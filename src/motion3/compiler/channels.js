// Keyed channels -> per-frame values. A channel is interpolated only through the keys that
// set it; before its first key and after its last it holds. Numbers, number arrays and
// {preset: weight} objects are supported. `step` keys jump at that frame (visibility switches
// and the like).
// Flow (spec.flow): the channels that place the body against the world or a target (feet,
// root, yaw, hand targets and weights, poles, fingers, objects) are monotone cubic / PCHIP and on
// time, so a held value never overshoots and a contact lands on its key. The body's own swing
// (FLOW_SMOOTH: spine, head, arm swing and bend, wrist) carries its speed through a key instead of
// stopping on it (Catmull-Rom, the overshoot past a key bounded), and trails the body
// (FLOW_LAG frames: the head behind the body, the arms behind both), the trail easing out over the
// take's last frames so every value is reached. An arm on its IK (armw) reaches for a target, so
// flow is gone by the time the arm is a quarter of the way onto it: an arm's swing and bend by its
// own armw, the spine (which carries the shoulders) and the head (the hands work near it) by the
// larger of the two; a reach or a held prop lands as keyed. A hold (two equal keys in a row) stays
// exactly flat either way. Overlap (overlap.js) breaks each change along the chains on top of that: the
// lower spine, the chest (chest_*: the top spine bone's share, baked beside spine_*), the head, the upper
// arm, the forearm and the wrist each take a later delay, one side of the body trails the other, and the
// arm's swing and bend overshoot and settle where they stop.
import { overlapDelay, sideTrail, settleBump, ikGap, contactGap, OVERLAP_SLOPE } from "./overlap.js";

function pchipSlopes(x, y) {
	const n = y.length, m = new Array(n).fill(0);
	for (let i = 1; i < n - 1; i++) {
		const h0 = x[i] - x[i - 1], h1 = x[i + 1] - x[i];
		const d0 = (y[i] - y[i - 1]) / h0, d1 = (y[i + 1] - y[i]) / h1;
		if (d0 * d1 > 0) {
			const w1 = 2 * h1 + h0, w2 = h1 + 2 * h0;
			m[i] = (w1 + w2) / (w1 / d0 + w2 / d1);
		}
	}
	return m;
}

function pchipEval(x, y, m, q) {
	if (x.length === 1 || q <= x[0]) return y[0];
	if (q >= x[x.length - 1]) return y[y.length - 1];
	let i = 0;
	while (q > x[i + 1]) i++;
	const h = x[i + 1] - x[i], t = (q - x[i]) / h;
	const t2 = t * t, t3 = t2 * t;
	return (2 * t3 - 3 * t2 + 1) * y[i] + (t3 - 2 * t2 + t) * h * m[i] + (-2 * t3 + 3 * t2) * y[i + 1] + (t3 - t2) * h * m[i + 1];
}

const FLOW_SMOOTH = /^(spine|chest|head)_(yaw|pitch|roll)$|^(aswing|abend)_[lr]$/;
const FLOW_LAG = { spine: 0, head: 2, arms: 3 }, HEAD_LEAD = 5;
const ARM = /^(hand|armw|elbow|aswing|abend|wflex|wtwist)_[lr]$/; // one side's arm: trails as one (overlap.js sideTrail)
const OVER_FRAC = 0.15, OVER_MAX = 6; // a smooth segment's overshoot: at most this share of its change, and degrees
const ikSides = ch => (/^(spine|chest|head)_/.test(ch) ? ["l", "r"] : /^(aswing|abend|wflex|wtwist)_([lr])$/.test(ch) ? [ch.slice(-1)] : []);
const lagFamily = ch => (/^(spine|chest)_/.test(ch) ? "spine" : /^head_/.test(ch) ? "head" : /^(aswing|abend)_[lr]$/.test(ch) ? "arms" : null);

/**
 * spec.flow -> { smooth, lag: { spine, head, arms }, overlap, headLead, seed, hands }: undefined is the default, false turns all off.
 * overlap: true (1) | false (0) | a scale of its delays and settle (overlap.js); headLead: the frames the head leads the trunk's
 * turn by, true (HEAD_LEAD) | false (0) | frames (head-lead.js); seed (the spec's label) picks which side trails;
 * hands: the frames each hand works on something (overlap.js handBusy), where a free IK hand's trail stops.
 */
export function flowOptions(flow, seed = "", hands = { l: [], r: [] }) {
	if (flow === false) return { smooth: false, lag: { spine: 0, head: 0, arms: 0 }, overlap: 0, headLead: 0, seed, hands };
	const f = flow ?? {}, lag = f.lag === false ? 0 : f.lag;
	const each = typeof lag === "number" ? { spine: lag, head: lag, arms: lag } : { ...FLOW_LAG, ...(lag ?? {}) };
	const overlap = f.overlap === false ? 0 : typeof f.overlap === "number" ? f.overlap : 1;
	const headLead = f.headLead === false ? 0 : typeof f.headLead === "number" ? Math.round(f.headLead) : HEAD_LEAD;
	return { smooth: f.smooth !== false, lag: each, overlap, headLead, seed, hands };
}

/** Catmull-Rom slopes, flat at a hold and at the ends, each segment's overshoot bounded. */
function smoothSlopes(x, y) {
	const n = y.length, m = new Array(n).fill(0);
	for (let i = 1; i < n - 1; i++) if (y[i] !== y[i - 1] && y[i] !== y[i + 1]) m[i] = (y[i + 1] - y[i - 1]) / (x[i + 1] - x[i - 1]);
	for (let i = 0; i < n - 1; i++) {
		const h = x[i + 1] - x[i], lo = Math.min(y[i], y[i + 1]), hi = Math.max(y[i], y[i + 1]), limit = Math.min(OVER_MAX, OVER_FRAC * (hi - lo));
		for (let tries = 0; tries < 12; tries++) {
			let over = 0;
			for (let k = 1; k < 16; k++) {
				const v = pchipEval([x[i], x[i + 1]], [y[i], y[i + 1]], [m[i], m[i + 1]], x[i] + (h * k) / 16);
				over = Math.max(over, v - hi, lo - v);
			}
			if (over <= limit + 1e-9) break;
			m[i] *= 0.7; m[i + 1] *= 0.7;
		}
	}
	return m;
}

const shapeOf = v => (Array.isArray(v) ? "vec" : v && typeof v === "object" ? "map" : "num");

/** keys: [{ f, set: { channel: value }, step?: [channel...] }] -> { channel: Array(frameCount) }; flow: flowOptions(spec.flow). */
export function bakeChannels(keys, frameCount, flow = flowOptions()) {
	const byChannel = new Map();
	for (const key of [...keys].sort((a, b) => a.f - b.f)) {
		for (const [ch, value] of Object.entries(key.set ?? {})) {
			if (!byChannel.has(ch)) byChannel.set(ch, []);
			byChannel.get(ch).push({ f: key.f, value, step: key.step?.includes(ch), src: key.src });
		}
	}
	// the top spine bone's share breaks after the two below it (pose.js), so it is baked as its own channel
	const overlap = flow.overlap ?? 0, entries = [...byChannel];
	if (overlap > 0) for (const [ch, list] of byChannel) if (/^spine_/.test(ch)) entries.push([ch.replace("spine", "chest"), list]);
	// an arm's IK weights first: a link's own delay runs out before an arm goes onto its IK and comes back after it
	// leaves (overlap.js), so the fade below never snaps a delayed move onto its keyed frames. Before them where each
	// hand touches: its anchor and fit weights (never delayed) and its carries and hand goals (flow.hands); a side's
	// trail stops short of those
	const pre = new Map(), near = new Map(), touch = {}, trails = {};
	if (overlap > 0) {
		for (const [ch, list] of entries) if (/^w_.+_[lr]$/.test(ch)) pre.set(ch, bakeOne(ch, list));
		for (const k of ["l", "r"]) touch[k] = contactGap(flow.hands?.[k] ?? [], [...pre].filter(([ch]) => ch.endsWith(`_${k}`)).map(([, b]) => b.frames), frameCount);
		// the whole arm of a side trails as one (overlap.js sideTrail), its FK swing with its IK weight, so a blend between
		// them never sets a late weight over an on-time swing
		for (const k of ["l", "r"]) trails[k] = sideTrail([...byChannel].filter(([ch]) => ARM.test(ch) && ch.endsWith(`_${k}`)).map(([ch, list]) => Object.assign([...list], { weight: /^armw_/.test(ch) })), k, overlap, flow.seed ?? "", touch[k]);
		for (const [ch, list] of entries) if (/^armw_[lr]$/.test(ch)) pre.set(ch, bakeOne(ch, list));
	}
	const gapOf = ch => {
		const sides = ikSides(ch).filter(k => pre.has(`armw_${k}`)), key = sides.join("");
		if (!sides.length) return null;
		if (!near.has(key)) near.set(key, ikGap(sides.map(k => pre.get(`armw_${k}`).frames), frameCount));
		return near.get(key);
	};
	const out = {}, plain = {};
	for (const [ch, list] of entries) {
		const baked = pre.get(ch) ?? bakeOne(ch, list, gapOf(ch));
		out[ch] = baked.frames;
		if (baked.plain) plain[ch] = baked.plain;
	}
	// flow fades out as the arm goes onto its IK (the spine with either arm)
	for (const [ch, keyed] of Object.entries(plain)) {
		const ws = ikSides(ch).map(k => out[`armw_${k}`]).filter(Boolean);
		if (!ws.length) continue;
		out[ch] = out[ch].map((v, f) => { const w = Math.min(1, 4 * Math.max(0, ...ws.map(a => a[f]))); return v + (keyed[f] - v) * w * (2 - w); });
	}
	return out;

	/** One channel's frames (and, for a flowing body channel, its keyed frames: plain); gap: frames to the nearest IK frame. */
	function bakeOne(ch, list, gap = null) {
		// later keys at the same frame win
		const pts = [...new Map(list.map(k => [k.f, k])).values()];
		const shape = shapeOf(pts[0].value);
		const comps = shape === "vec" ? pts[0].value.length : 0;
		const series = shape === "num" ? [pts.map(p => p.value)]
			: shape === "vec" ? Array.from({ length: comps }, (_, i) => pts.map(p => p.value[i]))
				: [...new Set(pts.flatMap(p => Object.keys(p.value)))].map(name => ({ name, y: pts.map(p => p.value[name] ?? 0) }));
		const x = pts.map(p => p.f), smooth = flow.smooth && FLOW_SMOOTH.test(ch), lag = flow.lag[lagFamily(ch)] ?? 0;
		const delay = shape === "num" ? overlapDelay(ch, pts, overlap, flow.seed ?? "", gap) : null;
		const trail = ARM.test(ch) ? trails[ch.slice(-1)] : null, most = lag + (delay?.max ?? 0);
		const delayAt = f => (delay ? Math.min(delay.at(f), gap ? OVERLAP_SLOPE * gap[Math.round(f)] : Infinity) : 0);
		const end = (f, d) => Math.min(1, (frameCount - 1 - f) / (2 * d));
		// the trail eases out over the last 2 * (its most) frames, so the take ends on the last value (the side's trail over
		// its own: a short ease there would quicken the arm's last move); the side's trail rides the keyed curve too (plain),
		// which an arm on its IK goes back to
		const keyedAt = f => (trail ? f - trail.at(f) * end(f, trail.max) : f);
		const at = f => keyedAt(f) - (most > 0 ? (lag + delayAt(f)) * end(f, most) : 0);
		// a settle near an arm's IK would be cut by the fade below: none within its span and a few frames
		const clear = (a, b) => { if (!gap) return true; for (let f = Math.max(0, Math.floor(a)); f <= Math.min(frameCount - 1, Math.ceil(b + most)); f++) if (gap[f] < 2) return false; return true; };
		const evalSeries = (y, flowing = true) => {
			const m = smooth && flowing ? smoothSlopes(x, y) : pchipSlopes(x, y), bump = flowing && shape === "num" ? settleBump(ch, pts, y, overlap, frameCount - 1, clear) : null;
			return q => {
				const f = flowing ? at(q) : keyedAt(q);
				// a step key holds the previous value right up to its frame
				for (let i = 1; i < pts.length; i++) if (pts[i].step && f >= x[i - 1] && f < x[i]) return y[i - 1];
				return pchipEval(x, y, m, f) + (bump ? bump(f) : 0);
			};
		};
		const frames = new Array(frameCount);
		if (shape === "num") { const e = evalSeries(series[0]); for (let f = 0; f < frameCount; f++) frames[f] = e(f); }
		else if (shape === "vec") { const es = series.map(evalSeries); for (let f = 0; f < frameCount; f++) frames[f] = es.map(e => e(f)); }
		else {
			const es = series.map(({ name, y }) => [name, evalSeries(y)]);
			for (let f = 0; f < frameCount; f++) frames[f] = Object.fromEntries(es.map(([n, e]) => [n, e(f)]));
		}
		if (!(shape === "num" && (smooth || most > 0) && ikSides(ch).length)) return { frames };
		// an arm's own channels keep the side's trail on its IK too (plain), only the links' own delays and settle fade
		const e = evalSeries(series[0], false);
		return { frames, plain: Array.from({ length: frameCount }, (_, f) => e(f)) };
	}
}

/** Frame f's channel dict. */
export const channelsAt = (baked, f) => Object.fromEntries(Object.entries(baked).map(([k, v]) => [k, v[f]]));

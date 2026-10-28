// Key thinning (variant J, deep research 14): an installing compile removes authored keys of the free spans one frame at a time,
// recompiling each time, and keeps a removal only when the QA groups and problems do not go up. Asked in the prompt, sparse
// free spans raised QA 1.9 -> 8.0 groups; removed under QA they went 38.4 -> 30.1 keys with no QA change. Never removed:
// the first and last keyed frame, the first and last key of each free span (its boundary), a hold (a key equal to a neighbour
// within the pause tolerance: holds carry the pauses), a key where the root's or a hand's or foot's speed is at a local extreme
// (a stop or a peak the motion reads by), and the frames the agent patched this round. Fill keys stay. Candidates go in order of
// how little their frame bends the curve (the root, hands and feet off the straight line between the neighbouring keys).
// One pass, LIMIT_MS at most. Answer: { spec, result, thinned: { removed: [f], kept, before, after, ms } } or null when none went.
import { classifySpans } from "./bricks/fill-density.js";
import { isFillKey } from "./bricks/fill-src.js";
import { qaProblems } from "../qa-label.js";

const LIMIT_MS = 10000, EXTREME = 3, STOP = 0.004, PEAK = 1.05, POS = 0.01, POLE = 0.05, ANGLE = 1;
const LIMBS = ["root", "hand_l", "hand_r", "foot_l", "foot_r"];
const dist = (a, b) => Math.hypot(...a.map((v, i) => v - b[i]));

/** Two keys' sets read as the same pose (the pause tolerance of fill.js: 1 cm, 5 cm on a pole, 1 deg). */
function samePose(a, b) {
	const chs = Object.keys(a.set ?? {}).filter(ch => ch in (b.set ?? {}));
	return chs.length > 0 && chs.every(ch => {
		const x = a.set[ch], y = b.set[ch];
		if (Array.isArray(x) && Array.isArray(y)) return dist(x, y) <= (/^(knee|elbow)_/.test(ch) ? POLE : POS);
		return Number.isFinite(x) && Number.isFinite(y) ? Math.abs(x - y) <= ANGLE : JSON.stringify(x) === JSON.stringify(y);
	});
}

/** Speed of a baked 3-vector channel at frame f (m per frame), or null. */
function speed(values, f) {
	const a = values?.[f - 1], b = values?.[f + 1];
	return Array.isArray(a) && Array.isArray(b) ? dist(a, b) / 2 : null;
}

/** True when some limb's speed at f is the largest or the smallest within EXTREME frames (a stop or a peak). */
function extreme(baked, f) {
	return LIMBS.some(ch => {
		const s = speed(baked[ch], f);
		if (s === null) return false;
		const around = [];
		for (let d = -EXTREME; d <= EXTREME; d++) if (d) { const v = speed(baked[ch], f + d); if (v !== null) around.push(v); }
		if (!around.length) return false;
		// a stop (under STOP m per frame, slower than every frame around) or a peak (faster than every frame around by PEAK)
		return (s < STOP && around.every(v => s < v - 1e-5)) || around.every(v => s > v * PEAK);
	});
}

/** How far frame f bends the root and limb curves off the straight line between frames a and b (m). */
function bend(baked, a, f, b) {
	let sum = 0;
	for (const ch of LIMBS) {
		const v = baked[ch];
		if (!Array.isArray(v?.[a]) || !Array.isArray(v?.[f]) || !Array.isArray(v?.[b])) continue;
		const t = (f - a) / (b - a);
		sum += dist(v[f], v[a].map((x, i) => x + (v[b][i] - x) * t));
	}
	return sum;
}

const worse = (r, best) => r.qa.groups.length > best.qa.groups.length || qaProblems(r.qa) > qaProblems(best.qa);

/** spec (the compiled one), result (its compile), compile(spec) -> result; opts.protect: frames the agent patched. */
export function thinSpec(spec, result, compile, { protect = [], limitMs = LIMIT_MS } = {}) {
	const t0 = performance.now(), keys = spec.keys ?? [], baked = result.out?.baked;
	if (!baked) return null;
	const authored = [...new Set(keys.filter(k => !isFillKey(k)).map(k => k.f))].sort((a, b) => a - b);
	if (authored.length < 4) return null;
	const { kind, spans } = classifySpans(spec, baked, result.out.frameCount ?? result.out.frames.length);
	const kept = new Set([authored[0], authored.at(-1), ...protect]);
	for (const s of spans.filter(s => s.kind === "free")) {
		const inside = authored.filter(f => f >= s.f0 && f <= s.f1);
		if (inside.length) { kept.add(inside[0]); kept.add(inside.at(-1)); }
	}
	const at = f => keys.filter(k => k.f === f && !isFillKey(k));
	authored.forEach((f, i) => {
		const near = [authored[i - 1], authored[i + 1]].filter(g => g !== undefined);
		if (near.some(g => at(f).some(a => at(g).some(b => samePose(a, b))))) kept.add(f);
		if (extreme(baked, f)) kept.add(f);
	});
	const candidates = authored.map((f, i) => ({ f, i })).filter(({ f, i }) => kind[f] === "free" && !kept.has(f) && i > 0 && i < authored.length - 1)
		.map(({ f, i }) => ({ f, cost: bend(baked, authored[i - 1], f, authored[i + 1]) })).sort((a, b) => a.cost - b.cost);
	let current = spec, best = result;
	const removed = [];
	for (const { f } of candidates) {
		if (performance.now() - t0 > limitMs) break;
		const trial = { ...current, keys: current.keys.filter(k => k.f !== f || isFillKey(k)) };
		let r;
		try { r = compile(trial); } catch { continue; }
		if (worse(r, best)) continue;
		current = trial; best = r; removed.push(f);
	}
	if (!removed.length) return null;
	return { spec: current, result: best, thinned: { removed: removed.sort((a, b) => a - b), kept: authored.length - removed.length, before: authored.length, after: authored.length - removed.length, ms: Math.round(performance.now() - t0) } };
}

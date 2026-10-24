// Measured, not judged (output.observations.life): how mechanical a take reads. Six cheap readings
// over the baked frames and the keys the agent wrote, one linear pass each, warnings only (never a
// QA group, never qa.ok):
//   sync   outside walks, the frame each body part (CHAINS) starts and stops moving (its activity,
//          below, past START of its usual level after a hold); the starts (stops) of several parts
//          close together are one transition, synchronous where most of them go within +-1 frame.
//          A body does not do that: the pelvis or a hand leads and the trunk, head and arms follow
//          a few frames later. score = the share of transitions that are synchronous.
//   keys   the gaps between the agent's key frames (per channel and all channels as one): their
//          coefficient of variation (cv, 0 = an even grid) and the share of keys on a half second.
//          Keys on a beat move every pose at one tempo; keys on the extremes do not.
//   jerk   the third difference of each CHAINS joint's position (m/s^3): its 95th percentile on
//          the frames the body moves, and spike frames, where a joint goes past SPIKE times its level
//          (and JERK_FLOOR): the acceleration snaps there, a seam between two keys' curves (a landing
//          too); warned past twice that.
//   twin   outside walks (the hips over WALK_SPEED) and jumps (no foot still), in WINDOW-frame windows: the correlation of
//          the left and right limb's bend speeds (elbow and shoulder; knee and hip). Over TWIN both
//          sides do the same thing on the same frames. score = the share of windows that twin.
//   dead   runs of a second or more with no joint moving over DEAD m a frame outside a still goal:
//          a statue (idle false, or a pose held where the idle layer stays off).
//   lead   where the pelvis turns (its heading spans LEAD_TURN degrees or more: more than a walk's sway), the lag (frames, -LAG..LAG) that best correlates the head's
//          world yaw change with the pelvis's: positive, the head turns first (a person's leads by about 5 frames at
//          24 fps, flow.headLead); [lag, correlation], or null without a turn. Read only, never warned.
// Activity is a part's own motion: the turn (deg/frame) of its local rotation, and for the hips
// their world turn or travel (cm/frame), so a hand carried by its arm does not count as moving.
// Why: compiled takes pass QA and still read mechanical (every part starts and stops on one frame,
// keys every 12 frames, both arms twinned), and nothing in the answer said so.
import { sub, len } from "../compiler/math.js";

const CHAINS = ["Hips", "Spine", "Spine2", "Head", "LeftArm", "RightArm", "LeftForeArm", "RightForeArm", "LeftHand", "RightHand",
	"LeftUpLeg", "RightUpLeg", "LeftLeg", "RightLeg", "LeftFoot", "RightFoot"];
/** A part moves above MOVE deg (cm) a frame; holds are HOLD frames or more under it; START of a part's usual level starts it. */
const MOVE = 0.25, HOLD = 3, START = 0.2;
/** sync: events GAP frames or less apart are one transition; synchronous when SYNC_MIN parts and SYNC_SHARE of its parts go within +-1 frame. */
const SYNC_MIN = 4, SYNC_SHARE = 0.6, GAP = 3;
const GRID_CV = 0.15, GRID_KEYS = 4, HALF_SHARE = 0.7;
const SPIKE = 4, JERK_FLOOR = 20;
const WALK_SPEED = 0.25, FOOT_STILL = 0.005, WINDOW = 48, TWIN = 0.9, TWIN_SWEEP = 15;
const DEAD = 1e-4;
const LAG = 10, LEAD_TURN = 15;
const r2 = x => Math.round(x * 100) / 100;

export const LIFE_UNITS = "life (warnings, not QA): [share or s, worst f0, f1]; keys [gap cv, even channels, half-second share]; jerk [p95 m/s^3, joint, spikes]; lead [frames the head turns before the pelvis, correlation]";

const p95 = xs => { const s = [...xs].sort((a, b) => a - b); return s.length ? s[Math.min(s.length - 1, Math.floor(0.95 * s.length))] : 0; };
const cvOf = gaps => { const m = gaps.reduce((a, b) => a + b, 0) / gaps.length, v = gaps.reduce((a, g) => a + (g - m) ** 2, 0) / gaps.length; return m > 0 ? Math.sqrt(v) / m : 0; };
function pearson(a, b) {
	const n = a.length, ma = a.reduce((s, x) => s + x, 0) / n, mb = b.reduce((s, x) => s + x, 0) / n;
	let ab = 0, aa = 0, bb = 0;
	for (let i = 0; i < n; i++) { ab += (a[i] - ma) * (b[i] - mb); aa += (a[i] - ma) ** 2; bb += (b[i] - mb) ** 2; }
	return aa > 0 && bb > 0 ? ab / Math.sqrt(aa * bb) : 0;
}

/** Per CHAINS part, activity[f] (from f-1): its local turn in deg; the hips the larger of their world turn and travel in cm. */
function activities(sk, F) {
	const I = sk.index, n = F.length, DEG = 180 / Math.PI;
	return CHAINS.map(j => {
		const b = I[j], p = j === "Hips" ? -1 : sk.parent[b], act = new Float64Array(n);
		let L = new Float64Array(9), prev = new Float64Array(9);
		for (let f = 0; f < n; f++) {
			const { R, P } = F[f].s, B = R[b], A = p < 0 ? null : R[p];
			// L = A^T B (the local rotation), written out: a pass over every frame of every part must not allocate
			for (let r = 0; r < 3; r++) for (let c = 0; c < 3; c++) L[r * 3 + c] = A ? A[0][r] * B[0][c] + A[1][r] * B[1][c] + A[2][r] * B[2][c] : B[r][c];
			if (f) {
				let tr = 0;
				for (let i = 0; i < 9; i++) tr += L[i] * prev[i];
				const turn = Math.acos(Math.max(-1, Math.min(1, (tr - 1) / 2))) * DEG, Q = F[f - 1].s.P[b];
				act[f] = p < 0 ? Math.max(turn, Math.hypot(P[b][0] - Q[0], P[b][1] - Q[1], P[b][2] - Q[2]) * 100) : turn;
			}
			[L, prev] = [prev, L];
		}
		return act;
	});
}

/** Moves between holds: [a, b] runs of frames where some part moves, gaps under HOLD frames joined. */
function moves(acts, n) {
	const runs = [];
	let a = -1, quiet = 0;
	for (let f = 1; f < n; f++) {
		if (acts.some(act => act[f] > MOVE)) { if (a < 0) a = f; quiet = 0; }
		else if (a >= 0 && ++quiet >= HOLD) { runs.push([a, f - quiet]); a = -1; quiet = 0; }
	}
	if (a >= 0) runs.push([a, n - 1 - quiet]);
	return runs.filter(([x, y]) => y - x >= 3);
}

/**
 * Starts and stops outside walks: a part starts where its activity rises past its threshold
 * (MOVE, or START of its usual level: the 90th percentile of its moving frames) after HOLD frames
 * under it, and stops where it falls under it for HOLD frames. Events of several parts that follow
 * one another within GAP frames are one transition; it is synchronous when, of the m parts in it
 * (SYNC_MIN or more), max(SYNC_MIN, SYNC_SHARE * m) go within one 3-frame window.
 */
function syncOf(acts, walking, n) {
	const events = [[], []];
	acts.forEach((act, j) => {
		const level = [...act].filter(v => v > MOVE).sort((a, b) => a - b), thr = Math.max(MOVE, START * (level[Math.floor(0.9 * level.length)] ?? 0));
		const on = f => act[f] > thr;
		for (let f = 1; f < n; f++) {
			if (walking[f]) continue;
			if (on(f) && !on(f - 1)) { let q = 1; while (q <= HOLD && f - q >= 0 && !on(f - q)) q++; if (q > HOLD || f - q < 0) events[0].push([f, j]); }
			if (!on(f) && on(f - 1)) { let q = 0; while (q < HOLD && f + q < n && !on(f + q)) q++; if (q >= HOLD && f + q < n) events[1].push([f - 1, j]); }
		}
	});
	let total = 0, synced = 0, worst = null;
	for (const list of events) {
		list.sort((a, b) => a[0] - b[0]);
		for (let i = 0; i < list.length;) {
			let k = i + 1;
			while (k < list.length && list[k][0] - list[k - 1][0] <= GAP) k++;
			const group = list.slice(i, k), m = new Set(group.map(e => e[1])).size;
			i = k;
			if (m < SYNC_MIN) continue;
			let best = 0, at = group[0][0];
			for (let x = 0, y = 0; y < group.length; y++) {
				while (group[y][0] - group[x][0] > 2) x++;
				const c = new Set(group.slice(x, y + 1).map(e => e[1])).size;
				if (c > best) { best = c; at = group[x][0]; }
			}
			total++;
			if (best >= Math.max(SYNC_MIN, Math.ceil(SYNC_SHARE * m))) synced++;
			if (!worst || best / m > worst.share || (best / m === worst.share && best > worst.k)) worst = { share: best / m, k: best, of: m, at: [at, at + 2] };
		}
	}
	return { score: total ? r2(synced / total) : 0, total, worst };
}

/** The agent's keys: cv of all key gaps, the channels keyed on an even grid, the share on half seconds. */
function keysOf(keys, fps) {
	const per = new Map(), all = new Set();
	for (const k of keys ?? []) {
		if (!Number.isFinite(k?.f)) continue;
		all.add(k.f);
		for (const ch of Object.keys(k.set ?? {})) (per.get(ch) ?? per.set(ch, new Set()).get(ch)).add(k.f);
	}
	const gaps = fs => { const s = [...fs].sort((a, b) => a - b); return s.slice(1).map((f, i) => f - s[i]); };
	const eligible = [...per].filter(([, fs]) => fs.size >= GRID_KEYS), grid = eligible.filter(([, fs]) => cvOf(gaps(fs)) < GRID_CV).map(([ch]) => ch);
	const inner = [...all].filter(f => f > 0), half = Math.round(fps / 2);
	return { cv: all.size >= GRID_KEYS ? r2(cvOf(gaps(all))) : null, grid, eligible: eligible.length,
		halfSec: inner.length >= GRID_KEYS ? r2(inner.filter(f => f % half === 0).length / inner.length) : null };
}

function jerkOf(sk, F, moving, fps) {
	const k3 = fps ** 3;
	let top = [0, null], worst = null;
	const spikes = new Set();
	for (const j of CHAINS) {
		const X = F.map(fr => fr.s.P[sk.index[j]]), J = new Float64Array(F.length), on = [];
		for (let f = 3; f < F.length; f++) {
			const d = i => X[f][i] - 3 * X[f - 1][i] + 3 * X[f - 2][i] - X[f - 3][i];
			J[f] = Math.hypot(d(0), d(1), d(2)) * k3;
			if (moving[f]) on.push(J[f]);
		}
		const level = p95(on);
		if (level > top[0]) top = [r2(level), j];
		for (let f = 3; f < F.length; f++) {
			if (J[f] <= Math.max(JERK_FLOOR, SPIKE * level)) continue;
			spikes.add(f);
			const ratio = J[f] / Math.max(level, 1e-9);
			if (!worst || ratio > worst.ratio) worst = { ratio, f, j };
		}
	}
	return { p95: top, spikes: spikes.size, worst };
}

/** Bend angles (deg) per frame of one side's limb: [elbow, shoulder] or [knee, hip]. */
function bends(sk, s, S, arm) {
	const I = sk.index, P = s.P, up = sub(P[I.Spine2], P[I.Hips]);
	const ang = (a, b) => Math.acos(Math.max(-1, Math.min(1, (a[0] * b[0] + a[1] * b[1] + a[2] * b[2]) / Math.max(1e-9, len(a) * len(b))))) * 180 / Math.PI;
	const [r, m, e] = arm ? [`${S}Arm`, `${S}ForeArm`, `${S}Hand`] : [`${S}UpLeg`, `${S}Leg`, `${S}Foot`];
	const u = sub(P[I[m]], P[I[r]]);
	return [ang(u, sub(P[I[e]], P[I[m]])), ang(u, arm ? up : [-up[0], -up[1], -up[2]])];
}

function twinOf(sk, F, walking) {
	const res = {};
	for (const [name, arm] of [["arms", true], ["legs", false]]) {
		const L = F.map(({ s }) => bends(sk, s, "Left", arm)), R = F.map(({ s }) => bends(sk, s, "Right", arm));
		let windows = 0, twins = 0, worst = null;
		for (let a = 1; a + WINDOW <= F.length; a += WINDOW / 4) {
			if (walking.slice(a, a + WINDOW).some(Boolean)) continue;
			const dl = [], dr = [];
			for (let f = a; f < a + WINDOW; f++) for (let i = 0; i < 2; i++) { dl.push(L[f][i] - L[f - 1][i]); dr.push(R[f][i] - R[f - 1][i]); }
			const sweep = d => d.reduce((x, v) => x + Math.abs(v), 0);
			if (sweep(dl) < TWIN_SWEEP || sweep(dr) < TWIN_SWEEP) continue;
			const c = pearson(dl, dr);
			windows++;
			if (c > TWIN) twins++;
			if (!worst || c > worst.c) worst = { c, at: [a, a + WINDOW - 1] };
		}
		res[name] = { score: windows ? r2(twins / windows) : 0, windows, worst };
	}
	return res;
}

function deadOf(sk, F, spec, fps) {
	const still = new Uint8Array(F.length);
	for (const g of spec.goals ?? []) {
		const at = Array.isArray(g?.at) ? g.at : null;
		if (g?.still !== undefined && at?.length) for (let f = Math.max(0, Math.round(at[0])); f <= Math.min(F.length - 1, Math.round(at[at.length - 1])); f++) still[f] = 1;
	}
	let best = null, frames = 0;
	for (let f = 1, a = -1; f <= F.length; f++) {
		const dead = f < F.length && !still[f] && sk.names.every((_, j) => len(sub(F[f].s.P[j], F[f - 1].s.P[j])) < DEAD);
		if (dead) { if (a < 0) a = f; continue; }
		if (a >= 0 && f - a >= fps) { frames += f - a; if (!best || f - a > best[1] - best[0] + 1) best = [a, f - 1]; }
		a = -1;
	}
	return { frames, best };
}

/** [lag, correlation] of the head's world yaw change against the pelvis's (lag > 0: the head first), null without a turn. */
function leadOf(sk, F) {
	const I = sk.index, n = F.length, DEG = 180 / Math.PI, wrap = d => d - 360 * Math.round(d / 360);
	const pelvis = F.map(({ s }) => { const a = s.P[I.LeftUpLeg], b = s.P[I.RightUpLeg]; return Math.atan2(b[0] - a[0], b[2] - a[2]) * DEG; });
	const head = F.map(({ s }) => { const R = s.R[I.Head]; return Math.atan2(R[0][2], R[2][2]) * DEG; });
	const dp = pelvis.map((v, f) => (f ? wrap(v - pelvis[f - 1]) : 0)), dh = head.map((v, f) => (f ? wrap(v - head[f - 1]) : 0));
	let heading = 0, lo = 0, hi = 0;
	for (const d of dp) { heading += d; lo = Math.min(lo, heading); hi = Math.max(hi, heading); }
	if (n <= 4 * LAG || hi - lo < LEAD_TURN) return null;
	let best = null;
	for (let lag = -LAG; lag <= LAG; lag++) {
		let ab = 0, aa = 0, bb = 0;
		for (let f = LAG + 2; f < n - LAG - 2; f++) { ab += dp[f] * dh[f - lag]; aa += dp[f] ** 2; bb += dh[f - lag] ** 2; }
		const c = aa > 0 && bb > 0 ? ab / Math.sqrt(aa * bb) : 0;
		if (!best || c > best[1]) best = [lag, c];
	}
	return [best[0], r2(best[1])];
}

/**
 * observeLife(sk, out, keys) -> observations.life; keys are the spec keys as the agent wrote them
 * (a skill's keys are the compiler's). Frames are absolute (out.f0 added). flags names the metrics
 * past their mark, worst first; warn is what to change for the worst (one line: the receipt budget, report.js).
 */
export function observeLife(sk, out, keys) {
	const F = out.frames, n = F.length, fps = out.fps ?? 24, f0 = out.f0 ?? 0, spec = out.ctx.spec, I = sk.index, warnings = [];
	const acts = activities(sk, F), runs = moves(acts, n), moving = new Uint8Array(n);
	for (const [a, b] of runs) moving.fill(1, a, b + 1);
	// a walk: the hips travel over WALK_SPEED, widened by half a window so its first and last steps count
	const walking = new Uint8Array(n), pad = WINDOW / 2;
	for (let f = 1; f < n; f++) {
		const P = F[f].s.P[I.Hips], Q = F[f - 1].s.P[I.Hips];
		if (Math.hypot(P[0] - Q[0], P[2] - Q[2]) * fps > WALK_SPEED) walking.fill(1, Math.max(0, f - pad), Math.min(n, f + pad));
	}
	// twins leave out walks and jumps too: no foot still (a flip, a hop takes both legs together)
	const free = walking.slice();
	for (let f = 1; f < n; f++) if (["LeftFoot", "RightFoot"].every(j => len(sub(F[f].s.P[I[j]], F[f - 1].s.P[I[j]])) > FOOT_STILL)) free.fill(1, Math.max(0, f - pad), Math.min(n, f + pad));
	const sync = syncOf(acts, walking, n), k = keysOf(keys, fps), jerk = jerkOf(sk, F, moving, fps), twin = twinOf(sk, F, free), dead = deadOf(sk, F, spec, fps);
	const span = ([a, b]) => `f${a + f0}-${b + f0}`;
	// [weight, metric, advice]: the answer keeps the worst advice and names every metric it flags
	if (sync.total >= 2 && sync.score >= 0.5) warnings.push([sync.score, "sync", `${sync.worst.k} of ${sync.worst.of} parts start or stop together ${span(sync.worst.at)}: lead with pelvis or a hand, spine/head/arms 2-4 frames later`]);
	const gridKeys = (k.cv !== null && k.cv < GRID_CV) || (k.eligible && k.grid.length / k.eligible >= 0.5) || (k.halfSec ?? 0) >= HALF_SHARE;
	if (gridKeys) warnings.push([0.9, "keys", `keys on a grid: key the extremes (contact, peak, turn), vary the gaps`]);
	if (jerk.worst && jerk.worst.ratio > 2 * SPIKE) warnings.push([0.6, "jerk", `${jerk.worst.j} jerks ${Math.round(jerk.worst.ratio)}x at f${jerk.worst.f + f0}: a key snaps; ease or move it`]);
	for (const [name, t] of Object.entries(twin)) if (t.windows >= 2 && t.score >= 0.4) warnings.push([t.score, name, `${name} mirror ${span(t.worst.at)}: ${name === "legs" ? "weight onto one foot, not straight down" : "offset one side 2-4 frames or pose it apart"}`]);
	if (dead.best) warnings.push([0.7, "dead", `dead still ${span(dead.best)}${spec.idle === false ? " (idle false)" : ""}: let idle run or key a settle`]);
	warnings.sort((a, b) => b[0] - a[0]);
	const at = (score, w) => (w ? [score, w[0] + f0, w[1] + f0] : [score]);
	return {
		sync: at(sync.score, sync.worst?.at), keys: [k.cv, k.grid.length, k.halfSec], jerk: [...jerk.p95, jerk.spikes],
		arms: at(twin.arms.score, twin.arms.worst?.at), legs: at(twin.legs.score, twin.legs.worst?.at), dead: at(r2(dead.frames / fps), dead.best), lead: leadOf(sk, F),
		...(warnings.length ? { flags: warnings.map(w => w[1]), warn: warnings[0][2] } : {}),
	};
}

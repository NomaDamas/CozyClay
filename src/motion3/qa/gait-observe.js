// Measured, not judged (output.observations.gait): how a take's walks compare with a person's. Only inside the walks
// (start to last step, compiler/head-steady.js walkSpans, and the PAD frames after it where the last step lands). A
// heel strikes where its sole point comes down under QA's plant height (QA_LIMITS.plantH). From the strikes: the
// steps, the cadence (steps a minute), the step length and speed (the hips' travel strike to strike). Over each
// stride (a foot's strike to its next): the share of it that foot is on the ground (heel or ball planted), and the
// pelvis's peak-to-peak motion with the stride's own trend taken out (so a turn or a slope does not count): its turn
// (the hip line's yaw), its obliquity (the hip line's tilt), its rise and fall (the hips' height) and its side to side
// (the hips off the stride's line). Warnings past the ranges (RANGES) a person's walk keeps; never a QA group,
// never qa.ok. No walk, no gait; under MIN_STEPS steps only the steps (too few strides to read; the answer budget).
// Ranges: pelvis rotation 9.5 +-2 SD and obliquity 7.4 +-2 SD degrees (Bruening et al. 2017, 44 adults); cadence
// normal 100-115, warned outside 80-140; stance 60% of a stride; the hips' rise and fall 2.7-5 cm is provisional.
import { walkSpans } from "../compiler/head-steady.js";
import { groundSole } from "./ground.js";
import { QA_LIMITS } from "./checks.js";

const DEG = 180 / Math.PI, PAD = 12, MIN_STEPS = 4;
const RANGES = { cadence: [80, 140], stance: [0.55, 0.65], rotation: [3.7, 15.3], obliquity: [2.4, 12.4], vertical: [2.7, 5] };
const r = (x, d) => Math.round(x * 10 ** d) / 10 ** d;

export const GAIT_UNITS = "gait (walks, warnings not QA): cadence [steps/min, normal]; stepLength m; speed m/s; stance [L, R] stride share down; pelvis p-p a stride: rotation, obliquity deg, vertical (range provisional), lateral cm";

/** Peak to peak of xs[a..b] less the line from xs[a] to xs[b]. */
function swing(xs, a, b) {
	let lo = Infinity, hi = -Infinity;
	for (let f = a; f <= b; f++) {
		const v = xs[f] - (xs[a] + ((xs[b] - xs[a]) * (f - a)) / (b - a));
		lo = Math.min(lo, v); hi = Math.max(hi, v);
	}
	return hi - lo;
}

const unwrap = xs => xs.reduce((o, v, i) => (o.push(i ? o[i - 1] + (v - xs[i - 1]) - 360 * Math.round((v - xs[i - 1]) / 360) : v), o), []);
const mean = xs => xs.reduce((a, b) => a + b, 0) / xs.length;

/** One stride [a, b]: the pelvis's rotation, obliquity (deg) and vertical, lateral (cm) peak to peak. */
function pelvisOf(hipLine, hips, a, b) {
	const [ax, , az] = hips[a], dx = hips[b][0] - ax, dz = hips[b][2] - az, d = Math.hypot(dx, dz) || 1;
	const side = hips.map(p => ((p[0] - ax) * dz - (p[2] - az) * dx) / d);
	return [swing(hipLine.yaw, a, b), swing(hipLine.tilt, a, b), 100 * swing(hips.map(p => p[1]), a, b), 100 * swing(side, a, b)];
}

/** observeGait(sk, out, keys) -> observations.gait or null; keys are the compiled keys (walk.js tags their src). */
export function observeGait(sk, out, keys) {
	const F = out.frames, n = F.length, f0 = out.f0 ?? 0, fps = out.fps ?? 24, I = sk.index;
	// a retime keeps its keys on fractional frames (fix/retime.js): the spans are frame indices
	const spans = walkSpans(keys ?? []).map(([a, b]) => [Math.max(0, Math.round(a - f0)), Math.min(n - 1, Math.round(b - f0) + PAD)]).filter(([a, b]) => b > a);
	if (!spans.length) return null;
	const sole = { Left: [], Right: [] };
	for (const [a, b] of spans) for (let f = a; f <= b; f++) for (const S of ["Left", "Right"]) sole[S][f] ??= groundSole(out, f, S);
	const hips = F.map(({ s }) => s.P[I.Hips]), line = F.map(({ s }) => { const p = s.P[I.LeftUpLeg], q = s.P[I.RightUpLeg]; return [q[0] - p[0], q[1] - p[1], q[2] - p[2]]; });
	const hipLine = { yaw: unwrap(line.map(v => Math.atan2(v[0], v[2]) * DEG)), tilt: line.map(v => Math.atan2(v[1], Math.hypot(v[0], v[2])) * DEG) };
	let steps = 0, time = 0, path = 0;
	const stance = { Left: [], Right: [] }, pelvis = [];
	for (const [a, b] of spans) {
		const strikes = [];
		for (const S of ["Left", "Right"]) {
			const own = [];
			for (let f = a + 1; f <= b; f++) if (sole[S][f].heel[1] < QA_LIMITS.plantH && sole[S][f - 1].heel[1] >= QA_LIMITS.plantH) own.push(f);
			strikes.push(...own);
			for (let i = 1; i < own.length; i++) {
				const [s0, s1] = [own[i - 1], own[i]];
				let down = 0;
				for (let f = s0; f < s1; f++) down += Math.min(sole[S][f].heel[1], sole[S][f].ball[1]) < QA_LIMITS.plantH ? 1 : 0;
				stance[S].push(down / (s1 - s0));
				pelvis.push(pelvisOf(hipLine, hips, s0, s1));
			}
		}
		strikes.sort((x, y) => x - y);
		if (strikes.length < 2) continue;
		steps += strikes.length - 1;
		time += (strikes.at(-1) - strikes[0]) / fps;
		for (let i = 1; i < strikes.length; i++) path += Math.hypot(hips[strikes[i]][0] - hips[strikes[i - 1]][0], hips[strikes[i]][2] - hips[strikes[i - 1]][2]);
	}
	if (steps < MIN_STEPS || !pelvis.length) return { steps };
	const cadence = (steps / time) * 60, st = ["Left", "Right"].map(S => (stance[S].length ? r(mean(stance[S]), 2) : null));
	const [rotation, obliquity, vertical, lateral] = [0, 1, 2, 3].map(i => mean(pelvis.map(p => p[i])));
	const warnings = [], warn = (name, v, [lo, hi]) => {
		if (v < lo) warnings.push(`${name} ${v} < ${lo}`);
		else if (v > hi) warnings.push(`${name} ${v} > ${hi}`);
	};
	warn("cadence", r(cadence, 1), RANGES.cadence);
	st.forEach((v, i) => v !== null && warn(`stance ${"LR"[i]}`, v, RANGES.stance));
	warn("rotation", r(rotation, 1), RANGES.rotation);
	warn("obliquity", r(obliquity, 1), RANGES.obliquity);
	warn("vertical", r(vertical, 2), RANGES.vertical);
	return { steps, cadence: [r(cadence, 1), "100-115"], stepLength: r(path / steps, 3), speed: r(path / time, 2), stance: st,
		pelvis: { rotation: r(rotation, 1), obliquity: r(obliquity, 1), vertical: r(vertical, 2), lateral: r(lateral, 2) }, warnings };
}

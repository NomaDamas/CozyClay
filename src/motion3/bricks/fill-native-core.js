// Shared pieces of the native MotionBricks fill (fill-native.js, fill-native-chain.js): the engines' endpoint correction and root
// filter on decoded SOMA frames, dense channels over a gap, and the gap's token count.
import { somaFK, toCozyPoint, SOMA_PARENT } from "./soma.js";
import { MIN_TOKENS, MAX_TOKENS } from "./model-io.js";
import { frameChannels, unwrapSeries } from "./forward.js";
import { STEP, lockFeet } from "./fill.js";
import { rangeOf } from "../compiler/vocab.js";
import { quatFromMat, matFromQuat, mul, T, add, scale, sub } from "../compiler/math.js";

export const MIN_GAP = 14; // the shortest call (6 tokens, 18 frames) is 13.6 spec frames
const TOKEN_SPREAD = 2;
const JOINT_FADE = 0.3 * 30; // model frames
const ROOT_FILTER = [-0.0465, 0.0639, 0.2827, 0.3998, 0.2827, 0.0639, -0.0465];
export const TOL_SCALE = 0.35;

export const lerp = (a, b, t) => (Array.isArray(a) ? a.map((v, i) => v + (b[i] - v) * t) : a + (b - a) * t);
const fade = v => { const t = Math.max(0, Math.min(1, v)), r = 1 - t; return t < 0.5 ? 1 - 2 * t * t : 2 * r * r; };

/** R raised to the power t (a partial rotation from identity). */
function partial(R, t) {
	let [x, y, z, w] = quatFromMat(R);
	if (w < 0) { x = -x; y = -y; z = -z; w = -w; }
	const half = Math.acos(Math.min(1, w)), s = Math.sin(half);
	if (s < 1e-8 || t === 0) return t === 0 ? [[1, 0, 0], [0, 1, 0], [0, 0, 1]] : R;
	const h = half * t, k = Math.sin(h) / s;
	return matFromQuat([x * k, y * k, z * k, Math.cos(h)]);
}

const localOf = R => R.map((r, j) => (j === 0 ? r : mul(T(R[SOMA_PARENT[j]]), r)));
const worldOf = L => { const R = []; L.forEach((l, j) => { R[j] = j === 0 ? l : mul(R[SOMA_PARENT[j]], l); }); return R; };

/** The runtime's root filter (7 taps, clamped at the ends) and the engines' endpoint correction, on decoded SOMA frames. */
export function correctMotion(motion, start, end) {
	const n = motion.length, last = n - 1, r = ROOT_FILTER.length >> 1;
	const roots = motion.map((_, f) => {
		const p = [0, 0, 0];
		ROOT_FILTER.forEach((w, t) => { const q = motion[Math.max(0, Math.min(last, f + t - r))].P[0]; p[0] += w * q[0]; p[1] += w * q[1]; p[2] += w * q[2]; });
		return p;
	});
	if (n < 2) return motion.map((m, f) => ({ ...m, P: somaFK(roots[f], m.R) }));
	const L = motion.map(m => localOf(m.R)), Ls = localOf(start.R), Le = localOf(end.R);
	// deltas that take the generated end frames onto the guides (inv(gen) * guide for the root, guide * inv(gen) per joint)
	const dRootS = mul(T(L[0][0]), Ls[0]), dRootE = mul(T(L[last][0]), Le[0]);
	const dPosS = sub(start.root ?? start.P[0], roots[0]), dPosE = sub(end.root ?? end.P[0], roots[last]);
	const dJS = Ls.map((l, j) => mul(l, T(L[0][j]))), dJE = Le.map((l, j) => mul(l, T(L[last][j])));
	const F = Math.min(JOINT_FADE, 0.5 * last);
	return motion.map((m, f) => {
		const ew = f / last, sw = 1 - ew, ws = fade(f / F), we = fade((last - f) / F);
		const local = L[f].map((l, j) => (j === 0 ? mul(mul(l, partial(dRootS, sw)), partial(dRootE, ew)) : mul(partial(dJE[j], we), mul(partial(dJS[j], ws), l))));
		const R = worldOf(local), root = add(roots[f], add(scale(dPosS, sw), scale(dPosE, ew)));
		return { R, P: somaFK(root, R), contacts: m.contacts };
	});
}

/** A knee pole the spec refuses (pointing backward, validate.js: z < -0.7 of its length) is turned to just inside the limit; the
 * ankle floor (4 cm) and the numeric channel ranges (vocab.js rangeOf) likewise. Mutates and returns the channel object. */
export function saneChannels(ch) {
	for (const k of ["knee_l", "knee_r"]) {
		const v = ch[k];
		if (!v) continue;
		const l = Math.hypot(...v);
		if (l > 1e-6 && v[2] < -0.6 * l) { const z = -0.6 * l, r = Math.hypot(v[0], v[1]) || 1e-6, s = Math.sqrt(Math.max(0, l * l - z * z)) / r; ch[k] = [v[0] * s, v[1] * s, z]; }
	}
	for (const k of ["foot_l", "foot_r"]) if (ch[k] && ch[k][1] < 0.045) ch[k] = [ch[k][0], 0.045, ch[k][2]];
	// numeric channels inside the spec's ranges (e.g. fpitch -60..90)
	for (const [k, v] of Object.entries(ch)) { const r = typeof v === "number" ? rangeOf(k) : null; if (r) ch[k] = Math.max(r[1], Math.min(r[2], v)); }
	return ch;
}

/** Dense channels over spec frames fa..fb from corrected SOMA frames (time-warped onto the gap), residual faded onto the compiled ends. */
export function denseChannels(motion, fa, fb, baked, endBaked = baked) {
	const gen = motion.map(m => frameChannels(m.P.map(toCozyPoint))), n = gen.length, out = [];
	for (let f = fa; f <= fb; f++) {
		const x = (f - fa) / (fb - fa) * (n - 1), i = Math.min(Math.floor(x), n - 2), u = x - i;
		out.push(Object.fromEntries(Object.keys(gen[0]).map(k => [k, lerp(gen[i][k], gen[i + 1][k], u)])));
	}
	unwrapSeries(out, Object.fromEntries(Object.entries(baked).map(([k, v]) => [k, v[fa]])));
	const last = out.length - 1, F = Math.min(JOINT_FADE * 24 / 30, 0.5 * last);
	const diff = (x, y) => (Array.isArray(x) ? x.map((v, i) => v - y[i]) : x - y);
	for (const k of Object.keys(out[0])) {
		if (!baked[k] || !endBaked[k]) continue;
		const s = diff(baked[k][fa], out[0][k]), e = diff(endBaked[k][fb], out[last][k]);
		out.forEach((ch, i) => {
			const ws = k === "root" ? 1 - i / last : fade(i / F), we = k === "root" ? i / last : fade((last - i) / F);
			ch[k] = Array.isArray(s) ? ch[k].map((v, c) => v + s[c] * ws + e[c] * we) : ch[k] + s * ws + e * we;
		});
	}
	const planted = out.map((_, i) => motion[Math.round(i / last * (n - 1))].contacts);
	lockFeet(out, planted);
	stepFeet(out);
	out.forEach(saneChannels);
	return out;
}

const STEP_MIN_M = 0.02, STEP_FROM = 0.6, STEP_LIFT = 0.03;
/**
 * A foot the model keeps planted over the whole gap while the authored keys move it (lockFeet then slides it straight from key
 * to key, QA SLIDE on every frame) holds its start until the hips have come STEP_FROM of the way from the last height, then
 * the feet step to the end key one after the other on a low arc (STEP_LIFT, at most 15% of the distance), the other foot
 * holding meanwhile: the legs go out as the body sits, never both in the air. Mutates out (and out.holds).
 */
export function stepFeet(out) {
	const last = out.length - 1, y = i => out[i].root?.[1];
	if (last < 6 || y(0) === undefined) return out;
	const drop = y(0) - y(last);
	let from = Math.round(last * 0.4);
	if (Math.abs(drop) > 0.05) { from = 0; while (from < last && (y(from) - y(last)) / drop > STEP_FROM) from++; }
	from = Math.max(1, Math.min(from, last - 6));
	const sides = ["l", "r"].filter(k => {
		const a = out[0][`foot_${k}`], b = out[last][`foot_${k}`];
		return out.holds?.[k]?.some(([i, j]) => i === 0 && j === last) && a && b && Math.hypot(b[0] - a[0], b[2] - a[2]) >= STEP_MIN_M;
	});
	const mid = Math.round((from + last) / 2);
	sides.forEach((k, n) => {
		const [s0, s1] = sides.length === 1 ? [from, last] : n === 0 ? [from, mid] : [mid, last];
		const a = out[0][`foot_${k}`], b = out[last][`foot_${k}`], lift = Math.min(STEP_LIFT, 0.15 * Math.hypot(b[0] - a[0], b[2] - a[2]));
		for (const ch of [`foot_${k}`, `fyaw_${k}`, `fpitch_${k}`]) {
			const A = out[0][ch], B = out[last][ch];
			if (A === undefined) continue;
			for (let i = 1; i < last; i++) {
				const t = Math.max(0, Math.min(1, (i - s0) / (s1 - s0)));
				out[i][ch] = lerp(A, B, 1 - fade(t));
				if (ch === `foot_${k}` && t > 0 && t < 1) out[i][ch][1] += lift * Math.sin(Math.PI * t);
			}
		}
		out.holds[k] = [[0, s0], [s1, last]];
	});
	return out;
}

/** The gap's own token count (its length at 30 fps) and a wider range for asking the model how long it would take. */
export function gapTokens(fa, fb) {
	const frames = (fb - fa) / STEP + 1, t = Math.max(MIN_TOKENS, Math.round((frames + 6) / 4));
	if (t > MAX_TOKENS) throw new Error(`FILL_GAP_TOO_LONG: f${fa}-f${fb}`);
	const lo = Math.max(MIN_TOKENS, t - TOKEN_SPREAD), hi = Math.min(MAX_TOKENS, t + TOKEN_SPREAD);
	return { exact: t, range: Array.from({ length: hi - lo + 1 }, (_, i) => lo + i) };
}


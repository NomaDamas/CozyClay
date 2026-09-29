/**
 * metrics.mjs - pure quality metrics for the known-character tracker gate
 * (#500, plan todo 4). No I/O: callers load motions and pass arrays.
 *
 * Motions are `{ frames, fps, posedJoints }` with posedJoints a flat
 * frames x 27 x 3 array (cskel27 order, metres), exactly what
 * src/ardy/npz.js decodeMotionNpz and tools/kimodo/read-npz.mjs give.
 * rotMats are flat frames x 27 x 9 (row-major local rotations; the root's
 * local rotation is its world rotation).
 */
import { CSKEL27_JOINTS } from "../../src/ardy/cskel27.js";

/** cskel27 foot joints whose truth speed defines stance (same set as the
 * truth-analysis evaluate(): RightFoot, RightToeBase, LeftFoot, LeftToeBase). */
export const STANCE_FEET = ["RightFoot", "RightToeBase", "LeftFoot", "LeftToeBase"].map((name) => CSKEL27_JOINTS.indexOf(name));
/** A truth foot joint moving slower than this (3D, m/s) is in stance. */
export const STANCE_SPEED_MPS = 0.1;

const DEG = 180 / Math.PI;

/** Geodesic angle (degrees) between consecutive root rotations: frames - 1 values. */
export function pelvisStepsDeg(rotMats, frames = rotMats.length / (27 * 9)) {
	if (!(Number.isInteger(frames) && frames > 0) || rotMats.length % frames) throw new Error(`pelvisStepsDeg: ${rotMats.length} values do not split into ${frames} frames`);
	const stride = rotMats.length / frames;
	if (stride < 9) throw new Error("pelvisStepsDeg: fewer than 9 values per frame");
	const out = new Float64Array(Math.max(0, frames - 1));
	for (let t = 0; t + 1 < frames; t += 1) {
		const a = t * stride, b = (t + 1) * stride;
		// trace(A^T B) = sum_ij A_ij B_ij
		let trace = 0;
		for (let k = 0; k < 9; k += 1) trace += rotMats[a + k] * rotMats[b + k];
		out[t] = Math.acos(Math.min(1, Math.max(-1, (trace - 1) / 2))) * DEG;
	}
	return out;
}

/** Solve A X = B in place (dense, partial pivoting). A: n x n rows, B: n x m rows. */
function solveDense(A, B) {
	const n = A.length, m = B[0].length;
	for (let c = 0; c < n; c += 1) {
		let p = c;
		for (let r = c + 1; r < n; r += 1) if (Math.abs(A[r][c]) > Math.abs(A[p][c])) p = r;
		if (!(Math.abs(A[p][c]) > 1e-300)) throw new Error("spline: singular system");
		[A[c], A[p]] = [A[p], A[c]];
		[B[c], B[p]] = [B[p], B[c]];
		for (let r = c + 1; r < n; r += 1) {
			const f = A[r][c] / A[c][c];
			if (f === 0) continue;
			for (let k = c; k < n; k += 1) A[r][k] -= f * A[c][k];
			for (let k = 0; k < m; k += 1) B[r][k] -= f * B[c][k];
		}
	}
	for (let r = n - 1; r >= 0; r -= 1) {
		for (let k = 0; k < m; k += 1) {
			let s = B[r][k];
			for (let c = r + 1; c < n; c += 1) s -= A[r][c] * B[c][k];
			B[r][k] = s / A[r][r];
		}
	}
	return B;
}

/**
 * Cubic spline with not-a-knot ends (scipy.interpolate.CubicSpline's
 * default) through `values[i][k]` at strictly increasing `times[i]`, evaluated
 * at `queries` (clamped to the knot range). Fewer than 4 knots: linear.
 * Returns queries.length rows of m values.
 */
export function splineResample(times, values, queries) {
	const n = times.length, m = values[0]?.length ?? 0;
	if (n < 2 || values.length !== n) throw new Error("splineResample: need >= 2 knots with one value row each");
	for (let i = 1; i < n; i += 1) if (!(times[i] > times[i - 1])) throw new Error("splineResample: times must increase");
	const h = Array.from({ length: n - 1 }, (_, i) => times[i + 1] - times[i]);
	let M = null; // second derivatives
	if (n >= 4) {
		const A = Array.from({ length: n }, () => new Float64Array(n));
		const B = Array.from({ length: n }, () => new Float64Array(m));
		A[0][0] = h[1]; A[0][1] = -(h[0] + h[1]); A[0][2] = h[0];
		A[n - 1][n - 3] = h[n - 2]; A[n - 1][n - 2] = -(h[n - 3] + h[n - 2]); A[n - 1][n - 1] = h[n - 3];
		for (let i = 1; i < n - 1; i += 1) {
			A[i][i - 1] = h[i - 1]; A[i][i] = 2 * (h[i - 1] + h[i]); A[i][i + 1] = h[i];
			for (let k = 0; k < m; k += 1) B[i][k] = 6 * ((values[i + 1][k] - values[i][k]) / h[i] - (values[i][k] - values[i - 1][k]) / h[i - 1]);
		}
		M = solveDense(A, B);
	}
	return Array.from(queries, (q0) => {
		const q = Math.min(times[n - 1], Math.max(times[0], q0));
		let i = 0, hi = n - 2;
		while (i < hi) { const mid = (i + hi + 1) >> 1; if (times[mid] <= q) i = mid; else hi = mid - 1; }
		const x0 = times[i], x1 = times[i + 1], hh = h[i], a = x1 - q, b = q - x0;
		const row = new Float64Array(m);
		for (let k = 0; k < m; k += 1) {
			const y0 = values[i][k], y1 = values[i + 1][k];
			row[k] = M
				? (M[i][k] * a ** 3 + M[i + 1][k] * b ** 3) / (6 * hh) + (y0 / hh - (M[i][k] * hh) / 6) * a + (y1 / hh - (M[i + 1][k] * hh) / 6) * b
				: (y0 * a + y1 * b) / hh;
		}
		return row;
	});
}

function jointCountOf(motion) {
	const count = motion.posedJoints.length / (motion.frames * 3);
	if (!Number.isInteger(count) || count < 1) throw new Error(`motion: ${motion.posedJoints.length} posedJoints values do not split into ${motion.frames} frames`);
	return count;
}

/** posedJoints of `motion` spline-resampled to `frames` frames at `fps` (times k / fps, clamped to the clip). */
export function resampleMotion(motion, fps, frames) {
	const joints = jointCountOf(motion), width = joints * 3;
	const times = Array.from({ length: motion.frames }, (_, i) => i / motion.fps);
	const rows = Array.from({ length: motion.frames }, (_, i) => motion.posedJoints.subarray ? motion.posedJoints.subarray(i * width, (i + 1) * width) : motion.posedJoints.slice(i * width, (i + 1) * width));
	const out = splineResample(times, rows, Array.from({ length: frames }, (_, k) => k / fps));
	const posedJoints = new Float64Array(frames * width);
	out.forEach((row, k) => posedJoints.set(row, k * width));
	return { frames, fps, posedJoints };
}

/**
 * Foot slide on truth-stance frames (cm/s). The truth is resampled (not-a-knot
 * cubic spline) to the prediction's timeline t_k = k / pred.fps; a foot joint
 * is in stance between k and k+1 when its truth 3D speed is below 0.10 m/s,
 * and the prediction's horizontal (XZ) speed there is pooled over the four
 * foot joints. Speeds are invariant to the rigid yaw/translation alignment
 * the prediction may need, so none is applied.
 */
export function truthStanceSlideCmPerS(pred, truth, { feet = STANCE_FEET, stanceSpeedMps = STANCE_SPEED_MPS } = {}) {
	const pj = jointCountOf(pred), tj = jointCountOf(truth);
	for (const j of feet) if (!(j < pj && j < tj)) throw new Error(`foot joint ${j} is outside the motions' joint count`);
	const n = pred.frames;
	const truthTimes = Array.from({ length: truth.frames }, (_, i) => i / truth.fps);
	const queries = Array.from({ length: n }, (_, k) => k / pred.fps);
	const truthRows = Array.from({ length: truth.frames }, (_, i) => feet.flatMap((j) => [0, 1, 2].map((c) => truth.posedJoints[(i * tj + j) * 3 + c])));
	const G = splineResample(truthTimes, truthRows, queries);
	const slides = [];
	for (let f = 0; f < feet.length; f += 1) {
		const j = feet[f];
		for (let k = 0; k + 1 < n; k += 1) {
			const gv = Math.hypot(G[k + 1][f * 3] - G[k][f * 3], G[k + 1][f * 3 + 1] - G[k][f * 3 + 1], G[k + 1][f * 3 + 2] - G[k][f * 3 + 2]) * pred.fps;
			if (!(gv < stanceSpeedMps)) continue;
			const a = (k * pj + j) * 3, b = ((k + 1) * pj + j) * 3;
			slides.push(Math.hypot(pred.posedJoints[b] - pred.posedJoints[a], pred.posedJoints[b + 2] - pred.posedJoints[a + 2]) * pred.fps);
		}
	}
	const total = feet.length * Math.max(0, n - 1);
	return {
		meanCmPerS: slides.length ? (slides.reduce((s, v) => s + v, 0) / slides.length) * 100 : null,
		stanceSamples: slides.length,
		stanceFraction: total ? slides.length / total : 0,
		rule: `truth foot 3D speed < ${stanceSpeedMps} m/s (truth spline-resampled to the prediction's ${pred.fps} fps); prediction XZ speed pooled over cskel27 joints ${feet.join(",")}`,
	};
}

function sameShape(a, b, what) {
	if (a.length !== b.length) throw new Error(`${what}: ${a.length} vs ${b.length} frames`);
	a.forEach((row, t) => { if (row.length !== b[t].length) throw new Error(`${what}: frame ${t} has ${row.length} vs ${b[t].length} joints`); });
}

/**
 * Agreement of per-frame, per-joint occlusion flags (true = hidden) with the
 * truth visibility (true = visible): the fraction of (frame, joint) pairs
 * where flagged === !visible, plus the confusion counts.
 */
export function occlusionAgreement(flags, truthVisibility) {
	sameShape(flags, truthVisibility, "occlusionAgreement");
	let pairs = 0, agree = 0, truthHidden = 0, flagged = 0, bothHidden = 0;
	flags.forEach((row, t) => row.forEach((flag, j) => {
		const hidden = !truthVisibility[t][j];
		pairs += 1;
		if (Boolean(flag) === hidden) agree += 1;
		if (hidden) truthHidden += 1;
		if (flag) flagged += 1;
		if (flag && hidden) bothHidden += 1;
	}));
	return {
		agreement: pairs ? agree / pairs : null,
		pairs,
		truthHidden,
		flagged,
		hiddenRecall: truthHidden ? bothHidden / truthHidden : null,
		flaggedPrecision: flagged ? bothHidden / flagged : null,
	};
}

/**
 * Mean Euclidean error (metres, Studio world frame, no alignment: the camera
 * is known) over exactly the (frame, joint) pairs flagged hidden.
 * pred / truth: [T][J][3]; flags: [T][J] booleans.
 */
export function hiddenJointError(pred, truth, flags) {
	sameShape(pred, truth, "hiddenJointError pred/truth");
	sameShape(pred, flags, "hiddenJointError pred/flags");
	let sum = 0, pairs = 0;
	flags.forEach((row, t) => row.forEach((flag, j) => {
		if (!flag) return;
		const p = pred[t][j], g = truth[t][j];
		sum += Math.hypot(p[0] - g[0], p[1] - g[1], p[2] - g[2]);
		pairs += 1;
	}));
	return { meanM: pairs ? sum / pairs : null, pairs };
}

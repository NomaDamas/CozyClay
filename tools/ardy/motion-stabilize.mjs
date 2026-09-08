/**
 * Small, model-agnostic cleanup pass for GVHMR retargets.
 *
 * GVHMR is temporally aware, but its per-frame segmentation/keypoint inputs
 * can still produce one-frame spikes.  This pass removes only high-frequency
 * residuals: the correction is centred on the neighbouring frames and its
 * strength falls as local speed increases.  A fast step therefore remains a
 * step while a stationary foot no longer buzzes in place.
 */

const JOINTS = 27;

const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));
const distance3 = (a, b) => Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]);

function smoothPositions(input, frames, stride, fps) {
	const out = new Float32Array(input);
	if (frames < 3) return { values: out, corrected: 0 };
	let corrected = 0;
	for (let f = 1; f < frames - 1; f += 1) {
		for (let item = 0; item < stride; item += 1) {
			const o = (f * stride + item) * 3;
			const p = (f - 1) * stride * 3 + item * 3;
			const n = (f + 1) * stride * 3 + item * 3;
			const prev = [input[p], input[p + 1], input[p + 2]];
			const curr = [input[o], input[o + 1], input[o + 2]];
			const next = [input[n], input[n + 1], input[n + 2]];
			const prevVelocity = [curr[0] - prev[0], curr[1] - prev[1], curr[2] - prev[2]];
			const nextVelocity = [next[0] - curr[0], next[1] - curr[1], next[2] - curr[2]];
			const speed = (distance3(curr, prev) + distance3(next, curr)) * 0.5 * fps;
			// At rest blend up to 35% towards the centred neighbour estimate;
			// above roughly 1 m/s preserve almost all of the authored motion.
			const reversal = prevVelocity[0] * nextVelocity[0] + prevVelocity[1] * nextVelocity[1] + prevVelocity[2] * nextVelocity[2] < 0;
			const blend = reversal ? 0.72 : clamp(0.35 - speed * 0.12, 0.04, 0.35);
			const correction = [(prev[0] + next[0]) * 0.5 - curr[0],
				(prev[1] + next[1]) * 0.5 - curr[1],
				(prev[2] + next[2]) * 0.5 - curr[2]];
			// Isolated reversals are segmentation outliers (often 10–15 cm on a
			// rendered limb), so permit a larger correction only in that case.
			const amount = Math.min(reversal ? 0.12 : 0.045, Math.hypot(...correction) * blend);
			if (amount < 1e-5) continue;
			const scale = amount / Math.max(Math.hypot(...correction), 1e-8);
			out[o] = curr[0] + correction[0] * scale;
			out[o + 1] = curr[1] + correction[1] * scale;
			out[o + 2] = curr[2] + correction[2] * scale;
			corrected += 1;
		}
	}
	return { values: out, corrected };
}

function matrixToQuat(m) {
	const trace = m[0] + m[4] + m[8];
	let x; let y; let z; let w;
	if (trace > 0) {
		const s = Math.sqrt(trace + 1) * 2; w = 0.25 * s; x = (m[7] - m[5]) / s; y = (m[2] - m[6]) / s; z = (m[3] - m[1]) / s;
	} else if (m[0] > m[4] && m[0] > m[8]) {
		const s = Math.sqrt(1 + m[0] - m[4] - m[8]) * 2; w = (m[7] - m[5]) / s; x = 0.25 * s; y = (m[1] + m[3]) / s; z = (m[2] + m[6]) / s;
	} else if (m[4] > m[8]) {
		const s = Math.sqrt(1 + m[4] - m[0] - m[8]) * 2; w = (m[2] - m[6]) / s; x = (m[1] + m[3]) / s; y = 0.25 * s; z = (m[5] + m[7]) / s;
	} else {
		const s = Math.sqrt(1 + m[8] - m[0] - m[4]) * 2; w = (m[3] - m[1]) / s; x = (m[2] + m[6]) / s; y = (m[5] + m[7]) / s; z = 0.25 * s;
	}
	const norm = Math.hypot(x, y, z, w) || 1;
	return [x / norm, y / norm, z / norm, w / norm];
}

function quatToMatrix(q) {
	const [x, y, z, w] = q;
	return [1 - 2 * (y * y + z * z), 2 * (x * y - z * w), 2 * (x * z + y * w),
		2 * (x * y + z * w), 1 - 2 * (x * x + z * z), 2 * (y * z - x * w),
		2 * (x * z - y * w), 2 * (y * z + x * w), 1 - 2 * (x * x + y * y)];
}

function slerp(a, b, t) {
	let d = a[0] * b[0] + a[1] * b[1] + a[2] * b[2] + a[3] * b[3];
		if (d < 0) { b = b.map((v) => -v); d = -d; }
	if (d > 0.9995) {
		const q = a.map((v, i) => v + (b[i] - v) * t); const n = Math.hypot(...q) || 1; return q.map((v) => v / n);
	}
	const angle = Math.acos(clamp(d, -1, 1));
	const sin = Math.sin(angle) || 1;
	const wa = Math.sin((1 - t) * angle) / sin; const wb = Math.sin(t * angle) / sin;
	return a.map((v, i) => v * wa + b[i] * wb);
}

function smoothRotations(input, frames, joints, fps) {
	const out = new Float32Array(input); if (frames < 3) return { values: out, corrected: 0 };
	let corrected = 0;
	for (let j = 0; j < joints; j += 1) {
		const qs = new Array(frames);
		for (let f = 0; f < frames; f += 1) qs[f] = matrixToQuat(input.subarray((f * joints + j) * 9, (f * joints + j + 1) * 9));
		for (let f = 1; f < frames - 1; f += 1) {
			const prev = qs[f - 1]; const curr = qs[f]; const next = qs[f + 1];
			const neighbour = slerp(prev, next, 0.5);
			const angular = 2 * Math.acos(clamp(Math.abs(curr[0] * prev[0] + curr[1] * prev[1] + curr[2] * prev[2] + curr[3] * prev[3]), -1, 1)) * fps;
			const blend = clamp(0.28 - angular * 0.035, 0.025, 0.28);
			const q = slerp(curr, neighbour, blend);
			const o = (f * joints + j) * 9; const m = quatToMatrix(q);
			for (let k = 0; k < 9; k += 1) out[o + k] = m[k];
			if (blend > 0.05) corrected += 1;
		}
	}
	return { values: out, corrected };
}

/** Return a copy of a converted motion with transient jitter reduced. */
function stabilizeContacts(root, posed, frames, fps, { contactHeight, groundY } = {}) {
	const outRoot = new Float32Array(root); const outPosed = new Float32Array(posed);
	const feet = [21, 22, 25, 26]; const window = Math.max(2, Math.round(fps * .12));
	let corrected = 0; const targetHeight = Number.isFinite(contactHeight) ? contactHeight : (Number.isFinite(groundY) ? groundY : null);
	// Without an explicit surface datum we cannot tell floor contact from a
	// step, stair, or chair. Leave the source trajectory untouched; smoothing
	// above remains safe for every scene.
	if (targetHeight === null) return { root: outRoot, posed: outPosed, corrected };
	for (let f = window; f < frames - window; f += 1) {
		const samples = [];
		for (const j of feet) {
			const speed = distance3(
				[posed[(f * JOINTS + j) * 3], posed[(f * JOINTS + j) * 3 + 1], posed[(f * JOINTS + j) * 3 + 2]],
				[posed[((f - window) * JOINTS + j) * 3], posed[((f - window) * JOINTS + j) * 3 + 1], posed[((f - window) * JOINTS + j) * 3 + 2]],
			) / (window / fps);
			const ys = []; for (let t = f - window; t <= f + window; t += 1) ys.push(posed[(t * JOINTS + j) * 3 + 1]);
			const spread = Math.max(...ys) - Math.min(...ys);
			if (speed < .08 && spread < .025) samples.push(j);
		}
		// Bilateral contact is a conservative signal that root translation should
		// not buzz. Single-foot IK belongs to the character-specific solver.
		if (samples.length < 2) continue;
		let dx = 0; let dy = 0; let dz = 0;
		for (const j of samples) { const o = (f * JOINTS + j) * 3; dx += posed[o]; dy += posed[o + 1]; dz += posed[o + 2]; }
		dx /= samples.length; dy /= samples.length; dz /= samples.length;
		if (targetHeight !== null) dy -= targetHeight;
		// Apply only a small centred correction; larger changes indicate a real
		// step or jump and are left to the source trajectory.
		const prevAvg = [0, 0, 0]; const nextAvg = [0, 0, 0];
		for (const j of samples) {
			for (let k = 0; k < 3; k += 1) { prevAvg[k] += posed[((f - 1) * JOINTS + j) * 3 + k]; nextAvg[k] += posed[((f + 1) * JOINTS + j) * 3 + k]; }
		}
		for (let k = 0; k < 3; k += 1) { prevAvg[k] /= samples.length; nextAvg[k] /= samples.length; }
		const correction = [((prevAvg[0] + nextAvg[0]) * .5 - dx), targetHeight !== null ? targetHeight - dy : ((prevAvg[1] + nextAvg[1]) * .5 - dy), ((prevAvg[2] + nextAvg[2]) * .5 - dz)];
		const amount = Math.min(.025, Math.hypot(...correction));
		if (amount < 1e-4) continue;
		const scale = amount / Math.max(Math.hypot(...correction), 1e-8);
		for (let j = 0; j < JOINTS; j += 1) { const o = (f * JOINTS + j) * 3; outPosed[o] += correction[0] * scale; outPosed[o + 1] += correction[1] * scale; outPosed[o + 2] += correction[2] * scale; }
		outRoot[f * 3] += correction[0] * scale; outRoot[f * 3 + 1] += correction[1] * scale; outRoot[f * 3 + 2] += correction[2] * scale; corrected += 1;
	}
	return { root: outRoot, posed: outPosed, corrected };
}

export function stabilizeMotion(motion, { enabled = true, smoothRotations: smoothRotationSeries = true, contactHeight, groundY } = {}) {
	if (!enabled || !motion || motion.frames < 3) return { ...motion, stabilization: { enabled: false, correctedPositions: 0, correctedRotations: 0 } };
	const frames = motion.frames; const fps = Number(motion.fps) || 30;
	const root = smoothPositions(motion.rootPos, frames, 1, fps);
	const posed = smoothPositions(motion.posedJoints, frames, JOINTS, fps);
	const rotations = smoothRotationSeries ? smoothRotations(motion.rotMats, frames, JOINTS, fps) : { values: new Float32Array(motion.rotMats), corrected: 0 };
	// Keep the root channel and the Hips joint coherent after filtering.
	for (let f = 0; f < frames; f += 1) {
		root.values[f * 3] = posed.values[(f * JOINTS) * 3];
		root.values[f * 3 + 1] = posed.values[(f * JOINTS) * 3 + 1];
		root.values[f * 3 + 2] = posed.values[(f * JOINTS) * 3 + 2];
	}
	const contacts = stabilizeContacts(root.values, posed.values, frames, fps, { contactHeight, groundY });
	return { ...motion, rootPos: contacts.root, posedJoints: contacts.posed, rotMats: rotations.values,
		stabilization: { enabled: true, correctedPositions: posed.corrected + root.corrected, correctedRotations: rotations.corrected,
			correctedContacts: contacts.corrected, contactHeight: Number.isFinite(contactHeight) ? contactHeight : (Number.isFinite(groundY) ? groundY : null), fps } };
}

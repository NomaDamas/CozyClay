/**
 * Small, model-agnostic cleanup pass for GVHMR retargets.
 *
 * GVHMR is temporally aware, but its per-frame segmentation/keypoint inputs
 * can still produce one-frame spikes.  This pass removes only high-frequency
 * residuals: the correction is centred on the neighbouring frames and its
 * strength falls as local speed increases.  A fast step therefore remains a
 * step while a stationary foot no longer buzzes in place.
 *
 * KINEMATIC CONSISTENCY. Only the rotations and the root trajectory are
 * filtered. posedJoints are never smoothed on their own: they are rebuilt by
 * forward kinematics from the filtered rotations, the take's own skeleton
 * (canonical cskel27 offsets x boneScale, exactly as smpl-cskel27.mjs grows
 * them) and the final root. Filtering joint positions independently let a
 * limb's drawn position drift from its rotation, so bones changed length
 * frame to frame and the skinned mesh disagreed with the joints. Spike and
 * dropout repair therefore act on each joint's local rotation, and contact
 * and foot anchoring move the root only (a rigid shift of the whole body).
 */
import { deriveBoneOffsets, forwardKinematics } from "../../src/ardy/convert.js";
import { canonicalCskel27Reference } from "../../src/ardy/to-cskel27.js";

const JOINTS = 27;

// Canonical cskel27 bone offsets; a take scales each by its boneScale.
const CANONICAL_OFFSETS = (() => {
	const skeleton = canonicalCskel27Reference();
	return deriveBoneOffsets(skeleton.posed_joints, skeleton.local_rot_mats);
})();

/** The take's skeleton: the same offsets smplToCskel27Motion grows posedJoints over. */
function takeBoneOffsets(boneScale) {
	return CANONICAL_OFFSETS.map((o, j) => { const s = boneScale?.[j] ?? 1; return [o[0] * s, o[1] * s, o[2] * s]; });
}

/** posedJoints for every frame by FK of `rotMats` over `offsets` from `rootPos`. */
function posedFromRotations(rotMats, rootPos, frames, offsets) {
	const out = new Float32Array(frames * JOINTS * 3);
	for (let f = 0; f < frames; f += 1) {
		const locals = new Array(JOINTS);
		for (let j = 0; j < JOINTS; j += 1) {
			const o = (f * JOINTS + j) * 9;
			locals[j] = [[rotMats[o], rotMats[o + 1], rotMats[o + 2]], [rotMats[o + 3], rotMats[o + 4], rotMats[o + 5]], [rotMats[o + 6], rotMats[o + 7], rotMats[o + 8]]];
		}
		const positions = forwardKinematics(locals, offsets, [rootPos[f * 3], rootPos[f * 3 + 1], rootPos[f * 3 + 2]]);
		for (let j = 0; j < JOINTS; j += 1) out.set(positions[j], (f * JOINTS + j) * 3);
	}
	return out;
}

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
			// Isolated reversals are segmentation outliers, so permit a larger
			// correction only in that case.
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

/** Angle (rad) of the rotation carrying unit quaternion a onto b. */
const quatAngle = (a, b) => 2 * Math.acos(clamp(Math.abs(a[0] * b[0] + a[1] * b[1] + a[2] * b[2] + a[3] * b[3]), 0, 1));

/** Vector part of b * conj(a) on the w >= 0 hemisphere: the axis of the step a -> b, scaled by sin(angle / 2). */
function quatStep(a, b) {
	const [ax, ay, az, aw] = a; const [bx, by, bz, bw] = b;
	const sign = ax * bx + ay * by + az * bz + aw * bw < 0 ? -1 : 1;
	return [sign * (-bw * ax + bx * aw - by * az + bz * ay), sign * (-bw * ay + bx * az + by * aw - bz * ax), sign * (-bw * az - bx * ay + by * ax + bz * aw)];
}

// Rotation-space limits. The position-space pass these replace was tuned in
// metres on limbs; each angle is that distance over a ~0.4 m limb segment.
const SPIKE_CAP = 0.3; // rad, one-frame reversal (12 cm)
const DROPOUT_ANGLE = 0.2; // rad off the long chord before a frame is a dropout candidate (8 cm)
const DROPOUT_CHORD_SPEED = 5; // rad/s; faster surrounding motion is a real gesture (2 m/s)
const DROPOUT_STEP = 0.04; // rad/frame; a dropout plateau barely moves inside its run (1.5 cm)
const DROPOUT_CAP = 0.25; // rad, largest dropout repair per frame (10 cm)

function smoothRotations(input, frames, joints, fps) {
	const out = new Float32Array(input); if (frames < 3) return { values: out, corrected: 0 };
	let corrected = 0;
	// About 100 ms either side, so 24, 30 and 60 fps clips behave alike.
	const radius = Math.max(3, Math.min(5, Math.round(fps * 0.1)));
	for (let j = 0; j < joints; j += 1) {
		const qs = new Array(frames);
		for (let f = 0; f < frames; f += 1) qs[f] = matrixToQuat(input.subarray((f * joints + j) * 9, (f * joints + j + 1) * 9));
		const pass = qs.slice();
		for (let f = 1; f < frames - 1; f += 1) {
			const prev = qs[f - 1]; const curr = qs[f]; const next = qs[f + 1];
			const neighbour = slerp(prev, next, 0.5);
			const angular = quatAngle(prev, curr) * fps;
			// A step that turns straight back is a one-frame segmentation outlier
			// (a limb snapping out and back), so it may take a larger correction.
			const stepIn = quatStep(prev, curr); const stepOut = quatStep(curr, next);
			const reversal = stepIn[0] * stepOut[0] + stepIn[1] * stepOut[1] + stepIn[2] * stepOut[2] < 0;
			const blend = reversal ? 0.72 : clamp(0.28 - angular * 0.035, 0.025, 0.28);
			const offset = quatAngle(curr, neighbour);
			const moved = Math.min(reversal ? SPIKE_CAP : offset, offset * blend);
			if (offset > 1e-9) pass[f] = slerp(curr, neighbour, moved / offset);
			if (blend > 0.05) corrected += 1;
		}
		// A detector dropout can hold a limb at the wrong angle for a few frames.
		// The three-tap pass above repairs the edges of that burst but not its
		// centre, so detect a short plateau against a longer chord, read off the
		// raw series so a correction cannot spread into clean entry/exit frames.
		// The Hips rotation is the authored body orientation (a real quick turn
		// is short and large), so only joints below it are eligible.
		const final = pass.slice();
		if (j > 0 && frames > radius * 2 + 1) {
			const candidates = new Uint8Array(frames);
			for (let f = radius; f < frames - radius; f += 1) {
				if (quatAngle(qs[f], slerp(qs[f - radius], qs[f + radius], 0.5)) < DROPOUT_ANGLE) continue;
				// Preserve fast gestures: the chord is only a dropout signal when
				// the surrounding motion is slow.
				if (quatAngle(qs[f - radius], qs[f + radius]) * fps / (2 * radius) > DROPOUT_CHORD_SPEED) continue;
				candidates[f] = 1;
			}
			for (let f = radius; f < frames - radius;) {
				if (!candidates[f]) { f += 1; continue; }
				const start = f;
				while (f < frames - radius && candidates[f]) f += 1;
				// Two adjacent outliers are required: a one-frame snap is the
				// three-tap pass's job. A run that moves quickly inside itself is a
				// real gesture, not a held dropout.
				if (f - start < 2) continue;
				let coherent = true;
				for (let g = start + 1; g < f && coherent; g += 1) coherent = quatAngle(qs[g - 1], qs[g]) <= DROPOUT_STEP;
				if (!coherent) continue;
				for (let g = start; g < f; g += 1) {
					const estimate = slerp(pass[g - radius], pass[g + radius], 0.5);
					const residual = quatAngle(pass[g], estimate);
					const moved = Math.min(DROPOUT_CAP, residual * 0.9);
					if (moved < 1e-5) continue;
					final[g] = slerp(pass[g], estimate, moved / residual);
					corrected += 1;
				}
			}
		}
		for (let f = 1; f < frames - 1; f += 1) {
			const o = (f * joints + j) * 9; const m = quatToMatrix(final[f]);
			for (let k = 0; k < 9; k += 1) out[o + k] = m[k];
		}
	}
	return { values: out, corrected };
}

/** Root trajectory with bilateral-contact buzz removed. `posed` is read only;
 *  the correction is a rigid body shift, applied to the root alone. */
function stabilizeContacts(root, posed, frames, fps, { contactHeight, groundY } = {}) {
	const outRoot = new Float32Array(root);
	const feet = [21, 22, 25, 26]; const window = Math.max(2, Math.round(fps * .12));
	let corrected = 0; const targetHeight = Number.isFinite(contactHeight) ? contactHeight : (Number.isFinite(groundY) ? groundY : null);
	// Without an explicit surface datum we cannot tell floor contact from a
	// step, stair, or chair. Leave the source trajectory untouched; smoothing
	// above remains safe for every scene.
	if (targetHeight === null) return { root: outRoot, corrected };
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
		outRoot[f * 3] += correction[0] * scale; outRoot[f * 3 + 1] += correction[1] * scale; outRoot[f * 3 + 2] += correction[2] * scale; corrected += 1;
	}
	return { root: outRoot, corrected };
}

/**
 * Foot-anchored root re-integration (#380).
 *
 * GVHMR integrates the root from per-frame velocity and, on rendered clips,
 * under-scales the stride: measured on v13c the stance ankle moonwalked at
 * 45 cm/s in world while the hips advanced 49 cm/s — the legs walk faster
 * than the body moves. Its contact logits did not correlate with planted
 * frames (r <= 0.09) so the anchor is read off the take itself: per frame the
 * foot that is BOTH lowest and slowest is the support, and the whole body is
 * shifted rigidly (root + every joint by one vector) so that foot holds the
 * world XZ it had when its stance run began. A rigid shift keeps every pose
 * exactly as authored; only the trajectory changes. Y is never touched (a
 * step, stair or chair is a real height change).
 *
 * Stance is a run: the anchor is only trusted once a foot has been low+slow
 * for MIN_STANCE frames, and it releases as soon as the foot lifts or
 * accelerates. Low and slow are both read off the INPUT arrays (the shift is
 * written to copies), so the correction cannot feed back into its own
 * trigger. Between runs the accumulated offset is held, never reset, so the
 * take stays continuous. Only the root is returned: the caller rebuilds every
 * joint from it by FK, which is the rigid shift.
 */
function anchorFeetToFloor(root, reference, frames, fps) {
	const outRoot = new Float32Array(root);
	const FEET = [21, 22, 25, 26];
	const MIN_STANCE = Math.max(2, Math.round(fps * 0.08));
	// Stance is read off `reference` — the AUTHORED joints, before the spike
	// filter above: its reversal branch moves the last stance frame (a
	// velocity reversal by definition), which would shorten every run by one
	// frame and leave that frame sliding.
	const at = (f, j, a) => reference[(f * JOINTS + j) * 3 + a];
	const heights = FEET.map((j) => Array.from({ length: frames }, (_, f) => at(f, j, 1)));
	const low = FEET.map((_, i) => { const s = [...heights[i]].sort((a, b) => a - b); return s[Math.floor((s.length - 1) * 0.35)]; });
	// World horizontal speed of the authored foot. Stance is low AND slow;
	// "slow" is half the foot's upper-quartile speed (its swing), which
	// separates the two phases without depending on the walk's duty cycle —
	// a median gate sits ON the stance speed of a 50/50 gait and then admits
	// or rejects stance frames on float noise.
	const speed = FEET.map((j) => Array.from({ length: frames }, (_, f) => f === 0 ? 0 : Math.hypot(at(f, j, 0) - at(f - 1, j, 0), at(f, j, 2) - at(f - 1, j, 2)) * fps));
	const quantile = (v, q) => { const s = [...v].sort((a, b) => a - b); return s[Math.floor((s.length - 1) * q)]; };
	const slow = speed.map((v) => quantile(v, 0.75) * 0.5);
	const planted = (i, f) => heights[i][f] <= low[i] + 0.01 && speed[i][f] <= slow[i];
	// Pass 1: stance runs. A run is one foot planted for >= MIN_STANCE
	// consecutive frames; the lowest such foot carries the frame. Runs of the
	// same foot that touch are one run.
	const support = new Int8Array(frames).fill(-1);
	for (let f = 0; f < frames; f += 1) {
		let best = -1;
		for (let i = 0; i < FEET.length; i += 1) {
			let run = 0; for (let t = f; t >= 0 && planted(i, t); t -= 1) run += 1;
			for (let t = f + 1; t < frames && run < MIN_STANCE && planted(i, t); t += 1) run += 1;
			if (run >= MIN_STANCE && (best < 0 || heights[i][f] < heights[best][f])) best = i;
		}
		support[f] = best;
	}
	// Pass 2: the offset that holds each run's foot at its landing position.
	// Inside a run only the foot's DRIFT is cancelled — the straight line from
	// where it landed to where it lifted, which is the under-scaled stride —
	// never its frame-to-frame wobble: mirroring that wobble into the root
	// would move the whole body by the foot's estimation noise (measured:
	// +4.4 mm/f² of root jitter for -25 cm/s of slide). Across the gap between
	// two runs the offset ramps linearly so the swap is spread over the swing.
	// Every pose is shifted rigidly per frame.
	const offsets = new Array(frames).fill(null);
	let anchoredFrames = 0; let carry = [0, 0]; let f = 0;
	while (f < frames) {
		const i = support[f];
		if (i < 0) { f += 1; continue; }
		let g = f; while (g + 1 < frames && support[g + 1] === i) g += 1;
		const j = FEET[i];
		// Land where the previous run left the body: the foot's own position
		// at the run's first frame plus the offset carried in.
		const driftX = at(g, j, 0) - at(f, j, 0), driftZ = at(g, j, 2) - at(f, j, 2), len = Math.max(1, g - f);
		for (let t = f; t <= g; t += 1) { const w = (t - f) / len; offsets[t] = [carry[0] - driftX * w, carry[1] - driftZ * w]; anchoredFrames += 1; }
		carry = offsets[g];
		f = g + 1;
	}
	// Fill the gaps: lead-in holds the first run's offset, gaps ramp, tail holds.
	let prev = -1;
	for (let t = 0; t < frames; t += 1) {
		if (offsets[t]) { prev = t; continue; }
		let nextAt = t; while (nextAt < frames && !offsets[nextAt]) nextAt += 1;
		const a = prev >= 0 ? offsets[prev] : (nextAt < frames ? offsets[nextAt] : [0, 0]);
		const b = nextAt < frames ? offsets[nextAt] : a;
		const span = nextAt - (prev >= 0 ? prev : t - 1);
		for (let u = t; u < nextAt; u += 1) { const w = prev >= 0 && nextAt < frames ? (u - prev) / span : 0; offsets[u] = [a[0] + (b[0] - a[0]) * w, a[1] + (b[1] - a[1]) * w]; }
		t = nextAt - 1;
	}
	// The offset series is piecewise linear with a slope change at every run
	// and gap boundary (the stride correction differs per step). Blur it over
	// ~120 ms so the body's velocity, not just its position, is continuous:
	// the slope changes become ramps and add no second-difference of their own.
	// A blur this short leaves the stance foot within a few mm of still.
	const radius = Math.max(1, Math.round(fps * 0.08));
	const kernel = []; let norm = 0;
	for (let k = -radius; k <= radius; k += 1) { const w = Math.exp(-0.5 * (k / (radius / 2)) ** 2); kernel.push(w); norm += w; }
	for (let t = 0; t < frames; t += 1) {
		let ox = 0, oz = 0;
		for (let k = -radius; k <= radius; k += 1) { const u = Math.min(frames - 1, Math.max(0, t + k)); const w = kernel[k + radius] / norm; ox += offsets[u][0] * w; oz += offsets[u][1] * w; }
		outRoot[t * 3] = root[t * 3] + ox; outRoot[t * 3 + 2] = root[t * 3 + 2] + oz;
	}
	return { root: outRoot, anchoredFrames };
}

export function stabilizeMotion(motion, { enabled = true, smoothRotations: smoothRotationSeries = true, contactHeight, groundY, anchorFeet = false } = {}) {
	if (!enabled || !motion || motion.frames < 3) return { ...motion, stabilization: { enabled: false, correctedPositions: 0, correctedRotations: 0, anchoredFrames: 0 } };
	const frames = motion.frames; const fps = Number(motion.fps) || 30;
	const offsets = takeBoneOffsets(motion.boneScale);
	const root = smoothPositions(motion.rootPos, frames, 1, fps);
	const rotations = smoothRotationSeries ? smoothRotations(motion.rotMats, frames, JOINTS, fps) : { values: new Float32Array(motion.rotMats), corrected: 0 };
	// Contact detection reads the filtered pose. Both root corrections below
	// are rigid shifts of the whole body, so the output joints are rebuilt by
	// FK from the final root: posedJoints follow rotMats by construction.
	const filteredPose = posedFromRotations(rotations.values, root.values, frames, offsets);
	const contacts = stabilizeContacts(root.values, filteredPose, frames, fps, { contactHeight, groundY });
	const anchored = anchorFeet ? anchorFeetToFloor(contacts.root, motion.posedJoints, frames, fps) : { root: contacts.root, anchoredFrames: 0 };
	const posedJoints = posedFromRotations(rotations.values, anchored.root, frames, offsets);
	return { ...motion, rootPos: anchored.root, posedJoints, rotMats: rotations.values,
		stabilization: { enabled: true, correctedPositions: root.corrected, correctedRotations: rotations.corrected,
			correctedContacts: contacts.corrected, anchoredFrames: anchored.anchoredFrames, contactHeight: Number.isFinite(contactHeight) ? contactHeight : (Number.isFinite(groundY) ? groundY : null), fps } };
}

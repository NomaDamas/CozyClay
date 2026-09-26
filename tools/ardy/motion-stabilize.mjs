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
	// A segmentation/keypoint dropout can persist for a few frames. A single
	// three-tap pass repairs the edges of that burst but leaves its centre at the
	// wrong location. Detect a short burst against a longer chord, using the
	// immutable source so a correction cannot spread into clean entry/exit
	// frames. The radius is tied to time (about 100 ms), not a fixed frame count,
	// so 24, 30 and 60 fps clips behave alike.
	const radius = Math.max(3, Math.min(5, Math.round(fps * 0.1)));
	if (frames > radius * 2 + 1) {
		const pass = new Float32Array(out);
		// Hips (joint 0) is the authored root trajectory. A real stair or chair
		// ascent can be a short, high-amplitude change, so never run the dropout
		// repair over it; only limb observations are eligible.
		const firstItem = stride === JOINTS ? 1 : stride;
		for (let item = firstItem; item < stride; item += 1) {
			// First identify a contiguous run from the raw input. Requiring two
			// adjacent outliers rejects a genuine one-frame limb snap, which the
			// preceding three-tap pass already handles with a smaller correction.
			const candidates = new Uint8Array(frames);
			for (let f = radius; f < frames - radius; f += 1) {
				const o = (f * stride + item) * 3;
				const before = ((f - radius) * stride + item) * 3;
				const after = ((f + radius) * stride + item) * 3;
				const rawCurrent = [input[o], input[o + 1], input[o + 2]];
				const rawEstimate = [(input[before] + input[after]) * 0.5,
					(input[before + 1] + input[after + 1]) * 0.5,
					(input[before + 2] + input[after + 2]) * 0.5];
				// 8 cm is above ordinary retarget noise and catches the short,
				// high-amplitude plateaus seen when a detector loses a limb.
				if (distance3(rawCurrent, rawEstimate) < 0.08) continue;
				const spanSpeed = distance3(
					[input[before], input[before + 1], input[before + 2]],
					[input[after], input[after + 1], input[after + 2]],
				) * fps / (2 * radius);
				// Preserve running/throwing trajectories; the long chord is only a
				// dropout signal when the surrounding motion is below 2 m/s.
				if (spanSpeed > 2) continue;
				candidates[f] = 1;
			}
			for (let f = radius; f < frames - radius;) {
				if (!candidates[f]) { f += 1; continue; }
				const start = f;
				while (f < frames - radius && candidates[f]) f += 1;
				if (f - start < 2) continue;
			// A dropout plateau has almost no movement inside its run. Reject a
			// run whose own samples are moving quickly; that is a real gesture,
			// even when its longer chord happens to curve by several centimetres.
				let coherent = true;
				for (let g = start + 1; g < f; g += 1) {
					const prev = ((g - 1) * stride + item) * 3;
					const curr = (g * stride + item) * 3;
				if (distance3([input[prev], input[prev + 1], input[prev + 2]], [input[curr], input[curr + 1], input[curr + 2]]) > 0.015) {
						coherent = false;
						break;
					}
				}
				if (!coherent) continue;
				for (let currentFrame = start; currentFrame < f; currentFrame += 1) {
					const o = (currentFrame * stride + item) * 3;
					const before = ((currentFrame - radius) * stride + item) * 3;
					const after = ((currentFrame + radius) * stride + item) * 3;
				const estimate = [(pass[before] + pass[after]) * 0.5,
					(pass[before + 1] + pass[after + 1]) * 0.5,
					(pass[before + 2] + pass[after + 2]) * 0.5];
				const current = [pass[o], pass[o + 1], pass[o + 2]];
				const residual = distance3(current, estimate);
				const amount = Math.min(0.1, residual * 0.9);
				if (amount < 1e-5) continue;
				const scale = amount / Math.max(residual, 1e-8);
				out[o] = current[0] + (estimate[0] - current[0]) * scale;
				out[o + 1] = current[1] + (estimate[1] - current[1]) * scale;
				out[o + 2] = current[2] + (estimate[2] - current[2]) * scale;
					corrected += 1;
				}
			}
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
 * take stays continuous.
 */
function anchorFeetToFloor(root, posed, frames, fps, reference = posed) {
	const outRoot = new Float32Array(root); const outPosed = new Float32Array(posed);
	const FEET = [21, 22, 25, 26];
	const MIN_STANCE = Math.max(2, Math.round(fps * 0.08));
	// Stance is read off `reference` — the AUTHORED joints, before the spike
	// filter above: that filter's reversal branch moves the last stance frame
	// (a velocity reversal by definition) by up to 2 cm, which would shorten
	// every run by one frame and leave that frame sliding.
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
		for (let j = 0; j < JOINTS; j += 1) { const o = (t * JOINTS + j) * 3; outPosed[o] = posed[o] + ox; outPosed[o + 2] = posed[o + 2] + oz; }
		outRoot[t * 3] = root[t * 3] + ox; outRoot[t * 3 + 2] = root[t * 3 + 2] + oz;
	}
	return { root: outRoot, posed: outPosed, anchoredFrames };
}

export function stabilizeMotion(motion, { enabled = true, smoothRotations: smoothRotationSeries = true, contactHeight, groundY, anchorFeet = false } = {}) {
	if (!enabled || !motion || motion.frames < 3) return { ...motion, stabilization: { enabled: false, correctedPositions: 0, correctedRotations: 0, anchoredFrames: 0 } };
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
	const anchored = anchorFeet ? anchorFeetToFloor(contacts.root, contacts.posed, frames, fps, motion.posedJoints) : { root: contacts.root, posed: contacts.posed, anchoredFrames: 0 };
	return { ...motion, rootPos: anchored.root, posedJoints: anchored.posed, rotMats: rotations.values,
		stabilization: { enabled: true, correctedPositions: posed.corrected + root.corrected, correctedRotations: rotations.corrected,
			correctedContacts: contacts.corrected, anchoredFrames: anchored.anchoredFrames, contactHeight: Number.isFinite(contactHeight) ? contactHeight : (Number.isFinite(groundY) ? groundY : null), fps } };
}

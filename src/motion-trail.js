/**
 * Motion trail math for the IK-mode 3D trajectory line editor.
 *
 * A "trail" is the world-space polyline of one clip-space track (the root, or
 * one effector joint) across every frame of the loaded take. The clip-to-world
 * mapping mirrors sample-at.js rootAt(): frame positions are re-based on the
 * anchor frame's root, rotated by the take's clip-to-scene yaw, and offset by
 * the scene anchor. All functions are pure: deformations return NEW motion
 * objects with cloned arrays and never touch the caller's take.
 */

import { CSKEL27_JOINTS, CSKEL27_PARENTS } from "./ardy/cskel27.js";
import { motionJointPositions, motionJointPositionsAt } from "./ardy/playback.js";
import { renderMotionEdit } from "./ardy/motion-edit.js";

/** Metres per rig unit: Character scales the Mixamo centimetre rig by 0.01 * stature. */
const RIG_UNIT_METRES = 0.01;

const JOINTS = CSKEL27_JOINTS.length;
const jointIndex = (name) => CSKEL27_JOINTS.indexOf(name);

/** Limb trail track -> two-bone chain [root, mid, effector] its drag bends. */
const LIMB_CHAINS = {
	leftHand: ["LeftArm", "LeftForeArm", "LeftHand"],
	rightHand: ["RightArm", "RightForeArm", "RightHand"],
	leftFoot: ["LeftUpLeg", "LeftLeg", "LeftFoot"],
	rightFoot: ["RightUpLeg", "RightLeg", "RightFoot"],
};

/**
 * The always-drawn trail tracks: root plus every IK chain endpoint and the
 * head, coloured exactly like their viewport IK/FK handles (posestudio.jsx
 * coding: arms orange, legs blue, torso yellow, head purple). Pick order is
 * limbs-first so an overlapping grab prefers the finer target; hips last.
 */
export const TRAIL_TRACKS = [
	{ id: "leftHand", joint: "LeftHand", color: "#ff8a3d" },
	{ id: "rightHand", joint: "RightHand", color: "#ff8a3d" },
	{ id: "leftFoot", joint: "LeftFoot", color: "#4dd2ff" },
	{ id: "rightFoot", joint: "RightFoot", color: "#4dd2ff" },
	{ id: "head", joint: "Head", color: "#b98cff" },
	{ id: "hips", joint: "Hips", color: "#ffd23d" },
];

/** ikFocus token -> cskel27 joint whose posed position draws the effector trail. */
export const TRAIL_EFFECTOR_JOINTS = {
	hips: "Hips",
	spine: "Spine1",
	chest: "Spine2",
	neck: "Neck",
	head: "Head",
	leftShoulder: "LeftArm",
	leftElbow: "LeftForeArm",
	leftHand: "LeftHand",
	rightShoulder: "RightArm",
	rightElbow: "RightForeArm",
	rightHand: "RightHand",
	leftKnee: "LeftLeg",
	leftFoot: "LeftFoot",
	rightKnee: "RightLeg",
	rightFoot: "RightFoot",
};

function anchorBasis(motion) {
	const frames = motion?.frames ?? 0;
	const anchorFrame = Math.max(0, Math.min(motion?.anchorFrame || 0, Math.max(0, frames - 1)));
	const radians = (((Number.isFinite(motion?.rotationDeg) ? motion.rotationDeg : 0) * Math.PI) / 180);
	return {
		anchorFrame,
		cos: Math.cos(radians),
		sin: Math.sin(radians),
		anchorX: Number.isFinite(motion?.anchorX) ? motion.anchorX : 0,
		anchorZ: Number.isFinite(motion?.anchorZ) ? motion.anchorZ : 0,
		// The anchor frame's ROOT joint pins the clip to the scene anchor —
		// the same re-basing applyMotionFrame and rootAt use.
		rootX: motion?.posedJoints?.[(anchorFrame * JOINTS) * 3] ?? motion?.rootPos?.[anchorFrame * 3] ?? 0,
		rootZ: motion?.posedJoints?.[(anchorFrame * JOINTS) * 3 + 2] ?? motion?.rootPos?.[anchorFrame * 3 + 2] ?? 0,
	};
}

/** Clip-space (x, z) of one frame of one track -> world (x, z). */
function toWorldXZ(basis, x, z) {
	const dx = x - basis.rootX;
	const dz = z - basis.rootZ;
	return [
		basis.anchorX + dx * basis.cos + dz * basis.sin,
		basis.anchorZ + -dx * basis.sin + dz * basis.cos,
	];
}

/** Rendered rig-space samples of one joint, or null when the rig drives no bone for it. */
function renderedSamples(motion, joint, rig) {
	if (!rig) return null;
	const samples = motionJointPositions(rig, motion);
	return samples && Number.isFinite(samples.positions[joint * 3]) ? samples : null;
}

/**
 * World-space polyline of one cskel27 joint across the take.
 * Returns a flat [x0,y0,z0, x1,y1,z1, ...] array of length frames*3.
 * `baseY` is the character entry's stage height (roof scenes ride above 0).
 * With `rig`, the points are where playback RENDERS that joint's bone on this
 * rig (rig proportions, prep scale, bind offsets); without it, the clip's
 * own posedJoints (the space pins and the wire use).
 */
export function jointTrailPoints(motion, jointName = "Hips", { baseY = 0, scale = 1, rig = null } = {}) {
	if (!motion?.posedJoints || !(motion.frames > 0)) return null;
	const joint = CSKEL27_JOINTS.indexOf(jointName);
	if (joint < 0) return null;
	const basis = anchorBasis(motion);
	const out = new Float32Array(motion.frames * 3);
	const rendered = renderedSamples(motion, joint, rig);
	if (rendered) {
		// The Character group: anchor position, clip yaw, 0.01 * stature scale.
		// Rig space is already anchor-relative (applyMotionFrame rebases).
		const unit = RIG_UNIT_METRES * scale;
		for (let f = 0; f < motion.frames; f += 1) {
			const po = (f * JOINTS + joint) * 3;
			const x = rendered.positions[po] * unit;
			const z = rendered.positions[po + 2] * unit;
			out[f * 3] = basis.anchorX + x * basis.cos + z * basis.sin;
			out[f * 3 + 1] = baseY + rendered.positions[po + 1] * unit;
			out[f * 3 + 2] = basis.anchorZ - x * basis.sin + z * basis.cos;
		}
		return out;
	}
	for (let f = 0; f < motion.frames; f += 1) {
		const po = (f * JOINTS + joint) * 3;
		const [wx, wz] = toWorldXZ(basis, motion.posedJoints[po], motion.posedJoints[po + 2]);
		out[f * 3] = basis.anchorX + (wx - basis.anchorX) * scale;
		out[f * 3 + 1] = baseY + motion.posedJoints[po + 1] * scale;
		out[f * 3 + 2] = basis.anchorZ + (wz - basis.anchorZ) * scale;
	}
	return out;
}

/**
 * A world-space POINT -> the take's own clip space — the exact inverse of what
 * jointTrailPoints does on the way out.
 *
 * WHY THIS EXISTS, and why it is not worldDeltaToClip. That one inverts the yaw
 * only, which is all a DELTA needs: rebasing and the anchor offset cancel in a
 * difference, and scale is applied by the caller. An absolute point has to undo
 * the whole chain — scale about the anchor, the yaw, the anchor offset, the
 * anchor frame's root rebase and baseY — because it is going to be compared
 * against `posed_joints` in an npz, which knows nothing about where the
 * character was placed on the stage.
 *
 * That is the pins3d contract in one sentence: a pin is authored where the
 * artist can see it (the viewport) and shipped in the space the take is stored
 * in, and THIS is the only conversion between the two. Read
 * `jointTrailPoints` beside it — every line here undoes one line there, in
 * reverse order.
 *
 * @param {object} motion  the loaded take (frames, posedJoints, rotationDeg,
 *   anchorX/Z, anchorFrame) — the same object jointTrailPoints takes.
 * @param {{x:number,y:number,z:number}} point  world metres.
 * @param {{baseY?:number, scale?:number}} [placement]  the character entry's
 *   stage height and scale, exactly as passed to jointTrailPoints.
 * @returns {{x:number,y:number,z:number}} clip space, comparable to posedJoints.
 */
export function worldPointToClip(motion, point, { baseY = 0, scale = 1 } = {}) {
	const basis = anchorBasis(motion);
	// A zero or negative scale would make the mapping non-invertible; the
	// character UI cannot produce one, and refusing to divide by it beats
	// returning an infinity that lands in a wire payload.
	const s = Number.isFinite(scale) && Math.abs(scale) > 1e-9 ? scale : 1;
	// 1. undo the scale-about-the-anchor and the anchor offset -> rotated clip
	const rx = (point.x - basis.anchorX) / s;
	const rz = (point.z - basis.anchorZ) / s;
	// 2. undo the yaw (toWorldXZ applies [cos, sin; -sin, cos])
	const dx = rx * basis.cos - rz * basis.sin;
	const dz = rx * basis.sin + rz * basis.cos;
	// 3. undo the anchor-frame root rebase
	return {
		x: basis.rootX + dx,
		y: (point.y - baseY) / s,
		z: basis.rootZ + dz,
	};
}

/** World-space drag delta -> clip-space delta (inverse of the trail yaw). */
export function worldDeltaToClip(motion, delta) {
	const basis = anchorBasis(motion);
	const { cos, sin } = basis;
	// Inverse of [x' = dx*cos + dz*sin; z' = -dx*sin + dz*cos].
	return {
		x: delta.x * cos - delta.z * sin,
		y: delta.y,
		z: delta.x * sin + delta.z * cos,
	};
}

/**
 * World drag delta on a drawn (rendered) trail -> the clip delta
 * applyTrailFalloffDelta takes, so the RENDERED effector follows the pointer.
 *
 * Playback turns the rig's own bones by the clip's rotations and adds rotated
 * bind offsets, so a clip move is not a rendered move (the y-bot forearm is
 * 27.6 cm against the clip's 23.3; the Mixamo head bone sits near the neck
 * pivot). Rather than model that, keep the clip delta along the pointer (as
 * before) and solve its LENGTH through real playback: the gain that brings
 * the rendered effector closest to the pointer (least squares, so it never
 * overshoots). A full 3D inverse was rejected: limb reach makes some
 * directions unreachable and chasing them sends the clip delta far off.
 * The gain is capped at 1.5: rig/clip limb ratios sit well inside it, and a
 * bone that needs more (the Mixamo head bone rides ~11 cm from the neck
 * pivot, 17 degrees per rendered cm) is a lever the edit cannot drive 1:1
 * without spinning the part. Without a rig: yaw + stature only.
 */
export function worldDeltaToTrailClip(motion, delta, { track = "hips", grabFrame = 0, radiusFrames = 0, rig = null, scale = 1 } = {}) {
	const stature = Number.isFinite(scale) && scale > 1e-9 ? scale : 1;
	const plain = worldDeltaToClip(motion, { x: delta.x / stature, y: delta.y / stature, z: delta.z / stature });
	const distance = Math.hypot(delta.x, delta.y, delta.z);
	const joint = jointIndex(TRAIL_TRACKS.find((item) => item.id === track)?.joint ?? "");
	const samples = rig && joint >= 0 && motion?.rotMats && distance > 1e-6 ? motionJointPositions(rig, motion) : null;
	const frame = Math.max(0, Math.min((motion?.frames ?? 1) - 1, Math.round(grabFrame) || 0));
	const base = samples?.positions.subarray((frame * JOINTS + joint) * 3, (frame * JOINTS + joint) * 3 + 3);
	if (!base || !Number.isFinite(base[0])) return plain;
	const basis = anchorBasis(motion);
	const unit = RIG_UNIT_METRES * stature;
	const target = [delta.x, delta.y, delta.z];
	const scaled = (gain) => ({ x: plain.x * gain, y: plain.y * gain, z: plain.z * gain });
	// Rendered world displacement of the effector at the grab for a gain.
	const reached = (gain) => {
		const edited = applyTrailFalloffDelta(motion, { track, grabFrame: frame, radiusFrames, clipDelta: scaled(gain) });
		const p = motionJointPositionsAt(rig, edited, frame).subarray(joint * 3, joint * 3 + 3);
		const x = (p[0] - base[0]) * unit;
		const z = (p[2] - base[2]) * unit;
		return [x * basis.cos + z * basis.sin, (p[1] - base[1]) * unit, -x * basis.sin + z * basis.cos];
	};
	const MIN_GAIN = 0.1;
	const MAX_GAIN = 1.5;
	// Locally reached ~ gain * v, so the best gain is gain * (D.r)/(r.r);
	// iterate that (the reach limit bends the curve) and keep the closest.
	let gain = 1;
	let best = { gain: 1, miss: Infinity };
	for (let i = 0; i < 4; i += 1) {
		const r = reached(gain);
		const miss = len(sub(target, r));
		if (miss < best.miss) best = { gain, miss };
		const rr = dot(r, r);
		if (!(rr > 1e-12) || miss < 1e-4) break;
		const next = Math.max(MIN_GAIN, Math.min(MAX_GAIN, (gain * dot(target, r)) / rr));
		if (Math.abs(next - gain) < 1e-4) break;
		gain = next;
	}
	return scaled(best.gain);
}

/** Smoothstep falloff: 1 at the grab frame, 0 at/beyond the radius. */
export function falloffWeight(distanceFrames, radiusFrames) {
	if (!(radiusFrames > 0)) return distanceFrames === 0 ? 1 : 0;
	const t = Math.min(1, Math.abs(distanceFrames) / radiusFrames);
	const s = 1 - t;
	return s * s * (3 - 2 * s);
}

/** The frames a grab at `grabFrame` with `radiusFrames` falloff can move. */
export function trailEditRange(frameCount, grabFrame, radiusFrames) {
	const last = Math.max(0, frameCount - 1);
	const grab = Math.max(0, Math.min(last, Math.round(grabFrame) || 0));
	const radius = Math.max(0, Math.round(radiusFrames) || 0);
	return {
		startFrame: Math.max(0, grab - radius),
		// endFrame is EXCLUSIVE, matching motionEdit's start..end contract.
		endFrame: Math.min(frameCount, grab + radius + 1),
	};
}

/* --- small vector / row-major 3x3 helpers for the limb and head solves --- */

const sub = (a, b) => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const add = (a, b) => [a[0] + b[0], a[1] + b[1], a[2] + b[2]];
const scale3 = (a, s) => [a[0] * s, a[1] * s, a[2] * s];
const dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const cross = (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
const len = (a) => Math.hypot(a[0], a[1], a[2]);
function unit(a) {
	const l = len(a);
	return l > 1e-9 ? scale3(a, 1 / l) : null;
}
function matMul(a, b) {
	const out = new Array(9);
	for (let r = 0; r < 3; r += 1) {
		for (let c = 0; c < 3; c += 1) {
			out[r * 3 + c] = a[r * 3] * b[c] + a[r * 3 + 1] * b[3 + c] + a[r * 3 + 2] * b[6 + c];
		}
	}
	return out;
}
const matT = (m) => [m[0], m[3], m[6], m[1], m[4], m[7], m[2], m[5], m[8]];
const matVec = (m, v) => [
	m[0] * v[0] + m[1] * v[1] + m[2] * v[2],
	m[3] * v[0] + m[4] * v[1] + m[5] * v[2],
	m[6] * v[0] + m[7] * v[1] + m[8] * v[2],
];
/** Inverse of a row-major 3x3 (callers keep it well conditioned). */
function inverse3(m) {
	const [a, b, c, d, e, f, g, h, i] = m;
	const A = e * i - f * h, B = f * g - d * i, C = d * h - e * g;
	const det = a * A + b * B + c * C;
	return [A, c * h - b * i, b * f - c * e, B, a * i - c * g, c * d - a * f, C, b * g - a * h, a * e - b * d].map((v) => v / det);
}
/** Shortest-arc rotation taking unit `a` onto unit `b` (Rodrigues). */
function arcRotation(a, b) {
	const c = dot(a, b);
	if (c < -1 + 1e-9) {
		const axis = unit(cross(a, Math.abs(a[0]) < 0.9 ? [1, 0, 0] : [0, 1, 0]));
		const [x, y, z] = axis;
		return [2 * x * x - 1, 2 * x * y, 2 * x * z, 2 * x * y, 2 * y * y - 1, 2 * y * z, 2 * x * z, 2 * y * z, 2 * z * z - 1];
	}
	const [x, y, z] = cross(a, b);
	const k = 1 / (1 + c);
	return [
		1 - k * (y * y + z * z), -z + k * x * y, y + k * x * z,
		z + k * x * y, 1 - k * (x * x + z * z), -x + k * y * z,
		-y + k * x * z, x + k * y * z, 1 - k * (x * x + y * y),
	];
}

/** Joint `root` and everything below it in the cskel27 tree. */
function subtreeOf(root) {
	return CSKEL27_JOINTS.map((_, j) => j).filter((j) => {
		for (let k = j; k !== null; k = CSKEL27_PARENTS[k]) if (k === root) return true;
		return false;
	});
}

/** Per-frame accessors over a take's flat posedJoints / rotMats (locals). */
function frameAccess(posedJoints, rotMats, f) {
	const globals = new Map();
	const local = (j) => Array.from(rotMats.subarray((f * JOINTS + j) * 9, (f * JOINTS + j) * 9 + 9));
	const global = (j) => {
		if (!globals.has(j)) {
			const parent = CSKEL27_PARENTS[j];
			globals.set(j, parent === null ? local(j) : matMul(global(parent), local(j)));
		}
		return globals.get(j);
	};
	return {
		pos: (j) => {
			const po = (f * JOINTS + j) * 3;
			return [posedJoints[po], posedJoints[po + 1], posedJoints[po + 2]];
		},
		setPos: (j, p) => posedJoints.set(p, (f * JOINTS + j) * 3),
		global,
		/** Write joint j's LOCAL rotation so its global becomes `g` (parent untouched). */
		setGlobal: (j, g, parentGlobal = CSKEL27_PARENTS[j] === null ? null : global(CSKEL27_PARENTS[j])) => {
			rotMats.set(parentGlobal ? matMul(matT(parentGlobal), g) : g, (f * JOINTS + j) * 9);
		},
	};
}

/** One bend-side guide from the source window, never from the dragged target. */
function limbWindowNormal(motion, [a, b, c], startFrame, endFrame, grabFrame, radiusFrames) {
	let sum = [0, 0, 0];
	for (let f = startFrame; f < endFrame; f += 1) {
		const access = frameAccess(motion.posedJoints, null, f);
		const normal = cross(sub(access.pos(b), access.pos(a)), sub(access.pos(c), access.pos(a)));
		// Area weighting gives nearly straight (ill-conditioned) frames no vote.
		sum = add(sum, scale3(normal, falloffWeight(f - grabFrame, radiusFrames)));
	}
	return unit(sum);
}

/** Beyond reach, the bend plane turns at most this far from the source frame's plane. */
const OVERREACH_PLANE_LIMIT = Math.PI / 6;
/** Excess distance, as a fraction of reach, over which that limit eases in. */
const OVERREACH_EASE = 0.25;

/** Rotate unit `from` toward unit `to` by at most `radians`. */
function limitNormal(from, to, radians) {
	const angle = Math.acos(Math.max(-1, Math.min(1, dot(from, to))));
	if (angle <= radians) return to;
	const tangent = unit(sub(to, scale3(from, dot(from, to))));
	return tangent ? add(scale3(from, Math.cos(radians)), scale3(tangent, Math.sin(radians))) : from;
}

/**
 * Two-bone solve: follow a reachable target exactly, using one window guide.
 * An unreachable target cannot be met anyway, so there the bend plane is
 * held within OVERREACH_PLANE_LIMIT of its pre-drag plane, easing in from the
 * reach boundary so crossing it does not pop.
 */
function bendLimbFrame(access, [a, b, c], descendants, offset, guide) {
	const A = access.pos(a);
	const B = access.pos(b);
	const C = access.pos(c);
	const l1 = len(sub(B, A));
	const l2 = len(sub(C, B));
	if (len(offset) < 1e-9) return;
	const AB = sub(B, A);
	const AC = sub(C, A);
	const oldNormal = unit(cross(AB, AC));
	let toTarget = sub(add(C, offset), A);
	let dir = unit(toTarget) ?? unit(AC);
	if (!dir) return;
	const reference = guide ?? oldNormal ?? unit(cross(dir, Math.abs(dir[0]) < 0.9 ? [1, 0, 0] : [0, 1, 0]));
	let normal = unit(sub(reference, scale3(dir, dot(reference, dir))))
		?? unit(cross(dir, Math.abs(dir[0]) < 0.9 ? [1, 0, 0] : [0, 1, 0]));
	const excess = (len(toTarget) - (l1 + l2)) / ((l1 + l2) * OVERREACH_EASE);
	const turn = oldNormal ? Math.acos(Math.max(-1, Math.min(1, dot(oldNormal, normal)))) : 0;
	if (excess > 0 && turn > OVERREACH_PLANE_LIMIT) {
		const t = Math.min(1, excess);
		const capped = limitNormal(oldNormal, normal, turn - (turn - OVERREACH_PLANE_LIMIT) * t * t * (3 - 2 * t));
		// Aim the straightened limb at the target's projection into that plane.
		const projected = sub(toTarget, scale3(capped, dot(toTarget, capped)));
		if (unit(projected)) {
			normal = capped;
			toTarget = projected;
			dir = unit(projected);
		}
	}
	// Leave a sub-millimetre bend at full reach so its side stays defined.
	const d = Math.min(l1 + l2 - 1e-6, Math.max(Math.abs(l1 - l2) + 1e-6, len(toTarget)));
	if (!(d > 1e-9)) return;
	const along = (l1 * l1 - l2 * l2 + d * d) / (2 * d);
	const h = Math.sqrt(Math.max(0, l1 * l1 - along * along));
	const pole = unit(cross(dir, normal));
	const B2 = add(A, add(scale3(dir, along), scale3(pole, h)));
	const C2 = add(A, scale3(dir, d));
	const move = sub(C2, C);
	for (const j of descendants) access.setPos(j, add(access.pos(j), move));
	access.setPos(b, B2);
	if (!access.rotMats) return;
	// Transport each segment by its shortest arc, not by the bend frame:
	// rotating the frame added axial twist even when the elbow hardly moved.
	const swing = (from, to) => arcRotation(unit(from), unit(to));
	const ga = matMul(swing(AB, sub(B2, A)), access.global(a));
	const gb = matMul(swing(sub(C, B), sub(C2, B2)), access.global(b));
	const gc = access.global(c);
	access.setGlobal(a, ga);
	access.setGlobal(b, gb, ga);
	access.setGlobal(c, gc, gb);
}

/** Head drag for one frame: swing Neck->Head about the neck toward the target. */
function swingHeadFrame(access, neck, head, subtree, offset) {
	const N = access.pos(neck);
	const H = access.pos(head);
	const from = unit(sub(H, N));
	const to = unit(sub(add(H, offset), N));
	if (!from || !to) return;
	const q = arcRotation(from, to);
	for (const j of subtree) access.setPos(j, add(N, matVec(q, sub(access.pos(j), N))));
	if (access.rotMats) access.setGlobal(neck, matMul(q, access.global(neck)));
}

/** Validate and own the small JSON recipe stored beside the source motion ID. */
export function normalizeTrailEdits(value) {
	if (value == null) return null;
	const fail = () => { throw new TypeError("Invalid motion trail edit recipe"); };
	if (value.version !== 1 || !Number.isInteger(value.frames) || value.frames < 1
		|| !(value.fps > 0) || !Number.isFinite(value.fps)
		|| !Array.isArray(value.edits) || value.edits.length > 4096) fail();
	const edits = value.edits.map((edit) => {
		if (!TRAIL_TRACKS.some(({ id }) => id === edit?.track)
			|| !Number.isInteger(edit.grabFrame) || edit.grabFrame < 0 || edit.grabFrame >= value.frames
			|| !Number.isInteger(edit.radiusFrames) || edit.radiusFrames < 0
			|| !["x", "y", "z"].every((axis) => Number.isFinite(edit.clipDelta?.[axis]))) fail();
		return { track: edit.track, grabFrame: edit.grabFrame, radiusFrames: edit.radiusFrames,
			clipDelta: { x: edit.clipDelta.x, y: edit.clipDelta.y, z: edit.clipDelta.z } };
	});
	let segments = null;
	if (value.segments != null) {
		if (!Array.isArray(value.segments) || !value.segments.length || value.segments.length > 4096) fail();
		segments = value.segments.map((segment) => {
			if (typeof segment?.id !== "string" || !Number.isInteger(segment.sourceStart) || segment.sourceStart < 0
				|| !Number.isInteger(segment.sourceEnd) || segment.sourceEnd < segment.sourceStart
				|| !Number.isFinite(segment.speed) || segment.speed < 0.1 || segment.speed > 4) fail();
			return { id: segment.id, sourceStart: segment.sourceStart, sourceEnd: segment.sourceEnd, speed: segment.speed };
		});
	}
	return { version: 1, frames: value.frames, fps: value.fps, segments, edits };
}

function rememberTrailEdit(source, edited, edit) {
	const previous = source.trailEdits;
	return { ...edited, trailEdits: {
		version: 1, frames: source.frames, fps: source.fps,
		segments: previous?.segments ?? source.editSegments?.map((segment) => ({ ...segment })) ?? null,
		edits: [...(previous?.edits ?? []), { ...edit, clipDelta: { ...edit.clipDelta } }],
	} };
}

/** Rebuild the arrays AND the retarget reference after project/cache decoding. */
export function restoreTrailEdits(motion, stored) {
	const recipe = normalizeTrailEdits(stored);
	if (!recipe) return motion;
	if (recipe.segments?.some((segment) => segment.sourceEnd >= motion.frames)) {
		throw new RangeError("Motion trail source segment exceeds the take");
	}
	let restored = recipe.segments ? renderMotionEdit(motion, recipe.segments) : motion;
	if (restored.frames !== recipe.frames || restored.fps !== recipe.fps) {
		throw new RangeError("Motion trail recipe does not match the take clock");
	}
	for (const edit of recipe.edits) restored = applyTrailFalloffDelta(restored, edit);
	return restored;
}

/**
 * Deform a take by a clip-space delta centred on `grabFrame`, weighted per
 * frame by the smoothstep falloff. `track` is the dragged TRAIL_TRACKS id:
 *   - "hips" (default): the whole body shifts by weight(f) * delta on rootPos
 *     AND posedJoints (applyMotionFrame skins from posedJoints; rootPos feeds
 *     camera/subject sampling — both must agree or the preview tears).
 *   - a hand/foot: only that limb bends (bendLimbFrame).
 *   - "head": only the head swings about the neck (swingHeadFrame).
 * Limb and head edits rewrite rotMats too, since playback reads rotations.
 * Returns a new motion; the caller's arrays are never written.
 */
export function applyTrailFalloffDelta(motion, { track = "hips", grabFrame, radiusFrames, clipDelta }) {
	if (!motion?.posedJoints || !motion?.rootPos || !(motion.frames > 0)) return motion;
	const { startFrame, endFrame } = trailEditRange(motion.frames, grabFrame, radiusFrames);
	const rootPos = motion.rootPos.slice();
	const posedJoints = motion.posedJoints.slice();
	const chain = LIMB_CHAINS[track]?.map(jointIndex);
	if (chain || track === "head") {
		const rotMats = motion.rotMats ? motion.rotMats.slice() : null;
		const neck = jointIndex("Neck");
		const head = jointIndex("Head");
		const moved = subtreeOf(chain ? chain[2] : head).filter((j) => !chain || j !== chain[2]);
		const guide = chain ? limbWindowNormal(motion, chain, startFrame, endFrame, grabFrame, radiusFrames) : null;
		for (let f = startFrame; f < endFrame; f += 1) {
			const w = falloffWeight(f - grabFrame, radiusFrames);
			if (w <= 0) continue;
			const access = { ...frameAccess(posedJoints, rotMats, f), rotMats };
			const offset = [clipDelta.x * w, clipDelta.y * w, clipDelta.z * w];
			if (chain) bendLimbFrame(access, chain, [chain[2], ...moved], offset, guide);
			else swingHeadFrame(access, neck, head, moved, offset);
		}
		const edited = rotMats ? { ...motion, rootPos, posedJoints, rotMats } : { ...motion, rootPos, posedJoints };
		if (chain && rotMats) {
			// One immutable reference, not a chain of preview/drag snapshots.
			edited.trailRetarget = {
				base: motion.trailRetarget?.base ?? motion,
				chains: [...new Set([...(motion.trailRetarget?.chains ?? []), track])],
			};
		}
		return rememberTrailEdit(motion, edited, { track, grabFrame, radiusFrames, clipDelta });
	}
	for (let f = startFrame; f < endFrame; f += 1) {
		const w = falloffWeight(f - grabFrame, radiusFrames);
		if (w <= 0) continue;
		const dx = clipDelta.x * w;
		const dy = clipDelta.y * w;
		const dz = clipDelta.z * w;
		rootPos[f * 3] += dx;
		rootPos[f * 3 + 1] += dy;
		rootPos[f * 3 + 2] += dz;
		for (let j = 0; j < JOINTS; j += 1) {
			const po = (f * JOINTS + j) * 3;
			posedJoints[po] += dx;
			posedJoints[po + 1] += dy;
			posedJoints[po + 2] += dz;
		}
	}
	return rememberTrailEdit(motion, { ...motion, rootPos, posedJoints }, { track, grabFrame, radiusFrames, clipDelta });
}

/**
 * Nearest trail frame to a pointer RAY (for grab picking without any
 * per-pointermove scene raycasting). Returns { frame, distance } of the
 * closest point, or null when nothing lies within `maxDistance` metres.
 */
export function nearestFrameToRay(points, origin, direction, maxDistance = 0.25) {
	if (!points || points.length < 3) return null;
	const len = Math.hypot(direction.x, direction.y, direction.z) || 1;
	const dx = direction.x / len;
	const dy = direction.y / len;
	const dz = direction.z / len;
	let best = null;
	for (let f = 0; f * 3 < points.length; f += 1) {
		const px = points[f * 3] - origin.x;
		const py = points[f * 3 + 1] - origin.y;
		const pz = points[f * 3 + 2] - origin.z;
		const t = px * dx + py * dy + pz * dz;
		if (t < 0) continue; // behind the camera
		const ox = px - t * dx;
		const oy = py - t * dy;
		const oz = pz - t * dz;
		const distance = Math.hypot(ox, oy, oz);
		if (distance <= maxDistance && (!best || distance < best.distance)) {
			best = { frame: f, distance };
		}
	}
	return best;
}

/** Nearest trail frame to a world-space point (for grab picking). */
export function nearestTrailFrame(points, world) {
	if (!points || points.length < 3) return 0;
	let best = 0;
	let bestD = Infinity;
	for (let f = 0; f * 3 < points.length; f += 1) {
		const dx = points[f * 3] - world.x;
		const dy = points[f * 3 + 1] - world.y;
		const dz = points[f * 3 + 2] - world.z;
		const d = dx * dx + dy * dy + dz * dz;
		if (d < bestD) {
			bestD = d;
			best = f;
		}
	}
	return best;
}

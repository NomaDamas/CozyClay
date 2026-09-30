#!/usr/bin/env node
/** Joint-relative trail drags (src/motion-trail.js applyTrailFalloffDelta):
 * hips moves the body, a limb trail bends only that limb, head swings on the neck. */
import assert from "node:assert/strict";
import { applyTrailFalloffDelta } from "../src/motion-trail.js";
import { CSKEL27_JOINTS } from "../src/ardy/cskel27.js";
import { CSKEL27_NEUTRAL } from "../src/ardy/cskel27-neutral.js";
import { deriveBoneOffsets, forwardKinematics } from "../src/ardy/convert.js";

const JOINTS = CSKEL27_JOINTS.length;
const J = (name) => CSKEL27_JOINTS.indexOf(name);
const IDENTITY = () => [[1, 0, 0], [0, 1, 0], [0, 0, 1]];
function axisAngle([x, y, z], angle) {
	const l = Math.hypot(x, y, z);
	[x, y, z] = [x / l, y / l, z / l];
	const c = Math.cos(angle);
	const s = Math.sin(angle);
	const t = 1 - c;
	return [
		[t * x * x + c, t * x * y - s * z, t * x * z + s * y],
		[t * x * y + s * z, t * y * y + c, t * y * z - s * x],
		[t * x * z - s * y, t * y * z + s * x, t * z * z + c],
	];
}
const OFFSETS = deriveBoneOffsets(CSKEL27_NEUTRAL, CSKEL27_JOINTS.map(IDENTITY));

/** An FK-consistent take: bent elbows/knees, a walking root, real rotMats. */
function fkMotion(frames = 40) {
	const rotMats = new Float32Array(frames * JOINTS * 9);
	const posedJoints = new Float32Array(frames * JOINTS * 3);
	const rootPos = new Float32Array(frames * 3);
	for (let f = 0; f < frames; f += 1) {
		const locals = CSKEL27_JOINTS.map(IDENTITY);
		const p = f / frames;
		locals[J("Hips")] = axisAngle([0, 1, 0], 0.3 * p);
		locals[J("LeftArm")] = axisAngle([0.2, 0.3, 1], -1.0 + 0.2 * p);
		locals[J("LeftForeArm")] = axisAngle([0, 1, 0.2], 0.9 + 0.3 * p);
		locals[J("RightArm")] = axisAngle([0.1, -0.2, 1], 1.0);
		locals[J("RightForeArm")] = axisAngle([0, 1, 0], -0.8);
		locals[J("LeftUpLeg")] = axisAngle([1, 0, 0], -0.4 - 0.2 * p);
		locals[J("LeftLeg")] = axisAngle([1, 0, 0.1], 0.7);
		locals[J("RightUpLeg")] = axisAngle([1, 0, 0], 0.2);
		locals[J("RightLeg")] = axisAngle([1, 0, 0], 0.3);
		locals[J("Neck")] = axisAngle([1, 0, 0], 0.15);
		const root = [0.02 * f, 0.95, 0.01 * f];
		const positions = forwardKinematics(locals, OFFSETS, root);
		rootPos.set(root, f * 3);
		for (let j = 0; j < JOINTS; j += 1) {
			posedJoints.set(positions[j], (f * JOINTS + j) * 3);
			rotMats.set(locals[j].flat(), (f * JOINTS + j) * 9);
		}
	}
	return { frames, fps: 24, anchorFrame: 0, rotationDeg: 0, anchorX: 0, anchorZ: 0, rootPos, posedJoints, rotMats };
}

const pos = (motion, f, name) => {
	const po = (f * JOINTS + J(name)) * 3;
	return [motion.posedJoints[po], motion.posedJoints[po + 1], motion.posedJoints[po + 2]];
};
const dist = (a, b) => Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]);
const localsAt = (motion, f) => CSKEL27_JOINTS.map((_, j) => {
	const o = (f * JOINTS + j) * 9;
	const m = motion.rotMats;
	return [[m[o], m[o + 1], m[o + 2]], [m[o + 3], m[o + 4], m[o + 5]], [m[o + 6], m[o + 7], m[o + 8]]];
});
/** FK over the edited rotMats must land on the edited posedJoints (playback reads both). */
function assertFkConsistent(motion, frames, label) {
	for (const f of frames) {
		const fk = forwardKinematics(localsAt(motion, f), OFFSETS, pos(motion, f, "Hips"));
		for (let j = 0; j < JOINTS; j += 1) {
			const d = dist(fk[j], pos(motion, f, CSKEL27_JOINTS[j]));
			assert.ok(d < 1e-4, `${label}: frame ${f} ${CSKEL27_JOINTS[j]} FK drift ${d}`);
		}
	}
}

const GRAB = 20;
const RADIUS = 6;
const WINDOW = Array.from({ length: 2 * RADIUS + 1 }, (_, i) => GRAB - RADIUS + i);

// --- hips: the whole body translates, rotations untouched ------------------
{
	const motion = fkMotion();
	const clipDelta = { x: 0.3, y: 0.1, z: -0.2 };
	const edited = applyTrailFalloffDelta(motion, { track: "hips", grabFrame: GRAB, radiusFrames: RADIUS, clipDelta });
	for (const name of CSKEL27_JOINTS) {
		const before = pos(motion, GRAB, name);
		const after = pos(edited, GRAB, name);
		assert.ok(dist(after, [before[0] + 0.3, before[1] + 0.1, before[2] - 0.2]) < 1e-6, `hips drag moves ${name} by delta`);
	}
	assert.ok(Math.abs(edited.rootPos[GRAB * 3] - (motion.rootPos[GRAB * 3] + 0.3)) < 1e-6, "hips drag moves rootPos");
	assert.equal(edited.rotMats, motion.rotMats, "hips drag leaves rotations alone");
	// No track = legacy callers: identical to hips.
	const legacy = applyTrailFalloffDelta(motion, { grabFrame: GRAB, radiusFrames: RADIUS, clipDelta });
	assert.deepEqual([...legacy.posedJoints], [...edited.posedJoints], "missing track defaults to hips");
}

// --- leftHand: only the left arm bends ------------------------------------
{
	const motion = fkMotion();
	const beforePosed = motion.posedJoints.slice();
	const beforeRot = motion.rotMats.slice();
	const clipDelta = { x: 0.08, y: 0.1, z: -0.06 };
	const edited = applyTrailFalloffDelta(motion, { track: "leftHand", grabFrame: GRAB, radiusFrames: RADIUS, clipDelta });
	assert.deepEqual([...motion.posedJoints], [...beforePosed], "source posedJoints untouched");
	assert.deepEqual([...motion.rotMats], [...beforeRot], "source rotMats untouched");

	const hand0 = pos(motion, GRAB, "LeftHand");
	const hand1 = pos(edited, GRAB, "LeftHand");
	assert.ok(dist(hand1, [hand0[0] + 0.08, hand0[1] + 0.1, hand0[2] - 0.06]) < 1e-5, "LeftHand lands on hand + delta");

	const bent = new Set(["LeftForeArm", "LeftHand", "LeftHandEnd", "LeftHandThumb1"]);
	for (let f = 0; f < motion.frames; f += 1) {
		for (const name of CSKEL27_JOINTS) {
			if (bent.has(name)) continue;
			assert.ok(dist(pos(edited, f, name), pos(motion, f, name)) < 1e-6, `frame ${f} ${name} unchanged by a hand drag`);
		}
		const upper0 = dist(pos(motion, f, "LeftArm"), pos(motion, f, "LeftForeArm"));
		const fore0 = dist(pos(motion, f, "LeftForeArm"), pos(motion, f, "LeftHand"));
		assert.ok(Math.abs(dist(pos(edited, f, "LeftArm"), pos(edited, f, "LeftForeArm")) - upper0) < 1e-4, `frame ${f} upper arm length kept`);
		assert.ok(Math.abs(dist(pos(edited, f, "LeftForeArm"), pos(edited, f, "LeftHand")) - fore0) < 1e-4, `frame ${f} forearm length kept`);
	}
	assert.deepEqual([...edited.rootPos], [...motion.rootPos], "rootPos unchanged by a hand drag");
	assert.notEqual(edited.rotMats, motion.rotMats, "rotations are rewritten on a new array");
	assert.ok(dist(pos(edited, GRAB, "LeftForeArm"), pos(motion, GRAB, "LeftForeArm")) > 1e-2, "the elbow is re-placed, not left behind");
	// Hand descendants translate rigidly with the hand.
	const end0 = pos(motion, GRAB, "LeftHandEnd");
	const end1 = pos(edited, GRAB, "LeftHandEnd");
	assert.ok(dist([end1[0] - end0[0], end1[1] - end0[1], end1[2] - end0[2]], [0.08, 0.1, -0.06]) < 1e-5, "LeftHandEnd follows the hand");
	// The elbow keeps its side of the shoulder->hand line.
	const side = (m) => {
		const a = pos(m, GRAB, "LeftArm");
		const b = pos(m, GRAB, "LeftForeArm");
		const c = pos(m, GRAB, "LeftHand");
		const ac = [c[0] - a[0], c[1] - a[1], c[2] - a[2]];
		const ab = [b[0] - a[0], b[1] - a[1], b[2] - a[2]];
		const k = (ab[0] * ac[0] + ab[1] * ac[1] + ab[2] * ac[2]) / (ac[0] ** 2 + ac[1] ** 2 + ac[2] ** 2);
		return [ab[0] - k * ac[0], ab[1] - k * ac[1], ab[2] - k * ac[2]];
	};
	const s0 = side(motion);
	const s1 = side(edited);
	assert.ok(s0[0] * s1[0] + s0[1] * s1[1] + s0[2] * s1[2] > 0, "elbow stays on its bend side");
	assertFkConsistent(edited, WINDOW, "leftHand");
}

// --- leftHand out of reach: the arm straightens, lengths still hold --------
{
	const motion = fkMotion();
	const edited = applyTrailFalloffDelta(motion, { track: "leftHand", grabFrame: GRAB, radiusFrames: RADIUS, clipDelta: { x: 3, y: 0, z: 0 } });
	const upper0 = dist(pos(motion, GRAB, "LeftArm"), pos(motion, GRAB, "LeftForeArm"));
	const fore0 = dist(pos(motion, GRAB, "LeftForeArm"), pos(motion, GRAB, "LeftHand"));
	assert.ok(Math.abs(dist(pos(edited, GRAB, "LeftArm"), pos(edited, GRAB, "LeftHand")) - (upper0 + fore0)) < 1e-4, "clamped to full reach");
	assert.ok(Math.abs(dist(pos(edited, GRAB, "LeftArm"), pos(edited, GRAB, "LeftForeArm")) - upper0) < 1e-4, "upper arm length kept at full reach");
	assertFkConsistent(edited, WINDOW, "leftHand reach");
}

// --- rightFoot: only the right leg bends -----------------------------------
{
	const motion = fkMotion();
	const clipDelta = { x: 0.05, y: 0.12, z: 0.04 };
	const edited = applyTrailFalloffDelta(motion, { track: "rightFoot", grabFrame: GRAB, radiusFrames: RADIUS, clipDelta });
	const foot0 = pos(motion, GRAB, "RightFoot");
	assert.ok(dist(pos(edited, GRAB, "RightFoot"), [foot0[0] + 0.05, foot0[1] + 0.12, foot0[2] + 0.04]) < 1e-5, "RightFoot lands on foot + delta");
	for (const name of ["Hips", "RightUpLeg", "LeftFoot", "LeftHand", "RightHand", "Head"]) {
		assert.ok(dist(pos(edited, GRAB, name), pos(motion, GRAB, name)) < 1e-6, `${name} unchanged by a foot drag`);
	}
	const thigh0 = dist(pos(motion, GRAB, "RightUpLeg"), pos(motion, GRAB, "RightLeg"));
	const shin0 = dist(pos(motion, GRAB, "RightLeg"), pos(motion, GRAB, "RightFoot"));
	assert.ok(Math.abs(dist(pos(edited, GRAB, "RightUpLeg"), pos(edited, GRAB, "RightLeg")) - thigh0) < 1e-4, "thigh length kept");
	assert.ok(Math.abs(dist(pos(edited, GRAB, "RightLeg"), pos(edited, GRAB, "RightFoot")) - shin0) < 1e-4, "shin length kept");
	assertFkConsistent(edited, WINDOW, "rightFoot");
}

// --- head: swings about the neck, nothing else moves -----------------------
{
	const motion = fkMotion();
	const clipDelta = { x: 0.06, y: 0, z: 0.05 };
	const edited = applyTrailFalloffDelta(motion, { track: "head", grabFrame: GRAB, radiusFrames: RADIUS, clipDelta });
	for (const name of CSKEL27_JOINTS) {
		if (name === "Head") continue;
		assert.ok(dist(pos(edited, GRAB, name), pos(motion, GRAB, name)) < 1e-6, `${name} unchanged by a head drag`);
	}
	const neck = pos(motion, GRAB, "Neck");
	const head0 = pos(motion, GRAB, "Head");
	const head1 = pos(edited, GRAB, "Head");
	assert.ok(Math.abs(dist(neck, head1) - dist(neck, head0)) < 1e-5, "neck->head length kept");
	const target = [head0[0] + 0.06 - neck[0], head0[1] - neck[1], head0[2] + 0.05 - neck[2]];
	const dir = [head1[0] - neck[0], head1[1] - neck[1], head1[2] - neck[2]];
	const cos = (target[0] * dir[0] + target[1] * dir[1] + target[2] * dir[2]) / (Math.hypot(...target) * Math.hypot(...dir));
	assert.ok(cos > 1 - 1e-6, "head points from the neck at the dragged target");
	assertFkConsistent(edited, WINDOW, "head");
}

console.log("all motion trail limb checks passed");

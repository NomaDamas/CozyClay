#!/usr/bin/env node
/** Real playback, not just the cskel wrist: preserve presentation and bone lengths. */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import * as THREE from "three";
import { FBXLoader } from "three/examples/jsm/loaders/FBXLoader.js";
import { applyTrailFalloffDelta } from "../src/motion-trail.js";
import { applyMotionFrame } from "../src/ardy/playback.js";
import { decodeMotionNpz } from "../src/ardy/npz.js";
import { retimeMotion } from "../src/ardy/retime.js";
import { CSKEL27_JOINTS } from "../src/ardy/cskel27.js";

const bytes = readFileSync(new URL("../public/models/y-bot-tpose.fbx", import.meta.url));
const rig = new FBXLoader().parse(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength), "");
rig.scale.setScalar(0.01);
const bones = new Map();
rig.traverse((b) => { if (b.isBone && !bones.has(b.name)) bones.set(b.name, b); });
const bone = (name) => bones.get(`mixamorig${name}`);
const motion = retimeMotion(await decodeMotionNpz(readFileSync(new URL("../public/demo/walk-then-stop.npz", import.meta.url))), 24);
const GRAB = 100, RADIUS = 12;
const degrees = THREE.MathUtils.radToDeg;
const pose = (take, frame, names) => {
	applyMotionFrame(rig, take, frame);
	return names.map((name) => ({ p: bone(name).getWorldPosition(new THREE.Vector3()), q: bone(name).getWorldQuaternion(new THREE.Quaternion()).normalize() }));
};
const plane = ([a, b, c]) => b.p.clone().sub(a.p).cross(c.p.clone().sub(a.p)).normalize();
const lengths = ([a, b, c]) => [a.p.distanceTo(b.p), b.p.distanceTo(c.p)];
const clipPos = (take, frame, name) => new THREE.Vector3().fromArray(take.posedJoints, (frame * 27 + CSKEL27_JOINTS.indexOf(name)) * 3);
const failures = [];
const check = (condition, label) => { if (!condition) failures.push(label); };

for (const [track, delta] of [
	["rightHand", [-0.0327, 0.202, -0.0208]],
	["rightHand", [0.1472, 0, -0.2313]],
	["rightHand", [-0.18, 1.1, -0.12]],
	["leftFoot", [-0.0368, 0.2274, -0.0234]],
]) {
	const arm = track.endsWith("Hand"), side = track.startsWith("left") ? "Left" : "Right";
	const names = (arm ? ["Arm", "ForeArm", "Hand"] : ["UpLeg", "Leg", "Foot"]).map((n) => side + n);
	const edited = applyTrailFalloffDelta(motion, { track, grabFrame: GRAB, radiusFrames: RADIUS, clipDelta: { x: delta[0], y: delta[1], z: delta[2] } });
	let maxRotation = 0, maxPlane = 0, maxTwist = 0, maxLength = 0;
	for (let f = GRAB - RADIUS; f <= GRAB + RADIUS; f += 1) {
		const before = pose(motion, f, names), after = pose(edited, f, names);
		maxRotation = Math.max(maxRotation, degrees(before[2].q.angleTo(after[2].q)));
		maxPlane = Math.max(maxPlane, degrees(plane(before).angleTo(plane(after))));
		const swing = new THREE.Quaternion().setFromUnitVectors(before[1].p.clone().sub(before[0].p).normalize(), after[1].p.clone().sub(after[0].p).normalize());
		maxTwist = Math.max(maxTwist, degrees(swing.multiply(before[0].q).angleTo(after[0].q)));
		const l0 = lengths(before), l1 = lengths(after);
		maxLength = Math.max(maxLength, ...l0.map((l, i) => Math.abs(l1[i] / l - 1)));
		for (let j = 1; j < 3; j += 1) {
			const oldLength = clipPos(motion, f, names[j]).distanceTo(clipPos(motion, f, names[j - 1]));
			const newLength = clipPos(edited, f, names[j]).distanceTo(clipPos(edited, f, names[j - 1]));
			check(Math.abs(newLength - oldLength) < 1e-5, `${track} frame ${f}: clip length`);
		}
	}
	console.log(`${track} delta=${delta}: hand/foot=${maxRotation.toFixed(3)} deg, plane=${maxPlane.toFixed(3)} deg, twist=${maxTwist.toFixed(3)} deg, length=${(maxLength * 100).toFixed(4)}%`);
	check(maxRotation < 15, `${track}: rendered effector orientation ${maxRotation}`);
	const beforeGrab = pose(motion, GRAB, names), afterGrab = pose(edited, GRAB, names);
	const clipMove = clipPos(edited, GRAB, names[2]).distanceTo(clipPos(motion, GRAB, names[2]));
	check(afterGrab[2].p.distanceTo(beforeGrab[2].p) >= 0.9 * clipMove, `${track}: rendered effector follows at least 90% of trail travel`);
	if (Math.hypot(...delta) < 0.5) {
		const target = clipPos(motion, GRAB, names[2]).add(new THREE.Vector3(...delta));
		check(clipPos(edited, GRAB, names[2]).distanceTo(target) < 1e-5, `${track}: reachable target is not projected or capped`);
	}
	let previous = plane(beforeGrab), maxStep = 0;
	for (let step = 1; step <= 50; step += 1) {
		const t = step / 50;
		const partial = applyTrailFalloffDelta(motion, { track, grabFrame: GRAB, radiusFrames: RADIUS, clipDelta: { x: delta[0] * t, y: delta[1] * t, z: delta[2] * t } });
		const next = plane(pose(partial, GRAB, names));
		maxStep = Math.max(maxStep, degrees(previous.angleTo(next)));
		previous = next;
	}
	check(maxStep < 15, `${track}: continuous bend plane, maximum drag step ${maxStep}`);
	check(maxTwist < 2, `${track}: upper-segment twist ${maxTwist}`);
	check(maxLength < 0.01, `${track}: rendered length ${maxLength}`);
	for (const f of [0, GRAB - RADIUS, GRAB + RADIUS, motion.frames - 1]) {
		const before = pose(motion, f, names), after = pose(edited, f, names);
		for (let j = 0; j < 3; j += 1) {
			check(before[j].p.distanceTo(after[j].p) < 1e-6, `${track}: unchanged outside window position`);
			check(before[j].q.angleTo(after[j].q) < 1e-6, `${track}: unchanged outside window orientation`);
		}
	}
	const once = pose(edited, GRAB, names);
	for (let i = 0; i < 10; i += 1) {
		const again = pose(edited, GRAB, names);
		check(once.every((p, j) => p.p.distanceTo(again[j].p) < 1e-9 && p.q.angleTo(again[j].q) < 1e-6), `${track}: seek accumulates no correction`);
	}
}
// A shared pole must not chase per-frame elbow noise. Symmetric noise has
// zero mean; every active frame should use that same window plane.
{
	const frames = 9, posedJoints = new Float32Array(frames * 27 * 3);
	const names = ["RightArm", "RightForeArm", "RightHand"];
	for (let f = 0; f < frames; f += 1) {
		const angle = (f - 4) * 0.2 * Math.PI / 180;
		for (const [j, p] of [[names[0], [0, 0, 0]], [names[1], [0.25, 0.15 * Math.cos(angle), 0.15 * Math.sin(angle)]], [names[2], [0.5, 0, 0]]]) {
			posedJoints.set(p, (f * 27 + CSKEL27_JOINTS.indexOf(j)) * 3);
		}
	}
	const source = { frames, posedJoints, rootPos: new Float32Array(frames * 3) };
	const edit = { track: "rightHand", grabFrame: 4, radiusFrames: 4, clipDelta: { x: 0, y: 0.04, z: 0 } };
	const edited = applyTrailFalloffDelta(source, edit);
	for (let f = 1; f < frames - 1; f += 1) {
		const actual = plane(names.map((n) => ({ p: clipPos(edited, f, n) })));
		check(actual.angleTo(new THREE.Vector3(0, 0, -1)) < 1e-6, `frame ${f}: fixed window pole`);
	}
	const zero = applyTrailFalloffDelta(source, { ...edit, clipDelta: { x: 0, y: 0, z: 0 } });
	assert.deepEqual(zero.posedJoints, source.posedJoints, "zero drag does not flatten the source bend animation");
	// A straight frame has no bend normal. Its new reach can be parallel
	// to the neighboring frames' guide; choose a finite perpendicular pole.
	const straight = { ...source, posedJoints: source.posedJoints.slice() };
	straight.posedJoints.set([0.25, 0, 0], (4 * 27 + CSKEL27_JOINTS.indexOf("RightForeArm")) * 3);
	const singular = applyTrailFalloffDelta(straight, { ...edit, clipDelta: { x: -0.5, y: 0, z: -0.4 } });
	assert.ok(singular.posedJoints.every(Number.isFinite), "straight-frame pole singularity stays finite");
	for (let j = 1; j < 3; j += 1) {
		assert.ok(Math.abs(clipPos(singular, 4, names[j]).distanceTo(clipPos(singular, 4, names[j - 1])) - 0.25) < 1e-6, "straight-frame segment length kept");
	}
}

assert.deepEqual(failures, [], failures.join("\n"));

// Repeated edits share one source, and editing a second limb keeps the first.
{
	const edit = (m, track, y) => applyTrailFalloffDelta(m, { track, grabFrame: GRAB, radiusFrames: RADIUS, clipDelta: { x: 0, y, z: 0 } });
	const first = edit(motion, "rightHand", 0.1);
	const second = edit(first, "rightHand", 0.05);
	const third = edit(second, "leftFoot", 0.1);
	assert.equal(third.trailRetarget.base, motion, "no recursive snapshot chain");
	const names = ["RightArm", "RightForeArm", "RightHand"];
	const before = pose(second, GRAB, names), after = pose(third, GRAB, names);
	check(before.every((p, j) => p.p.distanceTo(after[j].p) < 1e-6 && p.q.angleTo(after[j].q) < 1e-6), "second limb preserves first limb edit");
}
assert.deepEqual(failures, [], failures.join("\n"));
console.log("all motion trail orientation checks passed");

#!/usr/bin/env node
/** Path fix trails sit on the RENDERED bones, and a drag moves the rendered effector 1:1. */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import * as THREE from "three";
import { FBXLoader } from "three/examples/jsm/loaders/FBXLoader.js";
import * as trail from "../src/motion-trail.js";
import * as playback from "../src/ardy/playback.js";
import { decodeMotionNpz } from "../src/ardy/npz.js";
import { retimeMotion } from "../src/ardy/retime.js";
import { primeBindPose } from "../src/poses.js";

const { TRAIL_TRACKS, jointTrailPoints, applyTrailFalloffDelta } = trail;
const { applyMotionFrame, snapshotPlaybackBones } = playback;

// App-faithful placement: Character's group (anchor, baseY, clip yaw) over the
// primed clone scaled 0.01 * stature.
const STATURE = 0.93, BASE_Y = 0.4;
const bytes = readFileSync(new URL("../public/models/y-bot-tpose.fbx", import.meta.url));
const rig = new FBXLoader().parse(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength), "");
primeBindPose(rig);
rig.scale.setScalar(0.01 * STATURE);
const raw = retimeMotion(await decodeMotionNpz(readFileSync(new URL("../public/demo/walk-then-stop.npz", import.meta.url))), 24);
const motion = { ...raw, anchorX: 1.3, anchorZ: -0.7, rotationDeg: 37, anchorFrame: 5 };
const group = new THREE.Group();
group.position.set(motion.anchorX, BASE_Y, motion.anchorZ);
group.rotation.set(0, THREE.MathUtils.degToRad(motion.rotationDeg), 0);
group.add(rig);

const bones = new Map();
rig.traverse((b) => { if (b.isBone && !bones.has(b.name)) bones.set(b.name, b); });
const rendered = (take, frame, joint) => {
	applyMotionFrame(rig, take, frame);
	group.updateMatrixWorld(true);
	return bones.get(`mixamorig${joint}`).getWorldPosition(new THREE.Vector3());
};
const trailAt = (take, joint, frame) => new THREE.Vector3().fromArray(jointTrailPoints(take, joint, { baseY: BASE_Y, scale: STATURE, rig }), frame * 3);
const failures = [];
const check = (condition, label) => { if (!condition) failures.push(label); };
const cm = (v) => (v * 100).toFixed(2);

check(typeof playback.motionJointPositions === "function", "playback exports motionJointPositions");
check(typeof trail.worldDeltaToTrailClip === "function", "motion-trail exports worldDeltaToTrailClip");

// 1. Trail points == rendered bone world positions (raw take, every tracked joint).
const gap = (take, label) => {
	let worst = 0;
	for (const frame of [0, 5, 60, 100, 200, 300, 431]) {
		for (const { joint } of TRAIL_TRACKS) worst = Math.max(worst, rendered(take, frame, joint).distanceTo(trailAt(take, joint, frame)));
	}
	console.log(`${label}: max trail-vs-rendered gap ${cm(worst)} cm`);
	check(worst < 0.001, `${label}: trail-vs-rendered gap ${cm(worst)} cm`);
};
gap(motion, "raw take");

// 2. Sampling never writes the live rig.
if (playback.motionJointPositions) {
	applyMotionFrame(rig, motion, 77);
	const before = snapshotPlaybackBones(rig).map((entry) => entry.slice(1));
	const other = { ...motion, rotMats: motion.rotMats.slice() };
	playback.motionJointPositions(rig, other);
	const after = snapshotPlaybackBones(rig).map((entry) => entry.slice(1));
	check(JSON.stringify(before) === JSON.stringify(after), "motionJointPositions leaves the live rig untouched");
	check(playback.motionJointPositions(rig, other) === playback.motionJointPositions(rig, other), "samples cached per rig + motion");
}

// 3. A world drag moves the rendered effector the pointer distance along the
// pointer (no overshoot), and the rebuilt trail sits on it. The sideways
// residual is the limb solve's own bend budget, reported only.
const GRAB = 100, RADIUS = 12;
// The head swings about the neck: drag it across the rendered neck->head axis.
const headAxis = rendered(motion, GRAB, "Head").sub(rendered(motion, GRAB, "Neck")).normalize();
const headDrag = headAxis.clone().cross(new THREE.Vector3(0, 1, 0)).normalize().multiplyScalar(0.04).toArray();
for (const [track, joint, d] of [
	["rightHand", "RightHand", [-0.03, 0.19, -0.02]],
	// Sideways, mostly outside the bend budget: must not buy travel with overshoot.
	["rightHand", "RightHand", [0.22, 0, 0.15]],
	["leftFoot", "LeftFoot", [-0.03, 0.2, -0.02]],
	["head", "Head", headDrag],
	["hips", "Hips", [0.1, 0.05, -0.08]],
]) {
	const delta = { x: d[0], y: d[1], z: d[2] };
	const clipDelta = trail.worldDeltaToTrailClip
		? trail.worldDeltaToTrailClip(motion, delta, { track, grabFrame: GRAB, radiusFrames: RADIUS, rig, scale: STATURE })
		: trail.worldDeltaToClip(motion, { x: d[0] / STATURE, y: d[1] / STATURE, z: d[2] / STATURE });
	const edited = applyTrailFalloffDelta(motion, { track, grabFrame: GRAB, radiusFrames: RADIUS, clipDelta });
	const start = rendered(motion, GRAB, joint);
	const end = rendered(edited, GRAB, joint);
	const moved = end.clone().sub(start);
	const pointer = new THREE.Vector3(...d);
	const along = moved.dot(pointer) / pointer.lengthSq();
	const ratio = moved.length() / pointer.length();
	const miss = moved.distanceTo(pointer);
	console.log(`${track}: rendered move ${cm(moved.length())} / pointer ${cm(pointer.length())} cm (length ratio ${ratio.toFixed(3)}, along ${along.toFixed(3)}), miss ${cm(miss)} cm, committed trail gap ${cm(end.distanceTo(trailAt(edited, joint, GRAB)))} cm`);
	// Never an overshoot; reachable drags land within 5 % along the pointer.
	check(ratio < 1.01, `${track}: rendered move length ratio ${ratio.toFixed(3)}`);
	if (track === "head") {
		// The Mixamo head bone rides ~11 cm from the neck pivot (17 degrees per
		// rendered cm): the gain is capped, so it follows only partly.
		check(along > 0.3, `${track}: rendered travel along pointer ${along.toFixed(3)}`);
	} else if (pointer.x < 0.2) {
		check(along > 0.95, `${track}: rendered travel along pointer ${along.toFixed(3)}`);
		check(miss < 0.02, `${track}: rendered miss ${cm(miss)} cm`);
	}
	gap(edited, `${track} edit`);
}

// 4. Build cost: 432 frames, all six tracks (first build samples, rest hit the cache).
{
	const fresh = { ...motion, rotMats: motion.rotMats.slice() };
	const t0 = performance.now();
	for (const { joint } of TRAIL_TRACKS) jointTrailPoints(fresh, joint, { baseY: BASE_Y, scale: STATURE, rig });
	const ms = performance.now() - t0;
	console.log(`build ${fresh.frames} frames x ${TRAIL_TRACKS.length} tracks: ${ms.toFixed(1)} ms`);
	const edited = applyTrailFalloffDelta(fresh, { track: "rightHand", grabFrame: GRAB, radiusFrames: RADIUS, clipDelta: { x: 0, y: 0.1, z: 0 } });
	const t1 = performance.now();
	for (const { joint } of TRAIL_TRACKS) jointTrailPoints(edited, joint, { baseY: BASE_Y, scale: STATURE, rig });
	console.log(`build edited (trailRetarget) take: ${(performance.now() - t1).toFixed(1)} ms`);
}

// 5. Without a rig the clip-space trail is unchanged (pins and the wire use it).
{
	const clip = jointTrailPoints(motion, "Hips", { baseY: BASE_Y, scale: STATURE });
	const back = trail.worldPointToClip(motion, { x: clip[GRAB * 3], y: clip[GRAB * 3 + 1], z: clip[GRAB * 3 + 2] }, { baseY: BASE_Y, scale: STATURE });
	const po = GRAB * 27 * 3;
	check(Math.hypot(back.x - motion.posedJoints[po], back.y - motion.posedJoints[po + 1], back.z - motion.posedJoints[po + 2]) < 1e-5, "clip trail round-trips through worldPointToClip");
}

assert.deepEqual(failures, [], failures.join("\n"));
console.log("all trail rendered-geometry checks passed");

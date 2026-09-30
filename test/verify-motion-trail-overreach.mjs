#!/usr/bin/env node
/**
 * Limb trail drags: a reachable target is followed 1:1 whatever the bend
 * plane does; only an unreachable target keeps the elbow/knee plane within
 * 30 deg of its pre-drag plane, eased in from the reach boundary.
 */
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
const motion = retimeMotion(await decodeMotionNpz(readFileSync(new URL("../public/demo/walk-then-stop.npz", import.meta.url))), 24);
const GRAB = 100, RADIUS = 12, LIMIT = 30;
const NAMES = ["RightArm", "RightForeArm", "RightHand"];

const clipPos = (take, name) => new THREE.Vector3().fromArray(take.posedJoints, (GRAB * 27 + CSKEL27_JOINTS.indexOf(name)) * 3);
const [shoulder, elbow, hand] = NAMES.map((n) => clipPos(motion, n));
const reach = shoulder.distanceTo(elbow) + elbow.distanceTo(hand);
const targetDistance = (delta) => hand.clone().add(new THREE.Vector3(...delta)).distanceTo(shoulder);
const rendered = (take) => {
	applyMotionFrame(rig, take, GRAB);
	return NAMES.map((n) => bones.get(`mixamorig${n}`).getWorldPosition(new THREE.Vector3()));
};
const plane = ([a, b, c]) => b.clone().sub(a).cross(c.clone().sub(a)).normalize();
const before = rendered(motion);
const drag = (delta) => {
	const edited = applyTrailFalloffDelta(motion, { track: "rightHand", grabFrame: GRAB, radiusFrames: RADIUS, clipDelta: { x: delta[0], y: delta[1], z: delta[2] } });
	const after = rendered(edited);
	const trail = clipPos(edited, "RightHand").sub(hand);
	const pointer = new THREE.Vector3(...delta);
	return {
		plane: THREE.MathUtils.radToDeg(plane(before).angleTo(plane(after))),
		// Rendered hand travel along the pointer, as a fraction of the pointer travel.
		reach: after[2].clone().sub(before[2]).dot(pointer) / pointer.lengthSq(),
		exact: trail.distanceTo(pointer),
		after,
	};
};

// (a) Reachable sideways target: plane change is NOT capped, hand follows.
{
	const delta = [0.1472, 0, -0.2313];
	assert.ok(targetDistance(delta) < reach, "sideways target is reachable");
	const r = drag(delta);
	console.log(`sideways: target ${(targetDistance(delta) * 100).toFixed(1)} / reach ${(reach * 100).toFixed(1)} cm, plane ${r.plane.toFixed(2)} deg, reach ${(r.reach * 100).toFixed(1)}%`);
	assert.ok(r.plane > LIMIT, `sideways plane is left unconstrained (${r.plane} deg)`);
	assert.ok(r.reach >= 0.95, `sideways hand follows >= 95% of the pointer (${r.reach})`);
	assert.ok(r.exact < 1e-5, `sideways trail meets the target exactly (${r.exact})`);
}

// (b) Unreachable targets: plane change <= 30 deg, limb straight, lengths kept.
for (const delta of [[-0.18, 1.1, -0.12], [0.45, 0.35, -0.7], [-0.5, 0.9, 0.5]]) {
	assert.ok(targetDistance(delta) > reach * 1.25, `${delta}: target is past the easing band`);
	const r = drag(delta);
	const reached = r.after[0].distanceTo(r.after[2]);
	console.log(`over-reach ${delta}: target ${(targetDistance(delta) * 100).toFixed(1)} cm, plane ${r.plane.toFixed(2)} deg, shoulder-hand ${(reached * 100).toFixed(1)} cm`);
	assert.ok(r.plane <= LIMIT + 1e-6, `${delta}: over-reach plane change ${r.plane} deg`);
	assert.ok(Math.abs(reached - before[0].distanceTo(before[1]) - before[1].distanceTo(before[2])) < 1e-3, `${delta}: limb straightens to full reach`);
}

// (c) A 20-step drag from inside reach (where the free plane is already
// past 30 deg) to far beyond it: the limit eases in, never pops.
for (const full of [[-0.18, 1.1, -0.12], [0.45, 0.35, -0.7]]) {
	const at = (step) => full.map((v) => v * (0.7 + 0.3 * step / 20));
	assert.ok(targetDistance(at(0)) < reach && targetDistance(at(20)) > reach * 1.25, `${full}: drag crosses the reach boundary`);
	const start = drag(at(0));
	assert.ok(start.plane > LIMIT, `${full}: free plane at the boundary exceeds the limit (${start.plane})`);
	let previous = plane(start.after), previousTurn = start.plane, maxStep = 0;
	const turns = [start.plane.toFixed(1)];
	for (let step = 1; step <= 20; step += 1) {
		const r = drag(at(step));
		const next = plane(r.after);
		maxStep = Math.max(maxStep, THREE.MathUtils.radToDeg(previous.angleTo(next)));
		previous = next;
		previousTurn = r.plane;
		turns.push(r.plane.toFixed(1));
	}
	console.log(`crossing ${full}: max plane step ${maxStep.toFixed(2)} deg, plane ${turns.join(" ")}`);
	assert.ok(maxStep < 5, `${full}: max plane step ${maxStep} deg`);
	assert.ok(previousTurn <= LIMIT + 1e-6, `${full}: drag ends inside the limit (${previousTurn})`);
}
console.log("all motion trail over-reach checks passed");

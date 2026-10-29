#!/usr/bin/env node
import assert from "node:assert/strict";
import * as THREE from "three";
import { cameraPerformanceKeys, framingFromCamera } from "../src/camera-performance.js";
import { applyCameraOptics, focusDistance, repairOptics } from "../src/camera-optics.js";
import { emptyReview, repairReview, reviewAtFrame, timecodeAt } from "../src/shot-review.js";
import { reviewSlate } from "../src/review-burn-in.js";
import { applyBreakdownPose, breakdownNeighbors, breakdownPlacement, restoreLocalRig, snapshotLocalRig } from "../src/motion/pose-breakdown.js";

const camera = new THREE.PerspectiveCamera(50, 16 / 9, 0.1, 100);
camera.position.set(1, 2, 3);
const framing = framingFromCamera(camera, { yaw: 0.2, pitch: -0.1 });
assert.deepEqual(framing.pos, { x: 1, y: 2, z: 3 });
assert.equal(framing.fovDeg, 50);
const keys = cameraPerformanceKeys([
	{ seconds: 0, framing },
	{ seconds: 1 / 48, framing: { ...framing, yaw: 0.1 } },
	{ seconds: 1 / 24, framing: { ...framing, yaw: 0.3 } },
	{ seconds: 1, framing: { ...framing, yaw: 0.5 } },
], { startFrame: 10, endFrame: 34, fps: 24 });
assert.deepEqual(keys.map(key => key.frame), [10, 11, 34]);
assert.equal(keys[1].framing.yaw, 0.3, "one addressed frame keeps the latest sample");
assert.equal(cameraPerformanceKeys([], { startFrame: 0, endFrame: 10 }).length, 0);
const longPerformance = cameraPerformanceKeys(Array.from({ length: 2000 }, (_, frame) => ({ seconds: frame / 24, framing })), { startFrame: 0, endFrame: 1999, fps: 24 });
assert.equal(longPerformance.length, 600, "long recordings fit the shot command limit");
assert.equal(longPerformance[0].frame, 0);
assert.equal(longPerformance.at(-1).frame, 1999, "downsampling preserves the performance end");

assert.deepEqual(repairOptics({ shiftX: 2, shiftY: -2, focusTargetId: " hero " }), { shiftX: 0.5, shiftY: -0.5, focusTargetId: "hero" });
applyCameraOptics(camera, { shiftX: 0.1, shiftY: -0.2 });
assert.equal(camera.view.enabled, true);
assert.equal(camera.view.offsetX, -100);
assert.equal(camera.view.offsetY, -200);
applyCameraOptics(camera, null);
assert.equal(camera.view.enabled, false, "switching shots cannot leak lens shift");
assert.equal(focusDistance({ x: 0, y: 0, z: 0 }, { x: 0, y: 3, z: 4 }), 5);

const review = repairReview({ burnIn: true,
	comments: [{ id: "a", frame: 12, text: " Note " }, { id: "b", frame: 99, text: "outside" }],
	annotations: [{ id: "s", frame: 12, color: "red", points: [[0, 0], [1, 1], [2, 0]] }],
}, { startFrame: 0, endFrame: 24 });
assert.equal(review.comments.length, 1);
assert.equal(review.annotations[0].color, "#ffbf47");
assert.equal(review.annotations[0].points.length, 2);
assert.equal(reviewAtFrame(review, 12).comments[0].text, "Note");
assert.equal(reviewAtFrame(emptyReview(), 0).comments.length, 0);
assert.equal(timecodeAt(61, 24), "00:00:02:13");
assert.equal(reviewSlate({ shot: { name: "CU" }, frame: 61, focalMm: 50, projectName: "Demo" }).detail, "F 0061  ·  00:00:02:13  ·  50mm");

assert.deepEqual(breakdownNeighbors([0, 12, 24], 18), { before: 12, after: 24, weight: 0.5 });
assert.equal(breakdownNeighbors([0, 24], 24), null);
assert.deepEqual(breakdownPlacement({ x: 0, z: 0, rot: 0 }, { x: 2, z: 4, rot: 90 }, 0.25), { x: 0.5, z: 1, rot: 22.5 });
const rig = new THREE.Group(), bone = new THREE.Bone(); bone.name = "Hips"; rig.add(bone);
bone.position.set(0, 1, 0);
const before = snapshotLocalRig(rig);
bone.position.set(0, 3, 0); bone.quaternion.setFromAxisAngle(new THREE.Vector3(0, 1, 0), Math.PI / 2);
const after = snapshotLocalRig(rig);
applyBreakdownPose(rig, before, after, 0.5);
assert.equal(bone.position.y, 2);
assert.equal(Math.round(bone.quaternion.angleTo(after.get("Hips").quaternion) * 1000) > 0, true);
restoreLocalRig(rig, before);
assert.equal(bone.position.y, 1);

console.log("PASS previs camera, optics, review, burn-in and breakdown contracts");

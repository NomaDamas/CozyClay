#!/usr/bin/env node
import assert from "node:assert/strict";
import { applyMotionCalibration, normalizeMotionCalibration } from "../../src/ardy/motion-calibration.js";

const rotMats = new Float32Array(9);
rotMats[0] = rotMats[4] = rotMats[8] = 1;
const rootPos = new Float32Array([1, 2, 3, 2, 2, 3]);
const posedJoints = new Float32Array([
	1, 2, 3, 0, 2, 0,
	2, 2, 3, 1, 2, 0,
]);
const source = { frames: 2, fps: 24, rootPos, posedJoints, rotMats };
const originalRoot = rootPos.slice(), originalJoints = posedJoints.slice();
const { motion: calibrated, diagnostics } = applyMotionCalibration(source, {
	scale: 2, yawDeg: 90, offsetX: 1, offsetY: 2, offsetZ: -1,
});
assert.notEqual(calibrated, source);
assert.notEqual(calibrated.rootPos, source.rootPos);
assert.notEqual(calibrated.posedJoints, source.posedJoints);
assert.deepEqual(source.rootPos, originalRoot, "source root is not mutated");
assert.deepEqual(source.posedJoints, originalJoints, "source joints are not mutated");
assert.equal(calibrated.rootPos[0], 7); // (x,z)=(1,3) -> (6,2), then + (1,-1)
assert.equal(calibrated.rootPos[1], 6);
assert.equal(calibrated.rootPos[2], -3);
assert.equal(calibrated.rootPos[3], 7);
assert.equal(calibrated.rootPos[4], 6);
assert.equal(calibrated.rootPos[5], -5);
assert.equal(calibrated.rotMats, source.rotMats, "local rotations stay unchanged");
assert.equal(diagnostics.status, "calibrated");
assert.equal(diagnostics.applied, true);
assert.equal(diagnostics.changedFrames, 2);
assert.ok(diagnostics.maxDisplacement > 0);
assert.equal(diagnostics.maxDisplacement, Math.max(diagnostics.maxRootDisplacement, diagnostics.maxJointDisplacement));

const bounded = normalizeMotionCalibration({ scale: -5, yawDeg: 540, offsetX: 1000, offsetY: "bad", offsetZ: -1000 });
assert.deepEqual(bounded, { scale: 1, yawDeg: -180, offsetX: 100, offsetY: 0, offsetZ: -100 });
const identity = applyMotionCalibration(source, null);
assert.equal(identity.motion, source, "identity calibration keeps the original take");
assert.equal(identity.diagnostics.maxDisplacement, 0);
console.log("PASS motion scene calibration applies rigid scale/yaw/offset without mutating source and reports displacement");

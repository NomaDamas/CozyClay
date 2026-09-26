import assert from "node:assert/strict";
import { CSKEL27_NEUTRAL } from "../../src/ardy/cskel27-neutral.js";
import { guardTrajectoryFloor } from "../../tools/ardy/gvhmr-floor.mjs";

const frames = 12, rotMats = new Float32Array(frames * 27 * 9);
for (let i = 0; i < rotMats.length; i += 9) rotMats[i] = rotMats[i + 4] = rotMats[i + 8] = 1;
const rootPos = new Float32Array(frames * 3), posedJoints = new Float32Array(frames * 27 * 3);
for (let f = 0; f < frames; f++) {
	const y = f < 5 ? 1.3 : .91;
	rootPos[f * 3 + 1] = y;
	for (let j = 0; j < 27; j++) posedJoints.set([CSKEL27_NEUTRAL[j][0], CSKEL27_NEUTRAL[j][1] + y, CSKEL27_NEUTRAL[j][2]], (f * 27 + j) * 3);
}
const motion = { frames, fps: 24, rootPos, posedJoints, rotMats };
const before = { rootPos: rootPos.slice(), posedJoints: posedJoints.slice() };
assert.equal(guardTrajectoryFloor(motion).motion, motion, "no event returns exact original object");
const { motion: after, diagnostics } = guardTrajectoryFloor(motion, [{ start: 5, landing: 5, anchor: 11 }]);
assert.equal(diagnostics.status, "verified");
assert.ok(diagnostics.changedFrames > 0);
assert.ok(diagnostics.models.every(m => m.minimumAfterM >= .0019));
assert.equal(after.rotMats, motion.rotMats, "rotations are never changed");
assert.deepEqual(motion.rootPos, before.rootPos, "caller root is not mutated");
assert.deepEqual(motion.posedJoints, before.posedJoints, "caller joints are not mutated");
assert.deepEqual(after.rootPos.slice(0, 9), before.rootPos.slice(0, 9), "safe frames outside the correction ramp stay exact");
for (let f = 0; f < frames; f++) {
	assert.equal(after.rootPos[f * 3], before.rootPos[f * 3]);
	assert.equal(after.rootPos[f * 3 + 2], before.rootPos[f * 3 + 2]);
	const dy = after.rootPos[f * 3 + 1] - before.rootPos[f * 3 + 1];
	for (let j = 0; j < 27; j++) assert.ok(Math.abs(after.posedJoints[(f * 27 + j) * 3 + 1] - before.posedJoints[(f * 27 + j) * 3 + 1] - dy) < 1e-6);
}
console.log("PASS GVHMR descent floor guard: both real skins, no source mutation, preserved rotations/XZ/prefix");

const low = { ...motion, rootPos: rootPos.slice(), posedJoints: posedJoints.slice() };
for (let f = 5; f < frames; f++) {
	low.rootPos[f * 3 + 1] -= .22;
	for (let j = 0; j < 27; j++) low.posedJoints[(f * 27 + j) * 3 + 1] -= .22;
}
const calibrated = guardTrajectoryFloor(low, [{ start: 2, landing: 5, anchor: 11, endpointSource: "observed-plateau" }]);
assert.ok(calibrated.diagnostics.endpointDatumLiftM > 0);
assert.ok(calibrated.diagnostics.models.every(m => m.minimumAfterM >= .0019));
assert.deepEqual(calibrated.motion.rootPos.slice(0, 6), low.rootPos.slice(0, 6));
assert.equal(calibrated.motion.rotMats, low.rotMats);
console.log("PASS observed endpoint calibrated to real target skins before residual floor safety");
const raisedTail = { ...low, rootPos: low.rootPos.slice(), posedJoints: low.posedJoints.slice() };
for (let f = 10; f < frames; f++) {
	raisedTail.rootPos[f * 3 + 1] += .15;
	for (let j = 0; j < 27; j++) raisedTail.posedJoints[(f * 27 + j) * 3 + 1] += .15;
}
const noCushion = guardTrajectoryFloor(raisedTail, [{ start: 2, landing: 5, anchor: 11, endpointSource: "observed-plateau" }]);
assert.ok(Math.abs(noCushion.motion.rootPos[34] - calibrated.motion.rootPos[34]) < 1e-5,
	"landing datum must not remain as an unnecessary floating cushion");
console.log("PASS post-landing clearance releases unnecessary datum lift");
const lowStart = { ...motion, rootPos: rootPos.slice(), posedJoints: posedJoints.slice() };
lowStart.rootPos[1] -= .4;
for (let j = 0; j < 27; j++) lowStart.posedJoints[j * 3 + 1] -= .4;
const startSafe = guardTrajectoryFloor(lowStart, [{ start: 5, landing: 5, anchor: 11 }]);
assert.ok(startSafe.motion.rootPos[1] > lowStart.rootPos[1], "initial skin penetration must also be protected");
assert.ok(startSafe.diagnostics.models.every(m => m.minimumAfterM >= .0019));

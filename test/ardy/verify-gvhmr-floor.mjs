import assert from "node:assert/strict";
import { CSKEL27_NEUTRAL } from "../../src/ardy/cskel27-neutral.js";
import { guardTrajectoryFloor } from "../../tools/ardy/gvhmr-floor.mjs";

// Neutral-pose take whose root height follows `ys`. A root at ~.954 puts the
// canonical toe joints on the floor; .91 sinks both shipped skins.
function standingTake(ys, extra = {}, [dx, dz] = [0, 0]) {
	const frames = ys.length, rotMats = new Float32Array(frames * 27 * 9);
	for (let i = 0; i < rotMats.length; i += 9) rotMats[i] = rotMats[i + 4] = rotMats[i + 8] = 1;
	const rootPos = new Float32Array(frames * 3), posedJoints = new Float32Array(frames * 27 * 3);
	for (let f = 0; f < frames; f++) {
		rootPos.set([f * dx, ys[f], f * dz], f * 3);
		for (let j = 0; j < 27; j++) posedJoints.set([CSKEL27_NEUTRAL[j][0] + f * dx, CSKEL27_NEUTRAL[j][1] + ys[f], CSKEL27_NEUTRAL[j][2] + f * dz], (f * 27 + j) * 3);
	}
	return { frames, fps: 24, rootPos, posedJoints, rotMats, ...extra };
}

// No scene reset: a take whose skins clear the floor everywhere (a clip
// that is elevated throughout) comes back as the exact original object. The
// guard only raises penetrating frames; it never re-grounds a take or
// touches scene placement fields.
const scene = { anchorFrame: 2, anchorX: .4, anchorZ: -.3, rotationDeg: 30, sceneCalibration: { y: .15 } };
const hovering = standingTake(Array(8).fill(1.3), scene);
const kept = guardTrajectoryFloor(hovering);
assert.equal(kept.motion, hovering, "a clear ordinary take is returned untouched");
assert.equal(kept.diagnostics.mode, "ordinary");
assert.equal(kept.diagnostics.changedFrames, 0);
assert.equal(kept.diagnostics.groundingLiftM, 0);
assert.ok(kept.diagnostics.models.every(m => m.minimumBeforeM > .3 && m.minimumAfterM === m.minimumBeforeM), "elevated take is not pulled down");
console.log("PASS clear ordinary take: no scene reset, no lowering, same object");

// Skin-aware correction without descent events. Standing frames sink both
// skins; a jump and an elevated landing (feet ~30 cm up) do not. Minimum
// grounding lifts the whole take rigidly by the deepest foot clearance, so
// the jump arc and the platform height are preserved exactly.
const ordinaryYs = [.91, .91, .91, .91, 1.05, 1.2, 1.25, 1.2, 1.05, .91, .91, 1.21, 1.21, 1.21, 1.21, 1.21];
const ordinary = standingTake(ordinaryYs, { ...scene, personScale: 1, boneScale: new Float32Array(27).fill(1) }, [.03, .01]);
const ordinaryBefore = { rootPos: ordinary.rootPos.slice(), posedJoints: ordinary.posedJoints.slice() };
const grounded = guardTrajectoryFloor(ordinary);
assert.equal(grounded.diagnostics.mode, "ordinary");
assert.ok(grounded.diagnostics.models.every(m => m.minimumBeforeM < -.02), "fixture must sink both skins");
assert.ok(grounded.diagnostics.models.every(m => m.minimumAfterM >= .0019), "no skin penetration on either body");
assert.ok(grounded.diagnostics.skeletalMinimumAfterM >= 0, "no skeletal foot joint below the floor");
assert.ok(Math.min(...grounded.diagnostics.models.map(m => m.minimumAfterM)) < .003, "deeper body lands on the floor, not above it");
assert.ok(grounded.diagnostics.groundingLiftM > .02 && grounded.diagnostics.groundingLiftM < .25);
assert.equal(grounded.diagnostics.changedFrames, ordinary.frames);
assert.deepEqual(ordinary.rootPos, ordinaryBefore.rootPos, "caller root is not mutated");
assert.deepEqual(ordinary.posedJoints, ordinaryBefore.posedJoints, "caller joints are not mutated");
assert.equal(grounded.motion.rotMats, ordinary.rotMats, "rotations are never changed");
for (const key of [...Object.keys(scene), "personScale", "boneScale"]) assert.equal(grounded.motion[key], ordinary[key], `${key} is carried through untouched`);
for (let f = 0; f < ordinary.frames; f++) {
	assert.equal(grounded.motion.rootPos[f * 3], ordinary.rootPos[f * 3]);
	assert.equal(grounded.motion.rootPos[f * 3 + 2], ordinary.rootPos[f * 3 + 2]);
	const dy = grounded.motion.rootPos[f * 3 + 1] - ordinary.rootPos[f * 3 + 1];
	assert.ok(Math.abs(dy - grounded.diagnostics.groundingLiftM) < 1e-6, `frame ${f} lifted rigidly (${dy})`);
	for (let j = 0; j < 27; j++) assert.ok(Math.abs(grounded.motion.posedJoints[(f * 27 + j) * 3 + 1] - ordinary.posedJoints[(f * 27 + j) * 3 + 1] - dy) < 1e-6);
}
const apex = grounded.motion.rootPos[6 * 3 + 1] - grounded.motion.rootPos[1], platform = grounded.motion.rootPos[13 * 3 + 1] - grounded.motion.rootPos[1];
assert.ok(Math.abs(apex - (1.25 - .91)) < 1e-6 && Math.abs(platform - (1.21 - .91)) < 1e-6, "jump and elevated landing keep their height");
console.log("PASS ordinary take without descent events: both skins grounded by one rigid lift, jump/platform preserved");

const motion = standingTake(Array.from({ length: 12 }, (_, f) => f < 5 ? 1.3 : .91));
const { frames, rootPos, posedJoints } = motion;
const before = { rootPos: rootPos.slice(), posedJoints: posedJoints.slice() };
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

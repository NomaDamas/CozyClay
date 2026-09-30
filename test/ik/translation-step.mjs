import assert from "node:assert/strict";
import * as THREE from "three";

// Override only the module under test to measure origin/main without writing
// to that checkout. The same fixture and thresholds run on both revisions.
const { createIkState, ikBakeKeyframe, ikEvaluate, solveIk, solveMidJoint } = await import(
	process.env.IK_TRANSLATION_TEST_MODULE ?? "../../src/ardy/ik.js"
);
const KEY_FRAME = 20;
const BLEND = 6;
const mm = (value) => (value * 1000).toFixed(6);
const v = () => new THREE.Vector3();

function makeTake({ yaw = 0, moving = true, bend = -0.8 } = {}) {
	const rig = new THREE.Group();
	rig.scale.setScalar(0.01); // Mixamo centimetres -> world metres
	rig.rotation.y = yaw;
	const bones = ["LeftArm", "LeftForeArm", "LeftHand"].map((name) => {
		const bone = new THREE.Bone();
		bone.name = `mixamorig${name}`;
		return bone;
	});
	rig.add(bones[0]);
	bones[0].add(bones[1]);
	bones[1].add(bones[2]);
	bones[0].position.set(10, 100, 0);
	bones[1].position.set(30, 0, 0);
	bones[2].position.set(30, 0, 0);
	rig.updateMatrixWorld(true);
	// The same chain data resolveIkRig captures, without unrelated limbs.
	const chain = {
		rig, bones,
		bindPositions: bones.map((bone) => bone.position.clone()),
		lengths: [0, 1].map((i) => bones[i].getWorldPosition(v()).distanceTo(bones[i + 1].getWorldPosition(v()))),
		poleLocal: new THREE.Vector3(0, -1, 0),
	};
	const chains = new Map([["leftHand", chain]]);
	const state = createIkState();
	const poseClip = (frame) => {
		bones.forEach((bone, i) => {
			bone.position.copy(chain.bindPositions[i]);
			bone.position.z += 2; // each bone is exactly 20 mm off bind
			bone.quaternion.identity();
		});
		bones[1].rotation.z = bend;
		rig.position.z = moving ? (frame - KEY_FRAME) * 0.0005 : 0;
		rig.updateMatrixWorld(true);
	};
	const effector = () => bones[2].getWorldPosition(v());
	poseClip(KEY_FRAME);
	const clipPositions = bones.map((bone) => bone.position.clone());
	// A 1 cm chord along the forearm's reachable arc isolates the translation
	// transition from the separate near-full-extension/bend-continuity problem.
	const elbow = bones[1].getWorldPosition(v());
	const axis = new THREE.Vector3(0, 0, 1).applyQuaternion(rig.quaternion);
	const target = effector().sub(elbow).applyAxisAngle(axis, 2 * Math.asin(0.01 / (2 * 0.3))).add(elbow);
	assert.ok(Math.abs(target.distanceTo(effector()) - 0.01) < 1e-12);
	const baseQuats = new Map([["leftHand", bones.map((bone) => bone.quaternion.clone())]]);
	solveIk(chain, target);
	ikBakeKeyframe(chains, state, KEY_FRAME, null, ["leftHand"], null, baseQuats);
	assert.equal(state.keys.size, 1);
	assert.equal(state.keys.get(KEY_FRAME).get("leftHand").baseQ.length, 3);
	const evaluate = (frame) => {
		poseClip(frame); // no cumulative evaluation: playback writes the clip first
		ikEvaluate(chains, state, frame, null, BLEND);
		return effector();
	};
	return { bones, chain, chains, state, poseClip, clipPositions, baseQuats, effector, target, evaluate };
}

for (const [name, options] of [
	["moving", {}],
	["stationary", { moving: false }],
	["yawed", { yaw: 0.7 }],
	["straight", { bend: 0 }],
]) {
	const take = makeTake(options);
	let previous = null;
	let previousClip = null;
	let clipStep = 0;
	let correctedStep = 0;
	let maxDrift = 0;
	let keyedError = 0;
	// Include BOTH zero-weight boundaries and the frame outside each one.
	for (let frame = KEY_FRAME - BLEND - 1; frame <= KEY_FRAME + BLEND + 1; frame += 1) {
		take.poseClip(frame);
		const clip = take.effector();
		const corrected = take.evaluate(frame);
		if (previous) {
			clipStep = Math.max(clipStep, clip.distanceTo(previousClip));
			correctedStep = Math.max(correctedStep, corrected.distanceTo(previous));
		}
		maxDrift = Math.max(maxDrift, corrected.distanceTo(clip));
		if (frame === KEY_FRAME) keyedError = corrected.distanceTo(take.target);
		if (Math.abs(frame - KEY_FRAME) >= BLEND) assert.ok(corrected.distanceTo(clip) < 1e-12);
		previous = corrected;
		previousClip = clip;
	}
	console.log(`MEASURE ${name}: clipStep=${mm(clipStep)}mm correctedStep=${mm(correctedStep)}mm excess=${mm(correctedStep - clipStep)}mm keyedError=${mm(keyedError)}mm maxDrift=${mm(maxDrift)}mm`);
	assert.ok(correctedStep - clipStep < 0.003, `${name}: max effector step must exceed the clip's own step by less than 3 mm`);
	assert.ok(keyedError < 0.001, `${name}: keyed effector must hit the 1 cm correction target within 1 mm`);
	// Fractional-frame scrubbing must be continuous at the full-weight switch,
	// not merely spread the old discontinuity over adjacent integer frames.
	const key = take.evaluate(KEY_FRAME);
	for (const side of [-1, 1]) {
		assert.ok(take.evaluate(KEY_FRAME + side * 1e-5).distanceTo(key) < 1e-6,
			`${name}: no translation discontinuity on either side of the key`);
	}
	// New keys replay in the clip-translation space they were solved in.
	const entry = take.state.keys.get(KEY_FRAME).get("leftHand");
	assert.equal(entry.keepTranslations, true);
	assert.equal(entry.chainP, undefined, "a pure rotation delta must not freeze clip translations");
	take.evaluate(KEY_FRAME - 1);
	take.bones.forEach((bone, i) => assert.ok(bone.position.equals(take.clipPositions[i])));
	// Legacy keys without explicit translations still need their bind pose at
	// full weight, but must ease into it continuously rather than switch.
	delete entry.keepTranslations;
	delete entry.chainP;
	const legacyKey = take.evaluate(KEY_FRAME);
	for (const side of [-1, 1]) {
		assert.ok(take.evaluate(KEY_FRAME + side * 1e-5).distanceTo(legacyKey) < 1e-6);
	}
	take.evaluate(KEY_FRAME - 1);
	take.bones.forEach((bone, i) => assert.ok(bone.position.distanceTo(
		take.clipPositions[i].clone().lerp(take.chain.bindPositions[i], 5 / 6),
	) < 1e-10));
	// Existing explicit translation keys (physics review) must still opt out
	// of the bind reset, whether or not they carry a chainP pose.
	entry.keepTranslations = true;
	take.evaluate(KEY_FRAME);
	take.bones.forEach((bone, i) => assert.ok(bone.position.equals(take.clipPositions[i])));
	entry.chainP = take.clipPositions.map((p) => p.clone().add(new THREE.Vector3(0, 1, 0)));
	take.evaluate(KEY_FRAME - 1);
	take.bones.forEach((bone, i) => assert.ok(bone.position.distanceTo(
		take.clipPositions[i].clone().lerp(entry.chainP[i], 5 / 6),
	) < 1e-10));
	console.log(`PASS ${name}: <3 mm excess step, <1 mm target error, continuous subframes and translation opt-out`);
}
// A changing clip keeps its own translations even within a key's ramp.
{
	const take = makeTake();
	take.poseClip(KEY_FRAME - 1);
	take.bones.forEach((bone, i) => bone.position.y += 0.3 * (i + 1));
	const positions = take.bones.map((bone) => bone.position.clone());
	ikEvaluate(take.chains, take.state, KEY_FRAME - 1, null, BLEND);
	take.bones.forEach((bone, i) => assert.ok(bone.position.equals(positions[i])));
	const mid = take.bones[1].getWorldPosition(v());
	const length = take.bones[0].getWorldPosition(v()).distanceTo(mid);
	const clamped = solveMidJoint(take.chain, mid.clone().add(new THREE.Vector3(0, 0.02, 0)));
	assert.ok(take.bones[1].getWorldPosition(v()).distanceTo(clamped) < 1e-9);
	assert.ok(Math.abs(take.bones[0].getWorldPosition(v()).distanceTo(clamped) - length) < 1e-9);
	take.bones.forEach((bone, i) => assert.ok(bone.position.equals(positions[i])));
	console.log("PASS animated clip translations and mid-joint segment lengths stay intact");
}

// Re-keying a legacy/explicit-position layer must retain the live pose, even
// though a new rotation-only correction normally needs no translation data.
for (const explicit of [false, true]) {
	const take = makeTake();
	const entry = take.state.keys.get(KEY_FRAME).get("leftHand");
	if (explicit) entry.chainP = take.clipPositions.map((p) => p.clone().add(new THREE.Vector3(0, 1, 0)));
	else delete entry.keepTranslations;
	const live = take.evaluate(KEY_FRAME - 1);
	const positions = take.bones.map((bone) => bone.position.clone());
	const scratch = createIkState(); // the drag-end bake uses a fresh key map
	ikBakeKeyframe(take.chains, scratch, KEY_FRAME - 1, null, ["leftHand"], null, take.baseQuats);
	const rebaked = scratch.keys.get(KEY_FRAME - 1).get("leftHand");
	assert.ok(rebaked.chainP.every((p, i) => p.equals(positions[i])));
	take.state.keys = scratch.keys;
	assert.ok(take.evaluate(KEY_FRAME - 1).distanceTo(live) < 1e-9);
	console.log(`PASS re-keying ${explicit ? "explicit" : "legacy"} translations reproduces the live pose`);
}

// A key island can mix an older translation key and a new rotation-only key.
// Neither direction may jump as the interpolation meets either keyed frame.
for (const explicit of [false, true]) for (const reverse of [false, true]) {
	const take = makeTake();
	const pure = take.state.keys.get(KEY_FRAME).get("leftHand");
	const positioned = { ...pure };
	if (explicit) positioned.chainP = take.clipPositions.map((p) => p.clone().add(new THREE.Vector3(0, 1, 0)));
	else delete positioned.keepTranslations;
	take.state.keys.set(KEY_FRAME, new Map([["leftHand", reverse ? pure : positioned]]));
	take.state.keys.set(KEY_FRAME + 4, new Map([["leftHand", reverse ? positioned : pure]]));
	for (const frame of [KEY_FRAME, KEY_FRAME + 4]) {
		const keyed = take.evaluate(frame);
		for (const side of [-1, 1]) assert.ok(take.evaluate(frame + side * 1e-5).distanceTo(keyed) < 1e-6);
	}
	console.log(`PASS mixed ${explicit ? "explicit" : "legacy"}/clip translation island, reverse=${reverse}`);
}
console.log("all PASS translation-step");

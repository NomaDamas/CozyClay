/**
 * Real-rig positional-skinning validation: loads the actual
 * x-bot-tpose.fbx (the same asset the app renders and the viser demo's
 * avatar asset was prepared from) and drives it with a synthetic motion
 * built on the ARDY neutral skeleton (cskel27-neutral.js, exported from
 * CoreSkeleton27.neutral_joints on the box).
 *
 * Assertions:
 *  1. Zero pop: a frame at the floor-shifted ARDY neutral pose reproduces
 *     the rig's bind world positions/quaternions for every mapped bone.
 *  2. Floor plant: with the neutral pose the lowest mapped bone sits within
 *     millimetres of the rig's bind floor (offset residual only).
 *  3. Translation + rotation: a translated, hips-rotated frame moves every
 *     mapped bone to the independently computed skinning target
 *     (s * posed + R @ offset, R @ bindQuat).
 *  4. The prep scale factor is in the plausible cm-per-metre band (guards
 *     the unit logic: X Bot bind hips 104.27 rig units vs ARDY 0.9544 m).
 */
import * as THREE from "three";
import { FBXLoader } from "three/examples/jsm/loaders/FBXLoader.js";
import { readFileSync } from "node:fs";
import {
	applyMotionFrame,
	captureArdyRoot,
	motionBones,
	snapshotPlaybackBones,
	restorePlaybackBones,
} from "../../src/ardy/playback.js";
import { decodeMotionNpz } from "../../src/ardy/npz.js";
import { resolveIkRig, ikEvaluate, ikBakeKeyframe, solveIk, solveSwingAngle } from "../../src/ardy/ik.js";
import { CSKEL27_JOINTS, CSKEL27_PARENTS } from "../../src/ardy/cskel27.js";
import { CSKEL27_NEUTRAL } from "../../src/ardy/cskel27-neutral.js";
import { primeBindPose } from "../../src/poses.js";
import { smplToCskel27Motion } from "../../tools/ardy/smpl-cskel27.mjs";

const fail = [];
const ok = (label, cond, detail) => {
	console.log(`${cond ? "PASS" : "FAIL"} ${label}${detail ? `  ${detail}` : ""}`);
	if (!cond) fail.push(label);
};

const quatMaxError = (a, b) => {
	let best = Infinity;
	for (const sign of [1, -1]) {
		const err = Math.max(
			Math.abs(a.x - sign * b.x),
			Math.abs(a.y - sign * b.y),
			Math.abs(a.z - sign * b.z),
			Math.abs(a.w - sign * b.w),
		);
		if (err < best) best = err;
	}
	return best;
};

const ARDY_NEUTRAL_TOE = 0.9544128;
const JOINTS = CSKEL27_JOINTS.length;

const buf = readFileSync(new URL("../../public/models/x-bot-tpose.fbx", import.meta.url));
const rig = new FBXLoader().parse(
	buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength),
	"",
);
// App-faithful: Character scales the Mixamo centimetre rig to metres. The
// skinning math must stay in the space BELOW this root (a previous bug
// composed the root scale into the bind matrices and crushed the rig).
rig.scale.setScalar(0.01);
rig.updateMatrixWorld(true);

const bones = motionBones(rig);
const mapped = [];
for (let j = 0; j < JOINTS; j += 1) {
	if (bones[j]) mapped.push({ j, bone: bones[j] });
}
ok("real rig: skinning map resolves the Mixamo core bones", mapped.length >= 20, `mapped=${mapped.length}/27`);

// Bind reference (world, rig at origin) + local transforms for restore.
const bindWorldPos = new Map();
const bindWorldQuat = new Map();
const bindLocal = new Map();
for (const { bone } of mapped) {
	bindWorldPos.set(bone, bone.getWorldPosition(new THREE.Vector3()));
	bindWorldQuat.set(bone, bone.getWorldQuaternion(new THREE.Quaternion()));
	bindLocal.set(bone, { pos: bone.position.clone(), quat: bone.quaternion.clone() });
}

// Independent scale replication: rig leg height over ARDY's neutral leg.
const hips = bones[CSKEL27_JOINTS.indexOf("Hips")];
const hipsY = bindWorldPos.get(hips).y;
let lowestY = hipsY;
for (const { bone } of mapped) lowestY = Math.min(lowestY, bindWorldPos.get(bone).y);
const S = (hipsY - lowestY) / ARDY_NEUTRAL_TOE;
ok(
	"real rig: prep scale matches the rig-to-ARDY leg ratio",
	S > 1.0 && S < 1.25,
	`S=${S.toFixed(4)} scene units/m (bind hips ${hipsY.toFixed(4)} scene units)`,
);

// Motion: frame 0 = floor-shifted neutral (zero-pop + floor-plant checks),
// frame 1 = neutral translated by (+0.5, 0, -0.25) m with hips rotY(90).
const rotMats = new Float32Array(2 * JOINTS * 9);
for (let i = 0; i < rotMats.length; i += 9) {
	rotMats[i] = 1;
	rotMats[i + 4] = 1;
	rotMats[i + 8] = 1;
}
const hipsRotBase = JOINTS * 9; // frame 1, joint 0
rotMats[hipsRotBase + 0] = 0;
rotMats[hipsRotBase + 2] = 1;
rotMats[hipsRotBase + 4] = 1;
rotMats[hipsRotBase + 6] = -1;
rotMats[hipsRotBase + 8] = 0;

const posedJoints = new Float32Array(2 * JOINTS * 3);
for (let j = 0; j < JOINTS; j += 1) {
	const n = CSKEL27_NEUTRAL[j];
	posedJoints[(0 * JOINTS + j) * 3] = Math.fround(n[0]);
	posedJoints[(0 * JOINTS + j) * 3 + 1] = Math.fround(n[1] + ARDY_NEUTRAL_TOE);
	posedJoints[(0 * JOINTS + j) * 3 + 2] = Math.fround(n[2]);
	posedJoints[(1 * JOINTS + j) * 3] = Math.fround(n[0] + 0.5);
	posedJoints[(1 * JOINTS + j) * 3 + 1] = Math.fround(n[1] + ARDY_NEUTRAL_TOE);
	posedJoints[(1 * JOINTS + j) * 3 + 2] = Math.fround(n[2] - 0.25);
}
const rootY = Math.fround(ARDY_NEUTRAL_TOE);
const rootPos = new Float32Array([0, rootY, 0, 0.5, rootY, -0.25]);
const motion = { frames: 2, fps: 20, rotMats, rootPos, posedJoints, anchorFrame: 0 };

const snapshot = snapshotPlaybackBones(rig);

// 1. zero pop at the neutral frame.
applyMotionFrame(rig, motion, 0);
rig.updateMatrixWorld(true);
let popErr = 0;
let popQuatErr = 0;
let popWorst = "";
for (const { bone } of mapped) {
	const err = bone.getWorldPosition(new THREE.Vector3()).distanceTo(bindWorldPos.get(bone));
	if (err > popErr) { popErr = err; popWorst = bone.name; }
	popQuatErr = Math.max(popQuatErr, quatMaxError(bone.getWorldQuaternion(new THREE.Quaternion()), bindWorldQuat.get(bone)));
}
ok(
	"real rig: neutral frame reproduces the bind pose (zero pop)",
	popErr < 0.002 && popQuatErr < 1e-3,
	`max pos err ${popErr.toFixed(5)} scene units at ${popWorst}, max quat err ${popQuatErr.toExponential(1)}`,
);

// 2. floor plant: the lowest mapped bone returns to its bind floor height.
let lowestBoneY = Infinity;
for (const { bone } of mapped) lowestBoneY = Math.min(lowestBoneY, bone.getWorldPosition(new THREE.Vector3()).y);
ok(
	"real rig: lowest mapped bone plants at the bind floor",
	Math.abs(lowestBoneY - lowestY) < 0.002,
	`lowest=${lowestBoneY.toFixed(5)} bind floor=${lowestY.toFixed(5)}`,
);

// 3. translated + rotated frame: independent target for every mapped bone.
applyMotionFrame(rig, motion, 1);
rig.updateMatrixWorld(true);
const qGlobal = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), Math.PI / 2);
const anchorX = Math.fround(CSKEL27_NEUTRAL[0][0]); // anchor hips xz (frame 0)
const anchorZ = Math.fround(CSKEL27_NEUTRAL[0][2]);
let posErr = 0;
let quatErr = 0;
let preservedLocalErr = 0;
let posWorst = "";
const hierarchyPreserved = new Set([
	"RightShoulder", "RightArm", "RightForeArm",
	"LeftShoulder", "LeftArm", "LeftForeArm",
]);
for (const { j, bone } of mapped) {
	const n = CSKEL27_NEUTRAL[j];
	const offset = bindWorldPos.get(bone).clone().sub(new THREE.Vector3(
		S * n[0],
		S * (n[1] + ARDY_NEUTRAL_TOE),
		S * n[2],
	));
	const expected = new THREE.Vector3(
		S * (Math.fround(n[0] + 0.5) - anchorX),
		S * Math.fround(n[1] + ARDY_NEUTRAL_TOE),
		S * (Math.fround(n[2] - 0.25) - anchorZ),
	).add(offset.applyQuaternion(qGlobal));
	if (hierarchyPreserved.has(CSKEL27_JOINTS[j])) {
		preservedLocalErr = Math.max(
			preservedLocalErr,
			bone.position.distanceTo(bindLocal.get(bone).pos)
		);
	} else {
		const err = bone.getWorldPosition(new THREE.Vector3()).distanceTo(expected);
		if (err > posErr) { posErr = err; posWorst = bone.name; }
	}
	const expectedQuat = qGlobal.clone().multiply(bindWorldQuat.get(bone));
	quatErr = Math.max(quatErr, quatMaxError(bone.getWorldQuaternion(new THREE.Quaternion()), expectedQuat));
}
ok(
	"real rig: body hits positional targets while arm chains preserve Mixamo translations",
	posErr < 0.005 && preservedLocalErr < 1e-6 && quatErr < 1e-3,
	`body pos ${posErr.toFixed(5)} at ${posWorst}, arm local ${preservedLocalErr.toExponential(1)}, quat ${quatErr.toExponential(1)}`,
);

// 4. restore reproduces the bind transforms bitwise.
restorePlaybackBones(rig, snapshot);
ok(
	"real rig: restore reproduces bind transforms exactly",
	mapped.every(({ bone }) => {
		const b = bindLocal.get(bone);
		return bone.position.equals(b.pos) && bone.quaternion.equals(b.quat);
	}),
	`bones=${mapped.length} bitwise`,
);

// 5. Regression for the reported shoulder kink on the actual app rig and
// shipped generated clip. A child's translated joint center must stay on the
// direction encoded by its parent's rotated Mixamo bone; positional skinning
// previously diverged by 31-44 degrees at Shoulder -> Arm.
const yBuf = readFileSync(new URL("../../public/models/y-bot-tpose.fbx", import.meta.url));
const yRig = new FBXLoader().parse(
	yBuf.buffer.slice(yBuf.byteOffset, yBuf.byteOffset + yBuf.byteLength),
	"",
);
yRig.scale.setScalar(0.01);
yRig.updateMatrixWorld(true);
const yBones = motionBones(yRig);
const demoBytes = readFileSync(new URL("../../public/demo/walk-then-stop.npz", import.meta.url));
const demoMotion = await decodeMotionNpz(demoBytes);
const armPairs = [
	["LeftShoulder", "LeftArm"],
	["LeftArm", "LeftForeArm"],
	["RightShoulder", "RightArm"],
	["RightArm", "RightForeArm"],
].map(([parentName, childName]) => ({
	parent: yBones[CSKEL27_JOINTS.indexOf(parentName)],
	child: yBones[CSKEL27_JOINTS.indexOf(childName)],
	bindLocal: yBones[CSKEL27_JOINTS.indexOf(childName)].position.clone(),
}));
let armDirectionError = 0;
for (let frame = 0; frame < demoMotion.frames; frame += 1) {
	applyMotionFrame(yRig, demoMotion, frame);
	for (const { parent, child, bindLocal } of armPairs) {
		const actual = child.getWorldPosition(new THREE.Vector3())
			.sub(parent.getWorldPosition(new THREE.Vector3()))
			.normalize();
		const expected = bindLocal.clone()
			.applyQuaternion(parent.getWorldQuaternion(new THREE.Quaternion()))
			.normalize();
		armDirectionError = Math.max(
			armDirectionError,
			THREE.MathUtils.radToDeg(
				Math.acos(THREE.MathUtils.clamp(actual.dot(expected), -1, 1))
			)
		);
	}
}
ok(
	"Y-Bot demo: shoulder and arm translations follow the rotated Mixamo hierarchy",
	armDirectionError < 0.01,
	`max direction error ${armDirectionError.toFixed(5)} deg across ${demoMotion.frames} frames`,
);

// A raw frame does not animate the wrist, but MUST reset its base before
// the IK layer. Repeated scrub/play used to accumulate the wrist delta.
const resolved = resolveIkRig(yRig), wristChain = resolved.chains.get("leftHand");
applyMotionFrame(yRig, demoMotion, 0);
const baseQ = wristChain.bones.map((b) => b.quaternion.clone());
const corrected = baseQ.map((q) => q.clone());
corrected[2].multiply(new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(1, 0, 0), .12));
const wristLayer = { tracked: new Set(["leftHand"]), keys: new Map([[0, new Map([["leftHand", { q: corrected, baseQ, keepTranslations: true }]])]]) };
let wristError = 0;
for (let i = 0; i < 100; i += 1) {
	applyMotionFrame(yRig, demoMotion, 0); ikEvaluate(resolved.chains, wristLayer, 0, resolved.fkJoints, 6);
	wristError = Math.max(wristError, wristChain.bones[2].quaternion.angleTo(corrected[2]));
}
ok("100 repeated seeks do not accumulate the wrist correction", wristError < 1e-6, `${wristError} rad`);

/* --- performer-sized takes (boneScale) --------------------------------------
 *
 * A mocap take carries the performer's bone lengths (smpl-cskel27 boneScale).
 * Invariants, on the real FBX rigs:
 *  6. Standing in the performer's neutral pose (grounded like the retarget
 *     grounds a take: lowest joint on the floor) reproduces the rig's bind pose
 *     for every positionally skinned bone and plants on the bind floor. The
 *     bind offsets used to be floor-shifted by the CANONICAL toe depth, which
 *     sank a short-legged performer's whole rig into the floor.
 *  7. The rotation-driven arm chain wears the performer's lengths, and
 *     captureArdyRoot inverts exactly the offsets that frame was applied with.
 *  8. The IK layer rests on the take's skeleton, not the rig's bind: solving,
 *     keying and replaying a correction never pops an arm segment back to its
 *     bind length, and repeated playback-plus-IK accumulates nothing.
 */
const J = (name) => CSKEL27_JOINTS.indexOf(name);
const loadPrimedRig = (file) => {
	const bytes = readFileSync(new URL(`../../public/models/${file}`, import.meta.url));
	const loaded = new FBXLoader().parse(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength), "");
	loaded.scale.setScalar(0.01);
	primeBindPose(loaded); // app-faithful: Character primes the bind snapshot at clone time
	loaded.updateMatrixWorld(true);
	return loaded;
};
const worldOf = (object) => object.getWorldPosition(new THREE.Vector3());

const performerScale = new Float32Array(JOINTS).fill(1);
for (const name of ["Spine", "Spine1", "Spine2", "Spine3"]) performerScale[J(name)] = 0.88;
for (const side of ["Left", "Right"]) {
	performerScale[J(`${side}Shoulder`)] = 0.95; performerScale[J(`${side}Arm`)] = 0.95;
	performerScale[J(`${side}ForeArm`)] = 1.08; performerScale[J(`${side}Hand`)] = 0.93;
	performerScale[J(`${side}UpLeg`)] = 0.9; performerScale[J(`${side}Leg`)] = 0.92;
	performerScale[J(`${side}Foot`)] = 0.91; performerScale[J(`${side}ToeBase`)] = 0.95;
}
const grownNeutral = [];
for (let j = 0; j < JOINTS; j += 1) {
	const parent = CSKEL27_PARENTS[j];
	const n = CSKEL27_NEUTRAL[j];
	grownNeutral[j] = parent === null
		? [...n]
		: n.map((v, i) => grownNeutral[parent][i] + performerScale[j] * (v - CSKEL27_NEUTRAL[parent][i]));
}
const grownFloor = Math.min(...grownNeutral.map((g) => g[1]));
// Frame 0: the performer's neutral, lowest joint on the floor. Frame 1: the
// same body turned 90 degrees about Y (frame 1 of rotMats) and moved by
// (+0.5, 0, -0.25) m, FK-consistent.
const performerPosed = new Float32Array(2 * JOINTS * 3);
for (let j = 0; j < JOINTS; j += 1) {
	const [x, y, z] = grownNeutral[j];
	performerPosed.set([x, y - grownFloor, z], j * 3);
	performerPosed.set([z + 0.5, y - grownFloor, -x - 0.25], (JOINTS + j) * 3);
}
const performerTake = {
	frames: 2, fps: 20, rotMats, posedJoints: performerPosed, anchorFrame: 0, boneScale: performerScale,
	rootPos: new Float32Array([0, -grownFloor, 0, 0.5, -grownFloor, -0.25]),
};

for (const file of ["x-bot-tpose.fbx", "y-bot-tpose.fbx"]) {
	const pRig = loadPrimedRig(file);
	const pBones = motionBones(pRig);
	const pBind = new Map();
	let pFloor = Infinity;
	for (const bone of pBones) if (bone) { const p = worldOf(bone); pBind.set(bone, p); pFloor = Math.min(pFloor, p.y); }
	const pScale = (pBind.get(pBones[J("Hips")]).y - pFloor) / ARDY_NEUTRAL_TOE;

	applyMotionFrame(pRig, performerTake, 0);
	let pop = 0, popAt = "", lowest = Infinity;
	for (const [j, bone] of pBones.entries()) {
		if (!bone) continue;
		const p = worldOf(bone);
		lowest = Math.min(lowest, p.y);
		if (hierarchyPreserved.has(CSKEL27_JOINTS[j])) continue;
		const err = p.distanceTo(pBind.get(bone));
		if (err > pop) { pop = err; popAt = bone.name; }
	}
	ok(`${file} performer take: neutral frame reproduces the positional bind pose`, pop < 1e-5,
		`max pos err ${pop.toExponential(2)} scene units at ${popAt}`);
	ok(`${file} performer take: neutral frame plants on the bind floor`, Math.abs(lowest - pFloor) < 1e-5,
		`lowest=${lowest.toFixed(6)} bind floor=${pFloor.toFixed(6)}`);

	let armLengthErr = 0;
	for (const side of ["Left", "Right"]) {
		const chainBones = [`${side}Arm`, `${side}ForeArm`, `${side}Hand`].map((name) => pRig.getObjectByName(`mixamorig${name}`));
		for (const [i, name] of [`${side}ForeArm`, `${side}Hand`].entries()) {
			const n = CSKEL27_NEUTRAL[J(name)], m = CSKEL27_NEUTRAL[CSKEL27_PARENTS[J(name)]];
			const want = pScale * performerScale[J(name)] * Math.hypot(n[0] - m[0], n[1] - m[1], n[2] - m[2]);
			armLengthErr = Math.max(armLengthErr, Math.abs(worldOf(chainBones[i + 1]).distanceTo(worldOf(chainBones[i])) / want - 1));
		}
	}
	ok(`${file} performer take: arm chain wears the performer's bone lengths`, armLengthErr < 1e-6,
		`max relative length err ${armLengthErr.toExponential(2)}`);

	applyMotionFrame(pRig, performerTake, 1);
	const captured = captureArdyRoot(pRig);
	const rootWant = [0.5, -grownFloor, -0.25];
	const rootErr = Math.max(...captured.map((v, i) => Math.abs(v - rootWant[i])));
	ok(`${file} performer take: captureArdyRoot inverts the applied offsets`, rootErr < 1e-6,
		`root err ${rootErr.toExponential(2)} m`);

	// A straight (T-pose) arm on the performer's lengths: solveIk must restore
	// the take's translations, not bind, and then reach an in-range target
	// exactly (the straight chain takes the pole branch).
	applyMotionFrame(pRig, performerTake, 0);
	const pChain = resolveIkRig(pRig).chains.get("leftHand");
	const takeLengths = pChain.bones.slice(1).map((bone, i) => worldOf(bone).distanceTo(worldOf(pChain.bones[i])));
	const reachTarget = worldOf(pChain.bones[2]).add(new THREE.Vector3(-0.12, -0.1, 0.08));
	solveIk(pChain, reachTarget);
	const reachMiss = worldOf(pChain.bones[2]).distanceTo(reachTarget);
	const reachLengthErr = Math.max(...pChain.bones.slice(1).map((bone, i) => Math.abs(worldOf(bone).distanceTo(worldOf(pChain.bones[i])) - takeLengths[i])));
	ok(`${file} performer take: solveIk reaches its target on the take's arm lengths`, reachMiss < 1e-6 && reachLengthErr < 1e-9,
		`miss ${reachMiss.toExponential(2)} m, segment length err ${reachLengthErr.toExponential(2)} m`);
}

// A performer retargeted through the real SMPL path (smpl-cskel27), moving:
// turning, raising and bending the left arm, bending the knees. The rest
// skeleton is the SMPL fixture of test/smpl-cskel27.test.mjs.
const smplRest = [
	[0, 0, 0], [0.065, -0.091, -0.013], [-0.065, -0.091, -0.013], [0, 0.108, -0.005],
	[0.098, -0.470, -0.022], [-0.098, -0.470, -0.022], [0, 0.245, 0.008], [0.083, -0.867, -0.063],
	[-0.083, -0.867, -0.063], [0, 0.301, 0.026], [0.109, -0.923, 0.053], [-0.109, -0.923, 0.053],
	[0, 0.521, -0.004], [0.072, 0.418, -0.009], [-0.072, 0.418, -0.009], [0, 0.581, 0.026],
	[0.153, 0.440, -0.016], [-0.153, 0.440, -0.016], [0.399, 0.394, -0.040], [-0.399, 0.394, -0.040],
	[0.635, 0.398, -0.042], [-0.635, 0.398, -0.042], [0.715, 0.398, -0.042], [-0.715, 0.398, -0.042],
];
const SMPL_FRAMES = 12;
const smplMember = (data, shape) => ({ data: Float32Array.from(data.flat(Infinity)), shape });
const smplTake = smplToCskel27Motion({
	smpl_global_orient: smplMember(Array.from({ length: SMPL_FRAMES }, (_, f) => [0, 0.05 * f, 0]), [SMPL_FRAMES, 3]),
	smpl_body_pose: smplMember(Array.from({ length: SMPL_FRAMES }, (_, f) => {
		const pose = Array.from({ length: 23 }, () => [0, 0, 0]);
		pose[15] = [0, 0, -0.5 + 0.06 * f]; // left shoulder
		pose[17] = [0, -0.1 * f, 0]; // left elbow
		pose[3] = [0.05 * f, 0, 0]; // left knee
		pose[4] = [0.04 * f, 0, 0]; // right knee
		return pose;
	}), [SMPL_FRAMES, 23, 3]),
	smpl_transl: smplMember(Array.from({ length: SMPL_FRAMES }, (_, f) => [0.03 * f, 0.95, 0.02 * f]), [SMPL_FRAMES, 3]),
	smpl_rest_joints: smplMember(smplRest, [24, 3]),
	fps: { data: Float32Array.from([30]), shape: [] },
});
const smplArmFactor = smplTake.boneScale[J("LeftForeArm")];
ok("SMPL take is performer-sized", Math.abs(smplArmFactor - 1) > 0.05,
	`boneScale LeftForeArm=${smplArmFactor.toFixed(3)} LeftLeg=${smplTake.boneScale[J("LeftLeg")].toFixed(3)}`);

const ikRig = loadPrimedRig("x-bot-tpose.fbx");
const ikSnapshotBones = snapshotPlaybackBones(ikRig);
const bindTranslations = new Map([...ikRig.userData.poseBind].map(([bone, b]) => [bone, new THREE.Vector3(b.position.x, b.position.y, b.position.z)]));
applyMotionFrame(ikRig, smplTake, 0);
const ikResolved = resolveIkRig(ikRig);
const ikArm = ikResolved.chains.get("leftHand");
const segmentLengths = (chain) => chain.bones.slice(1).map((bone, i) => worldOf(bone).distanceTo(worldOf(chain.bones[i])));
const allRigBones = [];
ikRig.traverse((object) => { if (object.isBone) allRigBones.push(object); });

// The raw take, frame by frame: what the IK layer must rest on.
const rawLengths = [], rawRoots = [];
for (let f = 0; f < SMPL_FRAMES; f += 1) {
	applyMotionFrame(ikRig, smplTake, f);
	rawLengths[f] = segmentLengths(ikArm);
	rawRoots[f] = captureArdyRoot(ikRig);
}

// Author a correction at frame K the way the editor does: solve, then bake over
// the raw clip rotations.
const KEY = 6;
applyMotionFrame(ikRig, smplTake, KEY);
const rawArmQ = ikArm.bones.map((bone) => bone.quaternion.clone());
const handTarget = worldOf(ikArm.bones[2]).lerp(worldOf(ikArm.bones[0]), 0.3).add(new THREE.Vector3(0, -0.03, 0.04));
solveIk(ikArm, handTarget);
const authoredHand = worldOf(ikArm.bones[2]);
const authoredLengthErr = Math.max(...segmentLengths(ikArm).map((l, i) => Math.abs(l - rawLengths[KEY][i])));
ok("performer take: a bent-arm solve keeps the take's arm lengths", authoredLengthErr < 1e-9,
	`segment length err ${authoredLengthErr.toExponential(2)} m`);
const ikLayer = { tracked: new Set(), keys: new Map() };
ikBakeKeyframe(ikResolved.chains, ikLayer, KEY, ikResolved.fkJoints, ["leftHand"], null, new Map([["leftHand", rawArmQ]]));

// Replay the whole take with the layer 100 times: keyed frame, ease ramp and
// untouched frames alike.
const firstPass = [];
let accumulation = 0, lengthPop = 0, rootDrift = 0, keyMiss = Infinity, shear = 0;
for (let pass = 0; pass < 100; pass += 1) {
	for (let f = 0; f < SMPL_FRAMES; f += 1) {
		applyMotionFrame(ikRig, smplTake, f);
		ikEvaluate(ikResolved.chains, ikLayer, f, ikResolved.fkJoints, 6);
		ikRig.updateMatrixWorld(true);
		const state = allRigBones.flatMap((bone) => [...bone.position.toArray(), ...bone.quaternion.toArray()]);
		if (pass > 0) {
			for (let i = 0; i < state.length; i += 1) accumulation = Math.max(accumulation, Math.abs(state[i] - firstPass[f][i]));
			continue;
		}
		firstPass[f] = state;
		segmentLengths(ikArm).forEach((l, i) => { lengthPop = Math.max(lengthPop, Math.abs(l - rawLengths[f][i])); });
		captureArdyRoot(ikRig).forEach((v, i) => { rootDrift = Math.max(rootDrift, Math.abs(v - rawRoots[f][i])); });
		if (f === KEY) keyMiss = worldOf(ikArm.bones[2]).distanceTo(authoredHand);
		// Hierarchy: each arm segment stays on its Mixamo bone axis, i.e. the
		// local translation keeps the bind direction (only its length is the take's).
		for (const bone of [ikRig.getObjectByName("mixamorigLeftArm"), ...ikArm.bones.slice(1)]) {
			shear = Math.max(shear, THREE.MathUtils.radToDeg(bone.position.angleTo(bindTranslations.get(bone))));
		}
	}
}
ok("performer take + IK: keyed frame reproduces the authored hand", keyMiss < 1e-6, `miss ${keyMiss.toExponential(2)} m`);
ok("performer take + IK: no arm segment pops to its bind length on any frame", lengthPop < 1e-9,
	`max segment length change vs raw take ${lengthPop.toExponential(2)} m over ${SMPL_FRAMES} frames`);
ok("performer take + IK: the arm correction moves no root translation", rootDrift < 1e-9, `max root drift ${rootDrift.toExponential(2)} m`);
ok("performer take + IK: arm segments stay on the Mixamo hierarchy axes", shear < 1e-6, `max axis error ${shear.toExponential(2)} deg`);
ok("performer take + IK: 100 repeated playback+IK passes accumulate nothing", accumulation === 0,
	`max local transform change ${accumulation} over ${99 * SMPL_FRAMES} re-applications`);

// An FK swing on the shoulder keeps the take's girdle length.
applyMotionFrame(ikRig, smplTake, KEY);
const leftShoulder = ikResolved.fkJoints.get("leftShoulder");
const girdleLength = leftShoulder.bone.position.length();
solveSwingAngle(leftShoulder, new THREE.Vector3(0, 0, 1), 0.2, leftShoulder.bone.quaternion.clone(), leftShoulder.bone.parent.getWorldQuaternion(new THREE.Quaternion()));
const girdleErr = Math.abs(leftShoulder.bone.position.length() - girdleLength);
ok("performer take: shoulder swing keeps the take's girdle length", girdleErr < 1e-9,
	`length change ${girdleErr.toExponential(2)} rig units of ${girdleLength.toFixed(3)}`);

// Clearing the take hands IK back the rig's own bind skeleton.
restorePlaybackBones(ikRig, ikSnapshotBones);
const bindErr = Math.max(...ikArm.bindPositions.map((p, i) => p.distanceTo(bindTranslations.get(ikArm.bones[i]))),
	leftShoulder.bindPos.distanceTo(bindTranslations.get(leftShoulder.bone)));
ok("cleared take: IK rests on the rig's bind translations again", bindErr === 0, `max err ${bindErr}`);

console.log(`\nfailures: ${fail.length}`);
process.exit(fail.length ? 1 : 0);

import * as THREE from "three";
import {
	resolveIkRig,
	createIkState,
	solveIk,
	ikKeyframes,
} from "../../src/ardy/ik.js";
import {
	buildCollisionCapsules,
	detectPenetrations,
	fixCollisions,
	fixCollisionsRange,
} from "../../src/ardy/fix-collisions.js";

let failures = 0;
function check(name, cond, detail = "") {
	if (cond) console.log(`PASS ${name}`);
	else {
		failures += 1;
		console.log(`FAIL ${name}${detail ? " — " + detail : ""}`);
	}
}

/* Synthetic Mixamo-spelled rig in a T-pose: arms along ±X, legs along -Y,
 * toes forward (+Z). Rig scaled 0.01 (cm → m). Same layout as
 * test/ik/verify-ik.mjs. */
function makeRig() {
	const rig = new THREE.Object3D();
	rig.scale.setScalar(0.01);
	const mk = (name, parent, x, y, z) => {
		const b = new THREE.Bone();
		b.name = name;
		b.position.set(x, y, z);
		parent.add(b);
		return b;
	};
	const hips = mk("mixamorigHips", rig, 0, 100, 0);
	const spine = mk("mixamorigSpine", hips, 0, 15, 0);
	const chest = mk("mixamorigSpine1", spine, 0, 15, 0);
	mk("mixamorigSpine2", chest, 0, 15, 0);
	const neck = mk("mixamorigNeck", chest, 0, 30, 0);
	const head = mk("mixamorigHead", neck, 0, 15, 0);
	mk("mixamorigHeadTop_End", head, 0, 20, 0);
	const lShoulder = mk("mixamorigLeftShoulder", chest, 10, 25, 0);
	const rShoulder = mk("mixamorigRightShoulder", chest, -10, 25, 0);
	const lArm = mk("mixamorigLeftArm", lShoulder, 10, -10, 0);
	const lFore = mk("mixamorigLeftForeArm", lArm, 30, 0, 0);
	mk("mixamorigLeftHand", lFore, 30, 0, 0);
	const rArm = mk("mixamorigRightArm", rShoulder, -10, -10, 0);
	const rFore = mk("mixamorigRightForeArm", rArm, -30, 0, 0);
	mk("mixamorigRightHand", rFore, -30, 0, 0);
	const lUp = mk("mixamorigLeftUpLeg", hips, 10, 0, 0);
	const lLeg = mk("mixamorigLeftLeg", lUp, 0, -45, 0);
	const lFoot = mk("mixamorigLeftFoot", lLeg, 0, -45, 0);
	mk("mixamorigLeftToeBase", lFoot, 0, -5, 12);
	const rUp = mk("mixamorigRightUpLeg", hips, -10, 0, 0);
	const rLeg = mk("mixamorigRightLeg", rUp, 0, -45, 0);
	const rFoot = mk("mixamorigRightFoot", rLeg, 0, -45, 0);
	mk("mixamorigRightToeBase", rFoot, 0, -5, 12);
	rig.updateMatrixWorld(true);
	return rig;
}

// Plausible humanoid radii (metres). The synthetic rig has no skinned mesh
// to measure, so tests inject them explicitly.
const RADII = {
	Spine: 0.13, Head: 0.11, Neck: 0.06,
	LeftArm: 0.05, LeftForeArm: 0.045, LeftHand: 0.05,
	RightArm: 0.05, RightForeArm: 0.045, RightHand: 0.05,
	LeftUpLeg: 0.075, LeftLeg: 0.055, LeftFoot: 0.05,
	RightUpLeg: 0.075, RightLeg: 0.055, RightFoot: 0.05,
};

function penetrations(rig) {
	const capsules = buildCollisionCapsules(rig, RADII);
	return detectPenetrations(capsules, { offset: 0 });
}

/* --- build: every capsule resolves, T-pose is clean ----------------------- */
{
	const rig = makeRig();
	const capsules = buildCollisionCapsules(rig, RADII);
	check("builds all 15 body capsules", capsules && capsules.size === 15);
	check("capsule world positions respect rig scale",
		Math.abs(capsules.get("torso").a.y - 1.0) < 1e-6);
	const pens = penetrations(rig);
	check("T-pose reports no self-collision", pens.length === 0,
		`got ${pens.map((p) => `${p.a.def.id}×${p.b.def.id}@${p.depth.toFixed(3)}`).join(", ")}`);
}

/* --- detect: a wrist dragged into the chest is caught --------------------- */
{
	const rig = makeRig();
	const { chains } = resolveIkRig(rig);
	solveIk(chains.get("leftHand"), new THREE.Vector3(0.05, 1.45, 0));
	const pens = penetrations(rig);
	check("forearm-through-chest is detected", pens.length > 0,
		"no penetration found");
	check("detection names the arm and the torso",
		pens.some((p) => /left(ForeArm|Hand|UpperArm)/.test(p.a.def.id + p.b.def.id)
			&& /torso|chest/.test(p.a.def.id + p.b.def.id)),
		pens.map((p) => `${p.a.def.id}×${p.b.def.id}`).join(", "));
}

/* --- fix: the forearm comes back out of the chest ------------------------- */
{
	const rig = makeRig();
	const { chains, fkJoints } = resolveIkRig(rig);
	const ik = createIkState();
	ik.chains = chains;
	solveIk(chains.get("leftHand"), new THREE.Vector3(0.05, 1.45, 0));
	const before = penetrations(rig).length;
	const result = fixCollisions(rig, chains, { radii: RADII, ikState: ik });
	check("fixer changed the pose", result.changed && before > 0);
	check("no penetration remains after fixing", penetrations(rig).length === 0,
		`residual=${result.residual.toFixed(4)}`);
	check("touched chain is tracked for keying", ik.tracked.has("leftHand"));
	check("segment lengths survive the fix", (() => {
		const c = chains.get("leftHand");
		const p0 = c.bones[0].getWorldPosition(new THREE.Vector3());
		const p1 = c.bones[1].getWorldPosition(new THREE.Vector3());
		const p2 = c.bones[2].getWorldPosition(new THREE.Vector3());
		return Math.abs(p0.distanceTo(p1) - 0.3) < 1e-6 && Math.abs(p1.distanceTo(p2) - 0.3) < 1e-6;
	})());
	void fkJoints;
}

/* --- filter: onlyChains leaves everything else alone ---------------------- */
{
	const rig = makeRig();
	const { chains } = resolveIkRig(rig);
	solveIk(chains.get("leftHand"), new THREE.Vector3(0.05, 1.45, 0));
	const result = fixCollisions(rig, chains, { radii: RADII, onlyChains: new Set(["rightFoot"]) });
	check("onlyChains blocks fixes on unlisted chains", !result.changed);
	check("the penetrating pose is untouched when blocked", penetrations(rig).length > 0);
}

/* --- range: only frames that needed a fix get a key ----------------------- */
{
	const rig = makeRig();
	const { chains, fkJoints } = resolveIkRig(rig);
	const ik = createIkState();
	ik.chains = chains;
	const cleanWrist = new THREE.Vector3(0.8, 1.45, 0);
	const stuckWrist = new THREE.Vector3(0.05, 1.45, 0);
	const applyFrame = (frame) => {
		solveIk(chains.get("leftHand"), frame === 2 ? stuckWrist : cleanWrist);
	};
	const keyed = fixCollisionsRange({
		rig, chains, ikState: ik, fkJoints,
		startFrame: 0, endFrame: 4, applyFrame,
		radii: RADII,
	});
	check("only the penetrating frame is keyed",
		keyed.length === 1 && keyed[0] === 2, `keyed=${keyed.join(",")}`);
	check("the key landed in the IK layer", ikKeyframes(ik).includes(2));
	check("clean frames stay keyless", !ikKeyframes(ik).includes(0) && !ikKeyframes(ik).includes(4));
	check("the range fix left the last frame clean", penetrations(rig).length === 0);
}

console.log(failures ? `\n${failures} FAIL` : "\nall pass");
process.exit(failures ? 1 : 0);

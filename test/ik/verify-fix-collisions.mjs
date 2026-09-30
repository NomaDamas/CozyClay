import * as THREE from "three";
import {
	resolveIkRig,
	createIkState,
	solveIk,
	ikEvaluate,
	ikKeyframes,
	bindWorldPosition,
	restWorldPosition,
	solveMidJoint,
} from "../../src/ardy/ik.js";
import { primeBindPose, applyPose, POSE_BONES, DEFAULT_POSE } from "../../src/poses.js";
import {
	buildCollisionCapsules,
	restPairOverlaps,
	detectPenetrations,
	fixCollisions,
	fixCollisionsRange,
	supportsCollisionCleanup,
	isHingeFold,
	PAIR_TOLERANCE,
	PUSH_FLOOR_CLEARANCE,
	HOME_BIAS,
	MIN_ALIGN,
	DEFAULT_SLACK_FACTOR,
	FINGER_RADIUS,
	TRIM_FRACTION,
	HINGE_SLACK_FACTOR,
	YIELD_STEP_RAD,
	YIELD_TOTAL_RAD,
	MIN_DEPTH,
	blockerInsideCount,
} from "../../src/ardy/fix-collisions.js";

/** app-stage.jsx's REST_BONES: every joint at zero, i.e. the bind pose. */
const REST_ZERO = Object.fromEntries(POSE_BONES.map((bone) => [bone.id, [0, 0, 0]]));

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
 * test/ik/verify-ik.mjs.
 *
 * `withFingers` adds the middle-finger base bones. Real Mixamo exports have
 * them, cheaper game rigs do not, and the hand capsule has to work either
 * way — so the fixture builds both. */
function makeRig(withFingers = false) {
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
	const lHand = mk("mixamorigLeftHand", lFore, 30, 0, 0);
	const rArm = mk("mixamorigRightArm", rShoulder, -10, -10, 0);
	const rFore = mk("mixamorigRightForeArm", rArm, -30, 0, 0);
	const rHand = mk("mixamorigRightHand", rFore, -30, 0, 0);
	if (withFingers) {
		mk("mixamorigLeftHandMiddle1", lHand, 9, 0, 0);
		mk("mixamorigRightHandMiddle1", rHand, -9, 0, 0);
	}
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

/**
 * A REAL Mixamo hand: mixamorig{Side}Hand{Thumb,Index,Middle,Ring,Pinky}1..4 on
 * top of whatever makeRig already built. Each finger runs 9 cm out from the
 * knuckle in three 3 cm phalanges, so the tip sits 18 cm past the wrist — the
 * palm's length again, which is exactly why a wrist-only proxy cannot judge a
 * hand pressed into anything.
 */
function addFingers(rig) {
	const SPREAD = { Thumb: -3, Index: -1.5, Middle: 0, Ring: 1.5, Pinky: 3 };
	for (const side of ["Left", "Right"]) {
		const sign = side === "Left" ? 1 : -1;
		const hand = rig.getObjectByName(`mixamorig${side}Hand`);
		for (const finger of ["Thumb", "Index", "Middle", "Ring", "Pinky"]) {
			let parent = rig.getObjectByName(`mixamorig${side}Hand${finger}1`);
			if (!parent) {
				parent = new THREE.Bone();
				parent.name = `mixamorig${side}Hand${finger}1`;
				parent.position.set(9 * sign, 0, SPREAD[finger]);
				hand.add(parent);
			}
			for (let joint = 2; joint <= 4; joint += 1) {
				const bone = new THREE.Bone();
				bone.name = `mixamorig${side}Hand${finger}${joint}`;
				bone.position.set(3 * sign, 0, 0);
				parent.add(bone);
				parent = bone;
			}
		}
	}
	rig.updateMatrixWorld(true);
	return rig;
}

/** makeRig with a full set of fingers on both hands. */
function makeHandRig() {
	return addFingers(makeRig(true));
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

/** "a×b" with the ids sorted, so a pair reads the same whichever side of the
 * detection loop it came from. */
function pairIds(pen) {
	return [pen.a.def.id, pen.b.def.id].sort().join("×");
}

/** Every bone's local pose, for the "a clean read changes NOTHING" invariant —
 * positions as well as rotations, since a stray bind normalisation shows up
 * only in the positions. */
function layerSnapshot(rig) {
	const entries = [];
	rig.traverse((node) => {
		if (node.isBone) entries.push([node, node.position.clone(), node.quaternion.clone()]);
	});
	return entries;
}
function poseDrift(rig, snapshot) {
	let worst = 0;
	for (const [bone, position, quaternion] of snapshot) {
		worst = Math.max(worst, bone.position.distanceTo(position), bone.quaternion.angleTo(quaternion));
	}
	return worst;
}
function identicalPose(rig, snapshot) {
	return poseDrift(rig, snapshot) === 0;
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

/* --- offset: the skin gap is part of the TEST, not just the push ---------- */
/* A pose parked just clear of the thigh at offset 0 must read as penetrating
 * once a gap is demanded, and an already-reported pair's depth must grow by
 * exactly the offset. Before the fix, offset only scaled the push, so the
 * fixer opened a gap detection never asked for and immediately forgot. */
{
	const rig = makeRig();
	const { chains } = resolveIkRig(rig);
	solveIk(chains.get("leftHand"), new THREE.Vector3(0.22, 0.85, 0));
	const capsules = buildCollisionCapsules(rig, RADII);
	check("a grazing pose is clean with no offset",
		detectPenetrations(capsules, { offset: 0 }).length === 0);
	check("the same pose penetrates once a skin gap is demanded",
		detectPenetrations(capsules, { offset: 0.03 }).length > 0);

	const deeper = makeRig();
	const { chains: chains2 } = resolveIkRig(deeper);
	solveIk(chains2.get("leftHand"), new THREE.Vector3(0.2, 0.85, 0));
	const caps2 = buildCollisionCapsules(deeper, RADII);
	const bare = detectPenetrations(caps2, { offset: 0 })[0];
	const gapped = detectPenetrations(caps2, { offset: 0.01 })[0];
	check("offset adds itself to the reported depth",
		bare && gapped && Math.abs((gapped.depth - bare.depth) - 0.01) < 1e-9,
		`delta=${gapped && bare ? (gapped.depth - bare.depth).toFixed(6) : "n/a"}`);
}

/* --- slackFactor: the default is strict, and callers may override --------- */
/* 0.005 m past the allowance at the 0.4 default; invisible at the old 0.6,
 * which is exactly the "hand clearly inside the thigh, tool says clean"
 * complaint. */
{
	const rig = makeRig();
	const { chains } = resolveIkRig(rig);
	solveIk(chains.get("leftHand"), new THREE.Vector3(0.2, 0.85, 0));
	const capsules = buildCollisionCapsules(rig, RADII);
	check("the default slack catches a shallow hand-in-thigh",
		detectPenetrations(capsules, { offset: 0 }).some((p) => /leftHand/.test(p.a.def.id + p.b.def.id)));
	check("a looser slackFactor lets the same pose through",
		detectPenetrations(capsules, { offset: 0, slackFactor: 0.6 }).length === 0);

	const loose = makeRig();
	const { chains: chains2 } = resolveIkRig(loose);
	solveIk(chains2.get("leftHand"), new THREE.Vector3(0.2, 0.85, 0));
	check("fixCollisions forwards slackFactor to detection",
		fixCollisions(loose, chains2, { radii: RADII, offset: 0, slackFactor: 0.6 }).changed === false);

	const strict = makeRig();
	const { chains: chains3 } = resolveIkRig(strict);
	solveIk(chains3.get("leftHand"), new THREE.Vector3(0.2, 0.85, 0));
	check("the default slackFactor fixes what 0.6 ignored",
		fixCollisions(strict, chains3, { radii: RADII, offset: 0 }).changed === true);
}

/* --- hand capsule: fingers when the rig has them, wrist sphere when not --- */
{
	const bare = buildCollisionCapsules(makeRig(false), RADII);
	const fingered = buildCollisionCapsules(makeRig(true), RADII);
	check("a fingerless rig still builds every capsule",
		bare && bare.size === 15, "optional end must not disqualify the rig");
	check("the fingerless hand degrades to a wrist sphere",
		bare.get("leftHand").a.distanceTo(bare.get("leftHand").b) < 1e-9);
	check("the hand capsule reaches the middle finger when present",
		Math.abs(fingered.get("leftHand").a.distanceTo(fingered.get("leftHand").b) - 0.09) < 1e-6,
		`span=${fingered.get("leftHand").a.distanceTo(fingered.get("leftHand").b).toFixed(4)}`);
	check("both spellings of the rig are supported",
		supportsCollisionCleanup(makeRig(false)) && supportsCollisionCleanup(makeRig(true)));
}

/* --- and the fingers CHANGE the verdict: fingertip through the thigh ------ */
/* Wrist parked clear of the thigh, fingers sunk into it. Judged at the wrist
 * this pose is clean — the exact miss the optional end exists to close. */
{
	const target = new THREE.Vector3(0.18, 0.95, -0.1);
	const wristOnly = makeRig(false);
	solveIk(resolveIkRig(wristOnly).chains.get("leftHand"), target);
	const fingered = makeRig(true);
	solveIk(resolveIkRig(fingered).chains.get("leftHand"), target);
	check("the wrist sphere misses a fingertip in the thigh",
		detectPenetrations(buildCollisionCapsules(wristOnly, RADII), { offset: 0 }).length === 0);
	check("the finger-extended hand catches it",
		detectPenetrations(buildCollisionCapsules(fingered, RADII), { offset: 0 })
			.some((p) => /leftHand/.test(p.a.def.id + p.b.def.id) && /leftThigh/.test(p.a.def.id + p.b.def.id)));
}

/* --- per-pass exit: a pass that pushes nothing ends the loop -------------- */
/* Pass 0 pulls the left arm out of the chest; pass 1 still sees a right-hand
 * penetration but has no rightHand chain to push with, so it must stop. A
 * CUMULATIVE `changed` flag stays true from pass 0 and spins the loop out to
 * maxIterations re-solving a pose that cannot move. */
{
	const rig = makeRig();
	const { chains } = resolveIkRig(rig);
	solveIk(chains.get("leftHand"), new THREE.Vector3(0.05, 1.45, 0));
	solveIk(chains.get("rightHand"), new THREE.Vector3(-0.2, 0.85, 0));
	const onlyLeft = new Map([["leftHand", chains.get("leftHand")]]);
	const result = fixCollisions(rig, onlyLeft, { radii: RADII, offset: 0, maxIterations: 8 });
	check("the fixable half still gets fixed", result.changed);
	check("a fruitless pass ends the loop instead of burning iterations",
		result.passes < 8, `passes=${result.passes}`);
	check("only the unpushable penetration is left",
		penetrations(rig).every((p) => /right/.test(p.a.def.id + p.b.def.id)),
		penetrations(rig).map((p) => `${p.a.def.id}×${p.b.def.id}`).join(", "));
}

/* --- unsupported rig: "cannot run" is not "found nothing" ----------------- */
{
	const rig = makeRig();
	rig.getObjectByName("mixamorigLeftToeBase").removeFromParent();
	rig.updateMatrixWorld(true);
	check("a rig missing a required bone is reported unsupported",
		supportsCollisionCleanup(rig) === false);
	check("capsules cannot be built for it", buildCollisionCapsules(rig, RADII) === null);
	const result = fixCollisions(rig, new Map(), { radii: RADII });
	check("fixCollisions says supported:false, not a clean pose",
		result.supported === false && result.changed === false,
		JSON.stringify(result));
	check("a supported rig reports supported:true",
		fixCollisions(makeRig(), resolveIkRig(makeRig()).chains, { radii: RADII }).supported === true);
	check("the range walker bails on an unsupported rig", fixCollisionsRange({
		rig, chains: new Map(), ikState: createIkState(), startFrame: 0, endFrame: 9,
		applyFrame: () => {}, radii: RADII,
	}).length === 0);
}

/* --- REGRESSION (R5): onlyChains binds the WRITE, not just the query ------- */
/* The filter was applied to the detection list only, so a movable×movable pair
 * with one side listed split the push and moved the unlisted limb anyway
 * (3 cm on the probe). The existing filter test above only covers
 * movable×static, where the static side cannot move by construction. */
{
	const rig = makeRig();
	const { chains } = resolveIkRig(rig);
	// Hand sunk into the SAME-SIDE thigh: leftHand (chain leftHand) against
	// leftThigh (chain leftFoot) — two movable capsules.
	solveIk(chains.get("leftHand"), new THREE.Vector3(0.2, 0.85, 0));
	const pair = detectPenetrations(buildCollisionCapsules(rig, RADII), { offset: 0 })
		.find((p) => /leftHand|leftForeArm/.test(p.a.def.id) && /leftThigh|leftShin/.test(p.b.def.id));
	check("the fixture really is a movable×movable pair",
		Boolean(pair && pair.a.def.movable && pair.b.def.movable),
		pair ? `${pair.a.def.id}×${pair.b.def.id}` : "no movable pair found");

	const leg = chains.get("leftFoot");
	const hand = chains.get("leftHand");
	const kneeBefore = leg.bones[1].getWorldPosition(new THREE.Vector3());
	const ankleBefore = leg.bones[2].getWorldPosition(new THREE.Vector3());
	const wristBefore = hand.bones[2].getWorldPosition(new THREE.Vector3());
	const result = fixCollisions(rig, chains, { radii: RADII, offset: 0, onlyChains: new Set(["leftHand"]) });
	const kneeMoved = leg.bones[1].getWorldPosition(new THREE.Vector3()).distanceTo(kneeBefore);
	const ankleMoved = leg.bones[2].getWorldPosition(new THREE.Vector3()).distanceTo(ankleBefore);
	check("the permitted side still gets fixed",
		result.changed && hand.bones[2].getWorldPosition(new THREE.Vector3()).distanceTo(wristBefore) > 1e-4);
	check("onlyChains leaves the unlisted MOVABLE limb exactly where it was",
		kneeMoved < 1e-9 && ankleMoved < 1e-9, `knee=${kneeMoved.toFixed(5)} ankle=${ankleMoved.toFixed(5)}`);
	check("the run reports only the chain it actually drove",
		result.touched.join(",") === "leftHand", `touched=${result.touched.join(",")}`);
	check("the permitted side owed the WHOLE separation (nothing left over)",
		detectPenetrations(buildCollisionCapsules(rig, RADII), { offset: 0 }).length === 0,
		`residual=${result.residual.toFixed(5)}`);
}

/* --- the push respects the floor (R12) ------------------------------------ */
/* A separation normal knows nothing about the ground, so an otherwise correct
 * push can drive an ankle or a knee underground. With the floor raised above
 * the whole pose every push target is below it, which makes the clamp the only
 * thing that can be doing the work. */
{
	const rig = makeRig();
	const { chains } = resolveIkRig(rig);
	solveIk(chains.get("leftHand"), new THREE.Vector3(0.2, 0.85, 0));
	fixCollisions(rig, chains, { radii: RADII, offset: 0, floorY: 0.9, onlyChains: new Set(["leftHand"]) });
	const wristY = chains.get("leftHand").bones[2].getWorldPosition(new THREE.Vector3()).y;
	check("a pushed joint is never driven below the floor clearance",
		wristY >= 0.9 + PUSH_FLOOR_CLEARANCE - 1e-6, `wristY=${wristY.toFixed(4)}`);
}

/* --- detect and solve on the SAME skeleton (clip translations) ------------- */
/* Positional playback can change limb lengths. Both detection and the solver
 * now use the clip's skeleton, so no bind reset or length compensation belongs
 * in the baked correction, even on a chain the pass actually fixes. */
{
	const wobble = (rig, factor) => {
		for (const name of ["mixamorigLeftLeg", "mixamorigLeftFoot", "mixamorigLeftForeArm", "mixamorigLeftHand"]) {
			rig.getObjectByName(name).position.multiplyScalar(factor);
		}
		rig.updateMatrixWorld(true);
	};

	// A clean pose keeps its own translations — the tool must not silently
	// rewrite a skeleton it had nothing to fix on.
	const clean = makeRig();
	const cleanChains = resolveIkRig(clean).chains;
	wobble(clean, 1.04);
	const shinBefore = clean.getObjectByName("mixamorigLeftFoot").position.clone();
	const cleanResult = fixCollisions(clean, cleanChains, { radii: RADII });
	check("a no-op fix hands back the clip's own bone translations",
		cleanResult.changed === false
			&& clean.getObjectByName("mixamorigLeftFoot").position.distanceTo(shinBefore) < 1e-12,
		`drift=${clean.getObjectByName("mixamorigLeftFoot").position.distanceTo(shinBefore)}`);

	/**
	 * THE property: the delta a key stores must be the PUSH — no share of the
	 * clip's own bone lengths riding along in it. The defect this pins was a key
	 * whose rotations mostly said "reach a clip-length limb's wrist with a
	 * bind-length one": components that cancel only at full weight, so a
	 * partially weighted blend of a 15 mm correction wandered 31 mm.
	 *
	 * It used to be pinned by demanding the SAME baked angles on three different
	 * skeleton stretches, which held only because detection ran on the bind
	 * skeleton for all three — the very mismatch between what the solver judges
	 * and what the readout shows that QA measured as pairs appearing on a pose
	 * the user is told is clean. Detection now reads the caller's own pose, so a
	 * 6 % longer arm IS deeper in the chest and honestly earns a slightly bigger
	 * correction (46.02° → 47.96°); identical angles would now mean the solver
	 * was ignoring the pose again.
	 *
	 * So the property is measured where it bites instead, and scale-free: apply
	 * the key's own delta at partial weight — exactly as ikEvaluate does, on the
	 * CLIP's translations — and no partial weight may move the wrist further than
	 * the whole key does. A delta carrying length compensation fails this
	 * outright, because that is what "cancels only at full weight" means.
	 */
	const bakedDelta = (stretch) => {
		const seed = makeRig();
		solveIk(resolveIkRig(seed).chains.get("leftHand"), new THREE.Vector3(0.05, 1.45, 0));
		const rotations = resolveIkRig(seed).chains.get("leftHand").bones.map((b) => b.quaternion.clone());
		const rig = makeRig();
		const { chains } = resolveIkRig(rig);
		const chain = chains.get("leftHand");
		chain.bones.forEach((bone, index) => {
			bone.quaternion.copy(rotations[index]);
			bone.position.copy(chain.bindPositions[index]).multiplyScalar(stretch);
		});
		rig.updateMatrixWorld(true);
		const clipPos = chain.bones.map((b) => b.position.clone());
		const clipRot = chain.bones.map((b) => b.quaternion.clone());
		const clipWrist = chain.bones[2].getWorldPosition(new THREE.Vector3());
		const result = fixCollisions(rig, chains, { radii: RADII });
		const keepsTranslations = chain.bones.every((bone, i) => bone.position.equals(clipPos[i]));
		const base = result.baseQuats.get("leftHand");
		const keyed = chain.bones.map((b) => b.quaternion.clone());
		const full = chain.bones[2].getWorldPosition(new THREE.Vector3()).distanceTo(clipWrist);
		const partial = [0.2, 0.4, 0.6, 0.8].map((w) => {
			chain.bones.forEach((bone, index) => {
				bone.position.copy(clipPos[index]);
				bone.quaternion.copy(clipRot[index]);
				const delta = base[index].clone().invert().multiply(keyed[index]);
				delta.slerp(new THREE.Quaternion(), 1 - w);
				bone.quaternion.multiply(delta);
			});
			rig.updateMatrixWorld(true);
			return chain.bones[2].getWorldPosition(new THREE.Vector3()).distanceTo(clipWrist);
		});
		return {
			changed: result.changed,
			keepsTranslations,
			angles: chain.bones.map((b, i) => base[i].angleTo(keyed[i])),
			full,
			partial,
		};
	};
	const atBind = bakedDelta(1);
	const stretched = [1.03, 1.06].map(bakedDelta);
	check("the wobbled skeletons still get fixed",
		atBind.changed && stretched.every((d) => d.changed));
	check("even a corrected chain keeps its clip translations",
		[atBind, ...stretched].every((d) => d.keepsTranslations));
	check("no partial weight of the baked delta outruns the whole correction",
		[atBind, ...stretched].every((d) => d.partial.every((drift) => drift < d.full)
			&& d.partial.every((drift, i) => i === 0 || drift > d.partial[i - 1])),
		[atBind, ...stretched].map((d) => `${(d.full * 1000).toFixed(0)}mm:${d.partial.map((x) => (x * 1000).toFixed(0)).join("/")}`).join(" "));
	check("and a wobbled clip earns a correction of the same shape as a bind one",
		stretched.every((d) => d.angles.every((angle, i) => Math.abs(angle - atBind.angles[i]) < (3 * Math.PI) / 180)),
		`bind=${atBind.angles.map((a) => ((a * 180) / Math.PI).toFixed(3)).join("/")} `
		+ stretched.map((d) => d.angles.map((a) => ((a * 180) / Math.PI).toFixed(3)).join("/")).join(" "));

	// End to end: a clip whose bone translations wobble (positional playback)
	// with ONE penetrating frame. The frames easing out of the key must stay
	// near the clip, which is the whole point of a delta-valued blend.
	const BLEND = 6;
	const angleAt = (frame) => -Math.PI / 2 + (Math.PI / 3) * Math.abs(Math.sin((Math.PI * (frame - 2)) / 16));
	const makeWobblyTake = () => {
		const rig = makeRig();
		const resolved = resolveIkRig(rig);
		const arm = resolved.chains.get("leftHand");
		// Positional playback rewrites EVERY bone every frame, legs included.
		// A fixture that poses only the arm leaves one frame's correction ramp
		// sitting on the leg when the next frame is detected — an accumulation
		// the clip itself would have overwritten.
		const legs = ["leftFoot", "rightFoot"].map((id) => resolved.chains.get(id));
		const poseClip = (frame) => {
			for (const leg of legs) {
				leg.bones.forEach((bone, index) => {
					bone.position.copy(leg.bindPositions[index]);
					bone.quaternion.identity();
				});
			}
			const factor = 1 + 0.02 * Math.sin(frame * 0.9);
			arm.bones.forEach((bone, index) => {
				bone.position.copy(arm.bindPositions[index]).multiplyScalar(factor);
				bone.quaternion.identity();
			});
			arm.bones[0].quaternion.setFromAxisAngle(new THREE.Vector3(0, 0, 1), angleAt(frame));
			rig.updateMatrixWorld(true);
		};
		return { rig, chains: resolved.chains, fkJoints: resolved.fkJoints, arm, poseClip };
	};
	const reference = makeWobblyTake();
	const rawWristAt = (frame) => {
		reference.poseClip(frame);
		return reference.arm.bones[2].getWorldPosition(new THREE.Vector3());
	};

	const take = makeWobblyTake();
	const ik = createIkState();
	ik.chains = take.chains;
	const applyFrame = (frame) => {
		take.poseClip(frame);
		ikEvaluate(take.chains, ik, frame, take.fkJoints, BLEND);
	};
	const wobblyKeys = fixCollisionsRange({
		rig: take.rig, chains: take.chains, ikState: ik, fkJoints: take.fkJoints,
		startFrame: 0, endFrame: 20, applyFrame, radii: RADII,
	});
	check("the wobbly clip still keys only the frames that penetrate",
		wobblyKeys.length > 0 && wobblyKeys.every((f) => f === 2 || f === 18),
		`keyed=${wobblyKeys.join(",")}`);
	let worstNeighbour = 0;
	let worstKeyed = 0;
	for (let frame = 0; frame <= 20; frame += 1) {
		const raw = rawWristAt(frame);
		applyFrame(frame);
		const drift = take.arm.bones[2].getWorldPosition(new THREE.Vector3()).distanceTo(raw);
		if (wobblyKeys.includes(frame)) worstKeyed = Math.max(worstKeyed, drift);
		else worstNeighbour = Math.max(worstNeighbour, drift);
	}
	// The bound is the FIX'S OWN SIZE, not a millimetre count: the blend window
	// carries a fraction of the correction, so no unkeyed frame can move further
	// than the keyed one it is easing out of. (The absolute 1 cm this check used
	// to carry was the same statement at the old 0.4 slack, where the correction
	// itself was 12 mm; the 0.25 default pushes 22 mm and a fixed millimetre
	// bound would have to be re-tuned on every allowance change. The defect it
	// guards — a key storing length compensation instead of the push — drifted
	// unkeyed neighbours by THREE TIMES the correction.)
	check("an unkeyed neighbour of a fix on a wobbly clip never moves further than the fix itself",
		worstNeighbour > 0 && worstNeighbour < worstKeyed,
		`worst=${(worstNeighbour * 1000).toFixed(1)}mm key=${(worstKeyed * 1000).toFixed(1)}mm`);
}

/* --- REGRESSION (G1): the bind pose is the zero point, not zero ------------ */
/* Capsules are a coarse proxy, and on a real rig the REST pose reports 9.2 mm
 * of torso × upper-arm "penetration". One press of the button on a brand-new
 * project baked a phantom key and claimed a fix. The fixture below reproduces
 * that geometry: the arm hangs 15 cm in front of the torso axis in its BIND
 * pose, which is 16 mm past the slack allowance for that pair. */
{
	const makeBindOverlapRig = () => {
		const rig = makeRig();
		// Fold the left arm down in FRONT of the chest: forearm axis 15 cm from
		// the torso axis (0.13 + 0.045 + 0.002 offset − 0.15 = 27 mm of overlap
		// against the 11 mm allowance the 0.25 default slack gives that pair =
		// 16 mm of reported depth; it read 9 mm under the old, blunter 0.4).
		rig.getObjectByName("mixamorigLeftShoulder").position.set(0, 25, 15);
		rig.getObjectByName("mixamorigLeftArm").position.set(0, -10, 0);
		rig.getObjectByName("mixamorigLeftArm").quaternion
			.setFromAxisAngle(new THREE.Vector3(0, 0, 1), -Math.PI / 2);
		rig.updateMatrixWorld(true);
		primeBindPose(rig); // this pose IS the character's bind pose
		return rig;
	};

	const rig = makeBindOverlapRig();
	const capsules = buildCollisionCapsules(rig, RADII);
	const uncalibrated = detectPenetrations(capsules, { pairAllowances: null });
	check("the fixture's rest pose DOES trip the uncalibrated rule",
		uncalibrated.some((p) => pairIds(p) === "leftForeArm×torso") ,
		uncalibrated.map(pairIds).join(", ") || "none");
	check("the reported phantom depth is the one the default slack leaves standing",
		Math.abs(uncalibrated.find((p) => pairIds(p) === "leftForeArm×torso").depth - 0.01575) < 5e-4,
		`depth=${uncalibrated.find((p) => pairIds(p) === "leftForeArm×torso")?.depth.toFixed(5)}`);
	check("the bind overlap is measured for exactly that pair",
		restPairOverlaps(rig, RADII).get("leftForeArm|torso") > 0.02,
		[...restPairOverlaps(rig, RADII).entries()].map(([k, v]) => `${k}@${v.toFixed(4)}`).join(", "));
	check("the rest pose reads clean once the pair is calibrated against bind",
		detectPenetrations(capsules).length === 0,
		detectPenetrations(capsules).map(pairIds).join(", "));
	check("fixCollisions writes nothing at rest", (() => {
		const restRig = makeBindOverlapRig();
		return fixCollisions(restRig, resolveIkRig(restRig).chains, { radii: RADII }).changed === false;
	})());

	// ... and the same pair still fires when the arm is genuinely driven in.
	const deep = makeBindOverlapRig();
	deep.getObjectByName("mixamorigLeftShoulder").position.set(0, 25, 5); // 5 cm from the axis
	deep.updateMatrixWorld(true);
	const hits = detectPenetrations(buildCollisionCapsules(deep, RADII));
	check("a genuine deep hit on a calibrated pair is still caught",
		hits.some((p) => pairIds(p) === "leftForeArm×torso"),
		hits.map(pairIds).join(", ") || "none");
	check("the calibration shifts the zero point, it does not disable the pair",
		hits.find((p) => pairIds(p) === "leftForeArm×torso").depth > 0.09,
		`depth=${hits.find((p) => pairIds(p) === "leftForeArm×torso")?.depth.toFixed(4)}`);
	check("the tolerance is a few millimetres, not a licence", PAIR_TOLERANCE > 0 && PAIR_TOLERANCE <= 0.01);
	check("a rig with no bind snapshot gets no calibration at all",
		restPairOverlaps(makeRig(), RADII) === null);
}

/* --- REGRESSION (R3 + G2): a sparse fix stays sparse ----------------------- */
/* An arm swing that only penetrates at frames 2 and 18. TWO defects met here:
 *   R3 — ikEvaluate gave weight 1 to every frame between a track's first and
 *        last key, so those two keys replaced the whole swing (the wrist landed
 *        60 cm off the generated pose at the midpoint).
 *   G2 — fixCollisionsRange detected against its own evolving output, so the
 *        blend ramps it had just written produced fresh penetrations, which it
 *        then keyed: 4 of 11 keys on the QA clip were on source-CLEAN frames.
 */
{
	const BLEND = 6; // App's IK_CORRECTION_BLEND_FRAMES
	// The upper arm swings from hanging (−90°, wrist beside the thigh) up to
	// −30° and back. |sin| makes frames 2 and 18 the only ones at the bottom.
	const angleAt = (frame) => -Math.PI / 2 + (Math.PI / 3) * Math.abs(Math.sin((Math.PI * (frame - 2)) / 16));
	const makeTake = () => {
		const rig = makeRig();
		const resolved = resolveIkRig(rig);
		const arm = rig.getObjectByName("mixamorigLeftArm");
		const fore = rig.getObjectByName("mixamorigLeftForeArm");
		const hand = rig.getObjectByName("mixamorigLeftHand");
		// The clip writes local rotations AND translations every frame, exactly
		// as ARDY positional playback does — the LEGS as well as the arm, or a
		// correction keyed on the leg at one frame is still on the bone when the
		// next frame is detected.
		const legs = ["leftFoot", "rightFoot"].map((id) => resolved.chains.get(id));
		const poseClip = (frame) => {
			for (const leg of legs) {
				leg.bones.forEach((bone, index) => {
					bone.position.copy(leg.bindPositions[index]);
					bone.quaternion.identity();
				});
			}
			arm.position.set(10, -10, 0);
			fore.position.set(30, 0, 0);
			hand.position.set(30, 0, 0);
			fore.quaternion.identity();
			hand.quaternion.identity();
			arm.quaternion.setFromAxisAngle(new THREE.Vector3(0, 0, 1), angleAt(frame));
			rig.updateMatrixWorld(true);
		};
		return { rig, chains: resolved.chains, fkJoints: resolved.fkJoints, poseClip };
	};

	// The raw clip, with no key layer at all — the reference every unkeyed
	// frame must still reproduce.
	const reference = makeTake();
	const rawAt = (frame) => {
		reference.poseClip(frame);
		return reference.chains.get("leftHand").bones.map((b) => b.getWorldPosition(new THREE.Vector3()));
	};
	const sourceDirty = [];
	for (let frame = 0; frame <= 20; frame += 1) {
		reference.poseClip(frame);
		if (detectPenetrations(buildCollisionCapsules(reference.rig, RADII)).length) sourceDirty.push(frame);
	}
	check("the source clip penetrates at exactly frames 2 and 18",
		sourceDirty.join(",") === "2,18", `dirty=${sourceDirty.join(",")}`);

	const take = makeTake();
	const ik = createIkState();
	ik.chains = take.chains;
	// The user already dragged the right arm at some point in this session, so
	// it is TRACKED. A bake that writes "everything tracked" would re-key it on
	// every frame this pass touches (R4).
	ik.tracked.add("rightHand");
	const applyFrame = (frame) => {
		take.poseClip(frame);
		ikEvaluate(take.chains, ik, frame, take.fkJoints, BLEND);
	};
	const keyed = fixCollisionsRange({
		rig: take.rig, chains: take.chains, ikState: ik, fkJoints: take.fkJoints,
		startFrame: 0, endFrame: 20, applyFrame, radii: RADII,
	});
	check("the range pass keys only the frames the SOURCE clip needed",
		keyed.join(",") === "2,18", `keyed=${keyed.join(",")}`);
	check("a key names only the chains that frame actually drove",
		keyed.every((frame) => [...ik.keys.get(frame).keys()].sort().join(",") === "leftFoot,leftHand"),
		keyed.map((f) => `${f}:${[...ik.keys.get(f).keys()].join("+")}`).join(" "));
	check("a tracked-but-untouched limb is never re-keyed by the pass",
		keyed.every((frame) => !ik.keys.get(frame).has("rightHand")),
		keyed.map((f) => `${f}:${[...ik.keys.get(f).keys()].join("+")}`).join(" "));

	// The mid-gap frame is 9 frames from one key and 7 from the other: outside
	// both islands' blend windows, so the clip owns it outright.
	const raw11 = rawAt(11);
	applyFrame(11);
	const drift11 = take.chains.get("leftHand").bones
		.map((bone, index) => bone.getWorldPosition(new THREE.Vector3()).distanceTo(raw11[index]));
	check("an unkeyed mid-gap frame reproduces the raw clip within 1 mm",
		drift11.every((d) => d < 0.001), drift11.map((d) => d.toFixed(4)).join(" "));

	// Frames that ARE inside a window still ease, so the test is not vacuous.
	const raw4 = rawAt(4);
	applyFrame(4);
	const drift4 = take.chains.get("leftHand").bones[2].getWorldPosition(new THREE.Vector3()).distanceTo(raw4[2]);
	check("a frame inside the blend window still carries the correction", drift4 > 1e-6, `drift=${drift4}`);

	const before = ikKeyframes(ik).join(",");
	const again = fixCollisionsRange({
		rig: take.rig, chains: take.chains, ikState: ik, fkJoints: take.fkJoints,
		startFrame: 0, endFrame: 20, applyFrame, radii: RADII,
	});
	check("a second pass over the fixed clip keys nothing new",
		again.length === 0 && ikKeyframes(ik).join(",") === before,
		`again=${again.join(",")} keys=${ikKeyframes(ik).join(",")}`);
}

/* --- REGRESSION (G2): every frame is judged against the CLIP --------------- */
/* With fixes close enough together to share a blend window, the difference is
 * unmissable: `applyFrame` evaluates the keys this pass already wrote, so
 * frame 6 used to be detected and solved on top of frame 2's blend ramp rather
 * than on the clip. What the pass keys, and the pose it bakes, then depend on
 * the order it walked the range in — the "chasing its own tail" QA measured as
 * 4 of 11 keys landing on source-clean frames. The fix is the auto-physics
 * two-sweep pattern: record the clip first, restore it before every fix.
 *
 * The invariant that pins it down: a range pass must produce EXACTLY what
 * fixing each frame of the raw clip on its own produces. */
{
	const BLEND = 6;
	// Bottoms of the swing every 4 frames — inside each other's blend windows.
	const angleAt = (frame) => -Math.PI / 2 + (Math.PI / 3) * Math.abs(Math.sin((Math.PI * (frame - 2)) / 4));
	const makeTake = () => {
		const rig = makeRig();
		const resolved = resolveIkRig(rig);
		const arm = rig.getObjectByName("mixamorigLeftArm");
		const fore = rig.getObjectByName("mixamorigLeftForeArm");
		const hand = rig.getObjectByName("mixamorigLeftHand");
		const legs = ["leftFoot", "rightFoot"].map((id) => resolved.chains.get(id));
		const poseClip = (frame) => {
			for (const leg of legs) {
				leg.bones.forEach((bone, index) => {
					bone.position.copy(leg.bindPositions[index]);
					bone.quaternion.identity();
				});
			}
			arm.position.set(10, -10, 0);
			fore.position.set(30, 0, 0);
			hand.position.set(30, 0, 0);
			fore.quaternion.identity();
			hand.quaternion.identity();
			arm.quaternion.setFromAxisAngle(new THREE.Vector3(0, 0, 1), angleAt(frame));
			rig.updateMatrixWorld(true);
		};
		return { rig, chains: resolved.chains, fkJoints: resolved.fkJoints, poseClip };
	};

	// Ground truth: fix each frame of the RAW clip, alone, on a virgin state.
	const independent = new Map();
	for (let frame = 0; frame <= 20; frame += 1) {
		const solo = makeTake();
		solo.poseClip(frame);
		const outcome = fixCollisions(solo.rig, solo.chains, { radii: RADII, ikState: createIkState() });
		if (outcome.changed) {
			independent.set(frame, solo.chains.get("leftHand").bones.map((b) => b.quaternion.clone()));
		}
	}
	check("the fixture puts several fixes inside one blend window",
		independent.size >= 4 && [...independent.keys()].every((f, i, all) => i === 0 || f - all[i - 1] <= BLEND),
		`dirty=${[...independent.keys()].join(",")}`);

	const take = makeTake();
	const ik = createIkState();
	ik.chains = take.chains;
	const keyed = fixCollisionsRange({
		rig: take.rig, chains: take.chains, ikState: ik, fkJoints: take.fkJoints,
		startFrame: 0, endFrame: 20, radii: RADII,
		applyFrame: (frame) => {
			take.poseClip(frame);
			ikEvaluate(take.chains, ik, frame, take.fkJoints, BLEND);
		},
	});
	check("the range pass keys exactly the frames the raw clip needs",
		keyed.join(",") === [...independent.keys()].join(","),
		`range=${keyed.join(",")} raw=${[...independent.keys()].join(",")}`);
	const poseErrors = keyed.map((frame) => {
		const baked = ik.keys.get(frame).get("leftHand").q;
		return Math.max(...baked.map((q, i) => q.angleTo(independent.get(frame)[i])));
	});
	// Tolerance is solver round-off (the range walks one rig through many more
	// matrix updates than the per-frame reference does); the contaminated pose
	// misses by ~0.3°, three hundred times this.
	check("and bakes the pose a raw-clip fix would have produced",
		poseErrors.every((error) => error < 1e-5),
		poseErrors.map((e) => ((e * 180) / Math.PI).toFixed(4) + "°").join(" "));
}

/* --- REGRESSION (Defect A): calibrate against the REST pose ---------------- */
/* The T-pose fixture above proved the calibration works when the pair overlaps
 * in BIND. On a real character it does not: poseBind is a T-pose with the arms
 * straight out, while the pose on screen is DEFAULT_POSE with the arms hanging
 * at the sides — and that is where the arm capsules graze the torso. Bind-only
 * calibration therefore recorded nothing for torso × forearm, the rest pose
 * still read ~1 cm penetrating, and one press of Fix collisions on a brand-new
 * project baked a phantom key and moved the rig 13.7 mm.
 *
 * The fixture below is the first synthetic rig here with MIXAMO-LIKE bone
 * frames: the shoulders carry a bind rotation, so DEFAULT_POSE's X-axis delta
 * swings the arms down instead of spinning them about their own axis. */
{
	const shoulderQ = (sign) => new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), sign * Math.PI / 2);
	const makeStandingRig = () => {
		const rig = new THREE.Object3D();
		rig.scale.setScalar(0.01);
		const mk = (name, parent, x, y, z, quat) => {
			const b = new THREE.Bone();
			b.name = name;
			b.position.set(x, y, z);
			if (quat) b.quaternion.copy(quat);
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
		// Shoulder-local +Z is world +X (left) and +Y is world +Y, so the arm
		// chain runs out sideways at bind and DEFAULT_POSE rotates it down.
		const lSh = mk("mixamorigLeftShoulder", chest, 10, 25, 0, shoulderQ(1));
		const lArm = mk("mixamorigLeftArm", lSh, 0, -10, 4);
		const lFore = mk("mixamorigLeftForeArm", lArm, 0, 0, 30);
		mk("mixamorigLeftHand", lFore, 0, 0, 30);
		const rSh = mk("mixamorigRightShoulder", chest, -10, 25, 0, shoulderQ(-1));
		const rArm = mk("mixamorigRightArm", rSh, 0, -10, 4);
		const rFore = mk("mixamorigRightForeArm", rArm, 0, 0, 30);
		mk("mixamorigRightHand", rFore, 0, 0, 30);
		const lUp = mk("mixamorigLeftUpLeg", hips, 10, 0, 0);
		const lLeg = mk("mixamorigLeftLeg", lUp, 0, -45, 0);
		const lFoot = mk("mixamorigLeftFoot", lLeg, 0, -45, 0);
		mk("mixamorigLeftToeBase", lFoot, 0, -5, 12);
		const rUp = mk("mixamorigRightUpLeg", hips, -10, 0, 0);
		const rLeg = mk("mixamorigRightLeg", rUp, 0, -45, 0);
		const rFoot = mk("mixamorigRightFoot", rLeg, 0, -45, 0);
		mk("mixamorigRightToeBase", rFoot, 0, -5, 12);
		rig.updateMatrixWorld(true);
		primeBindPose(rig); // the T-pose IS the bind, exactly as at clone time
		return rig;
	};
	/** The rig as the app shows it: bind + DEFAULT_POSE, via applyPose itself. */
	const standing = () => {
		const rig = makeStandingRig();
		applyPose(rig, { ...REST_ZERO, ...DEFAULT_POSE.bones });
		rig.updateMatrixWorld(true);
		return rig;
	};

	const rig = standing();
	const foreArm = rig.getObjectByName("mixamorigLeftForeArm");
	check("the fixture's bind is a T-pose while its rest hangs the arm down",
		bindWorldPosition(rig, foreArm, new THREE.Vector3()).x > 0.4
			&& foreArm.getWorldPosition(new THREE.Vector3()).x < 0.2,
		`bindX=${bindWorldPosition(rig, foreArm, new THREE.Vector3()).x.toFixed(4)} restX=${foreArm.getWorldPosition(new THREE.Vector3()).x.toFixed(4)}`);

	const capsules = buildCollisionCapsules(rig, RADII);
	const uncalibrated = detectPenetrations(capsules, { pairAllowances: null });
	const phantom = uncalibrated.find((p) => pairIds(p) === "leftForeArm×torso");
	check("the standing rest pose DOES trip the uncalibrated rule at torso × forearm",
		Boolean(phantom), uncalibrated.map(pairIds).join(", ") || "none");
	check("the phantom is the centimetre-scale one QA measured",
		phantom.depth > 0.005 && phantom.depth < 0.02, `depth=${(phantom.depth * 1000).toFixed(1)}mm`);
	check("bind alone cannot see it — the arms are nowhere near the torso there",
		detectPenetrations(buildCollisionCapsules(makeStandingRig(), RADII), { pairAllowances: null })
			.every((p) => pairIds(p) !== "leftForeArm×torso"));

	check("the standing rest pose reads completely clean once calibrated",
		detectPenetrations(capsules).length === 0,
		detectPenetrations(capsules).map((p) => `${pairIds(p)}@${(p.depth * 1000).toFixed(1)}mm`).join(", "));
	check("the bind T-pose reads clean too",
		detectPenetrations(buildCollisionCapsules(makeStandingRig(), RADII)).length === 0);
	check("Fix collisions on a fresh standing project writes nothing", (() => {
		const fresh = standing();
		const result = fixCollisions(fresh, resolveIkRig(fresh).chains, { radii: RADII });
		return result.supported === true && result.changed === false && result.touched.length === 0;
	})());
	check("and it hands the pose back untouched", (() => {
		const fresh = standing();
		const before = fresh.getObjectByName("mixamorigLeftForeArm").getWorldPosition(new THREE.Vector3());
		fixCollisions(fresh, resolveIkRig(fresh).chains, { radii: RADII });
		return fresh.getObjectByName("mixamorigLeftForeArm").getWorldPosition(new THREE.Vector3()).distanceTo(before) < 1e-9;
	})());
	check("the allowance came from the REST composition, not from bind",
		restPairOverlaps(rig, RADII).get("leftForeArm|torso") > 0.02,
		[...restPairOverlaps(rig, RADII).entries()].map(([k, o]) => `${k}@${(o * 1000).toFixed(1)}mm`).join(", "));

	// ...and a genuine deep hit on that very pair is still caught at full depth.
	const driven = standing();
	driven.getObjectByName("mixamorigLeftShoulder").position.set(2, 25, 0);
	driven.updateMatrixWorld(true);
	const hits = detectPenetrations(buildCollisionCapsules(driven, RADII));
	const deep = hits.find((p) => pairIds(p) === "leftForeArm×torso");
	check("a forearm genuinely driven into the torso is still detected",
		Boolean(deep), hits.map(pairIds).join(", ") || "none");
	check("the calibration moved the zero point, it did not disable the pair",
		deep.depth > 0.05, `depth=${(deep.depth * 1000).toFixed(1)}mm`);
}

/* --- REGRESSION (escape direction): a limb escapes toward where it BELONGS -- */
/* The push used to follow the segment-to-segment separation normal, i.e. the
 * SHORTEST way out, which on a deep hit is regularly the wrong side of the
 * blocker: QA's forearm-in-the-chest exited ACROSS the chest and parked the
 * hand at the opposite shoulder, and a hand 10.8 cm inside the head exited
 * forward, turning "hand to face" into "hand held out in front of the face".
 * The escape is now the normal blended with a HOME direction — contact point →
 * the driven joint's REST-pose position — with the push length divided by the
 * alignment so the separation ALONG THE NORMAL is unchanged.
 *
 * Every fixture here primes a bind pose: with no bind snapshot there is no rest
 * pose to bias toward (restWorldPosition would compose the penetrating pose
 * itself), and the fixer deliberately keeps the old unbiased normal — which is
 * why every fixture above still measures exactly what it always did. */
{
	check("the bias constants are the documented ones",
		HOME_BIAS === 0.6 && MIN_ALIGN === 0.35, `HOME_BIAS=${HOME_BIAS} MIN_ALIGN=${MIN_ALIGN}`);

	/** The synthetic rig with a bind pose primed, so a rest pose exists. */
	const primed = () => {
		const rig = makeRig(true);
		primeBindPose(rig);
		return rig;
	};

	/**
	 * The same rig with the shoulders turned so the arms are authored pointing
	 * FORWARD (+Z). DEFAULT_POSE's delta then rotates each arm about its own
	 * axis, so the REST pose keeps the hands out in front of the chest — a rig
	 * where "where the limb belongs" is unambiguous, and where an escape out of
	 * the BACK of the chest is unmistakably the wrong answer.
	 */
	const reachRig = () => {
		const rig = makeRig(true);
		rig.getObjectByName("mixamorigLeftShoulder").quaternion
			.setFromAxisAngle(new THREE.Vector3(0, 1, 0), -Math.PI / 2);
		rig.getObjectByName("mixamorigRightShoulder").quaternion
			.setFromAxisAngle(new THREE.Vector3(0, 1, 0), Math.PI / 2);
		rig.updateMatrixWorld(true);
		primeBindPose(rig);
		return rig;
	};

	const wristOf = (chains) => chains.get("leftHand").bones[2].getWorldPosition(new THREE.Vector3());
	/** Signed side of the sagittal plane; the synthetic hips sit at x = 0 with
	 * no rotation, so this is simply the wrist's x. Positive = the rig's LEFT. */
	const side = (point) => point.x;
	const CHEST_SURFACE = 0.13; // the Spine radius the capsule table uses here

	{
		const rig = reachRig();
		check("the reach rig's rest pose holds the wrist out in FRONT of the chest",
			restWorldPosition(rig, rig.getObjectByName("mixamorigLeftHand"), new THREE.Vector3()).z > 0.6,
			`restZ=${restWorldPosition(rig, rig.getObjectByName("mixamorigLeftHand"), new THREE.Vector3()).z.toFixed(3)}`);
	}

	/* (a) forearm driven into the chest FROM THE FRONT. The old rule slid the
	 * hand sideways along the shortest normal and left it buried at the side of
	 * the chest (z = 0.053, well inside the 0.13 chest surface); the rest-biased
	 * escape brings it back out the way it came in. */
	{
		const rig = reachRig();
		const { chains } = resolveIkRig(rig);
		solveIk(chains.get("leftHand"), new THREE.Vector3(0.06, 1.46, 0));
		rig.updateMatrixWorld(true);
		const before = wristOf(chains);
		const hits = detectPenetrations(buildCollisionCapsules(rig, RADII));
		check("the fixture buries the forearm in the chest from the front",
			hits.some((p) => /chest/.test(pairIds(p)) && /left(ForeArm|Hand)/.test(pairIds(p)))
				&& side(before) > 0 && Math.abs(before.z) < CHEST_SURFACE,
			`${hits.map(pairIds).join(", ")} wrist=${before.toArray().map((n) => n.toFixed(3)).join(",")}`);

		const result = fixCollisions(rig, chains, { radii: RADII });
		const after = wristOf(chains);
		check("the chest fix leaves nothing penetrating",
			result.changed && result.residual === 0 && penetrations(rig).length === 0,
			`residual=${(result.residual * 1000).toFixed(2)}mm passes=${result.passes}`);
		check("the wrist keeps its OWN side of the sagittal plane",
			side(after) > 0, `x=${after.x.toFixed(3)} (was ${before.x.toFixed(3)})`);
		check("and comes out IN FRONT of the chest, not sideways through it",
			after.z >= CHEST_SURFACE, `z=${after.z.toFixed(3)} (chest surface ${CHEST_SURFACE})`);
		check("the chest fix preserves the arm's bone lengths", (() => {
			const c = chains.get("leftHand").bones.map((b) => b.getWorldPosition(new THREE.Vector3()));
			return Math.abs(c[0].distanceTo(c[1]) - 0.3) < 1e-6 && Math.abs(c[1].distanceTo(c[2]) - 0.3) < 1e-6;
		})());
		const again = fixCollisions(rig, chains, { radii: RADII });
		check("a second run over the fixed pose changes nothing",
			again.changed === false && wristOf(chains).distanceTo(after) < 1e-9,
			`drift=${wristOf(chains).distanceTo(after).toFixed(6)}`);
	}

	/* (a, side clause) the same defect measured as QA saw it: a deep forearm hit
	 * walking the hand across the body a couple of centimetres per pass until it
	 * ends at the opposite shoulder. Every one of these targets crossed the
	 * midline under the unbiased normal (one ended at x = -0.224). */
	{
		const crossers = [
			[0.12, 1.42, 0.14], [0.15, 1.44, 0.10], [0.16, 1.44, 0.10],
			[0.04, 1.50, 0.12], [0.05, 1.52, 0.14],
		];
		const ended = crossers.map((target) => {
			const rig = primed();
			const { chains } = resolveIkRig(rig);
			solveIk(chains.get("leftHand"), new THREE.Vector3(...target));
			rig.updateMatrixWorld(true);
			const result = fixCollisions(rig, chains, { radii: RADII });
			return { x: side(wristOf(chains)), residual: result.residual };
		});
		check("no deep chest hit walks the left hand over to the right side",
			ended.every((e) => e.x > 0), ended.map((e) => e.x.toFixed(3)).join(" "));
		check("and those deep hits still come out clean",
			ended.every((e) => e.residual === 0),
			ended.map((e) => (e.residual * 1000).toFixed(2) + "mm").join(" "));
	}

	/* (b) THE CROUCH CLIP: a hand 12.9 cm inside the head. The separation normal
	 * there points away from the hand's rest position, so the unbiased escape
	 * shoved the hand further from where it belongs (−27 mm along home) and the
	 * "hand to face" gesture became "hand held out in front of the face". */
	{
		const rig = primed();
		const { chains } = resolveIkRig(rig);
		solveIk(chains.get("leftHand"), new THREE.Vector3(0, 1.75, -0.02));
		rig.updateMatrixWorld(true);
		const before = wristOf(chains);
		const home = restWorldPosition(rig, chains.get("leftHand").bones[2], new THREE.Vector3())
			.sub(before).normalize();
		const hit = detectPenetrations(buildCollisionCapsules(rig, RADII))
			.find((p) => pairIds(p) === "head×leftHand");
		check("the fixture sinks the hand deep into the head",
			Boolean(hit) && hit.depth > 0.1, hit ? `${(hit.depth * 1000).toFixed(1)}mm` : "no head×hand hit");
		// `normal` points b → a = hand → head, so the hand escapes along −normal.
		check("and the head's own escape normal points AWAY from the rest pose",
			hit.normal.clone().negate().dot(home) < 0,
			`dot=${hit.normal.clone().negate().dot(home).toFixed(3)}`);

		const result = fixCollisions(rig, chains, { radii: RADII });
		const move = wristOf(chains).sub(before);
		check("the head fix still separates completely",
			result.changed && result.residual === 0 && penetrations(rig).length === 0,
			`residual=${(result.residual * 1000).toFixed(2)}mm`);
		check("the hand leaves the head TOWARD its rest position, not along the head normal",
			move.dot(home) > 0.05, `alongHome=${(move.dot(home) * 1000).toFixed(1)}mm`);
		check("the hand also stays on its own side coming out of the head",
			side(wristOf(chains)) > 0, `x=${wristOf(chains).x.toFixed(3)}`);
	}

	/* (c) a case the bias has no opinion about — a thigh driven up into the
	 * chest, movable × static, escaping straight out the front. It converged in
	 * 4 passes with the unbiased normal and must still do so: the bias chooses a
	 * side, it must never cost convergence. */
	{
		const rig = primed();
		const { chains } = resolveIkRig(rig);
		solveMidJoint(chains.get("leftFoot"), new THREE.Vector3(0.10, 1.35, 0.10));
		rig.updateMatrixWorld(true);
		const hits = detectPenetrations(buildCollisionCapsules(rig, RADII));
		const thigh = hits.find((p) => pairIds(p) === "chest×leftThigh");
		check("the thigh fixture is a movable × static hit",
			Boolean(thigh) && thigh.depth > 0.04
				&& Boolean(thigh.b.def.movable) && !thigh.a.def.movable,
			hits.map(pairIds).join(", ") || "none");
		const result = fixCollisions(rig, chains, { radii: RADII });
		check("the thigh case still converges to zero residual",
			result.changed && result.residual === 0 && penetrations(rig).length === 0,
			`residual=${(result.residual * 1000).toFixed(3)}mm`);
		check("in the same 4 passes the unbiased rule needed",
			result.passes <= 4, `passes=${result.passes}`);
		check("with the leg's bone lengths intact", (() => {
			const c = chains.get("leftFoot").bones.map((b) => b.getWorldPosition(new THREE.Vector3()));
			return Math.abs(c[0].distanceTo(c[1]) - 0.45) < 1e-6 && Math.abs(c[1].distanceTo(c[2]) - 0.45) < 1e-6;
		})());
	}
}

/* --- FINGERS: a hand is not a palm ---------------------------------------- */
/* The hand capsule stops at the middle-finger BASE, so the fingers — another
 * palm's length past it — were invisible. A hand whose wrist and palm clear a
 * thigh while its fingertips are 2 cm inside it read as perfectly clean. */
{
	const capsules = buildCollisionCapsules(makeHandRig(), RADII);
	check("a full Mixamo hand adds one capsule per finger",
		capsules.size === 25 && ["Thumb", "Index", "Middle", "Ring", "Pinky"]
			.every((finger) => capsules.has(`leftHand${finger}`) && capsules.has(`rightHand${finger}`)),
		`size=${capsules.size}`);
	check("a finger capsule spans the base joint to the TIP joint",
		Math.abs(capsules.get("leftHandIndex").a.distanceTo(capsules.get("leftHandIndex").b) - 0.09) < 1e-6,
		`span=${capsules.get("leftHandIndex").a.distanceTo(capsules.get("leftHandIndex").b).toFixed(4)}`);
	check("fingers carry the fixed contact radius, not a measured one",
		capsules.get("leftHandIndex").radius === FINGER_RADIUS && Math.abs(FINGER_RADIUS - 0.011) < 1e-9,
		`r=${capsules.get("leftHandIndex").radius}`);

	// 1 → 3 fallback: plenty of rigs ship three finger joints, not four.
	const noTips = makeHandRig();
	for (const finger of ["Thumb", "Index", "Middle", "Ring", "Pinky"]) {
		noTips.getObjectByName(`mixamorigLeftHand${finger}4`).removeFromParent();
	}
	noTips.updateMatrixWorld(true);
	const short = buildCollisionCapsules(noTips, RADII);
	check("a finger with no tip bone falls back to the last knuckle",
		short.size === 25 && Math.abs(short.get("leftHandIndex").a.distanceTo(short.get("leftHandIndex").b) - 0.06) < 1e-6,
		`span=${short.get("leftHandIndex").a.distanceTo(short.get("leftHandIndex").b).toFixed(4)}`);

	// A finger the rig simply does not have is one capsule fewer, never an
	// unsupported rig — the whole tool must not fall over a missing pinky.
	const noPinky = makeHandRig();
	noPinky.getObjectByName("mixamorigLeftHandPinky1").removeFromParent();
	noPinky.updateMatrixWorld(true);
	check("a missing finger drops its capsule and nothing else",
		buildCollisionCapsules(noPinky, RADII).size === 24 && supportsCollisionCleanup(noPinky));
	check("a rig with no finger bones at all is still fully supported",
		supportsCollisionCleanup(makeRig(false)) && buildCollisionCapsules(makeRig(false), RADII).size === 15);

	/**
	 * The arm hangs beside the thigh with the fingers curled inward: the wrist
	 * is 15.6 cm from the thigh axis and the palm capsule with it, while the
	 * fingertips reach 6.6 cm from that axis — 2 cm inside the thigh's surface.
	 */
	const reachingHand = (fingers) => {
		const rig = fingers ? makeHandRig() : makeRig(false);
		rig.getObjectByName("mixamorigLeftShoulder").position.set(15.6, 25, 0);
		rig.getObjectByName("mixamorigLeftArm").quaternion
			.setFromAxisAngle(new THREE.Vector3(0, 0, 1), -Math.PI / 2);
		if (fingers) {
			for (const finger of ["Thumb", "Index", "Middle", "Ring", "Pinky"]) {
				rig.getObjectByName(`mixamorigLeftHand${finger}1`).quaternion
					.setFromAxisAngle(new THREE.Vector3(0, 0, 1), -Math.PI / 2);
			}
		}
		rig.updateMatrixWorld(true);
		return rig;
	};

	check("the wrist and the palm clear the thigh in that pose",
		penetrations(reachingHand(false)).length === 0,
		penetrations(reachingHand(false)).map(pairIds).join(", "));
	const fingerHits = penetrations(reachingHand(true));
	check("but the fingertips 2 cm inside it are caught",
		fingerHits.some((p) => pairIds(p) === "leftHandMiddle×leftThigh"),
		fingerHits.map(pairIds).join(", ") || "none");
	check("every finger that reaches the thigh reports it, at the finger's own slack",
		fingerHits.filter((p) => /leftThigh/.test(pairIds(p))).length === 5
			&& Math.abs(fingerHits.find((p) => pairIds(p) === "leftHandMiddle×leftThigh").depth
				- (0.02 - DEFAULT_SLACK_FACTOR * FINGER_RADIUS)) < 5e-4,
		fingerHits.map((p) => `${pairIds(p)}@${(p.depth * 1000).toFixed(1)}mm`).join(" "));

	const rig = reachingHand(true);
	const chains = resolveIkRig(rig).chains;
	const wristBefore = chains.get("leftHand").bones[2].getWorldPosition(new THREE.Vector3());
	const result = fixCollisions(rig, chains, { radii: RADII });
	check("and the fix takes the fingers out of the thigh",
		result.changed && result.residual === 0 && penetrations(rig).length === 0
			&& chains.get("leftHand").bones[2].getWorldPosition(new THREE.Vector3()).distanceTo(wristBefore) > 1e-4,
		`residual=${(result.residual * 1000).toFixed(2)}mm left=${penetrations(rig).map(pairIds).join(", ")}`);
	check("the finger fix is idempotent",
		fixCollisions(rig, chains, { radii: RADII }).changed === false);

	/* The exclusions. A closed hand lays every finger across its own palm and
	 * back along its own forearm; those are poses, not collisions, and the
	 * proxies cannot tell them apart from a real one. */
	const fist = makeHandRig();
	for (const finger of ["Thumb", "Index", "Middle", "Ring", "Pinky"]) {
		fist.getObjectByName(`mixamorigLeftHand${finger}1`).quaternion
			.setFromAxisAngle(new THREE.Vector3(0, 0, 1), (5 * Math.PI) / 6);
	}
	fist.updateMatrixWorld(true);
	const fingerIds = ["Thumb", "Index", "Middle", "Ring", "Pinky"].map((f) => `leftHand${f}`);
	const closed = penetrations(fist);
	check("a closed hand reports no finger against its own hand, forearm or another finger",
		closed.every((p) => {
			const ids = [p.a.def.id, p.b.def.id];
			const fingers = ids.filter((id) => fingerIds.includes(id)).length;
			return fingers === 0
				|| (fingers === 1 && !ids.includes("leftHand") && !ids.includes("leftForeArm"));
		}),
		closed.map(pairIds).join(", ") || "none");
	check("the fist pose is a fold the fingers really do make",
		fist.getObjectByName("mixamorigLeftHandIndex4").getWorldPosition(new THREE.Vector3())
			.distanceTo(fist.getObjectByName("mixamorigLeftForeArm").getWorldPosition(new THREE.Vector3())) < 0.32);
}

/* --- SHALLOW CONTACTS: the global slack was a blunt instrument -------------- */
/* With the rest/bind calibration protecting the overlaps a character legitimately
 * holds, the global allowance no longer has to cover them: 0.4 × the thinner
 * capsule hid a centimetre and a half of forearm inside a thigh. */
{
	check("the default slack is the documented 0.25", DEFAULT_SLACK_FACTOR === 0.25);

	/** The left arm hanging 10.3 cm from the thigh axis: forearm 0.045 + thigh
	 * 0.075 − 0.103 = exactly 17 mm of overlap. The 15 mm the brief asked for
	 * lands between the two rules AND under MIN_DEPTH once the 0.25 allowance is
	 * taken off it (15 − 11.25 = 3.75 mm), so the fixture uses the shallowest
	 * overlap that is invisible at 0.4 (< 18 mm slack) and actionable at 0.25
	 * (17 − 11.25 = 5.75 mm, past the 4 mm reporting floor). */
	const grazingRig = () => {
		const rig = makeRig();
		rig.getObjectByName("mixamorigLeftShoulder").position.set(10.3, 25, 0);
		rig.getObjectByName("mixamorigLeftArm").quaternion
			.setFromAxisAngle(new THREE.Vector3(0, 0, 1), -Math.PI / 2);
		rig.updateMatrixWorld(true);
		return rig;
	};
	const capsules = buildCollisionCapsules(grazingRig(), RADII);
	const raw = detectPenetrations(capsules, { offset: 0, slackFactor: 0 })
		.find((p) => pairIds(p) === "leftForeArm×leftThigh");
	check("the fixture overlaps the forearm and the thigh by 17 mm",
		raw && Math.abs(raw.depth - 0.017) < 1e-6, `overlap=${raw ? (raw.depth * 1000).toFixed(2) : "none"}mm`);
	check("the old 0.4 slack called that clean",
		detectPenetrations(capsules, { offset: 0, slackFactor: 0.4 })
			.every((p) => pairIds(p) !== "leftForeArm×leftThigh"));
	check("the 0.25 default catches it",
		detectPenetrations(capsules, { offset: 0 }).some((p) => pairIds(p) === "leftForeArm×leftThigh"),
		detectPenetrations(capsules, { offset: 0 }).map(pairIds).join(", ") || "none");

	const rig = grazingRig();
	const chains = resolveIkRig(rig).chains;
	const result = fixCollisions(rig, chains, { radii: RADII, offset: 0 });
	check("and the fixer clears it",
		result.changed && result.residual === 0 && penetrations(rig).length === 0,
		`residual=${(result.residual * 1000).toFixed(2)}mm left=${penetrations(rig).map(pairIds).join(", ")}`);
	check("a shallow fix does not oscillate — the second run is a no-op",
		fixCollisions(rig, chains, { radii: RADII, offset: 0 }).changed === false);
}

/* --- HINGED PAIRS: the neighbours are tested on their far ends -------------- */
/* HOP_LIMIT skipped whole pairs outright, so a knee in the belly (thigh × torso)
 * and an arm folded past its own elbow (forearm × upper arm) were never once
 * looked at. They are tested now on the portions FAR from the shared joint. */
{
	check("the trim constants are the documented ones",
		TRIM_FRACTION === 0.45 && HINGE_SLACK_FACTOR === 0.65,
		`trim=${TRIM_FRACTION} hinge=${HINGE_SLACK_FACTOR}`);

	/* (a) knee to belly — thigh × torso, a pair that could not fire before. */
	{
		const rig = makeRig(true);
		primeBindPose(rig);
		const { chains } = resolveIkRig(rig);
		solveMidJoint(chains.get("leftFoot"), new THREE.Vector3(0.05, 1.35, 0.02));
		rig.updateMatrixWorld(true);
		const hits = detectPenetrations(buildCollisionCapsules(rig, RADII));
		const belly = hits.find((p) => pairIds(p) === "leftThigh×torso");
		check("a knee driven into the belly is detected as thigh × torso",
			Boolean(belly) && belly.depth > 0.02,
			hits.map((p) => `${pairIds(p)}@${(p.depth * 1000).toFixed(1)}mm`).join(", ") || "none");
		const kneeBefore = chains.get("leftFoot").bones[1].getWorldPosition(new THREE.Vector3());
		const result = fixCollisions(rig, chains, { radii: RADII });
		check("and it is resolved by moving the LEG",
			result.changed && result.touched.includes("leftFoot")
				&& chains.get("leftFoot").bones[1].getWorldPosition(new THREE.Vector3()).distanceTo(kneeBefore) > 0.01,
			`touched=${result.touched.join(",")}`);
		check("the belly case comes out clean",
			result.residual === 0 && penetrations(rig).length === 0,
			`residual=${(result.residual * 1000).toFixed(2)}mm left=${penetrations(rig).map(pairIds).join(", ")}`);
		check("with the leg's bone lengths intact", (() => {
			const c = chains.get("leftFoot").bones.map((b) => b.getWorldPosition(new THREE.Vector3()));
			return Math.abs(c[0].distanceTo(c[1]) - 0.45) < 1e-6 && Math.abs(c[1].distanceTo(c[2]) - 0.45) < 1e-6;
		})());
	}

	/* (b) the elbow fold — forearm × upper arm, the other pair HOP_LIMIT hid. */
	{
		const folded = (degrees) => {
			const rig = makeRig(true);
			primeBindPose(rig);
			rig.getObjectByName("mixamorigLeftForeArm").quaternion
				.setFromAxisAngle(new THREE.Vector3(0, 1, 0), (degrees * Math.PI) / 180);
			rig.updateMatrixWorld(true);
			return rig;
		};
		const flat = detectPenetrations(buildCollisionCapsules(folded(170), RADII));
		check("a forearm folded flat onto its own upper arm is detected",
			flat.some((p) => pairIds(p) === "leftForeArm×leftUpperArm"),
			flat.map((p) => `${pairIds(p)}@${(p.depth * 1000).toFixed(1)}mm`).join(", ") || "none");
		check("a normally bent elbow is not",
			detectPenetrations(buildCollisionCapsules(folded(90), RADII))
				.every((p) => pairIds(p) !== "leftForeArm×leftUpperArm"),
			detectPenetrations(buildCollisionCapsules(folded(90), RADII)).map(pairIds).join(", ") || "none");
		check("and neither is a deep, still-possible one",
			detectPenetrations(buildCollisionCapsules(folded(140), RADII))
				.every((p) => pairIds(p) !== "leftForeArm×leftUpperArm"));
	}

	/* (c) the invariant the trim exists to protect: the poses a character rests
	 * in must stay clean now that the neighbours are tested at all. */
	{
		const tpose = makeRig(true);
		primeBindPose(tpose);
		check("the bind T-pose still reads clean with the hinged pairs on",
			detectPenetrations(buildCollisionCapsules(tpose, RADII)).length === 0,
			detectPenetrations(buildCollisionCapsules(tpose, RADII)).map(pairIds).join(", "));
		check("a T-posed rig with full hands reads clean too",
			detectPenetrations(buildCollisionCapsules(makeHandRig(), RADII)).length === 0,
			detectPenetrations(buildCollisionCapsules(makeHandRig(), RADII)).map(pairIds).join(", "));
		check("and a hinged pair is calibrated like any other",
			restPairOverlaps(tpose, RADII) !== null);
	}
}

/* --- EXTERNAL BLOCKERS: the set is in the scene too ------------------------ */
/* Everything above is the character against itself. `blockers` are world-space
 * static shapes — a prop, a wall, another character — already posed for the
 * frame being solved: never movable, never adjacent, never calibrated. */
{
	const V = (x, y, z) => new THREE.Vector3(x, y, z);
	/** A second character's torso, standing where the left arm is. */
	// Ids arrive already namespaced by the caller (collision-blockers.js ships
	// "obj:cube" and "char:char-2:torso"), and are used VERBATIM in the labels.
	const NEIGHBOUR = [{ id: "char:char-2:torso", kind: "capsule", a: V(0.75, 1.1, 0), b: V(0.75, 1.6, 0), radius: 0.12 }];
	/** A 1 m cube, its near face 10 cm inside the left hand. */
	const crate = (yaw = 0) => [{
		id: "obj:crate", kind: "box", center: V(1.2, 1.45, 0), halfExtents: V(0.5, 0.5, 0.5), yaw,
	}];
	const withBlockers = (rig, blockers) => detectPenetrations(buildCollisionCapsules(rig, RADII), { blockers });
	/** Is `point` inside the (yawed) box, by the box's own arithmetic? */
	const insideBox = (box, point) => {
		const d = point.clone().sub(box.center);
		const local = new THREE.Vector3(
			Math.cos(box.yaw) * d.x - Math.sin(box.yaw) * d.z,
			d.y,
			Math.sin(box.yaw) * d.x + Math.cos(box.yaw) * d.z,
		);
		return Math.abs(local.x) <= box.halfExtents.x
			&& Math.abs(local.y) <= box.halfExtents.y
			&& Math.abs(local.z) <= box.halfExtents.z;
	};

	/* (a) capsule blocker. */
	{
		const rig = makeRig();
		const { chains } = resolveIkRig(rig);
		check("a rig clear of everything is clean until the blocker arrives",
			penetrations(rig).length === 0 && withBlockers(rig, NEIGHBOUR).length > 0);
		const hits = withBlockers(rig, NEIGHBOUR);
		check("the blocker's id names the pair, the way fcDetect reads it out",
			hits.some((p) => `${p.a.def.id}×${p.b.def.id}` === "leftHand×char:char-2:torso"),
			hits.map((p) => `${p.a.def.id}×${p.b.def.id}`).join(", "));
		check("a blocker is never the movable side",
			hits.every((p) => p.b.def.movable === null && p.a.def.movable));
		const result = fixCollisions(rig, chains, { radii: RADII, blockers: NEIGHBOUR });
		check("the arm is pushed out of the other character",
			result.changed && result.residual === 0
				&& withBlockers(rig, NEIGHBOUR).length === 0
				&& result.touched.join(",") === "leftHand",
			`residual=${(result.residual * 1000).toFixed(2)}mm touched=${result.touched.join(",")}`);
		check("the arm keeps its bone lengths coming out", (() => {
			const c = chains.get("leftHand").bones.map((b) => b.getWorldPosition(new THREE.Vector3()));
			return Math.abs(c[0].distanceTo(c[1]) - 0.3) < 1e-6 && Math.abs(c[1].distanceTo(c[2]) - 0.3) < 1e-6;
		})());
		check("a blocker fix is idempotent",
			fixCollisions(rig, chains, { radii: RADII, blockers: NEIGHBOUR }).changed === false);
	}

	/* (b) box blocker: the limb has to end OUTSIDE the box, not merely stop
	 * reporting a contact. */
	{
		const rig = makeRig();
		const { chains } = resolveIkRig(rig);
		const box = crate()[0];
		const before = withBlockers(rig, crate());
		check("a cube where the arm swings is detected",
			before.some((p) => `${p.a.def.id}×${p.b.def.id}` === "leftHand×obj:crate"),
			before.map((p) => `${p.a.def.id}×${p.b.def.id}@${(p.depth * 1000).toFixed(0)}mm`).join(", ") || "none");
		check("the fixture really does bury the hand inside the cube",
			insideBox(box, chains.get("leftHand").bones[2].getWorldPosition(new THREE.Vector3())));
		const result = fixCollisions(rig, chains, { radii: RADII, blockers: crate() });
		const capsules = buildCollisionCapsules(rig, RADII);
		check("the cube fix leaves nothing penetrating",
			result.changed && result.residual === 0 && withBlockers(rig, crate()).length === 0,
			`residual=${(result.residual * 1000).toFixed(2)}mm`);
		check("and the limb ends OUTSIDE the cube, not just off its surface",
			["leftHand", "leftForeArm", "leftUpperArm"].every((id) => {
				const capsule = capsules.get(id);
				return !insideBox(box, capsule.a) && !insideBox(box, capsule.b);
			}),
			chains.get("leftHand").bones[2].getWorldPosition(new THREE.Vector3()).toArray().map((n) => n.toFixed(3)).join(","));
	}

	/* (c) yaw. The plank clears the arm square-on and sweeps into it at 45°, so
	 * the rotation is the only thing that can decide the verdict. */
	{
		const plank = (yaw) => [{
			id: "obj:plank", kind: "box", center: V(0.4, 1.45, 0.35), halfExtents: V(0.5, 0.2, 0.06), yaw,
		}];
		const rig = makeRig();
		check("a plank parallel to the arm is clear of it",
			withBlockers(rig, plank(0)).length === 0,
			withBlockers(rig, plank(0)).map((p) => `${p.a.def.id}×${p.b.def.id}`).join(", "));
		const yawed = withBlockers(rig, plank(Math.PI / 4));
		check("the same plank yawed 45° into the arm is caught",
			yawed.some((p) => p.b.def.id === "obj:plank"),
			yawed.map((p) => `${p.a.def.id}×${p.b.def.id}@${(p.depth * 1000).toFixed(0)}mm`).join(", ") || "none");
		const { chains } = resolveIkRig(rig);
		const result = fixCollisions(rig, chains, { radii: RADII, blockers: plank(Math.PI / 4) });
		check("and the arm comes off the yawed plank completely",
			result.changed && result.residual === 0
				&& withBlockers(rig, plank(Math.PI / 4)).length === 0,
			`residual=${(result.residual * 1000).toFixed(2)}mm`);
	}

	/* (d) a blocker cannot be calibrated away, and a malformed one is ignored. */
	{
		const rig = makeRig();
		primeBindPose(rig); // gives the rig a rest/bind calibration to try to use
		check("no rest calibration can hide a blocker",
			withBlockers(rig, NEIGHBOUR).length > 0);
		check("a malformed blocker is dropped, not thrown",
			withBlockers(rig, [{ id: "obj:bad" }, { kind: "capsule", a: V(0, 0, 0), b: V(0, 1, 0), radius: 0.1 }]).length === 0
				&& withBlockers(rig, null).length === 0);
	}

	/* (e) the range driver: a static array, or a per-frame callback. */
	{
		const rig = makeRig();
		const { chains, fkJoints } = resolveIkRig(rig);
		const ik = createIkState();
		ik.chains = chains;
		const asked = [];
		const keyed = fixCollisionsRange({
			rig, chains, ikState: ik, fkJoints,
			startFrame: 0, endFrame: 4, radii: RADII,
			applyFrame: () => solveIk(chains.get("leftHand"), new THREE.Vector3(0.8, 1.45, 0)),
			blockersAt: (frame) => {
				asked.push(frame);
				return frame === 2 ? crate() : [];
			},
		});
		// Every frame the pass poses asks for the blockers as they stand on THAT
		// frame — the main sweep asks for all of them, and the blend-window round
		// asks again for each frame it re-poses.
		check("blockersAt is asked for every frame of the range, after that frame is posed",
			[...new Set(asked)].sort((a, b) => a - b).join(",") === "0,1,2,3,4"
				&& asked.slice(0, 5).join(",") === "0,1,2,3,4",
			`asked=${asked.join(",")}`);
		check("only the frame the prop was in the way gets keyed",
			keyed.join(",") === "2" && ikKeyframes(ik).join(",") === "2", `keyed=${keyed.join(",")}`);

		// A prop that does not move needs no callback: the static array rides
		// through the range driver's options to every frame.
		const still = makeRig();
		const resolved = resolveIkRig(still);
		const stillIk = createIkState();
		stillIk.chains = resolved.chains;
		const everyFrame = fixCollisionsRange({
			rig: still, chains: resolved.chains, ikState: stillIk, fkJoints: resolved.fkJoints,
			startFrame: 0, endFrame: 2, radii: RADII, blockers: crate(),
			applyFrame: () => solveIk(resolved.chains.get("leftHand"), new THREE.Vector3(0.8, 1.45, 0)),
		});
		check("a static blockers array applies to every frame of the range",
			everyFrame.join(",") === "0,1,2", `keyed=${everyFrame.join(",")}`);
	}
}

/* --- TORSO/HEAD YIELD: the blocker gives, a little -------------------------- */
/* Torso, chest and head are static, which is right until the limb cannot reach
 * a way out: the passes run out and the residual just stands there. After the
 * limb has done what it can, the blocker leans away — capped per pass and per
 * run, rolled back whole if it does not actually help. */
{
	/** A leg driven into the torso with the FLOOR raised above the whole pose:
	 * every push target is clamped to the floor clearance, so the leg cannot
	 * clear the torso by itself however many passes it gets. */
	const pinnedLeg = () => {
		const rig = makeRig(true);
		primeBindPose(rig);
		const resolved = resolveIkRig(rig);
		solveMidJoint(resolved.chains.get("leftFoot"), new THREE.Vector3(0.10, 1.35, 0.10));
		rig.updateMatrixWorld(true);
		return { rig, ...resolved };
	};
	const spineAngle = (rig) => {
		let worst = 0;
		for (const name of ["mixamorigSpine", "mixamorigSpine1", "mixamorigNeck"]) {
			worst = Math.max(worst, rig.getObjectByName(name).quaternion.angleTo(new THREE.Quaternion()));
		}
		return worst;
	};

	// The control: an EMPTY joint map is how a caller says "nothing may yield".
	// A caller that passes no map at all gets the joints derived off the rig —
	// the App's single-frame press passes none, and QA measured it leaving 88 mm
	// of head × upper arm standing with the spine at 0.000°.
	const pinned = pinnedLeg();
	const stuck = fixCollisions(pinned.rig, pinned.chains, {
		radii: RADII, floorY: 1.4, fkJoints: new Map(),
	});
	check("the fixture really is stuck without a yield",
		stuck.changed && stuck.residual > 0.02 && spineAngle(pinned.rig) < 1e-9,
		`residual=${(stuck.residual * 1000).toFixed(1)}mm`);

	const yielding = pinnedLeg();
	const relieved = fixCollisions(yielding.rig, yielding.chains, {
		radii: RADII, floorY: 1.4, fkJoints: yielding.fkJoints,
	});
	check("with the FK joints in hand the torso yields",
		relieved.touched.some((id) => ["spine", "chest", "neck"].includes(id)),
		`touched=${relieved.touched.join(",")}`);
	check("and the residual drops because of it",
		relieved.residual < stuck.residual - 0.005,
		`with=${(relieved.residual * 1000).toFixed(1)}mm without=${(stuck.residual * 1000).toFixed(1)}mm`);
	check("the yield is capped at 12° for the whole run",
		spineAngle(yielding.rig) > 1e-6 && spineAngle(yielding.rig) <= YIELD_TOTAL_RAD + 1e-9,
		`yielded=${((spineAngle(yielding.rig) * 180) / Math.PI).toFixed(2)}°`);
	check("the step cap is the documented one",
		Math.abs(YIELD_STEP_RAD - (6 * Math.PI) / 180) < 1e-12
			&& Math.abs(YIELD_TOTAL_RAD - (12 * Math.PI) / 180) < 1e-12);
	check("a yielded joint is named in touched, so the bake can key it",
		relieved.touched.filter((id) => ["spine", "chest", "neck"].includes(id))
			.every((id) => yielding.fkJoints.has(id)));

	// ...and an ordinary fix never leans on the spine at all.
	{
		const rig = makeRig(true);
		primeBindPose(rig);
		const { chains, fkJoints } = resolveIkRig(rig);
		solveIk(chains.get("leftHand"), new THREE.Vector3(0.06, 1.46, 0));
		rig.updateMatrixWorld(true);
		const result = fixCollisions(rig, chains, { radii: RADII, fkJoints });
		check("a case the limb can solve never yields",
			result.changed && result.residual === 0
				&& !result.touched.some((id) => ["hips", "spine", "chest", "neck", "head"].includes(id))
				&& spineAngle(rig) < 1e-9,
			`touched=${result.touched.join(",")}`);
	}

	// A yield that buys nothing is rolled back whole: no lean, no key, and the
	// pose the limb passes reached is what the caller gets.
	{
		const rig = makeRig();
		const { chains, fkJoints } = resolveIkRig(rig);
		// The right hand penetrates but its chain is absent from the map, so no
		// pass and no yield can touch it.
		solveIk(chains.get("rightHand"), new THREE.Vector3(-0.2, 0.85, 0));
		const onlyLeft = new Map([["leftHand", chains.get("leftHand")]]);
		const result = fixCollisions(rig, onlyLeft, { radii: RADII, offset: 0, fkJoints });
		check("an unfixable residual does not spend the yield budget on nothing",
			result.touched.every((id) => !["spine", "chest", "neck"].includes(id))
				&& rig.getObjectByName("mixamorigSpine").quaternion.angleTo(new THREE.Quaternion()) < 1e-9,
			`touched=${result.touched.join(",")}`);
	}
}

/* --- QA S1-A: the solver judges the pose the READOUT judges ---------------- */
/* Every chain's translations used to be normalised to bind before the first
 * capsule was built, so the pass detected on a skeleton the caller never sees.
 * On a real clip (positional playback puts the bones ~19 mm off bind) that
 * produced pairs on limbs the readout calls clean — and, through the key that
 * followed, a press that put an arm back INTO a cube it had just been taken out
 * of: clean → 11 pairs and 16 bones inside → clean → 11 pairs, on alternate
 * presses of the same button. Translations are now normalised per chain, at
 * solve time, so detection reads exactly what detectPenetrations reads. */
{
	const V = (x, y, z) => new THREE.Vector3(x, y, z);
	/**
	 * The mechanism, minimised: a box whose near face sits between the hand's
	 * CLIP position and its BIND position. The clip pose clears it; the same
	 * rotations on bind-length bones do not.
	 */
	const shortArm = () => {
		const rig = makeRig(true);
		primeBindPose(rig);
		const { chains } = resolveIkRig(rig);
		const chain = chains.get("leftHand");
		// ARDY positional playback writes its own per-bone translations; this
		// frame's are shorter than bind. Real clips sit ~19 mm off bind per bone
		// — exaggerated to 15 % here so the two verdicts are unambiguous either
		// side of MIN_DEPTH and the slack, which is a 4 cm swing on its own.
		chain.bones.forEach((bone, index) => bone.position.copy(chain.bindPositions[index]).multiplyScalar(0.85));
		rig.updateMatrixWorld(true);
		return { rig, chains, chain };
	};

	{
		const { rig, chains, chain } = shortArm();
		// The hand capsule reaches the knuckle, so its FAR end is what a crate
		// face beside the hand meets first.
		const handEnd = () => buildCollisionCapsules(rig, RADII).get("leftHand").b.x;
		const clipWrist = { x: handEnd() };
		const saved = chain.bones.map((b) => b.position.clone());
		chain.bones.forEach((bone, index) => bone.position.copy(chain.bindPositions[index]));
		rig.updateMatrixWorld(true);
		const bindWrist = { x: handEnd() };
		chain.bones.forEach((bone, index) => bone.position.copy(saved[index]));
		rig.updateMatrixWorld(true);
		// The crate's face sits between the two.
		const face = (clipWrist.x + bindWrist.x) / 2;
		const CRATE = [{ id: "obj:crate", kind: "box", center: V(face + 0.5, 1.45, 0), halfExtents: V(0.5, 0.5, 0.5), yaw: 0 }];
		check("the fixture's clip pose and its bind pose straddle the crate's face",
			clipWrist.x < face && bindWrist.x > face,
			`clip=${clipWrist.x.toFixed(3)} bind=${bindWrist.x.toFixed(3)} face=${face.toFixed(3)}`);
		check("the readout calls that pose clean",
			detectPenetrations(buildCollisionCapsules(rig, RADII), { blockers: CRATE }).length === 0,
			detectPenetrations(buildCollisionCapsules(rig, RADII), { blockers: CRATE })
				.map((p) => `${p.a.def.id}×${p.b.def.id}`).join(", "));

		const before = layerSnapshot(rig);
		const result = fixCollisions(rig, chains, { radii: RADII, blockers: CRATE });
		check("and so does the fixer: no key, no touch, no motion",
			result.changed === false && result.touched.length === 0 && identicalPose(rig, before),
			`changed=${result.changed} touched=${result.touched.join(",")} drift=${(poseDrift(rig, before) * 1000).toFixed(3)}mm`);
	}

	/* A clean pose is a STRICT no-op — on every shape of fixture, including the
	 * yawed box QA pressed the button under. */
	{
		const cases = [
			["a T-posed rig", () => makeRig(true), null],
			["a rig with full hands", () => makeHandRig(), null],
			["a rig beside a yawed crate it clears", () => makeRig(true), [{
				id: "obj:cube", kind: "box", center: V(1.4, 1.45, 0), halfExtents: V(0.15, 0.15, 0.15), yaw: Math.PI / 4,
			}]],
			["a rig beside a capsule blocker it clears", () => makeRig(true), [{
				id: "char:char-2:torso", kind: "capsule", a: V(1.2, 1.1, 0), b: V(1.2, 1.6, 0), radius: 0.12,
			}]],
		];
		for (const [label, build, blockers] of cases) {
			const rig = build();
			primeBindPose(rig);
			const { chains } = resolveIkRig(rig);
			const clean = detectPenetrations(buildCollisionCapsules(rig, RADII), { blockers }).length === 0;
			const before = layerSnapshot(rig);
			const result = fixCollisions(rig, chains, { radii: RADII, blockers });
			check(`${label} that reads clean is left bit-identical`,
				clean && result.changed === false && result.touched.length === 0 && identicalPose(rig, before),
				`clean=${clean} changed=${result.changed} touched=${result.touched.join(",")}`);
		}
	}

	/* The press-2 case itself: fix a real hit, then press again. */
	{
		const rig = makeRig(true);
		primeBindPose(rig);
		const { chains } = resolveIkRig(rig);
		const cube = [{
			id: "obj:cube", kind: "box", center: V(0.86, 1.45, 0), halfExtents: V(0.15, 0.15, 0.15), yaw: Math.PI / 4,
		}];
		const first = fixCollisions(rig, chains, { radii: RADII, blockers: cube });
		check("the yawed cube at the hand is fixed on the first press",
			first.changed && first.residual === 0
				&& detectPenetrations(buildCollisionCapsules(rig, RADII), { blockers: cube }).length === 0,
			`residual=${(first.residual * 1000).toFixed(2)}mm`);
		const after = layerSnapshot(rig);
		const second = fixCollisions(rig, chains, { radii: RADII, blockers: cube });
		check("and the second press on that pose changes nothing at all",
			second.changed === false && second.touched.length === 0 && identicalPose(rig, after),
			`changed=${second.changed} touched=${second.touched.join(",")} drift=${(poseDrift(rig, after) * 1000).toFixed(3)}mm`);
		const third = fixCollisions(rig, chains, { radii: RADII, blockers: cube });
		check("and the third, and the fourth — no flip-flop",
			third.changed === false && identicalPose(rig, after));
	}

	/* The box guard: however deep the hit, a pass may never end with more of the
	 * limb inside the box than it started with. */
	{
		for (const yaw of [0, Math.PI / 4, -Math.PI / 3]) {
			const rig = makeRig(true);
			primeBindPose(rig);
			const { chains } = resolveIkRig(rig);
			const crate = [{ id: "obj:crate", kind: "box", center: V(0.95, 1.45, 0), halfExtents: V(0.4, 0.4, 0.4), yaw }];
			const insideBefore = blockerInsideCount(buildCollisionCapsules(rig, RADII), crate);
			fixCollisions(rig, chains, { radii: RADII, blockers: crate });
			const insideAfter = blockerInsideCount(buildCollisionCapsules(rig, RADII), crate);
			check(`a deep crate at yaw ${Math.round((yaw * 180) / Math.PI)}° never ends with more of the limb inside it`,
				insideBefore > 0 && insideAfter <= insideBefore,
				`before=${insideBefore} after=${insideAfter}`);
		}
	}
}

/* --- QA S1-B / S2-A: nothing moves that had nothing to move for ------------ */
/* The whole-clip pass on the crouch moved the right leg by up to 142 mm on
 * frames whose pre-pass detection named no leg pair at all, put frame 117's toe
 * 17.2 mm UNDER the floor, and snapped every limb to bind length on every keyed
 * frame (worst: lShin 14.1 mm). Both came from the same place — the up-front
 * bind normalisation of EVERY chain, which manufactured leg pairs that only
 * exist at bind and then keyed the legs for them. A chain with no detected pair
 * must come out of the pass exactly as it went in, translations included. */
{
	/** An arm driven into the chest, with the LEGS carrying clip translations
	 * well off bind — the positional-playback skeleton the range pass sees. */
	const armHitWithWobblyLegs = () => {
		const rig = makeRig(true);
		primeBindPose(rig);
		const resolved = resolveIkRig(rig);
		for (const id of ["leftFoot", "rightFoot"]) {
			const leg = resolved.chains.get(id);
			leg.bones.forEach((bone, index) => bone.position.copy(leg.bindPositions[index]).multiplyScalar(1.04));
		}
		rig.updateMatrixWorld(true);
		solveIk(resolved.chains.get("leftHand"), new THREE.Vector3(0.06, 1.46, 0));
		rig.updateMatrixWorld(true);
		return { rig, ...resolved };
	};

	const { rig, chains } = armHitWithWobblyLegs();
	const legBones = ["leftFoot", "rightFoot"].flatMap((id) => chains.get(id).bones);
	const worldBefore = legBones.map((bone) => bone.getWorldPosition(new THREE.Vector3()));
	const localBefore = legBones.map((bone) => bone.position.clone());
	const lengthsBefore = ["leftFoot", "rightFoot"].map((id) => {
		const p = chains.get(id).bones.map((b) => b.getWorldPosition(new THREE.Vector3()));
		return [p[0].distanceTo(p[1]), p[1].distanceTo(p[2])];
	});
	const footBefore = Math.min(...legBones.map((bone) => bone.getWorldPosition(new THREE.Vector3()).y));

	const hits = detectPenetrations(buildCollisionCapsules(rig, RADII));
	check("the fixture is an ARM hit with no leg pair anywhere in it",
		hits.length > 0 && hits.every((p) => !/Thigh|Shin|Foot/.test(pairIds(p))),
		hits.map(pairIds).join(", "));

	const result = fixCollisions(rig, chains, { radii: RADII });
	check("the arm hit is fixed", result.changed && result.residual === 0);
	check("and only the arm chain is named",
		result.touched.join(",") === "leftHand", `touched=${result.touched.join(",")}`);
	check("every leg bone is exactly where the clip left it",
		legBones.every((bone, index) => bone.getWorldPosition(new THREE.Vector3()).distanceTo(worldBefore[index]) < 1e-6),
		`worst=${Math.max(...legBones.map((bone, index) => bone.getWorldPosition(new THREE.Vector3()).distanceTo(worldBefore[index]) * 1000)).toFixed(4)}mm`);
	check("with the clip's own translations, not bind's",
		legBones.every((bone, index) => bone.position.distanceTo(localBefore[index]) === 0));
	check("so no leg bone changes length",
		["leftFoot", "rightFoot"].every((id, leg) => {
			const p = chains.get(id).bones.map((b) => b.getWorldPosition(new THREE.Vector3()));
			return Math.abs(p[0].distanceTo(p[1]) - lengthsBefore[leg][0]) < 1e-9
				&& Math.abs(p[1].distanceTo(p[2]) - lengthsBefore[leg][1]) < 1e-9;
		}));
	check("and the feet keep the clearance they arrived with",
		Math.abs(Math.min(...legBones.map((bone) => bone.getWorldPosition(new THREE.Vector3()).y)) - footBefore) < 1e-9);

	// This arm arrived at bind, so preserving its locals leaves it there.
	const arm = chains.get("leftHand");
	check("the solved bind-length arm keeps its original translations",
		arm.bones.every((bone, index) => bone.position.distanceTo(arm.bindPositions[index]) < 1e-9));
}

/* --- QA S2-B: the yield reaches the case that needs it --------------------- */
/* A head × upper-arm hit at the arm's reach limit left 88 mm standing with
 * Spine, Spine1, Spine2, Neck and Head all at 0.000°: the single-frame press
 * passes no fkJoints, so the yield had nothing to swing. It now derives the
 * joints from the rig, and spends its budget in steps rather than betting the
 * whole thing on one 6° swing that cannot clear 88 mm on its own. */
{
	/** The shoulder hoisted up beside the head: the upper arm's ROOT end is
	 * inside the head capsule, so no elbow or wrist motion can separate them. */
	const hemmedHead = () => {
		const rig = makeRig(true);
		primeBindPose(rig);
		rig.getObjectByName("mixamorigLeftShoulder").position.set(0, 55, 0);
		rig.updateMatrixWorld(true);
		return { rig, ...resolveIkRig(rig) };
	};
	const neckAngle = (rig) => (rig.getObjectByName("mixamorigNeck").quaternion.angleTo(new THREE.Quaternion()) * 180) / Math.PI;

	const stuck = hemmedHead();
	const before = detectPenetrations(buildCollisionCapsules(stuck.rig, RADII));
	check("the fixture is a head × upper-arm hit the limb cannot solve",
		before.some((p) => pairIds(p) === "head×leftUpperArm"),
		before.map(pairIds).join(", "));
	const noYield = fixCollisions(stuck.rig, stuck.chains, { radii: RADII, fkJoints: new Map() });
	check("without a yield it stays exactly as deep as it was",
		noYield.residual > 0.04 && neckAngle(stuck.rig) < 1e-9,
		`residual=${(noYield.residual * 1000).toFixed(1)}mm`);

	const yielding = hemmedHead();
	const relieved = fixCollisions(yielding.rig, yielding.chains, { radii: RADII });
	check("a caller that passes no FK joints still gets the yield",
		relieved.touched.includes("neck") && neckAngle(yielding.rig) > 1,
		`touched=${relieved.touched.join(",")} neck=${neckAngle(yielding.rig).toFixed(2)}°`);
	check("the head leans off the arm and the residual drops with it",
		relieved.residual < noYield.residual - 0.01,
		`with=${(relieved.residual * 1000).toFixed(1)}mm without=${(noYield.residual * 1000).toFixed(1)}mm`);
	check("more than one step of budget is spent when one cannot finish the job",
		neckAngle(yielding.rig) > (YIELD_STEP_RAD * 180) / Math.PI + 1e-6
			&& neckAngle(yielding.rig) <= (YIELD_TOTAL_RAD * 180) / Math.PI + 1e-9,
		`neck=${neckAngle(yielding.rig).toFixed(2)}°`);

	// A blocker squeezed from both sides has nowhere to lean: every degree away
	// from one arm is a degree into the other. The yield must then decline —
	// and leave no trace of having tried.
	{
		const rig = makeRig(true);
		primeBindPose(rig);
		rig.getObjectByName("mixamorigLeftShoulder").position.set(0, 55, 0);
		rig.getObjectByName("mixamorigRightShoulder").position.set(0, 55, 0);
		rig.updateMatrixWorld(true);
		const { chains } = resolveIkRig(rig);
		const pinched = detectPenetrations(buildCollisionCapsules(rig, RADII));
		check("the pinched fixture presses the head from both sides at once",
			pinched.filter((p) => /head/.test(pairIds(p))).length === 2);
		const result = fixCollisions(rig, chains, { radii: RADII });
		check("a head pinched from both sides refuses to yield rather than rock",
			!result.touched.some((id) => ["spine", "chest", "neck"].includes(id))
				&& neckAngle(rig) < 1e-9,
			`touched=${result.touched.join(",")} neck=${neckAngle(rig).toFixed(3)}°`);
	}
}

/* --- QA S2-C: siblings are not hinges, and a reporting floor --------------- */
/* thigh × thigh fired at 0.218 mm during a normal walk stride and the pass
 * keyed the frame and moved the pose 16 mm for it. Two rules, not one: a pair
 * that meets only through a shared PARENT is an ordinary calibrated pair (it has
 * no joint between the two segments to trim toward), and nothing under MIN_DEPTH
 * is reported at all. */
{
	check("the reporting floor is the documented 4 mm", MIN_DEPTH === 0.004);

	/** Thighs `gap` metres apart at the axis, the walk-stride geometry. */
	const straddle = (gap) => {
		const rig = makeRig(true);
		primeBindPose(rig);
		rig.getObjectByName("mixamorigLeftUpLeg").position.set(gap * 50, 0, 0);
		rig.getObjectByName("mixamorigRightUpLeg").position.set(-gap * 50, 0, 0);
		rig.updateMatrixWorld(true);
		return rig;
	};
	// radii 0.075 + 0.075 + 0.002 offset, slack 0.25 × 0.075 = 0.01875.
	const depthOf = (gap) => {
		const hits = detectPenetrations(buildCollisionCapsules(straddle(gap), RADII));
		return hits.find((p) => pairIds(p) === "leftThigh×rightThigh")?.depth ?? 0;
	};
	check("a walk-stride graze between the thighs is not reported",
		depthOf(0.1315) === 0, `depth=${(depthOf(0.1315) * 1000).toFixed(3)}mm`);
	check("a real thigh-through-thigh crossing still is, at full depth",
		Math.abs(depthOf(0.05) - (0.15 + 0.002 - 0.05 - 0.01875)) < 1e-6,
		`depth=${(depthOf(0.05) * 1000).toFixed(2)}mm`);
	// If siblings were treated as a hinge, their allowance would be
	// 0.65 × (0.075 + 0.075) = 97.5 mm and a 10 cm crossing would read clean.
	check("the sibling pair is judged by the ordinary rule, not a hinge allowance",
		depthOf(0.05) > 0.065, `depth=${(depthOf(0.05) * 1000).toFixed(2)}mm`);

	// The same floor covers the feet, which graze constantly in a stride.
	{
		const rig = makeRig(true);
		primeBindPose(rig);
		rig.getObjectByName("mixamorigLeftUpLeg").position.set(5.4, 0, 0);
		rig.getObjectByName("mixamorigRightUpLeg").position.set(-5.4, 0, 0);
		rig.updateMatrixWorld(true);
		const feet = detectPenetrations(buildCollisionCapsules(rig, RADII))
			.filter((p) => pairIds(p) === "leftFoot×rightFoot");
		check("a millimetre of foot × foot in a stride is not worth a key",
			feet.length === 0 || feet[0].depth >= MIN_DEPTH,
			feet.map((p) => `${(p.depth * 1000).toFixed(2)}mm`).join(", "));
	}
}

/* --- QA S2-D: the blend window's own frames get one look ------------------- */
/* Sweeps 1 and 2 judge every frame against the CLIP, which is what stops the
 * pass chasing its own tail — and what left the ramp unexamined: on the crouch,
 * frame 103 was clean before the pass and carried 28.9 mm of forearm × thumb
 * after it, deterministically, because the big correction keyed at 104 dragged
 * its neighbours into contact and nothing ever looked. */
{
	const BLEND = 6;
	const OUT = new THREE.Vector3(0.55, 1.05, 0.25);
	const IN = new THREE.Vector3(0.05, 1.45, 0.05);
	/** One deep dip into the chest at frame 10, clean either side of it. */
	const makeTake = () => {
		const rig = makeRig(true);
		primeBindPose(rig);
		const resolved = resolveIkRig(rig);
		const poseClip = (frame) => {
			const t = Math.max(0, 1 - Math.abs(frame - 10) / 4);
			for (const id of ["leftFoot", "rightFoot", "rightHand"]) {
				const chain = resolved.chains.get(id);
				chain.bones.forEach((bone, index) => {
					bone.position.copy(chain.bindPositions[index]);
					bone.quaternion.identity();
				});
			}
			const arm = resolved.chains.get("leftHand");
			arm.bones.forEach((bone, index) => {
				bone.position.copy(arm.bindPositions[index]);
				bone.quaternion.identity();
			});
			rig.updateMatrixWorld(true);
			solveIk(arm, OUT.clone().lerp(IN, t));
			rig.updateMatrixWorld(true);
		};
		return { rig, ...resolved, poseClip };
	};

	const sourceDirty = [];
	const reference = makeTake();
	for (let frame = 0; frame <= 20; frame += 1) {
		reference.poseClip(frame);
		if (detectPenetrations(buildCollisionCapsules(reference.rig, RADII)).length) sourceDirty.push(frame);
	}
	check("the source clip penetrates at one frame only",
		sourceDirty.join(",") === "10", `dirty=${sourceDirty.join(",")}`);

	/** Run the range and report which frames are dirty in the FINAL, evaluated
	 * clip — the pose a viewer scrubs through. */
	const sweep = (blendWindow) => {
		const take = makeTake();
		const ik = createIkState();
		ik.chains = take.chains;
		const applyFrame = (frame) => {
			take.poseClip(frame);
			ikEvaluate(take.chains, ik, frame, take.fkJoints, BLEND);
		};
		const keyed = fixCollisionsRange({
			rig: take.rig, chains: take.chains, ikState: ik, fkJoints: take.fkJoints,
			startFrame: 0, endFrame: 20, applyFrame, radii: RADII, blendWindow,
		});
		const dirty = [];
		for (let frame = 0; frame <= 20; frame += 1) {
			applyFrame(frame);
			// A same-chain fold is reported by detection but is not something the
			// fixer claims to clear (see isHingeFold), so it is not a dirty frame.
			const pens = detectPenetrations(buildCollisionCapsules(take.rig, RADII)).filter((pen) => !isHingeFold(pen));
			if (pens.length) dirty.push(`${frame}:${pairIds(pens[0])}@${(pens[0].depth * 1000).toFixed(0)}mm`);
		}
		return { keyed, dirty, ik, take, applyFrame };
	};

	const unswept = sweep(0);
	check("the correction's own blend ramp drags its neighbours into the torso",
		unswept.keyed.join(",") === "10" && unswept.dirty.length === 2
			&& unswept.dirty.every((entry) => /torso/.test(entry)),
		`keyed=${unswept.keyed.join(",")} dirty=${unswept.dirty.join(" ")}`);

	const swept = sweep(BLEND);
	check("one bounded round over the window catches them",
		swept.keyed.join(",") === "9,10,11", `keyed=${swept.keyed.join(",")}`);
	check("and the clip the viewer scrubs through is clean",
		swept.dirty.length === 0, swept.dirty.join(" "));
	check("the round is ONE round: a second pass over the result keys nothing",
		(() => {
			const again = fixCollisionsRange({
				rig: swept.take.rig, chains: swept.take.chains, ikState: swept.ik,
				fkJoints: swept.take.fkJoints, startFrame: 0, endFrame: 20,
				applyFrame: swept.applyFrame, radii: RADII, blendWindow: BLEND,
			});
			return again.length === 0;
		})());
}

/* --- QA S3: frames the pass could not clear are named ---------------------- */
/* After a whole-clip pass some frames still touch (walk 30/56/189/332, crouch
 * 202) and the result said nothing about it, so the App could only report a
 * count of keys. The keyed-frame list carries an `unresolved` field now — an
 * array, so every existing caller keeps working unchanged. */
{
	/** The head hemmed by a shoulder: fixable only as far as the yield reaches. */
	const stubborn = () => {
		const rig = makeRig(true);
		primeBindPose(rig);
		rig.getObjectByName("mixamorigLeftShoulder").position.set(0, 55, 0);
		rig.updateMatrixWorld(true);
		return { rig, ...resolveIkRig(rig) };
	};
	const take = stubborn();
	const ik = createIkState();
	ik.chains = take.chains;
	const pose = take.rig.getObjectByName("mixamorigLeftArm").quaternion.clone();
	// applyFrame POSES THE RIG, every bone the pass can write, exactly as the
	// App's does (motion apply + ikEvaluate). Setting one quaternion and leaving
	// the rest of the skeleton wherever the last solve left it made the pass's
	// own final read-only sweep measure a pose no frame actually has — it read
	// frame 2's solved arm three times over, so "still penetrating" was true by
	// accident of leftover state rather than by measurement.
	const applyFrame = (frame) => {
		for (const chain of take.chains.values()) {
			chain.bones.forEach((bone, index) => {
				bone.position.copy(chain.bindPositions[index]);
				bone.quaternion.identity();
			});
		}
		// Rotations only for the FK joints: this fixture's geometry IS a moved
		// shoulder bone, and "restoring" its translation would pull the arm back
		// out of the head the fixture just put it in.
		for (const joint of take.fkJoints.values()) joint.bone.quaternion.identity();
		take.rig.getObjectByName("mixamorigLeftArm").quaternion.copy(pose);
		take.rig.updateMatrixWorld(true);
		ikEvaluate(take.chains, ik, frame, take.fkJoints, 6);
	};
	const keyed = fixCollisionsRange({
		rig: take.rig, chains: take.chains, ikState: ik, fkJoints: take.fkJoints,
		startFrame: 0, endFrame: 2, radii: RADII, applyFrame,
	});
	check("the keyed list is still an array the caller can count",
		Array.isArray(keyed) && keyed.length > 0);
	check("and it names the frames that still penetrate, with how deep",
		Array.isArray(keyed.unresolved) && keyed.unresolved.length > 0
			&& keyed.unresolved.every((entry) => Number.isInteger(entry.frame) && entry.residual >= MIN_DEPTH),
		JSON.stringify(keyed.unresolved));
	check("each frame appears at most once, in order",
		keyed.unresolved.every((entry, index) => index === 0 || entry.frame > keyed.unresolved[index - 1].frame));

	// A clip the pass DOES clear reports an empty list, not a missing one.
	{
		const rig = makeRig(true);
		primeBindPose(rig);
		const { chains, fkJoints } = resolveIkRig(rig);
		const state = createIkState();
		state.chains = chains;
		const clean = fixCollisionsRange({
			rig, chains, ikState: state, fkJoints,
			startFrame: 0, endFrame: 3, radii: RADII,
			applyFrame: () => {},
		});
		check("a clip with nothing left over reports an empty unresolved list",
			Array.isArray(clean.unresolved) && clean.unresolved.length === 0 && clean.length === 0);
	}
}

/* --- QA S4: a RUN of corrected frames is one correction, not N ------------- */
/* Every frame above is solved on its own, from the clip. That is what makes
 * each one honest and what made a run of them garbage: a deep hit has several
 * ways out, the choice turns on millimetres, and on QA's crouch frames 104..120
 * each found their own. The hand stepped 22 → 160 mm, 23 → 520 mm, 25 → 519 mm
 * between frames whose SOURCE poses barely moved — arm up, hands to the face,
 * arm down across the body. Every frame collision-free; the sequence garbage.
 *
 * The fixture is that defect in miniature: a hand that drifts onto the head's
 * own axis and sits there for six frames, which is the geometry that makes the
 * escape direction a coin toss (the separation normal flips with a couple of
 * millimetres of drift). */
{
	const BLEND = 6;
	const FRAMES = 12;
	const HEAD_Y = 1.665;
	const DIR = new THREE.Vector3(Math.cos(0.7), 0, Math.sin(0.7));
	const START = DIR.clone().multiplyScalar(0.22).setY(HEAD_Y);
	const END = DIR.clone().multiplyScalar(0.11).setY(HEAD_Y);
	/** The wrist ON the head axis, with a couple of millimetres of drift a frame
	 * — "nearly static", and enough to flip the shortest way out. */
	const inside = (frame) => new THREE.Vector3(
		0.003 * Math.sin(frame * 1.7),
		HEAD_Y + 0.002 * Math.cos(frame * 1.1),
		0.003 * Math.cos(frame * 2.3),
	);
	const targetAt = (frame) => {
		if (frame <= 4) return START.clone().lerp(inside(4), frame / 4);
		if (frame <= 9) return inside(frame);
		return inside(9).lerp(END, (frame - 9) / 2);
	};
	const makeTake = () => {
		const rig = makeRig(true);
		primeBindPose(rig);
		const resolved = resolveIkRig(rig);
		const poseClip = (frame) => {
			for (const chain of resolved.chains.values()) {
				chain.bones.forEach((bone, index) => {
					bone.position.copy(chain.bindPositions[index]);
					bone.quaternion.identity();
				});
			}
			rig.updateMatrixWorld(true);
			solveIk(resolved.chains.get("leftHand"), targetAt(frame));
			rig.updateMatrixWorld(true);
		};
		return { rig, ...resolved, poseClip };
	};
	const wristOf = (take) => take.chains.get("leftHand").bones[2].getWorldPosition(new THREE.Vector3());
	const dirtyOf = (take) => detectPenetrations(buildCollisionCapsules(take.rig, RADII)).filter((pen) => !isHingeFold(pen));

	// The source: what the clip does on its own, and how fast.
	const reference = makeTake();
	const source = [];
	const deep = [];
	for (let frame = 0; frame < FRAMES; frame += 1) {
		reference.poseClip(frame);
		source.push({ wrist: wristOf(reference), knee: reference.chains.get("leftFoot").bones[1].getWorldPosition(new THREE.Vector3()) });
		const pens = dirtyOf(reference);
		if (pens.length && pens[0].depth > 0.1) deep.push(`${frame}:${pairIds(pens[0])}`);
	}
	let sourceStep = 0;
	for (let frame = 1; frame < FRAMES; frame += 1) {
		sourceStep = Math.max(sourceStep, source[frame].wrist.distanceTo(source[frame - 1].wrist));
	}
	check("the fixture buries the hand in the head on frames 4..9",
		deep.map((entry) => entry.split(":")[0]).join(",") === "4,5,6,7,8,9"
			&& deep.every((entry) => /head×leftHand/.test(entry)),
		deep.join(" "));
	check("and its own hand never moves more than a few centimetres a frame",
		sourceStep < 0.06, `${(sourceStep * 1000).toFixed(1)}mm`);

	const take = makeTake();
	const ik = createIkState();
	ik.chains = take.chains;
	const applyFrame = (frame) => {
		take.poseClip(frame);
		ikEvaluate(take.chains, ik, frame, take.fkJoints, BLEND);
	};
	const keyed = fixCollisionsRange({
		rig: take.rig, chains: take.chains, ikState: ik, fkJoints: take.fkJoints,
		startFrame: 0, endFrame: FRAMES - 1, applyFrame, radii: RADII, blendWindow: BLEND,
	});
	const after = [];
	const stillDirty = [];
	for (let frame = 0; frame < FRAMES; frame += 1) {
		applyFrame(frame);
		after.push({ wrist: wristOf(take), knee: take.chains.get("leftFoot").bones[1].getWorldPosition(new THREE.Vector3()) });
		const pens = dirtyOf(take);
		if (pens.length) stillDirty.push(`${frame}:${pairIds(pens[0])}@${(pens[0].depth * 1000).toFixed(0)}mm`);
	}
	let afterStep = 0;
	const steps = [];
	for (let frame = 1; frame < FRAMES; frame += 1) {
		const step = after[frame].wrist.distanceTo(after[frame - 1].wrist);
		steps.push(`${frame - 1}→${frame}:${(step * 1000).toFixed(0)}`);
		afterStep = Math.max(afterStep, step);
	}
	check("the pass cleans every frame of the run", stillDirty.length === 0, stillDirty.join(" "));
	// The bound is the CLIP'S OWN worst step, not a millimetre count: a
	// correction may lead or lag the motion, but a run of them must not move the
	// hand faster than the take ever does. Frame-by-frame solving measured 507 mm
	// against this fixture's 55 mm source — nine times the source, three times
	// this bound.
	check("no frame steps further than 3× the clip's own worst step",
		afterStep <= 3 * sourceStep,
		`worst=${(afterStep * 1000).toFixed(1)}mm bound=${(3 * sourceStep * 1000).toFixed(1)}mm steps=${steps.join(" ")}`);
	// ... and inside the buried run itself, where the source is nearly static,
	// the correction is nearly static too: consecutive frames inherit one
	// another's escape rather than each picking their own.
	let insideStep = 0;
	for (let frame = 5; frame <= 9; frame += 1) {
		insideStep = Math.max(insideStep, after[frame].wrist.distanceTo(after[frame - 1].wrist));
	}
	check("the frames of one buried run inherit one another's escape",
		insideStep < 0.02, `${(insideStep * 1000).toFixed(1)}mm`);
	check("an arm-only run never moves a leg",
		after.every((sample, frame) => sample.knee.distanceTo(source[frame].knee) < 1e-9)
			&& keyed.every((frame) => ![...ik.keys.get(frame).keys()].some((id) => /Foot/.test(id))),
		keyed.map((frame) => `${frame}:${[...ik.keys.get(frame).keys()].join("+")}`).join(" "));
	check("a second pass over the coherent result keys nothing", (() => {
		const before = ikKeyframes(ik).join(",");
		const again = fixCollisionsRange({
			rig: take.rig, chains: take.chains, ikState: ik, fkJoints: take.fkJoints,
			startFrame: 0, endFrame: FRAMES - 1, applyFrame, radii: RADII, blendWindow: BLEND,
		});
		return again.length === 0 && ikKeyframes(ik).join(",") === before;
	})());

	/* --- and an UNRELATED single-frame hit is untouched by any of it -------- */
	/* Continuity only ever reaches back one frame, and only to a frame that was
	 * corrected: a lone dirty frame in a clean clip must still be solved exactly
	 * as a stand-alone fixCollisions of that frame solves it. */
	{
		const lone = makeTake();
		const loneClip = (frame) => {
			lone.poseClip(0);
			if (frame === 6) solveIk(lone.chains.get("leftHand"), inside(6));
			lone.rig.updateMatrixWorld(true);
		};
		const solo = makeTake();
		loneClip.call(null, 6);
		solo.poseClip(0);
		solveIk(solo.chains.get("leftHand"), inside(6));
		solo.rig.updateMatrixWorld(true);
		const outcome = fixCollisions(solo.rig, solo.chains, { radii: RADII, ikState: createIkState() });
		const soloQuats = solo.chains.get("leftHand").bones.map((bone) => bone.quaternion.clone());
		const state = createIkState();
		state.chains = lone.chains;
		const loneKeys = fixCollisionsRange({
			rig: lone.rig, chains: lone.chains, ikState: state, fkJoints: lone.fkJoints,
			startFrame: 0, endFrame: FRAMES - 1, radii: RADII, blendWindow: BLEND,
			applyFrame: (frame) => {
				loneClip(frame);
				ikEvaluate(lone.chains, state, frame, lone.fkJoints, BLEND);
			},
		});
		check("a lone dirty frame is the only one keyed",
			outcome.changed && loneKeys.join(",") === "6", `keyed=${loneKeys.join(",")}`);
		const baked = state.keys.get(6)?.get("leftHand")?.q ?? [];
		check("and it is solved exactly as a stand-alone fix solves it",
			baked.length === soloQuats.length
				&& baked.every((q, index) => q.angleTo(soloQuats[index]) < 1e-5),
			baked.map((q, index) => ((q.angleTo(soloQuats[index]) * 180) / Math.PI).toFixed(4) + "°").join(" "));
	}
}

console.log(failures ? `\n${failures} FAIL` : "\nall pass");
process.exit(failures ? 1 : 0);

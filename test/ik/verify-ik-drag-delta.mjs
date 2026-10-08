import * as THREE from "three";
import {
	resolveIkRig,
	createIkState,
	ikBakeKeyframe,
	ikEvaluate,
	ikTouch,
	solveIk,
	solveHipsTranslate,
	solveSwingAngle,
	applyBodyContact,
} from "../../src/ardy/ik.js";
import { bakeIkDragKey, bakeIkDragRange, chainsChangedBy, ikDragRecord, ikDragTouch } from "../../src/ardy/ik-drag.js";

/* A manual IK drag over a loaded motion must key ONLY the parts it moved, as
 * deltas over the raw clip. Keying every tracked part put an absolute key on a
 * hand dragged 25 frames earlier, which spiked it off the clip on the drag
 * frame (measured 4.0 cm at the frame, 1.5 cm one frame later). */

let failures = 0;
function check(name, cond, detail = "") {
	if (cond) console.log(`PASS ${name}`);
	else {
		failures += 1;
		console.log(`FAIL ${name}${detail ? " — " + detail : ""}`);
	}
}

const BLEND = 6; // App.jsx IK_CORRECTION_BLEND_FRAMES
const v = () => new THREE.Vector3();
const mm = (m) => `${(m * 1000).toFixed(3)}mm`;

/* verify-ik.mjs's synthetic Mixamo rig: T-pose, arms along ±X, 0.01 scale. */
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

/** A synthetic take: swinging arms with ARDY-style per-bone translation wobble
 * and a bobbing hips. Everything is a pure function of the frame, so posing
 * frame f always writes the same raw clip pose. */
function buildTake() {
	const rig = makeRig();
	const resolved = resolveIkRig(rig);
	const { chains, fkJoints } = resolved;
	const hips = fkJoints.get("hips");
	const X = new THREE.Vector3(1, 0, 0);
	const Z = new THREE.Vector3(0, 0, 1);
	const poseClip = (frame) => {
		const wobble = 1 + 0.03 * Math.sin(frame * 0.7);
		for (const [id, chain] of chains) {
			const sign = id.startsWith("left") ? 1 : -1;
			chain.bones.forEach((bone, index) => {
				bone.position.copy(chain.bindPositions[index]).multiplyScalar(wobble);
				bone.quaternion.identity();
			});
			if (chain.track.kind === "arm") {
				chain.bones[0].quaternion.setFromAxisAngle(Z, sign * (-0.9 + 0.5 * Math.sin(frame * 0.2)));
				chain.bones[1].quaternion.setFromAxisAngle(X, 0.3 + 0.4 * Math.sin(frame * 0.3));
			}
		}
		hips.bone.position.copy(hips.bindPos).add(new THREE.Vector3(0, 3 * Math.sin(frame * 0.4), frame * 0.5));
		hips.bone.quaternion.identity();
		for (const [id, joint] of fkJoints) {
			if (id === "hips") continue;
			joint.bone.position.copy(joint.bindPos);
			joint.bone.quaternion.identity();
		}
		rig.updateMatrixWorld(true);
	};
	const state = createIkState();
	state.chains = chains;
	state.fkJoints = fkJoints;
	state.rig = rig;
	// poseMemberAtFrame(rig, clip, state, frame, BLEND): clip, then the layer.
	const viewAt = (frame) => {
		poseClip(frame);
		if (state.keys.size) ikEvaluate(chains, state, frame, fkJoints, BLEND);
	};
	// setCharacterIkKey: each baked track replaces its key and joins `tracked`.
	const setKey = (frame, baked) => {
		if (!baked) return;
		let entry = state.keys.get(frame);
		if (!entry) state.keys.set(frame, (entry = new Map()));
		for (const [id, key] of baked) {
			entry.set(id, key);
			ikTouch(state, id);
		}
	};
	return { rig, chains, fkJoints, state, poseClip, viewAt, setKey };
}

/** The drag-end bake App.jsx did on origin/main: every tracked part, absolute. */
function legacyBake(take, frame) {
	const scratch = { ...createIkState(), tracked: new Set(take.state.tracked) };
	ikBakeKeyframe(take.chains, scratch, frame, take.fkJoints);
	return scratch.keys.get(frame);
}
/** The drag-end bake App.jsx does now with a motion loaded. */
function dragBake(take, frame, record) {
	return bakeIkDragKey(take.chains, take.fkJoints, frame, record.ids, () => take.poseClip(frame));
}

/** One chain drag as App.jsx's ikSolve + ikDragEnd perform it. */
function dragHand(take, frame, id, offset, bake) {
	take.viewAt(frame);
	const record = ikDragRecord(null, frame);
	const chain = take.chains.get(id);
	const target = chain.bones[2].getWorldPosition(v()).add(offset);
	ikDragTouch(take.state, record, id);
	solveIk(chain, target);
	take.setKey(frame, bake(take, frame, record));
	return target;
}

function dragEntry(take, frame, id, offset) {
	take.viewAt(frame);
	const record = ikDragRecord(null, frame);
	const chain = take.chains.get(id);
	const target = chain.bones[2].getWorldPosition(v()).add(offset);
	ikDragTouch(take.state, record, id);
	solveIk(chain, target);
	return { target, entry: bakeIkDragKey(take.chains, take.fkJoints, frame, record.ids, (rig, at) => take.poseClip(at)) };
}

const handAt = (take, id) => take.chains.get(id).bones[2].getWorldPosition(v());

/* --- frame-5 / frame-30 scenario ------------------------------------------ */
function scenario(bake) {
	const take = buildTake();
	const leftTarget = dragHand(take, 5, "leftHand", new THREE.Vector3(0, 0.05, 0.04), bake);
	const rightTarget = dragHand(take, 30, "rightHand", new THREE.Vector3(0.03, 0.06, -0.05), bake);
	let worstLeft = 0;
	let worstFrame = -1;
	for (let frame = 24; frame <= 36; frame += 1) {
		take.poseClip(frame);
		const raw = handAt(take, "leftHand");
		take.viewAt(frame);
		const error = handAt(take, "leftHand").distanceTo(raw);
		if (error > worstLeft) { worstLeft = error; worstFrame = frame; }
	}
	take.viewAt(30);
	const rightError = handAt(take, "rightHand").distanceTo(rightTarget);
	take.viewAt(5);
	const leftKeyError = handAt(take, "leftHand").distanceTo(leftTarget);
	return { take, worstLeft, worstFrame, rightError, leftKeyError };
}

const fixed = scenario(dragBake);
const legacy = scenario(legacyBake);

check("the fixture reproduces the origin/main spike (test is not vacuous)",
	legacy.worstLeft > 0.001, `legacy worst left-hand deviation=${mm(legacy.worstLeft)} at f${legacy.worstFrame}`);
check("untouched left hand stays on the clip at frames 24..36 (< 1 mm)",
	fixed.worstLeft < 0.001, `worst=${mm(fixed.worstLeft)} at f${fixed.worstFrame} (legacy ${mm(legacy.worstLeft)})`);
check("the frame-30 key holds only the dragged right hand",
	[...fixed.take.state.keys.get(30).keys()].join() === "rightHand",
	`keyed=${[...fixed.take.state.keys.get(30).keys()].join()}`);
check("the frame-30 key is a delta over the clip (baseQ on every chain bone)",
	fixed.take.state.keys.get(30).get("rightHand").baseQ?.length === 3);
check("the dragged right hand reaches its target at frame 30 (< 1 mm)",
	fixed.rightError < 0.001, `err=${mm(fixed.rightError)}`);
check("the earlier left-hand key still reaches its target at frame 5 (< 1 mm)",
	fixed.leftKeyError < 0.001, `err=${mm(fixed.leftKeyError)}`);

/* --- one drag applied to the selected motion block ----------------------- */
{
	const take = buildTake();
	const { entry } = dragEntry(take, 5, "leftHand", new THREE.Vector3(0, 0.05, 0.04));
	const boundaries = bakeIkDragRange(take.chains, take.fkJoints, entry, 0, 20, ["leftHand"], (rig, at) => take.poseClip(at));
	check("a range bake creates both selected-block boundary keys", boundaries.has(0) && boundaries.has(20));
	check("range boundary keys remain motion deltas", boundaries.get(0)?.get("leftHand")?.baseQ?.length === 3 && boundaries.get(20)?.get("leftHand")?.baseQ?.length === 3);
	take.setKey(0, boundaries.get(0));
	take.setKey(20, boundaries.get(20));
	const corrections = [];
	for (const frame of [0, 10, 20]) {
		take.poseClip(frame);
		const raw = handAt(take, "leftHand");
		take.viewAt(frame);
		corrections.push(handAt(take, "leftHand").distanceTo(raw));
	}
	check("the applied correction survives throughout the selected block", corrections.every((distance) => distance > 0.001), corrections.map(mm).join(", "));
	take.poseClip(30);
	const outside = handAt(take, "leftHand");
	take.viewAt(30);
	check("the range correction eases back to the raw clip outside the block", handAt(take, "leftHand").distanceTo(outside) < 0.001, mm(handAt(take, "leftHand").distanceTo(outside)));
}

/* --- capture leaves the live pose alone ----------------------------------- */
{
	const take = buildTake();
	dragHand(take, 5, "leftHand", new THREE.Vector3(0, 0.05, 0.04), dragBake);
	take.viewAt(6); // the left-hand correction is live here (weight 5/6)
	const record = ikDragRecord(null, 6);
	ikDragTouch(take.state, record, "rightHand");
	solveIk(take.chains.get("rightHand"), handAt(take, "rightHand").add(new THREE.Vector3(0, 0.04, 0)));
	const before = [];
	take.rig.traverse((node) => before.push([node, node.position.clone(), node.quaternion.clone()]));
	const baked = dragBake(take, 6, record);
	check("base capture restores every node of the live pose exactly",
		before.every(([node, p, q]) => node.position.equals(p) && node.quaternion.equals(q)));
	const clipQ = (() => {
		take.poseClip(6);
		return take.chains.get("rightHand").bones.map((b) => b.quaternion.clone());
	})();
	check("the base is the RAW clip pose, not the corrected live pose",
		baked.get("rightHand").baseQ.every((q, i) => q.equals(clipQ[i])));
}

/* --- FK / body drags carry a base pose ------------------------------------ */
{
	const take = buildTake();
	const hips = take.fkJoints.get("hips");
	take.viewAt(30);
	const record = ikDragRecord(null, 30);
	ikDragTouch(take.state, record, "hips");
	const start = hips.bone.position.clone();
	solveHipsTranslate(hips, new THREE.Vector3(0, -0.05, 0.02), start);
	const dragged = hips.bone.getWorldPosition(v());
	const head = take.fkJoints.get("head");
	ikDragTouch(take.state, record, "head");
	solveSwingAngle(head, new THREE.Vector3(1, 0, 0), 0.4, head.bone.quaternion.clone(), head.bone.parent.getWorldQuaternion(new THREE.Quaternion()));
	const headQ = head.bone.quaternion.clone();
	const baked = dragBake(take, 30, record);
	const hipsKey = baked.get("hips");
	check("a hips translate over a clip keys a translation-only delta",
		hipsKey.basePos && !hipsKey.q && !hipsKey.baseQ, JSON.stringify(Object.keys(hipsKey)));
	check("an FK swing over a clip keys rotation + position deltas",
		baked.get("head").baseQ?.length === 1 && baked.get("head").basePos && baked.get("head").q?.length === 1);
	take.setKey(30, baked);
	take.viewAt(30);
	check("the hips key reproduces the dragged hips at its frame",
		hips.bone.getWorldPosition(v()).distanceTo(dragged) < 1e-6, mm(hips.bone.getWorldPosition(v()).distanceTo(dragged)));
	check("the head key reproduces the dragged head rotation at its frame",
		head.bone.quaternion.angleTo(headQ) < 1e-6);
	take.poseClip(40);
	const clipHips = hips.bone.getWorldPosition(v());
	take.viewAt(40);
	check("outside the blend window the hips are the clip's",
		hips.bone.getWorldPosition(v()).distanceTo(clipHips) < 1e-9);
}

/* --- body contact reports the chains it lifted --------------------------- */
{
	const take = buildTake();
	take.poseClip(0);
	const left = take.chains.get("leftHand");
	left.bones[0].quaternion.setFromAxisAngle(new THREE.Vector3(0, 0, 1), -Math.PI / 2); // hang the left arm
	left.bones[1].quaternion.identity();
	const hips = take.fkJoints.get("hips");
	solveHipsTranslate(hips, new THREE.Vector3(0, -0.9, 0), hips.bone.position.clone());
	check("fixture: the hanging left hand is under the floor", handAt(take, "leftHand").y < 0, `y=${handAt(take, "leftHand").y.toFixed(3)}`);
	const changed = chainsChangedBy(take.chains, () => applyBodyContact(take.chains, take.fkJoints, 0, { skipFeet: true }));
	check("chainsChangedBy names exactly the chain body contact lifted",
		changed.join() === "leftHand", `changed=${changed.join()}`);
}

/* --- drag record lifecycle ------------------------------------------------ */
{
	const first = ikDragRecord(null, 12);
	first.ids.add("leftHand");
	check("a record persists across the solves of one drag", ikDragRecord(first, 12) === first);
	check("a record from another frame is stale and resets", ikDragRecord(first, 13).ids.size === 0);
}

/* --- no motion: the absolute key is unchanged ----------------------------- */
{
	const take = buildTake();
	take.viewAt(10);
	const record = ikDragRecord(null, 10);
	ikDragTouch(take.state, record, "leftHand");
	solveIk(take.chains.get("leftHand"), handAt(take, "leftHand").add(new THREE.Vector3(0, 0.05, 0)));
	const absolute = bakeIkDragKey(take.chains, take.fkJoints, 10, record.ids, null);
	const reference = legacyBake(take, 10);
	const a = absolute.get("leftHand");
	const b = reference.get("leftHand");
	check("without a motion the drag key is the plain absolute key",
		!a.baseQ && !a.basePos && a.q.every((q, i) => q.equals(b.q[i])));
	check("an empty drag bakes nothing", bakeIkDragKey(take.chains, take.fkJoints, 10, new Set(), () => take.poseClip(10)) === null);
}

if (failures) {
	console.log(`${failures} FAIL`);
	process.exit(1);
}
console.log("all PASS");

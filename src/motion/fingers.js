import * as THREE from "three";
import { findBone } from "./find-bone.js";

/**
 * Finger posing for the IK layer. Every finger bone (Thumb/Index/Middle/Ring/Pinky 1..3, per side) is an
 * FK joint track ("leftIndex2"), so keys, playback, take corrections and Undo reuse the joint path whole.
 * A finger bends only around one hinge axis per bone, measured off the hand: the axis is perpendicular to
 * the bone and to the palm normal, so a positive angle curls toward the palm. Angles are relative to the
 * bind pose and clamped per joint.
 */
const FINGER_NAMES = ["Thumb", "Index", "Middle", "Ring", "Pinky"];
const DEG = Math.PI / 180;
// [min, max] bend in degrees per joint (base, middle, tip). The thumb folds across the palm, less far.
const LIMITS = { Thumb: [[-20, 50], [-10, 60], [-10, 75]], other: [[-15, 90], [0, 100], [0, 80]] };
const limitsOf = (name) => LIMITS[name] ?? LIMITS.other;

const fingerTrackId = (side, name, joint) => `${side.toLowerCase()}${name}${joint}`;
export const FINGER_TRACK_IDS = ["Left", "Right"].flatMap((side) => FINGER_NAMES.flatMap((name) => [1, 2, 3].map((joint) => fingerTrackId(side, name, joint))));

const hingeCache = new WeakMap();
/** The fingers of an FK joint map (resolveIkRig's fkJoints): each finger joint record points at its finger. */
export const fingersOf = (fkJoints) => new Map([...(fkJoints?.values() ?? [])].filter((joint) => joint.finger).map((joint) => [joint.finger.id, joint.finger]));
const tmp = { a: new THREE.Vector3(), b: new THREE.Vector3(), c: new THREE.Vector3(), q: new THREE.Quaternion() };

function bindQuatOf(rig, bone) {
	const saved = rig.userData?.poseBind?.get(bone);
	return saved ? new THREE.Quaternion(saved.x, saved.y, saved.z, saved.w) : bone.quaternion.clone();
}

/** The palm normal, pointing to the side the fingers curl toward (the thumb's side of the knuckle plane). */
function palmNormal(hand, index1, pinky1, middle1, thumb2) {
	const at = (bone) => bone.getWorldPosition(new THREE.Vector3());
	const handPos = at(hand), forward = at(middle1).sub(handPos), across = at(index1).sub(at(pinky1));
	const normal = forward.clone().cross(across).normalize();
	const knuckles = at(index1).add(at(pinky1)).multiplyScalar(0.5);
	if (thumb2 && at(thumb2).sub(knuckles).dot(normal) < 0) normal.negate();
	return normal;
}

/** The bone's hinge axis in its own local frame, measured once per bone (a hinge turn leaves it fixed). */
function hingeAxis(bone, child, normal) {
	let axis = hingeCache.get(bone);
	if (axis) return axis;
	const dir = child.getWorldPosition(tmp.a).sub(bone.getWorldPosition(tmp.b)).normalize();
	const world = dir.clone().cross(normal);
	if (world.lengthSq() < 1e-8) return null;
	axis = world.normalize().applyQuaternion(bone.getWorldQuaternion(tmp.q).invert());
	hingeCache.set(bone, axis);
	return axis;
}

/**
 * Resolve the fingers of a rig: returns a Map of "leftIndex" to its three bones, hinge axes, bind rotations
 * and limits, and adds each bone to `fkJoints` under its track id (resolveIkRig's FK joint record shape).
 * A rig without finger bones, or a finger missing one, simply has no entry.
 */
export function resolveFingers(rig, fkJoints) {
	const fingers = new Map();
	rig.updateMatrixWorld(true);
	for (const side of ["Left", "Right"]) {
		const bone = (name) => findBone(rig, `mixamorig${side}${name}`);
		const hand = bone("Hand"), index1 = bone("HandIndex1"), pinky1 = bone("HandPinky1"), middle1 = bone("HandMiddle1");
		if (!hand || !index1 || !pinky1 || !middle1) continue;
		const normal = palmNormal(hand, index1, pinky1, middle1, bone("HandThumb2"));
		for (const name of FINGER_NAMES) {
			const bones = [1, 2, 3].map((joint) => bone(`Hand${name}${joint}`));
			if (bones.some((entry) => !entry)) continue;
			const tip = bone(`Hand${name}4`);
			const axes = bones.map((entry, i) => hingeAxis(entry, bones[i + 1] ?? tip ?? entry.children[0], normal));
			if (axes.some((axis) => !axis)) continue;
			const id = `${side.toLowerCase()}${name}`, trackIds = [1, 2, 3].map((joint) => fingerTrackId(side, name, joint));
			const finger = { id, side, name, bones, tip, axes, bindQuats: bones.map((entry) => bindQuatOf(rig, entry)), limits: limitsOf(name), trackIds };
			fingers.set(id, finger);
			bones.forEach((entry, i) => {
				const saved = rig.userData?.poseBind?.get(entry)?.position;
				fkJoints.set(trackIds[i], {
					track: { id: trackIds[i], label: `${side} ${name} ${i + 1}`, bone: entry.name, child: (bones[i + 1] ?? tip)?.name ?? null, finger: true, group: "finger", visibilityDepth: 0.05 },
					bone: entry, child: bones[i + 1] ?? tip ?? null, finger,
					bindPos: saved ? new THREE.Vector3(saved.x, saved.y, saved.z) : entry.position.clone(),
				});
			});
		}
	}
	return fingers;
}

/** The joint's current bend around its hinge, in radians from bind. */
function jointAngle(finger, i) {
	const rel = finger.bindQuats[i].clone().invert().multiply(finger.bones[i].quaternion);
	const axis = finger.axes[i];
	return 2 * Math.atan2(rel.x * axis.x + rel.y * axis.y + rel.z * axis.z, rel.w);
}

function setJointAngle(finger, i, angle) {
	const [min, max] = finger.limits[i];
	const clamped = Math.min(max * DEG, Math.max(min * DEG, angle));
	finger.bones[i].quaternion.copy(finger.bindQuats[i]).multiply(tmp.q.setFromAxisAngle(finger.axes[i], clamped));
	finger.bones[i].updateMatrixWorld(true);
}

/** The fingertip in world space: the tip bone, or the last bone extended by its own length. */
export function fingerTip(finger, out = new THREE.Vector3()) {
	if (finger.tip) return finger.tip.getWorldPosition(out);
	const end = finger.bones[2].getWorldPosition(out), mid = finger.bones[1].getWorldPosition(tmp.c);
	return end.add(end.clone().sub(mid));
}

/** Curl the whole finger: 0 straight (bind), 1 every joint at its maximum bend. */
export function solveFingerCurl(finger, amount) {
	const t = Math.min(1, Math.max(0, amount));
	finger.bones.forEach((_, i) => setJointAngle(finger, i, t * finger.limits[i][1] * DEG));
}

/** How curled the finger is now, 0..1 (mean of the joints' share of their maximum bend). */
export function fingerCurl(finger) {
	const shares = finger.bones.map((_, i) => Math.max(0, jointAngle(finger, i)) / (finger.limits[i][1] * DEG));
	return Math.min(1, shares.reduce((sum, value) => sum + value, 0) / shares.length);
}

/** Fingertip IK: cyclic coordinate descent over the three hinges toward `target`, inside each joint's limits. */
export function solveFingerReach(finger, target, iterations = 20) {
	const joint = new THREE.Vector3(), tip = new THREE.Vector3(), axis = new THREE.Vector3(), toTip = new THREE.Vector3(), toTarget = new THREE.Vector3();
	for (let pass = 0; pass < iterations; pass += 1) {
		for (let i = 2; i >= 0; i -= 1) {
			const bone = finger.bones[i];
			bone.getWorldPosition(joint);
			fingerTip(finger, tip);
			axis.copy(finger.axes[i]).applyQuaternion(bone.getWorldQuaternion(tmp.q)).normalize();
			toTip.copy(tip).sub(joint).projectOnPlane(axis);
			toTarget.copy(target).sub(joint).projectOnPlane(axis);
			if (toTip.lengthSq() < 1e-12 || toTarget.lengthSq() < 1e-12) continue;
			const delta = Math.atan2(toTip.clone().cross(toTarget).dot(axis), toTip.dot(toTarget));
			setJointAngle(finger, i, jointAngle(finger, i) + delta);
		}
		if (fingerTip(finger, tip).distanceTo(target) < 1e-4) break;
	}
}

// One pose-mode gesture on a finger: { curl } bends the whole finger (panel), a world point is the
// fingertip's IK target. Every joint of the finger is keyed.
export function solveFingerGesture(finger, target, touch) {
	if (!finger) return;
	if (typeof target?.curl === "number") solveFingerCurl(finger, target.curl); else solveFingerReach(finger, target);
	for (const id of finger.trackIds) touch(id);
}

export const FINGER_PRESETS = {
	open: { Thumb: 0, Index: 0, Middle: 0, Ring: 0, Pinky: 0 },
	fist: { Thumb: 0.7, Index: 1, Middle: 1, Ring: 1, Pinky: 1 },
	point: { Thumb: 0.7, Index: 0, Middle: 1, Ring: 1, Pinky: 1 },
};

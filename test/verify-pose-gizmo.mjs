import assert from "node:assert/strict";
import { test } from "node:test";
import * as THREE from "three";
import { bindQuaternionOf, handleColor, HANDLE_COLORS, ringAngle, rotationFromBindDeg, rotationReadout } from "../src/pose-gizmo.js";

test("handles are coloured by body part", () => {
	for (const id of ["leftShoulder", "leftElbow", "leftHand"]) assert.equal(handleColor(id), HANDLE_COLORS.leftArm);
	for (const id of ["rightShoulder", "rightElbow", "rightHand"]) assert.equal(handleColor(id), HANDLE_COLORS.rightArm);
	for (const id of ["leftKnee", "leftFoot"]) assert.equal(handleColor(id), HANDLE_COLORS.leftLeg);
	for (const id of ["rightKnee", "rightFoot"]) assert.equal(handleColor(id), HANDLE_COLORS.rightLeg);
	assert.equal(handleColor("hips"), HANDLE_COLORS.pelvis);
	for (const id of ["spine", "chest", "upperChest", "neck"]) assert.equal(handleColor(id), HANDLE_COLORS.torso);
	assert.equal(handleColor("head"), HANDLE_COLORS.head);
	assert.equal(new Set(Object.values(HANDLE_COLORS)).size, Object.keys(HANDLE_COLORS).length, "every part has its own colour");
});

test("ring angle is signed by the right-hand rule about the axis", () => {
	const z = new THREE.Vector3(0, 0, 1), origin = new THREE.Vector3(1, 2, 3);
	const start = origin.clone().add(new THREE.Vector3(1, 0, 0));
	const quarter = ringAngle(z, origin, start, origin.clone().add(new THREE.Vector3(0, 2, 0)));
	assert.ok(Math.abs(quarter - Math.PI / 2) < 1e-9);
	const back = ringAngle(z, origin, start, origin.clone().add(new THREE.Vector3(0, -1, 0)));
	assert.ok(Math.abs(back + Math.PI / 2) < 1e-9);
	assert.equal(ringAngle(z, origin, origin, start), 0, "a pointer on the pivot gives no rotation");
});

test("the readout is the rotation away from the bind pose", () => {
	const bind = new THREE.Quaternion().setFromEuler(new THREE.Euler(0.3, -0.2, 0.1));
	assert.deepEqual(rotationFromBindDeg(bind, bind.clone()), { x: 0, y: 0, z: 0 });
	const turned = bind.clone().multiply(new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 0, 1), THREE.MathUtils.degToRad(30)));
	assert.deepEqual(rotationFromBindDeg(bind, turned), { x: 0, y: 0, z: 30 });
	assert.deepEqual(rotationFromBindDeg(null, new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(1, 0, 0), THREE.MathUtils.degToRad(-45))), { x: -45, y: 0, z: 0 });
});

test("the readout lists the absolute angles and, while dragging, the signed delta", () => {
	assert.deepEqual(rotationReadout({ x: 0, y: -12.4, z: 30 }), { delta: null, axes: [
		{ axis: "x", value: "0°", active: false }, { axis: "y", value: "-12°", active: false }, { axis: "z", value: "30°", active: false }] });
	const dragging = rotationReadout({ x: 0, y: 0, z: 30 }, { axis: "z", angle: THREE.MathUtils.degToRad(-23) });
	assert.deepEqual(dragging.delta, { axis: "z", value: "−23.0°" });
	assert.deepEqual(dragging.axes.map((a) => a.active), [false, false, true]);
});

test("bind quaternions come from the primed rig root", () => {
	const root = new THREE.Group();
	const bone = new THREE.Bone();
	const child = new THREE.Bone();
	root.add(bone);
	bone.add(child);
	root.userData.poseBind = new Map([[child, { x: 0, y: 0, z: 0.7071068, w: 0.7071068 }]]);
	const quat = bindQuaternionOf(child);
	assert.ok(Math.abs(quat.z - 0.7071068) < 1e-6);
	assert.equal(bindQuaternionOf(new THREE.Bone()), null);
});

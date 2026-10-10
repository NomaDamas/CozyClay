#!/usr/bin/env node
// A route's lean marks (bank / pitch) become a body orientation at playback:
// q = Ry(yaw) · Rx(rotX − pitch) · Rz(rotZ + bank). three.js is the oracle.
import assert from "node:assert/strict";
import { Euler, Matrix4, Quaternion, Vector3 } from "three";
import { createObjectPath } from "../src/object-path.js";
import { sceneObjectTravelMatrixAt, sceneObjectsAt, travelPose } from "../src/object-travel.js";

const DEG = Math.PI / 180;
let passed = 0;
const check = (name, fn) => { fn(); passed += 1; console.log(`PASS ${name}`); };
const near = (a, b, tol = 1e-9, message = "value") => assert.ok(Math.abs(a - b) <= tol, `${message}: ${a} vs ${b} (tol ${tol})`);
const take = { frameCount: 101, fps: 25 };

const obj = (id, pose = {}, extra = {}) => ({
	id, name: id, renderer: "cube", parent: null, attach: null, path: null,
	x: 0, y: 0, z: 0, rot: 0, rotX: 0, rotZ: 0, scaleX: 1, scaleY: 1, scaleZ: 1,
	...pose, ...extra,
});
const rx = (deg) => new Matrix4().makeRotationX(deg * DEG);
const ry = (deg) => new Matrix4().makeRotationY(deg * DEG);
const rz = (deg) => new Matrix4().makeRotationZ(deg * DEG);
const rotationOf = (m) => new Matrix4().extractRotation(m);
const sameRotation = (a, b, tol = 1e-9, label = "rotation") => {
	for (let i = 0; i < 16; i += 1) near(a.elements[i], b.elements[i], tol, `${label} element ${i}`);
};
const matrixAt = (objects, id, frame) => sceneObjectTravelMatrixAt(objects, id, frame, take, new Matrix4());
const worldOf = (objects, id, frame, local) => new Vector3(...local).applyMatrix4(matrixAt(objects, id, frame));

const eastward = [{ x: 0, z: 0 }, { x: 20, z: 0 }]; // heading +X: yaw 90
const banked = (marks, extra = {}) => createObjectPath({ points: eastward, marks, ...extra });

check("a route heading +X with bank 15 tilts about +X, right side down", () => {
	const car = obj("car", { y: 1 }, { path: banked([{ t: 0.5, bank: 15 }]) });
	const m = matrixAt([car], "car", 50);
	sameRotation(rotationOf(m), rx(15).multiply(ry(90)), 1e-9, "Rx(15)·Ry(90)");
	// forward (+Z local) stays the travel direction: the tilt axis IS the travel direction
	const forward = new Vector3(0, 0, 1).applyMatrix4(rotationOf(m));
	near(forward.x, 1, 1e-9, "forward x"); near(forward.y, 0, 1e-9, "forward y"); near(forward.z, 0, 1e-9, "forward z");
	// right of a body facing +X is +Z; it goes down
	const right = new Vector3(-1, 0, 0).applyMatrix4(rotationOf(m));
	near(right.z, Math.cos(15 * DEG), 1e-9, "right side z"); assert.ok(right.y < 0, `right side goes down (${right.y})`);
	const left = new Vector3(1, 0, 0).applyMatrix4(rotationOf(m));
	assert.ok(left.y > 0, "left side goes up");
});

check("positive pitch is nose up, about the body's lateral axis", () => {
	const car = obj("car", { y: 1 }, { path: banked([{ t: 0.5, pitch: 10 }]) });
	const m = matrixAt([car], "car", 50);
	const nose = new Vector3(0, 0, 1).applyMatrix4(rotationOf(m));
	near(nose.y, Math.sin(10 * DEG), 1e-9, "nose rises"); near(nose.x, Math.cos(10 * DEG), 1e-9, "nose still faces +X");
	sameRotation(rotationOf(m), ry(90).multiply(rx(-10)), 1e-9, "Ry(90)·Rx(-10)");
});

check("an authored pitch stays about the body once the heading turns (not world X)", () => {
	const car = obj("car", { y: 1, rotX: 10 }, { path: banked([]) });
	const m = matrixAt([car], "car", 50);
	sameRotation(rotationOf(m), ry(90).multiply(rx(10)), 1e-9, "Ry(90)·Rx(10)");
	const nose = new Vector3(0, 0, 1).applyMatrix4(rotationOf(m));
	near(nose.x, Math.cos(10 * DEG), 1e-9, "the nose still points down the road");
	near(nose.y, -Math.sin(10 * DEG), 1e-9, "tipped about the lateral axis");
	near(nose.z, 0, 1e-9, "no sideways roll leaks in");
});

check("lean adds to the authored pitch and roll", () => {
	const car = obj("car", { y: 1, rotX: 4, rotZ: 3 }, { path: banked([{ t: 0.5, bank: 15, pitch: 6 }]) });
	const m = matrixAt([car], "car", 50);
	sameRotation(rotationOf(m), ry(90).multiply(rx(4 - 6)).multiply(rz(3 + 15)), 1e-9);
	assert.deepEqual(travelPose(car, { rot: 90, bank: 15, pitch: 6 }), { rotX: -2, rot: 90, rotZ: 18 });
});

check("a level route is the plain yaw, exactly as before", () => {
	const car = obj("car", { y: 1 }, { path: banked([{ t: 0.5, bank: 15 }]) });
	for (const frame of [0, 100]) sameRotation(rotationOf(matrixAt([car], "car", frame)), ry(90), 1e-9, `frame ${frame}`);
	const flat = obj("flat", { y: 1 }, { path: banked([]) });
	sameRotation(rotationOf(matrixAt([flat], "flat", 40)), ry(90), 1e-12);
});

check("wheel heights: equal near the ends, unequal mid-route (bank 12 at t=0.5)", () => {
	const road = createObjectPath({ points: [{ x: 0, y: 0.5, z: 0 }, { x: 20, y: 0.5, z: 0 }], marks: [{ t: 0.5, bank: 12 }] });
	const chassis = obj("chassis", { x: 0, y: 0.5, z: 0 }, { path: road });
	const fl = obj("fl", { x: -0.8, y: 0.3, z: 1 }, { parent: "chassis" });
	const fr = obj("fr", { x: 0.8, y: 0.3, z: 1 }, { parent: "chassis" });
	const parts = [chassis, fl, fr];
	const gap = (frame) => worldOf(parts, "fl", frame, [0, 0, 0]).y - worldOf(parts, "fr", frame, [0, 0, 0]).y;
	near(gap(0), 0, 1e-9, "level at the start"); near(gap(100), 0, 1e-9, "level at the end");
	near(gap(50), -1.6 * Math.sin(12 * DEG), 1e-9, "full bank mid-route: the sides differ by track · sin(bank)");
	assert.ok(Math.abs(gap(25)) > 0.01 && Math.abs(gap(25)) < Math.abs(gap(50)), "ramps in between");
	// heading +X: the right side is world +Z. fl (local -X) is the right wheel here, which sinks
	assert.ok(gap(50) < 0, "positive bank: right side (local -X) down");
	// the chassis pivot itself stays on the road
	near(worldOf(parts, "chassis", 50, [0, 0, 0]).y, 0.5, 1e-9);
});

check("a non-routed part keeps its pose relative to the chassis under a lean", () => {
	const chassis = obj("chassis", { x: 1, y: 0.5, z: 2, rot: 20 }, { path: banked([{ t: 0.3, bank: 12, pitch: 3 }, { t: 0.7, bank: -9 }]) });
	const wheel = obj("wheel", { x: 1.7, y: 0.3, z: 3, rot: 20, rotZ: 90 }, { parent: "chassis" });
	const grand = obj("grand", { x: 2, y: 0.9, z: 3.5, rot: 40 }, { parent: "wheel" });
	const parts = [chassis, wheel, grand];
	const authored = (o) => new Matrix4().compose(new Vector3(o.x, o.y, o.z), new Quaternion().setFromEuler(new Euler(o.rotX * DEG, o.rot * DEG, o.rotZ * DEG, "XYZ")), new Vector3(1, 1, 1));
	for (const frame of [0, 15, 30, 50, 70, 85, 100]) {
		const c = matrixAt(parts, "chassis", frame);
		for (const child of [wheel, grand]) {
			// the chassis's played pose differs from its authored one by the motion; the child rides it rigidly
			const motion = c.clone().multiply(authored(chassis).invert());
			const expected = motion.clone().multiply(authored(child));
			const got = matrixAt(parts, child.id, frame);
			for (let i = 0; i < 16; i += 1) near(got.elements[i], expected.elements[i], 1e-9, `frame ${frame} ${child.id} element ${i}`);
		}
	}
});

check("sceneObjectsAt hands out the same orientation the matrices give", () => {
	const chassis = obj("chassis", { y: 0.5, rot: 20, rotX: 3 }, { path: banked([{ t: 0.5, bank: 14, pitch: 5 }]) });
	const wheel = obj("wheel", { x: 0.8, y: 0.3, z: 1, rotZ: 90 }, { parent: "chassis" });
	const loner = obj("loner", { y: 0.2 }, { path: createObjectPath({ points: [{ x: 3, z: 3 }, { x: 3, z: 23 }], marks: [{ t: 0.5, bank: -20 }] }) });
	const flat = obj("flat", { y: 0.2, rot: 7 }, { path: createObjectPath({ points: [{ x: -3, z: 3 }, { x: -3, z: 23 }] }) });
	const parts = [chassis, wheel, loner, flat];
	for (const frame of [0, 33, 50, 80, 100]) {
		const placed = sceneObjectsAt(parts, frame, take);
		for (const record of placed) {
			const expected = matrixAt(parts, record.id, frame);
			const q = new Quaternion().setFromEuler(new Euler(record.rotX * DEG, record.rot * DEG, record.rotZ * DEG, "XYZ"));
			const got = new Matrix4().compose(new Vector3(record.x, record.y, record.z), q, new Vector3(1, 1, 1));
			for (let i = 0; i < 16; i += 1) near(got.elements[i], expected.elements[i], 1e-9, `frame ${frame} ${record.id} element ${i}`);
		}
	}
	// a level upright route still reads back as a pure yaw record
	const level = sceneObjectsAt([flat], 40, take)[0];
	assert.equal(level.rotX, 0); assert.equal(level.rotZ, 0);
});

console.log(`${passed} travel-lean checks passed`);

#!/usr/bin/env node
// Whose route the studio shows for a selection, and the Empty that rides it.
// A car is an Empty over a routed Chassis over its parts: selecting the Empty
// has to find the Chassis's route (routeOwnerFor), and during playback the
// Empty is drawn on the car (object-travel.js) instead of staying behind.
import assert from "node:assert/strict";
import { Euler, Matrix4, Quaternion, Vector3 } from "three";
import { createSceneObject, setSceneObjectParent } from "../src/scene-objects.js";
import { sceneObjectsAt, sceneObjectTravelMatrixAt } from "../src/object-travel.js";
import { routeOwnerFor } from "../src/route-owner.js";

let failures = 0;
async function check(name, fn) {
	try {
		await fn();
		console.log(`PASS ${name}`);
	} catch (error) {
		failures += 1;
		console.log(`FAIL ${name} - ${error.stack?.split("\n").slice(0, 3).join(" | ") ?? error.message}`);
	}
}
const near = (a, b, tol = 1e-6) => Math.abs(a - b) <= tol;
const DEG = Math.PI / 180;
const route = { points: [{ x: 0, y: 0.4, z: 0 }, { x: 0, y: 0.4, z: 8 }, { x: 6, y: 0.4, z: 8 }] };
const record = (kind, id, x, z, extra = {}) => ({ ...createSceneObject(kind, [], { x, z }), id, name: id, y: 0.4, ...extra });
const link = (objects, ...pairs) => pairs.reduce((all, [child, parent]) => setSceneObjectParent(all, child, parent), objects);

/* ----------------------------------------------------------- resolver ---- */

await check("a selected record that owns a route is its own owner", () => {
	const objects = [record("empty", "car", 1, 1), record("cube", "chassis", 1, 1, { path: route, parent: "car" })];
	assert.equal(routeOwnerFor(objects, "chassis").id, "chassis");
});

await check("a group stands for its nearest routed descendant", () => {
	const objects = link(
		[record("empty", "car", 1, 1), record("cube", "chassis", 1, 1, { path: route }), record("empty", "parts", 1, 1), record("cube", "wheel", 1, 1, { path: route })],
		["chassis", "car"], ["parts", "chassis"], ["wheel", "parts"],
	);
	assert.equal(routeOwnerFor(objects, "car").id, "chassis", "the chassis is nearer than the routed wheel under it");
	assert.equal(routeOwnerFor(objects, "parts").id, "wheel", "a mid-level group finds what is below it, not above");
});

await check("the resolver reaches a deep descendant through unrouted nodes", () => {
	const objects = link(
		[record("empty", "car", 0, 0), record("empty", "mid", 0, 0), record("cube", "deep", 0, 0, { path: route })],
		["mid", "car"], ["deep", "mid"],
	);
	assert.equal(routeOwnerFor(objects, "car").id, "deep");
});

await check("ties at one depth go to the first in record order", () => {
	const objects = link(
		[record("empty", "car", 0, 0), record("cube", "second", 0, 0, { path: route }), record("cube", "first", 0, 0, { path: route })],
		["second", "car"], ["first", "car"],
	);
	assert.equal(routeOwnerFor(objects, "car").id, "second", "record order, not id order");
	// across different parents at the same depth it is still the record order
	const split = link(
		[record("empty", "car", 0, 0), record("empty", "a", 0, 0), record("empty", "b", 0, 0), record("cube", "late", 0, 0, { path: route }), record("cube", "early", 0, 0, { path: route })],
		["a", "car"], ["b", "car"], ["late", "b"], ["early", "a"],
	);
	assert.equal(routeOwnerFor(split, "car").id, "late");
});

await check("no route anywhere, an unknown id or an ancestor-only route resolve to null", () => {
	const objects = link([record("empty", "car", 0, 0), record("cube", "chassis", 0, 0, { path: route }), record("cube", "bolt", 0, 0)], ["chassis", "car"], ["bolt", "chassis"]);
	assert.equal(routeOwnerFor(objects, "nope"), null);
	assert.equal(routeOwnerFor(objects, null), null);
	const bare = link([record("empty", "car", 0, 0), record("cube", "part", 0, 0)], ["part", "car"]);
	assert.equal(routeOwnerFor(bare, "car"), null);
	const bolt = routeOwnerFor(objects, "bolt");
	assert.equal(bolt, null, "a part under the routed chassis does not own it; the route is above, not below");
});

await check("a descendant carried by a character is skipped", () => {
	const objects = link([record("empty", "car", 0, 0), record("cube", "held", 0, 0, { path: route })], ["held", "car"])
		.map((o) => (o.id === "held" ? { ...o, attach: { characterId: "a", bone: "hand" } } : o));
	assert.equal(routeOwnerFor(objects, "car"), null);
});

await check("a parent cycle cannot hang the walk", () => {
	const objects = [record("empty", "a", 0, 0, { parent: "b" }), record("empty", "b", 0, 0, { parent: "a" })];
	assert.equal(routeOwnerFor(objects, "a"), null);
});

/* ------------------------------------------------- the Empty rides it ---- */

const take = { frameCount: 120, fps: 24 };
const world = (matrix) => new Vector3().setFromMatrixPosition(matrix);
const car = () => link(
	[
		record("empty", "car", -3.3, 0.6, { rot: 20 }),
		record("cube", "chassis", -3.3, 0.6, { path: route, rot: 20, scaleX: 1.3, scaleZ: 3.6 }),
		record("cube", "wheel", -2.9, 1.8, { rot: 20 }),
	],
	["chassis", "car"], ["wheel", "chassis"],
);

await check("the Empty is drawn at the chassis motion applied to its authored pose", () => {
	const objects = car();
	for (const frame of [0, 30, 60, 119]) {
		const empty = sceneObjectTravelMatrixAt(objects, "car", frame, take);
		const chassis = sceneObjectTravelMatrixAt(objects, "chassis", frame, take);
		assert.ok(empty && chassis, `frame ${frame} both travel`);
		const authored = (o) => new Matrix4().compose(new Vector3(o.x, o.y, o.z), new Quaternion().setFromEuler(new Euler((o.rotX ?? 0) * DEG, o.rot * DEG, (o.rotZ ?? 0) * DEG)), new Vector3(o.scaleX ?? 1, o.scaleY ?? 1, o.scaleZ ?? 1));
		const byId = Object.fromEntries(objects.map((o) => [o.id, o]));
		const motion = new Matrix4().multiplyMatrices(chassis, authored(byId.chassis).invert());
		const expected = new Matrix4().multiplyMatrices(motion, authored(byId.car));
		assert.ok(world(empty).distanceTo(world(expected)) < 1e-9, `frame ${frame}: ${JSON.stringify(world(empty))} vs ${JSON.stringify(world(expected))}`);
		const a = empty.elements, b = expected.elements;
		for (let i = 0; i < 16; i += 1) assert.ok(near(a[i], b[i], 1e-9), `frame ${frame} matrix element ${i}`);
	}
	const end = sceneObjectsAt(objects, 119, take);
	const at = (id) => end.find((o) => o.id === id);
	assert.ok(near(Math.hypot(at("car").x - at("chassis").x, at("car").z - at("chassis").z), 0, 1e-6), "authored coincident Empty and chassis stay together");
	assert.ok(Math.hypot(at("car").x - -3.3, at("car").z - 0.6) > 5, "and both have left the authored place");
});

await check("an Empty authored off the chassis keeps that offset, turned by the chassis' motion", () => {
	const objects = car().map((o) => (o.id === "car" ? { ...o, x: -3.3 + 1, z: 0.6 + 2, rot: 0 } : o));
	const frame = 60;
	const empty = world(sceneObjectTravelMatrixAt(objects, "car", frame, take));
	const chassis = sceneObjectTravelMatrixAt(objects, "chassis", frame, take);
	// carry = chassis drawn · chassis authored⁻¹; the Empty's authored point goes through it
	const authoredChassis = new Matrix4().compose(new Vector3(-3.3, 0.4, 0.6), new Quaternion().setFromEuler(new Euler(0, 20 * DEG, 0)), new Vector3(1.3, 1, 3.6));
	const carry = new Matrix4().multiplyMatrices(chassis, authoredChassis.invert());
	const expected = new Vector3(-2.3, 0.4, 2.6).applyMatrix4(carry);
	assert.ok(empty.distanceTo(expected) < 1e-9, `${JSON.stringify(empty)} vs ${JSON.stringify(expected)}`);
	// and the carry is rigid: it did not inherit the chassis' scale
	assert.ok(near(carry.getMaxScaleOnAxis(), 1, 1e-9));
});

await check("at frame 0 the Empty is where the chassis' own carry puts it (the route start)", () => {
	const objects = car();
	const empty = sceneObjectsAt(objects, 0, take).find((o) => o.id === "car");
	const chassis = sceneObjectsAt(objects, 0, take).find((o) => o.id === "chassis");
	assert.ok(near(empty.x, chassis.x, 1e-6) && near(empty.z, chassis.z, 1e-6) && near(empty.rot, chassis.rot, 1e-6));
});

await check("the Chassis' own pose is the same with or without the Empty's carry", () => {
	const withEmpty = sceneObjectsAt(car(), 90, take).find((o) => o.id === "chassis");
	const alone = sceneObjectsAt([car()[1]].map((o) => ({ ...o, parent: null })), 90, take)[0];
	assert.ok(near(withEmpty.x, alone.x) && near(withEmpty.y, alone.y) && near(withEmpty.z, alone.z) && near(withEmpty.rot, alone.rot));
});

await check("a non-Empty parent is NOT carried by its routed child", () => {
	const objects = link([record("cube", "box", 5, 5), record("cube", "slider", 5, 5, { path: route })], ["slider", "box"]);
	assert.equal(sceneObjectTravelMatrixAt(objects, "box", 90, take), null);
	assert.equal(sceneObjectsAt(objects, 90, take).find((o) => o.id === "box").x, 5);
});

await check("an Empty with no routed descendant stays put, and a routed Empty keeps its own route", () => {
	const bare = link([record("empty", "car", 2, 3), record("cube", "part", 2, 3)], ["part", "car"]);
	assert.equal(sceneObjectTravelMatrixAt(bare, "car", 60, take), null);
	const routed = [record("empty", "car", 0, 0, { path: route })];
	const m = sceneObjectTravelMatrixAt(routed, "car", 60, take);
	assert.ok(m && world(m).z > 1);
});

await check("an Empty over a routed record that itself sits under a routed ancestor takes the descendant's whole carry", () => {
	const objects = link(
		[record("cube", "top", 0, 0, { path: route }), record("empty", "mid", 1, 1), record("cube", "low", 1, 1, { path: { points: [{ x: 1, y: 0.4, z: 1 }, { x: 1, y: 0.4, z: 5 }] } })],
		["mid", "top"], ["low", "mid"],
	);
	const frame = 100;
	const mid = sceneObjectTravelMatrixAt(objects, "mid", frame, take);
	const low = sceneObjectTravelMatrixAt(objects, "low", frame, take);
	// mid and low were authored at the same spot and neither turns relative to
	// the other, so mid is drawn exactly where low is
	assert.ok(world(mid).distanceTo(world(low)) < 1e-9, `${JSON.stringify(world(mid))} vs ${JSON.stringify(world(low))}`);
});

if (failures) {
	console.error(`${failures} check(s) failed`);
	process.exit(1);
}
console.log("route owner verification passed");

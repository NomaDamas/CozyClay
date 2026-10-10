#!/usr/bin/env node
// Rotating a parent scene object turns its whole group rigidly about the
// parent's pivot. Records stay flat and world-space; updateSceneObject carries
// descendants (position, orientation; never the route, a road in the world) so every child keeps its pose
// RELATIVE to the parent. three.js is the oracle for all of the math.
import assert from "node:assert/strict";
import { Euler, Matrix4, Quaternion, Vector3 } from "three";
import { updateSceneObject, rigidMotionBetween, carryPointByMotion, wrapAngle } from "../src/scene-objects.js";
import { translateObjectPath } from "../src/object-path.js";

const DEG = Math.PI / 180;
let passed = 0;
const check = (name, fn) => { fn(); passed += 1; console.log(`PASS ${name}`); };
const near = (a, b, tol, message) => assert.ok(Math.abs(a - b) <= tol, `${message ?? "value"}: ${a} vs ${b} (tol ${tol})`);

// seeded PRNG so a failure is reproducible
let seed = 20260610;
const random = () => { seed = (seed * 1664525 + 1013904223) % 4294967296; return seed / 4294967296; };
const between = (lo, hi) => lo + (hi - lo) * random();

const obj = (id, parent, pose = {}, extra = {}) => ({
	id, name: id, renderer: "cube", parent, attach: null, path: null,
	x: 0, y: 0, z: 0, rot: 0, rotX: 0, rotZ: 0, scaleX: 1, scaleY: 1, scaleZ: 1,
	...pose, ...extra,
});
const rigid = (o) => new Matrix4().compose(
	new Vector3(o.x, o.y, o.z),
	new Quaternion().setFromEuler(new Euler(o.rotX * DEG, o.rot * DEG, o.rotZ * DEG, "XYZ")),
	new Vector3(1, 1, 1),
);
const byId = (rows, id) => rows.find((row) => row.id === id);
/** the child's frame expressed in the parent's frame (unscaled: the carry is rigid) */
const relative = (parent, child) => rigid(parent).invert().multiply(rigid(child));
function assertSameRelative(beforeRows, afterRows, parentId, childId, tol = 1e-6) {
	const a = relative(byId(beforeRows, parentId), byId(beforeRows, childId)).elements;
	const b = relative(byId(afterRows, parentId), byId(afterRows, childId)).elements;
	for (let i = 0; i < 16; i += 1) near(a[i], b[i], tol, `relative matrix element ${i} of ${childId} under ${parentId}`);
}

check("parent yaw 90 swings a child offset (1,0,0) to what three.js says, and adds 90 to its rot", () => {
	const rows = [obj("car", null, { x: 2, y: 3, z: 5 }), obj("wheel", "car", { x: 3, y: 3, z: 5 })];
	const out = updateSceneObject(rows, "car", { rot: 90 });
	const expected = new Vector3(1, 0, 0).applyEuler(new Euler(0, 90 * DEG, 0, "XYZ")); // (0, 0, -1)
	const wheel = byId(out, "wheel");
	near(wheel.x - 2, expected.x, 1e-9); near(wheel.y - 3, expected.y, 1e-9); near(wheel.z - 5, expected.z, 1e-9);
	assert.deepEqual([wheel.x, wheel.y, wheel.z], [2, 3, 4], "(1,0,0) becomes (0,0,-1) about the pivot, with exact tidy values");
	assert.equal(wheel.rot, 90);
	assert.equal(byId(out, "car").rot, 90);
	assert.equal(wheel.scaleX, 1, "scale is never carried");
});

check("nested grandchildren follow (chassis > Parts > Hood)", () => {
	const rows = [
		obj("car", null, { x: 0, y: 5, z: 0 }),
		obj("parts", "car", { x: 1, y: 5, z: 0, rot: 20 }),
		obj("hood", "parts", { x: 2, y: 5.5, z: 1, rot: 30, rotX: 10 }),
	];
	const out = updateSceneObject(rows, "car", { rot: 65, rotX: -30 });
	assertSameRelative(rows, out, "car", "parts");
	assertSameRelative(rows, out, "car", "hood");
	assertSameRelative(rows, out, "parts", "hood");
});

check("pitch (rotX) moves child height and composes the child Euler like three.js", () => {
	const rows = [obj("body", null, { x: 0, y: 3, z: 0 }), obj("nose", "body", { x: 0, y: 3, z: 1, rot: 40 })];
	const out = updateSceneObject(rows, "body", { rotX: 90 });
	const expected = new Vector3(0, 0, 1).applyEuler(new Euler(90 * DEG, 0, 0, "XYZ")); // (0,-1,0)
	const nose = byId(out, "nose");
	near(nose.y, 3 + expected.y, 1e-9, "height drops by one metre");
	near(nose.z, 0, 1e-9);
	assertSameRelative(rows, out, "body", "nose");
	const q = new Quaternion().setFromEuler(new Euler(90 * DEG, 0, 0)).multiply(new Quaternion().setFromEuler(new Euler(0, 40 * DEG, 0)));
	const e = new Euler().setFromQuaternion(q, "XYZ");
	near(wrapAngle(nose.rotX), e.x / DEG, 1e-7); near(wrapAngle(nose.rot), e.y / DEG, 1e-7); near(wrapAngle(nose.rotZ), e.z / DEG, 1e-7);
});

check("core invariant: child-relative-to-parent matrix is unchanged for random rotations (600 trials; kept clear of the floor clamp)", () => {
	for (let trial = 0; trial < 600; trial += 1) {
		const pose = () => ({ rotX: between(-180, 180), rot: between(-180, 180), rotZ: between(-180, 180) });
		const parentPose = { x: between(-20, 20), y: 100, z: between(-20, 20), ...pose() };
		const rows = [obj("p", null, parentPose)];
		for (let i = 0; i < 4; i += 1) rows.push(obj(`c${i}`, i < 2 ? "p" : `c${i - 2}`, { x: between(-30, 30), y: between(90, 110), z: between(-30, 30), ...pose() }));
		const patch = {};
		for (const key of ["rotX", "rot", "rotZ"]) if (random() < 0.7) patch[key] = between(-180, 180);
		if (!Object.keys(patch).length) patch.rot = between(-180, 180);
		const out = updateSceneObject(rows, "p", patch);
		for (let i = 0; i < 4; i += 1) assertSameRelative(rows, out, "p", `c${i}`);
		for (const row of out) for (const key of ["rotX", "rot", "rotZ"]) assert.ok(row[key] >= -180 && row[key] <= 180, `${row.id}.${key} stays in range: ${row[key]}`);
	}
});

check("a combined move + rotate patch keeps the relative-matrix invariant", () => {
	for (let trial = 0; trial < 200; trial += 1) {
		const rows = [obj("p", null, { x: between(-10, 10), y: 100, z: between(-10, 10), rot: between(-180, 180), rotX: between(-60, 60) })];
		for (let i = 0; i < 3; i += 1) rows.push(obj(`c${i}`, i === 2 ? "c0" : "p", { x: between(-20, 20), y: between(90, 110), z: between(-20, 20), rot: between(-180, 180) }));
		const patch = { x: between(-10, 10), y: between(95, 105), z: between(-10, 10), rot: between(-180, 180), rotZ: between(-90, 90) };
		const out = updateSceneObject(rows, "p", patch);
		assert.equal(byId(out, "p").x, patch.x);
		for (let i = 0; i < 3; i += 1) assertSameRelative(rows, out, "p", `c${i}`);
	}
});

check("attached children (and what hangs below them) are untouched by the turn", () => {
	const attached = obj("sword", "hero", { x: 1, y: 0.2, z: 0.1, rot: 15 }, { attach: { characterId: "cast-1", bone: "rightHand" } });
	const below = obj("jewel", "sword", { x: 4, y: 6, z: 1, rot: 5 });
	const free = obj("hilt", "hero", { x: 2, y: 6, z: 0 });
	const rows = [obj("hero", null, { y: 5 }), attached, below, free];
	const out = updateSceneObject(rows, "hero", { rot: 90, rotX: 20 });
	assert.strictEqual(byId(out, "sword"), attached, "attached record is the same object");
	assert.strictEqual(byId(out, "jewel"), below, "record below an attached one is not orbited either");
	assert.notDeepEqual(byId(out, "hilt"), free, "the free sibling still turns");
	// translation still behaves as before for those records (unchanged policy)
	const moved = updateSceneObject(rows, "hero", { x: 1 });
	assert.equal(byId(moved, "sword").x, 2);
});

check("an attached parent does not carry a turn (its numbers are bone-local)", () => {
	const rows = [obj("staff", null, { x: 1, y: 1, z: 1 }, { attach: { characterId: "cast-1", bone: "head" } }), obj("orb", "staff", { x: 2, y: 1, z: 1 })];
	const out = updateSceneObject(rows, "staff", { rot: 90 });
	assert.strictEqual(byId(out, "orb"), rows[1]);
	assert.equal(byId(out, "staff").rot, 90);
});

check("children's routes stay put when the parent turns; the body orbits and turns", () => {
	const path = { points: [{ x: 3, y: 5, z: 5 }, { x: 3, y: 5, z: 9 }, { x: 6, y: 7, z: 9 }], speed: 2, faceTravel: false };
	const rows = [obj("car", null, { x: 2, y: 5, z: 5 }), obj("ghost", "car", { x: 3, y: 5, z: 5 }, { path })];
	const out = updateSceneObject(rows, "car", { rot: 90, rotX: 30 });
	const ghost = byId(out, "ghost");
	assert.deepEqual(ghost.path, byId(rows, "ghost").path, "the road is not turned with the group");
	const q = new Quaternion().setFromEuler(new Euler(30 * DEG, 90 * DEG, 0, "XYZ"));
	const e = new Vector3(1, 0, 0).applyQuaternion(q);
	near(ghost.x, 2 + e.x, 1e-9); near(ghost.y, 5 + e.y, 1e-9); near(ghost.z, 5 + e.z, 1e-9);
	assertSameRelative(rows, out, "car", "ghost");
	// turning back restores every descendant exactly
	const back = updateSceneObject(out, "car", { rot: 0, rotX: 0 });
	const g = byId(back, "ghost"), g0 = byId(rows, "ghost");
	for (const key of ["x", "y", "z", "rot", "rotX", "rotZ"]) near(g[key], g0[key], 1e-9, `${key} restored`);
	assert.deepEqual(g.path, g0.path);
	// a move together with the turn still carries the road, unturned
	const both = updateSceneObject(rows, "car", { rot: 90, x: 4 });
	assert.deepEqual(byId(both, "ghost").path, translateObjectPath(path, { x: 2, y: 0, z: 0 }));
});

check("a translation-only patch is exactly the old behaviour (no rotation fields touched)", () => {
	const path = { points: [{ x: 1, y: 1, z: 1 }, { x: 4, y: 1, z: 1 }] };
	const rows = [obj("p", null, { x: 0, y: 1, z: 0, rot: 33 }), obj("c", "p", { x: 1, y: 1, z: 1, rot: 77, rotX: 5 }, { path }), obj("g", "c", { x: 2, y: 2, z: 2, rotZ: 9 })];
	const out = updateSceneObject(rows, "p", { x: 2.5, z: -1, y: 4 });
	const c = byId(out, "c");
	assert.deepEqual([c.x, c.y, c.z], [3.5, 4, 0]);
	assert.deepEqual([c.rot, c.rotX, c.rotZ], [77, 5, 0]);
	assert.deepEqual(c.path, translateObjectPath(path, { x: 2.5, y: 3, z: -1 }));
	const g = byId(out, "g");
	assert.deepEqual([g.x, g.y, g.z, g.rotZ], [4.5, 5, 1, 9]);
	// setting rotation to its current value is not a turn
	const same = updateSceneObject(rows, "p", { rot: 33 });
	assert.strictEqual(same, rows, "no-op returns the same array");
	assert.strictEqual(byId(updateSceneObject(rows, "p", { x: 2.5 }), "p").rot, 33);
});

check("360 steps of 1 degree return every child to its start within 1e-6", () => {
	for (const key of ["rot", "rotX", "rotZ"]) {
		const start = [
			obj("p", null, { x: 1, y: 20, z: -2, rot: 10, rotX: 5, rotZ: -8 }),
			obj("a", "p", { x: 4.3, y: 21.7, z: 3.9, rot: 77, rotX: 12, rotZ: -31 }, { path: { points: [{ x: 5, y: 22, z: 4 }, { x: 8, y: 23, z: 1 }] } }),
			obj("b", "a", { x: -3.1, y: 18.2, z: 7.7, rot: -120, rotX: 40, rotZ: 3 }),
		];
		let rows = start;
		for (let step = 1; step <= 360; step += 1) rows = updateSceneObject(rows, "p", { [key]: wrapAngle(start[0][key] + step) });
		for (const id of ["a", "b"]) {
			const was = byId(start, id), is = byId(rows, id);
			for (const axis of ["x", "y", "z"]) near(is[axis], was[axis], 1e-6, `${key}: ${id}.${axis}`);
			const a = rigid(was).elements, b = rigid(is).elements;
			for (let i = 0; i < 16; i += 1) near(a[i], b[i], 1e-6, `${key}: ${id} matrix ${i}`);
		}
		assert.deepEqual(byId(rows, "a").path, byId(start, "a").path, `${key}: the route is never touched by the turn`);
	}
});

check("interleaved mixed-axis steps (an author's wiggle) come back to start too", () => {
	const start = [obj("p", null, { y: 20 }), obj("a", "p", { x: 4, y: 22, z: -3, rot: 33 })];
	let rows = start;
	const walk = [];
	for (let i = 0; i < 400; i += 1) walk.push({ rotX: between(-180, 180), rot: between(-180, 180), rotZ: between(-180, 180) });
	for (const patch of walk) rows = updateSceneObject(rows, "p", patch);
	rows = updateSceneObject(rows, "p", { rotX: 0, rot: 0, rotZ: 0 });
	const was = byId(start, "a"), is = byId(rows, "a");
	for (const axis of ["x", "y", "z"]) near(is[axis], was[axis], 1e-6, axis);
	const a = rigid(was).elements, b = rigid(is).elements;
	for (let i = 0; i < 16; i += 1) near(a[i], b[i], 1e-6, `matrix ${i}`);
});

check("a flat (yaw-only) child stays yaw-only through yaw turns, and its rot follows the parent's", () => {
	for (let trial = 0; trial < 200; trial += 1) {
		const parentYaw = between(-180, 180), childYaw = between(-180, 180), newYaw = between(-180, 180);
		const rows = [obj("p", null, { y: 10, rot: parentYaw }), obj("c", "p", { x: between(-5, 5), y: 10, z: between(-5, 5), rot: childYaw })];
		const c = byId(updateSceneObject(rows, "p", { rot: newYaw }), "c");
		assert.equal(c.rotX, 0, "no pitch invented");
		assert.equal(c.rotZ, 0, "no roll invented");
		near(wrapAngle(c.rot - (childYaw + newYaw - parentYaw)), 0, 1e-7, "rot gains exactly the parent's yaw change");
	}
});

check("wrapping: a child's rot stays inside [-180,180) when the turn crosses the seam", () => {
	const rows = [obj("p", null, { y: 1 }), obj("c", "p", { x: 1, y: 1, z: 0, rot: 170 })];
	const out = updateSceneObject(rows, "p", { rot: 20 });
	assert.equal(byId(out, "c").rot, -170);
});

check("characters: rigid motion math — yaw 90 orbits (1,0,0) to (0,0,-1) and adds yaw 90", () => {
	const motion = rigidMotionBetween({ x: 2, y: 0, z: 5, rot: 0, rotX: 0, rotZ: 0 }, { x: 2, y: 0, z: 5, rot: 90, rotX: 0, rotZ: 0 });
	assert.ok(motion);
	const at = carryPointByMotion({ x: 3, y: 0, z: 5 }, motion);
	assert.deepEqual([at.x, at.y, at.z], [2, 0, 4]);
	assert.equal(motion.yaw, 90);
	assert.equal(rigidMotionBetween({ x: 0, y: 0, z: 0, rot: 7 }, { x: 4, y: 1, z: 2, rot: 7 }), null, "a pure move has no turn");
});

check("characters: pitch/roll of the parent moves a character's position but contributes no yaw", () => {
	const pitch = rigidMotionBetween({ x: 0, y: 3, z: 0 }, { x: 0, y: 3, z: 0, rotX: 90 });
	assert.equal(pitch.yaw, 0);
	const at = carryPointByMotion({ x: 0, y: 3, z: 1 }, pitch);
	assert.deepEqual([at.x, at.y, at.z], [0, 2, 0]);
	const roll = rigidMotionBetween({ x: 0, y: 0, z: 0 }, { x: 0, y: 0, z: 0, rotZ: -70 });
	assert.equal(roll.yaw, 0);
	// a yaw composed with a pitch: the twist about the vertical is still a clean number
	const both = rigidMotionBetween({ x: 0, y: 0, z: 0 }, { x: 0, y: 0, z: 0, rot: 90, rotX: 20 });
	assert.ok(Math.abs(both.yaw - 90) < 12, `yaw of a 90-yaw + 20-pitch turn is near 90: ${both.yaw}`);
});

check("characters: random motions agree with three.js", () => {
	for (let trial = 0; trial < 200; trial += 1) {
		const before = { x: between(-9, 9), y: between(0, 9), z: between(-9, 9), rotX: between(-180, 180), rot: between(-180, 180), rotZ: between(-180, 180) };
		const after = { x: between(-9, 9), y: between(0, 9), z: between(-9, 9), rotX: between(-180, 180), rot: between(-180, 180), rotZ: between(-180, 180) };
		const motion = rigidMotionBetween(before, after);
		const p = { x: between(-9, 9), y: between(0, 9), z: between(-9, 9) };
		const got = carryPointByMotion(p, motion);
		const local = new Vector3(p.x, p.y, p.z).applyMatrix4(rigid(before).invert()).applyMatrix4(rigid(after));
		near(got.x, local.x, 1e-6); near(got.y, local.y, 1e-6); near(got.z, local.z, 1e-6);
	}
});

console.log(`PASS ${passed} group-rotation checks`);

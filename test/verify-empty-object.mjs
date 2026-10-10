#!/usr/bin/env node
// The Empty: a scene object that is only a node (Unity's Create Empty). It has a
// transform, a parent and may own a route, but no mesh, no footprint, no
// blocker, no surface and no depth rank. The vintage-car assembly (a chassis
// with ~70 parts) gets one handle to move, turn and route the whole car.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { objectsFixture } from "./bus/objects-fixture.mjs";
import {
	EMPTY_KIND,
	OBJECT_LIBRARY,
	OBJECT_MENU_ENTRIES,
	createSceneObject,
	dropToSurfacePatch,
	groupUnderNewEmpty,
	isEmptyObject,
	loadScene,
	normalizeSceneObject,
	objectFootprintBounds,
	objectSize,
	serializeScene,
	setSceneObjectParent,
	updateSceneObject,
} from "../src/scene-objects.js";
import { sceneObjectBlockers } from "../src/ardy/collision-blockers.js";
import { createGroundSampler } from "../src/ardy/ground.js";
import { coplanarDepthRanks } from "../src/coplanar-depth.js";
import { sceneObjectsAt } from "../src/object-travel.js";
import { buildHierarchyNodes } from "../src/hierarchy-model.js";
import { elementByPath } from "../src/studio-elements.js";

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
const ok = (receipt) => {
	assert.equal(receipt.ok, true, JSON.stringify(receipt));
	return receipt;
};
const near = (a, b, tol = 1e-6) => Math.abs(a - b) <= tol;
const cube = (id, x, y, z, extra = {}) => ({ ...createSceneObject("cube", [], { x, z }), id, name: id, y, ...extra });

/* -------------------------------------------------------- the record ---- */

await check("an empty is creatable and is a zero-size node record", () => {
	const empty = createSceneObject(EMPTY_KIND, []);
	assert.ok(empty, "createSceneObject accepts the empty kind");
	assert.equal(empty.renderer, "empty");
	assert.equal(empty.name, "Empty");
	assert.deepEqual(empty.footprint, { width: 0, depth: 0 });
	assert.equal(empty.height, 0);
	assert.equal(empty.parent, null);
	assert.equal(empty.path, null);
	assert.equal(isEmptyObject(empty), true);
	assert.equal(isEmptyObject(createSceneObject("cube", [])), false);
	const second = createSceneObject(EMPTY_KIND, [empty]);
	assert.equal(second.id, "empty-2");
	assert.equal(second.name, "Empty 2");
	assert.deepEqual(objectSize(empty), { width: 0, height: 0, depth: 0 });
});

await check("the create menu lists the empty beside the primitives; the library contract is unchanged", () => {
	assert.ok(OBJECT_MENU_ENTRIES.some((entry) => entry.kind === EMPTY_KIND && entry.group === "Primitives"));
	assert.ok(OBJECT_MENU_ENTRIES.some((entry) => entry.kind === "cube"));
	assert.ok(!OBJECT_LIBRARY.some((entry) => entry.kind === EMPTY_KIND), "OBJECT_LIBRARY (sized catalogue) never lists a zero-size entry");
	assert.ok(elementByPath("object.renderer").enum.includes("empty"));
});

await check("normalization round trip keeps an empty, with transform, parent and a route", () => {
	const car = {
		...createSceneObject(EMPTY_KIND, [], { x: 1.5, z: -2 }),
		id: "car",
		name: "Vintage Car",
		y: 0.4,
		rot: 90,
		rotX: 10,
		scaleX: 2,
		parent: "world-root",
		path: { points: [{ x: 1.5, y: 0.4, z: -2 }, { x: 1.5, y: 0.4, z: 6 }] },
	};
	const again = normalizeSceneObject(JSON.parse(JSON.stringify(car)));
	assert.equal(again.renderer, "empty");
	assert.equal(again.x, 1.5);
	assert.equal(again.y, 0.4);
	assert.equal(again.rot, 90);
	assert.equal(again.rotX, 10);
	assert.equal(again.scaleX, 2);
	assert.equal(again.parent, "world-root");
	assert.equal(again.path.points.length, 2);
	assert.deepEqual(again.footprint, { width: 0, depth: 0 });
	// a stale footprint in storage is not a fact for an empty either
	const stale = normalizeSceneObject({ ...car, footprint: { width: 4, depth: 4 }, height: 3 });
	assert.deepEqual(stale.footprint, { width: 0, depth: 0 });
	assert.equal(stale.height, 0);
	const loaded = loadScene(serializeScene([car, cube("box", 0, 0, 0)].map((row) => normalizeSceneObject(row))));
	assert.equal(loaded.status, "valid");
	assert.equal(loaded.dropped, 0);
	assert.deepEqual(loaded.objects.map((row) => row.renderer), ["empty", "cube"]);
	assert.equal(normalizeSceneObject({ id: "x", renderer: "no-such-kind" }), null);
});

/* ------------------------------------------- no geometry contribution ---- */

await check("an empty contributes no blocker, no ground and no support", () => {
	const empty = { ...createSceneObject(EMPTY_KIND, [], { x: 0, z: 0 }), y: 0.5 };
	assert.deepEqual(sceneObjectBlockers([empty], { library: OBJECT_LIBRARY }), []);
	const box = cube("box", 3, 0, 3);
	const blockers = sceneObjectBlockers([empty, box], { library: OBJECT_LIBRARY });
	assert.deepEqual(blockers.map((row) => row.id), ["obj:box"], "only the cube blocks");
	const ground = createGroundSampler([empty]);
	assert.equal(ground.surfaces.length, 0);
	assert.equal(ground(0, 0), 0, "the floor is the ground under an empty");
	const b = objectFootprintBounds(empty);
	assert.ok(b.maxX - b.minX === 0 && b.maxZ - b.minZ === 0 && b.topY === b.baseY);
});

await check("an empty is not a drop surface, and is not itself dropped", () => {
	const empty = { ...createSceneObject(EMPTY_KIND, [], { x: 0, z: 0 }), y: 1 };
	const falling = cube("falling", 0, 3, 0);
	assert.deepEqual(dropToSurfacePatch(falling, [empty]), { y: 0 }, "the cube falls through the empty to the floor");
	const floor = cube("floor-box", 0, 0, 0);
	assert.deepEqual(dropToSurfacePatch(falling, [empty, floor]), { y: 1 }, "real surfaces still hold");
	assert.equal(dropToSurfacePatch(empty, [floor]), null, "dropping an empty is a no-op");
});

await check("an empty has no coplanar depth rank and does not disturb the parts' ranks", () => {
	const a = cube("a", 0, 0, 0);
	const b = cube("b", 0.5, 0, 0, { scaleZ: 0.5 });
	const base = coplanarDepthRanks([a, b]);
	assert.equal(base.get("b"), 1);
	const empty = { ...createSceneObject(EMPTY_KIND, [], { x: 0, z: 0 }), id: "root", y: 1 };
	const withEmpty = coplanarDepthRanks([empty, a, empty, b].map((row, i) => (i === 2 ? { ...row, id: "root-2" } : row)));
	assert.equal(withEmpty.has("root"), false);
	assert.equal(withEmpty.has("root-2"), false);
	assert.equal(withEmpty.get("b"), 1);
	assert.equal(coplanarDepthRanks([empty, { ...empty, id: "root-2" }]).size, 0);
});

/* ------------------------------------------------ carrying children ---- */

await check("moving an empty carries its descendants, with their routes", () => {
	const root = { ...createSceneObject(EMPTY_KIND, [], { x: 0, z: 0 }), id: "root" };
	let objects = [root, cube("a", 1, 0.5, 1), cube("b", 2, 0.5, 1, { path: { points: [{ x: 2, y: 0.5, z: 1 }, { x: 2, y: 0.5, z: 5 }] } })];
	objects = setSceneObjectParent(objects, "a", "root");
	objects = setSceneObjectParent(objects, "b", "a");
	const moved = updateSceneObject(objects, "root", { x: 3, z: -1 });
	const at = Object.fromEntries(moved.map((row) => [row.id, row]));
	assert.ok(near(at.root.x, 3) && near(at.root.z, -1));
	assert.ok(near(at.a.x, 4) && near(at.a.z, 0), "child follows");
	assert.ok(near(at.b.x, 5) && near(at.b.z, 0), "grandchild follows");
	assert.ok(near(at.b.path.points[0].x, 5) && near(at.b.path.points[1].z, 4), "a carried child takes its route along");
});

await check("a routed empty carries its children exactly like a routed cube (sceneObjectsAt)", () => {
	const route = { points: [{ x: 0, y: 0.4, z: 0 }, { x: 0, y: 0.4, z: 8 }] };
	const build = (kind) => {
		const root = { ...createSceneObject(kind, [], { x: 0, z: 0 }), id: "root", y: 0.4, path: route };
		let objects = [root, cube("cabin", -0.5, 0.8, 1), cube("wheel", 0.5, 0.2, -1)];
		for (const id of ["cabin", "wheel"]) objects = setSceneObjectParent(objects, id, "root");
		return objects;
	};
	const take = { frameCount: 120, fps: 24 };
	for (const frame of [0, 60, 119]) {
		const withCube = sceneObjectsAt(build("cube"), frame, take);
		const withEmpty = sceneObjectsAt(build(EMPTY_KIND), frame, take);
		for (const id of ["root", "cabin", "wheel"]) {
			const x = withCube.find((row) => row.id === id);
			const y = withEmpty.find((row) => row.id === id);
			assert.ok(near(x.x, y.x) && near(x.y, y.y) && near(x.z, y.z) && near(x.rot, y.rot), `frame ${frame} ${id}: empty ${JSON.stringify([y.x, y.y, y.z])} vs cube ${JSON.stringify([x.x, x.y, x.z])}`);
		}
	}
	const end = sceneObjectsAt(build(EMPTY_KIND), 119, take);
	assert.ok(end.find((row) => row.id === "wheel").z > 6.9, "the wheel travelled with the empty");
	assert.ok(near(end.find((row) => row.id === "cabin").x, -0.5), "and kept its offset");
});

await check("the Outliner model marks an empty row and nests parts under it", () => {
	const root = { ...createSceneObject(EMPTY_KIND, []), id: "root" };
	const objects = [root, { ...cube("part", 0, 0, 0), parent: "root" }];
	const props = buildHierarchyNodes(objects, []).flatMap((n) => n.children ?? []).find((n) => n.id === "props");
	assert.equal(props.children[0].id, "object:root");
	assert.equal(props.children[0].renderer, "empty");
	assert.equal(props.children[0].children[0].id, "object:part");
	assert.equal(props.children[0].children[0].renderer, undefined);
});

/* ------------------------------------------------------ pure grouping ---- */

await check("groupUnderNewEmpty: empty at the object's position, name, parent hand-over", () => {
	const objects = [cube("tree", 1, 2, 3, { name: "Tree" }), cube("rock", 0, 0, 0, { name: "Rock", parent: "tree" })];
	const grouped = groupUnderNewEmpty(objects, "rock");
	const empty = grouped.objects.find((row) => row.id === grouped.emptyId);
	assert.equal(empty.renderer, "empty");
	assert.equal(empty.name, "Rock Group");
	assert.equal(empty.parent, "tree", "the empty takes the object's old parent");
	assert.ok(near(empty.x, 0) && near(empty.z, 0) && near(empty.y, 0));
	assert.equal(grouped.objects.find((row) => row.id === "rock").parent, empty.id);
	assert.deepEqual(grouped.objects.map((row) => row.id), ["tree", empty.id, "rock"], "the empty sits just before the object");
	const lifted = groupUnderNewEmpty([cube("crate", 2, 1.5, -1, { name: "Crate" })], "crate");
	assert.equal(lifted.objects[0].y, 1.5, "y follows the object");
	const twice = groupUnderNewEmpty(lifted.objects, "crate");
	assert.equal(twice.objects.find((row) => row.id === twice.emptyId).name, "Crate Group 2", "names stay unique");
	assert.equal(groupUnderNewEmpty(objects, "nope"), null);
	assert.equal(groupUnderNewEmpty([cube("held", 0, 0, 0, { attach: { characterId: "a", bone: null } })], "held"), null);
});

/* --------------------------------------------- the command bus (real) ---- */

await check("object.add empty through the bus, undo and redo", () => {
	const f = objectsFixture();
	try {
		const before = structuredClone(f.objects.read());
		const receipt = ok(f.run("object.add", { kind: "empty", placement: { x: 1, z: 2 }, name: "Vintage Car" }));
		const id = receipt.affectedIds[0];
		const row = f.objects.read().find((entry) => entry.id === id);
		assert.equal(row.renderer, "empty");
		assert.equal(row.name, "Vintage Car");
		assert.ok(near(row.x, 1) && near(row.z, 2));
		assert.deepEqual(row.footprint, { width: 0, depth: 0 });
		// parts parent under it through the ordinary grouping command
		ok(f.run("object.group", { parent: id, children: ["cube", "sphere"] }));
		assert.equal(f.objects.read().find((entry) => entry.id === "cube").parent, id);
		const moved = ok(f.run("object.update", { id, patch: { x: 4 } }));
		assert.ok(near(f.objects.read().find((entry) => entry.id === "cube").x, 4 + (before.find((entry) => entry.id === "cube").x - 1)), "the whole assembly moved");
		assert.equal(f.run("edit.undo", { receiptId: moved.receiptId }).status, "undone");
		assert.ok(near(f.objects.read().find((entry) => entry.id === id).x, 1));
		f.actual.redoScene();
		assert.ok(near(f.objects.read().find((entry) => entry.id === id).x, 4), "redo restores the move");
		// the scene document round-trips with the empty in it
		const loaded = loadScene(serializeScene(f.objects.read()));
		assert.equal(loaded.dropped, 0);
		assert.ok(loaded.objects.some((entry) => entry.id === id && entry.renderer === "empty"));
	} finally {
		f.dispose();
	}
});

await check("object.groupUnderEmpty is one undo step and re-parents correctly", () => {
	const f = objectsFixture();
	try {
		ok(f.run("object.group", { parent: "sphere", children: ["cube"] }));
		const before = structuredClone(f.objects.read());
		const depth = f.store.current.depths().past;
		const receipt = ok(f.run("object.groupUnderEmpty", { id: "cube" }));
		const [emptyId, id] = receipt.affectedIds;
		assert.equal(id, "cube");
		const after = f.objects.read();
		const empty = after.find((row) => row.id === emptyId);
		assert.equal(empty.renderer, "empty");
		assert.equal(empty.name, "Cube Group");
		assert.equal(empty.parent, "sphere", "the empty took the cube's parent");
		assert.equal(after.find((row) => row.id === "cube").parent, emptyId);
		assert.equal(f.store.current.depths().past, depth + 1, "exactly one history entry");
		assert.equal(f.run("edit.undo", { receiptId: receipt.receiptId }).status, "undone");
		assert.deepEqual(f.objects.read(), before, "one undo removes the empty and restores the parent");
		f.actual.redoScene();
		assert.ok(f.objects.read().some((row) => row.id === emptyId), "redo brings it back");
		const missing = f.run("object.groupUnderEmpty", { id: "no-such-object" });
		assert.equal(missing.ok, false);
	} finally {
		f.dispose();
	}
});

await check("the Studio agent can build an assembly under an empty root (arrange_objects)", () => {
	const f = objectsFixture([]);
	try {
		const receipt = ok(f.run("objects.arrange", {
			ops: [
				{ op: "create", source: { kind: "empty" }, name: "Vintage Car", position: { world: { x: 0, y: 0, z: 0 } } },
				{ op: "create", source: { kind: "cube" }, name: "Chassis", parent: "Vintage Car", position: { world: { x: 0, y: 0.4, z: 0 } } },
			],
		}));
		assert.ok(receipt.affectedIds.length >= 2);
		const rows = f.objects.read();
		const root = rows.find((row) => row.name === "Vintage Car");
		assert.equal(root.renderer, "empty");
		assert.equal(rows.find((row) => row.name === "Chassis").parent, root.id);
	} finally {
		f.dispose();
	}
});

await check("the agent prompt names the empty root in one short line", () => {
	const prompt = readFileSync(new URL("../bin/agent/studio-prompt.mjs", import.meta.url), "utf8");
	assert.match(prompt, /use an empty \(kind "empty", no geometry\) as the root and parent the parts under it/);
});

if (failures > 0) {
	console.log(`${failures} check(s) failed`);
	process.exit(1);
}
console.log("empty object contract: ok");

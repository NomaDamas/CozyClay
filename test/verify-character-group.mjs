// A character grouped under a scene object (#655): the document keeps the
// link, the Outliner files the character under the object's row, and the
// object's travel hands the character a rigid carry.
import { Matrix4, Quaternion, Vector3 } from "three";
import { createCharacterEntry } from "../src/scenes.js";
import { buildHierarchyNodes } from "../src/hierarchy-model.js";
import { sceneObjectCarryMatrixAt } from "../src/object-travel.js";

let failures = 0;
const ok = (name, pass, detail = "") => {
	console.log(`${pass ? "PASS" : "FAIL"} ${name}${pass ? "" : ` — ${detail}`}`);
	if (!pass) failures += 1;
};
const near = (a, b, tol = 1e-6) => Math.abs(a - b) <= tol;
const take = { frameCount: 241, fps: 24 };
const record = (fields) => ({ y: 0, rot: 0, rotX: 0, rotZ: 0, scaleX: 1, scaleY: 1, scaleZ: 1, parent: null, attach: null, path: null, name: fields.id, ...fields });
const find = (nodes, id) => {
	for (const node of nodes ?? []) {
		if (node.id === id) return node;
		const nested = find(node.children, id);
		if (nested) return nested;
	}
	return null;
};
const parentOf = (nodes, id, parent = null) => {
	for (const node of nodes ?? []) {
		if (node.id === id) return parent;
		const nested = parentOf(node.children, id, node);
		if (nested !== undefined) return nested;
	}
	return undefined;
};

/* --- the document ---------------------------------------------------------- */

ok("a character stands in the world by default", createCharacterEntry({ id: "a" }).parent === null);
ok("a parent object id is kept", createCharacterEntry({ id: "a", parent: "cube" }).parent === "cube");
ok("junk is not a parent", createCharacterEntry({ id: "a", parent: 3 }).parent === null && createCharacterEntry({ id: "a", parent: "" }).parent === null);

/* --- the Outliner ---------------------------------------------------------- */

const chassis = record({ id: "cube", name: "Vintage Car", x: -2.2, y: 0.4, z: 0.6, scaleX: 1.3, scaleY: 0.22, scaleZ: 3.6,
	path: { points: [{ x: -2.2, y: 0.4, z: 0.6 }, { x: -2.2, y: 0.4, z: 10.6 }] } });
const cabin = record({ id: "cube-2", name: "Cabin", x: -2.2, y: 0.62, z: -0.7, parent: "cube" });
const objects = [chassis, cabin];
const cast = [
	createCharacterEntry({ id: "driver", x: -2.2, y: 0.62, z: 0, parent: "cube" }, 0),
	createCharacterEntry({ id: "walker", x: 3, z: 3 }, 1),
];
const tree = buildHierarchyNodes(objects, cast);
ok("a grouped character reads under its object's row", parentOf(tree, "characterA")?.id === "object:cube", JSON.stringify(parentOf(tree, "characterA")?.id));
ok("after the object's own parts", (() => {
	const children = find(tree, "object:cube").children.map((node) => node.id);
	return children.indexOf("object:cube-2") < children.indexOf("characterA");
})());
ok("the grouped row says so, keeps its rig and its row id", (() => {
	const row = find(tree, "characterA");
	return row.grouped === true && row.kind === "character" && row.children?.[0]?.id === "characterA.rig";
})());
ok("an ungrouped character stays in the cast", parentOf(tree, "characterB")?.id === "characters" && find(tree, "characterB").grouped === undefined);
ok("a character under a part reads under that part", (() => {
	const nested = buildHierarchyNodes(objects, [createCharacterEntry({ id: "driver", parent: "cube-2" }, 0)]);
	return parentOf(nested, "characterA")?.id === "object:cube-2";
})());
ok("a missing parent leaves the character in the cast", (() => {
	const orphan = buildHierarchyNodes(objects, [createCharacterEntry({ id: "driver", parent: "gone" }, 0)]);
	return parentOf(orphan, "characterA")?.id === "characters";
})());
ok("a parent a character carries leaves the character in the cast", (() => {
	const carried = [record({ id: "tray", attach: { characterId: "walker", bone: null } })];
	const rows = buildHierarchyNodes(carried, [createCharacterEntry({ id: "driver", parent: "tray" }, 0), createCharacterEntry({ id: "walker" }, 1)]);
	return parentOf(rows, "characterA")?.id === "characters";
})());
ok("nothing grouped: the tree is the same as before", (() => {
	const plain = buildHierarchyNodes(objects, [createCharacterEntry({ id: "a" }, 0)]);
	return parentOf(plain, "characterA")?.id === "characters" && find(plain, "object:cube").children.length === 1;
})());

/* --- the carry ------------------------------------------------------------- */

const apply = (matrix, x, y, z) => new Vector3(x, y, z).applyMatrix4(matrix);
ok("a routed object hands its travel to a rider", (() => {
	const carry = sceneObjectCarryMatrixAt(objects, "cube", 120, take);
	const seat = apply(carry, -2.2, 0.62, 0);
	return near(seat.x, -2.2) && near(seat.y, 0.62) && near(seat.z, 5);
})());
ok("the chassis's scale does not reach the rider", (() => {
	const scale = new Vector3();
	sceneObjectCarryMatrixAt(objects, "cube", 120, take).decompose(new Vector3(), new Quaternion(), scale);
	return near(scale.x, 1) && near(scale.y, 1) && near(scale.z, 1);
})());
ok("at the start the carry is identity", (() => {
	const m = sceneObjectCarryMatrixAt(objects, "cube", 0, take).elements;
	return new Matrix4().elements.every((value, index) => near(value, m[index]));
})());
ok("a turning route turns the rider about the object", (() => {
	const rows = [record({ id: "body", x: 0, z: 0, path: { points: [{ x: 0, y: 0, z: 0 }, { x: 10, y: 0, z: 0 }] } })];
	const seat = apply(sceneObjectCarryMatrixAt(rows, "body", 120, take), 0, 0.5, 1);
	return near(seat.x, 6) && near(seat.y, 0.5) && near(seat.z, 0);
})());
ok("a rider of a part travels with the routed parent above it", (() => {
	const seat = apply(sceneObjectCarryMatrixAt(objects, "cube-2", 120, take), -2.2, 0.62, -0.7);
	return near(seat.z, 4.3) && near(seat.x, -2.2);
})());
ok("an object that does not travel carries nothing", sceneObjectCarryMatrixAt([record({ id: "rock", x: 1, z: 1 })], "rock", 120, take) === null);
ok("a missing object carries nothing", sceneObjectCarryMatrixAt(objects, "gone", 120, take) === null);
ok("an object a character carries hands nothing on", sceneObjectCarryMatrixAt([{ ...chassis, attach: { characterId: "walker", bone: null } }], "cube", 120, take) === null);

if (failures) {
	console.error(`${failures} character group check(s) failed`);
	process.exit(1);
}
console.log("character group: all checks passed");

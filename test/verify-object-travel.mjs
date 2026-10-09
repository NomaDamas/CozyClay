// Travel through the grouping hierarchy: a routed parent carries every record
// grouped under it, rigidly, and records with nothing routed above them read
// exactly as they did before the carry existed.
import { Matrix4, Quaternion, Vector3 } from "three";
import { objectTransformAt } from "../src/object-path.js";
import { sceneObjectsAt, sceneObjectTravelMatrixAt } from "../src/object-travel.js";

let failures = 0;
const ok = (name, pass, detail = "") => {
	console.log(`${pass ? "PASS" : "FAIL"} ${name}${pass ? "" : ` — ${detail}`}`);
	if (!pass) failures += 1;
};
const near = (a, b, tol = 1e-6) => Math.abs(a - b) <= tol;
const take = { frameCount: 241, fps: 24 };
const byId = (rows, id) => rows.find((row) => row.id === id);
const record = (fields) => ({ y: 0, rot: 0, rotX: 0, rotZ: 0, scaleX: 1, scaleY: 1, scaleZ: 1, parent: null, attach: null, path: null, ...fields });

// The shape the Studio agent builds a vintage car in: a scaled chassis box
// with the body parts parented under it, standing 0.4 m up.
const chassis = record({
	id: "cube", x: -2.2, y: 0.4, z: 0.6, scaleX: 1.3, scaleY: 0.22, scaleZ: 3.6,
	path: { points: [{ x: -2.2, y: 0.4, z: 0.6 }, { x: -2.2, y: 0.4, z: 10.6 }] },
});
const fender = record({ id: "cube-12", x: -1.45, y: 0.74, z: 1.8, scaleX: 0.1, scaleY: 0.38, scaleZ: 0.6, parent: "cube" });
const mirror = record({ id: "mirror", x: -1.4, y: 1.0, z: 1.8, parent: "cube-12" });
const tree = record({ id: "tree", x: 5, z: 5 });
const car = [chassis, fender, mirror, tree];

/* --- straight route -------------------------------------------------------- */

const mid = sceneObjectsAt(car, 120, take);
ok("the routed chassis moves along its route", near(byId(mid, "cube").z, 5.6) && near(byId(mid, "cube").x, -2.2) && near(byId(mid, "cube").y, 0.4),
	JSON.stringify(byId(mid, "cube")));
ok("a part grouped under it moves with it, keeping its offset", near(byId(mid, "cube-12").x, -1.45) && near(byId(mid, "cube-12").y, 0.74) && near(byId(mid, "cube-12").z, 6.8),
	JSON.stringify(byId(mid, "cube-12")));
ok("a part of a part moves too", near(byId(mid, "mirror").z, 6.8) && near(byId(mid, "mirror").x, -1.4), JSON.stringify(byId(mid, "mirror")));
ok("the part keeps its own scale, not the chassis's", byId(mid, "cube-12").scaleX === 0.1 && byId(mid, "cube-12").scaleZ === 0.6);
ok("an ungrouped record stays where it was authored", byId(mid, "tree") === tree);
ok("authored records are not changed", fender.z === 1.8 && chassis.z === 0.6);
ok("at the start the group stands where it was authored", (() => {
	const first = sceneObjectsAt(car, 0, take);
	return near(byId(first, "cube-12").z, 1.8) && near(byId(first, "cube-12").x, -1.45) && near(byId(first, "mirror").z, 1.8);
})());

/* --- turning route: the group turns as one body ---------------------------- */

const turning = [
	record({ id: "body", x: 0, z: 0, path: { points: [{ x: 0, y: 0, z: 0 }, { x: 10, y: 0, z: 0 }] } }),
	record({ id: "nose", x: 0, y: 0.5, z: 1, parent: "body" }),
];
const turned = sceneObjectsAt(turning, 120, take);
ok("the routed body faces its travel (+x is yaw 90)", near(byId(turned, "body").rot, 90), String(byId(turned, "body").rot));
ok("a part in front of the body swings round with the turn", near(byId(turned, "nose").x, 5 + 1) && near(byId(turned, "nose").z, 0) && near(byId(turned, "nose").y, 0.5),
	JSON.stringify(byId(turned, "nose")));
ok("the part turns too, read back as a plain yaw", near(byId(turned, "nose").rot, 90) && byId(turned, "nose").rotX === 0 && byId(turned, "nose").rotZ === 0,
	JSON.stringify(byId(turned, "nose")));
ok("a turn past 90 still reads as one yaw", (() => {
	const back = [
		record({ id: "body", x: 0, z: 0, path: { points: [{ x: 0, y: 0, z: 0 }, { x: 0, y: 0, z: -10 }] } }),
		record({ id: "nose", x: 0, z: 1, parent: "body" }),
	];
	const row = byId(sceneObjectsAt(back, 120, take), "nose");
	return near(Math.abs(row.rot), 180) && row.rotX === 0 && row.rotZ === 0 && near(row.z, -6);
})());

/* --- a tilted part keeps its tilt relative to the body --------------------- */

ok("a pitched part under a turning body keeps the same world matrix as body ∘ offset", (() => {
	const rows = [turning[0], record({ id: "flag", x: 0, y: 1, z: 1, rotX: 30, parent: "body" })];
	const row = byId(sceneObjectsAt(rows, 120, take), "flag");
	const matrix = sceneObjectTravelMatrixAt(rows, "flag", 120, take);
	const pos = new Vector3();
	const quat = new Quaternion();
	matrix.decompose(pos, quat, new Vector3());
	const expected = new Quaternion().setFromAxisAngle(new Vector3(0, 1, 0), Math.PI / 2)
		.multiply(new Quaternion().setFromAxisAngle(new Vector3(1, 0, 0), Math.PI / 6));
	return near(pos.x, 6) && near(pos.z, 0) && Math.abs(quat.dot(expected)) > 1 - 1e-9 && near(row.x, 6);
})());

/* --- a routed part under a routed body: both motions compose --------------- */

ok("a part with its own route rides its routed parent's travel on top", (() => {
	const rows = [
		chassis,
		record({ id: "door", x: -1.45, y: 0.5, z: 0.6, parent: "cube", path: { points: [{ x: -1.45, y: 0.5, z: 0.6 }, { x: -0.45, y: 0.5, z: 0.6 }], faceTravel: false } }),
	];
	const row = byId(sceneObjectsAt(rows, 120, take), "door");
	return near(row.x, -0.95) && near(row.z, 5.6);
})());

/* --- what does not change -------------------------------------------------- */

ok("a scene with no routes is returned as the same list", (() => {
	const rows = [record({ id: "a", x: 1, z: 1 }), record({ id: "b", x: 2, z: 2, parent: "a" })];
	return sceneObjectsAt(rows, 120, take) === rows;
})());
ok("a routed record with nothing routed above it reads exactly as the route sample", (() => {
	const lone = record({ id: "lamp", x: 1, z: 1, rotX: 20, path: { points: [{ x: 0, z: 0 }, { x: -4, z: -4 }] } });
	const row = sceneObjectsAt([lone], 120, take)[0];
	const at = objectTransformAt(lone, 120, take);
	return row.x === at.x && row.y === at.y && row.z === at.z && row.rot === at.rot && row.rotX === 20;
})());
ok("records grouped under an unrouted parent stay put", (() => {
	const rows = [record({ id: "a", x: 1, z: 1 }), record({ id: "b", x: 2, z: 2, parent: "a" }), tree, record({ id: "c", x: 0, z: 0, path: chassis.path })];
	const out = sceneObjectsAt(rows, 120, take);
	return out[0] === rows[0] && out[1] === rows[1];
})());
ok("a carried prop is left to its attach frame", (() => {
	const rows = [chassis, record({ id: "cup", x: 0.1, y: 0.2, z: 0, parent: "cube", attach: { characterId: "char-a", bone: null } })];
	return byId(sceneObjectsAt(rows, 120, take), "cup") === rows[1] && sceneObjectTravelMatrixAt(rows, "cup", 120, take) === null;
})());
ok("a part under a carried parent is not walked through it", (() => {
	const rows = [
		record({ id: "tray", x: 0, z: 0, attach: { characterId: "char-a", bone: null }, path: chassis.path }),
		record({ id: "cup", x: 0.1, z: 0, parent: "tray" }),
	];
	return sceneObjectTravelMatrixAt(rows, "cup", 120, take) === null;
})());
ok("a parent cycle ends the walk instead of hanging", (() => {
	const rows = [record({ id: "a", x: 0, z: 0, parent: "b" }), record({ id: "b", x: 1, z: 0, parent: "a", path: chassis.path })];
	return sceneObjectsAt(rows, 120, take).length === 2;
})());
ok("the matrix answer accepts a lookup map as well as the list", (() => {
	const map = new Map(car.map((row) => [row.id, row]));
	const a = sceneObjectTravelMatrixAt(map, "cube-12", 120, take);
	const b = sceneObjectTravelMatrixAt(car, "cube-12", 120, take, new Matrix4());
	return a.equals(b);
})());

if (failures) {
	console.error(`${failures} object-travel check(s) failed`);
	process.exit(1);
}
console.log("object travel: all checks passed");

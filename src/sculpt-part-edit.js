// The part gizmo's arithmetic (#740 S8). Pure: no React, no DOM. A part's
// `position` and `rotation` are written in its PARENT's frame (the object
// frame for a root part), so a gizmo that moves the part in the world is
// read back through the parent: world = objectWorld × parent × local. A
// mirrored copy is edited through the part the recipe holds: the copy's own
// local values reflected across x = 0 of the same frame, which is how
// expandSculptParts derived the copy in the first place.
import * as THREE from "three";
import { SCULPT_MIRROR_SUFFIX, expandSculptParts } from "./sculpt-recipe.js";
import { tidy } from "./sculpt-recipe-read.js";

const DEG = Math.PI / 180;
// The recipe keeps 1e-4 (tidy); a field the drag left within that is unchanged.
const SAME = 1e-4;

const reflect = (local) => ({ position: [-local.position[0], local.position[1], local.position[2]], rotation: [local.rotation[0], -local.rotation[1], -local.rotation[2]] });
const wrap = (deg) => { const out = ((((deg + 180) % 360) + 360) % 360) - 180; return out === -180 ? 180 : out; };
const angleGap = (a, b) => Math.abs(wrap(a - b));

/**
 * Where the selected part is drawn, as the gizmo needs it: the drawn mesh id,
 * the object-frame matrix of the frame its values are written in (`parent`,
 * column-major), and its local position, rotation (deg, XYZ) and size. A
 * mirrored selection gives the copy's frame and values. Null when the recipe
 * has no such part.
 */
export function sculptPartFrame(recipe, selected) {
	if (!recipe?.parts || !selected?.partId) return null;
	// A cutter (op) is never drawn, so it has no mesh for the gizmo to sit on (the tree does not offer it).
	if (recipe.parts.find((part) => part.id === selected.partId)?.op) return null;
	const drawn = expandSculptParts(recipe);
	const meshId = selected.mirrored ? `${selected.partId}${SCULPT_MIRROR_SUFFIX}` : selected.partId;
	const row = drawn.find((entry) => entry.id === meshId);
	if (!row) return null;
	const parent = row.parent === undefined ? new THREE.Matrix4().toArray() : drawn.find((entry) => entry.id === row.parent).matrix;
	return { meshId, parent, position: [...row.position], rotation: [...row.rotation], size: [...row.size] };
}

/** A local transform (position, rotation in degrees XYZ, scale) as a matrix. */
function localMatrix({ position, rotation, scale = [1, 1, 1] }) {
	const quaternion = new THREE.Quaternion().setFromEuler(new THREE.Euler(rotation[0] * DEG, rotation[1] * DEG, rotation[2] * DEG, "XYZ"));
	return new THREE.Matrix4().compose(new THREE.Vector3(...position), quaternion, new THREE.Vector3(...scale));
}

/** The world matrix of the frame a part's values are written in: objectWorld × parent. */
export function partParentWorld(objectWorld, frame) {
	return objectWorld.clone().multiply(new THREE.Matrix4().fromArray(frame.parent));
}

/** Parent space → world: the matrix a part with `local` values draws at. */
export function partWorldMatrix(objectWorld, frame, local = frame) {
	return partParentWorld(objectWorld, frame).multiply(localMatrix(local));
}

/** World → parent space: the position, rotation (deg) and scale `world` has in the part's frame. */
export function partLocalFromWorld(objectWorld, frame, world) {
	const local = partParentWorld(objectWorld, frame).invert().multiply(world);
	const position = new THREE.Vector3(), quaternion = new THREE.Quaternion(), scale = new THREE.Vector3();
	local.decompose(position, quaternion, scale);
	return partLocalOf({ position, quaternion, scale });
}

/** An Object3D-like transform (position, quaternion, scale) as recipe-style local values. */
export function partLocalOf({ position, quaternion, scale }) {
	const euler = new THREE.Euler().setFromQuaternion(quaternion, "XYZ");
	return { position: position.toArray(), rotation: [euler.x / DEG, euler.y / DEG, euler.z / DEG], scale: scale.toArray() };
}

/** Shift's uniform scale: every axis takes the factor of the axis that moved furthest from 1. */
export function uniformScale(scale) {
	const lead = scale.reduce((best, value) => (Math.abs(value - 1) > Math.abs(best - 1) ? value : best), 1);
	return [lead, lead, lead];
}

/**
 * The one `object.sculpt` edit a finished drag writes: `{ set: partId,
 * position?, rotation?, size? }` with only the fields the drag changed, or
 * null when it changed nothing. `local` is the gizmo's result in the frame
 * sculptPartFrame gave (scale multiplies the size). A mirrored selection
 * writes the reflected values onto the part the recipe holds, so the pair
 * moves together. Nothing is clamped: an undrawable size goes to the command,
 * which refuses it with the reason.
 */
export function sculptPartEdit(recipe, selected, local) {
	const frame = sculptPartFrame(recipe, selected);
	if (!frame) return null;
	const moved = selected.mirrored ? reflect(local) : local;
	const authored = selected.mirrored ? reflect(frame) : frame;
	const edit = { set: selected.partId };
	const position = moved.position.map(tidy);
	if (position.some((value, axis) => Math.abs(value - authored.position[axis]) >= SAME)) edit.position = position;
	const rotation = moved.rotation.map((deg) => tidy(wrap(deg)));
	if (rotation.some((value, axis) => angleGap(value, authored.rotation[axis]) >= SAME)) edit.rotation = rotation;
	const size = frame.size.map((value, axis) => tidy(value * (local.scale?.[axis] ?? 1)));
	if (size.some((value, axis) => Math.abs(value - frame.size[axis]) >= SAME)) edit.size = size;
	return Object.keys(edit).length > 1 ? edit : null;
}

/**
 * The drag's live preview without rebuilding geometry: every drawn part's
 * object-frame matrix after `edit`, and how much the edited part's size
 * grew per axis (its meshes scale by that until the rebuilt sculpt lands).
 * `Map(meshId → { matrix, ratio })`.
 */
export function previewSculptParts(recipe, edit) {
	const parts = recipe.parts.map((part) => (part.id === edit?.set ? { ...part, ...edit } : part));
	const sizes = new Map(recipe.parts.map((part) => [part.id, part.size]));
	const out = new Map();
	for (const row of expandSculptParts({ ...recipe, parts })) {
		const source = row.id.endsWith(SCULPT_MIRROR_SUFFIX) ? row.id.slice(0, -SCULPT_MIRROR_SUFFIX.length) : row.id;
		const before = sizes.get(source) ?? row.size;
		out.set(row.id, { matrix: row.matrix, ratio: row.size.map((value, axis) => (before[axis] ? value / before[axis] : 1)) });
	}
	return out;
}

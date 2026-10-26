// sculpt-part-edit.js (#740 S8): the part gizmo's arithmetic. A part's values
// live in its parent's frame, so world ↔ parent conversions must round-trip
// through a rotated, moved parent and a rotated, scaled object; a mirrored
// copy's drag writes the reflected values onto the part the recipe holds; a
// drag writes only the fields it changed; Shift's scale is uniform; the
// preview matches what the recipe will draw.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import * as THREE from 'three';
import { expandSculptParts, normalizeSculptRecipe, patchSculptRecipe } from '../../src/sculpt-recipe.js';
import { partLocalFromWorld, partLocalOf, partWorldMatrix, previewSculptParts, sculptPartEdit, sculptPartFrame, uniformScale } from '../../src/sculpt-part-edit.js';

const normalized = normalizeSculptRecipe({ version: 1, parts: [
	{ id: 'body', shape: 'blob', size: [1, 1, 1], position: [0, 0.5, 0], rotation: [0, 0, 0] },
	{ id: 'head', parent: 'body', shape: 'blob', size: [0.6, 0.5, 0.6], position: [0.1, 0.7, -0.05], rotation: [10, 35, -20] },
	{ id: 'eye', parent: 'head', mirror: true, shape: 'blob', size: [0.12, 0.1, 0.08], position: [0.15, 0.05, 0.3], rotation: [5, 20, 15] },
	{ id: 'pupil', parent: 'eye', shape: 'blob', size: [0.05, 0.05, 0.05], position: [0.01, 0, 0.05], rotation: [0, 0, 0] },
] });
assert.equal(normalized.ok, true, normalized.error);
const recipe = normalized.recipe;
// The sculpt object itself stands turned, moved and scaled in the room.
const objectWorld = new THREE.Matrix4().compose(new THREE.Vector3(1.5, 0, -2), new THREE.Quaternion().setFromEuler(new THREE.Euler(0, 0.6, 0)), new THREE.Vector3(1.2, 1.2, 1.2));
const drawnWorld = (source, id) => objectWorld.clone().multiply(new THREE.Matrix4().fromArray(expandSculptParts(source).find((row) => row.id === id).matrix));
const close = (a, b, tolerance, label) => a.forEach((value, index) => assert.ok(Math.abs(value - b[index]) <= tolerance, `${label}[${index}]: ${value} vs ${b[index]}`));
const closeMatrix = (a, b, label) => close(a.elements, b.elements, 5e-4, label);
// A world-space nudge: move the part's world matrix by `offset` and turn it about world Y.
const nudged = (world, offset, yaw = 0) => {
	const position = new THREE.Vector3(), quaternion = new THREE.Quaternion(), scale = new THREE.Vector3();
	world.decompose(position, quaternion, scale);
	position.add(new THREE.Vector3(...offset));
	quaternion.premultiply(new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), yaw));
	return new THREE.Matrix4().compose(position, quaternion, scale);
};
const apply = (edit) => {
	const patched = patchSculptRecipe(recipe, [edit]);
	assert.equal(patched.ok, true, patched.error);
	return patched.recipe;
};

test('parent space → world draws the part where the recipe does, under a rotated parent', () => {
	for (const id of ['body', 'head', 'eye', 'pupil']) {
		const frame = sculptPartFrame(recipe, { partId: id, mirrored: false });
		closeMatrix(partWorldMatrix(objectWorld, frame), drawnWorld(recipe, id), id);
	}
	for (const id of ['eye', 'pupil']) {
		const frame = sculptPartFrame(recipe, { partId: id, mirrored: true });
		assert.equal(frame.meshId, `${id}.mirror`);
		closeMatrix(partWorldMatrix(objectWorld, frame), drawnWorld(recipe, `${id}.mirror`), `${id}.mirror`);
	}
});

test('world → parent space round-trips a child of a rotated, moved parent', () => {
	const selected = { partId: 'eye', mirrored: false };
	const frame = sculptPartFrame(recipe, selected);
	const target = nudged(partWorldMatrix(objectWorld, frame), [0.05, -0.02, 0.04], 0.3);
	const local = partLocalFromWorld(objectWorld, frame, target);
	close(local.scale, [1, 1, 1], 1e-6, 'scale');
	const edit = sculptPartEdit(recipe, selected, local);
	assert.equal(edit.set, 'eye');
	assert.ok(edit.position && edit.rotation && !edit.size, JSON.stringify(edit));
	closeMatrix(drawnWorld(apply(edit), 'eye'), target, 'eye after the edit');
	// A child rides along: the pupil keeps its place on the eye.
	closeMatrix(drawnWorld(apply(edit), 'pupil'), target.clone().multiply(new THREE.Matrix4().compose(new THREE.Vector3(0.01, 0, 0.05), new THREE.Quaternion(), new THREE.Vector3(1, 1, 1))), 'pupil follows');
});

test('a mirrored copy is dragged where it is, and the part the recipe holds takes the reflection', () => {
	const selected = { partId: 'eye', mirrored: true };
	const frame = sculptPartFrame(recipe, selected);
	const target = nudged(partWorldMatrix(objectWorld, frame), [-0.04, 0.03, 0.02], -0.25);
	const edit = sculptPartEdit(recipe, selected, partLocalFromWorld(objectWorld, frame, target));
	assert.equal(edit.set, 'eye', 'the edit names the authored part, never the copy');
	const after = apply(edit);
	closeMatrix(drawnWorld(after, 'eye.mirror'), target, 'the copy lands where it was dragged');
	// The pair stays a mirror pair: the authored eye is the copy's reflection.
	const eye = after.parts.find((part) => part.id === 'eye');
	const copy = expandSculptParts(after).find((row) => row.id === 'eye.mirror');
	close(copy.position, [-eye.position[0], eye.position[1], eye.position[2]], 1e-4, 'copy position');
	close(copy.rotation, [eye.rotation[0], -eye.rotation[1], -eye.rotation[2]], 1e-4, 'copy rotation');
	// The command itself refuses a set on the copy's id: the gizmo never sends one.
	assert.equal(patchSculptRecipe(recipe, [{ set: 'eye.mirror', position: [0, 0, 0] }]).ok, false);
});

test('a drag writes only the fields it changed, and nothing when it changed nothing', () => {
	const selected = { partId: 'head', mirrored: false };
	const frame = sculptPartFrame(recipe, selected);
	const still = { position: frame.position, rotation: frame.rotation, scale: [1, 1, 1] };
	assert.equal(sculptPartEdit(recipe, selected, still), null);
	assert.equal(sculptPartEdit(recipe, selected, { ...still, rotation: frame.rotation.map((deg) => deg + 360) }), null, 'a full turn is no turn');
	assert.deepEqual(Object.keys(sculptPartEdit(recipe, selected, { ...still, position: [0.2, 0.7, -0.05] })), ['set', 'position']);
	assert.deepEqual(sculptPartEdit(recipe, selected, { ...still, scale: [2, 1, 0.5] }), { set: 'head', size: [1.2, 0.5, 0.3] });
	assert.equal(sculptPartEdit(recipe, { partId: 'ghost', mirrored: false }, still), null);
});

test('Shift scales uniformly by the axis that moved furthest', () => {
	assert.deepEqual(uniformScale([1, 1.5, 1]), [1.5, 1.5, 1.5]);
	assert.deepEqual(uniformScale([0.8, 1, 1.1]), [0.8, 0.8, 0.8]);
	assert.deepEqual(uniformScale([1, 1, 1]), [1, 1, 1]);
	const selected = { partId: 'eye', mirrored: false };
	const frame = sculptPartFrame(recipe, selected);
	const edit = sculptPartEdit(recipe, selected, { position: frame.position, rotation: frame.rotation, scale: uniformScale([1, 1, 2]) });
	assert.deepEqual(edit, { set: 'eye', size: [0.24, 0.2, 0.16] });
});

test('an undrawable size is passed on for the command to refuse, never clamped', () => {
	const selected = { partId: 'eye', mirrored: false };
	const frame = sculptPartFrame(recipe, selected);
	const edit = sculptPartEdit(recipe, selected, { position: frame.position, rotation: frame.rotation, scale: [-1, 1, 1] });
	assert.deepEqual(edit.size, [-0.12, 0.1, 0.08]);
	const refused = patchSculptRecipe(recipe, [edit]);
	assert.equal(refused.ok, false);
	assert.match(refused.error, /size/);
});

test('the live preview is what the recipe will draw, with the size as a scale', () => {
	const edit = { set: 'eye', position: [0.2, 0.1, 0.25], size: [0.24, 0.1, 0.08] };
	const preview = previewSculptParts(recipe, edit);
	for (const row of expandSculptParts(apply(edit))) close(preview.get(row.id).matrix, row.matrix, 1e-9, row.id);
	assert.deepEqual(preview.get('eye').ratio, [2, 1, 1]);
	assert.deepEqual(preview.get('eye.mirror').ratio, [2, 1, 1], 'the copy grows with its part');
	assert.deepEqual(preview.get('pupil.mirror').ratio, [1, 1, 1]);
	assert.equal(previewSculptParts(recipe, null).size, expandSculptParts(recipe).length);
});

test('an Object3D reads back as recipe values', () => {
	const object = new THREE.Object3D();
	object.position.set(0.1, 0.2, 0.3);
	object.rotation.set(0.1, -0.2, 0.3);
	object.scale.set(1, 2, 1);
	const local = partLocalOf(object);
	close(local.position, [0.1, 0.2, 0.3], 1e-9, 'position');
	close(local.rotation, [0.1, -0.2, 0.3].map((rad) => (rad * 180) / Math.PI), 1e-9, 'rotation');
	close(local.scale, [1, 2, 1], 1e-9, 'scale');
});

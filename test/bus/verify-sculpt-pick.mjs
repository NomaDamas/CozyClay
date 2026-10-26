// sculpt-pick.js (#740 S7): a ray through a real sculpt group picks the nearest
// tagged part, a mirrored copy (and a mirrored subtree's child) resolves to the
// part the recipe holds, a miss is null, and the tree lists parents first.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import * as THREE from 'three';
import { normalizeSculptRecipe } from '../../src/sculpt-recipe.js';
import { buildSculptGroup, disposeSculptGroup } from '../../src/sculpt-geometry.js';
import { pickSculptPart, sculptPartMeshIds, sculptPartTree } from '../../src/sculpt-pick.js';

const normalized = normalizeSculptRecipe({ version: 1, parts: [
	{ id: 'body', shape: 'blob', size: [1, 1, 1], position: [0, 0.5, 0], rotation: [0, 0, 0], color: '#3f5f5a' },
	{ id: 'belly', shape: 'box', size: [0.6, 0.6, 0.1], position: [0, 0.5, 0.55], rotation: [0, 0, 0], color: '#e8d7b0' },
	{ id: 'head', shape: 'blob', size: [0.6, 0.5, 0.6], position: [0, 1.2, 0], rotation: [0, 0, 0], color: '#3f5f5a' },
	{ id: 'eye', parent: 'head', mirror: true, shape: 'blob', size: [0.12, 0.12, 0.12], position: [0.15, 0.05, 0.3], rotation: [0, 0, 0], color: '#ffffff' },
	{ id: 'pupil', parent: 'eye', shape: 'blob', size: [0.05, 0.05, 0.05], position: [0, 0, 0.07], rotation: [0, 0, 0], color: '#111111' },
] });
assert.equal(normalized.ok, true, normalized.error);
const recipe = normalized.recipe;

// A ray from the front (+z) straight back at (x, y).
function frontRay(x, y) {
	const raycaster = new THREE.Raycaster();
	raycaster.set(new THREE.Vector3(x, y, 5), new THREE.Vector3(0, 0, -1));
	return raycaster;
}

function withGroup(run) {
	const group = buildSculptGroup(recipe);
	// Under a scene object's carrier, as in the editor: picking walks descendants.
	const carrier = new THREE.Group();
	carrier.add(group);
	carrier.updateMatrixWorld(true);
	try { run(carrier); } finally { disposeSculptGroup(group); }
}

test('the nearest tagged part along the ray wins', () => {
	withGroup((root) => {
		// The belly plate stands in front of the body at the centre.
		assert.deepEqual(pickSculptPart(frontRay(0, 0.5), [root]), { partId: 'belly', mirrored: false });
		// Beside the plate the ray reaches the body itself.
		assert.deepEqual(pickSculptPart(frontRay(0.42, 0.3), [root]), { partId: 'body', mirrored: false });
		assert.deepEqual(pickSculptPart(frontRay(0.15 + 0.045, 1.25), [root]), { partId: 'eye', mirrored: false });
	});
});

test('a mirrored copy resolves to its source part', () => {
	withGroup((root) => {
		assert.deepEqual(pickSculptPart(frontRay(-0.15 - 0.045, 1.25), [root]), { partId: 'eye', mirrored: true });
		// The pupil rides the mirrored eye, so its copy resolves too.
		assert.deepEqual(pickSculptPart(frontRay(-0.15, 1.25), [root]), { partId: 'pupil', mirrored: true });
		assert.deepEqual(pickSculptPart(frontRay(0.15, 1.25), [root]), { partId: 'pupil', mirrored: false });
	});
});

test('a miss, or a hit on an untagged mesh, picks nothing', () => {
	withGroup((root) => {
		assert.equal(pickSculptPart(frontRay(3, 0.5), [root]), null);
		assert.equal(pickSculptPart(frontRay(0, 0.5), []), null);
		// A floor in front of the sculpt is passed over; the part behind it still counts.
		const floor = new THREE.Mesh(new THREE.PlaneGeometry(4, 4), new THREE.MeshBasicMaterial());
		floor.position.set(0, 0.5, 2);
		floor.updateMatrixWorld(true);
		assert.deepEqual(pickSculptPart(frontRay(0, 0.5), [floor, root]), { partId: 'belly', mirrored: false });
		assert.equal(pickSculptPart(frontRay(1.5, 0.5), [floor, root]), null);
	});
});

test('the part tree lists parents before children, with depth and mirror', () => {
	assert.deepEqual(sculptPartTree(recipe).map(({ id, depth, parent, mirror }) => ({ id, depth, parent, mirror })), [
		{ id: 'body', depth: 0, parent: null, mirror: false },
		{ id: 'belly', depth: 0, parent: null, mirror: false },
		{ id: 'head', depth: 0, parent: null, mirror: false },
		{ id: 'eye', depth: 1, parent: 'head', mirror: true },
		{ id: 'pupil', depth: 2, parent: 'eye', mirror: true },
	]);
	assert.deepEqual(sculptPartTree(null), []);
	assert.deepEqual(sculptPartMeshIds({ partId: 'eye', mirrored: true }), ['eye', 'eye.mirror']);
	assert.deepEqual(sculptPartMeshIds(null), []);
});

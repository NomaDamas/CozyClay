// The part gizmo's write (#740 S8): one finished drag is one object.sculpt
// edit through the bus, so one receipt and one history step; one undo puts
// the recipe back exactly; a refused drag writes nothing and says why.
import assert from 'node:assert/strict';
import { test, after } from 'node:test';
import { objectsFixture } from './objects-fixture.mjs';
import { sculptPartEdit, sculptPartFrame } from '../../src/sculpt-part-edit.js';

const recipe = { version: 1, parts: [
	{ id: 'head', shape: 'blob', size: [0.7, 0.6, 0.6], position: [0, 1.25, 0], rotation: [0, 30, 0] },
	{ id: 'eye', parent: 'head', mirror: true, shape: 'blob', size: [0.16, 0.16, 0.12], position: [0.17, 0.05, 0.28], rotation: [0, 0, 0] },
] };
const f = objectsFixture();
after(() => f.dispose());
const sculpt = () => f.objects.read().find((row) => row.id === id);
const id = f.run('object.sculpt', { recipe, name: 'Gizmo QA' }).affectedIds[0];
// A drag of the mirrored eye's copy, as the gizmo reads it back: moved and grown.
const drag = (scale) => {
	const selected = { partId: 'eye', mirrored: true };
	const frame = sculptPartFrame(sculpt().recipe, selected);
	return sculptPartEdit(sculpt().recipe, selected, { position: [frame.position[0] - 0.05, frame.position[1] + 0.02, frame.position[2]], rotation: frame.rotation, scale });
};

test('one drag is one receipt and one history step; one undo restores the recipe exactly', () => {
	const before = structuredClone(sculpt().recipe);
	const depth = f.objects.store.depths().past;
	const edit = drag([1.5, 1.5, 1.5]);
	assert.deepEqual(Object.keys(edit), ['set', 'position', 'size']);
	const receipt = f.run('object.sculpt', { id, edits: [edit] });
	assert.equal(receipt.ok, true, JSON.stringify(receipt));
	assert.equal(receipt.status, 'applied');
	assert.match(receipt.summary, /^Patched eye on Gizmo QA/);
	assert.equal(f.objects.store.depths().past, depth + 1, 'one undo step');
	const eye = sculpt().recipe.parts.find((part) => part.id === 'eye');
	assert.deepEqual(eye.position, [0.22, 0.07, 0.28], 'the copy moved -x, so the part moved +x');
	assert.deepEqual(eye.size, [0.24, 0.24, 0.18]);
	// The drag's own receipt owns the whole edit: undoing it is the one step back.
	assert.equal(f.run('edit.undo', { receiptId: receipt.receiptId }).status, 'undone');
	assert.deepEqual(sculpt().recipe, before, 'undo restores the recipe exactly');
	assert.equal(f.objects.store.depths().past, depth);
});

test('a refused drag writes nothing and names the reason', () => {
	const before = structuredClone(sculpt().recipe);
	const depth = f.objects.store.depths().past;
	const refused = f.run('object.sculpt', { id, edits: [drag([-1, 1, 1])] });
	assert.equal(refused.ok, false);
	assert.match(refused.message, /Recipe refused at parts\[eye\]\.size/);
	assert.deepEqual(sculpt().recipe, before);
	assert.equal(f.objects.store.depths().past, depth);
});

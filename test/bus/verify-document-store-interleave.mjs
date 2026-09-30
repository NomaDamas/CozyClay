import assert from 'node:assert/strict';
import { documentFixture } from './document-store-fixture.mjs';

const { store, bus, run, register } = documentFixture({ owned: { stage: { intensity: 1 }, shot: { frame: 0 }, objects: [] } });
register('objects.set', 'objects', ({ value }) => { store.write('objects', [{ id: 'cube', x: value }]); });
try {
  const stage = run('stage.set', { value: 2 });
  const object = run('objects.set', { value: 1 }), objectEntry = object.undo.historyEntryId;
  assert.equal(store.depths().past, 2);
  const images = [...store.history().past, store.history().present];
  assert.equal(images.slice(1).filter((entry, index) => entry.snapshot.objects !== images[index].snapshot.objects).length, 1, 'objects have exactly one stored transition');
  assert.equal(run('edit.undo', { receiptId: stage.receiptId }).code, 'UNDO_CONFLICT');
  assert.equal(store.undo().historyEntryId, objectEntry);
  assert.deepEqual(store.read('objects'), []);
  assert.equal(store.read('stage').intensity, 2);
  assert.equal(run('edit.undo', { receiptId: stage.receiptId }).status, 'undone');
  assert.equal(store.read('stage').intensity, 1);
  store.redo(); store.redo();
  assert.deepEqual(store.read('objects'), [{ id: 'cube', x: 1 }]);
  assert.equal(store.read('stage').intensity, 2);
  const newerStage = run('stage.set', { value: 3 });
  assert.equal(store.undo().historyEntryId, newerStage.undo.historyEntryId);
  assert.equal(store.undo().historyEntryId, objectEntry, 'stage and object history interleave in both directions');
  const tx = run('run.begin', { id: 'objects.set', args: { value: 1 } });
  run('run.update', { txId: tx.txId, args: { value: 3 } });
  run('run.update', { txId: tx.txId, args: { value: 4 } });
  assert.equal(run('run.cancel', { txId: tx.txId }).ok, true);
  assert.deepEqual(store.read('objects'), []);
  register('stage.composite', 'stage', ({ value }, context) => {
    store.write('stage', { intensity: value }); context.run('objects.set', { value });
  });
  const beforeDepth = store.depths().past, compound = run('stage.composite', { value: 8 });
  assert.equal(compound.ok, true, JSON.stringify(compound));
  assert.equal(store.depths().past, beforeDepth + 1, 'one receipt and one logical history entry');
  assert.equal(run('edit.undo', { receiptId: compound.receiptId }).status, 'undone');
  assert.deepEqual(store.read('objects'), []); assert.equal(store.read('stage').intensity, 2);
  store.redo();
  assert.equal(store.read('objects')[0].x, 8); assert.equal(store.read('stage').intensity, 8);
  assert.ok([...store.history().past, store.history().present, ...store.history().future].every(entry => Object.hasOwn(entry.snapshot, 'objects')));
  assert.throws(() => store.write('objects', [{ id: 'external' }]), /bus run/, 'uncoordinated edits are impossible, not just hidden from undo');
  assert.equal(store.canUndo(compound.undo.historyEntryId), true);
} finally { bus.dispose(); store.dispose(); }
console.log('PASS document store: owned object/stage ordering, wire cancellation and atomic multi-domain history');

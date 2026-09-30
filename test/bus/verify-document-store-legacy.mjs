import assert from 'node:assert/strict';
import { createDocumentStore } from '../../src/document-store.js';

// React is now a subscribed projection, never a native history owner.
const store = createDocumentStore({ owned: { cast: { name: 'Actor' } } });
let reactState = store.read('cast'), publications = 0;
const release = store.subscribe(() => { reactState = store.read('cast'); publications++; });
const before = reactState;
store.recordAction('cast', () => store.write('cast', current => ({ ...current, name: 'Edited' })));
assert.equal(reactState.name, 'Edited');
assert.equal(publications, 1);
assert.equal(store.history().past[0].snapshot.cast, before);
assert.equal(store.read('cast'), reactState);
assert.equal(store.owns('cast'), true);
assert.deepEqual(store.getSnapshot().slices, { cast: { name: 'Edited' } });
assert.ok([...store.history().past, store.history().present].every(entry => Object.hasOwn(entry.snapshot, 'cast')));
reactState = { name: 'External React update' };
assert.equal(store.read('cast').name, 'Edited', 'React cannot bypass the document owner');
const tx = store.beginAction('cast');
tx.update('cast', { name: 'Preview A' }); tx.update('cast', { name: 'Preview B' });
assert.equal(store.depths().past, 1, 'previews do not create history');
tx.cancel();
assert.equal(reactState.name, 'Edited');
assert.equal(store.depths().past, 1);
assert.deepEqual(store.getSnapshot().slices, { cast: { name: 'Edited' } });
release(); store.dispose();
console.log('PASS document store: React projects owned state and cancellation preserves committed history');

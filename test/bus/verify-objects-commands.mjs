import assert from 'node:assert/strict';
import { objectsFixture } from './objects-fixture.mjs';
import { STUDIO_ELEMENTS, isSettableElement } from '../../src/studio-elements.js';
import { createSceneObject } from '../../src/scene-objects.js';
import { readStudioFunction } from './verify-domain-modules.mjs';
const origins = ['ui', 'agent', 'mcp', 'cli'];
const changed = (receipt) => { assert.equal(receipt.ok, true, JSON.stringify(receipt)); assert.ok(receipt.undo?.historyEntryId, JSON.stringify(receipt)); return receipt; };
const patches = {
  renderer: 'sphere', position: { x: 2, y: 3, z: 4 }, rotation: { x: 10, y: 20, z: 30 }, scale: { x: 2, y: 3, z: 4 },
  name: 'Renamed', color: '#123456', parent: 'sphere', path: { points: [{ x: 0, y: 0, z: 0 }, { x: 2, y: 0, z: 1 }], speed: 2 }, remove: true,
};
assert.deepEqual(Object.keys(patches).sort(), STUDIO_ELEMENTS.filter(e => e.path.startsWith('object.') && isSettableElement(e)).map(e => e.path.slice(7)).sort());
for (const [path, value] of Object.entries(patches)) {
  const f = objectsFixture();
  try {
    const direct = changed(f.run('object.set', { id: 'cube', set: { [path]: value } }, 'agent'));
    const after = structuredClone(f.objects.store.objects);
    assert.equal(f.run('edit.undo', { receiptId: direct.receiptId }).status, 'undone');
    const alias = changed(f.binding.handlers.patch_elements(f.request('patch_elements', { ops: [{ target: { kind: 'object', id: 'cube' }, set: { [path]: value } }] })));
    assert.deepEqual(f.objects.store.objects, after, `generic/patch parity ${path}`);
    assert.equal(alias.status, 'applied', JSON.stringify(alias));
    if (path === 'remove') assert.deepEqual(alias.delta[0].after.patched, [{ path: 'object.remove', flag: true }]);
    console.log(`PASS real objects patch path ${path}`);
  } finally { f.dispose(); }
}
for (const origin of origins) {
  const f = objectsFixture();
  try {
    assert.equal(f.objects.documentStore.owns('objects'), true);
    const before = structuredClone(f.objects.store.objects);
    const receipt = changed(f.run('object.set', { id: 'cube', set: { name: 'Origin edit' } }, origin));
    assert.equal(receipt.revision.after, receipt.revision.before + 1);
    assert.equal(f.run('edit.undo', { receiptId: receipt.receiptId }, origin).status, 'undone');
    assert.deepEqual(f.objects.store.objects, before);
    const first = changed(f.run('object.rename', { id: 'cube', name: 'First' }, origin));
    for (let i = 0; i < 51; i++) changed(f.run('object.rename', { id: 'cube', name: `Retained ${i}` }, origin));
    assert.equal(f.run('edit.undo', { receiptId: first.receiptId }, origin).code, 'UNDO_EXPIRED');
    const saved = structuredClone(f.objects.store.objects);
    const tx = f.run('run.begin', { id: 'object.set', args: { id: 'cube', set: {} } }, origin);
    assert.equal(tx.ok, true, JSON.stringify(tx));
    assert.equal(f.run('run.update', { txId: tx.txId, args: { id: 'cube', set: { name: 'Cancelled' } } }, origin).ok, true);
    assert.equal(f.run('run.cancel', { txId: tx.txId }, origin).ok, true);
    assert.deepEqual(f.objects.store.objects, saved);
    const revision = f.binding.refresh().revision;
    changed(f.run('object.rename', { id: 'cube', name: 'Concurrent' }));
    const stale = f.run('object.rename', { id: 'cube', name: 'Stale' }, origin, { expectedRevision: revision });
    assert.equal(origin === 'ui' ? stale.ok : stale.code, origin === 'ui' ? true : 'STALE_SCENE');
    let ready;
    const prepared = new Promise(resolve => { ready = resolve; });
    f.registry.register({ id: 'fixture.objectsJob', label: 'Prepared object', description: 'Object fence', kind: 'job', domain: 'objects',
      input: { type: 'object', properties: {}, required: [], additionalProperties: false }, available: () => true,
      run: async (_args, context) => { await prepared; context.commit(() => f.objects.write([])); return { affectedIds: ['cube'], summary: 'Prepared' }; } });
    const job = f.run('fixture.objectsJob', {}, origin);
    changed(f.run('object.rename', { id: 'cube', name: 'Job fence' }));
    ready();
    assert.equal((await job).code, 'STALE_TARGET');
    console.log(`PASS real objects parity ${origin}: receipt, undo, expiry, transaction cancel, revision policy, concurrent job`);
  } finally { f.dispose(); }
}
{
  const f = objectsFixture();
  try {
    const clamped = changed(f.run('object.set', { id: 'cube', set: { scale: 500 } }, 'agent'));
    assert.deepEqual(['scaleX', 'scaleY', 'scaleZ'].map(key => f.objects.read()[0][key]), [100, 100, 100]);
    assert.equal(f.run('edit.undo', { receiptId: clamped.receiptId }).status, 'undone');
    const before = structuredClone(f.objects.read()), depth = f.objects.documentStore.depths().past;
    const deleted = changed(f.run('object.remove', { ids: ['cube', 'sphere', 'chair'] }, 'agent'));
    assert.deepEqual(f.objects.read(), []);
    assert.equal(f.objects.documentStore.depths().past, depth + 1);
    assert.equal(f.run('edit.undo', { receiptId: deleted.receiptId }).status, 'undone');
    assert.deepEqual(f.objects.read(), before);
    assert.throws(() => f.objects.store.applyAtomic(() => []), /bus run/);
    assert.throws(() => f.objects.write([]), /bus run/);
    const snapshot = new Function('appContext', `${readStudioFunction('snapshotActiveScene')}\nreturn snapshotActiveScene;`)(f.scope.appContext);
    f.scope.shotDocumentRef = { current: null };
    const inspected = f.binding.handlers.inspect_studio({ scope: 'document', select: ['object'] });
    assert.deepEqual(inspected.document.objects, snapshot()[0].objects);
    assert.equal(Object.hasOwn(inspected.document, 'object'), false);
    const loaded = [createSceneObject('cone')], identity = f.objects.documentStore;
    f.scope.appContext.loadStoreDomains({ objects: loaded, stage: f.stage.read(),
      cast: f.characterRef.current, shot: f.scope.shotsDomain.state() });
    assert.equal(f.objects.documentStore, identity);
    assert.deepEqual(f.objects.read(), loaded);
    assert.deepEqual(f.objects.documentStore.depths(), { past: 0, future: 0 });
    console.log('PASS clamped scalar scale, atomic bulk deletion, exact undo, write guard, persisted document and non-authored load');
  } finally { f.dispose(); }
}

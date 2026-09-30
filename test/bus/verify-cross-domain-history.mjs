import assert from 'node:assert/strict';
import { createDocumentStore } from '../../src/document-store.js';
import { registerElementKind, registerElementSet, elementSetSchema } from '../../src/commands/elements.js';
import { objectsFixture } from './objects-fixture.mjs';
for (const kind of ['fixtureEarly', 'fixtureLate']) registerElementKind(kind, {
  elements: [{ path: `${kind}.amount`, type: 'number', agentExposure: 'patch' }], normalize: value => value,
});
for (const surface of ['keyboard', 'receipt']) {
  const f = objectsFixture([]), app = f.scope.appContext, domains = [], releases = [];
  try {
    for (const kind of ['fixtureEarly', 'fixtureLate']) {
      const store = createDocumentStore({ owned: { [kind]: { amount: 0 } } });
      const domain = { documentStore: store, document: () => ({ [kind]: store.read(kind) }),
        read: () => store.read(kind), write: value => store.write(kind, value),
        beginAction: () => store.beginAction(kind), canUndo: id => store.canUndo(id),
        stepHistory: redo => Boolean((redo ? store.redo : store.undo)()) };
      domains.push(domain); releases.push(app.registerStoreDomain(kind, domain));
      registerElementSet(f.registry, f.actionHandlers.current, { id: `${kind}.set`, label: kind, description: 'History fixture',
        kind: 'mutation', undoDomain: kind, input: elementSetSchema(kind) });
    }
    const snapshot = () => structuredClone({ owned: domains.map(d => d.read()), stage: f.stage.read(),
      characters: f.actual.readStudioState().characters, objects: f.store.current.objects });
    const snapshots = [snapshot()], receipts = [];
    const edit = (id, args) => {
      const receipt = f.run(id, args);
      assert.equal(receipt.ok, true, JSON.stringify(receipt));
      receipts.push(receipt); snapshots.push(snapshot());
      return receipt;
    };
    edit('fixtureEarly.set', { amount: 1 });
    edit('fixtureLate.set', { amount: 1 });
    assert.equal(f.actual.canUndoStudioReceipt(receipts[0]), false, 'older registered domain is not the undo frontier');
    edit('character.addWaypoint', { characterId: 'actor-a', frame: 24, position: { x: 1, z: 0 } });
    edit('fixtureEarly.set', { amount: 2 });
    edit('stage.setStyle', { style: 'Cross-domain order' });
    const objectReceipt = f.binding.handlers.arrange_objects(f.request('arrange_objects', { ops: [{ op: 'create', source: { kind: 'cube' }, position: { world: { x: 1, y: 0, z: 0 } } }] }));
    assert.equal(objectReceipt.ok, true, JSON.stringify(objectReceipt));
    receipts.push(objectReceipt); snapshots.push(snapshot());
    edit('fixtureLate.set', { amount: 2 });
    for (let i = receipts.length - 1; i >= 0; i--) {
      assert.equal(f.actual.canUndoStudioReceipt(receipts[i]), true, `${surface} frontier ${i}`);
      if (surface === 'receipt') assert.equal(f.run('edit.undo', { receiptId: receipts[i].receiptId }).status, 'undone', `receipt undo ${i}`);
      else f.actual.undoScene();
      assert.deepEqual(snapshot(), snapshots[i], `${surface} reverse chronology ${i}`);
    }
    for (let i = 1; i < snapshots.length; i++) {
      f.actual.redoScene();
      assert.deepEqual(snapshot(), snapshots[i], `${surface} chronological redo ${i}`);
    }
    const clock = app.undoClock;
    f.run('fixtureLate.set', { amount: 2 });
    const tx = f.run('run.begin', { id: 'fixtureLate.set', args: {} });
    f.run('run.update', { txId: tx.txId, args: { amount: 9 } });
    f.run('run.cancel', { txId: tx.txId });
    assert.equal(app.undoClock, clock, 'noop and cancelled transactions do not stamp commits');
    assert.deepEqual(snapshot(), snapshots.at(-1));
    console.log(`PASS #480.3d ${surface}: two fixture domains, stage, cast and objects in one undo/redo order`);
  } finally { releases.forEach(release => release()); domains.forEach(d => d.documentStore.dispose()); f.dispose(); }
}

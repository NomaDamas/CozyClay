import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createAppContext } from '../../src/app-context.js';
import { createDocumentStore } from '../../src/document-store.js';
import { createStudioAppBinding } from '../../src/studio-app-binding.js';
import { createStudioActionRegistry } from '../../src/studio-actions.js';
import { createSceneStage } from '../../src/scenes.js';
import { createSceneObject } from '../../src/scene-objects.js';

function fixture() {
  const host = { workspaceId: 'workspace', documentEpoch: 'document', sceneId: 'scene', sceneEpoch: 'epoch' };
  const app = createAppContext(), store = createDocumentStore({ owned: { objects: [{ ...createSceneObject('cube'), id: 'cube' }] } });
  const domain = { documentStore: store, beginAction: () => store.beginAction('objects'), canUndo: store.canUndo,
    stepHistory: redo => Boolean((redo ? store.redo : store.undo)()) };
  app.registerStoreDomain('objects', domain);
  const registry = createStudioActionRegistry();
  registry.register({ id: 'fixture.rename', kind: 'mutation', undoDomain: 'objects', available: () => true,
    input: { type: 'object', properties: {}, required: [], additionalProperties: false },
    run() { store.write('objects', rows => rows.map(row => ({ ...row, name: 'Changed' }))); return { affectedIds: ['cube'], summary: 'Rename.' }; } });
  const ports = { revision: { current: 0 }, actions: () => registry,
    read: () => ({ host, objects: store.read('objects'), characters: [], shots: [], targets: new Map(), frameCount: 48,
      stage: createSceneStage(), view: { frame: 0 }, camera: null }),
    recordAction: app.recordAction, beginAction: app.beginAction,
    history: redo => app.historyEntry(redo),
    isRetained: receipt => Boolean(app.storeDomainForReceipt(receipt)),
    canUndo: receipt => app.historyEntry() === receipt.undo?.historyEntryId,
    undo: () => app.nextStoreHistory(false)?.stepHistory(false), redo: () => app.nextStoreHistory(true)?.stepHistory(true),
  };
  app.updatePorts({ revision: ports.revision });
  const binding = createStudioAppBinding(ports);
  const request = commandId => ({ commandId, host, expectedRevision: binding.refresh().revision });
  return { binding, store, request, dispose: () => binding.dispose() };
}
const ok = receipt => { assert.equal(receipt.ok, true, JSON.stringify(receipt)); return receipt; };
// Generated receipt ids vary by invocation; all machine-consumed evidence and
// history ids must agree. The alias is also replayed to assert exact identity.
const evidence = ({ commandId, receiptId, revision, ...rest }) => rest;

test('#494.3 undo_edit returns the bus receipt, including expiry and replay', () => {
  const f = fixture();
  try {
    const edit = ok(f.binding.bus.run('fixture.rename'));
    const direct = ok(f.binding.bus.run('edit.undo', { receiptId: edit.receiptId }));
    ok(f.binding.bus.run('edit.redo'));
    const request = { ...f.request('alias-undo'), args: { receiptId: edit.receiptId } };
    const alias = ok(f.binding.handlers.undo_edit(request));
    assert.deepEqual(evidence(alias), evidence(direct));
    assert.deepEqual(f.binding.handlers.undo_edit(request), alias, 'alias replays the same receipt');
    const missing = f.binding.handlers.undo_edit({ ...f.request('expired'), args: { receiptId: 'missing' } });
    assert.equal(missing.code, 'UNDO_EXPIRED', 'the alias must share bus refusal semantics');
  } finally { f.dispose(); }
});

test('#494.3 receipt-free keyboard controls select the same history and preserve receipt evidence', () => {
  const f = fixture();
  try {
    const before = f.store.read('objects'), edit = ok(f.binding.bus.run('fixture.rename'));
    const direct = ok(f.binding.bus.run('edit.undo', { receiptId: edit.receiptId }));
    assert.deepEqual(f.store.read('objects'), before);
    const redo = ok(f.binding.bus.run('edit.redo'));
    assert.equal(redo.action, 'edit.redo'); assert.equal(redo.undo.historyEntryId, edit.undo.historyEntryId);
    const keyboard = ok(f.binding.bus.run('edit.undo'));
    assert.deepEqual(evidence(keyboard), evidence(direct));
    assert.equal(ok(f.binding.bus.run('edit.undo')).status, 'noop');
    ok(f.binding.bus.run('edit.redo'));
    assert.equal(ok(f.binding.bus.run('edit.redo')).status, 'noop');
  } finally { f.dispose(); }
});

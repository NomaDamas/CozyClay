import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { objectsFixture } from './objects-fixture.mjs';
import { declarations } from '../../src/commands/objects.js';
const cases = {
  'object.set': { id: 'cube', set: { name: 'Generic' } },
  'object.update': { id: 'cube', patch: { x: 2 } },
  'object.add': { kind: 'cone' },
  'object.sculpt': { recipe: { parts: [{ id: 'body', shape: 'blob', size: [0.4, 0.6, 0.4], position: [0, 0.3, 0] }] } },
  'object.remove': { ids: ['cube'] },
  'object.rename': { id: 'cube', name: 'Renamed' },
  'object.group': { parent: 'sphere', children: ['cube'] },
  'object.ungroup': { children: ['cube'] },
  'object.attach': { objectId: 'cube', characterId: 'actor-a' },
  'object.detach': { objectId: 'cube' },
  'object.duplicate': { objectId: 'cube' },
  'objects.arrange': { ops: [{ op: 'update', id: 'cube', position: { world: { x: 2, y: 0, z: 1 } } }] },
};
assert.deepEqual(Object.keys(cases).sort(), declarations.filter(entry => entry.kind === 'mutation' && entry.exposure !== 'ui-only').map(entry => entry.id).sort());
// object.update is a legacy command that silently ignores unknown keys: the agent's index leaves it out (the prompt points at
// object.set / arrange_objects), while the wire keeps it for MCP's update_object, the CLI and the UI.
{
  const f = objectsFixture();
  try {
    const declared = declarations.find(entry => entry.id === 'object.update');
    assert.deepEqual([declared.exposure, declared.agentHidden], [undefined, true]);
    const listed = f.binding.handlers.inspect_studio({ scope: 'actions' }).actions.map(row => row.id);
    assert.ok(listed.includes('object.set') && listed.includes('objects.arrange') && !listed.includes('object.update'), 'inspect_studio actions omits object.update');
    assert.deepEqual(f.binding.handlers.inspect_studio({ scope: 'actions', ids: ['object.update'] }).actions, []);
    assert.ok(!f.binding.context().actionIndex.some(row => row.id === 'object.update'), 'the turn actionIndex omits object.update');
    assert.ok(f.binding.context().actionIndex.some(row => row.id === 'object.set'));
    for (const [index, origin] of ['agent', 'mcp', 'cli', 'ui'].entries()) assert.equal(f.run('object.update', { id: 'cube', patch: { x: 2 + index } }, origin).ok, true, `${origin} keeps object.update`);
    console.log('PASS object.update is hidden from the agent index; the wire keeps it for every origin');
  } finally { f.dispose(); }
}
for (const [command, args] of Object.entries(cases)) for (const origin of ['ui', 'agent', 'mcp', 'cli']) {
  const f = objectsFixture(), initial = structuredClone(f.objects.read());
  const ok = receipt => { assert.equal(receipt.ok, true, JSON.stringify(receipt)); return receipt; };
  const reset = () => {
    f.objects.load(initial);
    if (command === 'object.ungroup') ok(f.run('object.group', { parent: 'sphere', children: ['cube'] }));
    if (command === 'object.detach') ok(f.run('object.attach', { objectId: 'cube', characterId: 'actor-a' }));
  };
  try {
    reset();
    const before = structuredClone(f.objects.read());
    const receipt = ok(f.run(command, args, origin));
    assert.equal(receipt.revision.after, receipt.revision.before + 1);
    assert.ok(receipt.affectedIds.length && receipt.undo.historyEntryId);
    assert.equal(f.run('edit.undo', { receiptId: receipt.receiptId }, origin).status, 'undone');
    assert.deepEqual(f.objects.read(), before);
    reset();
    const first = ok(f.run(command, args, origin));
    for (let i = 0; i < 51; i++) ok(f.run('object.rename', { id: 'sphere', name: `Retention ${i}` }, origin));
    assert.equal(f.run('edit.undo', { receiptId: first.receiptId }, origin).code, 'UNDO_EXPIRED');
    reset();
    const saved = structuredClone(f.objects.read());
    const tx = ok(f.run('run.begin', { id: command, args }, origin));
    ok(f.run('run.update', { txId: tx.txId, args }, origin));
    ok(f.run('run.cancel', { txId: tx.txId }, origin));
    assert.deepEqual(f.objects.read(), saved);
    reset();
    const revision = f.binding.refresh().revision;
    ok(f.run('object.rename', { id: 'sphere', name: 'New revision' }));
    const stale = f.run(command, args, origin, { expectedRevision: revision });
    assert.equal(origin === 'ui' ? stale.ok : stale.code, origin === 'ui' ? true : 'STALE_SCENE');
    reset();
    let release;
    const prepared = new Promise(resolve => { release = resolve; });
    f.registry.register({ id: 'fixture.parityJob', label: 'Object job', description: 'Object job', kind: 'job', domain: 'objects',
      input: { type: 'object', properties: {}, required: [], additionalProperties: false }, available: () => true,
      run: async (_args, context) => { await prepared; context.commit(() => f.objects.write([])); return { affectedIds: ['cube'], summary: 'Prepared' }; } });
    const job = f.run('fixture.parityJob', {}, origin);
    ok(f.run(command, args, origin));
    const concurrent = structuredClone(f.objects.read());
    release();
    assert.equal((await job).code, 'STALE_TARGET');
    assert.deepEqual(f.objects.read(), concurrent);
    console.log(`PASS real objects parity ${command} ${origin}: receipt, undo, expiry, cancel, revision policy, concurrent job`);
  } finally { f.dispose(); }
}
// Retained object snapshots remain the boundary for the native cast adapter.
{
  const f = objectsFixture();
  try {
    const snapshot = () => structuredClone({ objects: f.objects.read(), stage: f.stage.read(), characters: f.actual.readStudioState().characters });
    const snapshots = [snapshot()], receipts = [];
    const edit = (id, args) => {
      const receipt = f.run(id, args);
      assert.equal(receipt.ok, true, JSON.stringify(receipt));
      receipts.push(receipt); snapshots.push(snapshot());
    };
    edit('object.rename', { id: 'cube', name: 'First object edit' });
    edit('stage.setStyle', { style: 'After object' });
    edit('character.addWaypoint', { characterId: 'actor-a', frame: 24, position: { x: 1, z: 0 } });
    edit('object.set', { id: 'cube', set: { position: { x: 3, y: 0, z: 0 } } });
    edit('stage.setStyle', { style: 'Last stage edit' });
    edit('object.remove', { ids: ['sphere', 'chair'] });
    for (let index = receipts.length - 1; index >= 0; index--) {
      assert.equal(f.actual.canUndoStudioReceipt(receipts[index]), true, `undo frontier ${index}`);
      assert.equal(f.run('edit.undo', { receiptId: receipts[index].receiptId }).status, 'undone');
      assert.deepEqual(snapshot(), snapshots[index], `undo chronology ${index}`);
    }
    for (let index = 1; index < snapshots.length; index++) {
      f.actual.redoScene();
      assert.deepEqual(snapshot(), snapshots[index], `redo chronology ${index}`);
    }
    console.log('PASS owned objects, stage and native cast share chronological receipt undo and keyboard redo');
  } finally { f.dispose(); }
}
assert.deepEqual(JSON.parse(readFileSync(new URL('./parity-pending/objects.json', import.meta.url))).pending, [], 'fully exercised objects rows are no longer pending');
console.log('PASS all 264 real objects origin/check rows; objects pending is empty');

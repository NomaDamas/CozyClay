import assert from 'node:assert/strict';
import { test } from 'node:test';
import { castFixture } from './cast-fixture.mjs';
import { STUDIO_PATCHABLE_PATHS } from '../../src/studio-agent-protocol.js';
import { createCharacterEntry } from '../../src/scenes.js';

const ok = receipt => { assert.equal(receipt.ok, true, JSON.stringify(receipt)); return receipt; };
const owned = f => assert.ok(f.cast.documentStore?.owns('cast'), 'useCast owns its document slice');
const block = { id: 'block-a', startFrame: 0, endFrame: 24, text: 'Walk' };
const cases = {
  'character.add': { character: { id: 'actor-c', subject: 'Third actor' } },
  'character.remove': { characterId: 'actor-b' },
  'character.update': { characterId: 'actor-a', patch: { x: 1 } },
  'character.setPose': { characterId: 'actor-a', pose: 'pose-wave' },
  'character.setPromptBlocks': { characterId: 'actor-a', blocks: [block] },
  'character.set': { id: 'actor-a', set: { subject: 'Changed' } },
  'character.addWaypoint': { characterId: 'actor-a', frame: 24, position: { x: 1, z: 0 } },
  'character.moveWaypoint': { characterId: 'actor-a', frame: 24, position: { x: 0.8, z: 0 } },
  'character.removeWaypoint': { characterId: 'actor-a', frame: 24 },
  'character.clearWaypoints': { characterId: 'actor-a' },
  'characters.arrange': { ops: [{ op: 'update', characterId: 'actor-a', position: { world: { x: 1, y: 0, z: 0 } } }] },
};
function seed(f, command) {
  if (['character.moveWaypoint', 'character.removeWaypoint', 'character.clearWaypoints'].includes(command))
    ok(f.run('character.addWaypoint', { characterId: 'actor-a', frame: 24, position: { x: 1, z: 0 } }));
}

test('cast: every exposed mutation and origin exercises receipt, undo, expiry, cancellation, revision and concurrent-job fences', async () => {
  for (const [command, args] of Object.entries(cases)) for (const origin of ['ui', 'agent', 'mcp', 'cli']) {
    const f = castFixture();
    try {
      owned(f); seed(f, command);
      const before = f.snapshot();
      const receipt = ok(f.run(command, args, origin));
      assert.equal(receipt.revision.after, receipt.revision.before + 1);
      assert.ok(receipt.affectedIds.length); assert.equal(receipt.undo.entries, 1);
      assert.equal(ok(f.run('edit.undo', { receiptId: receipt.receiptId }, origin)).status, 'undone');
      assert.deepEqual(f.snapshot(), before);
      const expired = ok(f.run(command, args, origin));
      for (let n = 0; n < 51; n++) ok(f.run('character.update', { characterId: 'actor-a', patch: { subject: `Retention ${n}` } }));
      assert.equal(f.run('edit.undo', { receiptId: expired.receiptId }, origin).code, 'UNDO_EXPIRED');
      f.cast.load(before.cast);
      const tx = ok(f.run('run.begin', { id: command, args }, origin));
      ok(f.run('run.update', { txId: tx.txId, args }, origin));
      ok(f.run('run.cancel', { txId: tx.txId }, origin)); assert.deepEqual(f.snapshot(), before);
      const revision = f.binding.refresh().revision;
      ok(f.run('character.update', { characterId: 'actor-a', patch: { subject: 'Concurrent' } }));
      const stale = f.run(command, args, origin, { expectedRevision: revision });
      assert.equal(origin === 'ui' ? stale.ok : stale.code, origin === 'ui' ? true : 'STALE_SCENE');
      f.cast.load(before.cast);
      let release;
      const ready = new Promise(resolve => { release = resolve; });
      f.registry.register({ id: 'fixture.castJob', label: 'Cast job', description: 'Prepared cast write', kind: 'job', domain: 'cast',
        input: { type: 'object', properties: {}, required: [], additionalProperties: false }, available: () => true,
        run: async (_args, context) => { await ready; context.commit(() => f.cast.write([])); return { affectedIds: ['actor-a'], summary: 'Prepared' }; } });
      const pending = f.run('fixture.castJob', {}, origin);
      ok(f.run(command, args, origin)); release();
      assert.equal((await pending).code, 'STALE_TARGET');
      console.log(`PASS real cast parity ${command} ${origin}: all six checks`);
    } finally { f.dispose(); }
  }
});

test('cast: prompt drag has one retained entry and agent prompt replacement restores deeply', () => {
  const f = castFixture();
  try {
    owned(f); ok(f.run('character.setPromptBlocks', { characterId: 'actor-a', blocks: [block] }));
    const before = f.snapshot(), depth = f.cast.documentStore.depths().past;
    const tx = ok(f.run('run.begin', { id: 'character.movePromptBlock', args: { characterId: 'actor-a', id: block.id, frame: 0 } }));
    for (const frame of [48, 96, 144]) ok(f.run('run.update', { txId: tx.txId, args: { characterId: 'actor-a', id: block.id, frame } }));
    const committed = ok(f.run('run.commit', { txId: tx.txId }));
    assert.equal(committed.undo.entries, 1); assert.equal(f.cast.documentStore.depths().past, depth + 1);
    assert.equal(f.cast.read()[0].layer.promptClips[0].startFrame, 144);
    ok(f.run('edit.undo', { receiptId: committed.receiptId })); assert.deepEqual(f.snapshot(), before);
    const replaced = ok(f.run('character.setPromptBlocks', { characterId: 'actor-a', blocks: [] }, 'agent'));
    ok(f.run('edit.undo', { receiptId: replaced.receiptId }, 'agent')); assert.deepEqual(f.snapshot(), before);
  } finally { f.dispose(); }
});

test('cast: selection changes only the layer projection, never the inspected document', async () => {
  const f = castFixture();
  try {
    owned(f); ok(f.run('character.setPromptBlocks', { characterId: 'actor-a', blocks: [block] }));
    ok(f.run('character.setPromptBlocks', { characterId: 'actor-b', blocks: [{ ...block, id: 'block-b', text: 'Wait' }] }));
    const before = await f.call('inspect_studio', { scope: 'document' });
    const depth = f.cast.documentStore.depths().past;
    f.cast.setActiveCharacterId('actor-b'); f.cast.switchActiveCharacterLayer();
    assert.equal(f.scope.loadedLayerCharRef.current, 'actor-b');
    assert.equal(f.buffer.current.promptClips[0].text, 'Wait');
    const after = await f.call('inspect_studio', { scope: 'document' });
    assert.deepEqual(after.document, before.document);
    assert.equal(f.cast.documentStore.depths().past, depth);
    assert.deepEqual(after.document.characters, f.cast.read().map(createCharacterEntry));
  } finally { f.dispose(); }
});

test('cast: every patchable path matches patch_elements normalization and field receipts', async () => {
  const values = { position: { x: 500, y: -3, z: 2 }, rot: 380, scale: 8, subject: 'A lead', hidden: true,
    model: 'x-bot-tpose', tint: '#123456', identityImage: 'data:image/png;base64,QQ==', pose: 'pose-wave',
    promptBlocks: [block], 'motionRef.url': '/ardy/motions/123456-abcdef', 'motionRef.motionId': 'a'.repeat(64) };
  assert.deepEqual(Object.keys(values).map(key => `character.${key}`).sort(), [...STUDIO_PATCHABLE_PATHS.character].sort());
  for (const [path, value] of Object.entries(values)) {
    const a = castFixture(), b = castFixture();
    try {
      owned(a); owned(b);
      const storedPath = path === 'promptBlocks' ? 'layer.promptClips' : path;
      const set = storedPath.split('.').reduceRight((value, key) => ({ [key]: value }), value);
      const direct = ok(a.run('character.set', { id: 'actor-a', set }, 'agent'));
      const alias = ok(await b.call('patch_elements', b.request('patch_elements', { ops: [{ target: { kind: 'character', id: 'actor-a' }, set: { [path]: value } }] })));
      assert.deepEqual(a.cast.read(), b.cast.read(), path);
      assert.deepEqual(direct.delta[0].after.patched.filter(row => row.path === `character.${path}`), alias.delta[0].after.patched, path);
      assert.equal(direct.undo.entries, alias.undo.entries);
    } finally { a.dispose(); b.dispose(); }
  }
});

test('cast: raw setters are guarded and scene load resets history without authoring', () => {
  const f = castFixture();
  try {
    owned(f); assert.equal(f.cast.setCharacters, undefined, 'the raw hook setter is retired');
    assert.throws(() => f.cast.write([]), /requires a bus run/);
    ok(f.run('character.update', { characterId: 'actor-a', patch: { x: 1 } }));
    const incoming = [createCharacterEntry({ id: 'loaded', layer: { waypoints: [], promptClips: [block] } })];
    f.scope.appContext.loadStoreDomains({ cast: incoming, objects: f.store.current.objects,
      stage: f.live.current.stage, shot: f.scope.shotsDomain.state() });
    assert.deepEqual(f.cast.read(), incoming); assert.equal(f.cast.documentStore.depths().past, 0);
    assert.deepEqual(f.buffer.current.promptClips, [block]);
  } finally { f.dispose(); }
});

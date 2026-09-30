import assert from 'node:assert/strict';
import { test } from 'node:test';
import { motionFixture, seedMotion } from './motion-fixture.mjs';
import { generationFixture } from './generation-fixture.mjs';
import { installGenerated as install, prepareGeneration } from './install-generated-motion.mjs';
const ok = receipt => { assert.equal(receipt.ok, true, JSON.stringify(receipt)); return receipt; };
const snapshot = f => ({ motion: f.snapshot(), cast: structuredClone(f.cast.documentStore.getSnapshot().slices), shots: structuredClone(f.scope.shotsDomain.state()) });
test('motion: generated publication, pose clear and receipt undo use only owned history', async () => {
  const f = generationFixture();
  try {
    f.scope.shotsDomain.load({ ...f.scope.shotsDomain.state(), camera: f.actual.readStudioCamera() });
    prepareGeneration(f);
    const before = snapshot(f), installed = ok(await install(f));
    assert.ok(f.motion.motionFor('actor-a')); assert.deepEqual(f.motion.documentStore.depths(), { past: 1, future: 0 });
    ok(f.run('edit.undo', { receiptId: installed.receiptId })); assert.deepEqual(snapshot(f), before);
    ok(await install(f)); const loaded = snapshot(f);
    const posed = ok(f.run('character.setPose', { characterId: 'actor-a', pose: 'pose-wave', clearMotion: true }));
    assert.equal(f.motion.motionFor('actor-a'), null); assert.equal(f.cast.read()[0].pose.id, 'pose-wave');
    ok(f.run('edit.undo', { receiptId: posed.receiptId })); assert.deepEqual(snapshot(f), loaded);
    assert.deepEqual(f.motion.documentStore.depths(), { past: 1, future: 1 }, 'pose undo leaves exactly the installed take and one redo');
  } finally { f.dispose(); }
});
test('motion: selection switches runtime take and IK projections without rewriting document intent', async () => {
  const f = motionFixture();
  try {
    const take = seedMotion(); f.motion.load([{ id: 'actor-a', take }, { id: 'actor-b', take: { ...take, anchorX: 4 } }]);
    ok(f.run('ik.setKey', { characterId: 'actor-b', frame: 0, tracks: { head: { q: [{ x: 0, y: 0, z: 0, w: 1 }] } } }));
    const before = await f.call('inspect_studio', { scope: 'document' });
    f.cast.setActiveCharacterId('actor-b'); f.cast.switchActiveCharacterLayer();
    assert.equal(f.buffer.current.motion.anchorX, 4); assert.equal(f.scope.ikStateRef.current.keys.size, 1);
    assert.deepEqual((await f.call('inspect_studio', { scope: 'document' })).document, before.document);
    f.cast.setActiveCharacterId('actor-a'); f.cast.switchActiveCharacterLayer();
    assert.equal(f.scope.ikStateRef.current.keys.size, 0);
  } finally { f.dispose(); }
});
test('motion: removing a cast member and undo restore its take and keys as one composed entry', () => {
  const f = motionFixture();
  try {
    const take = seedMotion(); f.motion.load([{ id: 'actor-a' }, { id: 'actor-b', take }]);
    ok(f.run('ik.setKey', { characterId: 'actor-b', frame: 0, tracks: { head: { q: [{ x: 0, y: 0, z: 0, w: 1 }] } } }));
    const before = snapshot(f), removed = ok(f.run('character.remove', { characterId: 'actor-b' }));
    assert.equal(f.motion.motionFor('actor-b'), null); assert.equal(f.scope.motionFullRef.current.has('actor-b'), false);
    ok(f.run('edit.undo', { receiptId: removed.receiptId })); assert.deepEqual(snapshot(f), before);
    assert.ok(f.motion.motionFor('actor-b')); assert.equal(f.scope.ikStatesRef.current.get('actor-b').keys.size, 1);
  } finally { f.dispose(); }
});

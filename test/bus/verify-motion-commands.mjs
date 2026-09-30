import assert from 'node:assert/strict';
import { test } from 'node:test';
import * as THREE from 'three';
import { motionFixture, seedMotion } from './motion-fixture.mjs';
import { resolveIkRig, solveIk } from '../../src/ardy/ik.js';
import { declarations } from '../../src/commands/motion.js';
const ok = receipt => { assert.equal(receipt.ok, true, JSON.stringify(receipt)); return receipt; };
const owned = f => assert.ok(f.motion.documentStore?.owns('motion'), 'the shipped useMotion hook owns motion/IK intent');
const unit = { x: 0, y: 0, z: 0, w: 1 };
const tracks = { head: { q: [{ x: 0, y: Math.sin(0.2), z: 0, w: Math.cos(0.2) }] } };
function seed(f) {
  const take = seedMotion();
  f.motion.load([{ id: 'actor-a', take, fullTake: take }, { id: 'actor-b' }]);
  return take;
}
function collide(f) {
  const rig = f.rigs['actor-a'], resolved = resolveIkRig(rig);
  const chest = rig.getObjectByName('mixamorigSpine1');
  assert.ok(resolved && chest);
  solveIk(resolved.chains.get('leftHand'), chest.getWorldPosition(new THREE.Vector3()));
  rig.updateMatrixWorld(true);
}
const pin = { id: 'parity-pin', track: 'leftFoot', startFrame: 5, endFrame: 5, blend: 6, reach: 'limb', target: { space: 'world', position: [0, 0, 0] } };
const cases = {
  'motion.rangePin.apply': () => ({ characterId: 'actor-a', pin }),
  'motion.rangePin.remove': () => ({ characterId: 'actor-a', pinId: pin.id }),
  'motion.clear': () => ({ characterId: 'actor-a' }),
  'motion.trim': () => ({ characterId: 'actor-a', start: 4, end: 39 }),
  'motion.resetTrim': () => ({ characterId: 'actor-a' }),
  'motion.cut': () => ({ characterId: 'actor-a', frame: 24 }),
  'motion.setSegmentSpeed': f => ({ characterId: 'actor-a', id: f.motion.motionFor('actor-a').editSegments[0].id, speed: 2 }),
  'motion.removeSegment': f => ({ characterId: 'actor-a', id: f.motion.motionFor('actor-a').editSegments[0].id }),
  'motion.set': () => ({ id: 'actor-a', set: { take: { anchorX: 2 } } }),
  'motion.fixCollisions': () => ({ characterId: 'actor-a', scope: 'frame' }),
  'motion.applyPhysics': () => ({ characterId: 'actor-a' }),
  'motion.editTrail': () => ({ characterId: 'actor-a', grabFrame: 12, radiusFrames: 6, delta: { x: 0.2, y: 0, z: 0 } }),
  'ik.applyPose': () => ({ characterId: 'actor-a', frame: 0, pose: { bones: {}, rootY: 0 } }),
  ...Object.fromEntries(['ik.setKey', 'character.setIkKey'].map(id => [id, () => ({ characterId: 'actor-a', frame: 0, tracks })])),
  ...Object.fromEntries(['ik.removeKey', 'character.removeIkKey'].map(id => [id, () => ({ characterId: 'actor-a', frame: 0 })])),
  ...Object.fromEntries(['ik.clearKeys', 'character.clearIkKeys'].map(id => [id, () => ({ characterId: 'actor-a' })])),
};
async function prepare(f, command) {
  seed(f);
  if (command === 'motion.rangePin.remove') ok(f.run('motion.rangePin.apply', { characterId: 'actor-a', pin }));
  if (command === 'motion.applyPhysics') {
    const take = seedMotion(12);
    for (let frame = 0; frame < take.frames; frame++) {
      take.rootPos[frame * 3 + 1] -= 0.05;
      for (let joint = 0; joint < 27; joint++) take.posedJoints[frame * 81 + joint * 3 + 1] -= 0.05;
    }
    f.motion.load([{ id: 'actor-a', take }, { id: 'actor-b' }]);
    ok(await f.run('motion.autoPhysics', { characterId: 'actor-a', apply: false }));
  }
  if (command.includes('removeKey') || command.includes('removeIkKey') || command.includes('clearKeys') || command.includes('clearIkKeys')) ok(f.run('ik.setKey', { characterId: 'actor-a', frame: 0, tracks: { head: { q: [unit] } } }));
  if (command === 'motion.resetTrim') ok(f.run('motion.trim', { characterId: 'actor-a', start: 4, end: 39 }));
  if (command === 'motion.removeSegment') ok(f.run('motion.cut', { characterId: 'actor-a', frame: 24 }));
  if (command === 'motion.fixCollisions') collide(f);
}

test('motion: owned intent and inspect include take, recipes, versions and JSON IK; mutable input buffers cannot rewrite history', async () => {
  const f = motionFixture();
  try {
    owned(f); const take = seed(f), original = take.rootPos[0];
    take.rootPos[0] += 10;
    assert.equal(f.motion.motionFor('actor-a').rootPos[0], original);
    const doc = await f.call('inspect_studio', { scope: 'document', select: ['motion'] });
    assert.equal(doc.document.motion[0].take.frames, 48);
    assert.deepEqual(doc.document.motion[0].ikKeys, []);
    assert.deepEqual(doc.document.motion[0].takeVersions, []);
    assert.equal(doc.document.motion[0].takeRecipe, null);
    assert.throws(() => f.motion.write(rows => rows.map(row => ({ ...row, ikKeys: [] }))), /requires a bus run/);
  } finally { f.dispose(); }
});

test('motion: an agent IK key and undo restore both the authored key layer and exact rig preimage', () => {
  const f = motionFixture();
  try {
    owned(f); seed(f);
    const before = f.snapshot(), rig = f.actual.snapshotExportRig(f.rigs['actor-a']);
    const keyed = ok(f.run('ik.setKey', { characterId: 'actor-a', frame: 0, tracks }, 'agent'));
    assert.equal(f.scope.ikStateRef.current.keys.has(0), true);
    assert.notDeepEqual(f.actual.snapshotExportRig(f.rigs['actor-a']), rig);
    assert.equal(ok(f.run('edit.undo', { receiptId: keyed.receiptId }, 'agent')).status, 'undone');
    assert.deepEqual(f.snapshot(), before); assert.deepEqual(f.actual.snapshotExportRig(f.rigs['actor-a']), rig);
    assert.deepEqual(f.motion.documentStore.depths(), { past: 0, future: 1 });
    assert.equal(f.cast.documentStore.depths().past, 0, 'IK does not duplicate history in cast');
  } finally { f.dispose(); }
});

test('motion: trim drag previews from one retained take and commits exactly one undo entry', () => {
  const f = motionFixture();
  try {
    owned(f); seed(f); const before = f.snapshot();
    const tx = ok(f.run('run.begin', { id: 'motion.trim', args: { characterId: 'actor-a', start: 0, end: 47 } }));
    for (const end of [43, 39, 35]) ok(f.run('run.update', { txId: tx.txId, args: { characterId: 'actor-a', start: 0, end } }));
    assert.equal(f.motion.documentStore.depths().past, 0);
    const committed = ok(f.run('run.commit', { txId: tx.txId }));
    assert.equal(committed.undo.entries, 1); assert.equal(f.motion.documentStore.depths().past, 1);
    assert.equal(f.motion.motionFor('actor-a').frames, 36);
    ok(f.run('edit.undo', { receiptId: committed.receiptId })); assert.deepEqual(f.snapshot(), before);
  } finally { f.dispose(); }
});

test('motion: real collision correction is undoable without changing the underlying take', () => {
  const f = motionFixture();
  try {
    owned(f); seed(f); collide(f);
    const before = f.snapshot(), take = structuredClone(f.motion.motionFor('actor-a')), rig = f.actual.snapshotExportRig(f.rigs['actor-a']);
    const fixed = ok(f.run('motion.fixCollisions', { characterId: 'actor-a', scope: 'frame' }));
    assert.equal(fixed.authored, true); assert.ok(f.motion.read()[0].ikKeys.length);
    ok(f.run('edit.undo', { receiptId: fixed.receiptId }));
    assert.deepEqual(f.snapshot(), before); assert.deepEqual(f.motion.motionFor('actor-a'), take);
    assert.deepEqual(f.actual.snapshotExportRig(f.rigs['actor-a']), rig);
  } finally { f.dispose(); }
});

test('motion: every mutation origin exercises receipt, undo, expiry, cancellation, revision and concurrent-job fences', async () => {
  assert.deepEqual(Object.keys(cases).sort(), declarations.filter(entry => entry.kind === 'mutation' && entry.exposure !== 'ui-only').map(entry => entry.id).sort());
  for (const [command, input] of Object.entries(cases)) for (const origin of ['ui', 'agent', 'mcp', 'cli']) {
    const f = motionFixture();
    try {
      owned(f); await prepare(f, command); const args = input(f), before = f.snapshot();
      const receipt = ok(f.run(command, args, origin));
      assert.ok(receipt.authored); assert.ok(receipt.affectedIds.length); assert.equal(receipt.undo.entries, 1);
      ok(f.run('edit.undo', { receiptId: receipt.receiptId }, origin)); assert.deepEqual(f.snapshot(), before);
      if (command === 'motion.fixCollisions') collide(f);
      const expired = ok(f.run(command, args, origin));
      for (let n = 0; n < 51; n++) ok(f.run('ik.setKey', { characterId: 'actor-b', frame: 0, tracks: { hips: { p: { x: n + 1, y: 0, z: 0 } } } }));
      assert.equal(f.run('edit.undo', { receiptId: expired.receiptId }, origin).code, 'UNDO_EXPIRED');
      await prepare(f, command); const saved = f.snapshot(), tx = ok(f.run('run.begin', { id: command, args: input(f) }, origin));
      ok(f.run('run.update', { txId: tx.txId, args: input(f) }, origin));
      ok(f.run('run.cancel', { txId: tx.txId }, origin)); assert.deepEqual(f.snapshot(), saved);
      await prepare(f, command); const revision = f.binding.refresh().revision;
      ok(f.run('ik.setKey', { characterId: 'actor-b', frame: 0, tracks }));
      const stale = f.run(command, input(f), origin, { expectedRevision: revision });
      assert.equal(origin === 'ui' ? stale.ok : stale.code, origin === 'ui' ? true : 'STALE_SCENE');
      await prepare(f, command);
      let release; const ready = new Promise(resolve => { release = resolve; });
      f.registry.register({ id: 'fixture.motionJob', label: 'Motion job', description: 'Prepare then publish', kind: 'job', domain: 'motion',
        input: { type: 'object', properties: {}, required: [], additionalProperties: false }, available: () => true,
        run: async (_args, context) => { await ready; context.commit(() => f.motion.write([])); return { affectedIds: ['actor-a'], summary: 'Prepared' }; } });
      const job = f.run('fixture.motionJob', {}, origin); ok(f.run(command, input(f), origin)); release();
      assert.equal((await job).code, 'STALE_TARGET');
      console.log(`PASS real motion parity ${command} ${origin}: all six checks`);
    } finally { f.dispose(); }
  }
});

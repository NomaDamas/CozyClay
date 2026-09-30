import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readFileSync } from 'node:fs';
import { motionFixture, seedMotion } from './motion-fixture.mjs';
const ok = value => { assert.equal(value.ok, true, JSON.stringify(value)); return value; };
test('motion: the shipped IK drag handler records the pre-drag rig, not its already-dragged pose', () => {
  const f = motionFixture();
  try {
    f.motion.load([{ id: 'actor-a', take: seedMotion() }]);
    const hook = f.renderMotion(), before = f.snapshot(), rig = f.actual.snapshotExportRig(f.rigs['actor-a']);
    hook.beginGesture(); f.scope.ikStateRef.current.tracked.add('head');
    f.rigs['actor-a'].getObjectByName('mixamorigHead').quaternion.setFromAxisAngle({ x: 0, y: 1, z: 0 }, 0.25);
    hook.ikDragEnd(); hook.finishGesture();
    assert.equal(hook.layer('actor-a').ikKeys.length, 1);
    assert.deepEqual(hook.documentStore.depths(), { past: 1, future: 0 }); assert.equal(f.cast.documentStore.depths().past, 0, 'IK does not duplicate history in cast');
    f.actual.undoScene();
    assert.deepEqual(f.snapshot(), before); assert.deepEqual(f.actual.snapshotExportRig(f.rigs['actor-a']), rig);
  } finally { f.dispose(); }
});
test('motion: a shipped trail drag commits its deformed take once without native cast history', () => {
  const f = motionFixture();
  try {
    f.motion.load([{ id: 'actor-a', take: seedMotion() }]);
    const hook = f.renderMotion(), before = f.snapshot();
    hook.onTrailDragStart(); assert.deepEqual(hook.documentStore.depths(), { past: 0, future: 0 });
    const input = { track: 'hips', grabFrame: 12, delta: { x: 0.2, y: 0, z: 0 } };
    hook.onTrailDragPreview(input); assert.deepEqual(f.snapshot(), before);
    hook.onTrailDragEnd(input); assert.equal(hook.documentStore.depths().past, 1);
    assert.notDeepEqual(f.snapshot(), before); f.actual.undoScene(); assert.deepEqual(f.snapshot(), before);
  } finally { f.dispose(); }
});
test('motion: AutoPhysics previews real rig corrections, applies them atomically, and undo restores the take and rig', { timeout: 20000 }, async () => {
  const f = motionFixture();
  try {
    const take = seedMotion(12);
    for (let frame = 0; frame < take.frames; frame++) {
      take.rootPos[frame * 3 + 1] -= 0.05;
      for (let joint = 0; joint < 27; joint++) take.posedJoints[frame * 81 + joint * 3 + 1] -= 0.05;
    }
    f.motion.load([{ id: 'actor-a', take }]);
    const before = f.snapshot(), rig = f.actual.snapshotExportRig(f.rigs['actor-a']);
    const analysed = ok(await f.run('motion.autoPhysics', { characterId: 'actor-a', apply: false }));
    assert.deepEqual(f.snapshot(), before); assert.equal(f.motion.documentStore.depths().past, 0);
    assert.ok(analysed.output.changedFrames > 0);
    const applied = ok(f.run('motion.applyPhysics', { characterId: 'actor-a' }));
    assert.ok(f.motion.layer('actor-a').ikKeys.length); assert.equal(applied.undo.entries, 1);
    ok(f.run('edit.undo', { receiptId: applied.receiptId })); assert.deepEqual(f.snapshot(), before);
    assert.deepEqual(f.actual.snapshotExportRig(f.rigs['actor-a']), rig);
  } finally { f.dispose(); }
});
test('motion: authored panel handlers dispatch semantic run commands', () => {
  const source = ['panels/RigControlPanel.jsx', 'panels/TakeBarPanel.jsx', 'ardy/physics-panel.jsx'].map(path => readFileSync(new URL(`../../src/${path}`, import.meta.url), 'utf8')).join('\n');
  const ids = new Set([...source.matchAll(/\brun\(['"](motion\.[^'"]+)['"]/g)].map(match => match[1]));
  for (const id of ['motion.fixCollisions', 'motion.autoPhysics', 'motion.applyPhysics', 'motion.loadVersion']) assert.ok(ids.has(id), id);
});

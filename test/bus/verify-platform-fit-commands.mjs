import assert from 'node:assert/strict';
import { test } from 'node:test';
import { motionFixture, seedMotion } from './motion-fixture.mjs';
const ok = receipt => { assert.equal(receipt.ok, true, JSON.stringify(receipt)); return receipt; };
function setup() {
  const f = motionFixture();
  f.motion.load([{ id: 'actor-a', take: seedMotion(24) }, { id: 'actor-b' }]);
  ok(f.run('object.add', { kind: 'cube' }));
  // This fixture's raw sole is 0.404 m above ground: a 0.6 m top is a 20 cm step.
  ok(f.run('object.set', { id: 'cube', set: { scale: { x: 4, y: 0.6, z: 4 } } }));
  return f;
}
for (const origin of ['ui', 'agent', 'mcp', 'cli']) test(`platform fit: ${origin} applies, removes and undoes through the owned commands`, async () => {
  const f = setup(), args = { characterId: 'actor-a' };
  try {
    const before = f.snapshot();
    const fit = ok(await f.run('motion.platformFit.run', args, origin));
    assert.equal(fit.authored, false);
    assert.equal(fit.undo?.entries ?? 0, 0);
    assert.equal(fit.output.summary.lifted, 2);
    assert.equal(fit.output.changedFrames.length, 24);
    assert.deepEqual(f.snapshot(), before, 'Preview does not mutate authored keys');
    const applied = ok(await f.run('motion.platformFit.remove', { ...args, apply: true }, origin));
    assert.notDeepEqual(f.snapshot(), before);
    assert.equal(applied.undo.entries, 1);
    const fitted = f.snapshot();
    const removed = ok(await f.run('motion.platformFit.remove', args, origin));
    assert.equal(removed.undo.entries, 1);
    assert.deepEqual(f.snapshot(), before, 'Remove restores the exact pre-fit keys after their JSON round trip');
    ok(f.run('edit.undo', { receiptId: removed.receiptId }, origin));
    assert.deepEqual(f.snapshot(), fitted, 'Remove itself is undoable');
    ok(f.run('edit.undo', { receiptId: applied.receiptId }, origin));
    assert.deepEqual(f.snapshot(), before, 'Fit itself is undoable');
  } finally { f.dispose(); }
});
test('platform fit: a concurrent authored edit refuses stale results without overwriting keys', async () => {
  const f = setup();
  try {
    const fitting = f.run('motion.platformFit.run', { characterId: 'actor-a' });
    ok(f.run('ik.setKey', { characterId: 'actor-a', frame: 0, tracks: { head: { q: [{ x: 0, y: 0, z: 0, w: 1 }] } } }));
    const edited = f.snapshot();
    assert.equal((await fitting).code, 'STALE_TARGET');
    assert.deepEqual(f.snapshot(), edited);
  } finally { f.dispose(); }
});

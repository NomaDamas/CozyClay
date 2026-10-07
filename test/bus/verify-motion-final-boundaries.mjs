import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readFileSync } from 'node:fs';
import { motionFixture, seedMotion } from './motion-fixture.mjs';
const ok = receipt => { assert.equal(receipt.ok, true, JSON.stringify(receipt)); return receipt; };
test('motion: cast pose application clears the named inactive character, not the active take', () => {
  const f = motionFixture();
  try {
    f.motion.load([{ id: 'actor-a', take: seedMotion() }, { id: 'actor-b', take: seedMotion() }]);
    const before = f.snapshot(), cast = structuredClone(f.cast.read());
    const receipt = ok(f.run('character.setPose', { characterId: 'actor-b', pose: 'pose-wave', clearMotion: true }));
    assert.equal(f.motion.motionFor('actor-b'), null); assert.ok(f.motion.motionFor('actor-a'));
    ok(f.run('edit.undo', { receiptId: receipt.receiptId })); assert.deepEqual(f.snapshot(), before); assert.deepEqual(f.cast.read(), cast);
  } finally { f.dispose(); }
});
test('motion: clear removes prompt blocks with the take and undo restores both', () => {
  const f = motionFixture();
  try {
    f.motion.load([{ id: 'actor-a', take: seedMotion() }]);
    ok(f.run('character.setPromptBlocks', { characterId: 'actor-a', blocks: [{ startFrame: 0, endFrame: 48, text: 'Walk forward' }] }));
    const before = f.snapshot(), cast = structuredClone(f.cast.read());
    const receipt = ok(f.run('motion.clear', { characterId: 'actor-a' }));
    assert.equal(f.motion.motionFor('actor-a'), null);
    assert.deepEqual(f.cast.read()[0].layer.promptClips, []);
    ok(f.run('edit.undo', { receiptId: receipt.receiptId }));
    assert.deepEqual(f.snapshot(), before);
    assert.deepEqual(f.cast.read(), cast);
  } finally { f.dispose(); }
});
test('motion: owned gesture recording needs no native cast history', () => {
  const f = motionFixture();
  try {
    f.motion.load([{ id: 'actor-a', take: seedMotion() }]);
    f.motion.beginGesture();
    assert.deepEqual(f.motion.documentStore.depths(), { past: 0, future: 0 }, 'arming a gesture records nothing');
    assert.equal(f.cast.recordCharacterUndo, undefined);
    f.motion.finishGesture(true);
  } finally { f.dispose(); }
});
test('motion: non-authored scene hydration exposes decoded take metadata and cannot resurrect a cleared take', async () => {
  const f = motionFixture();
  try {
    const reference = { url: '/ardy/motions/123456-abcdef', prompt: 'Stored', anchorX: 0, anchorZ: 0, rotationDeg: 0 };
    f.cast.load(f.cast.read().map(row => row.id === 'actor-a' ? { ...row, motionRef: reference } : row));
    f.motion.load(f.motion.sceneSlice({ cast: f.cast.read() }));
    const before = f.snapshot(), take = seedMotion();
    assert.equal(f.motion.hydrate('actor-a', take, f.cast.read()[0].motionRef), true);
    assert.deepEqual(f.snapshot(), before); assert.equal(f.motion.documentStore.depths().past, 0);
    const doc = await f.call('inspect_studio', { scope: 'document' }); assert.equal(doc.document.motion[0].take.frames, 48);
    const receipt = ok(f.run('motion.clear', { characterId: 'actor-a' }));
    assert.equal(f.motion.hydrate('actor-a', take, reference), false);
    ok(f.run('edit.undo', { receiptId: receipt.receiptId })); assert.equal(f.motion.motionFor('actor-a').frames, 48);
  } finally { f.dispose(); }
});
test('motion: line commit and trail regeneration have bus entry points without replacing the generation pipeline', () => {
  const f = motionFixture();
  try { for (const id of ['motion.commitLineEdit', 'motion.regenerateTrail']) assert.ok(f.registry.ids().includes(id), id); }
  finally { f.dispose(); }
});
test('motion: measured ratchet is recomputed and all real parity rows are off pending', async () => {
  const { scanTree } = await import('./verify-bus-coverage.mjs');
  const references = scanTree(new URL('../../src', import.meta.url).pathname);
  const baseline = JSON.parse(readFileSync(new URL('./baseline.json', import.meta.url)));
  assert.equal(baseline.coverage.writerReferences, references.length);
  const writers = {};
  for (const ref of references) { const key = `${ref.file}::${ref.function}`; writers[key] = (writers[key] ?? 0) + 1; }
  assert.deepEqual(baseline.writers, writers);
  assert.deepEqual(JSON.parse(readFileSync(new URL('./parity-pending/motion.json', import.meta.url))).pending, []);
});

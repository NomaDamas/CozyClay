import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { motionArraysToNpzMembers, writeNpz } from '../../tools/ardy/npz.mjs';
import { motionFixture, seedMotion } from './motion-fixture.mjs';
const ok = value => { assert.equal(value.ok, true, JSON.stringify(value)); return value; };
const dir = mkdtempSync(join(tmpdir(), 'motion-owned-npz-'));
let bytes;
try { const path = join(dir, 'take.npz'); writeNpz(path, motionArraysToNpzMembers(seedMotion())); bytes = new Uint8Array(readFileSync(path)); }
finally { rmSync(dir, { recursive: true, force: true }); }
const url = 'https://motion.invalid/take.npz';
function stored(f) {
  let release, timer;
  const promise = new Promise((resolve, reject) => {
    release = f.motionCache.subscribe(record => { clearTimeout(timer); release(); resolve(record); });
    timer = setTimeout(() => { release(); reject(new Error('motion cache publication deadline')); }, 10000);
  });
  return { promise, cancel() { clearTimeout(timer); release(); } };
}
test('motion: URL replacement decodes real NPZ, commits one entry, persists its bytes and undoes', async () => {
  const f = motionFixture(), fetch = globalThis.fetch, event = stored(f);
  globalThis.fetch = async requested => { assert.equal(requested, url); return new Response(bytes); };
  try {
    const before = f.snapshot();
    const receipt = ok(await f.run('motion.replace', { characterId: 'actor-a', url, prompt: 'Imported' }, 'agent'));
    assert.equal(f.motion.motionFor('actor-a').frames, 48);
    assert.equal(f.motion.layer('actor-a').takeRecipe.seed, null);
    assert.equal(f.motion.layer('actor-a').takeVersions.length, 1);
    assert.equal(receipt.undo.entries, 1); assert.equal(f.motion.documentStore.depths().past, 1);
    const cached = await event.promise; assert.ok(f.motionCache.records.has(cached.motionId));
    ok(f.run('edit.undo', { receiptId: receipt.receiptId })); assert.deepEqual(f.snapshot(), before);
    assert.deepEqual(f.motion.documentStore.depths(), { past: 0, future: 1 }, 'replacement undoes exactly one store entry');
  } finally { event.cancel(); globalThis.fetch = fetch; f.dispose(); }
});
test('motion: draft take preview is a runtime projection, not an authored replacement', () => {
  const f = motionFixture();
  try {
    const take = seedMotion(); f.motion.load([{ id: 'actor-a', take }]);
    const before = f.snapshot(), revision = f.binding.refresh().revision;
    const preview = { ...seedMotion(), anchorX: 3 };
    f.motion.preview('actor-a', preview);
    assert.equal(f.buffer.current.motion.anchorX, 3);
    assert.deepEqual(f.snapshot(), before); assert.equal(f.binding.refresh().revision, revision);
    f.motion.preview('actor-a', null); assert.equal(f.buffer.current.motion.anchorX, 0);
    assert.equal(f.motion.documentStore.depths().past, 0);
  } finally { f.dispose(); }
});
test('motion: restoring a version restores its recipe in the same retained take entry', async () => {
  const f = motionFixture(), fetch = globalThis.fetch;
  globalThis.fetch = async requested => { assert.equal(requested, url); return new Response(bytes); };
  try {
    const recipe = { seed: 13, blocks: [{ prompt: 'Saved version', duration: 2 }], lineEdits: [] };
    f.motion.load([{ id: 'actor-a', take: seedMotion(), takeRecipe: { ...recipe, seed: 12 }, takeVersions: [{ motionUrl: url, recipe, savedAt: 1, label: 'v1' }] }]);
    const before = f.snapshot();
    const receipt = ok(await f.run('motion.loadVersion', { characterId: 'actor-a', motionUrl: url }));
    assert.deepEqual(f.motion.layer('actor-a').takeRecipe, recipe);
    assert.equal(f.motion.documentStore.depths().past, 1);
    ok(f.run('edit.undo', { receiptId: receipt.receiptId })); assert.deepEqual(f.snapshot(), before);
  } finally { globalThis.fetch = fetch; f.dispose(); }
});
test('motion: extra performer delivery owns its take and cast placement in one undo entry', async () => {
  const f = motionFixture(), fetch = globalThis.fetch;
  globalThis.fetch = async requested => { assert.equal(requested, url); return new Response(bytes); };
  try {
    const before = f.snapshot(), characters = structuredClone(f.cast.read());
    assert.equal(await f.motion.deliverExtraTakes([{ motionUrl: url, offsetX: 1, offsetZ: 0 }], f.scope.activeChar, 'Imported'), 1);
    assert.equal(f.motion.motionFor('actor-b')?.frames, 48);
    assert.equal(f.motion.layer('actor-b').takeVersions.length, 1);
    assert.equal(f.motion.motionFor('actor-a'), null);
    assert.equal(f.motion.documentStore.depths().past, 1); assert.equal(f.cast.documentStore.depths().past, 1, 'placement is one member of the take composition');
    f.actual.undoScene(); assert.deepEqual(f.snapshot(), before); assert.deepEqual(f.cast.read(), characters);
  } finally { globalThis.fetch = fetch; f.dispose(); }
});
test('motion: a draft reaches the rig and cancelling it restores the authored take, not its unedited source URL', async () => {
  const f = motionFixture(), fetch = globalThis.fetch;
  try {
    f.motion.load([{ id: 'actor-a', take: seedMotion() }]);
    ok(f.run('motion.editTrail', { characterId: 'actor-a', grabFrame: 12, radiusFrames: 6, delta: { x: 0.2, y: 0, z: 0 } }));
    const take = f.motion.motionFor('actor-a'), before = f.snapshot(), rig = f.actual.snapshotExportRig(f.rigs['actor-a']);
    globalThis.fetch = async requested => { assert.equal(requested, take.url); return new Response(bytes); };
    const preview = structuredClone(take); preview.url = 'preview.npz';
    for (let i = 1; i < preview.posedJoints.length; i += 3) preview.posedJoints[i] += 0.2;
    for (let i = 1; i < preview.rootPos.length; i += 3) preview.rootPos[i] += 0.2;
    f.motion.preview('actor-a', preview);
    assert.notDeepEqual(f.actual.snapshotExportRig(f.rigs['actor-a']), rig);
    assert.deepEqual(f.snapshot(), before);
    await f.motion.loadMotion(take.url, take.prompt, take.rotationDeg, null, 'actor-a', null, { preview: true });
    assert.equal(f.buffer.current.motion, f.motion.motionFor('actor-a'));
    assert.deepEqual(f.snapshot(), before); assert.deepEqual(f.actual.snapshotExportRig(f.rigs['actor-a']), rig);
  } finally { globalThis.fetch = fetch; f.dispose(); }
});

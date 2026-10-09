import assert from 'node:assert/strict';
import { test } from 'node:test';
import { castFixture } from './cast-fixture.mjs';

const ok = receipt => { assert.equal(receipt.ok, true, JSON.stringify(receipt)); return receipt; };
const capsule = { id: 'actor-capsule', subject: 'A stand-in', model: 'proxy-figure', posture: 'sit', x: 1, z: -1 };

test('cast: character.add casts a capsule figure with its posture in one undo entry', () => {
  for (const origin of ['ui', 'agent', 'mcp']) {
    const f = castFixture();
    try {
      const before = f.snapshot();
      const receipt = ok(f.run('character.add', { character: capsule }, origin));
      assert.equal(receipt.undo.entries, 1);
      const row = f.cast.read().find(entry => entry.id === capsule.id);
      assert.equal(row.model, 'proxy-figure');
      assert.equal(row.posture, 'sit');
      ok(f.run('edit.undo', { receiptId: receipt.receiptId }, origin));
      assert.deepEqual(f.snapshot(), before);
      console.log(`PASS character.add proxy-figure/sit ${origin}: one undo entry, undo restores`);
    } finally { f.dispose(); }
  }
});

test('cast: the Assets drop shape (model only, no posture) casts a standing capsule figure', () => {
  const f = castFixture();
  try {
    ok(f.run('character.add', { character: { id: 'actor-drop', model: 'proxy-figure', x: 0.5, z: 0.5, pose: null, subject: 'a person' } }));
    ok(f.run('character.update', { characterId: 'actor-drop', patch: { x: 1 } }));
    const row = f.cast.read().find(entry => entry.id === 'actor-drop');
    assert.equal(row.model, 'proxy-figure');
    assert.equal(row.posture, 'stand');
    console.log('PASS character.add without posture defaults to stand; patch without posture still admitted');
  } finally { f.dispose(); }
});

test('cast: character.update sets a posture and undo puts the old one back', () => {
  const f = castFixture();
  try {
    ok(f.run('character.add', { character: capsule }));
    const before = f.snapshot();
    const receipt = ok(f.run('character.update', { characterId: capsule.id, patch: { posture: 'lie' } }, 'agent'));
    assert.equal(receipt.undo.entries, 1);
    assert.equal(f.cast.read().find(entry => entry.id === capsule.id).posture, 'lie');
    ok(f.run('edit.undo', { receiptId: receipt.receiptId }, 'agent'));
    assert.deepEqual(f.snapshot(), before);
    assert.equal(f.cast.read().find(entry => entry.id === capsule.id).posture, 'sit');
    console.log('PASS character.update posture lie applies and undoes');
  } finally { f.dispose(); }
});

test('cast: character.add refuses unknown models and postures; a patched unknown posture stands', () => {
  const f = castFixture();
  try {
    const before = f.snapshot();
    for (const [command, args] of [
      ['character.add', { character: { ...capsule, model: 'z-bot' } }],
      ['character.add', { character: { ...capsule, posture: 'kneel' } }],
    ]) {
      const refused = f.run(command, args, 'agent');
      assert.equal(refused.ok, false, JSON.stringify(refused));
      assert.equal(refused.code, 'INVALID_ARGUMENT', JSON.stringify(refused));
    }
    assert.deepEqual(f.snapshot(), before);
    console.log('PASS character.add unknown model/posture refused with INVALID_ARGUMENT; document unchanged');
    ok(f.run('character.add', { character: capsule }));
    ok(f.run('character.update', { characterId: capsule.id, patch: { posture: 'kneel' } }, 'agent'));
    assert.equal(f.cast.read().find(entry => entry.id === capsule.id).posture, 'stand');
    console.log('PASS character.update unknown posture normalizes to stand');
  } finally { f.dispose(); }
});

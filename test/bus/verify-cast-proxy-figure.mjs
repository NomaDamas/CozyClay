import assert from 'node:assert/strict';
import { test } from 'node:test';
import { castFixture } from './cast-fixture.mjs';
import { proxyFigureBounds } from '../../src/character-kind.js';

const ok = receipt => { assert.equal(receipt.ok, true, JSON.stringify(receipt)); return receipt; };
const proxy = { id: 'actor-proxy', subject: 'A stand-in', model: 'proxy-figure', posture: 'sit', x: 1, z: -1 };

test('cast: character.add casts a capsule figure with its posture in one undo entry', () => {
  for (const origin of ['ui', 'agent', 'mcp']) {
    const f = castFixture();
    try {
      const before = f.snapshot();
      const receipt = ok(f.run('character.add', { character: proxy }, origin));
      assert.equal(receipt.undo.entries, 1);
      const row = f.cast.read().find(entry => entry.id === proxy.id);
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
    ok(f.run('character.add', { character: proxy }));
    const before = f.snapshot();
    const receipt = ok(f.run('character.update', { characterId: proxy.id, patch: { posture: 'lie' } }, 'agent'));
    assert.equal(receipt.undo.entries, 1);
    assert.equal(f.cast.read().find(entry => entry.id === proxy.id).posture, 'lie');
    ok(f.run('edit.undo', { receiptId: receipt.receiptId }, 'agent'));
    assert.deepEqual(f.snapshot(), before);
    assert.equal(f.cast.read().find(entry => entry.id === proxy.id).posture, 'sit');
    console.log('PASS character.update posture lie applies and undoes');
  } finally { f.dispose(); }
});

test('cast: character.add refuses unknown models and postures; a patched unknown posture stands', () => {
  const f = castFixture();
  try {
    const before = f.snapshot();
    for (const [command, args] of [
      ['character.add', { character: { ...proxy, model: 'z-bot' } }],
      ['character.add', { character: { ...proxy, posture: 'kneel' } }],
    ]) {
      const refused = f.run(command, args, 'agent');
      assert.equal(refused.ok, false, JSON.stringify(refused));
      assert.equal(refused.code, 'INVALID_ARGUMENT', JSON.stringify(refused));
    }
    assert.deepEqual(f.snapshot(), before);
    console.log('PASS character.add unknown model/posture refused with INVALID_ARGUMENT; document unchanged');
    ok(f.run('character.add', { character: proxy }));
    ok(f.run('character.update', { characterId: proxy.id, patch: { posture: 'kneel' } }, 'agent'));
    assert.equal(f.cast.read().find(entry => entry.id === proxy.id).posture, 'stand');
    console.log('PASS character.update unknown posture normalizes to stand');
  } finally { f.dispose(); }
});

test('cast: character.update refuses an in-place rig <-> capsule figure conversion', () => {
  for (const origin of ['ui', 'agent', 'mcp']) {
    const f = castFixture();
    try {
      ok(f.run('character.add', { character: proxy }, origin));
      const rigId = f.cast.read().find(entry => entry.id !== proxy.id).id;
      const before = f.snapshot();
      for (const [characterId, model] of [[rigId, 'proxy-figure'], [proxy.id, 'y-bot-tpose']]) {
        const refused = f.run('character.update', { characterId, patch: { model } }, origin);
        assert.equal(refused.ok, false, JSON.stringify(refused));
        assert.equal(refused.code, 'INVALID_ARGUMENT', JSON.stringify(refused));
        assert.match(refused.message, /kind is chosen when it is created/);
      }
      assert.deepEqual(f.snapshot(), before);
      ok(f.run('character.update', { characterId: proxy.id, patch: { posture: 'lie', model: 'proxy-figure', subject: 'Renamed' } }, origin));
      ok(f.run('character.update', { characterId: rigId, patch: { subject: 'Renamed' } }, origin));
      assert.equal(f.cast.read().find(entry => entry.id === proxy.id).posture, 'lie');
      console.log(`PASS character.update model kind change refused with INVALID_ARGUMENT (${origin}); posture/name patches still succeed`);
    } finally { f.dispose(); }
  }
});

test('cast: a seated capsule figure is an L - torso and head 1.1 m, legs reaching forward', () => {
  const near = (a, b) => Math.abs(a - b) < 1e-9;
  const box = rot => proxyFigureBounds({ model: 'proxy-figure', posture: 'sit', x: 1, z: -1, rot });
  const front = box(0);
  assert.ok(near(front.min.y, 0) && near(front.max.y, 1.1), JSON.stringify(front));
  assert.ok(near(front.max.z, -1 + 0.55) && near(front.min.z, -1 - 0.22), JSON.stringify(front));
  assert.ok(near(front.min.x, 1 - 0.22) && near(front.max.x, 1 + 0.22), JSON.stringify(front));
  const stand = proxyFigureBounds({ model: 'proxy-figure', posture: 'stand', x: 1, z: -1 });
  assert.ok(near(stand.max.y, 1.7) && near(stand.max.z, -1 + 0.22), JSON.stringify(stand));
  console.log(`PASS sit bounds ${JSON.stringify(front)}: height 1.1, legs 0.55 forward of the hip`);
  // Facing is (sin rot, cos rot), as for a rig; the legs' far end follows it round.
  for (const [rot, axis, sign] of [[90, 'x', 1], [180, 'z', -1], [270, 'x', -1]]) {
    const b = box(rot), origin = axis === 'x' ? 1 : -1;
    const reach = sign > 0 ? b.max[axis] - origin : origin - b.min[axis];
    const back = sign > 0 ? origin - b.min[axis] : b.max[axis] - origin;
    assert.ok(near(reach, 0.55) && near(back, 0.22), `rot ${rot}: ${JSON.stringify(b)}`);
    console.log(`PASS sit rot ${rot}: legs reach 0.55 toward ${sign > 0 ? '+' : '-'}${axis}, back 0.22 behind`);
  }
});

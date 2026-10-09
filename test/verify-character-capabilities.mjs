#!/usr/bin/env node
// #635: rig-only features refuse a capsule figure by name; rigged characters
// in the same scene keep every feature.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { characterCapabilities, kindRefusal, refuseRigOnly, CHARACTER_CAPABILITIES } from '../src/character-kind.js';
import { createCharacterEntry, PROXY_FIGURE_MODEL } from '../src/scenes.js';
import { isKo } from '../src/locale.js';
import { motionFixture, seedMotion } from './bus/motion-fixture.mjs';
import { PROXY_ID } from './bus/cast-fixture.mjs';

const proxy = createCharacterEntry({ id: 'p', model: PROXY_FIGURE_MODEL });
const rigged = createCharacterEntry({ id: 'r', model: 'y-bot-tpose' });
const tracks = { head: { q: [{ x: 0, y: Math.sin(0.2), z: 0, w: Math.cos(0.2) }] } };
const refused = (receipt, feature) => {
  assert.equal(receipt.ok, false, JSON.stringify(receipt));
  assert.equal(receipt.code, 'TARGET_NOT_READY');
  assert.equal(receipt.message, kindRefusal(feature, false));
};

test('capabilities: all false for a capsule figure, all true for a rigged character', () => {
  assert.deepEqual(CHARACTER_CAPABILITIES, ['rig', 'ik', 'pose', 'motion', 'mocap', 'physics', 'trails', 'lineEdit']);
  assert.deepEqual({ ...characterCapabilities(proxy) }, Object.fromEntries(CHARACTER_CAPABILITIES.map(name => [name, false])));
  assert.deepEqual({ ...characterCapabilities(rigged) }, Object.fromEntries(CHARACTER_CAPABILITIES.map(name => [name, true])));
});

test('kindRefusal: exact en/ko sentences', () => {
  assert.equal(kindRefusal('Pose mode', false), 'Capsule figures have no rig - Pose mode works on rigged characters only.');
  assert.equal(kindRefusal('Pose mode', true), '캡슐 인물은 리그가 없어요 - Pose mode는 리그 캐릭터에서만 됩니다.');
  assert.equal(kindRefusal('motion', false), 'Capsule figures have no rig - Motion generation works on rigged characters only.');
  assert.equal(kindRefusal('motion', true), '캡슐 인물은 리그가 없어요 - 모션 생성는 리그 캐릭터에서만 됩니다.');
  assert.throws(() => refuseRigOnly(proxy, 'ik'), { code: 'TARGET_NOT_READY', message: kindRefusal('ik', false), uiMessage: kindRefusal('ik', isKo) });
  assert.equal(refuseRigOnly(rigged, 'ik'), undefined);
});

test('bus: motion.generate refuses a capsule figure and reaches the readiness path for a rig', async () => {
  const f = motionFixture({ proxy: true });
  try {
    assert.equal(f.cast.read().find(row => row.id === PROXY_ID).model, PROXY_FIGURE_MODEL);
    const before = f.snapshot();
    refused(await f.run('motion.generate', { characterId: PROXY_ID }, 'agent'), 'motion');
    assert.deepEqual(f.snapshot(), before);
    // The rig target passes the kind gate and stops at the existing readiness
    // checks of this bridge-less fixture instead.
    const rig = await f.run('motion.generate', { characterId: 'actor-a' }, 'agent');
    assert.equal(rig.code, 'INVALID_ARGUMENT', JSON.stringify(rig));
    assert.match(rig.message, /^Motion prompt is required/);
  } finally { f.dispose(); }
});

test('bus: IK keys, collisions, physics, trails and take loading refuse a capsule figure; the rig keeps them', async () => {
  const f = motionFixture({ proxy: true });
  try {
    const take = seedMotion();
    f.motion.load([{ id: 'actor-a', take, fullTake: take }, { id: 'actor-b' }, { id: PROXY_ID }]);
    const before = f.snapshot();
    for (const id of ['character.setIkKey', 'ik.setKey']) refused(f.run(id, { characterId: PROXY_ID, frame: 0, tracks }, 'agent'), 'ik');
    refused(f.run('motion.fixCollisions', { characterId: PROXY_ID, scope: 'frame' }, 'agent'), 'collision');
    refused(await f.run('motion.autoPhysics', { characterId: PROXY_ID, apply: false }, 'agent'), 'physics');
    refused(f.run('motion.editTrail', { characterId: PROXY_ID, grabFrame: 12, radiusFrames: 6, delta: { x: 0.2, y: 0, z: 0 } }, 'agent'), 'trails');
    refused(f.run('ik.applyPose', { characterId: PROXY_ID, frame: 0, pose: { bones: {}, rootY: 0 } }, 'agent'), 'pose');
    refused(await f.run('motion.replace', { characterId: PROXY_ID, url: '/ardy/motions/123456-abcdef' }, 'agent'), 'take');
    assert.deepEqual(f.snapshot(), before);
    const keyed = f.run('ik.setKey', { characterId: 'actor-a', frame: 0, tracks }, 'agent');
    assert.equal(keyed.ok, true, JSON.stringify(keyed));
    assert.equal(f.motion.layer('actor-a').ikKeys.length, 1);
  } finally { f.dispose(); }
});

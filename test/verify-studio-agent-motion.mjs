#!/usr/bin/env node
// #452: verification measures installed takes, not a private install candidate.
// Generation/repair/cancel/history contracts are exercised by test/bus/motion*.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readFileSync } from 'node:fs';
import * as THREE from 'three';
import { FBXLoader } from 'three/examples/jsm/loaders/FBXLoader.js';
import { primeBindPose } from '../src/poses.js';
import { createIkState } from '../src/ardy/ik.js';
import { CSKEL27_NEUTRAL } from '../src/ardy/cskel27-neutral.js';
import { createSceneObject } from '../src/scene-objects.js';
import { verifyInstalledTake } from '../src/studio-agent-motion.js';
import { createCharacterEntry, PROXY_FIGURE_MODEL } from '../src/scenes.js';

function rigFixture() {
  const bytes = readFileSync(new URL('../public/models/y-bot-tpose.fbx', import.meta.url));
  const rig = new FBXLoader().parse(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength), '');
  rig.scale.setScalar(.01); primeBindPose(rig); rig.updateMatrixWorld(true); return rig;
}
function clipFixture({ frames = 48, hover = 0, travel = 0 } = {}) {
  const rotMats = new Float32Array(frames * 243), rootPos = new Float32Array(frames * 3), posedJoints = new Float32Array(frames * 81);
  for (let f = 0; f < frames; f++) {
    for (let j = 0; j < 27; j++) {
      rotMats.set([1,0,0,0,1,0,0,0,1], (f * 27 + j) * 9);
      const p = CSKEL27_NEUTRAL[j];
      posedJoints.set([p[0], p[1] + .9544128 + hover, p[2] + travel * f / (frames - 1)], (f * 27 + j) * 3);
    }
    rootPos.set(posedJoints.subarray(f * 81, f * 81 + 3), f * 3);
  }
  return { frames, fps: 24, personScale: 1, rotMats, rootPos, posedJoints };
}
const bones = rig => { const rows = []; rig.traverse(n => { if (n.isBone) rows.push([...n.position.toArray(), ...n.quaternion.toArray(), ...n.scale.toArray()]); }); return rows; };
function fixture(options = {}) {
  const target = { character: { id: 'actor', x: 0, y: 0, z: 0, rot: 0, scale: 1 }, rig: rigFixture(), motion: clipFixture(options), ikState: createIkState() };
  // One capsule figure stands in the set: it has no rig, so verification must
  // skip it rather than count it as missing cast coverage.
  const proxy = { character: createCharacterEntry({ id: 'proxy', model: PROXY_FIGURE_MODEL, x: 3, z: 0 }), rig: null, motion: null, ikState: createIkState() };
  const environment = { host: { workspaceId: 'w', documentEpoch: 'd', sceneId: 's', sceneEpoch: 'e' }, physicsRevision: 1, floor: { model: 'flat', y: 0 }, objects: [], cast: [proxy], frameCount: target.motion.frames };
  const verify = extra => verifyInstalledTake({ target, environment, yieldTask: () => Promise.resolve(), ...extra });
  return { target, environment, verify };
}
for (const hover of [0, .4]) test(`installed take: full/ranged verification preserves visible rig and authored keys (hover ${hover})`, async () => {
  const f = fixture({ hover }), before = bones(f.target.rig), keys = structuredClone(f.target.ikState.keys);
  const whole = await f.verify();
  assert.equal(whole.status, hover ? 'unverified' : 'verified');
  assert.equal(whole.evaluatedFrames, 48); assert.equal(whole.characterId, 'actor');
  assert.equal(whole.surfaceMeasured, true); assert.equal(whole.unsupportedFrames, hover ? 48 : 0);
  assert.equal(whole.profile, 'studio-motion-v1'); assert.equal(whole.semanticStatus, 'unavailable');
  const part = await f.verify({ range: { startFrame: 12, endFrameExclusive: 36 } });
  assert.deepEqual(part.range, { startFrame: 12, endFrameExclusive: 36 }); assert.equal(part.evaluatedFrames, 24);
  assert.equal(part.unsupportedFrames, hover ? 24 : 0); assert.notEqual(part.id, whole.id);
  assert.deepEqual(bones(f.target.rig), before); assert.deepEqual(f.target.ikState.keys, keys);
  assert(Object.isFrozen(whole));
  assert(!whole.limitations.includes('other-cast-evaluation-incomplete'));
});
test('installed take: missing skin and unsupported support cannot be certified', async () => {
  const f = fixture(), meshes = [];
  f.target.rig.traverse(n => { if (n.isSkinnedMesh) meshes.push(n); });
  for (const mesh of meshes) mesh.removeFromParent();
  const v = await f.verify(); assert.equal(v.status, 'unverified'); assert.equal(v.surfaceMeasured, false);
  const platform = fixture(); platform.target.character.y = .5; platform.target.rig.position.y = .5;
  platform.environment.objects = [{ ...createSceneObject('cube'), scaleX: 3, scaleY: .5, scaleZ: 3 }];
  assert.equal((await platform.verify()).status, 'unverified');
});
test('installed take: every verification measures current floor inputs, independent of key order', async () => {
  const f = fixture(); assert.equal((await f.verify()).status, 'verified');
  f.environment.floor = { y: .3, model: 'flat' }; f.environment.physicsRevision++;
  const changed = await f.verify(); assert.equal(changed.physicsRevision, 2); assert(changed.maxFloorPenetrationM > .2);
  f.environment.floor = { model: 'flat', y: .3 };
  const { id, ...again } = await f.verify(), { id: previous, ...expected } = changed;
  assert.notEqual(id, previous); assert.deepEqual(again, expected);
});
test('installed take: moving props and other cast are sampled off the playhead without posing visible rigs', async () => {
  const f = fixture();
  f.environment.objects = [{ ...createSceneObject('cube'), scaleX: .2, scaleY: .3, scaleZ: .2, y: 1.45,
    path: { points: [{ x: -.8, y: 1.45, z: -2 }, { x: -.8, y: 1.45, z: 2 }], speed: 0, faceTravel: false, loop: false, extend: false, timing: null } }];
  assert.equal((await f.verify({ range: { startFrame: 0, endFrameExclusive: 1 } })).supportedCollisionFrames, 0);
  assert((await f.verify()).supportedCollisionFrames > 0);
  f.environment.objects = [];
  const other = rigFixture(); other.position.z = -2; other.updateMatrixWorld(true); const before = bones(other);
  f.environment.cast = [{ character: { id: 'other', hidden: false }, rig: other, motion: clipFixture({ travel: 4 }), ikState: createIkState() }];
  assert((await f.verify()).supportedCollisionFrames > 0); assert.deepEqual(bones(other), before);
  f.environment.cast[0].rig = null; assert.equal((await f.verify()).status, 'unverified');
});
test('installed take: authored IK continuity and protected poses remain verification inputs', async () => {
  const f = fixture(), before = bones(f.target.rig);
  f.target.ikState.keys.set(23, new Map([['hips', { p: new THREE.Vector3(0, 160, 0), q: [new THREE.Quaternion()] }]]));
  f.target.ikState.tracked.add('hips'); f.target.protectedFrames = [24];
  const v = await f.verify(); assert.equal(v.status, 'unverified');
  assert.deepEqual(bones(f.target.rig), before); assert(f.target.ikState.keys.has(23));
});
test('installed take: missing take/rig, invalid range and evaluation deadline refuse without mutation', async () => {
  const f = fixture(), before = bones(f.target.rig);
  await assert.rejects(f.verify({ target: { ...f.target, motion: null } }), { code: 'TARGET_NOT_READY' });
  await assert.rejects(f.verify({ target: { ...f.target, rig: null } }), { code: 'TARGET_NOT_READY' });
  await assert.rejects(f.verify({ range: { startFrame: 48, endFrameExclusive: 60 } }), { code: 'INVALID_RANGE' });
  let now = 0;
  await assert.rejects(f.verify({ now: () => now, verificationMs: 1, yieldTask: async () => { now = 3; } }), { code: 'VERIFICATION_FAILED' });
  assert.deepEqual(bones(f.target.rig), before);
  const long = fixture({ frames: 240 }); let clock = 0;
  assert.equal((await long.verify({ now: () => clock, verificationMs: 1, yieldTask: async () => { clock = 5; } })).evaluatedFrames, 240);
});

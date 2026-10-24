import assert from 'node:assert/strict';
import { test } from 'node:test';
import * as THREE from 'three';
import { motionFixture } from './motion-fixture.mjs';
import { fingerCurl, fingerTip, solveFingerCurl, solveFingerReach } from '../../src/motion/fingers.js';
const at = bone => bone.getWorldPosition(new THREE.Vector3());
function setup() {
  const f = motionFixture();
  f.motion.load([{ id: 'actor-a', take: null }]);
  const hook = f.renderMotion();
  return { f, hook, state: f.scope.ikStateRef.current };
}
test('fingers: both hands resolve five fingers, each bone an FK joint track', () => {
  const { f, state } = setup();
  try {
    assert.deepEqual([...state.fingers.keys()], ['leftThumb', 'leftIndex', 'leftMiddle', 'leftRing', 'leftPinky', 'rightThumb', 'rightIndex', 'rightMiddle', 'rightRing', 'rightPinky']);
    assert.equal([...state.fkJoints.values()].filter(joint => joint.track.finger).length, 30);
  } finally { f.dispose(); }
});
test('fingers: a curl bends toward the palm and reads back', () => {
  const { f, state } = setup();
  try {
    const finger = state.fingers.get('leftIndex'), tip0 = fingerTip(finger);
    const palmSide = fingerTip(state.fingers.get('leftThumb')).sub(at(finger.bones[0]));
    solveFingerCurl(finger, 0.5);
    assert.ok(Math.abs(fingerCurl(finger) - 0.5) < 1e-6);
    assert.ok(fingerTip(finger).sub(tip0).dot(palmSide) > 0, 'the tip moves to the thumb side of the knuckles');
  } finally { f.dispose(); }
});
test('fingers: fingertip IK reaches a reachable point from either end of the range', () => {
  const { f, state } = setup();
  try {
    const finger = state.fingers.get('rightMiddle');
    solveFingerCurl(finger, 0.4);
    const target = fingerTip(finger);
    for (const start of [0, 1]) {
      solveFingerCurl(finger, start);
      solveFingerReach(finger, target);
      assert.ok(fingerTip(finger).distanceTo(target) < 0.003, `from curl ${start}`);
    }
  } finally { f.dispose(); }
});
test('fingers: a finger gesture keys its three joints and one Undo restores the rig', () => {
  const { f, hook, state } = setup();
  try {
    const rig = f.actual.snapshotExportRig(f.rigs['actor-a']);
    hook.ikSolve('finger', 'leftIndex', { curl: 1 });
    hook.ikDragEnd();
    assert.deepEqual(Object.keys(hook.layer('actor-a').ikKeys[0].tracks).sort(), ['leftIndex1', 'leftIndex2', 'leftIndex3']);
    assert.ok(fingerCurl(state.fingers.get('leftIndex')) > 0.99);
    f.actual.undoScene();
    assert.equal(hook.layer('actor-a').ikKeys.length, 0);
    assert.deepEqual(f.actual.snapshotExportRig(f.rigs['actor-a']), rig);
  } finally { f.dispose(); }
});

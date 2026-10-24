// An IK edit stays with its own character: selection switches with a pending
// preview, mid-drag switches, and a character that has no motion row yet.
// Uses the persistent hook runtime: refs and effects survive re-renders, which
// renderToStaticMarkup (verify-motion-ui-physics) resets on every call.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { motionFixture, seedMotion, useMotion } from './motion-fixture.mjs';
import { persistentRender } from './persistent-hooks.mjs';
import { resolveIkRig } from '../../src/motion/ik.js';
globalThis.window ??= { addEventListener() {}, removeEventListener() {} };

function setup(rows) {
  const f = motionFixture(), app = f.scope.appContext, chars = f.characterRef.current;
  f.motion.load(rows ?? [{ id: 'actor-a', take: seedMotion() }, { id: 'actor-b', take: seedMotion() }]);
  const render = persistentRender(() => { const m = useMotion(app); f.scope.motionDomain = m; Object.assign(f.scope, m); return m; });
  // Left wrist world position, mm. The pose a user sees, not bone bookkeeping.
  const snap = id => {
    const rig = f.rigs[id]; rig.updateMatrixWorld(true); let hand = null;
    rig.traverse(node => { if (!hand && node.isBone && /LeftHand$/.test(node.name)) hand = node; });
    return hand.getWorldPosition(hand.position.clone()).toArray().map(v => Math.round(v * 1000)).join(',');
  };
  const t = { f, hook: render(), snap, r0: { A: snap('actor-a'), B: snap('actor-b') } };
  Object.assign(t, {
    // A click on a character: cast store, App re-render, motion effects, then
    // App's rig-resolve effect (App.jsx "Resolve the IK rig") on the new slot.
    select(id) {
      const i = chars.findIndex(c => c.id === id); f.cast.setActiveCharacterId(id);
      Object.assign(f.scope, { activeChar: chars[i], activeRig: f.rigs[id], activeCharIndex: i });
      t.hook = render(); f.cast.switchActiveCharacterLayer();
      const resolved = resolveIkRig(f.rigs[id]), state = f.scope.ikStateRef.current;
      Object.assign(state, { chains: resolved.chains, fkJoints: resolved.fkJoints, rig: f.rigs[id] });
      t.hook.setIkChains(resolved.chains); t.hook.setIkFkJoints(resolved.fkJoints);
      t.hook = render();
    },
    poseMode() {
      Object.assign(f.scope, { shotCamRef: { current: null }, poserCamRef: { current: null }, setTlPlaying: f.scope.setTlPlaying ?? (() => {}) });
      t.hook.toggleIkMode(); t.hook = render(); assert.equal(t.hook.ikMode, true); },
    target(id, dy = 0.04) {
      const state = id === f.scope.activeChar.id ? f.scope.ikStateRef.current : f.scope.ikStatesRef.current.get(id);
      const chain = state.chains.get('leftHand'), p = chain.bones[2].getWorldPosition(chain.bones[2].position.clone());
      p.y += dy; return p;
    },
    solve(target) { t.hook.ikSolve('chain', 'leftHand', target); },
    drag(id) { t.hook.beginGesture(); t.solve(t.target(id)); t.hook.ikDragEnd(); t.hook.finishGesture(); t.hook = render(); },
    keys: id => t.hook.layer(id).ikKeys.map(k => k.frame),
    depth: () => t.hook.documentStore.depths(),
  });
  return t;
}

test('T1 a pending preview on A is applied when B is selected', () => {
  const t = setup(); try {
    t.select('actor-a'); t.poseMode(); t.drag('actor-a');
    assert.equal(t.hook.pendingIkEdit?.characterId, 'actor-a');
    const edited = t.snap('actor-a'); assert.notEqual(edited, t.r0.A);
    t.select('actor-b');
    assert.equal(t.hook.pendingIkEdit?.characterId ?? null, null);
    assert.deepEqual([t.keys('actor-a'), t.keys('actor-b')], [[0, 47], []]);
    assert.equal(t.snap('actor-a'), edited, 'A keeps the edit');
    assert.equal(t.snap('actor-b'), t.r0.B);
    assert.deepEqual(t.depth(), { past: 1, future: 0 });
  } finally { t.f.dispose(); }
});

test('T2 a drag that started on A cannot pose B after a mid-drag switch', () => {
  const t = setup(); try {
    t.select('actor-a'); t.poseMode(); const a = t.target('actor-a');
    t.hook.beginGesture(); t.solve(a); assert.notEqual(t.snap('actor-a'), t.r0.A);
    t.select('actor-b'); t.solve(a);
    assert.equal(t.snap('actor-b'), t.r0.B);
    assert.equal(t.snap('actor-a'), t.r0.A, 'the switch restores A');
    t.hook.ikDragEnd(); t.hook.finishGesture();
  } finally { t.f.dispose(); }
});

test('T3 ending a drag after a mid-drag switch leaves both rigs and no preview', () => {
  const t = setup(); try {
    t.select('actor-a'); t.poseMode();
    t.hook.beginGesture(); t.solve(t.target('actor-a'));
    t.select('actor-b'); t.solve(t.target('actor-b')); t.hook.ikDragEnd(); t.hook.finishGesture(); t.select('actor-b');
    assert.equal(t.hook.pendingIkEdit?.characterId ?? null, null);
    assert.equal(t.hook.applyPendingIkEdit(), false);
    assert.equal(t.snap('actor-b'), t.r0.B);
    assert.equal(t.snap('actor-a'), t.r0.A);
    assert.deepEqual([t.keys('actor-a'), t.keys('actor-b')], [[], []]);
    // The next stroke on B is a fresh drag owned by B.
    t.drag('actor-b');
    assert.equal(t.hook.pendingIkEdit?.characterId, 'actor-b');
  } finally { t.f.dispose(); }
});

test('T4 no take: a mid-drag switch, drag end and undo leave B at its initial pose', () => {
  const t = setup([{ id: 'actor-a', take: null }, { id: 'actor-b', take: null }]); try {
    t.select('actor-a');
    t.hook.beginGesture(); t.solve(t.target('actor-a'));
    t.select('actor-b'); t.solve(t.target('actor-b')); t.hook.ikDragEnd(); t.hook.finishGesture();
    assert.equal(t.snap('actor-b'), t.r0.B);
    assert.deepEqual([t.keys('actor-a'), t.keys('actor-b')], [[], []]);
    t.f.actual.undoScene();
    assert.equal(t.snap('actor-b'), t.r0.B);
    assert.equal(t.snap('actor-a'), t.r0.A);
  } finally { t.f.dispose(); }
});

test('T5 regression: apply on each character, then undo, touches only the last one', () => {
  const t = setup(); try {
    t.select('actor-a'); t.drag('actor-a'); assert.equal(t.hook.applyPendingIkEdit(), true);
    const editedA = t.snap('actor-a');
    t.select('actor-b'); t.drag('actor-b');
    assert.equal(t.snap('actor-a'), editedA);
    assert.equal(t.hook.applyPendingIkEdit(), true);
    assert.deepEqual([t.keys('actor-a'), t.keys('actor-b')], [[0, 47], [0, 47]]);
    assert.equal(t.f.actual.undoScene().status, 'undone');
    assert.deepEqual([t.keys('actor-a'), t.keys('actor-b')], [[0, 47], []]);
    assert.equal(t.snap('actor-a'), editedA); assert.equal(t.snap('actor-b'), t.r0.B);
  } finally { t.f.dispose(); }
  const n = setup([{ id: 'actor-a', take: null }, { id: 'actor-b', take: null }]); try {
    n.select('actor-a'); n.drag('actor-a'); const editedA = n.snap('actor-a');
    n.select('actor-b'); n.drag('actor-b');
    assert.deepEqual([n.keys('actor-a'), n.keys('actor-b')], [[0], [0]]);
    assert.equal(n.f.actual.undoScene().status, 'undone');
    assert.equal(n.snap('actor-b'), n.r0.B); assert.equal(n.snap('actor-a'), editedA);
    assert.equal(n.f.actual.undoScene().status, 'undone');
    assert.deepEqual([n.keys('actor-a'), n.keys('actor-b')], [[], []]); assert.equal(n.snap('actor-a'), n.r0.A);
  } finally { n.f.dispose(); }
});

// B joins without a motion row (no take, never keyed), as a character added after startup does.
function noRowSetup() {
  const t = setup([{ id: 'actor-a', take: null }]);
  try { t.select('actor-a'); t.drag('actor-a'); t.select('actor-b'); } catch (error) { t.f.dispose(); throw error; }
  return t;
}

test('T6 a character without a motion row keys its first IK drag', () => {
  const t = noRowSetup(); try {
    const editedA = t.snap('actor-a');
    t.drag('actor-b');
    assert.deepEqual([t.keys('actor-a'), t.keys('actor-b')], [[0], [0]]);
    // assert.ok, not equal: a failure message would inspect the whole rig graph.
    assert.ok(t.f.scope.ikStateRef.current === t.f.scope.ikStatesRef.current.get('actor-b'), 'the live slot is the stored state');
    assert.deepEqual(t.depth(), { past: 2, future: 0 });
    assert.equal(t.snap('actor-a'), editedA);
  } finally { t.f.dispose(); }
});

test('T7 undo after that drag restores B only and keeps both characters', () => {
  const t = noRowSetup(); try {
    const editedA = t.snap('actor-a');
    t.drag('actor-b'); assert.notEqual(t.snap('actor-b'), t.r0.B);
    assert.equal(t.f.actual.undoScene().status, 'undone');
    assert.equal(t.snap('actor-b'), t.r0.B);
    assert.equal(t.snap('actor-a'), editedA);
    assert.deepEqual([t.keys('actor-a'), t.keys('actor-b')], [[0], []]);
    assert.deepEqual(t.f.cast.read().map(c => c.id), ['actor-a', 'actor-b']);
  } finally { t.f.dispose(); }
});

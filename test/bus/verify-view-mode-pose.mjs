import assert from 'node:assert/strict';
import { test } from 'node:test';
import { appFixture } from './app-fixture.mjs';
import { STUDIO_VARIANTS } from '../../src/studio-agent-protocol.js';
import { elementByPath } from '../../src/studio-elements.js';
import { STORYBOARD_MOTION_REFUSAL } from '../../src/commands/view.js';

test('#521: the workflow mode enum is scene|pose|camera|motion on both the protocol and the element map', () => {
  assert.deepEqual([...STUDIO_VARIANTS.modes], ['scene', 'pose', 'camera', 'motion']);
  assert.deepEqual([...elementByPath('view.mode').enum], ['scene', 'pose', 'camera', 'motion']);
});

test('#521: view.setMode {mode:"pose"} round-trips through the command bus and the published view', () => {
  const f = appFixture();
  let rigReady = true;
  Object.assign(f.actionHandlers.current, { readView: f.actual.readStudioState, publishView: f.actual.operateStudio, canPose: () => rigReady });
  try {
    const request = f.request('operate_studio', { mode: 'pose' });
    const alias = f.binding.handlers.operate_studio(request);
    assert.equal(alias.ok, true, JSON.stringify(alias));
    assert.equal(alias.action, 'view.setMode');
    assert.equal(alias.status, 'transient');
    assert.equal(alias.delta[0].after.view.mode, 'pose');
    assert.equal(f.binding.refresh().view.mode, 'pose', 'the published view reads back pose');

    const direct = f.binding.handlers.run_action(f.request('run_action', { action: 'view.setMode', args: { mode: 'scene' } }));
    assert.equal(direct.ok, true, JSON.stringify(direct));
    assert.equal(f.binding.refresh().view.mode, 'scene', 'leaving pose publishes the new mode');

    // No rig to solve: pose is refused with its reason and nothing is published.
    rigReady = false;
    const before = structuredClone(f.binding.refresh().view);
    const refused = f.binding.handlers.operate_studio(f.request('operate_studio', { mode: 'pose' }));
    assert.equal(refused.ok, false);
    assert.equal(refused.code, 'TARGET_NOT_READY');
    assert.match(refused.message, /rig/);
    assert.deepEqual(f.binding.refresh().view, before, 'a refused pose leaves the view untouched');

    const other = f.binding.handlers.operate_studio(f.request('operate_studio', { mode: 'motion' }));
    assert.equal(other.ok, true, 'the other modes never need a rig');
    assert.equal(f.binding.refresh().view.mode, 'motion');
  } finally { f.dispose(); }
});

test('#650: a storyboard project refuses view.setMode {mode:"motion"} with the toast text and keeps its mode', () => {
  assert.equal(STORYBOARD_MOTION_REFUSAL.en, 'Motion tools are not part of a Storyboard project.');
  assert.equal(STORYBOARD_MOTION_REFUSAL.ko, '모션 도구는 스토리보드 프로젝트에 없어요.');
  const f = appFixture({ previsMode: 'storyboard' });
  Object.assign(f.actionHandlers.current, { readView: f.actual.readStudioState, publishView: f.actual.operateStudio, canPose: () => true });
  try {
    const camera = f.binding.handlers.run_action(f.request('run_action', { action: 'view.setMode', args: { mode: 'camera' } }));
    assert.equal(camera.ok, true, JSON.stringify(camera));
    const before = structuredClone(f.binding.refresh().view);
    const refused = f.binding.handlers.run_action(f.request('run_action', { action: 'view.setMode', args: { mode: 'motion' } }));
    assert.equal(refused.ok, false, JSON.stringify(refused));
    assert.equal(refused.message, STORYBOARD_MOTION_REFUSAL.en);
    assert.deepEqual(f.binding.refresh().view, before, 'a refused Motion leaves the view untouched');
    assert.equal(f.binding.refresh().view.mode, 'camera');
    console.log(`storyboard view.setMode motion: ${JSON.stringify({ ok: refused.ok, code: refused.code, message: refused.message, mode: f.binding.refresh().view.mode })}`);
  } finally { f.dispose(); }

  const animation = appFixture({ previsMode: 'animation' });
  Object.assign(animation.actionHandlers.current, { readView: animation.actual.readStudioState, publishView: animation.actual.operateStudio, canPose: () => true });
  try {
    const opened = animation.binding.handlers.run_action(animation.request('run_action', { action: 'view.setMode', args: { mode: 'motion' } }));
    assert.equal(opened.ok, true, JSON.stringify(opened));
    assert.equal(animation.binding.refresh().view.mode, 'motion', 'an animation project still opens Motion');
  } finally { animation.dispose(); }
});

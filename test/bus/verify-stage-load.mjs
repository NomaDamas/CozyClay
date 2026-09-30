import assert from 'node:assert/strict';
import { createSceneStage } from '../../src/scenes.js';
import { createSceneHistoryStore } from '../../src/document-store.js';
import { withCommandHistory } from '../../src/command-bus.js';
import { createIkState } from '../../src/ardy/ik.js';
import { stageFixture } from './stage-fixture.mjs';
import { readStudioFunction } from './verify-domain-modules.mjs';
const f = stageFixture();
try {
  const first = f.run('stage.set', { style: 'Outgoing room' });
  const beforeRevision = f.revision.current;
  Object.assign(f.scope, { tutorialProjectEpochRef: { current: 0 }, tutorialSeedEpochRef: { current: null }, exportShotIdRef: { current: null } });
  const renderUpdates = [];
  for (const name of ['setTutorialSeedPending', 'setCameraTutorial', 'setCameraTutorialHandoff', 'setSceneObjects', 'setRigMountEpoch', 'setHasCharSheet', 'setSelectedPromptId', 'setRailDraw', 'setActiveWaypointId', 'setPendingWaypointFrame']) {
    f.scope[name] = value => renderUpdates.push([name, value]);
  }
  const dependencies = { appContext: f.scope.appContext, createSceneStage, createSceneHistoryStore, withCommandHistory, createIkState,
    DEFAULT_DURATION_S: 2, TIMELINE_FPS: 24, DEFAULT_ENVIRONMENT: 'a sunlit modern living room',
    restoredShotState: () => ({ shots: [], frameCount: 48 }), setScenes: f.scope.setScenes,
    setActiveSceneId: id => { f.scope.activeSceneIdRef.current = id; }, track: () => {} };
  const openScene = new Function(...Object.keys(dependencies), `${readStudioFunction('openScene')}\nreturn openScene;`)(...Object.values(dependencies));
  const next = { id: 'next-scene', objects: [], stage: createSceneStage({ environment: 'Loaded room', keyLight: { intensity: 500 } }) };
  openScene(next, [next]);
  assert.equal(f.stage.read().environment, 'Loaded room');
  assert.equal(f.stage.read().keyLight.intensity, 4);
  assert.deepEqual(f.stage.documentStore.depths(), { past: 0, future: 0 }, 'scene load records no authored stage history');
  assert.equal(f.stage.documentStore.isRetained(first.undo.historyEntryId), false);
  assert.equal(f.binding.refresh().revision, beforeRevision, 'loading a new host is not an authored stage edit');
  assert.equal(renderUpdates.some(([name]) => name === 'setSceneObjects'), false, 'scene loading no longer calls the native object setter');
  assert.deepEqual(f.store.current.objects, next.objects, 'the real owned scene-load boundary ran');
  assert.deepEqual(f.scope.appContext.storeDomain('objects').documentStore.depths(), { past: 0, future: 0 });
  assert.equal(renderUpdates.some(([name]) => name === 'setRigMountEpoch'), true);
  console.log('PASS scene load normalizes the owned stage without authored history or an edit revision');
} finally { f.dispose(); }

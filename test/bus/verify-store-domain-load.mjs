import assert from 'node:assert/strict';
import { createSceneStage } from '../../src/scenes.js';
import { createSceneHistoryStore } from '../../src/document-store.js';
import { withCommandHistory } from '../../src/command-bus.js';
import { createIkState } from '../../src/ardy/ik.js';
import { stageFixture } from './stage-fixture.mjs';
import { readStudioFunction } from './verify-domain-modules.mjs';
const f = stageFixture(), app = f.scope.appContext;
const calls = [], releases = [];
try {
  const original = f.store.current;
  for (const name of ['objects', 'shot', 'cast', 'fixture']) {
    const owner = app.storeDomain(name);
    if (owner) {
      const load = owner.load;
      owner.load = slice => { calls.push([name, slice]); return load(slice); };
      releases.push(() => { owner.load = load; });
    } else releases.push(app.registerStoreDomain(name, { load: slice => calls.push([name, slice]) }));
  }
  Object.assign(f.scope, { tutorialProjectEpochRef: { current: 0 }, tutorialSeedEpochRef: { current: null }, exportShotIdRef: { current: null } });
  for (const name of ['setTutorialSeedPending', 'setCameraTutorial', 'setCameraTutorialHandoff', 'setRigMountEpoch', 'setHasCharSheet', 'setSelectedPromptId', 'setRailDraw', 'setActiveWaypointId', 'setPendingWaypointFrame']) f.scope[name] = () => {};
  f.scope.setSceneObjects = () => { throw new Error('owned objects must publish through load'); };
  f.scope.setShots = () => { throw new Error('owned shots must publish through load'); };
  f.scope.setCharacters = () => { throw new Error('owned cast must publish through load'); };
  const shotState = { shots: [], frameCount: 48 };
  const deps = { appContext: app, createSceneStage, createSceneHistoryStore, withCommandHistory, createIkState,
    DEFAULT_DURATION_S: 2, TIMELINE_FPS: 24, restoredShotState: () => shotState, setScenes: f.scope.setScenes,
    setActiveSceneId: id => { f.scope.activeSceneIdRef.current = id; }, track: () => {} };
  const openScene = new Function(...Object.keys(deps), `${readStudioFunction('openScene')}\nreturn openScene;`)(...Object.values(deps));
  const next = { id: 'next', objects: [{ id: 'loaded-object' }], stage: createSceneStage({ environment: 'Next room' }), fixture: [{ id: 'loaded-item' }] };
  openScene(next, [next]);
  assert.equal(f.store.current, original, 'scene loading cannot replace a registered owner');
  assert.deepEqual(Object.fromEntries(calls), { objects: next.objects, shot: shotState, cast: next.stage.characters, fixture: next.fixture });
  assert.equal(calls.length, 4, 'each registered owner loads once, independent of registration order');
  assert.equal(f.stage.read().environment, 'Next room');
  assert.deepEqual(f.stage.documentStore.depths(), { past: 0, future: 0 });
  console.log('PASS #480.3c scene boundary calls registered loads without replacing stores or invoking legacy writers');
} finally { releases.forEach(release => release()); f.dispose(); }

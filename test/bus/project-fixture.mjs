import { readFileSync } from 'node:fs';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { createServer } from 'vite';
import { createStudioAppActions } from '../../src/commands/index.js';
import { createSceneStage, SCENES_VERSION } from '../../src/scenes.js';
import { PROJECT_SESSION_KEY } from '../../src/project.js';
import { objectsFixture } from './objects-fixture.mjs';

const source = readFileSync(new URL('../../src/app-stage.jsx', import.meta.url), 'utf8');
const constants = ['TIMELINE_FPS', 'DEFAULT_DURATION_S', 'DEFAULT_WORKSPACE_LAYOUT'].map(name =>
  source.match(new RegExp(`export const ${name} = [\\s\\S]*?;`))[0]).join('\n');
const server = await createServer({ configFile: false, server: { middlewareMode: true, hmr: false }, appType: 'custom', plugins: [{
  name: 'project-without-renderer', enforce: 'pre', load(id) {
    if (id.endsWith('/src/app-stage.jsx')) return constants;
    if (id.endsWith('/src/scene-assets.js')) return `export * from './scene-assets.js?real';
      import { db } from '../test/bus/objects-asset-db.mjs'; export const openAssetDb = async () => db;`;
  },
}] });
let useScenes, AppContext, ProjectPanel;
try {
  ({ useScenes } = await server.ssrLoadModule('/src/domains/scenes.js'));
  ({ AppContext } = await server.ssrLoadModule('/src/app-context.js'));
  ({ default: ProjectPanel } = await server.ssrLoadModule('/src/panels/ProjectPanel.jsx'));
} finally { await server.close(); }

export function projectFixture({ singleScene = false, session = { name: 'Heist' } } = {}) {
  const previousStorage = globalThis.localStorage;
  const storage = new Map([[PROJECT_SESSION_KEY, JSON.stringify(session)]]);
  globalThis.localStorage = { getItem: key => storage.get(key) ?? null, setItem: (key, value) => storage.set(key, value), removeItem: key => storage.delete(key) };
  const f = objectsFixture(), app = f.scope.appContext;
  app.updatePorts({ read: f.actual.readStudioState, bounds: f.actual.studioBounds, revision: f.revision, poses: () => f.poses,
    recordAction: f.actual.recordStudioAction, beginAction: f.actual.beginStudioAction });
  const stage = createSceneStage({ ...f.stage.read(), characters: f.characterRef.current });
  const scenes = [
    { id: 'scene', name: singleScene ? 'Fixture' : 'First', objects: f.objects.read(), shotDocument: null, stage },
    ...singleScene ? [] : [{ id: 'scene-b', name: 'Second', objects: [], shotDocument: null, stage: createSceneStage() }],
  ];
  Object.assign(f.scope, {
    startup: { document: { version: SCENES_VERSION, scenes, activeSceneId: 'scene' }, error: null },
    actorStageRef: { current: stage }, shotDocumentRef: { current: null },
    dirtyRef: { current: false }, saveBlockedRef: { current: false }, saveFailureToastRef: { current: false },
    projectHandleRef: { current: null }, projectSnapshotRef: { current: null },
    projectStateRef: { current: { workspaceLayout: null, customPoses: [] } }, customPoses: [],
    tutorialProjectEpochRef: { current: 0 }, tutorialSeedEpochRef: { current: null }, tutorialStarterRef: { current: false },
    exportShotIdRef: { current: null }, playgroundMode: false, cameraTutorialQuery: false,
  });
  for (const name of ['setTutorialSeedPending', 'setCameraTutorial', 'setCameraTutorialHandoff', 'setRigMountEpoch', 'setHasCharSheet', 'setSelectedPromptId', 'setRailDraw', 'setActiveWaypointId', 'setPendingWaypointFrame', 'setCustomPoses', 'setFirstSuccessGuideOpen']) f.scope[name] = () => {};
  // These seams model React's synchronous live publication, not scene changes.
  f.scope.setShots = shots => app.patchLive({ shots });
  f.scope.setCharacters = characters => { app.publishCharacters(characters); app.patchLive({ characters }); };
  f.scope.restoreMotionRefs = () => {};
  app.publishScenes(scenes); app.patchLive({ scenes });
  let project;
  function Mount() { project = useScenes(app); return null; }
  renderToStaticMarkup(createElement(Mount));
  f.scope.scenesDomain = project;
  f.scope.projectSnapshotRef.current = project.collectProjectSnapshot('Heist');
  Object.assign(f.actionHandlers.current, app.actionPorts, Object.fromEntries([
    'addSceneDocument', 'duplicateSceneDocument', 'renameSceneDocument', 'deleteSceneDocument', 'switchSceneDocument', 'saveProject',
  ].map(name => [name, project[name]])));
  const registry = createStudioAppActions(f.actionHandlers.current);
  f.ports.actions = () => registry;
  f.scope.studioActionsRef.current = registry;
  app.patchLive({ openScene: project.openScene, persistScenes: project.persistScenes });
  function panel(props = {}) {
    let tree;
    function Capture() { tree = ProjectPanel({ ...project, projectMenuOpen: true, runStudioAction: f.actual.runStudioAction, ...props }); return null; }
    renderToStaticMarkup(createElement(AppContext.Provider, { value: app }, createElement(Capture)));
    return tree;
  }
  return { ...f, project, registry, storage, panel, dispose() { f.dispose(); project.dispose?.(); globalThis.localStorage = previousStorage; } };
}
export const ok = receipt => { if (!receipt?.ok) throw new Error(JSON.stringify(receipt)); return receipt; };

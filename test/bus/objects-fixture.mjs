import { readFileSync } from 'node:fs';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { createServer } from 'vite';
import { createStudioAppActions } from '../../src/commands/index.js';
import { createSceneObject } from '../../src/scene-objects.js';
import { stageFixture } from './stage-fixture.mjs';
const source = readFileSync(new URL('../../src/app-stage.jsx', import.meta.url), 'utf8');
const carried = source.slice(source.indexOf('export const ATTACH_BONE_ROWS'), source.indexOf('export const CAMERA_MOVE_LABELS_KO'));
const server = await createServer({ configFile: false, server: { middlewareMode: true, hmr: false }, optimizeDeps: { noDiscovery: true, include: [] }, appType: 'custom', plugins: [{
  name: 'objects-without-renderer', enforce: 'pre', load(id) {
    if (id.endsWith('/src/scene-assets.js')) return `export * from './scene-assets.js?real';
      import { db } from '../test/bus/objects-asset-db.mjs';
      export const openAssetDb = async () => db;`;
    if (id.endsWith('/src/app-stage.jsx')) return `import * as THREE from 'three';
      import { SCENE_ATTACH_BONES } from './scene-objects.js';
      import { TRAIL_EFFECTOR_JOINTS } from './motion-trail.js';
      import { normalizeBoneName } from './poses.js';
      ${carried}
      export const HIERARCHY_INSPECTOR_TITLES = {};
      export const sceneObjectNameDisplayKo = name => name;
      export const sceneRendererLabelKo = name => name;`;
  },
}] });
let useObjects, AppContext, assetDb;
export let createObjectsDomain;
export const objectPanels = {};
try {
  assetDb = await server.ssrLoadModule('/test/bus/objects-asset-db.mjs');
  ({ useObjects, createObjectsDomain } = await server.ssrLoadModule('/src/domains/objects.js'));
  ({ AppContext } = await server.ssrLoadModule('/src/app-context.js'));
  for (const name of ['ObjectTransformPanel', 'PropsPanel']) objectPanels[name] = (await server.ssrLoadModule(`/src/panels/${name}.jsx`)).default;
} finally { await server.close(); }
export function objectsFixture(initial = ['cube', 'sphere', 'chair'].map(kind => createSceneObject(kind))) {
  const f = stageFixture(), app = f.scope.appContext;
  let objects;
  app.updatePorts({ read: f.actual.readStudioState, bounds: f.actual.studioBounds, revision: f.revision, poses: () => f.poses,
    recordAction: f.actual.recordStudioAction, beginAction: f.actual.beginStudioAction });
  Object.assign(f.scope, { startupScene: { objects: initial }, selectedHierarchyId: 'object:cube',
    editorCamRef: f.scope.shotCamRef, editorLook: f.scope.look, lookThroughShot: true,
    markCraftAction: () => {}, setInspectorActionsOpen: () => {}, matteEditorRef: { current: null },
    characters: f.characterRef.current, charIdFromHierarchyId: id => id.startsWith('character:') ? id.slice(10) : null,
  });
  app.storeDomain('objects').load(initial);
  function Mount() { objects = useObjects(app); return null; }
  renderToStaticMarkup(createElement(Mount));
  f.store.current = objects.store;
  f.scope.store = objects.store;
  f.scope.objectsDomain = objects;

  Object.assign(f.actionHandlers.current, app.actionPorts, { duplicateSelectedSceneObject: objects.duplicateSelectedSceneObject, attachSceneObject: objects.attachSceneObject, importAsset: objects.importAsset });
  // Production constructs the registry after mounting its domain hooks.
  const registry = createStudioAppActions(f.actionHandlers.current);
  f.ports.actions = () => registry;
  f.scope.studioActionsRef.current = registry;
  Object.assign(f.ports, app.ports);
  f.ports.canUndo = f.actual.canUndoStudioReceipt;
  function panel(name, props) {
    let tree;
    function Capture() { tree = objectPanels[name](props); return null; }
    renderToStaticMarkup(createElement(AppContext.Provider, { value: app }, createElement(Capture)));
    return tree;
  }
  return { ...f, objects, registry, panel, assetDb, dispose() { f.dispose(); objects.dispose?.(); } };
}

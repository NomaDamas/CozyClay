import { readFileSync } from 'node:fs';
import { parseSync } from 'rolldown/experimental';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { createServer } from 'vite';
import { castFixture, proxyCast } from './cast-fixture.mjs';
import { appFixture } from './app-fixture.mjs';
import { motionCache } from './history-owners.mjs';
import { freeReferences } from './verify-domain-modules.mjs';
import { createStudioAppActions } from '../../src/commands/index.js';
import { createMotionEdit } from '../../src/ardy/motion-edit.js';
import { CSKEL27_NEUTRAL } from '../../src/ardy/cskel27-neutral.js';

// Follow only the shipped constants/pure helpers used by motion. The renderer
// components co-located in app-stage are not needed to mount the real hook.
const stage = readFileSync(new URL('../../src/app-stage.jsx', import.meta.url), 'utf8');
const motionSource = readFileSync(new URL('../../src/domains/motion.js', import.meta.url), 'utf8');
const ast = parseSync('stage.jsx', stage).program, definitions = new Map(), imports = new Map();
for (const node of ast.body) {
  if (node.type === 'ImportDeclaration') for (const spec of node.specifiers) imports.set(spec.local.name, node);
  const declaration = node.declaration ?? node;
  if (declaration.type === 'FunctionDeclaration') definitions.set(declaration.id.name, node);
  if (declaration.type === 'VariableDeclaration') for (const item of declaration.declarations) if (item.id.type === 'Identifier') definitions.set(item.id.name, node);
}
const selected = new Set();
function include(name) {
  const node = definitions.get(name) ?? imports.get(name); if (!node || selected.has(node)) return;
  selected.add(node);
  if (node.type !== 'ImportDeclaration') for (const ref of freeReferences({ type: 'Program', body: [node] })) include(ref.node.name);
}
for (const node of parseSync('motion.js', motionSource).program.body) if (node.type === 'ImportDeclaration' && node.source.value.endsWith('/app-stage.jsx')) for (const spec of node.specifiers) include(spec.imported.name);
const stageSubset = ast.body.filter(node => selected.has(node)).map(node => stage.slice(node.start, node.end)).join('\n');
const server = await createServer({ configFile: false, server: { middlewareMode: true, hmr: false }, optimizeDeps: { noDiscovery: true, include: [] }, appType: 'custom',
  plugins: [{ name: 'motion-without-renderer', enforce: 'pre', load(id) {
    if (id.endsWith('/src/app-stage.jsx')) return stageSubset;
    if (id.endsWith('/src/motion-store.js')) return `export * from '../test/bus/motion-cache-fixture.mjs';`;
  } }] });
let useMotion;
try { ({ useMotion } = await server.ssrLoadModule('/src/domains/motion.js')); }
finally { await server.close(); }

export function seedMotion(frames = 48) {
  const rotMats = new Float32Array(frames * 243), rootPos = new Float32Array(frames * 3), posedJoints = new Float32Array(frames * 81);
  for (let f = 0; f < frames; f++) {
    for (let j = 0; j < 27; j++) {
      rotMats.set([1, 0, 0, 0, 1, 0, 0, 0, 1], (f * 27 + j) * 9);
      const p = CSKEL27_NEUTRAL[j]; posedJoints.set([p[0], p[1] + 1.3544128, p[2]], (f * 27 + j) * 3);
    }
    rootPos.set(posedJoints.subarray(f * 81, f * 81 + 3), f * 3);
  }
  return { frames, fps: 24, personScale: 1, rotMats, rootPos, posedJoints, anchorX: 0, anchorZ: 0, anchorFrame: 0, rotationDeg: 0, editSegments: createMotionEdit(frames), url: '/ardy/motions/123456-abcdef' };
}
// `{ proxy: true }` adds one capsule figure (cast-fixture PROXY_ID) to the cast.
export function motionFixture({ proxy = false } = {}) {
  const f = castFixture(proxy ? appFixture({ characters: proxyCast() }) : undefined), scope = f.scope, app = scope.appContext;
  Object.assign(scope, { rigs: f.rigs, activeRig: f.rigs['actor-a'], activeChar: f.characterRef.current[0], characters: f.characterRef.current,
    takeRecipeRef: { current: null }, trailBaseMotionRef: { current: null }, trailPreviewMotionRef: { current: null },
    physicsJobRef: { current: 0 }, physicsSourceCacheRef: { current: new Map() }, sceneObjects: [],
    generationPendingRef: { current: false }, genRunningRef: { current: false }, collisionCleanupSupported: true,
  });
  let motion;
  function renderMotion() {
    function Mount() { motion = useMotion(app); return null; }
    renderToStaticMarkup(createElement(Mount));
    scope.motionDomain = motion;
    Object.assign(scope, motion);
    return motion;
  }
  renderMotion();
  Object.assign(f.actionHandlers.current, app.actionPorts);
  const registry = createStudioAppActions(f.actionHandlers.current);
  scope.studioActionsRef.current = registry;
  app.updatePorts({ read: f.actual.readStudioState, bounds: f.actual.studioBounds, revision: f.revision, poses: () => f.poses,
    actions: () => registry, recordAction: f.actual.recordStudioAction, beginAction: f.actual.beginStudioAction });
  f.ports.actions = () => registry; Object.assign(f.ports, app.ports);
  const snapshot = () => structuredClone(app.storeDomain('motion').documentStore.getSnapshot().slices);
  return { ...f, motion, registry, snapshot, renderMotion, motionCache, dispose() { f.dispose(); motion.dispose?.(); } };
}

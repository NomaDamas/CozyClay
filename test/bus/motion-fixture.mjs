import { readFileSync } from 'node:fs';
import { parseSync } from 'rolldown/experimental';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { createServer } from 'vite';
import { fileURLToPath } from 'node:url';
import { castFixture, proxyCast } from './cast-fixture.mjs';
import { appFixture } from './app-fixture.mjs';

import { freeReferences } from './verify-domain-modules.mjs';
import { createStudioAppActions } from '../../src/commands/index.js';
import { compileTakeSource } from '../../src/domains/motion/take-source.js';
import { skeletonFor } from '../../src/motion3/rigs/index.js';

// Follow only the shipped constants/pure helpers used by motion. The renderer
// components co-located in app-stage are not needed to mount the real hook.
const stage = readFileSync(new URL('../../src/app-stage.jsx', import.meta.url), 'utf8')
  + readFileSync(new URL('../../src/timeline-defaults.js', import.meta.url), 'utf8')
  + readFileSync(new URL('../../src/stage-startup-defaults.js', import.meta.url), 'utf8');
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
for (const node of [motionSource].flatMap(text => parseSync('motion.js', text).program.body)) if (node.type === 'ImportDeclaration' && node.source.value.endsWith('/app-stage.jsx')) for (const spec of node.specifiers) include(spec.imported.name);
const stageSubset = ast.body.filter(node => selected.has(node)).map(node => stage.slice(node.start, node.end)).join('\n');
const server = await createServer({ configFile: false, root: fileURLToPath(new URL('../../', import.meta.url)), server: { middlewareMode: true, hmr: false }, optimizeDeps: { noDiscovery: true, include: [] }, appType: 'custom',
  plugins: [{ name: 'motion-without-renderer', enforce: 'pre', load(id) {
    if (id.endsWith('/src/app-stage.jsx')) return stageSubset;
    
  } }] });
let useMotion;
try { ({ useMotion } = await server.ssrLoadModule('/src/domains/motion.js')); }
finally { await server.close(); }

// A compiled take v3 for the fixture's Y Bot cast: standing, with a slow head turn.
export function seedMotion(frames = 48, model = 'y-bot-tpose') {
  const sk = skeletonFor(model), I = sk.index, P = sk.restWorldPos, ank = P[I.LeftFoot][1];
  const spec = { schema: 'cozyclay.motion-spec.v1', fps: 24, frames,
    keys: [{ f: 0, set: { root: [0, P[I.Hips][1] - 0.01, 0], yaw: 0, foot_l: [0.09, ank, -0.03], foot_r: [-0.09, ank, 0.03], head_yaw: 0 } },
      { f: frames - 1, set: { head_yaw: 30 } }] };
  return compileTakeSource({ schema: 'cozyclay.take.v3', rig: model, spec, placement: { position: [0, 0, 0], yaw: 0 }, scene: { objects: {} } });
}
// `{ proxy: true }` adds one capsule figure (cast-fixture PROXY_ID) to the cast.
export function motionFixture({ proxy = false } = {}) {
  const f = castFixture(proxy ? appFixture({ characters: proxyCast() }) : undefined), scope = f.scope, app = scope.appContext;
  Object.assign(scope, { rigs: f.rigs, activeRig: f.rigs['actor-a'], activeChar: f.characterRef.current[0], characters: f.characterRef.current,
    takeRecipeRef: { current: null }, trailBaseMotionRef: { current: null }, trailPreviewMotionRef: { current: null },
    sceneObjects: [],
    generationPendingRef: { current: false }, genRunningRef: { current: false },
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
  return { ...f, motion, registry, snapshot, renderMotion, dispose() { f.dispose(); motion.dispose?.(); } };
}
export { useMotion };

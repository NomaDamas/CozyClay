// Mount the shipped owners in the older App extraction fixture. Only the
// renderer components co-located with their pure app-stage imports are omitted.
import { readFileSync } from 'node:fs';
import { parseSync } from 'rolldown/experimental';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { createServer } from 'vite';
import { freeReferences } from './verify-domain-modules.mjs';

const source = readFileSync(new URL('../../src/app-stage.jsx', import.meta.url), 'utf8');
const ast = parseSync('stage.jsx', source).program, definitions = new Map(), imports = new Map();
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
for (const name of ['objects', 'cast', 'motion']) {
  const domain = readFileSync(new URL(`../../src/domains/${name}.js`, import.meta.url), 'utf8');
  for (const node of parseSync(`${name}.js`, domain).program.body) if (node.type === 'ImportDeclaration' && node.source.value.endsWith('/app-stage.jsx')) for (const spec of node.specifiers) include(spec.imported.name);
}
const subset = ast.body.filter(node => selected.has(node)).map(node => source.slice(node.start, node.end)).join('\n');
const server = await createServer({ configFile: false, server: { middlewareMode: true, hmr: false }, optimizeDeps: { noDiscovery: true, include: [] }, appType: 'custom',
  plugins: [{ name: 'history-without-renderer', enforce: 'pre', load(id) {
    if (id.endsWith('/src/app-stage.jsx')) return subset;
    if (id.endsWith('/src/motion-store.js')) return `export * from '../test/bus/motion-cache-fixture.mjs';`;
    // A browser fixes locale at page load. Each fixture is a fresh page, so
    // select that locale while retaining the shipped translations and ko().
    if (id.endsWith('/src/locale.js')) return readFileSync(new URL('../../src/locale.js', import.meta.url), 'utf8')
      .replace('export const isKo =', 'export let isKo =') + '\nexport const setFixtureLocale = value => { isKo = value; };';
  } }] });
let useCast, setFixtureLocale;
export let createObjectsDomain, createMotionDomain, motionCache;
try {
  ({ useCast } = await server.ssrLoadModule('/src/domains/cast.js'));
  ({ setFixtureLocale } = await server.ssrLoadModule('/src/locale.js'));
  ({ createObjectsDomain } = await server.ssrLoadModule('/src/domains/objects.js'));
  ({ createMotionDomain } = await server.ssrLoadModule('/src/domains/motion.js'));
  motionCache = await server.ssrLoadModule('/test/bus/motion-cache-fixture.mjs');
} finally { await server.close(); }
export function mountHistoryCast(app, korean = false) {
  setFixtureLocale(korean);
  let cast;
  function Mount() { cast = useCast(app); return null; }
  renderToStaticMarkup(createElement(Mount));
  return cast;
}

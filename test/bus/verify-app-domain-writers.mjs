import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { parseSync } from 'rolldown/experimental';

// Authored domain state (including native load/restore setters), not transient
// selection, playback, menu or renderer state. Both bare and member calls count.
const setters = new Set([
  'setShots', 'editShots', 'setFovDeg', 'setCameraMove', 'setCustomMove', 'setTlFrameCount', 'setTlFps',
  'setCharacters', 'editCharacters', 'setWaypoints', 'editWaypoints', 'setPromptClips', 'editPromptClips', 'setCustomPoses', 'setHasCharSheet',
  'setScenes', 'setActiveSceneId', 'setProjectName', 'setProjectDirty', 'setSceneObjects',
  'setMotion', 'setFalMotion', 'setKeyLight', 'setEnvironmentImage', 'setEnvironment', 'setStyle', 'setHasEnvSheet',
  'setShotAspectKey', 'setCameraPresetId', 'setSensorFormat',
]);
const storeWriters = new Set(['write', 'load', 'begin', 'beginCommand', 'end', 'applyAtomic', 'applyIn', 'undo', 'redo', 'settle']);
function walk(node, visit) {
  if (!node || typeof node !== 'object') return;
  visit(node);
  for (const [key, child] of Object.entries(node)) if (key !== 'parent') {
    if (Array.isArray(child)) child.forEach(n => walk(n, visit)); else walk(child, visit);
  }
}
function scan(source) {
  const parsed = parseSync('App.jsx', source);
  assert.deepEqual(parsed.errors, []);
  const aliases = new Set(setters), stores = new Set(['store', 'storeRef', 'stageDomain', 'documentStore']);
  // Follow direct aliases as well as the ordinary destructured hook setters.
  walk(parsed.program, node => {
    if (node.type === 'VariableDeclarator' && node.id.type === 'Identifier' && node.init?.type === 'Identifier') {
      if (aliases.has(node.init.name)) aliases.add(node.id.name);
      if (stores.has(node.init.name)) stores.add(node.id.name);
    }
  });
  const calls = [];
  walk(parsed.program, node => {
    if (node.type !== 'CallExpression') return;
    const isSetter = callee => callee?.type === 'ConditionalExpression'
      ? isSetter(callee.consequent) || isSetter(callee.alternate)
      : aliases.has(callee?.type === 'MemberExpression' ? callee.property.name ?? callee.property.value : callee?.name);
    let writer = isSetter(node.callee);
    const callee = node.callee;
    let root = callee?.object;
    while (root?.type === 'MemberExpression') root = root.object;
    if (stores.has(root?.name) && storeWriters.has(callee.property?.name)) writer = true;
    if (writer) calls.push({ line: source.slice(0, node.start).split('\n').length, call: source.slice(node.start, node.end).split('\n')[0] });
  });
  return calls;
}
assert.equal(scan('function App(){ setShots([]); storeRef.current.applyAtomic(x=>x); const alias=setMotion; alias(null); }').length, 3);
assert.equal(scan('function App(){ shotsDomain.renameTimelineShot(id, name); appContext.patchLive({shots: []}); }').length, 0);
const paths = ['src/App.jsx', ...readdirSync(new URL('../../src/shell/', import.meta.url), { recursive: true })
  .filter(path => /\.(js|jsx)$/.test(path)).sort().map(path => `src/shell/${path}`)];
for (const path of paths) {
  const source = readFileSync(new URL(`../../${path}`, import.meta.url), 'utf8');
  const calls = scan(source);
  console.log(`${path === 'src/App.jsx' ? 'APP' : path} DOMAIN WRITER CALLS: ${calls.length}`);
  assert.deepEqual(calls, [], `${path}: all authored setters and native store writers belong to named domain functions`);
}
console.log('PASS App and shell domain writer AST: zero direct calls');

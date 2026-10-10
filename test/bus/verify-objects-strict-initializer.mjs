import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { parseSync } from 'rolldown/experimental';
import { objectsFixture, createObjectsDomain } from './objects-fixture.mjs';
const source = readFileSync(new URL('../../src/domains/objects.js', import.meta.url), 'utf8');
let initializer;
function walk(node) {
  if (!node || typeof node !== 'object') return;
  if (node.type === 'VariableDeclarator' && node.id.type === 'ArrayPattern' && node.id.elements[0].name === 'domain') initializer = node.init.arguments[0];
  for (const [key, value] of Object.entries(node)) if (key !== 'parent') Array.isArray(value) ? value.forEach(walk) : walk(value);
}
walk(parseSync('objects.js', source).program);
const f = objectsFixture(), created = new Set();
try {
  // React StrictMode evaluates a useState initializer twice but retains only
  // one result. Replay that exact shipped initializer against the real owner.
  const initialize = new Function('appContext', 'createObjectsDomain', `return ${source.slice(initializer.start, initializer.end)};`)(f.scope.appContext, createObjectsDomain);
  const first = initialize(), replay = initialize(); created.add(first); created.add(replay);
  assert.equal(first, replay, 'replayed initialization must not register a discarded owner');
  assert.equal(first.documentStore, f.objects.documentStore);
  assert.equal(f.scope.appContext.storeDomain('objects'), first);
  f.objects.addSceneObject('cone');
  // A UI-made object is listed first under Props.
  assert.equal(f.objects.read().at(0).renderer, 'cone');
  assert.equal(f.objects.documentStore.depths().past, 1);
  console.log('PASS real initializer replay retains one owner and UI/command publication stays on the same store');
} finally { for (const domain of created) if (domain.documentStore !== f.objects.documentStore) domain.dispose(); f.dispose(); }

import assert from 'node:assert/strict';
import { appFixture } from './app-fixture.mjs';
import { objectsFixture } from './objects-fixture.mjs';
import { createSceneObject } from '../../src/scene-objects.js';
const native = appFixture();
try {
  native.scope.appContext.storeDomain('objects').dispose();
  const listing = native.registry.list();
  assert.equal(listing.find(row => row.id === 'object.add').available, false);
  assert.ok(listing.find(row => row.id === 'object.add').reason);
} finally { native.dispose(); }
const f = objectsFixture();
try {
  const before = structuredClone(f.objects.read());
  const incoming = [createSceneObject('cone', [], { x: 7 })];
  const replaced = f.objects.applyExternalObjects(incoming);
  assert.equal(replaced.ok, true, JSON.stringify(replaced));
  assert.deepEqual(f.objects.read(), incoming);
  assert.equal(f.run('edit.undo', { receiptId: replaced.receiptId }).status, 'undone');
  assert.deepEqual(f.objects.read(), before);
  for (const origin of ['agent', 'mcp', 'cli']) assert.equal(f.run('objects.replace', { objects: incoming }, origin).code, 'CAPABILITY_MISSING');
  const cycle = f.run('object.set', { id: 'cube', set: { parent: 'cube' } });
  assert.equal(cycle.ok, false);
  assert.deepEqual(f.objects.read(), before);
  const unknown = f.run('object.set', { id: 'cube', set: { parent: 'missing' } });
  assert.equal(unknown.ok, false);
  assert.deepEqual(f.objects.read(), before);
  console.log('PASS unmounted adapter availability, external authored replacement/undo, origin exposure and invalid parent refusal');
} finally { f.dispose(); }

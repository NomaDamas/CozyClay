import assert from 'node:assert/strict';
import { objectsFixture } from './objects-fixture.mjs';
const f = objectsFixture();
try {
  const before = structuredClone(f.objects.read());
  f.objects.addSceneObject('cone', { x: 3, z: 2 });
  assert.equal(f.objects.store.depths().past, 1);
  assert.ok(f.objects.read().some(row => row.renderer === 'cone' && row.x === 3));
  f.actual.undoScene(); assert.deepEqual(f.objects.read(), before);
  f.objects.renameSceneObject('cube', 'From hierarchy');
  assert.equal(f.objects.read()[0].name, 'From hierarchy');
  f.objects.reparentSceneObject('object:cube', 'object:sphere');
  assert.equal(f.objects.read()[0].parent, 'sphere');
  const request = f.request('arrange_objects', { ops: [{ op: 'update', id: 'cube', position: { world: { x: 5, y: 0, z: 2 } } }] });
  const arranged = f.binding.handlers.arrange_objects(request);
  assert.equal(arranged.action, 'objects.arrange', JSON.stringify(arranged));
  assert.deepEqual(f.binding.handlers.arrange_objects(request), arranged);
  assert.equal(f.objects.read()[0].x, 5);
  const duplicate = f.run('object.duplicate', { objectId: 'cube' });
  assert.equal(duplicate.ok, true, JSON.stringify(duplicate));
  assert.equal(duplicate.affectedIds.length, 1);
  assert.equal(f.objects.read().find(row => row.id === duplicate.affectedIds[0]).x, 5.5);
  const placed = { id: f.run('object.add', { kind: 'capsule' }).affectedIds[0] };
  assert.ok(f.objects.read().some(row => row.id === placed.id));
  const depth = f.objects.store.depths().past;
  const batchReceipt = await f.run('objects.batch', { atomic: true, ops: [
    { name: 'update_object', args: { id: 'cube', x: 7 } },
    { name: 'remove_object', args: { id: 'chair' } },
    { name: 'group_objects', args: { parent: 'sphere', children: [placed.id] } },
  ] });
  const batch = batchReceipt.output;
  assert.equal(batchReceipt.ok, true, JSON.stringify(batchReceipt));
  assert.deepEqual(batch.applied, [1, 2, 3]);
  assert.equal(batch.rolledBack, false);
  assert.equal(f.objects.store.depths().past, depth + 1);
  const saved = structuredClone(f.objects.read());
  const rollbackReceipt = await f.run('objects.batch', { atomic: true, ops: [
    { name: 'update_object', args: { id: 'cube', x: 9 } },
    { name: 'remove_object', args: { id: 'missing' } },
  ] });
  const rollback = rollbackReceipt.output;
  assert.equal(rollback.rolledBack, true);
  assert.deepEqual(f.objects.read(), saved);
  // A batch that references its own earlier parts is one transaction: one history entry, one undo.
  const preAssembly = structuredClone(f.objects.read()), assemblyDepth = f.objects.store.depths().past;
  const assembly = f.binding.handlers.arrange_objects(f.request('arrange_objects', { ops: [
    { op: 'create', source: { kind: 'cube' }, name: 'Chassis', scale: { x: 2, y: 0.5, z: 4 }, position: { world: { x: -8, y: 0, z: 6 } } },
    { op: 'create', source: { kind: 'cube' }, name: 'Hood', scale: { x: 1, y: 0.2, z: 1 }, rotationDeg: { x: -10, y: 0, z: 0 }, position: { onObject: 'Chassis', offsetXZ: { x: 0, z: 1 } }, parent: 'Chassis' },
    { op: 'create', source: { kind: 'cube' }, name: 'Fender', scale: { x: 0.3, y: 0.2, z: 1 }, position: { relativeTo: 'Hood', basis: 'world', side: 'right', gapM: 0.1, support: 'floor' } },
  ] }));
  assert.equal(assembly.action, 'objects.arrange', JSON.stringify(assembly));
  assert.equal(f.objects.read().length, preAssembly.length + 3);
  assert.equal(f.objects.store.depths().past, assemblyDepth + 1);
  f.actual.undoScene(); assert.deepEqual(f.objects.read(), preAssembly);
  assert.equal(f.objects.store.depths().past, assemblyDepth);
  console.log('PASS real UI add/rename/group, planner alias/replay, duplication and atomic legacy batches');
} finally { f.dispose(); }

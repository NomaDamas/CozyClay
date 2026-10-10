import assert from 'node:assert/strict';
import { objectsFixture } from './objects-fixture.mjs';
import { createSceneObject } from '../../src/scene-objects.js';

// A character grouped under an object turns with it: its position orbits the
// object's pivot and its yaw gains the object's yaw. One undo puts back the
// object and the rider together.
const f = objectsFixture([
  { ...createSceneObject('cube'), id: 'cube', x: 2, y: 0, z: 5 },
  { ...createSceneObject('sphere'), id: 'ball', parent: 'cube', x: 2, y: 0, z: 7 },
]);
try {
  const cast = f.scope.appContext.storeDomain('cast');
  const place = (id, patch) => { const r = f.run('character.update', { characterId: id, patch }); assert.equal(r.ok, true, JSON.stringify(r)); };
  const at = id => cast.read().find(row => row.id === id);
  place('actor-a', { parent: 'cube', x: 3, y: 0, z: 5, rot: 10 });
  place('actor-b', { parent: 'ball', x: 2, y: 0, z: 8, rot: -20 });
  const free = structuredClone(at('actor-a'));
  const objectsBefore = structuredClone(f.objects.read());
  const castBefore = structuredClone(cast.read());
  const depth = f.objects.store.depths().past;

  const turned = f.run('object.update', { id: 'cube', patch: { rot: 90 } });
  assert.equal(turned.ok, true, JSON.stringify(turned));
  // (1,0,0) about the pivot (2,0,5) -> (0,0,-1): (2,0,4); yaw 10 -> 100
  assert.deepEqual([at('actor-a').x, at('actor-a').y, at('actor-a').z, at('actor-a').rot], [2, 0, 4, 100]);
  // the ball orbits the cube pivot: offset (0,0,2) -> (2,0,0), so (4,0,5); the character under the BALL follows the ball's own motion: offset (0,0,1) -> (1,0,0), so (5,0,5)
  const ball = f.objects.read().find(row => row.id === 'ball');
  assert.deepEqual([ball.x, ball.y, ball.z, ball.rot], [4, 0, 5, 90]);
  assert.deepEqual([at('actor-b').x, at('actor-b').z, at('actor-b').rot], [5, 5, 70]);

  // pitch: position moves, facing does not
  const pitched = f.run('object.update', { id: 'cube', patch: { rotX: 90 } });
  assert.equal(pitched.ok, true, JSON.stringify(pitched));
  assert.equal(at('actor-a').rot, 100, 'pitch never turns a character');
  assert.ok(at('actor-a').y >= 0);

  // a pure move still just shifts riders (old behaviour)
  place('actor-a', { x: 2, y: 0, z: 4, rot: 100 });
  const before = structuredClone(at('actor-a'));
  const moved = f.run('object.update', { id: 'cube', patch: { x: 4, z: 6 } });
  assert.equal(moved.ok, true, JSON.stringify(moved));
  assert.deepEqual([at('actor-a').x, at('actor-a').z, at('actor-a').rot], [before.x + 2, before.z + 1, before.rot]);

  // one undo per edit puts back the object and its riders together
  f.actual.undoScene();
  assert.equal(f.objects.read().find(row => row.id === 'cube').x, 2);
  assert.equal(at('actor-a').x, before.x);
  f.actual.undoScene(); // the manual re-placement above
  f.actual.undoScene(); // the pitch
  assert.equal(at('actor-a').rot, 100);
  f.actual.undoScene(); // the turn
  assert.deepEqual(f.objects.read(), objectsBefore);
  assert.deepEqual(at('actor-a'), free);
  assert.deepEqual(cast.read(), castBefore);
  assert.equal(f.objects.store.depths().past, depth);
  console.log('PASS characters grouped under a turning object orbit it and take its yaw, in one undo step');
} finally { f.dispose(); }

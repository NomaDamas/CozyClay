import assert from 'node:assert/strict';
import { test } from 'node:test';
import { Euler, Matrix4, Quaternion, Vector3 } from 'three';
import { createSceneObject } from '../src/scene-objects.js';
import { createCharacterEntry } from '../src/scenes.js';
import { validateStudioCommand, StudioProtocolError } from '../src/studio-agent-protocol.js';
import { arrangement, localToWorld, worldToLocal, localTransformReadback } from '../src/studio-agent-commands.js';

const DEG = Math.PI / 180;
const state = rows => ({ host: { workspaceId: 'w', documentEpoch: 'd', sceneId: 's', sceneEpoch: 'e' }, frame: 0, frameCount: 24, floorY: 0, activeCharacterId: 'alex', selectedShotId: null,
  objects: rows, characters: [createCharacterEntry({ id: 'alex', subject: 'Alex' })], shotDocument: { shots: [] }, camera: null, filmback: null, manual: false });
const ports = { bounds: ({ entity }) => ({ min: { x: entity.x - 0.25, y: entity.y, z: entity.z - 0.15 }, max: { x: entity.x + 0.25, y: entity.y + 1.8, z: entity.z + 0.15 } }) };
const parent = (patch = {}) => ({ ...createSceneObject('cube'), id: 'root', name: 'Root', x: 2, y: 0.5, z: -3, ...patch });
const run = (rows, ops) => arrangement(validateStudioCommand({ name: 'arrange_objects', args: { ops } }), state(rows), ports).draft;
// Direct planner call, bypassing schema validation: create-time rotationDeg is a sibling change.
const runRaw = (rows, ops) => arrangement({ name: 'arrange_objects', args: { ops } }, state(rows), ports).draft;
const near = (a, b, label = '', eps = 1e-6) => assert.ok(Math.abs(a - b) < eps, `${label} ${a} != ${b}`);
const quatOf = o => new Quaternion().setFromEuler(new Euler((o.rotX ?? 0) * DEG, (o.rot ?? 0) * DEG, (o.rotZ ?? 0) * DEG, 'XYZ'));
// Independent three.js composition: parent world matrix * local matrix.
function compose(p, local, rot) {
  const one = new Vector3(1, 1, 1);
  const parentM = new Matrix4().compose(new Vector3(p.x, p.y, p.z), quatOf(p), one);
  const localM = new Matrix4().compose(new Vector3(local.x, local.y, local.z), new Quaternion().setFromEuler(new Euler(rot.x * DEG, rot.y * DEG, rot.z * DEG, 'XYZ')), one);
  const position = new Vector3(), quaternion = new Quaternion();
  parentM.multiply(localM).decompose(position, quaternion, new Vector3());
  return { position, quaternion };
}
function assertMatches(child, p, local, rot, label) {
  const want = compose(p, local, rot);
  near(child.x, want.position.x, `${label} x`); near(child.y, want.position.y, `${label} y`); near(child.z, want.position.z, `${label} z`);
  near(Math.abs(quatOf(child).dot(want.quaternion)), 1, `${label} orientation`);
}
const zero = { x: 0, y: 0, z: 0 };
const kid = { ...createSceneObject('cube'), id: 'kid', name: 'Kid', parent: 'root' };

test('yaw 90 parent: local children land where three.js composition puts them', () => {
  const p = parent({ rot: 90 });
  const rows = run([p], [{ op: 'create', source: { kind: 'cube' }, name: 'Wheel', position: { world: { x: 1, y: 0.2, z: 0.5 } }, parent: 'root', space: 'parent' }]);
  const wheel = rows.find(o => o.name === 'Wheel');
  assertMatches(wheel, p, { x: 1, y: 0.2, z: 0.5 }, zero, 'wheel');
  // Under a +90 yaw local +X is world -Z and local +Z is world +X.
  near(wheel.x, 2 + 0.5, 'x'); near(wheel.z, -3 - 1, 'z'); near(wheel.y, 0.7, 'y'); near(wheel.rot, 90, 'a child with no local rotation inherits the parent yaw');
  assert.equal(wheel.parent, 'root');
});

test('pitch parent: local Y tilts toward world +Z, and a tilted local update composes rotations', () => {
  const pitched = run([parent({ rotX: 90 }), kid], [{ op: 'update', id: 'kid', position: { world: { x: 0, y: 1, z: 0 } }, space: 'parent' }]).find(o => o.id === 'kid');
  near(pitched.x, 2, 'x'); near(pitched.y, 0.5, 'y'); near(pitched.z, -3 + 1, 'z');
  const p = parent({ rotX: 30, rot: 20, rotZ: -10 });
  const rows = run([p, kid], [{ op: 'update', id: 'kid', position: { world: { x: 0.3, y: 1, z: -0.7 } }, rotationDeg: { x: 15, y: 40, z: 5 }, space: 'parent' }]);
  assertMatches(rows.find(o => o.id === 'kid'), p, { x: 0.3, y: 1, z: -0.7 }, { x: 15, y: 40, z: 5 }, 'kid');
});

test('create-time rotationDeg is local too when the planner receives it', () => {
  const p = parent({ rotX: 30, rot: 20 });
  const rows = runRaw([p], [{ op: 'create', source: { kind: 'cube' }, name: 'Nose', position: { world: { x: 0, y: 1, z: 1 } }, rotationDeg: { x: 0, y: 45, z: 10 }, parent: 'root', space: 'parent' }]);
  assertMatches(rows.find(o => o.name === 'Nose'), p, { x: 0, y: 1, z: 1 }, { x: 0, y: 45, z: 10 }, 'nose');
});

test('facing.yawDeg is a local yaw', () => {
  const rows = run([parent({ rot: 90 }), kid], [{ op: 'update', id: 'kid', position: { world: zero }, facing: { yawDeg: 45 }, space: 'parent' }]);
  near(rows.find(o => o.id === 'kid').rot, 135, 'world yaw = 90 + 45');
});

test('round trip: local -> world -> local, planner result and readback', () => {
  const p = parent({ rotX: 25, rot: -70, rotZ: 12 });
  const local = { position: { x: 0.4, y: 1.3, z: -2.2 }, rotationDeg: { x: 10, y: 33, z: -20 } };
  const world = localToWorld(p, local);
  const back = worldToLocal(p, { x: world.position.x, y: world.position.y, z: world.position.z, rotX: world.rotationDeg.x, rot: world.rotationDeg.y, rotZ: world.rotationDeg.z });
  for (const a of ['x', 'y', 'z']) { near(back.position[a], local.position[a], `pos ${a}`, 1e-9); near(back.rotationDeg[a], local.rotationDeg[a], `rot ${a}`, 1e-9); }
  const rows = run([p, kid], [{ op: 'update', id: 'kid', position: { world: local.position }, rotationDeg: local.rotationDeg, space: 'parent' }]);
  const rb = localTransformReadback(rows.find(o => o.id === 'kid'), rows);
  for (const a of ['x', 'y', 'z']) { near(rb.position[a], local.position[a], `readback ${a}`, 1e-4); near(rb.rotationDeg[a], local.rotationDeg[a], `readback rot ${a}`, 1e-4); }
  assert.equal(localTransformReadback(rows.find(o => o.id === 'root'), rows), null, 'a root has no local transform');
});

test('default stays world space; parent scale is not applied', () => {
  const p = parent({ rot: 90, scaleX: 3, scaleY: 3, scaleZ: 3 });
  const a = run([p], [{ op: 'create', source: { kind: 'cube' }, name: 'A', position: { world: { x: 1, y: 0.2, z: 0.5 } }, parent: 'root' }]).find(o => o.name === 'A');
  near(a.x, 1, 'world x'); near(a.z, 0.5, 'world z'); near(a.rot, 0, 'world yaw untouched');
  const b = run([p], [{ op: 'create', source: { kind: 'cube' }, name: 'B', position: { world: { x: 1, y: 0, z: 0 } }, parent: 'root', space: 'parent' }]).find(o => o.name === 'B');
  near(b.x, 2, 'x'); near(b.z, -4, 'local metres, not multiplied by parent scale 3');
  near(b.scaleX, createSceneObject('cube').scaleX, 'child scale untouched');
});

test('parent created in the same batch resolves against the evolving draft', () => {
  const rows = run([], [
    { op: 'create', source: { kind: 'cube' }, name: 'Body', position: { world: { x: 4, y: 0, z: 1 } }, facing: { yawDeg: 90 } },
    { op: 'create', source: { kind: 'cube' }, name: 'Door', position: { world: { x: 1, y: 0.3, z: 0 } }, parent: 'Body', space: 'parent' },
  ]);
  const body = rows.find(o => o.name === 'Body'), door = rows.find(o => o.name === 'Door');
  assert.equal(door.parent, body.id);
  assertMatches(door, body, { x: 1, y: 0.3, z: 0 }, zero, 'door');
  near(door.x, 4, 'x'); near(door.z, 0, 'z (local +X is world -Z)');
});

test('translating the assembly root keeps children local-consistent', () => {
  const rows = run([], [
    { op: 'create', source: { kind: 'cube' }, name: 'Body', position: { world: zero } },
    { op: 'create', source: { kind: 'cube' }, name: 'Door', position: { world: { x: 1, y: 0.3, z: 0 } }, parent: 'Body', space: 'parent' },
  ]);
  const body = rows.find(o => o.name === 'Body'), door = rows.find(o => o.name === 'Door');
  const moved = run(rows, [{ op: 'update', id: body.id, position: { world: { x: 5, y: 0, z: 5 } } }]);
  const rb = localTransformReadback(moved.find(o => o.id === door.id), moved);
  near(rb.position.x, 1, 'local x unchanged'); near(rb.position.y, 0.3, 'local y unchanged'); near(rb.position.z, 0, 'local z unchanged');
});

test('invalid parent and unsupported shapes give teaching errors', () => {
  const p = parent(), loose = { ...kid, parent: null };
  const refuse = (rows, ops, pattern) => assert.throws(() => run(rows, ops), e => e instanceof StudioProtocolError && e.code === 'INVALID_ARGUMENT' && pattern.test(e.message), JSON.stringify(ops));
  const create = extra => [{ op: 'create', source: { kind: 'cube' }, name: 'A', position: { world: zero }, space: 'parent', ...extra }];
  refuse([p], create({}), /needs `parent`/);
  assert.throws(() => run([p], create({ parent: 'ghost' })), e => e instanceof StudioProtocolError && e.code === 'AMBIGUOUS_TARGET' && /parent/.test(e.message));
  refuse([p, loose], [{ op: 'update', id: 'kid', position: { world: zero }, space: 'parent' }], /already has a parent/);
  refuse([p, kid], [{ op: 'update', id: 'kid', position: { relativeTo: 'root', basis: 'world', side: 'left', gapM: 0.1, support: 'floor' }, space: 'parent' }], /world space/);
  refuse([p, kid], [{ op: 'update', id: 'kid', facing: { towardId: 'root' }, space: 'parent' }], /yawDeg/);
  refuse([p, kid], [{ op: 'update', id: 'kid', color: '#ff0000', space: 'parent' }], /none was given/);
  assert.throws(() => validateStudioCommand({ name: 'arrange_objects', args: { ops: [{ op: 'update', id: 'kid', position: { world: zero }, space: 'world' }] } }), /./);
  assert.throws(() => validateStudioCommand({ name: 'arrange_characters', args: { ops: [{ op: 'update', characterId: 'alex', position: { world: zero }, space: 'parent' }] } }), /./);
});

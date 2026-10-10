import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createSceneObject } from '../src/scene-objects.js';
import { createCharacterEntry } from '../src/scenes.js';
import { createShot } from '../src/cuts.js';
import { StudioSchemas, validateStudioSchema } from '../src/studio-agent-protocol.js';
import { segmentIntersectsAabb, sideOfAxis, shotGeometryFacts, GEOMETRY_FACTS_LIMITS } from '../src/studio-geometry-facts.js';

// Two characters 2 m apart on x, facing each other, and three shot cameras
// keyed on the first frame of their shots: a master and two over-the-shoulders.
const aim = (pos, at) => ({ pos, yaw: Math.atan2(-(at.x - pos.x), -(at.z - pos.z)), pitch: Math.atan2(at.y - pos.y, Math.hypot(at.x - pos.x, at.z - pos.z)), fovDeg: 40 });
const A = { x: -1, y: 1.5, z: 0 }, B = { x: 1, y: 1.5, z: 0 };
function fixture({ otsB = { x: 2, y: 1.6, z: 0.6 } } = {}) {
  const shots = [
    createShot('Master', 0, 23, [{ frame: 0, framing: aim({ x: 0, y: 1.6, z: 5 }, { x: 0, y: 1, z: 0 }) }]),
    createShot('OTS A', 24, 47, [{ frame: 24, framing: aim({ x: -2, y: 1.6, z: 0.6 }, B) }]),
    createShot('OTS B', 48, 71, [{ frame: 48, framing: aim(otsB, A) }]),
  ];
  const state = { frame: 0, frameCount: 72, objects: [], camera: null,
    characters: [createCharacterEntry({ id: 'ann', subject: 'Ann', x: -1, z: 0, rot: 90 }), createCharacterEntry({ id: 'ben', subject: 'Ben', x: 1, z: 0, rot: -90 })],
    shotDocument: { shots } };
  const ports = { bounds: ({ entity }) => ({ min: { x: entity.x - 0.25, y: entity.y ?? 0, z: entity.z - 0.15 }, max: { x: entity.x + 0.25, y: (entity.y ?? 0) + 1.8, z: entity.z + 0.15 } }) };
  return { state, ports, shots };
}

test('geometry facts: segment/box and side-of-axis helpers', () => {
  const box = { min: { x: 0, y: 0, z: 0 }, max: { x: 1, y: 1, z: 1 } };
  assert.equal(segmentIntersectsAabb({ x: -1, y: 0.5, z: 0.5 }, { x: 2, y: 0.5, z: 0.5 }, box), true, 'straight through');
  assert.equal(segmentIntersectsAabb({ x: -1, y: 2, z: 0.5 }, { x: 2, y: 2, z: 0.5 }, box), false, 'passes above');
  assert.equal(segmentIntersectsAabb({ x: -2, y: 0.5, z: 0.5 }, { x: -0.5, y: 0.5, z: 0.5 }, box), false, 'stops short of the box');
  assert.equal(segmentIntersectsAabb({ x: 0.5, y: 0.5, z: -1 }, { x: 0.5, y: 0.5, z: 0.2 }, box), true, 'ends inside the box');
  assert.equal(segmentIntersectsAabb({ x: 0.5, y: 3, z: 0.5 }, { x: 0.5, y: 3, z: 0.5 }, box), false, 'a point outside');
  assert.equal(segmentIntersectsAabb({ x: -1, y: -1, z: 0.5 }, { x: 2, y: 2, z: 0.5 }, box), true, 'diagonal through a corner region');
  const a = { x: -1, z: 0 }, b = { x: 1, z: 0 };
  assert.equal(sideOfAxis(a, b, { x: 0, z: 5 }), 'right', 'facing +x, +z is on the right');
  assert.equal(sideOfAxis(a, b, { x: 0, z: -5 }), 'left');
  assert.equal(sideOfAxis(b, a, { x: 0, z: 5 }), 'left', 'reversing the line flips the side');
  assert.equal(sideOfAxis(a, b, { x: 3, z: 0.04 }), 'on-axis', 'within 5 cm of the line');
  assert.equal(sideOfAxis(a, b, { x: 3, z: 0.06 }), 'right');
  assert.equal(sideOfAxis(a, a, { x: 0, z: 1 }), null, 'coincident subjects have no line');
});

test('geometry facts: master and both over-the-shoulders sit on one side of the line', () => {
  const { state, ports } = fixture(), facts = shotGeometryFacts(state, { ports });
  validateStudioSchema(StudioSchemas.GeometryFacts, facts);
  assert.deepEqual(facts.subjects, [{ id: 'ann', position: { x: -1, y: 0, z: 0 }, yawDeg: 90 }, { id: 'ben', position: { x: 1, y: 0, z: 0 }, yawDeg: -90 }]);
  assert.deepEqual(facts.pairs, [{ a: 'ann', b: 'ben', distanceM: 2 }]);
  assert.deepEqual(facts.shots.map(s => [s.subjectIds, s.cameraSide, s.occluders]), [[['ann', 'ben'], 'right', []], [['ann', 'ben'], 'right', []], [['ann', 'ben'], 'right', []]]);
  assert.deepEqual(facts.shots[1].camera.position, { x: -2, y: 1.6, z: 0.6 });
  assert.equal(facts.axisConsistent, true);
  // The playhead's shot reads the live camera, not its key.
  const live = fixture(); live.state.camera = { position: { x: 3, y: 1.6, z: 0.02 }, lookAt: { x: 0, y: 1, z: 0 } };
  assert.equal(shotGeometryFacts(live.state, { ports: live.ports }).shots[0].cameraSide, 'on-axis');
});

test('geometry facts: an over-the-shoulder across the line breaks the 180-degree rule', () => {
  const { state, ports } = fixture({ otsB: { x: 2, y: 1.6, z: -0.6 } }), facts = shotGeometryFacts(state, { ports });
  assert.deepEqual(facts.shots.map(s => s.cameraSide), ['right', 'right', 'left']);
  assert.equal(facts.axisConsistent, false);
  assert.equal(shotGeometryFacts(state, { ports, shotIds: [state.shotDocument.shots[2].id] }).axisConsistent, null, 'one sided shot has nothing to compare');
  const [master, otsA, otsB] = state.shotDocument.shots.map(s => s.id);
  assert.deepEqual(shotGeometryFacts(state, { ports, first: ['ann', otsB] }).shots.map(s => s.shotId), [otsB, master, otsA], 'named shots lead, the rest of the cut follows');
  const lone = fixture(); lone.state.characters.pop();
  assert.deepEqual(shotGeometryFacts(lone.state, { ports: lone.ports }).shots.map(s => s.cameraSide), [null, null, null], 'one character has no line');
});

test('geometry facts: a table between the master camera and Ann occludes her; riders, hidden props and enclosures do not', () => {
  const { state, ports } = fixture();
  state.objects.push({ ...createSceneObject('cube'), id: 'table', name: 'Table', x: -0.5, z: 2.5, scaleY: 2 });
  let facts = shotGeometryFacts(state, { ports });
  assert.deepEqual(facts.shots[0].occluders, [{ subjectId: 'ann', byObjectId: 'table' }]);
  assert.deepEqual(facts.shots[1].occluders, [], 'the over-the-shoulder looks past the table');
  state.objects[0] = { ...state.objects[0], hidden: true };
  assert.deepEqual(shotGeometryFacts(state, { ports }).shots[0].occluders, [], 'a hidden prop hides nothing');
  // A room set around the camera, and a prop Ann carries, are never in the way.
  state.objects = [{ ...createSceneObject('cube'), id: 'room', x: 0, z: 2, scaleX: 20, scaleY: 4, scaleZ: 20 },
    { ...createSceneObject('cube'), id: 'bag', x: -0.5, z: 2.5, scaleY: 2, attach: { characterId: 'ann', bone: null } }];
  ports.bounds = (base => input => input.entity.attach ? { min: { x: -1, y: 0, z: 2 }, max: { x: 0, y: 2, z: 3 } } : base(input))(ports.bounds);
  facts = shotGeometryFacts(state, { ports });
  assert.deepEqual(facts.shots[0].occluders, [], JSON.stringify(facts.shots[0].occluders));
});

test('geometry facts: bounded to the protocol limits', () => {
  const { state, ports } = fixture();
  state.characters = Array.from({ length: 30 }, (_, i) => createCharacterEntry({ id: `c${String(i).padStart(2, '0')}`, x: i, z: 0 }));
  state.shotDocument.shots = Array.from({ length: 12 }, (_, i) => createShot(`S${i}`, i, i, [{ frame: i, framing: aim({ x: i, y: 1.6, z: 4 }, { x: i, y: 1, z: 0 }) }]));
  const facts = shotGeometryFacts(state, { ports });
  assert.equal(facts.subjects.length, GEOMETRY_FACTS_LIMITS.subjects);
  assert.equal(facts.pairs.length, GEOMETRY_FACTS_LIMITS.pairs);
  assert.equal(facts.shots.length, GEOMETRY_FACTS_LIMITS.shots);
  validateStudioSchema(StudioSchemas.GeometryFacts, facts);
});

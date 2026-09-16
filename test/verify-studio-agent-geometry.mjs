import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { dispatchLiveFrame } from '../src/live-control.js';
import { createSceneObject, updateSceneObject } from '../src/scene-objects.js';
import { createSceneHistoryStore } from '../src/scene-history.js';
import { createCharacterEntry } from '../src/scenes.js';
import { createShotAuthoringDocument } from '../src/shot-authoring.js';
import { validateReceipt, validateStudioCommand } from '../src/studio-agent-protocol.js';
import { physicsFingerprintInput } from '../src/studio-agent-context.js';
import { createShot } from '../src/cuts.js';

export function fixture() {
  const host = { workspaceId: 'workspace', documentEpoch: 'document', sceneId: 'scene', sceneEpoch: 'epoch' };
  const state = { host, revision: 0, frame: 0, frameCount: 144, floorY: 0, activeCharacterId: 'alex', selectedShotId: null,
    objects: [], characters: [createCharacterEntry({ id: 'alex', subject: 'Alex' })],
    shotDocument: createShotAuthoringDocument({ frameCount: 144 }),
    camera: { position: { x: 0, y: 1.6, z: 5 }, lookAt: { x: 0, y: 1, z: 0 }, focalMm: 35 },
    filmback: { sensorId: 'fullFrame', aspectRatio: 16 / 9 }, busy: false };
  const stores = {};
  for (const [domain, key] of [['objects', 'objects'], ['cast', 'characters'], ['shot', 'shotState']]) {
    if (domain === 'shot') state.shotState = { shotDocument: state.shotDocument, camera: state.camera, manual: false };
    stores[domain] = createSceneHistoryStore(state[key], { onObjects(next) {
      state[key] = next;
      if (domain === 'shot') Object.assign(state, next);
    }, onCommit() { state.revision++; } });
  }
  let sequence = 0;
  const ports = {
    read: () => state,
    guard: id => ({ ...state.host, targetId: id, token: `token-${state.revision}` }),
    bounds: ({ entity, frame }) => {
      assert.equal(frame, state.frame, 'bounds evaluated at the frozen reference frame');
      if (entity.id === 'unready') return null;
      const scale = entity.scale ?? 1;
      return { min: { x: entity.x - 0.25 * scale, y: entity.y, z: entity.z - 0.15 * scale },
        max: { x: entity.x + 0.25 * scale, y: entity.y + 1.8 * scale, z: entity.z + 0.15 * scale } };
    },
    commit({ domain, draft, expectedRevision }) {
      assert.equal(state.revision, expectedRevision);
      stores[domain].applyAtomic(() => draft);
      return { historyEntryId: `history-${state.revision}` };
    },
  };
  const envelope = (name, args) => ({ commandId: `command-${++sequence}`, host: { ...host }, expectedRevision: state.revision,
    expectedTargets: [...state.objects, ...state.characters, ...state.shotDocument.shots].map(e => ports.guard(e.id)), name, args });
  return { state, stores, ports, envelope };
}
const near = (actual, expected) => assert.ok(Math.abs(actual - expected) < 1e-8, `${actual} != ${expected}`);
const relative = basis => ({ relativeTo: 'alex', basis, side: 'left', gapM: 0.5, support: 'floor' });
const chair = basis => ({ op: 'create', source: { kind: 'chair' }, position: relative(basis), facing: { towardId: 'alex' } });

async function characterize() {
  const object = createSceneObject('chair');
  assert.equal(object.height, 1.15); assert.equal(object.supportY, 0.495);
  const store = createSceneHistoryStore([], {});
  store.applyAtomic(objects => [...objects, object]);
  store.applyAtomic(objects => updateSceneObject(objects, object.id, { x: -1.05, rot: 90 }));
  assert.equal(store.objects[0].x, -1.05); assert.equal(store.depths().past, 2);
  store.undo(); assert.equal(store.objects[0].x, 0); store.undo(); assert.deepEqual(store.objects, []);
  const absent = await dispatchLiveFrame(JSON.stringify({ type: 'cmd', id: 'baseline', name: 'arrange_objects', args: { ops: [chair('shot_camera')] } }), {});
  assert.equal(absent.ok, false); assert.equal(absent.error, 'Unknown command: arrange_objects');
  console.log('PASS characterization: actual world reducer, seat/height, two primitive history entries and absent relative dispatch', JSON.stringify(absent));
}

async function run() {
  const args = process.argv.slice(2);
  if (args.length && !(args.length === 2 && args[0] === '--case' && ['characterization', 'relative-basis-and-batch', 'measured-character-floor'].includes(args[1]))) throw new Error('Unknown test arguments');
  if (args[1] === 'characterization') return characterize();
  await characterize();
  const f = fixture();
  // Before implementation this exercises the existing dispatcher with no new
  // registration. RED is an assertion on its actual rejection, not an import error.
  const moduleUrl = new URL('../src/studio-agent-commands.js', import.meta.url);
  const mod = existsSync(moduleUrl) ? await import(moduleUrl) : null;
  if (args[1] === 'measured-character-floor') return measuredCharacterFloor(mod);
  const commands = mod?.createStudioCommands(f.ports);
  const handlers = commands ? { arrange_objects: request => commands.execute(request) } : {};
  const response = await dispatchLiveFrame(JSON.stringify({ type: 'cmd', id: 'relative', name: 'arrange_objects', args: f.envelope('arrange_objects', { ops: [chair('shot_camera')] }) }), handlers);
  assert.equal(response.ok, true, `relative arrangement must execute through live dispatch: ${response.error}`);
  assert.equal(response.value.ok, true, JSON.stringify(response.value));
  validateReceipt(response.value);
  near(f.state.objects[0].x, -1.05); near(f.state.objects[0].rot, 90);
  assert.equal(f.stores.objects.depths().past, 1);
  f.stores.objects.undo(); assert.deepEqual(f.state.objects, []);
  console.log('PASS relative-basis-and-batch: camera-left -1.05m, actual receipt/state and one Undo');
  await measuredCharacterFloor(mod);
  await boundaries(mod);
}

async function measuredCharacterFloor(mod) {
  // Frozen same-frame skin measurement of the shipped upright y-bot-tpose,
  // y=0, scale=1, no motion/pose. The browser QA also uses the actual loaded rig.
  const measured = { min: { x: -0.25069919668017837, y: -0.00010230400198583725, z: -0.22550816444218705 },
    max: { x: 0.25061193225927636, y: 1.8046321105951333, z: 0.20375764888362347 } };
  const bounds = ({ entity }) => Object.fromEntries(['min', 'max'].map(edge => [edge,
    Object.fromEntries(['x', 'y', 'z'].map(axis => [axis, entity[axis] + measured[edge][axis] * entity.scale]))]));
  const create = { op: 'create', name: 'B', position: { relativeTo: 'alex', basis: 'shot_camera', side: 'right', gapM: 2, support: 'floor' } };
  for (const scale of [1, 2]) {
    const f = fixture(); f.ports.bounds = bounds;
    const commands = mod.createStudioCommands(f.ports);
    const cube = commands.execute(f.envelope('arrange_objects', { ops: [{ op: 'create', source: { kind: 'cube' },
      position: { ...create.position, side: 'left', gapM: 1 } }] }));
    assert.equal(cube.ok, true, JSON.stringify(cube)); near(cube.checks.actualGapM, 1);
    const before = structuredClone(f.state), castBefore = f.state.characters;
    let commits = 0, measurements = 0;
    const commit = f.ports.commit;
    f.ports.commit = payload => { commits++; return commit(payload); };
    f.ports.bounds = input => {
      if (!commits) {
        assert.deepEqual(f.state, before, 'bounds preparation must not publish intermediate character transforms');
        assert.equal(f.stores.cast.depths().past, 0);
      }
      measurements++;
      return bounds(input);
    };
    const request = f.envelope('arrange_characters', { ops: [{ ...create, scale }] });
    const response = await dispatchLiveFrame(JSON.stringify({ type: 'cmd', id: 'measured-floor', name: request.name, args: request }),
      { arrange_characters: input => commands.execute(input) });
    assert.equal(response.ok, true, response.error);
    const receipt = validateReceipt(response.value);
    assert.equal(receipt.ok, true, `ordinary measured upright character must be placeable: ${JSON.stringify(receipt)}`);
    const second = f.state.characters[1], grounded = bounds({ entity: second });
    assert.equal(second.y, f.state.floorY);
    assert.ok(Math.abs(grounded.min.y - f.state.floorY) <= 0.005, `measured skin offset must stay within support tolerance: ${grounded.min.y}`);
    near(grounded.min.x - bounds({ entity: f.state.characters[0] }).max.x, 2);
    near(receipt.checks.actualGapM, 2); near(receipt.checks.baseY, 0);
    assert.equal(receipt.checks.support, 'floor'); assert.equal(receipt.undo.entries, 1);
    assert.equal(receipt.delta[0].after.position.y, second.y);
    assert.equal(f.state.revision, before.revision + 1); assert.equal(commits, 1); assert(measurements > 1);
    assert.equal(f.stores.cast.depths().past, 1); assert.equal(f.stores.objects.depths().past, 1);
    assert.deepEqual(f.state.objects, before.objects); assert.equal(f.state.activeCharacterId, 'alex');
    assert.deepEqual(commands.execute(request), receipt); assert.equal(commits, 1);
    f.stores.cast.undo(); assert.strictEqual(f.state.characters, castBefore);
    assert.deepEqual(f.state.objects, before.objects); assert.equal(f.stores.cast.depths().past, 0);
  }
  console.log('PASS measured-character-floor: measured default rig and scale=2, grounded skin, exact 2m gap, private draft, one domain history entry, replay and Undo');

  for (const scenario of ['tilted-support', 'unavailable', 'unavailable-after-measurement', 'clamped', 'unresponsive-bounds', 'batch-failure', 'revision-race', 'frame-race', 'gesture-race']) {
    const f = fixture(); f.ports.bounds = bounds;
    let ops = [create], name = 'arrange_characters', code = 'TARGET_NOT_READY';
    if (scenario === 'tilted-support') {
      f.stores.objects.applyAtomic(() => [{ ...createSceneObject('chair'), rotX: 10 }]);
      ops = [{ ...create, position: { onObject: 'chair' } }];
    }
    if (scenario === 'unavailable') f.ports.bounds = () => null;
    if (scenario === 'unavailable-after-measurement') {
      let measuredCharacter = false;
      f.ports.bounds = input => {
        if (input.entity.id !== 'alex' && measuredCharacter) return null;
        if (input.entity.id !== 'alex') measuredCharacter = true;
        return bounds(input);
      };
    }
    if (scenario === 'clamped') f.ports.bounds = input => { const box = bounds(input); box.min.y = input.entity.y + 0.1; return box; };
    if (scenario === 'unresponsive-bounds') f.ports.bounds = input => {
      const box = bounds(input);
      if (input.entity.id !== 'alex') box.min.y = input.entity.y - 0.0051;
      return box;
    };
    if (scenario === 'batch-failure') { ops = [create, { ...create, name: 'Alex' }]; code = 'DUPLICATE_NAME'; }
    if (scenario.endsWith('-race')) {
      code = scenario === 'gesture-race' ? 'TARGET_BUSY' : 'STALE_SCENE';
      let changed = false;
      f.ports.bounds = input => {
        if (!changed) {
          changed = true;
          if (scenario === 'revision-race') f.state.revision++;
          else if (scenario === 'frame-race') f.state.frame++;
          else f.state.busy = true;
        }
        return bounds(input);
      };
    }
    const before = structuredClone(f.state), depths = Object.fromEntries(Object.entries(f.stores).map(([k, s]) => [k, s.depths()]));
    const commands = mod.createStudioCommands(f.ports);
    f.ports.commit = () => assert.fail('refused placement must never publish');
    const receipt = validateReceipt(commands.execute(f.envelope(name, { ops })));
    assert.equal(receipt.ok, false, scenario); assert.equal(receipt.code, code, `${scenario}: ${JSON.stringify(receipt)}`);
    assert.equal(receipt.mutated, false); assert.deepEqual(f.state.characters, before.characters); assert.deepEqual(f.state.objects, before.objects);
    if (!scenario.endsWith('-race')) assert.deepEqual(f.state, before);
    assert.deepEqual(Object.fromEntries(Object.entries(f.stores).map(([k, s]) => [k, s.depths()])), depths);
    assert.equal(commands.reconcile_studio_command({ commandId: receipt.commandId }).status, 'not_applied');
  }
  console.log('PASS measured-character-floor refusals: tilted object/support, missing/changed/unresponsive bounds, domain floor clamp, batch atomicity and revision/frame/gesture races');
}

async function boundaries(mod) {
  const setup = () => { const f = fixture(); return { ...f, commands: mod.createStudioCommands(f.ports) }; };
  const execute = (f, name, args) => { const receipt = f.commands.execute(f.envelope(name, args)); validateReceipt(receipt); return receipt; };
  const ok = receipt => assert.equal(receipt.ok, true, JSON.stringify(receipt));
  const rejected = (f, name, args, code) => {
    const state = structuredClone(f.state), depths = Object.fromEntries(Object.entries(f.stores).map(([k, s]) => [k, s.depths()]));
    const receipt = execute(f, name, args);
    assert.equal(receipt.ok, false); assert.equal(receipt.code, code, JSON.stringify(receipt)); assert.equal(receipt.mutated, false);
    assert.deepEqual(f.state, state); assert.deepEqual(Object.fromEntries(Object.entries(f.stores).map(([k, s]) => [k, s.depths()])), depths);
    assert.equal(f.commands.reconcile_studio_command({ commandId: receipt.commandId }).status, 'not_applied');
    return receipt;
  };
  const seed = (f, object) => f.stores.objects.applyAtomic(rows => [...rows, object]);
  for (const [basis, x, yaw] of [['world', -1.05, 90], ['subject', 1.05, -90], ['shot_camera', -1.05, 90]]) {
    const f = setup(); const receipt = execute(f, 'arrange_objects', { ops: [chair(basis)] }); ok(receipt);
    near(f.state.objects[0].x, x); near(f.state.objects[0].rot, yaw); near(receipt.checks.actualGapM, 0.5);
    assert.deepEqual(receipt.delta[0].after.position, { x, y: 0, z: 0 });
  }
  for (const yaw of [90, 180]) {
    const f = setup(); f.state.characters[0].rot = yaw;
    ok(execute(f, 'arrange_objects', { ops: [{ ...chair('subject'), facing: { yawDeg: 0 } }] }));
    const p = f.state.objects[0];
    if (yaw === 90) { near(p.x, 0); near(p.z, -0.95); } else { near(p.x, -1.05); near(p.z, 0); }
  }
  {
    const f = setup();
    ok(execute(f, 'arrange_objects', { ops: [{ ...chair('world'), scale: { x: 2, y: 3, z: 4 }, facing: { yawDeg: 90 } }] }));
    near(f.state.objects[0].x, -1.95); assert.equal(f.state.objects[0].scaleY, 3);
    const parent = f.state.objects[0];
    ok(execute(f, 'arrange_objects', { ops: [{ op: 'create', source: { kind: 'cube' }, position: { onObject: parent.id } }] }));
    near(f.state.objects[1].y, 1.485); // actual chair seat .495, not back height 1.15
  }
  {
    const f = setup();
    seed(f, updateSceneObject([createSceneObject('cube')], 'cube', { x: 4, z: 2 })[0]);
    ok(execute(f, 'arrange_objects', { ops: [{ op: 'create', source: { kind: 'chair' }, position: { between: ['alex', 'cube'], fraction: 0.25, support: 'floor' } }] }));
    near(f.state.objects[1].x, 1); near(f.state.objects[1].z, 0.5);
  }
  console.log('PASS geometry: three bases, yaw 90/180, anisotropic rotated extents, between and scaled authored seat');
  {
    const f = setup();
    rejected(f, 'arrange_objects', { ops: [chair('world'), { op: 'create', source: { kind: 'not-a-kind' }, position: { world: { x: 2, y: 0, z: 0 } } }] }, 'INVALID_ARGUMENT');
    rejected(f, 'arrange_objects', { ops: [{ ...chair('world'), position: { ...relative('world'), relativeTo: 'missing' } }] }, 'STALE_TARGET');
    rejected(f, 'arrange_objects', { ops: [{ ...chair('world'), position: { onObject: 'missing' } }] }, 'STALE_TARGET');
    f.state.camera.lookAt = { ...f.state.camera.position, y: 0 };
    rejected(f, 'arrange_objects', { ops: [chair('shot_camera')] }, 'AMBIGUOUS_BASIS');
    f.state.characters[0].id = 'unready'; f.state.activeCharacterId = 'unready';
    rejected(f, 'arrange_objects', { ops: [{ ...chair('world'), position: { ...relative('world'), relativeTo: 'unready' }, facing: { yawDeg: 0 } }] }, 'TARGET_NOT_READY');
  }
  for (const supportPatch of [{ path: { points: [{ x: 0, y: 0, z: 0 }, { x: 2, y: 0, z: 0 }] } }, { attach: { characterId: 'alex', bone: null } }, { rotX: 10 }, { renderer: 'cutout' }, { renderer: 'sphere' }]) {
    const f = setup(); seed(f, { ...createSceneObject('chair'), ...supportPatch });
    rejected(f, 'arrange_objects', { ops: [{ op: 'create', source: { kind: 'cube' }, position: { onObject: 'chair' } }] }, 'TARGET_NOT_READY');
  }
  for (const position of [{ world: { x: 0, y: 0, z: 0 } }, { between: ['alex', 'other'], fraction: 0.5, support: 'floor' }, { onObject: 'chair' }]) {
    rejected(setup(), 'arrange_objects', { collisionPolicy: 'avoid', ops: [{ op: 'create', source: { kind: 'chair' }, position }] }, 'INVALID_ARGUMENT');
  }
  {
    const f = setup();
    // Crate [-.87,-.50] yields independently specified .12m overlap.
    seed(f, updateSceneObject([createSceneObject('cube')], 'cube', { x: -0.685, scaleX: 0.37, scaleZ: 0.4 })[0]);
    const receipt = execute(f, 'arrange_objects', { ops: [chair('shot_camera')] }); ok(receipt);
    near(receipt.checks.maximumFootprintOverlapM, 0.12); assert.deepEqual(receipt.checks.overlapIds, ['cube']);
    f.stores.objects.undo(); f.state.revision++;
    const avoided = execute(f, 'arrange_objects', { collisionPolicy: 'avoid', ops: [chair('shot_camera')] }); ok(avoided);
    near(f.state.objects[1].x, -1.17); near(avoided.checks.actualGapM, 0.62); assert.deepEqual(avoided.checks.overlapIds, []);
    const g = setup(); seed(g, updateSceneObject([createSceneObject('cube')], 'cube', { x: -1.05 })[0]);
    rejected(g, 'arrange_objects', { collisionPolicy: 'avoid', ops: [chair('world')] }, 'VERIFICATION_FAILED');
  }
  console.log('PASS failure atomicity: operation 2, references, support readiness, vertical camera, missing rig, avoid grammar and bounded correction');
  {
    const f = setup();
    ok(execute(f, 'arrange_objects', { ops: [chair('world'), { op: 'create', source: { kind: 'cube' }, position: { world: { x: 3, y: 0, z: 0 } } }] }));
    assert.equal(f.stores.objects.depths().past, 1);
    ok(execute(f, 'arrange_objects', { ops: [{ op: 'group', parentId: 'chair', childIds: ['cube'] }, { op: 'update', id: 'chair', position: { world: { x: 0, y: 0, z: 0 } } }] }));
    near(f.state.objects[1].x, 4.05); assert.equal(f.state.objects[1].parent, 'chair');
    rejected(f, 'arrange_objects', { ops: [{ op: 'group', parentId: 'cube', childIds: ['chair'] }] }, 'INVALID_ARGUMENT');
    ok(execute(f, 'arrange_objects', { ops: [{ op: 'remove', id: 'chair' }] })); assert.equal(f.state.objects[0].parent, null);
    const depths = f.stores.objects.depths();
    const noop = execute(f, 'arrange_objects', { ops: [{ op: 'update', id: 'cube', position: { world: { x: 4.05, y: 0, z: 0 } } }] });
    ok(noop); assert.equal(noop.status, 'noop'); assert.deepEqual(f.stores.objects.depths(), depths);
  }
  {
    const f = setup();
    ok(execute(f, 'arrange_characters', { ops: [{ op: 'create', name: 'Bob', position: relative('world'), scale: 2 }] }));
    const bob = f.state.characters[1]; near(bob.x, -1.25); assert.equal(bob.scale, 2); assert.equal(f.state.activeCharacterId, 'alex');
    assert.equal(f.stores.cast.depths().past, 1); assert.equal(f.stores.objects.depths().past, 0);
    const snapshot = structuredClone(bob.layer);
    ok(execute(f, 'arrange_characters', { ops: [{ op: 'update', characterId: bob.id, name: 'Robert', hidden: true }] }));
    assert.deepEqual(f.state.characters[1].layer, snapshot);
    ok(execute(f, 'arrange_characters', { ops: [{ op: 'remove', characterId: bob.id }] }));
    rejected(f, 'arrange_characters', { ops: [{ op: 'remove', characterId: 'alex' }] }, 'INVALID_ARGUMENT');
    rejected(f, 'arrange_characters', { ops: [{ op: 'create', name: 'Alex', position: { world: { x: 1, y: 0, z: 0 } } }] }, 'DUPLICATE_NAME');
  }
  {
    const f = setup(); seed(f, updateSceneObject([createSceneObject('cube')], 'cube', { x: 4 })[0]);
    const receipt = execute(f, 'arrange_objects', { ops: [
      { op: 'create', source: { kind: 'chair' }, position: { ...relative('world'), relativeTo: 'cube' } },
      { op: 'update', id: 'cube', position: { world: { x: 5, y: 0, z: 0 } } },
    ] });
    assert.equal(receipt.ok, false); assert.equal(receipt.code, 'STALE_SCENE'); assert.equal(receipt.mutated, false);
    assert.deepEqual(f.state.objects.map(({ id, x, z }) => ({ id, x, z })), [{ id: 'cube', x: 4, z: 0 }]);
  }
  console.log('PASS domain drafts: object grouping/removal/carried children, no-op, cast-only history and preserved layers/active selection');
  const framing = { intent: { size: 'medium shot', view: 'front', level: 'eye', side: 'right', focalMm: 35 } };
  {
    const f = setup(); const before = structuredClone(f.state.shotState);
    const receipt = execute(f, 'frame_shot', { subjectIds: ['alex'], framing, keyAtFrame: 48 }); ok(receipt);
    const shot = f.state.shotDocument.shots[0];
    assert.equal(shot.name, 'Shot 1'); assert.equal(shot.startFrame, 0); assert.equal(shot.endFrame, 143); assert.equal(shot.cameraKeys[0].frame, 48);
    near(f.state.camera.position.y, 1.65);
    const distance = 1.8 * 35 / (0.975 * 20.25); // full-frame 36mm / (16/9) gate, independent inversion
    near(f.state.camera.position.z, Math.sqrt(distance ** 2 - 0.35 ** 2));
    near(shot.cameraKeys[0].framing.fovDeg, 2 * Math.atan(20.25 / 70) * 180 / Math.PI);
    assert.equal(receipt.checks.derivedSize, 'medium shot'); assert.equal(f.stores.shot.depths().past, 1);
    assert.equal(f.commands.readDetails(receipt.commandId).geometry.created, true);
    f.stores.shot.undo(); assert.deepEqual(f.state.shotState, before);
  }
  {
    const f = setup(); f.state.frameCount = 0;
    rejected(f, 'frame_shot', { subjectIds: ['alex'], framing }, 'TARGET_NOT_READY');
    f.state.frameCount = 144; f.state.shotDocument.shots = [createShot('Later', 60, 100)];
    rejected(f, 'frame_shot', { subjectIds: ['alex'], framing }, 'AMBIGUOUS_TARGET');
    f.state.selectedShotId = f.state.shotDocument.shots[0].id;
    rejected(f, 'frame_shot', { subjectIds: ['alex'], framing, keyAtFrame: 101 }, 'INVALID_RANGE');
    const exact = { exact: { position: { x: 3, y: 2, z: 4 }, lookAt: { x: 0, y: 1, z: 0 }, focalMm: 35 } };
    ok(execute(f, 'frame_shot', { subjectIds: ['alex'], framing: exact, keyAtFrame: 80 }));
    assert.deepEqual(f.state.camera.position, exact.exact.position);
    assert.deepEqual(f.state.camera.lookAt, exact.exact.lookAt);
    rejected(f, 'frame_shot', { subjectIds: ['alex'], framing: { ...framing, intent: { ...framing.intent, focalMm: 1 } }, keyAtFrame: 80 }, 'INVALID_ARGUMENT');
  }
  {
    const a = setup(), b = setup();
    const exact = lookAt => ({ subjectIds: ['alex'], framing: { exact: { position: { x: 0, y: 1, z: 5 }, lookAt, focalMm: 35 } } });
    const first = execute(a, 'frame_shot', exact({ x: 0, y: 1, z: 0 }));
    const second = execute(b, 'frame_shot', exact({ x: 0, y: 1, z: 4 })); ok(first); ok(second);
    near(first.checks.screenFraction, second.checks.screenFraction);
  }
  console.log('PASS framing: real shot/key domain, independent filmback inversion, single Undo, exact lens/aim, no-shot/zero-frame/gap/key boundaries');
  {
    const f = setup(); const request = f.envelope('arrange_objects', { ops: [chair('world')] });
    const first = f.commands.execute(request); ok(first);
    assert.deepEqual(f.commands.execute(request), first); assert.equal(f.stores.objects.depths().past, 1);
    assert.deepEqual(f.commands.reconcile_studio_command({ commandId: request.commandId }), { status: 'applied', receipt: first });
    assert.equal(f.commands.reconcile_studio_command({ commandId: 'missing' }).status, 'unknown');
    assert.equal(f.commands.reconcile_studio_command({ commandId: request.commandId, host: { ...f.state.host, documentEpoch: 'reloaded' } }).status, 'unknown');
    const stale = f.envelope('arrange_objects', { ops: [{ op: 'update', id: 'chair', name: 'Renamed' }] }); stale.expectedTargets[0].token = 'old-token';
    assert.equal(f.commands.execute(stale).code, 'STALE_TARGET');
    const g = fixture(); const commit = g.ports.commit;
    g.ports.commit = draft => { commit(draft); throw new Error('lost acknowledgement after real history commit'); };
    const uncertain = mod.createStudioCommands(g.ports); const req = g.envelope('arrange_objects', { ops: [chair('world')] });
    const result = uncertain.execute(req); assert.equal(result.mutated, 'unknown'); validateReceipt(result);
    assert.equal(uncertain.reconcile_studio_command({ commandId: req.commandId }).status, 'unknown');
    assert.deepEqual(uncertain.execute(req), result); assert.equal(g.stores.objects.depths().past, 1);
    near(g.state.objects[0].x, -1.05);
    // A lost ack may follow a real commit. The owner records its authoritative
    // receipt later; reconciliation must settle the unknown without reapplying.
    uncertain.journal.record({ ...first, commandId: req.commandId, host: g.state.host });
    assert.equal(uncertain.reconcile_studio_command({ commandId: req.commandId }).status, 'applied');
    let clock = 0, retain = true;
    const journal = mod.createStudioCommandJournal({ host: f.state.host, now: () => clock, isRetained: () => retain, maxCompleted: 1 });
    journal.begin(first.commandId); journal.record(first); journal.begin('in-flight'); clock = 600001;
    journal.prune(); assert.equal(journal.reconcile({ commandId: first.commandId }).status, 'applied');
    retain = false; journal.prune(); assert.equal(journal.reconcile({ commandId: first.commandId }).status, 'unknown');
    assert.equal(journal.begin('in-flight'), false);
    const transient = validateReceipt({ ok: true, commandId: 'view', receiptId: 'view-receipt', host: f.state.host, status: 'transient', authored: false, revision: { before: 1, after: 1 }, affectedIds: ['alex'], delta: [{ id: 'alex', after: { activeCharacterId: 'alex' } }], checks: { coverage: 'view-only' }, view: { before: 0, after: 1 }, undo: null, warnings: [] });
    journal.begin('view'); journal.record(transient); assert.equal(journal.reconcile({ commandId: 'view' }).status, 'not_applied');
    f.state.host = { ...f.state.host, documentEpoch: 'reloaded' };
    assert.equal(f.commands.reconcile_studio_command({ commandId: first.commandId }).status, 'unknown');
    assert.equal(f.commands.execute(request).code, 'STALE_SCENE');
    assert.equal(f.commands.readDetails(first.commandId), null);
  }
  {
    const f = setup();
    const receipt = execute(f, 'arrange_objects', { ops: Array.from({ length: 20 }, (_, i) => ({ op: 'create', source: { kind: 'cube' }, name: `Cube ${i}`, position: { world: { x: i * 2 + 5, y: 0, z: 0 } } })) }); ok(receipt);
    assert.equal(receipt.affectedIds.length, 20); assert.equal(receipt.delta.length, 8); assert.ok(receipt.detailCursor);
    assert.equal(f.commands.readDetails(receipt.commandId).delta.length, 20); assert.equal(f.stores.objects.depths().past, 1);
    f.stores.objects.undo(); assert.equal(f.state.objects.length, 0);
  }
  console.log('PASS recovery: idempotent replay, explicit rejection vs missing/in-flight/reloaded/unknown, retained history, expiry and bounded batch detail readback');
  {
    const input = { objects: [], characters: [{ id: 'alex', incarnation: 'incarnation', modelId: 'y-bot-tpose', rigId: 'rig', rigReady: true, hidden: false, position: { x: 0, y: 0, z: 0 }, yawDeg: 0, scale: 1, takeId: null, sessionMotionId: null, motionRevision: 0, calibrationRevision: 0, ikRevision: 0, waypoints: [] }], floor: { model: 'flat', y: 0 }, frameCount: 144 };
    const before = physicsFingerprintInput(input);
    assert.deepEqual(physicsFingerprintInput({ ...input, frame: 99, selection: 'other', camera: { x: 2 } }), before);
    input.characters[0].ikRevision++; assert.notDeepEqual(physicsFingerprintInput(input), before);
    const ik = physicsFingerprintInput(input); input.characters[0].position.x = 1; assert.notDeepEqual(physicsFingerprintInput(input), ik);
    assert.equal(validateStudioCommand({ name: 'arrange_objects', args: { ops: [chair('world')] } }).args.collisionPolicy, 'report');
    assert.deepEqual(mod.studioObjectCatalogue().imageRefs, []);
  }
  console.log('PASS shared contract: normalized defaults, physical target/IK fingerprint changes and scrub/view exclusions; image variants not advertised');
}
if (import.meta.url === pathToFileURL(process.argv[1]).href) await run();

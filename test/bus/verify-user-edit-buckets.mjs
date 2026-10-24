// #922: the session edit buckets and craft:first_edit (definition_version 2) count
// the user's own committed edits from the command bus's receipts: one per receipt,
// grouped by the one action table in command-bus-telemetry.js. An agent edit, an
// MCP edit and undo/redo move nothing.
import assert from 'node:assert/strict';
import { appFixture } from './app-fixture.mjs';
import { castFixture } from './cast-fixture.mjs';
import { sessionEditBuckets } from '../../src/analytics.js';
import { editKind, firstEditKindOf, startUserEdits, telemetrySeam } from '../../src/command-bus-telemetry.js';
import { FIRST_EDIT_KINDS, FIRST_EDIT_VERSION } from '../../src/semantic-edit.js';

const sent = [];
let now = 5_000_000;
const restore = telemetrySeam({ track: (event, props) => sent.push({ event, props }), now: () => now });
const firstEdits = () => sent.splice(0).filter(row => row.event.endsWith(':first_edit'));
const ok = receipt => { assert.equal(receipt?.ok, true, JSON.stringify(receipt)); return receipt; };
// Gesture merging (EDIT_GESTURE_GAP_MS = 1000) joins same-group edits closer than 1 s;
// the buckets read Date.now(), so the checks below compare one group at a time.
const bucket = group => sessionEditBuckets()[`${group}_edit_bucket`];

// The action table covers every first-edit kind and agrees with the edit:undone groups.
assert.equal(FIRST_EDIT_VERSION, 2);
const table = {
  'shot.create': 'shot_add', 'shot.duplicate': 'shot_add', 'shot.rename': 'shot_edit', 'shot.setRange': 'shot_edit',
  'shot.addKey': 'camera_key_record', 'shot.setCamera': 'camera_key_record', 'shot.setCameraRail': 'rail_edit', 'shot.setCameraMode': 'rail_edit',
  'character.setPose': 'pose_edit', 'ik.setKey': 'pose_edit', 'motion.rangePin.apply': 'pose_edit',
  'object.add': 'object_insert', 'character.add': 'object_insert', 'object.set': 'object_transform', 'objects.arrange': 'object_transform', 'character.move': 'object_transform',
  'motion.set': 'prompt_block_edit', 'stage.set': null, 'scene.create': null, 'edit.undo': null, 'character.addWaypoint': null,
};
for (const [action, kind] of Object.entries(table)) assert.equal(firstEditKindOf(action), kind, action);
assert.equal(firstEditKindOf('asset.import', 'cutout'), 'cutout_insert');
assert.equal(firstEditKindOf('asset.import', 'mesh'), 'object_insert');
for (const kind of Object.values(table).filter(Boolean)) assert.ok(FIRST_EDIT_KINDS.includes(kind), kind);
assert.deepEqual(['shot.addKey', 'shot.rename', 'character.setPose', 'object.set', 'motion.set', 'stage.set'].map(action => editKind(action)), ['camera', 'shot', 'pose', 'object', 'prompt', 'other']);

// Each group's first counted edit moves its bucket from "0" to "1-3" (buckets are ranges).
// An agent or MCP edit first, on a group still at "0", proves they move nothing.
const c = castFixture();
try {
  startUserEdits('playground');
  assert.equal(bucket('pose'), '0');
  ok(c.run('character.setPose', { characterId: 'actor-a', pose: 'pose-wave' }, 'agent'));
  ok(c.run('character.setPose', { characterId: 'actor-a', pose: 'pose-wave' }, 'mcp'));
  assert.equal(bucket('pose'), '0', 'agent and MCP pose edits move nothing');
  assert.deepEqual(firstEdits(), [], 'and fire no first edit');
  ok(c.run('edit.undo', {}, 'ui'));
  assert.equal(bucket('pose'), '0', 'undo is history, not an edit');
  // A committed pose edit (the bone-drag commit is character.setPose) counts as pose.
  ok(c.run('character.setPose', { characterId: 'actor-a', pose: 'pose-wave' }, 'ui'));
  assert.equal(bucket('pose'), '1-3', 'a committed UI pose edit moves the pose bucket');
  assert.deepEqual(firstEdits(), [{ event: 'playground:first_edit', props: { edit_kind: 'pose_edit', definition_version: 2 } }], 'the playground surface has its own first edit');
} finally { c.dispose?.(); }

const f = appFixture();
try {
  for (const [action, args, group, kind] of [
    ['object.add', { kind: 'cube', name: 'Box', placement: { x: 0, z: 0 } }, 'object', 'object_insert'],
    ['shot.create', {}, 'shot', 'shot_add'],
    ['shot.addKey', 'shot', 'camera', 'camera_key_record'],
  ]) {
    startUserEdits('craft');
    assert.equal(bucket(group), '0', `${group} starts at 0`);
    const shotId = f.live.current.shots?.[0]?.id;
    ok(f.binding.bus.run(action, args === 'shot' ? { shotId, frame: 4 } : args, { origin: 'ui' }));
    assert.equal(bucket(group), '1-3', `${action} moves the ${group} bucket`);
    assert.deepEqual(firstEdits().map(row => row.props), [{ edit_kind: kind, definition_version: 2 }], `${action} fires craft:first_edit ${kind}`);
  }
  // A UI object.set is counted too (its first edit names it), and the first edit is once per mount.
  startUserEdits('craft');
  const id = f.live.current.objects?.[0]?.id ?? f.actual.objects?.[0]?.id;
  ok(f.binding.bus.run('object.set', { id, set: { position: { x: 1, y: 0, z: 0 } } }, { origin: 'ui' }));
  ok(f.binding.bus.run('shot.create', {}, { origin: 'ui' }));
  assert.deepEqual(firstEdits().map(row => row.props.edit_kind), ['object_transform'], 'object.set counts; the next edit does not fire a second first edit');
} finally { f.dispose(); restore(); }
console.log('PASS user edit buckets: UI object/shot/camera/pose receipts move their bucket and fire first_edit v2 once; agent, MCP and undo move nothing');

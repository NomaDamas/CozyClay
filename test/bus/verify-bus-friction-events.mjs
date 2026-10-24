// The command bus's friction events (command-bus-telemetry.js): studio:refused per
// refusal (3 per code, group and origin), edit:undone for the user's own undos
// (20 per session) with what was undone and how long ago, and runOrigin() naming
// who asked while an owned edit runs.
import assert from 'node:assert/strict';
import { appFixture } from './app-fixture.mjs';
import { deferred } from './fixture.mjs';
import * as friction from '../../src/analytics-friction.js';
import { strictPropValidator } from '../../src/analytics-strict.js';
import { runOrigin } from '../../src/bus-run-origin.js';
import { commandGroup, editKind, noteUndone, telemetrySeam } from '../../src/command-bus-telemetry.js';
import { createSceneUndo } from '../../src/domains/scene-undo.js';

const sent = [];
let now = 1_000_000;
const restore = telemetrySeam({ track: (event, props) => sent.push({ event, props }), now: () => now });
const take = event => sent.splice(0).filter(row => row.event === event).map(row => row.props);
// Every property sent must pass the event's closed schema (what track() would keep).
const closed = (event, props) => { const allowed = strictPropValidator(event); for (const [key, value] of Object.entries(props)) assert.ok(allowed(key, value), `${event}.${key}=${value}`); };

// Group and kind tables, from the real command ids.
assert.deepEqual(['object.add', 'objects.arrange', 'shot.create', 'character.add', 'characters.arrange', 'cast.replace', 'scene.set', 'motion.compile', 'edit.undo', 'task.begin', 'agent.turn.begin', 'stage.set', 'ik.setKey', 'job.await'].map(commandGroup),
  ['object', 'object', 'shot', 'cast', 'cast', 'cast', 'scene', 'motion', 'edit', 'task', 'agent', 'other', 'motion', 'other']);
const kinds = { 'character.setPose': 'pose', 'ik.setKey': 'pose', 'ik.applyPose': 'pose', 'character.setIkKey': 'pose', 'motion.rangePin.apply': 'pose',
  'shot.setCamera': 'camera', 'shot.addKey': 'camera', 'shot.moveKey': 'camera', 'shot.setCameraRail': 'camera', 'shot.clearCameraRail': 'camera', 'shot.setCameraMode': 'camera', 'shot.setLens': 'camera', 'shot.captureCamera': 'camera',
  'object.add': 'object', 'object.update': 'object', 'objects.arrange': 'object', 'character.add': 'object', 'character.move': 'object',
  'shot.create': 'shot', 'shot.setRange': 'shot', 'shot.remove': 'shot', 'motion.set': 'prompt',
  'agent.turn.finish': 'agent_turn', 'task.finish': 'agent_turn', 'stage.set': 'other', 'scene.set': 'other', 'motion.trim': 'other' };
for (const [action, kind] of Object.entries(kinds)) assert.equal(editKind(action), kind, action);
assert.equal(editKind('object.add', 'agent'), 'agent_turn', 'an edit the agent ran is agent work');

const f = appFixture();
try {
  friction.reset(); sent.length = 0;
  const inputs = { type: 'object', properties: {}, required: [], additionalProperties: false };
  const agent = (id, args = {}, extra = {}) => f.binding.bus.run(id, args, { origin: 'agent', host: f.host(), expectedRevision: f.binding.refresh().revision, ...extra });

  // studio:refused: closed values, 3 per (code, group, origin); past the cap only the counter moves.
  f.registry.register({ id: 'shot.testRefuse', kind: 'mutation', undoDomain: 'shot', input: inputs, available: () => true, run: () => { throw new Error('This edit is refused.'); } });
  for (let i = 0; i < 4; i++) assert.equal(f.binding.bus.run('shot.testRefuse', {}, { origin: 'ui' }).ok, false);
  const ui = take('studio:refused');
  assert.equal(ui.length, 3, 'three per key');
  assert.deepEqual(ui[0], { code: 'INVALID_ARGUMENT', origin: 'ui', phase: 'admission', group: 'shot' });
  assert.equal(friction.snapshot().refusals_ui, '4-5', 'the counter keeps every refusal');
  for (const props of ui) closed('studio:refused', props);
  const mcp = f.binding.bus.run('shot.testRefuse', {}, { origin: 'mcp', host: f.host(), expectedRevision: -1 });
  assert.equal(mcp.code, 'STALE_SCENE', JSON.stringify(mcp));
  assert.deepEqual(take('studio:refused'), [{ code: 'STALE_SCENE', origin: 'agent', phase: 'admission', group: 'shot' }], 'mcp is sent as agent');
  assert.equal(agent('shot.testRefuse').ok, false);
  assert.deepEqual(take('studio:refused'), [{ code: 'INVALID_ARGUMENT', origin: 'agent', phase: 'admission', group: 'shot' }], 'a new origin is a new key');

  // A cancel the caller asked for is neither an event nor a counted refusal.
  const started = deferred();
  f.registry.register({ id: 'test.cancellable', kind: 'job', domain: 'motion', input: inputs, available: () => true,
    run: (_args, ctx) => new Promise((_resolve, reject) => { started.resolve(); ctx.signal.addEventListener('abort', () => reject(ctx.signal.reason)); }) });
  const admitted = await f.binding.bus.run('test.cancellable', {}, { origin: 'ui', wait: false });
  await started.promise;
  const cancelled = await f.binding.bus.run('job.cancel', { jobId: admitted.jobId }, { origin: 'ui' });
  assert.equal(cancelled.code, 'CANCELLED');
  assert.deepEqual(take('studio:refused'), [], 'CANCELLED sends nothing');
  assert.equal(friction.snapshot().refusals_ui, '4-5');

  // runOrigin(): the requester while an owned edit runs, null outside any run.
  const seen = [];
  f.registry.register({ id: 'shot.testProbe', kind: 'mutation', undoDomain: 'shot', input: inputs, available: () => true, run: () => { seen.push(runOrigin()); return { affectedIds: [] }; } });
  assert.equal(runOrigin(), null);
  f.binding.bus.run('shot.testProbe', {}, { origin: 'ui' });
  agent('shot.testProbe');
  const tx = f.binding.bus.run('run.begin', { id: 'shot.testProbe', args: {} }, { origin: 'ui' });
  f.binding.bus.run('run.update', { txId: tx.txId, args: {} }, { origin: 'ui' });
  f.binding.bus.run('run.commit', { txId: tx.txId }, { origin: 'ui' });
  const turnId = crypto.randomUUID();
  assert.equal(agent('agent.turn.begin', { turnId }, { turnId }).ok, true);
  agent('shot.testProbe', {}, { turnId });
  assert.deepEqual(seen, ['ui', 'agent', 'ui', 'agent'], 'UI edit, agent edit, a UI drag update, an edit inside the agent turn');
  assert.equal(runOrigin(), null, 'null again outside the run');

  // edit:undone: the agent turn's transaction undone by the user is agent_turn, aged from its receipt.
  assert.equal(agent('shot.create', {}, { turnId }).ok, true);
  assert.equal(agent('agent.turn.finish', { turnId }, { turnId }).ok, true);
  sent.length = 0; now += 1500;
  assert.equal(f.actual.undoScene('key').status, 'undone');
  assert.deepEqual(take('edit:undone'), [{ kind: 'agent_turn', via: 'key', result: 'done', age: 'lt2s' }]);

  // The user's own edit: its kind from the action, its age bucket from the stamp.
  assert.equal(f.actual.runStudioAction('shot.create')?.ok, true);
  now += 12_000;
  assert.equal(f.actual.undoScene('menu').status, 'undone');
  const [own] = take('edit:undone');
  assert.deepEqual(own, { kind: 'shot', via: 'menu', result: 'done', age: '10-60s' });
  closed('edit:undone', own);
  assert.equal(friction.snapshot().undos, '2', 'the counter still counts user undos');
  const agentUndo = agent('edit.undo');
  assert.notEqual(agentUndo.status, 'undone', JSON.stringify(agentUndo).slice(0, 200));
  assert.deepEqual(take('edit:undone'), [], 'the agent undo_edit sends nothing');

  // Undo with nothing left: noop (or the oldest native entry, other with no receipt and no age).
  let last;
  for (let i = 0; i < 30 && last?.status !== 'noop'; i++) last = f.actual.undoScene('key');
  assert.equal(last.status, 'noop', JSON.stringify(last).slice(0, 200));
  const rest = take('edit:undone');
  assert.deepEqual(rest.at(-1), { kind: 'other', via: 'key', result: 'noop' });
  for (const props of rest.slice(0, -1)) assert.equal(props.result, 'done');
  for (const props of rest) closed('edit:undone', props);
} finally { f.dispose(); }

// scene-undo.js over stub buses: a refused undo, and an IK preview backed out.
const stub = (receipt, ik = false) => createSceneUndo({ notify() {}, shared: { motionDomain: { cancelPendingIkEdit: () => ik } }, bus: { run: () => receipt, noteUndone } });
stub({ ok: false, code: 'UNDO_CONFLICT', message: 'Another edit owns the history boundary.' }).undoScene('button');
stub(null, true).undoScene('key');
assert.deepEqual(take('edit:undone'), [{ kind: 'other', via: 'button', result: 'refused' }, { kind: 'ik_preview', via: 'key', result: 'done' }]);
// A bus without the hook (older fixtures) still undoes.
assert.equal(createSceneUndo({ notify() {}, shared: {}, bus: { run: () => ({ ok: true, status: 'undone' }) } }).undoScene('key').status, 'undone');

// 20 per session; past it nothing is sent.
friction.reset(); sent.length = 0;
for (let i = 0; i < 25; i++) noteUndone('key', { ok: true, status: 'noop' });
assert.equal(take('edit:undone').length, 20, 'twenty per session');
restore(); friction.reset();
console.log('PASS bus friction events: studio:refused 3/key, CANCELLED skipped, mcp as agent, edit:undone kind/age/result/via, ik_preview, 20 cap, runOrigin');

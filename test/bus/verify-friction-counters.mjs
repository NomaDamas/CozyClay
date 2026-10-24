// The command bus feeds the session friction counters (app:friction_summary):
// refusals by origin, and undos the user made. A cancel the caller asked for is
// not a refusal, and an agent's own undo is not user regret.
import assert from 'node:assert/strict';
import { appFixture } from './app-fixture.mjs';
import { deferred } from './fixture.mjs';
import * as friction from '../../src/analytics-friction.js';

const f = appFixture();
try {
  friction.reset();
  const inputs = { type: 'object', properties: {}, required: [], additionalProperties: false };
  f.registry.register({ id: 'test.refuse', kind: 'mutation', undoDomain: 'shot', input: inputs, available: () => true,
    run: () => { throw new Error('This edit is refused.'); } });
  const refused = await f.binding.bus.run('test.refuse', {}, { origin: 'ui' });
  assert.equal(refused.ok, false, JSON.stringify(refused));
  assert.deepEqual([friction.snapshot().refusals_ui, friction.snapshot().refusals_agent], ['1', '0'], 'a UI refusal counts as refusals_ui');

  const agentRefused = await f.binding.bus.run('test.refuse', {}, { origin: 'agent' });
  assert.equal(agentRefused.ok, false);
  assert.deepEqual([friction.snapshot().refusals_ui, friction.snapshot().refusals_agent], ['1', '1'], 'any other origin counts as refusals_agent');

  // A job the caller cancels ends as a CANCELLED refusal receipt, but is no friction.
  const started = deferred();
  f.registry.register({ id: 'test.cancellable', kind: 'job', domain: 'motion', input: inputs, available: () => true,
    run: (_args, ctx) => new Promise((_resolve, reject) => { started.resolve(); ctx.signal.addEventListener('abort', () => reject(ctx.signal.reason)); }) });
  const admitted = await f.binding.bus.run('test.cancellable', {}, { origin: 'ui', wait: false });
  await started.promise;
  assert.equal(admitted.status, 'started', JSON.stringify(admitted));
  const cancelled = await f.binding.bus.run('job.cancel', { jobId: admitted.jobId }, { origin: 'ui' });
  assert.equal(cancelled.code, 'CANCELLED', JSON.stringify(cancelled));
  assert.equal(friction.snapshot().refusals_ui, '1', 'a cancelled job is not counted as a refusal');

  const edit = await f.actual.runStudioAction('shot.create');
  assert.equal(edit?.ok, true, JSON.stringify(edit));
  const undo = await f.binding.bus.run('edit.undo', { receiptId: edit.receiptId }, { origin: 'ui' });
  assert.equal(undo.status, 'undone', JSON.stringify(undo));
  assert.equal(friction.snapshot().undos, '1', 'a UI undo counts');
  const empty = await f.binding.bus.run('edit.undo', {}, { origin: 'ui' });
  assert.notEqual(empty.status, 'undone');
  assert.equal(friction.snapshot().undos, '1', 'an undo with nothing to undo does not count');
  console.log('PASS bus friction counters: refusals by origin, a cancelled job excluded, user undos only');
} finally { f.dispose(); friction.reset(); }

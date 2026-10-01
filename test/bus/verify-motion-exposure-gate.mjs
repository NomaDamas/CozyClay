import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createStudioTools } from '../../bin/agent/studio-tools.mjs';
import { generationFixture } from './generation-fixture.mjs';
import { declarations } from '../../src/commands/motion.js';
import { deferred } from './fixture.mjs';

test('#444.7: paid video remains confirmation-gated for every non-UI origin', async () => {
  const f = generationFixture(); let calls = 0;
  const state = f.actionHandlers.current.state;
  f.actionHandlers.current.state = () => ({ ...state(), i2vMotion: { enabled: true, status: 'idle', dailyRemaining: 2 } });
  f.actionHandlers.current.generateI2vMotion = async () => { calls++; return { job: { video: { url: 'https://video.invalid/take.mp4' } } }; };
  try {
    assert.equal(f.registry.get('motion.generateFromVideo').exposure, 'confirm');
    for (const origin of ['agent', 'mcp', 'cli']) assert.equal((await f.run('motion.generateFromVideo', { instruction: 'Walk' }, origin)).code, 'CONFIRMATION_REQUIRED');
    assert.equal(calls, 0);
    const confirmationToken = f.binding.bus.confirm('motion.generateFromVideo', { instruction: 'Walk' });
    assert.equal((await f.run('motion.generateFromVideo', { instruction: 'Walk' }, 'agent', { confirmationToken })).ok, true);
    assert.equal(calls, 1);
  } finally { f.dispose(); }
});
test('#444: the declared generation gate includes an in-flight alias and allows a later message', async () => {
  const entered = deferred(), release = deferred(); let calls = 0;
  const liveHub = { command: async () => { calls++; entered.resolve(); await release.promise; return { ok: true, status: 'completed' }; } };
  const session = () => ({ actionIndex: declarations });
  const tools = createStudioTools({ liveHub, workspaceHandle: 'workspace', session: session() });
  const args = { characterId: 'actor', source: { kind: 'generate', beats: [{ text: 'Walk' }], durationSeconds: 2 } };
  const running = tools.internal.invoke('generate_motion', args);
  await entered.promise;
  try {
    const rejected = assert.rejects(tools.internal.invoke('run_action', { action: 'motion.generate', args: { characterId: 'actor' } }), { code: 'GENERATION_LIMIT' });
    release.resolve(); await rejected;
    assert.equal(calls, 1);
  } finally { release.resolve(); await running; }
  await assert.rejects(tools.internal.invoke('generate_motion', args), { code: 'GENERATION_LIMIT' });
  await createStudioTools({ liveHub, workspaceHandle: 'workspace', session: session() }).internal.invoke('generate_motion', args);
  assert.equal(calls, 2);
});

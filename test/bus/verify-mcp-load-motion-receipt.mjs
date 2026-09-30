import assert from 'node:assert/strict';
import { test } from 'node:test';
import { motionFixture, seedMotion } from './motion-fixture.mjs';
import { motionBytes } from './generation-fixture.mjs';
import { createToolHandlers, setLiveHub, liveWorkspace } from '../../mcp/tool-handlers.mjs';

test('#495.3: MCP load_motion returns the owned replacement receipt and edit.undo restores the take', async () => {
  const f = motionFixture(), fetch = globalThis.fetch, calls = [];
  f.motion.load([{ id: 'actor-a', take: seedMotion(48) }]);
  const before = f.snapshot();
  globalThis.fetch = async url => { assert.equal(url, '/ardy/motions/123456-abcdef'); return new Response(motionBytes); };
  setLiveHub({ connected: true, command: async (name, args) => {
    calls.push(name);
    if (name === 'load_motion') return { loaded: true }; // Retired transport acknowledgement cannot satisfy the assertions below.
    return f.binding.handlers[name](args);
  } });
  try {
    const tool = createToolHandlers().find(tool => tool.name === 'load_motion');
    const response = await liveWorkspace.run('fixture', () => tool.handler({ url: '/ardy/motions/123456-abcdef', prompt: 'Replacement' }));
    let receipt; try { receipt = JSON.parse(response.content[0].text); } catch { receipt = null; }
    assert.equal(receipt?.action, 'motion.replace', response.content[0].text);
    assert.equal(receipt.ok, true); assert.equal(receipt.undo.entries, 1);
    assert.equal(f.motion.motionFor('actor-a').frames, 96);
    assert.equal(calls.includes('load_motion'), false);
    assert.equal(f.run('edit.undo', { receiptId: receipt.receiptId }).status, 'undone');
    assert.deepEqual(f.snapshot(), before);
  } finally { setLiveHub(null); globalThis.fetch = fetch; f.dispose(); }
});
test('#495.3: registered replacement retains drop and prompt clips in its one undo entry', async () => {
  const f = motionFixture(), fetch = globalThis.fetch;
  globalThis.fetch = async () => new Response(motionBytes);
  try {
    const before = f.snapshot();
    const blocks = [{ startFrame: 0, endFrame: 48, prompt: 'Fall' }, { startFrame: 48, endFrame: 96, prompt: 'Land' }];
    const receipt = await f.run('motion.replace', { characterId: 'actor-a', url: '/ardy/motions/123456-abcdef', blocks, drop: { from_s: 0.5, to_s: 2, meters: 2 } });
    assert.equal(receipt.ok, true, JSON.stringify(receipt));
    assert.deepEqual(f.cast.read()[0].layer.promptClips.map(({ id, ...clip }) => clip), blocks.map(({ prompt: text, ...clip }) => ({ ...clip, text })));
    const take = f.motion.motionFor('actor-a');
    assert.ok(take.rootPos[72 * 3 + 1] < take.rootPos[1] - 1, 'explicit root drop reaches the authored take');
    assert.equal(f.motion.documentStore.depths().past, 1);
    assert.equal(f.run('edit.undo', { receiptId: receipt.receiptId }).ok, true);
    assert.deepEqual(f.snapshot(), before);
  } finally { globalThis.fetch = fetch; f.dispose(); }
});

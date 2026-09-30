#!/usr/bin/env node
// MCP stdio -> live-control -> shipped binding/owner -> HTTP bridge -> real NPZ.
// Only the retired server task registry and separate installation protocol are gone.
import assert from 'node:assert/strict';
import { createServer as createHttpServer } from 'node:http';
import { createServer } from 'node:net';
import { fileURLToPath } from 'node:url';
import { once } from 'node:events';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { WebSocket } from 'ws';
import { createLiveControl } from '../src/live-control.js';
import { checkBridge } from '../src/ardy/client.js';
import { validateReceipt } from '../src/studio-agent-protocol.js';
import { generationFixture, motionBytes } from '../test/bus/generation-fixture.mjs';

const bounded = promise => {
  let timer;
  return Promise.race([promise, new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error('MCP motion event deadline')), 15000);
  })]).finally(() => clearTimeout(timer));
};
const reservePort = () => new Promise((resolve, reject) => {
  const server = createServer();
  server.once('error', reject);
  server.listen(0, '127.0.0.1', () => {
    const { port } = server.address();
    server.close(error => error ? reject(error) : resolve(port));
  });
});
// Register observers before triggering actions; buffer cross-transport arrivals.
const channel = () => {
  const values = [], waiters = [];
  return {
    push(value) {
      const index = waiters.findIndex(waiter => waiter.matches(value));
      if (index < 0) values.push(value);
      else waiters.splice(index, 1)[0].resolve(value);
    },
    next(matches = () => true) {
      const index = values.findIndex(matches);
      return index >= 0 ? Promise.resolve(values.splice(index, 1)[0])
        : new Promise(resolve => waiters.push({ matches, resolve }));
    },
  };
};
const port = Number(process.env.COZYCLAY_LIVE_PORT) || await reservePort();
const f = generationFixture(), originalFetch = globalThis.fetch;
const client = new Client({ name: 'verify-bus-motion', version: '1.0.0' });
const requests = channel(), settled = channel(), downloads = channel();
const generations = [], artifactRequests = [], connections = [], events = [], bridgeErrors = [];
const unsubscribe = f.binding.bus.subscribe(event => events.push(event));
let health = { ok: true, host: 'private-gpu-host', device: 'cuda', backend: 'kimodo' };
let healthGate, healthCount = 0, plan = {}, downloadGate, rejectDownload = false;
let captureMode = 'ok', editor, loseReply;
const gates = [];
const gate = () => { const value = Promise.withResolvers(); gates.push(value); return value; };
// Observe the queue's actual producer completion, including abort cleanup, not a delay.
const pendingRef = f.scope.generationPendingRef;
let pending = pendingRef.current;
Object.defineProperty(pendingRef, 'current', {
  configurable: true, get: () => pending,
  set(value) { const wasPending = pending; pending = value; if (wasPending && !value) settled.push(true); },
});
const bridge = createHttpServer((request, response) => {
  void serve(request, response).catch(error => { bridgeErrors.push(error); response.destroy(error); });
});
async function serve(request, response) {
  if (request.url === '/ardy/health') {
    healthCount++;
    if (healthGate) { const held = healthGate; healthGate = null; held.arrived.resolve(); await held.release.promise; }
    if (health.disconnect) return response.destroy();
    response.writeHead(health.ok ? 200 : 503, { 'content-type': 'application/json' });
    return response.end(JSON.stringify(health));
  }
  if (request.url === '/ardy/generate' && request.method === 'POST') {
    const outcome = plan; plan = {};
    let body = '';
    for await (const chunk of request) body += chunk;
    const aborted = Promise.withResolvers();
    response.once('close', () => { if (!response.writableFinished) aborted.resolve(); });
    const generation = { body: JSON.parse(body), aborted: aborted.promise, release: gate() };
    generations.push(generation); requests.push(generation);
    if (outcome.held) await Promise.race([generation.release.promise, generation.aborted]);
    if (response.destroyed) return;
    response.writeHead(outcome.status ?? 200, { 'content-type': 'application/x-ndjson' });
    // Duplicate terminal packets must not produce a second download or commit.
    const packet = outcome.error ? { event: 'error', message: outcome.error }
      : { event: 'done', motionUrl: outcome.url ?? '/ardy/motions/123456-abcdef' };
    return response.end((JSON.stringify(packet) + '\n').repeat(2));
  }
  artifactRequests.push(request.url); downloads.push(request.url);
  if (downloadGate) { const held = downloadGate; downloadGate = null; await held.promise; }
  if (rejectDownload) return response.writeHead(200).end('not an NPZ');
  if (request.url !== '/ardy/motions/123456-abcdef') return response.writeHead(404).end();
  response.writeHead(200, { 'content-type': 'application/octet-stream' });
  response.end(motionBytes);
}
await new Promise((resolve, reject) => {
  bridge.once('error', reject);
  bridge.listen(0, '127.0.0.1', resolve);
});
const bridgeUrl = `http://127.0.0.1:${bridge.address().port}`;
const transport = new StdioClientTransport({
  command: process.execPath,
  args: [fileURLToPath(new URL('./server.mjs', import.meta.url)), '--live-port', String(port)],
  env: { ...process.env, COZYCLAY_LIVE_PORT: String(port), COZYCLAY_BRIDGE: bridgeUrl },
});
// Supply the browser's same-origin URL resolution only. HTTP, streaming,
// request bodies, AbortSignal and NPZ decoding all use their real implementations.
globalThis.fetch = (url, options) => originalFetch(typeof url === 'string' && url.startsWith('/') ? new URL(url, bridgeUrl) : url, options);
const capture = collection => (event, props) => {
  collection.push({ event, props });
  if (captureMode === 'throw') throw new Error('SDK unavailable');
  if (captureMode === 'reject') return Promise.reject(new Error('SDK rejected capture'));
};
async function connect(observer = false) {
  const ready = Promise.withResolvers(), frames = channel();
  const connection = { wire: [], telemetry: [], motionTelemetry: [], frames };
  connection.control = createLiveControl({
    url: `ws://127.0.0.1:${port}/live`, workspaceId: observer ? 'unrelated-workspace' : f.host().workspaceId,
    WebSocketImpl: class extends WebSocket { constructor(url) { super(url); connection.socket = this; } },
    onWorkspace: ready.resolve,
    captureTelemetry: capture(connection.telemetry), captureMotionTelemetry: capture(connection.motionTelemetry),
    handlers: observer ? {} : { ...f.binding.handlers, run_action: async args => {
      const receipt = await f.binding.handlers.run_action(args);
      if (loseReply && args.args.action === 'job.await') {
        const lost = loseReply; loseReply = null;
        connection.control.close(); lost.resolve(receipt);
      }
      return receipt;
    } },
  });
  connection.socket.on('message', raw => { const frame = JSON.parse(raw); connection.wire.push(frame); frames.push(frame); });
  connections.push(connection);
  connection.handle = await bounded(ready.promise);
  return connection;
}
async function disconnect(connection) {
  const closed = once(connection.socket, 'close'); connection.control.close(); await bounded(closed);
}
async function barrier(connection = editor) {
  const pong = connection.frames.next(frame => frame.type === 'pong');
  connection.socket.send(JSON.stringify({ type: 'ping' })); await bounded(pong);
}
const defaults = { phases: [{ text: 'A person walks.', seconds: 4 }], seed: 17 };
const rawCall = (name, args = {}, connection = editor) => bounded(client.callTool({
  name, arguments: { ...args, ...(connection ? { workspace_handle: connection.handle } : {}) },
}));
async function call(name, args = {}) {
  const response = await rawCall(name, args), receipt = JSON.parse(response.content[0].text);
  validateReceipt(receipt);
  assert.equal(Boolean(response.isError), receipt.ok === false);
  return receipt;
}
const ok = receipt => { assert.equal(receipt.ok, true, JSON.stringify(receipt)); return receipt; };
const run = (action, args) => call('studio_run', { action, args });
function begin(args = defaults, outcome = {}) {
  plan = outcome;
  const arrival = requests.next(), finished = settled.next();
  return { arrival, finished, reply: call('generate_motion', args) };
}
async function complete(attempt) {
  const initial = await attempt.reply;
  const receipt = initial.status === 'started' ? await run('job.await', { jobId: initial.jobId }) : initial;
  await bounded(attempt.finished);
  return receipt;
}
function started(receipt) {
  ok(receipt);
  assert.equal(receipt.status, 'started'); assert.equal(receipt.kind, 'job');
  assert.equal(receipt.action, 'motion.generate'); assert.equal(receipt.authored, false);
  for (const key of ['jobId', 'commandId', 'receiptId']) assert.equal(typeof receipt[key], 'string');
  assert.equal(receipt.host.workspaceId, f.host().workspaceId);
  assert.ok(Number.isInteger(receipt.revision.before) && Number.isInteger(receipt.revision.after));
  assert.equal(receipt.undo, null);
  for (const key of ['taskId', 'createdAt', 'lastUpdatedAt', 'ttlMs', 'pollIntervalMs']) assert.equal(Object.hasOwn(receipt, key), false);
  return receipt;
}
async function undo(receipt, before) {
  assert.equal(receipt.undo.entries, 1);
  assert.equal(ok(await run('edit.undo', { receiptId: receipt.receiptId })).status, 'undone');
  assert.deepEqual(f.snapshot(), before);
}
async function refreshHealth() { f.motion.setBridge(await checkBridge()); f.renderGeneration(); }
try {
  await client.connect(transport);
  await rawCall('generate_motion', defaults, null);
  assert.equal(healthCount, 0); assert.equal(generations.length, 0); assert.equal(artifactRequests.length, 0);
  editor = await connect();
  await refreshHealth();

  // Success is not application: withhold the actual artifact response.
  const before = f.snapshot(), download = downloads.next();
  const heldDownload = gate(); downloadGate = heldDownload;
  const first = begin(), firstRequest = await bounded(first.arrival);
  assert.equal(firstRequest.body.seed, 17); assert.equal(firstRequest.body.duration, 4);
  await bounded(download);
  const firstStarted = started(await first.reply);
  assert.equal(f.motion.motionFor('actor-a'), null);
  const completion = run('job.await', { jobId: firstStarted.jobId });
  heldDownload.resolve(); const installed = ok(await completion); await bounded(first.finished);
  assert.equal(installed.status, 'completed'); assert.equal(installed.jobId, firstStarted.jobId);
  assert.equal(installed.action, 'motion.generate'); assert.ok(installed.affectedIds.includes('actor-a'));
  // Timeline extension can affect both cast rows; only the requesting actor gets a take.
  assert.equal(f.motion.motionFor('actor-a').frames, 96); assert.equal(f.motion.motionFor('actor-b'), null);
  assert.equal(editor.wire.find(frame => frame.name === 'run_action').args.args.args.characterId, 'actor-a');
  assert.equal(artifactRequests.length, 1); assert.equal(generations.length, 1);
  assert.equal(events.filter(event => event.jobId === firstStarted.jobId && event.type === 'job.completed').length, 1);
  await undo(installed, before);

  // Reuse bypasses even unavailable generation, while preserving blocks/drop.
  health = { ok: false, host_configured: false }; await refreshHealth();
  const reuseCounts = [healthCount, generations.length], reuseBefore = f.snapshot();
  const reused = ok(await call('generate_motion', { ...defaults, motion_url: '/ardy/motions/123456-abcdef', drop: { from_s: 0.5, to_s: 2, meters: 2 } }));
  assert.equal(reused.action, 'motion.replace'); assert.deepEqual([healthCount, generations.length], reuseCounts);
  assert.equal(f.cast.read()[0].layer.promptClips.at(-1).endFrame, 96);
  const take = f.motion.motionFor('actor-a'); assert.ok(take.rootPos[72 * 3 + 1] < take.rootPos[1] - 1);
  await undo(reused, reuseBefore);
  const invalidReuseCounts = [healthCount, generations.length, artifactRequests.length];
  assert.equal((await rawCall('generate_motion', { ...defaults, motion_url: '/ardy/../../outside.npz' })).isError, true);
  assert.deepEqual([healthCount, generations.length, artifactRequests.length], invalidReuseCounts);

  // Cached editor readiness replaces the removed per-request server health job.
  for (const state of [{ ok: false, host_configured: false }, { ok: false }, { disconnect: true }, { ok: true, host: 'local', device: 'local' }]) {
    health = state; await refreshHealth(); const count = generations.length;
    const refused = await call('generate_motion', { phases: [{ text: 'Walk', seconds: 2 }, { text: 'Stop', seconds: 2 }] });
    assert.equal(refused.code, 'TARGET_NOT_READY'); assert.equal(generations.length, count);
    assert.equal(f.motion.motionFor('actor-a'), null);
  }
  // Pending health cannot be mistaken for readiness or launch paid work.
  f.motion.setBridge(null); f.renderGeneration();
  health = { ok: true, host: 'private-gpu-host', device: 'cuda', backend: 'kimodo' };
  const probe = { arrived: gate(), release: gate() }; healthGate = probe;
  const healthRequest = refreshHealth(); await bounded(probe.arrived.promise);
  const probeCount = generations.length;
  assert.equal((await call('generate_motion', defaults)).code, 'TARGET_NOT_READY');
  assert.equal(generations.length, probeCount);
  probe.release.resolve(); await bounded(healthRequest);

  // Decode/install rejection, invalid artifact, stream error and HTTP refusal.
  for (const outcome of [{ decode: true }, { url: '/ardy/../../outside.npz' }, { error: 'raw generator error private prompt private-gpu-host' }, { status: 500, error: 'raw generator error' }]) {
    rejectDownload = Boolean(outcome.decode);
    const generationCount = generations.length, artifactCount = artifactRequests.length;
    const failed = await complete(begin(defaults, outcome));
    assert.equal(failed.ok, false); assert.equal(f.motion.motionFor('actor-a'), null);
    assert.notEqual(failed.status, 'completed');
    assert.equal(generations.length, generationCount + 1);
    assert.equal(artifactRequests.length - artifactCount, outcome.error ? 0 : 1);
    rejectDownload = false;
  }

  // Double cancel reaches the real HTTP AbortSignal, completes once, never loads.
  const cancelledAttempt = begin(defaults, { held: true });
  const cancellableRequest = await bounded(cancelledAttempt.arrival);
  const cancellable = started(await cancelledAttempt.reply), downloadsBeforeCancel = artifactRequests.length;
  const abort = bounded(cancellableRequest.aborted);
  for (let i = 0; i < 2; i++) assert.equal((await run('job.cancel', { jobId: cancellable.jobId })).code, 'CANCELLED');
  await abort; await bounded(cancelledAttempt.finished);
  assert.equal((await run('job.await', { jobId: cancellable.jobId })).code, 'CANCELLED');
  assert.equal(artifactRequests.length, downloadsBeforeCancel); assert.equal(f.motion.motionFor('actor-a'), null);
  assert.equal(events.filter(event => event.jobId === cancellable.jobId && event.type === 'job.completed').length, 1);

  // Busy admission cannot rewrite the running request or start another POST.
  const recoveryBefore = f.snapshot(), recovering = begin(defaults, { held: true });
  const recoveryRequest = await bounded(recovering.arrival), recoveringJob = started(await recovering.reply);
  const count = generations.length, cast = structuredClone(f.cast.read());
  assert.equal((await call('generate_motion', { phases: [{ text: 'Run', seconds: 4 }] })).code, 'TARGET_BUSY');
  assert.equal(generations.length, count); assert.deepEqual(f.cast.read(), cast);
  await disconnect(editor);
  recoveryRequest.release.resolve(); await bounded(recovering.finished);
  editor = await connect();
  const recovered = ok(await run('job.await', { jobId: recoveringJob.jobId }));
  const recoveredState = f.snapshot(), downloadsAfterRecovery = artifactRequests.length;
  await disconnect(editor); editor = await connect();
  ok(await run('job.await', { jobId: recoveringJob.jobId })); await barrier();
  assert.deepEqual(f.snapshot(), recoveredState); assert.equal(artifactRequests.length, downloadsAfterRecovery);
  assert.equal(events.filter(event => event.jobId === recoveringJob.jobId && event.type === 'job.completed').length, 1);
  await undo(recovered, recoveryBefore);

  // Lose a real command reply after installation, then recover by job identity.
  const uncertainBefore = f.snapshot(), uncertain = begin(defaults, { held: true });
  const uncertainRequest = await bounded(uncertain.arrival), uncertainJob = started(await uncertain.reply);
  const lost = Promise.withResolvers(); loseReply = lost;
  const closed = once(editor.socket, 'close');
  const uncertainReply = rawCall('studio_run', { action: 'job.await', args: { jobId: uncertainJob.jobId } });
  uncertainRequest.release.resolve(); const applied = ok(await bounded(lost.promise));
  await bounded(closed); await bounded(uncertain.finished);
  assert.equal((await uncertainReply).isError, true);
  const uncertainState = f.snapshot(), uncertainDownloads = artifactRequests.length;
  editor = await connect(); const reconciled = ok(await run('job.await', { jobId: uncertainJob.jobId }));
  assert.equal(reconciled.jobId, uncertainJob.jobId); assert.deepEqual(f.snapshot(), uncertainState);
  assert.equal(artifactRequests.length, uncertainDownloads); assert.equal(applied.undo.entries, 1);
  await undo(reconciled, uncertainBefore);

  // Retained live-control telemetry receiver: validation, privacy and deduplication.
  const receive = payload => editor.socket.onmessage({ data: JSON.stringify({ type: 'event', name: 'motion_telemetry', payload }) });
  const relayId = 'a'.repeat(32), relayBefore = editor.motionTelemetry.length;
  for (const payload of [
    { event: 'feature:used', props: { request_id: relayId, name: 'mcp_connected' } },
    { event: 'motion:backend_state', props: { request_id: relayId, backend: 'hosted' } },
    { event: 'motion:generate_blocked', props: { request_id: relayId } },
    { event: 'private prompt', props: { request_id: relayId } },
    { event: '__proto__', props: { request_id: relayId } }, { event: {}, props: { request_id: relayId } },
    { event: 'motion:generate_requested', props: { request_id: 'private prompt', surface: 'mcp' } },
    { event: 'motion:generate_requested', props: { request_id: relayId, surface: 'timeline' } },
    { event: 'motion:job_failed', props: [] },
  ]) await receive(payload);
  assert.equal(editor.motionTelemetry.length, relayBefore);
  const relay = { event: 'motion:generate_requested', props: { request_id: relayId, surface: 'mcp', input_mode: 'prompt', prompt: 'private prompt', host: 'private-gpu-host', url: 'http://private-host', taskId: 'private-task' } };
  await receive(relay); await receive(relay);
  assert.deepEqual(editor.motionTelemetry.slice(relayBefore), [{ event: relay.event, props: { request_id: relayId, surface: 'mcp', input_mode: 'prompt' } }]);

  // Throwing/rejecting SDK callbacks cannot control real POST or installation.
  for (const mode of ['throw', 'reject']) {
    captureMode = mode;
    const saved = f.snapshot(), telemetryBefore = editor.telemetry.length;
    await receive({ ...relay, props: { ...relay.props, request_id: crypto.randomUUID().replaceAll('-', '') } });
    const attempt = begin({ phases: [{ text: 'A person walks.', seconds: 3 }], seed: 17, drop: { from_s: 0, to_s: 1, meters: 1 } });
    const request = await bounded(attempt.arrival);
    assert.equal(request.body.seed, 17); assert.equal(request.body.duration, 3);
    const receipt = ok(await complete(attempt)); await barrier();
    assert.ok(editor.telemetry.length > telemetryBefore);
    const dropped = f.motion.motionFor('actor-a'); assert.ok(dropped.rootPos[72 * 3 + 1] < dropped.rootPos[1] - 0.5);
    await undo(receipt, saved);
  }
  captureMode = 'ok';

  const observer = await connect(true), isolatedBefore = f.snapshot();
  const isolated = ok(await complete(begin())); await barrier(observer);
  assert.equal(observer.wire.filter(frame => ['cmd', 'event'].includes(frame.type)).length, 0);
  assert.deepEqual(observer.telemetry, []); assert.deepEqual(observer.motionTelemetry, []);
  await undo(isolated, isolatedBefore); await barrier();
  const wire = connections.flatMap(connection => connection.wire);
  assert.equal(wire.some(frame => frame.name === 'load_motion' || frame.name === 'motion_job'), false);
  const commands = wire.filter(frame => frame.name === 'run_action');
  assert.ok(commands.length > 0);
  assert.ok(commands.every(frame => frame.args.commandId && frame.args.host && Number.isInteger(frame.args.expectedRevision)));
  const telemetry = connections.flatMap(connection => connection.telemetry);
  const ids = telemetry.filter(row => row.event === 'mcp:tool_requested').map(row => row.props.request_id);
  assert.equal(new Set(ids).size, ids.length);
  for (const id of ids) {
    assert.match(id, /^[a-f0-9]{32}$/);
    assert.ok(commands.every(frame => frame.args.commandId.replaceAll('-', '') !== id));
    assert.ok(events.every(event => event.jobId?.replaceAll('-', '') !== id));
  }
  assert.ok(telemetry.some(row => row.event === 'mcp:tool_requested' && row.props.tool_category === 'motion_generate'));
  const keys = {
    'mcp:tool_requested': ['request_id', 'tool_category'],
    'mcp:tool_executed': ['duration_bucket', 'outcome', 'request_id', 'tool_category'],
    'mcp:result_applied': ['request_id'],
  };
  for (const row of telemetry) assert.deepEqual(Object.keys(row.props).sort(), keys[row.event]);
  assert.doesNotMatch(JSON.stringify(telemetry), /private-gpu-host|private prompt|raw generator error|http:|taskId|actor-a/);
  const tools = await client.listTools();
  for (const name of ['get', 'result', 'list', 'update']) assert.ok(!tools.tools.some(tool => tool.name === `tasks/${name}`));
  assert.deepEqual(bridgeErrors, [], 'unexpected bridge-fixture errors must fail the test');
  console.log(`PASS MCP live motion: optional port ${port}, HTTP bridge, receipt fields, decode/failure/readiness, abort, SDK isolation, reply loss, reconnect, workspace isolation, telemetry, reuse/drop/blocks and undo`);
} finally {
  for (const held of gates) held.resolve();
  for (const connection of connections) connection.control.close();
  await client.close(); unsubscribe(); globalThis.fetch = originalFetch; f.dispose();
  bridge.closeAllConnections();
  await new Promise((resolve, reject) => bridge.close(error => error ? reject(error) : resolve()));
}

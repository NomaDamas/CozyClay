#!/usr/bin/env node
/** CPU-only fixture transport; production route, runtime, verifier and editor are never mocked. */
import assert from 'node:assert/strict';
import { readFileSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer } from 'node:http';
import { createServer as createPortProbe } from 'node:net';
import { once, EventEmitter } from 'node:events';
import { createAgentHandler } from '../../bin/agent/agent-routes.mjs';
import { createFakeModel } from './fake-model.mjs';
import { fauxAssistantMessage, fauxToolCall, fauxText } from '@earendil-works/pi-ai/providers/faux';
import * as auth from '../../bin/codex-auth.mjs';
import { startLiveHub } from '../../mcp/live-hub.mjs';
import { writeNpz, motionArraysToNpzMembers } from '../../tools/ardy/npz.mjs';
import { CSKEL27_NEUTRAL } from '../../src/ardy/cskel27-neutral.js';
import { createSceneStage, SCENES_VERSION } from '../../src/scenes.js';
import { createShotAuthoringDocument } from '../../src/shot-authoring.js';
import { createShot } from '../../src/cuts.js';

const fixture = JSON.parse(readFileSync(new URL('./studio-agent-scene.json', import.meta.url)));
export const sceneDocument = { version: SCENES_VERSION, activeSceneId: fixture.scene.id, scenes: [{ id: fixture.scene.id, name: fixture.scene.name, objects: fixture.objects,
  stage: createSceneStage({ characters: fixture.characters.map(c => ({ id:c.id,subject:c.name,model:c.model,...c.position,rot:c.yawDeg })) }),
  shotDocument: createShotAuthoringDocument({ frameCount: fixture.frameCount, waypoints: [], shots: fixture.shots.map(s => ({ ...createShot(s.name,s.range.startFrame,s.range.endFrameExclusive-1), id:s.id })) }) }] };
export const bounded = (promise, label, ms = 60000) => {
  let timer;
  return Promise.race([promise, new Promise((_, reject) => { timer = setTimeout(() => reject(Error(`Deadline: ${label}`)), ms); })]).finally(() => clearTimeout(timer));
};
export async function released(port) {
  const server = createPortProbe(); const ready = once(server, 'listening'); server.listen(port, '127.0.0.1');
  await ready; await new Promise(resolve => server.close(resolve)); return port;
}
export function createFixtureMotion({ frames = 48, fps = 24, hover = .08 } = {}) {
  assert(Number.isInteger(frames) && frames > 1);
  const rootPos = new Float32Array(frames * 3), posedJoints = new Float32Array(frames * 81), rotMats = new Float32Array(frames * 243);
  for (let frame = 0; frame < frames; frame++) {
    // The existing private-verifier hovering fixture exercises bounded repair.
    // This is NOT semantic walking/waving evidence; live generation remains blocked.
    const travel = 0;
    for (let joint = 0; joint < 27; joint++) {
      const p = CSKEL27_NEUTRAL[joint];
      posedJoints.set([p[0], p[1] + .9544128 + hover, p[2] + travel], (frame * 27 + joint) * 3);
      rotMats.set([1,0,0,0,1,0,0,0,1], (frame * 27 + joint) * 9);
    }
    rootPos.set(posedJoints.subarray(frame * 81, frame * 81 + 3), frame * 3);
  }
  return { frames, fps, personScale: 1, rootPos, posedJoints, rotMats };
}
export async function startFixtureStudio({ port, evidence }) {
  await released(port);
  const hub = await startLiveHub(Number(process.env.QA_LIVE_PORT || 0)); assert(hub, 'exclusive LiveHub required');
  const scratch = mkdtempSync(join(tmpdir(), 'studio-acceptance-'));
  const archive = join(scratch, 'motion.npz'); writeNpz(archive, motionArraysToNpzMembers(createFixtureMotion()));
  const priorArchive = join(scratch, 'prior.npz'); writeNpz(priorArchive, motionArraysToNpzMembers(createFixtureMotion({hover:0})));
  const priorBytes = readFileSync(priorArchive), bytes = readFileSync(archive), events = new EventEmitter(), actions = [], requests = [];
  const realModel = process.env.QA_REAL_MODEL === '1', mode = realModel ? 'real-model-fixture-generator' : 'scripted-model-fixture-generator';
  let sequence = 0;
  const command = hub.command.bind(hub);
  const controls = { hold: null, invalid: false, rateLimit: false, lostAck: false, receiptId: null };
  hub.command = async (name, args, handle) => {
    const startedSequence = ++sequence; const result = await command(name, args, handle);
    // Protocol identity/order plus authoritative receipt, never request prompts/images/tokens.
    const row = { name, startedSequence, finishedSequence: ++sequence, commandId: args.commandId, jobId: args.jobId, binding: args.binding, expectedRevision: args.expectedRevision, result };
    actions.push(row); events.emit('command', row);
    if (controls.lostAck && name === 'commit_motion_candidate' && result.ok) { controls.lostAck = false; throw Error('Fixture lost acknowledgement after editor commit'); }
    return result;
  };
  const context = async () => (await command('inspect_studio', { scope: 'selection' }, hub.workspaceHandles[0])).context;
  const read = async () => {
    const description = await command('describe', {}, hub.workspaceHandles[0]);
    const { objects, characters, camera, timeline } = description;
    const shots = description.document.scenes.find(scene => scene.id === description.document.activeSceneId)?.shotDocument.shots;
    return { context: await context(), objects, characters, camera, timeline, shots, actions };
  };
  const dispatch = async (name, args) => {
    const c = await context(); const host = Object.fromEntries(['workspaceId','documentEpoch','sceneId','sceneEpoch'].map(k => [k,c.host[k]]));
    return hub.command(name, { name, args, commandId: crypto.randomUUID(), host, expectedRevision: c.revision.scene, expectedTargets: c.entities.map(e => ({ ...host, targetId: e.id, token: e.token })) }, c.host.workspaceHandle);
  };
  const fakeModel = createFakeModel();
  // #379 / 16p: GET /agent/models only lists the five registry provider ids
  // (bin/agent/providers.mjs PROVIDERS); it never queries the faux provider's
  // own "faux" id, so the browser panel's composer never leaves "Loading
  // models..." against this scripted fixture. The SAME faux provider is
  // additionally registered under the recognized "anthropic" id (a trivially-
  // resolving faux auth, so it reads signedIn) purely so the real panel can
  // discover and pick a model; every model definition still carries its
  // original internal `provider: "faux"` tag, so actual execution still
  // resolves and runs through the one faux response queue below regardless of
  // whether a turn's model string says "faux/scripted" or "anthropic/scripted".
  if (typeof fakeModel.models?.setProvider === 'function') fakeModel.models.setProvider({ ...fakeModel.fauxProvider.provider, id: 'anthropic' });
  fakeModel.fauxProvider.setResponses(Array.from({ length: 64 }, () => async (context) => {
    const messages = context.messages || [];
    const user = [...messages].reverse().find((message) => message.role === 'user');
    const text = (Array.isArray(user?.content) ? user.content : []).filter((part) => part.type === 'text').map((part) => part.text).join(' ');
    const lastUserIndex = messages.map((message) => message.role).lastIndexOf('user');
    const outputs = messages.slice(lastUserIndex + 1).filter((message) => message.role === 'toolResult').length;
    const target = fixture.characters[0].id;
    if (controls.rateLimit) return fauxAssistantMessage([], { stopReason: 'error', errorMessage: 'Fixture rate limit: 429 Too Many Requests' });
    let call = null;
    if (text.includes('Put a cube')) call = outputs === 0 ? { name: 'arrange_objects', args: { ops: [{ op: 'create', source: { kind: 'cube' }, position: { relativeTo: target, basis: 'shot_camera', side: 'left', gapM: 1, support: 'floor' } }] } } : outputs === 1 ? { name: 'arrange_characters', args: { ops: [{ op: 'create', name: 'Fixture second', position: { relativeTo: target, basis: 'shot_camera', side: 'right', gapM: 2, support: 'floor' } }] } } : null;
    else if (text.includes('Frame the selected')) call = outputs === 0 ? { name: 'frame_shot', args: { subjectIds: [target], keyAtFrame: 0, framing: { intent: { size: 'medium shot', view: 'front', level: 'eye', side: 'right' } } } } : null;
    else if (text.includes('Undo the earlier')) call = outputs === 0 ? { name: 'undo_edit', args: { receiptId: controls.receiptId } } : null;
    else if (text.includes('Inspect')) call = outputs === 0 ? { name: 'inspect_studio', args: { scope: 'selection' } } : null;
    else call = outputs === 0 ? { name: 'generate_motion', args: { characterId: target, source: { kind: 'generate', beats: [{ text: 'walk forward' }, { text: 'wave' }, { text: 'return' }], durationSeconds: 2 } } } : null;
    return fauxAssistantMessage(call ? [fauxToolCall(call.name, call.args, { id: crypto.randomUUID() })] : [fauxText('Fixture-only execution. Refer to the authoritative receipt; semantic motion and model vision are not verified.')]);
  }));
  let origin;
  const handler = createAgentHandler({ ...(realModel ? {} : { auth: { getAccessToken: async () => 'fixture-only' }, models: fakeModel.models, fauxProvider: fakeModel.fauxProvider }), liveHub: hub, port, getBridgeOrigin: () => origin });
  const server = createServer(async (req, res) => {
    try {
      res.setHeader('access-control-allow-origin', `http://127.0.0.1:${port}`);
      if (req.url === '/oauth/status') { const status = realModel ? auth.status() : { signedIn:true,plan:'fixture-only' }; res.setHeader('content-type','application/json'); res.end(JSON.stringify({ signedIn:status.signedIn,plan:status.plan })); return; }
      if (req.url === '/agent/stop') { let body=''; req.on('data',chunk=>{body+=chunk;}); req.once('end',()=>{ const {sessionId,turnId,jobId}=JSON.parse(body); requests.push({action:'stop-http-body',sequence:++sequence,sessionId,turnId,jobId}); }); }
      if (req.url === '/ardy/health') { res.end(JSON.stringify({ ok: true, mode: 'fixture-only', host: 'fixture', device: 'cpu' })); return; }
      if (req.url === '/qa/read') { res.end(JSON.stringify(await read())); return; }
      if (req.url === '/ardy/generate') {
        req.resume(); res.setHeader('content-type','application/x-ndjson'); res.write(JSON.stringify({ event: 'progress', progress: .25 })+'\n');
        const hold = controls.hold; events.emit('generating');
        if (hold) await Promise.race([hold.promise, once(res, 'close')]);
        if (!res.destroyed) res.end(JSON.stringify({ event: 'done', motionUrl: '/ardy/motions/123456-abcdef' })); return;
      }
      if (req.url === '/ardy/motions/123455-abcdef') { res.end(priorBytes); return; }
      if (req.url === '/ardy/motions/123456-abcdef') { res.end(controls.invalid ? Buffer.from('invalid NPZ') : bytes); return; }
      if (!await handler(req,res)) res.writeHead(404).end();
    } catch (error) { console.error(error); if (!res.headersSent) res.writeHead(500); res.end('Fixture transport failure'); }
  });
  let vite;
  const close = async () => {
    controls.hold?.resolve(); await handler.close(); await vite?.close(); server.closeAllConnections(); await new Promise(resolve => server.close(resolve));
    rmSync(scratch, { recursive: true, force: true });
    writeFileSync(`${evidence}/transport.json`, JSON.stringify({ mode, actions, requests }, null, 2));
    const ports = [port, Number(new URL(origin).port), livePort]; for (const p of ports) await released(p);
    writeFileSync(`${evidence}/cleanup.json`, JSON.stringify({ portsReleased: ports, fixtureArchiveRemoved: true, resources: ['Vite','Agent','LiveHub','bridge'] }));
    console.log('CLEANUP fixture listeners released', ports.join(','));
  };
  const livePort = hub.server.address().port;
  try {
    const listening = once(server,'listening'); server.listen(0,'127.0.0.1'); await listening; origin = `http://127.0.0.1:${server.address().port}`;
    process.env.COZYCLAY_LIVE_PORT = String(livePort); process.env.COZYCLAY_OAUTH_PORT = String(server.address().port); process.env.COZYCLAY_BRIDGE_URL = origin;
    const { createServer: createVite } = await import('vite'); vite = await createVite({ server: { port, strictPort: true, host: '127.0.0.1' } }); await vite.listen();
    return { hub, events, controls, actions, read, context, dispatch, command, origin, close };
  } catch (error) { await close(); throw error; }
}

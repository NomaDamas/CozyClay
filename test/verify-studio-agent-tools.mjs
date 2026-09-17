#!/usr/bin/env node
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { once } from "node:events";
import { randomUUID } from "node:crypto";
import { createAgentHandler } from "../bin/agent/agent-routes.mjs";
import { createHttpTransport } from "../src/workflow/agent-client.js";
import { startLiveHub } from "../mcp/live-hub.mjs";
import { STUDIO_TOOL_FAMILIES } from "../src/studio-agent-protocol.js";
import { createRequire } from "node:module";
const { WebSocket } = createRequire(new URL("../mcp/package.json", import.meta.url))("ws");

const CASES = new Set(["surface-context-and-images", "stale-host-and-post-install-rate-limit", "sse-disconnect-reconnect", "sequential-mutations-revision-chain", "external-revision-bump-refuses", "rejection-receipt-surfaces-reason"]);
const index = process.argv.indexOf("--case");
const selected = index >= 0 ? process.argv[index + 1] : null;
if (selected && !CASES.has(selected)) { console.error(`unknown --case ${selected}`); process.exit(2); }
const shouldRun = name => !selected || selected === name;
const uuid = () => randomUUID();
const png = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=";
const host = (handle = "handle-12", workspaceId = "tab-7") => ({ surface: "studio", workspaceId, workspaceHandle: handle, documentEpoch: "doc-3", sceneId: "scene-main", sceneEpoch: "scene-open-4" });
function context(binding = host(), sceneRevision = 1) {
  return { schema: "studio-context-v1", host: binding, revision: { scene: sceneRevision, physics: 1, view: 1 }, units: { distance: "m", angle: "deg", up: "+Y", yawZero: "+Z", yawPositiveToward: "+X", fps: 24, rangeEnd: "exclusive" }, scene: { name: "Workshop", aspect: "16:9", floorY: 0, frameCount: 48, objectCount: 0, characterCount: 1 }, selection: { kind: "character", id: "char-alex" }, activeCharacterId: "char-alex", view: { mode: "scene", frame: 0, playing: false, lookThrough: false, grid: false, autoColor: false }, shot: null, camera: null, entities: [{ id: "char-alex", kind: "character", token: "ct-11", position: { x: 0, y: 0, z: 0 }, yawDeg: 0, scale: 1, bounds: null, motion: { takeId: null, frames: 48, ikKeyCount: 0, promptBlockCount: 0 }, capabilities: { rigReady: true, ik: true, measuredFeet: true } }], entityPage: { returned: 1, total: 1, truncated: false, nextCursor: null }, shots: [], shotsTruncated: false, assets: [], recentReceipts: [], jobs: [], capabilities: { profile: "studio-slice-1", tools: [...STUDIO_TOOL_FAMILIES], rigReady: true, cameraReady: false, bridgeReady: true } };
}
const envelope = (binding = host(), text = "inspect") => ({ surface: "studio", sessionId: uuid(), turnId: uuid(), text, context: context(binding) });
const deferred = () => { let resolve; const promise = new Promise(r => { resolve = r; }); return { promise, resolve }; };
async function bounded(promise) { let timer; try { return await Promise.race([promise, new Promise((_, reject) => { timer = setTimeout(() => reject(new Error("fixture event deadline")), 10000); })]); } finally { clearTimeout(timer); } }

async function liveFixture({ bridge = null, command = null } = {}) {
  const hub = await startLiveHub(0); assert.ok(hub);
  const socket = new WebSocket(`ws://127.0.0.1:${hub.server.address().port}/live`);
  const ready = deferred();
  socket.on("message", raw => { const frame = JSON.parse(raw); if (frame.type === "workspace") ready.resolve(frame.handle); else if (frame.type === "cmd") void (async () => { const value = await command(frame.name, frame.args); if (socket.readyState === WebSocket.OPEN) socket.send(JSON.stringify({ type: "result", id: frame.id, ok: true, value })); })(); });
  await once(socket, "open"); socket.send(JSON.stringify({ type: "hello", role: "editor", version: 1, workspaceId: "tab-7" }));
  const handle = await bounded(ready.promise);
  return { hub, socket, handle, async close() { socket.terminate(); for (const peer of hub.server.clients) peer.terminate(); await new Promise(resolve => hub.server.close(resolve)); if (bridge) await new Promise(resolve => bridge.close(resolve)); } };
}
async function httpFixture({ codex, live, getBridgeOrigin = () => null, clock = Date.now, setIntervalImpl = setInterval, clearIntervalImpl = clearInterval } = {}) {
  const auth = { getAccessToken: async () => "fixture-token" };
  const handler = createAgentHandler({ auth, codex, liveHub: live.hub, getBridgeOrigin, clock, setIntervalImpl, clearIntervalImpl, port: () => server.address().port });
  const server = createServer((req, res) => handler(req, res).catch(error => { if (!res.headersSent) { res.writeHead(500); res.end(error.stack); } }));
  server.listen(0, "127.0.0.1"); await once(server, "listening");
  const origin = `http://127.0.0.1:${server.address().port}`;
  const post = async (body, cookie = null, signal) => { const response = await fetch(`${origin}/agent/turn`, { method: "POST", signal: signal ?? AbortSignal.timeout(10000), headers: { origin, "content-type": "application/json", ...(cookie ? { cookie } : {}) }, body: JSON.stringify(body) }); return { response, text: await response.text(), cookie: response.headers.get("set-cookie")?.split(";")[0] ?? cookie }; };
  return { handler, server, origin, post, async close() { await handler.close(); await new Promise(resolve => server.close(resolve)); } };
}
function streamOf(items) { return { headers: Promise.resolve(new Headers()), async *[Symbol.asyncIterator]() { for (const item of items) yield { type: "response.output_item.done", item }; yield { type: "response.completed", response: { status: "completed" } }; } }; }

if (shouldRun("surface-context-and-images")) {
  const commands = []; let failImage = false;
  const live = await liveFixture({ command: async (name, args) => { commands.push({ name, args }); if (name === "read_studio_context") return { context: context(host(live.handle)) }; if (name === "verify_result") return { ok: true, receiptId: "receipt-1", revision: { scene: 1, physics: 1, view: 1 }, visualRefs: [{ imageId: "capture-1" }] }; if (name === "resolve_studio_image") return failImage ? {} : { imageId: "capture-1", dataUrl: png, revision: { scene: 1 }, receiptId: "receipt-1" }; return { ok: true, commandId: args.commandId ?? "cmd-1", receiptId: "receipt-1", affectedIds: [], status: "applied" }; } });
  const calls = []; let phase = 0;
  const codex = { streamResponses: ({ input, tools }) => { calls.push(input); assert.deepEqual(tools.map(t => t.name), STUDIO_TOOL_FAMILIES); const turn = phase++; if (turn === 0) return streamOf([{ type: "function_call", call_id: "arrange-1", name: "arrange_objects", arguments: JSON.stringify({ ops: [{ op: "remove", id: "cube" }] }) }]); if (turn === 2 || turn === 4) return streamOf([{ type: "function_call", call_id: `visual-${turn}`,  name: "verify_result", arguments: JSON.stringify({ targets: ["char-alex"], checks: ["framing"], visual: "frame" }) }]); return streamOf([{ type: "message", role: "assistant", content: [{ type: "output_text", text: "done" }] }]); }, appendImageObservation(history, value) { history.push({ role: "user", content: [{ type: "input_text", text: value.label }, { type: "input_image", image_url: value.dataUrl }] }); } };
  const liveHttp = await httpFixture({ codex, live }); const first = envelope(host(live.handle)); const result = await liveHttp.post(first); assert.equal(result.response.status, 200); assert.ok(result.text.split("\n").some(line => line.startsWith("data: "))); assert.ok(!result.text.includes("data: {\\\"")); assert.equal(commands[1].name, "arrange_objects"); assert.equal(typeof commands[1].args.commandId, "string"); assert.deepEqual(commands[1].args.host, { workspaceId: "tab-7", documentEpoch: "doc-3", sceneId: "scene-main", sceneEpoch: "scene-open-4" });
  const imageTurn = envelope(host(live.handle), "check the frame"); const imageResult = await liveHttp.post(imageTurn, result.cookie); assert.equal(imageResult.response.status, 200); assert.ok(calls.some(input => input.some(item => item.content?.some(part => part.type === "input_image" && part.image_url === png)))); assert.ok(!calls.flat().filter(item => item.type === "function_call_output").some(item => JSON.stringify(item).includes(png))); assert.match(imageResult.text, /visualStatus/);
  failImage = true; const failedImage = await liveHttp.post(envelope(host(live.handle), "check again"), imageResult.cookie); assert.equal(failedImage.response.status, 200); assert.match(failedImage.text, /unavailable/); assert.ok(!calls.at(-1).some(item => item.content?.some(part => part.type === "input_image")));
  await liveHttp.close(); await live.close(); console.log("PASS surface context, eight-family profile, command envelopes and actual image bytes");
}

if (shouldRun("stale-host-and-post-install-rate-limit")) {
  const live = await liveFixture({ command: async name => { if (name !== "read_studio_context") heartbeat?.(); return name === "read_studio_context" ? { context: context(host(live.handle)) } : { ok: true, status: "installed", receiptId: "receipt-installed" }; } });
  const calls = []; let first = true; let heartbeat; let clockTicks = 0;
  const codex = { streamResponses: ({ input }) => { calls.push(input); if (first) { first = false; return streamOf([{ type: "function_call", call_id: "tool-1", name: "arrange_objects", arguments: JSON.stringify({ ops: [{ op: "remove", id: "cube" }] }) }]); } const error = Object.assign(new Error("rate limited"), { status: 429 }); throw error; } };
  const liveHttp = await httpFixture({ codex, live, clock: () => ++clockTicks, setIntervalImpl: callback => { heartbeat = callback; return callback; }, clearIntervalImpl: () => {} });
  const wrong = envelope(host("missing-handle")); let refused = await liveHttp.post(wrong); assert.equal(refused.response.status, 409); assert.match(refused.text, /LIVE_HUB_UNAVAILABLE/);
  const otherSocket = new WebSocket(`ws://127.0.0.1:${live.hub.server.address().port}/live`); const otherReady = deferred(); otherSocket.on("message", raw => { const frame = JSON.parse(raw); if (frame.type === "workspace") otherReady.resolve(frame.handle); }); await once(otherSocket, "open"); otherSocket.send(JSON.stringify({ type: "hello", role: "editor", version: 1, workspaceId: "tab-other" })); const otherHandle = await bounded(otherReady.promise); const mismatch = envelope(host(otherHandle, "tab-7")); const mismatchResult = await liveHttp.post(mismatch); assert.equal(mismatchResult.response.status, 409); assert.match(mismatchResult.text, /STALE_SCENE/); otherSocket.terminate();
  const firstTurn = envelope(host(live.handle), "explain this"); const firstResult = await liveHttp.post(firstTurn); heartbeat?.(); assert.equal(firstResult.response.status, 200); assert.match(firstResult.text, /: heartbeat\n\n/); assert.ok(clockTicks > 0); assert.match(firstResult.text, /rate_limit/); assert.equal(calls.length, 2); assert.ok(calls[1].some(item => item.type === "function_call_output" && item.output.includes("installed"))); const stopResponse = await fetch(`${liveHttp.origin}/agent/stop`, { method: "POST", headers: { origin: liveHttp.origin, cookie: firstResult.cookie, "content-type": "application/json" }, body: JSON.stringify({ surface: "studio", sessionId: firstTurn.sessionId, turnId: firstTurn.turnId }) }); assert.equal(stopResponse.status, 200);
  const retry = envelope(host(live.handle), "explain this"); const retryResult = await liveHttp.post(retry, firstResult.cookie); assert.equal(retryResult.response.status, 200); assert.equal(calls.length, 3); assert.ok(!retryResult.text.includes("tool.start"));
  await liveHttp.close(); await live.close(); console.log("PASS mismatched handle refusal and rate-limit retry retains completed output without regeneration");
}

if (shouldRun("sequential-mutations-revision-chain") || shouldRun("external-revision-bump-refuses")) {
  const revisionScenarios = selected ? [selected === "external-revision-bump-refuses"] : [false, true];
  for (const externalBump of revisionScenarios) {
    let sceneRevision = 1; let applies = 0; const commands = [];
  const live = await liveFixture({ command: async (name, args) => {
    commands.push({ name, args });
    if (name === "read_studio_context") return { context: context(host(live.handle), sceneRevision) };
    if (externalBump && applies === 1) sceneRevision++;
    if (args.expectedRevision !== sceneRevision) return { ok: false, error: { code: "STALE_SCENE", message: "Authored scene revision changed." } };
    applies++; const before = sceneRevision++; return { ok: true, commandId: args.commandId, receiptId: `receipt-${applies}`, host: host(live.handle), status: "applied", authored: true, revision: { before, after: sceneRevision }, affectedIds: [args.name === "arrange_objects" ? "cube" : "char-alex"], delta: [], checks: { coverage: "fixture" }, undo: { historyEntryId: `history-${applies}`, entries: 1, canUndoDirect: true }, warnings: [] };
  } });
  let callNumber = 0; const inputs = []; const codex = { streamResponses: ({ input }) => { inputs.push(input); callNumber++; if (callNumber === 1) return streamOf([{ type: "function_call", call_id: "mutation-1", name: "arrange_objects", arguments: JSON.stringify({ ops: [{ op: "remove", id: "cube" }] }) }]); if (callNumber === 2) return streamOf([{ type: "function_call", call_id: "mutation-2", name: "arrange_characters", arguments: JSON.stringify({ ops: [{ op: "remove", characterId: "char-alex" }] }) }]); return streamOf([{ type: "message", role: "assistant", content: [{ type: "output_text", text: "done" }] }]); } };
  const liveHttp = await httpFixture({ codex, live }); const result = await liveHttp.post(envelope(host(live.handle), "apply both")).then(value => ({ ...value, calls: commands.filter(command => command.name !== "read_studio_context") }));
  assert.equal(result.response.status, 200); assert.equal(result.calls.length, 2); assert.equal(result.calls[0].args.expectedRevision, 1); assert.equal(result.calls[1].args.expectedRevision, 2); assert.equal(applies, externalBump ? 1 : 2);
  if (externalBump) { assert.ok(inputs[2].some(item => item.type === "function_call_output" && item.output.includes("STALE_SCENE"))); assert.equal(result.calls[1].args.expectedRevision, 2); } else { assert.ok(!result.text.includes("STALE_SCENE")); }
    await liveHttp.close(); await live.close(); console.log(`PASS ${externalBump ? "external revision bump refuses second mutation" : "sequential mutations chain receipt revision"}`);
  }
}

if (shouldRun("sse-disconnect-reconnect")) {
  const arrived = deferred(), release = deferred(); let generations = 0; const bridge = createServer(async (req, res) => { if (req.url === "/ardy/health") { res.writeHead(200, { "content-type": "application/json" }); res.end(JSON.stringify({ ok: true, backend: "local_kimodo", host: "fixture", device: "cuda" })); return; } generations++; arrived.resolve(); await release.promise; res.writeHead(200, { "content-type": "application/x-ndjson" }); res.end('{"event":"done","motionUrl":"/ardy/motions/123456-abcdef"}\n'); }); bridge.listen(0, "127.0.0.1"); await once(bridge, "listening"); const bridgeOrigin = `http://127.0.0.1:${bridge.address().port}`;
  const commands = []; let socket;
  const live = await liveFixture({ bridge, command: async (name, args) => { commands.push({ name, args }); if (name === "read_studio_context") return { context: context(host(live.handle)) }; if (name === "prepare_motion_install") return { candidateId: "candidate-1", candidateRevision: 1, targetToken: "ct-11", physicsRevision: 1, structurallyValid: true }; if (name === "verify_motion_candidate") return { verificationId: "verify-1", candidateId: args.candidateId, candidateRevision: args.candidateRevision, targetToken: "ct-11", physicsRevision: 1, structurallyValid: true, status: "verified", profile: "studio-motion-v1", evaluatedFrames: 48, range: { startFrame: 0, endFrameExclusive: 48 }, limitations: [] }; if (name === "commit_motion_candidate") return { ok: true, status: "installed", commandId: args.commandId, receiptId: "receipt-1", host: { workspaceId: "tab-7", documentEpoch: "doc-3", sceneId: "scene-main", sceneEpoch: "scene-open-4" }, authored: true, revision: { before: 1, after: 2 }, affectedIds: ["char-alex"], delta: [{ id: "char-alex", after: { takeId: "take-1" } }], checks: { coverage: "whole-clip" }, warnings: [], undo: { historyEntryId: "history-1", entries: 1, canUndoDirect: true }, jobId: args.jobId, artifactId: args.artifactId, installed: { characterId: "char-alex", beforeTakeId: null, takeId: "take-1", targetToken: "ct-12", frameCount: 48, fps: 24, durationSeconds: 2, blocks: [{ sourceBeat: 0, startFrame: 0, endFrameExclusive: 48 }], selectionChanged: false }, verification: { id: args.verificationId, status: "verified", profile: "studio-motion-v1", range: { startFrame: 0, endFrameExclusive: 48 }, evaluatedFrames: 48, physicsRevision: 1, limitations: [] } }; return { discarded: true }; } });
  const calls = []; const codex = { streamResponses: ({ input }) => { calls.push(input); if (calls.length === 1) return streamOf([{ type: "function_call", call_id: "motion-1", name: "generate_motion", arguments: JSON.stringify({ characterId: "char-alex", source: { kind: "generate", beats: [{ text: "walk", seconds: 2 }] }, repair: "none" }) }]); return streamOf([{ type: "message", role: "assistant", content: [{ type: "output_text", text: "installed" }] }]); } };
  const liveHttp = await httpFixture({ codex, live, getBridgeOrigin: () => bridgeOrigin }); const turn = envelope(host(live.handle), "generate motion"); let firstObserver = true, cookie = null; const fetches = [];
  const clientFetch = async (url, init = {}) => { const target = new URL(url, liveHttp.origin).href; fetches.push(target); const headers = { ...(init.headers || {}), origin: liveHttp.origin, ...(cookie ? { cookie } : {}) }; const response = await fetch(target, { ...init, headers }); cookie ||= response.headers.get("set-cookie")?.split(";")[0] ?? null; if (firstObserver && target.endsWith("/agent/turn")) { firstObserver = false; const reader = response.body.getReader(); let dropped = false; const body = new ReadableStream({ async pull(controller) { const part = await reader.read(); if (part.done) { controller.close(); return; } controller.enqueue(part.value); if (!dropped && new TextDecoder().decode(part.value).includes('"state":"generating"')) { dropped = true; await reader.cancel(); controller.error(new Error("observer disconnected")); } } }); return new Response(body, { status: response.status, headers: response.headers }); } return response; };
  const transport = createHttpTransport({ fetchImpl: clientFetch, surface: "studio", capture: () => {} }); const seen = []; const turnPromise = transport.turn(turn, event => { seen.push(event); if (event.type === "job.state" && event.state === "generating") { arrived.promise.then(() => release.resolve()); } }); await bounded(arrived.promise); release.resolve(); await bounded(turnPromise); assert.equal(generations, 1); assert.equal(seen.filter(event => event.type === "receipt").length, 1); assert.ok(seen.some(event => event.type === "done")); assert.ok(fetches.some(url => /events\?after=[1-9]/.test(url))); assert.ok(commands.some(command => command.name === "prepare_motion_install")); assert.equal(calls.length, 2);
  await liveHttp.close(); await live.close(); console.log("PASS pending-generation disconnect/reconnect uses landed HTTP client, real live hub/bridge, one generation and receipt");
}

if (shouldRun("rejection-receipt-surfaces-reason")) {
  const { createStudioTools } = await import("../bin/agent/studio-tools.mjs");
  const receipt = { ok: false, commandId: "cmd-9", code: "INVALID_ARGUMENT", phase: "admission", message: "Expected exactly one supported variant.", recovery: { action: "inspect", retryAllowed: false }, expectedTargets: [], currentTargets: [], mutated: false, preserved: { authoredState: "unchanged" } };
  const rejecting = { command: async () => receipt };
  const tools = createStudioTools({ liveHub: rejecting, workspaceHandle: "handle-1", session: { signal: new AbortController().signal } });
  const invoke = tools.internal.invoke;
  await assert.rejects(invoke("inspect_studio", { scope: "scene" }), (error) => {
    assert.equal(error.code, "INVALID_ARGUMENT", "the receipt's top-level code wins");
    assert.equal(error.message, "Expected exactly one supported variant.", "the receipt's top-level message wins");
    assert.deepEqual(error.receipt, receipt, "the whole receipt is attached for the route to forward");
    return true;
  });
  // Nested `error` still works, and top level beats it when both exist.
  const nested = { command: async () => ({ ok: false, code: "STALE_SCENE", message: "top-level wins", error: { code: "TARGET_BUSY", message: "nested" } }) };
  await assert.rejects(createStudioTools({ liveHub: nested, workspaceHandle: "h", session: { signal: new AbortController().signal } }).internal.invoke("inspect_studio", { scope: "scene" }), (error) => {
    assert.equal(error.code, "STALE_SCENE"); assert.equal(error.message, "top-level wins"); return true;
  });
  // The generic string survives only when the receipt has neither code nor message.
  const bare = { command: async () => ({ ok: false }) };
  await assert.rejects(createStudioTools({ liveHub: bare, workspaceHandle: "h", session: { signal: new AbortController().signal } }).internal.invoke("inspect_studio", { scope: "scene" }), (error) => {
    assert.equal(error.code, undefined); assert.equal(error.message, "Studio command failed"); return true;
  });
  console.log("PASS rejection receipts surface their code, message and recovery to the route");
}

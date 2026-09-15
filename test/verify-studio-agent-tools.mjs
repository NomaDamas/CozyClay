#!/usr/bin/env node
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { once } from "node:events";
import { createAgentHandler } from "../bin/agent/agent-routes.mjs";
import { createStudioTools } from "../bin/agent/studio-tools.mjs";
import { encodeStudioContext } from "../src/studio-agent-context.js";
const uuid = "00000000-0000-4000-8000-000000000001";
const context = { schema: "studio-context-v1", host: { surface: "studio", workspaceId: "tab-7", workspaceHandle: "handle-12", documentEpoch: "doc-3", sceneId: "scene-main", sceneEpoch: "scene-open-4" }, revision: { scene: 1, physics: 1, view: 1 }, units: { distance: "m", angle: "deg", up: "+Y", yawZero: "+Z", yawPositiveToward: "+X", fps: 24, rangeEnd: "exclusive" }, scene: { name: "Workshop", aspect: "16:9", floorY: 0, frameCount: 144, objectCount: 0, characterCount: 1 }, selection: { kind: "character", id: "char-alex" }, activeCharacterId: "char-alex", view: { mode: "scene", frame: 0, playing: false, lookThrough: false, grid: false, autoColor: false }, shot: null, camera: null, entities: [{ id: "char-alex", kind: "character", token: "ct-11", position: { x: 0, y: 0, z: 0 }, yawDeg: 0, scale: 1 }], entityPage: { returned: 1, total: 1, truncated: false, nextCursor: null }, shots: [], shotsTruncated: false, assets: [], recentReceipts: [], jobs: [], capabilities: { profile: "studio-slice-1", tools: ["inspect_studio", "operate_studio", "arrange_objects", "arrange_characters", "frame_shot", "generate_motion", "verify_result", "undo_edit"], rigReady: true, cameraReady: false, bridgeReady: false } };

const cases = new Set(["surface-context-and-images", "stale-host-and-post-install-rate-limit", "sse-disconnect-reconnect"]);
const caseIndex = process.argv.indexOf("--case");
const requested = caseIndex >= 0 ? process.argv[caseIndex + 1] : undefined;
if (requested && !cases.has(requested)) { console.error(`unknown --case ${requested}`); process.exit(2); }
const run = async name => !requested || requested === name;
const png = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=";
if (await run("surface-context-and-images")) {
  const routed = [];
  const hub = { command: async (name, args, handle) => { routed.push({ name, args, handle }); return name === "verify_result" ? { ok: true, receiptId: "receipt-1", revision: { before: 1, after: 1 }, visualRefs: [{ imageId: "capture-1" }] } : { ok: true, commandId: "cmd-1", receiptId: "receipt-1", affectedIds: [] }; } };
  const tools = createStudioTools({ liveHub: hub, workspaceHandle: "handle-12", resolveImage: async id => ({ imageId: id, dataUrl: png, revision: { scene: 1 } }) });
  assert.deepEqual(tools.map(tool => tool.name), ["inspect_studio", "operate_studio", "arrange_objects", "arrange_characters", "frame_shot", "generate_motion", "verify_result", "undo_edit"]);
  const result = await tools.find(tool => tool.name === "verify_result").handler({ targets: ["char-alex"], checks: ["framing"], visual: "frame" });
  assert.equal(result.visualRefs[0].imageId, "capture-1");
  assert.equal(encodeStudioContext(context).includes("<"), false);
  assert.equal(routed[0].handle, "handle-12");
  console.log("PASS Studio allowlist, compact context encoding and revision-correlated image resolver");
}

if (await run("stale-host-and-post-install-rate-limit")) {
  const handler = createAgentHandler({ auth: { getAccessToken: async () => "token" }, liveHub: { command: async () => ({}) }, port: () => server.address().port });
  const server = createServer((req, res) => handler(req, res).catch(error => { res.writeHead(500); res.end(error.message); })); server.listen(0, "127.0.0.1"); await once(server, "listening");
  const body = { surface: "studio", sessionId: uuid, turnId: "00000000-0000-4000-8000-000000000002", text: "inspect", context };
  const response = await fetch(`http://127.0.0.1:${server.address().port}/agent/turn`, { method: "POST", headers: { origin: `http://127.0.0.1:${server.address().port}`, "content-type": "application/json" }, body: JSON.stringify({ ...body, context: { ...context, host: { ...context.host, workspaceHandle: null } } }) });
  assert.equal(response.status, 409); assert.equal((await response.json()).error.code, "LIVE_HUB_UNAVAILABLE");
  await handler.close(); await new Promise(resolve => server.close(resolve));
  console.log("PASS stale host never falls back to another workspace");
}

if (await run("sse-disconnect-reconnect")) {
  const calls = [];
  const codex = { parseQuotaHeaders: () => ({ primary: {}, credits: {} }), appendImageObservation() {}, streamResponses: ({ input }) => ({ headers: Promise.resolve(new Headers()), async *[Symbol.asyncIterator]() { calls.push(input); yield { type: "response.output_text.delta", delta: "ok" }; yield { type: "response.completed", response: { status: "completed" } }; } }) };
  const handler = createAgentHandler({ auth: { getAccessToken: async () => "token" }, codex, liveHub: { command: async () => ({}) }, port: () => server.address().port });
  const server = createServer((req, res) => handler(req, res).catch(error => { res.writeHead(500); res.end(error.message); })); server.listen(0, "127.0.0.1"); await once(server, "listening");
  const body = { surface: "studio", sessionId: uuid, turnId: "00000000-0000-4000-8000-000000000002", text: "inspect", context };
  const response = await fetch(`http://127.0.0.1:${server.address().port}/agent/turn`, { method: "POST", headers: { origin: `http://127.0.0.1:${server.address().port}`, "content-type": "application/json" }, body: JSON.stringify(body) });
  const text = await response.text(); assert.match(text, /"type":"done"/); assert.equal(calls.length, 1);
  const replay = await fetch(`http://127.0.0.1:${server.address().port}/agent/turn/${body.turnId}/events?after=0`, { headers: { origin: `http://127.0.0.1:${server.address().port}` } }); assert.equal(replay.status, 200); assert.match(await replay.text(), /done/);
  await handler.close(); await new Promise(resolve => server.close(resolve));
  console.log("PASS Studio SSE terminal replay is single-generation and cursor-bound");
}

#!/usr/bin/env node
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { once } from "node:events";
import { buildStudioHistoryItem, encodeStudioContext, studioCacheKey } from "../src/studio-agent-context.js";
import { createAgentHandler } from "../bin/agent/agent-routes.mjs";
import { validateFrameRange, validateStudioContext, validateTargetGuard, validateStudioCommand } from "../src/studio-agent-protocol.js";

const context = {
	schema: "studio-context-v1",
	host: { surface: "studio", workspaceId: "tab-7", workspaceHandle: "handle-12", documentEpoch: "doc-3", sceneId: "scene-main", sceneEpoch: "scene-open-4" },
	revision: { scene: 41, physics: 9, view: 18 },
	units: { distance: "m", angle: "deg", up: "+Y", yawZero: "+Z", yawPositiveToward: "+X", fps: 24, rangeEnd: "exclusive" },
	scene: { name: "Workshop", aspect: "16:9", floorY: 0, frameCount: 144, objectCount: 1, characterCount: 1 },
	selection: { kind: "character", id: "char-alex", hierarchyId: "characterA" }, activeCharacterId: "char-alex",
	view: { mode: "scene", frame: 0, playing: false, lookThrough: false, grid: false, autoColor: false }, shot: null, camera: null,
	entities: [{ id: "char-alex", kind: "character", name: "Alex", token: "ct-11" }], shots: [], assets: [], recentReceipts: [], jobs: [], capabilities: { profile: "studio-slice-1", tools: ["inspect_studio"] },
};
const caseFlag = process.argv.indexOf("--case");
const caseName = caseFlag === -1 ? "context-and-stale-target" : process.argv[caseFlag + 1];
if (caseName !== "context-and-stale-target") throw new Error("use --case context-and-stale-target");
validateStudioContext(context);
assert.equal(validateFrameRange({ startFrame: 0, endFrameExclusive: 1 }).endFrameExclusive, 1);
assert.equal(studioCacheKey(context), "tab-7:doc-3:scene-open-4:41:scene");
const encoded = encodeStudioContext(context);
assert.equal(encoded.includes("<"), false);
assert.equal(buildStudioHistoryItem(context, "move Alex").content.length, 2);
assert.throws(() => validateTargetGuard({ documentEpoch: "doc-3", sceneEpoch: "scene-open-4", token: "old" }, { documentEpoch: "doc-3", sceneEpoch: "scene-open-4", token: "new" }), (error) => error.code === "STALE_TARGET");
assert.throws(() => validateFrameRange({ startFrame: 4, endFrameExclusive: 4 }), (error) => error.code === "INVALID_RANGE");
assert.throws(() => validateStudioCommand({ name: "arrange_objects", args: { variant: "unknown" } }), (error) => error.code === "UNKNOWN_VARIANT");
assert.throws(() => validateStudioCommand({ name: "arrange_objects", args: { ops: [{ op: "create", name: "A" }, { op: "create", name: "A" }] } }), (error) => error.code === "DUPLICATE_NAME");

const codex = { parseQuotaHeaders: () => ({ planType: "Plus", primary: {}, credits: { hasCredits: true } }), streamResponses: () => ({ headers: Promise.resolve(new Headers()), async *[Symbol.asyncIterator]() { yield { type: "response.completed", response: { status: "completed" } }; } }) };
const auth = { getAccessToken: async () => "token" };
let server;
const handler = createAgentHandler({ auth, codex, handlers: [], liveHub: {}, port: () => server.address().port });
server = createServer((req, res) => handler(req, res).catch((error) => { res.writeHead(500); res.end(error.message); }));
server.listen(0, "127.0.0.1"); await once(server, "listening");
const url = `http://127.0.0.1:${server.address().port}/agent/turn`;
const post = (body) => fetch(url, { method: "POST", headers: { origin: `http://127.0.0.1:${server.address().port}`, "content-type": "application/json" }, body: JSON.stringify(body) });
const invalid = await post({ surface: "studio", sessionId: "not-uuid", turn_id: "not-uuid", text: "x", context });
assert.equal(invalid.status, 400);
assert.equal((await invalid.json()).error.code, "INVALID_TURN_ID");
const validLegacy = await post({ sessionId: "legacy", text: "hello" });
assert.equal(validLegacy.status, 200);
server.close(); await once(server, "close");
console.log("PASS Studio protocol context identity, bounded history, stale target and legacy HTTP routing");

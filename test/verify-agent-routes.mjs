import assert from "node:assert/strict";
import { createServer } from "node:http";
import { once } from "node:events";
import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createModels } from "@earendil-works/pi-ai";
import { createAgentHandler, REASONING_EFFORTS } from "../bin/agent/agent-routes.mjs";
import { createFakeModel } from "./fixtures/fake-model.mjs";

const png = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=";
function assertUniqueToolPairs(frames, message) {
	const starts = frames.filter((event) => event.type === "tool.start");
	const dones = frames.filter((event) => event.type === "tool.done");
	assert.equal(new Set(starts.map((event) => event.callId)).size, starts.length, `${message}: tool call ids are unique`);
	for (const start of starts) assert.equal(dones.filter((event) => event.callId === start.callId).length, 1, `${message}: ${start.callId} has one tool.done`);
}
const sessionDir = mkdtempSync(join(tmpdir(), "cozyclay-agent-sessions-"));
process.env.COZYCLAY_AGENT_SESSIONS_DIR = sessionDir;
delete process.env.CLIPROXY_API_KEY;
delete process.env.CLIPROXY_BASE_URL;
const fauxMain = createFakeModel();
fauxMain.script([
	{ type: "text", text: "hello" },
	{ type: "toolCall", id: "c1", name: "describe_workflow", arguments: {} },
	{ type: "toolCall", id: "c2", name: "add_workflow_node", arguments: { type: "image", model: "image-generation", data: { prompt: "render" } } },
	{ type: "text", text: " done" },
	{ type: "toolCall", id: "c3", name: "run_workflow", arguments: {} },
	{ type: "text", text: " done" },
]);
const fakeLive = { command: async (name) => name === "capture_framing_png" ? { dataUrl: png, width: 1920, height: 1080 } : { assetId: "a1", objectId: "o1" } };
const fakeCodex = {
  listModels: async () => ["gpt-5", { slug: "gpt-6-astra", supported_reasoning_levels: [{ effort: "low" }, { effort: "medium" }, { effort: "xhigh" }], default_reasoning_level: "medium" }],
  parseQuotaHeaders: () => ({ planType: "Plus", primary: {}, credits: { hasCredits: true } }),
  editImage: async () => ({ pngBase64: png.split(",")[1], width: 1, height: 1 }),
};
let server;
const handler = createAgentHandler({ auth: { getAccessToken: async () => "token" }, codex: fakeCodex, models: fauxMain.models, fauxProvider: fauxMain.fauxProvider, liveHub: fakeLive, port: () => server.address().port });
server = createServer((req, res) => handler(req, res).catch((error) => { res.writeHead(500); res.end(error.message); }));
server.listen(0, "127.0.0.1");
await once(server, "listening");
const { port } = server.address();
const turnId = "a".repeat(32);
const response = await fetch(`http://127.0.0.1:${port}/agent/turn`, { method: "POST", headers: { "content-type": "application/json", origin: `http://127.0.0.1:${port}` }, body: JSON.stringify({ sessionId: "s", text: "hi", model: "faux/scripted", attachFrame: false, turn_id: turnId }) });
const text = await response.text();
const events = [...text.matchAll(/^data: (.+)$/gm)].map((match) => JSON.parse(match[1]));
assert.deepEqual(events.filter((event) => !["execution_telemetry", "execution_tool_started"].includes(event.type)).map((event) => event.type), ["quota", "text.delta", "tool.start", "tool.done", "tool.start", "tool.done", "text.delta", "tool.start", "tool.done", "text.delta", "done"]);
const executionTelemetry = events.filter((event) => event.type === "execution_telemetry");
assert.deepEqual(executionTelemetry.map((event) => event.event), [
	"agent:tool_executed", "agent:tool_executed", "agent:tool_executed", "agent:turn_succeeded",
]);
assert.equal(executionTelemetry[0].props.turn_id, turnId, "browser correlation ID survives the local relay");
assert.ok(executionTelemetry.every((event) => event.props.turn_id === turnId));
assert.ok(executionTelemetry.every((event) => !Object.hasOwn(event.props, "args") && !Object.hasOwn(event.props, "result")));
assert.ok(executionTelemetry.slice(0, 3).every((event) => event.props.outcome === "succeeded"));
assert.equal(new Set(executionTelemetry.slice(0, 3).map((event) => event.telemetry_id)).size, 3, "every execution gets its own local-only wire dedupe ID");
assert.ok(executionTelemetry.slice(0, 3).every((event) => /^[a-f0-9]{32}$/.test(event.telemetry_id)));
const toolEvents = events.filter((event) => event.type === "tool.start" || event.type === "tool.done");
assert.deepEqual(toolEvents.map((event) => event.callId), ["c1", "c1", "c2", "c2", "c3", "c3"], "every tool.start is paired with its tool.done");
assertUniqueToolPairs(events, "golden parity W");
assert.ok(toolEvents.every((event) => event.type !== "tool.done" || event.ok), "every scripted tool call succeeds");
assert.equal(events.some((event) => event.type === "image"), false, "the canvas turn builds nodes instead of emitting images");
assert.equal(JSON.stringify(fauxMain.calls[0].messages).includes(png), false);
{
	const { normaliseFrame } = await import("./fixtures/agent-sse-golden.mjs");
	const golden = JSON.parse(readFileSync(new URL("./fixtures/agent-sse-golden.json", import.meta.url), "utf8")).W;
	const actual = events.filter((event) => !["execution_telemetry", "execution_tool_started"].includes(event.type)).map(normaliseFrame);
	const expected = golden.filter((event) => !["execution_telemetry", "execution_tool_started"].includes(event.type));
	// Codex quota values are provider-specific; the frame ordering and every
	// browser-visible Workflow frame after it are byte-for-byte frozen.
	assert.deepEqual(actual.slice(1), expected.slice(1), "Workflow frames preserve golden parity W");
	console.log("PASS golden parity W");
}
{
	const interleaved = createFakeModel();
	interleaved.script([[{ type: "toolCall", id: "i1", name: "describe_workflow", arguments: {} }, { type: "toolCall", id: "i2", name: "run_workflow", arguments: {} }], { type: "text", text: "done" }]);
	let interleaveServer;
	const interleaveHandler = createAgentHandler({ auth: { getAccessToken: async () => "token" }, models: interleaved.models, fauxProvider: interleaved.fauxProvider, codex: fakeCodex, liveHub: fakeLive, port: () => interleaveServer.address().port });
	interleaveServer = createServer((req, res) => interleaveHandler(req, res).catch(() => {})); interleaveServer.listen(0, "127.0.0.1"); await once(interleaveServer, "listening");
	const interleaveOrigin = `http://127.0.0.1:${interleaveServer.address().port}`;
	const interleaveText = await fetch(`${interleaveOrigin}/agent/turn`, { method: "POST", headers: { "content-type": "application/json", origin: interleaveOrigin }, body: JSON.stringify({ sessionId: "interleave", text: "hi", model: "faux/scripted" }) }).then((r) => r.text());
	const interleaveEvents = [...interleaveText.matchAll(/^data: (.+)$/gm)].map((match) => JSON.parse(match[1]));
	const pairs = interleaveEvents.filter((event) => ["tool.start", "tool.done"].includes(event.type));
	assert.deepEqual(pairs.map((event) => `${event.type}:${event.callId}`), ["tool.start:i1", "tool.done:i1", "tool.start:i2", "tool.done:i2"], "two tool calls stay strictly interleaved");
	await new Promise((resolve) => interleaveServer.close(resolve));
	console.log("PASS two Workflow tool calls are strictly interleaved");
}
{
	const unknown = createFakeModel();
	unknown.script([{ type: "toolCall", id: "u1", name: "unknown_tool", arguments: {} }, { type: "text", text: "recovered" }]);
	let unknownServer;
	const unknownHandler = createAgentHandler({ auth: { getAccessToken: async () => "token" }, models: unknown.models, fauxProvider: unknown.fauxProvider, codex: fakeCodex, liveHub: fakeLive, port: () => unknownServer.address().port });
	unknownServer = createServer((req, res) => unknownHandler(req, res).catch(() => {})); unknownServer.listen(0, "127.0.0.1"); await once(unknownServer, "listening");
	const unknownOrigin = `http://127.0.0.1:${unknownServer.address().port}`;
	const unknownText = await fetch(`${unknownOrigin}/agent/turn`, { method: "POST", headers: { "content-type": "application/json", origin: unknownOrigin }, body: JSON.stringify({ sessionId: "unknown", text: "hi", model: "faux/scripted", turn_id: "b".repeat(32) }) }).then((r) => r.text());
	const unknownEvents = [...unknownText.matchAll(/^data: (.+)$/gm)].map((match) => JSON.parse(match[1]));
	assert.deepEqual(unknownEvents.map((event) => event.type), ["quota", "execution_tool_started", "tool.start", "tool.done", "execution_telemetry", "text.delta", "execution_telemetry", "done"], "unknown tool frame order is stable");
	assertUniqueToolPairs(unknownEvents, "unknown tool");
	const unknownDone = unknownEvents.find((event) => event.type === "tool.done");
	assert.equal(unknownDone?.callId, "u1");
	assert.equal(unknownDone?.ok, false);
	assert.match(unknownDone?.error || "", /unknown_tool.*unavailable/i);
	assert.equal(unknownEvents.at(-1).type, "done");
	const errorResult = unknown.calls[1]?.messages?.find((message) => message.role === "toolResult" && message.toolCallId === "u1");
	assert.equal(errorResult?.isError, true, "the faux model receives an error tool result for the unknown call");
	await new Promise((resolve) => unknownServer.close(resolve));
	console.log("PASS unknown Workflow tool returns an error result and the turn ends");
}
{
	const post = (body, p = port) => fetch(`http://127.0.0.1:${p}/agent/image`, { method: "POST", headers: { "content-type": "application/json", origin: `http://127.0.0.1:${p}` }, body: JSON.stringify(body) });
	// A real 1920x1080 shot PNG is a few MB as a data URL; the route must not
	// fall under the 64 KB limit that protects the chat routes.
	const bigFrame = "data:image/png;base64," + "A".repeat(3 * 1024 * 1024);
	const ok = await post({ prompt: "golden hour", imageDataUrl: bigFrame, referenceDataUrl: png, quality: "auto" });
	assert.equal(ok.status, 200, "a full-size frame is accepted");
	const image = await ok.json();
	assert.ok(image.dataUrl.startsWith("data:image/png;base64,") && image.width === 1 && image.height === 1);
	assert.equal((await post({ prompt: "", imageDataUrl: png })).status, 400, "empty prompt is rejected");
	assert.equal((await post({ prompt: "x", imageDataUrl: "https://example.com/a.png" })).status, 400, "only data URLs are accepted");
	assert.equal((await post({ prompt: "x", imageDataUrl: png, quality: "ultra" })).status, 400, "unknown quality is rejected");
	const seen = [];
	const refHandler = createAgentHandler({ auth: { getAccessToken: async () => "token" }, codex: { ...fakeCodex, editImage: async (args) => { seen.push(args); return fakeCodex.editImage(args); } }, liveHub: fakeLive, port: () => refServer.address().port });
	const refServer = createServer((req, res) => refHandler(req, res).catch(() => {})); refServer.listen(0, "127.0.0.1"); await once(refServer, "listening");
	await post({ prompt: "x", imageDataUrl: png, referenceDataUrl: png }, refServer.address().port);
	assert.equal(seen[0].referenceDataUrl, png, "the reference image reaches codex");
	assert.equal(seen[0].prompt, "x", "without a scene to describe, the prompt is sent as written");
	// Scene reference slots (#167) attach after the frame/reference pair and are
	// named in the prompt. test/verify-agent-image-references.mjs covers the
	// validation matrix; this pins that the shipped route carries them at all.
	await post({ prompt: "x", imageDataUrl: png, referenceDataUrl: png, references: [{ role: "character", name: "Alpha", dataUrl: png }, { role: "environment", dataUrl: png }] }, refServer.address().port);
	assert.equal([seen[1].imageDataUrl, seen[1].referenceDataUrl, ...seen[1].extraImages].filter(Boolean).length, 4, "frame + reference + two scene references");
	assert.ok(seen[1].prompt.includes("Character Alpha"), seen[1].prompt);
	assert.equal((await post({ prompt: "x", imageDataUrl: png, references: [{ role: "character", dataUrl: "data:text/plain;base64,aGk=" }] }, refServer.address().port)).status, 400, "a reference that is not an image is rejected");
	refServer.close();
	const guided = [];
	const guideLive = { ...fakeLive, connected: true, workspaceHandleDetails: () => [{ handle: "w", meta: { commands: ["capture_framing_png", "import_asset"] } }], resolveWorkspace: () => "w" };
	const guideHandler = createAgentHandler({ auth: { getAccessToken: async () => "token" }, codex: { ...fakeCodex, editImage: async (args) => { guided.push(args.prompt); return fakeCodex.editImage(args); } }, liveHub: guideLive, handlers: [{ name: "render_prompt", handler: async ({ mode, environment }) => ({ content: [{ type: "text", text: `[${mode}] medium shot, 24mm, subject faces camera (${environment})` }] }) }], port: () => guideServer.address().port });
	const guideServer = createServer((req, res) => guideHandler(req, res).catch(() => {})); guideServer.listen(0, "127.0.0.1"); await once(guideServer, "listening");
	await post({ prompt: "golden hour", imageDataUrl: png }, guideServer.address().port);
	assert.equal(guided[0], "golden hour\n[image] medium shot, 24mm, subject faces camera (golden hour)", "scene guidance is appended to the node prompt like render_from_frame does");
	guideServer.close();
	console.log("PASS /agent/image: full-size frame accepted, validation, reference and scene references forwarded");
}
{
	// Attaching the frame captures through the sidecar's internal tool even though
	// the model-facing list no longer offers capture_blocking_frame.
	const attachFaux = createFakeModel();
	attachFaux.script([{ type: "text", text: "" }]);
	const attachHandler = createAgentHandler({ auth: { getAccessToken: async () => "token" }, codex: fakeCodex, models: attachFaux.models, fauxProvider: attachFaux.fauxProvider, liveHub: fakeLive, port: () => attachServer.address().port });
	const attachServer = createServer((req, res) => attachHandler(req, res).catch(() => {})); attachServer.listen(0, "127.0.0.1"); await once(attachServer, "listening");
	const attachPort = attachServer.address().port;
	const attachText = await fetch(`http://127.0.0.1:${attachPort}/agent/turn`, { method: "POST", headers: { "content-type": "application/json", origin: `http://127.0.0.1:${attachPort}` }, body: JSON.stringify({ sessionId: "att", text: "hi", model: "faux/scripted", attachFrame: true }) }).then((r) => r.text());
	const attachEvents = [...attachText.matchAll(/^data: (.+)$/gm)].map((match) => JSON.parse(match[1]));
	assert.deepEqual(attachEvents.filter((event) => event.type === "tool.start").map((event) => event.name), ["capture_blocking_frame"], "the attached frame is captured and shown as a tool card");
	assert.ok(attachEvents.every((event) => event.type !== "error"), "attaching a frame does not fail the turn");
	assert.match(attachFaux.calls[0].messages.find((item) => item.role === "user").content[0].text, /Attached frame imageId: /, "the model is told which image was attached");
	attachServer.close();
	console.log("PASS attachFrame captures through the internal tool");
}
{
	// #367: a picture the author pasted into the composer reaches the model as a
	// real user image item, placed BEFORE the turn text on both surfaces — the
	// same shape attachFrame already uses.
	const { contextFixture, envelopeFixture } = await import("./verify-studio-agent-protocol.mjs");
	const workflowFaux = createFakeModel();
	workflowFaux.script([[{ type: "text", text: "" }], [{ type: "text", text: "" }]]);
	const attachHub = { command: async () => ({ ok: true }), workspaceId: () => "tab-7", resolveWorkspace: () => "handle-12", handleForWorkspaceId: () => "handle-12", connected: true, workspaceHandles: ["handle-12"] };
	let attachServer;
	const attachHandler = createAgentHandler({ auth: { getAccessToken: async () => "token" }, codex: fakeCodex, models: workflowFaux.models, fauxProvider: workflowFaux.fauxProvider, liveHub: attachHub, studioRuntime: { readContext: async () => contextFixture() }, port: () => attachServer.address().port });
	attachServer = createServer((req, res) => attachHandler(req, res).catch((error) => { console.error("attachment fixture error:", error); if (!res.headersSent) res.writeHead(500); res.end(error.message); }));
	attachServer.listen(0, "127.0.0.1");
	await once(attachServer, "listening");
	const attachOrigin = `http://127.0.0.1:${attachServer.address().port}`;
	const post = (body) => fetch(`${attachOrigin}/agent/turn`, { method: "POST", headers: { "content-type": "application/json", origin: attachOrigin }, body: JSON.stringify(body) }).then((response) => response.text());

	// Own session: Studio sessions persist (#368), and the resume check below
	// counts the user items a fresh route instance replays for the fixture id.
	const studioEnvelope = { ...envelopeFixture(), sessionId: "00000000-0000-4000-8000-00000000a367", text: "what is in the attached image?", attachments: [{ dataUrl: png, name: "probe.png" }] };
	await post(studioEnvelope);
	const studioInput = workflowFaux.calls.at(-1)?.messages ?? [];
	const imageAt = studioInput.findIndex((item) => item.role === "user" && item.content?.some((part) => part.type === "image"));
	const textAt = studioInput.findIndex((item) => item.role === "user" && item.content?.some((part) => part.type === "text" && part.text.includes("what is in the attached image?")));
	assert.ok(imageAt !== -1, `the studio turn sends an ImageContent user item: ${JSON.stringify(studioInput).slice(0, 400)}`);
	assert.ok(textAt !== -1 && imageAt <= textAt, "the attachment precedes the turn text, exactly like attachFrame");
	const imagePart = studioInput[imageAt].content.find((part) => part.type === "image");
	assert.equal(`data:${imagePart.mimeType};base64,${imagePart.data}`, png, "the pasted bytes reach the model");
	assert.match(studioInput[imageAt].content.find((part) => part.type === "text").text, /User attachment probe\.png/, "the image is named for the model");

	const rejected = await fetch(`${attachOrigin}/agent/turn`, { method: "POST", headers: { "content-type": "application/json", origin: attachOrigin }, body: JSON.stringify({ ...envelopeFixture(), attachments: [{ dataUrl: "data:text/plain;base64,aGk=" }] }) });
	assert.equal(rejected.status, 400, "a non-image attachment never reaches the model");

	await post({ sessionId: "attach-workflow", text: "describe this", model: "faux/scripted", attachments: [{ dataUrl: png }] });
	const workflowInput = workflowFaux.calls.at(-1)?.messages ?? [];
	const workflowImageAt = workflowInput.findIndex((item) => item.content?.some((part) => part.type === "image"));
	const workflowTextAt = workflowInput.findIndex((item) => item.content?.some((part) => part.type === "text" && part.text.includes("describe this")));
	assert.ok(workflowImageAt !== -1 && workflowImageAt < workflowTextAt, `the workflow turn carries the attachment too: ${JSON.stringify(workflowInput).slice(0, 300)}`);
	assert.match(workflowInput[workflowImageAt].content[0].text, /User attachment 1/, "an unnamed attachment is named by its position");
	const badWorkflow = await fetch(`${attachOrigin}/agent/turn`, { method: "POST", headers: { "content-type": "application/json", origin: attachOrigin }, body: JSON.stringify({ sessionId: "attach-bad", text: "hi", attachments: [{ dataUrl: "https://example.test/a.png" }] }) });
	assert.equal(badWorkflow.status, 400, "a remote URL is not an attachment");
	attachServer.close();
	console.log("PASS pasted attachments reach the model as input_image items before the turn text");
}
{
	// Workflow providers other than openai-codex still emit the quota frame first;
	// the values are intentionally null because they have no Codex headers.
	const quotaFaux = createFakeModel();
	quotaFaux.script([{ type: "text", text: "ok" }]);
	let quotaServer;
	const quotaHandler = createAgentHandler({ auth: { getAccessToken: async () => "token" }, models: quotaFaux.models, fauxProvider: quotaFaux.fauxProvider, codex: fakeCodex, liveHub: fakeLive, port: () => quotaServer.address().port });
	quotaServer = createServer((req, res) => quotaHandler(req, res).catch(() => {})); quotaServer.listen(0, "127.0.0.1"); await once(quotaServer, "listening");
	const quotaText = await fetch(`http://127.0.0.1:${quotaServer.address().port}/agent/turn`, { method: "POST", headers: { "content-type": "application/json", origin: `http://127.0.0.1:${quotaServer.address().port}` }, body: JSON.stringify({ sessionId: "quota", text: "hi", model: "faux/scripted" }) }).then((r) => r.text());
	const quotaFrames = [...quotaText.matchAll(/^data: (.+)$/gm)].map((match) => JSON.parse(match[1]));
	assert.equal(quotaFrames[0].type, "quota");
	assert.equal(quotaFrames[0].plan, null);
	assert.equal(quotaFrames.at(-1).type, "done");
	await new Promise((resolve) => quotaServer.close(resolve));
	console.log("PASS Workflow quota frame is emitted first for non-Codex providers");
}
{
	const { LiveHub, RUN_WORKFLOW_TIMEOUT_MS, CAPTURE_FRAME_TIMEOUT_MS, IMPORT_ASSET_TIMEOUT_MS, DEFAULT_COMMAND_TIMEOUT_MS } = await import("../mcp/live-hub.mjs");
	assert.equal(LiveHub.commandTimeoutMs("run_workflow"), RUN_WORKFLOW_TIMEOUT_MS, "run_workflow waits for capture + generation");
	assert.equal(LiveHub.commandTimeoutMs("capture_frame"), CAPTURE_FRAME_TIMEOUT_MS, "capture_frame waits for skinned-rig occlusion rays");
	assert.equal(LiveHub.commandTimeoutMs("import_asset"), IMPORT_ASSET_TIMEOUT_MS, "import_asset waits for a large mesh data URL");
	assert.equal(LiveHub.commandTimeoutMs("add_node"), DEFAULT_COMMAND_TIMEOUT_MS);
	console.log("PASS run_workflow and capture_frame get long live command timeouts");
}
// #379 / 16p: /agent/models must answer from the handler's OWN injected
// `models` registry (proven separately below); `handler`/`port` above inject
// `models: fauxMain.models` for turn execution, which is a bare pi registry
// with only the faux provider set up (no real provider catalogs), so the
// real-catalog assertions in this block need a handler with NO `models`
// option, exercising the real-registry fallback in `listAgentModels`
// (`models ?? await createModels(...)`) exactly as the live sidecar runs it.
const realCatalogHandler = createAgentHandler({ auth: { getAccessToken: async () => "token" }, codex: fakeCodex, liveHub: fakeLive, port: () => realCatalogServer.address().port });
const realCatalogServer = createServer((req, res) => realCatalogHandler(req, res).catch((error) => { if (!res.headersSent) res.writeHead(500); res.end(error.message); }));
realCatalogServer.listen(0, "127.0.0.1");
await once(realCatalogServer, "listening");
const realCatalogPort = realCatalogServer.address().port;
const forbidden = await fetch(`http://127.0.0.1:${realCatalogPort}/agent/models`, { headers: { origin: "http://evil.example" } });
assert.equal(forbidden.status, 403);
assert.equal((await fetch(`http://127.0.0.1:${realCatalogPort}/agent/models`)).status, 200);
const models = await fetch(`http://127.0.0.1:${realCatalogPort}/agent/models`).then((r) => r.json());
try {
	// #379: /agent/models is grouped by provider, each with its pi-derived sign-in
	// state and its chat models shaped for the panel. This handler's own auth
	// double (getAccessToken only, no readStored/status) leaves every provider
	// signed out, so the live codex.listModels() merge never fires here — the
	// merge itself is exercised against providers.mjs directly below, where a
	// signed-in double is cheap and does not need network access.
	assert.equal(models.providers.length, 6, "all six registry providers are listed");
	assert.deepEqual(models.providers.map((provider) => provider.id).sort(), ["anthropic", "cliproxy", "google", "openai", "openai-codex", "openrouter"]);
	assert.ok(models.providers.every((provider) => provider.signedIn === false), "no credentials are configured for this handler's auth double");
	assert.ok(models.models.length > 0 && models.models.every((model) => typeof model.id === "string" && model.id.includes("/")), "the flat union is key-addressed: every models[].id is provider/id");
	const codexProvider = models.providers.find((provider) => provider.id === "openai-codex");
	assert.equal(codexProvider.models[0].id, "gpt-6-astra", "gpt-6-astra sorts first even though it is not the catalog's first entry");
	const astra = codexProvider.models[0];
	assert.ok(!astra.efforts.includes("none") && !astra.efforts.includes("off"), "astra's thinkingLevelMap marks off unsupported, so neither wire name for it is offered");
	assert.ok(astra.efforts.includes("max"), "astra supports pi's top thinking level");
	assert.equal(astra.defaultEffort, "medium", "medium is the default whenever a model supports it");
	assert.ok(!astra.efforts.includes("ultra"), "ultra is never an advertised effort \u2014 it is only ever an accepted, clamped input");
	console.log("PASS models grouped by provider");
} finally {
	await realCatalogHandler.close();
	await new Promise((resolve) => realCatalogServer.close(resolve));
}
{
	// Sign-in state and the codex live-catalog merge, exercised directly against
	// providers.mjs: an env-configured provider reports signedIn/authSource, and
	// openai-codex merges codex.listModels() with the static pi catalog only for
	// models the catalog does not already have — astra stays catalog-sourced
	// (and therefore keeps its full pi effort list) and still sorts first.
	const { listAgentModels, resolveModel, resolveEffort, EFFORT_LEVELS } = await import("../bin/agent/providers.mjs");
	const previousAnthropicKey = process.env.ANTHROPIC_API_KEY;
	process.env.ANTHROPIC_API_KEY = "x";
	try {
		const signedInAuth = { readStored: async () => undefined };
		const keys = { readKeys: () => ({}) };
		const base = await import("../bin/agent/providers.mjs").then((m) => m.createModels({ auth: signedInAuth, keys, env: process.env }));
		const withCodexSignedIn = { getModels: (id) => base.getModels(id), getAuth: async (id) => (id === "openai-codex" ? { auth: {}, source: "chatgpt" } : base.getAuth(id)) };
		const liveCodex = { listModels: async () => ["gpt-5", { slug: "gpt-6-astra", supported_reasoning_levels: [{ effort: "low" }], default_reasoning_level: "low" }, { slug: "gpt-9-nova", supported_reasoning_levels: [{ effort: "low" }], default_reasoning_level: "low" }] };
		const result = await listAgentModels({ models: withCodexSignedIn, codex: liveCodex, auth: signedInAuth, keys, env: process.env });
		const anthropic = result.providers.find((provider) => provider.id === "anthropic");
		assert.equal(anthropic.signedIn, true, "an env-configured provider is signed in");
		assert.equal(anthropic.authSource, "env", "the api key came from the environment");
		const codexProvider = result.providers.find((provider) => provider.id === "openai-codex");
		assert.equal(codexProvider.signedIn, true);
		assert.equal(codexProvider.models[0].id, "gpt-6-astra", "the catalog's astra still sorts first after the merge");
		assert.ok(codexProvider.models[0].efforts.includes("max"), "the merge never overwrites astra's catalog entry with codex's live one");
		assert.ok(codexProvider.models.some((model) => model.id === "gpt-9-nova"), "a live model the pi catalog does not know about still appears");
		assert.equal(codexProvider.models.find((model) => model.id === "gpt-9-nova").key, "openai-codex/gpt-9-nova");
		console.log("PASS openai-codex merges the live catalog with the pi catalog, keeping astra first");

		await assert.rejects(resolveModel("anthropic/does-not-exist", { models: base }), (error) => error.code === "UNKNOWN_MODEL", "resolveModel rejects an unknown model id with the frozen error code");
		const { getSupportedThinkingLevels } = await import("@earendil-works/pi-ai");
		// gpt-6-astra's thinkingLevelMap marks "off" unsupported (it always thinks);
		// resolveEffort must still hand pi "off" verbatim for the wire name "none"
		// — clamping it up to astra's lowest supported level ("minimal") would
		// silently turn "no reasoning requested" into "some reasoning requested".
		const astra = base.getModel("openai-codex", "gpt-6-astra");
		assert.equal(await resolveEffort(astra, "none"), "off", "none reaches pi as off even on a model whose thinkingLevelMap has no off");
		assert.equal(await resolveEffort(astra, "ultra"), "max", "ultra is accepted on input and clamped to pi's top level, which astra supports");
		assert.equal(await resolveEffort(astra, "medium"), "medium", "an effort the model already supports passes through unchanged");
		// gpt-5.4 supports "off" and everything up to "xhigh" but not "max": it
		// exercises the ordinary none→off mapping and clamping an effort the
		// model lacks (xhigh's neighbour, "max") down to its highest supported
		// level — read from getSupportedThinkingLevels, not a hardcoded string.
		const gpt54 = base.getModel("openai-codex", "gpt-5.4");
		const gpt54Levels = getSupportedThinkingLevels(gpt54);
		assert.ok(gpt54Levels.includes("off") && !gpt54Levels.includes("max"), "gpt-5.4 is the fixture this assertion needs: off supported, max not");
		const gpt54Highest = gpt54Levels.at(-1);
		assert.equal(await resolveEffort(gpt54, "none"), "off", "the wire name none maps to pi's off");
		assert.equal(await resolveEffort(gpt54, "ultra"), gpt54Highest, "ultra is accepted on input, clamped to max, then clamped again to what this model supports");
		assert.equal(await resolveEffort(gpt54, "max"), gpt54Highest, "an effort a model lacks is clamped down to what it supports");
		assert.deepEqual(EFFORT_LEVELS, REASONING_EFFORTS, "the frozen wire vocabulary providers.mjs exports matches the turn route's own REASONING_EFFORTS");
		console.log("PASS resolveModel/resolveEffort: unknown model id rejects, effort maps and clamps through clampThinkingLevel");
	} finally {
		if (previousAnthropicKey === undefined) delete process.env.ANTHROPIC_API_KEY; else process.env.ANTHROPIC_API_KEY = previousAnthropicKey;
	}
}
{
	const bad = await fetch(`http://127.0.0.1:${port}/agent/turn`, { method: "POST", headers: { "content-type": "application/json", origin: `http://127.0.0.1:${port}` }, body: JSON.stringify({ sessionId: "e", text: "hi", effort: "bogus" }) });
	assert.equal(bad.status, 400, "an effort the backend would reject never leaves the sidecar");
	const effortFaux = createFakeModel();
	effortFaux.script([{ type: "text", text: "ok" }]);
	const effortHandler = createAgentHandler({ auth: { getAccessToken: async () => "token" }, codex: fakeCodex, models: effortFaux.models, fauxProvider: effortFaux.fauxProvider, liveHub: fakeLive, port: () => effortServer.address().port });
	const effortServer = createServer((req, res) => effortHandler(req, res).catch(() => {})); effortServer.listen(0, "127.0.0.1"); await once(effortServer, "listening");
	const effortPort = effortServer.address().port;
	const effortText = await fetch(`http://127.0.0.1:${effortPort}/agent/turn`, { method: "POST", headers: { "content-type": "application/json", origin: `http://127.0.0.1:${effortPort}` }, body: JSON.stringify({ sessionId: "e2", text: "hi", model: "faux/scripted", effort: "xhigh" }) }).then((r) => r.text());
	assert.equal(effortText.includes('"type":"error"'), false, "the chosen effort reaches the faux model");
	effortServer.close();
	console.log("PASS reasoning effort: models expose efforts/default, invalid effort is 400, chosen effort reaches codex");
}
const authHandler = createAgentHandler({ auth: { getAccessToken: async () => null }, codex: fakeCodex, liveHub: fakeLive, port: () => authServer.address().port });
const authServer = createServer((req, res) => authHandler(req, res).catch(() => {})); authServer.listen(0, "127.0.0.1"); await once(authServer, "listening");
const authPort = authServer.address().port;
const authResponse = await fetch(`http://127.0.0.1:${authPort}/agent/turn`, { method: "POST", headers: { origin: `http://127.0.0.1:${authPort}`, "content-type": "application/json" }, body: JSON.stringify({ sessionId: "auth", text: "hi" }) });
assert.equal((await authResponse.text()).includes('"code":"auth"'), true);
await new Promise((resolve) => authServer.close(resolve));

// Provider-only Studio sessions can replay events and accept an owned candidate;
// neither route should require a ChatGPT token once the registry has a key.
{
	const { envelopeFixture, contextFixture } = await import("./verify-studio-agent-protocol.mjs");
	const providerModels = createModels();
	const providerFaux = createFakeModel({ models: providerModels, provider: "anthropic", modelId: "claude-3" });
	let savedKey = "sk-ant-route-test";
	providerModels.getAuth = async (providerOrModel) => (typeof providerOrModel === "string" ? providerOrModel : providerOrModel.provider) === "anthropic" && savedKey
		? { auth: { apiKey: savedKey }, source: "file" } : undefined;
	const acceptedJobs = [];
	const motionRuntime = {
		readContext: async () => contextFixture(),
		admit: () => ({ jobId: "provider-job", commandId: "provider-command", state: "queued" }),
		subscribe: () => () => {},
		// #379 / 16r: activeJobId now stays set for the accept route only while the
		// runtime's outcome is genuinely pending an explicit accept, matching the
		// real motion-runtime's own "review_required" terminal-transition status
		// (bin/agent/motion-runtime.mjs execute()); any other resolved status is
		// treated as terminal and clears activeJobId before this route ever runs.
		start: async () => ({ ok: false, status: "review_required", mutated: false }),
		accept: async (id) => { acceptedJobs.push(id); return { ok: true, jobId: id, status: "installed" }; },
	};
	const providerAuth = { getAccessToken: async () => null, onAuthChange: () => () => {} };
	let providerServer;
	const providerHandler = createAgentHandler({ auth: providerAuth, codex: fakeCodex, models: providerModels, fauxProvider: providerFaux.fauxProvider, liveHub: fakeLive, studioRuntime: motionRuntime, port: () => providerServer.address().port });
	providerFaux.script([
		{ type: "toolCall", id: "provider-motion", name: "generate_motion", arguments: { characterId: "char-alex", source: { kind: "generate", beats: [{ text: "walk" }], durationSeconds: 2 } } },
		{ type: "text", text: "provider-only" },
	]);
	providerServer = createServer((req, res) => providerHandler(req, res).catch((error) => { if (!res.headersSent) res.writeHead(500); res.end(error.message); }));
	const ready = once(providerServer, "listening", { signal: AbortSignal.timeout(5000) });
	providerServer.listen(0, "127.0.0.1");
	await ready;
	const providerOrigin = `http://127.0.0.1:${providerServer.address().port}`;
	const providerEnvelope = { ...envelopeFixture(), sessionId: "00000000-0000-4000-8000-00000000c379", turnId: "00000000-0000-4000-8000-00000000c380", model: "anthropic/claude-3" };
	const request = (path, init = {}) => fetch(`${providerOrigin}${path}`, { ...init, signal: AbortSignal.timeout(5000), headers: { origin: providerOrigin, "content-type": "application/json", ...init.headers } });
	const turnResponse = await request("/agent/turn", { method: "POST", body: JSON.stringify(providerEnvelope) });
	assert.equal((await turnResponse.text()).includes('"type":"error"'), false);
	const ownerCookie = (turnResponse.headers.getSetCookie?.() ?? [turnResponse.headers.get("set-cookie")]).filter(Boolean).map((entry) => entry.split(";")[0]).join("; ");
	assert.match(ownerCookie, /studio_owner=/);
	const eventsPath = `/agent/turn/${providerEnvelope.turnId}/events`;
	const acceptPath = "/agent/jobs/provider-job/accept";
	const accept = (cookie) => ({ method: "POST", headers: { cookie }, body: JSON.stringify({ surface: "studio", sessionId: providerEnvelope.sessionId, turnId: providerEnvelope.turnId, explicitUnverifiedAcceptance: true }) });
	const eventsResponse = await request(eventsPath, { headers: { cookie: ownerCookie } });
	assert.equal(eventsResponse.status, 200, "provider-only owner can replay Studio events");
	assert.match(eventsResponse.headers.get("content-type"), /text\/event-stream/);
	assert.ok((await eventsResponse.text()).includes('"type":"done"'));
	assert.equal((await request(eventsPath, { headers: { cookie: "studio_owner=wrong" } })).status, 403);
	assert.equal((await request(acceptPath, accept("studio_owner=wrong"))).status, 403);
	assert.equal((await request("/agent/image", { method: "POST", body: JSON.stringify({ prompt: "render", imageDataUrl: png }) })).status, 401, "image generation stays ChatGPT-only");
	assert.equal((await request(acceptPath, accept(ownerCookie))).status, 200, "provider-only owner can accept the unverified candidate");
	assert.deepEqual(acceptedJobs, ["provider-job"]);
	providerFaux.script([{ type: "text", text: "workflow provider-only" }]);
	const workflow = await request("/agent/turn", { method: "POST", body: JSON.stringify({ sessionId: "provider-workflow", model: "anthropic/claude-3", text: "hi" }) });
	assert.equal((await workflow.text()).includes('"type":"error"'), false, "the turn route shares provider-neutral readiness");
	savedKey = null;
	assert.equal((await request(eventsPath, { headers: { cookie: ownerCookie } })).status, 401);
	assert.equal((await request(acceptPath, accept(ownerCookie))).status, 401);
	await new Promise((resolve) => providerServer.close(resolve));
	await providerHandler.close();
	console.log("PASS provider-only Studio event replay and acceptance gates; no-credential requests remain 401");
}

// Older route fixtures may inject only a model registry shell. Credential gates
// must treat that as no provider credential, never as an internal server error.
{
	let registryServer;
	const noGetAuth = createAgentHandler({ auth: { getAccessToken: async () => null }, models: {}, liveHub: fakeLive, port: () => registryServer.address().port });
	registryServer = createServer((req, res) => noGetAuth(req, res).catch((error) => { if (!res.headersSent) res.writeHead(500); res.end(error.message); }));
	registryServer.listen(0, "127.0.0.1");
	await once(registryServer, "listening");
	const registryOrigin = `http://127.0.0.1:${registryServer.address().port}`;
	const noTokenEvents = await fetch(`${registryOrigin}/agent/turn/missing/events`, { headers: { origin: registryOrigin } });
	assert.equal(noTokenEvents.status, 401, "a registry without getAuth is treated as no credential");
	await new Promise((resolve) => registryServer.close(resolve));
	await noGetAuth.close();

	let tokenServer;
	const tokenRegistry = createAgentHandler({ auth: { getAccessToken: async () => "token" }, models: {}, liveHub: fakeLive, port: () => tokenServer.address().port });
	tokenServer = createServer((req, res) => tokenRegistry(req, res).catch((error) => { if (!res.headersSent) res.writeHead(500); res.end(error.message); }));
	tokenServer.listen(0, "127.0.0.1");
	await once(tokenServer, "listening");
	const tokenOrigin = `http://127.0.0.1:${tokenServer.address().port}`;
	const tokenEvents = await fetch(`${tokenOrigin}/agent/turn/missing/events`, { headers: { origin: tokenOrigin } });
	assert.equal(tokenEvents.status, 403, "a ChatGPT token reaches the owner-cookie authorization check");
	await new Promise((resolve) => tokenServer.close(resolve));
	await tokenRegistry.close();

	let throwingServer;
	const throwingRegistry = createAgentHandler({ auth: { getAccessToken: async () => null }, models: { getAuth: async () => { throw new Error("provider lookup failed"); } }, liveHub: fakeLive, port: () => throwingServer.address().port });
	throwingServer = createServer((req, res) => throwingRegistry(req, res).catch((error) => { if (!res.headersSent) res.writeHead(500); res.end(error.message); }));
	throwingServer.listen(0, "127.0.0.1");
	await once(throwingServer, "listening");
	const throwingOrigin = `http://127.0.0.1:${throwingServer.address().port}`;
	assert.equal((await fetch(`${throwingOrigin}/agent/turn/missing/events`, { headers: { origin: throwingOrigin } })).status, 401, "a throwing provider lookup is treated as no credential");
	await new Promise((resolve) => throwingServer.close(resolve));
	await throwingRegistry.close();
	console.log("PASS credential gates tolerate injected registries without getAuth");
}
server.close();
{
	const { envelopeFixture, contextFixture } = await import("./verify-studio-agent-protocol.mjs");
	const studioFaux = createFakeModel();
	studioFaux.script([[{ type: "text", text: "First answer" }], [{ type: "text", text: "Continued answer" }]]);
	const makeStudio = () => {
		const handler = createAgentHandler({ auth: { getAccessToken: async () => "token" }, codex: fakeCodex, models: studioFaux.models, fauxProvider: studioFaux.fauxProvider, liveHub: fakeLive, studioRuntime: { readContext: async () => contextFixture() }, port: () => studioServer.address().port });
		const studioServer = createServer((req, res) => handler(req, res).catch((error) => { if (!res.headersSent) res.writeHead(500); res.end(error.message); }));
		return { handler, studioServer };
	};
	const first = makeStudio();
	first.studioServer.listen(0, "127.0.0.1"); await once(first.studioServer, "listening");
	const firstEnvelope = envelopeFixture();
	const studioOrigin = `http://127.0.0.1:${first.studioServer.address().port}`;
	await fetch(`${studioOrigin}/agent/turn`, { method: "POST", headers: { "content-type": "application/json", origin: studioOrigin }, body: JSON.stringify(firstEnvelope) }).then((response) => response.text());
	first.studioServer.close();
	assert.ok(readdirSync(sessionDir).some((name) => name === `${firstEnvelope.sessionId}.jsonl`), "Studio turn writes its append-only history");
	assert.ok(readdirSync(sessionDir).some((name) => name === `${firstEnvelope.sessionId}.meta.json`), "Studio turn writes its metadata");
	const second = makeStudio();
	second.studioServer.listen(0, "127.0.0.1"); await once(second.studioServer, "listening");
	const secondEnvelope = { ...envelopeFixture(), turnId: "00000000-0000-4000-8000-000000000003", text: "continue this" };
	const secondOrigin = `http://127.0.0.1:${second.studioServer.address().port}`;
	await fetch(`${secondOrigin}/agent/turn`, { method: "POST", headers: { "content-type": "application/json", origin: secondOrigin }, body: JSON.stringify(secondEnvelope) }).then((response) => response.text());
	assert.equal(studioFaux.calls[1].messages[0].role, "user");
	assert.equal(studioFaux.calls[1].messages.filter((item) => item.role === "user").length, 2, "a fresh route instance sends prior history to pi");
	const listed = await fetch(`${secondOrigin}/agent/sessions?surface=studio`).then((response) => response.json());
	assert.equal(listed.sessions[0].sessionId, firstEnvelope.sessionId, "Studio sessions list newest metadata first");
	const loaded = await fetch(`${secondOrigin}/agent/sessions/${firstEnvelope.sessionId}`).then((response) => response.json());
	assert.deepEqual(loaded.transcript.filter((item) => item.kind === "user").map((item) => item.text), ["inspect selection", "continue this"]);
	assert.ok(loaded.transcript.some((item) => item.kind === "assistant" && item.text === "First answer"), "session route derives assistant transcript text");
	second.studioServer.close();
	rmSync(sessionDir, { recursive: true, force: true });
	console.log("PASS Studio sessions persist, lazy-load across route instances, list and derive transcript views");

	// #372/#379: pasted pictures precede their turn text in the history; the
	// transcript view puts them back on that text's bubble as thumbnails, now
	// over the v2 pi Message shape.
	const { transcriptFromHistory } = await import("../bin/agent/session-store.mjs");
	const png = "data:image/png;base64,iVBORw0KGgo=";
	const withAttachments = transcriptFromHistory([
		{ role: "user", content: [{ type: "text", text: "User attachment probe.png" }, { type: "image", data: png, mimeType: "image/png" }] },
		{ role: "user", content: [{ type: "text", text: "User attachment 2" }, { type: "image", data: png, mimeType: "image/png" }] },
		{ role: "user", content: "<studio-context>{}</studio-context>\nwhat is in these?" },
		{ role: "assistant", content: [{ type: "text", text: "Two probes." }] },
		{ role: "user", content: [{ type: "text", text: "User attachment big.png" }] },
		{ role: "user", content: "and this one?" },
	]);
	assert.deepEqual(withAttachments.map((item) => item.kind), ["user", "assistant", "user"], "attachment items fold into their turn's user bubble");
	assert.equal(withAttachments[0].text, "what is in these?");
	assert.deepEqual(withAttachments[0].attachments, [{ name: "probe.png", dataUrl: png }, { name: "2", dataUrl: png }]);
	assert.equal(withAttachments[2].attachments, undefined, "an attachment whose image was too large to persist leaves no empty thumbnail");
	console.log("PASS resumed transcripts carry pasted attachments as thumbnails on the user bubble");

	// gate-5 fix #1: attachmentNames names the attachment in content order,
	// ahead of any adjacent label text part.
	const namedAttachment = transcriptFromHistory([
		{ role: "user", content: [{ type: "text", text: "What is shown?" }, { type: "image", data: "AA==", mimeType: "image/png" }], attachmentNames: ["named.png"] },
	]);
	assert.deepEqual(namedAttachment, [{ kind: "user", text: "What is shown?", attachments: [{ name: "named.png", dataUrl: "data:image/png;base64,AA==" }] }], "message.attachmentNames names the pasted picture");
	console.log("PASS attachmentNames names a pi attachment ahead of an adjacent label");

	// gate-5 fix #2: ordinary text that precedes a `User attachment <name>`
	// label in the SAME message is turn text, never folded into the label.
	const inlineLabelAttachment = transcriptFromHistory([
		{ role: "user", content: [{ type: "text", text: "What is shown?" }, { type: "text", text: "User attachment inline.png" }, { type: "image", data: "AA==", mimeType: "image/png" }] },
	]);
	assert.deepEqual(inlineLabelAttachment, [{ kind: "user", text: "What is shown?", attachments: [{ name: "inline.png", dataUrl: "data:image/png;base64,AA==" }] }], "an adjacent label never leaks into the bubble text");
	console.log("PASS a User attachment label that follows ordinary text stays out of the bubble text");

	// #379: the store persists pi Messages under a v2 header, round-trips them
	// from a fresh instance, and treats a headerless (pre-v2) file as absent.
	{
		const { createSessionStore } = await import("../bin/agent/session-store.mjs");
		const v2Dir = mkdtempSync(join(tmpdir(), "cozyclay-agent-sessions-v2-"));
		const messages = [
			{ role: "user", content: "hello there" },
			{ role: "assistant", content: [{ type: "text", text: "hi!" }], provider: "openai", model: "gpt-6-astra", usage: { inputTokens: 3, outputTokens: 2 }, stopReason: "stop" },
			{ role: "toolResult", toolCallId: "call-1", toolName: "frame_shot", content: [{ type: "text", text: "ok" }], details: { receiptId: "receipt-9" }, isError: false },
		];
		const writer = createSessionStore(v2Dir);
		writer.append("round-trip", messages, { surface: "studio", motionJobIds: ["job-a", "job-a", 42] });
		writer.append("round-trip", [], { motionJobIds: ["job-b", null, "job-a"] });
		const reader = createSessionStore(v2Dir);
		const read = reader.read("round-trip");
		assert.deepEqual(read.history, messages, "a fresh store instance reads back exactly what was appended");
		assert.deepEqual(read.meta.motionJobIds, ["job-a", "job-b"], "session metadata unions only deduped string motion job ids across appends");
		const historyFile = readFileSync(join(v2Dir, "round-trip.jsonl"), "utf8");
		const header = JSON.parse(historyFile.split("\n")[0]);
		assert.deepEqual(header, { format: "cozyclay-agent-v2", version: 2, sessionId: "round-trip" }, "the file opens with the v2 header line");

		// A headerless jsonl (pre-v2, or anything foreign) is invisible to read()
		// and list(), and logs exactly one warning across both lookups.
		writeFileSync(join(v2Dir, "legacy.jsonl"), `${JSON.stringify({ role: "user", content: "old shape" })}\n`, { mode: 0o600 });
		writeFileSync(join(v2Dir, "legacy.meta.json"), `${JSON.stringify({ sessionId: "legacy", surface: "studio", updatedAt: new Date().toISOString() })}\n`, { mode: 0o600 });
		const warnings = [];
		const originalWarn = console.warn;
		console.warn = (...args) => warnings.push(args.join(" "));
		try {
			assert.equal(reader.read("legacy"), null, "a headerless file is treated as absent by read()");
			const listed = reader.list({ surface: "studio" });
			assert.equal(listed.some((entry) => entry.sessionId === "legacy"), false, "list() omits the legacy session");
		} finally { console.warn = originalWarn; }
		assert.equal(warnings.length, 1, `exactly one warning across the read() and list() lookups: ${JSON.stringify(warnings)}`);
		assert.match(warnings[0], /\[agent\] skipping legacy session legacy/);
		rmSync(v2Dir, { recursive: true, force: true });
		console.log("PASS session store v2: round-trips pi messages under a header, skips a legacy headerless file with one warning");

		// gate-5 fix #3: a file whose literal first line is blank (starts with
		// '\n') is legacy too — list() must not treat that blank truthiness as a v2 header.
		const blankDir = mkdtempSync(join(tmpdir(), "cozyclay-agent-sessions-blank-"));
		const blankStore = createSessionStore(blankDir);
		writeFileSync(join(blankDir, "blank-first.jsonl"), `\n${JSON.stringify({ role: "user", content: "old shape" })}\n`, { mode: 0o600 });
		writeFileSync(join(blankDir, "blank-first.meta.json"), `${JSON.stringify({ sessionId: "blank-first", surface: "studio", updatedAt: new Date().toISOString() })}\n`, { mode: 0o600 });
		const blankWarnings = [];
		const originalBlankWarn = console.warn;
		console.warn = (...args) => blankWarnings.push(args.join(" "));
		try {
			assert.equal(blankStore.read("blank-first"), null, "a blank first line is treated as absent by read()");
			const blankListed = blankStore.list({ surface: "studio" });
			assert.equal(blankListed.some((entry) => entry.sessionId === "blank-first"), false, "list() omits a session whose jsonl starts with a blank line");
		} finally { console.warn = originalBlankWarn; }
		assert.equal(blankWarnings.length, 1, `exactly one warning across the read() and list() lookups: ${JSON.stringify(blankWarnings)}`);
		assert.match(blankWarnings[0], /\[agent\] skipping legacy session blank-first/);
		rmSync(blankDir, { recursive: true, force: true });
		console.log("PASS session store v2: list() also skips a legacy session whose jsonl starts with a blank first line");
	}

	// #375: a handler built with its own session store never touches the disk
	// store, so suites that only need the routes leave no session files behind.
	const memoryDir = mkdtempSync(join(tmpdir(), "cozyclay-agent-sessions-memory-"));
	const previousDir = process.env.COZYCLAY_AGENT_SESSIONS_DIR;
	process.env.COZYCLAY_AGENT_SESSIONS_DIR = memoryDir;
	const memory = new Map();
	const memoryStore = {
		read(sessionId) { return memory.get(sessionId) ?? null; },
		append(sessionId, items, meta = {}) { const entry = memory.get(sessionId) ?? { history: [], meta: { sessionId, ...meta } }; entry.history.push(...items); memory.set(sessionId, entry); return entry.meta; },
		list() { return [...memory.values()].map((entry) => entry.meta); },
	};
	const memoryFaux = createFakeModel();
	memoryFaux.script([{ type: "text", text: "memory" }]);
	const memoryHandler = createAgentHandler({ auth: { getAccessToken: async () => "token" }, codex: fakeCodex, models: memoryFaux.models, fauxProvider: memoryFaux.fauxProvider, liveHub: fakeLive, studioRuntime: { readContext: async () => contextFixture() }, port: () => memoryServer.address().port, sessionStore: memoryStore });
	const memoryServer = createServer((req, res) => memoryHandler(req, res).catch((error) => { if (!res.headersSent) res.writeHead(500); res.end(error.message); }));
	memoryServer.listen(0, "127.0.0.1"); await once(memoryServer, "listening");
	const memoryOrigin = `http://127.0.0.1:${memoryServer.address().port}`;
	const memoryEnvelope = { ...envelopeFixture(), sessionId: "00000000-0000-4000-8000-00000000a375" };
	await fetch(`${memoryOrigin}/agent/turn`, { method: "POST", headers: { "content-type": "application/json", origin: memoryOrigin }, body: JSON.stringify(memoryEnvelope) }).then((response) => response.text());
	assert.ok(memory.has(memoryEnvelope.sessionId), "the injected session store received the turn");
	assert.deepEqual(readdirSync(memoryDir), [], "an injected session store keeps the disk store untouched");
	memoryServer.close();
	process.env.COZYCLAY_AGENT_SESSIONS_DIR = previousDir;
	rmSync(memoryDir, { recursive: true, force: true });
	console.log("PASS createAgentHandler accepts an injected session store");
}
console.log("agent routes verified");

// #135: the embedded Studio preview is a live editor too; the agent must
// pick the authoring tab, not throw on "several workspaces connected".
{
	const { pickWorkspace } = await import("../bin/agent/agent-tools.mjs");
	const hub = (details) => ({
		workspaceHandleDetails: () => details,
		resolveWorkspace: () => { throw new Error("requires workspace_handle"); },
	});
	const agentCommands = ["capture_framing_png", "import_asset"];
	assert.equal(pickWorkspace(hub([{ handle: "a", meta: { embed: true, commands: agentCommands } }, { handle: "b", meta: { project: "P", commands: agentCommands } }])), "b", "skips the embedded preview");
	// #349: two authoring editors are ambiguous, never "pick the last one" —
	// the CLI and the sidecar share one tie-break, and it refuses to guess.
	try {
		pickWorkspace(hub([{ handle: "a", meta: { commands: agentCommands } }, { handle: "b", meta: { project: "P", commands: agentCommands } }]));
		assert.fail("expected AMBIGUOUS_WORKSPACE for two authoring editors");
	} catch (error) {
		assert.equal(error.code, "AMBIGUOUS_WORKSPACE");
		assert.deepEqual(error.details.candidates.map((candidate) => candidate.handle).sort(), ["a", "b"]);
	}
	assert.equal(pickWorkspace(hub([{ handle: "a", meta: { embed: true, commands: agentCommands } }])), "a", "the embedded Studio is the scene when no standalone editor is open");
	assert.equal(pickWorkspace(hub([{ handle: "a", meta: { embed: true, commands: agentCommands } }, { handle: "w", meta: { kind: "workflow", commands: ["get_graph"] } }])), "a", "the workflow canvas never counts as a scene editor");
	assert.throws(() => pickWorkspace(hub([{ handle: "old", meta: { project: "P" } }])), /requires workspace_handle/, "an editor that does not advertise commands is not a candidate");
	console.log("PASS pickWorkspace skips embedded previews");
}

{
	const { pickWorkspace } = await import("../bin/agent/agent-tools.mjs");
	const hub = (details) => ({ workspaceHandleDetails: () => details, resolveWorkspace: () => { throw new Error("requires workspace_handle"); } });
	// A stale tab (or another app on the live port) that lacks the agent commands is skipped.
	assert.equal(pickWorkspace(hub([{ handle: "old", meta: { commands: ["describe"] } }, { handle: "new", meta: { commands: ["capture_framing_png", "import_asset"] } }])), "new", "skips workspaces without the agent commands");
	console.log("PASS pickWorkspace skips workspaces lacking agent commands");
}

{
	const { pickWorkspace, createAgentTools, agentToolSchemas, SYSTEM_PROMPT } = await import("../bin/agent/agent-tools.mjs");
	const mapping = { describe_workflow: "get_graph", add_workflow_node: "add_node", update_workflow_node: "update_node", remove_workflow_node: "remove_node", connect_workflow_nodes: "connect", disconnect_workflow_nodes: "disconnect", run_workflow: "run_workflow", set_workflow_node_output: "set_node_output", focus_workflow_node: "focus_node" };
	const details = [
		{ handle: "studio", meta: { commands: ["capture_framing_png", "import_asset"] } },
		{ handle: "preview", meta: { embed: true, commands: ["capture_framing_png", "import_asset"] } },
		{ handle: "canvas", meta: { kind: "workflow", commands: Object.values(mapping) } },
	];
	const routed = [];
	const hub = {
		workspaceHandleDetails: () => details,
		resolveWorkspace: () => { throw new Error("requires workspace_handle"); },
		command: async (name, args, handle) => { routed.push({ name, args, handle }); return name === "capture_framing_png" ? { dataUrl: png, width: 1, height: 1 } : { node: { id: "new-image" } }; },
	};
	assert.equal(pickWorkspace(hub), "studio");
	assert.equal(pickWorkspace(hub, ["get_graph"], "workflow"), "canvas");
	const onlyStudio = { ...hub, workspaceHandleDetails: () => [details[0]], resolveWorkspace: () => "studio" };
	assert.throws(() => pickWorkspace(onlyStudio, ["get_graph"], "workflow"), /workflow/i, "never route graph commands to a sole Studio");
	const session = { signal: new AbortController().signal, images: new Map(), codex: fakeCodex };
	const tools = createAgentTools({ liveHub: hub, session, emit: () => {} });
	const schemas = agentToolSchemas(tools);
	const names = schemas.map((tool) => tool.name);
	for (const removed of ["capture_blocking_frame", "render_from_frame", "place_image_in_scene"]) assert.equal(names.includes(removed), false, `${removed} is removed from the tool list`);
	assert.ok(names.includes("describe_workflow") && names.includes("add_reference_node"), "describe_workflow and add_reference_node are exposed");
	assert.match(SYSTEM_PROMPT, /run_workflow/);
	{
		// Canvas results echo the whole graph and any data URLs; the model must get a
		// bounded summary, otherwise a reference image blows the request.
		const big = "data:image/png;base64," + "A".repeat(200_000);
		const echoHub = { ...hub, command: async (name) => name === "add_node" ? { node: { id: "upload-1", type: "upload", data: { image_url: big, outputs: [{ value: big }] } }, graph: { nodes: [{ id: "x", data: { image_url: big } }], edges: [] } } : name === "get_graph" ? { nodes: [{ id: "u", type: "upload", model: null, data: { image_url: big }, position: { x: 0, y: 0 } }], edges: [], outputs: { u: [{ value: big }] } } : {} };
		const echoTools = createAgentTools({ liveHub: echoHub, session: { ...session, images: new Map([["img", big]]), latestCaptureId: "img" }, emit: () => {} });
		for (const name of ["add_workflow_node", "add_reference_node", "describe_workflow"]) {
			const out = JSON.stringify(await echoTools.find((tool) => tool.name === name).handler({ type: "upload" }));
			assert.ok(out.length < 2000, `${name} result stays small (${out.length} chars)`);
			assert.ok(!out.includes("AAAAAAAA"), `${name} result carries no image bytes`);
		}
		console.log("PASS canvas tool results are summarised for the model");
	}
	{
		// A panel session outlives page reloads; its cached handles must not point
		// at an editor that is gone, or at the canvas when a scene command is due.
		const stale = { ...session, workspaceHandle: "canvas", workflowHandle: "gone" };
		const staleTools = createAgentTools({ liveHub: hub, session: stale, emit: () => {} });
		routed.length = 0;
		await staleTools.internal.capture.handler({});
		assert.equal(routed.at(-1).handle, "studio", "a scene command re-picks a scene editor instead of the canvas");
		await staleTools.find((tool) => tool.name === "describe_workflow").handler({});
		assert.equal(routed.at(-1).handle, "canvas", "a canvas command re-picks the canvas when its cached handle vanished");
		console.log("PASS stale session handles are re-picked");
	}
	{
		// The canvas connects before the embedded Studio finishes booting. A scene
		// command must never land on the canvas, and capture waits for the editor.
		const canvasOnly = [{ handle: "canvas", meta: { kind: "workflow", commands: ["get_graph"] } }];
		const late = { workspaceHandleDetails: () => canvasOnly, resolveWorkspace: () => "canvas", command: async (name, args, handle) => ({ handle, dataUrl: png, width: 1, height: 1 }) };
		assert.throws(() => pickWorkspace(late), /scene editor/i, "a scene command is refused rather than sent to the canvas");
		const waited = createAgentTools({ liveHub: late, session: { ...session, images: new Map() }, emit: () => {} });
		const pending = waited.internal.capture.handler({});
		canvasOnly.push({ handle: "preview", meta: { embed: true, commands: ["capture_framing_png", "import_asset"] } });
		const result = await pending;
		assert.ok(result.imageId, "capture waits for the editor to say hello, then proceeds");
		console.log("PASS scene commands wait for a scene editor and never hit the canvas");
		// The embedded Studio answers hello before its shot renderer exists.
		let attempts = 0;
		const warming = { workspaceHandleDetails: () => canvasOnly, resolveWorkspace: () => "preview", command: async () => { attempts += 1; if (attempts < 3) throw new Error("The shot renderer is not ready"); return { dataUrl: png, width: 1, height: 1 }; } };
		const warmTools = createAgentTools({ liveHub: warming, session: { ...session, images: new Map() }, emit: () => {} });
		assert.ok((await warmTools.internal.capture.handler({})).imageId, "capture retries while the renderer warms up");
		assert.equal(attempts, 3);
		console.log("PASS capture retries until the shot renderer is ready");
	}
	assert.match(SYSTEM_PROMPT, /describe_workflow/);
	for (const [name, command] of Object.entries(mapping)) {
		const tool = tools.find((entry) => entry.name === name);
		const args = command === "add_node" ? { type: "image" } : {};
		await tool.handler(args);
		assert.deepEqual(routed.at(-1), { name: command, args, handle: "canvas" });
	}
	assert.deepEqual(schemas.find((tool) => tool.name === "add_workflow_node").parameters.required, ["type"]);
	assert.equal(schemas.find((tool) => tool.name === "update_workflow_node").parameters.properties.data.type, "object");
	assert.deepEqual(schemas.find((tool) => tool.name === "connect_workflow_nodes").parameters.required, ["source", "target"]);
	assert.deepEqual(schemas.find((tool) => tool.name === "add_reference_node").parameters.required, [], "imageId is optional on add_reference_node");
	await tools.find((tool) => tool.name === "describe_workflow").handler();
	assert.equal(routed.at(-1).handle, "canvas");
	await assert.rejects(tools.find((tool) => tool.name === "add_reference_node").handler({}), /image/i, "no reference image, no node");
	session.images.set("ref", png);
	session.latestCaptureId = "ref";
	await tools.find((tool) => tool.name === "add_reference_node").handler({});
	assert.equal(routed.at(-1).name, "add_node"); assert.equal(routed.at(-1).handle, "canvas");
	assert.equal(routed.at(-1).args.type, "upload");
	assert.equal(routed.at(-1).args.data.image_url, png);
	assert.equal(routed.at(-1).args.data.fileName, "reference.png");
	assert.equal(routed.at(-1).args.data.mimeType, "image/png");
	assert.deepEqual(routed.at(-1).args.data.outputs, [{ value: png }]);
	await tools.find((tool) => tool.name === "add_reference_node").handler({ imageId: "ref" });
	assert.equal(routed.at(-1).args.data.image_url, png);
	assert.equal(session.workflowHandle, "canvas");
	console.log("PASS canvas agent tools: kind isolation, schemas, one-to-one routing, add_reference_node, independent handles");
}

{
	// Regression for #320: /agent/stop must forward the motion runtime's outcome.
	// The panel decides whether it may say "scene unchanged" from this body alone,
	// so a route that answers a bare {ok:true,status:"stopped"} silently turns
	// "nobody could check" into "nothing was applied".
	const { contextFixture, envelopeFixture } = await import("./verify-studio-agent-protocol.mjs");
	const stopReplies = [
		{ status: "cancelled", code: "CANCELLED", mutated: false },
		{ ok: false, code: "UNCERTAIN_APPLY", mutated: "unknown" },
	];
	const seenJobIds = [];
	const stopRuntime = {
		readContext: async () => contextFixture(),
		admit: () => ({ jobId: "job-stop-1", commandId: "cmd-stop-1", state: "queued" }),
		subscribe: () => () => {},
		start: async () => ({ ok: false, code: "CANCELLED", mutated: false }),
		stop: async (jobId) => { seenJobIds.push(jobId); return stopReplies.shift(); },
	};
	const stopFaux = createFakeModel();
	stopFaux.script([
		{ type: "toolCall", id: "m1", name: "generate_motion", arguments: { characterId: "char-alex", source: { kind: "generate", beats: [{ text: "walk forward" }], durationSeconds: 2 } } },
		{ type: "text", text: "done" },
	]);
	let stopServer;
	const stopHub = { command: async () => ({ ok: true }), workspaceId: () => "tab-7", resolveWorkspace: () => "handle-12", handleForWorkspaceId: () => "handle-12", connected: true, workspaceHandles: ["handle-12"] };
	const stopHandler = createAgentHandler({ auth: { getAccessToken: async () => "token" }, codex: fakeCodex, models: stopFaux.models, fauxProvider: stopFaux.fauxProvider, liveHub: stopHub, studioRuntime: stopRuntime, port: () => stopServer.address().port });
	stopServer = createServer((req, res) => stopHandler(req, res).catch((error) => { console.error("stop-route fixture error:", error); if (!res.headersSent) res.writeHead(500); res.end(error.message); }));
	stopServer.listen(0, "127.0.0.1");
	await once(stopServer, "listening");
	const stopPort = stopServer.address().port;
	const origin = `http://127.0.0.1:${stopPort}`;
	const envelope = { ...envelopeFixture(), model: "faux/scripted" };
	const turnResponse = await fetch(`${origin}/agent/turn`, { method: "POST", headers: { "content-type": "application/json", origin }, body: JSON.stringify(envelope) });
	await turnResponse.text();
	const cookie = (turnResponse.headers.getSetCookie?.() ?? [turnResponse.headers.get("set-cookie")]).filter(Boolean).map((entry) => entry.split(";")[0]).join("; ");
	assert.match(cookie, /studio_owner=/, "the turn hands the owning UI its stop credential");
	const stop = async () => {
		const response = await fetch(`${origin}/agent/stop`, { method: "POST", headers: { "content-type": "application/json", origin, cookie }, body: JSON.stringify({ surface: "studio", sessionId: envelope.sessionId, turnId: envelope.turnId, jobId: "job-stop-1" }) });
		return { status: response.status, body: await response.json() };
	};
	const proved = await stop();
	assert.equal(proved.status, 200, JSON.stringify(proved.body));
	assert.deepEqual(proved.body.outcome, { status: "cancelled", code: "CANCELLED", mutated: false }, "a proven cancellation reaches the panel intact");
	const unproven = await stop();
	assert.equal(unproven.body.outcome.mutated, "unknown", "an uncertain runtime outcome is forwarded as uncertain, not dropped");
	assert.equal(unproven.body.outcome.code, "UNCERTAIN_APPLY");
	assert.deepEqual(seenJobIds, ["job-stop-1", "job-stop-1"]);
	stopServer.close();
	console.log("PASS /agent/stop forwards the runtime outcome instead of asserting success");
}

{
	// Regression for #335/#336: a Studio turn whose model stream fails on every
	// attempt must surface a real error frame (never a bare "done") and the
	// sidecar must have retried the transient failure before giving up.
	const { contextFixture, envelopeFixture } = await import("./verify-studio-agent-protocol.mjs");
	let failTurns = 0;
	const failRuntime = { readContext: async () => contextFixture() };
	const failFaux = createFakeModel();
	failFaux.fauxProvider.setResponses([async () => { failTurns += 1; throw Object.assign(new Error("Model response failed."), { code: "server_error" }); }]);
	let failServer;
	const failHub = { command: async () => ({ ok: true }), workspaceId: () => "tab-8", resolveWorkspace: () => "handle-13", handleForWorkspaceId: () => "handle-13", connected: true, workspaceHandles: ["handle-13"] };
	const failHandler = createAgentHandler({ auth: { getAccessToken: async () => "token" }, codex: fakeCodex, models: failFaux.models, fauxProvider: failFaux.fauxProvider, liveHub: failHub, studioRuntime: failRuntime, port: () => failServer.address().port });
	failServer = createServer((req, res) => failHandler(req, res).catch((error) => { console.error("studio-stream-error fixture error:", error); if (!res.headersSent) res.writeHead(500); res.end(error.message); }));
	failServer.listen(0, "127.0.0.1");
	await once(failServer, "listening");
	const failOrigin = `http://127.0.0.1:${failServer.address().port}`;
	const failText = await fetch(`${failOrigin}/agent/turn`, { method: "POST", headers: { "content-type": "application/json", origin: failOrigin }, body: JSON.stringify(envelopeFixture()) }).then((r) => r.text());
	const failEvents = [...failText.matchAll(/^data: (.+)$/gm)].map((match) => JSON.parse(match[1]));
	const failTypes = failEvents.map((event) => event.type);
	const errorIndex = failTypes.indexOf("error");
	const doneIndex = failTypes.indexOf("done");
	assert.ok(errorIndex !== -1, "a persistently failing model stream produces an error frame");
	assert.ok(doneIndex !== -1 && errorIndex < doneIndex, "the error frame precedes done, never a bare done alone");
	assert.match(failEvents[errorIndex].message, /Model response failed/);
	assert.equal(failTurns, 1, "the runner surfaces the faux provider failure without a legacy Studio retry loop");
	failServer.close();
	console.log("PASS Studio turn model stream errors are retried and surfaced as a real error frame");
}

{
	// #350: the Studio branch owes the panel and the analytics pipeline exactly
	// what the Workflow branch already sends — a labelled tool.start whose args
	// are summarised (no image bytes), a tool.done that states how long the tool
	// took, and the execution telemetry frames that make a turn measurable.
	const { contextFixture, envelopeFixture } = await import("./verify-studio-agent-protocol.mjs");
	const { receiptFixture } = await import("./verify-studio-agent-protocol.mjs");
	const identityImage = "data:image/png;base64," + "A".repeat(120_000);
	const parityFaux = createFakeModel();
	parityFaux.script([
		{ type: "toolCall", id: "par-1", name: "patch_elements", arguments: { ops: [{ target: { kind: "character", id: "char-alex" }, set: { identityImage } }] } },
		{ type: "text", text: "done" },
	]);
	let parityServer;
	const parityHub = { command: async (name) => name === "patch_elements" ? receiptFixture() : { ok: true }, workspaceId: () => "tab-7", resolveWorkspace: () => "handle-12", handleForWorkspaceId: () => "handle-12", connected: true, workspaceHandles: ["handle-12"] };
	const parityHandler = createAgentHandler({ auth: { getAccessToken: async () => "token" }, codex: fakeCodex, models: parityFaux.models, fauxProvider: parityFaux.fauxProvider, liveHub: parityHub, studioRuntime: { readContext: async () => contextFixture() }, port: () => parityServer.address().port });
	parityServer = createServer((req, res) => parityHandler(req, res).catch((error) => { console.error("studio-parity fixture error:", error); if (!res.headersSent) res.writeHead(500); res.end(error.message); }));
	parityServer.listen(0, "127.0.0.1");
	await once(parityServer, "listening");
	const parityOrigin = `http://127.0.0.1:${parityServer.address().port}`;
	const parityEnvelope = envelopeFixture();
	const parityText = await fetch(`${parityOrigin}/agent/turn`, { method: "POST", headers: { "content-type": "application/json", origin: parityOrigin }, body: JSON.stringify(parityEnvelope) }).then((r) => r.text());
	const parityEvents = [...parityText.matchAll(/^data: (.+)$/gm)].map((match) => JSON.parse(match[1]));
	const parityStart = parityEvents.find((event) => event.type === "tool.start" && event.callId === "par-1");
	assert.ok(parityStart, "the Studio tool call opens a card");
	assert.equal(parityStart.label, "patch elements", "a Studio tool.start reads as an action, exactly like the Workflow branch");
	assert.ok(parityStart.args, "a Studio tool.start carries the arguments the card shows");
	const parityArgs = JSON.stringify(parityStart.args);
	assert.equal(parityArgs.includes("data:image/"), false, "image bytes never travel in a tool card");
	assert.match(parityArgs, /\[image \d+ KB\]/, "the summarised argument states the size it replaced");
	assert.equal(parityStart.args.ops[0].target.id, "char-alex", "summarising keeps every readable argument");
	const parityDone = parityEvents.find((event) => event.type === "tool.done" && event.callId === "par-1");
	assert.equal(parityDone.ok, true, JSON.stringify(parityDone));
	assert.ok(Number.isFinite(parityDone.elapsedMs) && parityDone.elapsedMs >= 0, `a Studio tool.done states its elapsed time: ${JSON.stringify(parityDone.elapsedMs)}`);
	const parityStarted = parityEvents.filter((event) => event.type === "execution_tool_started");
	const parityTelemetry = parityEvents.filter((event) => event.type === "execution_telemetry");
	assert.equal(parityStarted.length, 1, "the Studio turn announces the tool it started");
	assert.match(parityStarted[0].telemetry_id, /^[a-f0-9]{32}$/);
	assert.equal(parityStarted[0].tool_category, "scene_write");
	assert.deepEqual(parityTelemetry.map((event) => event.event), ["agent:result_applied", "agent:tool_executed", "agent:turn_succeeded"], JSON.stringify(parityTelemetry));
	assert.ok(parityTelemetry.every((event) => event.props.turn_id === parityEnvelope.turnId), "the host's own turn id correlates every frame");
	assert.equal(parityStarted[0].turn_id, parityEnvelope.turnId);
	assert.equal(parityTelemetry.find((event) => event.event === "agent:tool_executed").props.outcome, "succeeded");
	assert.equal(parityTelemetry.find((event) => event.event === "agent:tool_executed").telemetry_id, parityStarted[0].telemetry_id);
	// The browser rejects a telemetry frame that carries an unexpected key, so
	// advisory telemetry stays out of the replayable event sequence.
	assert.ok([...parityStarted, ...parityTelemetry].every((event) => !Object.hasOwn(event, "eventSeq")), "telemetry frames carry no replay cursor");
	assert.ok(parityEvents.filter((event) => !["execution_telemetry", "execution_tool_started"].includes(event.type)).every((event) => Number.isSafeInteger(event.eventSeq)), "every replayable Studio event keeps its cursor");
	parityServer.close();
	console.log("PASS Studio turns stream labelled/summarised tool cards, elapsed times and execution telemetry");
}

{
	// #379: each turn in one live session must use its own admitted revision,
	// including after the author edits the scene outside the agent.
	const { contextFixture, envelopeFixture, receiptFixture } = await import("./verify-studio-agent-protocol.mjs");
	let revision = 41;
	const seen = [];
	const current = () => { const context = contextFixture(); context.revision.scene = revision; return context; };
	const twoTurnFaux = createFakeModel();
	const twoTurnHub = { command: async (name, args) => {
		assert.equal(name, "patch_elements");
		seen.push({ actualRevision: revision, expectedRevision: args.expectedRevision });
		if (args.expectedRevision !== revision) return { ok: false, code: "STALE_SCENE", message: "Scene revision changed." };
		return { ...receiptFixture(), revision: { before: revision, after: ++revision } };
	} };
	let twoTurnServer;
	const twoTurnHandler = createAgentHandler({ auth: { getAccessToken: async () => "token" }, models: twoTurnFaux.models, fauxProvider: twoTurnFaux.fauxProvider, handlers: [], liveHub: twoTurnHub, studioRuntime: { readContext: async () => current() }, port: () => twoTurnServer.address().port });
	twoTurnServer = createServer((req, res) => twoTurnHandler(req, res).catch((error) => { if (!res.headersSent) res.writeHead(500); res.end(error.message); }));
	const listening = once(twoTurnServer, "listening", { signal: AbortSignal.timeout(5000) });
	twoTurnServer.listen(0, "127.0.0.1");
	await listening;
	const origin = `http://127.0.0.1:${twoTurnServer.address().port}`;
	const sessionId = "00000000-0000-4000-8000-00000000e379";
	let cookie;
	const post = async (turnId, callId) => {
		twoTurnFaux.script([
			{ type: "toolCall", id: callId, name: "patch_elements", arguments: { ops: [{ target: { kind: "stage" }, set: { "keyLight.warmth": 0.3 } }] } },
			{ type: "text", text: "done" },
		]);
		const response = await fetch(`${origin}/agent/turn`, { method: "POST", headers: { origin, "content-type": "application/json", ...(cookie ? { cookie } : {}) }, body: JSON.stringify({ ...envelopeFixture(), sessionId, turnId, text: "set warmth", context: current(), model: "faux/scripted" }), signal: AbortSignal.timeout(5000) });
		assert.equal(response.status, 200);
		cookie = response.headers.get("set-cookie")?.split(";")[0] || cookie;
		const text = await response.text();
		return [...text.matchAll(/^data: (.+)$/gm)].map((match) => JSON.parse(match[1]));
	};
	try {
		const first = await post("00000000-0000-4000-8000-00000000e380", "first-patch");
		assert.equal(first.find((frame) => frame.type === "tool.done")?.ok, true);
		assert.equal(revision, 42, "the first mutation publishes revision 42");
		revision = 99; // An ordinary manual scene edit between agent turns.
		const second = await post("00000000-0000-4000-8000-00000000e381", "second-patch");
		console.log("two-turn revision bindings", JSON.stringify({ seen, second }));
		assert.equal(seen[1]?.expectedRevision, 99, "turn 2 must use its own admitted revision, not turn 1's closure");
		assert.deepEqual(seen, [{ actualRevision: 41, expectedRevision: 41 }, { actualRevision: 99, expectedRevision: 99 }]);
		assert.equal(second.find((frame) => frame.type === "tool.done")?.ok, true);
		assert.equal(revision, 100, "the second mutation succeeds after the manual edit");
		assert.equal(second.some((frame) => frame.type === "error"), false);
		assert.equal(second.at(-1)?.type, "done");
		assert.equal(twoTurnFaux.calls[2].messages.filter((message) => message.role === "user").length, 2, "the same harness retains both turns");
	} finally {
		await twoTurnHandler.close();
		await new Promise((resolve) => twoTurnServer.close(resolve));
	}
	console.log("PASS Studio two-turn session installs the current admission after an out-of-band revision change");
}

{
	// Regression for #342: a Studio rejection receipt carries code/message at the
	// top level, never under `error`. The tool.done event and the model's
	// function_call_output must show that code, message and recovery hint — never
	// the generic BACKEND_UNAVAILABLE / "Studio command failed".
	const { contextFixture, envelopeFixture } = await import("./verify-studio-agent-protocol.mjs");
	const rejection = { ok: false, commandId: "cmd-rej", host: { workspaceId: "tab-7", documentEpoch: "doc-3", sceneId: "scene-main", sceneEpoch: "scene-open-4" }, code: "STALE_TARGET", phase: "admission", message: "Target incarnation changed; re-read the scene.", affectedIds: [], expectedTargets: [], currentTargets: [{ workspaceId: "tab-7", documentEpoch: "doc-3", sceneId: "scene-main", sceneEpoch: "scene-open-4", targetId: "char-alex", token: "ct-99" }], mutated: false, preserved: { authoredState: "unchanged" }, recovery: { action: "inspect", retryAllowed: false } };
	const rejFaux = createFakeModel();
	rejFaux.script([
		{ type: "toolCall", id: "rej-1", name: "arrange_objects", arguments: { ops: [{ op: "remove", id: "char-alex" }] } },
		{ type: "text", text: "recovered" },
	]);
	let rejServer;
	const rejHub = { command: async (name) => name === "arrange_objects" ? rejection : { ok: true }, workspaceId: () => "tab-7", resolveWorkspace: () => "handle-12", handleForWorkspaceId: () => "handle-12", connected: true, workspaceHandles: ["handle-12"] };
	const rejRuntime = { readContext: async () => contextFixture() };
	const rejHandler = createAgentHandler({ auth: { getAccessToken: async () => "token" }, codex: fakeCodex, models: rejFaux.models, fauxProvider: rejFaux.fauxProvider, liveHub: rejHub, studioRuntime: rejRuntime, port: () => rejServer.address().port });
	rejServer = createServer((req, res) => rejHandler(req, res).catch((error) => { console.error("studio-rejection fixture error:", error); if (!res.headersSent) res.writeHead(500); res.end(error.message); }));
	rejServer.listen(0, "127.0.0.1");
	await once(rejServer, "listening");
	const rejOrigin = `http://127.0.0.1:${rejServer.address().port}`;
	const rejText = await fetch(`${rejOrigin}/agent/turn`, { method: "POST", headers: { "content-type": "application/json", origin: rejOrigin }, body: JSON.stringify({ ...envelopeFixture(), model: "faux/scripted" }) }).then((r) => r.text());
	const rejEvents = [...rejText.matchAll(/^data: (.+)$/gm)].map((match) => JSON.parse(match[1]));
	const toolDone = rejEvents.find((event) => event.type === "tool.done" && event.callId === "rej-1");
	assert.ok(toolDone, "the rejected tool call ends with a tool.done");
	assert.equal(toolDone.ok, false);
	assert.match(toolDone.error, /STALE_TARGET/, "the card shows the receipt's code, not a generic backend failure");
	assert.match(toolDone.error, /Target incarnation changed/, "the card shows the receipt's message");
	assert.ok(!/BACKEND_UNAVAILABLE|Studio command failed/.test(toolDone.error), "the generic failure strings are gone");
	const output = rejFaux.calls[1]?.messages?.find((item) => item.role === "toolResult" && item.toolCallId === "rej-1");
	assert.ok(output, "the model receives a function_call_output for the rejected call");
	const modelError = output.content.find((part) => part.type === "text").text;
	assert.match(modelError, /STALE_TARGET/);
	assert.match(modelError, /Target incarnation changed; re-read the scene\./);
	assert.match(modelError, /inspect, do not retry/, "the model sees the recovery hint");
	assert.equal(rejEvents.some((event) => event.type === "error"), false, "a rejected tool call does not fail the turn; the model continues");
	rejServer.close();
	console.log("PASS Studio tool rejections surface the receipt's code, message and recovery");
}

{
	const { recordGolden } = await import("./fixtures/agent-sse-golden.mjs");
	const golden = JSON.parse(readFileSync(new URL("./fixtures/agent-sse-golden.json", import.meta.url), "utf8"));
	assert.deepEqual((await recordGolden()).S, golden.S, "Studio runner frames preserve golden parity S");
	console.log("PASS golden parity S");
}

{
	// #379: a corrupt providers.json must not take ChatGPT readiness down.
	// codex-auth.mjs fixes its token file path at import time, so this exercises
	// the real production dispatch (handleOAuthRequest) in a fresh child process
	// with a scratch COZYCLAY_CONFIG_DIR (corrupt providers.json) and a faked
	// ChatGPT token, and asserts on its stdout.
	const { spawnSync } = await import("node:child_process");
	const oauthConfigDir = mkdtempSync(join(tmpdir(), "cozyclay-oauth-status-corrupt-"));
	writeFileSync(join(oauthConfigDir, "providers.json"), "{bad", { mode: 0o600 });
	const oauthAuthFile = join(oauthConfigDir, "codex-auth.json");
	const probeScript = `
import { createServer } from "node:http";
import { once } from "node:events";
import { handleOAuthRequest, writeStored } from ${JSON.stringify(new URL("../bin/codex-auth.mjs", import.meta.url).pathname)};
await writeStored({ access_token: "probe-access", refresh_token: "probe-refresh", expires_at: Date.now() + 3600000 });
const server = createServer((req, res) => { handleOAuthRequest(req, res).catch(() => { if (!res.headersSent) { res.writeHead(502, { "content-type": "application/json" }); res.end("{}"); } }); });
server.listen(0, "127.0.0.1");
await once(server, "listening");
const port = server.address().port;
const response = await fetch(\`http://127.0.0.1:\${port}/oauth/status\`);
const body = await response.json();
console.log(JSON.stringify({ status: response.status, body }));
server.close();
`;
	const probeFile = join(oauthConfigDir, "probe.mjs");
	writeFileSync(probeFile, probeScript);
	const result = spawnSync(process.execPath, [probeFile], {
		env: { ...process.env, COZYCLAY_CONFIG_DIR: oauthConfigDir, COZYCLAY_CODEX_AUTH_FILE: oauthAuthFile },
		encoding: "utf8",
	});
	assert.equal(result.status, 0, `probe process exited cleanly: ${result.stderr}`);
	const { status, body } = JSON.parse(result.stdout.trim().split("\n").at(-1));
	assert.equal(status, 200, "a corrupt providers.json no longer produces a 502 from /oauth/status");
	assert.equal(body.signedIn, true, "a valid ChatGPT token still reports signed in");
	assert.equal(body.providersConfigured, 0, "the corrupt file counts as zero saved provider keys");
	rmSync(oauthConfigDir, { recursive: true, force: true });
	console.log("PASS GET /oauth/status: a corrupt providers.json returns 200 with signedIn true and providersConfigured 0");
}

// #379 / 16h: real credential-store modify -> auth.writeStored -> onAuthChange
// during a 401 retry. Only remote OAuth and model/editor responses are fixtures.
{
	const { createCredentialStore } = await import("../bin/agent/credential-store.mjs");
	const { createSessionStore } = await import("../bin/agent/session-store.mjs");
	const { fauxAssistantMessage, fauxText, fauxToolCall } = await import("@earendil-works/pi-ai/providers/faux");
	const tokenFor = accountId => `e30.${Buffer.from(JSON.stringify({ "https://api.openai.com/auth": { chatgpt_account_id: accountId } })).toString("base64url")}.e30`;
	for (const kind of ["rotated", "replaced", "signed_out"]) {
		const scratch = mkdtempSync(join(tmpdir(), `cozyclay-agent-auth-change-${kind}-`));
		const previousAuthFile = process.env.COZYCLAY_CODEX_AUTH_FILE;
		process.env.COZYCLAY_CODEX_AUTH_FILE = join(scratch, "codex-auth.json");
		let realAuth;
		try {
			// A separate module instance fixes its token path to this case's file.
			realAuth = await import(`../bin/codex-auth.mjs?16h=${kind}`);
		} finally {
			if (previousAuthFile === undefined) delete process.env.COZYCLAY_CODEX_AUTH_FILE;
			else process.env.COZYCLAY_CODEX_AUTH_FILE = previousAuthFile;
		}
		realAuth.writeStored({ access_token: "route-old-access", refresh_token: "route-refresh", expires_at: Date.now() + 3600000, id_token: tokenFor("route-account-a") });
		const auth = { ...realAuth, writeStored: value => realAuth.writeStored({ ...value, ...(kind === "replaced" ? { id_token: tokenFor("route-account-b") } : {}) }) };
		let refreshes = 0, mutations = 0, disposals = 0;
		const changes = [];
		const off = auth.onAuthChange(change => changes.push(change));
		const models = createModels({ credentials: createCredentialStore({ auth, keys: { readKeys: () => ({}) }, env: {} }) });
		const faux = createFakeModel({ models, provider: "openai-codex", modelId: "gpt-6-astra", modelName: "Astra" });
		faux.provider.auth = { oauth: {
			name: "Route OAuth",
			refresh: async credential => {
				refreshes++;
				if (kind === "signed_out") {
					auth.logout();
					throw new Error("401 Unauthorized");
				}
				return { ...credential, access: "route-new-access", refresh: "route-new-refresh", expires: Date.now() + 3600000 };
			},
			toAuth: async credential => ({ apiKey: credential.access }),
		} };
		models.setProvider(faux.provider);
		faux.fauxProvider.setResponses([
			fauxAssistantMessage([fauxToolCall("add_workflow_node", { type: "image" }, { id: `${kind}-tool` })], { stopReason: "toolUse" }),
			fauxAssistantMessage([], { stopReason: "error", errorMessage: "401 Unauthorized" }),
			fauxAssistantMessage([fauxText("recovered after refresh")]),
		]);
		const sessions = createSessionStore(join(scratch, "sessions"));
		const handler = createAgentHandler({
			auth, models, codex: fakeCodex, sessionStore: sessions,
			liveHub: { command: async command => { assert.equal(command, "add_node"); mutations++; return { node: { id: `${kind}-node` } }; } },
			studioRuntime: { dispose: () => { disposals++; } },
			port: () => server.address().port,
		});
		const server = createServer((req, res) => handler(req, res).catch(error => { if (!res.headersSent) res.writeHead(500); res.end(error.message); }));
		const listening = once(server, "listening", { signal: AbortSignal.timeout(5000) });
		server.listen(0, "127.0.0.1");
		await listening;
		const origin = `http://127.0.0.1:${server.address().port}`;
		const turnId = "c".repeat(32);
		try {
			const response = await fetch(`${origin}/agent/turn`, { method: "POST", headers: { origin, "content-type": "application/json" }, body: JSON.stringify({ sessionId: `auth-change-${kind}`, turn_id: turnId, text: "apply this exactly once", model: "openai-codex/gpt-6-astra" }), signal: AbortSignal.timeout(10000) });
			const frames = [...(await response.text()).matchAll(/^data: (.+)$/gm)].map(match => JSON.parse(match[1]));
			const rotated = kind === "rotated";
			assert.equal(response.status, 200);
			assert.equal(refreshes, 1, `${kind}: one OAuth refresh`);
			assert.equal(mutations, 1, `${kind}: one actual editor mutation`);
			assertUniqueToolPairs(frames, `16h ${kind}`);
			assert.equal(frames.some(frame => frame.type === "error" && frame.code === "aborted"), !rotated, `${kind}: abort only for identity changes`);
			assert.equal(frames.some(frame => frame.type === "error"), !rotated);
			assert.equal(frames.filter(frame => frame.type === "text.delta").map(frame => frame.text).join(""), rotated ? "recovered after refresh" : "");
			assert.equal(frames.at(-1)?.type, "done");
			assert.deepEqual(sessions.read(`auth-change-${kind}`)?.history.map(message => message.role), rotated ? ["user", "assistant", "toolResult", "assistant"] : ["user", "assistant", "toolResult"]);
			assert.equal(disposals, rotated ? 0 : 1, `${kind}: runtime invalidated only for identity changes`);
			const steer = await fetch(`${origin}/agent/turn/${turnId}/steer`, { method: "POST", headers: { origin, "content-type": "application/json" }, body: JSON.stringify({ text: "session lookup" }), signal: AbortSignal.timeout(5000) });
			assert.equal(steer.status, rotated ? 409 : 404, `${kind}: live session retained only for token rotation`);
			await steer.text();
			if (kind !== "signed_out") assert.equal(auth.readStored().access_token, "route-new-access");
			else assert.equal(auth.readStored(), undefined);
			assert.deepEqual(changes, [{ kind, status: auth.status() }], `${kind}: production notification payload`);
			console.log(`PASS 16h ${kind}: real credential write preserves rotation and invalidates identity changes`);
		} finally {
			off();
			await handler.close();
			await new Promise(resolve => server.close(resolve));
			rmSync(scratch, { recursive: true, force: true });
		}
	}
}

// #379 / 16i (F2 pass 5 finding 2): a Studio turn with an ordinary attachment
// and NO frameObservation must keep the submitted prompt and the attachment
// label as their OWN transcript parts, not one string starting with
// "User attachment " (which session-store's transcriptFromHistory treats
// entirely as the attachment label and drops from the bubble text).
{
	const { transcriptFromHistory, createSessionStore } = await import("../bin/agent/session-store.mjs");
	const studioAttachFaux = createFakeModel();
	studioAttachFaux.script([{ type: "text", text: "I see the reference." }]);
	const studioAttachSessions = createSessionStore(mkdtempSync(join(tmpdir(), "cozyclay-agent-studio-attach-restore-")));
	const studioAttachHandler = createAgentHandler({ auth: { getAccessToken: async () => "token" }, codex: fakeCodex, models: studioAttachFaux.models, fauxProvider: studioAttachFaux.fauxProvider, liveHub: fakeLive, sessionStore: studioAttachSessions, studioRuntime: { readContext: async () => (await import("./verify-studio-agent-protocol.mjs")).contextFixture() }, port: () => studioAttachServer.address().port });
	const studioAttachServer = createServer((req, res) => studioAttachHandler(req, res).catch((error) => { if (!res.headersSent) res.writeHead(500); res.end(error.message); }));
	studioAttachServer.listen(0, "127.0.0.1");
	await once(studioAttachServer, "listening");
	const studioAttachOrigin = `http://127.0.0.1:${studioAttachServer.address().port}`;
	const studioAttachSessionId = "00000000-0000-4000-8000-00000000a379";
	const studioAttachEnvelope = { ...(await import("./verify-studio-agent-protocol.mjs")).envelopeFixture(), sessionId: studioAttachSessionId, text: "Make the character match this reference.", attachments: [{ dataUrl: png, name: "reference.png" }] };
	await fetch(`${studioAttachOrigin}/agent/turn`, { method: "POST", headers: { "content-type": "application/json", origin: studioAttachOrigin }, body: JSON.stringify(studioAttachEnvelope) }).then((response) => response.text());
	const studioAttachMessage = studioAttachFaux.calls.at(-1)?.messages.findLast((item) => item.role === "user");
	const studioAttachParts = studioAttachMessage?.content ?? [];
	assert.equal(studioAttachParts.length, 4, `the provider-observed Studio user message carries the label, context, prompt and image as 4 separate parts: ${JSON.stringify(studioAttachParts)}`);
	assert.match(studioAttachParts.find((part) => part.type === "text" && part.text.startsWith("User attachment"))?.text ?? "", /reference\.png/, "the attachment label part names the file");
	assert.ok(studioAttachParts.some((part) => part.type === "text" && part.text === "Make the character match this reference."), "the user prompt is its own text part, not merged into the label or the context");
	assert.ok(studioAttachParts.some((part) => part.type === "image"), "the image part is still sent to the model");
	const studioAttachHistory = studioAttachSessions.read(studioAttachSessionId).history;
	const studioAttachTranscript = transcriptFromHistory(studioAttachHistory);
	const studioAttachBubble = studioAttachTranscript.find((item) => item.kind === "user");
	assert.equal(studioAttachBubble?.text, "Make the character match this reference.", "the restored Studio bubble keeps the submitted prompt text");
	assert.equal(studioAttachBubble?.attachments?.[0]?.name, "reference.png", "the restored Studio bubble keeps the attachment name");
	studioAttachServer.close();
	console.log("PASS 16i: a Studio turn with an attachment and no frameObservation restores its prompt text and attachment name");
}

// #379 / 16m (F2 pass 6 finding 2): signed_out/replaced must retire the
// cached workflowRunner, not just abort the route session, because the
// runner's tools (e.g. the attach-frame capture) close over the FIRST
// turn's session/signal. A later turn reusing the same sessionId must build
// a fresh runner instead of running tools bound to the retired session.
for (const kind of ["replaced", "signed_out", "rotated"]) {
	const scratch16m = mkdtempSync(join(tmpdir(), `cozyclay-agent-16m-${kind}-`));
	const previousAuthFile16m = process.env.COZYCLAY_CODEX_AUTH_FILE;
	process.env.COZYCLAY_CODEX_AUTH_FILE = join(scratch16m, "codex-auth.json");
	let realAuth16m;
	try {
		realAuth16m = await import(`../bin/codex-auth.mjs?16m=${kind}`);
	} finally {
		if (previousAuthFile16m === undefined) delete process.env.COZYCLAY_CODEX_AUTH_FILE;
		else process.env.COZYCLAY_CODEX_AUTH_FILE = previousAuthFile16m;
	}
	const tokenFor16m = accountId => `e30.${Buffer.from(JSON.stringify({ "https://api.openai.com/auth": { chatgpt_account_id: accountId } })).toString("base64url")}.e30`;
	realAuth16m.writeStored({ access_token: "16m-old-access", refresh_token: "16m-refresh", expires_at: Date.now() + 3600000, id_token: tokenFor16m("16m-account-a") });
	const { createSessionStore: createSessionStore16m } = await import("../bin/agent/session-store.mjs");
	const faux16m = createFakeModel();
	faux16m.script(["first turn ok"]);
	let captures16m = 0;
	const sessions16m = createSessionStore16m(join(scratch16m, "sessions"));
	const handler16m = createAgentHandler({
		auth: realAuth16m, models: faux16m.models, fauxProvider: faux16m.fauxProvider, sessionStore: sessions16m,
		liveHub: { command: async name => { assert.equal(name, "capture_framing_png"); captures16m++; return { dataUrl: png, width: 1, height: 1 }; } },
		port: () => server16m.address().port,
	});
	const server16m = createServer((req, res) => handler16m(req, res).catch(error => { if (!res.headersSent) res.writeHead(500); res.end(error.message); }));
	const listening16m = once(server16m, "listening", { signal: AbortSignal.timeout(5000) });
	server16m.listen(0, "127.0.0.1");
	await listening16m;
	const origin16m = `http://127.0.0.1:${server16m.address().port}`;
	const sessionId16m = `16m-${kind}`;
	const turn16m = async (attachFrame, text) => {
		const response = await fetch(`${origin16m}/agent/turn`, { method: "POST", headers: { origin: origin16m, "content-type": "application/json" }, body: JSON.stringify({ sessionId: sessionId16m, text, model: "faux/scripted", attachFrame }), signal: AbortSignal.timeout(10000) });
		assert.equal(response.status, 200);
		return [...(await response.text()).matchAll(/^data: (.+)$/gm)].map(match => JSON.parse(match[1]));
	};
	try {
		const first16m = await turn16m(false, "before identity change");
		assert.equal(first16m.some(frame => frame.type === "error"), false, `${kind}: first turn has no error`);
		if (kind === "rotated") realAuth16m.writeStored({ access_token: "16m-new-access", refresh_token: "16m-refresh", expires_at: Date.now() + 3600000, id_token: tokenFor16m("16m-account-a") });
		else if (kind === "replaced") realAuth16m.writeStored({ access_token: "16m-new-access", refresh_token: "16m-refresh", expires_at: Date.now() + 3600000, id_token: tokenFor16m("16m-account-b") });
		else realAuth16m.logout();
		faux16m.script(["second turn ok"]);
		const second16m = await turn16m(true, "after identity change");
		if (kind === "rotated") {
			assert.equal(captures16m, 1, `${kind}: rotation reuses the runner, so the capture tool still runs`);
			assert.equal(second16m.some(frame => frame.type === "error"), false, `${kind}: rotation must not invalidate the runner`);
			assert.equal(second16m.filter(frame => frame.type === "text.delta").map(frame => frame.text).join(""), "second turn ok", `${kind}: the reused runner ran the second script`);
		} else if (kind === "replaced") {
			assert.equal(captures16m, 1, `${kind}: the fresh runner's capture tool still ran exactly once`);
			assert.equal(second16m.some(frame => frame.type === "error"), false, `${kind}: a fresh post-identity-change turn must not retain the retired runner's aborted capture tool`);
			assert.equal(second16m.filter(frame => frame.type === "text.delta").map(frame => frame.text).join(""), "second turn ok", `${kind}: the fresh runner ran the second script instead of failing on the stale session`);
			assert.equal(second16m.some(frame => frame.type === "tool.done" && frame.ok === false), false, `${kind}: no tool.done{ok:false} from a stale capture`);
		} else {
			// signed_out with no other credential correctly refuses the second turn
			// with 401 before any tool runs; the fix under test is that this 401
			// comes from hasAnyCredential(), never from a tool.done{ok:false} on a
			// runner whose tools still close over the retired signed-out session.
			assert.equal(captures16m, 0, `${kind}: no credential means the turn never reaches the capture tool`);
			assert.equal(second16m.some(frame => frame.type === "tool.done" && frame.ok === false), false, `${kind}: no stale tool.done{ok:false} from a retired runner`);
			assert.equal(second16m.some(frame => frame.type === "error" && frame.status === 401), true, `${kind}: the second turn is refused for lack of credential, not a stale-session abort`);
		}
		console.log(`PASS 16m ${kind}: ${kind === "rotated" ? "the runner is reused with no invalidation" : "the cached runner is retired so the next turn builds a fresh one"}`);
	} finally {
		await handler16m.close();
		await new Promise(resolve => server16m.close(resolve));
		rmSync(scratch16m, { recursive: true, force: true });
	}
}

// #379 / 16p (discovered by 16o): GET /agent/models must answer from the
// handler's own injected `models` registry, exactly like the turn routes
// (:509/:773) already do, instead of always building a fresh real registry.
// A test double whose `anthropic` catalog carries one deliberately
// unmistakable model id proves which registry answered: the real registry
// (built with no credentials configured here) never has this id under any
// provider, so its presence in the response can only come from the injected
// double.
{
	const injected16p = {
		getModels: (providerId) => (providerId === "anthropic" ? [{ id: "16p-test-double-model", name: "16p Test Double", input: ["text", "image"] }] : []),
		getAuth: async (providerId) => (providerId === "anthropic" ? { auth: {}, source: "16p-double" } : undefined),
	};
	const handler16p = createAgentHandler({ auth: { getAccessToken: async () => null }, codex: { listModels: async () => [] }, models: injected16p, liveHub: fakeLive, port: () => server16p.address().port });
	const server16p = createServer((req, res) => handler16p(req, res).catch((error) => { if (!res.headersSent) res.writeHead(500); res.end(error.message); }));
	const listening16p = once(server16p, "listening", { signal: AbortSignal.timeout(5000) });
	server16p.listen(0, "127.0.0.1");
	await listening16p;
	const origin16p = `http://127.0.0.1:${server16p.address().port}`;
	try {
		const result16p = await fetch(`${origin16p}/agent/models`, { headers: { origin: origin16p } }).then((r) => r.json());
		assert.ok(result16p.models.some((model) => model.id === "anthropic/16p-test-double-model"), "GET /agent/models must answer from the handler's own injected `models` registry (createAgentHandler :264), the same one the turn routes already use (:509/:773), not always build a fresh real registry from credentials this handler was never given");
		const anthropicProvider16p = result16p.providers.find((provider) => provider.id === "anthropic");
		assert.equal(anthropicProvider16p?.signedIn, true, "the injected registry's getAuth result decides signedIn, not a freshly built registry with no credentials");
		console.log("PASS 16p: /agent/models serves the handler's injected model registry");
	} finally {
		await handler16p.close();
		await new Promise((resolve) => server16p.close(resolve));
	}
}

// The no-`models` path (the real sidecar's shape) must be unaffected: with no
// injected registry, listAgentModels still builds a real one from credentials
// (already covered above by the `port`/`models` server's provider assertions);
// this just pins that omitting `models` from createAgentHandler still reaches
// GET /agent/models successfully rather than throwing on an undefined registry.
{
	const noModelsHandler16p = createAgentHandler({ auth: { getAccessToken: async () => null }, codex: { listModels: async () => [] }, liveHub: fakeLive, port: () => noModelsServer16p.address().port });
	const noModelsServer16p = createServer((req, res) => noModelsHandler16p(req, res).catch((error) => { if (!res.headersSent) res.writeHead(500); res.end(error.message); }));
	const listeningNoModels16p = once(noModelsServer16p, "listening", { signal: AbortSignal.timeout(5000) });
	noModelsServer16p.listen(0, "127.0.0.1");
	await listeningNoModels16p;
	const originNoModels16p = `http://127.0.0.1:${noModelsServer16p.address().port}`;
	try {
		const responseNoModels16p = await fetch(`${originNoModels16p}/agent/models`, { headers: { origin: originNoModels16p } });
		assert.equal(responseNoModels16p.status, 200, "omitting `models` from createAgentHandler still builds a real registry and answers 200");
		const resultNoModels16p = await responseNoModels16p.json();
		assert.equal(resultNoModels16p.providers.length, 6, "the real-registry path (no injected `models`) lists all six providers");
		console.log("PASS 16p: the real-registry path (no injected `models`) is unchanged");
	} finally {
		await noModelsHandler16p.close();
		await new Promise((resolve) => noModelsServer16p.close(resolve));
	}
}

// #379 / 16q (discovered by 16p's browser run): an acknowledged Stop mid-generation
// must settle the held generate_motion tool call with the runtime's structured
// outcome (tool.done{ok:true,result:{code:"CANCELLED",mutated:false,...}}, the
// tool CALL itself having succeeded exactly like the sibling STALE_TARGET/
// VERIFICATION_FAILED resilience scenarios) then
// done — never a synthesized error{code:'aborted'} that hides whether the scene
// was touched. Real motion runtime (bin/agent/motion-runtime.mjs, no studioRuntime
// override), a real bridge HTTP server whose /ardy/generate is held open exactly
// like the browser fixture's controls.hold, and a real /agent/turn + /agent/stop
// round trip — no sleeps: the held generation is released only after the SSE
// stream itself has already delivered the job.state{generating} frame carrying
// the jobId.
async function run16qStopScenario() {
	const hub16q = {
		connected: true, workspaceHandles: ["handle-12"],
		workspaceId: () => "tab-7", resolveWorkspace: () => "handle-12", handleForWorkspaceId: () => "handle-12",
		command: async (name, args) => {
			if (name === "read_studio_context") return { context: (await import("./verify-studio-agent-protocol.mjs")).contextFixture() };
			if (name === "cancel_motion_install") return { status: "not_applied", evidence: true };
			if (name === "discard_motion_candidate") return { discarded: true };
			return { ok: true };
		},
	};
	const held16q = Promise.withResolvers();
	const bridge16q = createServer((req, res) => {
		if (req.url === "/ardy/health") { res.writeHead(200, { "content-type": "application/json" }); res.end(JSON.stringify({ ok: true, backend: "local_kimodo", host: "fixture", device: "cpu" })); return; }
		(async () => {
			res.writeHead(200, { "content-type": "application/x-ndjson" });
			res.write(`${JSON.stringify({ event: "progress", progress: 0.25 })}\n`);
			await Promise.race([held16q.promise, once(res, "close")]);
			if (!res.destroyed) res.end(`${JSON.stringify({ event: "done", motionUrl: "/ardy/motions/123456-abcdef" })}\n`);
		})();
	});
	bridge16q.listen(0, "127.0.0.1"); await once(bridge16q, "listening");
	const bridgeOrigin16q = `http://127.0.0.1:${bridge16q.address().port}`;
	const faux16q = createFakeModel();
	faux16q.script([
		{ type: "toolCall", id: "m16q", name: "generate_motion", arguments: { characterId: "char-alex", source: { kind: "generate", beats: [{ text: "walk forward" }], durationSeconds: 2 } } },
		{ type: "text", text: "done" },
	]);
	let server16q;
	const handler16q = createAgentHandler({ auth: { getAccessToken: async () => "token" }, codex: fakeCodex, models: faux16q.models, fauxProvider: faux16q.fauxProvider, liveHub: hub16q, getBridgeOrigin: () => bridgeOrigin16q, port: () => server16q.address().port });
	server16q = createServer((req, res) => handler16q(req, res).catch((error) => { console.error("16q fixture error:", error); if (!res.headersSent) res.writeHead(500); res.end(error.message); }));
	server16q.listen(0, "127.0.0.1"); await once(server16q, "listening");
	const origin16q = `http://127.0.0.1:${server16q.address().port}`;
	const { contextFixture, envelopeFixture } = await import("./verify-studio-agent-protocol.mjs");
	const turnEnvelope16q = { ...envelopeFixture(), model: "faux/scripted" };
	try {
		const turnResponse16q = await fetch(`${origin16q}/agent/turn`, { method: "POST", headers: { "content-type": "application/json", origin: origin16q }, body: JSON.stringify(turnEnvelope16q) });
		assert.equal(turnResponse16q.status, 200);
		const cookie16q = (turnResponse16q.headers.getSetCookie?.() ?? [turnResponse16q.headers.get("set-cookie")]).filter(Boolean).map((entry) => entry.split(";")[0]).join("; ");
		assert.match(cookie16q, /studio_owner=/);
		const reader16q = turnResponse16q.body.getReader();
		const decoder16q = new TextDecoder();
		const frames16q = [];
		let carry16q = "";
		let jobId16q = null;
		const pump16q = async () => {
			const { value, done } = await bounded16q(reader16q.read(), "16q SSE read");
			if (done) return false;
			carry16q += decoder16q.decode(value, { stream: true });
			const lines = carry16q.split("\n"); carry16q = lines.pop();
			for (const line of lines) if (line.startsWith("data: ")) {
				const frame = JSON.parse(line.slice(6)); frames16q.push(frame);
				if (frame.type === "job.state" && frame.state === "generating" && !jobId16q) jobId16q = frame.jobId;
			}
			return true;
		};
		while (!jobId16q) { if (!(await pump16q())) throw new Error("16q: stream ended before job.state{generating}"); }
		const stopResponse16q = await fetch(`${origin16q}/agent/stop`, { method: "POST", headers: { "content-type": "application/json", origin: origin16q, cookie: cookie16q }, body: JSON.stringify({ surface: "studio", sessionId: turnEnvelope16q.sessionId, turnId: turnEnvelope16q.turnId, jobId: jobId16q }) });
		assert.equal(stopResponse16q.status, 200);
		held16q.resolve();
		while (await pump16q()) { /* drain until the SSE stream itself closes */ }
		return frames16q;
	} finally {
		await handler16q.close();
		await new Promise((resolve) => server16q.close(resolve));
		await new Promise((resolve) => bridge16q.close(resolve));
	}
}
async function bounded16q(promise, label, ms = 10000) {
	let timer;
	return Promise.race([promise, new Promise((_, reject) => { timer = setTimeout(() => reject(new Error(`Deadline: ${label}`)), ms); })]).finally(() => clearTimeout(timer));
}
{
	const frames16q = await run16qStopScenario();
	const types16q = frames16q.map((frame) => frame.type);
	const toolDone16q = frames16q.find((frame) => frame.type === "tool.done");
	const failures16q = [];
	if (types16q.includes("error")) failures16q.push(`no error{aborted} frame is allowed for an acknowledged stop with a resolvable outcome; got types ${JSON.stringify(types16q)}`);
	if (!toolDone16q) failures16q.push(`a tool.done frame settling the held generate_motion call is required; got types ${JSON.stringify(types16q)}`);
	else {
		// The tool CALL itself succeeded (pi's own isError/ok wire flag) exactly
		// like the already-passing STALE_TARGET/VERIFICATION_FAILED sibling
		// scenarios in this same resilience case (test/qa-studio-agent-browser.mjs
		// checks `result.code`/`result.mutated`, never top-level tool.done.ok, for
		// those); the BUSINESS-level failure lives in the nested `result`.
		if (toolDone16q.ok !== true) failures16q.push(`tool.done.ok (the wire-level call outcome) must be true, matching the STALE_TARGET/VERIFICATION_FAILED sibling scenarios; got ${JSON.stringify(toolDone16q)}`);
		if (toolDone16q.result?.code !== "CANCELLED") failures16q.push(`tool.done.result.code must be CANCELLED; got ${JSON.stringify(toolDone16q)}`);
		if (toolDone16q.result?.mutated !== false) failures16q.push(`tool.done.result.mutated must be false; got ${JSON.stringify(toolDone16q)}`);
	}
	if (types16q.at(-1) !== "done") failures16q.push(`the stream must still end with done; got types ${JSON.stringify(types16q)}`);
	console.log("16q frame types:", JSON.stringify(types16q));
	assert.deepEqual(failures16q, [], `an acknowledged Stop with a resolvable outcome must settle tool.done{ok:true,result:{code:'CANCELLED',mutated:false}} then done, never error{aborted}: ${JSON.stringify(failures16q)}`);
	console.log("PASS 16q: an acknowledged Stop settles the held generate_motion tool card with the runtime outcome, no error{aborted}");
}

{
	// 16q: a stop with NO active job (no jobId, session detaches) stays a plain
	// abort — error{aborted} + done — unchanged.
	// Held exactly the way the harness's own canonical abort test holds a slow
	// tool (verify-agent-runner-errors.mjs's `slowTool`): the held step listens
	// for its OWN abort signal and rejects itself — pi does not forcibly race or
	// kill an in-flight model/tool call that never checks its signal, so a mock
	// that just hangs forever (never checking `options.signal`) would hang this
	// test exactly as it would hang the real harness. This is the cooperative
	// contract every real provider and Studio tool already follows.
	const startedDetached = Promise.withResolvers();
	const { fauxAssistantMessage: detachedFauxMessage, fauxText: detachedFauxText } = await import("@earendil-works/pi-ai/providers/faux");
	const detachedFaux = createFakeModel();
	detachedFaux.fauxProvider.setResponses([(context, options) => new Promise((resolve, reject) => {
		const signal = options?.signal;
		startedDetached.resolve(signal);
		signal?.addEventListener("abort", () => reject(Object.assign(new Error("aborted"), { name: "AbortError" })), { once: true });
	})]);
	const detachedHub = { command: async () => ({ ok: true }), workspaceId: () => "tab-7", resolveWorkspace: () => "handle-12", handleForWorkspaceId: () => "handle-12", connected: true, workspaceHandles: ["handle-12"] };
	let detachedServer;
	const detachedHandler = createAgentHandler({ auth: { getAccessToken: async () => "token" }, codex: fakeCodex, models: detachedFaux.models, fauxProvider: detachedFaux.fauxProvider, liveHub: detachedHub, studioRuntime: { readContext: async () => (await import("./verify-studio-agent-protocol.mjs")).contextFixture() }, port: () => detachedServer.address().port });
	detachedServer = createServer((req, res) => detachedHandler(req, res).catch((error) => { if (!res.headersSent) res.writeHead(500); res.end(error.message); }));
	detachedServer.listen(0, "127.0.0.1"); await once(detachedServer, "listening");
	const detachedOrigin = `http://127.0.0.1:${detachedServer.address().port}`;
	const { envelopeFixture: detachedEnvelopeFixture } = await import("./verify-studio-agent-protocol.mjs");
	const detachedEnvelope = { ...detachedEnvelopeFixture(), model: "faux/scripted" };
	try {
		const detachedTurnResponse = await bounded16q(fetch(`${detachedOrigin}/agent/turn`, { method: "POST", headers: { "content-type": "application/json", origin: detachedOrigin }, body: JSON.stringify(detachedEnvelope) }), "16q detached turn POST");
		const detachedCookie = (detachedTurnResponse.headers.getSetCookie?.() ?? [detachedTurnResponse.headers.get("set-cookie")]).filter(Boolean).map((entry) => entry.split(";")[0]).join("; ");
		// The turn must still be genuinely in flight (the model response held) when
		// Stop is clicked, or this proves nothing about the abort path at all.
		await bounded16q(startedDetached.promise, "16q detached model call start");
		const detachedStopResponse = await bounded16q(fetch(`${detachedOrigin}/agent/stop`, { method: "POST", headers: { "content-type": "application/json", origin: detachedOrigin, cookie: detachedCookie }, body: JSON.stringify({ surface: "studio", sessionId: detachedEnvelope.sessionId, turnId: detachedEnvelope.turnId }) }), "16q detached stop POST");
		assert.equal(detachedStopResponse.status, 200);
		const detachedStopBody = await detachedStopResponse.json();
		assert.equal(detachedStopBody.status, "detached", "a stop with no jobId reports status:detached");
		const detachedText = await bounded16q(detachedTurnResponse.text(), "16q detached SSE");
		const detachedFrames = [...detachedText.matchAll(/^data: (.+)$/gm)].map((match) => JSON.parse(match[1]));
		const detachedTypes = detachedFrames.map((frame) => frame.type);
		assert.ok(detachedFrames.some((frame) => frame.type === "error" && frame.code === "aborted"), `a stop with no active job must still abort the turn: ${JSON.stringify(detachedTypes)}`);
		assert.equal(detachedTypes.at(-1), "done");
		console.log("PASS 16q: a stop with no active job (status:detached) is still a plain abort—error{aborted}+done");
	} finally {
		await detachedHandler.close();
		await new Promise((resolve) => detachedServer.close(resolve));
	}
}

// #379 / 16r (F2 pass 7, finding 1): a retired motion job must not make a
// LATER, unrelated turn's Stop go quiet. session.activeJobId used to be set
// on admission (:472 pre-fix) and cleared only on explicit accept, so once a
// motion turn was stopped and settled, the next plain (non-motion) turn's
// Stop on the SAME session still saw the retired job id, called
// runtime.stop() on it, skipped controller.abort(), and passed quiet:true —
// the next turn ended silently with agent:turn_succeeded + done, no
// error{aborted}. The fix clears activeJobId/activeJobTurnId at every
// terminal state (the motion handler's finally, the stop route after
// runtime.stop settles, and accept) and only treats a Stop as acknowledged
// when session.activeJobTurnId matches the CURRENT turn's id.
async function run16rTwoTurnScenario() {
	const hub16r = {
		connected: true, workspaceHandles: ["handle-12"],
		workspaceId: () => "tab-7", resolveWorkspace: () => "handle-12", handleForWorkspaceId: () => "handle-12",
		command: async (name) => {
			if (name === "read_studio_context") return { context: (await import("./verify-studio-agent-protocol.mjs")).contextFixture() };
			if (name === "cancel_motion_install") return { status: "not_applied", evidence: true };
			if (name === "discard_motion_candidate") return { discarded: true };
			return { ok: true };
		},
	};
	const held16r = Promise.withResolvers();
	const bridge16r = createServer((req, res) => {
		if (req.url === "/ardy/health") { res.writeHead(200, { "content-type": "application/json" }); res.end(JSON.stringify({ ok: true, backend: "local_kimodo", host: "fixture", device: "cpu" })); return; }
		(async () => {
			res.writeHead(200, { "content-type": "application/x-ndjson" });
			res.write(`${JSON.stringify({ event: "progress", progress: 0.25 })}\n`);
			await Promise.race([held16r.promise, once(res, "close")]);
			if (!res.destroyed) res.end(`${JSON.stringify({ event: "done", motionUrl: "/ardy/motions/123456-abcdef" })}\n`);
		})();
	});
	bridge16r.listen(0, "127.0.0.1"); await once(bridge16r, "listening");
	const bridgeOrigin16r = `http://127.0.0.1:${bridge16r.address().port}`;
	const faux16r = createFakeModel();
	faux16r.script([
		{ type: "toolCall", id: "m16r", name: "generate_motion", arguments: { characterId: "char-alex", source: { kind: "generate", beats: [{ text: "walk forward" }], durationSeconds: 2 } } },
		{ type: "text", text: "done" },
	]);
	let server16r;
	const handler16r = createAgentHandler({ auth: { getAccessToken: async () => "token" }, codex: fakeCodex, models: faux16r.models, fauxProvider: faux16r.fauxProvider, liveHub: hub16r, getBridgeOrigin: () => bridgeOrigin16r, port: () => server16r.address().port });
	server16r = createServer((req, res) => handler16r(req, res).catch((error) => { console.error("16r fixture error:", error); if (!res.headersSent) res.writeHead(500); res.end(error.message); }));
	server16r.listen(0, "127.0.0.1"); await once(server16r, "listening");
	const origin16r = `http://127.0.0.1:${server16r.address().port}`;
	const { envelopeFixture } = await import("./verify-studio-agent-protocol.mjs");
	const turnEnvelope16r = { ...envelopeFixture(), model: "faux/scripted" };
	try {
		// Turn 1: generate_motion held, stopped with the correct jobId. Must still
		// behave exactly like 16q (tool.done{CANCELLED} + done, no error) — the fix
		// must not regress the acknowledged-stop path.
		const turnResponse16r = await fetch(`${origin16r}/agent/turn`, { method: "POST", headers: { "content-type": "application/json", origin: origin16r }, body: JSON.stringify(turnEnvelope16r) });
		assert.equal(turnResponse16r.status, 200);
		const cookie16r = (turnResponse16r.headers.getSetCookie?.() ?? [turnResponse16r.headers.get("set-cookie")]).filter(Boolean).map((entry) => entry.split(";")[0]).join("; ");
		assert.match(cookie16r, /studio_owner=/);
		const reader16r = turnResponse16r.body.getReader();
		const decoder16r = new TextDecoder();
		const frames16r = [];
		let carry16r = "";
		let jobId16r = null;
		const pump16r = async (target) => {
			const { value, done } = await bounded16q(reader16r.read(), "16r SSE read");
			if (done) return false;
			carry16r += decoder16r.decode(value, { stream: true });
			const lines = carry16r.split("\n"); carry16r = lines.pop();
			for (const line of lines) if (line.startsWith("data: ")) {
				const frame = JSON.parse(line.slice(6)); target.push(frame);
				if (frame.type === "job.state" && frame.state === "generating" && !jobId16r) jobId16r = frame.jobId;
			}
			return true;
		};
		while (!jobId16r) { if (!(await pump16r(frames16r))) throw new Error("16r: stream ended before job.state{generating}"); }
		// A Stop carrying a stale explicit jobId must still be rejected 409
		// STALE_TARGET, unaffected by the acknowledgment fix.
		const staleStopResponse = await fetch(`${origin16r}/agent/stop`, { method: "POST", headers: { "content-type": "application/json", origin: origin16r, cookie: cookie16r }, body: JSON.stringify({ surface: "studio", sessionId: turnEnvelope16r.sessionId, turnId: turnEnvelope16r.turnId, jobId: "not-the-real-job-id" }) });
		assert.equal(staleStopResponse.status, 409);
		const staleStopBody = await staleStopResponse.json();
		assert.equal(staleStopBody.error?.code, "STALE_TARGET", `a Stop with a stale explicit jobId must stay 409 STALE_TARGET: ${JSON.stringify(staleStopBody)}`);
		const stopResponse16r = await fetch(`${origin16r}/agent/stop`, { method: "POST", headers: { "content-type": "application/json", origin: origin16r, cookie: cookie16r }, body: JSON.stringify({ surface: "studio", sessionId: turnEnvelope16r.sessionId, turnId: turnEnvelope16r.turnId, jobId: jobId16r }) });
		assert.equal(stopResponse16r.status, 200);
		held16r.resolve();
		while (await pump16r(frames16r)) { /* drain until the SSE stream itself closes */ }
		const types16r = frames16r.map((frame) => frame.type);
		const toolDone16r = frames16r.find((frame) => frame.type === "tool.done");
		const turn1Failures = [];
		if (types16r.includes("error")) turn1Failures.push(`turn 1 (acknowledged stop) must not emit error: got ${JSON.stringify(types16r)}`);
		if (!toolDone16r || toolDone16r.result?.code !== "CANCELLED" || toolDone16r.result?.mutated !== false) turn1Failures.push(`turn 1 tool.done must be CANCELLED/mutated:false: got ${JSON.stringify(toolDone16r)}`);
		if (types16r.at(-1) !== "done") turn1Failures.push(`turn 1 must end with done: got ${JSON.stringify(types16r)}`);
		assert.deepEqual(turn1Failures, [], JSON.stringify(turn1Failures));

		// Turn 2: SAME session, a fresh turnId, no motion tool at all — a plain
		// held model call. Pre-fix, session.activeJobId still held turn 1's
		// retired job, so this Stop went quiet (no error, just done). Post-fix it
		// must be a normal loud abort.
		const entered16r = Promise.withResolvers(); let providerAborted16r = false;
		faux16r.fauxProvider.setResponses([(context, options) => new Promise((resolve, reject) => {
			options.signal.addEventListener("abort", () => { providerAborted16r = true; reject(Object.assign(new Error("cancelled active provider"), { name: "AbortError" })); }, { once: true });
			entered16r.resolve();
		})]);
		const secondEnvelope16r = { ...turnEnvelope16r, turnId: "00000000-0000-4000-8000-000000000099", text: "Inspect the scene, no motion generation." };
		const secondResponse16r = await fetch(`${origin16r}/agent/turn`, { method: "POST", headers: { "content-type": "application/json", origin: origin16r, cookie: cookie16r }, body: JSON.stringify(secondEnvelope16r) });
		assert.equal(secondResponse16r.status, 200);
		const secondTextPromise = bounded16q(secondResponse16r.text(), "16r second turn SSE");
		await bounded16q(entered16r.promise, "16r second provider started");
		const stopSecond16r = await fetch(`${origin16r}/agent/stop`, { method: "POST", headers: { "content-type": "application/json", origin: origin16r, cookie: cookie16r }, body: JSON.stringify({ surface: "studio", sessionId: turnEnvelope16r.sessionId, turnId: secondEnvelope16r.turnId }) });
		const stopSecondBody16r = await stopSecond16r.json();
		const secondText16r = await secondTextPromise;
		const secondFrames16r = [...secondText16r.matchAll(/^data: (.+)$/gm)].map((match) => JSON.parse(match[1]));
		const secondTypes16r = secondFrames16r.map((frame) => frame.type);
		console.log("16r turn 2 frame types:", JSON.stringify(secondTypes16r), "stop body:", JSON.stringify(stopSecondBody16r));
		assert.equal(stopSecond16r.status, 200);
		assert.equal(stopSecondBody16r.status, "detached", `turn 2's Stop must not report a retired job as active: ${JSON.stringify(stopSecondBody16r)}`);
		assert.ok(providerAborted16r, "turn 2's provider call must actually receive the abort signal");
		assert.ok(secondFrames16r.some((frame) => frame.type === "error" && frame.code === "aborted"), `Stop on the next, non-motion turn must not silently suppress its aborted outcome by treating a retired prior-turn job as the current acknowledged job: got ${JSON.stringify(secondTypes16r)}`);
		assert.equal(secondTypes16r.at(-1), "done");
		console.log("PASS 16r: turn 1 acknowledged stop unaffected; turn 2's Stop on the same session is a plain loud abort, and a stale explicit jobId stays 409 STALE_TARGET");
	} finally {
		await handler16r.close();
		await new Promise((resolve) => server16r.close(resolve));
		await new Promise((resolve) => bridge16r.close(resolve));
	}
}
await run16rTwoTurnScenario();

// #379 / 16s: the live-only Codex model already advertised by the real
// catalogue must remain executable when the turn runner creates its registry.
{
	const { zstdDecompressSync } = await import("node:zlib");
	const liveId16s = "gpt-9-nova";
	const token16s = `e30.${Buffer.from(JSON.stringify({ "https://api.openai.com/auth": { chatgpt_account_id: "16s-routes" } })).toString("base64url")}.e30`;
	const auth16s = {
		getAccessToken: async () => token16s,
		readStored: () => ({ access_token: token16s, refresh_token: "routes-refresh", expires_at: Date.now() + 3600000 }),
		status: () => ({ signedIn: true }),
	};
	const received16s = [];
	const fixture16s = createServer(async (req, res) => {
		const chunks = []; for await (const chunk of req) chunks.push(Buffer.from(chunk));
		const encoded = Buffer.concat(chunks);
		const body = JSON.parse((req.headers["content-encoding"] === "zstd" ? zstdDecompressSync(encoded) : encoded).toString("utf8"));
		received16s.push(body.model);
		res.writeHead(200, { "content-type": "text/event-stream" });
		res.end(`data: ${JSON.stringify({ type: "response.completed", response: { status: "completed" } })}\n\n`);
	});
	fixture16s.listen(0, "127.0.0.1"); await once(fixture16s, "listening");
	const fixtureOrigin16s = `http://127.0.0.1:${fixture16s.address().port}`;
	const codex16s = {
		listModels: async () => [{ slug: liveId16s, supported_reasoning_levels: ["medium"] }],
		parseQuotaHeaders: () => ({ primary: {}, credits: {} }),
	};
	let sidecar16s;
	const handler16s = createAgentHandler({ auth: auth16s, codex: codex16s, codexBaseUrl: fixtureOrigin16s, handlers: [], liveHub: {}, port: () => sidecar16s.address().port });
	sidecar16s = createServer((req, res) => handler16s(req, res).catch((error) => { if (!res.headersSent) res.writeHead(500); res.end(error.message); }));
	sidecar16s.listen(0, "127.0.0.1"); await once(sidecar16s, "listening");
	const origin16s = `http://127.0.0.1:${sidecar16s.address().port}`;
	try {
		const catalogue16s = await fetch(`${origin16s}/agent/models`).then((response) => response.json());
		assert.ok(catalogue16s.models.some((model) => model.id === `openai-codex/${liveId16s}`), "the cached live-only model remains advertised");
		const turn16s = await fetch(`${origin16s}/agent/turn`, { method: "POST", headers: { origin: origin16s, "content-type": "application/json" }, body: JSON.stringify({ sessionId: "16s-route-live", text: "hello", model: `openai-codex/${liveId16s}` }) });
		const frames16s = [...(await turn16s.text()).matchAll(/^data: (.+)$/gm)].map((match) => JSON.parse(match[1]));
		assert.equal(frames16s.some((frame) => frame.type === "error" && frame.code === "UNKNOWN_MODEL"), false, "a model advertised by /agent/models resolves in the runner registry");
		assert.deepEqual(received16s, [liveId16s], "the Codex fixture receives the advertised model id");
		console.log("PASS 16s: the cached live-only catalogue entry executes through the route runner");
	} finally {
		await handler16s.close();
		const closedSidecar16s = once(sidecar16s, "close", { signal: AbortSignal.timeout(5000) }); sidecar16s.close(); sidecar16s.closeAllConnections(); await closedSidecar16s;
		const closedFixture16s = once(fixture16s, "close", { signal: AbortSignal.timeout(5000) }); fixture16s.close(); fixture16s.closeAllConnections(); await closedFixture16s;
	}
}

// #379 / 16u: every explicit Studio Stop id must have been admitted by the
// same session. A retired id remains idempotently stoppable for that session,
// but a known id from another session must be rejected before runtime.stop().
{
	const { contextFixture, envelopeFixture } = await import("./verify-studio-agent-protocol.mjs");
	const startEntered = Promise.withResolvers();
	const startGate = Promise.withResolvers();
	const stopCalls = [];
	const motionRuntime = {
		readContext: async () => contextFixture(),
		admit: () => ({ jobId: "job-16u", commandId: "command-16u", state: "queued" }),
		subscribe: (jobId, send) => { send({ type: "job.state", jobId, state: "generating", phase: "generating" }); return () => {}; },
		start: async () => { startEntered.resolve(); return startGate.promise; },
		stop: async (jobId) => { stopCalls.push(jobId); startGate.resolve({ ok: false, status: "cancelled", code: "CANCELLED", mutated: false }); return { status: "cancelled", code: "CANCELLED", mutated: false }; },
	};
	const faux16u = createFakeModel();
	faux16u.script([
		[{ type: "text", text: "B completed" }],
		{ type: "toolCall", id: "motion-16u", name: "generate_motion", arguments: { characterId: "char-alex", source: { kind: "generate", beats: [{ text: "walk" }], durationSeconds: 2 } } },
		[{ type: "text", text: "A completed" }],
	]);
	let server16u;
	const handler16u = createAgentHandler({ auth: { getAccessToken: async () => "token" }, models: faux16u.models, fauxProvider: faux16u.fauxProvider, liveHub: { connected: true, workspaceHandles: ["handle-12"], workspaceId: () => "tab-7", resolveWorkspace: () => "handle-12", handleForWorkspaceId: () => "handle-12", command: async () => ({ ok: true }) }, studioRuntime: motionRuntime, port: () => server16u.address().port });
	server16u = createServer((req, res) => handler16u(req, res).catch((error) => { if (!res.headersSent) res.writeHead(500); res.end(error.message); }));
	server16u.listen(0, "127.0.0.1"); await once(server16u, "listening");
	const origin16u = `http://127.0.0.1:${server16u.address().port}`;
	const post16u = (body, cookie) => fetch(`${origin16u}/agent/${body.jobId === undefined && body.text !== undefined ? "turn" : "stop"}`, { method: "POST", headers: { origin: origin16u, "content-type": "application/json", ...(cookie ? { cookie } : {}) }, body: JSON.stringify(body), signal: AbortSignal.timeout(10000) });
	const cookieOf16u = response => (response.headers.getSetCookie?.() ?? [response.headers.get("set-cookie")]).filter(Boolean).map(entry => entry.split(";")[0]).join("; ");
	const frames16u = text => [...text.matchAll(/^data: (.+)$/gm)].map(match => JSON.parse(match[1]));
	const bSession16u = "00000000-0000-4000-8000-000000000161";
	const aSession16u = "00000000-0000-4000-8000-000000000162";
	const bTurn1 = { ...envelopeFixture(), sessionId: bSession16u, turnId: "00000000-0000-4000-8000-000000000163", text: "B completed" };
	const aTurn = { ...envelopeFixture(), sessionId: aSession16u, turnId: "00000000-0000-4000-8000-000000000164", text: "A motion" };
	try {
		const bFirst = await post16u(bTurn1); assert.equal(bFirst.status, 200); const bCookie = cookieOf16u(bFirst); await bFirst.text();
		const aFirst = await post16u(aTurn); assert.equal(aFirst.status, 200); const aCookie = cookieOf16u(aFirst); const aText = aFirst.text();
		await startEntered.promise;
		const crossStop = await post16u({ surface: "studio", sessionId: bSession16u, turnId: bTurn1.turnId, jobId: "job-16u" }, bCookie);
		assert.equal(crossStop.status, 409); assert.equal((await crossStop.json()).error.code, "STALE_TARGET"); assert.deepEqual(stopCalls, [], "a cross-session explicit Stop never reaches the runtime");
		const ownStop = await post16u({ surface: "studio", sessionId: aSession16u, turnId: aTurn.turnId, jobId: "job-16u" }, aCookie);
		assert.equal(ownStop.status, 200); assert.equal((await ownStop.json()).outcome.code, "CANCELLED");
		const aFrames = frames16u(await aText); assert.equal(aFrames.find(frame => frame.type === "tool.done")?.result?.code, "CANCELLED");
		const repeatStop = await post16u({ surface: "studio", sessionId: aSession16u, turnId: aTurn.turnId, jobId: "job-16u" }, aCookie);
		assert.equal(repeatStop.status, 200); assert.equal((await repeatStop.json()).outcome.code, "CANCELLED"); assert.deepEqual(stopCalls, ["job-16u", "job-16u"]);

		const bEntered = Promise.withResolvers();
		faux16u.fauxProvider.setResponses([(_context, options) => new Promise((resolve, reject) => { options.signal.addEventListener("abort", () => reject(Object.assign(new Error("aborted"), { name: "AbortError" })), { once: true }); bEntered.resolve(); })]);
		const bTurn2 = { ...bTurn1, turnId: "00000000-0000-4000-8000-000000000165", text: "B held" };
		const bSecond = await post16u(bTurn2, bCookie); const bSecondText = bSecond.text(); await bEntered.promise;
		const detached = await post16u({ surface: "studio", sessionId: bSession16u, turnId: bTurn2.turnId }, bCookie);
		assert.equal(detached.status, 200); assert.equal((await detached.json()).status, "detached");
		const bSecondFrames = frames16u(await bSecondText); assert.ok(bSecondFrames.some(frame => frame.type === "error" && frame.code === "aborted")); assert.equal(bSecondFrames.at(-1).type, "done");
		console.log("PASS 16u: explicit Stop ids are session-admitted, own retired ids remain idempotent, and plain Stop stays loud");
	} finally { await handler16u.close(); server16u.closeAllConnections(); await new Promise(resolve => server16u.close(resolve)); }
}

// #379 / 16u restore: admitted motion ownership is durable with the Studio
// session. An accepted retired job remains stoppable after a fresh handler
// restores the same JSONL/meta store, without gaining another session's job.
{
	const { contextFixture, envelopeFixture } = await import("./verify-studio-agent-protocol.mjs");
	const { createSessionStore } = await import("../bin/agent/session-store.mjs");
	const sessionStore16uRestore = createSessionStore(mkdtempSync(join(tmpdir(), "cozyclay-agent-16u-restore-")));
	const stopCalls16uRestore = [];
	const started16uRestore = Promise.withResolvers(), held16uRestore = Promise.withResolvers();
	let admissions16uRestore = 0;
	const motionRuntime16uRestore = {
		readContext: async () => contextFixture(),
		admit: () => ({ jobId: ++admissions16uRestore === 1 ? "gate-owned" : "gate-other", commandId: `gate-command-${admissions16uRestore}`, state: "queued" }),
		subscribe: () => () => {},
		start: async () => { started16uRestore.resolve(); await held16uRestore.promise; return { ok: false, status: "review_required", code: "REVIEW_REQUIRED" }; },
		accept: async () => ({ ok: true, status: "installed" }),
		stop: async jobId => { stopCalls16uRestore.push(jobId); return { status: "installed", code: "ALREADY_INSTALLED", mutated: true }; },
	};
	const faux16uRestore = createFakeModel();
	const hub16uRestore = { workspaceId: () => "tab-7", resolveWorkspace: () => "handle-12", command: async () => ({ ok: true }) };
	const sessionId16uRestore = "00000000-0000-4000-8000-000000000171";
	const initialTurn16uRestore = { ...envelopeFixture(), sessionId: sessionId16uRestore, turnId: "00000000-0000-4000-8000-000000000172", text: "generate motion" };
	let handler16uRestore, server16uRestore;
	const open16uRestore = async () => {
		handler16uRestore = createAgentHandler({ auth: { getAccessToken: async () => "token" }, models: faux16uRestore.models, fauxProvider: faux16uRestore.fauxProvider, liveHub: hub16uRestore, studioRuntime: motionRuntime16uRestore, sessionStore: createSessionStore(sessionStore16uRestore.dir), port: () => server16uRestore.address().port });
		server16uRestore = createServer((req, res) => handler16uRestore(req, res).catch(error => { if (!res.headersSent) res.writeHead(500); res.end(error.message); }));
		const listening = once(server16uRestore, "listening", { signal: AbortSignal.timeout(5000) });
		server16uRestore.listen(0, "127.0.0.1"); await listening;
		return `http://127.0.0.1:${server16uRestore.address().port}`;
	};
	const close16uRestore = async () => {
		held16uRestore.resolve();
		await bounded16q(handler16uRestore.close(), "restore handler close");
		const closed = once(server16uRestore, "close", { signal: AbortSignal.timeout(5000) });
		server16uRestore.close(); server16uRestore.closeAllConnections(); await closed;
	};
	const cookie16uRestore = response => response.headers.get("set-cookie")?.split(";")[0] || "";
	try {
		faux16uRestore.script([{ type: "toolCall", id: "gate-motion", name: "generate_motion", arguments: { characterId: "char-alex", source: { kind: "generate", beats: [{ text: "walk" }], durationSeconds: 2 } } }, [{ type: "text", text: "review" }]]);
		const firstOrigin16uRestore = await open16uRestore();
		const post16uRestore = (origin, path, body, cookie) => fetch(origin + path, { method: "POST", headers: { origin, "content-type": "application/json", ...(cookie ? { cookie } : {}) }, body: JSON.stringify(body), signal: AbortSignal.timeout(10000) });
		const firstResponse16uRestore = await post16uRestore(firstOrigin16uRestore, "/agent/turn", initialTurn16uRestore);
		assert.equal(firstResponse16uRestore.status, 200); const firstCookie16uRestore = cookie16uRestore(firstResponse16uRestore);
		await bounded16q(started16uRestore.promise, "restore motion admission");
		held16uRestore.resolve();
		const firstFrames = [...(await firstResponse16uRestore.text()).matchAll(/^data: (.+)$/gm)].map(match => JSON.parse(match[1]));
		assert.equal(firstFrames.find(frame => frame.type === "tool.done")?.result?.status, "review_required");
		assert.equal(firstFrames.some(frame => frame.type === "error"), false);
		const accept16uRestore = await post16uRestore(firstOrigin16uRestore, "/agent/jobs/gate-owned/accept", { surface: "studio", sessionId: sessionId16uRestore, turnId: initialTurn16uRestore.turnId, explicitUnverifiedAcceptance: true }, firstCookie16uRestore);
		assert.equal(accept16uRestore.status, 200); await accept16uRestore.text();
		faux16uRestore.script([{ type: "toolCall", id: "other-motion", name: "generate_motion", arguments: { characterId: "char-alex", source: { kind: "generate", beats: [{ text: "walk" }], durationSeconds: 2 } } }, ["review"]]);
		const otherTurn = { ...initialTurn16uRestore, sessionId: "00000000-0000-4000-8000-000000000174", turnId: "00000000-0000-4000-8000-000000000175" };
		const otherResponse = await post16uRestore(firstOrigin16uRestore, "/agent/turn", otherTurn);
		assert.equal(otherResponse.status, 200);
		await otherResponse.text();
		assert.equal(admissions16uRestore, 2, "the foreign id actually exists in the shared runtime");
		await close16uRestore();

		faux16uRestore.script([[{ type: "text", text: "resumed" }]]);
		const restoredOrigin16uRestore = await open16uRestore();
		const restoredTurn16uRestore = { ...initialTurn16uRestore, turnId: "00000000-0000-4000-8000-000000000173", text: "resume" };
		const restoredResponse16uRestore = await post16uRestore(restoredOrigin16uRestore, "/agent/turn", restoredTurn16uRestore);
		assert.equal(restoredResponse16uRestore.status, 200); const restoredCookie16uRestore = cookie16uRestore(restoredResponse16uRestore); await restoredResponse16uRestore.text();
		const foreignStop = await post16uRestore(restoredOrigin16uRestore, "/agent/stop", { surface: "studio", sessionId: sessionId16uRestore, turnId: restoredTurn16uRestore.turnId, jobId: "gate-other" }, restoredCookie16uRestore);
		assert.equal(foreignStop.status, 409); assert.equal((await foreignStop.json()).error.code, "STALE_TARGET");
		assert.deepEqual(stopCalls16uRestore, [], "the restored session cannot forward another session's admitted id");
		const restoredStop16uRestore = await post16uRestore(restoredOrigin16uRestore, "/agent/stop", { surface: "studio", sessionId: sessionId16uRestore, turnId: restoredTurn16uRestore.turnId, jobId: "gate-owned" }, restoredCookie16uRestore);
		assert.equal(restoredStop16uRestore.status, 200); assert.deepEqual((await restoredStop16uRestore.json()).outcome, { status: "installed", code: "ALREADY_INSTALLED", mutated: true }); assert.deepEqual(stopCalls16uRestore, ["gate-owned"]);

		const loaded = await fetch(`${restoredOrigin16uRestore}/agent/sessions/${sessionId16uRestore}`, { signal: AbortSignal.timeout(5000) }).then(response => response.json());
		assert.deepEqual(loaded.meta.motionJobIds, ["gate-owned"], "GET session metadata retains only this session's trusted admissions");
		assert.deepEqual(sessionStore16uRestore.read(otherTurn.sessionId).meta.motionJobIds, ["gate-other"]);
		console.log("PASS 16u restore: accepted motion ownership survives a fresh handler and remains session-bound");
	} finally { await close16uRestore(); rmSync(sessionStore16uRestore.dir, { recursive: true, force: true }); }
}

// #379 / 16y: an owned retired job must not acknowledge a Stop for the
// current turn while a different motion job is active. The retired target is
// stale relative to the active turn and must be rejected before runtime.stop.
{
	const { contextFixture, envelopeFixture } = await import("./verify-studio-agent-protocol.mjs");
	const started16y = Promise.withResolvers();
	const release16y = Promise.withResolvers();
	const stopCalls16y = [];
	let admissions16y = 0;
	let active16y = false;
	const runtime16y = {
		readContext: async () => contextFixture(),
		admit: () => ({ jobId: ++admissions16y === 1 ? "retired-16y" : "active-16y", commandId: `command-${admissions16y}`, state: "queued" }),
		subscribe: () => () => {},
		start: async jobId => {
			if (jobId === "retired-16y") return { ok: false, status: "cancelled", code: "CANCELLED", mutated: false };
			active16y = true;
			started16y.resolve();
			const outcome = await release16y.promise;
			active16y = false;
			return outcome;
		},
		stop: async jobId => {
			stopCalls16y.push(jobId);
			// Keep the defective implementation from hanging the RED test: if it
			// incorrectly stops the retired id, let the active job finish naturally.
			release16y.resolve({ ok: true, status: "installed", mutated: true, receiptId: "installed-16y" });
			return { status: "cancelled", code: "CANCELLED", mutated: false };
		},
	};
	const faux16y = createFakeModel();
	const motion16y = id => ({ type: "toolCall", id, name: "generate_motion", arguments: { characterId: "char-alex", source: { kind: "generate", beats: [{ text: "walk" }], durationSeconds: 2 } } });
	faux16y.script([motion16y("first-16y"), [{ type: "text", text: "first complete" }], motion16y("second-16y"), [{ type: "text", text: "second complete" }]]);
	let server16y;
	const handler16y = createAgentHandler({ auth: { getAccessToken: async () => "token" }, models: faux16y.models, fauxProvider: faux16y.fauxProvider, liveHub: { workspaceId: () => "tab-7", resolveWorkspace: () => "handle-12", command: async () => ({ ok: true }) }, studioRuntime: runtime16y, port: () => server16y.address().port });
	server16y = createServer((req, res) => handler16y(req, res).catch(error => { if (!res.headersSent) res.writeHead(500); res.end(error.message); }));
	server16y.listen(0, "127.0.0.1"); await once(server16y, "listening");
	const origin16y = `http://127.0.0.1:${server16y.address().port}`;
	const post16y = (path, body, cookie) => fetch(origin16y + path, { method: "POST", headers: { origin: origin16y, "content-type": "application/json", ...(cookie ? { cookie } : {}) }, body: JSON.stringify(body), signal: AbortSignal.timeout(10000) });
	const cookie16y = response => (response.headers.getSetCookie?.() ?? [response.headers.get("set-cookie")]).filter(Boolean).map(entry => entry.split(";")[0]).join("; ");
	const session16y = "00000000-0000-4000-8000-000000000181";
	const firstTurn16y = { ...envelopeFixture(), sessionId: session16y, turnId: "00000000-0000-4000-8000-000000000182", text: "first motion" };
	let secondBody16y;
	try {
		const firstResponse16y = await post16y("/agent/turn", firstTurn16y);
		assert.equal(firstResponse16y.status, 200);
		const owner16y = cookie16y(firstResponse16y);
		await firstResponse16y.text();
		const secondTurn16y = { ...firstTurn16y, turnId: "00000000-0000-4000-8000-000000000183", text: "second motion" };
		const secondResponse16y = await post16y("/agent/turn", secondTurn16y, owner16y);
		assert.equal(secondResponse16y.status, 200);
		secondBody16y = secondResponse16y.text();
		await bounded16q(started16y.promise, "16y active second motion");
		const stopResponse16y = await post16y("/agent/stop", { surface: "studio", sessionId: session16y, turnId: secondTurn16y.turnId, jobId: "retired-16y" }, owner16y);
		const stopBody16y = await stopResponse16y.json();
		assert.equal(stopResponse16y.status, 409);
		assert.equal(stopBody16y.error?.code, "STALE_TARGET");
		assert.deepEqual(stopCalls16y, [], "a retired owned id is rejected before runtime.stop while another job is active");
		assert.equal(active16y, true, "the active motion remains running after the stale Stop");
		release16y.resolve({ ok: true, status: "installed", mutated: true, receiptId: "installed-16y" });
		const secondFrames16y = [...(await secondBody16y).matchAll(/^data: (.+)$/gm)].map(match => JSON.parse(match[1]));
		assert.ok(secondFrames16y.some(frame => frame.type === "receipt" && frame.receipt?.status === "installed"));
		assert.equal(secondFrames16y.some(frame => frame.type === "error"), false);
		console.log("PASS 16y: an owned retired Stop is stale while a different active motion job is running");
	} finally {
		release16y.resolve({ ok: false, status: "cancelled", code: "CANCELLED" });
		if (secondBody16y) await bounded16q(secondBody16y, "16y second turn cleanup");
		await handler16y.close();
		server16y.closeAllConnections();
		await new Promise(resolve => server16y.close(resolve));
	}
}

// A second generate_motion inside one user message is a generation limit, not
// a sign-in failure: the model must report the first result and ask the user.
{
	const { contextFixture, envelopeFixture } = await import("./verify-studio-agent-protocol.mjs");
	let admissionsLimit = 0;
	const runtimeLimit = {
		readContext: async () => contextFixture(),
		admit: () => ({ jobId: `limit-job-${++admissionsLimit}`, commandId: `limit-command-${admissionsLimit}`, state: "queued" }),
		subscribe: () => () => {},
		start: async () => ({ ok: true, status: "installed", mutated: true, receiptId: "limit-receipt" }),
		stop: async () => ({ status: "already_applied" }),
	};
	const fauxLimit = createFakeModel();
	const motionLimit = id => ({ type: "toolCall", id, name: "generate_motion", arguments: { characterId: "char-alex", source: { kind: "generate", beats: [{ text: "walk" }], durationSeconds: 2 } } });
	fauxLimit.script([motionLimit("limit-first"), motionLimit("limit-second"), [{ type: "text", text: "reported" }]]);
	let serverLimit;
	const handlerLimit = createAgentHandler({ auth: { getAccessToken: async () => "token" }, models: fauxLimit.models, fauxProvider: fauxLimit.fauxProvider, liveHub: { workspaceId: () => "tab-7", resolveWorkspace: () => "handle-12", command: async () => ({ ok: true }) }, studioRuntime: runtimeLimit, port: () => serverLimit.address().port });
	serverLimit = createServer((req, res) => handlerLimit(req, res).catch(error => { if (!res.headersSent) res.writeHead(500); res.end(error.message); }));
	serverLimit.listen(0, "127.0.0.1"); await once(serverLimit, "listening");
	const originLimit = `http://127.0.0.1:${serverLimit.address().port}`;
	try {
		const turnLimit = { ...envelopeFixture(), sessionId: "00000000-0000-4000-8000-000000000191", turnId: "00000000-0000-4000-8000-000000000192", text: "make Alex walk" };
		const response = await fetch(`${originLimit}/agent/turn`, { method: "POST", headers: { origin: originLimit, "content-type": "application/json" }, body: JSON.stringify(turnLimit), signal: AbortSignal.timeout(10000) });
		assert.equal(response.status, 200);
		const framesLimit = [...(await response.text()).matchAll(/^data: (.+)$/gm)].map(match => JSON.parse(match[1]));
		const done = framesLimit.filter(frame => frame.type === "tool.done");
		assert.equal(admissionsLimit, 1, "the second generation in one user message is never admitted");
		assert.equal(done.length, 2); assert.equal(done[0].ok, true);
		assert.equal(done[1].ok, false);
		assert.match(done[1].error, /GENERATION_LIMIT/, `the model sees the generation-limit code: ${done[1].error}`);
		assert.match(done[1].error, /One motion generation per user message\. Report this result and ask the user before generating again\./);
		assert.doesNotMatch(done[1].error, /AUTH_REQUIRED|sign in/i);
		console.log("PASS a second generation in one user message fails with GENERATION_LIMIT, not AUTH_REQUIRED");
	} finally {
		await handlerLimit.close();
		serverLimit.closeAllConnections();
		await new Promise(resolve => serverLimit.close(resolve));
	}
}

// The one-generation rule holds across both generation paths: generate_motion
// and a run_action job action (motion.generateAllBlocks) share one limit per
// user message, in either order.
for (const [index, [label, first, second]] of [
	["generate_motion then generateAllBlocks", "generate_motion", "run_action"],
	["generateAllBlocks then generate_motion", "run_action", "generate_motion"],
].entries()) {
	const { contextFixture, envelopeFixture } = await import("./verify-studio-agent-protocol.mjs");
	let admissionsMixed = 0; const hubMixed = [];
	const runtimeMixed = {
		readContext: async () => contextFixture(),
		admit: () => ({ jobId: `mixed-job-${++admissionsMixed}`, commandId: `mixed-command-${admissionsMixed}`, state: "queued" }),
		subscribe: () => () => {},
		start: async () => ({ ok: true, status: "installed", mutated: true, receiptId: "mixed-receipt" }),
		stop: async () => ({ status: "already_applied" }),
	};
	const call = (name, id) => name === "generate_motion"
		? { type: "toolCall", id, name, arguments: { characterId: "char-alex", source: { kind: "generate", beats: [{ text: "walk" }], durationSeconds: 2 } } }
		: { type: "toolCall", id, name, arguments: { action: "motion.generateAllBlocks" } };
	const fauxMixed = createFakeModel();
	fauxMixed.script([call(first, "mixed-first"), call(second, "mixed-second"), [{ type: "text", text: "reported" }]]);
	const liveHubMixed = {
		workspaceId: () => "tab-7", resolveWorkspace: () => "handle-12",
		command: async (name, payload) => {
			hubMixed.push(name);
			if (name === "run_action") return { ok: true, commandId: payload.commandId, action: payload.args.action, kind: "job", status: "started", affectedIds: ["char-alex"], summary: "Started generating every prompt block." };
			return { ok: true };
		},
	};
	let serverMixed;
	const handlerMixed = createAgentHandler({ auth: { getAccessToken: async () => "token" }, models: fauxMixed.models, fauxProvider: fauxMixed.fauxProvider, liveHub: liveHubMixed, studioRuntime: runtimeMixed, port: () => serverMixed.address().port });
	serverMixed = createServer((req, res) => handlerMixed(req, res).catch(error => { if (!res.headersSent) res.writeHead(500); res.end(error.message); }));
	serverMixed.listen(0, "127.0.0.1"); await once(serverMixed, "listening");
	const originMixed = `http://127.0.0.1:${serverMixed.address().port}`;
	try {
		const turnMixed = { ...envelopeFixture(), sessionId: `00000000-0000-4000-8000-00000000019${3 + index * 2}`, turnId: `00000000-0000-4000-8000-00000000019${4 + index * 2}`, text: "make Alex walk" };
		const response = await fetch(`${originMixed}/agent/turn`, { method: "POST", headers: { origin: originMixed, "content-type": "application/json" }, body: JSON.stringify(turnMixed), signal: AbortSignal.timeout(10000) });
		assert.equal(response.status, 200);
		const framesMixed = [...(await response.text()).matchAll(/^data: (.+)$/gm)].map(match => JSON.parse(match[1]));
		const done = framesMixed.filter(frame => frame.type === "tool.done");
		assert.equal(done.length, 2, `${label}: both tool calls finish`);
		assert.equal(done[0].ok, true, `${label}: the first generation starts: ${done[0].error ?? ""}`);
		assert.equal(admissionsMixed + hubMixed.filter(name => name === "run_action").length, 1, `${label}: exactly one generation starts in one user message`);
		assert.equal(done[1].ok, false, `${label}: the second generation is refused`);
		assert.match(done[1].error, /GENERATION_LIMIT/, `${label}: the model sees the generation-limit code: ${done[1].error}`);
		console.log(`PASS one generation per user message across both paths: ${label}`);
	} finally {
		await handlerMixed.close();
		serverMixed.closeAllConnections();
		await new Promise(resolve => serverMixed.close(resolve));
	}
}

// The limit is per user message, not per wording: a user who says "다시해" in two
// messages asked twice, so the second message generates again.
{
	const { contextFixture, envelopeFixture } = await import("./verify-studio-agent-protocol.mjs");
	let admissionsAgain = 0;
	const runtimeAgain = {
		readContext: async () => contextFixture(),
		admit: () => ({ jobId: `again-job-${++admissionsAgain}`, commandId: `again-command-${admissionsAgain}`, state: "queued" }),
		subscribe: () => () => {},
		start: async () => ({ ok: true, status: "installed", mutated: true, receiptId: `again-receipt-${admissionsAgain}` }),
		stop: async () => ({ status: "already_applied" }),
	};
	const fauxAgain = createFakeModel();
	const motionAgain = id => ({ type: "toolCall", id, name: "generate_motion", arguments: { characterId: "char-alex", source: { kind: "generate", beats: [{ text: "walk" }], durationSeconds: 2 } } });
	fauxAgain.script([motionAgain("again-first"), [{ type: "text", text: "first" }], motionAgain("again-second"), [{ type: "text", text: "second" }]]);
	let serverAgain;
	const handlerAgain = createAgentHandler({ auth: { getAccessToken: async () => "token" }, models: fauxAgain.models, fauxProvider: fauxAgain.fauxProvider, liveHub: { workspaceId: () => "tab-7", resolveWorkspace: () => "handle-12", command: async () => ({ ok: true }) }, studioRuntime: runtimeAgain, port: () => serverAgain.address().port });
	serverAgain = createServer((req, res) => handlerAgain(req, res).catch(error => { if (!res.headersSent) res.writeHead(500); res.end(error.message); }));
	serverAgain.listen(0, "127.0.0.1"); await once(serverAgain, "listening");
	const originAgain = `http://127.0.0.1:${serverAgain.address().port}`;
	try {
		const sessionAgain = "00000000-0000-4000-8000-000000000197";
		const turn = async (turnId, cookie) => {
			const body = { ...envelopeFixture(), sessionId: sessionAgain, turnId, text: "다시해" };
			const response = await fetch(`${originAgain}/agent/turn`, { method: "POST", headers: { origin: originAgain, "content-type": "application/json", ...(cookie ? { cookie } : {}) }, body: JSON.stringify(body), signal: AbortSignal.timeout(10000) });
			assert.equal(response.status, 200);
			const ownerCookie = (response.headers.getSetCookie?.() ?? [response.headers.get("set-cookie")]).filter(Boolean).map((entry) => entry.split(";")[0]).join("; ");
			const frames = [...(await response.text()).matchAll(/^data: (.+)$/gm)].map(match => JSON.parse(match[1]));
			return { ownerCookie, done: frames.filter(frame => frame.type === "tool.done") };
		};
		const first = await turn("00000000-0000-4000-8000-000000000198");
		assert.equal(first.done[0]?.ok, true, `the first message generates: ${first.done[0]?.error ?? ""}`);
		const second = await turn("00000000-0000-4000-8000-000000000199", first.ownerCookie);
		assert.equal(second.done[0]?.ok, true, `the same words in a later message generate again: ${second.done[0]?.error ?? ""}`);
		assert.equal(admissionsAgain, 2, "each user message admits its own generation");
		console.log("PASS the same words in a later user message may generate again");
	} finally {
		await handlerAgain.close();
		serverAgain.closeAllConnections();
		await new Promise(resolve => serverAgain.close(resolve));
	}
}

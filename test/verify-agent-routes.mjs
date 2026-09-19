import assert from "node:assert/strict";
import { createServer } from "node:http";
import { once } from "node:events";
import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
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
	const { LiveHub, RUN_WORKFLOW_TIMEOUT_MS, CAPTURE_FRAME_TIMEOUT_MS, DEFAULT_COMMAND_TIMEOUT_MS } = await import("../mcp/live-hub.mjs");
	assert.equal(LiveHub.commandTimeoutMs("run_workflow"), RUN_WORKFLOW_TIMEOUT_MS, "run_workflow waits for capture + generation");
	assert.equal(LiveHub.commandTimeoutMs("capture_frame"), CAPTURE_FRAME_TIMEOUT_MS, "capture_frame waits for skinned-rig occlusion rays");
	assert.equal(LiveHub.commandTimeoutMs("add_node"), DEFAULT_COMMAND_TIMEOUT_MS);
	console.log("PASS run_workflow and capture_frame get long live command timeouts");
}
const forbidden = await fetch(`http://127.0.0.1:${port}/agent/models`, { headers: { origin: "http://evil.example" } });
assert.equal(forbidden.status, 403);
assert.equal((await fetch(`http://127.0.0.1:${port}/agent/models`)).status, 200);
const models = await fetch(`http://127.0.0.1:${port}/agent/models`).then((r) => r.json());
{
	// #379: /agent/models is grouped by provider, each with its pi-derived sign-in
	// state and its chat models shaped for the panel. This handler's own auth
	// double (getAccessToken only, no readStored/status) leaves every provider
	// signed out, so the live codex.listModels() merge never fires here — the
	// merge itself is exercised against providers.mjs directly below, where a
	// signed-in double is cheap and does not need network access.
	assert.equal(models.providers.length, 5, "all five registry providers are listed");
	assert.deepEqual(models.providers.map((provider) => provider.id).sort(), ["anthropic", "google", "openai", "openai-codex", "openrouter"]);
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
		writer.append("round-trip", messages, { surface: "studio" });
		const reader = createSessionStore(v2Dir);
		const read = reader.read("round-trip");
		assert.deepEqual(read.history, messages, "a fresh store instance reads back exactly what was appended");
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
	const failHandler = createAgentHandler({ auth: { getAccessToken: async () => "token" }, codex: fakeCodex, models: failFaux.models, fauxProvider: failFaux.fauxProvider, liveHub: failHub, studioRuntime: failRuntime, retryDelayMs: 1, port: () => failServer.address().port });
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

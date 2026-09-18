import assert from "node:assert/strict";
import { createServer } from "node:http";
import { once } from "node:events";
import { mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createAgentHandler } from "../bin/agent/agent-routes.mjs";

const png = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=";
const sessionDir = mkdtempSync(join(tmpdir(), "cozyclay-agent-sessions-"));
process.env.COZYCLAY_AGENT_SESSIONS_DIR = sessionDir;
const calls = [];
const fakeLive = { command: async (name) => name === "capture_framing_png" ? { dataUrl: png, width: 1920, height: 1080 } : { assetId: "a1", objectId: "o1" } };
const fakeCodex = {
  listModels: async () => ["gpt-5", { slug: "gpt-6-astra", supported_reasoning_levels: [{ effort: "low" }, { effort: "medium" }, { effort: "xhigh" }], default_reasoning_level: "medium" }],
  parseQuotaHeaders: () => ({ planType: "Plus", primary: {}, credits: { hasCredits: true } }),
  editImage: async () => ({ pngBase64: png.split(",")[1], width: 1, height: 1 }),
  streamResponses: ({ input }) => {
    calls.push(input);
    const items = calls.length === 1
      ? [{ type: "message", role: "assistant" }, { type: "function_call", call_id: "c1", name: "describe_workflow", arguments: "{}" }]
      : calls.length === 2
        ? [{ type: "function_call", call_id: "c2", name: "add_workflow_node", arguments: JSON.stringify({ type: "image", model: "image-generation", data: { prompt: "render" } }) }]
        : calls.length === 3
          ? [{ type: "function_call", call_id: "c3", name: "run_workflow", arguments: "{}" }]
          : [{ type: "message", role: "assistant" }];
    return { headers: Promise.resolve(new Headers()), async *[Symbol.asyncIterator]() {
      if (calls.length !== 2) yield { type: "response.output_text.delta", delta: calls.length === 1 ? "hello" : " done" };
      for (const item of items) yield { type: "response.output_item.done", item };
      yield { type: "response.completed", response: { status: "completed" } };
    } };
  },
};
let server;
const handler = createAgentHandler({ auth: { getAccessToken: async () => "token" }, codex: fakeCodex, liveHub: fakeLive, port: () => server.address().port });
server = createServer((req, res) => handler(req, res).catch((error) => { res.writeHead(500); res.end(error.message); }));
server.listen(0, "127.0.0.1");
await once(server, "listening");
const { port } = server.address();
const turnId = "a".repeat(32);
const response = await fetch(`http://127.0.0.1:${port}/agent/turn`, { method: "POST", headers: { "content-type": "application/json", origin: `http://127.0.0.1:${port}` }, body: JSON.stringify({ sessionId: "s", text: "hi", attachFrame: false, turn_id: turnId }) });
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
assert.ok(toolEvents.every((event) => event.type !== "tool.done" || event.ok), "every scripted tool call succeeds");
assert.equal(events.some((event) => event.type === "image"), false, "the canvas turn builds nodes instead of emitting images");
assert.equal(calls[0][0].content[0].text.includes(png), false);
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
	const seenInputs = [];
	const attachHandler = createAgentHandler({ auth: { getAccessToken: async () => "token" }, codex: { ...fakeCodex, streamResponses: ({ input }) => { seenInputs.push(input); return { headers: Promise.resolve(new Headers()), async *[Symbol.asyncIterator]() { yield { type: "response.output_item.done", item: { type: "message", role: "assistant" } }; } }; } }, liveHub: fakeLive, port: () => attachServer.address().port });
	const attachServer = createServer((req, res) => attachHandler(req, res).catch(() => {})); attachServer.listen(0, "127.0.0.1"); await once(attachServer, "listening");
	const attachPort = attachServer.address().port;
	const attachText = await fetch(`http://127.0.0.1:${attachPort}/agent/turn`, { method: "POST", headers: { "content-type": "application/json", origin: `http://127.0.0.1:${attachPort}` }, body: JSON.stringify({ sessionId: "att", text: "hi", attachFrame: true }) }).then((r) => r.text());
	const attachEvents = [...attachText.matchAll(/^data: (.+)$/gm)].map((match) => JSON.parse(match[1]));
	assert.deepEqual(attachEvents.filter((event) => event.type === "tool.start").map((event) => event.name), ["capture_blocking_frame"], "the attached frame is captured and shown as a tool card");
	assert.ok(attachEvents.every((event) => event.type !== "error"), "attaching a frame does not fail the turn");
	assert.match(seenInputs[0].find((item) => item.role === "user").content[0].text, /Attached frame imageId: /, "the model is told which image was attached");
	attachServer.close();
	console.log("PASS attachFrame captures through the internal tool");
}
{
	// #367: a picture the author pasted into the composer reaches the model as a
	// real user image item, placed BEFORE the turn text on both surfaces — the
	// same shape attachFrame already uses.
	const { contextFixture, envelopeFixture } = await import("./verify-studio-agent-protocol.mjs");
	const seenInputs = [];
	const quietCodex = { ...fakeCodex, streamResponses: ({ input }) => { seenInputs.push(input); return { headers: Promise.resolve(new Headers()), async *[Symbol.asyncIterator]() {
		yield { type: "response.output_item.done", item: { type: "message", role: "assistant" } };
		yield { type: "response.completed", response: { status: "completed" } };
	} }; } };
	const attachHub = { command: async () => ({ ok: true }), workspaceId: () => "tab-7", resolveWorkspace: () => "handle-12", handleForWorkspaceId: () => "handle-12", connected: true, workspaceHandles: ["handle-12"] };
	let attachServer;
	const attachHandler = createAgentHandler({ auth: { getAccessToken: async () => "token" }, codex: quietCodex, liveHub: attachHub, studioRuntime: { readContext: async () => contextFixture() }, port: () => attachServer.address().port });
	attachServer = createServer((req, res) => attachHandler(req, res).catch((error) => { console.error("attachment fixture error:", error); if (!res.headersSent) res.writeHead(500); res.end(error.message); }));
	attachServer.listen(0, "127.0.0.1");
	await once(attachServer, "listening");
	const attachOrigin = `http://127.0.0.1:${attachServer.address().port}`;
	const post = (body) => fetch(`${attachOrigin}/agent/turn`, { method: "POST", headers: { "content-type": "application/json", origin: attachOrigin }, body: JSON.stringify(body) }).then((response) => response.text());

	// Own session: Studio sessions persist (#368), and the resume check below
	// counts the user items a fresh route instance replays for the fixture id.
	const studioEnvelope = { ...envelopeFixture(), sessionId: "00000000-0000-4000-8000-00000000a367", text: "what is in the attached image?", attachments: [{ dataUrl: png, name: "probe.png" }] };
	await post(studioEnvelope);
	const studioInput = seenInputs.at(-1) ?? [];
	const imageAt = studioInput.findIndex((item) => item.role === "user" && item.content?.some((part) => part.type === "input_image"));
	const textAt = studioInput.findIndex((item) => item.role === "user" && item.content?.some((part) => part.type === "input_text" && part.text.includes("what is in the attached image?")));
	assert.ok(imageAt !== -1, `the studio turn sends an input_image user item: ${JSON.stringify(studioInput).slice(0, 400)}`);
	assert.ok(textAt !== -1 && imageAt < textAt, "the attachment precedes the turn text, exactly like attachFrame");
	assert.equal(studioInput[imageAt].content[1].image_url, png, "the pasted bytes reach the model");
	assert.match(studioInput[imageAt].content[0].text, /User attachment probe\.png/, "the image is named for the model");

	const rejected = await fetch(`${attachOrigin}/agent/turn`, { method: "POST", headers: { "content-type": "application/json", origin: attachOrigin }, body: JSON.stringify({ ...envelopeFixture(), attachments: [{ dataUrl: "data:text/plain;base64,aGk=" }] }) });
	assert.equal(rejected.status, 400, "a non-image attachment never reaches the model");

	const before = seenInputs.length;
	await post({ sessionId: "attach-workflow", text: "describe this", attachments: [{ dataUrl: png }] });
	const workflowInput = seenInputs[before] ?? [];
	const workflowImageAt = workflowInput.findIndex((item) => item.content?.some((part) => part.type === "input_image"));
	const workflowTextAt = workflowInput.findIndex((item) => item.content?.some((part) => part.type === "input_text" && part.text.includes("describe this")));
	assert.ok(workflowImageAt !== -1 && workflowImageAt < workflowTextAt, `the workflow turn carries the attachment too: ${JSON.stringify(workflowInput).slice(0, 300)}`);
	assert.match(workflowInput[workflowImageAt].content[0].text, /User attachment 1/, "an unnamed attachment is named by its position");
	const badWorkflow = await fetch(`${attachOrigin}/agent/turn`, { method: "POST", headers: { "content-type": "application/json", origin: attachOrigin }, body: JSON.stringify({ sessionId: "attach-bad", text: "hi", attachments: [{ dataUrl: "https://example.test/a.png" }] }) });
	assert.equal(badWorkflow.status, 400, "a remote URL is not an attachment");
	attachServer.close();
	console.log("PASS pasted attachments reach the model as input_image items before the turn text");
}
{
	// The backend sometimes answers a whole stream with server_is_overloaded.
	// One retry usually clears it; a persistent overload is reported as such.
	const overloaded = { type: "error", error: { type: "service_unavailable_error", code: "server_is_overloaded", message: "Our servers are currently overloaded." } };
	const make = (failures) => { let n = 0; return { ...fakeCodex, streamResponses: () => ({ headers: Promise.resolve(new Headers()), async *[Symbol.asyncIterator]() { if (n++ < failures) { yield overloaded; return; } yield { type: "response.output_item.done", item: { type: "message", role: "assistant" } }; } }) }; };
	const turn = async (codex) => { const h = createAgentHandler({ auth: { getAccessToken: async () => "token" }, codex, liveHub: fakeLive, port: () => s.address().port, retryDelayMs: 1 }); const s = createServer((req, res) => h(req, res).catch(() => {})); s.listen(0, "127.0.0.1"); await once(s, "listening"); const p = s.address().port; const text = await fetch(`http://127.0.0.1:${p}/agent/turn`, { method: "POST", headers: { "content-type": "application/json", origin: `http://127.0.0.1:${p}` }, body: JSON.stringify({ sessionId: "ov" + Math.random(), text: "hi" }) }).then((r) => r.text()); s.close(); return [...text.matchAll(/^data: (.+)$/gm)].map((m) => JSON.parse(m[1])); };
	const once1 = await turn(make(1));
	assert.ok(once1.every((event) => event.type !== "error"), "one overloaded stream is retried and the turn completes");
	const always = await turn(make(10));
	const err = always.find((event) => event.type === "error");
	assert.equal(err?.code, "overloaded", "a persistent overload is reported with its own code");
	const serverError = { type: "error", error: { type: "server_error", code: "server_error", message: "An error occurred while processing your request." } };
	let se = 0;
	const flaky = { ...fakeCodex, streamResponses: () => ({ headers: Promise.resolve(new Headers()), async *[Symbol.asyncIterator]() { if (se++ < 1) { yield serverError; return; } yield { type: "response.output_item.done", item: { type: "message", role: "assistant" } }; } }) };
	assert.ok((await turn(flaky)).every((event) => event.type !== "error"), "a transient server_error stream is retried too");
	console.log("PASS overloaded model streams are retried, then reported");
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
assert.equal(models.models[0].id, "gpt-6-astra");
assert.deepEqual(models.models[0].efforts, ["low", "medium", "xhigh"]); assert.equal(models.models[0].defaultEffort, "medium");
assert.deepEqual(models.models[1].efforts, []); assert.equal(models.models[1].defaultEffort, null);
{
	const bad = await fetch(`http://127.0.0.1:${port}/agent/turn`, { method: "POST", headers: { "content-type": "application/json", origin: `http://127.0.0.1:${port}` }, body: JSON.stringify({ sessionId: "e", text: "hi", effort: "bogus" }) });
	assert.equal(bad.status, 400, "an effort the backend would reject never leaves the sidecar");
	const seen = [];
	const effortHandler = createAgentHandler({ auth: { getAccessToken: async () => "token" }, codex: { ...fakeCodex, streamResponses: (request) => { seen.push(request.effort); return fakeCodex.streamResponses(request); } }, liveHub: fakeLive, port: () => effortServer.address().port });
	const effortServer = createServer((req, res) => effortHandler(req, res).catch(() => {})); effortServer.listen(0, "127.0.0.1"); await once(effortServer, "listening");
	const effortPort = effortServer.address().port;
	await fetch(`http://127.0.0.1:${effortPort}/agent/turn`, { method: "POST", headers: { "content-type": "application/json", origin: `http://127.0.0.1:${effortPort}` }, body: JSON.stringify({ sessionId: "e2", text: "hi", effort: "xhigh" }) }).then((r) => r.text());
	assert.ok(seen.length > 0 && seen.every((effort) => effort === "xhigh"), "the chosen effort reaches every codex request of the turn");
	effortServer.close();
	console.log("PASS reasoning effort: models expose efforts/default, invalid effort is 400, chosen effort reaches codex");
}
const authHandler = createAgentHandler({ auth: { getAccessToken: async () => null }, codex: fakeCodex, liveHub: fakeLive, port: () => authServer.address().port });
const authServer = createServer((req, res) => authHandler(req, res).catch(() => {})); authServer.listen(0, "127.0.0.1"); await once(authServer, "listening");
const authPort = authServer.address().port;
const authResponse = await fetch(`http://127.0.0.1:${authPort}/agent/turn`, { method: "POST", headers: { origin: `http://127.0.0.1:${authPort}`, "content-type": "application/json" }, body: JSON.stringify({ sessionId: "auth", text: "hi" }) });
assert.equal((await authResponse.text()).includes('"code":"auth"'), true);
let rateServer;
const rateHandler = createAgentHandler({ auth: { getAccessToken: async () => "token" }, codex: { ...fakeCodex, streamResponses: () => { const error = Object.assign(new Error("busy"), { status: 429, headers: new Headers() }); throw error; } }, liveHub: fakeLive, port: () => rateServer.address().port });
rateServer = createServer((req, res) => rateHandler(req, res).catch(() => {})); rateServer.listen(0, "127.0.0.1"); await once(rateServer, "listening");
const ratePort = rateServer.address().port;
const rateText = await fetch(`http://127.0.0.1:${ratePort}/agent/turn`, { method: "POST", headers: { origin: `http://127.0.0.1:${ratePort}`, "content-type": "application/json" }, body: JSON.stringify({ sessionId: "rate", text: "hi" }) }).then((r) => r.text());
assert.equal(rateText.includes('"code":"rate_limit"'), true);
await new Promise((resolve) => rateServer.close(resolve));
await new Promise((resolve) => authServer.close(resolve));
server.close();
{
	const { envelopeFixture, contextFixture } = await import("./verify-studio-agent-protocol.mjs");
	const studioCalls = [];
	const studioCodex = {
		...fakeCodex,
		streamResponses: ({ input }) => {
			studioCalls.push(input);
			return { headers: Promise.resolve(new Headers()), async *[Symbol.asyncIterator]() {
				yield { type: "response.output_text.delta", delta: studioCalls.length === 1 ? "First answer" : "Continued answer" };
				yield { type: "response.output_item.done", item: { type: "message", role: "assistant", content: [{ type: "output_text", text: studioCalls.length === 1 ? "First answer" : "Continued answer" }] } };
			} };
		},
	};
	const makeStudio = () => {
		const handler = createAgentHandler({ auth: { getAccessToken: async () => "token" }, codex: studioCodex, liveHub: fakeLive, studioRuntime: { readContext: async () => contextFixture() }, port: () => studioServer.address().port });
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
	assert.equal(studioCalls[1][0].role, "user");
	assert.equal(studioCalls[1].filter((item) => item.role === "user").length, 2, "a fresh route instance sends prior history to codex");
	const listed = await fetch(`${secondOrigin}/agent/sessions?surface=studio`).then((response) => response.json());
	assert.equal(listed.sessions[0].sessionId, firstEnvelope.sessionId, "Studio sessions list newest metadata first");
	const loaded = await fetch(`${secondOrigin}/agent/sessions/${firstEnvelope.sessionId}`).then((response) => response.json());
	assert.deepEqual(loaded.transcript.filter((item) => item.kind === "user").map((item) => item.text), ["inspect selection", "continue this"]);
	assert.ok(loaded.transcript.some((item) => item.kind === "assistant" && item.text === "First answer"), "session route derives assistant transcript text");
	second.studioServer.close();
	rmSync(sessionDir, { recursive: true, force: true });
	console.log("PASS Studio sessions persist, lazy-load across route instances, list and derive transcript views");
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
	let stopTurns = 0;
	const stopCodex = {
		...fakeCodex,
		streamResponses: () => { const first = stopTurns++ === 0; return { headers: Promise.resolve(new Headers()), async *[Symbol.asyncIterator]() {
			if (first) yield { type: "response.output_item.done", item: { type: "function_call", call_id: "m1", name: "generate_motion", arguments: JSON.stringify({ characterId: "char-alex", source: { kind: "generate", beats: [{ text: "walk forward" }], durationSeconds: 2 } }) } };
			else yield { type: "response.output_item.done", item: { type: "message", role: "assistant" } };
			yield { type: "response.completed", response: { status: "completed" } };
		} }; },
	};
	let stopServer;
	const stopHub = { command: async () => ({ ok: true }), workspaceId: () => "tab-7", resolveWorkspace: () => "handle-12", handleForWorkspaceId: () => "handle-12", connected: true, workspaceHandles: ["handle-12"] };
	const stopHandler = createAgentHandler({ auth: { getAccessToken: async () => "token" }, codex: stopCodex, liveHub: stopHub, studioRuntime: stopRuntime, port: () => stopServer.address().port });
	stopServer = createServer((req, res) => stopHandler(req, res).catch((error) => { console.error("stop-route fixture error:", error); if (!res.headersSent) res.writeHead(500); res.end(error.message); }));
	stopServer.listen(0, "127.0.0.1");
	await once(stopServer, "listening");
	const stopPort = stopServer.address().port;
	const origin = `http://127.0.0.1:${stopPort}`;
	const envelope = envelopeFixture();
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
	const failCodex = {
		...fakeCodex,
		streamResponses: () => { failTurns += 1; return { headers: Promise.resolve(new Headers()), async *[Symbol.asyncIterator]() {
			yield { type: "error", error: { code: "server_error", message: "boom" } };
		} }; },
	};
	let failServer;
	const failHub = { command: async () => ({ ok: true }), workspaceId: () => "tab-8", resolveWorkspace: () => "handle-13", handleForWorkspaceId: () => "handle-13", connected: true, workspaceHandles: ["handle-13"] };
	const failHandler = createAgentHandler({ auth: { getAccessToken: async () => "token" }, codex: failCodex, liveHub: failHub, studioRuntime: failRuntime, retryDelayMs: 1, port: () => failServer.address().port });
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
	assert.equal(failTurns, 3, "a transient server_error is retried twice before the turn is reported failed");
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
	let parityTurns = 0;
	const parityCodex = {
		...fakeCodex,
		streamResponses: () => { const first = parityTurns++ === 0; return { headers: Promise.resolve(new Headers()), async *[Symbol.asyncIterator]() {
			if (first) yield { type: "response.output_item.done", item: { type: "function_call", call_id: "par-1", name: "patch_elements", arguments: JSON.stringify({ ops: [{ target: { kind: "character", id: "char-alex" }, set: { identityImage } }] }) } };
			else yield { type: "response.output_item.done", item: { type: "message", role: "assistant" } };
			yield { type: "response.completed", response: { status: "completed" } };
		} }; },
	};
	let parityServer;
	const parityHub = { command: async (name) => name === "patch_elements" ? receiptFixture() : { ok: true }, workspaceId: () => "tab-7", resolveWorkspace: () => "handle-12", handleForWorkspaceId: () => "handle-12", connected: true, workspaceHandles: ["handle-12"] };
	const parityHandler = createAgentHandler({ auth: { getAccessToken: async () => "token" }, codex: parityCodex, liveHub: parityHub, studioRuntime: { readContext: async () => contextFixture() }, port: () => parityServer.address().port });
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
	let rejTurns = 0;
	const rejInputs = [];
	const rejCodex = {
		...fakeCodex,
		streamResponses: ({ input }) => { rejInputs.push(input); const first = rejTurns++ === 0; return { headers: Promise.resolve(new Headers()), async *[Symbol.asyncIterator]() {
			if (first) yield { type: "response.output_item.done", item: { type: "function_call", call_id: "rej-1", name: "arrange_objects", arguments: JSON.stringify({ ops: [{ op: "remove", id: "char-alex" }] }) } };
			else yield { type: "response.output_item.done", item: { type: "message", role: "assistant" } };
			yield { type: "response.completed", response: { status: "completed" } };
		} }; },
	};
	let rejServer;
	const rejHub = { command: async (name) => name === "arrange_objects" ? rejection : { ok: true }, workspaceId: () => "tab-7", resolveWorkspace: () => "handle-12", handleForWorkspaceId: () => "handle-12", connected: true, workspaceHandles: ["handle-12"] };
	const rejRuntime = { readContext: async () => contextFixture() };
	const rejHandler = createAgentHandler({ auth: { getAccessToken: async () => "token" }, codex: rejCodex, liveHub: rejHub, studioRuntime: rejRuntime, port: () => rejServer.address().port });
	rejServer = createServer((req, res) => rejHandler(req, res).catch((error) => { console.error("studio-rejection fixture error:", error); if (!res.headersSent) res.writeHead(500); res.end(error.message); }));
	rejServer.listen(0, "127.0.0.1");
	await once(rejServer, "listening");
	const rejOrigin = `http://127.0.0.1:${rejServer.address().port}`;
	const rejText = await fetch(`${rejOrigin}/agent/turn`, { method: "POST", headers: { "content-type": "application/json", origin: rejOrigin }, body: JSON.stringify(envelopeFixture()) }).then((r) => r.text());
	const rejEvents = [...rejText.matchAll(/^data: (.+)$/gm)].map((match) => JSON.parse(match[1]));
	const toolDone = rejEvents.find((event) => event.type === "tool.done" && event.callId === "rej-1");
	assert.ok(toolDone, "the rejected tool call ends with a tool.done");
	assert.equal(toolDone.ok, false);
	assert.match(toolDone.error, /STALE_TARGET/, "the card shows the receipt's code, not a generic backend failure");
	assert.match(toolDone.error, /Target incarnation changed/, "the card shows the receipt's message");
	assert.ok(!/BACKEND_UNAVAILABLE|Studio command failed/.test(toolDone.error), "the generic failure strings are gone");
	const output = rejInputs[1]?.find((item) => item.type === "function_call_output" && item.call_id === "rej-1");
	assert.ok(output, "the model receives a function_call_output for the rejected call");
	const parsed = JSON.parse(output.output);
	assert.equal(parsed.ok, false);
	assert.equal(parsed.error.code, "STALE_TARGET");
	assert.equal(parsed.error.message, "Target incarnation changed; re-read the scene.");
	assert.deepEqual(parsed.error.recovery, { action: "inspect", retryAllowed: false }, "the model sees the recovery hint");
	assert.equal(parsed.error.phase, "admission");
	assert.equal(rejEvents.some((event) => event.type === "error"), false, "a rejected tool call does not fail the turn; the model continues");
	rejServer.close();
	console.log("PASS Studio tool rejections surface the receipt's code, message and recovery");
}

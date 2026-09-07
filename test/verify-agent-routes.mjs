import assert from "node:assert/strict";
import { createServer } from "node:http";
import { once } from "node:events";
import { createAgentHandler } from "../bin/agent/agent-routes.mjs";

const png = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=";
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
    } };
  },
};
let server;
const handler = createAgentHandler({ auth: { getAccessToken: async () => "token" }, codex: fakeCodex, liveHub: fakeLive, port: () => server.address().port });
server = createServer((req, res) => handler(req, res).catch((error) => { res.writeHead(500); res.end(error.message); }));
server.listen(0, "127.0.0.1");
await once(server, "listening");
const { port } = server.address();
const response = await fetch(`http://127.0.0.1:${port}/agent/turn`, { method: "POST", headers: { "content-type": "application/json", origin: `http://127.0.0.1:${port}` }, body: JSON.stringify({ sessionId: "s", text: "hi", attachFrame: false }) });
const text = await response.text();
const events = [...text.matchAll(/^data: (.+)$/gm)].map((match) => JSON.parse(match[1]));
assert.deepEqual(events.map((event) => event.type), ["quota", "text.delta", "tool.start", "tool.done", "tool.start", "tool.done", "text.delta", "tool.start", "tool.done", "text.delta", "done"]);
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
	refServer.close();
	const guided = [];
	const guideLive = { ...fakeLive, connected: true, workspaceHandleDetails: () => [{ handle: "w", meta: { commands: ["capture_framing_png", "import_asset"] } }], resolveWorkspace: () => "w" };
	const guideHandler = createAgentHandler({ auth: { getAccessToken: async () => "token" }, codex: { ...fakeCodex, editImage: async (args) => { guided.push(args.prompt); return fakeCodex.editImage(args); } }, liveHub: guideLive, handlers: [{ name: "render_prompt", handler: async ({ mode, environment }) => ({ content: [{ type: "text", text: `[${mode}] medium shot, 24mm, subject faces camera (${environment})` }] }) }], port: () => guideServer.address().port });
	const guideServer = createServer((req, res) => guideHandler(req, res).catch(() => {})); guideServer.listen(0, "127.0.0.1"); await once(guideServer, "listening");
	await post({ prompt: "golden hour", imageDataUrl: png }, guideServer.address().port);
	assert.equal(guided[0], "golden hour\n[image] medium shot, 24mm, subject faces camera (golden hour)", "scene guidance is appended to the node prompt like render_from_frame does");
	guideServer.close();
	console.log("PASS /agent/image: full-size frame accepted, validation, reference forwarded");
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
	assert.equal(pickWorkspace(hub([{ handle: "a", meta: { commands: agentCommands } }, { handle: "b", meta: { project: "P", commands: agentCommands } }])), "b", "prefers the most recent authoring tab");
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

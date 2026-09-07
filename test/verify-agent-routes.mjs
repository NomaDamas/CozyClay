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
      ? [{ type: "message", role: "assistant" }, { type: "function_call", call_id: "c1", name: "capture_blocking_frame", arguments: "{}" }]
      : calls.length === 2
        ? [{ type: "function_call", call_id: "c2", name: "render_from_frame", arguments: JSON.stringify({ prompt: "render" }) }]
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
assert.deepEqual(events.map((event) => event.type), ["quota", "text.delta", "tool.start", "tool.done", "tool.start", "image", "tool.done", "text.delta", "done"]);
assert.equal(calls[0][0].content[0].text.includes(png), false);
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
	assert.throws(() => pickWorkspace(hub([{ handle: "a", meta: { embed: true, commands: agentCommands } }])), /requires workspace_handle/, "falls back to the hub rule when only previews are connected");
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
	const { pickWorkspace, createAgentTools, agentToolSchemas } = await import("../bin/agent/agent-tools.mjs");
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
	assert.deepEqual(schemas.map((tool) => tool.name).sort(), ["capture_blocking_frame", "render_from_frame", "place_image_in_scene", "describe_scene", "describe_shot", ...Object.keys(mapping)].sort());
	assert.equal(schemas.find((tool) => tool.name === "render_from_frame").parameters.properties.addAsNode.type, "boolean");
	for (const [name, command] of Object.entries(mapping)) {
		const tool = tools.find((entry) => entry.name === name);
		const args = command === "add_node" ? { type: "image" } : {};
		await tool.handler(args);
		assert.deepEqual(routed.at(-1), { name: command, args, handle: "canvas" });
	}
	assert.deepEqual(schemas.find((tool) => tool.name === "add_workflow_node").parameters.required, ["type"]);
	assert.equal(schemas.find((tool) => tool.name === "update_workflow_node").parameters.properties.data.type, "object");
	assert.deepEqual(schemas.find((tool) => tool.name === "connect_workflow_nodes").parameters.required, ["source", "target"]);
	await tools.find((tool) => tool.name === "capture_blocking_frame").handler();
	assert.equal(routed.at(-1).handle, "studio");
	await tools.find((tool) => tool.name === "render_from_frame").handler({ prompt: "render", addAsNode: true });
	assert.equal(routed.at(-1).name, "add_node"); assert.equal(routed.at(-1).handle, "canvas");
	assert.equal(routed.at(-1).args.model, "image-passthrough"); assert.equal(routed.at(-1).args.data.image_url, png);
	assert.equal(session.workspaceHandle, "studio"); assert.equal(session.workflowHandle, "canvas");
	console.log("PASS canvas agent tools: kind isolation, schemas, one-to-one routing, independent handles, render addAsNode");
}

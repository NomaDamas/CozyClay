import assert from "node:assert/strict";
import { createServer } from "node:http";
import { once } from "node:events";
import { createAgentHandler } from "../bin/agent/agent-routes.mjs";

const png = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=";
const calls = [];
const fakeLive = { command: async (name) => name === "capture_framing_png" ? { dataUrl: png, width: 1920, height: 1080 } : { assetId: "a1", objectId: "o1" } };
const fakeCodex = {
  listModels: async () => ["gpt-5", "gpt-6-astra"],
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

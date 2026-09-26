#!/usr/bin/env node
/**
 * Issue #326: the live hub's controller half.
 *
 * A controller is a local process, not a page: it proves itself with the hub
 * token from the endpoint file and is refused the moment it arrives with a
 * browser Origin. What it can then do — route a command, run a registry tool,
 * read status — reuses the hub's existing workspace resolution, so this suite
 * asserts the routing failures carry stable codes rather than prose, that a
 * silent socket is dropped by the heartbeat instead of hanging a mutation, and
 * that a workspace id is the handle, stable across reconnects.
 */
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { existsSync, mkdtempSync, rmSync, statSync, watch } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { WebSocket } from "ws";

import { startLiveHub } from "./live-hub.mjs";

// Every endpoint file this suite writes (its own and the MCP server's) lands in
// a throwaway config home, never the developer's.
const configHome = mkdtempSync(join(tmpdir(), "cozyclay-live-endpoint-"));
process.env.XDG_CONFIG_HOME = configHome;
const liveDirectory = join(configHome, "cozyclay", "live");
const { liveEndpointPath, publishLiveEndpoint, readLiveEndpoint, removeLiveEndpoint } = await import("../bin/live-endpoint.mjs");

const TOKEN = "e6f0c1a2b3d4e5f60718293a4b5c6d7e8f90a1b2c3d4e5f60718293a4b5c6d7e";
const serverPath = fileURLToPath(new URL("./server.mjs", import.meta.url));

const reservePort = () => new Promise((resolve, reject) => {
	const server = createServer();
	server.once("error", reject);
	server.listen(0, "127.0.0.1", () => {
		const address = server.address();
		if (!address || typeof address === "string") return reject(new Error("Could not reserve a TCP port."));
		server.close((error) => (error ? reject(error) : resolve(address.port)));
	});
});

const withTimeout = (promise, label, milliseconds = 5_000) => {
	let timer;
	return Promise.race([
		promise,
		new Promise((_, reject) => { timer = setTimeout(() => reject(new Error(`Timed out waiting for ${label}.`)), milliseconds); }),
	]).finally(() => clearTimeout(timer));
};

const once = (target, event) => withTimeout(new Promise((resolve, reject) => {
	target.once(event, resolve);
	target.once("error", reject);
}), event);

const closeInfo = (socket) => withTimeout(
	new Promise((resolve) => socket.once("close", (code, reason) => resolve({ code, reason: reason.toString() }))),
	"socket close",
);

/** An owner publishes its endpoint while it is starting up, so watch for the
 * file and read it once, whichever happens first. */
const waitForEndpoint = (port) => withTimeout(new Promise((resolve) => {
	const settle = (watcher) => {
		const record = readLiveEndpoint(port);
		if (!record) return;
		watcher?.close();
		resolve(record);
	};
	const watcher = watch(liveDirectory, () => settle(watcher));
	settle(watcher);
}), `endpoint file for port ${port}`, 20_000);

const connectController = async (url, hello, socketOptions = {}) => {
	const socket = new WebSocket(url, socketOptions);
	const pending = new Map();
	const waiters = new Set();
	const events = [];
	let readyResolve;
	const ready = new Promise((resolve) => { readyResolve = resolve; });
	socket.on("message", (raw) => {
		const frame = JSON.parse(raw.toString());
		if (frame.type === "ready") return readyResolve(frame);
		if (frame.type === "result") {
			pending.get(frame.id)?.(frame);
			pending.delete(frame.id);
			return;
		}
		if (frame.type !== "event") return;
		events.push(frame);
		for (const waiter of [...waiters]) {
			if (waiter.name !== frame.name) continue;
			waiters.delete(waiter);
			waiter.resolve(frame);
		}
	});
	await once(socket, "open");
	socket.send(JSON.stringify(hello));
	return {
		socket,
		ready: await withTimeout(ready, "controller ready frame"),
		request: (frame, label = frame.type) => {
			const id = randomUUID();
			return withTimeout(new Promise((resolve) => {
				pending.set(id, resolve);
				socket.send(JSON.stringify({ ...frame, id }));
			}), `controller ${label} result`, 20_000);
		},
		// Subscribe first, then trigger: the promise only ever sees events that
		// arrive after this call, so nothing resolves on a stale one.
		nextEvent: (name, from = events.length) => withTimeout(new Promise((resolve) => {
			const seen = events.slice(from).find((frame) => frame.name === name);
			if (seen) return resolve(seen);
			waiters.add({ name, resolve });
		}), `controller event ${name}`),
	};
};

const connectEditor = async (url, workspaceId, { autoPong = true, answer = true } = {}) => {
	const socket = new WebSocket(url, { autoPong });
	const received = [];
	const pongWaiters = [];
	let welcomeResolve;
	const welcome = new Promise((resolve) => { welcomeResolve = resolve; });
	socket.on("message", (raw) => {
		const frame = JSON.parse(raw.toString());
		if (frame.type === "workspace") return welcomeResolve(frame);
		if (frame.type === "pong") {
			for (const resolve of pongWaiters.splice(0)) resolve(frame);
			return;
		}
		if (frame.type !== "cmd") return;
		received.push(frame);
		if (!answer) return;
		socket.send(JSON.stringify({ type: "result", id: frame.id, ok: true, value: { ran: frame.name, args: frame.args } }));
	});
	await once(socket, "open");
	socket.send(JSON.stringify({ type: "hello", role: "editor", version: 1, workspaceId, meta: { project: workspaceId } }));
	const frame = await withTimeout(welcome, `${workspaceId} workspace frame`);
	return {
		socket, workspaceId, received,
		handle: frame.handle,
		heartbeatMs: frame.heartbeatMs,
		appPing: () => {
			const answered = withTimeout(new Promise((resolve) => pongWaiters.push(resolve)), "app-level pong");
			socket.send(JSON.stringify({ type: "ping" }));
			return answered;
		},
	};
};

const evidence = {};
const hub = await startLiveHub(0, { token: TOKEN, owner: "mcp" });
assert.ok(hub, "the controller suite needs its own hub on a free port");
const url = `ws://127.0.0.1:${hub.port}/live`;
const open = [];

try {
	/* ---------------------------- admission ------------------------------- */

	const tokenless = new WebSocket(url);
	await once(tokenless, "open");
	tokenless.send(JSON.stringify({ type: "hello", role: "controller", version: 1 }));
	const tokenlessClose = await closeInfo(tokenless);
	assert.equal(tokenlessClose.code, 1008, "a controller without the hub token is refused");
	assert.match(tokenlessClose.reason, /token/i);

	const wrongToken = new WebSocket(url);
	await once(wrongToken, "open");
	wrongToken.send(JSON.stringify({ type: "hello", role: "controller", version: 1, token: `${TOKEN.slice(0, -1)}0` }));
	assert.equal((await closeInfo(wrongToken)).code, 1008, "a controller with the wrong token is refused");

	// A page served from loopback passes the editor origin rule, so the
	// controller role has to refuse an Origin header of any kind.
	const fromPage = new WebSocket(url, { headers: { Origin: "http://127.0.0.1:5180" } });
	await once(fromPage, "open");
	fromPage.send(JSON.stringify({ type: "hello", role: "controller", version: 1, token: TOKEN }));
	const fromPageClose = await closeInfo(fromPage);
	assert.equal(fromPageClose.code, 1008, "a browser page may never hold the controller role");
	assert.match(fromPageClose.reason, /browser/i);
	evidence.admission = { tokenless: tokenlessClose, browserOrigin: fromPageClose };

	const controller = await connectController(url, { type: "hello", role: "controller", version: 1, token: TOKEN });
	open.push(controller.socket);
	assert.equal(controller.ready.server.owner, "mcp");
	assert.equal(controller.ready.server.port, hub.port);
	assert.equal(controller.ready.heartbeatMs, hub.heartbeatMs);

	/* ------------------------- routing and events -------------------------- */

	const connected = controller.nextEvent("editor_connected");
	const alpha = await connectEditor(url, "alpha-tab");
	open.push(alpha.socket);
	const connectedEvent = await connected;
	assert.equal(connectedEvent.payload.handle, alpha.handle);
	assert.equal(connectedEvent.payload.workspaceId, "alpha-tab");
	assert.equal(alpha.handle, "alpha-tab", "the hello's workspace id IS the handle");
	assert.equal(alpha.heartbeatMs, hub.heartbeatMs, "the workspace frame advertises the hub's heartbeat");
	assert.deepEqual(await alpha.appPing(), { type: "pong" }, "an editor can probe the hub at the application level");

	const beta = await connectEditor(url, "beta-tab");
	open.push(beta.socket);

	const ambiguous = await controller.request({ type: "cmd", name: "set_camera", args: { x: 3 } });
	assert.equal(ambiguous.ok, false);
	assert.equal(ambiguous.error.code, "AMBIGUOUS_WORKSPACE");
	assert.deepEqual([...ambiguous.error.details.candidates].sort(), ["alpha-tab", "beta-tab"]);
	assert.equal(alpha.received.length, 0, "an ambiguous command reaches no editor at all");
	assert.equal(beta.received.length, 0);

	const unknown = await controller.request({ type: "cmd", name: "set_camera", args: { x: 3 }, workspaceHandle: "not-a-workspace" });
	assert.equal(unknown.error.code, "STALE_HANDLE");
	assert.ok(unknown.error.recovery, "a typed failure carries its recovery hint");

	const routed = await controller.request({ type: "cmd", name: "set_camera", args: { x: 11 }, workspaceHandle: alpha.handle });
	assert.equal(routed.ok, true);
	assert.deepEqual(routed.value, { ran: "set_camera", args: { x: 11 } });
	assert.deepEqual(alpha.received.map((frame) => frame.name), ["set_camera"]);
	assert.equal(beta.received.length, 0, "a bound command never crosses the workspace boundary");
	evidence.routing = { ambiguous: ambiguous.error, stale: unknown.error, routed: routed.value };

	/* ------------------------------- tools --------------------------------- */

	const toolCalls = [];
	hub.serveTool = (name, args, workspaceHandle) => {
		toolCalls.push({ name, args, workspaceHandle });
		if (name !== "describe_scene") throw Object.assign(new Error(`Unknown live tool "${name}".`), { code: "UNKNOWN_TOOL" });
		return { content: [{ type: "text", text: `Scene: ${workspaceHandle}` }] };
	};
	const tool = await controller.request({ type: "tool", name: "describe_scene", args: { object_cursor: 0 }, workspaceHandle: beta.handle });
	assert.equal(tool.ok, true);
	assert.equal(tool.value.content[0].text, "Scene: beta-tab");
	assert.deepEqual(toolCalls, [{ name: "describe_scene", args: { object_cursor: 0 }, workspaceHandle: "beta-tab" }]);
	const missingTool = await controller.request({ type: "tool", name: "not_a_tool", args: {} });
	assert.equal(missingTool.ok, false);
	assert.equal(missingTool.error.code, "UNKNOWN_TOOL");
	evidence.tool = { value: tool.value, unknown: missingTool.error };

	/* ------------------------------- status -------------------------------- */

	const status = await controller.request({ type: "status" });
	assert.equal(status.ok, true);
	assert.deepEqual(status.value.server, { port: hub.port, owner: "mcp", pid: process.pid });
	const listed = status.value.editors.find((editor) => editor.handle === alpha.handle);
	assert.deepEqual(listed.meta, { project: "alpha-tab" });
	assert.equal(listed.workspaceId, "alpha-tab");
	assert.equal(listed.inFlight, 0);
	assert.ok(Number.isInteger(listed.lastSeenMs) && listed.lastSeenMs >= 0, `lastSeenMs should be a duration, got ${listed.lastSeenMs}`);
	assert.ok(Number.isInteger(listed.connectedAt));
	assert.deepEqual(status.value.editors.map((editor) => editor.handle).sort(), ["alpha-tab", "beta-tab"]);
	evidence.status = status.value;

	/* -------------------- stable handle across reconnects ------------------ */

	const duplicate = new WebSocket(url);
	await once(duplicate, "open");
	duplicate.send(JSON.stringify({ type: "hello", role: "editor", version: 1, workspaceId: "alpha-tab" }));
	const duplicateClose = await closeInfo(duplicate);
	assert.equal(duplicateClose.code, 1008, "one workspace id, one live socket");
	assert.match(duplicateClose.reason, /already connected/i);

	const disconnected = controller.nextEvent("editor_disconnected");
	alpha.socket.close();
	assert.equal((await disconnected).payload.handle, "alpha-tab");
	const duringGap = await controller.request({ type: "cmd", name: "set_camera", args: { x: 7 }, workspaceHandle: "alpha-tab" });
	assert.equal(duringGap.ok, false);
	assert.equal(duringGap.error.code, "STALE_HANDLE", "a handle is stale exactly while its editor is away");

	const resumed = await connectEditor(url, "alpha-tab");
	open.push(resumed.socket);
	assert.equal(resumed.handle, "alpha-tab", "the same tab resumes the same handle");
	const afterResume = await controller.request({ type: "cmd", name: "set_camera", args: { x: 9 }, workspaceHandle: "alpha-tab" });
	assert.equal(afterResume.ok, true);
	evidence.stableHandle = { duplicate: duplicateClose, duringGap: duringGap.error, resumed: resumed.handle };

	/* ------------------------------ heartbeat ------------------------------ */

	// Its own hub: a short interval must not be able to mistake a busy event
	// loop elsewhere in this suite for a dead socket.
	const heartbeatMs = 60;
	const beating = await startLiveHub(0, { token: TOKEN, owner: "mcp", heartbeatMs });
	const beatingUrl = `ws://127.0.0.1:${beating.port}/live`;
	const watcher = await connectController(beatingUrl, { type: "hello", role: "controller", version: 1, token: TOKEN });
	// A socket that never answers a ping and never answers a command: only the
	// heartbeat can end this, and the mutation it was running is uncertain.
	const silent = await connectEditor(beatingUrl, "silent-tab", { autoPong: false, answer: false });
	const silentClosed = closeInfo(silent.socket);
	const dropped = watcher.nextEvent("editor_disconnected");
	const startedAt = Date.now();
	const pendingMutation = watcher.request({ type: "cmd", name: "set_camera", args: { x: 1 }, workspaceHandle: "silent-tab", timeoutMs: 60_000 }, "silent mutation");
	const droppedEvent = await dropped;
	const mutation = await pendingMutation;
	const elapsed = Date.now() - startedAt;
	assert.equal(droppedEvent.payload.handle, "silent-tab");
	assert.equal(mutation.ok, false);
	assert.equal(mutation.error.code, "UNCERTAIN_APPLY", "a mutation cut off by the heartbeat is never reported as clean");
	assert.match(mutation.error.recovery, /describe/i);
	assert.ok(elapsed < 5_000, `the heartbeat, not the 60 s command timeout, ended it (${elapsed} ms)`);
	await silentClosed; // the transport itself was torn down, not just the hub's map

	assert.deepEqual((await watcher.request({ type: "status" })).value.editors, [], "a terminated editor leaves no ghost in status");
	evidence.heartbeat = { heartbeatMs, elapsed, error: mutation.error };
	watcher.socket.close();
	await new Promise((resolve) => beating.server.close(resolve));

	/* ---------------------------- endpoint file ---------------------------- */

	const record = publishLiveEndpoint({ port: hub.port, token: TOKEN, owner: "mcp" });
	const endpointPath = liveEndpointPath(hub.port);
	assert.equal(statSync(endpointPath).mode & 0o777, 0o600, "the endpoint file carries a token, so only its owner may read it");
	assert.deepEqual(readLiveEndpoint(hub.port), record);
	assert.equal(record.pid, process.pid);
	assert.equal(record.owner, "mcp");
	removeLiveEndpoint(hub.port);
	assert.equal(existsSync(endpointPath), false, "removing the endpoint leaves nothing to reconnect to");
	assert.equal(readLiveEndpoint(hub.port), null);
	evidence.endpoint = record;
} finally {
	for (const socket of open) if (socket.readyState === WebSocket.OPEN) socket.close();
	await new Promise((resolve) => hub.server.close(resolve));
}

/* ------------------ the MCP owner publishes and cleans up ------------------ */

const ownedPort = await reservePort();
const ownedPath = liveEndpointPath(ownedPort);
const client = new Client({ name: "cozyclay-live-controller-verify", version: "1.0.0" });
const transport = new StdioClientTransport({
	command: process.execPath,
	args: [serverPath, "--live-port", String(ownedPort)],
	env: { ...process.env, XDG_CONFIG_HOME: configHome },
});
try {
	await client.connect(transport);
	// The hub is published before the server accepts its first request, so a
	// connected client is proof the file is already there.
	const owned = readLiveEndpoint(ownedPort);
	assert.ok(owned, `the MCP server should publish ${ownedPath}`);
	assert.equal(owned.owner, "mcp");
	assert.equal(owned.port, ownedPort);
	assert.match(owned.token, /^[a-f0-9]{64}$/, "the token is minted per hub start");
	assert.equal(statSync(ownedPath).mode & 0o777, 0o600);
	// Subscribe before shutting down, so the removal cannot be missed.
	const removed = withTimeout(new Promise((resolve) => {
		const watcher = watch(liveDirectory, (_event, filename) => {
			if (filename !== `${ownedPort}.json` || existsSync(ownedPath)) return;
			watcher.close();
			resolve(true);
		});
	}), "endpoint removal when the MCP server exits", 15_000);
	await client.close();
	await removed;
	assert.equal(existsSync(ownedPath), false);
	evidence.mcpOwner = { port: ownedPort, owner: owned.owner, startedAt: owned.startedAt };
} finally {
	await client.close().catch(() => {});
}

/* ------------- the launcher owner publishes and serves its tools ----------- */

// The other owner of a hub is the local agent relay. Its registry tools are the
// ones a controller reaches, so run one of them over a real controller socket.
const agentPort = await reservePort();
process.env.COZYCLAY_LIVE_PORT = String(agentPort);
process.env.COZYCLAY_LIVE_OWNER = "cozyclay";
const { createAgentHandler } = await import("../bin/agent/agent-routes.mjs");
const agent = createAgentHandler({
	auth: { getAccessToken: async () => null, onAuthChange: () => () => {} },
	codex: { parseQuotaHeaders: () => ({ primary: {}, credits: {} }) },
	port: () => agentPort,
});
try {
	const launcher = await waitForEndpoint(agentPort);
	assert.equal(launcher.owner, "cozyclay");
	assert.equal(statSync(liveEndpointPath(agentPort)).mode & 0o777, 0o600);
	const controller = await connectController(`ws://127.0.0.1:${agentPort}/live`, { type: "hello", role: "controller", version: 1, token: launcher.token });
	const described = await controller.request({ type: "tool", name: "describe_scene", args: {} });
	assert.equal(described.ok, true, JSON.stringify(described));
	assert.match(described.value.content[0].text, /Scene:/, "a controller runs the owner's own registry tool");
	const noEditor = await controller.request({ type: "cmd", name: "describe", args: {} });
	assert.equal(noEditor.error.code, "NO_EDITOR", "a protocol command still needs a live editor");
	controller.socket.close();
	evidence.launcherOwner = { port: agentPort, owner: launcher.owner, tool: described.value.content[0].text.split("\n")[0], noEditor: noEditor.error.code };
	await agent.close();
	assert.equal(existsSync(liveEndpointPath(agentPort)), false, "closing the hub takes its endpoint file with it");
} finally {
	await agent.close().catch(() => {});
	rmSync(configHome, { recursive: true, force: true });
}

console.log(JSON.stringify(evidence));
console.log("PASS verify-live-controller: controller admission, typed routing errors, registry tools, status, stable handles, heartbeat, endpoint file");

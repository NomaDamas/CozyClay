#!/usr/bin/env node
import assert from "node:assert/strict";
import { createLiveControl, dispatchLiveFrame } from "../src/live-control.js";

const frames = [];
const workspaceHandles = [];
const handlers = { ping: () => ({ pong: true }), echo: (args) => args };
const liveControlSource = await import("node:fs/promises").then((fs) => fs.readFile(new URL("../src/live-control.js", import.meta.url), "utf8"));
assert.match(liveControlSource, /VITE_COZYCLAY_LIVE_PORT/);
assert.deepEqual(await dispatchLiveFrame(JSON.stringify({ type: "cmd", id: "1", name: "ping", args: {} }), handlers), {
	type: "result", id: "1", ok: true, value: { pong: true },
});
assert.deepEqual(await dispatchLiveFrame(JSON.stringify({ type: "cmd", id: "2", name: "missing", args: {} }), handlers), {
	type: "result", id: "2", ok: false, error: "Unknown command: missing",
});
assert.deepEqual(await dispatchLiveFrame(JSON.stringify({ type: "cmd", id: "3", name: "echo", args: { x: 4 } }), handlers), {
	type: "result", id: "3", ok: true, value: { x: 4 },
});
assert.equal(await dispatchLiveFrame("not json", handlers), null);

class FakeWebSocket {
	static OPEN = 1;
	static instances = [];
	constructor(url) {
		this.url = url;
		this.readyState = 0;
		FakeWebSocket.instances.push(this);
	}
	open() {
		this.readyState = FakeWebSocket.OPEN;
		this.onopen?.();
	}
	receive(frame) {
		this.onmessage?.({ data: JSON.stringify(frame) });
	}
	send(frame) { frames.push(JSON.parse(frame)); }
	close() {
		this.readyState = 3;
		this.onclose?.();
	}
}

const client = createLiveControl({
	WebSocketImpl: FakeWebSocket,
	handlers,
	onWorkspace: (handle) => workspaceHandles.push(handle),
	reconnectMs: 60_000,
});
const socket = FakeWebSocket.instances[0];
assert.equal(socket.url, "ws://127.0.0.1:5184/live");

// Given a local live port supplied by the dev server at build time
// When the editor creates its live-control client
// Then it connects to that loopback endpoint rather than a hardcoded port.
const configuredClient = createLiveControl({
	WebSocketImpl: FakeWebSocket,
	handlers,
	url: "ws://127.0.0.1:5199/live",
	reconnectMs: 60_000,
});
const configuredSocket = FakeWebSocket.instances[1];
assert.equal(configuredSocket.url, "ws://127.0.0.1:5199/live");
configuredClient.close();
socket.open();
assert.deepEqual(frames.shift(), { type: "hello", role: "editor", version: 1 });
// Given the hub assigns this editor's fresh workspace handle
// When it reaches the browser live client
// Then the editor surfaces the opaque handle without treating it as a command.
socket.receive({ type: "workspace", handle: "workspace-1" });
assert.deepEqual(workspaceHandles, ["workspace-1"]);
socket.receive({ type: "cmd", id: "wire-1", name: "ping", args: {} });
await new Promise((resolve) => queueMicrotask(resolve));
assert.deepEqual(frames.shift(), { type: "result", id: "wire-1", ok: true, value: { pong: true } });
socket.receive({ type: "cmd", id: "wire-2", name: "unknown", args: {} });
await new Promise((resolve) => queueMicrotask(resolve));
assert.deepEqual(frames.shift(), { type: "result", id: "wire-2", ok: false, error: "Unknown command: unknown" });
client.close();
const executionEvents = [];
const executionClient = createLiveControl({
	WebSocketImpl: FakeWebSocket,
	handlers,
	captureTelemetry: (event, props) => executionEvents.push({ event, props }),
	reconnectMs: 60_000,
});
const executionSocket = FakeWebSocket.instances[2];
executionSocket.open();
const requestId = "a".repeat(32);
executionSocket.receive({
	type: "event",
	name: "telemetry",
	payload: {
		event: "mcp:tool_executed",
		props: { request_id: requestId, tool_category: "read", outcome: "succeeded", duration_bucket: "lt1s", prompt: "private" },
	},
});
executionSocket.receive({
	type: "event",
	name: "telemetry",
	payload: {
		event: "mcp:tool_executed",
		props: { request_id: requestId, tool_category: "read", outcome: "succeeded", duration_bucket: "lt1s" },
	},
});
executionSocket.receive({
	type: "event",
	name: "telemetry",
	payload: { event: "mcp:result_applied", props: { request_id: requestId } },
});
executionSocket.receive({
	type: "event",
	name: "telemetry",
	payload: { event: "mcp:tool_executed", props: { request_id: requestId, tool_category: "private", outcome: "succeeded", duration_bucket: "lt1s" } },
});
assert.deepEqual(executionEvents, [
	{ event: "mcp:tool_executed", props: { request_id: requestId, tool_category: "read", outcome: "succeeded", duration_bucket: "lt1s" } },
	{ event: "mcp:result_applied", props: { request_id: requestId } },
]);
executionClient.close();
console.log("all live control checks PASS");

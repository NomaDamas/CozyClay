#!/usr/bin/env node
/** Deterministic real-hub execution receipts; no timing-based absence assertions. */
import assert from "node:assert/strict";
import { once } from "node:events";
import { mock } from "node:test";
import { WebSocket } from "ws";
import { LiveHub, LiveMutationUncertainError, startLiveHub } from "./live-hub.mjs";

const bounded = (promise) => {
	let timer;
	return Promise.race([promise, new Promise((_, reject) => { timer = setTimeout(() => reject(new Error("Fixture signal timed out")), 5_000); })]).finally(() => clearTimeout(timer));
};
const hub = await startLiveHub(0);
const telemetry = [];
const commandIds = [];
const originalSendEvent = hub.sendEvent.bind(hub);
const capture = (workspaceId, name, payload) => {
	if (name === "telemetry") telemetry.push(payload);
	return originalSendEvent(workspaceId, name, payload);
};
hub.sendEvent = capture;
const editor = { camera: { x: 0 }, characters: [{ id: "a", x: 0 }], objects: [] };
let mode = "ok";
let objectNumber = 0;
let withheld;
let installation;
let ready;
let socket;
const receive = (raw) => {
	const frame = JSON.parse(raw.toString());
	if (frame.type === "workspace") { ready.resolve(frame.handle); return; }
	if (frame.type !== "cmd") return;
	commandIds.push(frame.id.replaceAll("-", ""));
	let value;
	let error;
	if (frame.name === "describe") {
		if (mode === "describe-failed") { error = "PRIVATE editor verification refused"; mode = "ok"; }
		else value = structuredClone(editor);
	} else if (frame.name === "set_camera") {
		if (mode === "timeout") { withheld.resolve(); return; }
		if (mode === "reject") error = "PRIVATE failure";
		else {
			editor.camera.x = frame.args.x ?? editor.camera.x;
			value = { camera: editor.camera };
			if (mode === "verification-failed") mode = "describe-failed";
		}
	} else if (frame.name === "update_character") {
		editor.characters[0].x = frame.args.x ?? editor.characters[0].x;
		value = { id: "a" };
	} else if (frame.name === "apply_batch") {
		const failed = mode === "rollback" || mode === "partial";
		if (mode !== "rollback" && mode !== "noop") editor.objects.push({ id: `object-${++objectNumber}` });
		value = { applied: [1], failed: failed ? [{ index: 2, error: "PRIVATE failure" }] : [], rolledBack: mode === "rollback" };
	} else if (frame.name === "load_motion") {
		value = { loaded: mode !== "noop" };
		if (installation) {
			installation.resolve(frame);
			return;
		}
	} else throw new Error(`Unexpected command ${frame.name}`);
	socket.send(JSON.stringify(error ? { type: "result", id: frame.id, ok: false, error } : { type: "result", id: frame.id, ok: true, value }));
};
const connect = async () => {
	ready = Promise.withResolvers();
	socket = new WebSocket(`ws://127.0.0.1:${hub.server.address().port}/live`);
	socket.on("message", receive);
	await bounded(once(socket, "open"));
	socket.send(JSON.stringify({ type: "hello", role: "editor", version: 1, workspaceId: "private-editor" }));
	return bounded(ready.promise);
};
const disconnect = async (handle) => {
	const closed = bounded(Promise.all([once(socket, "close"), once(hub.editors.get(handle), "close")]));
	socket.close();
	await closed;
};
let handle = await connect();
const run = (name, command, args = {}) => hub.runExclusive(name, handle, (resolved) => hub.observeExecution(name, resolved, async () => {
	try {
		await hub.command(command, args, resolved);
		await hub.command("describe", {}, resolved);
		return { content: [] };
	} catch { return { isError: true, content: [{ type: "text", text: "unchanged handler error prose" }] }; }
}));
const expect = (offset, outcome, applied) => {
	const events = telemetry.slice(offset);
	assert.deepEqual(events.map(({ event }) => event), ["mcp:tool_requested", "mcp:tool_executed", ...(applied ? ["mcp:result_applied"] : [])]);
	assert.equal(events[1].props.outcome, outcome);
	assert.match(events[0].props.request_id, /^[a-f0-9]{32}$/);
	assert.ok(events.every(({ props }) => props.request_id === events[0].props.request_id));
	assert.deepEqual(Object.keys(events[0].props).sort(), ["request_id", "tool_category"]);
	assert.deepEqual(Object.keys(events[1].props).sort(), ["duration_bucket", "outcome", "request_id", "tool_category"]);
	if (applied) assert.deepEqual(Object.keys(events[2].props), ["request_id"]);
	assert.doesNotMatch(JSON.stringify(events), /PRIVATE|private-editor|set_camera|unchanged handler/);
};
try {
	let offset = telemetry.length;
	await run("set_camera", "set_camera", { x: 2 });
	expect(offset, "succeeded", true);
	offset = telemetry.length;
	await run("set_camera", "set_camera", { x: 2 });
	expect(offset, "succeeded", false);
	offset = telemetry.length;
	await run("place_character", "update_character", { x: 3 });
	expect(offset, "succeeded", true);
	for (const [nextMode, outcome, applied] of [["noop", "succeeded", false], ["rollback", "failed", false], ["partial", "failed", true], ["ok", "succeeded", true]]) {
		mode = nextMode; offset = telemetry.length;
		await run("apply_batch", "apply_batch");
		expect(offset, outcome, applied);
	}
	mode = "reject"; offset = telemetry.length;
	await run("set_camera", "set_camera", { x: 4 });
	expect(offset, "failed", false);
	mode = "ok"; offset = telemetry.length;
	await run("set_camera", "set_camera", { x: 4 });
	expect(offset, "succeeded", true); // Retry is a new attempt, not a replay.
	mode = "verification-failed"; offset = telemetry.length;
	const unverified = await run("set_camera", "set_camera", { x: 5 });
	assert.equal(unverified.isError, true);
	expect(offset, "uncertain", false);
	mode = "describe-failed"; offset = telemetry.length;
	await run("set_camera", "set_camera", { x: 6 });
	assert.equal(editor.camera.x, 6, "failed observational baseline cannot block the mutation");
	expect(offset, "succeeded", false); // No evidence means no application claim.

	// Advance the real command timeout callback only after the editor has
	// received that exact mutation. The socket stays connected to observe it.
	mode = "timeout"; withheld = Promise.withResolvers(); offset = telemetry.length;
	mock.timers.enable({ apis: ["setTimeout"] });
	try {
		const timeout = run("set_camera", "set_camera", { x: 7 });
		await withheld.promise;
		mock.timers.tick(LiveHub.commandTimeoutMs("set_camera"));
		await timeout;
	} finally { mock.timers.reset(); }
	expect(offset, "uncertain", false);
	mode = "ok"; offset = telemetry.length;
	await assert.rejects(hub.observeExecution("set_camera", handle, () => { throw new LiveMutationUncertainError("PRIVATE uncertain"); }), LiveMutationUncertainError);
	expect(offset, "uncertain", false);
	offset = telemetry.length;
	await assert.rejects(hub.observeExecution("set_camera", handle, () => { throw new DOMException("PRIVATE aborted", "AbortError"); }), { name: "AbortError" });
	expect(offset, "cancelled", false);

	// Queuing succeeds before generation finishes. The existing async context
	// carries only telemetry state, not a job/command ID or persisted scene data.
	offset = telemetry.length;
	const generated = Promise.withResolvers();
	installation = Promise.withResolvers();
	let job;
	await hub.observeExecution("generate_motion", handle, () => {
		job = generated.promise.then(() => hub.command("load_motion", {}, handle));
		return { status: "queued" };
	});
	expect(offset, "succeeded", false);
	generated.resolve();
	const load = await bounded(installation.promise);
	expect(offset, "succeeded", false);
	for (let i = 0; i < 2; i++) socket.send(JSON.stringify({ type: "result", id: load.id, ok: true, value: { loaded: true } }));
	await job;
	expect(offset, "succeeded", true);
	installation = null;

	// Randomness, initial/terminal clock reads, and sync/async sinks cannot
	// change the operation's return value or turn it into a rejection.
	const sentinel = {};
	for (const options of [{ randomId() { throw new Error("random offline"); } }, { now() { throw new Error("clock offline"); } }]) {
		offset = telemetry.length;
		assert.equal(await hub.observeExecution("set_camera", handle, () => sentinel, options), sentinel);
		assert.equal(telemetry.length, offset);
	}
	let clockReads = 0;
	assert.equal(await hub.observeExecution("set_camera", handle, () => sentinel, { now() { if (clockReads++) throw new Error("terminal clock offline"); return 0; } }), sentinel);
	for (const sink of [() => { throw new Error("sink offline"); }, () => Promise.reject(new Error("sink offline"))]) {
		hub.sendEvent = sink;
		assert.equal(await hub.observeExecution("set_camera", handle, () => sentinel), sentinel);
	}
	hub.sendEvent = capture;

	const ids = telemetry.filter(({ event }) => event === "mcp:tool_requested").map(({ props }) => props.request_id);
	assert.equal(new Set(ids).size, ids.length);
	assert.ok(ids.every((id) => !commandIds.includes(id)), "request IDs are not command IDs");
	await disconnect(handle);
	offset = telemetry.length;
	assert.equal(await hub.observeExecution("set_camera", handle, () => sentinel), sentinel);
	assert.equal(telemetry.length, offset, "detached editor is unobserved");
	handle = await connect();
	await hub.command("describe", {}, handle);
	assert.equal(telemetry.length, offset, "reconnect and non-MCP hub commands do not replay telemetry");
	console.log("MCP execution receipts PASS: real hub acknowledgements, aliases, no-op, rollback, partial failure, retry, verification/timeout uncertainty, cancellation, async motion ack, duplicate receipt, clock/random/sink failures, disconnection and no replay");
} finally {
	if (hub.editors.has(handle)) await disconnect(handle);
	await new Promise((resolve) => hub.server.close(resolve));
}

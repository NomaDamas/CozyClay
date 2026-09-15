#!/usr/bin/env node
/** Real MCP -> bridge -> live-control boundary coverage, without polling. */
import assert from "node:assert/strict";
import { createServer as createHttpServer } from "node:http";
import { createServer } from "node:net";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { WebSocket } from "ws";
import { MotionJobRegistry } from "./live-hub.mjs";
import { fileURLToPath } from "node:url";
import { createLiveControl } from "../src/live-control.js";

const serverPath = fileURLToPath(new URL("./server.mjs", import.meta.url));
const motionTaskFields = ["createdAt", "lastUpdatedAt", "pollIntervalMs", "status", "taskId", "ttlMs"];
const deferred = () => {
	let resolve;
	const promise = new Promise((next) => { resolve = next; });
	return { promise, resolve };
};
const reservePort = () => new Promise((resolve, reject) => {
	const server = createServer();
	server.once("error", reject);
	server.listen(0, "127.0.0.1", () => {
		const address = server.address();
		if (!address || typeof address === "string") return reject(new Error("Could not reserve a TCP port."));
		server.close((error) => error ? reject(error) : resolve(address.port));
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
// Subscribers are registered before an action. Buffered values also preserve
// cross-transport events arriving before the MCP call's immediate response.
const channel = () => {
	const values = [];
	const waiters = [];
	return {
		values,
		push(value) {
			const index = waiters.findIndex(({ matches }) => matches(value));
			if (index < 0) values.push(value);
			else waiters.splice(index, 1)[0].resolve(value);
		},
		next(matches = () => true) {
			const index = values.findIndex(matches);
			if (index >= 0) return Promise.resolve(values.splice(index, 1)[0]);
			return new Promise((resolve) => waiters.push({ matches, resolve }));
		},
	};
};
const livePort = await reservePort();
const bridgePort = await reservePort();
const generations = channel();
let health = { ok: true, host: "private-gpu-host", device: "cuda" };
let healthGate = null;
let healthCount = 0;
let generationCount = 0;
const bridge = createHttpServer(async (request, response) => {
	if (request.url === "/ardy/health") {
		healthCount += 1;
		if (healthGate) {
			const gate = healthGate;
			healthGate = null;
			gate.arrived.resolve();
			await gate.release.promise;
		}
		if (health.disconnect) return response.destroy();
		response.writeHead(health.ok ? 200 : 503, { "content-type": "application/json" });
		response.end(JSON.stringify(health));
		return;
	}
	if (request.url === "/ardy/generate" && request.method === "POST") {
		generationCount += 1;
		const generation = deferred();
		let body = "";
		for await (const chunk of request) body += chunk;
		generation.body = JSON.parse(body);
		response.on("close", () => generation.resolve({ cancelled: true }));
		generations.push(generation);
		const outcome = await generation.promise;
		if (outcome.cancelled || response.destroyed) return;
		response.writeHead(outcome.status ?? 200, { "content-type": "application/x-ndjson" });
		response.end(outcome.error
			? `${JSON.stringify({ event: "error", message: outcome.error })}\n`
			: `${JSON.stringify({ event: "done", motionUrl: outcome.motionUrl })}\n`.repeat(2));
		return;
	}
	response.writeHead(404).end();
});
await new Promise((resolve, reject) => {
	bridge.once("error", reject);
	bridge.listen(bridgePort, "127.0.0.1", resolve);
});
const client = new Client({ name: "cozyclay-live-motion-job-verify", version: "1.0.0" });
const transport = new StdioClientTransport({
	command: process.execPath,
	args: [serverPath, "--live-port", String(livePort)],
	env: { ...process.env, COZYCLAY_BRIDGE: `http://127.0.0.1:${bridgePort}` },
});
const editorState = { loadCount: 0, loadMode: "ok", loadGate: null, captureMode: "ok" };
const telemetry = [];
const wireTelemetry = [];
const captureEvents = channel();
const requestIds = new Set();
const namesSince = (index) => telemetry.slice(index).map(({ event }) => event);
const assertRequest = (index, task, names) => {
	const events = telemetry.slice(index);
	assert.deepEqual(events.map(({ event }) => event), names.map((name) => `motion:${name}`));
	const id = events[0].props.request_id;
	assert.match(id, /^[a-f0-9]{32}$/);
	assert.notEqual(id, task.taskId.replaceAll("-", ""));
	assert.ok(!requestIds.has(id), "each explicit request needs fresh secure randomness");
	requestIds.add(id);
	assert.ok(events.every(({ props }) => props.request_id === id));
	assert.equal(events[0].props.surface, "mcp");
	assert.equal(events[0].props.input_mode, "prompt");
	assert.ok(events.every(({ props }) => !Object.hasOwn(props, "backend") || props.backend === "local_kimodo"));
	assert.doesNotMatch(JSON.stringify(events), /private-gpu-host|private prompt|raw generator error|http:|taskId|char-a/);
};
const connections = [];
const connectEditor = async (workspaceId) => {
	let socket;
	const events = channel();
	const capturedTelemetry = [];
	const receivedTelemetry = [];
	const loadedMotions = [];
	const ready = deferred();
	const control = createLiveControl({
		workspaceId,
		url: `ws://127.0.0.1:${livePort}/live`,
		reconnectMs: 60_000,
		WebSocketImpl: class extends WebSocket {
			constructor(url) { super(url); socket = this; }
		},
		onWorkspace: ready.resolve,
		captureMotionTelemetry: (event, props) => {
			const captured = { event, props };
			capturedTelemetry.push(captured);
			telemetry.push(captured);
			captureEvents.push(captured);
			if (editorState.captureMode === "throw") throw new Error("SDK unavailable");
			if (editorState.captureMode === "reject") return Promise.reject(new Error("SDK rejected capture"));
		},
		onEvent: (name, payload) => { if (name === "motion_job") events.push(payload); },
		handlers: {
			describe: () => ({
				sceneName: "MOTION JOB",
				activeCharacterId: "char-a",
				camera: { x: 0, y: 1.6, z: 4.5, focalMm: 35, sensorId: "super35", aspectRatio: 16 / 9 },
				stage: { shotAspect: "16:9", sensorId: "super35", hasCharSheet: false },
				timeline: { currentFrame: 0, frameCount: 240, fps: 24 },
				characters: [{ id: "char-a", model: "y-bot-tpose", subject: "performer", x: 0, y: 0, z: 0, rot: 0, hidden: false }],
				objects: [],
			}),
			load_motion: async (args) => {
				loadedMotions.push(args);
				editorState.loadCount += 1;
				if (editorState.loadGate) {
					const gate = editorState.loadGate;
					editorState.loadGate = null;
					gate.arrived.resolve();
					await gate.release.promise;
				}
				if (editorState.loadMode === "reject") {
					editorState.loadMode = "ok";
					throw new Error("test editor rejected motion");
				}
				if (editorState.loadMode === "disconnect") {
					editorState.loadMode = "ok";
					control.close();
					return;
				}
				return { loaded: true };
			},
		},
	});
	socket.on("message", (raw) => {
		const frame = JSON.parse(raw.toString());
		if (frame.type === "event" && frame.name === "motion_telemetry") {
			wireTelemetry.push(frame.payload);
			receivedTelemetry.push(frame.payload);
		}
	});
	const connection = { socket, control, events, capturedTelemetry, receivedTelemetry, loadedMotions };
	connections.push(connection);
	connection.handle = await withTimeout(ready.promise, "workspace handshake");
	return connection;
};
const call = (name, args = {}) => client.callTool({ name, arguments: args });
const begin = async (args = { phases: ["A person walks forward.", "A person stops."] }) => {
	const result = await call("generate_motion", args);
	assert.equal(result.isError, undefined, JSON.stringify(result));
	const task = JSON.parse(result.content[0].text);
	assert.deepEqual(Object.keys(task).sort(), motionTaskFields);
	assert.equal(task.status, "queued");
	return task;
};
const terminal = (editor, task, status) => withTimeout(editor.events.next((event) => event.taskId === task.taskId && event.status === status), `${status} motion event`);
const closeEditor = async (editor) => {
	const closed = once(editor.socket, "close");
	editor.control.close();
	await closed;
};
try {
	await client.connect(transport);
	await call("generate_motion", { phases: ["A person walks."] });
	assert.equal(healthCount, 0, "without an editor generation and telemetry are omitted");
	assert.equal(generationCount, 0);
	let editor = await connectEditor("motion-job-workspace");

	// Request is observable while health is withheld; start before completion;
	// success while load acknowledgement is withheld; application only after it.
	const firstIndex = telemetry.length;
	const requested = captureEvents.next(({ event }) => event === "motion:generate_requested");
	const started = captureEvents.next(({ event }) => event === "motion:job_started");
	const probe = { arrived: deferred(), release: deferred() };
	healthGate = probe;
	const task = await begin();
	await withTimeout(requested, "generate requested");
	await withTimeout(probe.arrived.promise, "health request");
	assert.deepEqual(namesSince(firstIndex), ["motion:generate_requested"]);
	assert.equal(generationCount, 0);
	probe.release.resolve();
	const firstGeneration = await withTimeout(generations.next(), "generation request");
	await withTimeout(started, "job started");
	assert.deepEqual(namesSince(firstIndex), ["motion:generate_requested", "motion:preflight_passed", "motion:job_started"]);
	const installation = { arrived: deferred(), release: deferred() };
	editorState.loadGate = installation;
	const succeeded = captureEvents.next(({ event }) => event === "motion:job_succeeded");
	const completion = terminal(editor, task, "completed");
	firstGeneration.resolve({ motionUrl: "/ardy/motions/123456-abcdef" });
	await withTimeout(succeeded, "job succeeded");
	await withTimeout(installation.arrived.promise, "load motion arrival");
	assert.equal(telemetry.at(-1).event, "motion:job_succeeded");
	installation.release.resolve();
	const completed = await completion;
	assert.equal(completed.outcome.motionUrl, "/ardy/motions/123456-abcdef");
	assert.equal(completed.outcome.targetCharacterId, "char-a");
	assert.equal(editorState.loadCount, 1);
	assertRequest(firstIndex, task, ["generate_requested", "preflight_passed", "job_started", "job_succeeded", "result_applied"]);
	const beforeDuplicate = telemetry.length;
	for (const payload of wireTelemetry) await editor.socket.onmessage({ data: JSON.stringify({ type: "event", name: "motion_telemetry", payload }) });
	assert.equal(telemetry.length, beforeDuplicate, "duplicate lifecycle notifications do not capture twice");

	// Even a malformed/unknown local relay frame must not reach capture. Valid
	// lifecycle frames are re-sanitized at the browser boundary before capture.
	const receiveTelemetry = (payload) => editor.socket.onmessage({ data: JSON.stringify({ type: "event", name: "motion_telemetry", payload }) });
	const relayId = "a".repeat(32);
	for (const payload of [
		{ event: "feature:used", props: { request_id: relayId, name: "mcp_connected" } },
		{ event: "motion:backend_state", props: { request_id: relayId, backend: "hosted" } },
		{ event: "motion:generate_blocked", props: { request_id: relayId } },
		{ event: "private prompt", props: { request_id: relayId } },
		{ event: "__proto__", props: { request_id: relayId } },
		{ event: {}, props: { request_id: relayId } },
		{ event: "motion:generate_requested", props: { request_id: "private prompt", surface: "mcp" } },
		{ event: "motion:generate_requested", props: { request_id: relayId, surface: "timeline" } },
		{ event: "motion:job_failed", props: [] },
	]) await receiveTelemetry(payload);
	assert.equal(telemetry.length, beforeDuplicate, "unknown names and invalid request IDs must never reach capture");
	await receiveTelemetry({ event: "motion:generate_requested", props: {
		request_id: relayId, surface: "mcp", input_mode: "prompt", prompt: "private prompt", host: "private-gpu-host", url: "http://private-host", taskId: task.taskId,
	} });
	assert.deepEqual(telemetry.at(-1), { event: "motion:generate_requested", props: { request_id: relayId, surface: "mcp", input_mode: "prompt" } });
	assert.equal(telemetry.length, beforeDuplicate + 1);

	// A failed installation changes the live task outcome, not generation success.
	const rejectedIndex = telemetry.length;
	editorState.loadMode = "reject";
	const rejectedTask = await begin({ phases: ["A person jumps upward."] });
	const rejectedGeneration = await withTimeout(generations.next(), "rejected generation request");
	const rejection = terminal(editor, rejectedTask, "failed");
	rejectedGeneration.resolve({ motionUrl: "/ardy/motions/222222-badbad" });
	assert.match((await rejection).outcome.message, /test editor rejected motion/);
	assert.equal(editorState.loadCount, 2);
	assertRequest(rejectedIndex, rejectedTask, ["generate_requested", "preflight_passed", "job_started", "job_succeeded"]);

	// Actual invalid output, streamed failure, and HTTP refusal all fail generation.
	for (const outcome of [
		{ motionUrl: "/ardy/../../outside.npz" },
		{ error: "raw generator error private prompt private-gpu-host" },
		{ error: "raw generator error", status: 500 },
	]) {
		const index = telemetry.length;
		const failedTask = await begin({ phases: ["A person jumps upward."] });
		const generation = await withTimeout(generations.next(), "failing generation request");
		const failure = terminal(editor, failedTask, "failed");
		generation.resolve(outcome);
		await failure;
		assert.equal(editorState.loadCount, 2);
		assertRequest(index, failedTask, ["generate_requested", "preflight_passed", "job_started", "job_failed"]);
		assert.equal(telemetry.at(-1).props.error_code, "generation_failed");
	}

	// A double cancel produces one failure with a normalized code, no installation.
	const cancelledIndex = telemetry.length;
	const cancelledTask = await begin();
	const cancellableGeneration = await withTimeout(generations.next(), "cancellable generation request");
	const cancellation = terminal(editor, cancelledTask, "cancelled");
	for (let i = 0; i < 2; i += 1) editor.socket.send(JSON.stringify({ type: "event", name: "motion_job_cancel", payload: { taskId: cancelledTask.taskId } }));
	await cancellation;
	cancellableGeneration.resolve({ cancelled: true });
	await call("describe_scene");
	assert.equal(editorState.loadCount, 2);
	assertRequest(cancelledIndex, cancelledTask, ["generate_requested", "preflight_passed", "job_started", "job_failed"]);
	assert.equal(telemetry.at(-1).props.error_code, "aborted");

	// Readiness refusal is operational, not driven by telemetry return values.
	for (const [probeHealth, reason] of [
		[{ ok: false, host_configured: false }, "unconfigured"],
		[{ ok: false, reason: "private-gpu-host unreachable" }, "unreachable"],
		[{ disconnect: true }, "unreachable"],
		[{ ok: true, host: "local", device: "local" }, "unsupported_route"],
	]) {
		health = probeHealth;
		const index = telemetry.length;
		const before = generationCount;
		const blockedTask = await begin();
		await terminal(editor, blockedTask, "failed");
		assert.equal(generationCount, before, "preflight blocked requests must never POST generation");
		assertRequest(index, blockedTask, ["generate_requested", "preflight_blocked"]);
		assert.equal(telemetry.at(-1).props.reason, reason);
	}
	health = { ok: true, host: "private-gpu-host", device: "cuda" };

	// Cancellation while health is pending must not fabricate a job start or a
	// preflight refusal: no backend operation was allowed to begin.
	const probeCancelIndex = telemetry.length;
	const beforeProbeCancel = generationCount;
	const cancelProbe = { arrived: deferred(), release: deferred() };
	healthGate = cancelProbe;
	const probeCancelTask = await begin();
	await withTimeout(cancelProbe.arrived.promise, "cancelled health probe arrival");
	const probeCancellation = terminal(editor, probeCancelTask, "cancelled");
	editor.socket.send(JSON.stringify({ type: "event", name: "motion_job_cancel", payload: { taskId: probeCancelTask.taskId } }));
	await probeCancellation;
	cancelProbe.release.resolve();
	await call("describe_scene");
	assert.equal(generationCount, beforeProbeCancel);
	assertRequest(probeCancelIndex, probeCancelTask, ["generate_requested"]);

	// The accepted reuse argument only installs an existing take, even with no backend.
	health = { ok: false, host_configured: false };
	const reuseIndex = telemetry.length;
	const beforeReuse = { healthCount, generationCount };
	const reusedTask = await begin({ phases: ["A person walks."], motion_url: "/ardy/motions/333333-abcdef" });
	await terminal(editor, reusedTask, "completed");
	assert.deepEqual({ healthCount, generationCount }, beforeReuse);
	assert.equal(telemetry.length, reuseIndex, "reusing a take must not manufacture generation demand");
	health = { ok: true, host: "private-gpu-host", device: "cuda" };

	// SDK failures cannot control POST or successful installation. Timed phases,
	// seed and drop still take the same supported generation path.
	for (const captureMode of ["throw", "reject"]) {
		editorState.captureMode = captureMode;
		const index = telemetry.length;
		const sdkTask = await begin({ phases: [{ text: "A person walks.", seconds: 3 }], seed: 17, drop: { from_s: 0, to_s: 1, meters: 1 } });
		const generation = await withTimeout(generations.next(), "SDK-failing generation request");
		assert.equal(generation.body.seed, 17);
		assert.equal(generation.body.duration, 3);
		const completion = terminal(editor, sdkTask, "completed");
		generation.resolve({ motionUrl: "/ardy/motions/444444-abcdef" });
		assert.deepEqual((await completion).outcome.drop, { from_s: 0, to_s: 1, meters: 1 });
		assertRequest(index, sdkTask, ["generate_requested", "preflight_passed", "job_started", "job_succeeded", "result_applied"]);
	}
	editorState.captureMode = "ok";

	// Reconnect recovery uses the retained result, without replaying telemetry or installs.
	const loadsBeforeRecovery = editorState.loadCount;
	const recoverTask = await begin();
	const recoveryGeneration = await withTimeout(generations.next(), "recovery generation request");
	await closeEditor(editor);
	recoveryGeneration.resolve({ motionUrl: "/ardy/motions/654321-fedcba" });
	editor = await connectEditor("motion-job-workspace");
	const recovered = await terminal(editor, recoverTask, "completed");
	assert.equal(recovered.outcome.motionUrl, "/ardy/motions/654321-fedcba");
	assert.equal(editorState.loadCount, loadsBeforeRecovery + 1);
	const capturesBeforeReconnect = telemetry.length;
	await closeEditor(editor);
	editor = await connectEditor("motion-job-workspace");
	// A command response is an ordered protocol barrier, not a timed absence check.
	await call("describe_scene");
	assert.ok(!editor.events.values.some((event) => event.taskId === recoverTask.taskId));
	assert.equal(editorState.loadCount, loadsBeforeRecovery + 1);
	assert.equal(telemetry.length, capturesBeforeReconnect, "reconnect must not reconstruct or replay lifecycle telemetry");

	// A lost acknowledgement is not application and must not undo generation success.
	const uncertainIndex = telemetry.length;
	editorState.loadMode = "disconnect";
	const uncertainTask = await begin({ phases: ["A person falls backward."] });
	const uncertainGeneration = await withTimeout(generations.next(), "uncertain generation request");
	const uncertainClosed = once(editor.socket, "close");
	uncertainGeneration.resolve({ motionUrl: "/ardy/motions/777777-abcdef" });
	await uncertainClosed;
	const loadsBeforeReconnect = editorState.loadCount;
	editor = await connectEditor("motion-job-workspace");
	assert.match((await terminal(editor, uncertainTask, "failed")).outcome.message, /may have applied/);
	assert.equal(editorState.loadCount, loadsBeforeReconnect);
	assertRequest(uncertainIndex, uncertainTask, ["generate_requested", "preflight_passed", "job_started", "job_succeeded"]);

	// A generation belongs only to its explicit workspace. The unrelated editor
	// gets neither telemetry nor installation or job events.
	const observer = await connectEditor("unrelated-workspace");
	const isolatedIndex = telemetry.length;
	const isolatedTask = await begin({ phases: ["A person walks."], workspace_handle: editor.handle });
	const isolatedGeneration = await withTimeout(generations.next(), "isolated generation request");
	const isolatedCompletion = terminal(editor, isolatedTask, "completed");
	isolatedGeneration.resolve({ motionUrl: "/ardy/motions/888888-abcdef" });
	await isolatedCompletion;
	await call("describe_scene", { workspace_handle: observer.handle });
	assert.deepEqual(observer.receivedTelemetry, []);
	assert.deepEqual(observer.capturedTelemetry, []);
	assert.deepEqual(observer.events.values, []);
	assert.deepEqual(observer.loadedMotions, []);
	assert.equal(editor.loadedMotions.at(-1).url, "/ardy/motions/888888-abcdef");
	assertRequest(isolatedIndex, isolatedTask, ["generate_requested", "preflight_passed", "job_started", "job_succeeded", "result_applied"]);
	assert.doesNotMatch(JSON.stringify(wireTelemetry), /private-gpu-host|private prompt|raw generator error|http:|taskId|char-a/);
	const propertyKeys = {
		"motion:generate_requested": ["surface", "input_mode", "request_id"],
		"motion:preflight_blocked": ["reason", "surface", "request_id"],
		"motion:preflight_passed": ["backend", "surface", "request_id"],
		"motion:job_started": ["backend", "input_mode", "request_id"],
		"motion:job_succeeded": ["backend", "input_mode", "request_id", "duration_bucket"],
		"motion:job_failed": ["backend", "input_mode", "request_id", "duration_bucket", "error_code"],
		"motion:result_applied": ["request_id", "backend"],
	};
	for (const payload of wireTelemetry) {
		assert.deepEqual(Object.keys(payload).sort(), ["event", "props"]);
		assert.deepEqual(Object.keys(payload.props).sort(), propertyKeys[payload.event].toSorted());
	}

	const tools = await client.listTools();
	for (const forbidden of ["get", "result", "list", "update"].map((name) => ["tasks", name].join("/"))) {
		assert.ok(!tools.tools.some((tool) => tool.name === forbidden), `Polling tool must not be exposed: ${forbidden}`);
	}
	let now = 0;
	const registry = new MotionJobRegistry({ clock: () => now, ttlMs: 10 });
	const expired = registry.create("expired-workspace");
	registry.transition(expired, "completed", { motionUrl: "/ardy/motions/expired" });
	now = 10;
	assert.deepEqual(registry.forWorkspace("expired-workspace"), []);
	assert.equal(registry.jobs.get(expired.taskId).status, "expired");
	const capacity = new MotionJobRegistry();
	capacity.create("workspace-a");
	assert.throws(() => capacity.create("workspace-a"), /already has an active motion job/);
	capacity.create("workspace-b");
	assert.throws(() => capacity.create("workspace-c"), /capacity reached/);
	console.log("MCP motion telemetry and live jobs PASS: real-time stages, readiness gating, failure, cancel, duplicate delivery, reuse, SDK failure, application separation, reconnect, expiry and capacity");
} finally {
	for (const connection of connections) connection.control.close();
	await client.close().catch(() => {});
	bridge.closeAllConnections();
	await new Promise((resolve, reject) => bridge.close((error) => error ? reject(error) : resolve()));
}

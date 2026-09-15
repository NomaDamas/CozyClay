import assert from "node:assert/strict";
import { EventEmitter, once } from "node:events";
import { createServer } from "node:http";
import { createHttpTransport } from "../src/workflow/agent-client.js";
import { createAgentHandler } from "../bin/agent/agent-routes.mjs";
import { createCodexClient } from "../bin/agent/codex-client.mjs";
import { createCanvasCommands } from "../src/workflow/canvas-commands.js";

const request = { sessionId: "private-session", text: "private prompt /secret/file.png", model: "private-model" };
const encode = (event) => `data: ${JSON.stringify(event)}\n\n`;
const terminal = (turnId, outcome = "succeeded", failureCode) => ({ type: "execution_telemetry", event: `agent:turn_${outcome}`, props: { turn_id: turnId, duration_bucket: "gte30s", ...(failureCode ? { failure_code: failureCode } : {}) } });
const tool = (turnId, id, outcome = "succeeded") => ({ type: "execution_telemetry", telemetry_id: id, event: "agent:tool_executed", props: { turn_id: turnId, tool_category: "workflow_write", outcome, duration_bucket: "lt1s" } });
const started = (turnId, id) => ({ type: "execution_tool_started", turn_id: turnId, telemetry_id: id, tool_category: "workflow_write" });
const applied = (turnId) => ({ type: "execution_telemetry", event: "agent:result_applied", props: { turn_id: turnId } });
const names = (events) => events.map(({ event }) => event);
const bounded = (emitter, event) => once(emitter, event, { signal: AbortSignal.timeout(5000) });
const listen = async (server) => { const ready = bounded(server, "listening"); server.listen(0, "127.0.0.1"); await ready; return `http://127.0.0.1:${server.address().port}`; };
const close = async (server) => { const closed = bounded(server, "close"); server.close(); server.closeAllConnections(); await closed; };

// Exercise the actual HTTP transport, not a telemetry helper or panel replay.
{
	const captured = [];
	const bodies = [];
	const transport = createHttpTransport({ surface: "studio", capture: (event, props) => captured.push({ event, props }), now: () => 100,
		fetchImpl: async (_url, init) => {
			const body = JSON.parse(init.body); bodies.push(body);
			return new Response(encode(terminal(body.turn_id)) + encode({ type: "done" }));
		},
	});
	await transport.turn(request, () => {});
	assert.deepEqual(names(captured), ["agent:turn_requested", "agent:turn_succeeded"], "real transport owns requested and terminal");
	assert.deepEqual(captured[0].props, { surface: "studio", turn_id: bodies[0].turn_id });
	assert.match(bodies[0].turn_id, /^[a-f0-9]{32}$/);
	assert.deepEqual(captured[1].props, { turn_id: bodies[0].turn_id, duration_bucket: "lt1s" }, "browser measures the entire request, not server time");
	await transport.turn(request, () => {});
	assert.notEqual(bodies[0].turn_id, bodies[1].turn_id, "retry gets a fresh ID despite reusing session, prompt and model");
	assert.ok(!JSON.stringify(captured).includes("private"));
}

{
	const captured = [];
	const transport = createHttpTransport({ surface: "workflow", capture: (event, props) => captured.push({ event, props }),
		fetchImpl: async (_url, init) => {
			const { turn_id: id } = JSON.parse(init.body);
			const first = tool(id, "a".repeat(32));
			const frames = [
				{ type: "execution_telemetry", event: "project:saved", props: { object_count_bucket: "gte100" } },
				{ ...first, props: { ...first.props, outcome: "uncertain" } },
				{ ...first, telemetry_id: "private-call-id" },
				{ ...first, telemetry_id: ["a".repeat(32)] },
				{ ...terminal(id), props: { turn_id: id, duration_bucket: "private duration" } },
				terminal(id, "failed", "private failure"),
				{ ...applied(id), props: { turn_id: id, result: "private" } },
				{ ...first, props: { ...first.props, tool_category: "camera" } },
				{ ...first, props: { ...first.props, prompt: "private" } },
				tool("b".repeat(32), "c".repeat(32)),
				first, first, tool(id, "d".repeat(32)), applied(id), applied(id), terminal(id), terminal(id),
				terminal(id, "failed", "upstream"), tool(id, "e".repeat(32)),
			];
			return new Response(frames.map(encode).join(""));
		},
	});
	await transport.turn(request, () => {});
	assert.deepEqual(names(captured), ["agent:turn_requested", "agent:tool_executed", "agent:tool_executed", "agent:result_applied", "agent:turn_succeeded"], "validate frames; duplicate wire IDs collapse but two real same-category tools do not");
	assert.ok(captured.every(({ props }) => !Object.hasOwn(props, "telemetry_id")));
}

for (const [status, failureCode] of [[401, "auth"], [429, "rate_limited"], [503, "upstream"]]) {
	const captured = [];
	const transport = createHttpTransport({ capture: (event, props) => captured.push({ event, props }), fetchImpl: async () => new Response("private response", { status }) });
	await transport.turn(request, () => {});
	assert.deepEqual(names(captured), ["agent:turn_requested", "agent:turn_failed"]);
	assert.equal(captured[1].props.failure_code, failureCode);
}
{
	const captured = [];
	const error = new TypeError("private network refusal");
	const transport = createHttpTransport({ capture: (event, props) => captured.push({ event, props }), fetchImpl: async () => { throw error; } });
	await assert.rejects(transport.turn(request, () => {}), (caught) => caught === error);
	assert.deepEqual(names(captured), ["agent:turn_requested", "agent:turn_failed"]);
	assert.equal(captured[1].props.failure_code, "upstream");
}
for (const body of ["", encode({ type: "done" }), 'data: {"type":"execution_telemetry"']) {
	const captured = [];
	await createHttpTransport({ capture: (event, props) => captured.push({ event, props }), fetchImpl: async () => new Response(body) }).turn(request, () => {});
	assert.deepEqual(names(captured), ["agent:turn_requested"], "EOF/done without explicit outcome stays unresolved");
}

{
	const captured = [];
	const error = new TypeError("stream connection lost");
	const transport = createHttpTransport({ capture: (event, props) => captured.push({ event, props }), fetchImpl: async () => new Response(new ReadableStream({ start(controller) { controller.error(error); } })) });
	await assert.rejects(transport.turn(request, () => {}), (caught) => caught === error);
	assert.deepEqual(names(captured), ["agent:turn_requested"], "a broken in-flight SSE connection is unresolved, not a fabricated terminal");
}

for (const explicit of [true, false]) {
	const captured = [];
	const events = new EventEmitter();
	const controller = new AbortController();
	let stream;
	const ready = bounded(events, "tool");
	const transport = createHttpTransport({ capture: (event, props) => { captured.push({ event, props }); }, fetchImpl: async (_url, init) => {
		if (_url === "/agent/stop") return new Response('{"ok":true}');
		const id = JSON.parse(init.body).turn_id;
		return new Response(new ReadableStream({ start(value) {
			stream = value;
			value.enqueue(new TextEncoder().encode(encode(started(id, "f".repeat(32))) + encode({ type: "text.delta", text: "ready" })));
			init.signal.addEventListener("abort", () => value.error(new DOMException("Aborted", "AbortError")), { once: true });
		} }));
	} });
	const pending = transport.turn(request, (event) => { if (event.type === "text.delta") events.emit("tool"); }, controller.signal);
	const rejected = assert.rejects(pending, { name: "AbortError" });
	await ready;
	controller.abort(explicit ? "agent-stop" : undefined);
	if (explicit) await transport.stop(request.sessionId);
	await rejected;
	assert.deepEqual(names(captured), explicit ? ["agent:turn_requested", "agent:tool_executed", "agent:turn_cancelled"] : ["agent:turn_requested"], "explicit Stop is observed before SSE abort; disconnect is unresolved");
	if (explicit) { assert.equal(captured[1].props.outcome, "cancelled"); assert.equal(captured[2].props.failure_code, "aborted"); }
	assert.ok(stream);
}

// Randomness, clocks, capture callbacks and foreign error getters are advisory.
{
	const original = Object.getOwnPropertyDescriptor(globalThis, "crypto");
	try {
		Object.defineProperty(globalThis, "crypto", { configurable: true, get() { throw new Error("random unavailable"); } });
		let calls = 0;
		await createHttpTransport({ capture: () => { throw new Error("capture unavailable"); }, now: () => { throw new Error("clock unavailable"); }, fetchImpl: async () => { calls++; return new Response(encode({ type: "done" })); } }).turn(request, () => {});
		assert.equal(calls, 1);
	} finally { Object.defineProperty(globalThis, "crypto", original); }
	for (const capture of [() => { throw new Error("sink"); }, () => Promise.reject(new Error("sink"))]) {
		for (const now of [() => { throw new Error("clock"); }, () => Symbol("unavailable"), () => ({ valueOf() { throw new Error("clock getter"); } })]) {
			await createHttpTransport({ capture, now, fetchImpl: async (_url, init) => new Response(encode(terminal(JSON.parse(init.body).turn_id))) }).turn(request, () => {});
		}
	}
	const captured = [];
	const foreign = Object.defineProperty({}, "status", { get() { throw new Error("foreign getter"); } });
	await assert.rejects(createHttpTransport({ capture: (event, props) => captured.push({ event, props }), fetchImpl: async () => { throw foreign; } }).turn(request, () => {}), (error) => error === foreign);
	assert.equal(captured.at(-1).props.failure_code, "upstream");
}

// Real model HTTP/SSE -> Codex parser -> agent tools -> HTTP transport. A real
// canvas command supplies the mutation ack; generic accepted responses do not.
{
	let scenario = "success";
	let graph = { nodes: [], edges: [] };
	const canvas = createCanvasCommands({ store: { getGraph: () => graph, setGraph: (next) => { graph = next; } }, makeNode: (type, id, position) => ({ id, type, position, data: {} }), nodeSchemas: {} });
	const model = createServer(async (req, res) => {
		let text = ""; for await (const chunk of req) text += chunk;
		const input = JSON.parse(text).input;
		const hasOutput = input.some((item) => item.type === "function_call_output");
		res.writeHead(200, { "content-type": "text/event-stream" });
		if (!hasOutput) {
			const name = scenario === "unknown" ? "private_unknown_tool" : scenario === "failure" ? "update_workflow_node" : scenario === "read" ? "describe_workflow" : "add_workflow_node";
			const args = scenario === "parse" ? "{private malformed" : JSON.stringify({ type: "text", data: { prompt: "private payload" } });
			res.write(encode({ type: "response.output_item.done", item: { type: "function_call", call_id: "private-call", name, arguments: args } }));
			if (scenario === "success") res.write(encode({ type: "response.output_item.done", item: { type: "function_call", call_id: "private-call-2", name, arguments: args } }));
		}
		if (scenario !== "truncated") res.write(encode({ type: "response.completed", response: { status: "completed" } }));
		res.end();
	});
	const modelUrl = await listen(model);
	const codex = createCodexClient({ getAccessToken: async () => "fixture", getAccountId: async () => "fixture", fetch: (_url, init) => fetch(modelUrl, init) });
	let toolRelease;
	const liveHub = { command: async (name, args) => {
		if (scenario === "cancel") return toolRelease.promise;
		if (scenario === "disconnected") throw new Error("Live editor disconnected");
		return scenario === "accepted" ? { accepted: true } : canvas.handlers[name](args);
	} };
	const handler = createAgentHandler({ auth: { getAccessToken: async () => "fixture" }, codex, liveHub });
	const sidecar = createServer((req, res) => handler(req, res).catch((error) => { res.writeHead(500); res.end(error.message); }));
	const sidecarUrl = await listen(sidecar);
	try {
		for (scenario of ["success", "failure", "parse", "unknown", "disconnected", "read", "accepted", "truncated"]) {
			const captured = [];
			const wire = [];
			const transport = createHttpTransport({ surface: "workflow", capture: (event, props) => captured.push({ event, props }), fetchImpl: async (url, init) => {
				const response = await fetch(sidecarUrl + url, init);
				const copy = await response.clone().text(); wire.push(...[...copy.matchAll(/^data: (.+)$/gm)].map((match) => JSON.parse(match[1])));
				return response;
			} });
			await transport.turn({ ...request, sessionId: scenario }, () => {});
			const tools = captured.filter(({ event }) => event === "agent:tool_executed");
			assert.equal(tools.length, scenario === "success" ? 2 : 1, scenario);
			assert.ok(tools.every(({ props }) => props.outcome === (["failure", "parse", "unknown", "disconnected"].includes(scenario) ? "failed" : "succeeded")), scenario);
			if (["failure", "parse", "unknown", "disconnected"].includes(scenario)) assert.equal(captured.at(-1).props.failure_code, "tool_failed", scenario);
			else if (scenario === "truncated") assert.ok(!names(captured).some((name) => /^agent:turn_(succeeded|failed|cancelled)$/.test(name)), "truncated model stream cannot fabricate success");
			else assert.equal(captured.at(-1).event, "agent:turn_succeeded", scenario);
			assert.equal(captured.filter(({ event }) => event === "agent:result_applied").length, ["success", "truncated"].includes(scenario) ? 1 : 0, `${scenario}: only real mutation ack proves applied`);
			assert.ok(!JSON.stringify(captured).includes("private"));
			const toolFrames = wire.filter(({ event }) => event === "agent:tool_executed");
			assert.equal(new Set(toolFrames.map(({ telemetry_id }) => telemetry_id)).size, tools.length);
			assert.ok(toolFrames.every(({ telemetry_id }) => /^[a-f0-9]{32}$/.test(telemetry_id)));
			assert.ok(wire.every(({ event }) => event !== "agent:turn_requested"), "requested belongs to browser, not sidecar");
		}
		assert.ok(graph.nodes.length >= 2, "real canvas mutations were executed");
		scenario = "cancel";
		for (const throughTransport of [true, false]) {
			const captured = [];
			const events = new EventEmitter();
			const ready = bounded(events, "tool");
			toolRelease = Promise.withResolvers();
			let wireBody;
			const transport = createHttpTransport({ capture: (event, props) => captured.push({ event, props }), fetchImpl: async (url, init) => {
				const response = await fetch(sidecarUrl + url, init);
				if (url === "/agent/turn") wireBody = response.clone().text();
				return response;
			} });
			const sessionId = `cancel-${throughTransport}`;
			const pending = transport.turn({ ...request, sessionId }, (event) => { if (event.type === "tool.start") events.emit("tool"); });
			await ready;
			if (throughTransport) await transport.stop(sessionId);
			else await fetch(sidecarUrl + "/agent/stop", { method: "POST", body: JSON.stringify({ sessionId }) }).then((response) => response.json());
			toolRelease.resolve({ accepted: true });
			await pending;
			assert.deepEqual(names(captured), ["agent:turn_requested", "agent:tool_executed", "agent:turn_cancelled"]);
			assert.equal(captured[1].props.outcome, "cancelled");
			assert.equal(captured[2].props.failure_code, "aborted");
			const wire = [...(await wireBody).matchAll(/^data: (.+)$/gm)].map((match) => JSON.parse(match[1]));
			assert.equal(wire.find(({ event }) => event === "agent:tool_executed").props.outcome, "cancelled", "server observes the stopped tool too");
			assert.equal(wire.find(({ event }) => event === "agent:turn_cancelled").props.failure_code, "aborted");
		}
		scenario = "read";
		for (const turn_id of [undefined, "private-session", ["a".repeat(32)]]) {
			const response = await fetch(sidecarUrl + "/agent/turn", { method: "POST", body: JSON.stringify({ ...request, sessionId: `unobserved-${typeof turn_id}`, turn_id }) });
			const wire = await response.text();
			assert.ok(wire.includes('"type":"done"'));
			assert.ok(!wire.includes("execution_telemetry") && !wire.includes("execution_tool_started"), "missing/invalid browser IDs disable only telemetry");
		}
	} finally { await handler.close(); await close(sidecar); await close(model); }
}
console.log("PASS Agent execution: browser ownership, refusal, failure, cancellation, retry, frame validation/dedupe, applied ack and fake-model HTTP/SSE");

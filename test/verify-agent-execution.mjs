import assert from "node:assert/strict";
import { EventEmitter, once } from "node:events";
import { createServer } from "node:http";
import { zstdDecompressSync } from "node:zlib";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHttpTransport } from "../src/workflow/agent-client.js";
import { createAgentHandler } from "../bin/agent/agent-routes.mjs";
import { createCanvasCommands } from "../src/workflow/canvas-commands.js";

const request = { sessionId: "private-session", text: "private prompt /secret/file.png", model: "private-model" };
process.env.COZYCLAY_CONFIG_DIR = mkdtempSync(join(tmpdir(), "cozyclay-agent-config-"));
process.env.COZYCLAY_AGENT_SESSIONS_DIR = mkdtempSync(join(tmpdir(), "cozyclay-agent-sessions-"));
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
		const chunks = []; for await (const chunk of req) chunks.push(Buffer.from(chunk));
		const encoded = Buffer.concat(chunks);
		const text = req.headers["content-encoding"] === "zstd" ? zstdDecompressSync(encoded).toString("utf8") : encoded.toString("utf8");
		const body = JSON.parse(text);
		assert.equal(body.store, false, "the fixture receives pi's non-persisted Responses request");
		assert.ok(Array.isArray(body.input), "the fixture receives a Responses input array");
		const input = body.input;
		const hasOutput = input.some((item) => item.type === "function_call_output");
		if (!hasOutput) assert.ok(Array.isArray(body.tools) && body.tools.length > 0, "the fixture receives the Workflow tools");
		res.writeHead(200, { "content-type": "text/event-stream" });
		if (!hasOutput) {
			const name = scenario === "unknown" ? "private_unknown_tool" : scenario === "failure" ? "update_workflow_node" : scenario === "read" ? "describe_workflow" : "add_workflow_node";
			const args = scenario === "read" ? "{}" : scenario === "parse" ? "{private malformed" : JSON.stringify({ type: "text", data: { prompt: "private payload" } });
			res.write(encode({ type: "response.output_item.done", item: { type: "function_call", call_id: "private-call", name, arguments: args } }));
			if (scenario === "success") res.write(encode({ type: "response.output_item.done", item: { type: "function_call", call_id: "private-call-2", name, arguments: args } }));
		}
		if (scenario === "truncated" && hasOutput) return res.end();
		res.write(encode({ type: "response.completed", response: { status: "completed" } }));
		res.end();
	});
	const modelUrl = await listen(model);
	const fixtureToken = `e30.${Buffer.from(JSON.stringify({ "https://api.openai.com/auth": { chatgpt_account_id: "fixture" } })).toString("base64url")}.e30`;
	let toolRelease;
	const liveHub = { command: async (name, args) => {
		if (scenario === "cancel") return toolRelease.promise;
		if (scenario === "disconnected") throw new Error("Live editor disconnected");
		return scenario === "accepted" ? { accepted: true } : canvas.handlers[name](args);
	} };
	const auth = { getAccessToken: async () => fixtureToken, readStored: async () => ({ refresh_token: "fixture-refresh", access_token: fixtureToken, expires_at: Date.now() + 60 * 60 * 1000 }) };
	const handler = createAgentHandler({ auth, codexBaseUrl: modelUrl, liveHub });
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
			await transport.turn({ ...request, model: "gpt-6-astra", sessionId: scenario }, () => {});
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
			const pending = transport.turn({ ...request, model: "gpt-6-astra", sessionId }, (event) => { if (event.type === "tool.start") events.emit("tool"); });
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
// --- #379 / 16k (F2 pass 5 finding 4): on the REAL codex HTTP path, the
// quota frame must carry the ACTUAL response header values (proving the
// providers.mjs fetch seam reaches the runner with real headers) and must
// reach the browser BEFORE the model's own completion event is even sent —
// not merely appear first inside one all-at-once flush that happened to wait
// for the whole call. The model fixture deliberately withholds its
// `response.completed` (and the tool/text "done" that would end the turn)
// until this test releases it; the sidecar's SSE body is read incrementally
// (not `.text()`, which would hide exactly this timing) so we can observe
// the quota+text.delta frames arriving on the wire while the upstream model
// call is still deliberately blocked.
{
	const release = Promise.withResolvers();
	const model = createServer(async (req, res) => {
		res.writeHead(200, { "content-type": "text/event-stream", "x-quota-test-percent": "77" });
		res.flushHeaders();
		res.write(encode({ type: "response.output_item.added", output_index: 0, item: { type: "message" } }));
		res.write(encode({ type: "response.output_text.delta", output_index: 0, delta: "quota timing probe" }));
		await release.promise;
		res.write(encode({ type: "response.output_item.done", output_index: 0, item: { type: "message" } }));
		res.write(encode({ type: "response.completed", response: { status: "completed" } }));
		res.end();
	});
	const modelUrl = await listen(model);
	const fixtureToken = `e30.${Buffer.from(JSON.stringify({ "https://api.openai.com/auth": { chatgpt_account_id: "quota-fixture" } })).toString("base64url")}.e30`;
	const auth = { getAccessToken: async () => fixtureToken, readStored: async () => ({ refresh_token: "fixture-refresh", access_token: fixtureToken, expires_at: Date.now() + 60 * 60 * 1000 }) };
	const codex = { parseQuotaHeaders: (headers) => ({ planType: "Plus", primary: { usedPercent: Number(headers?.["x-quota-test-percent"] ?? -1), windowMinutes: null, resetAt: null }, credits: { hasCredits: true } }) };
	const handler = createAgentHandler({ auth, codex, codexBaseUrl: modelUrl, liveHub: { command: async () => ({ accepted: true }) } });
	const sidecar = createServer((req, res) => handler(req, res).catch((error) => { res.writeHead(500); res.end(error.message); }));
	const sidecarUrl = await listen(sidecar);
	const deadline = async (promise, label) => {
		let timer;
		try { return await Promise.race([promise, new Promise((_, reject) => { timer = setTimeout(() => reject(new Error(`${label} deadline`)), 5000); })]); }
		finally { clearTimeout(timer); }
	};
	try {
		const response = await fetch(`${sidecarUrl}/agent/turn`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ sessionId: "quota-timing", text: "hi", model: "gpt-6-astra" }) });
		const reader = response.body.getReader();
		const decoder = new TextDecoder();
		let buffer = "";
		const seenBeforeRelease = [];
		for (;;) {
			const { value, done } = await deadline(reader.read(), "sidecar SSE read");
			if (done) break;
			buffer += decoder.decode(value, { stream: true });
			const frames = [...buffer.matchAll(/^data: (.+)$/gm)].map((match) => JSON.parse(match[1]));
			for (const frame of frames) if (!seenBeforeRelease.some((seen) => seen === frame.type)) seenBeforeRelease.push(frame.type);
			if (frames.some((frame) => frame.type === "text.delta")) break; // release only after observing the early frames
		}
		const quotaFrame = [...buffer.matchAll(/^data: (.+)$/gm)].map((match) => JSON.parse(match[1])).find((frame) => frame.type === "quota");
		assert.ok(seenBeforeRelease.includes("quota"), `the quota frame arrived while the model call was still blocked: ${JSON.stringify(seenBeforeRelease)}`);
		assert.ok(seenBeforeRelease.includes("text.delta"), `the text.delta arrived while the model call was still blocked: ${JSON.stringify(seenBeforeRelease)}`);
		assert.equal(seenBeforeRelease.indexOf("quota") < seenBeforeRelease.indexOf("text.delta"), true, `the quota frame precedes the first text.delta: ${JSON.stringify(seenBeforeRelease)}`);
		assert.equal(quotaFrame?.primary?.usedPercent, 77, "the quota frame carries the real parsed codex response header value, not a null default");
		release.resolve();
		// Drain the rest of the (now-released) stream so the server and sidecar close cleanly.
		for (;;) { const { done } = await deadline(reader.read(), "sidecar SSE drain"); if (done) break; }
	} finally { release.resolve(); await handler.close(); await close(sidecar); await close(model); }
	console.log("PASS 16k: the codex HTTP path's quota frame carries real header values and arrives before the model call completes");
}

// #379 / 16v: one handler registry must carry discovery from listing into every
// execution surface, including runners created before and after discovery.
{
	const liveId = "gpt-16v-live-only";
	const token = `e30.${Buffer.from(JSON.stringify({ "https://api.openai.com/auth": { chatgpt_account_id: "16v-fixture" } })).toString("base64url")}.e30`;
	const auth = {
		getAccessToken: async () => token,
		readStored: () => ({ access_token: token, refresh_token: "16v-refresh", expires_at: Date.now() + 3600000 }),
		status: () => ({ signedIn: true }),
	};
	const received = [];
	const fixture = createServer(async (req, res) => {
		if (req.method !== "POST") { res.writeHead(404); res.end(); return; }
		const chunks = []; for await (const chunk of req) chunks.push(Buffer.from(chunk));
		const encoded = Buffer.concat(chunks);
		const body = JSON.parse(req.headers["content-encoding"] === "zstd" ? zstdDecompressSync(encoded) : encoded);
		received.push(body.model);
		res.writeHead(200, { "content-type": "text/event-stream" });
		res.end(`data: ${JSON.stringify({ type: "response.completed", response: { status: "completed" } })}\n\n`);
	});
	const fixtureUrl = await listen(fixture);
	const codex = {
		listModels: async () => [{ slug: liveId, supported_reasoning_levels: ["medium"] }],
		parseQuotaHeaders: () => ({ primary: {}, credits: {} }),
	};
	const studioRuntime = { readContext: async () => (await import("./verify-studio-agent-protocol.mjs")).contextFixture() };
	const liveHub = { workspaceId: () => "tab-7", resolveWorkspace: () => "handle-12", command: async () => ({}) };
	const handler = createAgentHandler({ auth, codex, codexBaseUrl: fixtureUrl, handlers: [], liveHub, studioRuntime });
	const sidecar = createServer((req, res) => handler(req, res).catch((error) => { if (!res.headersSent) res.writeHead(500); res.end(error.message); }));
	const sidecarUrl = await listen(sidecar);
	const workflowTurn = async (sessionId, model) => {
		const response = await fetch(`${sidecarUrl}/agent/turn`, { method: "POST", headers: { origin: sidecarUrl, "content-type": "application/json" }, body: JSON.stringify({ sessionId, text: "hello", model }), signal: AbortSignal.timeout(8000) });
		const text = await response.text();
		return { response, frames: [...text.matchAll(/^data: (.+)$/gm)].map((match) => JSON.parse(match[1])), text };
	};
	const studioTurn = async (sessionId, turnId) => {
		const context = (await import("./verify-studio-agent-protocol.mjs")).contextFixture();
		const response = await fetch(`${sidecarUrl}/agent/turn`, { method: "POST", headers: { origin: sidecarUrl, "content-type": "application/json" }, body: JSON.stringify({ surface: "studio", sessionId, turnId, text: "inspect selection", model: `openai-codex/${liveId}`, context }), signal: AbortSignal.timeout(8000) });
		const text = await response.text();
		return { response, frames: [...text.matchAll(/^data: (.+)$/gm)].map((match) => JSON.parse(match[1])), text };
	};
	try {
		const warm = await workflowTurn("16v-workflow", "gpt-6-astra");
		assert.equal(warm.response.status, 200);
		assert.equal(warm.frames.some((frame) => frame.type === "error"), false, "the static Workflow turn warms the execution registry");
		const catalogueResponse = await fetch(`${sidecarUrl}/agent/models`, { signal: AbortSignal.timeout(8000) });
		const catalogue = await catalogueResponse.json();
		assert.equal(catalogueResponse.status, 200);
		assert.ok(catalogue.models.some((model) => model.id === `openai-codex/${liveId}`), "GET /agent/models advertises the live-only slug");
		for (const [sessionId, turnId] of [["16v-workflow", null], ["00000000-0000-4000-8000-000000000103", "00000000-0000-4000-8000-000000000101"], ["00000000-0000-4000-8000-000000000104", "00000000-0000-4000-8000-000000000102"]]) {
			const result = turnId ? await studioTurn(sessionId, turnId) : await workflowTurn(sessionId, `openai-codex/${liveId}`);
			assert.equal(result.response.status, 200);
			assert.equal(result.frames.some((frame) => frame.type === "error" && frame.code === "UNKNOWN_MODEL"), false, `${sessionId} resolves the advertised live-only slug`);
			assert.equal(result.frames.at(-1)?.type, "done", `${sessionId} reaches a terminal done frame`);
		}
		assert.deepEqual(received, ["gpt-6-astra", liveId, liveId, liveId], "static, Workflow and both Studio turns reach the Codex fixture");
		console.log("PASS 16v: one handler registry carries live Codex discovery into Workflow and Studio execution");
	} finally { await handler.close(); await close(sidecar); await close(fixture); }
}

// #379 / 16m: identity changes retire the handler's catalogue registry too.
{
	let identity = "a";
	let onAuthChange;
	const calls = [];
	const token = () => `e30.${Buffer.from(JSON.stringify({ "https://api.openai.com/auth": { chatgpt_account_id: identity } })).toString("base64url")}.e30`;
	const auth = {
		getAccessToken: async () => identity ? token() : null,
		readStored: () => identity ? ({ access_token: token(), refresh_token: "fixture-refresh", expires_at: Date.now() + 3600000 }) : undefined,
		status: () => ({ signedIn: !!identity }),
		onAuthChange: callback => { onAuthChange = callback; return () => {}; },
	};
	const codex = { listModels: async () => { calls.push(identity); return [{ slug: `gpt-16m-${identity}`, supported_reasoning_levels: ["medium"] }]; } };
	const handler = createAgentHandler({ auth, codex, handlers: [], liveHub: {} });
	const server = createServer((req, res) => handler(req, res).catch(error => { if (!res.headersSent) res.writeHead(500); res.end(error.message); }));
	const origin = await listen(server);
	const getModels = async () => {
		const response = await fetch(`${origin}/agent/models`, { signal: AbortSignal.timeout(8000) });
		return { status: response.status, models: (await response.json()).models.filter(model => model.id.includes("gpt-16m")).map(model => model.id) };
	};
	try {
		const accountA = await getModels();
		assert.deepEqual(accountA.models, ["openai-codex/gpt-16m-a"]);
		assert.deepEqual(calls, ["a"]);
		identity = null;
		onAuthChange({ kind: "signed_out" });
		const signedOut = await getModels();
		assert.deepEqual(signedOut.models, [], "sign-out drops the previous account's live-only model");
		assert.deepEqual(calls, ["a"], "sign-out does not fetch a catalogue");
		identity = "b";
		onAuthChange({ kind: "replaced" });
		const accountB = await getModels();
		assert.deepEqual(accountB.models, ["openai-codex/gpt-16m-b"], "account replacement rebuilds the live catalogue registry");
		assert.deepEqual(calls, ["a", "b"], "account replacement fetches exactly the new account's catalogue");
		console.log("PASS 16m: identity changes rebuild the handler's catalogue registry");
	} finally { await handler.close(); await close(server); }
}

console.log("PASS Agent execution: browser ownership, refusal, failure, cancellation, retry, frame validation/dedupe, applied ack and fake-model HTTP/SSE");

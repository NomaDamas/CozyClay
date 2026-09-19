#!/usr/bin/env node
// Start plain Vite with COZYCLAY_LIVE_PORT=5194 on port 5254, then:
// QA_URL=http://127.0.0.1:5254/workflow/ CDP_PORT=9493 COZYCLAY_LIVE_PORT=5194
// node tools/qa-browser.mjs -- node test/qa-execution-outcomes-browser.mjs
// Only the SDK and model are fakes; the browser, sanitizer, Agent HTTP/SSE,
// MCP stdio server, WebSocket hub and editor mutations are real.
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { createRequire } from "node:module";
import { mkdir, writeFile } from "node:fs/promises";
import { startLiveHub } from "../mcp/live-hub.mjs";
import { createAgentHandler } from "../bin/agent/agent-routes.mjs";
import { createFakeModel } from "./fixtures/fake-model.mjs";
import { fauxAssistantMessage, fauxText, fauxToolCall } from "@earendil-works/pi-ai/providers/faux";
const requireMcp = createRequire(new URL("../mcp/package.json", import.meta.url));
const { Client } = requireMcp("@modelcontextprotocol/sdk/client/index.js");
const { StdioClientTransport } = requireMcp("@modelcontextprotocol/sdk/client/stdio.js");

const cdpPort = Number(process.env.CDP_PORT || 9493);
const livePort = Number(process.env.COZYCLAY_LIVE_PORT || 5194);
const origin = new URL(process.env.QA_URL || "http://127.0.0.1:5254/workflow/").origin;
const out = process.env.QA_OUT || "/tmp/cozyclay-execution-outcomes";
const timeout = 60_000;
await mkdir(out, { recursive: true });
const target = (await (await fetch(`http://127.0.0.1:${cdpPort}/json`)).json()).find((entry) => entry.type === "page" && entry.webSocketDebuggerUrl);
assert.ok(target, "QA Chrome has no page target");
const ws = new WebSocket(target.webSocketDebuggerUrl);
await new Promise((resolve, reject) => { ws.onopen = resolve; ws.onerror = reject; });
const pending = new Map(), listeners = new Map();
const events = [], errors = [], checks = [], networkFailures = [], blocked = [], diagnostics = [];
let sequence = 0;
ws.onmessage = ({ data }) => {
	const message = JSON.parse(data);
	if (message.id && pending.has(message.id)) {
		const item = pending.get(message.id);
		pending.delete(message.id); clearTimeout(item.timer);
		if (message.error) item.reject(new Error(JSON.stringify(message.error))); else item.resolve(message.result);
		return;
	}
	if (message.method === "Runtime.bindingCalled" && message.params.name === "__qaExecutionRecord") events.push(JSON.parse(message.params.payload));
	if (message.method === "Runtime.exceptionThrown") errors.push(message.params.exceptionDetails.exception?.description || message.params.exceptionDetails.text);
	if (message.method === "Network.loadingFailed") networkFailures.push(message.params);
	if (message.method === "Log.entryAdded" && message.params.entry.level === "error") diagnostics.push(message.params.entry.text);
	for (const listener of listeners.get(message.method) || []) listener(message.params);
};
const send = (method, params = {}) => new Promise((resolve, reject) => {
	const id = ++sequence;
	const timer = setTimeout(() => { pending.delete(id); reject(new Error(`CDP timeout: ${method}`)); }, timeout + 5000);
	pending.set(id, { resolve, reject, timer });
	ws.send(JSON.stringify({ id, method, params }));
});
const on = (method, listener) => {
	const set = listeners.get(method) || new Set(); listeners.set(method, set); set.add(listener);
	return () => set.delete(listener);
};
const once = (method, predicate = () => true) => new Promise((resolve, reject) => {
	const timer = setTimeout(() => { off(); reject(new Error(`Missing CDP event: ${method}`)); }, timeout);
	const off = on(method, (params) => { if (predicate(params)) { off(); clearTimeout(timer); resolve(params); } });
});
const evaluate = async (expression) => {
	const result = await send("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true, timeout });
	if (result.exceptionDetails) throw new Error(result.exceptionDetails.exception?.description || result.exceptionDetails.text);
	return result.result?.value;
};
const navigate = async (path) => {
	const loaded = once("Page.loadEventFired");
	await send("Page.navigate", { url: `${origin}${path}` }); await loaded;
};
const waitState = (expression, label) => evaluate(`window.__qaExecution.wait(() => (${expression}), ${JSON.stringify(label)})`);
const screenshot = async (name) => {
	await writeFile(`${out}/${name}.png`, Buffer.from((await send("Page.captureScreenshot", { format: "png" })).data, "base64"));
};
const pass = (message) => { checks.push(message); console.log(`PASS ${message}`); };
async function click(selector) {
	const point = await evaluate(`(() => { const element=document.querySelector(${JSON.stringify(selector)});
		if (!element || element.disabled) throw new Error("Missing/enabled control: " + ${JSON.stringify(selector)});
		const r=element.getBoundingClientRect(); return {x:r.x+r.width/2,y:r.y+r.height/2}; })()`);
	for (const type of ["mousePressed", "mouseReleased"]) await send("Input.dispatchMouseEvent", { type, ...point, button: "left", clickCount: 1 });
}
function installFixture() {
	const bus = new EventTarget();
	window.__qaExecution = {
		events: [], signal: () => bus.dispatchEvent(new Event("change")),
		wait(predicate, label) {
			return new Promise((resolve, reject) => {
				const finish = (error, value) => { clearTimeout(timer); observer.disconnect(); bus.removeEventListener("change", check); error ? reject(error) : resolve(value); };
				const check = () => { try { const value = predicate(); if (value) finish(null, value); } catch (error) { finish(error); } };
				const observer = new MutationObserver(check);
				const timer = setTimeout(() => finish(new Error(`Timed out: ${label}`)), 60_000);
				observer.observe(document, { subtree: true, childList: true, attributes: true, characterData: true });
				bus.addEventListener("change", check); check();
			});
		},
	};
	window.addEventListener("cozyclay:mcp-rig-ready", () => { window.__qaExecution.signal(); window.parent.__qaExecution?.signal(); });
	let beforeSend = (event) => event;
	window.__qaPosthog = {
		init(_key, options) { beforeSend = options.before_send; }, register() {},
		// Deliberately NOT suppressing capture here: the real analytics gate
		// must stop it, otherwise the opt-out assertion would be tautological.
		opt_in_capturing() {}, opt_out_capturing() {}, get_distinct_id: () => "qa",
		capture(event, properties = {}) {
			const value = beforeSend({ event, properties });
			if (!value) return;
			window.__qaExecution.events.push(value); window.__qaExecution.signal();
			window.__qaExecutionRecord(JSON.stringify({ ...value, surface: location.pathname }));
		},
	};
	if (window === window.top && location.pathname === "/workflow/") {
		localStorage.setItem("cozyclay.locale", "en");
		localStorage.setItem("cozyclay.project-session.v1", JSON.stringify({ name: "QA" }));
		localStorage.setItem("cozyclay.workflow.v1", JSON.stringify({
			version: 1, nodes: [{ id: "qa-scene", type: "scene", position: { x: 40, y: 40 }, data: { preview: "scene", status: "idle" } }], edges: [],
		}));
	}
}

const hub = await startLiveHub(livePort);
assert.ok(hub, `QA must own live port ${livePort}; do not start dev-full`);
const auth = { getAccessToken: async () => "qa-token" };
const fakeModel = createFakeModel({ provider: "openai-codex", modelId: "gpt-6-astra", modelName: "QA model" });
fakeModel.fauxProvider.setResponses([
	async () => fauxAssistantMessage([fauxToolCall("add_workflow_node", { type: "text", data: { prompt: "PRIVATE_TOOL_ARGUMENT" } }, { id: "qa-call" })]),
	async () => fauxAssistantMessage([fauxText("QA model completed.")]),
]);
const codex = {
	parseQuotaHeaders: () => ({ planType: "Plus", primary: {}, credits: {} }),
	listModels: async () => ["qa-model"],
};
const agent = createAgentHandler({ auth, codex, models: fakeModel.models, fauxProvider: fakeModel.fauxProvider, handlers: [], liveHub: hub });
const http = createServer(async (request, response) => {
	try {
		if (request.url === "/oauth/status") {
			response.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ signedIn: true, email: "qa@example.invalid", plan: "Plus" }));
		} else if (!await agent(request, response)) response.writeHead(404).end();
	} catch (error) { response.writeHead(500).end(error.message); }
});
await new Promise((resolve) => http.listen(0, "127.0.0.1", resolve));
let mcp;
on("Fetch.requestPaused", (request) => {
	void (async () => {
		const url = new URL(request.request.url);
		const path = url.pathname;
		if (url.hostname === "cdn.jsdelivr.net") {
			// Vite's existing Three helpers load library modules and font data
			// from this static CDN. These are not analytics or model requests.
			await send("Fetch.continueRequest", { requestId: request.requestId });
		} else if (url.origin !== origin) {
			blocked.push(url.href);
			await send("Fetch.failRequest", { requestId: request.requestId, errorReason: "BlockedByClient" });
		} else if (path === "/src/analytics.js") {
			const result = await send("Fetch.getResponseBody", { requestId: request.requestId });
			let source = result.base64Encoded ? Buffer.from(result.body, "base64").toString() : result.body;
			assert.ok(source.includes("return import.meta.env ?? {};"), "analytics environment seam exists");
			assert.match(source, /await import\([^)]*posthog[^)]*\)/);
			source = source.replace("return import.meta.env ?? {};", "window.__qaExecution.analyticsUrl=import.meta.url; return { PROD:true, VITE_POSTHOG_KEY:'qa', VITE_POSTHOG_ALLOWED_ORIGINS:location.origin };")
				.replace(/await import\([^)]*posthog[^)]*\)/, "await Promise.resolve({default:window.__qaPosthog})");
			await send("Fetch.fulfillRequest", { requestId: request.requestId, responseCode: 200, responseHeaders: [{ name: "Content-Type", value: "text/javascript" }], body: Buffer.from(source).toString("base64") });
		} else if (path.startsWith("/agent/") || path.startsWith("/oauth/")) {
			const response = await fetch(`http://127.0.0.1:${http.address().port}${path}`, {
				method: request.request.method, headers: { "content-type": "application/json" }, body: request.request.postData,
			});
			await send("Fetch.fulfillRequest", { requestId: request.requestId, responseCode: response.status, responseHeaders: [{ name: "Content-Type", value: response.headers.get("content-type") || "application/json" }], body: Buffer.from(await response.arrayBuffer()).toString("base64") });
		} else await send("Fetch.continueRequest", { requestId: request.requestId });
	})().catch(async (error) => { errors.push(error.stack); await send("Fetch.failRequest", { requestId: request.requestId, errorReason: "Failed" }).catch(() => {}); });
});
try {
	await send("Page.enable"); await send("Runtime.enable"); await send("Network.enable"); await send("Log.enable");
	await send("Network.setCacheDisabled", { cacheDisabled: true });
	await send("Runtime.addBinding", { name: "__qaExecutionRecord" });
	await send("Page.addScriptToEvaluateOnNewDocument", { source: `(${installFixture})();` });
	await send("Fetch.enable", { patterns: [
		{ urlPattern: "https://*", requestStage: "Request" },
		{ urlPattern: "*/src/analytics.js*", requestStage: "Response" },
		{ urlPattern: "*/agent/*", requestStage: "Request" }, { urlPattern: "*/oauth/*", requestStage: "Request" },
	] });
	await send("Emulation.setDeviceMetricsOverride", { width: 1440, height: 900, deviceScaleFactor: 1, mobile: false });
	await navigate("/workflow/");
	await waitState("window.__cozyclayWorkflow && window.__qaExecution.events.some(e=>e.event==='$pageview')", "Workflow SDK ready");
	await waitState("document.querySelector('iframe')?.contentWindow.__cozyclayMcpRigReady?.includes('char-a')", "embedded rig ready");
	await evaluate("window.__cozyclayWorkflow.run().then(r=>({outputs:r.outputs.length}))");
	const workflowEvents = await evaluate("window.__qaExecution.events.filter(e=>e.event.startsWith('workflow:'))");
	assert.deepEqual(workflowEvents.map((entry) => entry.event), ["workflow:run_requested", "workflow:result_applied", "workflow:run_succeeded"]);
	assert.equal(new Set(workflowEvents.map((entry) => entry.properties.run_id)).size, 1);
	pass("Workflow requested, captured output applied and succeeded through real sanitizer");
	await screenshot("workflow-desktop");

	await waitState("document.querySelector('.agent-input') && !document.querySelector('.agent-input').disabled", "Agent ready");
	await click(".agent-input");
	await send("Input.insertText", { text: "PRIVATE_USER_PROMPT" });
	await waitState("document.querySelector('.agent-send')?.disabled===false", "Send enabled");
	await evaluate("window.__qaExecution.turnDone=window.__qaExecution.wait(()=>window.__qaExecution.events.some(e=>/^agent:turn_(succeeded|failed|cancelled)$/.test(e.event)),'Agent terminal'); true");
	// Workflow's success toast temporarily covers the bottom-right Send button.
	// Enter uses the actual composer handler without waiting for a toast timer.
	await click(".agent-input");
	await send("Input.dispatchKeyEvent", { type: "keyDown", key: "Enter", code: "Enter", windowsVirtualKeyCode: 13 });
	await send("Input.dispatchKeyEvent", { type: "keyUp", key: "Enter", code: "Enter", windowsVirtualKeyCode: 13 });
	await evaluate("window.__qaExecution.turnDone");
	const agentEvents = await evaluate("window.__qaExecution.events.filter(e=>e.event.startsWith('agent:'))");
	assert.deepEqual(agentEvents.map((entry) => entry.event), ["agent:turn_requested", "agent:result_applied", "agent:tool_executed", "agent:turn_succeeded"]);
	assert.equal(agentEvents[2].properties.tool_category, "workflow_write");
	assert.equal(await evaluate("window.__cozyclayWorkflow.getGraph().nodes.length"), 2);
	pass("real Agent HTTP/SSE fake-model turn applies one canvas node without duplicating Workflow run");
	await screenshot("agent-desktop");
	await send("Emulation.setDeviceMetricsOverride", { width: 390, height: 844, deviceScaleFactor: 1, mobile: true });
	await screenshot("workflow-mobile");

	// Use the public analytics opt-out API, not the fake SDK's own gate.
	await evaluate("import(window.__qaExecution.analyticsUrl).then(m=>m.setAnalyticsOptOut(true))");
	const beforeOptOut = await evaluate("window.__qaExecution.events.length");
	await evaluate("window.__cozyclayWorkflow.run().then(()=>true)");
	assert.equal(await evaluate("window.__qaExecution.events.length"), beforeOptOut);
	await click(".agent-input");
	await send("Input.insertText", { text: "PRIVATE_OPTOUT_PROMPT" });
	await evaluate("window.__qaExecution.optedTurn=window.__qaExecution.wait(()=>document.querySelectorAll('.agent-row.user').length===2 && !document.querySelector('.agent-send.stop'),'opted-out Agent completion'); true");
	await send("Input.dispatchKeyEvent", { type: "keyDown", key: "Enter", code: "Enter", windowsVirtualKeyCode: 13 });
	await send("Input.dispatchKeyEvent", { type: "keyUp", key: "Enter", code: "Enter", windowsVirtualKeyCode: 13 });
	await evaluate("window.__qaExecution.optedTurn");
	assert.equal(await evaluate("window.__qaExecution.events.length"), beforeOptOut);
	await evaluate("import(window.__qaExecution.analyticsUrl).then(m=>m.setAnalyticsOptOut(false))");
	pass("opt-out suppresses Workflow and Agent analytics while execution completes");

	// Stop our Agent-owned hub before the actual MCP stdio process owns it.
	await navigate("/favicon.ico");
	await agent.close();
	mcp = new Client({ name: "execution-qa", version: "1" });
	await mcp.connect(new StdioClientTransport({
		command: process.execPath, args: [new URL("../mcp/server.mjs", import.meta.url).pathname, "--live-port", String(livePort)],
		env: { ...process.env }, stderr: "pipe",
	}));
	const workspace = once("Network.webSocketFrameReceived", (params) => {
		try { return JSON.parse(params.response.payloadData).type === "workspace"; } catch { return false; }
	});
	await send("Emulation.setDeviceMetricsOverride", { width: 1440, height: 900, deviceScaleFactor: 1, mobile: false });
	await navigate("/app/");
	const handle = JSON.parse((await workspace).response.payloadData).handle;
	await waitState("window.__cozyclay && window.__qaExecution.events.some(e=>e.event==='$pageview')", "Studio SDK ready");
	await waitState("window.__cozyclayMcpRigReady?.includes('char-a')", "Studio rig ready");
	const call = (name, args = {}) => mcp.callTool({ name, arguments: { ...args, workspace_handle: handle } });
	const baseline = await evaluate("window.__qaExecution.events.length");
	await evaluate("window.__qaExecution.applied=window.__qaExecution.wait(()=>window.__qaExecution.events.some(e=>e.event==='mcp:result_applied'),'MCP applied'); true");
	const result = await call("place_object", { kind: "cube", name: "PRIVATE_OBJECT", x: 1 });
	assert.ok(!result.isError, JSON.stringify(result));
	await evaluate("window.__qaExecution.applied");
	const mcpEvents = await evaluate(`window.__qaExecution.events.slice(${baseline}).filter(e=>e.event.startsWith('mcp:'))`);
	assert.equal(mcpEvents.filter((entry) => entry.event === "mcp:tool_requested").length, 1);
	assert.equal(mcpEvents.filter((entry) => entry.event === "mcp:tool_executed" && entry.properties.outcome === "succeeded").length, 1);
	assert.equal(mcpEvents.filter((entry) => entry.event === "mcp:result_applied").length, 1);
	assert.equal(new Set(mcpEvents.map((entry) => entry.properties.request_id)).size, 1);
	assert.equal(await evaluate("window.__qaExecution.events.filter(e=>e.event==='craft:first_edit').length"), 1);
	await call("describe_scene");
	assert.equal(await evaluate("window.__qaExecution.events.filter(e=>e.event==='craft:first_edit').length"), 1);
	pass("real MCP stdio/hub mutation applied with one shared first-edit after UI echo");
	await screenshot("mcp-studio-desktop");
	await evaluate("import(window.__qaExecution.analyticsUrl).then(m=>m.setAnalyticsOptOut(true))");
	const beforeMcpOptOut = await evaluate("window.__qaExecution.events.length");
	await call("place_object", { kind: "sphere", x: -1 });
	assert.equal(await evaluate("window.__qaExecution.events.length"), beforeMcpOptOut);
	pass("opted-out connected editor still executes MCP but captures no telemetry");
	for (const entry of [...workflowEvents, ...agentEvents, ...mcpEvents]) {
		const props = entry.properties;
		assert.match(props.run_id || props.turn_id || props.request_id, /^[a-f0-9]{32}$/);
		assert.doesNotMatch(JSON.stringify(props), /PRIVATE|prompt|arguments|filename|telemetry_id|call_id/);
	}
	assert.deepEqual(errors, []);
	await writeFile(`${out}/events.json`, JSON.stringify({ checks, workflowEvents, agentEvents, mcpEvents, errors, events }, null, 2));
	console.log(`QA_EXECUTION_OUTCOMES PASS; evidence ${out}/events.json`);
} catch (error) {
	const state = await evaluate("({ events:window.__qaExecution?.events, panel:document.querySelector('.agent-panel')?.dataset.agentState, transcript:document.querySelector('.agent-transcript')?.textContent, iframe:document.querySelector('iframe')?.contentDocument?.body?.textContent, iframeEvents:document.querySelector('iframe')?.contentWindow.__qaExecution?.events })").catch(() => null);
	await screenshot("failure").catch(() => {});
	await writeFile(`${out}/failure.json`, JSON.stringify({ error: error.stack, errors, state, events, networkFailures, blocked, diagnostics }, null, 2));
	console.error(JSON.stringify({ errors, state, blocked, diagnostics }));
	throw error;
} finally {
	await mcp?.close().catch(() => {});
	http.closeAllConnections(); await new Promise((resolve) => http.close(resolve));
	if (hub.server.address()) await agent.close();
	ws.close();
}

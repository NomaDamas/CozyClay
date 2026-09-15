#!/usr/bin/env node
// #273: prompt authoring is not generation demand. Start Vite separately.
// QA_URL=http://127.0.0.1:5254/app/ CDP_PORT=9493 QA_SCREENSHOT=/tmp/motion-intent.png \
//   node tools/qa-browser.mjs -- node test/qa-motion-intent-browser.mjs
// Requires DEV Vite + the wrapper's isolated Chrome profile; owns neither server
// nor Chrome. Uses Node's built-in CDP WebSocket, with no additional dependencies.
// Like qa-export-lifecycle-browser.mjs, replace only analytics environment()/SDK
// import: real track(), lifecycle and sanitizer run against an in-memory SDK spy.
// This proves the sanitized capture boundary, NOT production PostHog delivery.
// The optional MCP socket is an in-page transport fixture: createLiveControl's
// real dispatcher and App handlers run, but this does not test the external hub.
// Missing-backend Generate can remain disabled (readiness UX is out of scope).
// In that case use the supported __cozyclay.runArdy hook and report the fallback;
// never remove disabled, invoke React internals, or call a disabled DOM handler.
import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import { dirname } from "node:path";

const url = new URL(process.env.QA_URL || "http://127.0.0.1:5254/app/");
const port = Number(process.env.CDP_PORT || 9493);
const screenshotPath = process.env.QA_SCREENSHOT || null;
const timeoutMs = 60_000;
const targets = await (await fetch(`http://127.0.0.1:${port}/json`, { signal: AbortSignal.timeout(timeoutMs) })).json();
const page = targets.find((target) => target.type === "page" && target.url.startsWith(url.origin) && target.webSocketDebuggerUrl);
assert.ok(page, `No QA page for ${url.origin} on CDP port ${port}; run through tools/qa-browser.mjs`);
const ws = new WebSocket(page.webSocketDebuggerUrl);
let nextId = 0;
const pending = new Map();
const listeners = new Map();
const routeTasks = new Set();
const routeErrors = [];
const pageErrors = [];
const checks = [];
const requests = { health: 0, generate: 0, unexpectedArdy: [], telemetry: [] };
let routedAnalytics = 0;
let fixtureId;
let screenshotSaved = false;

function subscribe(method, listener) {
	const group = listeners.get(method) || new Set();
	listeners.set(method, group);
	group.add(listener);
	return () => group.delete(listener);
}
function once(method) {
	let remove;
	let timer;
	const promise = new Promise((resolve, reject) => {
		remove = subscribe(method, (value) => { clearTimeout(timer); remove(); resolve(value); });
		timer = setTimeout(() => { remove(); reject(new Error(`Missing CDP event: ${method}`)); }, timeoutMs);
	});
	// A trigger can fail before its previously installed subscription is awaited.
	promise.catch(() => {});
	return { promise, cancel() { clearTimeout(timer); remove(); } };
}
function send(method, params = {}) {
	return new Promise((resolve, reject) => {
		const id = ++nextId;
		const timer = setTimeout(() => { pending.delete(id); reject(new Error(`CDP timed out: ${method}`)); }, timeoutMs + 5000);
		pending.set(id, { resolve, reject, timer });
		ws.send(JSON.stringify({ id, method, params }));
	});
}
ws.onmessage = ({ data }) => {
	const message = JSON.parse(data);
	if (message.id && pending.has(message.id)) {
		const item = pending.get(message.id);
		pending.delete(message.id);
		clearTimeout(item.timer);
		if (message.error) item.reject(new Error(JSON.stringify(message.error)));
		else item.resolve(message.result);
		return;
	}
	for (const listener of listeners.get(message.method) || []) listener(message.params);
};
subscribe("Runtime.exceptionThrown", ({ exceptionDetails }) => {
	pageErrors.push(exceptionDetails.exception?.description || exceptionDetails.text);
});
async function evaluate(expression) {
	const result = await send("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true, timeout: timeoutMs });
	if (result.exceptionDetails) throw new Error(result.exceptionDetails.exception?.description || result.exceptionDetails.text);
	return result.result?.value;
}
async function navigate(destination) {
	const loaded = once("Page.loadEventFired");
	try { await send("Page.navigate", { url: destination }); await loaded.promise; }
	finally { loaded.cancel(); }
}
const waitState = (expression, label) => evaluate(`window.__qaMotion.wait(() => (${expression}), ${JSON.stringify(label)})`);
async function changeAndWait(expression, action, label) {
	await evaluate(`window.__qaMotion.pendingState = window.__qaMotion.wait(() => (${expression}), ${JSON.stringify(label)}); window.__qaMotion.pendingState.catch(() => {}); true`);
	await action();
	await evaluate("window.__qaMotion.pendingState");
}
async function click(selector) {
	const position = await evaluate(`(() => {
		const element = document.querySelector(${JSON.stringify(selector)});
		if (!element || element.disabled || element.getAttribute('aria-disabled') === 'true') throw new Error('Missing or disabled control: ' + ${JSON.stringify(selector)});
		element.scrollIntoView({ block: 'center', inline: 'center', behavior: 'instant' });
		const rect = element.getBoundingClientRect();
		if (!rect.width || !rect.height) throw new Error('Invisible control: ' + ${JSON.stringify(selector)});
		const x = rect.x + rect.width / 2, y = rect.y + rect.height / 2;
		if (!element.contains(document.elementFromPoint(x, y))) throw new Error('Control is covered: ' + ${JSON.stringify(selector)});
		return { x, y };
	})()`);
	for (const type of ["mousePressed", "mouseReleased"]) {
		await send("Input.dispatchMouseEvent", { type, ...position, button: "left", buttons: type === "mousePressed" ? 1 : 0, clickCount: 1 });
	}
}
async function typeInto(selector, text) {
	await click(selector);
	// Select existing text, then use Chrome's real text-input path (React onChange).
	await evaluate(`document.querySelector(${JSON.stringify(selector)}).select()`);
	await send("Input.insertText", { text });
}
function pass(label, detail = {}) {
	checks.push({ label, ...detail });
	console.log(`PASS ${label} ${JSON.stringify(detail)}`);
}
async function screenshot() {
	if (!screenshotPath) return;
	await mkdir(dirname(screenshotPath), { recursive: true });
	const image = await send("Page.captureScreenshot", { format: "png" });
	await writeFile(screenshotPath, Buffer.from(image.data, "base64"));
	screenshotSaved = true;
	console.log(`QA_SCREENSHOT ${screenshotPath}`);
}

const scene = {
	version: 4, activeSceneId: "qa-motion-intent",
	scenes: [{
		id: "qa-motion-intent", name: "Motion intent QA", objects: [],
		shotDocument: { version: 4, frameCount: 96, waypoints: [], shots: [{
			id: "qa-motion-shot", name: "Shot 1", startFrame: 0, endFrame: 95,
			camera: { mode: "keys" }, cameraKeys: [{ id: "qa-motion-camera", frame: 0, framing: { pos: { x: 0, y: 1.6, z: 4 }, yaw: 0, pitch: -0.08, fovDeg: 45 } }],
		}] },
		stage: { characters: [{ id: "char-a", model: "y-bot-tpose", x: 0, z: 0, rot: 0, hidden: false, pose: null, layer: { waypoints: [], promptClips: [] } }], hasCharSheet: false, shotAspect: "16:9" },
	}],
};
function installBrowserFixture(sceneDocument, deadline) {
	localStorage.clear();
	localStorage.setItem("cozyclay.locale", "en");
	localStorage.setItem("cozyclay.project-session.v1", JSON.stringify({ name: "QA", updatedAt: Date.now() }));
	localStorage.setItem("cozyclay.scenes.v4", JSON.stringify(sceneDocument));
	const bus = new EventTarget();
	const qa = window.__qaMotion = {
		events: [], liveFrames: [], live: null, hello: null,
		signal: () => bus.dispatchEvent(new Event("change")),
		wait(predicate, label) {
			return new Promise((resolve, reject) => {
				const finish = (error, value) => {
					clearTimeout(timer); observer.disconnect(); bus.removeEventListener("change", check);
					if (error) reject(error); else resolve(value);
				};
				const check = () => { try { const value = predicate(); if (value) finish(null, value); } catch (error) { finish(error); } };
				const observer = new MutationObserver(check);
				const timer = setTimeout(() => finish(new Error(`Timed out: ${label}`)), deadline);
				observer.observe(document, { subtree: true, childList: true, attributes: true, characterData: true });
				bus.addEventListener("change", check);
				check();
			});
		},
		async command(name, args) {
			const id = `qa-live-${qa.liveFrames.length}`;
			const response = qa.wait(() => qa.liveFrames.find((frame) => frame.type === "result" && frame.id === id), `live result ${name}`);
			response.catch(() => {});
			// The application's actual onmessage -> dispatchLiveFrame -> handler ->
			// send path remains intact, including its asynchronous result semantics.
			await qa.live.onmessage(new MessageEvent("message", { data: JSON.stringify({ type: "cmd", id, name, args }) }));
			return response;
		},
	};
	let cozyclay;
	Object.defineProperty(window, "__cozyclay", {
		configurable: true, get: () => cozyclay,
		set(value) { cozyclay = value; qa.signal(); },
	});
	let beforeSend;
	window.__qaPosthog = {
		init(_key, options) { beforeSend = options.before_send; },
		register() {}, opt_in_capturing() {}, opt_out_capturing() {}, get_distinct_id: () => "internal-qa-273",
		capture(event, properties = {}) {
			const payload = beforeSend({ event, properties: { ...properties } });
			if (!payload) return;
			qa.events.push(payload);
			qa.signal();
		},
	};
	const NativeWebSocket = window.WebSocket;
	class LiveSocketFixture {
		OPEN = 1;
		readyState = 1;
		constructor() {
			qa.live = this;
			queueMicrotask(() => { this.onopen?.(new Event("open")); qa.signal(); });
		}
		send(data) {
			const frame = JSON.parse(data);
			qa.liveFrames.push(frame);
			if (frame.type === "hello") qa.hello = frame;
			qa.signal();
		}
		close() { this.readyState = 3; this.onclose?.(new CloseEvent("close")); }
	}
	window.WebSocket = class extends NativeWebSocket {
		constructor(address, protocols) {
			const parsed = new URL(address, location.href);
			if (["127.0.0.1", "localhost", "[::1]"].includes(parsed.hostname) && parsed.pathname === "/live") return new LiveSocketFixture();
			super(address, protocols);
		}
	};
}

async function fulfill(requestId, status, value, contentType = "application/json") {
	await send("Fetch.fulfillRequest", {
		requestId, responseCode: status,
		responseHeaders: [{ name: "Content-Type", value: contentType }, { name: "Cache-Control", value: "no-store" }],
		body: Buffer.from(typeof value === "string" ? value : JSON.stringify(value)).toString("base64"),
	});
}
subscribe("Fetch.requestPaused", (request) => {
	const task = (async () => {
		const requestedUrl = new URL(request.request.url);
		if (requestedUrl.pathname === "/src/analytics.js") {
			const { body, base64Encoded } = await send("Fetch.getResponseBody", { requestId: request.requestId });
			let source = base64Encoded ? Buffer.from(body, "base64").toString("utf8") : body;
			assert.equal((source.match(/return import\.meta\.env \?\? \{\};/g) || []).length, 1, "analytics environment seam changed");
			source = source.replace("return import.meta.env ?? {};", "return { PROD: true, VITE_POSTHOG_KEY: 'internal-qa-273', VITE_POSTHOG_HOST: 'https://telemetry.invalid', VITE_POSTHOG_ALLOWED_ORIGINS: location.origin };");
			const sdkImport = /await import\([^)]*posthog[^)]*\)/g;
			assert.equal((source.match(sdkImport) || []).length, 1, "analytics SDK import seam changed");
			source = source.replace(sdkImport, "await Promise.resolve({ default: window.__qaPosthog })");
			await fulfill(request.requestId, 200, source, "text/javascript");
			routedAnalytics += 1;
		} else if (requestedUrl.pathname === "/ardy/health") {
			requests.health += 1;
			await fulfill(request.requestId, 503, { ok: false, backend: "none", host_configured: false, reason: "unconfigured", capabilities: { lineEdit: false } });
		} else if (requestedUrl.pathname === "/ardy/generate") {
			requests.generate += 1;
			// Fail closed even when the regression incorrectly queues a request.
			await fulfill(request.requestId, 503, { ok: false, reason: "unconfigured" });
		} else if (requestedUrl.pathname === "/ardy/bases") {
			await fulfill(request.requestId, 200, { bases: [] });
		} else if (requestedUrl.pathname.startsWith("/ardy/")) {
			requests.unexpectedArdy.push({ method: request.request.method, path: requestedUrl.pathname });
			await fulfill(request.requestId, 503, { ok: false, reason: "QA backend is unavailable" });
		} else if (requestedUrl.hostname === "telemetry.invalid" || requestedUrl.hostname.endsWith(".posthog.com")) {
			requests.telemetry.push(requestedUrl.origin);
			await send("Fetch.failRequest", { requestId: request.requestId, errorReason: "BlockedByClient" });
		} else {
			await send("Fetch.continueRequest", { requestId: request.requestId });
		}
	})().catch(async (error) => {
		routeErrors.push(error.message);
		try { await send("Fetch.failRequest", { requestId: request.requestId, errorReason: "Failed" }); }
		catch (failure) { routeErrors.push(failure.message); }
	});
	routeTasks.add(task);
	void task.finally(() => routeTasks.delete(task));
});

const demandEvents = (events) => events.filter(({ event }) => event === "motion:generate_requested" || event === "motion:generate_blocked" || event.startsWith("motion:preflight_") || event.startsWith("motion:job_") || event === "motion:result_applied");
const records = () => evaluate("window.__qaMotion.events");
async function assertNoDemand(label) {
	const events = demandEvents(await records());
	assert.deepEqual(events, [], `${label}: authoring must not emit demand, preflight, jobs, application, or legacy blocked events`);
	assert.equal(requests.generate, 0, `${label}: no generation HTTP request`);
	pass(label, { demand: 0, generation_http: 0 });
}
function assertBlockedPair(events) {
	const funnel = demandEvents(events);
	assert.equal(funnel.length, 2, `Exactly one requested and one blocked, no legacy/job/application: ${JSON.stringify(funnel)}`);
	const [requested, blocked] = funnel;
	assert.equal(requested.event, "motion:generate_requested");
	assert.equal(blocked.event, "motion:preflight_blocked");
	assert.match(requested.properties.request_id, /^[a-f0-9]{32}$/);
	assert.deepEqual(requested.properties, { surface: "timeline", input_mode: "prompt", request_id: requested.properties.request_id });
	assert.deepEqual(blocked.properties, { reason: "unconfigured", surface: "timeline", request_id: requested.properties.request_id });
	return requested.properties.request_id;
}

try {
	await new Promise((resolve, reject) => {
		const timer = setTimeout(() => reject(new Error("CDP WebSocket open timed out")), timeoutMs);
		ws.onopen = () => { clearTimeout(timer); resolve(); };
		ws.onerror = () => { clearTimeout(timer); reject(new Error("CDP WebSocket failed")); };
	});
	await send("Runtime.enable");
	await send("Page.enable");
	await send("Network.enable");
	await send("Network.setCacheDisabled", { cacheDisabled: true });
	await send("Network.setBypassServiceWorker", { bypass: true });
	await send("Fetch.enable", { patterns: [
		{ urlPattern: "*/src/analytics.js*", requestStage: "Response" },
		{ urlPattern: "*/ardy/*", requestStage: "Request" },
		{ urlPattern: "*://telemetry.invalid/*", requestStage: "Request" },
		{ urlPattern: "*://*.posthog.com/*", requestStage: "Request" },
	] });
	({ identifier: fixtureId } = await send("Page.addScriptToEvaluateOnNewDocument", { source: `(${installBrowserFixture.toString()})(${JSON.stringify(scene)}, ${timeoutMs});` }));
	await send("Emulation.setDeviceMetricsOverride", { width: 1600, height: 1100, deviceScaleFactor: 1, mobile: false });
	await navigate(url.href);
	// Missing-backend studio legitimately loads the shipped demo once. Await its
	// actual applied state before establishing our baseline, not a guessed delay.
	await waitState("!!window.__cozyclay?.rigA && !!window.__cozyclay?.motion && !!window.__qaMotion.hello && window.__qaMotion.events.some(({event, properties}) => event === 'motion:backend_state' && properties.backend === 'none')", "rig, demo seed, live dispatcher and sanitized no-backend baseline");
	await evaluate("window.__qaMotion.baselineMotion = window.__cozyclay.motion; true");
	assert.ok(routedAnalytics > 0, "real analytics module routed through SDK spy");
	assert.ok(requests.health > 0, "no-backend health fixture was consumed");
	await assertNoDemand("startup has no explicit generation demand");

	await changeAndWait("document.querySelector('.app')?.dataset.workflowMode === 'motion'", () => click(".workflow-mode-switch [role='tab']:nth-child(3)"), "Motion workflow selected");
	const beforeCount = await evaluate("document.querySelectorAll('.tl-track.prompts .tl-chip-input').length");
	await changeAndWait(`document.querySelectorAll('.tl-track.prompts .tl-chip-input').length === ${beforeCount + 1} && !!document.querySelector('input[placeholder="describe this motion block"]')`, () => click(".tl-track.prompts .tl-track-add"), "real Add prompt block commits and reveals inspector");
	await assertNoDemand("actual timeline Add prompt block is authoring only");
	const firstEdits = (await records()).filter(({ event }) => event === "craft:first_edit");
	assert.deepEqual(firstEdits, [{ event: "craft:first_edit", properties: { edit_kind: "prompt_block_add", definition_version: 1 } }], "#269 semantic setter still records the authored edit");
	pass("semantic first-edit contract survives motion separation", { edit_kind: "prompt_block_add", definition_version: 1, count: 1 });

	const inspector = 'input[placeholder="describe this motion block"]';
	const chip = ".tl-track.prompts .tl-chip.selected .tl-chip-input";
	const authored = "PRIVATE_PROMPT_273 walks forward";
	await changeAndWait(`document.querySelector(${JSON.stringify(chip)})?.value === ${JSON.stringify(authored)}`, () => typeInto(inspector, authored), "inspector edit propagated to timeline block");
	await assertNoDemand("actual inspector prompt editing is authoring only");
	const revised = "PRIVATE_PROMPT_273 turns left";
	await changeAndWait(`document.querySelector(${JSON.stringify(inspector)})?.value === ${JSON.stringify(revised)}`, () => typeInto(chip, revised), "timeline edit propagated to inspector");
	await assertNoDemand("actual timeline prompt editing is authoring only");

	const commands = await evaluate("window.__qaMotion.hello.meta.commands");
	assert.ok(commands.includes("set_prompt_blocks"), "real live editor advertises prompt authoring");
	const liveText = "PRIVATE_LIVE_PROMPT_273 steps back";
	await changeAndWait(`document.querySelectorAll('.tl-track.prompts .tl-chip-input').length === 1 && document.querySelector('.tl-track.prompts .tl-chip-input')?.value === ${JSON.stringify(liveText)}`, async () => {
		const result = await evaluate(`window.__qaMotion.command('set_prompt_blocks', {blocks: [{startFrame: 0, endFrame: 48, text: ${JSON.stringify(liveText)}}]})`);
		assert.equal(result.ok, true, JSON.stringify(result));
		assert.deepEqual(result.value, { blocks: 1 });
	}, "live set_prompt_blocks commits through real App handler");
	await assertNoDemand("live protocol prompt authoring is not demand");
	pass("live route inventory", { generation_commands: commands.filter((name) => /generat/.test(name)), transport: "browser-local fixture; real dispatcher and App handlers" });

	await changeAndWait("window.__cozyclay.tlFrame === 1", () => evaluate("window.__cozyclay.scrub(1)"), "existing __cozyclay hook updates real playhead");
	await assertNoDemand("programmatic timeline navigation is not demand");
	assert.equal(await evaluate("window.__cozyclay.motion === window.__qaMotion.baselineMotion"), true, "authoring never replaced the loaded take");

	const generateControl = await evaluate(`(() => {
		const button = document.querySelector('.prompt-block-generate');
		if (!button) throw new Error('Prompt Blocks Generate control is missing after authoring');
		return { disabled: button.disabled || button.getAttribute('aria-disabled') === 'true', label: button.textContent.trim(), title: button.title };
	})()`);
	const requestSurface = generateControl.disabled ? "__cozyclay.runArdy" : "actual Generate button";
	if (generateControl.disabled) {
		assert.equal(await evaluate("typeof window.__cozyclay.runArdy"), "function", "No-backend UI is disabled: supported __cozyclay.runArdy is required; do not fake-enable the button");
		console.log(`QA_UI_LIMITATION ${JSON.stringify({ ...generateControl, fallback: requestSurface, ui_click_verified: false, reason: "No-backend readiness UX is outside #273" })}`);
	}
	const requestGeneration = generateControl.disabled
		? () => evaluate(`window.__cozyclay.runArdy({promptOverride: ${JSON.stringify(liveText)}, durationOverride: 2, promptClipsOverride: []})`)
		: () => click(".prompt-block-generate");
	const ids = [];
	for (let attempt = 0; attempt < 2; attempt += 1) {
		const offset = (await records()).length;
		await changeAndWait(`window.__qaMotion.events.slice(${offset}).some(({event}) => event === 'motion:preflight_blocked')`, requestGeneration, "explicit request reaches terminal no-backend preflight");
		// A real React state commit is the completion barrier for queue effects,
		// not a quiet-period sleep that could miss a delayed duplicate callback.
		await changeAndWait(`window.__cozyclay.tlFrame === ${attempt + 2}`, () => evaluate(`window.__cozyclay.scrub(${attempt + 2})`), "post-request React commit");
		const id = assertBlockedPair((await records()).slice(offset));
		assert.equal(requests.generate, 0, "preflight does not contact generation backend");
		assert.equal(await evaluate("window.__cozyclay.motion === window.__qaMotion.baselineMotion"), true, "blocked request did not apply/replace motion");
		ids.push(id);
		pass(`explicit generation request ${attempt + 1}`, { entry_point: requestSurface, ui_click_verified: !generateControl.disabled, request_id: id, requested: 1, preflight_blocked: 1, reason: "unconfigured", jobs: 0, result_applied: 0, generation_http: 0 });
		if (attempt === 0) await screenshot();
	}
	assert.notEqual(ids[0], ids[1], "independent requests receive fresh random 128-bit IDs");
	assert.equal(demandEvents(await records()).length, 4, "two independently linked explicit requests contain exactly four events");
	// Exercise the real browser receiver as well as the real server/HTTP/socket
	// integration in mcp/verify-live-motion-job.mjs. This is a transport fixture,
	// not a claim that the browser itself ran an MCP server or generated motion.
	const relayId = "a".repeat(32);
	const relayStages = [
		{ event: "motion:generate_requested", props: { surface: "mcp", input_mode: "prompt", request_id: relayId } },
		{ event: "motion:preflight_passed", props: { backend: "local_kimodo", surface: "mcp", request_id: relayId } },
		{ event: "motion:job_started", props: { backend: "local_kimodo", input_mode: "prompt", request_id: relayId } },
		{ event: "motion:job_succeeded", props: { backend: "local_kimodo", duration_bucket: "lt1s", input_mode: "prompt", request_id: relayId } },
		{ event: "motion:result_applied", props: { request_id: relayId, backend: "local_kimodo" } },
	];
	const relayOffset = (await records()).length;
	await changeAndWait(`window.__qaMotion.events.some(({event, properties}) => event === 'motion:result_applied' && properties.request_id === '${relayId}')`, () => evaluate(`(async () => {
		for (const payload of ${JSON.stringify([...relayStages, ...relayStages, { event: "motion:PRIVATE_UNKNOWN", props: { request_id: relayId } }])}) {
			await window.__qaMotion.live.onmessage(new MessageEvent("message", { data: JSON.stringify({
				type: "event", name: "motion_telemetry",
				payload: { ...payload, props: { ...payload.props, prompt: "PRIVATE_MCP_PROMPT_273", host: "PRIVATE_HOST_273" } },
			}) }));
		}
	})()`), "MCP lifecycle reaches real browser sanitizer and capture");
	const allEvents = await records();
	assert.deepEqual(allEvents.slice(relayOffset), relayStages.map(({ event, props }) => ({ event, properties: props })), "MCP duplicates, unknown names and private fields are excluded at the real browser boundary");
	pass("MCP browser relay preserves stages and suppresses duplicates", { transport: "fixture", stages: relayStages.length, duplicate_stages: 0, unknown_events: 0 });
	assert.ok(!JSON.stringify(allEvents).includes("PRIVATE_"), "private fixture prompt text never enters sanitized telemetry");
	await Promise.all([...routeTasks]);
	assert.deepEqual(routeErrors, [], "CDP fixtures succeeded");
	assert.deepEqual(pageErrors, [], "no uncaught browser exceptions");
	assert.deepEqual(requests.unexpectedArdy, [], "no unexpected backend routes");
	assert.deepEqual(requests.telemetry, [], "no production telemetry traffic");
	pass("session-level deduplication, privacy and unchanged result", { unique_request_ids: ids.length });
	console.log(`QA_MOTION_INTENT ${JSON.stringify({ url: url.href, checks, requests, motion_events: allEvents.filter(({event}) => event.startsWith("motion:")), screenshot: screenshotSaved ? screenshotPath : null })}`);
} catch (error) {
	console.error(`FAIL motion intent QA: ${error.stack || error}`);
	console.error(`QA_FIXTURE_EVIDENCE ${JSON.stringify({ requests, routeErrors, pageErrors })}`);
	if (screenshotPath && ws.readyState === WebSocket.OPEN) {
		try { await screenshot(); } catch (failure) { console.error(`Failure screenshot unavailable: ${failure.message}`); }
	}
	process.exitCode = 1;
} finally {
	// Remove reload-time mutation first, then unload the app to cancel its
	// observers, optional live connection and bridge probes. Wrapper owns Chrome.
	if (ws.readyState === WebSocket.OPEN) {
		try {
			if (fixtureId) await send("Page.removeScriptToEvaluateOnNewDocument", { identifier: fixtureId });
			await navigate("about:blank");
			await Promise.all([...routeTasks]);
			await send("Fetch.disable");
		} catch (error) { console.error(`QA cleanup failed: ${error.message}`); process.exitCode = 1; }
	}
	for (const item of pending.values()) { clearTimeout(item.timer); item.reject(new Error("QA CDP session closed")); }
	pending.clear();
	listeners.clear();
	ws.close();
}

#!/usr/bin/env node
// #277 / #282: real editor controls, HTTP health/NDJSON/NPZ fixtures, and the
// production motion lifecycle + sanitizer. Only analytics environment()/SDK are
// replaced. No React handlers, fake-enabled controls, or application-state writes.
// Start DEV Vite separately, then:
// QA_URL=http://127.0.0.1:5257/app/ CDP_PORT=9497 node tools/qa-browser.mjs -- node test/qa-motion-readiness-browser.mjs
// Artifacts (including genuine browser downloads) are outside git in QA_OUT.
import assert from "node:assert/strict";
import { EventEmitter, once as eventOnce } from "node:events";
import { createServer } from "node:http";
import { mkdir, readFile, writeFile } from "node:fs/promises";

const url = new URL(process.env.QA_URL || "http://127.0.0.1:5257/app/");
const port = Number(process.env.CDP_PORT || 9497);
const out = process.env.QA_OUT || "/tmp/cozyclay-277-qa";
const timeoutMs = 60_000;
const sample = await readFile(new URL("../public/demo/walk-then-stop.npz", import.meta.url));
await mkdir(`${out}/downloads`, { recursive: true });
const checks = [], screenshots = [], pageErrors = [], routeErrors = [], liveFrames = [];
const requests = { health: 0, generate: [], motions: 0, unexpected: [], telemetry: [], sessionEnd: [] };
const fixture = new EventEmitter();
const healthStates = {
	not_configured: { ok: false, backend: "none", host_configured: false, reason: "unconfigured", capabilities: { lineEdit: false } },
	unavailable: { ok: false, backend: "local_kimodo", host_configured: true, host: "PRIVATE_HOST_277", reason: "PRIVATE_CONNECTION_277", capabilities: { lineEdit: false } },
	local: { ok: true, backend: "local_kimodo", host_configured: true, host: "local", device: "local", capabilities: { lineEdit: false } },
	ready: { ok: true, backend: "local_kimodo", host_configured: true, host: "PRIVATE_HOST_277", device: "cuda", capabilities: { lineEdit: true } },
};
let health = healthStates.not_configured;
let holdHealth = true;
const heldHealth = [];
let jobResponse = null;
// The browser consumes this actual streaming HTTP response through CDP's URL
// override. Terminal release is explicit, never a timer or timing-luck window.
const server = createServer(async (req, res) => {
	res.setHeader("Access-Control-Allow-Origin", url.origin);
	res.setHeader("Access-Control-Allow-Headers", "Content-Type");
	if (req.method === "OPTIONS") { res.writeHead(204); res.end(); return; }
	if (req.url !== "/ardy/generate" || req.method !== "POST") { res.writeHead(404); res.end(); return; }
	let body = "";
	for await (const chunk of req) body += chunk;
	requests.generate.push(JSON.parse(body));
	res.writeHead(200, { "Content-Type": "application/x-ndjson", "Cache-Control": "no-store" });
	res.write(`${JSON.stringify({ event: "status", message: "QA fixture generating motion: 40%" })}\n`);
	jobResponse = res;
	fixture.emit("job");
});
let fixtureOrigin;
const targets = await (await fetch(`http://127.0.0.1:${port}/json`, { signal: AbortSignal.timeout(timeoutMs) })).json();
const page = targets.find(target => target.type === "page" && target.url.startsWith(url.origin) && target.webSocketDebuggerUrl);
assert.ok(page, `Run through tools/qa-browser.mjs with QA_URL=${url.href} CDP_PORT=${port}`);
const ws = new WebSocket(page.webSocketDebuggerUrl);
const pending = new Map(), listeners = new Map(), routeTasks = new Set();
let nextId = 0, fixtureId, routedAnalytics = 0;
function subscribe(method, callback) {
	const group = listeners.get(method) || new Set();
	listeners.set(method, group); group.add(callback);
	return () => group.delete(callback);
}
function once(method, predicate = () => true) {
	let remove, timer;
	const promise = new Promise((resolve, reject) => {
		remove = subscribe(method, value => { if (!predicate(value)) return; clearTimeout(timer); remove(); resolve(value); });
		timer = setTimeout(() => { remove(); reject(new Error(`Missing CDP event: ${method}`)); }, timeoutMs);
	});
	promise.catch(() => {});
	return { promise, cancel() { clearTimeout(timer); remove(); } };
}
function send(method, params = {}) {
	return new Promise((resolve, reject) => {
		const id = ++nextId;
		const timer = setTimeout(() => { pending.delete(id); reject(new Error(`CDP timeout: ${method}`)); }, timeoutMs + 5000);
		pending.set(id, { resolve, reject, timer });
		ws.send(JSON.stringify({ id, method, params }));
	});
}
ws.onmessage = ({ data }) => {
	const message = JSON.parse(data);
	if (message.id && pending.has(message.id)) {
		const item = pending.get(message.id); pending.delete(message.id); clearTimeout(item.timer);
		if (message.error) item.reject(new Error(JSON.stringify(message.error))); else item.resolve(message.result);
		return;
	}
	for (const callback of listeners.get(message.method) || []) callback(message.params);
};
subscribe("Runtime.exceptionThrown", ({ exceptionDetails }) => pageErrors.push(exceptionDetails.exception?.description || exceptionDetails.text));
subscribe("Network.webSocketFrameReceived", ({ response }) => {
	try {
		const frame = JSON.parse(response.payloadData);
		if (frame.type === "cmd") liveFrames.push({ type: frame.type, name: frame.name });
	} catch { /* Binary/non-JSON WebSocket traffic is not a live command. */ }
});
async function evaluate(expression) {
	const result = await send("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true, timeout: timeoutMs });
	if (result.exceptionDetails) throw new Error(result.exceptionDetails.exception?.description || result.exceptionDetails.text);
	return result.result?.value;
}
async function navigate(destination) {
	const loaded = once("Page.loadEventFired");
	try { await send("Page.navigate", { url: destination }); await loaded.promise; } finally { loaded.cancel(); }
}
async function changeAndWait(expression, action, label) {
	await evaluate(`window.__qaReadiness.pending = window.__qaReadiness.wait(() => (${expression}), ${JSON.stringify(label)}); window.__qaReadiness.pending.catch(() => {}); true`);
	await action();
	await evaluate("window.__qaReadiness.pending");
}
async function position(selector, { allowDisabled = false, fraction = 0.5 } = {}) {
	return evaluate(`(() => {
		const element = document.querySelector(${JSON.stringify(selector)});
		if (!element || (!${allowDisabled} && (element.disabled || element.getAttribute('aria-disabled') === 'true'))) throw new Error('Missing/disabled: ' + ${JSON.stringify(selector)});
		element.scrollIntoView({block:'center', inline:'center', behavior:'instant'});
		const rect = element.getBoundingClientRect(), x = rect.x + rect.width * ${fraction}, y = rect.y + rect.height / 2;
		if (!rect.width || !rect.height || !element.contains(document.elementFromPoint(x,y))) throw new Error('Invisible/covered: ' + ${JSON.stringify(selector)});
		return {x,y};
	})()`);
}
async function press(point, button = "left") {
	for (const type of ["mousePressed", "mouseReleased"]) await send("Input.dispatchMouseEvent", { type, ...point, button, buttons: type === "mousePressed" ? (button === "left" ? 1 : 2) : 0, clickCount: 1 });
}
const click = async (selector, options) => press(await position(selector, options));
async function typeInto(selector, text) {
	await click(selector);
	await send("Input.dispatchKeyEvent", { type: "keyDown", key: "a", code: "KeyA", modifiers: 4, windowsVirtualKeyCode: 65 });
	await send("Input.dispatchKeyEvent", { type: "keyUp", key: "a", code: "KeyA", modifiers: 4, windowsVirtualKeyCode: 65 });
	await send("Input.insertText", { text });
}
async function escape() {
	for (const type of ["keyDown", "keyUp"]) await send("Input.dispatchKeyEvent", { type, key: "Escape", code: "Escape", windowsVirtualKeyCode: 27 });
}
function pass(label, detail = {}) { checks.push({ label, ...detail }); console.log(`PASS ${label} ${JSON.stringify(detail)}`); }
async function screenshot(name) {
	const image = await send("Page.captureScreenshot", { format: "png" });
	const path = `${out}/${name}.png`;
	await writeFile(path, Buffer.from(image.data, "base64")); screenshots.push(path);
	console.log(`QA_SCREENSHOT ${path}`);
}
async function viewport(width) {
	await evaluate(`window.__qaReadiness.resize = new Promise((resolve, reject) => {
		const done = () => { clearTimeout(timer); window.removeEventListener('resize', done); resolve(true); };
		const timer = setTimeout(() => { window.removeEventListener('resize', done); reject(new Error('resize deadline')); }, ${timeoutMs});
		window.addEventListener('resize', done); }); window.__qaReadiness.resize.catch(() => {}); true`);
	await send("Emulation.setDeviceMetricsOverride", { width, height: width === 390 ? 844 : 1100, deviceScaleFactor: 1, mobile: width === 390 });
	await evaluate("window.__qaReadiness.resize");
}
async function captureBoth(name, selector = ".motion-readiness") {
	const reveal = () => evaluate(`(() => {
		const element = document.querySelector(${JSON.stringify(selector)});
		if (!element || !element.getBoundingClientRect().height) throw new Error('Screenshot target is not rendered');
		element.scrollIntoView({block:'center', inline:'center', behavior:'instant'}); return true;
	})()`);
	await reveal(); await screenshot(`${name}-desktop`);
	await viewport(390); await reveal(); await screenshot(`${name}-mobile`);
	await viewport(1600);
}

const scene = { version: 4, activeSceneId: "qa-readiness", scenes: [{
	id: "qa-readiness", name: "PRIVATE_SCENE_277", objects: [],
	shotDocument: { version: 4, frameCount: 96, waypoints: [], shots: [{ id: "qa-shot", name: "Shot 1", startFrame: 0, endFrame: 95, camera: { mode: "keys" }, cameraKeys: [{ id: "qa-camera", frame: 0, framing: { pos: { x: 0, y: 1.6, z: 4 }, yaw: 0, pitch: -0.08, fovDeg: 45 } }] }] },
	stage: { characters: [{ id: "char-a", model: "y-bot-tpose", x: 0, z: 0, rot: 0, hidden: false, pose: null, layer: { waypoints: [], promptClips: [] } }], hasCharSheet: false, shotAspect: "16:9" },
}] };
function installBrowserFixture(documentSeed, deadline) {
	localStorage.clear();
	localStorage.setItem("cozyclay.locale", "en");
	localStorage.setItem("cozyclay.project-session.v1", JSON.stringify({ name: "QA", updatedAt: Date.now() }));
	localStorage.setItem("cozyclay.scenes.v4", JSON.stringify(documentSeed));
	window.__qaInitialScene = JSON.parse(localStorage.getItem("cozyclay.scenes.v4")).activeSceneId;
	const bus = new EventTarget();
	const qa = window.__qaReadiness = {
		events: [], signal: () => bus.dispatchEvent(new Event("change")),
		wait(predicate, label) {
			return new Promise((resolve, reject) => {
				const finish = (error, value) => { clearTimeout(timer); observer.disconnect(); bus.removeEventListener("change", check); if (error) reject(error); else resolve(value); };
				const check = () => { try { const value = predicate(); if (value) finish(null, value); } catch (error) { finish(error); } };
				const observer = new MutationObserver(check);
				const timer = setTimeout(() => finish(new Error(`Timed out: ${label}`)), deadline);
				observer.observe(document, { subtree: true, childList: true, attributes: true, characterData: true });
				bus.addEventListener("change", check); check();
			});
		},
	};
	// Read-only observation of the existing QA surface, never a state override.
	// Subscribe during document initialization, before the application's modules run.
	qa.studio = qa.wait(() => !!document.querySelector('.workflow-mode-switch'), 'studio controls mounted');
	qa.studio.catch(() => {});
	let cozyclay;
	Object.defineProperty(window, "__cozyclay", { configurable: true, get: () => cozyclay, set(value) { cozyclay = value; qa.signal(); } });
	let beforeSend;
	window.__qaPosthog = {
		init(_key, options) { beforeSend = options.before_send; }, register() {}, opt_in_capturing() {}, opt_out_capturing() {}, get_distinct_id: () => "internal-qa-277",
		capture(event, properties = {}) { const payload = beforeSend({ event, properties: { ...properties } }); if (payload) { qa.events.push(payload); qa.signal(); } },
	};
}
async function fulfill(requestId, status, value, contentType = "application/json") {
	await send("Fetch.fulfillRequest", { requestId, responseCode: status, responseHeaders: [{ name: "Content-Type", value: contentType }, { name: "Cache-Control", value: "no-store" }], body: (Buffer.isBuffer(value) ? value : Buffer.from(typeof value === "string" ? value : JSON.stringify(value))).toString("base64") });
}
async function answerHealth(requestId) { await fulfill(requestId, health.ok ? 200 : 503, health); }
subscribe("Fetch.requestPaused", request => {
	const task = (async () => {
		const requested = new URL(request.request.url), id = request.requestId;
		if (requested.pathname === "/src/analytics.js") {
			const { body, base64Encoded } = await send("Fetch.getResponseBody", { requestId: id });
			let source = base64Encoded ? Buffer.from(body, "base64").toString("utf8") : body;
			assert.equal((source.match(/return import\.meta\.env \?\? \{\};/g) || []).length, 1, "analytics environment seam");
			source = source.replace("return import.meta.env ?? {};", "return { PROD: true, VITE_POSTHOG_KEY: 'internal-qa-277', VITE_POSTHOG_HOST: 'https://telemetry.invalid', VITE_POSTHOG_ALLOWED_ORIGINS: location.origin };");
			const sdk = /await import\([^)]*posthog[^)]*\)/g;
			assert.equal((source.match(sdk) || []).length, 1, "analytics SDK seam");
			source = source.replace(sdk, "await Promise.resolve({ default: window.__qaPosthog })");
			await fulfill(id, 200, source, "text/javascript"); routedAnalytics++;
		} else if (requested.pathname === "/ardy/health") {
			requests.health++; if (holdHealth) heldHealth.push(id); else await answerHealth(id);
		} else if (requested.pathname === "/ardy/generate") {
			await send("Fetch.continueRequest", { requestId: id, url: `${fixtureOrigin}/ardy/generate` });
		} else if (requested.pathname === "/ardy/motions/qa-readiness.npz") {
			requests.motions++; await fulfill(id, 200, sample, "application/octet-stream");
		} else if (requested.pathname === "/ardy/bases") {
			await fulfill(id, 200, { bases: [] });
		} else if (requested.pathname.startsWith("/ardy/")) {
			requests.unexpected.push(requested.pathname); await fulfill(id, 503, { ok: false, reason: "QA unexpected route" });
		} else if (requested.hostname === "telemetry.invalid") {
			// Native unload beacon is independent of the SDK; receive it only at
			// the environment fixture sink, never a production analytics endpoint.
			// Chrome omits Blob beacon bodies from Fetch.requestPaused. This
			// records only the transport; motion payload privacy is asserted below.
			assert.equal(requested.pathname, "/e/");
			requests.sessionEnd.push({ method: request.request.method, path: requested.pathname }); await fulfill(id, 204, "");
		} else if (requested.hostname.endsWith(".posthog.com")) {
			requests.telemetry.push(requested.origin); await send("Fetch.failRequest", { requestId: id, errorReason: "BlockedByClient" });
		} else {
			await send("Fetch.continueRequest", { requestId: id });
		}
	})().catch(async error => { routeErrors.push(error.message); try { await send("Fetch.failRequest", { requestId: request.requestId, errorReason: "Failed" }); } catch (failure) { routeErrors.push(failure.message); } });
	routeTasks.add(task); void task.finally(() => routeTasks.delete(task));
});
const records = () => evaluate("window.__qaReadiness.events");
const demand = events => events.filter(({ event }) => /^motion:(generate_|preflight_|job_|result_applied)/.test(event));
const readyState = state => `!!document.querySelector('.motion-readiness[data-state="${state}"]')`;
const authoredState = () => evaluate(`({ prompts: [...document.querySelectorAll('.tl-track.prompts .tl-chip-input')].map(e => e.value), keys: [...document.querySelectorAll('.tl-marker.cam')].map(e => e.title), scene: window.__cozyclay.charA, motion: window.__cozyclay.motion?.url })`);
async function assertPreserved(before, label) { assert.deepEqual(await authoredState(), before, label); pass(label); }
function assertLifecycle(events, terminal, reason) {
	const funnel = demand(events);
	const names = ["motion:generate_requested", reason ? "motion:preflight_blocked" : "motion:preflight_passed", ...(!reason ? ["motion:job_started", `motion:job_${terminal}`, ...(terminal === "succeeded" ? ["motion:result_applied"] : [])] : [])];
	assert.deepEqual(funnel.map(e => e.event), names, "one accepted click, one requested/preflight and ordered existing stages only");
	const id = funnel[0].properties.request_id;
	assert.match(id, /^[a-f0-9]{32}$/);
	const keys = {
		"motion:generate_requested": ["surface", "input_mode", "request_id"], "motion:preflight_blocked": ["reason", "surface", "request_id"],
		"motion:preflight_passed": ["backend", "surface", "request_id"], "motion:job_started": ["backend", "input_mode", "request_id"],
		"motion:job_succeeded": ["backend", "duration_bucket", "input_mode", "request_id"], "motion:job_failed": ["backend", "duration_bucket", "input_mode", "error_code", "request_id"],
		"motion:result_applied": ["request_id", "backend"],
	};
	for (const record of funnel) {
		assert.equal(record.properties.request_id, id);
		assert.deepEqual(Object.keys(record.properties).sort(), keys[record.event].sort(), "exact #282 property contract");
		if (record.properties.surface) assert.equal(record.properties.surface, "timeline");
		if (record.properties.input_mode) assert.equal(record.properties.input_mode, "prompt");
		if (record.properties.backend) assert.equal(record.properties.backend, "local_kimodo");
		if (record.properties.duration_bucket) assert.ok(["lt1s", "1-3s", "3-10s", "10-30s", "gte30s"].includes(record.properties.duration_bucket));
	}
	if (reason) assert.equal(funnel[1].properties.reason, reason);
	if (terminal === "failed") assert.equal(funnel.at(-1).properties.error_code, "generation_failed");
	return id;
}
async function blocked(reason, control = ".prompt-block-generate") {
	const offset = (await records()).length, http = requests.generate.length;
	await changeAndWait(`window.__qaReadiness.events.slice(${offset}).some(e => e.event === 'motion:preflight_blocked')`, () => click(control), `blocked ${reason}`);
	assert.equal(requests.generate.length, http);
	pass(`visible Generate blocked: ${reason}`, { request_id: assertLifecycle((await records()).slice(offset), null, reason), generation_http: 0 });
}
async function recheck(state, expected, control = "[data-testid=motion-health-retry]") {
	health = healthStates[state];
	await changeAndWait(readyState(expected), () => click(control), `recheck becomes ${expected}`);
}
async function openSetup() {
	await changeAndWait("!!document.querySelector('[data-testid=motion-setup]')", () => click("[data-testid=motion-readiness-action]"), "contextual action opens setup");
}
async function closeSetup() { await changeAndWait("!document.querySelector('.settings-menu')", escape, "setup closes without reload"); }

try {
	await new Promise((resolve, reject) => { const timer = setTimeout(() => reject(new Error("CDP open deadline")), timeoutMs); ws.onopen = () => { clearTimeout(timer); resolve(); }; ws.onerror = () => { clearTimeout(timer); reject(new Error("CDP open failed")); }; });
	const listening = eventOnce(server, "listening", { signal: AbortSignal.timeout(timeoutMs) });
	server.listen(0, "127.0.0.1");
	await listening;
	fixtureOrigin = `http://127.0.0.1:${server.address().port}`;
	await send("Runtime.enable"); await send("Page.enable"); await send("Network.enable");
	await send("Network.setCacheDisabled", { cacheDisabled: true }); await send("Network.setBypassServiceWorker", { bypass: true });
	await send("Browser.setDownloadBehavior", { behavior: "allowAndName", downloadPath: `${out}/downloads`, eventsEnabled: true });
	// Unload the wrapper's warm-up app before interception: an old health probe
	// otherwise leaves a cancelled InterceptionId in the held initial fixture.
	await navigate("about:blank");
	await send("Fetch.enable", { patterns: [{ urlPattern: "*/src/analytics.js*", requestStage: "Response" }, { urlPattern: "*/ardy/*", requestStage: "Request" }, { urlPattern: "*://telemetry.invalid/*", requestStage: "Request" }, { urlPattern: "*://*.posthog.com/*", requestStage: "Request" }] });
	({ identifier: fixtureId } = await send("Page.addScriptToEvaluateOnNewDocument", { source: `(${installBrowserFixture.toString()})(${JSON.stringify(scene)}, ${timeoutMs})` }));
	await send("Emulation.setDeviceMetricsOverride", { width: 1600, height: 1100, deviceScaleFactor: 1, mobile: false });
	await navigate(url.href);
	await evaluate("window.__qaReadiness.studio");
	await changeAndWait(`document.querySelector('.app')?.dataset.workflowMode === 'motion' && ${readyState("loading")}`, () => click(".workflow-mode-switch [role=tab]:nth-child(3)"), "Motion workflow and loading readiness mounted");
	assert.ok(await evaluate(readyState("loading")), "Initial health probe must render loading readiness at the generation entry point");
	await captureBoth("loading");
	await changeAndWait(`${readyState("not_configured")} && !!window.__cozyclay.motion`, async () => { holdHealth = false; await Promise.all(heldHealth.splice(0).map(answerHealth)); }, "unconfigured health and real shipped sample decoded");
	assert.ok(routedAnalytics > 0);
	assert.equal(await evaluate("window.__cozyclay.motion.url"), "/demo/walk-then-stop.npz");
	assert.deepEqual(demand(await records()), []);
	await captureBoth("not-configured");
	pass("no backend: real shipped sample decoded, editor remains available");

	const frameBefore = await evaluate("window.__cozyclay.tlFrame");
	await changeAndWait(`window.__cozyclay.playing && window.__cozyclay.tlFrame !== ${frameBefore}`, () => click('[aria-label="Play playback"]'), "sample advances through real Play");
	await changeAndWait("!!document.querySelector('[aria-label=\"Play playback\"]')", () => click('[aria-label="Pause playback"]'), "sample paused through real Pause");
	pass("no backend: actual sample playback controls advance motion");
	await changeAndWait("document.querySelector('.app')?.dataset.workflowMode === 'camera'", () => click(".workflow-mode-switch [role=tab]:nth-child(2)"), "Camera workflow");
	const cameraKeys = await evaluate("document.querySelectorAll('.tl-marker.cam').length");
	await changeAndWait(`document.querySelectorAll('.tl-marker.cam').length === ${cameraKeys + 1}`, () => click(".tl-shot-key-surface"), "camera key authored through timeline");
	await captureBoth("no-backend-camera", ".tl-shot-key-surface");
	pass("no backend: actual camera key authoring", { keys: cameraKeys + 1 });

	await changeAndWait("!!document.querySelector('.export-menu')", () => click("#export-menu-trigger"), "Export menu");
	const download = once("Browser.downloadWillBegin"), completed = once("Browser.downloadProgress", event => event.state === "completed");
	const exportOffset = (await records()).length;
	try {
		await changeAndWait(`window.__qaReadiness.events.slice(${exportOffset}).some(e => e.event === 'export:attempt_succeeded')`, () => click("[data-testid=export-video]"), "real MP4 export succeeds without backend");
		const started = await download.promise, finished = await completed.promise;
		assert.equal(started.guid, finished.guid);
		const bytes = await readFile(`${out}/downloads/${started.guid}`);
		assert.equal(bytes.subarray(4, 8).toString(), "ftyp"); assert.ok(bytes.length > 100);
		await writeFile(`${out}/no-backend-export.mp4`, bytes);
		pass("no backend: native browser MP4 download completed", { name: started.suggestedFilename, bytes: bytes.length });
	} finally { download.cancel(); completed.cancel(); }
	await escape();
	await changeAndWait("document.querySelector('.app')?.dataset.workflowMode === 'motion'", () => click(".workflow-mode-switch [role=tab]:nth-child(3)"), "return to Motion");
	await changeAndWait("!!document.querySelector('input[placeholder=\"describe this motion block\"]')", () => click(".tl-track.prompts .tl-track-add"), "Add prompt block is authoring only");
	const text = "PRIVATE_PROMPT_277 walks forward";
	await changeAndWait(`document.querySelector('.tl-track.prompts .tl-chip-input')?.value === ${JSON.stringify(text)}`, () => typeInto('input[placeholder="describe this motion block"]', text), "prompt edit commits");
	assert.deepEqual(demand(await records()), []); assert.equal(requests.generate.length, 0);
	const authored = await authoredState();
	await blocked("unconfigured");
	await openSetup(); await captureBoth("setup-not-configured", "[data-testid=motion-setup]");
	await closeSetup(); await assertPreserved(authored, "setup preserves prompt blocks, authored camera and scene");
	await openSetup(); await recheck("unavailable", "unavailable");
	await captureBoth("setup-unavailable", "[data-testid=motion-setup]");
	await closeSetup(); await assertPreserved(authored, "configured unreachable retry preserves authored scene");
	await captureBoth("unavailable"); await blocked("unreachable");
	await recheck("ready", "ready", "[data-testid=motion-readiness-action]");
	await captureBoth("recovered-ready"); await assertPreserved(authored, "recovered connection preserves edits without reload");

	// One unconstrained prompt can be ready locally while trail regeneration
	// is unsupported. Settings must retain the originating request on retry.
	await changeAndWait("!!document.querySelector('.settings-menu')", () => click("[data-testid=settings-menu-trigger]"), "open route settings");
	await recheck("unavailable", "unavailable");
	await recheck("local", "ready"); await closeSetup();
	await changeAndWait("!!document.querySelector('.trail-regenerate')", async () => {
		await click('[aria-label="Inverse kinematics"]');
		await click('[data-node-id="characterA.rig"] .hierarchy-row');
	}, "rig trail regeneration controls");
	const trailReadiness = ".trail-regenerate + .motion-readiness";
	assert.equal(await evaluate(`document.querySelector(${JSON.stringify(trailReadiness)})?.dataset.state`), "unsupported_route");
	await captureBoth("trail-unsupported", trailReadiness);
	await changeAndWait("document.querySelector('[data-testid=motion-setup]')?.dataset.state === 'unsupported_route'",
		() => click(`${trailReadiness} [data-testid=motion-readiness-action]`), "trail setup keeps unsupported route");
	await captureBoth("trail-setup", "[data-testid=motion-setup]");
	health = healthStates.ready;
	await changeAndWait("document.querySelector('[data-testid=motion-setup]')?.dataset.state === 'ready'",
		() => click("[data-testid=motion-health-retry]"), "trail setup reflects recovered current health");
	await closeSetup();
	await assertPreserved(authored, "trail-origin setup retains its route and preserves edits through recovery");
	await click('[aria-label="Inverse kinematics"]');
	await changeAndWait("!!document.querySelector('.prompt-block-generate')",
		() => click('[data-node-id="characterA"] .hierarchy-row'), "return to prompt generation");

	// A second distinct block is a real selected local sequence, not a capability
	// flag alone. Local MLX/cpp must refuse the sequence before any generation HTTP.
	await changeAndWait("document.querySelectorAll('.tl-track.prompts .tl-chip-input').length === 2", () => click(".tl-track.prompts .tl-track-add"), "add second sequence block");
	await changeAndWait("document.querySelectorAll('.tl-track.prompts .tl-chip-input')[1]?.value === 'PRIVATE_PROMPT_277 turns left'", () => typeInto('input[placeholder="describe this motion block"]', "PRIVATE_PROMPT_277 turns left"), "second block prompt");
	await changeAndWait("!!document.querySelector('.settings-menu')", () => click("[data-testid=settings-menu-trigger]"), "Settings opens from topbar");
	await recheck("local", "unsupported_route"); await closeSetup();
	await captureBoth("unsupported-route"); await blocked("unsupported_route");
	const sequence = await authoredState();
	await openSetup(); await captureBoth("setup-unsupported", "[data-testid=motion-setup]");
	await recheck("ready", "ready"); await closeSetup();
	await assertPreserved(sequence, "route setup/recheck keeps both authored blocks and scene");

	for (const terminal of ["failed", "succeeded"]) {
		const offset = (await records()).length, count = requests.generate.length;
		const job = eventOnce(fixture, "job", { signal: AbortSignal.timeout(timeoutMs) }); job.catch(() => {});
		await changeAndWait("[...document.querySelectorAll('.ardy-status')].some(e => e.textContent.includes('40%')) && document.querySelector('.prompt-block-generate')?.disabled", () => click(".prompt-block-generate"), `real streamed ${terminal} job progress`);
		await job;
		await captureBoth(`job-${terminal}-progress`, ".ardy-status");
		// Dispatch actual pointer input onto the now-disabled visible control.
		// Its disabled property is observed, never removed. A second HTTP request
		// or requested event fails the exact lifecycle assertion after completion.
		await click(".prompt-block-generate", { allowDisabled: true });
		await changeAndWait(`window.__qaReadiness.events.slice(${offset}).some(e => e.event === '${terminal === "succeeded" ? "motion:result_applied" : "motion:job_failed"}') && !document.querySelector('.prompt-block-generate')?.disabled`, async () => {
			assert.ok(jobResponse);
			jobResponse.end(`${JSON.stringify(terminal === "succeeded" ? { event: "done", output: "qa-readiness.npz", bytes: sample.length, motionUrl: "/ardy/motions/qa-readiness.npz" } : { event: "error", message: "PRIVATE_JOB_FAILURE_277" })}\n`);
			jobResponse = null;
		}, `job ${terminal} terminal and idle controls`);
		assert.equal(requests.generate.length, count + 1, "duplicate click never reaches HTTP");
		pass(`fixture job ${terminal}: ordered lifecycle and duplicate suppression`, { request_id: assertLifecycle((await records()).slice(offset), terminal), generation_http: 1 });
		await captureBoth(`job-${terminal}`, ".motion-readiness");
		if (terminal === "succeeded") { assert.equal(await evaluate("window.__cozyclay.motion.url"), "/ardy/motions/qa-readiness.npz"); assert.ok(requests.motions > 0); }
	}
	const all = await records(), ids = demand(all).filter(e => e.event === "motion:generate_requested").map(e => e.properties.request_id);
	assert.equal(new Set(ids).size, 5); assert.equal(ids.length, 5);
	assert.ok(!JSON.stringify(all).includes("PRIVATE_"), "production sanitizer excludes prompt, scene, host and error text");
	await Promise.all([...routeTasks]);
	assert.deepEqual(routeErrors, []); assert.deepEqual(pageErrors, []); assert.deepEqual(requests.unexpected, []); assert.deepEqual(requests.telemetry, []);
	assert.deepEqual(requests.sessionEnd, [], "no reload/unload while preserving the authored session");
	pass("five accepted clicks, exactly five unique requested/preflight pairs; unchanged #282 contract and privacy", { accepted_clicks: ids.length, real_npz_fetches: requests.motions });
	console.log(`QA_MOTION_READINESS PASS ${out}`);
} catch (error) {
	console.error(`FAIL motion readiness QA: ${error.stack || error}`); process.exitCode = 1;
	if (ws.readyState === WebSocket.OPEN) { try { await screenshot("failure"); } catch (failure) { console.error(`Failure screenshot: ${failure.message}`); } }
	if (ws.readyState === WebSocket.OPEN) {
		try { console.error(`QA_DOCUMENT_FAILURE ${JSON.stringify(await evaluate("({ initial: window.__qaInitialScene, stored: JSON.parse(localStorage.getItem('cozyclay.scenes.v4')), readiness: [...document.querySelectorAll('.motion-readiness')].map(e => e.dataset.state) })"))} LIVE_COMMANDS ${JSON.stringify(liveFrames)}`); }
		catch (diagnosticError) { console.error(`Failure document unavailable: ${diagnosticError.message}`); }
	}
} finally {
	let events = [];
	if (ws.readyState === WebSocket.OPEN) {
		try {
			events = await records();
			if (fixtureId) await send("Page.removeScriptToEvaluateOnNewDocument", { identifier: fixtureId });
			await navigate("about:blank"); await Promise.all([...routeTasks]); await send("Fetch.disable");
		} catch (error) { routeErrors.push(`cleanup: ${error.message}`); process.exitCode = 1; }
	}
	jobResponse?.destroy(); server.closeAllConnections(); server.close();
	await writeFile(`${out}/report.json`, JSON.stringify({ proof: "real visible controls, native MP4 download, streamed HTTP fixture and real NPZ decode; production lifecycle/sanitizer with SDK-boundary spy (not PostHog delivery)", checks, requests, events, screenshots, routeErrors, pageErrors }, null, 2));
	if (routeErrors.length || pageErrors.length) process.exitCode = 1;
	console.log(`QA_FIXTURE_EVIDENCE ${JSON.stringify({ checks: checks.length, requests, routeErrors, pageErrors, report: `${out}/report.json` })}`);
	for (const item of pending.values()) { clearTimeout(item.timer); item.reject(new Error("CDP session closed")); }
	pending.clear(); listeners.clear(); ws.close();
}

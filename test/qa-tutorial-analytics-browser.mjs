#!/usr/bin/env node
// #271: real Studio and landing-hosted Playground tutorial analytics.
// Start Vite separately on 5251, then:
// QA_URL=http://127.0.0.1:5251/app/ CDP_PORT=9271 \
//   node tools/qa-browser.mjs -- node test/qa-tutorial-analytics-browser.mjs
// QA_OUT is an optional artifact parent; every run creates an isolated directory.
// Requires Node with native WebSocket and the DEV server (not vite preview).
// Only the analytics environment/SDK import and /ardy/health are intercepted.
// track(), sanitization, before_send, tutorial state, signals, input, and rendering
// remain production code. This proves sanitized SDK-boundary calls, not delivery
// to PostHog. No synthetic completion signals or QA authoring hooks are invoked.
// Every wait subscribes to DOM, SDK, or source events before input. Timers are
// bounded failure deadlines, never sleeps, interval polling, or animation delays.
import assert from "node:assert/strict";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const origin = new URL(process.env.QA_URL || "http://127.0.0.1:5251/app/").origin;
assert.equal(new URL(origin).port, "5251", "issue #271 QA must use dev port 5251");
const port = Number(process.env.CDP_PORT || 9271);
const deadline = 45_000;
await mkdir(process.env.QA_OUT || tmpdir(), { recursive: true });
const out = await mkdtemp(join(process.env.QA_OUT || tmpdir(), "tutorial-analytics-"));
const report = { checks: [], scenarios: [], events: [], signals: [], pageErrors: [], routeErrors: [], productionTelemetry: [], blockedQaTelemetry: [], routedModules: 0 };
console.log(`QA artifacts: ${out}`);
const targets = await (await fetch(`http://127.0.0.1:${port}/json`)).json();
const page = targets.find((target) => target.type === "page" && target.webSocketDebuggerUrl);
assert.ok(page, "QA Chrome must expose a page target");
const ws = new WebSocket(page.webSocketDebuggerUrl);
await new Promise((resolve, reject) => {
	const timer = setTimeout(() => reject(new Error("CDP connection timed out")), deadline);
	ws.onopen = () => { clearTimeout(timer); resolve(); };
	ws.onerror = (error) => { clearTimeout(timer); reject(error); };
});
let nextId = 0;
let surface = "studio";
let scenarioStart = 0;
const pending = new Map();
const listeners = new Map();
function send(method, params = {}) {
	return new Promise((resolve, reject) => {
		const id = ++nextId;
		const timer = setTimeout(() => { pending.delete(id); reject(new Error(`CDP timeout: ${method}`)); }, deadline + 5000);
		pending.set(id, { resolve, reject, timer });
		ws.send(JSON.stringify({ id, method, params }));
	});
}
function once(method, predicate = () => true) {
	const group = listeners.get(method) || new Set();
	listeners.set(method, group);
	return new Promise((resolve, reject) => {
		const timer = setTimeout(() => { group.delete(onEvent); reject(new Error(`Missing CDP event: ${method}`)); }, deadline);
		const onEvent = (params) => { if (predicate(params)) { group.delete(onEvent); clearTimeout(timer); resolve(params); } };
		group.add(onEvent);
	});
}
ws.onmessage = ({ data }) => {
	const message = JSON.parse(data);
	if (message.id) {
		const item = pending.get(message.id);
		if (!item) return;
		pending.delete(message.id);
		clearTimeout(item.timer);
		if (message.error) item.reject(new Error(JSON.stringify(message.error)));
		else item.resolve(message.result);
		return;
	}
	if (message.method === "Runtime.exceptionThrown") report.pageErrors.push(message.params.exceptionDetails.exception?.description || message.params.exceptionDetails.text);
	if (message.method === "Runtime.consoleAPICalled" && message.params.type === "error") {
		report.pageErrors.push(message.params.args.map((arg) => arg.value ?? arg.description ?? arg.type).join(" "));
	}
	if (message.method === "Runtime.bindingCalled" && message.params.name === "__qaTutorialRecord") {
		const record = JSON.parse(message.params.payload);
		if (record.type === "sdk") report.events.push(record.value);
		else report.signals.push(record.value);
	}
	for (const listener of listeners.get(message.method) || []) listener(message.params);
};
async function evaluate(expression, inApp = false) {
	const wrapped = inApp && surface === "playground"
		? `(() => { const window = globalThis.document.querySelector('#playground iframe').contentWindow; const document = window.document; return (${expression}); })()`
		: expression;
	const result = await send("Runtime.evaluate", { expression: wrapped, awaitPromise: true, returnByValue: true, timeout: deadline });
	if (result.exceptionDetails) throw new Error(result.exceptionDetails.exception?.description || result.exceptionDetails.text);
	return result.result?.value;
}
async function navigate(path) {
	const loaded = once("Page.loadEventFired");
	const result = await send("Page.navigate", { url: `${origin}${path}` });
	assert.equal(result.errorText, undefined, "navigation succeeds");
	await loaded;
}
const wait = (condition, inApp = false) => evaluate(`window.__qaTutorial.wait(() => (${condition}), ${JSON.stringify(condition)})`, inApp);
let nextWait = 0;
async function change(condition, action, inApp = false) {
	const slot = `wait${++nextWait}`;
	await evaluate(`(() => { window.__qaTutorial.${slot} = window.__qaTutorial.wait(() => (${condition}), ${JSON.stringify(condition)}); window.__qaTutorial.${slot}.catch(() => {}); return true; })()`, inApp);
	try {
		await action();
		await evaluate(`window.__qaTutorial.${slot}`, inApp);
	} finally { await evaluate(`delete window.__qaTutorial.${slot}`, inApp); }
}
// One actual animation-frame boundary after a DOM commit allows passive React
// effects to publish their existing read-only QA snapshot. This is not a retry
// loop, elapsed-time wait, or substitution of the renderer/state publication.
const frame = (inApp = true) => evaluate(`new Promise((resolve, reject) => {
	const timer = setTimeout(() => reject(new Error('No animation frame')), ${deadline});
	window.requestAnimationFrame(() => { clearTimeout(timer); resolve(true); });
})`, inApp);
async function box(selector, inApp = true) {
	if (inApp && surface === "playground") await evaluate("document.querySelector('#playground iframe').scrollIntoView({block:'center',behavior:'instant'})");
	const rect = await evaluate(`(() => {
		const element = document.querySelector(${JSON.stringify(selector)});
		if (!element || element.disabled) throw new Error('Missing or disabled control: ' + ${JSON.stringify(selector)});
		element.scrollIntoView({block:'center',inline:'nearest',behavior:'instant'});
		const r = element.getBoundingClientRect();
		if (r.width < 2 || r.height < 2) throw new Error('Hidden control: ' + ${JSON.stringify(selector)});
		return {x:r.x, y:r.y, width:r.width, height:r.height};
	})()`, inApp);
	if (inApp && surface === "playground") {
		const offset = await evaluate("(() => { const r = document.querySelector('#playground iframe').getBoundingClientRect(); return {x:r.x,y:r.y}; })()");
		rect.x += offset.x; rect.y += offset.y;
	}
	return rect;
}
const mouse = (type, options) => send("Input.dispatchMouseEvent", { type, ...options });
async function click(selector, inApp = true) {
	const r = await box(selector, inApp);
	const point = { x: r.x + r.width / 2, y: r.y + r.height / 2 };
	await mouse("mousePressed", { ...point, button: "left", buttons: 1, clickCount: 1 });
	await mouse("mouseReleased", { ...point, button: "left", buttons: 0, clickCount: 1 });
}
async function key(name, repeat = false) {
	const code = name === "Escape" ? "Escape" : `Key${name.toUpperCase()}`;
	const keyCode = name === "Escape" ? 27 : name.toUpperCase().charCodeAt(0);
	const common = { code, key: name, windowsVirtualKeyCode: keyCode };
	await send("Input.dispatchKeyEvent", { type: "rawKeyDown", ...common });
	if (repeat) await send("Input.dispatchKeyEvent", { type: "rawKeyDown", ...common, autoRepeat: true });
	await frame();
	await send("Input.dispatchKeyEvent", { type: "keyUp", ...common });
}
async function screenshot(name) {
	if (surface === "playground") await evaluate("document.querySelector('#playground')?.scrollIntoView({block:'center',behavior:'instant'})");
	const { data } = await send("Page.captureScreenshot", { format: "png" });
	await writeFile(join(out, `${name}.png`), Buffer.from(data, "base64"));
}
function pass(label, detail = {}) {
	report.checks.push({ surface, label, ...detail });
	console.log(`PASS ${surface}: ${label}${Object.keys(detail).length ? ` ${JSON.stringify(detail)}` : ""}`);
}

// Installed before modules run in BOTH the real landing document and iframe.
// No app globals, input APIs, clocks, completion listeners, or tracker replaced.
function installFixture(timeout) {
	const context = location.pathname === "/app/" ? new URLSearchParams(location.search).has("embed") ? "playground" : "studio" : "landing";
	const bus = new EventTarget();
	const qa = window.__qaTutorial = {
		events: [], signals: [], sdkRequested: false, sdkInitialized: false,
		signal: () => bus.dispatchEvent(new Event("change")),
		wait(predicate, label) {
			return new Promise((resolve, reject) => {
				const finish = (error, value) => {
					clearTimeout(timer); observer.disconnect(); bus.removeEventListener("change", check);
					document.removeEventListener("pointerlockchange", check);
					if (error) reject(error); else resolve(value);
				};
				const check = () => { try { const value = predicate(); if (value) finish(null, value); } catch (error) { finish(error); } };
				const observer = new MutationObserver(check);
				const timer = setTimeout(() => finish(new Error(`State timeout: ${label}`)), timeout);
				observer.observe(document, { subtree: true, attributes: true, childList: true, characterData: true });
				bus.addEventListener("change", check);
				document.addEventListener("pointerlockchange", check);
				check();
			});
		},
	};
	const recordSignal = (value) => {
		qa.signals.push(value);
		window.__qaTutorialRecord(JSON.stringify({ type: "signal", value: { ...value, context } }));
		qa.signal();
	};
	for (const type of ["cozyclay:nav", "cozyclay:playground-signal"]) {
		window.addEventListener(type, (event) => recordSignal({ type, kind: event.detail?.kind, key: event.detail?.key ?? null }));
	}
	window.addEventListener("message", (event) => {
		const iframe = document.querySelector("#playground iframe");
		if (event.source !== iframe?.contentWindow || event.origin !== location.origin) return;
		if (["cozyclay:playground-ready", "cozyclay:playground-nav"].includes(event.data?.type)) {
			recordSignal({ type: event.data.type, kind: event.data.kind ?? null, key: event.data.key ?? null });
		}
	});
	let beforeSend;
	const sdk = {
		init(_key, options) { beforeSend = options.before_send; qa.sdkInitialized = true; qa.signal(); },
		register() {}, opt_in_capturing() {}, opt_out_capturing() {}, get_distinct_id: () => "internal-qa-271",
		capture(event, properties = {}) {
			const payload = beforeSend({ event, properties: { ...properties } });
			if (!payload) return;
			const value = { ...payload, context };
			qa.events.push(value);
			window.__qaTutorialRecord(JSON.stringify({ type: "sdk", value }));
			qa.signal();
		},
	};
	const held = localStorage.getItem("qa.tutorial-sdk-held") === "1";
	let release;
	const gate = new Promise((resolve) => { release = resolve; });
	qa.releaseSdk = () => release({ default: sdk });
	qa.sdkModule = () => { qa.sdkRequested = true; qa.signal(); return held ? gate : Promise.resolve({ default: sdk }); };
}

listeners.set("Fetch.requestPaused", new Set([(request) => {
	void (async () => {
		const url = new URL(request.request.url);
		if (url.pathname === "/ardy/health") {
			// The hosted product has no optional local motion bridge. A 503 is
			// the real demo-seed branch; the bundled scene/walk assets stay real.
			await send("Fetch.fulfillRequest", { requestId: request.requestId, responseCode: 503,
				responseHeaders: [{ name: "Content-Type", value: "application/json" }], body: Buffer.from('{"reason":"QA hosted bridge unavailable"}').toString("base64") });
			return;
		}
		assert.equal(url.pathname, "/src/analytics.js", "only the expected SDK/environment seam is intercepted");
		assert.equal(request.responseStatusCode, 200, "Vite analytics module loads");
		const response = await send("Fetch.getResponseBody", { requestId: request.requestId });
		let source = response.base64Encoded ? Buffer.from(response.body, "base64").toString("utf8") : response.body;
		const environment = "return import.meta.env ?? {};";
		assert.equal(source.split(environment).length, 2, "analytics environment seam must be unique");
		source = source.replace(environment, "return { PROD: true, VITE_POSTHOG_KEY: 'internal-qa-271', VITE_POSTHOG_HOST: 'https://telemetry.invalid', VITE_POSTHOG_ALLOWED_ORIGINS: location.origin };");
		const sdkImport = /await import\([^)]*posthog[^)]*\)/g;
		assert.equal((source.match(sdkImport) || []).length, 1, "analytics SDK import seam must be unique");
		source = source.replace(sdkImport, "await window.__qaTutorial.sdkModule()");
		await send("Fetch.fulfillRequest", { requestId: request.requestId, responseCode: 200,
			responseHeaders: [{ name: "Content-Type", value: "text/javascript" }, { name: "Cache-Control", value: "no-store" }], body: Buffer.from(source).toString("base64") });
		report.routedModules += 1;
	})().catch(async (error) => {
		report.routeErrors.push(`${request.request.url}\n${error.stack}`);
		try { await send("Fetch.failRequest", { requestId: request.requestId, errorReason: "Failed" }); }
		catch (failure) { report.routeErrors.push(failure.stack); }
	});
}]));
listeners.set("Network.requestWillBeSent", new Set([({ request }) => {
	const url = new URL(request.url);
	const hostname = url.hostname;
	if (hostname === "telemetry.invalid") report.blockedQaTelemetry.push({ method: request.method, path: url.pathname });
	if (hostname === "t.cozyclay.org" || /(^|\.)posthog\.com$/.test(hostname)) report.productionTelemetry.push(request.url);
}]));

const kinds = ["fly", "walk", "dolly", "orbit", "shot", "rail", "play"];
const buckets = new Set(["lt1s", "1-3s", "3-10s", "10-30s", "gte30s"]);
const tutorial = (events = report.events.slice(scenarioStart)) => events.filter(({ event }) => event.startsWith("tutorial:"));
const firstEdit = () => report.events.slice(scenarioStart).filter(({ event }) => /^(craft|playground):first_edit$/.test(event));
const count = (name, kind, events = tutorial()) => events.filter(({ event, properties }) => event === `tutorial:${name}` && (!kind || properties.step_kind === kind)).length;
function validateShape(events = tutorial(report.events)) {
	for (const { event, properties } of events) {
		const fields = ["surface", "tutorial_version"];
		assert.ok(["studio", "playground"].includes(properties.surface));
		assert.equal(properties.tutorial_version, 1, "version is numeric 1");
		if (event === "tutorial:started") {
			fields.push("start_source");
			assert.ok(["query", "settings", "landing"].includes(properties.start_source));
		} else if (["tutorial:step_entered", "tutorial:step_completed", "tutorial:dismissed"].includes(event)) {
			fields.push("step_kind");
			assert.ok(kinds.includes(properties.step_kind));
		} else assert.equal(event, "tutorial:completed", "only the five tutorial event names are emitted");
		if (["tutorial:step_completed", "tutorial:completed"].includes(event)) {
			fields.push("elapsed_bucket"); assert.ok(buckets.has(properties.elapsed_bucket), "elapsed is a bucketMs value");
		}
		assert.deepEqual(Object.keys(properties).sort(), fields.sort(), "exact safe property shape; no identifiers, URLs, scene content, or free text");
		assert.doesNotMatch(JSON.stringify(properties), /PRIVATE_|City Block|\.cclayproject|https?:|internal-qa|\//);
	}
}
function expectFirstEdit(kind = null) {
	assert.deepEqual(firstEdit().map(({ event, properties }) => ({ event, properties })), kind ? [{
		event: `${surface === "studio" ? "craft" : "playground"}:first_edit`, properties: { edit_kind: kind, definition_version: 1 },
	}] : [], "only genuine authoring emits one versioned first-edit per App mount");
}
function expectAttempt({ from = scenarioStart, completed = [], dismissed = null, source = surface === "studio" ? "query" : "landing" } = {}) {
	const events = tutorial(report.events.slice(from));
	validateShape(events);
	assert.equal(count("started", null, events), 1, "one start per real attempt");
	assert.ok(events.every(({ properties }) => properties.surface === surface), "initiating surface owns every tutorial event");
	assert.equal(events[0].event, "tutorial:started");
	assert.equal(events[0].properties.start_source, source);
	assert.deepEqual(events.filter(({ event }) => event === "tutorial:step_completed").map(({ properties }) => properties.step_kind), completed, "one completion per actual step, in action order");
	const entered = completed.length === 7 ? kinds : kinds.slice(0, completed.length + 1);
	assert.deepEqual(events.filter(({ event }) => event === "tutorial:step_entered").map(({ properties }) => properties.step_kind), entered, "each current step is entered once; resumed signals do not re-enter it");
	assert.equal(count("completed", null, events), completed.length === 7 ? 1 : 0);
	assert.equal(count("dismissed", null, events), dismissed ? 1 : 0);
	if (dismissed) assert.equal(events.at(-1).properties.step_kind, dismissed);
	for (const kind of completed) {
		assert.ok(events.findIndex((record) => record.event === "tutorial:step_entered" && record.properties.step_kind === kind)
			< events.findIndex((record) => record.event === "tutorial:step_completed" && record.properties.step_kind === kind), `${kind}: entered precedes completed`);
	}
}
const stepCondition = (kind) => surface === "studio"
	? `document.querySelector('[data-testid="camera-tutorial-step"][data-kind="${kind}"]')?.dataset.done === '1'`
	: `document.querySelectorAll('#tutorial-steps li')[${kinds.indexOf(kind)}]?.dataset.done === '1'`;
const stepWait = (kind, action) => change(stepCondition(kind), action, surface === "studio");
async function seedStorage({ optOut = false, late = false } = {}) {
	await navigate("/favicon.ico");
	await evaluate(`(() => { localStorage.clear(); localStorage.setItem('cozyclay.locale','en');
		localStorage.setItem('cozyclay.project-session.v1', JSON.stringify({name:'PRIVATE_SCENE_271',updatedAt:Date.now()}));
		localStorage.setItem('cozyclay.analyticsOptOut', ${JSON.stringify(optOut ? "1" : "0")});
		localStorage.setItem('qa.tutorial-sdk-held', ${JSON.stringify(late ? "1" : "0")}); return true; })()`);
}
async function startLanding() {
	await change("!!document.querySelector('#playground iframe') && document.querySelector('#playground').dataset.state === 'live'", () => click("#playground-start", false));
	const url = new URL(await evaluate("document.querySelector('#playground iframe').src"));
	assert.equal(url.pathname, "/app/");
	assert.equal(url.searchParams.get("embed"), "playground");
	assert.equal(url.searchParams.get("scene"), "/scenes/city-block.cclayproject");
	assert.equal(url.searchParams.has("tutorial"), false, "host creates the real embed URL, never an invented combined tutorial query");
	await wait("window.__qaTutorial.signals.some(({type}) => type === 'cozyclay:playground-ready')");
}
async function seeded(source = "query") {
	await wait("!!document.querySelector('.stage canvas') && document.querySelectorAll('.tl-motion-clip').length === 1 && !!window.__cozyclay?.motion && window.__cozyclay?.frameCount === 432 && !!window.__cozyclay?.rigA", true);
	await frame();
	const state = await evaluate(`(async () => { const p = JSON.parse(await window.__cozyclayProject.export()).scenes; const scene = p.scenes.find(s => s.id === p.activeSceneId) || p.scenes[0];
		return {props:scene.objects.length, frames:window.__cozyclay.frameCount, frame:window.__cozyclay.tlFrame, look:window.__cozyclay.lookThroughShot}; })()`, true);
	const starter = await (await fetch(`${origin}/scenes/city-block.cclayproject`)).json();
	assert.equal(state.props, starter.scenes.scenes[0].objects.length, "real City Block props seeded");
	assert.ok(state.props > 0); assert.equal(state.frames, 432); assert.equal(state.frame, 0); assert.equal(state.look, false);
	if (surface === "studio") assert.equal(await evaluate("window.__cozyclayTutorialSource"), source);
	pass("real City Block and 432-frame bundled walk seeded", state);
}
async function fresh(options = {}) {
	await seedStorage(options);
	scenarioStart = report.events.length;
	await navigate(surface === "studio" ? "/app/?tutorial=camera" : "/index.html");
	if (surface === "playground") await startLanding();
	await seeded();
	if (!options.optOut && !options.late) {
		await wait("window.__qaTutorial.events.some(({event}) => event === 'tutorial:step_entered')");
		if (surface === "playground") await wait("window.__qaTutorial.sdkInitialized", true);
		expectAttempt(); expectFirstEdit();
	}
	await screenshot(`${surface}-${options.late ? "late" : options.optOut ? "opt-out" : "seed"}-start`);
}
async function sourceNav(kind, action) {
	const from = await evaluate("window.__qaTutorial.signals.length", true);
	await change(`window.__qaTutorial.signals.slice(${from}).some(signal => signal.type === 'cozyclay:nav' && signal.kind === '${kind}')`, action, true);
}
async function beginFly() {
	const r = await box(".stage canvas");
	const p = { x: r.x + r.width * 0.45, y: r.y + r.height * 0.6 };
	await mouse("mouseMoved", p);
	// Chrome may deny immediate pointer-lock reacquisition. The real controls
	// deliberately support captured-pointer fallback; observe their actual nav
	// event rather than requiring a browser permission outcome unrelated to #271.
	await sourceNav("fly", () => mouse("mousePressed", { ...p, button: "right", buttons: 2, clickCount: 1 }));
	await mouse("mouseMoved", { x: p.x + 70, y: p.y + 18, button: "right", buttons: 2 });
	await mouse("mouseMoved", { x: p.x + 100, y: p.y + 26, button: "right", buttons: 2 });
	await frame();
	return p;
}
async function releaseFly(p) {
	await change("document.pointerLockElement === null", () => mouse("mouseReleased", { ...p, button: "right", buttons: 0, clickCount: 1 }), true);
}
async function navigationSteps() {
	let point;
	const before = await evaluate("window.__cozyclay.editorCam.rotation.y", true);
	await stepWait("fly", async () => { point = await beginFly(); });
	assert.notEqual(await evaluate("window.__cozyclay.editorCam.rotation.y", true), before, "right-drag really rotates the free camera");
	for (const name of ["w", "a", "s"]) await key(name, true);
	assert.equal(await evaluate(stepCondition("walk"), surface === "studio"), false, "three keys and autorepeats do not finish Walk");
	await stepWait("walk", async () => { for (const name of ["d", "q", "e"]) await key(name, true); });
	// Repeat all six keys during the same hold, then resume a new fly hold.
	for (const name of ["w", "a", "s", "d", "q", "e"]) await key(name, true);
	await releaseFly(point);
	await releaseFly(await beginFly());
	const r = await box(".stage canvas");
	const p = { x: r.x + r.width * 0.45, y: r.y + r.height * 0.6 };
	await stepWait("dolly", () => mouse("mouseWheel", { ...p, deltaX: 0, deltaY: -120 }));
	await mouse("mouseWheel", { ...p, deltaX: 0, deltaY: 40 });
	const orbit = async () => {
		await mouse("mouseMoved", p);
		await sourceNav("orbit", () => mouse("mousePressed", { ...p, button: "left", buttons: 1, modifiers: 1, clickCount: 1 }));
		await mouse("mouseMoved", { x: p.x + 80, y: p.y, button: "left", buttons: 1, modifiers: 1 });
		await change("document.pointerLockElement === null", () => mouse("mouseReleased", { x: p.x + 80, y: p.y, button: "left", buttons: 0, modifiers: 1, clickCount: 1 }), true);
	};
	await stepWait("orbit", orbit); await orbit();
	pass("real fly, six walk keys/autorepeats, resumed hold, wheel and Alt orbit");
}
const shots = () => evaluate("(async () => { const p = JSON.parse(await window.__cozyclayProject.export()).scenes; return (p.scenes.find(s => s.id === p.activeSceneId) || p.scenes[0]).shotDocument.shots; })()", true);
async function drawRail(offset = 0) {
	if (await evaluate("window.__cozyclay.lookThroughShot", true)) await change("!window.__cozyclay.lookThroughShot", () => key("Escape"), true);
	await change("!!document.querySelector('.tl-camera-editor .tl-rail-draw')", () => click(".tl-shot-label b"), true);
	await change("document.querySelector('.app').dataset.railDraw === '1'", () => click(".tl-camera-editor .tl-rail-draw"), true);
	const r = await box(".vp-inset");
	const from = { x: r.x + r.width * 0.2, y: r.y + r.height * 0.6 + offset };
	const old = await shots();
	await change("document.querySelector('.app').dataset.railDraw !== '1'", async () => {
		await mouse("mousePressed", { ...from, button: "left", buttons: 1, clickCount: 1 });
		for (let i = 1; i <= 8; i += 1) await mouse("mouseMoved", { x: from.x + r.width * 0.6 * i / 8, y: from.y - i * 2, button: "left", buttons: 1 });
		await mouse("mouseReleased", { x: from.x + r.width * 0.6, y: from.y - 16, button: "left", buttons: 0, clickCount: 1 });
	}, true);
	const authored = (await shots()).find((shot) => {
		const previous = old.find((entry) => entry.id === shot.id);
		return JSON.stringify(shot.camera.cameraRail) !== JSON.stringify(previous?.camera.cameraRail);
	});
	assert.ok(authored, "real stroke changes serialized rail geometry");
	const rail = authored.camera.cameraRail;
	assert.ok(Array.isArray(rail) && rail.length >= 2); assert.notDeepEqual(rail[0], rail.at(-1));
	pass("real rail stroke committed", { points: rail.length, repeated: offset !== 0 });
}
async function closeTutorial() {
	await change(surface === "studio" ? "!document.querySelector('[data-testid=camera-tutorial]')" : "!document.querySelector('#playground iframe')", () =>
		click(surface === "studio" ? "[data-testid=camera-tutorial-close]" : "#playground-close", surface === "studio"), surface === "studio");
}
async function restart() {
	const from = report.events.length;
	if (surface === "studio") {
		await change("!!document.querySelector('[data-testid=settings-camera-tutorial]')", () => click("[data-testid=settings-menu-trigger]"), true);
		await change("document.querySelector('[data-testid=camera-tutorial-step][data-kind=fly]')?.dataset.current === '1'", () => click("[data-testid=settings-camera-tutorial]"), true);
	} else await startLanding();
	await wait(`window.__qaTutorial.events.filter(({event}) => event === 'tutorial:started').length === ${count("started", null, tutorial(report.events.slice(scenarioStart, from))) + 1}`);
	await seeded(surface === "studio" ? "settings" : "landing");
	expectAttempt({ from, source: surface === "studio" ? "settings" : "landing" });
	return from;
}
async function completeRun({ optOut = false } = {}) {
	await fresh({ optOut });
	await navigationSteps();
	expectFirstEdit();
	if (!optOut) expectAttempt({ completed: kinds.slice(0, 4) });
	pass("seeding and navigation emit no first-edit");
	const before = await shots();
	await stepWait("shot", () => click(".tl-track-add.cut"));
	assert.equal((await shots()).length, before.length + 1, "Add shot really authors a new cut");
	if (!optOut) expectFirstEdit("shot_add");
	if (surface === "playground") {
		// The real rail handler enters preview and auto-plays the seeded walk.
		// Arm Play before the stroke, not after this legitimate fast completion.
		await stepWait("play", () => stepWait("rail", () => drawRail()));
	} else await stepWait("rail", () => drawRail());
	await drawRail(-20);
	if (!optOut) expectFirstEdit("shot_add");
	// Studio completes via the existing previewing/look-through prop. Hosted
	// Playground's real rail-triggered preview already crossed tlPlaying; real
	// pause/play clicks below generate repeated play signals without duplicates.
	if (surface === "studio") {
		await stepWait("play", () => click(".vp-look-through"));
		await change("!window.__cozyclay.lookThroughShot", () => key("Escape"), true);
		await change("window.__cozyclay.lookThroughShot", () => click(".vp-look-through"), true);
	} else {
		await wait("window.__cozyclay.playing && window.__cozyclay.tlFrame > 0 && window.__cozyclay.lookThroughShot", true);
		pass("rail-triggered preview crosses the existing hosted tlPlaying Play boundary");
		// The QA snapshot's effect is frame-dependent, so it can retain playing
		// on the final paused frame. The actual transport's on class reflects
		// tlPlaying directly and is the real user-visible pause/play state.
		await change("!!document.querySelector('.tl-transport .play:not(.on)')", () => click(".tl-transport .play"), true);
		const from = await evaluate("window.__qaTutorial.signals.length");
		await change(`window.__qaTutorial.signals.slice(${from}).some(signal => signal.type === 'cozyclay:playground-nav' && signal.kind === 'play')`, () =>
			change("!!document.querySelector('.tl-transport .play.on')", () => click(".tl-transport .play"), true));
		await change("!!document.querySelector('.tl-transport .play:not(.on)')", () => click(".tl-transport .play"), true);
	}
	if (optOut) {
		assert.deepEqual(tutorial(), []); expectFirstEdit();
		assert.equal(await evaluate("window.__qaTutorial.sdkRequested"), false, "opt-out never requests SDK");
		if (surface === "playground") assert.equal(await evaluate("window.__qaTutorial.sdkRequested", true), false);
	} else {
		expectAttempt({ completed: kinds }); expectFirstEdit("shot_add");
	}
	await screenshot(`${surface}-${optOut ? "opt-out" : "complete"}-done`);
	await closeTutorial();
	if (optOut) assert.deepEqual(tutorial(), []);
	else expectAttempt({ completed: kinds });
	pass(optOut ? "opt-out suppresses every tutorial event through all seven real steps and close" : "seven single completions; repeated keys/strokes/play signals and completed close do not duplicate or dismiss");
}
async function lifecycleRun() {
	await fresh();
	let p;
	await stepWait("fly", async () => { p = await beginFly(); }); await releaseFly(p);
	expectAttempt({ completed: ["fly"] });
	let initialFrom = scenarioStart;
	if (surface === "studio") {
		// Settings is a real restart even while the unfinished overlay is open.
		initialFrom = await restart();
		assert.equal(count("started"), 2); assert.equal(count("dismissed"), 0);
		assert.equal(await evaluate("[...document.querySelectorAll('[data-testid=camera-tutorial-step]')].every(step => step.dataset.done === '0')"), true, "open-overlay restart resets all seven progress flags");
		await screenshot("studio-settings-restart-while-open");
		await stepWait("fly", async () => { p = await beginFly(); }); await releaseFly(p);
		expectAttempt({ from: initialFrom, source: "settings", completed: ["fly"] });
		pass("real Settings restart while unfinished resets Fly and emits a new start without dismissal");
	}
	await closeTutorial();
	expectAttempt({ from: initialFrom, source: surface === "studio" ? "settings" : "landing", completed: ["fly"], dismissed: "walk" });
	let from = await restart();
	await closeTutorial();
	expectAttempt({ from, source: surface === "studio" ? "settings" : "landing", dismissed: "fly" });
	from = await restart();
	await stepWait("fly", async () => { p = await beginFly(); }); await releaseFly(p);
	expectAttempt({ from, source: surface === "studio" ? "settings" : "landing", completed: ["fly"] });
	const abandoned = tutorial(report.events.slice(from));
	const reloadFrom = report.events.length;
	// Reload the actual top document. The landing page requires a new real
	// Start click after reload, whereas Studio's query starts a fresh attempt.
	const loaded = once("Page.loadEventFired"); await send("Page.reload", { ignoreCache: true }); await loaded;
	if (surface === "playground") await startLanding();
	await seeded();
	await wait("window.__qaTutorial.events.some(({event}) => event === 'tutorial:step_entered')");
	expectAttempt({ from: reloadFrom });
	assert.equal(count("completed", null, abandoned), 0, "leaving mid-step invents no completion");
	assert.equal(count("dismissed", null, abandoned), 0, "reload/unload is not an explicit dismissal");
	const starts = surface === "studio" ? 5 : 4;
	assert.equal(count("started"), starts); assert.equal(count("dismissed"), 2);
	expectFirstEdit();
	await screenshot(`${surface}-reload-fresh-attempt`);
	await closeTutorial();
	expectAttempt({ from: reloadFrom, dismissed: "fly" });
	assert.equal(count("started"), starts); assert.equal(count("dismissed"), 3);
	pass("dismiss/restart/reload counts", { started: starts, dismissed: 3, abandonedMidWalk: surface === "studio" ? 2 : 1 });
}
async function lateRun() {
	await fresh({ late: true });
	await wait("window.__qaTutorial.sdkRequested");
	let p;
	await stepWait("fly", async () => { p = await beginFly(); }); await releaseFly(p);
	assert.deepEqual(tutorial(), [], "SDK import gate is genuinely unresolved during initial UI progress");
	// The SDK also starts a health request. Wait for its actual capture before
	// the next scenario destroys this document or the hosted iframe.
	await change("window.__qaTutorial.events.some(({event,properties}) => event === 'tutorial:step_entered' && properties.step_kind === 'walk') && window.__qaTutorial.events.some(({event}) => event === 'motion:backend_state')", async () => {
		await evaluate("window.__qaTutorial.releaseSdk()");
		if (surface === "playground") await change("window.__qaTutorial.events.some(({event}) => event === 'motion:backend_state')",
			() => evaluate("window.__qaTutorial.releaseSdk()", true), true);
	});
	expectAttempt({ completed: ["fly"] });
	await closeTutorial();
	expectAttempt({ completed: ["fly"], dismissed: "walk" });
	pass("late SDK initialization preserves started, initial entered, completed fly and entered walk in order");
}

let failures = 0;
try {
	await send("Runtime.enable"); await send("Page.enable"); await send("Network.enable");
	await send("Network.setCacheDisabled", { cacheDisabled: true });
	// Unload beacons can outlive an iframe's interception IDs. Block the
	// disposable QA endpoint at the network layer instead of racing a response
	// against frame destruction; SDK-boundary event observation stays intact.
	await send("Network.setBlockedURLs", { urls: ["https://telemetry.invalid/*", "*://t.cozyclay.org/*", "*://*.posthog.com/*", "*://posthog.com/*"] });
	await send("Runtime.addBinding", { name: "__qaTutorialRecord" });
	await send("Fetch.enable", { patterns: [
		{ urlPattern: `${origin}/src/analytics.js*`, requestStage: "Response" },
		{ urlPattern: `${origin}/ardy/health*`, requestStage: "Request" },
	] });
	await send("Page.addScriptToEvaluateOnNewDocument", { source: `(${installFixture.toString()})(${deadline});` });
	await send("Emulation.setDeviceMetricsOverride", { width: 1600, height: 1100, deviceScaleFactor: 1, mobile: false });
	for (surface of ["studio", "playground"]) {
		for (const [name, run] of [["completion", completeRun], ["lifecycle", lifecycleRun], ["late-sdk", lateRun], ["opt-out", () => completeRun({ optOut: true })]]) {
			const start = report.events.length;
			try {
				await run();
				report.scenarios.push({ surface, name, status: "passed", events: report.events.slice(start) });
			} catch (error) {
				failures += 1;
				report.scenarios.push({ surface, name, status: "failed", error: error.stack, events: report.events.slice(start) });
				console.error(`FAIL ${surface} ${name}: ${error.stack}`);
				await screenshot(`${surface}-${name}-FAIL`);
			}
		}
	}
	validateShape();
	assert.deepEqual(report.routeErrors, [], "all SDK/environment routes succeed");
	assert.deepEqual(report.pageErrors, [], "no uncaught or console App errors are hidden by broad interception");
	assert.deepEqual(report.productionTelemetry, [], "no production telemetry attempted");
	assert.ok(report.routedModules >= 8, "each actual surface loaded the real intercepted analytics module");
	assert.equal(failures, 0, "every real-surface scenario passes");
	pass("exact closed event properties, no private content, no production telemetry or App errors", { routedModules: report.routedModules });
	console.log(`PASS tutorial analytics browser QA: ${report.scenarios.length} scenarios; ${out}`);
} catch (error) {
	report.failure = error.stack;
	process.exitCode = 1;
	console.error(error.stack);
} finally {
	await writeFile(join(out, "report.json"), JSON.stringify(report, null, 2));
	for (const item of pending.values()) clearTimeout(item.timer);
	ws.close();
}

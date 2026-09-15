#!/usr/bin/env node
// #275: real first-shot handoff, project safety and hosted local download.
// Start Vite separately on 5255, then:
// QA_URL=http://127.0.0.1:5255/app/ CDP_PORT=9525 \
//   node tools/qa-browser.mjs -- node test/qa-first-shot-handoff-browser.mjs
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

const origin = new URL(process.env.QA_URL || "http://127.0.0.1:5255/app/").origin;
assert.equal(new URL(origin).port, "5255", "issue #275 QA must use dev port 5255");
const port = Number(process.env.CDP_PORT || 9525);
const deadline = 60_000;
await mkdir(process.env.QA_OUT || tmpdir(), { recursive: true });
const out = await mkdtemp(join(process.env.QA_OUT || tmpdir(), "first-shot-handoff-"));
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
let bridgeAvailable = false;
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
	const { data } = await send("Page.captureScreenshot", { format: "png" });
	await writeFile(join(out, `${name}.png`), Buffer.from(data, "base64"));
}
function pass(label, detail = {}) {
	report.checks.push({ surface, label, ...detail });
	console.log(`PASS ${surface}: ${label}${Object.keys(detail).length ? ` ${JSON.stringify(detail)}` : ""}`);
}

// Installed before modules run in BOTH the real landing document and iframe.
// Snapshot publication is observed without changing values. Native capture and
// Blob downloads are observed at their real boundaries; no authored state,
// input API, clocks, tutorial completion listener or analytics tracker replaced.
function installFixture(timeout) {
	const context = location.pathname === "/app/" ? new URLSearchParams(location.search).has("embed") ? "playground" : "studio" : "landing";
	const bus = new EventTarget();
	const qa = window.__qaTutorial = {
		events: [], signals: [], downloads: [], native: null, sdkRequested: false, sdkInitialized: false,
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
	window.addEventListener('message', (event) => {
		if (!qa.holdProjectResult || event.data?.type !== 'cozyclay:playground-export-result') return;
		const iframe = document.querySelector('#playground iframe');
		if (event.source !== iframe?.contentWindow || event.origin !== location.origin || qa.heldProjectResult) return;
		qa.heldProjectResult = event;
		event.stopImmediatePropagation();
		qa.signal();
	}, true);
	let cozyclay;
	const observedCameras = new WeakSet();
	Object.defineProperty(window, "__cozyclay", { configurable: true, get: () => cozyclay, set(value) {
		cozyclay = value;
		const camera = value?.shotCam;
		if (camera && !observedCameras.has(camera)) {
			observedCameras.add(camera);
			const update = camera.updateProjectionMatrix;
			camera.updateProjectionMatrix = function (...args) {
				const result = update.apply(this, args);
				qa.signal();
				return result;
			};
		}
		qa.signal();
	} });
	const blobs = new Map();
	const createObjectURL = URL.createObjectURL.bind(URL);
	URL.createObjectURL = (blob) => { const href = createObjectURL(blob); blobs.set(href, blob); return href; };
	const anchorClick = HTMLAnchorElement.prototype.click;
	HTMLAnchorElement.prototype.click = function () {
		if (!this.download) return anchorClick.apply(this, arguments);
		qa.downloads.push({ name: this.download, href: this.href, blob: blobs.get(this.href) || null });
		qa.signal();
	};
	qa.camera = () => {
		const camera = window.__cozyclay.shotCam;
		return { position: camera.position.toArray(), quaternion: camera.quaternion.toArray(), fov: camera.fov, aspect: camera.aspect };
	};
	qa.installNative = () => {
		if (qa.native) throw new Error("Native fixture must be restored between scenarios");
		const Encoder = window.VideoEncoder;
		const Frame = window.VideoFrame;
		const original = { support: Encoder.isConfigSupported, configure: Encoder.prototype.configure, encoderClose: Encoder.prototype.close, frameClose: Frame.prototype.close };
		const state = qa.native = {
			configs: [], supportConfigs: [], frames: [], reads: [], createdEncoders: 0, closedEncoders: 0,
			createdFrames: 0, closedFrames: 0,
			activeEncoders: new Set(), activeFrames: new Set(), captureFramebuffers: new Set(), releasedFramebuffers: new Set(), digests: [], restored: false,
		};
		Encoder.isConfigSupported = async function (config) {
			state.supportConfigs.push(structuredClone(config));
			return original.support.call(Encoder, config);
		};
		window.VideoEncoder = new Proxy(Encoder, { construct(Target, args) {
			const encoder = new Target(...args);
			state.createdEncoders++; state.activeEncoders.add(encoder); qa.signal();
			return encoder;
		} });
		Encoder.prototype.configure = function (config) { state.configs.push(structuredClone(config)); return original.configure.call(this, config); };
		Encoder.prototype.close = function () {
			const result = original.encoderClose.call(this);
			if (state.activeEncoders.delete(this)) state.closedEncoders++;
			qa.signal(); return result;
		};
		window.VideoFrame = new Proxy(Frame, { construct(Target, args) {
			const frame = new Target(...args);
			state.createdFrames++; state.activeFrames.add(frame);
			const input = args[1];
			const record = { width: input.codedWidth, height: input.codedHeight, timestamp: input.timestamp, duration: input.duration, camera: state.reads.at(-1)?.camera, hash: null };
			state.frames.push(record);
			const bytes = new Uint8Array(args[0].buffer, args[0].byteOffset, args[0].byteLength).slice();
			state.digests.push(crypto.subtle.digest("SHA-256", bytes).then((digest) => {
				record.hash = [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join(""); qa.signal();
			}));
			return frame;
		} });
		Frame.prototype.close = function () {
			const result = original.frameClose.call(this);
			if (state.activeFrames.delete(this)) state.closedFrames++;
			qa.signal(); return result;
		};
		const readPatches = [window.WebGLRenderingContext, window.WebGL2RenderingContext].filter(Boolean).map((Type) => {
			const readPixels = Type.prototype.readPixels;
			const deleteFramebuffer = Type.prototype.deleteFramebuffer;
			Type.prototype.deleteFramebuffer = function (framebuffer) {
				const result = deleteFramebuffer.call(this, framebuffer);
				if (state.captureFramebuffers.has(framebuffer)) state.releasedFramebuffers.add(framebuffer);
				qa.signal(); return result;
			};
			Type.prototype.readPixels = function (...args) {
				if (state.activeEncoders.size) {
					const framebuffer = this.getParameter(this.READ_FRAMEBUFFER_BINDING ?? this.FRAMEBUFFER_BINDING);
					if (framebuffer) state.captureFramebuffers.add(framebuffer);
					// The capture camera clone uses the target dimensions, not the
					// editor camera aspect. Sample transform synchronously at readback.
					state.reads.push({ width: args[2], height: args[3], camera: { ...qa.camera(), aspect: args[2] / args[3] } });
				}
				return readPixels.apply(this, args);
			};
			return { Type, readPixels, deleteFramebuffer };
		});
		state.restore = () => {
			window.VideoEncoder = Encoder; window.VideoFrame = Frame;
			Encoder.isConfigSupported = original.support;
			Encoder.prototype.configure = original.configure; Encoder.prototype.close = original.encoderClose;
			Frame.prototype.close = original.frameClose;
			for (const { Type, readPixels, deleteFramebuffer } of readPatches) {
				Type.prototype.readPixels = readPixels; Type.prototype.deleteFramebuffer = deleteFramebuffer;
			}
			state.restored = true; qa.native = null; qa.signal();
		};
		state.proof = async () => {
			await Promise.all(state.digests);
			return { configs: state.configs, supportConfigs: state.supportConfigs, frames: state.frames, reads: state.reads,
				createdEncoders: state.createdEncoders, closedEncoders: state.closedEncoders, createdFrames: state.createdFrames, closedFrames: state.closedFrames,
				liveEncoders: state.activeEncoders.size, liveFrames: state.activeFrames.size,
				capturedFramebuffers: state.captureFramebuffers.size, releasedFramebuffers: state.releasedFramebuffers.size };
		};
	};
	let beforeSend;
	const sdk = {
		init(_key, options) { beforeSend = options.before_send; qa.sdkInitialized = true; qa.signal(); },
		register() {}, opt_in_capturing() {}, opt_out_capturing() {}, get_distinct_id: () => "internal-qa-275",
		capture(event, properties = {}) {
			const payload = beforeSend({ event, properties: { ...properties } });
			if (!payload) return;
			const value = { ...payload, context };
			qa.events.push(value);
			window.__qaTutorialRecord(JSON.stringify({ type: "sdk", value }));
			qa.signal();
		},
	};
	qa.sdkModule = () => { qa.sdkRequested = true; qa.signal(); return Promise.resolve({ default: sdk }); };
}

listeners.set("Fetch.requestPaused", new Set([(request) => {
	void (async () => {
		const url = new URL(request.request.url);
		if (url.pathname === "/ardy/health") {
			// The hosted product has no optional local motion bridge. A 503 is
			// the real demo-seed branch; the bundled scene/walk assets stay real.
			await send("Fetch.fulfillRequest", { requestId: request.requestId, responseCode: bridgeAvailable ? 200 : 503,
				responseHeaders: [{ name: "Content-Type", value: "application/json" }], body: Buffer.from(JSON.stringify(bridgeAvailable ? {ok:true,host:'qa',device:'cpu'} : {reason:'QA hosted bridge unavailable'})).toString('base64') });
			return;
		}
		assert.equal(url.pathname, "/src/analytics.js", "only the expected SDK/environment seam is intercepted");
		assert.equal(request.responseStatusCode, 200, "Vite analytics module loads");
		const response = await send("Fetch.getResponseBody", { requestId: request.requestId });
		let source = response.base64Encoded ? Buffer.from(response.body, "base64").toString("utf8") : response.body;
		const environment = "return import.meta.env ?? {};";
		assert.equal(source.split(environment).length, 2, "analytics environment seam must be unique");
		source = source.replace(environment, "return { PROD: true, VITE_POSTHOG_KEY: 'internal-qa-275', VITE_POSTHOG_HOST: 'https://telemetry.invalid', VITE_POSTHOG_ALLOWED_ORIGINS: location.origin };");
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
async function seedStorage() {
	await navigate("/favicon.ico");
	await evaluate(`(() => { localStorage.clear(); localStorage.setItem('cozyclay.locale','en');

		localStorage.setItem('cozyclay.analyticsOptOut', '0'); return true; })()`);
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
async function fresh() {
	await seedStorage();
	scenarioStart = report.events.length;
	await navigate(surface === "studio" ? "/app/?tutorial=camera" : "/index.html");
	if (surface === "playground") await startLanding();
	await seeded();
	{
		await wait("window.__qaTutorial.events.some(({event}) => event === 'tutorial:step_entered')");
		if (surface === "playground") await wait("window.__qaTutorial.sdkInitialized", true);
		expectAttempt(); expectFirstEdit();
	}
	await screenshot(`${surface}-seed-start`);
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
	// The label center can overlap the hover Split action on a 40-frame cut.
	// Select the real shot body above its key strip, never a production hook.
	await change("!!document.querySelector('.tl-camera-editor .tl-rail-draw')", async () => {
		const r = await box('.tl-shot-block');
		const point = { x:r.x+r.width*0.55, y:r.y+r.height*0.65 };
		await mouse('mousePressed',{...point,button:'left',buttons:1,clickCount:1});
		await mouse('mouseReleased',{...point,button:'left',buttons:0,clickCount:1});
	}, true);
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

const terminalKey = "cozyclay.camera-tutorial-terminal.v1";
const handoffSelector = '[data-testid="camera-tutorial-handoff"]';
const lifecycle = (events = report.events.slice(scenarioStart)) => events.filter(({ event }) => event.startsWith("export:attempt_"));

// Exported project timestamps are save metadata, not authored project state.
const project = () => evaluate(`(async () => { const p = JSON.parse(await window.__cozyclayProject.export(${surface === "playground" ? '"City Block"' : ""})); delete p.savedAt; return p; })()`, true);
// Canvas aspect is derived from responsive layout, not authored camera state.
// The persisted output aspect and export range remain covered by project/meta.
const editing = () => evaluate(`(() => { const live = window.__cozyclay; const pose = camera => ({ position: camera.position.toArray(), quaternion: camera.quaternion.toArray(), fov: camera.fov });
	return { frame: live.tlFrame, frameCount: live.frameCount, look: live.lookThroughShot, meta: live.captureMeta(), shotCamera: pose(live.shotCam), editorCamera: pose(live.editorCam) }; })()`, true);
async function state(label) {
	const value = { project: await project(), editing: await editing() };
	await writeFile(join(out, `${label}.json`), JSON.stringify(value, null, 2));
	return value;
}
async function rendererReady() {
	await wait("!!window.__cozyclay?.rigA && !!window.__cozyclay?.shotCam && !!window.__cozyclay?.editorCam && !!document.querySelector('.stage canvas')", true);
	// Observe a real scene render, not whether the moving actor happens to be
	// inside the shot frustum after a resize. Preserve the original callback.
	await evaluate(`(() => { window.__qaTutorial.rendered = new Promise((resolve, reject) => {
		let scene = window.__cozyclay.rigA;
		while (scene.parent) scene = scene.parent;
		if (!scene.isScene) throw new Error('The loaded rig is not attached to the rendered scene');
		const original = scene.onAfterRender;
		const clean = () => { clearTimeout(timer); scene.onAfterRender = original; };
		const timer = setTimeout(() => { clean(); reject(new Error('No real scene draw')); }, ${deadline});
		scene.onAfterRender = function (...args) { original.apply(this, args); clean(); resolve(true); };
	}); window.__qaTutorial.rendered.catch(() => {}); return true; })()`, true);
	// Wake the real demand-render activity listener with ordinary pointer input.
	// A no-op Settings restart correctly need not redraw an idle canvas itself.
	const r = await box('.stage canvas');
	await mouse('mouseMoved', { x:r.x+r.width*0.4, y:r.y+r.height*0.6 });
	await mouse('mouseMoved', { x:r.x+r.width*0.45, y:r.y+r.height*0.6 });
	await evaluate('window.__qaTutorial.rendered', true);
}
async function closeTutorial() {
	await change("!document.querySelector('[data-testid=camera-tutorial]')", () => click('[data-testid="camera-tutorial-close"]'), true);
}
async function restart() {
	await change("!!document.querySelector('[data-testid=settings-camera-tutorial]')", () => click('[data-testid="settings-menu-trigger"]'), true);
	await change("document.querySelector('[data-testid=camera-tutorial-step][data-kind=fly]')?.dataset.current === '1'", () => click('[data-testid="settings-camera-tutorial"]'), true);
	await frame();
}
async function pauseHosted() {
	if (await evaluate("!!document.querySelector('.tl-transport .play.on')", true)) {
		await change("!!document.querySelector('.tl-transport .play:not(.on)')", () => click('.tl-transport .play'), true);
	}
	await frame();
}
async function completeSteps() {
	const seededProject = await project();
	await navigationSteps();
	assert.deepEqual((await project()).scenes, seededProject.scenes, "navigation changes no authored scene, range or shot camera");
	expectFirstEdit();
	const old = await shots();
	await stepWait('shot', () => click('.tl-track-add.cut'));
	const added = (await shots()).filter(shot => !old.some(previous => previous.id === shot.id));
	assert.equal(added.length, 1, 'Add shot authors exactly one real cut');
	const targetId = added[0].id;
	if (surface === 'playground') {
		await stepWait('play', () => stepWait('rail', () => drawRail()));
		await pauseHosted();
	} else {
		await stepWait('rail', () => drawRail());
		// This is the EXISTING Studio v1 Play boundary. Do not require the
		// transport to run or the playhead to advance: look-through owns it.
		await stepWait('play', () => click('.vp-look-through'));
	}
	await frame();
	const target = (await shots()).find(shot => shot.id === targetId);
	assert.ok(target.camera.cameraRail?.length >= 2, 'the added shot owns the real authored rail');
	assert.ok(target.cameraKeys.length > 0, 'authored shot already has its framing; export must not seed a key');
	expectAttempt({ completed: kinds });
	expectFirstEdit('shot_add');
	assert.deepEqual(lifecycle(), [], 'all seven steps invent no video attempt');
	pass('unchanged seven-step completion; Studio uses look-through, hosted uses tlPlaying', { targetId, start: target.startFrame, end: target.endFrame });
	return target;
}
async function viewport(width, height) {
	// Keep desktop input semantics. A 390px resize of a supported session is
	// NOT a claim that the landing page supports starting from an actual phone.
	await send('Emulation.setDeviceMetricsOverride', { width, height, deviceScaleFactor: 1, mobile: false });
	await frame(surface === 'studio');
}
async function layout(label, selectors, inApp = true) {
	const values = await evaluate(`(() => {
		return ${JSON.stringify(selectors)}.map(selector => {
			const e = document.querySelector(selector); if (!e) throw new Error('Missing layout control '+selector);
			const r = e.getBoundingClientRect(), hit = document.elementFromPoint(r.x+r.width/2,r.y+r.height/2);
			return { selector, visible: r.width > 1 && r.height > 1, disabled: !!e.disabled,
				inBounds: r.x >= -1 && r.y >= -1 && r.right <= window.innerWidth+1 && r.bottom <= window.innerHeight+1,
				hit: hit === e || e.contains(hit), overflow: e.scrollWidth > e.clientWidth+1,
				rect: { x:r.x,y:r.y,width:r.width,height:r.height,right:r.right,bottom:r.bottom } };
		}); })()`, inApp);
	for (const control of values) {
		assert.ok(control.visible && control.inBounds && !control.overflow, `${label}: ${control.selector} fits viewport: ${JSON.stringify(control)}`);
		if (!control.selector.includes('handoff"]') && !control.selector.includes('card"]') && control.selector !== '#tutorial-done') {
			assert.ok(control.hit && !control.disabled, `${label}: ${control.selector} is hit-test reachable`);
		}
	}
	await writeFile(join(out, `${label}-layout.json`), JSON.stringify(values, null, 2));
	await screenshot(label);
	pass(`${label}: rendered bounds and hit tests`, { controls: values.length });
}
async function handoffScreenshots() {
	for (const [name, width, height] of [['desktop',1440,1000],['narrow',390,844]]) {
		await viewport(width, height);
		if (surface === 'playground') await evaluate("document.querySelector('#tutorial-done').scrollIntoView({block:'center',behavior:'instant'})");
		await layout(`${surface}-handoff-${name}-${width}x${height}`, surface === 'studio'
			? [handoffSelector, '[data-testid="camera-tutorial-handoff-export"]', '[data-testid="camera-tutorial-handoff-dismiss"]', '#export-menu-trigger']
			: ['#tutorial-done', '#playground-download', '#playground-handoff-dismiss', '#playground-close'], surface === 'studio');
	}
	await viewport(1440, 1000);
}
function assertVideoAttempt(from) {
	const events = report.events.slice(from);
	const attempts = lifecycle(events);
	assert.deepEqual(attempts.map(record => record.event), ['export:attempt_started', 'export:attempt_succeeded']);
	const [start, end] = attempts;
	assert.match(start.properties.attempt_id, /^[a-f0-9]{32}$/);
	assert.equal(end.properties.attempt_id, start.properties.attempt_id);
	for (const record of attempts) {
		assert.equal(record.properties.export_kind, 'video');
		assert.equal(record.properties.format, 'mp4');
		assert.equal(record.properties.surface, 'studio');
		assert.deepEqual(Object.keys(record.properties).sort(), ['attempt_id','export_kind','format','surface', ...(record === end ? ['duration_bucket'] : [])].sort());
	}
	assert.ok(buckets.has(end.properties.duration_bucket));
	assert.deepEqual(events.filter(({ event }) => event === 'export:video_succeeded').map(({ properties }) => properties), [{ format: 'mp4' }]);
	return start.properties.attempt_id;
}
async function downloadEvidence(label, extension, inApp = true) {
	const files = await evaluate(`Promise.all(window.__qaTutorial.downloads.map(async ({name,blob}) => {
		if (!blob) throw new Error('Download did not use a captured real Blob');
		const bytes = new Uint8Array(await blob.arrayBuffer()); let binary=''; for (const byte of bytes) binary+=String.fromCharCode(byte);
		return {name, bytes:btoa(binary), type:blob.type};
	}))`, inApp);
	assert.equal(files.length, 1, 'one actual download handoff');
	const file = files[0]; assert.ok(file.name.endsWith(`.${extension}`));
	const bytes = Buffer.from(file.bytes, 'base64'); assert.ok(bytes.length > 0);
	if (extension === 'mp4') assert.equal(bytes.subarray(4,8).toString(), 'ftyp');
	const path = join(out, `${label}.${extension}`); await writeFile(path, bytes);
	pass('real Blob download handoff (not OS save confirmation)', { path, bytes: bytes.length });
	return extension === 'cclayproject' ? JSON.parse(bytes.toString()) : path;
}
async function studioExport() {
	surface = 'studio'; bridgeAvailable = false;
	await fresh(); await rendererReady();
	const target = await completeSteps();
	await wait(`!!document.querySelector(${JSON.stringify(handoffSelector)})`);
	await handoffScreenshots();
	// Layout resizing changes only viewport aspect, so take preservation
	// snapshots once the desktop renderer has applied its real projection.
	await rendererReady();
	const before = await state('studio-before-handoff');
	assert.equal(before.editing.frameCount, 432);
	assert.ok(target.endFrame-target.startFrame+1 < 432, 'target is narrower than bundled motion; whole-take fallback would fail');
	assert.equal(before.editing.meta.shotIndex, (await shots()).findIndex(shot => shot.id === target.id));
	await change("!!document.querySelector('.export-menu')", () => click('[data-testid="camera-tutorial-handoff-export"]'));
	assert.equal(await evaluate("document.querySelectorAll('.export-menu').length"), 1, 'one existing Export menu');
	assert.deepEqual(await state('studio-menu-open'), before, 'opening contextual Export preserves serialized project, frame, range and cameras');
	assert.deepEqual(lifecycle(), [], 'opening the menu is not an export attempt');
	assert.equal(await evaluate(`!!document.querySelector(${JSON.stringify(handoffSelector)})`), false, 'contextual action does not re-prompt');
	await layout('studio-existing-export-desktop', ['[data-testid="export-video"]', '#export-menu-trigger']);
	await evaluate('window.__qaTutorial.installNative(); true');
	const from = report.events.length;
	try {
		await change("window.__qaTutorial.events.some(({event}) => event === 'export:attempt_succeeded') && window.__qaTutorial.downloads.length === 1 && !document.querySelector('#export-menu-trigger.recording')", () => click('[data-testid="export-video"]'));
		const proof = await evaluate('window.__qaTutorial.native.proof()');
		await writeFile(join(out, 'studio-native-capture.json'), JSON.stringify({ target, ...proof }, null, 2));
		const count = target.endFrame-target.startFrame+1;
		assert.equal(proof.frames.length, count, 'native VideoFrame count equals target inclusive range, not 432-frame motion');
		assert.equal(proof.reads.length, count, 'one native offscreen readback per addressed frame');
		assert.equal(proof.createdFrames, proof.closedFrames); assert.equal(proof.liveFrames, 0);
		assert.equal(proof.createdEncoders, proof.closedEncoders); assert.equal(proof.liveEncoders, 0);
		assert.ok(proof.capturedFramebuffers > 0); assert.equal(proof.capturedFramebuffers, proof.releasedFramebuffers);
		assert.deepEqual(proof.frames.map(({timestamp}) => timestamp), Array.from({length:count}, (_, i) => Math.round(i*1_000_000/before.editing.meta.fps)));
		assert.notEqual(proof.frames[0].hash, proof.frames.at(-1).hash, 'real rendered pixels change across the authored rail and bundled walk');
		const attemptId = assertVideoAttempt(from);
		await downloadEvidence('studio-target-shot', 'mp4');
		await rendererReady();
		assert.deepEqual(await state('studio-after-export'), before, 'native export restores serialized scenes, selected range, frame and both cameras');
		assert.equal(await evaluate(`!!document.querySelector(${JSON.stringify(handoffSelector)})`), false);
		pass('contextual Export -> ordinary video lifecycle; exact target inclusive range despite motion', { attemptId, count });
	} finally {
		await evaluate('window.__qaTutorial.native.restore(); true');
	}
	const receipt = await evaluate(`JSON.parse(localStorage.getItem(${JSON.stringify(terminalKey)}))`);
	assert.equal(receipt.export_started, true, 'ordinary video start records returning-user suppression');
	await navigate('/app/?tutorial=camera'); await rendererReady();
	assert.equal(await evaluate("!!document.querySelector('[data-testid=camera-tutorial]')"), false, 'exported returning user not auto-prompted');
	pass('fresh complete sample to video without Settings/help, exported return stays quiet');
}
async function scrubAway() {
	const old = await evaluate('window.__cozyclay.tlFrame', true);
	const r = await box('.tl-ruler-lane');
	const point = { x:r.x+r.width*0.37, y:r.y+r.height*0.5 };
	await change(`window.__cozyclay.tlFrame !== ${old} && window.__cozyclay.tlFrame > 0`, async () => {
		await mouse('mousePressed', { ...point,button:'left',buttons:1,clickCount:1 });
		await mouse('mouseReleased', { ...point,button:'left',buttons:0,clickCount:1 });
	}, true);
}
async function studioDismissAndRestart() {
	surface = 'studio'; bridgeAvailable = false;
	await fresh(); await rendererReady(); await completeSteps();
	await change("!document.querySelector('[data-testid=camera-tutorial]')", () => click('[data-testid="camera-tutorial-handoff-dismiss"]'));
	await change('!window.__cozyclay.lookThroughShot', () => key('Escape'), true);
	await scrubAway();
	const before = await state('tutorial-owned-before-restart');
	assert.ok(before.editing.frame > 0, 'safety snapshot is not at reset frame zero');
	await restart();
	assert.deepEqual(await state('tutorial-owned-after-restart'), before, 'tutorial-owned restart never reseeds, overwrites or resets camera/playhead');
	assert.equal(await evaluate(`!!document.querySelector(${JSON.stringify(handoffSelector)})`), false, 'dismissed attempt stays hidden on explicit restart');
	await closeTutorial();
	assert.deepEqual(await state('tutorial-owned-after-close'), before, 'close is non-destructive');
	assert.deepEqual(lifecycle(), [], 'dismiss/restart does not invent an export attempt');
	await navigate('/app/?tutorial=camera'); await rendererReady();
	assert.equal(await evaluate("!!document.querySelector('[data-testid=camera-tutorial]')"), false, 'dismissed returning user not auto-prompted');
	pass('tutorial close/dismiss/restart are safe on authored tutorial-owned scene');
}
const safetyScene = {
	version:4, activeSceneId:'private-safety-275', scenes:[{
		id:'private-safety-275', name:'PRIVATE_SCENE_275', objects:[],
		shotDocument:{version:4,frameCount:72,waypoints:[],shots:[{id:'private-cut-275',name:'PRIVATE_SHOT_275',startFrame:0,endFrame:23,camera:{mode:'keys'},cameraKeys:[{id:'private-key-275',frame:0,framing:{pos:{x:0.7,y:1.6,z:4},yaw:-0.2,pitch:-0.1,fovDeg:45}}]}]},
		stage:{characters:[{id:'private-cast-275',model:'y-bot-tpose',x:0,z:0,rot:0,hidden:false,pose:null,subject:'PRIVATE_SUBJECT_275'}],hasCharSheet:false,shotAspect:'16:9'}
	}]
};
async function dirtyProject(named) {
	surface = 'studio'; bridgeAvailable = true;
	await seedStorage();
	await evaluate(`localStorage.setItem('cozyclay.scenes.v4',${JSON.stringify(JSON.stringify(safetyScene))}); ${named ? "localStorage.setItem('cozyclay.project-session.v1',JSON.stringify({name:'PRIVATE_NAMED_275',updatedAt:Date.now()}));" : ''} true`);
	scenarioStart = report.events.length;
	// Query opens steps on this existing document without granting seeding
	// authority. It also dismisses the unnamed startup chooser legitimately.
	await navigate('/app/?tutorial=camera'); await rendererReady();
	assert.equal((await project()).scenes.activeSceneId, safetyScene.activeSceneId);
	assert.equal(await evaluate('window.__cozyclay.motion'), null, 'existing project has no unexpectedly seeded demo walk');
	await closeTutorial();
	const oldShots = (await shots()).length;
	await change(`document.querySelectorAll('.tl-shot-block').length > ${oldShots}`, () => click('.tl-track-add.cut'));
	await scrubAway();
	await releaseFly(await beginFly());
	await frame();
	assert.equal((await shots()).length, oldShots+1);
	// The named document has a saved baseline and a dirty dot. An unnamed
	// document has no baseline; its actual authored change is proven above.
	if (named) assert.equal(await evaluate("!!document.querySelector('.project-dirty-dot')"), true, 'named authoring marks the project dirty');
	const label = named ? 'dirty-named' : 'dirty-unnamed';
	const before = await state(`${label}-before`);
	await restart();
	assert.deepEqual(await state(`${label}-after-start`), before, 'explicit Settings start preserves dirty project byte-for-byte and camera/playhead');
	await restart();
	assert.deepEqual(await state(`${label}-after-open-restart`), before, 'restart while open preserves dirty project');
	await closeTutorial();
	assert.deepEqual(await state(`${label}-after-close`), before, 'dirty project close preserves all state');
	assert.deepEqual(lifecycle(), []);
	pass(`${label}: Settings may show steps but never reseeds, overwrites or resets camera/playhead`);
}
async function priorReceipt(reason) {
	surface = 'studio'; bridgeAvailable = true;
	await seedStorage();
	await evaluate(`localStorage.setItem('cozyclay.scenes.v4',${JSON.stringify(JSON.stringify(safetyScene))}); localStorage.setItem('cozyclay.project-session.v1',JSON.stringify({name:'PRIVATE_RETURN_275',updatedAt:Date.now()})); localStorage.setItem(${JSON.stringify(terminalKey)},JSON.stringify({${reason}:true})); true`);
	scenarioStart = report.events.length;
	await navigate('/app/?tutorial=camera'); await rendererReady();
	assert.equal(await evaluate("!!document.querySelector('[data-testid=camera-tutorial]')"), false);
	assert.deepEqual(tutorial(), [], 'prior receipt auto-query emits no invented attempt');
	const before = await state(`return-${reason}-before`);
	await restart();
	assert.deepEqual(await state(`return-${reason}-after-settings`), before);
	assert.equal(await evaluate(`!!document.querySelector(${JSON.stringify(handoffSelector)})`), false);
	await closeTutorial();
	assert.deepEqual(lifecycle(), []);
	pass(`prior ${reason} receipt stays quiet; explicit Settings preserves existing project`);
}
async function hostedDownload() {
	surface = 'playground'; bridgeAvailable = false;
	await fresh(); await rendererReady(); await completeSteps();
	await wait("!document.querySelector('#tutorial-done').hidden");
	await handoffScreenshots();
	const before = await state('hosted-before-download');
	assert.equal(await evaluate("document.querySelector('#tutorial-done').contains(document.querySelector('#playground-download'))"), true);
	// Copy is evidence in the screenshot/report, not pinned by a prose test.
	pass('hosted action explains .cclayproject and local Studio video boundary', { text: await evaluate("document.querySelector('#tutorial-done').textContent.trim()") });
	await evaluate('window.__qaTutorial.holdProjectResult = true; true');
	await change('!!window.__qaTutorial.heldProjectResult', () => click('#playground-download', false));
	assert.equal(await evaluate("document.querySelector('#playground-download').disabled"), true);
	// Negative trust-boundary inputs are intentionally synthetic; the successful
	// payload is the retained REAL iframe export result, never invented content.
	await evaluate(`(() => {
		const frame=document.querySelector('#playground iframe');
		const data={type:'cozyclay:playground-export-result',serialized:'PRIVATE_FORGED_275'};
		window.dispatchEvent(new MessageEvent('message',{data,source:window,origin:location.origin}));
		window.dispatchEvent(new MessageEvent('message',{data,source:frame.contentWindow,origin:'https://wrong.invalid'}));
		return true;
	})()`);
	assert.equal(await evaluate('window.__qaTutorial.downloads.length'), 0, 'wrong source/origin cannot hand off forged project');
	assert.equal(await evaluate("document.querySelector('#playground-download').disabled"), true, 'forged results cannot consume pending request');
	await change('window.__qaTutorial.downloads.length === 1 && !document.querySelector("#playground-download").disabled', () => evaluate(`(() => {
		window.__qaTutorial.holdProjectResult=false;
		// Send the retained production payload from its actual iframe realm so
		// the browser provides a genuine source/origin (not a synthetic success).
		document.querySelector('#playground iframe').contentWindow.eval('parent.postMessage(parent.__qaTutorial.heldProjectResult.data, location.origin)');
		return true;
	})()`));
	const downloaded = await downloadEvidence('hosted-edited-project','cclayproject',false);
	delete downloaded.savedAt;
	assert.deepEqual(downloaded, before.project, 'download preserves the actual serialized scenes, cuts, rail, camera and bundled motion');
	assert.deepEqual(await state('hosted-after-download'), before, 'project handoff changes no editor state');
	assert.deepEqual(lifecycle(), [], 'local project download remains untracked by export lifecycle: zero invented video attempts');
	assert.equal(await evaluate("!!document.querySelector('#playground iframe')"), true);
	assert.equal(await evaluate("document.querySelector('#tutorial-done').hidden"), true, 'completed local download does not re-prompt');
	pass('hosted real project download, wrong origin/source guards, exact serialization and zero video attempts');
}
async function hostedDismiss() {
	surface = 'playground'; bridgeAvailable = false;
	await fresh(); await rendererReady(); await completeSteps();
	const before = await state('hosted-before-dismiss');
	await evaluate("window.__qaTutorial.originalFrame = document.querySelector('#playground iframe'); true");
	await change("document.querySelector('#tutorial-done').hidden", () => click('#playground-handoff-dismiss',false));
	assert.equal(await evaluate("document.querySelector('#playground iframe') === window.__qaTutorial.originalFrame"), true, 'dismiss retains the same live iframe');
	assert.deepEqual(await state('hosted-after-dismiss'),before);
	// The host button owns keyboard focus after dismissal. Use the real iframe
	// transport to emit another existing Play signal without faking focus/keys.
	await change("!!document.querySelector('.tl-transport .play.on')",()=>click('.tl-transport .play'),true);
	await pauseHosted();
	assert.equal(await evaluate("document.querySelector('#tutorial-done').hidden"),true,'repeated preview cannot redisplay dismissed handoff');
	assert.deepEqual(lifecycle(),[]);
	assert.equal(await evaluate('window.__qaTutorial.downloads.length'),0);
	pass('hosted Continue editing keeps iframe and authored project alive; dismissal stays hidden');
}
async function phoneStart() {
	surface = 'playground'; bridgeAvailable = false;
	await seedStorage(); await viewport(390,844);
	await send('Emulation.setTouchEmulationEnabled',{enabled:true,maxTouchPoints:1});
	await navigate('/index.html');
	await wait("!!document.querySelector('#playground-start')");
	await evaluate("document.querySelector('#playground-start').scrollIntoView({block:'center',behavior:'instant'})");
	const unsupported = await evaluate(`(() => { const e=document.querySelector('.playground-phone'),r=e.getBoundingClientRect(); return {visible:r.width>0&&r.height>0,text:e.textContent,canPlay:matchMedia('(min-width:721px) and (hover:hover)').matches}; })()`);
	assert.equal(unsupported.canPlay,false); assert.equal(unsupported.visible,true);
	await click('#playground-start',false);
	assert.equal(await evaluate("!!document.querySelector('#playground iframe')"),false,'actual phone start remains unsupported, not a fake playable canvas');
	await screenshot('hosted-unsupported-phone-390x844');
	await send('Emulation.setTouchEmulationEnabled',{enabled:false}); await viewport(1440,1000);
	pass('actual phone start remains honestly unsupported',unsupported);
}

let failures = 0;
try {
	await send('Runtime.enable'); await send('Page.enable'); await send('Network.enable');
	await send('Network.setCacheDisabled',{cacheDisabled:true});
	await send('Network.setBlockedURLs',{urls:['https://telemetry.invalid/*','*://t.cozyclay.org/*','*://*.posthog.com/*','*://posthog.com/*']});
	await send('Runtime.addBinding',{name:'__qaTutorialRecord'});
	await send('Fetch.enable',{patterns:[{urlPattern:`${origin}/src/analytics.js*`,requestStage:'Response'},{urlPattern:`${origin}/ardy/health*`,requestStage:'Request'}]});
	await send('Page.addScriptToEvaluateOnNewDocument',{source:`(${installFixture.toString()})(${deadline});`});
	await send('Emulation.setDeviceMetricsOverride',{width:1440,height:1000,deviceScaleFactor:1,mobile:false});
	const scenarios = [
		['studio-export',studioExport],['tutorial-owned-dismiss-restart',studioDismissAndRestart],
		['dirty-named',()=>dirtyProject(true)],['dirty-unnamed',()=>dirtyProject(false)],
		['prior-completed',()=>priorReceipt('completed')],['prior-exported',()=>priorReceipt('export_started')],
		['hosted-download',hostedDownload],['hosted-dismiss',hostedDismiss],['unsupported-phone',phoneStart],
	];
	for (const [name, run] of scenarios) {
		if (process.env.QA_CASE && process.env.QA_CASE !== name) continue;
		const from = report.events.length;
		try {
			await run(); report.scenarios.push({name,status:'passed',events:report.events.slice(from)});
		} catch(error) {
			failures++; report.scenarios.push({name,status:'failed',error:error.stack,events:report.events.slice(from)});
			console.error(`FAIL ${name}: ${error.stack}`);
			try { await screenshot(`${name}-FAIL`); } catch(captureError) { report.pageErrors.push(`Failure screenshot: ${captureError.stack}`); }
		}
	}
	validateShape();
	assert.deepEqual(report.routeErrors,[], 'all analytics SDK routes succeed');
	assert.deepEqual(report.pageErrors,[], 'no App errors hidden by interception');
	assert.deepEqual(report.productionTelemetry,[], 'zero attempted production telemetry');
	assert.equal(report.events.some(({properties}) => JSON.stringify(properties).includes('PRIVATE_')),false,'private project content never crosses SDK sanitizer');
	assert.equal(failures,0,'all real-surface scenarios pass');
	pass('browser handoff QA complete; SDK boundary proof, not OS saves or PostHog delivery',{scenarios:report.scenarios.length,out});
} catch(error) {
	report.failure=error.stack; process.exitCode=1; console.error(error.stack);
} finally {
	await writeFile(join(out,'report.json'),JSON.stringify(report,null,2));
	for(const item of pending.values()) clearTimeout(item.timer);
	ws.close();
}

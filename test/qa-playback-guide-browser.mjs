#!/usr/bin/env node
// P2-c browser QA: studio:ready, the first-success guide, playback:summary,
// agent:panel_toggled, object:deleted_soon / object:delete_undone and the
// end-of-session app:friction_summary, driven through real controls and keys.
// Start Vite separately (a DEV server, not preview), then:
// QA_URL=http://127.0.0.1:5361/app/ CDP_PORT=9561 node tools/qa-browser.mjs -- node test/qa-playback-guide-browser.mjs
// The CDP analytics-module route changes only environment() and the SDK import:
// production track(), sanitizeProps(), before_send and the unload beacon stay
// real. This is a sanitized SDK-boundary spy, NOT proof of PostHog wire delivery.
import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";

const origin = new URL(process.env.QA_URL || "http://127.0.0.1:5361/app/").origin;
const port = Number(process.env.CDP_PORT || 9561);
const out = process.env.QA_OUT || "/tmp/playback-guide-qa";
const timeoutMs = 60_000;
const targets = await (await fetch(`http://127.0.0.1:${port}/json`)).json();
const page = targets.find((target) => target.type === "page" && target.webSocketDebuggerUrl);
assert.ok(page, "QA Chrome must expose a page target");
const ws = new WebSocket(page.webSocketDebuggerUrl);
await new Promise((resolve, reject) => { ws.onopen = resolve; ws.onerror = reject; });
let nextId = 0;
const pending = new Map(), listeners = new Map();
const telemetry = [], pageErrors = [], routeErrors = [];
const P2C_EVENTS = new Set(["studio:ready", "playback:summary", "guide:opened", "guide:step", "guide:dismissed", "guide:completed", "agent:panel_toggled", "object:deleted_soon", "object:delete_undone", "app:friction_summary"]);

ws.onmessage = ({ data }) => {
	const message = JSON.parse(data);
	if (message.id && pending.has(message.id)) {
		const item = pending.get(message.id);
		pending.delete(message.id);
		if (message.error) item.reject(new Error(JSON.stringify(message.error)));
		else item.resolve(message.result);
		return;
	}
	if (message.method === "Runtime.exceptionThrown") pageErrors.push(message.params.exceptionDetails.exception?.description || message.params.exceptionDetails.text);
	if (message.method === "Runtime.bindingCalled" && message.params.name === "__qaP2cRecord") {
		const record = JSON.parse(message.params.payload);
		telemetry.push(record);
		if (P2C_EVENTS.has(record.event)) console.log(`EVENT ${record.via} ${record.event} ${JSON.stringify(record.properties)}`);
	}
	for (const listener of listeners.get(message.method) || []) listener(message.params);
};
const send = (method, params = {}) => new Promise((resolve, reject) => {
	const id = ++nextId;
	pending.set(id, { resolve, reject });
	ws.send(JSON.stringify({ id, method, params }));
});
async function evaluate(expression) {
	const result = await send("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true, timeout: timeoutMs });
	if (result.exceptionDetails) throw new Error(result.exceptionDetails.exception?.description || result.exceptionDetails.text);
	return result.result?.value;
}
async function waitFor(label, predicate, ms = 20_000) {
	const deadline = Date.now() + ms;
	for (;;) {
		const value = await predicate();
		if (value) return value;
		if (Date.now() > deadline) throw new Error(`Timed out: ${label}`);
		await new Promise((resolve) => setTimeout(resolve, 100));
	}
}
const events = (name) => telemetry.filter(({ event }) => event === name);
const waitEvent = (name, count = 1) => waitFor(name, () => events(name).length >= count);
const centerOf = (selector, textPattern = null) => evaluate(`(() => {
	const nodes = [...document.querySelectorAll(${JSON.stringify(selector)})];
	const node = ${textPattern ? `nodes.find((n) => ${textPattern}.test(n.textContent.trim()))` : "nodes[0]"};
	if (!node) return null;
	node.scrollIntoView({ block: "center", inline: "center" });
	const r = node.getBoundingClientRect();
	if (!(r.width > 0 && r.height > 0)) return null;
	for (const fraction of [0.5, 0.35, 0.2, 0.1, 0.65]) {
		const x = r.left + r.width * fraction, y = r.top + r.height / 2;
		const top = document.elementFromPoint(x, y);
		if (top && (top === node || node.contains(top))) return { x, y };
	}
	return null;
})()`);
const mouse = (type, x, y, extra = {}) => send("Input.dispatchMouseEvent", { type, x: Math.round(x), y: Math.round(y), button: "left", clickCount: 1, buttons: type === "mouseReleased" ? 0 : 1, ...extra });
async function click(selector, textPattern = null) {
	const at = await waitFor(`visible ${selector}`, () => centerOf(selector, textPattern));
	await mouse("mouseMoved", at.x, at.y, { buttons: 0 });
	await mouse("mousePressed", at.x, at.y);
	await mouse("mouseReleased", at.x, at.y);
}
async function rightClick(selector) {
	const at = await waitFor(`visible ${selector}`, () => centerOf(selector));
	await mouse("mouseMoved", at.x, at.y, { buttons: 0 });
	await mouse("mousePressed", at.x, at.y, { button: "right", buttons: 2 });
	await mouse("mouseReleased", at.x, at.y, { button: "right", buttons: 0 });
}
async function press(key, code, vk, modifiers = 0) {
	await send("Input.dispatchKeyEvent", { type: "rawKeyDown", key, code, windowsVirtualKeyCode: vk, modifiers });
	await send("Input.dispatchKeyEvent", { type: "keyUp", key, code, windowsVirtualKeyCode: vk, modifiers });
}
async function screenshot(name) {
	const image = await send("Page.captureScreenshot", { format: "png" });
	await writeFile(`${out}/${name}.png`, Buffer.from(image.data, "base64"));
}

// Runs before the studio's own scripts: the SDK spy and the beacon recorder.
function installFixture() {
	localStorage.setItem("cozyclay.locale", "en");
	localStorage.setItem("cozyclay.project-session.v1", JSON.stringify({ name: "QA", updatedAt: Date.now() }));
	let beforeSend;
	window.__qaPosthog = {
		init(_key, options) { beforeSend = options.before_send; },
		register() {}, opt_in_capturing() {}, opt_out_capturing() {},
		has_opted_out_capturing: () => false, get_distinct_id: () => "internal-qa-p2c", get_session_id: () => "qa-session",
		capture(event, properties = {}) {
			const payload = beforeSend({ event, properties: { ...properties } });
			if (payload) window.__qaP2cRecord(JSON.stringify({ via: "sdk", event: payload.event, properties: payload.properties }));
		},
	};
	const sendBeacon = navigator.sendBeacon?.bind(navigator);
	navigator.sendBeacon = (url, body) => {
		void Promise.resolve(typeof body?.text === "function" ? body.text() : String(body)).then((text) => {
			const parsed = JSON.parse(text);
			window.__qaP2cRecord(JSON.stringify({ via: "beacon", event: parsed.event, properties: parsed.properties }));
		});
		return String(url).includes("telemetry.invalid") ? true : sendBeacon?.(url, body);
	};
}

listeners.set("Fetch.requestPaused", new Set([(request) => {
	void (async () => {
		const { body, base64Encoded } = await send("Fetch.getResponseBody", { requestId: request.requestId });
		let source = base64Encoded ? Buffer.from(body, "base64").toString("utf8") : body;
		assert.equal((source.match(/return import\.meta\.env \?\? \{\};/g) || []).length, 1, "analytics environment seam changed");
		source = source.replace("return import.meta.env ?? {};", "return { PROD: true, VITE_POSTHOG_KEY: 'internal-qa-p2c', VITE_POSTHOG_HOST: 'https://telemetry.invalid', VITE_POSTHOG_ALLOWED_ORIGINS: location.origin };");
		const sdkImport = /await import\([^)]*posthog[^)]*\)/g;
		assert.equal((source.match(sdkImport) || []).length, 1, "analytics SDK import seam changed");
		source = source.replace(sdkImport, "await Promise.resolve({ default: window.__qaPosthog })");
		await send("Fetch.fulfillRequest", { requestId: request.requestId, responseCode: 200, responseHeaders: [{ name: "Content-Type", value: "text/javascript" }, { name: "Cache-Control", value: "no-store" }], body: Buffer.from(source).toString("base64") });
	})().catch(async (error) => {
		routeErrors.push(error.message);
		try { await send("Fetch.failRequest", { requestId: request.requestId, errorReason: "Failed" }); } catch (failure) { routeErrors.push(failure.message); }
	});
}]));

try {
	await mkdir(out, { recursive: true });
	await send("Runtime.enable");
	await send("Page.enable");
	await send("Network.setCacheDisabled", { cacheDisabled: true });
	await send("Runtime.addBinding", { name: "__qaP2cRecord" });
	await send("Fetch.enable", { patterns: [{ urlPattern: "*/src/analytics.js*", requestStage: "Response" }] });
	await send("Page.addScriptToEvaluateOnNewDocument", { source: `(${installFixture.toString()})();` });
	await send("Emulation.setDeviceMetricsOverride", { width: 1440, height: 1000, deviceScaleFactor: 1, mobile: false });
	const loaded = new Promise((resolve) => listeners.set("Page.loadEventFired", new Set([resolve])));
	await send("Page.navigate", { url: `${origin}/app/` });
	await loaded;

	// 1. Boot.
	await waitEvent("studio:ready");
	await waitFor("studio QA hook", () => evaluate("Boolean(window.__cozyclay?.rigA) && !!document.querySelector('.timeline')"));
	console.log("STEP boot done");

	// 2. A new project opens the guide; step twice, then skip.
	await evaluate("window.confirm = () => true; true");
	await click("[data-testid=menu-file]");
	await click("[data-testid=menubar-new]");
	await waitFor("new-project dialog", () => evaluate("!!document.querySelector('[data-testid=start-create]')"));
	await click("[data-testid=start-create]");
	await waitFor("guide open", () => evaluate("!!document.querySelector('.first-success-guide')"));
	await waitEvent("guide:opened");
	await click(".first-success-guide-next");
	await waitEvent("guide:step", 1);
	await click(".first-success-guide-next");
	await waitEvent("guide:step", 2);
	await screenshot("guide-step-3");
	await click(".first-success-guide-skip");
	await waitEvent("guide:dismissed");
	console.log("STEP guide done");

	// 3. Play 3 s at 24 fps with Space, then stop with Space.
	await evaluate("document.activeElement?.blur?.(); true");
	// window.__cozyclay.playing/tlFrame are render snapshots; the playhead box's position is the live proof.
	const playhead = "document.querySelector('.tl-frame-box')?.style.getPropertyValue('--tl-f') ?? null";
	const startFrame = await evaluate(playhead);
	await press(" ", "Space", 32);
	await new Promise((resolve) => setTimeout(resolve, 3000));
	const midFrame = await evaluate(playhead);
	await screenshot("playing");
	await press(" ", "Space", 32);
	await waitEvent("playback:summary");
	console.log(`STEP playback done (playhead --tl-f ${startFrame} -> ${midFrame} after ~3 s)`);
	assert.notEqual(midFrame, startFrame, "the playhead moved while playing");

	// 4. Cmd/Ctrl+B by key.
	await press("b", "KeyB", 66, 2);
	await waitEvent("agent:panel_toggled");
	console.log("STEP agent panel done");

	// 5. Add a cube from the Outliner's create menu, delete it with Delete within 2 s, undo from the toast.
	await evaluate(`(() => { const fold = document.querySelector('[data-node-id="props"] .hierarchy-toggle'); if (fold && fold.textContent.trim() === "▸") fold.click(); return true; })()`);
	await rightClick('[data-node-id="props"] .hierarchy-row');
	await click(".v2-outliner .hierarchy-context-menu .add-object-item", /^Cube/);
	const createdAt = Date.now();
	await waitFor("cube selected", () => evaluate(`document.querySelector(".v2-outliner .hierarchy-row-wrap.selected")?.dataset.nodeId?.startsWith("object:")`));
	await evaluate("document.activeElement?.blur?.(); true");
	await press("Delete", "Delete", 46);
	const deleteMs = Date.now() - createdAt;
	await waitEvent("object:deleted_soon");
	await click('[aria-label="Undo object deletion"]');
	await waitEvent("object:delete_undone");
	console.log(`STEP delete regret done (create -> delete ${deleteMs} ms)`);
	await screenshot("after-undo");

	// 6. End of session: the unload beacon carries app:friction_summary.
	await evaluate("window.dispatchEvent(new PageTransitionEvent('pagehide', { persisted: false })); true");
	await waitEvent("app:friction_summary");

	const one = (name) => { assert.equal(events(name).length, 1, `exactly one ${name}`); return events(name)[0].properties; };
	assert.ok(["lt2s", "2-5s", "5-15s", "gte15s"].includes(one("studio:ready").boot));
	assert.deepEqual(events("guide:step").map(({ properties }) => properties.step), ["1", "2"]);
	assert.equal(one("guide:dismissed").reached, "3");
	assert.equal(events("guide:completed").length, 0, "a skipped guide is not completed");
	const playback = one("playback:summary");
	assert.equal(playback.fps, "24");
	assert.equal(playback.speed, "1");
	assert.deepEqual([one("agent:panel_toggled").open, one("agent:panel_toggled").via], [true, "key"]);
	if (deleteMs < 2000) assert.equal(one("object:deleted_soon").age, "lt2s");
	assert.ok(["lt2s", "2-10s"].includes(one("object:delete_undone").age));
	const summary = one("app:friction_summary");
	assert.ok(Object.hasOwn(summary, "late_tick_ratio"));
	console.log(`RESULT late_tick_ratio=${summary.late_tick_ratio} playback.late_ticks=${playback.late_ticks} max_catchup=${playback.max_catchup} measured_fps=${playback.measured_fps}`);
	assert.equal(summary.late_tick_ratio, playback.late_ticks, "the only playback run feeds the session ratio");
	const p2cProps = JSON.stringify(telemetry.filter(({ event }) => P2C_EVENTS.has(event) && event !== "app:friction_summary").map(({ properties }) => properties));
	assert.equal(/cube|"id"/i.test(p2cProps), false, "no object id or name in any property");
	assert.deepEqual(routeErrors, [], "module routing has no errors");
	assert.deepEqual(pageErrors, [], "browser has no uncaught page errors");
	console.log("PASS P2-c browser QA: studio:ready, guide, playback:summary, agent:panel_toggled, delete regret, friction summary");
} finally {
	await mkdir(out, { recursive: true });
	await writeFile(`${out}/report.json`, JSON.stringify({ proof: "real studio and sanitizer; SDK-boundary spy, not live PostHog delivery", telemetry, routeErrors, pageErrors }, null, 2));
	ws.close();
}

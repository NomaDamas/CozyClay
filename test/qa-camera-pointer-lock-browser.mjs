#!/usr/bin/env node
// Browser QA for camera pointer lock: a right-drag on the free camera must
// still turn the view (clientX fallback or movementX under lock), and the
// canvas must have asked the browser to lock the pointer.
import { mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const port = Number(process.env.CDP_PORT || 9222);
const appUrl = (process.env.QA_URL || "http://127.0.0.1:5180/app/").replace(/\?.*$/, "");
const shotDir = process.env.QA_SHOT_DIR || join(tmpdir(), "camera-pointer-lock-qa");
mkdirSync(shotDir, { recursive: true });

const targets = await (await fetch(`http://127.0.0.1:${port}/json`)).json();
const page = targets.find((target) => target.type === "page" && target.webSocketDebuggerUrl);
if (!page) throw new Error("no page target on the QA browser");
const ws = new WebSocket(page.webSocketDebuggerUrl);
await new Promise((resolve, reject) => { ws.onopen = resolve; ws.onerror = reject; });
let nextId = 1;
const pending = new Map();
ws.onmessage = (event) => {
	const message = JSON.parse(event.data);
	if (!message.id || !pending.has(message.id)) return;
	const { resolve, reject } = pending.get(message.id);
	pending.delete(message.id);
	if (message.error) reject(new Error(JSON.stringify(message.error)));
	else resolve(message.result);
};
const send = (method, params = {}) => new Promise((resolve, reject) => {
	const id = nextId++;
	pending.set(id, { resolve, reject });
	ws.send(JSON.stringify({ id, method, params }));
});
const evaluate = async (expression) => {
	const result = await send("Runtime.evaluate", { expression, returnByValue: true, awaitPromise: true });
	if (result.exceptionDetails) throw new Error(result.exceptionDetails.exception?.description || "evaluate failed");
	return result.result.value;
};
const waitFor = async (expression, timeoutMs = 20000) => {
	const deadline = Date.now() + timeoutMs;
	while (Date.now() < deadline) {
		if (await evaluate(expression).catch(() => false)) return true;
		await new Promise((resolve) => setTimeout(resolve, 60));
	}
	return false;
};
let failures = 0;
const expect = (name, condition, detail = "") => {
	console.log(`${condition ? "PASS" : "FAIL"} ${name}${condition ? "" : ` — ${detail}`}`);
	if (!condition) failures += 1;
};
const mouse = (type, params) => send("Input.dispatchMouseEvent", { type, ...params });

await waitFor("location.href.startsWith('http')", 30000);
await evaluate("localStorage.setItem('cozyclay.locale', 'en')");
await send("Page.enable");
await send("Page.navigate", { url: `${appUrl}?motion=/demo/walk-then-stop.npz` });
expect("the studio comes up", await waitFor("!!window.__cozyclay?.editorCam", 40000));
expect("the stage canvas is on screen", await waitFor("!!document.querySelector('.stage canvas')", 15000));
expect("look-through is off so the free camera flies", await evaluate("window.__cozyclay?.lookThroughShot !== true && globalThis.playMode === false"));

const canvas = await evaluate(`(() => {
	const el = document.querySelector(".stage canvas");
	if (!el) return null;
	const r = el.getBoundingClientRect();
	return { x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2) };
})()`);
expect("the canvas has a centre", !!canvas, JSON.stringify(canvas));

await evaluate(`(() => {
	const canvas = document.querySelector(".stage canvas");
	window.__cozyclayLockCalls = 0;
	const original = canvas.requestPointerLock?.bind(canvas);
	canvas.requestPointerLock = function (...args) {
		window.__cozyclayLockCalls += 1;
		try { return original ? original(...args) : undefined; } catch { return undefined; }
	};
})()`);

const before = await evaluate("(() => { const r = window.__cozyclay.editorCam.rotation; return { x: r.x, y: r.y }; })()");
await mouse("mousePressed", { x: canvas.x, y: canvas.y, button: "right", buttons: 2, clickCount: 1 });
await mouse("mouseMoved", { x: canvas.x + 90, y: canvas.y + 24, button: "right", buttons: 2 });
await mouse("mouseMoved", { x: canvas.x + 160, y: canvas.y + 40, button: "right", buttons: 2 });
await mouse("mouseReleased", { x: canvas.x + 160, y: canvas.y + 40, button: "right", buttons: 0, clickCount: 1 });

expect(
	"right-drag turned the free camera",
	await waitFor(`(() => {
		const r = window.__cozyclay.editorCam.rotation;
		const b = ${JSON.stringify(before)};
		return Math.abs(r.x - b.x) > 0.01 || Math.abs(r.y - b.y) > 0.01;
	})()`, 8000),
	JSON.stringify({ before, after: await evaluate("(() => { const r = window.__cozyclay.editorCam.rotation; return { x: r.x, y: r.y }; })()") }),
);
expect(
	"the canvas requested pointer lock during the hold",
	await waitFor("window.__cozyclayLockCalls > 0", 4000),
	String(await evaluate("window.__cozyclayLockCalls")),
);

const capture = await send("Page.captureScreenshot", { format: "png" });
writeFileSync(join(shotDir, "free-camera-right-drag.png"), Buffer.from(capture.data, "base64"));
console.log(`screenshot ${join(shotDir, "free-camera-right-drag.png")}`);

if (failures > 0) {
	console.error(`${failures} FAILURES`);
	process.exit(1);
}
console.log("qa-camera-pointer-lock-browser: all checks passed");

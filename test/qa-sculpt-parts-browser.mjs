#!/usr/bin/env node
// Browser QA for Sculpt mode part picking (#740 S7): a click on the turntable
// selects the part under the pointer and presses its row in the Sculpt panel's
// part tree; a mirrored copy selects its source part, marked as the copy; a
// row press selects the same way; an orbit drag, a click on empty space and
// Esc behave as the spec says, and the scene selection never changes.
// Run through tools/qa-browser.mjs with QA_URL pointing at `/app/`.

import { mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const port = Number(process.env.CDP_PORT || 9222);
const out = process.env.QA_OUT || join(tmpdir(), "cozyclay-qa-sculpt-parts");
// sculpt-mode.js SCULPT_LAYER: only the sculpt camera sees this layer.
const SCULPT_LAYER = 6;
const recipe = { version: 1, parts: [
	{ id: "body", shape: "blob", size: [1, 1, 0.9], position: [0, 0.5, 0], rotation: [0, 0, 0], color: "#3f5f5a" },
	{ id: "head", shape: "blob", size: [0.7, 0.6, 0.6], position: [0, 1.25, 0], rotation: [0, 0, 0], color: "#4f7a72" },
	{ id: "eye", parent: "head", mirror: true, shape: "blob", size: [0.16, 0.16, 0.12], position: [0.17, 0.05, 0.28], rotation: [0, 0, 0], color: "#f4f4f4" },
] };
await mkdir(out, { recursive: true });
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
const waitForPageLoad = (timeoutMs = 30000) => new Promise((resolve, reject) => {
	let settled = false;
	const finish = (error) => {
		if (settled) return;
		settled = true;
		ws.removeEventListener("message", onMessage);
		clearTimeout(timer);
		if (error) reject(error);
		else resolve();
	};
	const onMessage = (event) => {
		if (JSON.parse(event.data).method === "Page.loadEventFired") finish();
	};
	const timer = setTimeout(() => finish(new Error("timed out waiting for the QA page to load")), timeoutMs);
	ws.addEventListener("message", onMessage);
});
const evaluate = async (expression) => {
	const result = await send("Runtime.evaluate", { expression, returnByValue: true, awaitPromise: true });
	if (result.exceptionDetails) throw new Error(result.exceptionDetails.exception?.description || "evaluate failed");
	return result.result.value;
};
const reload = async () => {
	const loaded = waitForPageLoad();
	await send("Page.reload", { ignoreCache: true });
	await loaded;
};
// DOM conditions settle on a mutation; scene-graph conditions (layers, records
// read through the QA hook) settle on a rendered frame. Both are bounded.
const waitFor = (condition, timeoutMs = 15000) => evaluate(`new Promise((resolve) => {
	let settled = false;
	const finish = (value) => {
		if (settled) return;
		settled = true;
		observer.disconnect();
		clearTimeout(timer);
		resolve(value);
	};
	const check = () => {
		let value = false;
		try { value = Boolean(${condition}); } catch {}
		if (value) finish(true);
	};
	const observer = new MutationObserver(check);
	observer.observe(document.documentElement, { childList: true, subtree: true, attributes: true, characterData: true });
	const timer = setTimeout(() => finish(false), ${timeoutMs});
	check();
})`);
const waitForFrame = (condition, timeoutMs = 15000) => evaluate(`new Promise((resolve) => {
	const deadline = performance.now() + ${timeoutMs};
	const tick = () => {
		let value = false;
		try { value = Boolean(${condition}); } catch {}
		if (value) return resolve(true);
		if (performance.now() > deadline) return resolve(false);
		requestAnimationFrame(tick);
	};
	tick();
})`);
const screenshot = async (name) => {
	const result = await send("Page.captureScreenshot", { format: "png" });
	const path = join(out, name);
	await writeFile(path, Buffer.from(result.data, "base64"));
	console.log(`SCREENSHOT ${path}`);
	return path;
};
const KEY_CODES = { Digit5: ["5", 53], Escape: ["Escape", 27] };
const press = async (code) => {
	const [key, windowsVirtualKeyCode] = KEY_CODES[code];
	await evaluate("document.activeElement?.blur?.()");
	await send("Input.dispatchKeyEvent", { type: "rawKeyDown", code, key, windowsVirtualKeyCode });
	await send("Input.dispatchKeyEvent", { type: "keyUp", code, key, windowsVirtualKeyCode });
};
const mouse = (type, x, y) => send("Input.dispatchMouseEvent", { type, x, y, button: "left", buttons: type === "mouseReleased" ? 0 : 1, clickCount: 1 });
const clickAt = async (at) => {
	if (!Number.isFinite(at?.x)) throw new Error(`no screen point: ${JSON.stringify(at)}`);
	const { x, y } = at;
	await mouse("mousePressed", x, y);
	await mouse("mouseReleased", x, y);
};
const dragFrom = async ({ x, y }, dx) => {
	await mouse("mousePressed", x, y);
	for (let step = 1; step <= 6; step += 1) await send("Input.dispatchMouseEvent", { type: "mouseMoved", x: x + (dx * step) / 6, y, button: "left", buttons: 1 });
	await mouse("mouseReleased", x + dx, y);
};
const mode = () => evaluate("document.querySelector('[data-workflow-mode]')?.dataset.workflowMode ?? null");
const pressedRow = () => evaluate(`(() => { const row = document.querySelector("[data-testid=sculpt-part-row][aria-pressed=true]"); return row ? { part: row.dataset.part, mirrored: row.dataset.mirrored === "true" } : null; })()`);
const waitForRow = (part, mirrored = false) => waitFor(part === null
	? "!document.querySelector('[data-testid=sculpt-part-row][aria-pressed=true]')"
	: `(() => { const row = document.querySelector("[data-testid=sculpt-part-row][aria-pressed=true]"); return row?.dataset.part === ${JSON.stringify(part)} && (row.dataset.mirrored === "true") === ${mirrored}; })()`, 5000);
// The scene's own selection (the Stage selection): the hierarchy's selected row.
const sceneSelection = () => evaluate("document.querySelector('.hierarchy-row-wrap.selected')?.dataset.nodeId ?? null");
// Where a part's centre (plus a world offset) lands on screen,
// through the sculpt camera, in the main pane's client rect.
const screenPoint = (sculptId, part, offset = [0, 0, 0]) => evaluate(`(() => {
	let root = window.__cozyclay?.editorCam;
	while (root?.parent) root = root.parent;
	let camera = null, mesh = null, object = null;
	root.traverse((node) => {
		// The sculpt camera is none of the studio's own (the render loop re-layers cameras between frames).
		const studio = [window.__cozyclay.editorCam, window.__cozyclay.shotCam, window.__cozyclay.poserCam, window.__cozyclay.planCam];
		if (node.isPerspectiveCamera && !studio.includes(node)) camera = node;
		if (node.userData?.sceneObjectId === ${JSON.stringify(sculptId)}) object = node;
	});
	object?.traverse((node) => { if (node.userData?.sculptPart === ${JSON.stringify(part)}) mesh = node; });
	if (!camera || !mesh) return { missing: { camera: Boolean(camera), mesh: Boolean(mesh), object: Boolean(object) } };
	mesh.geometry.computeBoundingSphere();
	const point = mesh.geometry.boundingSphere.center.clone().applyMatrix4(mesh.matrixWorld);
	point.x += ${offset[0]}; point.y += ${offset[1]}; point.z += ${offset[2]};
	point.project(camera);
	const pane = document.querySelector(".vp-pane.vp-main").getBoundingClientRect();
	return { x: pane.left + ((point.x + 1) / 2) * pane.width, y: pane.top + ((1 - point.y) / 2) * pane.height };
})()`);
const outlineShells = () => evaluate(`(() => {
	let root = window.__cozyclay?.editorCam;
	while (root?.parent) root = root.parent;
	const shells = [];
	root.traverse((node) => { const source = node.userData?.source; if (node.isMesh && source?.userData?.sculptPart) shells.push({ part: source.userData.sculptPart, onlySculptLayer: node.layers.mask === ${1 << SCULPT_LAYER} }); });
	return shells;
})()`);

await send("Page.enable");
await send("Emulation.setDeviceMetricsOverride", { width: 1440, height: 900, deviceScaleFactor: 1, mobile: false });
let failures = 0;
const expect = (name, condition, detail = "") => {
	console.log(`${condition ? "PASS" : "FAIL"} ${name}${condition ? "" : ` — ${detail}`}`);
	if (!condition) failures += 1;
};

await reload();
expect("the editor opens", await waitFor("!document.querySelector('.v2-start-screen') && !!document.querySelector('.timeline') && !!window.__cozyclay?.runStudioAction", 30000));
await press("Digit5");
expect("key 5 enters Sculpt mode", await waitFor("document.querySelector('[data-workflow-mode]')?.dataset.workflowMode === 'sculpt'"), await mode());
const sculptId = await evaluate(`window.__cozyclay.runStudioAction("object.sculpt", { recipe: ${JSON.stringify(recipe)}, name: "QA Parts" })?.affectedIds?.[0] ?? null`);
expect("object.sculpt creates the sculpt", Boolean(sculptId));
await evaluate(`window.__cozyclay.runStudioAction("view.select", { selection: { kind: "object", id: ${JSON.stringify(sculptId)} } })`);
expect("the panel lists the parts", await waitFor("document.querySelectorAll('[data-testid=sculpt-part-row]').length === 3"), await evaluate("document.querySelectorAll('[data-testid=sculpt-part-row]').length"));
expect("the turntable draws the sculpt", await waitForFrame(`(() => { let root = window.__cozyclay?.editorCam; while (root?.parent) root = root.parent; let on = false; root.traverse((node) => { if (node.userData?.sculptPart === "eye.mirror" && node.layers.isEnabled(${SCULPT_LAYER})) on = true; }); return on; })()`));
// Let the framing settle (the turntable refits on a new target).
await waitForFrame("false", 600);
const selectionBefore = await sceneSelection();
expect("the scene selection is the sculpt", selectionBefore === `object:${sculptId}`, selectionBefore);
expect("no part starts selected", (await pressedRow()) === null, JSON.stringify(await pressedRow()));

// --- Click the head -----------------------------------------------------------
await clickAt(await screenPoint(sculptId, "head", [0, 0.22, 0]));
expect("a click on the head presses the head row", await waitForRow("head"), JSON.stringify(await pressedRow()));
expect("the head is outlined on the sculpt layer only", await waitForFrame(`(() => { let root = window.__cozyclay?.editorCam; while (root?.parent) root = root.parent; let n = 0; root.traverse((node) => { if (node.isMesh && node.userData?.source?.userData?.sculptPart === "head" && node.layers.mask === ${1 << SCULPT_LAYER}) n += 1; }); return n === 2; })()`), JSON.stringify(await outlineShells()));
expect("a part click leaves the scene selection alone", (await sceneSelection()) === selectionBefore, await sceneSelection());
await screenshot("sculpt-parts-01-head.png");

// --- Click the mirrored eye -------------------------------------------------------
await clickAt(await screenPoint(sculptId, "eye.mirror"));
expect("a click on the mirrored eye presses the eye row, marked as the copy", await waitForRow("eye", true), JSON.stringify(await pressedRow()));
expect("both eyes are outlined", await waitForFrame(`(() => { let root = window.__cozyclay?.editorCam; while (root?.parent) root = root.parent; const parts = []; root.traverse((node) => { if (node.isMesh && node.userData?.source) parts.push(node.userData.source.userData.sculptPart); }); return parts.sort().join() === "eye,eye,eye.mirror,eye.mirror"; })()`), JSON.stringify(await outlineShells()));
expect("the mirror copy chip shows", await evaluate("document.querySelector('[data-testid=sculpt-part-row][aria-pressed=true] .sculpt-part-tag')?.textContent === 'mirror copy'"));
await screenshot("sculpt-parts-02-mirror-eye.png");
await clickAt(await screenPoint(sculptId, "eye"));
expect("a click on the source eye presses the eye row, not as the copy", await waitForRow("eye", false), JSON.stringify(await pressedRow()));

// --- An orbit drag is not a click ----------------------------------------------------
await dragFrom(await screenPoint(sculptId, "body"), 60);
await waitForFrame("false", 300);
expect("an orbit drag over the body keeps the eye selected", JSON.stringify(await pressedRow()) === JSON.stringify({ part: "eye", mirrored: false }), JSON.stringify(await pressedRow()));

// --- A row press ----------------------------------------------------------------------
expect("the body row is clickable", await evaluate("(() => { const row = document.querySelector('[data-testid=sculpt-part-row][data-part=body]'); row?.click(); return Boolean(row); })()"));
expect("a row press selects that part", await waitForRow("body"), JSON.stringify(await pressedRow()));

// --- Empty space clears -----------------------------------------------------------------
await clickAt(await screenPoint(sculptId, "body", [2.4, 1.4, 0]));
expect("a click on empty space clears the part", await waitForRow(null), JSON.stringify(await pressedRow()));
await screenshot("sculpt-parts-03-cleared.png");
expect("no outline is left", await waitForFrame("true") && (await outlineShells()).length === 0, JSON.stringify(await outlineShells()));

// --- Esc clears the part first, then the scene selection as before ----------------------------
await clickAt(await screenPoint(sculptId, "head", [0, 0.22, 0]));
expect("the head is picked again", await waitForRow("head"), JSON.stringify(await pressedRow()));
await press("Escape");
expect("Esc clears the part", await waitForRow(null), JSON.stringify(await pressedRow()));
expect("that Esc leaves the scene selection alone", (await sceneSelection()) === selectionBefore, await sceneSelection());
expect("Esc keeps Sculpt mode", (await mode()) === "sculpt", await mode());

ws.close();
if (failures > 0) {
	console.error(`\n${failures} sculpt-parts check(s) failed`);
	process.exit(1);
}
console.log("\nAll sculpt-parts checks passed");

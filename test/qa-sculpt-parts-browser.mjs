#!/usr/bin/env node
// Browser QA for Sculpt mode part picking (#740 S7): a click on the turntable
// selects the part under the pointer and presses its row in the Sculpt panel's
// part tree; a mirrored copy selects its source part, marked as the copy; a
// row press selects the same way; an orbit drag, a click on empty space and
// Esc behave as the spec says, and the scene selection never changes.
// Then the part gizmo (#740 S8): W/E/R pick its tool only while a part is
// selected; a real handle drag moves the part (one undo puts it back); the
// mirrored copy drags its pair; Shift scales uniformly; a refused scale snaps
// back with the reason; Delete never takes the whole sculpt from a part.
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
const KEY_CODES = { Digit5: ["5", 53], Escape: ["Escape", 27], KeyW: ["w", 87], KeyE: ["e", 69], KeyR: ["r", 82], KeyZ: ["z", 90], Delete: ["Delete", 46] };
// modifiers: 2 = Ctrl (the studio's undo takes Ctrl or Cmd), 8 = Shift.
const press = async (code, modifiers = 0) => {
	const [key, windowsVirtualKeyCode] = KEY_CODES[code];
	await evaluate("document.activeElement?.blur?.()");
	await send("Input.dispatchKeyEvent", { type: "rawKeyDown", code, key, windowsVirtualKeyCode, modifiers });
	await send("Input.dispatchKeyEvent", { type: "keyUp", code, key, windowsVirtualKeyCode, modifiers });
};
const mouse = (type, x, y, modifiers = 0) => send("Input.dispatchMouseEvent", { type, x, y, modifiers, button: "left", buttons: type === "mouseReleased" ? 0 : 1, clickCount: 1 });
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
// An open menu takes the first Esc; the part stays until the menu has closed.
await evaluate("document.querySelector('[data-testid=menu-file]')?.click()");
expect("the File menu opens over a selected part", await waitFor("!!document.querySelector('[role=menu]')"), "no menu");
await press("Escape");
expect("Esc closes the menu", await waitFor("!document.querySelector('[role=menu]')"), "menu still open");
expect("that Esc keeps the part", JSON.stringify(await pressedRow()) === JSON.stringify({ part: "head", mirrored: false }), JSON.stringify(await pressedRow()));
await press("Escape");
expect("Esc clears the part", await waitForRow(null), JSON.stringify(await pressedRow()));
expect("that Esc leaves the scene selection alone", (await sceneSelection()) === selectionBefore, await sceneSelection());
expect("Esc keeps Sculpt mode", (await mode()) === "sculpt", await mode());

// --- The part gizmo (#740 S8) -----------------------------------------------------------------
const toolKeys = () => evaluate("[...document.querySelectorAll('.vp-tool-key')].map((b) => b.dataset.tool + (b.classList.contains('active') ? '*' : '')).join()");
const recipeNow = () => evaluate(`JSON.stringify(window.__cozyclay.objects.find((o) => o.id === ${JSON.stringify(sculptId)})?.recipe ?? null)`);
const partNow = async (id) => JSON.parse(await recipeNow())?.parts.find((part) => part.id === id) ?? null;
const notice = () => evaluate("document.querySelector('[data-testid=sculpt-part-notice]')?.textContent ?? null");
// A handle of the live gizmo: where its +axis picker sits on screen, and where the gizmo's centre is.
const gizmoHandle = (mode, axis) => evaluate(`(() => {
	let root = window.__cozyclay?.editorCam;
	while (root?.parent) root = root.parent;
	let camera = null, gizmo = null;
	const studio = [window.__cozyclay.editorCam, window.__cozyclay.shotCam, window.__cozyclay.poserCam, window.__cozyclay.planCam];
	root.traverse((node) => {
		if (node.isPerspectiveCamera && !studio.includes(node)) camera = node;
		if (node.type === "TransformControlsGizmo") gizmo = node;
	});
	if (!camera || !gizmo || !gizmo.parent?.visible) return { missing: { camera: Boolean(camera), gizmo: Boolean(gizmo), visible: Boolean(gizmo?.parent?.visible) } };
	// Handle offsets are baked into each picker's geometry (setupGizmo), so the +axis one is found by its box.
	const centreOf = (node) => { node.geometry.computeBoundingSphere(); return node.geometry.boundingSphere.center.clone(); };
	const handle = gizmo.picker[${JSON.stringify(mode)}].children.find((node) => node.name === ${JSON.stringify(axis)} && centreOf(node).toArray().reduce((a, b) => a + b, 0) > 0);
	const pane = document.querySelector(".vp-pane.vp-main").getBoundingClientRect();
	const toScreen = (point) => { point.project(camera); return { x: pane.left + ((point.x + 1) / 2) * pane.width, y: pane.top + ((1 - point.y) / 2) * pane.height }; };
	// Half again out along the handle (its outer half): the picker cones fatten toward the camera near the centre.
	const origin = handle.getWorldPosition(handle.position.clone());
	const at = toScreen(centreOf(handle).applyMatrix4(handle.matrixWorld).sub(origin).multiplyScalar(1.5).add(origin));
	const centre = toScreen(origin.clone());
	return { x: at.x, y: at.y, centre };
})()`);
// A real handle drag: hover (the gizmo picks its axis on hover), press, travel in steps, release.
const dragHandle = async (handle, dx, dy, modifiers = 0) => {
	if (!Number.isFinite(handle?.x)) throw new Error(`no gizmo handle: ${JSON.stringify(handle)}`);
	await mouse("mouseMoved", handle.x - 2, handle.y);
	await send("Input.dispatchMouseEvent", { type: "mouseMoved", x: handle.x, y: handle.y, modifiers, button: "none", buttons: 0 });
	await mouse("mousePressed", handle.x, handle.y, modifiers);
	for (let step = 1; step <= 8; step += 1) await send("Input.dispatchMouseEvent", { type: "mouseMoved", x: handle.x + (dx * step) / 8, y: handle.y + (dy * step) / 8, modifiers, button: "left", buttons: 1 });
	await mouse("mouseReleased", handle.x + dx, handle.y + dy, modifiers);
};
// Along the handle's own screen direction, `pixels` past where it starts.
const along = (handle, pixels) => {
	const vx = handle.x - handle.centre.x, vy = handle.y - handle.centre.y, length = Math.hypot(vx, vy) || 1;
	return [(vx / length) * pixels, (vy / length) * pixels];
};
const undoKey = () => press("KeyZ", 2);

// W with no part selected is the front view, squared up for the gizmo checks.
await press("KeyW");
await waitForFrame("false", 400);
expect("with no part selected, W/E/R are the turntable views", (await toolKeys()).replace(/\*/g, "") === "front,side,back", await toolKeys());
expect("the view keys say what they do with a part", await evaluate("document.querySelector('.vp-tool-key[data-tool=front]')?.title.includes('with a part selected, W moves it')"), await evaluate("document.querySelector('.vp-tool-key[data-tool=front]')?.title"));
await clickAt(await screenPoint(sculptId, "head", [0, 0.22, 0]));
expect("the head is picked for the gizmo", await waitForRow("head"), JSON.stringify(await pressedRow()));
expect("a selected part turns W/E/R into move, rotate and scale", await waitFor("[...document.querySelectorAll('.vp-tool-key')].map((b) => b.dataset.tool).join() === 'move,rotate,scale'"), await toolKeys());
await press("KeyE");
expect("E picks rotate", await waitFor("document.querySelector('.vp-tool-key.active')?.dataset.tool === 'rotate'"), await toolKeys());
await press("KeyR");
expect("R picks scale", await waitFor("document.querySelector('.vp-tool-key.active')?.dataset.tool === 'scale'"), await toolKeys());
await press("KeyW");
expect("W picks move", await waitFor("document.querySelector('.vp-tool-key.active')?.dataset.tool === 'move'"), await toolKeys());
expect("the gizmo is on the sculpt layer only", await waitForFrame(`(() => { let root = window.__cozyclay?.editorCam; while (root?.parent) root = root.parent; let ok = null; root.traverse((node) => { if (node.type === "TransformControlsGizmo") { ok = true; node.traverse((child) => { if (child.layers.mask !== ${1 << SCULPT_LAYER}) ok = false; }); } }); return ok === true; })()`));

// Move: drag the X arrow; the head moves along x, one write, one undo back.
const recipeBefore = await recipeNow();
const headBefore = await partNow("head");
let handle = await gizmoHandle("translate", "X");
await dragHandle(handle, ...along(handle, 70));
expect("a move drag writes the head's new position", await waitForFrame(`(() => { const head = window.__cozyclay.objects.find((o) => o.id === ${JSON.stringify(sculptId)})?.recipe.parts.find((p) => p.id === "head"); return head && head.position[0] > ${headBefore.position[0] + 0.02}; })()`, 5000), JSON.stringify(await partNow("head")));
const headMoved = await partNow("head");
expect("the move touches only x", headMoved.position[1] === headBefore.position[1] && headMoved.position[2] === headBefore.position[2] && JSON.stringify(headMoved.rotation) === JSON.stringify(headBefore.rotation) && JSON.stringify(headMoved.size) === JSON.stringify(headBefore.size), JSON.stringify(headMoved));
expect("the drag kept the head selected", JSON.stringify(await pressedRow()) === JSON.stringify({ part: "head", mirrored: false }), JSON.stringify(await pressedRow()));
expect("the eyes rode along with their parent", await waitForFrame(`(() => { const head = window.__cozyclay.objects.find((o) => o.id === ${JSON.stringify(sculptId)})?.recipe.parts.find((p) => p.id === "head"); let eye = null; let root = window.__cozyclay?.editorCam; while (root?.parent) root = root.parent; root.traverse((node) => { if (node.userData?.sceneObjectId === ${JSON.stringify(sculptId)}) node.traverse((c) => { if (c.userData?.sculptPart === "eye") eye = c; }); }); return eye && Math.abs(eye.position.x - (head.position[0] + 0.17)) < 1e-3; })()`));
await screenshot("sculpt-gizmo-01-moved.png");
await undoKey();
expect("one undo restores the recipe exactly", await waitForFrame(`JSON.stringify(window.__cozyclay.objects.find((o) => o.id === ${JSON.stringify(sculptId)})?.recipe) === ${JSON.stringify(recipeBefore)}`, 5000), await recipeNow());

// The mirrored copy: drag it +x on screen and its pair moves the mirrored way.
await clickAt(await screenPoint(sculptId, "eye.mirror"));
expect("the mirrored eye is picked for the gizmo", await waitForRow("eye", true), JSON.stringify(await pressedRow()));
await waitForFrame("false", 200);
const eyeBefore = await partNow("eye");
handle = await gizmoHandle("translate", "X");
const eyeMirrorX = async () => (await evaluate(`(() => { let x = null; let root = window.__cozyclay?.editorCam; while (root?.parent) root = root.parent; root.traverse((node) => { if (node.userData?.sceneObjectId === ${JSON.stringify(sculptId)}) node.traverse((c) => { if (c.userData?.sculptPart === "eye.mirror") x = c.getWorldPosition(c.position.clone()).x; }); }); return x; })()`));
const copyBefore = await eyeMirrorX();
await dragHandle(handle, ...along(handle, 40));
expect("dragging the copy writes the authored eye, mirrored", await waitForFrame(`(() => { const eye = window.__cozyclay.objects.find((o) => o.id === ${JSON.stringify(sculptId)})?.recipe.parts.find((p) => p.id === "eye"); return eye && eye.position[0] < ${eyeBefore.position[0] - 0.01}; })()`, 5000), JSON.stringify(await partNow("eye")));
expect("the copy moved toward +x where it was dragged", (await eyeMirrorX()) > copyBefore + 0.01, `${copyBefore} -> ${await eyeMirrorX()}`);
await screenshot("sculpt-gizmo-02-mirror.png");
await undoKey();
expect("undo puts the eye pair back", await waitForFrame(`JSON.stringify(window.__cozyclay.objects.find((o) => o.id === ${JSON.stringify(sculptId)})?.recipe) === ${JSON.stringify(recipeBefore)}`, 5000), JSON.stringify(await partNow("eye")));

// Scale: Shift scales all three axes by one factor.
await clickAt(await screenPoint(sculptId, "body"));
expect("the body is picked for the gizmo", await waitForRow("body"), JSON.stringify(await pressedRow()));
await press("KeyR");
await waitForFrame("false", 200);
const bodyBefore = await partNow("body");
handle = await gizmoHandle("scale", "X");
await dragHandle(handle, ...along(handle, 50), 8);
expect("a Shift scale drag grows every axis by one factor", await waitForFrame(`(() => { const body = window.__cozyclay.objects.find((o) => o.id === ${JSON.stringify(sculptId)})?.recipe.parts.find((p) => p.id === "body"); return body && body.size[0] > ${bodyBefore.size[0] * 1.05}; })()`, 5000), JSON.stringify(await partNow("body")));
const bodyScaled = await partNow("body");
const factors = bodyScaled.size.map((value, axis) => value / bodyBefore.size[axis]);
expect("the factors agree to the recipe's rounding", Math.max(...factors) - Math.min(...factors) < 1e-3, JSON.stringify(factors));
await undoKey();
expect("undo restores the body", await waitForFrame(`JSON.stringify(window.__cozyclay.objects.find((o) => o.id === ${JSON.stringify(sculptId)})?.recipe) === ${JSON.stringify(recipeBefore)}`, 5000), await recipeNow());

// A refused scale: dragged through the centre the size turns negative; the command refuses it.
await waitForFrame("false", 200);
handle = await gizmoHandle("scale", "X");
await dragHandle(handle, ...along(handle, -2.2 * Math.hypot(handle.x - handle.centre.x, handle.y - handle.centre.y)));
expect("a refused edit shows its reason", await waitFor("document.querySelector('[data-testid=sculpt-part-notice]')?.textContent.includes('Edit refused')", 5000), await notice());
expect("the refusal names the size", /size/.test((await notice()) ?? ""), await notice());
expect("a refused edit writes nothing", (await recipeNow()) === recipeBefore, await recipeNow());
expect("the meshes snap back", await waitForFrame(`(() => { let s = null; let root = window.__cozyclay?.editorCam; while (root?.parent) root = root.parent; root.traverse((node) => { if (node.userData?.sceneObjectId === ${JSON.stringify(sculptId)}) node.traverse((c) => { if (c.userData?.sculptPart === "body") s = c.scale.toArray(); }); }); return s && s.every((v) => v === 1); })()`));
await screenshot("sculpt-gizmo-03-refused.png");

// Delete with a part selected never deletes the sculpt.
await press("Delete");
expect("Delete with a part selected is refused with a notice", await waitFor("document.querySelector('[data-testid=sculpt-part-notice]')?.textContent.includes('Delete removes the whole sculpt')", 5000), await notice());
expect("the sculpt is still there", await evaluate(`window.__cozyclay.objects.some((o) => o.id === ${JSON.stringify(sculptId)})`));
await press("Escape");
expect("Esc deselects the part", await waitForRow(null), JSON.stringify(await pressedRow()));
expect("W/E/R are the views again", await waitFor("[...document.querySelectorAll('.vp-tool-key')].map((b) => b.dataset.tool).join() === 'front,side,back'"), await toolKeys());
expect("the gizmo is gone", await waitForFrame(`(() => { let root = window.__cozyclay?.editorCam; while (root?.parent) root = root.parent; let shown = false; root.traverse((node) => { if (node.type === "TransformControlsGizmo" && node.parent?.visible) shown = true; }); return !shown; })()`));

ws.close();
if (failures > 0) {
	console.error(`\n${failures} sculpt-parts check(s) failed`);
	process.exit(1);
}
console.log("\nAll sculpt-parts checks passed");

#!/usr/bin/env node
// Real-canvas regression for Cube -> another object selection. The selected
// gizmo is intentionally left mounted while the second object's body is
// clicked; this is the path that used to get swallowed by the first gizmo.

const port = Number(process.env.CDP_PORT || 9222);
const targets = await (await fetch(`http://127.0.0.1:${port}/json`)).json();
const page = targets.find((target) => target.type === "page" && target.webSocketDebuggerUrl);
if (!page) throw new Error("no page target on the QA browser");

const ws = new WebSocket(page.webSocketDebuggerUrl);
await new Promise((resolve, reject) => {
	ws.onopen = resolve;
	ws.onerror = reject;
});

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
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const waitFor = async (expression, timeoutMs = 10000) => {
	const deadline = Date.now() + timeoutMs;
	while (Date.now() < deadline) {
		if (await evaluate(expression).catch(() => false)) return true;
		await sleep(100);
	}
	return false;
};
const click = (expression) => evaluate(`${expression}.click()`);
const mouse = (type, x, y) => send("Input.dispatchMouseEvent", {
	type,
	x,
	y,
	button: "left",
	buttons: type === "mousePressed" ? 1 : 0,
	clickCount: 1,
});
const expect = (name, condition, detail = "") => {
	console.log(`${condition ? "PASS" : "FAIL"} ${name}${condition ? "" : ` — ${detail}`}`);
	if (!condition) failures += 1;
};

let failures = 0;
await evaluate("localStorage.removeItem('cozyclay.scene.v1'); localStorage.removeItem('cozyclay.scene.v1.quarantine'); localStorage.setItem('cozyclay.locale', 'en')");
await send("Page.reload");
await waitFor("!!document.querySelector('canvas')", 30000);
await waitFor("!!document.querySelector('.add-object-trigger')");

const add = async (label) => {
	await click("document.querySelector('.add-object-trigger')");
	await waitFor("document.querySelectorAll('.add-object-item').length > 0");
	await click(`[...document.querySelectorAll('.add-object-item')].find((entry) => entry.textContent.startsWith(${JSON.stringify(label)}))`);
	await waitFor("window.__gizmoHandles().length > 0");
};

await add("Cube");
await add("Sphere");

// Move Sphere away from Cube so the ray has a visible body to choose while
// Cube remains selected with its gizmo. The field is the selected object's
// real inspector input, not a mocked store write.
await evaluate(`(() => {
	const row = [...document.querySelectorAll('.inspector-pane .vec3-row')].find((entry) => entry.querySelector('.vec3-label')?.textContent === 'Position');
	const input = row?.querySelectorAll('input')[0];
	if (!input) return false;
	input.focus();
	Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set.call(input, '2');
	input.dispatchEvent(new Event('input', { bubbles: true }));
	input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
	input.blur();
	return true;
})()`);
await waitFor("document.querySelector('.inspector-pane .vec3-row input')?.value === '2'");

await click("[...document.querySelectorAll('.hierarchy-row')].find((entry) => entry.querySelector('.hierarchy-label')?.textContent === 'Cube')");
const cubeSelected = await waitFor("[...document.querySelectorAll('.hierarchy-row-wrap.selected .hierarchy-label')].some((entry) => entry.textContent === 'Cube')");
expect("Cube stays selected while the next body is aimed", cubeSelected, await evaluate("[...document.querySelectorAll('.hierarchy-row-wrap.selected .hierarchy-label')].map((entry) => entry.textContent).join('|')"));
await waitFor("window.__gizmoHandles().length > 0");
const spherePoint = await evaluate(`(() => {
	const canvas = document.querySelector('canvas');
	for (let y = 80; y < innerHeight - 80; y += 6) {
		for (let x = 20; x < innerWidth - 20; x += 6) {
			if (document.elementFromPoint(x, y) !== canvas) continue;
			const id = window.__objectPick(x, y);
			if (id === 'sphere' && !window.__gizmoPick(x, y)) return { x, y, id };
		}
	}
	return null;
})()`);
expect("a second object's body is visible to the real ray picker", !!spherePoint, JSON.stringify({ spherePoint }));

if (spherePoint) {
	await mouse("mousePressed", spherePoint.x, spherePoint.y);
	await mouse("mouseReleased", spherePoint.x, spherePoint.y);
}
const switched = await waitFor("[...document.querySelectorAll('.hierarchy-row-wrap.selected .hierarchy-label')].some((entry) => entry.textContent.includes('Sphere'))");
expect("clicking Sphere switches selection while Cube is focused", switched, await evaluate("[...document.querySelectorAll('.hierarchy-row-wrap.selected .hierarchy-label')].map((entry) => entry.textContent).join('|')"));
expect("the switched object remains the Inspector owner", (await evaluate("document.querySelector('.inspector-pane .vec3-row input')?.value")) === "2");

if (failures) {
	ws.close();
	process.exitCode = 1;
} else {
	console.log("verify-object-switch-browser: all checks passed");
	ws.close();
}

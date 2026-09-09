#!/usr/bin/env node

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
const pageErrors = [];
ws.onmessage = (event) => {
	const message = JSON.parse(event.data);
	if (message.method === "Runtime.exceptionThrown") {
		pageErrors.push(message.params.exceptionDetails.exception?.description ?? message.params.exceptionDetails.text);
		return;
	}
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
const waitFor = async (expression, timeoutMs = 8000) => {
	const deadline = Date.now() + timeoutMs;
	while (Date.now() < deadline) {
		if (await evaluate(expression)) return true;
		await sleep(50);
	}
	return false;
};

let failures = 0;
const expect = (name, condition, detail = "") => {
	console.log(`${condition ? "PASS" : "FAIL"} ${name}${condition ? "" : ` — ${detail}`}`);
	if (!condition) failures += 1;
};

await send("Runtime.enable");
await send("Page.enable");
await send("Emulation.setEmulatedMedia", { features: [{ name: "prefers-reduced-motion", value: "reduce" }] });
await send("Page.navigate", { url: process.env.QA_URL ?? "http://127.0.0.1:5180/app/" });
expect("app becomes ready", await waitFor("!!window.__cozyclay?.rigA"));
// The Full-Body track tools (Cut, trim, retime) and the segment-speed editor
// belong to Motion mode (#191): pick the department before editing the take.
expect("Motion mode is selectable", await evaluate(`(() => {
	const tab = [...document.querySelectorAll('.workflow-mode-switch button')].find((item) => ['Motion', '\ubaa8\uc158'].includes(item.textContent.trim()));
	if (!tab) return false;
	tab.click();
	return true;
})()`));
expect("the studio switches to Motion mode", await waitFor("document.querySelector('.app')?.dataset.workflowMode === 'motion'"));
expect("the demo take draws one Full-Body segment", await waitFor("document.querySelectorAll('.tl-motion-clip').length === 1"));

const initial = await evaluate(`(() => {
	const clip = document.querySelector(".tl-motion-clip");
	const speed = document.querySelector('.tl-motion-speed-editor input[type="number"]');
	const cut = [...document.querySelectorAll(".tl-track-add.motion-cut")][0];
	return {
		label: clip?.querySelector(".tl-motion-clip-label")?.textContent,
		speed: speed?.value,
		editorVisible: !!speed && speed.getBoundingClientRect().width > 0,
		cutDisabled: cut?.disabled,
		readout: document.querySelector(".tl-readout")?.textContent,
	};
})()`);
expect("the initial segment is visibly 1x", initial.label?.includes("1×") && initial.speed === "1", JSON.stringify(initial));
expect("speed editor lives outside the segment and is visible", initial.editorVisible === true, JSON.stringify(initial));
expect("Cut is disabled at frame zero", initial.cutDisabled === true, JSON.stringify(initial));
const initialRange = initial.readout?.match(/\/ \d+/)?.[0];

expect("scrubbing enables Cut at frame 1", await evaluate(`(() => {
	const slider = document.querySelector('.tl-ruler-lane');
	slider.focus();
	slider.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true }));
	return true;
})()`));
expect("frame 1 is reached", await waitFor("document.querySelector('.tl-readout')?.textContent.includes('1 /')"));
expect("Cut enables away from the edges", await evaluate("document.querySelector('.tl-track-add.motion-cut')?.disabled === false"));
expect("clicking Cut produces two Full-Body segments", await evaluate(`(() => {
	document.querySelector('.tl-track-add.motion-cut').click();
	return true;
})()`) && await waitFor("document.querySelectorAll('.tl-motion-clip').length === 2"));

const beforeSlow = await evaluate(`(() => ({
	readout: document.querySelector('.tl-readout')?.textContent,
	widths: [...document.querySelectorAll('.tl-motion-clip')].map((clip) => clip.getBoundingClientRect().width),
	labels: [...document.querySelectorAll('.tl-motion-clip-label')].map((label) => label.textContent),
}))()`);
expect("cut segments retain the 1x labels", beforeSlow.labels.every((label) => label.includes("1×")), JSON.stringify(beforeSlow));
expect("the first segment is narrower than an inline selector", beforeSlow.widths[0] < 20, JSON.stringify(beforeSlow));

expect("the playhead can return to the one-frame segment", await evaluate(`(() => {
	const slider = document.querySelector('.tl-ruler-lane');
	slider.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowLeft', bubbles: true }));
	return true;
})()`) && await waitFor("document.querySelector('.tl-readout')?.textContent.includes('0 /')"));

expect("the external numeric editor accepts 0.7x on the tiny segment", await evaluate(`(() => {
	const input = document.querySelector('.tl-motion-speed-editor input[type="number"]');
	Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(input, '0.7');
	input.dispatchEvent(new Event('input', { bubbles: true }));
	return true;
})()`));
expect("the tiny segment updates to 0.7x", await waitFor("document.querySelector('.tl-motion-clip-label')?.textContent.includes('0.7×')"));

expect("the range editor accepts the next 0.1x step", await evaluate(`(() => {
	const input = document.querySelector('.tl-motion-speed-editor input[type="range"]');
	Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(input, '0.8');
	input.dispatchEvent(new Event('input', { bubbles: true }));
	return true;
})()`));
expect("the tiny segment updates to 0.8x", await waitFor("document.querySelector('.tl-motion-clip-label')?.textContent.includes('0.8×')"));

const afterSlow = await evaluate(`(() => ({
	readout: document.querySelector('.tl-readout')?.textContent,
	widths: [...document.querySelectorAll('.tl-motion-clip')].map((clip) => clip.getBoundingClientRect().width),
	labels: [...document.querySelectorAll('.tl-motion-clip-label')].map((label) => label.textContent),
	speed: document.querySelector('.tl-motion-speed-editor input[type="number"]')?.value,
	selected: [...document.querySelectorAll('.tl-motion-clip')].map((clip) => clip.classList.contains('selected')),
}))()`);
expect("the header and tiny segment agree on 0.8x", afterSlow.labels[0]?.includes("0.8×") && afterSlow.speed === "0.8", JSON.stringify(afterSlow));
expect("the playhead identifies the active segment", afterSlow.selected.some(Boolean), JSON.stringify(afterSlow));
expect("reduced-motion mode keeps the controls usable", await evaluate("matchMedia('(prefers-reduced-motion: reduce)').matches"));

/* ------------------------------------------- segment delete + undo ---- */

const clipSpot = await evaluate(
	"(() => { const clip = [...document.querySelectorAll('.tl-motion-clip')].at(-1); if (!clip) return null;" +
		" const r = clip.getBoundingClientRect(); return { x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2) }; })()",
);
expect("the wide segment offers a right-click target", !!clipSpot);
await send("Input.dispatchMouseEvent", { type: "mousePressed", x: clipSpot.x, y: clipSpot.y, button: "right", buttons: 2, clickCount: 1 });
await send("Input.dispatchMouseEvent", { type: "mouseReleased", x: clipSpot.x, y: clipSpot.y, button: "right", buttons: 0, clickCount: 1 });
expect("right-clicking a segment deletes it", await waitFor("document.querySelectorAll('.tl-motion-clip').length === 1"));
const shrunkReadout = await waitFor("document.querySelector('.tl-readout')?.textContent.includes('/ 0')");
expect("deleting the long segment shrinks the timeline range", shrunkReadout, await evaluate("document.querySelector('.tl-readout')?.textContent"));
await send("Input.dispatchKeyEvent", { type: "keyDown", key: "z", code: "KeyZ", modifiers: 2, windowsVirtualKeyCode: 90 });
await send("Input.dispatchKeyEvent", { type: "keyUp", key: "z", code: "KeyZ", modifiers: 2, windowsVirtualKeyCode: 90 });
expect("Ctrl+Z restores the deleted segment", await waitFor("document.querySelectorAll('.tl-motion-clip').length === 2"));
const restoredReadout = await waitFor(`document.querySelector('.tl-readout')?.textContent.includes(${JSON.stringify(initialRange)})`);
expect("undo restores the original timeline range", restoredReadout, await evaluate("document.querySelector('.tl-readout')?.textContent"));
expect("the restored segments keep their speeds", await waitFor("[...document.querySelectorAll('.tl-motion-clip-label')].some((l) => l.textContent.includes('0.8\u00d7'))"));

expect("browser run has no uncaught page errors", pageErrors.length === 0, pageErrors.join(" | "));

ws.close();
if (failures) process.exit(1);
console.log("all motion edit browser checks PASS");

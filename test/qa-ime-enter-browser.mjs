#!/usr/bin/env node
// #604: a composing Enter must be left to the IME. The real browser sequence
// below reproduces Chrome's keyCode=229/isComposing=true event for both the
// idle Send path and the streaming Steer path.
import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";

const port = Number(process.env.CDP_PORT || 9222);
const out = process.env.QA_OUT || "/tmp/cozyclay-ime-enter";
await mkdir(out, { recursive: true });
const targets = await (await fetch(`http://127.0.0.1:${port}/json`)).json();
const page = targets.find((target) => target.type === "page" && target.webSocketDebuggerUrl);
if (!page) throw new Error("No page target on the QA browser.");
const ws = new WebSocket(page.webSocketDebuggerUrl);
await new Promise((resolve, reject) => { ws.onopen = resolve; ws.onerror = reject; });
let nextId = 0;
const pending = new Map();
const pageErrors = [];
ws.onmessage = (event) => {
	const message = JSON.parse(event.data);
	if (message.method === "Runtime.exceptionThrown") pageErrors.push(message.params.exceptionDetails.exception?.description || message.params.exceptionDetails.text);
	if (!message.id || !pending.has(message.id)) return;
	const item = pending.get(message.id); pending.delete(message.id);
	if (message.error) item.reject(new Error(JSON.stringify(message.error))); else item.resolve(message.result);
};
const send = (method, params = {}) => new Promise((resolve, reject) => {
	const id = ++nextId; pending.set(id, { resolve, reject }); ws.send(JSON.stringify({ id, method, params }));
});
const evaluate = async (expression) => {
	const result = await send("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true });
	if (result.exceptionDetails) throw new Error(result.exceptionDetails.exception?.description || result.exceptionDetails.text);
	return result.result?.value;
};
const waitFor = async (expression, timeoutMs = 30_000) => {
	const deadline = Date.now() + timeoutMs;
	while (Date.now() < deadline) {
		if (await evaluate(expression).catch(() => false)) return true;
		await new Promise((resolve) => setTimeout(resolve, 100));
	}
	return false;
};
const click = async (selector) => {
	const position = await evaluate(`(() => {
		const element = document.querySelector(${JSON.stringify(selector)});
		if (!element) throw new Error("Missing control: " + ${JSON.stringify(selector)});
		element.scrollIntoView({ block: "center", inline: "center", behavior: "instant" });
		const rect = element.getBoundingClientRect();
		return { x: rect.x + rect.width / 2, y: rect.y + rect.height / 2 };
	})()`);
	for (const type of ["mousePressed", "mouseReleased"]) await send("Input.dispatchMouseEvent", {
		type, x: position.x, y: position.y, button: "left", buttons: type === "mousePressed" ? 1 : 0, clickCount: 1,
	});
};
const inputCompositionEnter = async (text = "안녕") => {
	await click(".agent-input");
	await send("Input.insertText", { text: text.slice(0, 1) });
	await send("Input.imeSetComposition", { text: text.slice(1), selectionStart: 1, selectionEnd: 1 });
	await send("Input.dispatchKeyEvent", { type: "rawKeyDown", key: "Enter", code: "Enter", windowsVirtualKeyCode: 229, nativeVirtualKeyCode: 229 });
};
const state = () => evaluate(`(() => ({
	value: document.querySelector(".agent-input")?.value ?? null,
	keys: window.__imeKeys ?? [],
	user: [...document.querySelectorAll(".agent-row.user .agent-bubble")].map((node) => node.textContent),
	panel: document.querySelector(".agent-panel")?.dataset.agentState ?? null,
}))()`);
const summary = (snapshot) => ({
	value: snapshot.value,
	user: snapshot.user,
	panel: snapshot.panel,
	composingEnterEvents: snapshot.keys.filter((key) => key.key === "Enter" && key.keyCode === 229 && key.isComposing).length,
});
const screenshot = async (name) => {
	const { data } = await send("Page.captureScreenshot", { format: "png" });
	const path = `${out}/${name}.png`; await writeFile(path, Buffer.from(data, "base64")); console.log(`QA_SCREENSHOT ${path}`);
};
const setDraft = async (text) => evaluate(`(() => {
	const element = document.querySelector('.agent-input');
	const setter = Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, 'value').set;
	setter.call(element, ${JSON.stringify(text)});
	element.dispatchEvent(new Event('input', { bubbles: true }));
})()`);

try {
	await send("Page.enable");
	const url = new URL(process.env.QA_URL || "http://127.0.0.1:5291/workflow/");
	url.searchParams.set("agent", "mock");
	url.searchParams.set("state", "ready");
	url.searchParams.set("speed", "0.15");
	await send("Page.navigate", { url: url.toString() });
	assert.equal(await waitFor("!!document.querySelector('.agent-input') && !!document.querySelector('.agent-send')"), true, "mock composer loads");
	await evaluate("window.__imeKeys=[]; document.querySelector('.agent-input').addEventListener('keydown', event => window.__imeKeys.push({ key: event.key, keyCode: event.keyCode, isComposing: event.isComposing, value: event.target.value }));");

	await inputCompositionEnter();
	const idle = await state();
	assert.equal(
		idle.keys.some((key) => key.key === "Enter" && key.keyCode === 229 && key.isComposing === true && key.value === "안녕"),
		true,
		`composing Enter event was not observed: ${JSON.stringify(idle)}`,
	);
	assert.equal(idle.value, "안녕", `composing draft was changed: ${JSON.stringify(idle)}`);
	assert.deepEqual(idle.user, [], `composing Enter sent a turn: ${JSON.stringify(idle)}`);
	assert.equal(idle.panel, "ready");
	console.log(`PASS composing Enter leaves Send draft intact ${JSON.stringify(summary(idle))}`);
	await screenshot("idle-composition");

	await setDraft("first turn");
	await evaluate("document.querySelector('.agent-input').focus()");
	await click(".agent-send");
	assert.equal(await waitFor("!!document.querySelector('.agent-send.stop')"), true, "streaming turn starts");
	await inputCompositionEnter();
	const steer = await state();
	assert.deepEqual(steer.user, ["first turn"], `composing Enter steered a second turn: ${JSON.stringify(steer)}`);
	assert.equal(steer.value, "안녕", `composing steer draft was changed: ${JSON.stringify(steer)}`);
	assert.equal(steer.panel, "streaming");
	console.log(`PASS composing Enter leaves Steer draft intact ${JSON.stringify(summary(steer))}`);
	await screenshot("streaming-composition");
	assert.deepEqual(pageErrors, []);
	console.log(`QA_IME_ENTER ${JSON.stringify({ url: await evaluate("location.href"), page_errors: pageErrors })}`);
} catch (error) {
	console.error(`FAIL IME Enter QA: ${error.stack || error}`);
	console.error(`QA_IME_ENTER_FAILURE ${JSON.stringify({ page_errors: pageErrors })}`);
	process.exitCode = 1;
} finally {
	ws.close();
}

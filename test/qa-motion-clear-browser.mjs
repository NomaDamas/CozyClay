#!/usr/bin/env node
// #605: the motion clear action must remain visible in Stage and fully
// clickable when the Motion header wraps. Clearing the take also clears the
// prompt-block schedule through the real editor action.
//
// QA_URL=http://127.0.0.1:5257/app/?motion=/demo/walk-then-stop.npz \
//   npm run qa:browser -- node test/qa-motion-clear-browser.mjs
import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';

const port = Number(process.env.CDP_PORT || 9222);
const out = process.env.QA_OUT || '/tmp/cozyclay-605-clear';
await mkdir(out, { recursive: true });
const targets = await (await fetch(`http://127.0.0.1:${port}/json`)).json();
const page = targets.find((target) => target.type === 'page' && target.webSocketDebuggerUrl);
if (!page) throw new Error('No page target on the QA browser.');
const ws = new WebSocket(page.webSocketDebuggerUrl);
await new Promise((resolve, reject) => { ws.onopen = resolve; ws.onerror = reject; });
let nextId = 0;
const pending = new Map();
const pageErrors = [];
ws.onmessage = (event) => {
	const message = JSON.parse(event.data);
	if (message.method === 'Runtime.exceptionThrown') pageErrors.push(message.params.exceptionDetails.exception?.description || message.params.exceptionDetails.text);
	if (!message.id || !pending.has(message.id)) return;
	const item = pending.get(message.id); pending.delete(message.id);
	if (message.error) item.reject(new Error(JSON.stringify(message.error))); else item.resolve(message.result);
};
const send = (method, params = {}) => new Promise((resolve, reject) => {
	const id = ++nextId; pending.set(id, { resolve, reject }); ws.send(JSON.stringify({ id, method, params }));
});
const evaluate = async (expression) => {
	const result = await send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true });
	if (result.exceptionDetails) throw new Error(result.exceptionDetails.exception?.description || result.exceptionDetails.text);
	return result.result?.value;
};
const waitFor = async (expression, timeoutMs = 60_000) => {
	const started = Date.now();
	while (Date.now() - started < timeoutMs) {
		if (await evaluate(expression).catch(() => false)) return true;
		await new Promise((resolve) => setTimeout(resolve, 250));
	}
	return false;
};
const point = async (selector) => evaluate(`(() => {
	const element = document.querySelector(${JSON.stringify(selector)});
	if (!element) throw new Error('Missing control: ' + ${JSON.stringify(selector)});
	element.scrollIntoView({ block: 'center', inline: 'center', behavior: 'instant' });
	const rect = element.getBoundingClientRect();
	return { x: rect.x + rect.width / 2, y: rect.y + rect.height / 2, width: rect.width, height: rect.height };
})()`);
const click = async (selector) => {
	const position = await point(selector);
	for (const type of ['mousePressed', 'mouseReleased']) await send('Input.dispatchMouseEvent', {
		type, x: position.x, y: position.y, button: 'left', buttons: type === 'mousePressed' ? 1 : 0, clickCount: 1,
	});
};
const typeInto = async (selector, text) => {
	await click(selector);
	await send('Input.insertText', { text });
};
const clearGeometry = () => evaluate(`(() => {
	const element = document.querySelector('[aria-label="Clear loaded motion"]');
	if (!element) return null;
	const rect = element.getBoundingClientRect();
	const hit = document.elementFromPoint(rect.x + rect.width / 2, rect.y + rect.height / 2);
	return { width: rect.width, height: rect.height, display: getComputedStyle(element).display,
		hitClear: hit === element || hit?.closest('[aria-label="Clear loaded motion"]') === element,
		head: document.querySelector('.tl-head')?.getBoundingClientRect().toJSON(),
		body: document.querySelector('.tl-body')?.getBoundingClientRect().toJSON() };
})()`);
const screenshot = async (name) => {
	const { data } = await send('Page.captureScreenshot', { format: 'png' });
	const path = `${out}/${name}.png`; await writeFile(path, Buffer.from(data, 'base64')); console.log(`QA_SCREENSHOT ${path}`); return path;
};
const checks = [];
const pass = (label, detail) => { checks.push({ label, ...detail }); console.log(`PASS ${label} ${JSON.stringify(detail)}`); };

try {
	await send('Runtime.enable');
	assert.equal(await waitFor('!!window.__cozyclay?.motion && window.__cozyclay.motion.frames > 0 && !!document.querySelector("[aria-label=\\"Clear loaded motion\\"]")'), true, 'motion take and clear action load');
	assert.equal(await waitFor('document.querySelector(".app")?.dataset.workflowMode === "scene"'), true, 'Stage workflow loads');
	const stage = await clearGeometry();
	assert.ok(stage?.width > 0 && stage?.height > 0, `Stage clear control is visible: ${JSON.stringify(stage)}`);
	assert.equal(stage.hitClear, true, `Stage clear control is hit-testable: ${JSON.stringify(stage)}`);
	pass('Stage clear control is visible and hit-testable', stage);

	await click('[data-mode-key="4"]');
	assert.equal(await waitFor('document.querySelector(".app")?.dataset.workflowMode === "motion"'), true, 'Motion workflow loads');
	await click('.tl-track.prompts .tl-track-add');
	assert.equal(await waitFor('document.querySelectorAll(".tl-track.prompts .tl-chip-input").length === 1 && !!document.querySelector("input[placeholder=\\"describe this motion block\\"]")'), true, 'first prompt block appears');
	await typeInto('input[placeholder="describe this motion block"]', 'QA_CLEAR_MOTION_605 walk');
	await click('.tl-track.prompts .tl-track-add');
	assert.equal(await waitFor('document.querySelectorAll(".tl-track.prompts .tl-chip-input").length === 2'), true, 'second prompt block appears');
	await typeInto('input[placeholder="describe this motion block"]', 'QA_CLEAR_MOTION_605 stop');
	const before = await clearGeometry();
	assert.ok(before?.width > 0 && before?.height > 0, `Motion clear control is visible: ${JSON.stringify(before)}`);
	assert.equal(before.hitClear, true, `Motion clear control center is hit-testable: ${JSON.stringify(before)}`);
	await screenshot('before-clear');
	pass('Motion clear control remains inside the wrapped header', before);

	await click('[aria-label="Clear loaded motion"]');
	assert.equal(await waitFor('window.__cozyclay.motion == null && document.querySelectorAll(".tl-track.prompts .tl-chip-input").length === 0'), true, 'clear removes take and prompt blocks');
	const prompts = await evaluate('window.__cozyclay.charA?.layer?.promptClips ?? null');
	if (Array.isArray(prompts)) assert.equal(prompts.length, 0, 'cast layer prompt blocks are empty after clear');
	await screenshot('after-clear');
	pass('Clear removes the take and prompt-block schedule', { motion: null, prompt_blocks: Array.isArray(prompts) ? prompts.length : 0 });
	assert.deepEqual(pageErrors, []);
	console.log(`QA_MOTION_CLEAR ${JSON.stringify({ url: await evaluate('location.href'), checks, page_errors: pageErrors })}`);
} catch (error) {
	console.error(`FAIL motion clear QA: ${error.stack || error}`);
	console.error(`QA_MOTION_CLEAR_FAILURE ${JSON.stringify({ checks, page_errors: pageErrors })}`);
	process.exitCode = 1;
} finally {
	ws.close();
}

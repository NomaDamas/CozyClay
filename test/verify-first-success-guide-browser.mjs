#!/usr/bin/env node
// Browser contract for the first-run checklist. It drives the same named
// controls a new author sees: create a project, read the four actions, mark
// them complete, and dismiss the guide without blocking the editor.

const port = Number(process.env.CDP_PORT || 9222);
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
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const waitFor = async (expression, timeoutMs = 15000) => {
	const deadline = Date.now() + timeoutMs;
	while (Date.now() < deadline) {
		if (await evaluate(expression).catch(() => false)) return true;
		await sleep(100);
	}
	return false;
};

let failures = 0;
const expect = (name, condition, detail = "") => {
	console.log(`${condition ? "PASS" : "FAIL"} ${name}${condition ? "" : ` — ${detail}`}`);
	if (!condition) failures += 1;
};

expect("the first-run project chooser renders", await waitFor("!!document.querySelector('.project-browser.startup')"));
expect("New Project is available", await waitFor("!!document.querySelector('.project-browser.startup .project-browser-foot .btn.primary')"));
await evaluate("document.querySelector('.project-browser.startup .project-browser-foot .btn.primary').click()");
expect("the project name dialog opens", await waitFor("!!document.querySelector('.project-name-dialog')"));
await evaluate("document.querySelector('.project-name-dialog button[type=submit]').click()");
expect("guidance starts after project creation", await waitFor("!!document.querySelector('.first-success-guide')"));
const guideText = await evaluate("document.querySelector('.first-success-guide')?.textContent || ''");
expect("guidance names selection, movement, key, and playback", /Select a character.*Move it.*Press K.*Scrub the timeline.*Space/s.test(guideText), guideText);

for (let index = 0; index < 4; index += 1) {
	await evaluate("document.querySelector('.first-success-guide-next')?.click()");
	// React commits each click on the next task; a short yield keeps this check
	// deterministic without spending a full polling window per checklist step.
	await sleep(120);
}
expect("the guide exposes a completion state", await waitFor("document.querySelector('.first-success-guide')?.textContent.includes('You made your first shot.')"));
await evaluate("document.querySelector('.first-success-guide-close').click()");
expect("the guide can be dismissed", await waitFor("!document.querySelector('.first-success-guide')"));
expect("the editor remains available after dismissal", await waitFor("!!document.querySelector('.timeline')"));

ws.close();
if (failures > 0) {
	console.error(`\n${failures} first-success guide browser check(s) failed`);
	process.exit(1);
}
console.log("\nAll first-success guide browser checks passed");

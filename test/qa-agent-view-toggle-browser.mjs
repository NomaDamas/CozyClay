#!/usr/bin/env node
// Browser QA for the studio's agent panel toggle (#184), driven over CDP
// through tools/qa-browser.mjs:
//
//   QA_URL=http://127.0.0.1:5306/app/ CDP_PORT=9316 \
//     node tools/qa-browser.mjs -- node test/qa-agent-view-toggle-browser.mjs
//
// The studio has no room for another top bar button (IA rule R4), so the panel
// is shown from View ▾ like every other "what is on screen" toggle. This suite
// proves the three things that contract is made of: the studio boots with the
// panel collapsed and NO .agent-topbar-toggle in the top bar, the View ▾ item
// expands it, and Cmd/Ctrl+B collapses it again with the menu's checkmark
// following along. Screenshots land in QA_SHOT_DIR for the PR body.
import { mkdirSync, writeFileSync } from "node:fs";

const port = Number(process.env.CDP_PORT || 9222);
const shotDir = process.env.QA_SHOT_DIR || "/tmp/agent-view-toggle-qa";
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
/** poll a page condition — every wait in this file is a state condition, never a delay */
const waitFor = async (expression, timeoutMs = 15000) => {
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
async function shot(name) {
	const { data } = await send("Page.captureScreenshot", { format: "png", captureBeyondViewport: false });
	const file = `${shotDir}/${name}.png`;
	writeFileSync(file, Buffer.from(data, "base64"));
	console.log(`     screenshot ${file}`);
	return file;
}

/* ---------------------------------------------------------- page setup --- */

await waitFor("location.href.startsWith('http')", 30000);
await evaluate("localStorage.setItem('cozyclay.locale', 'en')");
await send("Page.enable");
await send("Emulation.setDeviceMetricsOverride", { width: 1600, height: 950, deviceScaleFactor: 1, mobile: false });
await send("Page.reload", { ignoreCache: false });
expect("the studio comes back up", await waitFor("!!document.querySelector('.add-object-trigger')", 40000));
expect("the hierarchy has rendered", await waitFor("document.querySelectorAll('.hierarchy-row-wrap').length > 0", 15000));

const trigger = "document.querySelector('.view-menu-trigger')";
const menu = "document.querySelector('.view-menu')";
const item = "document.querySelector('.view-menu .agent-panel-toggle')";
const panel = "document.querySelector('.agent-panel')";
const collapsedFlag = `${panel}?.getAttribute('data-agent-collapsed')`;
const openMenu = async () => {
	if (!(await evaluate(`!!${menu}`))) await evaluate(`${trigger}.click()`);
	return waitFor(`!!${menu}`, 8000);
};
const pressToggleShortcut = async () => {
	// Ctrl+B: the panel's own shortcut listener accepts either modifier.
	const key = { key: "b", code: "KeyB", windowsVirtualKeyCode: 66, nativeVirtualKeyCode: 66, modifiers: 2 };
	await send("Input.dispatchKeyEvent", { type: "keyDown", ...key });
	await send("Input.dispatchKeyEvent", { type: "keyUp", ...key });
};

/* ------------------------------------------------------ R4: no button ---- */

expect("the top bar carries no agent button", await evaluate("document.querySelectorAll('.agent-topbar-toggle').length === 0"));
expect(
	"nothing agent-shaped was added to .topbar-actions",
	await evaluate("![...document.querySelectorAll('.topbar-actions button, .topbar-actions a')].some((el) => /agent/i.test(el.className + ' ' + el.textContent))"),
);

/* ---------------------------------------------- the panel boots collapsed - */

expect("the agent panel is mounted", await waitFor(`!!${panel}`, 15000));
expect("it boots collapsed", await evaluate(`${collapsedFlag} === 'true'`), await evaluate(`${collapsedFlag}`));
expect("collapsed, it takes no room at all — no rail, no control spent", await evaluate(`${panel}.getBoundingClientRect().width === 0 && getComputedStyle(${panel}).display === 'none'`));

/* ------------------------------------------------------ the View ▾ item -- */

expect("the View menu opens", await openMenu());
expect("it offers an Agent panel item", await evaluate(`!!${item}`));
expect("the item reads as a checkbox", await evaluate(`${item}.getAttribute('role') === 'menuitemcheckbox'`));
expect("the item is labelled Agent panel", await evaluate(`${item}.textContent.trim() === 'Agent panel'`), await evaluate(`${item}?.textContent`));
expect("it is unchecked while the panel is collapsed", await evaluate(`${item}.getAttribute('aria-checked') === 'false' && ${item}.getAttribute('aria-pressed') === 'false'`));
expect("the checkmark slot is empty", await evaluate(`${item}.querySelector('.view-menu-mark').textContent.trim() === ''`));
await shot("view-menu-agent-item");

await evaluate(`${item}.click()`);
expect("clicking it expands the panel", await waitFor(`!${collapsedFlag}`, 8000));
expect("the expanded panel is the full column", await evaluate(`${panel}.getBoundingClientRect().width > 200`));
expect("the menu stays open — this is a toggle, not a command", await evaluate(`!!${menu}`));
expect("the item now reports checked", await waitFor(`${item}.getAttribute('aria-checked') === 'true' && ${item}.getAttribute('aria-pressed') === 'true'`, 8000));
expect("the checkmark is drawn", await evaluate(`${item}.querySelector('.view-menu-mark').textContent.trim() === '✓'`));
expect("it sits beside the inspector, not over it", await evaluate(`(() => {
	const inspector = document.querySelector('.inspector-sidebar');
	if (!inspector) return false;
	const a = inspector.getBoundingClientRect();
	const b = ${panel}.getBoundingClientRect();
	return b.left >= a.right - 1;
})()`));

// Close the menu so the screenshot shows the panel itself.
await evaluate(`${trigger}.click()`);
expect("the menu closes again", await waitFor(`!${menu}`, 8000));
await shot("agent-panel-expanded");

/* ------------------------------------------------------- Cmd/Ctrl+B ------ */

await pressToggleShortcut();
expect("Cmd/Ctrl+B collapses the panel", await waitFor(`${collapsedFlag} === 'true'`, 8000));
expect("the View item follows the shortcut", await openMenu() && await waitFor(`${item}.getAttribute('aria-checked') === 'false'`, 8000));
await evaluate(`${trigger}.click()`);
await waitFor(`!${menu}`, 8000);

await pressToggleShortcut();
expect("the shortcut expands it again", await waitFor(`!${collapsedFlag}`, 8000));
expect("and the item checks itself back on", await openMenu() && await waitFor(`${item}.getAttribute('aria-checked') === 'true'`, 8000));
await evaluate(`${item}.click()`);
expect("the item collapses the panel exactly like the shortcut", await waitFor(`${collapsedFlag} === 'true'`, 8000));
expect("the top bar is still free of an agent button", await evaluate("document.querySelectorAll('.agent-topbar-toggle').length === 0"));

if (failures > 0) { console.error(`${failures} FAILURES`); process.exit(1); }
console.log("qa-agent-view-toggle-browser: all checks passed");
process.exit(0);

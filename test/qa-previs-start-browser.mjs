#!/usr/bin/env node
// Browser QA for the start screen's project mode (#649, #654). The New
// view offers Storyboard / Animation above the templates; the choice lands on
// the project and survives a reload. No URL flag is needed.
// Run through tools/qa-browser.mjs with QA_URL pointing at `/app/`.

import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { SCENES_STORAGE_KEY, PREVIOUS_SCENES_STORAGE_KEY } from "../src/scenes.js";

const port = Number(process.env.CDP_PORT || 9222);
const out = process.env.QA_OUT || "/Users/yun/CozyClay/.omo/evidence/previs-modes/previs-modes-r1/shots";
const SESSION_KEY = "cozyclay.project-session.v1";
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
const screenshot = async (name) => {
	const result = await send("Page.captureScreenshot", { format: "png" });
	const path = join(out, name);
	await writeFile(path, Buffer.from(result.data, "base64"));
	console.log(`SCREENSHOT ${path}`);
	return path;
};
const setTheme = async (theme) => {
	await evaluate(`(() => { document.documentElement.dataset.theme = ${JSON.stringify(theme)}; window.dispatchEvent(new CustomEvent("cozyclay:theme-change", { detail: ${JSON.stringify(theme)} })); })()`);
	await waitFor(`document.documentElement.dataset.theme === ${JSON.stringify(theme)}`);
};
const setInput = (selector, value) => evaluate(`(() => {
	const input = document.querySelector(${JSON.stringify(selector)});
	if (!input) return false;
	const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value").set;
	setter.call(input, ${JSON.stringify(value)});
	input.dispatchEvent(new Event("input", { bubbles: true }));
	return true;
})()`);
const click = (selector) => evaluate(`(() => { const node = document.querySelector(${JSON.stringify(selector)}); if (!node) return false; node.click(); return true; })()`);
const session = () => evaluate(`JSON.parse(localStorage.getItem(${JSON.stringify(SESSION_KEY)}) || "null")`);
const templateIds = () => evaluate("[...document.querySelectorAll('.v2-start-template-grid [data-template-id]')].map((node) => node.dataset.templateId)");
const checkedMode = () => evaluate("document.querySelector('[data-testid=start-previs-mode] [aria-checked=true]')?.dataset.previsMode ?? null");
// Fresh first launch: no project session, no scenes, no camera tutorial.
const firstLaunch = async () => {
	await evaluate(`(() => {
		localStorage.removeItem(${JSON.stringify(SESSION_KEY)});
		localStorage.removeItem("${SCENES_STORAGE_KEY}");
		localStorage.removeItem("${PREVIOUS_SCENES_STORAGE_KEY}");
		localStorage.setItem("cozyclay.camera-tutorial-terminal.v1", JSON.stringify({ dismissed: true }));
	})()`);
	await reload();
};
const editorOpen = "!document.querySelector('.v2-start-screen') && !!document.querySelector('.timeline')";

await send("Page.enable");
await send("Emulation.setDeviceMetricsOverride", { width: 1440, height: 900, deviceScaleFactor: 1, mobile: false });
let failures = 0;
const expect = (name, condition, detail = "") => {
	console.log(`${condition ? "PASS" : "FAIL"} ${name}${condition ? "" : ` — ${detail}`}`);
	if (!condition) failures += 1;
};

await firstLaunch();

// --- New screen, Animation (default) -------------------------------------
expect("the start screen renders", await waitFor("!!document.querySelector('.v2-start-screen.startup [data-testid=start-create]')"));
expect("the mode control is above the template grid", await waitFor("(() => { const mode = document.querySelector('[data-testid=start-previs-mode]'); const grid = document.querySelector('.v2-start-template-grid'); return !!mode && !!grid && mode.getBoundingClientRect().bottom <= grid.getBoundingClientRect().top; })()"));
const options = await evaluate("[...document.querySelectorAll('[data-testid=start-previs-mode] [role=radio]')].map((node) => node.dataset.previsMode + ':' + node.querySelector('strong').textContent)");
expect("the control offers exactly Storyboard and Animation", options.join("|") === "storyboard:Storyboard|animation:Animation", options.join("|"));
expect("Animation is selected by default", (await checkedMode()) === "animation");
const animationTemplates = await templateIds();
expect("Animation offers every template", animationTemplates.includes("blank-stage") && animationTemplates.includes("sample-city-block"), animationTemplates.join(","));
await setTheme("dark");
await screenshot("task-18-new-animation-dark.png");
await setTheme("light");
await screenshot("task-18-new-animation-light.png");

// --- Storyboard: the grid narrows to Blank Stage (failure scenario) --------
await click("[data-previs-mode=storyboard]");
expect("Storyboard becomes the checked mode", await waitFor("document.querySelector('[data-previs-mode=storyboard]')?.getAttribute('aria-checked') === 'true'"));
const storyboardTemplates = await templateIds();
expect("Storyboard does not offer the City Block card", !storyboardTemplates.includes("sample-city-block"), storyboardTemplates.join(","));
expect("Storyboard shows only Blank Stage", storyboardTemplates.join(",") === "blank-stage", storyboardTemplates.join(","));
expect("Blank Stage is the selected template", await evaluate("document.querySelector('.v2-start-template.selected')?.dataset.templateId === 'blank-stage'"));
const storyboardName = await evaluate("document.querySelector('[data-testid=start-project-name]')?.value");
expect("the starter-filled name follows the switch to Blank Stage", storyboardName === "Blank Stage", storyboardName);
// The narrowest desktop the fixed 232px + 340px columns leave room for.
await send("Emulation.setDeviceMetricsOverride", { width: 1024, height: 768, deviceScaleFactor: 1, mobile: false });
const narrow = await evaluate("(() => { const mode = document.querySelector('[data-testid=start-previs-mode]').getBoundingClientRect(); const main = document.querySelector('.v2-start-main').getBoundingClientRect(); return { mode: [mode.left, mode.right], main: [main.left, main.right] }; })()");
expect("the mode control fits the main column at 1024px", narrow.mode[0] >= narrow.main[0] && narrow.mode[1] <= narrow.main[1], JSON.stringify(narrow));
await screenshot("task-18-new-storyboard-1024-light.png");
await send("Emulation.setDeviceMetricsOverride", { width: 1440, height: 900, deviceScaleFactor: 1, mobile: false });
await screenshot("task-18-new-storyboard-light.png");
await setTheme("dark");
await screenshot("task-18-new-storyboard-dark.png");
await screenshot("task-18-previs-modes.png");
await setTheme("light");

// --- Storyboard + Blank Stage + name -> Create -----------------------------
await setInput('[data-testid="start-project-name"]', "qa649_storyboard");
await click("[data-template-id=blank-stage]");
await click("[data-testid=start-create]");
expect("Create opens the editor", await waitFor(editorOpen));
const storyboardSession = await session();
expect("the new project is a storyboard project", storyboardSession?.name === "qa649_storyboard" && storyboardSession?.previsMode === "storyboard", JSON.stringify(storyboardSession));

await reload();
expect("reload reopens the editor", await waitFor(editorOpen));
await evaluate("window.__cozyclay.sceneObject.place({ kind: 'cube', x: 0, z: 0 })");
expect("an edit after reload lands", await waitFor("!!document.querySelector('.project-dirty-dot')"));
const reloadedSession = await session();
expect("reload keeps previsMode storyboard", reloadedSession?.name === "qa649_storyboard" && reloadedSession?.previsMode === "storyboard", JSON.stringify(reloadedSession));

// --- File > New: Animation + City Block -> animation ------------------------
await evaluate("window.confirm = () => true");
await click("[data-testid=menu-file]");
expect("File shows New", await waitFor("!!document.querySelector('[data-testid=menubar-new]')"));
await click("[data-testid=menubar-new]");
expect("File > New reuses the start screen with the mode control", await waitFor("!!document.querySelector('.v2-start-screen [data-testid=start-previs-mode]')"));
expect("File > New starts on Animation", (await checkedMode()) === "animation");
await click("[data-template-id=sample-city-block]");
expect("City Block is the selected template", await waitFor("document.querySelector('.v2-start-template.selected')?.dataset.templateId === 'sample-city-block'"));
await setInput('[data-testid="start-project-name"]', "qa649_animation");
expect("the City Block name is entered", await waitFor("document.querySelector('[data-testid=start-project-name]')?.value === 'qa649_animation'"));
await click("[data-testid=start-create]");
const cityBlockOpened = await waitFor(`${editorOpen} && (document.querySelector('.project-menu-trigger')?.textContent || '').includes('qa649_animation')`, 30000);
expect("City Block opens in the editor", cityBlockOpened, await evaluate("JSON.stringify({ start: !!document.querySelector('.v2-start-screen'), menu: document.querySelector('.project-menu-trigger')?.textContent, toast: document.querySelector('[role=status]')?.textContent, name: document.querySelector('[data-testid=start-project-name]')?.value, selected: document.querySelector('.v2-start-template.selected')?.dataset.templateId })"));
const animationSession = await session();
expect("the City Block project is an animation project", animationSession?.name === "qa649_animation" && animationSession?.previsMode === "animation", JSON.stringify(animationSession));

ws.close();
if (failures > 0) {
	console.error(`\n${failures} previs start-screen check(s) failed`);
	process.exit(1);
}
console.log("\nAll previs start-screen checks passed");

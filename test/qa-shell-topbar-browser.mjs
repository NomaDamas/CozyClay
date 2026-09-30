#!/usr/bin/env node
// Browser QA for issue #523: the 2a top bar (44px), File/Edit/Window/Help,
// Generate Motion with its caret, and the 24px status bar that carries save
// state and export progress. Exports are exercised end to end: File › Export
// and ⌘E hand a real zip to the browser download manager.
import { mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const port = Number(process.env.CDP_PORT || 9222);
const out = process.env.QA_OUT || "/tmp/cozyclay-task-9";
const downloads = join(out, "task-9-downloads");
mkdirSync(downloads, { recursive: true });

const targets = await (await fetch(`http://127.0.0.1:${port}/json`)).json();
const page = targets.find((target) => target.type === "page" && target.webSocketDebuggerUrl);
if (!page) throw new Error("no page target on the QA browser");
const ws = new WebSocket(page.webSocketDebuggerUrl);
await new Promise((resolve, reject) => { ws.onopen = resolve; ws.onerror = reject; });

let nextId = 1;
const pending = new Map();
const listeners = new Map();
const runtimeErrors = [];
ws.onmessage = (event) => {
	const message = JSON.parse(event.data);
	if (message.method === "Runtime.exceptionThrown") runtimeErrors.push(message.params?.exceptionDetails?.exception?.description ?? "page exception");
	if (message.method) for (const listener of listeners.get(message.method) ?? []) listener(message.params);
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
/** Subscribe BEFORE acting; resolves on the first matching CDP event. */
const once = (method, predicate = () => true, timeoutMs = 60000) => {
	let cancel;
	const promise = new Promise((resolve, reject) => {
		const set = listeners.get(method) ?? new Set();
		listeners.set(method, set);
		const timer = setTimeout(() => { set.delete(on); reject(new Error(`Missing CDP event ${method}`)); }, timeoutMs);
		const on = (params) => { if (!predicate(params)) return; set.delete(on); clearTimeout(timer); resolve(params); };
		set.add(on);
		cancel = () => { set.delete(on); clearTimeout(timer); };
	});
	promise.cancel = cancel;
	return promise;
};
const evaluate = async (expression) => {
	const result = await send("Runtime.evaluate", { expression, returnByValue: true, awaitPromise: true });
	if (result.exceptionDetails) throw new Error(result.exceptionDetails.exception?.description || "evaluate failed");
	return result.result.value;
};
// A MutationObserver armed before the check resolves on the exact DOM state.
const waitFor = (expression, timeoutMs = 20000) => evaluate(`new Promise((resolve, reject) => {
	const test = () => { try { return Boolean(${expression}); } catch { return false; } };
	if (test()) { resolve(true); return; }
	const observer = new MutationObserver(() => { if (!test()) return; observer.disconnect(); clearTimeout(timer); resolve(true); });
	observer.observe(document.documentElement, { subtree: true, childList: true, attributes: true, characterData: true });
	const timer = setTimeout(() => { observer.disconnect(); reject(new Error(${JSON.stringify(`Timed out waiting for: ${expression}`)})); }, ${timeoutMs});
})`);

let failures = 0;
const expect = (name, condition, detail = "") => {
	console.log(`${condition ? "PASS" : "FAIL"} ${name}${condition ? "" : ` — ${detail}`}`);
	if (!condition) failures += 1;
};
const click = async (selector) => {
	const box = await evaluate(`(() => {
		const element = document.querySelector(${JSON.stringify(selector)});
		if (!element) throw new Error('Missing control: ' + ${JSON.stringify(selector)});
		const rect = element.getBoundingClientRect();
		if (!rect.width || !rect.height) throw new Error('Invisible control: ' + ${JSON.stringify(selector)});
		return { x: rect.x + rect.width / 2, y: rect.y + rect.height / 2 };
	})()`);
	for (const type of ["mousePressed", "mouseReleased"]) {
		await send("Input.dispatchMouseEvent", { type, ...box, button: "left", buttons: type === "mousePressed" ? 1 : 0, clickCount: 1 });
	}
};
const MOD = process.platform === "darwin" ? 4 : 2;
const chord = async (code, key, keyCode) => {
	await send("Input.dispatchKeyEvent", { type: "rawKeyDown", key, code, windowsVirtualKeyCode: keyCode, modifiers: MOD });
	await send("Input.dispatchKeyEvent", { type: "keyUp", key, code, windowsVirtualKeyCode: keyCode, modifiers: MOD });
};
const screenshot = async (name, clip) => {
	const image = await send("Page.captureScreenshot", { format: "png", ...(clip ? { clip: { ...clip, scale: 1 } } : {}) });
	const path = join(out, name);
	writeFileSync(path, Buffer.from(image.data, "base64"));
	console.log(`SCREENSHOT ${path}`);
};
const openFileExport = async () => {
	if (!await evaluate("!!document.querySelector('.menubar-menu[data-menu=file]')")) {
		await click("[data-testid=menu-file]");
		await waitFor("!!document.querySelector('#export-menu-trigger')");
	}
	if (!await evaluate("!!document.querySelector('.export-menu')")) {
		await click("#export-menu-trigger");
		await waitFor("!!document.querySelector('.export-menu')");
	}
};
const closeMenus = async () => {
	if (!await evaluate("!!document.querySelector('.menubar-menu')")) return;
	await click(".topbar-swatch");
	await waitFor("!document.querySelector('.menubar-menu')");
};

const framing = (x, z) => ({ pos: { x, y: 1.6, z }, yaw: 0, pitch: -0.08, fovDeg: 45 });
const sceneDocument = (shots, frameCount = 96) => ({
	version: 4, activeSceneId: "qa-topbar-scene",
	scenes: [{
		id: "qa-topbar-scene", name: "QA TOPBAR", objects: [],
		shotDocument: { version: 4, frameCount, waypoints: [], shots },
		stage: { characters: [{ id: "char-a", model: "y-bot-tpose", x: 0, z: 0, rot: 0, hidden: false, pose: null, subject: "a person" }], hasCharSheet: false, shotAspect: "16:9" },
	}],
});
const url = new URL(process.env.QA_URL || "http://127.0.0.1:5180/app/");
async function load(document) {
	const seeded = once("Page.loadEventFired");
	await send("Page.navigate", { url: `${url.origin}/favicon.ico` });
	await seeded;
	await evaluate(`(() => {
		localStorage.setItem("cozyclay.locale", "en");
		localStorage.setItem("cozyclay.project-session.v1", JSON.stringify({ name: "QA", updatedAt: Date.now() }));
		localStorage.setItem("cozyclay.scenes.v4", JSON.stringify(${JSON.stringify(document)}));
		return true;
	})()`);
	const loaded = once("Page.loadEventFired");
	await send("Page.navigate", { url: `${url.origin}/app/` });
	await loaded;
	await waitFor("!!window.__cozyclay?.rigA && !!document.querySelector('.v2-topbar') && !!document.querySelector('.v2-statusbar')", 60000);
}

await send("Runtime.enable");
await send("Page.enable");
await send("Network.enable");
await send("Network.setBlockedURLs", { urls: ["*cloudflareinsights.com*"] });
await send("Browser.setDownloadBehavior", { behavior: "allowAndName", downloadPath: downloads, eventsEnabled: true });
await send("Emulation.setDeviceMetricsOverride", { width: 1920, height: 1080, deviceScaleFactor: 1, mobile: false });

/* ------------------------------------------------ no shots (failure) --- */
await load(sceneDocument([]));
await openFileExport();
expect("with no shots the OTIO item is absent", !await evaluate("!!document.querySelector('[data-testid=export-otio]')"));
expect("with no shots the keyframe pack is disabled with its reason",
	await evaluate("document.querySelector('[data-testid=export-keyframe-pack]').disabled && document.querySelector('[data-testid=export-keyframe-pack]').dataset.disabledReason === 'no-shots'"));
expect("every other export format is still offered", await evaluate("['export-render-passes','export-depth-video','export-storyboard'].every((id) => !!document.querySelector('[data-testid=' + id + ']'))"));
await closeMenus();
const noShotDownload = once("Browser.downloadWillBegin", () => true, 3000);
noShotDownload.catch(() => {});
await chord("KeyE", "e", 69);
expect("⌘E without a shot says why in a toast", await waitFor("[...document.querySelectorAll('.toast')].some((t) => /Add a shot first/.test(t.textContent))").catch(() => false));
expect("⌘E without a shot hands off no download", await noShotDownload.then(() => false, () => true));

/* --------------------------------------------------- one shot (happy) --- */
await load(sceneDocument([{ id: "qa-shot", name: "QA SHOT", startFrame: 0, endFrame: 95, camera: { mode: "keys" }, cameraKeys: [{ id: "k0", frame: 0, framing: framing(0, 5) }, { id: "k95", frame: 95, framing: framing(1.5, 3) }] }]));

const geometry = await evaluate(`(() => {
	const box = (selector) => { const r = document.querySelector(selector).getBoundingClientRect(); return { top: r.top, bottom: r.bottom, height: r.height, width: r.width }; };
	return { top: box('.topbar'), status: box('.brandbar') };
})()`);
expect("the top bar is 44px tall", Math.abs(geometry.top.height - 44) < 0.5, JSON.stringify(geometry.top));
expect("the status bar is 24px tall", Math.abs(geometry.status.height - 24) < 0.5, JSON.stringify(geometry.status));
expect("the status bar sits at the bottom edge", Math.abs(geometry.status.bottom - 1080) < 0.5, JSON.stringify(geometry.status));

const buttons = await evaluate(`[...document.querySelectorAll('header.topbar button')].filter((b) => {
	const r = b.getBoundingClientRect(); const s = getComputedStyle(b);
	return r.width > 1 && r.height > 1 && s.visibility !== 'hidden' && s.display !== 'none';
}).map((b) => ({ testid: b.dataset.testid ?? null, cls: b.className, text: b.innerText.trim(), popup: b.getAttribute('aria-haspopup'), expanded: b.getAttribute('aria-expanded') }))`);
console.log(`TOPBAR BUTTONS ${JSON.stringify(buttons)}`);
const menuTrigger = (b) => /^menu-(file|edit|window|help)$/.test(b.testid ?? "") || (b.cls.includes("project-menu-trigger") && b.expanded !== null);
const generate = (b) => b.testid === "topbar-generate" || b.testid === "topbar-generate-menu";
expect("the only top-bar buttons are the menu triggers, Generate Motion and its caret", buttons.length > 0 && buttons.every((b) => menuTrigger(b) || generate(b)), JSON.stringify(buttons));
expect("the menu bar reads File, Edit, Window, Help", buttons.filter((b) => /^menu-/.test(b.testid ?? "")).map((b) => b.text).join(",") === "File,Edit,Window,Help");
expect("Generate Motion and its caret are present", buttons.filter(generate).length === 2 && buttons.some((b) => b.text === "Generate Motion"));
expect("the MCP state is shown", /MCP (connected|offline)/.test(await evaluate("document.querySelector('.topbar-mcp').textContent")));
const status = await evaluate(`({ left: document.querySelector('.statusbar-left').textContent, fps: document.querySelector('.statusbar-fps')?.textContent, save: document.querySelector('.v2-statusbar [data-testid=project-save-status]')?.textContent })`);
expect("the status bar shows status text, fps and save state", status.left.trim().length > 0 && /\d+ fps/.test(status.fps ?? "") && (status.save ?? "").trim().length > 0, JSON.stringify(status));
await screenshot("task-9-compare.png");
await screenshot("task-9-topbar.png", { x: 0, y: 0, width: 1920, height: 44 });
await screenshot("task-9-statusbar.png", { x: 0, y: 1056, width: 1920, height: 24 });

await click("[data-testid=menu-file]");
await waitFor("!!document.querySelector('.menubar-menu[data-menu=file]')");
const fileItems = await evaluate("[...document.querySelectorAll('.menubar-menu[data-menu=file] > [role=menuitem], .menubar-menu[data-menu=file] > .export-menu-wrap > [role=menuitem]')].map((item) => item.querySelector('.menubar-item-label').textContent)");
expect("File holds New, Open…, Save, Save As…, Export", fileItems.join("|") === "New|Open…|Save|Save As…|Export", fileItems.join("|"));
expect("Save carries topbar-save", await evaluate("!!document.querySelector('.menubar-menu [data-testid=topbar-save]')"));
await openFileExport();
const exportItems = await evaluate("[...document.querySelectorAll('.export-menu [role=menuitem]')].map((item) => item.dataset.testid)");
expect("Export leads with the keyframe pack and keeps every format", exportItems.join(",") === "export-keyframe-pack,export-video,export-render-passes,export-depth-video,export-storyboard,export-otio", exportItems.join(","));
expect("the Export trigger keeps both handles", await evaluate("!!document.querySelector('[data-testid=topbar-export]#export-menu-trigger')"));
const flyout = await evaluate("(() => { const r = document.querySelector('.export-menu').getBoundingClientRect(); const f = document.querySelector('.menubar-menu[data-menu=file]').getBoundingClientRect(); return { left: r.left, right: r.right, fileRight: f.right }; })()");
expect("the Export flyout opens beside File", flyout.left >= flyout.fileRight - 8 && flyout.right <= 1920, JSON.stringify(flyout));
await screenshot("task-9-file-export.png", { x: 0, y: 0, width: 760, height: 360 });

const menuDownload = once("Browser.downloadWillBegin");
const menuDone = once("Browser.downloadProgress", (event) => event.state === "completed");
await click("[data-testid=export-keyframe-pack]");
const menuStarted = await menuDownload;
await menuDone;
const menuZip = readFileSync(join(downloads, menuStarted.guid));
expect("File › Export › Keyframe pack downloads a zip", menuStarted.suggestedFilename.endsWith(".zip") && menuZip.subarray(0, 2).toString() === "PK", menuStarted.suggestedFilename);
console.log(`DOWNLOAD menu ${menuStarted.suggestedFilename} ${menuZip.length} bytes`);
expect("the menu closes after an export is chosen", await waitFor("!document.querySelector('.menubar-menu')").catch(() => false));
expect("the status bar reports the completed pack", await waitFor("document.querySelector('.v2-statusbar [data-testid=export-status]')?.dataset.phase === 'completed' && document.querySelector('.v2-statusbar [data-testid=export-status]')?.dataset.kind === 'keyframe_pack'", 30000).catch(() => false));

const keyDownload = once("Browser.downloadWillBegin");
const keyDone = once("Browser.downloadProgress", (event) => event.state === "completed");
await chord("KeyE", "e", 69);
const keyStarted = await keyDownload;
await keyDone;
const keyZip = readFileSync(join(downloads, keyStarted.guid));
expect("⌘E downloads the keyframe pack zip", keyStarted.suggestedFilename.endsWith(".zip") && keyZip.subarray(0, 2).toString() === "PK", keyStarted.suggestedFilename);
console.log(`DOWNLOAD ⌘E ${keyStarted.suggestedFilename} ${keyZip.length} bytes`);

/* ------------------------------------------------ Edit, Window, Help --- */
await click("[data-testid=menu-edit]");
await waitFor("!!document.querySelector('.menubar-menu[data-menu=edit]')");
expect("Edit holds Undo, Redo, Preferences…", (await evaluate("[...document.querySelectorAll('.menubar-menu[data-menu=edit] [role=menuitem]')].map((i) => i.textContent).join('|')")).replace(/[⌘⇧]|Ctrl\+|Shift\+/g, "").replace(/Z/g, "") === "Undo|Redo|Preferences…");
await click("[data-testid=menu-preferences]");
expect("Edit › Preferences… opens the settings", await waitFor("!!document.querySelector('.settings-menu')").catch(() => false));
await screenshot("task-9-preferences.png", { x: 0, y: 0, width: 760, height: 520 });
await send("Input.dispatchKeyEvent", { type: "rawKeyDown", key: "Escape", code: "Escape", windowsVirtualKeyCode: 27 });
await send("Input.dispatchKeyEvent", { type: "keyUp", key: "Escape", code: "Escape", windowsVirtualKeyCode: 27 });
expect("Escape closes the settings", await waitFor("!document.querySelector('.settings-menu')").catch(() => false));
expect("focus returns to the Edit menu", await waitFor("document.activeElement === document.querySelector('[data-testid=menu-edit]')", 3000).catch(() => false));

await click("[data-testid=menu-window]");
await waitFor("!!document.querySelector('[data-testid=menu-agent]')");
const agentBefore = await evaluate("document.querySelector('[data-testid=menu-agent]').getAttribute('aria-checked')");
await click("[data-testid=menu-agent]");
await click("[data-testid=menu-window]");
await waitFor("!!document.querySelector('[data-testid=menu-agent]')");
expect("Window › Agent toggles the agent pane", await waitFor(`document.querySelector('[data-testid=menu-agent]').getAttribute('aria-checked') !== ${JSON.stringify(agentBefore)}`).catch(() => false));
await click("[data-testid=menu-agent]");
await click("[data-testid=menu-help]");
await waitFor("!!document.querySelector('.menubar-menu[data-menu=help]')");
expect("Help holds Tutorial, Keyboard shortcuts, About", (await evaluate("[...document.querySelectorAll('.menubar-menu[data-menu=help] [role=menuitem]')].map((i) => i.textContent).join('|')")) === "Tutorial|Keyboard shortcuts|About Cozy Clay");
await click(".menubar-menu[data-menu=help] [role=menuitem]:nth-child(2)");
expect("Keyboard shortcuts opens its dialog", await waitFor("!!document.querySelector('.menubar-dialog[data-dialog=shortcuts]')").catch(() => false));
await screenshot("task-9-shortcuts.png");
await click(".menubar-dialog-close");
await waitFor("!document.querySelector('.menubar-dialog')");

await click("[data-testid=topbar-generate-menu]");
expect("the Generate caret lists Start over, Take it again, Add block", await waitFor("[...document.querySelectorAll('[data-generate-action]')].map((i) => i.dataset.generateAction).join() === 'new,again,block'").catch(() => false));
await screenshot("task-9-generate-menu.png", { x: 1320, y: 0, width: 600, height: 260 });
await closeMenus();

/* ------------------------------------------------ cancel mid-export --- */
await openFileExport();
await click("[data-testid=export-video]");
expect("a running video shows progress and Cancel in the status bar", await waitFor("!!document.querySelector('.v2-statusbar [data-testid=export-cancel]')", 30000).catch(() => false));
const running = await evaluate("document.querySelector('.v2-statusbar [data-testid=export-status]').innerText");
console.log(`STATUS running ${JSON.stringify(running)}`);
await screenshot("task-9-export-running.png", { x: 0, y: 1056, width: 1920, height: 24 });
await click(".v2-statusbar [data-testid=export-cancel]");
expect("the status bar shows the cancel state", await waitFor("document.querySelector('.v2-statusbar [data-testid=export-status]')?.dataset.phase === 'cancelled'", 30000).catch(() => false));
console.log(`STATUS cancelled ${JSON.stringify(await evaluate("document.querySelector('.v2-statusbar [data-testid=export-status]').innerText"))}`);
await screenshot("task-9-cancel.png", { x: 0, y: 1056, width: 1920, height: 24 });

/* ------------------------------------------------------ narrow window --- */
await send("Emulation.setDeviceMetricsOverride", { width: 390, height: 844, deviceScaleFactor: 1, mobile: false });
await waitFor("window.innerWidth === 390");
const narrow = await evaluate(`[...document.querySelectorAll('header.topbar button, footer.brandbar button, footer.brandbar [role=status]')].filter((e) => e.getBoundingClientRect().width > 1).map((e) => { const r = e.getBoundingClientRect(); return { t: e.dataset.testid ?? e.className, left: r.left, right: r.right }; })`);
expect("at 390px every bar control stays inside the window", narrow.every((c) => c.left >= 0 && c.right <= 391), JSON.stringify(narrow));
await screenshot("task-9-narrow.png");
await send("Emulation.setDeviceMetricsOverride", { width: 1920, height: 1080, deviceScaleFactor: 1, mobile: false });

expect("the browser raised no page exceptions", runtimeErrors.length === 0, runtimeErrors.join(" | "));
console.log(`DOWNLOADS ${readdirSync(downloads).length} file(s) in ${downloads}`);
ws.close();
if (failures) {
	console.error(`\n${failures} top-bar browser check(s) failed`);
	process.exit(1);
}
console.log("all top bar / menu / status bar browser checks PASS");

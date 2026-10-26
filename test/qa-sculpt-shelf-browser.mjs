#!/usr/bin/env node
// Browser QA for the sculpt shelf (#740 S9 + S13): Save to shelf in Sculpt mode
// makes a card with a rendered thumbnail in Content › Sculpts; the card survives
// a reload and the original sculpt's deletion; dragging it into a second scene
// makes a sculpt with the same recipe at the drop point, as one undo step; and
// the exported .cozysculpt.json imports back after the card is deleted.
// Run through tools/qa-browser.mjs with QA_URL pointing at `/app/`.

import { mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const port = Number(process.env.CDP_PORT || 9222);
const out = process.env.QA_OUT || join(tmpdir(), "cozyclay-qa-sculpt-shelf");
const downloads = join(out, `downloads-${Date.now()}`);
const recipe = JSON.parse(await readFile(new URL("./fixtures/sculpt-snorlax.json", import.meta.url), "utf8"));
await mkdir(downloads, { recursive: true });
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
const reload = async () => {
	const loaded = new Promise((resolve) => {
		const onMessage = (event) => {
			if (JSON.parse(event.data).method !== "Page.loadEventFired") return;
			ws.removeEventListener("message", onMessage);
			resolve();
		};
		ws.addEventListener("message", onMessage);
	});
	await send("Page.reload", { ignoreCache: true });
	await loaded;
};
const waitFor = (condition, timeoutMs = 15000) => evaluate(`new Promise((resolve) => {
	const deadline = performance.now() + ${timeoutMs};
	const tick = () => {
		let value = false;
		try { value = Boolean(${condition}); } catch {}
		if (value) return resolve(true);
		if (performance.now() > deadline) return resolve(false);
		setTimeout(tick, 50);
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
const click = (selector) => evaluate(`(() => { const node = document.querySelector(${JSON.stringify(selector)}); if (!node || node.disabled) return false; node.click(); return true; })()`);
const rectOf = (selector) => evaluate(`(() => { const r = document.querySelector(${JSON.stringify(selector)})?.getBoundingClientRect(); return r ? { x: r.left + r.width / 2, y: r.top + r.height / 2, left: r.left, top: r.top, width: r.width, height: r.height } : null; })()`);
const mouse = (type, params) => send("Input.dispatchMouseEvent", { type, ...params });
const drag = async (from, to, steps = 8) => {
	await mouse("mouseMoved", { x: from.x, y: from.y });
	await mouse("mousePressed", { x: from.x, y: from.y, button: "left", buttons: 1, clickCount: 1 });
	for (let i = 1; i <= steps; i += 1) await mouse("mouseMoved", { x: from.x + ((to.x - from.x) * i) / steps, y: from.y + ((to.y - from.y) * i) / steps, button: "left", buttons: 1 });
	await mouse("mouseReleased", { x: to.x, y: to.y, button: "left", buttons: 0, clickCount: 1 });
};
const press = async (code, key, windowsVirtualKeyCode) => {
	await evaluate("document.activeElement?.blur?.()");
	await send("Input.dispatchKeyEvent", { type: "rawKeyDown", code, key, windowsVirtualKeyCode });
	await send("Input.dispatchKeyEvent", { type: "keyUp", code, key, windowsVirtualKeyCode });
};
const mode = () => evaluate("document.querySelector('[data-workflow-mode]')?.dataset.workflowMode ?? null");
const sculpts = () => evaluate("(window.__cozyclay?.objects ?? []).filter((object) => object.renderer === 'sculpt').map(({ id, name, x, y, z, recipe }) => ({ id, name, x, y, z, parts: recipe?.parts?.length ?? 0, recipe: JSON.stringify(recipe) }))");
const pastDepth = () => evaluate("window.__sceneHistory?.().past ?? null");
const CARD = "[data-testid=content-asset][data-asset-key^='sculpt:sculpt-']";
const openSculpts = async () => {
	// The Content pane is the dock's Assets tab; hidden, its tiles have no box to drag.
	await click("[data-testid=dock-tab-assets]");
	await waitFor("!document.querySelector('.studio-library')?.hidden");
	await click("[data-testid=content-tab-content]");
	await click("[data-testid=content-folder-sculpts]");
	return waitFor("!!document.querySelector('[data-testid=sculpt-shelf]') && !document.querySelector('[data-testid=sculpt-shelf] .is-loading')");
};
const cardKeys = () => evaluate(`[...document.querySelectorAll(${JSON.stringify(CARD)})].map((node) => node.dataset.assetKey)`);
// Opaque pixels in the card's thumbnail: a blank render would be all transparent.
const thumbCoverage = (selector) => evaluate(`(async () => {
	const img = document.querySelector(${JSON.stringify(selector)} + ' img');
	if (!img?.src?.startsWith('data:image/png')) return -1;
	await img.decode();
	const canvas = document.createElement('canvas');
	canvas.width = img.naturalWidth; canvas.height = img.naturalHeight;
	const context = canvas.getContext('2d');
	context.drawImage(img, 0, 0);
	const { data } = context.getImageData(0, 0, canvas.width, canvas.height);
	let opaque = 0;
	for (let i = 3; i < data.length; i += 4) if (data[i] > 16) opaque += 1;
	return { coverage: opaque / (canvas.width * canvas.height), width: canvas.width };
})()`);

await send("Page.enable");
await send("DOM.enable");
await send("Emulation.setDeviceMetricsOverride", { width: 1600, height: 1000, deviceScaleFactor: 1, mobile: false });
await send("Page.setDownloadBehavior", { behavior: "allow", downloadPath: downloads });
let failures = 0;
const expect = (name, condition, detail = "") => {
	console.log(`${condition ? "PASS" : "FAIL"} ${name}${condition ? "" : ` — ${detail}`}`);
	if (!condition) failures += 1;
};

await reload();
expect("the editor opens", await waitFor("!document.querySelector('.v2-start-screen') && !!document.querySelector('.timeline') && !!window.__cozyclay?.runStudioAction", 30000));
expect("the shelf starts empty", await openSculpts() && (await cardKeys()).length === 0, JSON.stringify(await cardKeys()));

// --- A sculpt, then Save to shelf in Sculpt mode ------------------------------
const sculptId = await evaluate(`(() => window.__cozyclay.runStudioAction("object.sculpt", { recipe: ${JSON.stringify(recipe)}, name: "QA Snorlax" })?.affectedIds?.[0] ?? null)()`);
expect("object.sculpt makes the source sculpt", Boolean(sculptId));
await waitFor(`(window.__cozyclay.objects ?? []).some((object) => object.id === ${JSON.stringify(sculptId)})`);
const source = (await sculpts()).find((row) => row.id === sculptId);
await evaluate(`window.__cozyclay.runStudioAction("view.select", { selection: { kind: "object", id: ${JSON.stringify(sculptId)} } })`);
await press("Digit5", "5", 53);
expect("key 5 enters Sculpt mode", await waitFor("document.querySelector('[data-workflow-mode]')?.dataset.workflowMode === 'sculpt'"), await mode());
expect("Save to shelf sits under Place in scene and is enabled", await waitFor("document.querySelector('[data-testid=sculpt-place]')?.nextElementSibling?.dataset.testid === 'sculpt-save-shelf' && document.querySelector('[data-testid=sculpt-save-shelf]')?.disabled === false"));
await screenshot("sculpt-shelf-01-sculpt-mode.png");
expect("Save to shelf is clickable", await click("[data-testid=sculpt-save-shelf]"));
expect("the save raises a toast", await waitFor("[...document.querySelectorAll('.toast')].some((node) => node.textContent.includes('saved to the shelf'))"), await evaluate("document.querySelector('.toast')?.textContent ?? ''"));
expect("the card shows in Content › Sculpts", await openSculpts() && await waitFor(`document.querySelectorAll(${JSON.stringify(CARD)}).length === 1`), JSON.stringify(await cardKeys()));
const [cardKey] = await cardKeys();
const cardSelector = `[data-testid=content-asset][data-asset-key=${JSON.stringify(cardKey)}]`;
expect("the card is named after the sculpt", await evaluate(`document.querySelector(${JSON.stringify(cardSelector)})?.querySelector('.content-tile-name')?.textContent === 'QA Snorlax'`));
const thumb = await thumbCoverage(cardSelector);
expect("the card wears a rendered 256 px thumbnail", thumb?.width === 256 && thumb.coverage > 0.05 && thumb.coverage < 0.95, JSON.stringify(thumb));
await screenshot("sculpt-shelf-02-card.png");

// --- The card outlives a reload and its source sculpt ------------------------
await reload();
await waitFor("!!window.__cozyclay?.runStudioAction", 30000);
expect("the card survives a reload", await openSculpts() && await waitFor(`!!document.querySelector(${JSON.stringify(cardSelector)})`));
await evaluate(`window.__cozyclay.runStudioAction("object.remove", { ids: [${JSON.stringify(sculptId)}] })`);
expect("the source sculpt is deleted", await waitFor(`!(window.__cozyclay.objects ?? []).some((object) => object.id === ${JSON.stringify(sculptId)})`));
await click("[data-testid=content-folder-props]");
expect("the card outlives its source sculpt", await openSculpts() && await waitFor(`!!document.querySelector(${JSON.stringify(cardSelector)})`));

// --- Drag the card into a second scene ---------------------------------------
const created = await evaluate("Promise.resolve(window.__cozyclay.runStudioAction('scene.create')).then((receipt) => receipt?.affectedIds ?? null)");
expect("a second scene opens", Array.isArray(created) && created.length > 0, JSON.stringify(created));
await waitFor("(window.__cozyclay.objects ?? []).every((object) => object.renderer !== 'sculpt')");
expect("the second scene has no sculpt", (await sculpts()).length === 0, JSON.stringify(await sculpts()));
expect("the card shows in the second scene", await openSculpts() && await waitFor(`!!document.querySelector(${JSON.stringify(cardSelector)})`));
const depthBeforeDrop = await pastDepth();
const viewport = await rectOf(".viewport");
await drag(await rectOf(cardSelector), { x: viewport.left + viewport.width * 0.6, y: viewport.top + viewport.height * 0.62 });
expect("the drop makes one sculpt", await waitFor("(window.__cozyclay.objects ?? []).filter((object) => object.renderer === 'sculpt').length === 1"), JSON.stringify(await sculpts()));
const [dropped] = await sculpts();
expect("the dropped sculpt has the card's recipe", dropped?.recipe === source?.recipe && dropped.parts === source.parts, `${dropped?.parts} vs ${source?.parts}`);
expect("the dropped sculpt is named after the card", dropped?.name === "QA Snorlax", dropped?.name);
expect("the sculpt stands at the drop point, not the origin", Math.abs(dropped?.y ?? 1) < 1e-6 && Math.hypot(dropped?.x ?? 0, dropped?.z ?? 0) > 0.05, JSON.stringify({ x: dropped?.x, y: dropped?.y, z: dropped?.z }));
expect("the drop is one undo step", (await pastDepth()) === depthBeforeDrop + 1, `${depthBeforeDrop} -> ${await pastDepth()}`);
expect("the dropped sculpt is selected", await waitFor(`document.querySelector('.hierarchy-row-wrap.selected')?.dataset.nodeId === ${JSON.stringify(`object:${dropped?.id}`)}`), await evaluate("document.querySelector('.hierarchy-row-wrap.selected')?.dataset.nodeId ?? null"));
await evaluate("new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)))");
await screenshot("sculpt-shelf-03-dropped.png");

// --- Double-click places a copy at the origin ---------------------------------
await evaluate(`(() => { const tile = document.querySelector(${JSON.stringify(cardSelector)}); tile.dispatchEvent(new MouseEvent("dblclick", { bubbles: true })); })()`);
expect("double-click places a second copy", await waitFor("(window.__cozyclay.objects ?? []).filter((object) => object.renderer === 'sculpt').length === 2"), JSON.stringify(await sculpts()));
const atOrigin = (await sculpts()).find((row) => row.id !== dropped?.id);
expect("the double-clicked copy stands at the origin", Math.hypot(atOrigin?.x ?? 9, atOrigin?.z ?? 9) < 1e-6 && atOrigin?.recipe === source?.recipe, JSON.stringify({ x: atOrigin?.x, z: atOrigin?.z }));
await evaluate(`window.__cozyclay.runStudioAction("object.remove", { ids: [${JSON.stringify(atOrigin?.id ?? "")}] })`);

// --- Export, delete, import back ---------------------------------------------
await click(cardSelector);
expect("a selected card offers Export", await waitFor("!!document.querySelector('[data-testid=sculpt-shelf-export]')"));
await click("[data-testid=sculpt-shelf-export]");
let exported = null;
for (let i = 0; i < 100 && !exported; i += 1) {
	exported = (await readdir(downloads)).find((name) => name.endsWith(".cozysculpt.json")) ?? null;
	if (!exported) await new Promise((resolve) => setTimeout(resolve, 100));
}
expect("Export saves a .cozysculpt.json", Boolean(exported), JSON.stringify(await readdir(downloads)));
const file = exported ? JSON.parse(await readFile(join(downloads, exported), "utf8")) : null;
expect("the file holds the format, recipe and thumbnail", file?.format === "cozysculpt" && file.version === 1 && file.name === "QA Snorlax" && JSON.stringify(file.recipe) === source?.recipe && String(file.thumb).startsWith("data:image/png;base64,"), exported ?? "");
await click("[data-testid=sculpt-shelf-delete]");
expect("Delete asks once more", await waitFor("!!document.querySelector('[data-testid=sculpt-shelf-delete-confirm]')"));
await click("[data-testid=sculpt-shelf-delete-confirm]");
expect("the card is deleted", await waitFor(`!document.querySelector(${JSON.stringify(cardSelector)})`));
expect("the placed sculpt stays after the card goes", (await sculpts()).length === 1);
const { root } = await send("DOM.getDocument");
const { nodeId } = await send("DOM.querySelector", { nodeId: root.nodeId, selector: "[data-testid=sculpt-shelf-file]" });
if (exported) await send("DOM.setFileInputFiles", { nodeId, files: [join(downloads, exported)] });
expect("Import brings the card back under the same id", await waitFor(`!!document.querySelector(${JSON.stringify(cardSelector)})`), JSON.stringify(await cardKeys()));
expect("the import names what came in", await waitFor("document.querySelector('[data-testid=sculpt-shelf-note]')?.textContent.includes('Imported QA Snorlax')"), await evaluate("document.querySelector('[data-testid=sculpt-shelf-note]')?.textContent ?? ''"));
await screenshot("sculpt-shelf-04-imported.png");

ws.close();
if (failures > 0) {
	console.error(`\n${failures} sculpt-shelf check(s) failed`);
	process.exit(1);
}
console.log("\nAll sculpt-shelf checks passed");

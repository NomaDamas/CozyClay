#!/usr/bin/env node
// Browser QA for look-through vs the preview player.
//
//   QA_URL=http://127.0.0.1:5180/app/ node tools/qa-browser.mjs -- \
//     node test/qa-preview-browser.mjs
//
// Studio look-through flies the shot camera (same bindings as the free camera).
// The chrome-free player remains an internal `preview` state entered from the
// Workflow embed (`?embed=playview`). Every wait is a state condition; nothing
// here sleeps.
const port = Number(process.env.CDP_PORT || 9222);
const baseUrl = process.env.QA_URL || "http://127.0.0.1:5180/app/";
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
const escape = async () => {
	await send("Input.dispatchKeyEvent", { type: "keyDown", key: "Escape", code: "Escape", windowsVirtualKeyCode: 27 });
	await send("Input.dispatchKeyEvent", { type: "keyUp", key: "Escape", code: "Escape", windowsVirtualKeyCode: 27 });
};
const mouse = async (type, extra) => {
	await send("Input.dispatchMouseEvent", { type, ...extra });
};
/** an element counts as shown when it is in the box tree and not [hidden] */
const shown = (selector) => `(() => {
	const el = document.querySelector(${JSON.stringify(selector)});
	return !!el && !el.hidden && !!el.offsetParent;
})()`;

/* ------------------------------------------------------------- the app --- */

await waitFor("location.href.startsWith('http')", 30000);
await evaluate("localStorage.setItem('cozyclay.locale', 'en')");
await send("Page.enable");
await send("Page.navigate", { url: `${baseUrl}?motion=/demo/walk-then-stop.npz` });
expect("the studio comes up with a character", await waitFor("!!window.__cozyclay?.rigA", 40000));
expect("the demo motion is loaded", await waitFor("!!window.__cozyclay?.motion && window.__cozyclay.frameCount > 30", 40000));
expect("the hierarchy has rendered", await waitFor("document.querySelectorAll('.hierarchy-row-wrap').length > 0", 15000));

/* --------------------------------------------- the tabs are gone (#195) --- */

expect("no centre tabs in the DOM", await evaluate("document.querySelectorAll('.pane-tabs').length === 0"));
expect("no PlayView toolbar in the DOM", await evaluate("document.querySelectorAll('.editor-toolbar.play-tools').length === 0"));
expect("the scene tools own the title bar", await evaluate(shown(".editor-toolbar.scene-tools")));
expect("the studio starts outside the player", await evaluate("globalThis.playMode === false"));
expect("the shot PiP offers look-through", await evaluate(shown(".vp-look-through")));

// Park the playhead near the end so a player-style restart to frame 0 would
// be unmistakable — look-through must leave the playhead where it is.
const parked = await evaluate("(() => { const f = window.__cozyclay.frameCount - 6; window.__cozyclay.scrub(f); return f; })()");
expect("the playhead is parked near the end", await waitFor(`window.__cozyclay.tlFrame === ${parked}`, 8000));

const editorBefore = await evaluate("(() => { const r = window.__cozyclay.editorCam.rotation; return { x: r.x, y: r.y, z: r.z }; })()");

/* ------------------------------------------------------ fly the shot camera */

await evaluate("document.querySelector('.vp-look-through').click()");
expect("look-through does not enter the player", await waitFor("globalThis.playMode === false", 8000));
expect("the QA hook agrees", await evaluate("window.__cozyclay.preview === false && window.__cozyclay.lookThroughShot === true"));
expect("the pane renders through the shot camera", await waitFor("window.__cozyclay.activeCam === window.__cozyclay.shotCam", 8000));
expect("the shot PiP is gone", await evaluate(`!${shown(".vp-shot-preview")}`));
expect("the way out is visible", await evaluate(shown(".vp-look-through-exit")));
expect("the camera bar toggle is pressed", await waitFor(`${shown('[data-testid="shot-look-toggle"]')} && document.querySelector('[data-testid="shot-look-toggle"]').getAttribute("aria-pressed") === "true"`, 8000));
expect("the playhead did not restart", await waitFor(`window.__cozyclay.tlFrame === ${parked}`, 8000));
expect("playback did not start", await evaluate("window.__cozyclay.playing === false"));

const shotBefore = await evaluate("(() => { const r = window.__cozyclay.shotCam.rotation; return { x: r.x, y: r.y, z: r.z }; })()");
const canvas = await evaluate(`(() => {
	const el = document.querySelector(".stage canvas");
	if (!el) return null;
	const r = el.getBoundingClientRect();
	return { x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2) };
})()`);
expect("the stage canvas is on screen", !!canvas, JSON.stringify(canvas));
await mouse("mousePressed", { x: canvas.x, y: canvas.y, button: "right", buttons: 2, clickCount: 1 });
await mouse("mouseMoved", { x: canvas.x + 80, y: canvas.y + 24, button: "right", buttons: 2 });
await mouse("mouseMoved", { x: canvas.x + 140, y: canvas.y + 40, button: "right", buttons: 2 });
await mouse("mouseReleased", { x: canvas.x + 140, y: canvas.y + 40, button: "right", buttons: 0, clickCount: 1 });
expect(
	"right-drag turned the shot camera",
	await waitFor(`(() => {
		const r = window.__cozyclay.shotCam.rotation;
		const b = ${JSON.stringify(shotBefore)};
		return Math.abs(r.x - b.x) > 0.01 || Math.abs(r.y - b.y) > 0.01 || Math.abs(r.z - b.z) > 0.01;
	})()`, 8000),
);
const editorAfter = await evaluate("(() => { const r = window.__cozyclay.editorCam.rotation; return { x: r.x, y: r.y, z: r.z }; })()");
expect(
	"the free camera stayed put",
	Math.abs(editorAfter.x - editorBefore.x) < 0.001 &&
	Math.abs(editorAfter.y - editorBefore.y) < 0.001 &&
	Math.abs(editorAfter.z - editorBefore.z) < 0.001,
	JSON.stringify({ editorBefore, editorAfter }),
);

/* ------------------------------------------------------- leave look-through */

await escape();
expect("Escape leaves look-through", await waitFor("window.__cozyclay.lookThroughShot === false", 8000));
expect("the pane is the editor camera again", await waitFor("window.__cozyclay.activeCam === window.__cozyclay.editorCam", 8000));
expect("the scene tools are back", await evaluate(shown(".editor-toolbar.scene-tools")));
expect("the shot PiP is back", await waitFor(shown(".vp-shot-preview"), 8000));
expect("still no centre tabs to go back to", await evaluate("document.querySelectorAll('.pane-tabs').length === 0"));

/* ------------------------------------------------ the Workflow embed path -- */

await send("Page.navigate", { url: `${baseUrl}?embed=playview` });
expect("the embed comes up", await waitFor("!!window.__cozyclay?.editorCam", 40000));
expect("the embed loads straight into the player", await waitFor("globalThis.playMode === true", 15000));
expect("the embed has no centre tabs either", await evaluate("document.querySelectorAll('.pane-tabs').length === 0"));
expect("the embed hides the whole title bar", await evaluate(`!${shown(".viewport-titlebar")}`));
expect("the embed shows no exit affordance", await evaluate("document.querySelectorAll('.vp-look-through-exit').length === 0"));

await send("Page.navigate", { url: baseUrl });
if (failures > 0) { console.error(`${failures} FAILURES`); process.exit(1); }
console.log("qa-preview-browser: all checks passed");
process.exit(0);

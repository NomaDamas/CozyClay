#!/usr/bin/env node
// Browser QA for the preview state machine (#195), over CDP through the QA
// browser wrapper:
//
//   QA_URL=http://127.0.0.1:5180/app/ node tools/qa-browser.mjs -- \
//     node test/qa-preview-browser.mjs
//
// The Scene/PlayView centre tabs are gone. PlayView's render path survives as
// an internal `preview` state with two entry points — the shot PiP's
// look-through button and the Workflow embed (`?embed=playview`) — and one
// exit (Escape). This drives the real studio with a character and a motion
// loaded and pins the whole round trip: enter (shot camera owns the pane, no
// gizmo handles, no inset, frame 0, playing) and leave (editor chrome back,
// paused). Every wait is a state condition; nothing here sleeps.
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
/** gizmo pick proxies live in the scene graph (src/gizmo-claim.js HANDLE_PROXY_FLAG) */
const gizmoProxies = `(() => {
	let node = window.__cozyclay.editorCam; while (node.parent) node = node.parent;
	let count = 0;
	node.traverse((child) => { if (child.userData?.gizmoHandleProxy) count += 1; });
	return count;
})()`;
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
expect("the shot PiP offers the way in", await evaluate(shown(".vp-look-through")));

// A character row mounts the transform gizmo: that is the editing chrome the
// player has to drop, so it must be on the screen before the comparison.
await evaluate("document.querySelector('[data-node-id=\"characterA\"] .hierarchy-row').click()");
expect("the character row is selected", await waitFor("document.querySelector('[data-node-id=\"characterA\"]').getAttribute('aria-selected') === 'true'", 8000));
expect("the gizmo is mounted in the editor view", await waitFor(`${gizmoProxies} > 0`, 10000));

// Park the playhead near the end so the frame-0 restart is unmistakable —
// playback would need seconds to reach this frame again.
const parked = await evaluate("(() => { const f = window.__cozyclay.frameCount - 6; window.__cozyclay.scrub(f); return f; })()");
expect("the playhead is parked near the end", await waitFor(`window.__cozyclay.tlFrame === ${parked}`, 8000));

/* ------------------------------------------------------ enter the player -- */

await evaluate("document.querySelector('.vp-look-through').click()");
expect("look-through enters preview", await waitFor("globalThis.playMode === true", 8000));
expect("the QA hook agrees", await evaluate("window.__cozyclay.preview === true"));
expect("the rig is still live in the player", await evaluate("!!window.__cozyclay.rigA"));
expect("the pane renders through the shot camera", await evaluate("window.__cozyclay.activeCam === window.__cozyclay.shotCam"));
expect("the gizmo layer is gone", await waitFor(`${gizmoProxies} === 0`, 8000));
expect("no transform gizmo handles remain", await evaluate("typeof window.__gizmoHandles !== 'function' || window.__gizmoHandles().length === 0"));
expect("the plan inset is gone", await evaluate(`!${shown(".vp-inset")}`));
expect("the shot PiP is gone", await evaluate(`!${shown(".vp-shot-preview")}`));
expect("the player keeps one visible way out", await evaluate(shown(".vp-look-through-exit")));
expect("the piece restarted from frame 0", await waitFor(`window.__cozyclay.tlFrame < ${parked}`, 8000));
expect("and it is playing", await waitFor("window.__cozyclay.playing === true", 8000));

/* ------------------------------------------------------- leave the player -- */

await escape();
expect("Escape leaves preview", await waitFor("globalThis.playMode === false", 8000));
expect("no playback is left running underneath", await waitFor("window.__cozyclay.playing === false", 8000));
expect("the scene tools are back", await evaluate(shown(".editor-toolbar.scene-tools")));
expect("the shot PiP is back", await waitFor(shown(".vp-shot-preview"), 8000));
expect("the plan inset is back", await waitFor(shown(".vp-inset"), 8000));
expect("the gizmo comes back with the editor view", await waitFor(`${gizmoProxies} > 0`, 10000));
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

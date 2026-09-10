#!/usr/bin/env node
// Browser QA for the Studio-native camera tutorial (#206), over CDP through
// the QA browser wrapper:
//
//   QA_URL=http://127.0.0.1:5320/app/ CDP_PORT=9320 \
//     node tools/qa-browser.mjs -- node test/qa-camera-tutorial-browser.mjs
//
// It drives the REAL studio with real input events — a right-drag to look, the
// six walk keys pressed while the right button is held, a wheel dolly, an
// Alt+left orbit, "+ Add shot" in the timeline, "Draw rail" plus a stroke over
// the Top-View, and the look-through button — and reads each step's data-done
// back off the strip. Nothing here pokes React state: if a real gesture stops
// announcing itself, this suite goes red. Screenshots land in QA_SHOT_DIR.
//
// It also proves the seeded set (#209): both entries must land on the
// city-block starter with the shipped walk take on its character, and the
// Settings entry must ask before replacing a scene with unsaved changes.
// Evidence script; not part of the Node manifest.
import { mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const port = Number(process.env.CDP_PORT || 9222);
const appUrl = (process.env.QA_URL || "http://127.0.0.1:5180/app/").replace(/\?.*$/, "");
const shotDir = process.env.QA_SHOT_DIR || join(tmpdir(), "tutorial-qa");
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
const screenshot = async (name) => {
	const capture = await send("Page.captureScreenshot", { format: "png" });
	writeFileSync(join(shotDir, `${name}.png`), Buffer.from(capture.data, "base64"));
};

/* ------------------------------------------------------------ helpers --- */

const centreOf = (selector) => evaluate(`(() => {
	const el = document.querySelector(${JSON.stringify(selector)});
	if (!el) return null;
	const box = el.getBoundingClientRect();
	if (box.width < 2 || box.height < 2) return null;
	return { x: box.x + box.width / 2, y: box.y + box.height / 2, width: box.width, height: box.height, left: box.x, top: box.y };
})()`);
const mouse = (type, { x, y, button = "none", buttons = 0, modifiers = 0, clickCount = 0, deltaX = 0, deltaY = 0 }) =>
	send("Input.dispatchMouseEvent", { type, x, y, button, buttons, modifiers, clickCount, deltaX, deltaY });
/** a real press/release pair at an element's centre */
const click = async (selector, modifiers = 0) => {
	const box = await centreOf(selector);
	if (!box) return false;
	await mouse("mousePressed", { x: box.x, y: box.y, button: "left", buttons: 1, clickCount: 1, modifiers });
	await mouse("mouseReleased", { x: box.x, y: box.y, button: "left", buttons: 0, clickCount: 1, modifiers });
	return true;
};
const key = async (code, keyName, virtualKeyCode) => {
	const common = { code, key: keyName, windowsVirtualKeyCode: virtualKeyCode, nativeVirtualKeyCode: virtualKeyCode };
	await send("Input.dispatchKeyEvent", { type: "keyDown", text: keyName, ...common });
	await send("Input.dispatchKeyEvent", { type: "keyUp", ...common });
};
/** The shipped walk take's length on the production clock (24 fps): the
 * transport counts 0 … 431 and the hierarchy says "432 frames". */
const WALK_FRAMES = 432;
const projectLabel = `document.querySelector('.hierarchy-project strong')?.textContent.trim()`;
const propCount = `Number(document.querySelector('[data-node-id="props"] .hierarchy-badge')?.textContent ?? -1)`;
/** window.confirm is a page-level dialog CDP would have to answer out of band;
 * override it in the page instead, record every question, and answer `true`. */
const armConfirm = (answer = true) => evaluate(`(() => {
	window.__qaConfirms = [];
	window.confirm = (message) => { window.__qaConfirms.push(String(message)); return ${answer ? "true" : "false"}; };
	return true;
})()`);
const step = (kind) => `document.querySelector('[data-testid="camera-tutorial-step"][data-kind="${kind}"]')`;
const doneFlag = (kind) => `${step(kind)}?.dataset.done === "1"`;
const currentFlag = (kind) => `${step(kind)}?.dataset.current === "1"`;

/* --------------------------------------------------------- page setup --- */

// The QA browser inherits the host locale; pin English so label matching is
// deterministic, then boot the studio with the tutorial query on.
await send("Page.enable");
await send("Emulation.setDeviceMetricsOverride", { width: 1600, height: 1000, deviceScaleFactor: 1, mobile: false });
await waitFor("location.href.startsWith('http')", 30000);
await evaluate("localStorage.setItem('cozyclay.locale', 'en')");
await send("Page.navigate", { url: `${appUrl}?tutorial=camera` });
expect("the studio comes up on ?tutorial=camera", await waitFor("!!document.querySelector('canvas')", 40000));
expect("the editor camera is live", await waitFor("!!window.__cozyclay?.editorCam", 30000));
expect("the tutorial mounts from the query", await waitFor('!!document.querySelector(\'[data-testid="camera-tutorial"]\')', 15000));

/* ----------------------------------------- the set the steps run on (#209) */

// The seven steps teach Shot / Rail / Play, so the tutorial has to open on a
// set with somebody moving through it: the city-block starter plus the walk
// take, whatever the local motion bridge is doing.
const starterProps = await evaluate(`(async () => {
	const project = await (await fetch('/scenes/city-block.cclayproject')).json();
	return project.scenes.scenes[0].objects.length;
})()`);
expect("the starter scene ships with props to frame", starterProps > 0, String(starterProps));
expect("the query entry went through startCameraTutorial", await waitFor(`window.__cozyclayTutorialSource === "query"`));
expect("the tutorial opened the City Block project", await waitFor(`${projectLabel} === "City Block"`), await evaluate(projectLabel));
expect(
	"the hierarchy holds the starter's props",
	await waitFor(`${propCount} === ${starterProps}`),
	String(await evaluate(propCount)),
);
expect("the startup project chooser never appeared", await evaluate(`!document.querySelector('.project-startup')`));
expect("a take is loaded on the character", await waitFor("!!window.__cozyclay?.motion", 40000));
expect(
	`the take is the ${WALK_FRAMES}-frame walk clip`,
	await waitFor(`window.__cozyclay?.frameCount === ${WALK_FRAMES}`),
	String(await evaluate("window.__cozyclay?.frameCount")),
);
expect(
	"the hierarchy reports the clip length instead of Blocking",
	await waitFor(`document.querySelector('.hierarchy-frame-status')?.textContent.trim() === "${WALK_FRAMES} frames"`),
	await evaluate(`document.querySelector('.hierarchy-frame-status')?.textContent`),
);
expect("the Full-Body lane shows the clip", await waitFor("document.querySelectorAll('.tl-motion-clip').length === 1"));
expect(
	"the transport counts the whole take from frame 0",
	await waitFor(`/^\\u2039\\u25b6\\u203a?0 \\/ ${WALK_FRAMES - 1} /.test(document.querySelector('.tl-transport')?.textContent ?? "")`),
	await evaluate(`document.querySelector('.tl-transport')?.textContent`),
);
expect("the playhead sits on frame 0", await evaluate("window.__cozyclay?.tlFrame === 0"));
expect("the pane is on the free camera, not the shot camera", await evaluate("window.__cozyclay?.lookThroughShot === false"));

expect(
	"the strip shows the seven steps in order",
	await evaluate(`JSON.stringify([...document.querySelectorAll('[data-testid="camera-tutorial-step"]')].map((li) => li.dataset.kind)) === '["fly","walk","dolly","orbit","shot","rail","play"]'`),
);
expect("nothing starts done", await evaluate(`[...document.querySelectorAll('[data-testid="camera-tutorial-step"]')].every((li) => li.dataset.done === "0")`));
expect("the first step is the current one", await evaluate(`${currentFlag("fly")} && ${step("walk")}.dataset.current === "0"`));
expect("the card carries the first instruction", await evaluate(`/Right-drag/.test(document.querySelector('[data-testid="camera-tutorial-card"]').textContent)`));
await screenshot("tutorial-step1");
await screenshot("tutorial-city-block-step1");

/* ------------------------------------------------------- the gestures --- */

const canvas = await centreOf(".stage canvas");
expect("the stage canvas is on screen", !!canvas, JSON.stringify(canvas));

// 1. Look — a right-button drag in the viewport.
await mouse("mousePressed", { x: canvas.x, y: canvas.y, button: "right", buttons: 2, clickCount: 1 });
await mouse("mouseMoved", { x: canvas.x + 70, y: canvas.y + 20, button: "right", buttons: 2 });
await mouse("mouseMoved", { x: canvas.x + 130, y: canvas.y + 34, button: "right", buttons: 2 });
expect("right-drag completes the Look step", await waitFor(doneFlag("fly")));
expect("Walk becomes the current step", await waitFor(currentFlag("walk")));

// 2. Walk — the six keys, pressed while the right button is still held.
await key("KeyW", "w", 87);
await key("KeyA", "a", 65);
await key("KeyS", "s", 83);
expect("three of six keys do not finish Walk", await evaluate(`${step("walk")}.dataset.done === "0"`));
expect("the pressed keys are marked on the card", await waitFor(`document.querySelectorAll('[data-testid="camera-tutorial-card"] kbd[data-done="1"]').length === 3`));
await key("KeyD", "d", 68);
await key("KeyQ", "q", 81);
await key("KeyE", "e", 69);
expect("all six keys complete the Walk step", await waitFor(doneFlag("walk")));
await mouse("mouseReleased", { x: canvas.x + 130, y: canvas.y + 34, button: "right", buttons: 0, clickCount: 1 });

// 3. Dolly — the wheel over the viewport.
await mouse("mouseWheel", { x: canvas.x, y: canvas.y, deltaX: 0, deltaY: -120 });
expect("the wheel completes the Dolly step", await waitFor(doneFlag("dolly")));

// 4. Orbit — Alt + left drag (modifier bit 1 is Alt in the CDP contract).
await mouse("mousePressed", { x: canvas.x, y: canvas.y, button: "left", buttons: 1, clickCount: 1, modifiers: 1 });
await mouse("mouseMoved", { x: canvas.x + 90, y: canvas.y, button: "left", buttons: 1, modifiers: 1 });
await mouse("mouseReleased", { x: canvas.x + 90, y: canvas.y, button: "left", buttons: 0, clickCount: 1, modifiers: 1 });
expect("Alt+left-drag completes the Orbit step", await waitFor(doneFlag("orbit")));
expect("Shot is now the current step", await waitFor(currentFlag("shot")));
await screenshot("tutorial-midway");

// 5. Shot — the timeline's Shots lane header button.
expect("the Shots lane offers + Add shot", await waitFor(`!!document.querySelector('.tl-track-add.cut')`));
expect("+ Add shot is clickable", await click(".tl-track-add.cut"));
expect("adding a shot completes the Shot step", await waitFor(doneFlag("shot")));
expect("the shot block appears in the lane", await waitFor("!!document.querySelector('.tl-shot-block')"));
await screenshot("tutorial-city-block-shot");

// 6. Rail — select the shot, arm Draw rail, then stroke across the Top-View.
expect("the shot block can be selected", await click(".tl-shot-block"));
expect("the camera bar appears for the shot", await waitFor("!!document.querySelector('.tl-camera-editor .tl-rail-draw')"));
expect("Draw rail is clickable", await click(".tl-camera-editor .tl-rail-draw"));
expect("the studio arms rail drawing", await waitFor(`document.querySelector('.app').dataset.railDraw === "1"`));
const inset = await centreOf(".vp-inset");
expect("the Top-View inset is on screen", !!inset, JSON.stringify(inset));
const railY = inset.top + inset.height * 0.55;
const railFrom = inset.left + inset.width * 0.2;
const railTo = inset.left + inset.width * 0.8;
await mouse("mousePressed", { x: railFrom, y: railY, button: "left", buttons: 1, clickCount: 1 });
for (let i = 1; i <= 8; i += 1) {
	await mouse("mouseMoved", { x: railFrom + ((railTo - railFrom) * i) / 8, y: railY - i * 2, button: "left", buttons: 1 });
}
await mouse("mouseReleased", { x: railTo, y: railY - 16, button: "left", buttons: 0, clickCount: 1 });
expect("the stroke completes the Rail step", await waitFor(doneFlag("rail")));
expect(
	"the rail is real geometry on the shot",
	await waitFor(`document.querySelector('.tl-camera-editor .tl-rail-draw')?.textContent.trim() === "Redraw rail"`),
);

// 7. Play — the look-through button hands the pane to the shot camera.
expect("Play is the last current step", await waitFor(currentFlag("play")));
expect("the look-through button is clickable", await click(".vp-look-through"));
expect("look-through completes the Play step", await waitFor(doneFlag("play")));
expect("every step reads done", await evaluate(`[...document.querySelectorAll('[data-testid="camera-tutorial-step"]')].every((li) => li.dataset.done === "1")`));
expect("the overlay reports the Done state", await waitFor(`document.querySelector('[data-testid="camera-tutorial"]').dataset.state === "done"`));
expect("the card says the run is finished", await evaluate(`/Done/.test(document.querySelector('[data-testid="camera-tutorial-card"]').textContent)`));
await screenshot("tutorial-done");

// The close button removes the overlay outright.
expect("the close button is clickable", await click('[data-testid="camera-tutorial-close"]'));
expect("× removes the tutorial from the DOM", await waitFor('!document.querySelector(\'[data-testid="camera-tutorial"]\')'));

/* ------------------------------- Settings ▾ on a scene of one's own (#209) */

// Second scenario: a plain session on its own scene, modified by hand. The
// Settings entry must ask before it replaces that scene, and then land on the
// same seeded set the query entry lands on.
await evaluate(`(() => {
	localStorage.clear();
	localStorage.setItem('cozyclay.locale', 'en');
	localStorage.setItem('cozyclay.project-session.v1', JSON.stringify({ name: 'QA Scene', updatedAt: Date.now() }));
	return true;
})()`);
await send("Page.navigate", { url: appUrl });
expect("plain /app/ comes back up", await waitFor("!!document.querySelector('canvas')", 40000));
expect("plain /app/ carries no tutorial", await evaluate('!document.querySelector(\'[data-testid="camera-tutorial"]\')'));
expect("it comes up on its own project, not the starter", await waitFor(`${projectLabel} === "QA Scene"`), await evaluate(projectLabel));
expect("and with no take loaded", await evaluate("!window.__cozyclay?.motion"));

// Modify the scene by hand: the hierarchy's "+ Add object" menu, one prop.
const propsBefore = Math.max(await evaluate(propCount), 0);
expect("the hierarchy offers + Add object", await waitFor("!!document.querySelector('.add-object-trigger')"));
expect("the add-object menu opens", await click(".add-object-trigger") && await waitFor("!!document.querySelector('.add-object-item')"));
expect("an object can be added", await click(".add-object-item"));
expect(
	"the object lands in the scene",
	await waitFor(`${propCount} === ${propsBefore + 1}`),
	String(await evaluate(propCount)),
);
expect("the project reads as unsaved", await waitFor("!!document.querySelector('.hierarchy-project .project-dirty-dot')"));

// Open the tutorial from Settings ▾ with the confirm answered in the page.
expect("window.confirm is armed for this scenario", await armConfirm(true));
expect("the Settings trigger is present", await waitFor('!!document.querySelector(\'[data-testid="settings-menu-trigger"]\')'));
expect("the Settings menu opens", await click('[data-testid="settings-menu-trigger"]') && await waitFor('!!document.querySelector(\'[data-testid="settings-camera-tutorial"]\')'));
expect("the item is labelled Camera tutorial", await evaluate(`document.querySelector('[data-testid="settings-camera-tutorial"]').textContent.trim() === "Camera tutorial"`));
await screenshot("tutorial-settings-menu");
expect("the Settings item is clickable", await click('[data-testid="settings-camera-tutorial"]'));
expect("replacing the modified scene is confirmed first", await waitFor("(window.__qaConfirms ?? []).length === 1"), JSON.stringify(await evaluate("window.__qaConfirms ?? null")));
expect(
	"the question names the starter scene it is about to open",
	await evaluate(`/City Block starter scene and replaces the current scene/.test(window.__qaConfirms[0])`),
	JSON.stringify(await evaluate("window.__qaConfirms?.[0] ?? null")),
);
expect("the Settings entry went through startCameraTutorial", await evaluate(`window.__cozyclayTutorialSource === "settings"`));
expect("Settings ▾ mounts the tutorial", await waitFor('!!document.querySelector(\'[data-testid="camera-tutorial"]\')'));
expect("the menu closes behind it", await waitFor('!document.querySelector(\'[data-testid="settings-camera-tutorial"]\')'));
expect("it opens at step one", await evaluate(`${currentFlag("fly")} && [...document.querySelectorAll('[data-testid="camera-tutorial-step"]')].every((li) => li.dataset.done === "0")`));
expect("the scene switched to City Block", await waitFor(`${projectLabel} === "City Block"`), await evaluate(projectLabel));
expect(
	"the hand-added object is gone, the starter's props are in",
	await waitFor(`${propCount} === ${starterProps}`),
	String(await evaluate(propCount)),
);
expect("the walk take is loaded here too", await waitFor("!!window.__cozyclay?.motion", 40000));
expect(
	`the same ${WALK_FRAMES}-frame clip is on the Full-Body lane`,
	await waitFor(`window.__cozyclay?.frameCount === ${WALK_FRAMES} && document.querySelectorAll('.tl-motion-clip').length === 1`),
	String(await evaluate("window.__cozyclay?.frameCount")),
);
expect("the playhead sits on frame 0", await evaluate("window.__cozyclay?.tlFrame === 0"));
expect("the pane is on the free camera", await evaluate("window.__cozyclay?.lookThroughShot === false"));
await screenshot("tutorial-settings-city-block");

ws.close();
if (failures > 0) { console.error(`${failures} FAILURES`); process.exit(1); }
console.log("qa-camera-tutorial-browser: all checks passed");
process.exit(0);

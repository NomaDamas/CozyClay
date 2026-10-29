#!/usr/bin/env node
import { mkdir, writeFile } from "node:fs/promises";

const port = Number(process.env.CDP_PORT || 9222), out = process.env.QA_OUT || "/tmp/cozyclay-previs-workflow-qa";
await mkdir(out, { recursive: true });
const targetOrigin = new URL(process.env.QA_URL || "http://127.0.0.1:5180/app/").host;
const targets = await (await fetch(`http://127.0.0.1:${port}/json`)).json();
const page = targets.find(target => target.type === "page" && target.url.includes(targetOrigin)) ?? targets.find(target => target.type === "page");
const ws = new WebSocket(page.webSocketDebuggerUrl);
await new Promise((resolve, reject) => { ws.onopen = resolve; ws.onerror = reject; });
let nextId = 0;
const pending = new Map();
ws.onmessage = event => {
	const message = JSON.parse(event.data);
	if (!message.id || !pending.has(message.id)) return;
	pending.get(message.id)(message.result); pending.delete(message.id);
};
const send = (method, params = {}) => new Promise(resolve => {
	const id = ++nextId; pending.set(id, resolve); ws.send(JSON.stringify({ id, method, params }));
});
const evaluate = async expression => {
	const result = await send("Runtime.evaluate", { expression, returnByValue: true, awaitPromise: true });
	if (result.exceptionDetails) throw new Error(result.exceptionDetails.exception?.description || "evaluate failed");
	return result.result.value;
};
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const wait = async (expression, timeoutMs = 10000) => {
	const deadline = Date.now() + timeoutMs;
	while (Date.now() < deadline) {
		if (await evaluate(expression).catch(() => false)) return true;
		await sleep(100);
	}
	return false;
};
let failures = 0;
const expect = (name, condition) => { console.log(`${condition ? "PASS" : "FAIL"} ${name}`); if (!condition) failures += 1; };
const click = async selector => {
	const found = await evaluate(`(() => { const element = document.querySelector(${JSON.stringify(selector)}); if (!element) return false; element.click(); return true; })()`);
	if (!found) throw new Error(`missing ${selector}`);
	await sleep(150);
};

await wait(`window.__cozyclay?.characters?.length > 0 && !!window.__cozyclay?.runStudioAction`);
await sleep(1000);
await evaluate(`window.__cozyclay.runStudioAction("shot.create")`);
if (!await wait(`!!document.querySelector(".tl-shot-block")`)) throw new Error("shot block was not rendered");
await click(".tl-shot-block");
await wait(`!!window.__cozyclay.activeShotId?.()`);
const shotId = await evaluate(`window.__cozyclay.activeShotId()`);
expect("camera performance control is available", await evaluate(`!!document.querySelector('[data-testid="camera-performance-record"]')`));

const focusId = await evaluate(`window.__cozyclay.characters[0]?.id ?? window.__cozyclay.objects[0]?.id ?? null`);
await evaluate(`window.__cozyclay.runStudioAction("shot.setOptics", { shotId: ${JSON.stringify(shotId)}, optics: { shiftX: 0.1, shiftY: -0.05, focusTargetId: ${JSON.stringify(focusId)} } })`);
await sleep(250);
expect("lens shift reaches the live shot camera", await evaluate(`window.__cozyclay.shotCam.view?.enabled === true`));
expect("focus distance is visible", focusId ? await wait(`!!document.querySelector('[data-testid="focus-distance"]')`) : true);

await evaluate(`window.__cozyclay.runStudioAction("shot.setReview", { shotId: ${JSON.stringify(shotId)}, review: { burnIn: true, comments: [], annotations: [] } })`);
await evaluate(`[...document.querySelectorAll("button")].find(element => element.textContent.trim() === "Review")?.click()`);
expect("burn-in is enabled from review panel", await evaluate(`document.querySelector('[data-testid="review-burn-in"]')?.checked === true`));
await evaluate(`(() => { const element = document.querySelector('textarea[aria-label="Frame comment"]'); Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value").set.call(element, "Keep this framing"); element.dispatchEvent(new Event("input", { bubbles: true })); })()`);
await click('[data-testid="review-comment-add"]');
expect("frame comment persists in shot document", await evaluate(`[...document.querySelectorAll(".review-comment span")].some(element => element.textContent === "Keep this framing")`));

await click('[data-testid="review-annotate"]');
const rect = await evaluate(`(() => { const bounds = document.querySelector('[data-testid="review-overlay"]').getBoundingClientRect(); return { x: bounds.left, y: bounds.top, w: bounds.width, h: bounds.height }; })()`);
for (const [type, x, y, buttons] of [
	["mousePressed", rect.x + rect.w * 0.45, rect.y + rect.h * 0.45, 1],
	["mouseMoved", rect.x + rect.w * 0.55, rect.y + rect.h * 0.55, 1],
	["mouseReleased", rect.x + rect.w * 0.55, rect.y + rect.h * 0.55, 0],
]) await send("Input.dispatchMouseEvent", { type, x, y, button: "left", buttons, clickCount: 1 });
await sleep(300);
expect("viewport stroke persists on its frame", await evaluate(`document.body.innerText.includes("1 stroke(s) on this frame")`));
await click('[data-testid="review-annotate"]');

await click('[data-testid="camera-performance-record"]');
await sleep(200);
for (const [type, x, y, buttons] of [["mousePressed", 650, 350, 2], ["mouseMoved", 710, 365, 2], ["mouseReleased", 710, 365, 0]]) {
	await send("Input.dispatchMouseEvent", { type, x, y, button: "right", buttons, clickCount: 1 });
}
await sleep(300);
await click('[data-testid="camera-performance-record"]');
expect("camera recording saves editable keys", await evaluate(`document.querySelectorAll(".tl-marker.cam").length >= 2`));
await evaluate(`window.__cozyclay.setLookThrough(false)`);
const beforeFrameAll = await evaluate(`window.__cozyclay.editorCam.position.toArray()`);
await click('[data-testid="view-camera-trigger"]'); await click('[data-testid="view-frame-all"]');
await sleep(400);
expect("Frame all moves the editor camera", await evaluate(`window.__cozyclay.editorCam.position.toArray().some((value, index) => Math.abs(value - ${JSON.stringify(beforeFrameAll)}[index]) > 0.001)`));
await click('[data-testid="view-camera-trigger"]'); await click('[data-testid="view-front"]');
await sleep(400);
expect("Front axis view is available", await evaluate(`window.__cozyclay.editorCam.position.z > 0`));

await click('[data-testid="view-menu-trigger"]');
await evaluate(`window.__xrayBaseline = new Map(); window.__cozyclay.rigA?.traverse(node => { for (const material of Array.isArray(node.material) ? node.material : [node.material]) if (material && !window.__xrayBaseline.has(material)) window.__xrayBaseline.set(material, material.opacity); });`);
await click('[data-testid="view-xray"]');
expect("X-Ray viewer preference toggles", await evaluate(`JSON.parse(localStorage.getItem("cozyclay.viewport-tools.v1")).xray === true`));
await click('[data-testid="view-xray"]');
expect("X-Ray restores shared material opacity", await evaluate(`[...window.__xrayBaseline].every(([material, opacity]) => material.opacity === opacity)`));
await click('[data-testid="surface-snap"]');
expect("Surface snap is available from Show", await evaluate(`JSON.parse(localStorage.getItem("cozyclay.viewport-tools.v1")).surfaceSnap === true`));
await click('[data-testid="measure-tool"]');
for (const [x, y] of [[600, 400], [700, 400]]) {
	await send("Input.dispatchMouseEvent", { type: "mousePressed", x, y, button: "left", buttons: 1, clickCount: 1 });
	await send("Input.dispatchMouseEvent", { type: "mouseReleased", x, y, button: "left", buttons: 0, clickCount: 1 });
	await sleep(100);
}
expect("ruler reports a two-point measurement", await wait(`document.querySelector('[data-testid="measure-status"]')?.dataset.points === "2"`));
await evaluate(`document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", code: "Escape", bubbles: true }))`);

if (!await evaluate(`window.__cozyclay.characters.length > 0`)) {
	await evaluate(`window.__cozyclay.runStudioAction("character.add", { character: { id: "qa-char", model: "y-bot-tpose", subject: "QA", x: 0, z: 0, rot: 0 } })`);
}
await wait(`window.__cozyclay.characters.length > 0 && !!window.__cozyclay.rigA`);
await evaluate(`window.__cozyclay.runStudioAction("view.select", { selection: { kind: "character", id: window.__cozyclay.characters[0].id } })`);
await sleep(500);
await evaluate(`window.__cozyclay.runStudioAction("view.setMode", { mode: "pose" })`);
await wait(`window.__cozyclay.ikMode === true && !!document.querySelector('[data-fid="pose_key"]')`);
await evaluate(`window.__cozyclay.setFrame(0)`); await click('[data-fid="pose_key"]');
await evaluate(`window.__cozyclay.setFrame(24)`); await click('[data-fid="pose_key"]');
await evaluate(`window.__cozyclay.setFrame(12)`); await click('[data-testid="pose-breakdown"]');
expect("Breakdown authors an intermediate pose key", await wait(`window.__cozyclay.ik?.keys?.has(12)`));
await click('[data-testid="pose-auto-key"]');
expect("Auto-key is available from the pose key bar", await evaluate(`document.querySelector('[data-testid="pose-auto-key"]')?.getAttribute("aria-pressed") === "true"`));

const drag = await evaluate(`(() => { const marker = [...document.querySelectorAll(".tl-marker.ik")].find(element => element.title.includes("frame 12")); if (!marker) return null; const box = marker.getBoundingClientRect(), lane = marker.closest(".tl-lane").getBoundingClientRect(); return { x: box.left + box.width / 2, y: box.top + box.height / 2, dx: lane.width / 359 }; })()`);
if (!drag) throw new Error("Breakdown key marker was not rendered");
await send("Input.dispatchMouseEvent", { type: "mousePressed", x: drag.x, y: drag.y, button: "left", buttons: 1, clickCount: 1 });
await send("Input.dispatchMouseEvent", { type: "mouseMoved", x: drag.x + 1, y: drag.y, button: "left", buttons: 1, clickCount: 1 });
await send("Input.dispatchMouseEvent", { type: "mouseMoved", x: drag.x + drag.dx, y: drag.y, button: "left", buttons: 1, clickCount: 1 });
await send("Input.dispatchMouseEvent", { type: "mouseReleased", x: drag.x + drag.dx, y: drag.y, button: "left", buttons: 0, clickCount: 1 });
expect("Dope Sheet drag moves a pose key", await wait(`[...document.querySelectorAll(".tl-marker.ik")].some(element => element.title.includes("frame 13")) && ![...document.querySelectorAll(".tl-marker.ik")].some(element => element.title.includes("frame 12"))`));
const collision = await evaluate(`(() => { const marker = [...document.querySelectorAll(".tl-marker.ik")].find(element => element.title.includes("frame 13")); const box = marker.getBoundingClientRect(), lane = marker.closest(".tl-lane").getBoundingClientRect(); return { x: box.left + box.width / 2, y: box.top + box.height / 2, dx: lane.width * 11 / 359 }; })()`);
await send("Input.dispatchMouseEvent", { type: "mousePressed", x: collision.x, y: collision.y, button: "left", buttons: 1, clickCount: 1 });
await send("Input.dispatchMouseEvent", { type: "mouseMoved", x: collision.x + 1, y: collision.y, button: "left", buttons: 1, clickCount: 1 });
await send("Input.dispatchMouseEvent", { type: "mouseMoved", x: collision.x + collision.dx, y: collision.y, button: "left", buttons: 1, clickCount: 1 });
await send("Input.dispatchMouseEvent", { type: "mouseReleased", x: collision.x + collision.dx, y: collision.y, button: "left", buttons: 0, clickCount: 1 });
expect("Dope Sheet refuses to overwrite an occupied key", await evaluate(`[...document.querySelectorAll(".tl-marker.ik")].some(element => element.title.includes("frame 13")) && [...document.querySelectorAll(".tl-marker.ik")].some(element => element.title.includes("frame 24"))`));
expect("burn-in changes actual RGBA output", await evaluate(`(async () => { const { burnInRgba } = await import("/src/review-burn-in.js"); const output = burnInRgba(new Uint8ClampedArray(16), 2, 2, { title: "QA", detail: "F 0000" }); return output.some(value => value !== 0); })()`));

const image = await send("Page.captureScreenshot", { format: "png", captureBeyondViewport: true });
await writeFile(`${out}/previs-workflow.png`, Buffer.from(image.data, "base64"));
console.log(`SCREENSHOT ${out}/previs-workflow.png`);
ws.close();
if (failures) process.exitCode = 1;

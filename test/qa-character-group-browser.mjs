#!/usr/bin/env node
// Browser contract for a character grouped under a scene object (#655). The
// author drags the character's Outliner row onto the car's row; the character
// then reads under the car, rides the car's travel path during playback, is
// carried when the car is moved in the editor, and "Remove from group" puts it
// back in the world.
//
// Run: `CCLAY_KIMODO_HOST= COZYCLAY_LIVE_PORT=5890 npm run dev -- --port 5790`
// in one shell, then
// `QA_URL=http://127.0.0.1:5790/app/ CDP_PORT=9431 node tools/qa-browser.mjs -- node test/qa-character-group-browser.mjs`
import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";

const cdpPort = Number(process.env.CDP_PORT || 9431);
const out = process.env.QA_OUT || "/tmp/character-group-qa";
const targets = await (await fetch(`http://127.0.0.1:${cdpPort}/json`)).json();
const page = targets.find((target) => target.type === "page" && target.url.includes("/app/")) || targets.find((target) => target.type === "page");
assert.ok(page, "studio page is not open");

const ws = new WebSocket(page.webSocketDebuggerUrl);
await new Promise((resolve, reject) => { ws.onopen = resolve; ws.onerror = reject; });
let seq = 0;
const pending = new Map();
ws.onmessage = (event) => {
	const message = JSON.parse(event.data);
	if (!message.id || !pending.has(message.id)) return;
	const item = pending.get(message.id);
	pending.delete(message.id);
	if (message.error) item.reject(new Error(JSON.stringify(message.error)));
	else item.resolve(message.result);
};
const send = (method, params = {}) => new Promise((resolve, reject) => { const id = ++seq; pending.set(id, { resolve, reject }); ws.send(JSON.stringify({ id, method, params })); });
const evaluate = async (expression) => {
	const result = await send("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true });
	if (result.exceptionDetails) throw new Error(result.exceptionDetails.exception?.description || "browser evaluation failed");
	return result.result?.value;
};
const waitFor = async (label, probe, timeoutMs = 60000) => {
	const deadline = Date.now() + timeoutMs;
	while (Date.now() < deadline) {
		const value = await probe().catch(() => null);
		if (value) return value;
		await new Promise((resolve) => setTimeout(resolve, 150));
	}
	throw new Error(`Timed out waiting for ${label}`);
};
const near = (a, b, tol = 1e-3) => Math.abs(a - b) <= tol;
await mkdir(out, { recursive: true });
const shot = async (name) => {
	const image = await send("Page.captureScreenshot", { format: "png" });
	await writeFile(`${out}/${name}.png`, Buffer.from(image.data, "base64"));
};

await waitFor("studio QA hook", () => evaluate("Boolean(window.__cozyclay?.sceneObject && window.__cozyclay?.scrub)"));
await waitFor("character rig", () => evaluate("Boolean(window.__cozyclay.rigA?.parent)"));
const character = await evaluate("({ id: window.__cozyclay.charA.id, x: window.__cozyclay.charA.x, y: window.__cozyclay.charA.y ?? 0, z: window.__cozyclay.charA.z })");

// The car the agent builds, standing over the character: a chassis with a part.
const car = await evaluate(`(() => {
	const api = window.__cozyclay.sceneObject;
	const chassis = api.place({ kind: "cube", name: "Vintage Car", x: ${character.x}, y: 0.4, z: ${character.z} }).id;
	api.update({ id: chassis, scaleX: 1.3, scaleY: 0.22, scaleZ: 3.6 });
	const cabin = api.place({ kind: "cube", name: "Cabin", parent: chassis, x: ${character.x}, y: 0.62, z: ${character.z - 1.2} }).id;
	return { chassis, cabin };
})()`);

// Group the character under the car the way an author does: drag its row
// onto the car's row. The props folder may be folded; open it first.
await waitFor("car row", () => evaluate(`(() => {
	if (document.querySelector('[data-node-id="object:${car.chassis}"]')) return true;
	const fold = document.querySelector('[data-node-id="props"] .hierarchy-toggle');
	if (fold && fold.textContent.trim() === "▸") fold.click();
	return null;
})()`));
await evaluate(`(() => {
	const source = document.querySelector('[data-node-id="characterA"]');
	const target = document.querySelector('[data-node-id="object:${car.chassis}"]');
	const dataTransfer = new DataTransfer();
	const fire = (node, type) => node.dispatchEvent(new DragEvent(type, { bubbles: true, cancelable: true, dataTransfer }));
	fire(source, "dragstart");
	fire(target, "dragenter");
	fire(target, "dragover");
	fire(target, "drop");
	fire(source, "dragend");
})()`);
const grouped = await waitFor("character grouped under the car", () => evaluate(`window.__cozyclay.charA.parent === ${JSON.stringify(car.chassis)} || null`));
assert.equal(grouped, true);

// The Outliner files the character under the car, after the car's own part.
const rows = await waitFor("character row under the car row", () => evaluate(`(() => {
	const rows = [...document.querySelectorAll(".v2-outliner .hierarchy-row-wrap")];
	const depth = (row) => Number(getComputedStyle(row).getPropertyValue("--hierarchy-depth") || row.style.getPropertyValue("--hierarchy-depth"));
	const carRow = rows.find((row) => row.dataset.nodeId === "object:${car.chassis}");
	const cabinRow = rows.find((row) => row.dataset.nodeId === "object:${car.cabin}");
	const characterRow = rows.find((row) => row.dataset.nodeId === "characterA");
	if (!carRow || !cabinRow || !characterRow) return null;
	return { car: rows.indexOf(carRow), cabin: rows.indexOf(cabinRow), character: rows.indexOf(characterRow), carDepth: depth(carRow), characterDepth: depth(characterRow) };
})()`));
assert.ok(rows.character > rows.cabin && rows.cabin > rows.car && rows.characterDepth === rows.carDepth + 1, `Outliner order/depth: ${JSON.stringify(rows)}`);
await shot("outliner-grouped");

// Playback: the car drives 8 m along +z and the character rides it.
await evaluate(`window.__cozyclay.sceneObject.update({ id: ${JSON.stringify(car.chassis)}, path: { points: [{ x: ${character.x}, y: 0.4, z: ${character.z} }, { x: ${character.x}, y: 0.4, z: ${character.z + 8} }] } })`);
const frameCount = await evaluate("window.__cozyclay.frameCount");
const placedAt = async (frame) => {
	await evaluate(`window.__cozyclay.scrub(${frame})`);
	return waitFor(`frame ${frame} placed`, () => evaluate(`(() => {
		const props = window.__cclayPropWorld || {};
		const chassis = props[${JSON.stringify(car.chassis)}];
		if (!chassis || chassis.frame !== ${frame}) return null;
		const body = window.__cozyclay.rigA.parent;
		body.updateWorldMatrix(true, false);
		const at = body.getWorldPosition(body.position.clone());
		return { chassis: { x: chassis.x, y: chassis.y, z: chassis.z }, character: { x: at.x, y: at.y, z: at.z } };
	})()`));
};
const report = [];
for (const frame of [0, Math.round((frameCount - 1) / 2), frameCount - 1]) {
	// Two passes: the carrier places in the frame loop, so let one frame run.
	await placedAt(frame);
	await new Promise((resolve) => setTimeout(resolve, 200));
	const at = await placedAt(frame);
	const travel = at.chassis.z - character.z;
	assert.ok(near(at.character.x, character.x) && near(at.character.y, character.y) && near(at.character.z, character.z + travel),
		`frame ${frame}: character at ${JSON.stringify(at.character)} should ride the car ${travel.toFixed(3)} m to z ${(character.z + travel).toFixed(3)}`);
	report.push({ frame, chassisZ: +at.chassis.z.toFixed(3), characterZ: +at.character.z.toFixed(3) });
	await shot(`ride-${frame}`);
}
assert.ok(report.at(-1).characterZ - report[0].characterZ > 7.9, `the character travels with the car: ${JSON.stringify(report)}`);
console.log(JSON.stringify({ frameCount, report }));

// Authoring: moving the car in the editor carries the grouped character.
await evaluate("window.__cozyclay.scrub(0)");
await evaluate(`window.__cozyclay.sceneObject.update({ id: ${JSON.stringify(car.chassis)}, x: ${character.x + 1.5} })`);
await waitFor("character carried by the car's move", () => evaluate(`Math.abs(window.__cozyclay.charA.x - ${character.x + 1.5}) < 1e-6 || null`));
console.log("authoring carry: character x", await evaluate("window.__cozyclay.charA.x"));

// "Remove from group" from the character row's context menu.
await evaluate(`(() => {
	const row = document.querySelector('[data-node-id="characterA"]');
	const r = row.getBoundingClientRect();
	row.dispatchEvent(new MouseEvent("contextmenu", { bubbles: true, cancelable: true, clientX: r.left + 20, clientY: r.top + 5 }));
})()`);
await waitFor("Remove from group item", () => evaluate(`(() => {
	const item = [...document.querySelectorAll(".hierarchy-context-menu .hierarchy-context-item")].find((node) => /Remove from group|그룹에서 빼기/.test(node.textContent));
	if (!item) return null; item.click(); return true;
})()`));
await waitFor("character back in the world", () => evaluate("window.__cozyclay.charA.parent === null || null"));
const released = await placedAt(frameCount - 1);
await new Promise((resolve) => setTimeout(resolve, 200));
const releasedAt = await placedAt(frameCount - 1);
assert.ok(near(releasedAt.character.z, character.z) && near(releasedAt.character.x, character.x + 1.5), `released character stands where it was authored: ${JSON.stringify(releasedAt.character)} (${JSON.stringify(released.character)})`);
await waitFor("character row back in the cast", () => evaluate(`(() => {
	const rows = [...document.querySelectorAll(".v2-outliner .hierarchy-row-wrap")];
	const characterRow = rows.find((row) => row.dataset.nodeId === "characterA");
	return characterRow && Number(characterRow.style.getPropertyValue("--hierarchy-depth")) === 1 || null;
})()`));
console.log(`character group browser QA: grouped by drag, rides the route, carried by the move, released by the menu (screenshots in ${out})`);
ws.close();

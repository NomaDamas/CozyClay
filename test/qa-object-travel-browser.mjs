#!/usr/bin/env node
// Browser contract for a routed group (#647): the Studio agent builds a vintage car as
// a chassis box with its body parts parented under it, and a travel route on
// the chassis has to drive the whole car — not the chassis alone while the
// parts stay parked. The assertions read the rendered prop transforms (the
// placement hook in props.jsx), scrubbed to several frames.
//
// Run: `CCLAY_KIMODO_HOST= COZYCLAY_LIVE_PORT=5890 npm run dev -- --port 5790`
// in one shell, then
// `QA_URL=http://127.0.0.1:5790/app/ CDP_PORT=9431 node tools/qa-browser.mjs -- node test/qa-object-travel-browser.mjs`
import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";

const cdpPort = Number(process.env.CDP_PORT || 9431);
const out = process.env.QA_OUT || "/tmp/object-travel-qa";
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

await waitFor("studio QA hook", () => evaluate("Boolean(window.__cozyclay?.sceneObject && window.__cozyclay?.scrub)"));

// The car, in the agent's shape: chassis at 0.4 m with parts grouped under it.
const ids = await evaluate(`(() => {
	const api = window.__cozyclay.sceneObject;
	const chassis = api.place({ kind: "cube", name: "Vintage Car", x: -2.2, y: 0.4, z: 0.6 }).id;
	api.update({ id: chassis, scaleX: 1.3, scaleY: 0.22, scaleZ: 3.6 });
	const parts = [
		["Cabin", -2.2, 0.62, -0.7],
		["Fender FL", -1.45, 0.74, 1.8],
		["Fender FR", -2.95, 0.74, 1.8],
		["Running Board L", -1.45, 0.45, 0.6],
	].map(([name, x, y, z]) => api.place({ kind: "cube", name, parent: chassis, x, y, z }).id);
	return { chassis, parts };
})()`);
await waitFor("parts on stage", () => evaluate(`(() => { const w = window.__cclayPropWorld || {}; return ${JSON.stringify([ids.chassis, ...ids.parts])}.every((id) => w[id]); })()`));
const authored = await evaluate(`Object.fromEntries(window.__cozyclay.objects.map((o) => [o.id, { x: o.x, y: o.y, z: o.z, parent: o.parent }]))`);
for (const id of ids.parts) assert.equal(authored[id].parent, ids.chassis, `${id} is grouped under the chassis`);

// A straight route forward along +z, at the chassis's height.
await evaluate(`window.__cozyclay.sceneObject.update({ id: ${JSON.stringify(ids.chassis)}, path: { points: [{ x: -2.2, y: 0.4, z: 0.6 }, { x: -2.2, y: 0.4, z: 8.6 }] } })`);
const frameCount = await evaluate("window.__cozyclay.frameCount");
const world = async (frame) => {
	await evaluate(`window.__cozyclay.scrub(${frame})`);
	return waitFor(`props placed at frame ${frame}`, () => evaluate(`(() => {
		const w = window.__cclayPropWorld || {};
		const rows = ${JSON.stringify([ids.chassis, ...ids.parts])}.map((id) => w[id]);
		return rows.every((row) => row && row.frame === ${frame}) ? Object.fromEntries(${JSON.stringify([ids.chassis, ...ids.parts])}.map((id, i) => [id, rows[i]])) : null;
	})()`));
};

await mkdir(out, { recursive: true });
const shot = async (name) => {
	const image = await send("Page.captureScreenshot", { format: "png" });
	await writeFile(`${out}/${name}.png`, Buffer.from(image.data, "base64"));
};

const report = [];
for (const frame of [0, Math.round((frameCount - 1) / 2), frameCount - 1]) {
	const at = await world(frame);
	const chassis = at[ids.chassis];
	const travel = { x: chassis.x - authored[ids.chassis].x, y: chassis.y - authored[ids.chassis].y, z: chassis.z - authored[ids.chassis].z };
	for (const id of ids.parts) {
		const part = at[id];
		const expected = { x: authored[id].x + travel.x, y: authored[id].y + travel.y, z: authored[id].z + travel.z };
		assert.ok(near(part.x, expected.x) && near(part.y, expected.y) && near(part.z, expected.z),
			`frame ${frame}: ${id} at ${JSON.stringify(part)} should ride the chassis to ${JSON.stringify(expected)}`);
	}
	report.push({ frame, chassisZ: +chassis.z.toFixed(3), partZ: ids.parts.map((id) => +at[id].z.toFixed(3)) });
	await shot(`frame-${frame}`);
}
assert.ok(report.at(-1).chassisZ - report[0].chassisZ > 7.9, `the chassis travels the route: ${JSON.stringify(report)}`);
console.log(JSON.stringify({ frameCount, report }, null, 1));

// The same car, routed the way an author does it: select the chassis, press
// "Draw path" and drag across the Top View. The drawn route has to keep the
// chassis at its 0.4 m, or the whole car sinks into the floor while it drives.
await evaluate(`window.__cozyclay.sceneObject.update({ id: ${JSON.stringify(ids.chassis)}, path: null })`);
await evaluate("window.__cozyclay.scrub(0)");
const mouse = async (type, x, y) => send("Input.dispatchMouseEvent", { type, x: Math.round(x), y: Math.round(y), button: "left", clickCount: 1, buttons: type === "mouseReleased" ? 0 : 1 });
const click = async (x, y) => { await mouse("mousePressed", x, y); await mouse("mouseReleased", x, y); };
// The Props folder may be folded; open it until the chassis row exists, then
// select the chassis the way an author does — by its Outliner row.
const rowSelector = `[data-node-id="object:${ids.chassis}"] .hierarchy-row`;
await waitFor("chassis row in the outliner", () => evaluate(`(() => {
	const row = document.querySelector(${JSON.stringify(rowSelector)});
	if (row) return true;
	const fold = document.querySelector('[data-node-id="props"] .hierarchy-toggle'); if (fold && fold.textContent.trim() === '▸') fold.click();
	return null;
})()`), 15000).catch(async (error) => {
	console.error("outliner node ids:", await evaluate(`[...document.querySelectorAll("[data-node-id]")].map((el) => el.dataset.nodeId).join(", ")`));
	throw error;
});
await evaluate(`document.querySelector(${JSON.stringify(rowSelector)}).click()`);
const drawButton = await waitFor("Draw path button", () => evaluate(`(() => {
	const el = document.querySelector(".objmo-tools .tl-camera-tool"); if (!el) return null;
	const r = el.getBoundingClientRect(); return r.width > 0 ? { x: r.left + r.width / 2, y: r.top + r.height / 2 } : null;
})()`));
await click(drawButton.x, drawButton.y);
await waitFor("draw mode", () => evaluate(`document.querySelector(".objmo-tools .tl-camera-tool.active") !== null`));
// World floor points → screen pixels through the plan camera and its pane.
const toScreen = (x, z) => evaluate(`(() => {
	const pane = document.querySelector(".vp-pane.vp-inset.plan"); const cam = window.__cozyclay.planCam;
	if (!pane || !cam) return null; cam.updateMatrixWorld(); const r = pane.getBoundingClientRect();
	const v = cam.position.clone().set(${x}, 0, ${z}).project(cam);
	return { x: r.left + (v.x + 1) / 2 * r.width, y: r.top + (1 - v.y) / 2 * r.height };
})()`);
const from = await toScreen(-2.2, 2.6);
const to = await toScreen(-2.2, 8.6);
assert.ok(from && to && Math.hypot(to.x - from.x, to.y - from.y) > 20, `the drawn stroke spans the plan pane: ${JSON.stringify({ from, to })}`);
await mouse("mousePressed", from.x, from.y);
for (let i = 1; i <= 20; i += 1) await mouse("mouseMoved", from.x + ((to.x - from.x) * i) / 20, from.y + ((to.y - from.y) * i) / 20);
await mouse("mouseReleased", to.x, to.y);
const drawn = await waitFor("the drawn route", () => evaluate(`window.__cozyclay.objects.find((o) => o.id === ${JSON.stringify(ids.chassis)})?.path ?? null`));
assert.ok(drawn.points.length >= 2 && drawn.points.every((point) => near(point.y, 0.4)), `the drawn route keeps the chassis height: ${JSON.stringify(drawn.points)}`);
const end = await world(frameCount - 1);
for (const id of ids.parts) {
	assert.ok(near(end[id].y, authored[id].y), `the drawn route keeps ${id} at its height: ${JSON.stringify(end[id])} vs ${JSON.stringify(authored[id])}`);
}
assert.ok(end[ids.parts[1]].z - authored[ids.parts[1]].z > 3, `parts drive along the drawn route: ${JSON.stringify(end[ids.parts[1]])}`);
await shot("drawn-end");
console.log(JSON.stringify({ drawn: drawn.points, partsAtEnd: ids.parts.map((id) => end[id]) }));
console.log(`object travel browser QA: the whole group rides the chassis route (screenshots in ${out})`);
ws.close();

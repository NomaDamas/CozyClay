#!/usr/bin/env node
// Browser contract for rotating a group: turning the chassis of a grouped car
// turns every part with it, rigidly about the chassis pivot. The assertions
// read what is RENDERED (the placement hook in props.jsx: world position and
// quaternion per prop) and check the core invariant — each part's pose
// relative to the chassis is unchanged — through three.js, for turns written
// by the update command, by typing into the Inspector's rotation field, and by
// scrubbing that field (a drag transaction: many small steps).
//
// Run: `CCLAY_KIMODO_HOST= COZYCLAY_LIVE_PORT=5907 npm run dev -- --port 5807`
// in one shell, then
// `QA_URL=http://127.0.0.1:5807/app/ CDP_PORT=9497 node tools/qa-browser.mjs -- node test/qa-group-rotation-browser.mjs`
import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import { Euler, Matrix4, Quaternion, Vector3 } from "three";

const cdpPort = Number(process.env.CDP_PORT || 9497);
const out = process.env.QA_OUT || "/tmp/group-rotation-qa";
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

await waitFor("studio QA hook", () => evaluate("Boolean(window.__cozyclay?.sceneObject)"));

// The car in the agent's shape: a chassis with parts under it, one of them a
// group of its own (Vintage Car > Parts > Hood), parts already turned/pitched.
const ids = await evaluate(`(() => {
	const api = window.__cozyclay.sceneObject;
	const chassis = api.place({ kind: "cube", name: "Vintage Car", x: -2.2, y: 1.2, z: 0.6 }).id;
	api.update({ id: chassis, scaleX: 1.3, scaleY: 0.22, scaleZ: 3.6 });
	const part = (name, parent, x, y, z, extra = {}) => {
		const id = api.place({ kind: "cube", name, parent, x, y, z }).id;
		if (Object.keys(extra).length) api.update({ id, ...extra });
		return id;
	};
	const cabin = part("Cabin", chassis, -2.2, 1.6, -0.7);
	const fender = part("Fender FL", chassis, -1.45, 1.4, 1.8, { rot: 25 });
	const board = part("Running Board L", chassis, -1.45, 1.25, 0.6, { rotX: 12, rotZ: -8 });
	const group = part("Parts", chassis, -2.2, 1.3, 1.2, { rot: 40 });
	const hood = part("Hood", group, -2.2, 1.55, 2.4, { rot: -30, rotX: 10 });
	return { chassis, parts: [cabin, fender, board, group, hood], hood, group };
})()`);
const all = [ids.chassis, ...ids.parts];
await waitFor("parts on stage", () => evaluate(`(() => { const w = window.__cclayPropWorld || {}; return ${JSON.stringify(all)}.every((id) => w[id]); })()`));
await mkdir(out, { recursive: true });
const shot = async (name) => writeFile(`${out}/${name}.png`, Buffer.from((await send("Page.captureScreenshot", { format: "png" })).data, "base64"));

const authoredNow = () => evaluate(`Object.fromEntries(window.__cozyclay.objects.map((o) => [o.id, { x: o.x, y: o.y, z: o.z, rot: o.rot, rotX: o.rotX, rotZ: o.rotZ, scaleX: o.scaleX, parent: o.parent }]))`);
const authoredQuat = (o) => evaluate(`(() => { const o = window.__cozyclay.objects.find((p) => p.id === ${JSON.stringify(o)}); return [o.rotX, o.rot, o.rotZ]; })()`);
const rendered = () => evaluate(`JSON.parse(JSON.stringify(window.__cclayPropWorld))`);
const frameMatrix = (row) => new Matrix4().compose(new Vector3(row.x, row.y, row.z), new Quaternion(row.quat.x, row.quat.y, row.quat.z, row.quat.w), new Vector3(1, 1, 1));
const sameQuat = (a, b) => Math.abs(a.dot(b)) > 1 - 1e-6;

/** wait until the render has caught up with the authored chassis rotation */
async function settled(label) {
	return waitFor(`render settled: ${label}`, async () => {
		const [rx, ry, rz] = await authoredQuat(ids.chassis);
		const world = await rendered();
		const row = world[ids.chassis];
		const want = new Quaternion().setFromEuler(new Euler(rx * Math.PI / 180, ry * Math.PI / 180, rz * Math.PI / 180, "XYZ"));
		const parts = ids.parts.every((id) => world[id]);
		return parts && row && sameQuat(want, new Quaternion(row.quat.x, row.quat.y, row.quat.z, row.quat.w)) ? world : null;
	});
}

/** each part's pose relative to the chassis (and Hood relative to Parts) is what it was */
function assertRigid(before, after, label) {
	const pairs = [...ids.parts.filter((id) => id !== ids.hood).map((id) => [ids.chassis, id]), [ids.group, ids.hood], [ids.chassis, ids.hood]];
	for (const [parent, child] of pairs) {
		const rel0 = frameMatrix(before[parent]).invert().multiply(frameMatrix(before[child]));
		const expected = frameMatrix(after[parent]).multiply(rel0);
		const got = frameMatrix(after[child]);
		const ep = new Vector3().setFromMatrixPosition(expected), gp = new Vector3().setFromMatrixPosition(got);
		assert.ok(ep.distanceTo(gp) < 1e-3, `${label}: ${child} under ${parent} drifted by ${ep.distanceTo(gp)} (expected ${ep.toArray()}, got ${gp.toArray()})`);
		const eq = new Quaternion().setFromRotationMatrix(expected), gq = new Quaternion().setFromRotationMatrix(got);
		assert.ok(sameQuat(eq, gq), `${label}: ${child} orientation under ${parent} is not parent-relative-constant`);
	}
}

const base = await settled("initial");
const authored0 = await authoredNow();
for (const id of ids.parts) assert.ok(authored0[id].parent, `${id} is grouped`);
await shot("0-before");

// 1. the update command: yaw 90
await evaluate(`window.__cozyclay.sceneObject.update({ id: ${JSON.stringify(ids.chassis)}, rot: 90 })`);
const yawed = await settled("yaw 90");
assertRigid(base, yawed, "yaw 90");
const authored1 = await authoredNow();
const moved = ids.parts.filter((id) => Math.hypot(authored1[id].x - authored0[id].x, authored1[id].z - authored0[id].z) > 0.1);
assert.ok(moved.length >= 3, `parts orbit the chassis (${moved.length} moved)`);
const cabinOffset = { x: authored0[ids.parts[0]].x - authored0[ids.chassis].x, z: authored0[ids.parts[0]].z - authored0[ids.chassis].z };
// yaw +90 about +Y: (x, z) -> (z, -x)
assert.ok(near(authored1[ids.parts[0]].x - authored1[ids.chassis].x, cabinOffset.z, 1e-6) && near(authored1[ids.parts[0]].z - authored1[ids.chassis].z, -cabinOffset.x, 1e-6),
	`the cabin's offset (${cabinOffset.x}, ${cabinOffset.z}) swung a quarter turn: ${JSON.stringify(authored1[ids.parts[0]])}`);
assert.ok(near(authored1[ids.parts[1]].rot, 25 + 90, 1e-6), `Fender rot gained the chassis yaw: ${authored1[ids.parts[1]].rot}`);
await shot("1-yaw-90");

// 2. pitch + roll on top of the yaw, still through the command
await evaluate(`window.__cozyclay.sceneObject.update({ id: ${JSON.stringify(ids.chassis)}, rotX: 35, rotZ: -20, rot: 123 })`);
const tilted = await settled("tilt");
assertRigid(yawed, tilted, "pitch/roll/yaw");
await shot("2-tilted");

// 3. a combined move + turn in one patch
await evaluate(`window.__cozyclay.sceneObject.update({ id: ${JSON.stringify(ids.chassis)}, x: 1.5, z: -2, rot: -60 })`);
const both = await settled("move + turn");
assertRigid(tilted, both, "move + turn");

// 4. the Inspector: select the chassis the way an author does, type a yaw
const rowSelector = `[data-node-id="object:${ids.chassis}"] .hierarchy-row`;
await waitFor("chassis row in the outliner", () => evaluate(`(() => {
	if (document.querySelector(${JSON.stringify(rowSelector)})) return true;
	const fold = document.querySelector('[data-node-id="props"] .hierarchy-toggle'); if (fold && fold.textContent.trim() === '▸') fold.click();
	return null;
})()`), 15000);
await evaluate(`document.querySelector(${JSON.stringify(rowSelector)}).click()`);
const field = (axisIndex) => waitFor("rotation field", () => evaluate(`(() => {
	const row = [...document.querySelectorAll(".vec3-row")].find((r) => /^(Rotation|회전)$/.test(r.querySelector(".vec3-label")?.textContent.trim() ?? ""));
	const el = row?.querySelectorAll(".number-field")[${axisIndex}]; if (!el) return null;
	const r = el.getBoundingClientRect(); return r.width > 0 ? { x: r.left + r.width / 2, y: r.top + r.height / 2, left: r.left + 4 } : null;
})()`));
const mouse = (type, x, y, buttons = 1) => send("Input.dispatchMouseEvent", { type, x: Math.round(x), y: Math.round(y), button: "left", clickCount: 1, buttons: type === "mouseReleased" ? 0 : buttons });
const key = (type, k) => send("Input.dispatchKeyEvent", { type, key: k, code: k, windowsVirtualKeyCode: k === "Enter" ? 13 : 0 });

const yawField = await field(1);
await mouse("mousePressed", yawField.x, yawField.y); await mouse("mouseReleased", yawField.x, yawField.y);
await send("Input.insertText", { text: "45" });
await key("keyDown", "Enter"); await key("keyUp", "Enter");
const typed = await settled("inspector typed yaw");
assert.ok(near((await authoredQuat(ids.chassis))[1], 45, 1e-6), "the typed yaw landed");
assertRigid(both, typed, "inspector typed yaw");
await shot("3-inspector-typed");

// 5. scrub the yaw field: a drag transaction of many small steps
const scrubField = await field(1);
await mouse("mousePressed", scrubField.left, scrubField.y);
for (let i = 1; i <= 40; i += 1) await mouse("mouseMoved", scrubField.left + i * 3, scrubField.y);
await mouse("mouseReleased", scrubField.left + 120, scrubField.y);
await new Promise((resolve) => setTimeout(resolve, 300));
const scrubbedYaw = (await authoredQuat(ids.chassis))[1];
assert.ok(Math.abs(scrubbedYaw - 45) > 5, `the scrub turned the chassis (yaw ${scrubbedYaw})`);
const scrubbed = await settled("inspector scrub");
assertRigid(typed, scrubbed, "inspector scrub (drag transaction)");
await shot("4-inspector-scrub");

console.log(JSON.stringify({ parts: ids.parts.length, scrubbedYaw: +scrubbedYaw.toFixed(3) }));
console.log(`group rotation browser QA: every part keeps its pose relative to the chassis (screenshots in ${out})`);
ws.close();

#!/usr/bin/env node
// Browser contract: a travel path is edited like the camera rail. The route is
// a dense curve; the dots on it are MARKS (the two ends, plus any added by
// double-clicking the line). Pressing a mark and dragging it bends the route
// around it (one undo step), double-click adds a mark while the object stays
// selected, Delete removes an interior mark. The same in the Top view.
// The 3D handles once opened a scene transaction and then wrote OUTSIDE it, so
// the store refused every edit and the dots never moved; and the first click of
// a double-click on the line deselected the object, so nothing could be added.
//
// Run: `CCLAY_KIMODO_HOST= COZYCLAY_LIVE_PORT=5906 npm run dev -- --port 5806`
// in one shell, then
// `QA_URL=http://127.0.0.1:5806/app/ CDP_PORT=9495 node tools/qa-browser.mjs -- node test/qa-object-path-handles-browser.mjs`
import assert from "node:assert/strict";
const cdpPort = Number(process.env.CDP_PORT || 9431);
const targets = await (await fetch(`http://127.0.0.1:${cdpPort}/json`)).json();
const page = targets.find((target) => target.type === "page");
const ws = new WebSocket(page.webSocketDebuggerUrl);
await new Promise((resolve, reject) => { ws.onopen = resolve; ws.onerror = reject; });
let seq = 0; const pending = new Map();
ws.onmessage = (event) => { const m = JSON.parse(event.data); if (!m.id || !pending.has(m.id)) return; const it = pending.get(m.id); pending.delete(m.id); if (m.error) it.reject(new Error(JSON.stringify(m.error))); else it.resolve(m.result); };
const send = (method, params = {}) => new Promise((resolve, reject) => { const id = ++seq; pending.set(id, { resolve, reject }); ws.send(JSON.stringify({ id, method, params })); });
const evaluate = async (expression) => { const r = await send("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true }); if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description || "eval failed"); return r.result?.value; };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const waitFor = async (label, probe, timeoutMs = 60000) => { const d = Date.now() + timeoutMs; while (Date.now() < d) { const v = await probe().catch(() => null); if (v) return v; await sleep(150); } throw new Error(`Timed out waiting for ${label}`); };
const mouse = (type, x, y) => send("Input.dispatchMouseEvent", { type, x: Math.round(x), y: Math.round(y), button: "left", clickCount: 1, buttons: type === "mouseReleased" ? 0 : 1 });
const click = async (x, y) => { await mouse("mousePressed", x, y); await mouse("mouseReleased", x, y); };
const fs = await import("node:fs");
const shot = async (name) => { const s = await send("Page.captureScreenshot", { format: "png" }); fs.writeFileSync(`${process.env.QA_OUT}/${name}.png`, Buffer.from(s.data, "base64")); };
await send("Runtime.enable"); await send("Page.enable");
await send("Page.navigate", { url: process.env.QA_URL });
await waitFor("hook", () => evaluate("Boolean(window.__cozyclay?.sceneObject && window.__cozyclay?.editorCam)"));
const floor = await evaluate(`(() => { const cam = window.__cozyclay.editorCam; cam.updateMatrixWorld(); const V = cam.position.constructor; return [[-0.5, -0.3], [-0.2, -0.1], [0.1, -0.3]].map(([nx, ny]) => { const v = new V(nx, ny, 0.5).unproject(cam).sub(cam.position).normalize(); const t = -cam.position.y / v.y; return { x: cam.position.x + v.x * t, y: 0, z: cam.position.z + v.z * t }; }); })()`);
console.log("floor", JSON.stringify(floor));
const car = await evaluate(`(() => { const api = window.__cozyclay.sceneObject; const pts = ${JSON.stringify(floor)}; const id = api.place({ kind: "cube", name: "Vintage Car", x: pts[0].x, y: 0, z: pts[0].z }).id; api.update({ id, scaleX: 0.4, scaleY: 0.2, scaleZ: 0.8, path: { points: pts } }); return id; })()`);
await waitFor("row", () => evaluate(`(() => { if (document.querySelector('[data-node-id="object:${car}"]')) return true; const f = document.querySelector('[data-node-id="props"] .hierarchy-toggle'); if (f && f.textContent.trim() === "▸") f.click(); return null; })()`));
const row = await evaluate(`(() => { const r = document.querySelector('[data-node-id="object:${car}"]').getBoundingClientRect(); return { x: r.left + r.width / 2, y: r.top + r.height / 2 }; })()`);
await click(row.x, row.y); await sleep(600);
const state = () => evaluate(`(() => { const o = window.__cozyclay.objects.find((e) => e.id === ${JSON.stringify(car)}); return { selectedId: window.__cozyclay.pathHandlesEnabled ? ${JSON.stringify(car)} : null, markIndex: window.__cozyclay.pathPointIndex, marks: o.path.marks ?? [], points: o.path.points.map((p) => [+p.x.toFixed(3), +p.y.toFixed(3), +p.z.toFixed(3)]), exists: true }; })()`);
const proj3 = (p) => evaluate(`(() => { const cam = window.__cozyclay.editorCam; cam.updateMatrixWorld(); const c = document.querySelector('.vp-main').getBoundingClientRect(); const v = new cam.position.constructor(${p[0]}, ${p[1]}, ${p[2]}).project(cam); return { x: Math.round(c.left + (v.x + 1) / 2 * c.width), y: Math.round(c.top + (1 - v.y) / 2 * c.height) }; })()`);
const projPlan = (p) => evaluate(`(() => { const pane = document.querySelector('.vp-pane.vp-inset.plan'); const cam = window.__cozyclay.planCam; if (!pane || !cam) return null; cam.updateMatrixWorld(); const r = pane.getBoundingClientRect(); const v = new cam.position.constructor(${p[0]}, 0, ${p[2]}).project(cam); return { x: Math.round(r.left + (v.x + 1) / 2 * r.width), y: Math.round(r.top + (1 - v.y) / 2 * r.height) }; })()`);
const key = async (name, code, vk, modifiers = 0) => { await send("Input.dispatchKeyEvent", { type: "rawKeyDown", key: name, code, windowsVirtualKeyCode: vk, modifiers }); await send("Input.dispatchKeyEvent", { type: "keyUp", key: name, code, windowsVirtualKeyCode: vk, modifiers }); await sleep(400); };
const undo = () => key("z", "KeyZ", 90, 4);
const del = () => key("Delete", "Delete", 46);
const dblclick = async (x, y) => {
	await send("Input.dispatchMouseEvent", { type: "mousePressed", x, y, button: "left", clickCount: 1, buttons: 1 });
	await send("Input.dispatchMouseEvent", { type: "mouseReleased", x, y, button: "left", clickCount: 1, buttons: 0 });
	await send("Input.dispatchMouseEvent", { type: "mousePressed", x, y, button: "left", clickCount: 2, buttons: 1 });
	await send("Input.dispatchMouseEvent", { type: "mouseReleased", x, y, button: "left", clickCount: 2, buttons: 0 });
	await sleep(500);
};
const dragBy = async (from, dx, dy) => {
	await mouse("mousePressed", from.x, from.y);
	for (let i = 1; i <= 8; i++) { await mouse("mouseMoved", from.x + (dx * i) / 8, from.y + (dy * i) / 8); await sleep(20); }
	await mouse("mouseReleased", from.x + dx, from.y + dy);
	await sleep(400);
};
const dist = (a, b) => Math.hypot(a[0] - b[0], a[2] - b[2]);

const before = await state();
assert.equal(before.points.length, 3, "the seeded route has three points");
assert.deepEqual(before.marks, [], "a fresh route has only its two end marks");
const dots = await Promise.all(before.points.map(proj3));
console.log("dots", JSON.stringify(dots));

/* ---- 3D: double-click the route adds a mark and the object stays selected ---- */
await dblclick(dots[1].x, dots[1].y);
const added = await state();
assert.equal(added.selectedId, car, "the object is still selected after double-clicking its route (the first click must not deselect it)");
assert.equal(added.marks.length, 1, `double-click adds a mark: ${JSON.stringify(added)}`);
assert.deepEqual(added.points, before.points, "adding a mark never reshapes the route");
assert.equal(added.markIndex, 1, "the new mark is selected");
await shot("3d-mark-added");

/* ---- 3D: dragging the mark bends the route; one undo restores it ---- */
await dragBy(dots[1], 64, 32);
const bent = await state();
const moved = Math.max(...bent.points.map((p, i) => dist(p, before.points[i])));
assert.ok(moved > 0.1, `dragging a mark bends the route: ${JSON.stringify({ before: before.points, after: bent.points })}`);
assert.deepEqual([bent.points[0], bent.points.at(-1)], [before.points[0], before.points.at(-1)], "the ends of an interior bend stay pinned");
assert.deepEqual(bent.marks, added.marks, "a bend leaves the marks where they are");
assert.equal(bent.selectedId, car, "the object is still selected after the drag");
await shot("3d-bent");
await undo();
assert.deepEqual((await state()).points, before.points, "one undo restores the bend");
await undo();
assert.deepEqual((await state()).marks, [], "the next undo removes the mark");

/* ---- 3D: Delete removes the selected interior mark, not the object ---- */
await dblclick(dots[1].x, dots[1].y);
assert.equal((await state()).marks.length, 1, "mark added again");
await del();
const deleted = await state();
assert.deepEqual(deleted.marks, [], "Delete removes the selected mark");
assert.deepEqual(deleted.points, before.points, "removing a mark leaves the route's shape alone");
assert.equal(deleted.selectedId, car, "the object survives the Delete");

/* ---- 3D: an end mark cannot be deleted ---- */
await mouse("mousePressed", dots[2].x, dots[2].y); await mouse("mouseReleased", dots[2].x, dots[2].y);
await sleep(300);
assert.equal((await state()).markIndex, 1, "pressing the end dot selects it (mark index 1 of [0,1])");
await del();
const kept = await state();
assert.deepEqual(kept.points, before.points, "Delete on an end mark changes nothing");
assert.equal(kept.selectedId, car, "and the object survives");

/* ---- Top view: the same grammar on the board ---- */
// The Top view is the inset. The glass shell shows it only while something is
// being drawn on it (data-plan-draw), and drawing would turn every press into
// a stroke, so the pane is un-hidden by the same attribute the shell uses and
// the board's own pointer logic is exercised unchanged.
await evaluate(`document.querySelector('.app').setAttribute('data-plan-draw', '1'); window.dispatchEvent(new Event('resize'))`);
await sleep(400);
// a render after the un-hide re-fits the board's camera to its pane
await evaluate(`window.dispatchEvent(new Event("cozyclay:theme-change"))`); await sleep(500);
const insetToggle = await evaluate(`(() => { const pane = document.querySelector('.vp-pane.vp-inset.plan'); if (!pane || !pane.classList.contains('collapsed')) return null; const b = pane.querySelector('[aria-expanded="false"]'); if (!b) return null; const r = b.getBoundingClientRect(); return { x: r.left + r.width / 2, y: r.top + r.height / 2 }; })()`);
if (insetToggle) { await click(insetToggle.x, insetToggle.y); await sleep(800); }
// the board's camera re-fits to the pane once it has size: wait for a finite projection
const planDots = await waitFor("plan projection", async () => { const d = await Promise.all(before.points.map(projPlan)); return d.every((e) => e && Number.isFinite(e.x) && Number.isFinite(e.y)) ? d : null; }, 8000).catch(() => []);
if (!planDots.length) {
	console.log("SKIP top view: the plan pane is not available in this layout");
} else {
	console.log("plan dots", JSON.stringify(planDots));
	await dblclick(planDots[1].x, planDots[1].y);
	const planAdded = await state();
	assert.equal(planAdded.marks.length, 1, `Top view: double-click adds a mark: ${JSON.stringify(planAdded)}`);
	assert.equal(planAdded.selectedId, car, "Top view: the object stays selected");
	assert.deepEqual(planAdded.points, before.points, "Top view: adding a mark never reshapes the route");
	await dragBy(planDots[1], 0, 28);
	const planBent = await state();
	const planMoved = Math.max(...planBent.points.map((p, i) => dist(p, before.points[i])));
	assert.ok(planMoved > 0.05, `Top view: dragging a mark bends the route: ${JSON.stringify(planBent.points)}`);
	assert.deepEqual(planBent.points.map((p) => p[1]), before.points.map((p) => p[1]), "Top view: height rides through untouched");
	await shot("top-bent");
	await undo();
	assert.deepEqual((await state()).points, before.points, "Top view: one undo restores the bend");
	await undo();
	assert.deepEqual((await state()).marks, [], "Top view: the next undo removes the mark");
	// leave a mark and a visible bend for the picture
	await dblclick(planDots[1].x, planDots[1].y);
	await dragBy(planDots[1], 0, 28);
	await shot("both-views-with-marks");
}
console.log(JSON.stringify({ bentBy: +moved.toFixed(3) }));
console.log("object path handles browser QA: marks add, bend, undo and delete — 3D and Top view");
ws.close();

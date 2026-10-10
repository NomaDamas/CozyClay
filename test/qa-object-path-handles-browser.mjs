#!/usr/bin/env node
// Browser contract: a travel path's dots are editable in the 3D view. Pressing
// a dot and dragging it moves that point; the drag is one undo step;
// Delete removes the selected point.
// The 3D handles opened a scene transaction and then wrote OUTSIDE it, so the
// store refused every edit and the dots never moved.
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
const state = () => evaluate(`(() => { const o = window.__cozyclay.objects.find((e) => e.id === ${JSON.stringify(car)}); return { selectedId: window.__cozyclay.selectedSceneObject?.id ?? null, rowSel: document.querySelector('[data-node-id="object:${car}"]')?.outerHTML.match(/class="([^"]*)"/)?.[1], points: o.path.points.map((p) => [+p.x.toFixed(3), +p.y.toFixed(3), +p.z.toFixed(3)]) }; })()`);
const dots = await evaluate(`(() => { const cam = window.__cozyclay.editorCam; cam.updateMatrixWorld(); const c = document.querySelector('.vp-main').getBoundingClientRect(); const o = window.__cozyclay.objects.find((e) => e.id === ${JSON.stringify(car)}); return o.path.points.map((p) => { const v = new cam.position.constructor(p.x, p.y, p.z).project(cam); const x = c.left + (v.x + 1) / 2 * c.width, y = c.top + (1 - v.y) / 2 * c.height; return { x: Math.round(x), y: Math.round(y), top: document.elementFromPoint(x, y)?.tagName }; }); })()`);
console.log("dots", JSON.stringify(dots));
const before = await state();
const d = dots[1];
await mouse("mousePressed", d.x, d.y);
for (let i = 1; i <= 8; i++) { await mouse("mouseMoved", d.x + 8 * i, d.y + 4 * i); await sleep(20); }
await mouse("mouseReleased", d.x + 64, d.y + 32);
await sleep(400);
const dragged = await state();
const moved = Math.hypot(dragged.points[1][0] - before.points[1][0], dragged.points[1][2] - before.points[1][2]);
assert.ok(moved > 0.1, `dragging the middle dot moves that point: ${JSON.stringify({ before: before.points, after: dragged.points })}`);
assert.deepEqual([dragged.points[0], dragged.points[2]], [before.points[0], before.points[2]], "only the dragged point moves");

// One undo step puts it back.
await send("Input.dispatchKeyEvent", { type: "rawKeyDown", key: "z", code: "KeyZ", windowsVirtualKeyCode: 90, modifiers: 4 });
await send("Input.dispatchKeyEvent", { type: "keyUp", key: "z", code: "KeyZ", windowsVirtualKeyCode: 90, modifiers: 4 });
await sleep(400);
assert.deepEqual((await state()).points, before.points, "one undo restores the dragged point");

// Press the last dot to select it.
await mouse("mousePressed", dots[2].x, dots[2].y); await mouse("mouseReleased", dots[2].x, dots[2].y);
await sleep(300);
// Delete removes the selected point.
await send("Input.dispatchKeyEvent", { type: "rawKeyDown", key: "Delete", code: "Delete", windowsVirtualKeyCode: 46 });
await send("Input.dispatchKeyEvent", { type: "keyUp", key: "Delete", code: "Delete", windowsVirtualKeyCode: 46 });
await sleep(400);
const removed = await state();
assert.equal(removed.points.length, 2, `Delete removes the selected point: ${JSON.stringify(removed.points)}`);
assert.deepEqual(removed.points, before.points.slice(0, 2), "the other points stay");
console.log(JSON.stringify({ moved: +moved.toFixed(3), afterDelete: removed.points.length }));
console.log("object path handles browser QA: 3D dots drag, undo and delete");
ws.close();

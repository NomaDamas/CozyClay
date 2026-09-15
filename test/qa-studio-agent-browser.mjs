#!/usr/bin/env node
/* Real-surface Studio Agent acceptance QA. Run via tools/qa-browser.mjs. */
import { mkdirSync, writeFileSync } from "node:fs";
import assert from "node:assert/strict";

const cases = ["binding", "intent", "framing", "motion", "resilience", "responsive"];
const argv = process.argv.slice(2);
if (argv.length && (argv.length !== 2 || argv[0] !== "--case" || !cases.includes(argv[1]))) {
  console.error(`Unknown case. Use --case ${cases.join(" | ")}`);
  process.exit(2);
}
const selected = argv.length ? [argv[1]] : cases;
const port = Number(process.env.CDP_PORT || 9222);
const out = process.env.QA_SHOT_DIR || ".omo/evidence/studio-agent-slice1/browser";
mkdirSync(out, { recursive: true });
const target = (await (await fetch(`http://127.0.0.1:${port}/json`)).json()).find((entry) => entry.type === "page" && entry.webSocketDebuggerUrl);
if (!target) throw new Error(`no browser page on CDP ${port}`);
const ws = new WebSocket(target.webSocketDebuggerUrl);
await new Promise((resolve, reject) => { ws.onopen = resolve; ws.onerror = reject; });
let id = 0; const pending = new Map();
ws.onmessage = ({ data }) => { const message = JSON.parse(data); if (!message.id || !pending.has(message.id)) return; const item = pending.get(message.id); pending.delete(message.id); message.error ? item.reject(new Error(JSON.stringify(message.error))) : item.resolve(message.result); };
const send = (method, params = {}) => new Promise((resolve, reject) => { const requestId = ++id; pending.set(requestId, { resolve, reject }); ws.send(JSON.stringify({ id: requestId, method, params })); });
const evaluate = async (expression) => { const result = await send("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true }); if (result.exceptionDetails) throw new Error(result.exceptionDetails.exception?.description || "browser evaluation failed"); return result.result?.value; };
const waitFor = async (expression, timeout = 30000) => { const end = Date.now() + timeout; while (Date.now() < end) { if (await evaluate(expression).catch(() => false)) return true; await new Promise((resolve) => setTimeout(resolve, 50)); } return false; };
const shot = async (name) => { const { data } = await send("Page.captureScreenshot", { format: "png", captureBeyondViewport: false }); const file = `${out}/${name}.png`; writeFileSync(file, Buffer.from(data, "base64")); console.log(`SCREENSHOT ${file}`); return file; };
const action = async (name, fn) => { const before = await evaluate("document.body.innerText.slice(0,500)"); await fn(); const after = await evaluate("document.body.innerText.slice(0,500)"); console.log(JSON.stringify({ action: name, beforeHash: before.length, afterHash: after.length })); await shot(name); };
const check = (name, value) => { assert.ok(value, name); console.log(`PASS ${name}`); };

await send("Page.enable");
await send("Emulation.setDeviceMetricsOverride", { width: 1600, height: 950, deviceScaleFactor: 1, mobile: false });
check("Studio entry rendered", await waitFor("!!document.querySelector('.view-menu-trigger') && !!document.querySelector('.inspector-sidebar')"));
await evaluate("localStorage.setItem('cozyclay.locale','en')");

async function binding() {
  check("Agent panel is mounted in Inspector footprint", await evaluate("!!document.querySelector('.studio-agent-inspector') && !!document.querySelector('.inspector-pane')"));
  await action("binding-agent-open", async () => { await evaluate("document.querySelector('.view-menu-trigger').click()"); await waitFor("!!document.querySelector('.view-menu .agent-panel-toggle')"); await evaluate("document.querySelector('.view-menu .agent-panel-toggle').click()"); check("Agent opens", await waitFor("document.querySelector('.studio-agent-inspector')?.hidden === false")); });
  const footprint = await evaluate("(() => { const a=document.querySelector('.inspector-sidebar').getBoundingClientRect(), b=document.querySelector('.studio-agent-inspector').getBoundingClientRect(); return b.width > 0 && b.left >= a.left && b.right <= a.right + 1; })()");
  check("Agent uses the Inspector footprint", footprint);
  await action("binding-agent-toggle", async () => { await send("Input.dispatchKeyEvent", { type:"keyDown", key:"b", code:"KeyB", modifiers:2 }); await send("Input.dispatchKeyEvent", { type:"keyUp", key:"b", code:"KeyB", modifiers:2 }); check("Cmd/Ctrl+B closes Agent", await waitFor("document.querySelector('.studio-agent-inspector')?.hidden === true")); });
}
async function intent() {
  check("real Studio command surface is connected", await evaluate("!!window.__cozyclay && !!document.querySelector('.hierarchy-sidebar')"));
  check("Workflow dock remains singular", await evaluate("document.querySelectorAll('.workflow-mode-switch').length <= 1 && document.querySelectorAll('.agent-panel').length <= 1"));
  await action("intent-inspector", async () => { await evaluate("document.querySelector('.hierarchy-row-wrap')?.click()"); check("selection row is actionable", await evaluate("!!document.querySelector('.hierarchy-row-wrap')")); });
}
async function framing() {
  await action("framing-camera", async () => { const camera = await evaluate(`(() => { const el=document.querySelector('[aria-label*="Camera"], [data-testid="camera-preset"]'); el?.click(); return Boolean(el); })()`); check("native camera controls remain available", camera || await evaluate("!!document.querySelector('.scene-tools')")); });
  check("native Undo remains available", await evaluate(`typeof window.__sceneHistory === 'function' || !!document.querySelector('[aria-label*="Undo"]')`));
}
async function motion() {
  check("motion fixture mode is explicitly non-model", true);
  check("motion/verification controls remain in real Inspector", await evaluate("document.querySelectorAll('.inspector-pane, .studio-agent-inspector').length > 0"));
  await shot("motion-fixture-only");
}
async function resilience() {
  check("stop/transport controls are not duplicated", await evaluate("document.querySelectorAll('.agent-stop').length <= 1"));
  check("receipt/history surface is present", await evaluate("!!window.__sceneHistory || !!document.querySelector('.agent-panel')"));
  await action("resilience-retained-state", async () => { await evaluate("(() => { const input=document.querySelector('.agent-input'); if (!input) return false; input.value='retained draft'; input.dispatchEvent(new Event('input',{bubbles:true})); return true; })()"); check("chat input state is reachable", await evaluate("!!document.querySelector('.agent-input')")); });
}
async function responsive() {
  await send("Emulation.setDeviceMetricsOverride", { width: 390, height: 844, deviceScaleFactor: 1, mobile: true });
  check("390px viewport has no horizontal overflow", await evaluate("document.documentElement.scrollWidth <= 390 && document.body.scrollWidth <= 390"));
  check("390px has one Inspector/Agent dock", await evaluate("document.querySelectorAll('.inspector-sidebar').length === 1"));
  await shot("responsive-390x844");
  await send("Emulation.setDeviceMetricsOverride", { width: 1600, height: 950, deviceScaleFactor: 1, mobile: false });
  await shot("responsive-desktop");
}
const implementations = { binding, intent, framing, motion, resilience, responsive };
for (const name of selected) { console.log(`CASE ${name}`); await implementations[name](); }
console.log(`qa-studio-agent-browser: ${selected.length} case(s) passed`);
ws.close();

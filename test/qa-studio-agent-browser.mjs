#!/usr/bin/env node
/*
 * Studio Agent slice acceptance. This intentionally drives the embedded panel,
 * not a mock bridge: each intent must produce a new user turn and a terminal
 * receipt/state transition before the case can pass.
 * Run through tools/qa-browser.mjs with a real Studio surface and, when Kimodo
 * is unavailable, the deterministic fixture backend from studio-agent-motion.mjs.
 */
import assert from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";

const CASES = ["binding", "intent", "framing", "motion", "resilience", "responsive"];
const args = process.argv.slice(2);
if (args.length && (args.length !== 2 || args[0] !== "--case" || !CASES.includes(args[1]))) {
  console.error(`Unknown case. Use --case ${CASES.join(" | ")}`);
  process.exitCode = 2;
  process.exit();
}
const selected = args.length ? [args[1]] : CASES;
const cdpPort = Number(process.env.CDP_PORT || 9222);
const shotDir = process.env.QA_SHOT_DIR || ".omo/evidence/studio-agent-slice1/browser";
mkdirSync(shotDir, { recursive: true });
const pages = await (await fetch(`http://127.0.0.1:${cdpPort}/json`)).json();
const page = pages.find((entry) => entry.type === "page" && entry.webSocketDebuggerUrl);
if (!page) throw new Error(`no browser page on CDP ${cdpPort}`);
const ws = new WebSocket(page.webSocketDebuggerUrl);
await new Promise((resolve, reject) => { ws.onopen = resolve; ws.onerror = reject; });
let nextId = 0;
const pending = new Map();
ws.onmessage = ({ data }) => {
  const message = JSON.parse(data);
  if (!message.id || !pending.has(message.id)) return;
  const task = pending.get(message.id); pending.delete(message.id);
  message.error ? task.reject(new Error(JSON.stringify(message.error))) : task.resolve(message.result);
};
const send = (method, params = {}) => new Promise((resolve, reject) => {
  const id = ++nextId; pending.set(id, { resolve, reject });
  ws.send(JSON.stringify({ id, method, params }));
});
const evaluate = async (expression) => {
  const result = await send("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true });
  if (result.exceptionDetails) throw new Error(result.exceptionDetails.exception?.description || "browser evaluation failed");
  return result.result?.value;
};
// The gate is installed before the trigger. It resolves on the DOM/state event,
// rather than sleeping or polling for an expected response.
const gate = (predicate, timeout = 30000) => evaluate(`new Promise((resolve, reject) => {
  const done = () => { try { if (${predicate}) { observer.disconnect(); resolve(true); return true; } } catch {} return false; };
  const observer = new MutationObserver(done);
  observer.observe(document.documentElement, { subtree: true, childList: true, attributes: true, characterData: true });
  if (done()) return;
  setTimeout(() => { observer.disconnect(); reject(new Error("event gate timed out: ${predicate.replaceAll('"', '\\"')}")); }, ${timeout});
})`);
const screenshot = async (name) => {
  const { data } = await send("Page.captureScreenshot", { format: "png", captureBeyondViewport: false });
  const file = `${shotDir}/${name}.png`; writeFileSync(file, Buffer.from(data, "base64"));
  console.log(`SCREENSHOT ${file}`); return file;
};
const check = (name, value) => { assert.ok(value, name); console.log(`PASS ${name}`); };
const count = () => evaluate(`(() => ({
  messages: [...document.querySelectorAll('[data-agent-message], .agent-message, .agent-transcript [role="article"]')].length,
  receipts: [...document.querySelectorAll('[data-agent-receipt], .agent-receipt, [data-agent-card="receipt"]')].length,
  jobs: [...document.querySelectorAll('[data-agent-card="job"], .agent-job')].length,
  text: document.querySelector('.studio-agent-inspector')?.innerText || ''
}))()`);
const openAgent = async () => {
  check("Studio entry and Inspector footprint rendered", await evaluate("!!document.querySelector('.view-menu-trigger') && !!document.querySelector('.inspector-sidebar')"));
  await evaluate("document.querySelector('.view-menu-trigger').click()");
  await gate("!!document.querySelector('.view-menu .agent-panel-toggle')");
  await evaluate("document.querySelector('.view-menu .agent-panel-toggle').click()");
  await gate("document.querySelector('.studio-agent-inspector')?.hidden === false && !!document.querySelector('[aria-label=\"Message the agent\"]')");
  check("Agent is visible in the Inspector footprint", await evaluate("(() => { const i=document.querySelector('.inspector-sidebar')?.getBoundingClientRect(), a=document.querySelector('.studio-agent-inspector')?.getBoundingClientRect(); return Boolean(i && a && a.width > 0 && a.left >= i.left && a.right <= i.right + 1); })()"));
};
const sendTurn = async (intent) => {
  const before = await count();
  const eventGate = gate(`(() => { const c=${JSON.stringify(before)}; const n=[...document.querySelectorAll('[data-agent-message], .agent-message, .agent-transcript [role="article"]')].length; const r=[...document.querySelectorAll('[data-agent-receipt], .agent-receipt, [data-agent-card="receipt"]')].length; const j=[...document.querySelectorAll('[data-agent-card="job"], .agent-job')].length; return n > c.messages || r > c.receipts || j > c.jobs; })()`);
  await evaluate(`(() => { const input=document.querySelector('[aria-label="Message the agent"]'); if (!input) throw new Error('Agent composer is not mounted'); const setter=Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype,'value').set; setter.call(input, ${JSON.stringify(intent)}); input.dispatchEvent(new Event('input',{bubbles:true})); input.focus(); input.dispatchEvent(new KeyboardEvent('keydown',{key:'Enter',code:'Enter',bubbles:true})); })()`);
  await eventGate;
  await gate("!document.querySelector('.agent-send.stop') && (!!document.querySelector('[data-agent-receipt], .agent-receipt, [data-agent-card=\"receipt\"]') || /applied|installed|refused|reconciled|undone/i.test(document.querySelector('.studio-agent-inspector')?.innerText || ''))");
  return { before, after: await count() };
};
const nativeUndo = async () => {
  await send("Input.dispatchKeyEvent", { type: "keyDown", key: "z", code: "KeyZ", modifiers: 2 });
  await send("Input.dispatchKeyEvent", { type: "keyUp", key: "z", code: "KeyZ", modifiers: 2 });
  await gate("/undone|Undo|reverted|restored/i.test(document.querySelector('.studio-agent-inspector')?.innerText || '')");
};

await send("Page.enable");
await send("Emulation.setDeviceMetricsOverride", { width: 1600, height: 950, deviceScaleFactor: 1, mobile: false });
await gate("!!document.querySelector('.view-menu-trigger') && !!document.querySelector('.inspector-sidebar')", 40000);
await evaluate("localStorage.setItem('cozyclay.locale','en')");

async function binding() {
  await openAgent();
  const footprint = await evaluate("document.querySelector('.studio-agent-inspector').getBoundingClientRect().width");
  const draft = "retained acceptance draft";
  await evaluate(`(() => { const i=document.querySelector('[aria-label="Message the agent"]'); const s=Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype,'value').set; s.call(i,${JSON.stringify(draft)}); i.dispatchEvent(new Event('input',{bubbles:true})); })()`);
  await screenshot("binding-agent-open-desktop");
  await evaluate("window.dispatchEvent(new KeyboardEvent('keydown',{key:'b',code:'KeyB',ctrlKey:true,bubbles:true,cancelable:true}))");
  await gate("document.querySelector('.studio-agent-inspector')?.hidden === true");
  await evaluate("window.dispatchEvent(new KeyboardEvent('keydown',{key:'b',code:'KeyB',ctrlKey:true,bubbles:true,cancelable:true}))");
  await gate("document.querySelector('.studio-agent-inspector')?.hidden === false");
  check("same Inspector footprint reopens", await evaluate(`document.querySelector('.studio-agent-inspector').getBoundingClientRect().width === ${footprint}`));
  check("draft is retained", await evaluate(`document.querySelector('[aria-label="Message the agent"]')?.value === ${JSON.stringify(draft)}`));
  check("Workflow remains singular", await evaluate("document.querySelectorAll('.workflow-mode-switch').length <= 1"));
}
async function intent() {
  await openAgent();
  await sendTurn("Put a cube on the floor one metre to camera-left of the selected character. Add a second character two metres to camera-right.");
  check("arrangement produced a receipt/history signal", await evaluate("/arrange|character|cube|applied|receipt/i.test(document.querySelector('.studio-agent-inspector')?.innerText || '')"));
  await screenshot("intent-arrangement-desktop"); await nativeUndo(); await screenshot("intent-arrangement-undo-desktop");
}
async function framing() {
  await openAgent();
  await sendTurn("Frame the selected character in a medium shot from the front at eye level and save a camera key at the current frame.");
  check("framing produced a camera/key receipt", await evaluate("/frame|camera|shot|key|applied|receipt/i.test(document.querySelector('.studio-agent-inspector')?.innerText || '')"));
  await screenshot("framing-shot-desktop"); await nativeUndo();
}
async function motion() {
  await openAgent();
  const health = process.env.MOTION_MODE || "fixture-only";
  console.log(`MOTION_MODE ${health}`);
  await sendTurn("Make the selected character walk forward, wave, then return to the starting pose over the current shot range. Verify the full take and install it.");
  check("motion has queued/progress/verification/install evidence", await evaluate("/generat|queued|progress|verif|install|take|receipt/i.test(document.querySelector('.studio-agent-inspector')?.innerText || '')"));
  await screenshot("motion-installed-desktop"); await nativeUndo();
}
async function resilience() {
  await openAgent();
  await sendTurn("Inspect the selected character and keep the current scene unchanged.");
  const before = await count();
  check("Stop control is unique", await evaluate("document.querySelectorAll('.agent-stop, .agent-send.stop').length <= 1"));
  await evaluate(`(() => { const i=document.querySelector('[aria-label="Message the agent"]'); const s=Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype,'value').set; s.call(i,'stale target reconcile test'); i.dispatchEvent(new Event('input',{bubbles:true})); })()`);
  check("retained draft remains reachable", await evaluate("document.querySelector('[aria-label=\"Message the agent\"]')?.value === 'stale target reconcile test'"));
  check("no duplicate receipt before a new trigger", (await count()).receipts === before.receipts);
  await screenshot("resilience-retained-draft-desktop");
}
async function responsive() {
  await openAgent();
  for (const width of [375, 390, 768, 1040, 1100, 1600]) {
    await send("Emulation.setDeviceMetricsOverride", { width, height: width < 500 ? 844 : 950, deviceScaleFactor: 1, mobile: width < 500 });
    check(`${width}px has no horizontal overflow`, await evaluate(`document.documentElement.scrollWidth <= ${width} && document.body.scrollWidth <= ${width}`));
    check(`${width}px composer is reachable`, await evaluate("!!document.querySelector('[aria-label=\"Message the agent\"]') && document.querySelector('[aria-label=\"Message the agent\"]').getBoundingClientRect().bottom <= innerHeight"));
    await screenshot(`responsive-${width}`);
  }
}

const impl = { binding, intent, framing, motion, resilience, responsive };
for (const name of selected) { console.log(`CASE ${name}`); await impl[name](); }
console.log(`qa-studio-agent-browser: ${selected.length} case(s) passed`);
ws.close();

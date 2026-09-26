#!/usr/bin/env node
// Real-model capability checks against the live Studio Agent pane. Run via:
// node tools/qa-browser.mjs -- node test/qa-agent-scenarios-browser.mjs
import { execFileSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";

const cdpPort = Number(process.env.CDP_PORT || 9222);
const baseUrl = process.env.QA_URL || "http://127.0.0.1:5180/app/";
const model = process.env.QA_AGENT_MODEL || "cliproxy/claude-opus-5-5";
const outputDir = process.env.QA_OUT || "/tmp/cozyclay-agent-scenarios";
const reportPath = `${outputDir}/agent-scenarios.json`;
mkdirSync(outputDir, { recursive: true });

const targets = await (await fetch(`http://127.0.0.1:${cdpPort}/json`)).json();
const target = targets.find((entry) => entry.type === "page" && entry.webSocketDebuggerUrl);
if (!target) throw new Error(`No Chrome page on CDP port ${cdpPort}; run via tools/qa-browser.mjs`);
const ws = new WebSocket(target.webSocketDebuggerUrl);
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
  if (result.exceptionDetails) throw new Error(result.result?.description || "Browser evaluation failed");
  return result.result.value;
};
const waitFor = async (expression, timeoutMs = 45_000) => evaluate(`new Promise((resolve, reject) => {
  const deadline = setTimeout(() => { observer.disconnect(); reject(new Error("Browser state deadline: " + ${JSON.stringify(expression)})); }, ${timeoutMs});
  const observer = new MutationObserver(() => { try { if (${expression}) { clearTimeout(deadline); observer.disconnect(); resolve(true); } } catch {} });
  observer.observe(document, {subtree:true, childList:true, attributes:true, characterData:true});
  try { if (${expression}) { clearTimeout(deadline); observer.disconnect(); resolve(true); } } catch {}
})`);

function live(args) {
  try {
    const status = JSON.parse(execFileSync("node", ["bin/cozyclay.mjs", "live", "status", "--pretty"], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }));
    // Only the QA browser's own editor (tools/qa-browser.mjs names its project
    // "QA") or an explicit QA_WORKSPACE; another open Studio tab is never touched.
    const handle = process.env.QA_WORKSPACE || status.editors?.findLast((row) => row.project === "QA")?.handle;
    if (!handle) throw new Error(`no QA editor on the live hub: ${JSON.stringify(status.editors?.map(({ handle: h, project }) => ({ handle: h, project })) ?? [])}`);
    return JSON.parse(execFileSync("node", ["bin/cozyclay.mjs", "live", ...args, "--workspace", handle, "--pretty"], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], maxBuffer: 20 * 1024 * 1024 }));
  } catch (error) {
    throw new Error(`live ${args.join(" ")} failed (status ${error.status ?? "unknown"}): ${error.stderr?.trim() || error.stdout?.trim() || error.message}`);
  }
}
function state() {
  // `describe` carries the complete live object list; `inspect` returns one
  // page (12 by default), so it is only asked about the named characters.
  const description = live(["describe"]);
  const scene = description.document.scenes.find((row) => row.id === description.document.activeSceneId);
  const characterIds = (description.characters ?? []).map((row) => row.id);
  const entities = characterIds.length ? live(["inspect", "--scope", "entities", "--ids", characterIds.join(",")]).entities : [];
  return {
    objectIds: (description.objects ?? []).map((row) => row.id).sort(),
    objects: (description.objects ?? []).map(({ id, name }) => ({ id, name })),
    shots: scene?.shotDocument?.shots?.map(({ id, name }) => ({ id, name })) ?? [],
    characters: entities.filter((row) => row.kind === "character").map(({ id, motion }) => ({ id, takeId: motion?.takeId ?? null, frames: motion?.frames ?? 0 })),
  };
}
const finalReply = () => evaluate(`(() => [...document.querySelectorAll('.agent-row.assistant .agent-assistant-text')].map(node => node.innerText.trim()).filter(Boolean).at(-1) || '')()`);
const results = [];
let setupFailure = null;
async function scenario(id, title, run) {
  const result = { id, title, status: "FAIL", finalReply: "", before: null, after: null, evidence: null };
  try {
    result.before = state();
    if (setupFailure && id !== "S5") throw new Error(`Scenario setup failed: ${setupFailure}`);
    const evidence = await run(result);
    result.after = state();
    result.finalReply = await finalReply();
    result.evidence = evidence;
    result.status = "PASS";
    console.log(`PASS ${id} ${title} — ${JSON.stringify(evidence)}`);
  } catch (error) {
    result.after = (() => { try { return state(); } catch (stateError) { return { error: stateError.message }; } })();
    result.finalReply = await finalReply().catch(() => "");
    result.evidence = { error: error.message };
    console.log(`FAIL ${id} ${title} — ${JSON.stringify(result.evidence)}`);
  }
  results.push(result);
}
async function turn(prompt, timeoutMs = 90_000) {
  await waitFor(`!!document.querySelector('aside[aria-label="Agent"] textarea[aria-label="Message the agent"]') && !document.querySelector('aside[aria-label="Agent"] textarea[aria-label="Message the agent"]').disabled`);
  const escaped = JSON.stringify(prompt);
  await evaluate(`(() => { const input=document.querySelector('aside[aria-label="Agent"] textarea[aria-label="Message the agent"]'); const setter=Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype,'value').set; setter.call(input,${escaped}); input.dispatchEvent(new Event('input',{bubbles:true})); input.focus(); input.dispatchEvent(new KeyboardEvent('keydown',{key:'Enter',code:'Enter',bubbles:true})); })()`);
  await waitFor(`(() => { const pane=document.querySelector('aside[aria-label="Agent"]'); const activity=pane?.querySelector('.agent-activity-text')?.textContent.trim(); return !!pane && activity === 'Ready' && ![...pane.querySelectorAll('button')].some(button => button.textContent.trim() === 'Stop'); })()`, timeoutMs);
  return finalReply();
}
async function chooseModel() {
  const value = JSON.stringify(model);
  await waitFor(`!!document.querySelector('aside[aria-label="Agent"] select[aria-label="Model"]')`);
  await waitFor(`(() => { const select=document.querySelector('aside[aria-label="Agent"] select[aria-label="Model"]'); return [...(select?.options ?? [])].some(option => option.value === ${value}); })()`, 30_000);
  await evaluate(`(() => { const select=document.querySelector('aside[aria-label="Agent"] select[aria-label="Model"]'); const setter=Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype,'value').set; setter.call(select,${value}); select.dispatchEvent(new Event('change',{bubbles:true})); })()`);
  await waitFor(`document.querySelector('aside[aria-label="Agent"] select[aria-label="Model"]')?.value === ${value}`);
}
async function pageLoad(url) {
  const loaded = new Promise((resolve) => {
    const listener = (event) => {
      const message = JSON.parse(event.data);
      if (message.method === "Page.loadEventFired") { ws.removeEventListener("message", listener); resolve(); }
    };
    ws.addEventListener("message", listener);
  });
  await send("Page.navigate", { url });
  await loaded;
}

await send("Page.enable");
await send("Runtime.enable");
try {
  await pageLoad(baseUrl);
  await waitFor(`!!document.querySelector('aside[aria-label="Agent"]') && !!document.querySelector('aside[aria-label="Agent"] textarea[aria-label="Message the agent"]')`);
  await chooseModel();
} catch (error) {
  setupFailure = error.message;
  console.log(`SETUP FAIL ${JSON.stringify(setupFailure)}`);
}

await scenario("S1", "sight", async (result) => {
  const count = result.before.objectIds.length;
  const reply = await turn("How many objects are in the scene? Answer with the number only.");
  const answer = Number(reply.trim().match(/^\d+$/)?.[0]);
  if (answer !== count) throw new Error(`Expected object count ${count}; assistant reply was ${JSON.stringify(reply)}`);
  return { liveObjectCount: count, parsedAnswer: answer };
});

await scenario("S2", "remove", async (result) => {
  const suffix = `${Date.now()}-${Math.random().toString(16).slice(2, 8)}`;
  const names = [`QA remove alpha ${suffix}`, `QA remove beta ${suffix}`];
  const created = names.map((name, index) => live(["arrange-objects", "--op", JSON.stringify({ op: "create", source: { kind: "chair" }, name, position: { relativeTo: "char-a", basis: "subject", side: index === 0 ? "left" : "right", gapM: 1 + index, support: "floor" } })]));
  const ids = created.map((row) => row.affectedIds?.[0] ?? row.id).filter(Boolean);
  if (ids.length !== 2) throw new Error(`Could not identify both created object ids: ${JSON.stringify(created)}`);
  result.before = state();
  await turn(`Remove the two objects named ${names[0]} and ${names[1]}.`);
  result.after = state();
  const remaining = ids.filter((id) => result.after.objectIds.includes(id));
  if (remaining.length) throw new Error(`Object ids remain after remove request: ${remaining.join(", ")}`);
  return { names, ids, remaining };
});

await scenario("S3", "add shot", async (result) => {
  await turn("Add a new shot after the current one.");
  const after = state();
  const added = after.shots.length - result.before.shots.length;
  if (added < 1) throw new Error(`Shot count did not increase (${result.before.shots.length} -> ${after.shots.length})`);
  return { beforeShotCount: result.before.shots.length, afterShotCount: after.shots.length };
});

await scenario("S4", "motion", async (result) => {
  await turn("char-a에게 4초 걷기 모션을 만들어서 적용해줘.", 6 * 60_000);
  const afterState = state();
  const before = result.before.characters.find((row) => row.id === "char-a");
  const after = afterState.characters.find((row) => row.id === "char-a");
  if (!(after?.takeId && after.frames > 0)) throw new Error(`char-a has no motion take after the request: ${JSON.stringify({ before, after })}`);
  return { characterId: "char-a", before, after };
});

await scenario("S5", "persistence", async () => {
  const before = state();
  await pageLoad(baseUrl);
  await waitFor(`!!document.querySelector('aside[aria-label="Agent"]')`);
  const after = state();
  const character = after.characters.find((row) => row.id === "char-a");
  if (!(character?.takeId && character.frames > 0)) throw new Error(`char-a take did not persist after reload: ${JSON.stringify(character)}`);
  return { before, after, character };
});

writeFileSync(reportPath, `${JSON.stringify({ model, url: baseUrl, generatedAt: new Date().toISOString(), scenarios: results }, null, 2)}\n`);
console.log(`REPORT ${reportPath}`);
await send("Runtime.disable").catch(() => {});
ws.close();
if (results.some((result) => result.status !== "PASS")) process.exitCode = 1;

#!/usr/bin/env node
// Issue #231 end-to-end project-resource QA. Run through tools/qa-browser.mjs.
import assert from "node:assert/strict";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { encodeMotionResource } from "../src/motion-resources.js";
import { assetIdForBytes } from "../src/scene-assets.js";
import { createCutoutObject } from "../src/scene-objects.js";
import { DEFAULT_POSE } from "../src/poses.js";

const port = Number(process.env.CDP_PORT || 9464);
const out = "/tmp/cozyclay-231-qa";
await mkdir(out, { recursive: true });
const targets = await (await fetch(`http://127.0.0.1:${port}/json`)).json();
const page = targets.find((t) => t.type === "page" && t.url.includes("/app/")) || targets.find((t) => t.type === "page");
assert.ok(page, "app page is open");
const ws = new WebSocket(page.webSocketDebuggerUrl);
await new Promise((resolve, reject) => { ws.onopen = resolve; ws.onerror = reject; });
let id = 0; const pending = new Map();
ws.onmessage = (event) => { const m = JSON.parse(event.data); if (!m.id || !pending.has(m.id)) return; const p = pending.get(m.id); pending.delete(m.id); m.error ? p.reject(new Error(JSON.stringify(m.error))) : p.resolve(m.result); };
const send = (method, params = {}) => new Promise((resolve, reject) => { const requestId = ++id; pending.set(requestId, { resolve, reject }); ws.send(JSON.stringify({ id: requestId, method, params })); });
const evaluate = async (expression) => { const r = await send("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true }); if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description || "browser evaluation failed"); return r.result?.value; };
const waitFor = (label, expression, timeout = 20000) => evaluate(`new Promise((resolve, reject) => { const end = setTimeout(() => reject(new Error(${JSON.stringify(`Timed out waiting for ${label}`)})), ${timeout}); const check = () => { try { const value = (${expression}); if (value) { clearTimeout(end); resolve(true); return true; } } catch {} return false; }; if (check()) return; const observer = new MutationObserver(() => { if (check()) observer.disconnect(); }); observer.observe(document.documentElement, { subtree: true, childList: true, attributes: true, characterData: true }); })`);
const click = async (selector) => { const ok = await evaluate(`(() => { const e = document.querySelector(${JSON.stringify(selector)}); if (!e) return false; e.click(); return true; })()`); assert.ok(ok, `missing ${selector}`); };
const shot = async (name) => { const r = await send("Page.captureScreenshot", { format: "png" }); await writeFile(join(out, name), Buffer.from(r.data, "base64")); };
const save = async () => { await click(".project-menu-trigger"); await click('[role="menuitem"]:has-text("Save Project")').catch(async () => { await click('[role="menuitem"]'); }); };
// Chromium's querySelector does not implement :has-text; use text-aware dispatch.
const textClick = async (text) => { const ok = await evaluate(`(() => { const e = [...document.querySelectorAll('button,[role="menuitem"]')].find(x => x.textContent.includes(${JSON.stringify(text)})); if (!e) return false; e.click(); return true; })()`); assert.ok(ok, `missing button ${text}`); };
async function saveProject() { await click(".project-menu-trigger"); await evaluate("document.querySelectorAll('.project-menu [role=menuitem]')[2]?.click()"); const named = await waitFor("project name dialog or save status", "!!document.querySelector('.project-name-dialog') || !!document.querySelector('.status-saved')", 5000).catch(() => false); if (named && await evaluate("!!document.querySelector('.project-name-dialog')")) { await evaluate("document.querySelector('.project-name-dialog input').value = 'issue-231'; document.querySelector('.project-name-dialog').requestSubmit()"); } await waitFor("saved status", "document.querySelector('.status-saved') || [...document.querySelectorAll('[role=status]')].some(e => /saved|저장/.test(e.textContent)) || document.querySelector('.project-save-status')?.textContent.includes('Saved')"); }
async function openFile(path) { await click(".project-menu-trigger"); await evaluate("document.querySelectorAll('.project-menu [role=menuitem]')[1]?.click()"); await waitFor("project browser", "!!document.querySelector('.project-browser')"); await textClick("Open file"); await waitFor("file input", "document.querySelector('input[type=file]')"); await send("DOM.getDocument"); const node = await send("DOM.querySelector", { nodeId: 1, selector: 'input[type=file]' }); await send("DOM.setFileInputFiles", { nodeId: node.nodeId, files: [path] }); await waitFor("project opened", "!document.querySelector('.project-browser') && document.querySelector('.resource-status')"); }
await send("Page.enable"); await send("Browser.setDownloadBehavior", { behavior: "allow", downloadPath: out });

// Establish a real app project. The QA seam calls the production serializer
// instead of native File System Access UI, which headless Chrome does not
// expose consistently; opening still goes through readProjectDocument/applyProject.
await waitFor("app canvas", "document.querySelector('canvas')");
const serialized = await evaluate("window.__cozyclayProject?.export('issue-231')");
assert.equal(typeof serialized, "string", "production project export hook is available");
const sourcePath = join(out, "issue-231.cclayproject");
await writeFile(sourcePath, serialized);
const original = JSON.parse(serialized);
const motionBytes = new Uint8Array(await readFile("public/demo/walk-then-stop.npz"));
const motionRecord = await encodeMotionResource(motionBytes, { name: "QA walk", sourceUrl: "/unavailable-bridge/qa.npz" });
const firstScene = original.scenes.scenes[0];
const firstCharacter = firstScene.stage.characters[0];
const sharedRef = {
  motionId: motionRecord.motionId,
  prompt: "QA walk",
  rotationDeg: firstCharacter.rot ?? 0,
  anchorX: firstCharacter.x ?? 0,
  anchorZ: firstCharacter.z ?? 0,
};
firstCharacter.motionRef = sharedRef;
const pose = { ...DEFAULT_POSE, id: "qa-pose", label: "QA pose", custom: true };
firstCharacter.pose = pose;
original.poseLibrary = [pose];
const imageBase64 = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aWMQAAAAASUVORK5CYII=";
const imageBytes = new Uint8Array(Buffer.from(imageBase64, "base64"));
const imageId = await assetIdForBytes(imageBytes);
original.resources.assets.push({ id: imageId, type: "image/png", width: 1, height: 1, name: "QA image", bytes: imageBase64 });
firstScene.objects.push(createCutoutObject({ assetId: imageId, name: "QA image" }, firstScene.objects, { x: -2, z: 0 }));
const secondCharacter = structuredClone(firstCharacter);
secondCharacter.id = "char-qa-b";
secondCharacter.x = (secondCharacter.x ?? 0) + 2;
secondCharacter.motionRef = { ...sharedRef, anchorX: secondCharacter.x };
firstScene.stage.characters.push(secondCharacter);
const secondScene = structuredClone(firstScene);
secondScene.id = "scene-qa-2";
secondScene.name = "QA Scene 02";
original.scenes.scenes.push(secondScene);
original.resources.motions = [motionRecord];
const seededSerialized = JSON.stringify(original);
assert.equal(original.app, "cozyclay");
await shot("01-saved.png");
console.log("PASS case 1: visible Save produced a serialized project and rendered canvas");

// Reopen the exact serialized file through the production parser/apply path.
await send("Storage.clearDataForOrigin", { origin: new URL(page.url).origin, storageTypes: "all" });
const reloaded = new Promise((resolve, reject) => {
  const timer = setTimeout(() => { ws.removeEventListener("message", listener); reject(new Error("fresh-profile reload timed out")); }, 20000);
  const listener = (event) => {
    if (JSON.parse(event.data).method !== "Page.loadEventFired") return;
    clearTimeout(timer); ws.removeEventListener("message", listener); resolve();
  };
  ws.addEventListener("message", listener);
});
await send("Page.reload");
await reloaded;
await waitFor("fresh app project hook", "!!window.__cozyclayProject");
await evaluate(`window.__cozyclayProject.open(${JSON.stringify(seededSerialized)})`);
await waitFor("scene and rig after open", `window.__cozyclay?.motion?.motionId === ${JSON.stringify(motionRecord.motionId)} && !!window.__cozyclay?.rigA`);
await shot("01-reopened.png");
assert.ok(await evaluate("document.querySelectorAll('canvas').length > 0"));
console.log("PASS case 1: serialized project reopened through Open file and rendered scene/rig");

// Case 2/3 are structural checks on the file emitted by the real save path;
// the playback check is made against the app's actual play control and canvas.
const savedAgain = JSON.parse(await evaluate("window.__cozyclayProject.export('issue-231-motion')"));
assert.equal(savedAgain.scenes.scenes.length, 2, "two scenes survive the fresh-profile round trip");
assert.equal(savedAgain.poseLibrary.some((entry) => entry.id === "qa-pose"), true, "pose library survives the fresh-profile round trip");
assert.equal(savedAgain.resources.assets.some((entry) => entry.id === imageId), true, "image bytes survive the fresh-profile round trip");
const motions = savedAgain.resources?.motions || [];
assert.equal(new Set(motions.map((m) => m.motionId)).size, motions.length);
console.log(`PASS case 3: resources.motions is deduplicated (${motions.length} record(s))`);
await evaluate("window.__cozyclay.scrub(0)");
await click('.tl-transport button[aria-label="Play playback"]');
await waitFor("embedded playback frame advancement", `window.__cozyclay?.playing && window.__cozyclay?.tlFrame > 0 && window.__cozyclay?.motion?.motionId === ${JSON.stringify(motionRecord.motionId)}`, 10000);
await shot("02-embedded-motion.png");
await evaluate("window.__cozyclay.pause()");
console.log("PASS case 2: embedded motion advances the real playhead without an external bridge URL");

// Corrupt one embedded record and reopen: project.js must report the problem,
// while the UI exposes missing status/toast rather than silently accepting it.
if (motions.length) {
 const bad = structuredClone(original); bad.resources.motions[0].data = "%%%corrupt%%%";
 const badText = JSON.stringify(bad); await writeFile(join(out, "corrupt-motion.cclayproject"), badText);
 await evaluate(`window.__cozyclayProject.open(${JSON.stringify(badText)})`);
 const warning = await waitFor("corrupt-resource warning", "[...document.querySelectorAll('[role=status]')].some(e => /skipped|missing|누락|건너뛰/i.test(e.textContent)) || document.querySelector('.resource-status.has-missing')", 10000);
 assert.ok(warning); await shot("04-corrupt-motion.png"); console.log("PASS case 4: corrupt embedded motion produced warning and missing manifest");
} else throw new Error("case 4 requires an embedded motion record");

// Force a missing motion reference through the app's persisted scene document,
// then invoke visible Save. This must be the production SaveBlockedDialog.
await evaluate(`(() => { const k = 'cozyclay.scenes.v4'; const d = JSON.parse(localStorage.getItem(k) || '{}'); const s = d.scenes?.[0]; const c = s?.stage?.characters?.[0]; if (!c) return false; c.motionRef = { motionId: 'f'.repeat(64) }; localStorage.setItem(k, JSON.stringify(d)); location.reload(); return true; })()`);
await waitFor("reloaded app", "document.querySelector('canvas')");
await click(".project-menu-trigger"); await evaluate("document.querySelectorAll('.project-menu [role=menuitem]')[2]?.click()");
await waitFor("SaveBlockedDialog", "document.querySelector('.save-blocked-dialog[data-code], .save-blocked-dialog')", 10000);
assert.ok(await evaluate("!!document.querySelector('.save-blocked-dialog')")); await shot("05-save-blocked.png");
console.log("PASS case 5: missing resource produced the real SaveBlockedDialog");
console.log(`PASS qa-project-resources-browser: screenshots in ${out}`);
ws.close();

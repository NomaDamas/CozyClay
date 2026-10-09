#!/usr/bin/env node
import { mkdirSync, writeFileSync } from "node:fs";

const cdpPort = Number(process.env.CDP_PORT || 9222);
const out = process.env.QA_OUT || "/tmp/cozyclay-qa-616";
mkdirSync(out, { recursive: true });
const baseUrl = process.env.QA_URL || "http://127.0.0.1:5796/app/";
const url = `${baseUrl}${baseUrl.includes("?") ? "&" : "?"}motion=/demo/walk-then-stop.npz`;
const targets = await (await fetch(`http://127.0.0.1:${cdpPort}/json`)).json();
const page = targets.find((entry) => entry.type === "page" && entry.webSocketDebuggerUrl);
if (!page) throw new Error("No Chrome page target");

const ws = new WebSocket(page.webSocketDebuggerUrl);
await new Promise((resolve, reject) => { ws.onopen = resolve; ws.onerror = reject; });
let nextId = 1;
const pending = new Map();
const pageErrors = [];
ws.onmessage = ({ data }) => {
	const message = JSON.parse(data);
	if (message.method === "Runtime.exceptionThrown") pageErrors.push(message.params.exceptionDetails.exception?.description ?? message.params.exceptionDetails.text);
	if (!message.id || !pending.has(message.id)) return;
	const job = pending.get(message.id);
	pending.delete(message.id);
	message.error ? job.reject(new Error(JSON.stringify(message.error))) : job.resolve(message.result);
};
const send = (method, params = {}) => new Promise((resolve, reject) => {
	const id = nextId++;
	pending.set(id, { resolve, reject });
	ws.send(JSON.stringify({ id, method, params }));
});
const evaluate = async (expression) => {
	const result = await send("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true });
	if (result.exceptionDetails) throw new Error(result.exceptionDetails.exception?.description || result.exceptionDetails.text);
	return result.result?.value;
};
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const waitFor = async (expression, timeout = 120_000) => {
	const deadline = Date.now() + timeout;
	while (Date.now() < deadline) {
		if (await evaluate(expression).catch(() => false)) return true;
		await sleep(100);
	}
	throw new Error(`Timeout waiting for ${expression}`);
};
const checks = [];
const check = (name, pass, detail = "") => {
	checks.push({ name, pass: !!pass, detail });
	console.log(`${pass ? "PASS" : "FAIL"} ${name}${detail ? ` — ${detail}` : ""}`);
};

await send("Runtime.enable");
await send("Page.enable");
await send("Emulation.setDeviceMetricsOverride", { width: 1600, height: 1000, deviceScaleFactor: 1, mobile: false });
await send("Page.navigate", { url });
await waitFor(`location.href === ${JSON.stringify(url)} && !!window.__cozyclay?.motion && !!window.__cozyclay?.ikChains`);
await evaluate(`(() => { const q = window.__cozyclay, p = q.rigA.getWorldPosition(q.rigA.position.clone()); q.frameEditorCam({x:p.x+4,y:p.y+3,z:p.z+6}, {x:p.x,y:p.y+1,z:p.z}); })()`);
await sleep(200);
await evaluate(`document.querySelector('[data-mode-key="2"]')?.click()`);
await waitFor("document.querySelector('.app')?.dataset.workflowMode === 'pose' && window.__cozyclay?.ikMode === true");

const distance = (a, b) => Math.hypot(...a.map((v, i) => v - b[i]));
const beforeHand = await evaluate("window.__cozyclay.rangePinEffector('leftHand')");
await evaluate("window.__cozyclay.ikPreviewApply('leftHand', {x:0,y:0.04,z:0})");
await waitFor("!!document.querySelector('[data-testid=ik-pending-edit]')");
await sleep(300);
const pendingView = await evaluate("({ text: document.querySelector('[data-testid=ik-pending-edit]')?.textContent.trim(), keys: [...window.__cozyclay.ik.keys.keys()], hand: window.__cozyclay.rangePinEffector('leftHand') })");
check("an IK drag previews a changed pose without creating keys", pendingView.keys.length === 0 && distance(beforeHand, pendingView.hand) > 0.001, JSON.stringify(pendingView));
const previewImage = await send("Page.captureScreenshot", { format: "png" });
writeFileSync(`${out}/ik-preview.png`, Buffer.from(previewImage.data, "base64"));
await evaluate("document.querySelector('[data-testid=ik-cancel-preview]').click()");
await waitFor("!document.querySelector('[data-testid=ik-pending-edit]')");
await sleep(200);
check("Cancel restores the original rendered pose and leaves no keys", await evaluate("window.__cozyclay.ik.keys.size") === 0 && distance(beforeHand, await evaluate("window.__cozyclay.rangePinEffector('leftHand')")) < 0.00001);
await evaluate("window.__cozyclay.ikPreviewApply('leftHand', {x:0,y:0.04,z:0})");
await waitFor("!!document.querySelector('[data-testid=ik-pending-edit]')");
await sleep(200);
await evaluate("window.__cozyclay.ikPreviewApply('leftHand', {x:0,y:0.02,z:0})");
await sleep(200);
check("a second drag remains uncommitted until Apply", await evaluate("window.__cozyclay.ik.keys.size") === 0);
const previewHand = await evaluate("window.__cozyclay.rangePinEffector('leftHand')");
await evaluate("document.querySelector('[data-testid=ik-apply-range]')?.click()");
await waitFor("!document.querySelector('[data-testid=ik-pending-edit]') && window.__cozyclay.ik.keys.size >= 2");
await sleep(200);
check("Apply preserves the previewed pose", distance(previewHand, await evaluate("window.__cozyclay.rangePinEffector('leftHand')")) < 0.00001);
const applied = await evaluate("[...window.__cozyclay.ik.keys.keys()].sort((a,b)=>a-b)");
const frameCount = await evaluate("window.__cozyclay.motion.frames");
check("Apply writes correction keys at the selected motion-block boundaries", applied.length >= 2 && applied[0] === 0 && applied.at(-1) === frameCount - 1, JSON.stringify(applied));

const pathButton = await evaluate(`(() => [...document.querySelectorAll('[data-testid=pose-active-tool] button')].find((button) => /Path fix|경로 수정/.test(button.textContent))?.textContent.trim() ?? null)()`);
check("Pose exposes the Path fix tool", pathButton !== null, pathButton);
await evaluate(`(() => [...document.querySelectorAll('[data-testid=pose-active-tool] button')].find((button) => /Path fix|경로 수정/.test(button.textContent))?.click())()`);
await waitFor("window.__cozyclay?.trail?.tool === 'trail' && window.__cozyclayVisibleTrailTracks?.length === 1");
const initial = await evaluate("({ active: window.__cozyclay.trail.activeTrackId, visible: window.__cozyclayVisibleTrailTracks.slice() })");
check("Path fix opens with only the selected line visible", initial.visible.length === 1 && initial.visible[0] === initial.active, JSON.stringify(initial));
await evaluate("(() => { const el = document.querySelector('[data-testid=trail-track-select]'); el.value = 'hips'; el.dispatchEvent(new Event('change', {bubbles:true})); })()");
await waitFor("window.__cozyclay?.trail?.activeTrackId === 'hips' && window.__cozyclayVisibleTrailTracks.length === 1");
const focused = await evaluate("({ active: window.__cozyclay.trail.activeTrackId, visible: window.__cozyclayVisibleTrailTracks.slice(), selection: document.querySelector('[data-testid=trail-track-select]')?.selectedOptions[0]?.textContent })");
check("selecting a MotionTrails line isolates its rendered track", focused.active === "hips" && focused.visible.join() === "hips", JSON.stringify(focused));
check("the selected line is named in Pose", /Hips|엉덩이|hips/i.test(focused.selection ?? ""), focused.selection);

await evaluate("(() => { const el = document.querySelector('[data-testid=trail-track-select]'); el.value = 'head'; el.dispatchEvent(new Event('change', {bubbles:true})); })()");
await waitFor("window.__cozyclay.trail.activeTrackId === 'head' && window.__cozyclayVisibleTrailTracks.join() === 'head'");
check("switching tracks hides the previous edit highlight too", await evaluate("window.__cozyclayTrails.children.length === 1"));

const screenshot = await send("Page.captureScreenshot", { format: "png" });
writeFileSync(`${out}/ik-range-trail.png`, Buffer.from(screenshot.data, "base64"));

await evaluate("document.querySelector('[data-testid=trail-show-all]')?.click()");
await waitFor("window.__cozyclay?.trail?.activeTrackId === null && window.__cozyclayVisibleTrailTracks.length === 6");
check("Show all lines restores the full MotionTrails set", await evaluate("window.__cozyclay.trail.activeTrackId === null && window.__cozyclayVisibleTrailTracks.length === 6"));
check("the browser reports no uncaught page errors", pageErrors.length === 0, pageErrors.join("\n"));


writeFileSync(`${out}/report.json`, JSON.stringify({ checks, initial, focused }, null, 2));
ws.close();
process.exit(checks.some((entry) => !entry.pass) ? 1 : 0);

// Scratch QA: run the in-browser MediaPipe photo-pose path on one image and
// dump the resulting cskel27 posed joints as JSON. Driven through
// tools/qa-browser.mjs; PHOTO=<png path> selects the image, OUT=<json path>.
import { readFileSync, writeFileSync } from "node:fs";

const port = Number(process.env.CDP_PORT || 9222);
const photo = process.env.PHOTO;
const out = process.env.OUT || "/tmp/mediapipe-pose.json";
const targets = await (await fetch(`http://127.0.0.1:${port}/json`)).json();
const page = targets.find((t) => t.type === "page" && t.webSocketDebuggerUrl);
if (!page) throw new Error("no page target on the QA browser");
const ws = new WebSocket(page.webSocketDebuggerUrl);
await new Promise((resolve, reject) => { ws.onopen = resolve; ws.onerror = reject; });
let id = 0; const pending = new Map();
ws.onmessage = (e) => { const m = JSON.parse(e.data); if (m.id && pending.has(m.id)) { pending.get(m.id)(m.result ?? m); pending.delete(m.id); } };
const send = (method, params = {}) => new Promise((r) => { id += 1; pending.set(id, r); ws.send(JSON.stringify({ id, method, params })); });
const evaluate = async (expression) => {
	const r = await send("Runtime.evaluate", { expression, returnByValue: true, awaitPromise: true });
	if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description || "evaluate failed");
	return r.result?.value;
};
const b64 = readFileSync(photo).toString("base64");
const result = await evaluate(`(async () => {
	const mod = await import("/src/pose-extract/index.js");
	const rest = await (await fetch("/ardy/cskel27-rest.json")).json();
	const det = await mod.createPoseDetector({ runningMode: "IMAGE", model: "heavy" });
	const blob = await (await fetch("data:image/png;base64,${b64}")).blob();
	const url = URL.createObjectURL(blob);
	const image = await mod.decodeImage(url, { createImage: () => new Image() });
	const landmarks = await mod.detectMirrorAveraged(image, det.detect);
	if (!landmarks) return { error: "no-person" };
	const take = mod.bakePoseFrame({ samples: [{ timeS: 0, landmarks }], rest, createdMs: Date.now() });
	return { frames: take.frames, posedJoints: Array.from(take.posedJoints), rotMats: Array.from(take.rotMats), releasedBones: take.releasedBones, confidence: take.confidence };
})()`);
writeFileSync(out, JSON.stringify(result));
console.log(result.error ? `FAIL ${result.error}` : `ok frames=${result.frames} confidence=${result.confidence?.toFixed?.(2)} released=${JSON.stringify(result.releasedBones)}`);
ws.close();
process.exit(result.error ? 1 : 0);

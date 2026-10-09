#!/usr/bin/env node
// Browser QA: a returning author with only a v4 scene document opens /app/.
// The studio must write the v5 document (every cast member standing) and keep
// the v4 body untouched as the backup.
// Run: node tools/qa-browser.mjs -- node test/qa-scenes-v5-migration-browser.mjs
import assert from "node:assert/strict";

const port = Number(process.env.CDP_PORT || 9222);
const targets = await (await fetch(`http://127.0.0.1:${port}/json`)).json();
const page = targets.find((target) => target.type === "page" && target.url.includes("/app/"));
assert.ok(page, "app page is open on the QA browser");
const appUrl = page.url;
const origin = new URL(appUrl).origin;

const ws = new WebSocket(page.webSocketDebuggerUrl);
await new Promise((resolve, reject) => { ws.onopen = resolve; ws.onerror = reject; });
let nextId = 0;
const pending = new Map();
const listeners = new Set();
ws.onmessage = (event) => {
	const message = JSON.parse(event.data);
	if (message.id && pending.has(message.id)) {
		const { resolve, reject } = pending.get(message.id);
		pending.delete(message.id);
		if (message.error) reject(new Error(JSON.stringify(message.error)));
		else resolve(message.result);
		return;
	}
	for (const listener of listeners) listener(message);
};
const send = (method, params = {}) => new Promise((resolve, reject) => {
	const id = ++nextId;
	pending.set(id, { resolve, reject });
	ws.send(JSON.stringify({ id, method, params }));
});
const evaluate = async (expression) => {
	const result = await send("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true });
	if (result.exceptionDetails) throw new Error(result.exceptionDetails.exception?.description || "evaluate failed");
	return result.result?.value;
};
const navigate = async (url) => {
	const loaded = new Promise((resolve, reject) => {
		const timer = setTimeout(() => { listeners.delete(onEvent); reject(new Error(`load timed out: ${url}`)); }, 60000);
		function onEvent(message) {
			if (message.method !== "Page.loadEventFired") return;
			clearTimeout(timer);
			listeners.delete(onEvent);
			resolve();
		}
		listeners.add(onEvent);
	});
	await send("Page.navigate", { url });
	await loaded;
};

const v4Document = {
	version: 4,
	activeSceneId: "qa-v4-scene",
	scenes: [{
		id: "qa-v4-scene",
		name: "V4 QA",
		objects: [],
		shotDocument: null,
		stage: {
			characters: [
				{ id: "char-a", model: "y-bot-tpose", x: 1, y: 0, z: -1, rot: 0, hidden: false, tint: null, pose: null, identityImage: null, scale: 1, subject: "hero", layer: { waypoints: [], promptClips: [] }, motionRef: null },
				{ id: "char-b", model: "x-bot-tpose", x: -1, y: 0, z: 1, rot: 90, hidden: false, tint: null, pose: null, identityImage: null, scale: 1, subject: "friend", layer: { waypoints: [], promptClips: [] }, motionRef: null },
			],
			hasCharSheet: false,
			shotAspect: "16:9",
		},
	}],
};
const v4Raw = JSON.stringify(v4Document);

await send("Page.enable");
// Leave the studio first (it persists its scenes on the way out), then wipe
// and seed through a plain same-origin document so the studio never sees a
// half-seeded storage.
await navigate(`${origin}/favicon.ico`);
await send("Storage.clearDataForOrigin", { origin, storageTypes: "all" });
await evaluate(`localStorage.setItem("cozyclay.scenes.v4", ${JSON.stringify(v4Raw)});
	localStorage.setItem("cozyclay.project-session.v1", JSON.stringify({ name: "V5 QA", updatedAt: Date.now() }));
	localStorage.setItem("cozyclay.camera-tutorial-terminal.v1", JSON.stringify({ completed: true }));
	true`);
assert.equal(await evaluate(`localStorage.getItem("cozyclay.scenes.v5")`), null, "no v5 key before the studio opens");
await navigate(appUrl);

// The migration is written by the studio's scene reader during startup.
const deadline = Date.now() + 30000;
let v5Raw = null;
while (!v5Raw && Date.now() < deadline) {
	v5Raw = await evaluate(`localStorage.getItem("cozyclay.scenes.v5")`);
	if (!v5Raw) await new Promise((resolve) => setTimeout(resolve, 200));
}
assert.ok(v5Raw, "the v5 key appears after /app/ loads");
const v5 = JSON.parse(v5Raw);
assert.equal(v5.version, 5);
assert.equal(v5.activeSceneId, "qa-v4-scene");
const cast = v5.scenes.find((scene) => scene.id === "qa-v4-scene")?.stage?.characters ?? [];
assert.deepEqual(cast.map((character) => [character.id, character.model, character.posture]), [
	["char-a", "y-bot-tpose", "stand"],
	["char-b", "x-bot-tpose", "stand"],
], "every v4 cast member is migrated standing");
assert.equal(await evaluate(`localStorage.getItem("cozyclay.scenes.v4")`), v4Raw, "the v4 key is kept byte-for-byte");

console.log(`PASS v4 -> v5 storage migration: v5 key written (version ${v5.version}, postures ${cast.map((character) => character.posture).join(",")}), v4 key kept (${v4Raw.length} bytes)`);
ws.close();

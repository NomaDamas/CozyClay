#!/usr/bin/env node
// Issue #193: a Shot with no camera keys used to be un-exportable — the Export
// button was disabled, and the recorder's range fell back to the whole
// production duration because timelineContentExtent ignores shots. The Export
// menu's Video item now keys the current framing first and records exactly the
// shot's own range, so a keyless 40-frame static shot yields a 40-frame MP4.
//
// Run: `npm run dev:ui` in one shell, then
//   QA_URL=http://127.0.0.1:5180/app/ node tools/qa-browser.mjs -- \
//     node test/verify-static-shot-export-browser.mjs

const origin = new URL(process.env.QA_URL ?? "http://127.0.0.1:5180/app/").origin;
const port = Number(process.env.CDP_PORT || 9222);
const targets = await (await fetch(`http://127.0.0.1:${port}/json`)).json();
const page = targets.find((target) => target.type === "page" && target.webSocketDebuggerUrl);
if (!page) throw new Error("no page target on the QA browser");

const ws = new WebSocket(page.webSocketDebuggerUrl);
await new Promise((resolve, reject) => {
	ws.onopen = resolve;
	ws.onerror = reject;
});

let nextId = 1;
const pending = new Map();
const pageErrors = [];
ws.onmessage = (event) => {
	const message = JSON.parse(event.data);
	if (message.method === "Runtime.exceptionThrown") {
		pageErrors.push(message.params.exceptionDetails.exception?.description ?? message.params.exceptionDetails.text);
		return;
	}
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
	if (result.exceptionDetails) throw new Error(result.exceptionDetails.exception?.description || "evaluate failed");
	return result.result.value;
};
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const waitFor = async (expression, timeoutMs = 30000) => {
	const deadline = Date.now() + timeoutMs;
	while (Date.now() < deadline) {
		if (await evaluate(expression).catch(() => false)) return true;
		await sleep(100);
	}
	return false;
};

let failures = 0;
const expect = (name, condition, detail = "") => {
	console.log(`${condition ? "PASS" : "FAIL"} ${name}${condition ? "" : ` — ${detail}`}`);
	if (!condition) failures += 1;
};

const SHOT_FRAMES = 40;

await send("Runtime.enable");
await send("Page.enable");
// Seed on a blank same-origin document: a scene written into the live studio
// races the studio's own save on the next commit.
await send("Page.navigate", { url: `${origin}/favicon.ico` });
await sleep(500);
await evaluate(`(() => {
	const shot = { id: "static-shot", name: "Static", startFrame: 0, endFrame: ${SHOT_FRAMES - 1}, cameraKeys: [], camera: { mode: "keys" } };
	const document = { version: 4, activeSceneId: "scene-static", scenes: [{
		id: "scene-static", name: "STATIC QA", objects: [],
		shotDocument: { version: 4, frameCount: 360, shots: [shot], waypoints: [] },
		stage: { characters: [{ id: "char-a", model: "y-bot-tpose", x: 0, z: 0, rot: 0, hidden: false, pose: null, subject: "a person" }], hasCharSheet: false, shotAspect: "16:9" },
	}] };
	localStorage.setItem("cozyclay.locale", "en");
	localStorage.setItem("cozyclay.project-session.v1", JSON.stringify({ name: "QA", updatedAt: Date.now() }));
	localStorage.setItem("cozyclay.scenes.v4", JSON.stringify(document));
})()`);
await send("Page.navigate", { url: `${origin}/app/` });
expect("the keyless static shot loads", await waitFor("!!window.__cozyclay?.rigA && !!document.querySelector('.tl-shot-block')"));
expect("the project has no motion, so the timeline extent would fall back to 360", (await evaluate("window.__cozyclay.motion ?? null")) === null);
expect("the topbar Export trigger is enabled anyway", (await evaluate("document.querySelector('[data-testid=topbar-export]').disabled")) === false);

// The Export menu's Video item, minus the file download (same closure).
const result = await evaluate("window.__cozyclay.exportShotVideo({ download: false })");
expect(
	`the static shot exports its own ${SHOT_FRAMES} frames, not the production duration`,
	result?.frameCount === SHOT_FRAMES,
	JSON.stringify({ frameCount: result?.frameCount, blobSize: result?.blobSize ?? result?.blob?.size }),
);
expect("the preflight materialized one framing key on the shot", await waitFor(
	"JSON.parse(localStorage.getItem('cozyclay.scenes.v4')).scenes[0].shotDocument.shots[0].cameraKeys.length === 1",
	10000,
));
expect("the export leaves the recorder idle", await waitFor("!document.querySelector('[data-testid=topbar-export].recording')", 5000));
expect("browser run has no uncaught page errors", pageErrors.length === 0, pageErrors.join(" | "));

ws.close();
if (failures) process.exit(1);
console.log(`all static-shot export browser checks PASS — keyless ${SHOT_FRAMES}-frame shot yields ${SHOT_FRAMES} frames`);

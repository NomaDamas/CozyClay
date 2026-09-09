#!/usr/bin/env node
// Browser QA for the last three controls docs/studio-ui-ia.md budgets against
// (§1 R6, #189): the scene ROOT has no fold caret, the Characters GROUP row is
// gone (the cast sits directly under the root), and Prompt Blocks' "Generate
// all" stays absent until there is a block to generate (R3). Drives the real
// studio over CDP and screenshots both surfaces, because "the count went down"
// and "the panel still reads right" are two claims.
//
//   QA_URL=http://127.0.0.1:5196/app/ CDP_PORT=9256 node tools/qa-browser.mjs \
//     -- node test/qa-ia-tail-browser.mjs
import { mkdirSync, writeFileSync } from "node:fs";

const out = process.env.QA_OUT || "/tmp/ia-tail-qa";
mkdirSync(out, { recursive: true });

const port = Number(process.env.CDP_PORT || 9222);
const targets = await (await fetch(`http://127.0.0.1:${port}/json`)).json();
const page = targets.find((target) => target.type === "page" && target.webSocketDebuggerUrl);
if (!page) throw new Error("no page target on the QA browser");
const ws = new WebSocket(page.webSocketDebuggerUrl);
await new Promise((resolve, reject) => { ws.onopen = resolve; ws.onerror = reject; });

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
	const result = await send("Runtime.evaluate", { expression, returnByValue: true, awaitPromise: true, timeout: 120_000 });
	if (result.exceptionDetails) throw new Error(result.exceptionDetails.exception?.description || "evaluate failed");
	return result.result.value;
};
// Every wait is on the state the step produces, never on a fixed delay: React
// commits when it commits, and a sleep would only decide how flaky this is.
const waitFor = async (expression, timeoutMs = 20_000) => {
	const deadline = Date.now() + timeoutMs;
	for (;;) {
		if (await evaluate(expression).catch(() => false)) return true;
		if (Date.now() >= deadline) return false;
		await new Promise((resolve) => setTimeout(resolve, 50));
	}
};

let failures = 0;
const expect = (name, condition, detail = "") => {
	console.log(`${condition ? "PASS" : "FAIL"} ${name}${condition ? "" : ` — ${detail}`}`);
	if (!condition) failures += 1;
};

// Screenshots the element an EXPRESSION returns, so a card found by its
// heading can be framed as precisely as one found by class.
const shotOf = async (name, elementExpression) => {
	const clip = await evaluate(`(() => {
		const node = ${elementExpression};
		if (!node) return null;
		node.scrollIntoView({ block: "nearest" });
		const box = node.getBoundingClientRect();
		return { x: Math.max(0, Math.round(box.x - 8)), y: Math.max(0, Math.round(box.y - 8)), width: Math.round(box.width + 16), height: Math.round(box.height + 16) };
	})()`);
	if (!clip) return 0;
	const image = await send("Page.captureScreenshot", { format: "png", clip: { ...clip, scale: 2 } });
	writeFileSync(`${out}/${name}.png`, Buffer.from(image.data, "base64"));
	return Buffer.from(image.data, "base64").byteLength;
};

const rowDepth = (id) => evaluate(`(() => {
	const row = document.querySelector("[data-node-id='${id}']");
	return row ? Number(getComputedStyle(row).getPropertyValue("--hierarchy-depth")) : null;
})()`);
const rowLabels = () => evaluate(`[...document.querySelectorAll(".hierarchy-tree .hierarchy-row")].map((node) => (node.getAttribute("aria-label") ?? node.textContent).trim())`);
const clickMode = async (label) => {
	await evaluate(`[...document.querySelectorAll(".workflow-mode-switch button")].find((node) => node.textContent.trim() === "${label}")?.click()`);
	return waitFor(`[...document.querySelectorAll(".workflow-mode-switch button")].find((node) => node.textContent.trim() === "${label}")?.getAttribute("aria-selected") === "true"`);
};
// The Prompt Blocks card, found by its heading rather than by index: the
// inspector column reorders as foldouts show and hide.
const PROMPT_CARD = `[...document.querySelectorAll(".card.foldout")].find((card) => !card.hidden && card.querySelector(".foldout-title")?.textContent.trim() === "Prompt Blocks")`;
const generateAllLabels = () => evaluate(`(() => {
	const card = ${PROMPT_CARD};
	if (!card) return null;
	return [...card.querySelectorAll("button")].map((node) => node.textContent.trim()).filter((text) => text.startsWith("Generate all"));
})()`);

/* --- a QA project with one character ----------------------------------------- */

await send("Runtime.enable");
await send("Page.enable");
await send("Emulation.setDeviceMetricsOverride", { width: 1600, height: 1000, deviceScaleFactor: 1, mobile: false });
await send("Page.navigate", { url: process.env.QA_URL ?? "http://127.0.0.1:5180/app/" });
await waitFor("location.href.startsWith('http')");
await evaluate(`(() => {
	localStorage.clear();
	localStorage.setItem("cozyclay.locale", "en");
	localStorage.setItem("cozyclay.project-session.v1", JSON.stringify({ name: "QA", updatedAt: Date.now() }));
})()`);
await send("Page.reload");
expect("the studio comes up", await waitFor("!!window.__cozyclay?.rigA", 60_000));
expect("the tree is rendered", await waitFor(`!!document.querySelector("[data-node-id='shot']")`));

/* --- (a) the scene root does not fold ---------------------------------------- */

expect(
	"the root row carries no fold caret",
	await evaluate(`!document.querySelector("[data-node-id='shot'] .hierarchy-toggle")`),
);
expect(
	"the root keeps the caret column, so its icon still lines up",
	await evaluate(`!!document.querySelector("[data-node-id='shot'] .hierarchy-fold-space")`),
);

/* --- (b) the cast sits directly under the root ------------------------------- */

const labels = await rowLabels();
expect("no Characters group row is rendered", !labels.includes("Characters"), JSON.stringify(labels));
expect("the group node itself has no row", await evaluate(`!document.querySelector("[data-node-id='characters']")`));
expect("Character 1 is still a row", await evaluate(`!!document.querySelector("[data-node-id='characterA']")`));
const cameraDepth = await rowDepth("camera");
const characterDepth = await rowDepth("characterA");
expect("Character 1 sits at the same indent as Camera", characterDepth === cameraDepth && cameraDepth === 1, `camera=${cameraDepth} characterA=${characterDepth}`);
expect(
	"the character keeps its own caret and rig subtree",
	await evaluate(`!!document.querySelector("[data-node-id='characterA'] .hierarchy-toggle") && !!document.querySelector("[data-node-id='characterA.rig']")`),
);
await evaluate(`document.querySelector("[data-node-id='characterA'] .hierarchy-row").click()`);
expect(
	"clicking Character 1 still selects it",
	await waitFor(`document.querySelector("[data-node-id='characterA']").classList.contains("selected")`),
);
expect("the hierarchy screenshot has bytes", (await shotOf("hierarchy-scene-mode", `document.querySelector(".hierarchy-tree")`)) > 2000);

/* --- (c) Generate all waits for a block -------------------------------------- */

expect("Motion mode opens", await clickMode("Motion"));
// #201: entering Motion selects the active character's ROW, so the character
// panels (Prompt Blocks among them) are the ones on screen.
expect("Motion lands on a character row, not the vanished group", await waitFor(`["characterA", "characterB"].some((id) => document.querySelector("[data-node-id='" + id + "']")?.classList.contains("selected"))`));
expect("the Prompt Blocks panel is open", await waitFor(`!!(${PROMPT_CARD})?.querySelector(".foldout-body")`));
expect("with no blocks there is no Generate all button", (await generateAllLabels())?.length === 0, JSON.stringify(await generateAllLabels()));
expect("the next step is still spelled out", await evaluate(`[...(${PROMPT_CARD}).querySelectorAll("button")].some((node) => node.textContent.trim().startsWith("Add block at frame"))`));
expect("the empty Prompt Blocks screenshot has bytes", (await shotOf("prompt-blocks-zero", PROMPT_CARD)) > 2000);

await evaluate(`[...(${PROMPT_CARD}).querySelectorAll("button")].find((node) => node.textContent.trim().startsWith("Add block at frame"))?.click()`);
expect("adding the first block brings the action back", await waitFor(`[...(${PROMPT_CARD}).querySelectorAll("button")].some((node) => node.textContent.trim().startsWith("Generate all"))`));
const withBlock = await generateAllLabels();
expect("the action counts the block it would run", withBlock?.[0] === "Generate all 1 blocks", JSON.stringify(withBlock));

writeFileSync(`${out}/summary.json`, JSON.stringify({ labels, cameraDepth, characterDepth, withBlock }, null, 2));
expect("browser run has no uncaught page errors", pageErrors.length === 0, pageErrors.join(" | "));

ws.close();
if (failures) { console.error(`${failures} FAILURES`); process.exit(1); }
console.log(`PASS IA tail — no root caret, no Characters group row, Generate all gated on a block; evidence in ${out}`);

/**
 * Visual QA driver for CozyClay: drives headless Chrome over CDP with
 * Node's built-in WebSocket. Loads the studio, generates "a person walk"
 * with the default seed (2), then captures screenshots at several playback
 * frames for pose review.
 *
 * Usage: node tools/ardy/visual-qa.mjs <outDir> [url]
 * The default URL is the studio route (`/app/`), not the marketing landing page.
 */
import { writeFileSync, mkdirSync } from "node:fs";

const OUT = process.argv[2] || "/tmp/visual-qa";
const URL = process.argv[3] || "http://127.0.0.1:5180/app/";
mkdirSync(OUT, { recursive: true });

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// --- minimal CDP client -----------------------------------------------------
async function newTab() {
	const res = await fetch("http://127.0.0.1:9222/json/new?about:blank", { method: "PUT" });
	const target = await res.json();
	const ws = new WebSocket(target.webSocketDebuggerUrl);
	await new Promise((resolve, reject) => {
		ws.onopen = resolve;
		ws.onerror = reject;
	});
	let id = 0;
	const pending = new Map();
	const consoleLog = [];
	ws.onmessage = (event) => {
		const msg = JSON.parse(event.data);
		if (msg.id && pending.has(msg.id)) {
			const { resolve, reject } = pending.get(msg.id);
			pending.delete(msg.id);
			if (msg.error) reject(new Error(msg.error.message));
			else resolve(msg.result);
		} else if (msg.method === "Runtime.consoleAPICalled") {
			const type = msg.params.type;
			const text = msg.params.args.map((a) => a.value ?? a.description ?? "").join(" ");
			if (type === "error" || type === "warning") consoleLog.push(`[${type}] ${text}`);
		} else if (msg.method === "Runtime.exceptionThrown") {
			consoleLog.push(`[exception] ${msg.params.exceptionDetails.text} ${msg.params.exceptionDetails.exception?.description ?? ""}`);
		}
	};
	const send = (method, params = {}) =>
		new Promise((resolve, reject) => {
			const msgId = ++id;
			pending.set(msgId, { resolve, reject });
			ws.send(JSON.stringify({ id: msgId, method, params }));
		});
	return { ws, send, consoleLog };
}

async function evaluate(tab, expression) {
	const res = await tab.send("Runtime.evaluate", {
		expression,
		awaitPromise: true,
		returnByValue: true,
	});
	if (res.exceptionDetails) {
		throw new Error(`evaluate failed: ${JSON.stringify(res.exceptionDetails.exception?.description || res.exceptionDetails.text)}`);
	}
	return res.result.value;
}

async function shot(tab, name) {
	const res = await tab.send("Page.captureScreenshot", { format: "png" });
	writeFileSync(`${OUT}/${name}.png`, Buffer.from(res.data, "base64"));
	console.log(`saved ${OUT}/${name}.png`);
}

// --- flow -------------------------------------------------------------------
const tab = await newTab();
await tab.send("Page.enable");
await tab.send("Runtime.enable");
await tab.send("Page.navigate", { url: URL });
await sleep(6000);

// Prompt Blocks replaced the old single "Generate motion" field. Select the
// first character, open the Prompt Blocks foldout, then add a block before
// looking for its prompt input and batch Generate action.
await evaluate(tab, `(() => {
	const character = [...document.querySelectorAll('.hierarchy-row')].find((row) => /Character 1|Subject 1|인물 1/.test(row.textContent));
	character?.click();
	const foldout = [...document.querySelectorAll('.foldout-head')].find((button) => /Prompt Blocks|프롬프트 블록/.test(button.textContent));
	foldout?.click();
	const add = document.querySelector('.tl-track.prompts .tl-track-add') || document.querySelector('.tl-track-add[title*="prompt"]');
	add?.click();
	return true;
})()`);
await sleep(400);
const state0 = await evaluate(tab, `(() => {
	const seed = document.querySelector('input[placeholder="empty = random"]');
	const promptEl = document.querySelector('input[placeholder*="motion block"], input[placeholder*="모션 블록"]');
	const gen = document.querySelector('button.prompt-block-generate');
	return { seedValue: seed?.value ?? null, hasGenerate: !!gen, generateDisabled: !!gen?.disabled, hasPrompt: !!promptEl };
})()`);
console.log("initial:", JSON.stringify(state0));

if (!state0.hasGenerate || !state0.hasPrompt) {
	await shot(tab, "00-no-ui");
	throw new Error("studio UI not ready");
}
if (state0.seedValue === null) throw new Error("Prompt Blocks panel did not open");

// Set the prompt and generate: focus the field, then type via the Input
// domain so React's controlled input sees real key events.
await evaluate(tab, `(() => {
	const el = document.querySelector('input[placeholder*="motion block"], input[placeholder*="모션 블록"]');
	if (!el) return false;
	el.focus();
	el.select?.();
	return true;
})()`);
for (const key of ["a", " ", "p", "e", "r", "s", "o", "n", " ", "w", "a", "l", "k"]) {
	await tab.send("Input.dispatchKeyEvent", { type: "keyDown", text: key });
	await tab.send("Input.dispatchKeyEvent", { type: "keyUp", text: key });
}
await sleep(300);
await shot(tab, "01-before-generate");
const clicked = await evaluate(tab, `(() => {
const gen = document.querySelector('button.prompt-block-generate');
	if (!gen || gen.disabled) return false;
	gen.click();
	return true;
})()`);
if (!clicked) throw new Error("Kimodo bridge is unavailable or generation is disabled");
console.log("generate clicked, waiting for the clip...");

// Wait for "Motion loaded" or the PLAYBACK badge (generation ~12 s).
let loaded = false;
for (let i = 0; i < 40; i += 1) {
	await sleep(1000);
	const st = await evaluate(tab, `document.body.textContent.includes("Motion loaded") || document.body.textContent.includes("PLAYBACK")`);
	if (st) { loaded = true; break; }
}
console.log("motion loaded:", loaded);
if (!loaded) {
	await shot(tab, "02-generation-timeout");
	throw new Error("motion did not load within 40 s");
}
await sleep(1500);

// Scrub to specific frames by clicking the timeline's accessible ruler. The
// old tick-text selector clicked labels, not the scrub surface, after the
// timeline was redesigned.
const frames = [0, 20, 40, 60, 79];
for (const f of frames) {
	const point = await evaluate(tab, `(() => {
		const lane = document.querySelector('[role="slider"][aria-label*="Scrub timeline"], [role="slider"][aria-label*="타임라인"]');
		if (!lane) return null;
		const rect = lane.getBoundingClientRect();
		const max = Math.max(1, Number(lane.getAttribute('aria-valuemax')) || 1);
		return { x: rect.left + rect.width * Math.min(1, ${f} / max), y: rect.top + rect.height / 2 };
	})()`);
	if (!point) throw new Error("timeline scrub ruler not found");
	await tab.send("Input.dispatchMouseEvent", { type: "mouseMoved", x: point.x, y: point.y, button: "none" });
	await tab.send("Input.dispatchMouseEvent", { type: "mousePressed", x: point.x, y: point.y, button: "left", clickCount: 1 });
	await tab.send("Input.dispatchMouseEvent", { type: "mouseReleased", x: point.x, y: point.y, button: "left", clickCount: 1 });
	await sleep(700);
	await shot(tab, `10-frame-${String(f).padStart(2, "0")}`);
}

// Play a couple of seconds for a mid-stride live shot.
await evaluate(tab, `(() => {
	const play = [...document.querySelectorAll("button")].find(b => b.textContent.trim() === "▶");
	play?.click();
	return true;
})()`);
await sleep(1600);
await shot(tab, "20-playing-midstride");
await sleep(1600);
await shot(tab, "21-playing-later");
await evaluate(tab, `(() => {
	const pause = [...document.querySelectorAll("button")].find(b => /❚❚|⏸/.test(b.textContent.trim()));
	pause?.click();
	return true;
})()`);

// Camera close-up on the subject for a detailed pose check.
await evaluate(tab, `(() => {
	const chip = [...document.querySelectorAll("button")].find(b => /close-up/i.test(b.textContent));
	chip?.click();
	return true;
})()`);
await sleep(900);
await shot(tab, "30-closeup");

if (tab.consoleLog.length) {
	console.log("--- console errors/warnings ---");
	for (const line of [...new Set(tab.consoleLog)].slice(0, 15)) console.log(line);
} else {
	console.log("no console errors/warnings captured");
}
tab.ws.close();
console.log("visual QA capture complete");

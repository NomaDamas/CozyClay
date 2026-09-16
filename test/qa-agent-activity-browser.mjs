#!/usr/bin/env node
/** Browser QA for the Agent panel's activity line and explicit turn outcomes (#324).
 *
 * Runs against the REAL Studio (/app/) on the fixture studio transport: real
 * agent routes, real SSE, real motion job, fixture model. It records every
 * activity phrase the panel shows during a turn, forces three failures (an HTTP
 * refusal with an upstream detail, a sidecar usage limit, and a turn that
 * streams nothing at all) and saves desktop + 390px screenshots.
 *
 *   node test/qa-agent-activity-browser.mjs
 *
 * Evidence script; not part of the manifest (it owns its own Chrome and ports).
 */
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startFixtureStudio, sceneDocument } from "./fixtures/studio-agent-motion.mjs";
import { spawnOwned, terminateOwned } from "../tools/process-supervisor.mjs";

const port = Number(process.env.QA_PORT || 5204);
const cdp = Number(process.env.CDP_PORT || 9304);
const evidence = process.env.QA_SHOT_DIR || "/tmp/agent-activity-qa";
mkdirSync(evidence, { recursive: true });

const chromePath = [process.env.CHROME_PATH, "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome", "/usr/bin/google-chrome", "/usr/bin/chromium"].filter(Boolean).find(existsSync);
if (!chromePath) throw new Error("Google Chrome/Chromium not found; set CHROME_PATH");

let failures = 0;
const expect = (name, condition, detail = "") => {
	console.log(`${condition ? "PASS" : "FAIL"} ${name}${condition ? "" : ` — ${detail}`}`);
	if (!condition) failures += 1;
};
const shots = [];
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const fixture = await startFixtureStudio({ port, evidence });
const profileDir = mkdtempSync(join(tmpdir(), "cozyclay-activity-qa-"));
const chrome = spawnOwned(chromePath, [
	"--headless=new",
	`--remote-debugging-port=${cdp}`,
	`--user-data-dir=${profileDir}`,
	"--window-size=1440,900",
	"about:blank",
]);

let ws;
try {
	const deadline = Date.now() + 30000;
	let target = null;
	while (!target) {
		if (Date.now() > deadline) throw new Error("QA browser CDP startup timed out");
		try {
			const targets = await (await fetch(`http://127.0.0.1:${cdp}/json`)).json();
			target = targets.find((entry) => entry.type === "page" && entry.webSocketDebuggerUrl) || null;
		} catch { /* the browser is still coming up */ }
		if (!target) await sleep(100);
	}
	ws = new WebSocket(target.webSocketDebuggerUrl);
	await new Promise((resolve, reject) => { ws.onopen = resolve; ws.onerror = reject; });

	let nextId = 1;
	const pending = new Map();
	const paused = [];
	let onPaused = null;
	ws.onmessage = (event) => {
		const message = JSON.parse(event.data);
		if (message.method === "Fetch.requestPaused") {
			paused.push(message.params);
			onPaused?.(message.params);
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
	const waitFor = async (expression, timeoutMs = 30000) => {
		const until = Date.now() + timeoutMs;
		while (Date.now() < until) {
			if (await evaluate(expression).catch(() => false)) return true;
			await sleep(60);
		}
		return false;
	};
	const shot = async (name) => {
		const { data } = await send("Page.captureScreenshot", { format: "png" });
		const file = `${evidence}/${name}.png`;
		writeFileSync(file, Buffer.from(data, "base64"));
		shots.push(file);
		console.log(`     screenshot ${file}`);
		return file;
	};
	const viewport = (width, height) => send("Emulation.setDeviceMetricsOverride", { width, height, deviceScaleFactor: 1, mobile: false });
	const activityText = () => evaluate("document.querySelector('.agent-activity-text')?.textContent || ''");
	const activityLog = () => evaluate("window.__activity || []");
	// Phases are transient. Record them from the DOM as they happen instead of
	// sampling and hoping the poll lands inside the phase.
	const watchActivity = () => evaluate(`(() => {
		window.__activity = [];
		window.__activityObserver?.disconnect();
		const read = () => document.querySelector('.agent-activity-text')?.textContent || '';
		const push = () => { const text = read(); if (text && window.__activity.at(-1) !== text) window.__activity.push(text); };
		window.__activityObserver = new MutationObserver(push);
		window.__activityObserver.observe(document.body, { subtree: true, childList: true, characterData: true });
		push();
		return window.__activity;
	})()`);
	const type = (text) => evaluate(`(() => { const box = document.querySelector('.agent-input'); const setter = Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, 'value').set; setter.call(box, ${JSON.stringify(text)}); box.dispatchEvent(new Event('input', { bubbles: true })); })()`);
	const sendTurn = async (text) => { await type(text); await watchActivity(); await evaluate("document.querySelector('.agent-send').click()"); };
	const idle = () => waitFor("document.querySelector('.agent-activity')?.dataset.agentActivityKind === 'idle'", 60000);

	await send("Page.enable");
	await viewport(1440, 900);
	await send("Page.addScriptToEvaluateOnNewDocument", {
		source: `localStorage.setItem('cozyclay.scenes.v4', ${JSON.stringify(JSON.stringify(sceneDocument))});`
			+ `localStorage.setItem('cozyclay.locale', 'en');`
			+ `localStorage.setItem('cozyclay.project-session.v1', JSON.stringify({ name: 'QA', updatedAt: 1 }));`,
	});
	await send("Page.navigate", { url: `http://127.0.0.1:${port}/app/` });
	if (!await waitFor("!!window.__cozyclay?.rigA && !!document.querySelector('.view-menu-trigger')", 90000)) throw new Error("the studio never finished loading");

	// --- open the shared panel from the View menu -----------------------------
	await evaluate("document.querySelector('.view-menu-trigger').click()");
	if (!await waitFor("!!document.querySelector('.view-menu .agent-panel-toggle')")) throw new Error("the View menu never offered the agent panel");
	await evaluate("document.querySelector('.view-menu .agent-panel-toggle').click()");
	await waitFor("document.querySelector('.studio-agent-inspector')?.hidden === false");
	await evaluate("document.querySelector('.view-menu-trigger').click()");
	if (!await waitFor("!!document.querySelector('.agent-input')")) throw new Error("the composer never mounted");

	// --- idle ------------------------------------------------------------------
	expect("the panel advertises the model the sidecar answered with", await waitFor("document.querySelector('.agent-model-select')?.value === 'fixture-only'"), await evaluate("document.querySelector('.agent-model-select')?.value"));
	expect("the composer is only usable once a model is advertised", await evaluate("document.querySelector('.agent-input').disabled === false"));
	expect("an idle panel says Ready", (await activityText()) === "Ready", await activityText());
	expect("the idle line is marked as idle", await evaluate("document.querySelector('.agent-activity')?.dataset.agentActivityKind === 'idle'"));
	expect("the line is announced politely", await evaluate("document.querySelector('.agent-activity')?.getAttribute('aria-live') === 'polite'"));
	await shot("desktop-idle-ready");

	// --- a tool turn: Sending -> Running <tool> -> Done ------------------------
	await sendTurn("Put a cube on the floor one metre to camera-left of the selected character. Add a second character two metres to camera-right.");
	expect("a live turn reports itself immediately", await waitFor("document.querySelector('.agent-activity')?.dataset.agentActivityKind === 'live'", 15000));
	await waitFor("document.querySelector('.agent-activity')?.dataset.agentActivity === 'tool'", 60000);
	await shot("desktop-running-tool");
	expect("the turn ends with an explicit Done", await waitFor("document.querySelector('.agent-activity')?.dataset.agentActivity === 'done'", 120000), await activityText());
	const toolPhases = await activityLog();
	writeFileSync(`${evidence}/activity-tool-turn.json`, JSON.stringify(toolPhases, null, 2));
	expect("the line opens on Sending…", toolPhases.some((text) => text.startsWith("Sending…")), JSON.stringify(toolPhases));
	expect("an open tool call is named in plain words", toolPhases.some((text) => /^Running .+…/.test(text)), JSON.stringify(toolPhases));
	expect("every live phrase carries an elapsed clock", toolPhases.filter((text) => text.includes("·")).every((text) => / · \d+ s$|^Done · /.test(text)), JSON.stringify(toolPhases));
	expect("the outcome states how long it took", toolPhases.some((text) => /^Done · \d+ s$/.test(text)), JSON.stringify(toolPhases));
	await shot("desktop-done");
	await idle();

	// --- a motion job: the job's own phase and progress ------------------------
	fixture.controls.hold = Promise.withResolvers();
	await sendTurn("Make the selected character walk forward, wave, then return to the starting pose over the current shot range. Verify the full take and install it.");
	const reachedJob = await waitFor("document.querySelector('.agent-activity')?.dataset.agentActivity === 'job'", 120000);
	expect("a generation reports the job phase and its progress", reachedJob, await activityText());
	const jobLine = await activityText();
	expect("the job line reuses the runtime's phase and percentage", /^\w+ motion( \d+%)? · \d+ s$/.test(jobLine), jobLine);
	await shot("desktop-generating-motion");
	fixture.controls.hold.resolve();
	fixture.controls.hold = null;
	await waitFor("document.querySelector('.agent-activity')?.dataset.agentActivityKind !== 'live'", 180000);
	const jobPhases = await activityLog();
	writeFileSync(`${evidence}/activity-motion-turn.json`, JSON.stringify(jobPhases, null, 2));
	expect("the motion turn ends with an explicit outcome", /^(Done · \d+ s|Failed: .+|Stopped)$/.test(await activityText()), await activityText());
	await shot("desktop-motion-outcome");
	await idle();

	// --- forced failure 1: an HTTP refusal keeps its status and detail ---------
	await send("Fetch.enable", { patterns: [{ urlPattern: "*/agent/turn", requestStage: "Request" }] });
	const refuse = (responseCode, headers, body) => new Promise((resolve) => {
		onPaused = async (event) => {
			onPaused = null;
			await send("Fetch.fulfillRequest", { requestId: event.requestId, responseCode, responseHeaders: headers, body: Buffer.from(body).toString("base64") });
			resolve(event);
		};
	});
	const held = () => new Promise((resolve) => { onPaused = (event) => { onPaused = null; resolve(event); }; });
	let refused = refuse(400, [{ name: "content-type", value: "application/json" }], JSON.stringify({ error: { code: "upstream", message: "The requested model is not supported for this account." } }));
	await sendTurn("Inspect the current selection without changes.");
	await refused;
	expect("a refused turn ends as an explicit failure", await waitFor("document.querySelector('.agent-activity')?.dataset.agentActivity === 'failed'", 30000), await activityText());
	expect("the failure line carries the upstream status and detail", (await activityText()).startsWith("Failed: 400 — The requested model is not supported"), await activityText());
	expect("the transcript renders a failure card with a retry", await waitFor("!!document.querySelector('.agent-failure-card .agent-error-retry')"));
	expect("the failure card names the code the transport reported", (await evaluate("document.querySelector('.agent-failure-card')?.dataset.failureCode")) === "upstream");
	await shot("desktop-failed-http-400");

	// --- forced failure 2: a turn that streams nothing at all ------------------
	await idle();
	refused = refuse(200, [{ name: "content-type", value: "text/event-stream" }], "");
	await sendTurn("Inspect the current selection without changes.");
	await refused;
	expect("a turn that produces nothing is reported, not ignored", await waitFor("document.querySelector('.agent-activity')?.dataset.agentActivity === 'failed'", 60000), await activityText());
	expect("the silent turn says what happened", (await activityText()) === "Failed: no response", await activityText());
	expect("the silent turn leaves a failure card behind", await waitFor("[...document.querySelectorAll('.agent-failure-card')].some((card) => card.dataset.failureCode === 'no_output')"));
	await shot("desktop-failed-no-output");
	await send("Fetch.disable");

	// --- forced failure 3: the sidecar's own usage limit -----------------------
	await idle();
	fixture.controls.rateLimit = true;
	await sendTurn("Inspect the current selection without changes.");
	expect("a usage limit is a stated outcome, not silence", await waitFor("document.querySelector('.agent-activity')?.dataset.agentActivity === 'failed'", 60000), await activityText());
	expect("the usage limit is named in a few words", (await activityText()) === "Failed: usage limit reached", await activityText());
	expect("the paused card still explains the wait", await evaluate("!!document.querySelector('[data-agent-card=\"rate-limited\"]')"));
	await shot("desktop-failed-usage-limit");
	await evaluate("document.querySelector('.agent-paused-switch')?.click()");
	await idle();

	// --- 390px ------------------------------------------------------------------
	await viewport(390, 844);
	await waitFor("innerWidth === 390");
	// The studio stacks the inspector under the stage at this width, so the shots
	// are taken with the panel scrolled into view, the way an author reads it.
	const reveal = () => evaluate("(() => { document.querySelector('.agent-activity')?.scrollIntoView({ block: 'center' }); return document.querySelector('.agent-activity')?.getBoundingClientRect().top; })()");
	await reveal();
	expect("the panel still fits at 390px", await evaluate("document.documentElement.scrollWidth <= 390"), await evaluate("document.documentElement.scrollWidth"));
	expect("the activity line is readable in the narrow layout", await evaluate("(() => { const line = document.querySelector('.agent-activity'); if (!line) return false; const box = line.getBoundingClientRect(); return box.width > 0 && box.left >= 0 && box.right <= 390 && box.top >= 0 && box.bottom <= innerHeight; })()"));
	expect("the narrow panel shows a quiet Ready", (await activityText()) === "Ready", await activityText());
	await shot("mobile-390-idle-ready");
	// The request is held open by the debugger, so the narrow-width evidence is of
	// the live phase itself rather than of whatever the panel drifted to while the
	// screenshot was being taken.
	await send("Fetch.enable", { patterns: [{ urlPattern: "*/agent/turn", requestStage: "Request" }] });
	const inFlight = held();
	await sendTurn("Inspect the current selection without changes.");
	const stalled = await inFlight;
	expect("a request in flight is reported at 390px", await waitFor("document.querySelector('.agent-activity')?.dataset.agentActivity === 'sending'", 15000), await activityText());
	await reveal();
	await shot("mobile-390-sending");
	const firstClock = await activityText();
	expect("the elapsed clock keeps counting while the request is in flight", await waitFor(`document.querySelector('.agent-activity-text')?.textContent !== ${JSON.stringify(firstClock)}`, 5000), firstClock);
	await send("Fetch.fulfillRequest", { requestId: stalled.requestId, responseCode: 200, responseHeaders: [{ name: "content-type", value: "text/event-stream" }], body: "" });
	expect("the narrow turn ends with a stated outcome", await waitFor("document.querySelector('.agent-activity')?.dataset.agentActivityKind === 'terminal'", 60000), await activityText());
	await reveal();
	await shot("mobile-390-failed-no-output");
	expect("the outcome was still on screen when it was captured", await evaluate("document.querySelector('.agent-activity')?.dataset.agentActivityKind === 'terminal'"), await activityText());
	await send("Fetch.disable");
} finally {
	ws?.close();
	await terminateOwned(chrome);
	rmSync(profileDir, { recursive: true, force: true });
	await fixture.close();
}

console.log(`\nscreenshots (${shots.length}):`);
for (const file of shots) console.log(`  ${file}`);
if (failures) {
	console.error(`${failures} FAILURES`);
	process.exit(1);
}
console.log("qa-agent-activity-browser: all checks passed");
process.exit(0);

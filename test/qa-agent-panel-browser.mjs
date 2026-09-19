#!/usr/bin/env node
// Browser QA for the Agent panel, driven over CDP through tools/qa-browser.mjs.
// The Workflow half (#126) visits every state the issue enumerates against the
// mock transport (?agent=mock&state=...), asserts the real DOM, drives the
// scripted turn and clicks "Use in scene". The Studio half (#350) mounts the
// SAME component in the Inspector column and proves the surface it was given
// decides its chrome: Studio tool labels, Studio chips, no image hint, no
// History placeholder, and a receipt that lights the hierarchy row it changed.
// Screenshots land in QA_SHOT_DIR. Evidence script; not part of the manifest.
//
// The Studio half needs a live editor (the panel refuses to describe a scene it
// is not connected to), so run it against a dev server with a live hub:
//
//   COZYCLAY_LIVE_PORT=5650 npm run dev -- --host 127.0.0.1 --port 5530
//   QA_URL='http://127.0.0.1:5530/workflow/?agent=mock&state=ready' \
//   QA_SHOT_DIR=/tmp/qa-350 CDP_PORT=9350 \
//   node tools/qa-browser.mjs -- node test/qa-agent-panel-browser.mjs
import { mkdirSync, writeFileSync } from "node:fs";

const port = Number(process.env.CDP_PORT || 9222);
const shotDir = process.env.QA_SHOT_DIR || "/tmp/agent-panel-qa";
const baseUrl = new URL(process.env.QA_URL || "http://127.0.0.1:5306/workflow/?agent=mock&state=ready");
mkdirSync(shotDir, { recursive: true });

const targets = await (await fetch(`http://127.0.0.1:${port}/json`)).json();
const page = targets.find((target) => target.type === "page" && target.webSocketDebuggerUrl);
if (!page) throw new Error("no page target on the QA browser");
const ws = new WebSocket(page.webSocketDebuggerUrl);
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
	if (result.exceptionDetails) throw new Error(result.exceptionDetails.exception?.description || "evaluate failed");
	return result.result.value;
};
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const waitFor = async (expression, timeoutMs = 15000) => {
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

await send("Page.enable");
await send("Emulation.setDeviceMetricsOverride", { width: 1440, height: 900, deviceScaleFactor: 1, mobile: false });

const loadedOnce = () => new Promise((resolve) => {
	const onMessage = (event) => {
		if (JSON.parse(event.data).method !== "Page.loadEventFired") return;
		ws.removeEventListener("message", onMessage);
		resolve();
	};
	ws.addEventListener("message", onMessage);
});

async function open(state, params = {}) {
	const url = new URL(baseUrl);
	url.searchParams.set("agent", "mock");
	url.searchParams.set("state", state);
	// ?speed= slows the scripted turn down so a steer can be typed into a turn
	// that is genuinely still running.
	for (const [key, value] of Object.entries(params)) url.searchParams.set(key, String(value));
	const loaded = loadedOnce();
	await send("Page.navigate", { url: url.toString() });
	await loaded;
	const ready = await waitFor("!!document.querySelector('.agent-panel')", 30000);
	if (!ready) throw new Error(`agent panel never mounted for state=${state}`);
	// The auth-dependent chrome (account strip, composer) mounts only after the
	// transport reports a session, so wait for the state card this state owns
	// rather than driving a half-rendered panel.
	const settled = state === "signed-out" || state === "signing-in"
		? `!!document.querySelector('[data-agent-card="${state}"]')`
		: "!!document.querySelector('.agent-input') && !!document.querySelector('.agent-account')";
	if (!await waitFor(settled, 15000)) throw new Error(`agent panel never settled for state=${state}`);
	return url.toString();
}

async function shot(name) {
	const { data } = await send("Page.captureScreenshot", { format: "png", captureBeyondViewport: false });
	const file = `${shotDir}/${name}.png`;
	writeFileSync(file, Buffer.from(data, "base64"));
	console.log(`     screenshot ${file}`);
	return file;
}

const shots = [];

// --- layout contract, from the ready state --------------------------------
await open("ready");
expect("the panel mounts inside .workflow-main", await evaluate("!!document.querySelector('.workflow-main > .agent-panel')"));
expect("the panel is the sibling AFTER .workflow-canvas", await evaluate("document.querySelector('.workflow-canvas')?.nextElementSibling?.classList.contains('agent-panel') === true"));
expect("the panel opens at 360px", await evaluate("Math.round(document.querySelector('.agent-panel').getBoundingClientRect().width) === 360"));
expect("the transcript is an aria-live region", await evaluate("document.querySelector('.agent-transcript')?.getAttribute('aria-live') === 'polite'"));
expect("focus lands on the composer when the panel opens", await waitFor("document.activeElement?.classList.contains('agent-input') === true", 8000));
expect("the ready state offers three suggestion chips", await evaluate("document.querySelectorAll('[data-agent-card=\"ready\"] .agent-chip').length === 3"));
expect("the footer states the image cost", await evaluate("/about 3-5x a normal turn/.test(document.querySelector('.agent-footer-hint')?.textContent || '')"));
expect("the account strip names the signed-in account", await evaluate("/@/.test(document.querySelector('.agent-account-email')?.textContent || '')"));
shots.push(await shot("ready"));

// a chip prefills the composer
await evaluate("document.querySelector('[data-agent-card=\"ready\"] .agent-chip').click()");
expect("a suggestion chip prefills the composer", await waitFor("document.querySelector('.agent-input')?.value.length > 8", 5000));

// --- drag handle + persistence --------------------------------------------
const handleBox = await evaluate("(() => { const r = document.querySelector('.agent-resize').getBoundingClientRect(); return { x: r.x + r.width / 2, y: r.y + 300 }; })()");
await send("Input.dispatchMouseEvent", { type: "mousePressed", x: handleBox.x, y: handleBox.y, button: "left", clickCount: 1 });
await send("Input.dispatchMouseEvent", { type: "mouseMoved", x: handleBox.x - 90, y: handleBox.y, button: "left" });
await send("Input.dispatchMouseEvent", { type: "mouseReleased", x: handleBox.x - 90, y: handleBox.y, button: "left", clickCount: 1 });
expect("dragging the handle widens the panel", await waitFor("Math.round(document.querySelector('.agent-panel').getBoundingClientRect().width) === 450", 5000), await evaluate("document.querySelector('.agent-panel').getBoundingClientRect().width"));
expect("the width is persisted under the agreed key", await evaluate("localStorage.getItem('cozyclay.workflow.agentPanel.width') === '450'"));
shots.push(await shot("resized-450"));

// clamp: a drag well past the maximum stops at 560
await send("Input.dispatchMouseEvent", { type: "mousePressed", x: handleBox.x - 90, y: handleBox.y, button: "left", clickCount: 1 });
await send("Input.dispatchMouseEvent", { type: "mouseMoved", x: 40, y: handleBox.y, button: "left" });
await send("Input.dispatchMouseEvent", { type: "mouseReleased", x: 40, y: handleBox.y, button: "left", clickCount: 1 });
expect("the drag clamps at the 560px maximum", await waitFor("Math.round(document.querySelector('.agent-panel').getBoundingClientRect().width) === 560", 5000));
await evaluate("localStorage.setItem('cozyclay.workflow.agentPanel.width', '360')");

// --- collapse: rail + keyboard --------------------------------------------
await open("ready");
await evaluate("document.querySelector('.agent-collapse').click()");
expect("collapsing leaves a 36px rail", await waitFor("(() => { const rail = document.querySelector('.agent-panel.collapsed'); return !!rail && Math.round(rail.getBoundingClientRect().width) === 36; })()", 5000));
expect("the rail carries a status dot", await evaluate("!!document.querySelector('.agent-panel.collapsed .agent-status-dot')"));
expect("the rail does not hover-reveal", await evaluate("(() => { const rail = document.querySelector('.agent-panel.collapsed'); rail.dispatchEvent(new MouseEvent('mouseover', { bubbles: true })); return Math.round(rail.getBoundingClientRect().width) === 36; })()"));
shots.push(await shot("collapsed-rail"));
for (const type of ["keyDown", "keyUp"]) {
	await send("Input.dispatchKeyEvent", { type, key: "b", code: "KeyB", windowsVirtualKeyCode: 66, modifiers: 2 });
}
expect("Ctrl/Cmd+B re-opens the panel", await waitFor("!document.querySelector('.agent-panel.collapsed') && !!document.querySelector('.agent-panel')", 5000));
expect("the top-bar button toggles the panel too", await (async () => {
	await evaluate("document.querySelector('.workflow-agent-toggle').click()");
	return waitFor("!!document.querySelector('.agent-panel.collapsed')", 5000);
})());

// --- overlay drawer below 1100px ------------------------------------------
await send("Emulation.setDeviceMetricsOverride", { width: 1000, height: 900, deviceScaleFactor: 1, mobile: false });
await open("ready");
expect("below 1100px the panel is an overlay drawer", await waitFor("getComputedStyle(document.querySelector('.agent-panel')).position === 'fixed'", 8000));
shots.push(await shot("overlay-drawer"));
await send("Emulation.setDeviceMetricsOverride", { width: 1440, height: 900, deviceScaleFactor: 1, mobile: false });

// --- auth states -----------------------------------------------------------
await open("signed-out");
expect("signed-out shows the Sign in with ChatGPT card", await waitFor("!!document.querySelector('[data-agent-card=\"signed-out\"] .agent-signin')", 8000));
expect("signed-out offers no composer at all", await evaluate("!document.querySelector('.agent-input') && !document.querySelector('.agent-footer-hint')"));
expect("signed-out shows no account strip", await evaluate("!document.querySelector('.agent-account')"));
expect("the panel reports the signed-out state", await evaluate("document.querySelector('.agent-panel')?.dataset.agentState === 'signed-out'"));
shots.push(await shot("signed-out"));

await open("signing-in");
expect("signing-in shows the waiting card", await waitFor("!!document.querySelector('[data-agent-card=\"signing-in\"] .agent-spinner')", 8000));
expect("the panel reports the signing-in state", await evaluate("document.querySelector('.agent-panel')?.dataset.agentState === 'signing-in'"));
shots.push(await shot("signing-in"));

await open("no-entitlement");
expect("no-entitlement explains the missing image plan", await waitFor("!!document.querySelector('[data-agent-card=\"no-entitlement\"]')", 8000));
expect("no-entitlement still shows the account strip", await evaluate("!!document.querySelector('.agent-account')"));
expect("no-entitlement keeps the composer usable for chat", await evaluate("document.querySelector('.agent-input')?.disabled === false"));
expect("the panel reports the no-entitlement state", await evaluate("document.querySelector('.agent-panel')?.dataset.agentState === 'no-entitlement'"));
shots.push(await shot("no-entitlement"));

// --- streaming: the scripted turn, typed into the real composer ------------
await open("ready");
await evaluate("(() => { const t = document.querySelector('.agent-input'); const setter = Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, 'value').set; setter.call(t, 'Give me a wide two-shot of this scene'); t.dispatchEvent(new Event('input', { bubbles: true })); })()");
expect("typing enables Send", await waitFor("document.querySelector('.agent-send:not(.stop)')?.disabled === false", 5000));
await evaluate("document.querySelector('.agent-attach-chip').click()");
expect("the attach chip toggles on with a thumbnail", await waitFor("document.querySelector('.agent-attach-chip')?.getAttribute('aria-pressed') === 'true' && !!document.querySelector('.agent-attach-thumb')", 5000));
await evaluate("document.querySelector('.agent-send').click()");
expect("the turn echoes the prompt as a right-aligned bubble", await waitFor("!!document.querySelector('.agent-row.user .agent-bubble')", 8000));
expect("user bubbles are right-aligned", await evaluate("getComputedStyle(document.querySelector('.agent-row.user')).alignItems === 'flex-end'"));
expect("streaming swaps Send for Stop", await waitFor("!!document.querySelector('.agent-send.stop')", 8000));
expect("the panel reports the streaming state", await evaluate("document.querySelector('.agent-panel')?.dataset.agentState === 'streaming'"));
expect("assistant text streams in bare (no bubble)", await waitFor("(document.querySelector('.agent-row.assistant .agent-assistant-text')?.textContent || '').length > 10", 8000));
expect("the capture tool card appears while running", await waitFor("!!document.querySelector('[data-tool-name=\"capture_blocking_frame\"]')", 8000));
shots.push(await shot("streaming"));

expect("the capture tool completes", await waitFor("document.querySelector('[data-tool-name=\"capture_blocking_frame\"]')?.dataset.toolStatus === 'done'", 10000));
expect("the render tool runs after the capture", await waitFor("!!document.querySelector('[data-tool-name=\"render_from_frame\"]')", 10000));
expect("tool cards read as verb + target", await evaluate("document.querySelector('[data-tool-name=\"capture_blocking_frame\"] .agent-tool-label')?.textContent === 'Capture blocking frame'"));
expect("a completed tool card shows its elapsed time", await waitFor("/\\d/.test(document.querySelector('[data-tool-name=\"render_from_frame\"] .agent-tool-elapsed')?.textContent || '')", 10000));
expect("the image result card arrives", await waitFor("!!document.querySelector('.agent-image-card img')", 12000));
expect("the turn finishes and Stop reverts to Send", await waitFor("!document.querySelector('.agent-send.stop')", 12000));
expect("the account strip picks up the plan from the quota event", await evaluate("(document.querySelector('.agent-plan-badge')?.textContent || '').trim() === 'Plus'"));
expect("the image card offers Use in scene / Download / Regenerate", await evaluate("['.agent-image-use', '.agent-image-download', '.agent-image-regenerate'].every((sel) => !!document.querySelector(sel))"));
shots.push(await shot("turn-complete"));

// a tool card expands to its details
await evaluate("document.querySelector('[data-tool-name=\"render_from_frame\"] summary').click()");
expect("tool cards expand to raw args/result", await waitFor("!!document.querySelector('[data-tool-name=\"render_from_frame\"] details[open] .agent-tool-detail')", 5000));

// lightbox
await evaluate("document.querySelector('.agent-image-card img').click()");
expect("clicking the image opens the lightbox", await waitFor("!!document.querySelector('.agent-lightbox img')", 5000));
shots.push(await shot("lightbox"));
await evaluate("document.querySelector('.agent-lightbox').click()");
expect("clicking the lightbox closes it", await waitFor("!document.querySelector('.agent-lightbox')", 5000));

// Use in scene -> Placed · Undo
await evaluate("document.querySelector('.agent-image-use').click()");
expect("Use in scene flips the card to Placed", await waitFor("document.querySelector('.agent-image-card')?.dataset.placed === 'true' && /Placed/.test(document.querySelector('.agent-placed')?.textContent || '')", 6000));
expect("the placed card offers Undo", await evaluate("!!document.querySelector('.agent-image-undo')"));
shots.push(await shot("use-in-scene-placed"));
await evaluate("document.querySelector('.agent-image-undo').click()");
expect("Undo restores the image actions", await waitFor("!!document.querySelector('.agent-image-use') && !document.querySelector('.agent-placed')", 6000));

// --- Esc stops a running turn ---------------------------------------------
await open("ready");
await evaluate("(() => { const t = document.querySelector('.agent-input'); const setter = Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, 'value').set; setter.call(t, 'stop me'); t.dispatchEvent(new Event('input', { bubbles: true })); t.focus(); })()");
await evaluate("document.querySelector('.agent-send').click()");
expect("a turn starts before the stop", await waitFor("!!document.querySelector('.agent-send.stop')", 8000));
for (const type of ["keyDown", "keyUp"]) {
	await send("Input.dispatchKeyEvent", { type, key: "Escape", code: "Escape", windowsVirtualKeyCode: 27 });
}
expect("Esc stops the running turn", await waitFor("!document.querySelector('.agent-send.stop')", 8000));

// --- rate-limited ----------------------------------------------------------
await open("rate-limited");
expect("rate-limited renders the inline paused card", await waitFor("!!document.querySelector('[data-agent-card=\"rate-limited\"]')", 15000));
expect("the paused card counts down to the reset", await waitFor("/resets in \\d/.test(document.querySelector('.agent-paused-countdown')?.textContent || '')", 8000));
expect("the paused card offers Wait & retry and Switch model", await evaluate("!!document.querySelector('.agent-paused-wait') && !!document.querySelector('.agent-paused-switch')"));
expect("rate-limited disables the composer", await evaluate("document.querySelector('.agent-input').disabled === true"));
expect("the panel reports the rate-limited state", await evaluate("document.querySelector('.agent-panel')?.dataset.agentState === 'rate-limited'"));
const firstCountdown = await evaluate("document.querySelector('.agent-paused-countdown').textContent");
shots.push(await shot("rate-limited"));
expect("the countdown is live", await waitFor(`document.querySelector('.agent-paused-countdown')?.textContent !== ${JSON.stringify(firstCountdown)}`, 4000), firstCountdown);
await evaluate("document.querySelector('.agent-paused-switch').click()");
expect("Switch model clears the paused card and re-enables the composer", await waitFor("!document.querySelector('[data-agent-card=\"rate-limited\"]') && document.querySelector('.agent-input').disabled === false", 6000));

// --- error -----------------------------------------------------------------
await open("error");
expect("the failing tool call is marked failed", await waitFor("document.querySelector('[data-tool-name=\"capture_blocking_frame\"]')?.dataset.toolStatus === 'failed'", 15000));
expect("the error card is attached to the failing tool call", await evaluate("!!document.querySelector('[data-tool-status=\"failed\"] .agent-error')"));
expect("the error card offers Retry and Details", await evaluate("!!document.querySelector('.agent-error-retry') && !!document.querySelector('.agent-error-details')"));
expect("the panel reports the error state", await evaluate("document.querySelector('.agent-panel')?.dataset.agentState === 'error'"));
shots.push(await shot("error"));
await evaluate("document.querySelector('.agent-error-details').click()");
expect("Details expands the failing tool call", await waitFor("!!document.querySelector('[data-tool-status=\"failed\"] details[open]')", 5000));

// --- header controls -------------------------------------------------------
await open("ready");
await evaluate("document.querySelector('.agent-overflow-toggle').click()");
expect("the overflow menu offers Clear context and Sign out", await waitFor("(() => { const items = [...document.querySelectorAll('.agent-menu button')].map((b) => b.textContent); return items.includes('Clear context') && items.includes('Sign out'); })()", 5000));
shots.push(await shot("overflow-menu"));

// --- provider keys (#379) --------------------------------------------------
// The menu opens an INLINE section (no modal) that lists the API-key providers
// the sidecar reports. A key is typed into a password field, saved through the
// scripted sidecar, and the page is then searched for it: the panel manages
// credentials without ever showing one.
const providerRow = (id) => `document.querySelector('[data-provider="${id}"]')`;
const typeKey = (id, value) => evaluate(`(() => { const input = document.querySelector('[data-provider="${id}"] .agent-key-input'); const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set; setter.call(input, ${JSON.stringify(value)}); input.dispatchEvent(new Event('input', { bubbles: true })); })()`);

expect("the overflow menu offers Provider keys…", await waitFor("[...document.querySelectorAll('.agent-menu button')].some((b) => b.textContent.startsWith('Provider keys'))", 5000),
	await evaluate("[...document.querySelectorAll('.agent-menu button')].map((b) => b.textContent).join(',')"));
await evaluate("[...document.querySelectorAll('.agent-menu button')].find((b) => b.textContent.startsWith('Provider keys')).click()");
expect("the menu item opens an inline section inside the panel, not a modal", await waitFor("!!document.querySelector('.agent-panel .agent-keys') && !document.querySelector('[role=\"dialog\"]')", 8000));
expect("the section lists the four API-key providers and never ChatGPT", await waitFor("document.querySelectorAll('.agent-key-row').length === 4 && !document.querySelector('[data-provider=\"openai-codex\"]')", 8000),
	await evaluate("[...document.querySelectorAll('.agent-key-row')].map((r) => r.dataset.provider).join(',')"));
expect("every key field is a password field", await evaluate("[...document.querySelectorAll('.agent-key-input')].every((input) => input.type === 'password')"));
expect("an env-backed provider is disabled and names the variable it is set by", await evaluate("(() => { const row = document.querySelector('[data-provider-source=\"env\"]'); if (!row) return false; const input = row.querySelector('.agent-key-input'); return input.disabled === true && /^set by [A-Z_]+( or [A-Z_]+)?$/.test(input.placeholder) && row.querySelector('.agent-key-source').textContent === 'environment'; })()"),
	await evaluate("document.querySelector('[data-provider-source=\"env\"]')?.innerText"));
expect("an unconfigured provider shows a grey dot and offers no Remove", await evaluate(`(() => { const row = ${providerRow("anthropic")}; return row.dataset.providerSignedIn === 'false' && !row.querySelector('.agent-status-dot.ok') && !row.querySelector('.agent-key-remove'); })()`));
shots.push(await shot("provider-keys-open"));

// happy path: the scripted sidecar accepts the key
await typeKey("anthropic", "sk-test-123");
expect("typing a key enables Save", await waitFor("document.querySelector('[data-provider=\"anthropic\"] .agent-key-save').disabled === false", 5000));
await evaluate("document.querySelector('[data-provider=\"anthropic\"] .agent-key-save').click()");
expect("saving turns that provider's dot green and states where the key lives", await waitFor(`(() => { const row = ${providerRow("anthropic")}; return row.dataset.providerSignedIn === 'true' && !!row.querySelector('.agent-status-dot.ok') && /saved on this machine/.test(row.innerText); })()`, 8000),
	await evaluate(`${providerRow("anthropic")}?.innerText`));
expect("a stored key can be removed from the same row", await evaluate("!!document.querySelector('[data-provider=\"anthropic\"] .agent-key-remove')"));
expect("the input is emptied the moment the key is stored", await evaluate("document.querySelector('[data-provider=\"anthropic\"] .agent-key-input').value === ''"));
expect("no key material is anywhere in the page text", await evaluate("!document.body.innerText.includes('sk-test')"));
expect("no key material survives anywhere in the DOM", await evaluate("!document.documentElement.outerHTML.includes('sk-test-123')"));
shots.push(await shot("panel-provider-keys"));

// failure path: the sidecar refuses the key with a 400
await typeKey("openrouter", "sk-no");
await evaluate("document.querySelector('[data-provider=\"openrouter\"] .agent-key-save').click()");
expect("a refused key is explained under its own input and leaves the dot grey", await waitFor(`(() => { const row = ${providerRow("openrouter")}; return !!row.querySelector('.agent-key-error') && !row.querySelector('.agent-status-dot.ok') && row.dataset.providerSignedIn === 'false'; })()`, 8000),
	await evaluate(`${providerRow("openrouter")}?.innerText`));
expect("the refusal never quotes the key it refused", await evaluate("!document.body.innerText.includes('sk-no')"));
expect("the provider that did save is untouched by the refusal", await evaluate(`${providerRow("anthropic")}.dataset.providerSignedIn === 'true'`));
shots.push(await shot("provider-keys-refused"));

// the section has to survive the narrow panel too
await send("Emulation.setDeviceMetricsOverride", { width: 390, height: 844, deviceScaleFactor: 1, mobile: true });
expect("the section fits a phone-width panel", await waitFor("(() => { const section = document.querySelector('.agent-keys'); if (!section) return false; const box = section.getBoundingClientRect(); return box.width > 0 && box.left >= 0 && box.right <= innerWidth + 1; })()", 5000),
	await evaluate("JSON.stringify(document.querySelector('.agent-keys')?.getBoundingClientRect())"));
expect("nothing scrolls sideways at 390px", await evaluate("document.documentElement.scrollWidth <= innerWidth + 1"));
shots.push(await shot("provider-keys-390"));
await send("Emulation.setDeviceMetricsOverride", { width: 1440, height: 900, deviceScaleFactor: 1, mobile: false });

await evaluate("document.querySelector('.agent-keys-close').click()");
expect("closing the section leaves the conversation where it was", await waitFor("!document.querySelector('.agent-keys') && !!document.querySelector('.agent-transcript')", 5000));
await evaluate("document.querySelector('.agent-overflow-toggle').click()");
await waitFor("[...document.querySelectorAll('.agent-menu button')].some((b) => b.textContent === 'Sign out')", 5000);
await evaluate("[...document.querySelectorAll('.agent-menu button')].find((b) => b.textContent === 'Sign out').click()");
expect("Sign out returns the panel to signed-out", await waitFor("document.querySelector('.agent-panel')?.dataset.agentState === 'signed-out'", 6000));

// --- a saved key is a way in, immediately (#379) ---------------------------
// Readiness is `signedIn || providersConfigured > 0`. An author who never
// signed in to ChatGPT and saves their first provider key must land in a
// composer there and then, without reloading the page, and must be handed back
// to the sign-in card when that key is removed. The scripted sidecar counts
// the session reads it answers, so the count proves the panel asks once per
// write instead of polling for it.
const statusCalls = () => evaluate("localStorage.getItem('cozyclay.mock.agent.status-calls')");
await open("signed-out");
expect("a signed-out session offers no composer to begin with", await evaluate("!document.querySelector('.agent-composer') && !!document.querySelector('[data-agent-card=\"signed-out\"]')"));
// A page-lifetime marker: if the composer only arrives with a new document,
// this is gone and the assertion below says so.
await evaluate("localStorage.setItem('cozyclay.mock.agent.status-calls', '0'); window.__readinessMark = 'kept';");
await evaluate("document.querySelector('.agent-overflow-toggle').click()");
await waitFor("!!document.querySelector('.agent-menu-keys')", 5000);
await evaluate("document.querySelector('.agent-menu-keys').click()");
expect("the keys section opens for a signed-out session too", await waitFor(`!!document.querySelector('[data-provider="anthropic"] .agent-key-input')`, 8000));
await typeKey("anthropic", "sk-readiness-123");
await waitFor(`document.querySelector('[data-provider="anthropic"] .agent-key-save').disabled === false`, 5000);
await evaluate(`document.querySelector('[data-provider="anthropic"] .agent-key-save').click()`);
expect("saving the first key brings the composer up without a reload", await waitFor("!!document.querySelector('.agent-composer') && document.querySelector('.agent-panel')?.dataset.agentState === 'ready'", 8000),
	await evaluate("JSON.stringify({ state: document.querySelector('.agent-panel')?.dataset.agentState, composer: !!document.querySelector('.agent-composer') })"));
expect("the sign-in card gives way to the session it now has", await evaluate("!document.querySelector('[data-agent-card=\"signed-out\"]')"));
expect("the page was never reloaded", await evaluate("window.__readinessMark === 'kept'"));
expect("the save re-read the session exactly once", await statusCalls() === "1", String(await statusCalls()));
shots.push(await shot("panel-keys-readiness-after-save"));
await evaluate(`document.querySelector('[data-provider="anthropic"] .agent-key-remove').click()`);
expect("removing the last key puts the sign-in gate back, still without a reload", await waitFor("!document.querySelector('.agent-composer') && !!document.querySelector('[data-agent-card=\"signed-out\"]')", 8000),
	await evaluate("JSON.stringify({ state: document.querySelector('.agent-panel')?.dataset.agentState, composer: !!document.querySelector('.agent-composer') })"));
expect("the removal re-read the session exactly once too", await statusCalls() === "2", String(await statusCalls()));
expect("the panel never reloaded to get there either", await evaluate("window.__readinessMark === 'kept'"));
shots.push(await shot("panel-keys-readiness-after-remove"));

/* ===================== provider-grouped models + steering (#379) ========= */

// Five providers answer the scripted /agent/models: two hold a credential and
// three are waiting for a key. Everything below is asserted on the real DOM of
// the dock, at 1440 and at 390.
// A composer click is only real once the panel has taken the text: Send and
// Steer stay disabled until the store has the draft, so that is the signal to
// wait for rather than a sleep after typing.
const clickWhenEnabled = async (selector) => {
	if (!await waitFor(`!!document.querySelector(${JSON.stringify(`${selector}:not([disabled])`)})`, 8000)) throw new Error(`${selector} never became clickable`);
	await evaluate(`document.querySelector(${JSON.stringify(selector)}).click()`);
};
const setValue = (selector, value) => evaluate(`(() => { const node = document.querySelector(${JSON.stringify(selector)}); const proto = node instanceof window.HTMLSelectElement ? window.HTMLSelectElement.prototype : window.HTMLTextAreaElement.prototype; Object.getOwnPropertyDescriptor(proto, 'value').set.call(node, ${JSON.stringify(value)}); node.dispatchEvent(new Event(node instanceof window.HTMLSelectElement ? 'change' : 'input', { bubbles: true })); return node.value; })()`);

await evaluate("localStorage.removeItem('cozyclay.agent.model')");
await open("ready");
expect("the model dropdown is grouped, one optgroup per provider", await waitFor("document.querySelectorAll('.agent-model-select optgroup').length === 5", 10000),
	String(await evaluate("document.querySelectorAll('.agent-model-select optgroup').length")));
expect("every group is labelled with the provider that serves it", await evaluate("[...document.querySelectorAll('.agent-model-select optgroup')].every((group) => group.label.length > 2)"),
	await evaluate("JSON.stringify([...document.querySelectorAll('.agent-model-select optgroup')].map((group) => group.label))"));
expect("every option is a provider/model key", await evaluate("[...document.querySelectorAll('.agent-model-select:not(.agent-effort-select) option')].every((option) => option.value.includes('/'))"),
	await evaluate("JSON.stringify([...document.querySelectorAll('.agent-model-select:not(.agent-effort-select) option')].map((option) => option.value))"));
const disabledOption = await evaluate("(() => { const option = [...document.querySelectorAll('.agent-model-select:not(.agent-effort-select) option')].find((entry) => entry.disabled); return option ? { value: option.value, text: option.textContent, group: option.closest('optgroup')?.label } : null; })()");
expect("a provider without a key is still listed, disabled, and says what it needs", Boolean(disabledOption) && /\u2014 add key$/.test(disabledOption.text || ""), JSON.stringify(disabledOption));
expect("the panel opens on a model whose provider holds a credential", await evaluate("document.querySelector('.agent-model-select').selectedOptions[0]?.disabled === false"),
	await evaluate("document.querySelector('.agent-model-select').value"));
expect("the effort select offers the selected model's levels, its default first", await evaluate("(() => { const effort = document.querySelector('.agent-effort-select'); return !!effort && effort.options.length >= 2 && / \u00b7 default$/.test(effort.options[0].textContent); })()"),
	await evaluate("JSON.stringify([...document.querySelectorAll('.agent-effort-select option')].map((option) => option.textContent))"));
// A native dropdown draws its list outside the page, so the grouped structure
// is recorded here as well as screenshotted.
console.log(`     model select: ${await evaluate("JSON.stringify([...document.querySelectorAll('.agent-model-select:not(.agent-effort-select) optgroup')].map((group) => ({ provider: group.label, options: [...group.children].map((option) => option.value + (option.disabled ? ' (disabled: ' + option.textContent + ')' : '')) })))")}`);
shots.push(await shot("panel-optgroups-1440"));

// Happy path: pick another provider's model and the turn is sent with THAT key.
const picked = await evaluate("(() => { const select = document.querySelector('.agent-model-select'); const option = [...select.options].find((entry) => !entry.disabled && !entry.value.startsWith('openai-codex/')); return option?.value ?? null; })()");
expect("a second provider has a model that can be picked", typeof picked === "string" && picked.includes("/"), String(picked));
await setValue(".agent-model-select", picked);
const pickedEfforts = await evaluate("JSON.stringify([...document.querySelectorAll('.agent-effort-select option')].map((option) => option.value))");
expect("the effort list follows the model that was picked", JSON.parse(pickedEfforts).length > 0, pickedEfforts);
await setValue(".agent-input", "Give me a wide two-shot of this scene");
await clickWhenEnabled(".agent-send:not(.stop)");
expect("the turn is sent with the provider-qualified key of the chosen model", await waitFor(`(() => { try { return JSON.parse(localStorage.getItem('cozyclay.mock.agent.last-turn'))?.model === ${JSON.stringify(picked)}; } catch { return false; } })()`, 10000),
	await evaluate("localStorage.getItem('cozyclay.mock.agent.last-turn')"));
expect("the turn carries the effort the model advertised", await evaluate("(() => { try { const turn = JSON.parse(localStorage.getItem('cozyclay.mock.agent.last-turn')); return turn.effort === null || typeof turn.effort === 'string'; } catch { return false; } })()"));
await waitFor("!document.querySelector('.agent-send.stop')", 20000);

// The choice is a preference, not a per-session accident.
await open("ready");
expect("the panel reopens on the model that was picked", await waitFor(`document.querySelector('.agent-model-select')?.value === ${JSON.stringify(picked)}`, 10000),
	await evaluate("document.querySelector('.agent-model-select')?.value"));

// --- the phone-width dock ---------------------------------------------------
await send("Emulation.setDeviceMetricsOverride", { width: 390, height: 844, deviceScaleFactor: 1, mobile: true });
await open("ready");
expect("the grouped dropdown survives the phone-width drawer", await waitFor("document.querySelectorAll('.agent-model-select optgroup').length === 5", 10000));
// The dock is a drawer pinned to the right of a canvas that is wider than a
// phone, so the panel has to be scrolled to before it can be judged — and the
// evidence has to be framed on it, not on the empty canvas beside it.
await evaluate("document.querySelector('.agent-composer').scrollIntoView({ inline: 'end', block: 'end' })");
expect("the drawer is wholly on screen once it is scrolled to", await waitFor("(() => { const rect = document.querySelector('.agent-panel').getBoundingClientRect(); return rect.width >= 300 && rect.left >= -1 && rect.right <= innerWidth + 1; })()", 5000),
	await evaluate("JSON.stringify(document.querySelector('.agent-panel').getBoundingClientRect())"));
expect("the model select and the effort select share the row without clipping", await evaluate("(() => { const [model, effort] = [document.querySelector('.agent-model-select:not(.agent-effort-select)'), document.querySelector('.agent-effort-select')]; const rects = [model, effort].map((node) => node.getBoundingClientRect()); return rects.every((rect) => rect.width > 0 && rect.left >= 0 && rect.right <= innerWidth + 1) && rects[0].right <= rects[1].left + 1; })()"),
	await evaluate("JSON.stringify([document.querySelector('.agent-model-select:not(.agent-effort-select)').getBoundingClientRect(), document.querySelector('.agent-effort-select').getBoundingClientRect()])"));
expect("the whole composer is on screen at 390px, not below the fold", await evaluate("(() => { const rect = document.querySelector('.agent-composer').getBoundingClientRect(); return rect.top >= 0 && rect.bottom <= innerHeight + 1 && rect.right <= innerWidth + 1; })()"),
	await evaluate("JSON.stringify({ composer: document.querySelector('.agent-composer').getBoundingClientRect(), viewport: [innerWidth, innerHeight] })"));
expect("the Send button is reachable at 390px", await evaluate("(() => { const rect = document.querySelector('.agent-send').getBoundingClientRect(); return rect.width > 0 && rect.right <= innerWidth + 1 && rect.bottom <= innerHeight + 1; })()"),
	await evaluate("JSON.stringify(document.querySelector('.agent-send').getBoundingClientRect())"));
shots.push(await shot("panel-optgroups-390"));
await send("Emulation.setDeviceMetricsOverride", { width: 1440, height: 900, deviceScaleFactor: 1, mobile: false });

// --- steering a turn that is still running ----------------------------------
await open("ready", { speed: 0.15 });
await setValue(".agent-input", "Block a two-shot in this scene");
await clickWhenEnabled(".agent-send:not(.stop)");
expect("a running turn keeps Stop and offers Steer", await waitFor("!!document.querySelector('.agent-send.stop') && !!document.querySelector('.agent-send.agent-steer')", 15000));
expect("Steer is disabled until there is something to say", await evaluate("document.querySelector('.agent-send.agent-steer').disabled === true"));
const steerText = "actually, make it a low angle";
await setValue(".agent-input", steerText);
await clickWhenEnabled(".agent-send.agent-steer");
expect("the steer reaches the turn that is still running", await waitFor(`(() => { try { return JSON.parse(localStorage.getItem('cozyclay.mock.agent.last-steer'))?.text === ${JSON.stringify(steerText)}; } catch { return false; } })()`, 15000),
	await evaluate("localStorage.getItem('cozyclay.mock.agent.last-steer')"));
expect("an accepted steer joins the transcript and empties the composer", await waitFor("document.querySelectorAll('.agent-row.user').length === 2 && document.querySelector('.agent-input').value === ''", 8000),
	await evaluate("document.querySelectorAll('.agent-row.user').length + ' rows'"));
expect("the turn is still streaming after the steer", await evaluate("document.querySelector('.agent-panel')?.dataset.agentState === 'streaming'"));
shots.push(await shot("panel-steer"));

// Failure probe: the scripted turn holds its stream open for a moment after the
// last frame, exactly as the sidecar does while it closes the turn out. A steer
// inside that window is the 409 the route answers, and the panel has to say so
// instead of eating the text.
// The probe starts at the last visible frame of the turn and keeps offering the
// same text until either the turn takes it or the panel stops streaming, so it
// is bounded by the turn itself rather than by a sleep.
await waitFor("!!document.querySelector('.agent-image-card')", 30000);
let steerNotice = "";
for (let attempt = 0; attempt < 1000; attempt += 1) {
	const probe = await evaluate("(() => { const notice = document.querySelector('.agent-steer-notice')?.textContent || ''; const button = document.querySelector('.agent-send.agent-steer'); const input = document.querySelector('.agent-input'); if (!notice && button && input && input.value !== 'too late') { Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, 'value').set.call(input, 'too late'); input.dispatchEvent(new Event('input', { bubbles: true })); } return { notice, steerable: !!button }; })()");
	steerNotice = probe.notice;
	if (steerNotice || !probe.steerable) break;
	await evaluate("document.querySelector('.agent-send.agent-steer:not([disabled])')?.click()");
}
steerNotice = steerNotice || await evaluate("document.querySelector('.agent-steer-notice')?.textContent || ''");
expect("a steer the turn can no longer take reports the 409 instead of vanishing", /already ended/.test(steerNotice), steerNotice);
expect("the refused text is still in the composer", await evaluate("document.querySelector('.agent-input')?.value === 'too late'"),
	await evaluate("document.querySelector('.agent-input')?.value"));
shots.push(await shot("panel-steer-refused"));
await waitFor("!document.querySelector('.agent-send.stop')", 20000);

/* ============================ Studio surface (#350) ====================== */

// One component, two presentations. Everything below is asserted on the
// embedded Studio mount, at the two widths the Inspector column has to work at.
const studioUrl = (() => {
	const url = new URL("/app/", baseUrl);
	url.searchParams.set("agent", "mock");
	url.searchParams.set("state", "ready");
	return url.toString();
})();

async function openStudio(width, height) {
	await send("Emulation.setDeviceMetricsOverride", { width, height, deviceScaleFactor: 1, mobile: width < 500 });
	const loaded = loadedOnce();
	await send("Page.navigate", { url: studioUrl });
	await loaded;
	if (!await waitFor("!!document.querySelector('.view-menu-trigger') && document.querySelectorAll('.hierarchy-row-wrap').length > 0", 40000)) {
		throw new Error("the studio never came up");
	}
	if (await evaluate("document.querySelector('.studio-agent-inspector')?.hidden !== false")) {
		await evaluate("document.querySelector('.view-menu-trigger').click()");
		if (!await waitFor("!!document.querySelector('.view-menu .agent-panel-toggle')", 8000)) throw new Error("the View menu never opened");
		await evaluate("document.querySelector('.view-menu .agent-panel-toggle').click()");
		if (!await waitFor("document.querySelector('.studio-agent-inspector')?.hidden === false", 8000)) throw new Error("the agent column never opened");
		await evaluate("document.querySelector('.view-menu-trigger').click()");
		await waitFor("!document.querySelector('.view-menu')", 8000);
	}
	if (!await waitFor("!!document.querySelector('.studio-agent-inspector .agent-input:not([disabled])')", 20000)) {
		throw new Error("the Studio composer never became usable");
	}
	// A Studio turn describes the scene from the live editor, so the panel
	// refuses to send before this tab owns a live workspace. Waiting for the
	// handle the top bar already shows is the same readiness the panel checks.
	if (!await waitFor("!!document.querySelector('.live-workspace-handle')", 30000)) {
		throw new Error("no live editor is connected; start the dev server with its live hub (COZYCLAY_LIVE_PORT)");
	}
}

const studioChips = () => evaluate("[...document.querySelectorAll('[data-agent-card=\"ready\"] .agent-chip')].map((chip) => chip.textContent.trim())");

await openStudio(1440, 900);
expect("the Studio mounts ONE agent panel, embedded in the Inspector column", await evaluate("document.querySelectorAll('.agent-panel').length === 1 && document.querySelector('.studio-agent-inspector > .agent-panel')?.dataset.agentEmbedded === 'true'"));
expect("the Studio panel shows no image cost hint", await evaluate("!document.querySelector('.studio-agent-inspector .agent-footer-hint')"));
expect("the Studio panel enables History", await evaluate("!!document.querySelector('.studio-agent-inspector .agent-history:not([disabled])')"));
expect("the Workflow dock still owns both", await evaluate("!document.querySelector('.workflow-main')"), "the studio route must not mount the dock");
expect("the Studio panel never shows the image entitlement card", await evaluate("!document.querySelector('[data-agent-card=\"no-entitlement\"]')"));
const chips = await studioChips();
expect("the Studio offers its own three previs chips", chips.length === 3 && chips.every((chip) => chip.length > 8) && !chips.some((chip) => /storyboard|Render/i.test(chip)), JSON.stringify(chips));
expect("the composer asks for Studio work, not a render", /animate/i.test(await evaluate("document.querySelector('.studio-agent-inspector .agent-input').placeholder")), await evaluate("document.querySelector('.studio-agent-inspector .agent-input').placeholder"));
shots.push(await shot("studio-ready-1440"));

// A chip is a real prompt: it fills the composer it sits above.
await evaluate("document.querySelector('[data-agent-card=\"ready\"] .agent-chip').click()");
expect("a Studio chip prefills the composer", await waitFor("document.querySelector('.studio-agent-inspector .agent-input')?.value.length > 8", 5000));

// --- a Studio turn: Studio labels, Studio badge, Inspector-row receipt -----
// Select something the receipt will NOT name, so the highlight has to be
// legible on its own instead of borrowing the selected row's colour.
await evaluate("document.querySelector('.hierarchy-row-wrap[data-node-id=\"light\"] .hierarchy-row').click()");
expect("the selection is parked away from the row the turn will touch", await waitFor("document.querySelector('.hierarchy-row-wrap.selected')?.dataset.nodeId === 'light'", 8000));
const selectionBeforeTurn = await evaluate("document.querySelector('.hierarchy-row-wrap.selected')?.dataset.nodeId ?? null");
await evaluate("document.querySelector('.studio-agent-inspector .agent-send').click()");
expect("the Studio turn opens a tool card for a Studio family", await waitFor("!!document.querySelector('[data-tool-name=\"inspect_studio\"]')", 15000),
	await evaluate("document.querySelector('.scene-save-error')?.textContent || document.querySelector('.agent-activity-text')?.textContent || ''"));
expect("a Studio tool card reads as an action, not a function name", await evaluate("document.querySelector('[data-tool-name=\"inspect_studio\"] .agent-tool-label')?.textContent === 'Read the scene'"),
	await evaluate("document.querySelector('[data-tool-name=\"inspect_studio\"] .agent-tool-label')?.textContent"));
expect("the card is badged for the surface it edits", await evaluate("document.querySelector('[data-tool-name=\"inspect_studio\"] .agent-tool-badge')?.textContent === 'Scene'"));
expect("the second Studio family is labelled too", await waitFor("document.querySelector('[data-tool-name=\"arrange_characters\"] .agent-tool-label')?.textContent === 'Arrange characters'", 15000),
	await evaluate("document.querySelector('[data-tool-name=\"arrange_characters\"] .agent-tool-label')?.textContent"));
expect("a finished Studio tool card states its elapsed time", await waitFor("/\\d/.test(document.querySelector('[data-tool-name=\"arrange_characters\"] .agent-tool-elapsed')?.textContent || '')", 15000));
expect("the receipt lands as a card", await waitFor("!!document.querySelector('[data-receipt-status=\"applied\"]')", 15000));
// The highlight is deliberately short-lived, so it is screenshotted the moment
// it appears rather than after the rest of the assertions.
expect("the receipt lights the hierarchy row it changed", await waitFor("!!document.querySelector('.hierarchy-row.agent-touched')", 8000));
shots.push(await shot("studio-receipt-highlight-1440"));
expect("the lit row is the character the receipt named", await evaluate("document.querySelector('.hierarchy-row.agent-touched')?.closest('.hierarchy-row-wrap')?.dataset.nodeId === 'characterA'"),
	await evaluate("document.querySelector('.hierarchy-row.agent-touched')?.closest('.hierarchy-row-wrap')?.dataset.nodeId"));
expect("the highlight is its own overlay, not the selection style", await evaluate("(() => { const row = document.querySelector('.hierarchy-row.agent-touched'); const after = getComputedStyle(row, '::after'); return after.content === '\"\"' && after.animationName === 'hierarchy-agent-touch'; })()"),
	await evaluate("JSON.stringify({ content: getComputedStyle(document.querySelector('.hierarchy-row.agent-touched'), '::after').content, animation: getComputedStyle(document.querySelector('.hierarchy-row.agent-touched'), '::after').animationName })"));
expect("an agent edit reports itself without taking the selection", await evaluate("document.querySelector('.hierarchy-row-wrap.selected')?.dataset.nodeId ?? null") === selectionBeforeTurn,
	`${selectionBeforeTurn} -> ${await evaluate("document.querySelector('.hierarchy-row-wrap.selected')?.dataset.nodeId ?? null")}`);
expect("the Studio turn never produces an image card", await evaluate("!document.querySelector('.agent-image-card')"));
expect("the turn ends and Stop reverts to Send", await waitFor("!document.querySelector('.studio-agent-inspector .agent-send.stop')", 15000));
shots.push(await shot("studio-turn-complete-1440"));
expect("the highlight clears itself", await waitFor("!document.querySelector('.hierarchy-row.agent-touched')", 8000));

// --- Studio resume after reload (#368) -------------------------------------
const firstStudioSession = await evaluate("localStorage.getItem('cozyclay.agent.session.studio')");
const loadedAfterReload = loadedOnce();
await send("Page.reload", { ignoreCache: true });
await loadedAfterReload;
if (await evaluate("document.querySelector('.studio-agent-inspector')?.hidden !== false")) {
	await evaluate("document.querySelector('.view-menu-trigger').click()");
	await waitFor("!!document.querySelector('.view-menu .agent-panel-toggle')", 5000);
	await evaluate("document.querySelector('.view-menu .agent-panel-toggle').click()");
	await waitFor("document.querySelector('.studio-agent-inspector')?.hidden === false", 5000);
	await evaluate("document.querySelector('.view-menu-trigger').click()");
}
expect("reload restores the Studio thread", await waitFor(`document.querySelectorAll('.studio-agent-inspector .agent-row').length >= 4 && localStorage.getItem('cozyclay.agent.session.studio') === ${JSON.stringify(firstStudioSession)}`, 20000));
// A Studio turn describes the scene from the live editor, so the reloaded tab
// has to own a live workspace again before it can send anything at all.
if (!await waitFor("!!document.querySelector('.live-workspace-handle')", 30000)) throw new Error("no live editor after the reload");
const followup = "Continue this shot with a softer eyeline";
await evaluate(`(() => { const t = document.querySelector('.studio-agent-inspector .agent-input'); const setter = Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, 'value').set; setter.call(t, ${JSON.stringify(followup)}); t.dispatchEvent(new Event('input', { bubbles: true })); })()`);
// The reloaded panel enables Send only once the store holds the draft; clicking
// before that lands on a disabled button and the follow-up is never sent.
await clickWhenEnabled(".studio-agent-inspector .agent-send:not(.stop)");
expect("the reloaded thread renders the follow-up", await waitFor("document.querySelectorAll('.studio-agent-inspector .agent-row.user').length >= 2", 20000),
	await evaluate("document.querySelector('.studio-agent-inspector .agent-failure-message')?.textContent || document.querySelector('.studio-agent-inspector .agent-activity-text')?.textContent || ''"));
expect("the reloaded thread sends a follow-up on the same session", await waitFor(`localStorage.getItem('cozyclay.mock.agent.last-turn-session') === ${JSON.stringify(firstStudioSession)} && !document.querySelector('.studio-agent-inspector .agent-send.stop')`, 20000));
await evaluate("document.querySelector('.studio-agent-inspector').scrollIntoView({ block: 'start' }); document.querySelector('.studio-agent-inspector .agent-transcript').scrollTop = document.querySelector('.studio-agent-inspector .agent-transcript').scrollHeight");
shots.push(await shot("resume-after-reload"));

// --- the Inspector column at phone width ----------------------------------
await evaluate("document.querySelector('.studio-agent-inspector .agent-new').click()");
await waitFor("!!document.querySelector('[data-agent-card=\\\"ready\\\"]')", 5000);
await openStudio(390, 844);
expect("the phone-width Studio panel still has no image hint and enables History", await evaluate("!document.querySelector('.studio-agent-inspector .agent-footer-hint') && !!document.querySelector('.studio-agent-inspector .agent-history:not([disabled])')"));
expect("the composer fits the viewport at 390px", await evaluate("(() => { const r = document.querySelector('.studio-agent-inspector .agent-input').getBoundingClientRect(); return r.width > 0 && r.left >= 0 && r.right <= innerWidth + 1; })()"),
	await evaluate("JSON.stringify(document.querySelector('.studio-agent-inspector .agent-input').getBoundingClientRect())"));
expect("nothing scrolls sideways at 390px", await evaluate("document.documentElement.scrollWidth <= innerWidth && document.body.scrollWidth <= innerWidth"));
const phoneChips = await studioChips();
expect("the Studio chips survive the narrow column", phoneChips.length === 3, JSON.stringify(phoneChips));
// The panel sits under the viewport at phone width; the evidence has to show
// the panel, not the empty stage above it.
await evaluate("document.querySelector('.studio-agent-inspector').scrollIntoView({ block: 'start' })");
expect("the panel is on screen once it is scrolled to", await waitFor("(() => { const r = document.querySelector('.studio-agent-inspector').getBoundingClientRect(); return r.top < innerHeight - 100 && r.height > 200; })()", 5000),
	await evaluate("JSON.stringify(document.querySelector('.studio-agent-inspector').getBoundingClientRect())"));
shots.push(await shot("studio-ready-390"));
await send("Emulation.setDeviceMetricsOverride", { width: 1440, height: 900, deviceScaleFactor: 1, mobile: false });

console.log(`\nscreenshots (${shots.length}):`);
for (const file of shots) console.log(`  ${file}`);

if (failures > 0) {
	console.error(`${failures} FAILURES`);
	process.exit(1);
}
console.log("qa-agent-panel-browser: all checks passed");
process.exit(0);

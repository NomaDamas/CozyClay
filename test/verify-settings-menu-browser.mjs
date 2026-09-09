#!/usr/bin/env node
// Issue #193: the analytics opt-out and the language choice moved off the
// topbar into one labelled `Settings` menu. GDPR 7(3) asks that withdrawing
// consent be as easy as giving it, so this suite proves the opt-out is still
// two interactions away — including from the keyboard — and that turning it
// off still wipes the PostHog storage the old toggle wiped.
//
// Run: `npm run dev:ui` in one shell, then
//   QA_URL=http://127.0.0.1:5180/app/ node tools/qa-browser.mjs -- \
//     node test/verify-settings-menu-browser.mjs

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
const waitFor = async (expression, timeoutMs = 20000) => {
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

const clickAt = async ({ x, y }) => {
	await send("Input.dispatchMouseEvent", { type: "mousePressed", x, y, button: "left", clickCount: 1, buttons: 1 });
	await send("Input.dispatchMouseEvent", { type: "mouseReleased", x, y, button: "left", clickCount: 1, buttons: 0 });
};
const rectCentre = async (selector) => {
	const centre = await evaluate(
		`(() => { const el = document.querySelector(${JSON.stringify(selector)}); if (!el) return null;` +
			` const r = el.getBoundingClientRect(); return { x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2) }; })()`,
	);
	if (!centre) throw new Error(`no element matches ${selector} — is the QA browser on the studio page (/app/)?`);
	return centre;
};
const pressKey = async (key, code, keyCode, text) => {
	await send("Input.dispatchKeyEvent", { type: text ? "keyDown" : "rawKeyDown", key, code, windowsVirtualKeyCode: keyCode, text });
	await send("Input.dispatchKeyEvent", { type: "keyUp", key, code, windowsVirtualKeyCode: keyCode });
};

const TRIGGER = "[data-testid=settings-menu-trigger]";
const ANALYTICS = "[data-testid=settings-analytics]";

// Subscribe to the exact DOM change BEFORE acting, then await it (bounded).
const armMenu = (state) =>
	evaluate(`window.__settingsMenu = new Promise((resolve) => {
		const has = () => !!document.querySelector('.settings-menu');
		if (has() === ${state === "open"}) { resolve('already'); return; }
		const obs = new MutationObserver(() => {
			if (has() === ${state === "open"}) { obs.disconnect(); clearTimeout(t); resolve(${JSON.stringify(state)}); }
		});
		obs.observe(document.body, { childList: true, subtree: true });
		const t = setTimeout(() => { obs.disconnect(); resolve('timeout'); }, 4000);
	}), true`);
const menuSettled = () => evaluate("window.__settingsMenu");
const armPressedFlip = () =>
	evaluate(`window.__analyticsFlip = new Promise((resolve) => {
		const item = document.querySelector('${ANALYTICS}');
		const before = item.getAttribute('aria-pressed');
		const obs = new MutationObserver(() => {
			const now = document.querySelector('${ANALYTICS}')?.getAttribute('aria-pressed');
			if (now && now !== before) { obs.disconnect(); clearTimeout(t); resolve(now); }
		});
		obs.observe(document.body, { attributes: true, subtree: true, attributeFilter: ['aria-pressed'] });
		const t = setTimeout(() => { obs.disconnect(); resolve('timeout'); }, 8000);
	}), true`);

expect("the studio topbar renders a labelled Settings trigger", await waitFor(`!!document.querySelector('${TRIGGER}')`, 30000));
expect(
	"the trigger carries a text label, never an icon alone",
	/[A-Za-z\uAC00-\uD7AF]/.test(await evaluate(`document.querySelector('${TRIGGER}').textContent`)),
);

// A stale PostHog blob and an opted-in state, so the opt-out has something to
// clear and something to flip.
await evaluate(`(() => {
	localStorage.setItem("ph_qa-project_posthog", JSON.stringify({ distinct_id: "qa" }));
	localStorage.setItem("cozyclay.analyticsOptOut", "0");
})()`);

/* ------------------------------------------- keyboard reachability ---- */
await armMenu("open");
await evaluate(`document.querySelector('${TRIGGER}').focus()`);
await pressKey("Enter", "Enter", 13, "\r");
expect("Enter on the focused trigger opens Settings", (await menuSettled()) !== "timeout");
expect("Settings offers both languages and the analytics item", (await evaluate(
	`[...document.querySelectorAll('.settings-menu button')].map((b) => b.dataset.testid).join(",")`,
)) === "settings-locale-en,settings-locale-ko,settings-analytics");
expect(
	"the stored language is marked pressed",
	(await evaluate("[...document.querySelectorAll('.settings-menu button[data-testid^=settings-locale]')].filter((b) => b.getAttribute('aria-pressed') === 'true').length")) === 1,
);

await armMenu("closed");
await pressKey("Escape", "Escape", 27);
expect("Escape closes Settings", (await menuSettled()) !== "timeout");
expect(
	"Escape returns focus to the trigger",
	(await evaluate(`document.activeElement === document.querySelector('${TRIGGER}')`)) === true,
);

/* ------------------------------------------------ analytics opt-out --- */
await armMenu("open");
await clickAt(await rectCentre(TRIGGER));
expect("clicking the trigger reopens Settings", (await menuSettled()) !== "timeout");
const before = await evaluate(`document.querySelector('${ANALYTICS}').getAttribute('aria-pressed')`);
expect("analytics reads as on before the opt-out", before === "true", String(before));

await armPressedFlip();
await clickAt(await rectCentre(ANALYTICS));
const after = await evaluate("window.__analyticsFlip");
expect("one click flips aria-pressed to off", after === "false", String(after));
expect("the opt-out is persisted", (await evaluate("localStorage.getItem('cozyclay.analyticsOptOut')")) === "1");
expect(
	"opting out clears every ph_* key",
	(await evaluate("Object.keys(localStorage).filter((key) => key.startsWith('ph_'))")).length === 0,
);
expect("the panel stays open after the toggle, so the state is readable", await evaluate("!!document.querySelector('.settings-menu')"));

ws.close();
if (failures) process.exit(1);
console.log("all Settings menu browser checks PASS — keyboard reachable, opt-out flips and clears ph_* storage");

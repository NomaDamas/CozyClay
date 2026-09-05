#!/usr/bin/env node
// Browser contract for the topbar project menu's dismissal affordances. The
// menu is plain state in App.jsx, so only a real page can prove the document
// -level listeners: Escape closes it, a pointerdown outside .project-menu-wrap
// closes it, and presses inside the wrap keep working (the trigger still
// toggles, menu items still fire). Mirrors the inspector-actions dismissal
// contract.
//
// Run: `npm run dev:ui` in one shell, then `npm run test:project-menu`, which
// launches the headless QA browser against QA_URL (default 127.0.0.1:5180).

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
const waitFor = async (expression, timeoutMs = 10000) => {
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

const rectCentre = async (selector) => {
	const centre = await evaluate(
		`(() => { const el = document.querySelector(${JSON.stringify(selector)}); if (!el) return null;` +
			` const r = el.getBoundingClientRect(); return { x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2) }; })()`,
	);
	// Fail by name: destructuring null a few frames later blames the wrong line.
	if (!centre) throw new Error(`no element matches ${selector} — is the QA browser on the studio page (/app/)?`);
	return centre;
};
const mouse = (type, x, y) =>
	send("Input.dispatchMouseEvent", { type, x, y, button: "left", clickCount: 1, buttons: type === "mousePressed" ? 1 : 0 });
const clickAt = async ({ x, y }) => {
	await mouse("mousePressed", x, y);
	await mouse("mouseReleased", x, y);
};
const pressEscape = async () => {
	await send("Input.dispatchKeyEvent", { type: "keyDown", key: "Escape", code: "Escape", windowsVirtualKeyCode: 27 });
	await send("Input.dispatchKeyEvent", { type: "keyUp", key: "Escape", code: "Escape", windowsVirtualKeyCode: 27 });
};

// Subscribe to the exact DOM change BEFORE acting, then await it (bounded).
// The observer resolves "closed"/"open" on the mutation, "timeout" otherwise.
const armMenuGone = () =>
	evaluate(`window.__menuGone = new Promise((resolve) => {
		if (!document.querySelector('.project-menu')) { resolve('already-closed'); return; }
		const obs = new MutationObserver(() => {
			if (!document.querySelector('.project-menu')) { obs.disconnect(); clearTimeout(t); resolve('closed'); }
		});
		obs.observe(document.body, { childList: true, subtree: true });
		const t = setTimeout(() => { obs.disconnect(); resolve('timeout'); }, 4000);
	}), true`);
const armMenuShown = () =>
	evaluate(`window.__menuShown = new Promise((resolve) => {
		if (document.querySelector('.project-menu')) { resolve('already-open'); return; }
		const obs = new MutationObserver(() => {
			if (document.querySelector('.project-menu')) { obs.disconnect(); clearTimeout(t); resolve('open'); }
		});
		obs.observe(document.body, { childList: true, subtree: true });
		const t = setTimeout(() => { obs.disconnect(); resolve('timeout'); }, 4000);
	}), true`);
const menuGone = () => evaluate("window.__menuGone");
const menuShown = () => evaluate("window.__menuShown");
const menuOpen = () => evaluate("!!document.querySelector('.project-menu')");
const openMenu = async () => {
	await armMenuShown();
	await clickAt(await rectCentre(".project-menu-trigger"));
	return menuShown();
};

// Boot: wait for the studio topbar; the app document may still be loading.
expect("the topbar renders the project menu trigger", await waitFor("!!document.querySelector('.project-menu-trigger')", 30000));
expect("the topbar renders a direct Save action", await waitFor("!!document.querySelector('[data-testid=topbar-save]')"));
expect("the topbar renders a direct Export action", await waitFor("!!document.querySelector('[data-testid=topbar-export]')"));
expect(
	"the topbar exposes an understandable save status",
	Boolean(await evaluate("document.querySelector('[data-testid=project-save-status]')?.textContent.trim()")),
);
expect("the menu starts closed", !(await menuOpen()));

/* ------------------------------------------------ Escape closes ------ */
expect("clicking the trigger opens the menu", (await openMenu()) === "open");
await armMenuGone();
await pressEscape();
expect("Escape closes the menu", (await menuGone()) === "closed");

/* -------------------------------------- outside pointerdown closes --- */
expect("the menu reopens after Escape", (await openMenu()) === "open");
await armMenuGone();
const outside = await rectCentre(".topbar .logo");
await mouse("mousePressed", outside.x, outside.y);
expect("a pointerdown outside .project-menu-wrap closes the menu", (await menuGone()) === "closed");
await mouse("mouseReleased", outside.x, outside.y);

/* ------------------------- presses inside the wrap keep working ------ */
expect("the menu reopens after the outside press", (await openMenu()) === "open");
const trigger = await rectCentre(".project-menu-trigger");
await mouse("mousePressed", trigger.x, trigger.y);
expect("a pointerdown inside the wrap does NOT close the menu", await menuOpen());
await armMenuGone();
await mouse("mouseReleased", trigger.x, trigger.y);
expect("completing the trigger click still toggles the menu closed", (await menuGone()) === "closed");
expect(
	"the trigger reports the collapsed state",
	(await evaluate("document.querySelector('.project-menu-trigger').getAttribute('aria-expanded')")) === "false",
);

/* -------------------------------------- menu items still function ---- */
expect("the menu reopens after the toggle", (await openMenu()) === "open");
await clickAt(await rectCentre('.project-menu [role="menuitem"]:nth-of-type(2)'));
expect("the Open Project… item still opens the project browser", await waitFor("!!document.querySelector('.project-browser')"));
expect("selecting an item closes the menu", !(await menuOpen()));
await clickAt(await rectCentre(".project-browser .x"));
expect("the project browser closes again", await waitFor("!document.querySelector('.project-browser')"));

ws.close();
if (failures > 0) {
	console.error(`\n${failures} project-menu browser check(s) failed`);
	process.exit(1);
}
console.log("\nAll project-menu browser checks passed");

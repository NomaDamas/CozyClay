#!/usr/bin/env node
// Browser QA for issue #530: Motion-mode Details with prompt blocks and a
// Takes section (G6), the old take bar removed.
//
//   COZYCLAY_LIVE_PORT=6681 npm run dev -- --port 5681 --strictPort
//   QA_URL=http://127.0.0.1:5681/app/?motion=/demo/walk-then-stop.npz CDP_PORT=9681 \
//     COZYCLAY_LIVE_PORT=6681 QA_OUT=<dir> node tools/qa-browser.mjs -- node test/qa-shell-motion-browser.mjs
//
// The second take is installed through the real motion.replace command over
// the dev runner's live hub (as a token-holding controller), the same route an
// agent's load_motion takes, so the Takes list is driven by the production
// take lineage and not by a page-side fixture. Run it against a dev server
// started WITHOUT CCLAY_KIMODO_HOST: the unavailable generation bridge is the
// failure scenario.
import { mkdirSync, watch, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { connectController, discoverEndpoint } from "../bin/live/client.mjs";
import { liveEndpointPath, readLiveEndpoint } from "../bin/live-endpoint.mjs";

const port = Number(process.env.CDP_PORT || 9681);
const livePort = Number(process.env.COZYCLAY_LIVE_PORT || 6681);
const out = process.env.QA_OUT || "/tmp/task-16-motion";
mkdirSync(out, { recursive: true });

const SECOND_TAKE_URL = "/demo/walk-then-stop.npz?take=2";
const SELECT_TINT = "rgba(232, 163, 61, 0.14)";

const targets = await (await fetch(`http://127.0.0.1:${port}/json`)).json();
const page = targets.find((target) => target.type === "page" && target.webSocketDebuggerUrl);
if (!page) throw new Error("no page target on the QA browser");

// The dev runner publishes its live hub lazily (on the studio's first agent
// request), so a run that starts with a fresh server waits for the endpoint
// file with a live owner pid instead of failing with NO_SERVER.
const hubAlive = () => {
	const record = readLiveEndpoint(livePort);
	if (!record) return false;
	try { process.kill(record.pid, 0); return true; } catch { return false; }
};
if (!hubAlive()) {
	const directory = dirname(liveEndpointPath(livePort));
	mkdirSync(directory, { recursive: true, mode: 0o700 });
	await new Promise((resolve, reject) => {
		const done = (error) => { watcher.close(); clearTimeout(timer); if (error) reject(error); else resolve(); };
		const watcher = watch(directory, () => { if (hubAlive()) done(); });
		const timer = setTimeout(() => done(new Error(`no live hub published on port ${livePort} within 60 s`)), 60_000);
		if (hubAlive()) done();
	});
}
const controller = await connectController(discoverEndpoint(livePort));
const command = async (name, args, workspaceHandle) => {
	const reply = await controller.request({ type: "cmd", name, args, workspaceHandle, timeoutMs: 30_000 }, { timeoutMs: 30_000 });
	if (!reply.ok) throw new Error(`${name}: ${JSON.stringify(reply.error)}`);
	return reply.value;
};

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
	return result.result?.value;
};
// Resolves on the first DOM mutation after which the condition holds.
const waitFor = (condition, timeoutMs = 20_000) => evaluate(`new Promise((resolve, reject) => {
	let timer;
	const finish = (value, error) => {
		observer?.disconnect();
		clearTimeout(timer);
		if (error) reject(error); else resolve(value);
	};
	const check = () => {
		try { if (${condition}) finish(true); } catch (error) { finish(false, error); }
	};
	const observer = new MutationObserver(check);
	observer.observe(document, { subtree: true, childList: true, attributes: true, characterData: true });
	timer = setTimeout(() => finish(false), ${timeoutMs});
	check();
})`);
const pageEvent = (method) => new Promise((resolve) => {
	const listener = (event) => {
		const message = JSON.parse(event.data);
		if (message.method !== method) return;
		ws.removeEventListener("message", listener);
		resolve(message.params);
	};
	ws.addEventListener("message", listener);
});
let failures = 0;
const expect = (name, condition, detail = "") => {
	console.log(`${condition ? "PASS" : "FAIL"} ${name}${condition ? "" : ` — ${detail}`}`);
	if (!condition) failures += 1;
};
const capture = async (clip) => {
	const { data } = await send("Page.captureScreenshot", clip
		? { format: "png", captureBeyondViewport: true, clip: { ...clip, scale: 1 } }
		: { format: "png", captureBeyondViewport: false });
	return data;
};
const screenshot = async (name, clip) => {
	const data = await capture(clip);
	const file = `${out}/${name}.png`;
	writeFileSync(file, Buffer.from(data, "base64"));
	console.log(`     screenshot ${file}`);
	return data;
};
const rectOf = (selector) => evaluate(`(() => {
	const node = document.querySelector(${JSON.stringify(selector)});
	if (!node) return null;
	const r = node.getBoundingClientRect();
	return { x: r.left + r.width / 2, y: r.top + r.height / 2, left: r.left, top: r.top, width: r.width, height: r.height };
})()`);
const click = async (selector) => {
	await evaluate(`document.querySelector(${JSON.stringify(selector)})?.scrollIntoView({ block: "nearest" }); true`);
	const rect = await rectOf(selector);
	if (!rect) throw new Error(`nothing to click at ${selector}`);
	for (const type of ["mousePressed", "mouseReleased"]) {
		await send("Input.dispatchMouseEvent", { type, x: rect.x, y: rect.y, button: "left", buttons: type === "mousePressed" ? 1 : 0, clickCount: 1 });
	}
};
const takeRows = ".v2-details-section:not([hidden]) .motion-take-row";

try {
	await send("Runtime.enable");
	await send("Page.enable");
	await send("Emulation.setDeviceMetricsOverride", { width: 1920, height: 1080, deviceScaleFactor: 1, mobile: false });
	await waitFor("location.href.startsWith('http')", 30_000);
	const appUrl = await evaluate("location.href");
	await evaluate("localStorage.removeItem('cozyclay.scene.v1'); localStorage.removeItem('cozyclay.scene.v1.quarantine'); localStorage.setItem('cozyclay.locale', 'en'); true");
	// Marked before the reload so the reloaded tab's connection cannot be missed.
	const connected = controller.nextEvent("editor_connected", { since: controller.eventCount(), timeoutMs: 45_000 });
	connected.catch(() => {});
	const loaded = pageEvent("Page.loadEventFired");
	await send("Page.reload", { ignoreCache: false });
	await loaded;
	const handle = (await connected).payload.handle;
	expect("the studio loads the demo take", await waitFor("!!window.__cozyclay?.motion && window.__cozyclay.motion.frames > 0 && !!document.querySelector('[data-node-id=characterA] .hierarchy-row')", 60_000));

	// ---- Motion mode, character selected ----
	// The v2 mode toolbar (#521/#524): key 4 is Motion.
	await evaluate(`document.querySelector('[data-mode-key="4"]')?.click(); true`);
	expect("Motion mode is active", await waitFor("document.querySelector('.app')?.dataset.workflowMode === 'motion'"));
	await click("[data-node-id=characterA] .hierarchy-row");
	expect("Details shows the Takes section with the loaded take", await waitFor(`document.querySelectorAll(${JSON.stringify(takeRows)}).length === 1`));
	expect("the take bar is gone from the dock", await evaluate("!document.querySelector('.take-bar') && !document.querySelector('.bottom-timeline [data-take-mode]')"));

	// ---- A second take through the production motion.replace route ----
	const inspected = await command("inspect_studio", { scope: "actions", ids: ["motion.replace"] }, handle);
	const context = inspected.context;
	const receipt = await command("run_action", {
		name: "run_action",
		args: { action: "motion.replace", args: { characterId: context.activeCharacterId, url: SECOND_TAKE_URL, prompt: "QA second take" } },
		commandId: crypto.randomUUID(),
		host: Object.fromEntries(["workspaceId", "documentEpoch", "sceneId", "sceneEpoch"].map((key) => [key, context.host[key]])),
		expectedRevision: context.revision.scene,
	}, handle);
	expect("motion.replace installs a second take", receipt?.ok === true, JSON.stringify(receipt));
	expect("Takes lists v1 and v2 with v2 current", await waitFor(`(() => {
		const rows = [...document.querySelectorAll(${JSON.stringify(takeRows)})];
		return rows.length === 2 && rows[1].dataset.versionCurrent === 'true' && document.querySelector('.motion-takes')?.dataset.takeSource === ${JSON.stringify(SECOND_TAKE_URL)};
	})()`));

	const rows = await evaluate(`[...document.querySelectorAll(${JSON.stringify(takeRows)})].map((row) => ({
		height: row.getBoundingClientRect().height,
		text: row.textContent,
		url: row.dataset.versionUrl,
		current: row.dataset.versionCurrent === 'true',
		background: getComputedStyle(row).backgroundColor,
	}))`);
	expect("every Takes row is 24 px tall", rows.every((row) => row.height === 24), JSON.stringify(rows));
	const current = rows.find((row) => row.current);
	expect("the current take row wears the amber selection tint", current?.background === SELECT_TINT, JSON.stringify(current));
	expect("the other take row is untinted", rows.filter((row) => !row.current).every((row) => row.background !== SELECT_TINT), JSON.stringify(rows));
	const footer = await evaluate("document.querySelector('.motion-takes .motion-takes-footer')?.textContent ?? null");
	expect("the recipe summary is the Takes footer line", typeof footer === "string" && footer.includes("block(s)"), JSON.stringify(footer));

	// ---- Happy path: switch v2 -> v1 ----
	const before = await evaluate("document.querySelector('.motion-takes').dataset.takeSource");
	await click(`${takeRows}:not(.current)`);
	expect("clicking v1 loads it (data-take-source changes)", await waitFor(`(() => {
		const source = document.querySelector('.motion-takes')?.dataset.takeSource;
		return source && source !== ${JSON.stringify(before)} && document.querySelector(${JSON.stringify(`${takeRows}.current`)})?.dataset.versionUrl === source;
	})()`), before);
	const after = await evaluate("document.querySelector('.motion-takes').dataset.takeSource");
	expect("v1 is the demo take", after === "/demo/walk-then-stop.npz", after);

	// ---- Actions that left the take bar have one visible home: the top bar (#550) ----
	await evaluate(`(() => {
		const head = [...document.querySelectorAll('.v2-details-section:not([hidden]) .foldout-head')].find((button) => button.textContent.trim() === 'Prompt Blocks');
		if (head?.getAttribute('aria-expanded') === 'false') head.click();
		return true;
	})()`);
	expect("Prompt Blocks is open", await waitFor("[...document.querySelectorAll('.inspector-sidebar .inspector-hint')].some((node) => node.textContent.startsWith('Blocks define what is generated'))"));
	await click("[data-testid=topbar-generate-menu]");
	await waitFor("!!document.querySelector('[data-generate-action=block]')");
	const homes = await evaluate(`(() => {
		const visible = (selector) => { const node = document.querySelector(selector); if (!node) return false; const r = node.getBoundingClientRect(); return r.width > 0 && r.height > 0; };
		return {
			scene: visible('.topbar [data-testid=topbar-generate]'),
			refine: visible('.hierarchy-sidebar [data-take-mode=refine]'),
			startOver: visible('[data-generate-action=new]'),
			again: visible('[data-generate-action=again]'),
			block: visible('[data-generate-action=block]'),
		};
	})()`);
	expect("Generate Motion with Start over, Take it again and Add block in its caret menu are visible in the top bar, Refine in Details", Object.values(homes).every(Boolean), JSON.stringify(homes));
	const detailsGenerate = await evaluate(`[...document.querySelectorAll('.inspector-sidebar [data-scene-action], .inspector-sidebar .prompt-block-generate')].filter((node) => { const r = node.getBoundingClientRect(); return r.width > 0 && r.height > 0; }).length`);
	expect("Details shows no generate action of its own", detailsGenerate === 0, String(detailsGenerate));
	await send("Input.dispatchKeyEvent", { type: "keyDown", key: "Escape", code: "Escape", windowsVirtualKeyCode: 27 });
	await send("Input.dispatchKeyEvent", { type: "keyUp", key: "Escape", code: "Escape", windowsVirtualKeyCode: 27 });
	expect("Escape closes the Generate menu", await waitFor("!document.querySelector('[data-generate-action]')"));
	expect("Motion › Advanced starts collapsed", await evaluate("document.querySelector('.motion-advanced-head')?.getAttribute('aria-expanded') === 'false' && !document.querySelector('[data-preserve-strength]')"));
	await click(".motion-advanced-head");
	expect("Motion › Advanced reveals preserve strength", await waitFor("!!document.querySelector('.motion-advanced [data-preserve-strength]')"));

	// ---- Failure path: generation bridge unavailable ----
	const clipsBefore = await evaluate("document.querySelectorAll('.tl-track.prompts .tl-chip-input').length");
	await click("[data-testid=topbar-generate-menu]");
	await waitFor("!!document.querySelector('[data-generate-action=block]')");
	await click("[data-generate-action=block]");
	expect("Add block adds a prompt block", await waitFor(`document.querySelectorAll('.tl-track.prompts .tl-chip-input').length === ${clipsBefore + 1} && !!document.querySelector('input[placeholder="describe this motion block"]')`));
	await evaluate(`(() => { const input = document.querySelector('input[placeholder="describe this motion block"]'); input.focus(); input.select(); return true; })()`);
	await send("Input.insertText", { text: "walk forward and stop" });
	expect("the selected block shows its range and prompt", await waitFor(`!!document.querySelector('.motion-block-range') && document.querySelector('input[placeholder="describe this motion block"]').value === 'walk forward and stop'`));
	expect("Generate is on screen", await waitFor("!!document.querySelector('[data-testid=topbar-generate]')"));
	const readiness = await evaluate(`(() => {
		const generate = document.querySelector('[data-testid=topbar-generate]');
		const status = document.querySelector('.hierarchy-sidebar .motion-readiness');
		return { disabledReason: generate.dataset.disabledReason ?? null, title: generate.title, state: status?.dataset.state ?? null, text: status?.querySelector('[role=status]')?.textContent ?? null };
	})()`);
	// The top-bar button stays live so its click reaches the pipeline's refusal;
	// the readiness reason is said inline beside the blocks in Details.
	expect("the readiness reason is said inline in Details while top-bar Generate stays clickable", readiness.state && readiness.state !== "ready" && readiness.text && !readiness.disabledReason, JSON.stringify(readiness));
	const motionBefore = await evaluate("window.__cozyclay.motion?.url ?? null");
	const busyBefore = await evaluate("document.querySelector('[data-testid=topbar-generate]').textContent");
	// The refusal is the signal: subscribed before the click, it arrives as the
	// generation pipeline's TARGET_NOT_READY toast.
	await evaluate(`(() => {
		window.__qaRefusal = new Promise((resolve) => {
			const seen = () => [...document.querySelectorAll('.toast')].some((toast) => toast.textContent.includes('cannot run this request'));
			const observer = new MutationObserver(() => { if (seen()) { observer.disconnect(); clearTimeout(timer); resolve(true); } });
			const timer = setTimeout(() => { observer.disconnect(); resolve(false); }, 20000);
			observer.observe(document.body, { subtree: true, childList: true, characterData: true });
		});
		return true;
	})()`);
	await click("[data-testid=topbar-generate]");
	expect("Generate is refused with the readiness reason", await evaluate("window.__qaRefusal"));
	const afterClick = await evaluate("({ label: document.querySelector('[data-testid=topbar-generate]').textContent, url: window.__cozyclay.motion?.url ?? null, cancel: [...document.querySelectorAll('.hierarchy-sidebar button')].some((button) => button.textContent.trim() === 'Cancel run') })");
	expect("no generation job starts without a bridge", afterClick.label === busyBefore && afterClick.url === motionBefore && !afterClick.cancel, JSON.stringify({ busyBefore, motionBefore, afterClick }));
	await evaluate("document.activeElement?.blur(); true");
	await screenshot("task-16-failure");

	// ---- No backend brand names in the UI ----
	const brands = await evaluate(`(() => {
		const hits = [];
		for (const node of document.querySelectorAll('body *')) {
			const own = [...node.childNodes].filter((child) => child.nodeType === Node.TEXT_NODE).map((child) => child.textContent).join('');
			const text = own + ' ' + (node.getAttribute('title') ?? '') + ' ' + (node.getAttribute('aria-label') ?? '');
			if (/Kimodo|ProjFlow/.test(text)) hits.push(node.tagName + '.' + node.className + ': ' + text.trim().slice(0, 80));
		}
		return hits;
	})()`);
	expect("no element's text contains Kimodo or ProjFlow", brands.length === 0, JSON.stringify(brands));

	// ---- Evidence: the Motion Details, then ours beside the 2a reference ----
	await click(".motion-advanced-head");
	await waitFor("!document.querySelector('[data-preserve-strength]')");
	await evaluate("document.querySelector('.motion-takes')?.scrollIntoView({ block: 'end' }); true");
	await screenshot("task-16-motion");
	// At 1080 p the Outliner leaves Details a short pane; a taller viewport lets
	// the whole Motion Details (Prompt Blocks through Takes) sit in one capture.
	await send("Emulation.setDeviceMetricsOverride", { width: 1920, height: 2160, deviceScaleFactor: 1, mobile: false });
	await waitFor("innerHeight === 2160");
	await evaluate("document.querySelector('.inspector-scroll').scrollTop = 0; true");
	// From the pane's top edge down to the end of the Takes section.
	const sidebar = await evaluate(`(() => {
		const pane = document.querySelector('.inspector-pane').getBoundingClientRect();
		const takes = document.querySelector('.motion-takes').closest('.v2-details-section').getBoundingClientRect();
		return { left: pane.left, top: pane.top, width: pane.width, height: takes.bottom - pane.top };
	})()`);
	const oursPng = await capture({ x: sidebar.left, y: sidebar.top, width: sidebar.width, height: sidebar.height });
	writeFileSync(`${out}/task-16-ours.png`, Buffer.from(oursPng, "base64"));
	const referenceLoaded = pageEvent("Page.loadEventFired");
	await send("Page.navigate", { url: `${new URL(appUrl).origin}/docs/design/v2-reference.html#2a` });
	await referenceLoaded;
	expect("the 2a reference card renders", await waitFor("[...document.querySelectorAll('div')].some((node) => node.firstElementChild?.textContent === 'Details' && node.style.flexDirection === 'column')", 20_000));
	const reference = await evaluate(`(() => {
		const node = [...document.querySelectorAll('div')].find((div) => div.firstElementChild?.textContent === 'Details' && div.style.flexDirection === 'column');
		const r = node.getBoundingClientRect();
		return { x: r.left + scrollX, y: r.top + scrollY, width: r.width, height: r.height };
	})()`);
	const referencePng = await capture(reference);
	await send("Page.navigate", { url: "about:blank" });
	await evaluate(`(() => {
		document.body.style.cssText = 'margin:0;background:#070708;color:#9b9ba1;font:12px system-ui;display:flex;align-items:flex-start;gap:16px;padding:16px';
		const col = (title, data) => '<figure style="margin:0"><figcaption style="margin:0 0 8px">' + title + '</figcaption><img src="data:image/png;base64,' + data + '"></figure>';
		document.body.innerHTML = col('v2 reference (2a Details)', ${JSON.stringify(referencePng)}) + col('CozyClay Motion Details (this branch)', ${JSON.stringify(oursPng)});
		return Promise.all([...document.images].map((img) => img.decode()));
	})()`);
	const size = await evaluate("({ width: document.body.scrollWidth, height: document.body.scrollHeight })");
	await screenshot("task-16-compare", { x: 0, y: 0, width: size.width, height: size.height });

	writeFileSync(`${out}/task-16-motion.json`, `${JSON.stringify({ issue: 530, rows, footer, before, after, homes, readiness, afterClick, brands, pageErrors, failures }, null, "\t")}\n`);
	expect("the page threw no uncaught errors", pageErrors.length === 0, pageErrors.join(" | "));
} catch (error) {
	console.log(`FAIL setup — ${error.stack}`);
	failures += 1;
} finally {
	ws.close();
	controller.close();
}
console.log(failures ? `qa-shell-motion-browser: ${failures} FAIL` : "qa-shell-motion-browser: all PASS");
process.exit(failures ? 1 : 0);

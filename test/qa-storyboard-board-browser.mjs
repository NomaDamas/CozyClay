#!/usr/bin/env node
// Storyboard browser QA: per-panel cast overrides (#640), the Board dock
// tab (#641) and panel Stylize through a stubbed /agent/image (#643). Run
// through tools/qa-browser.mjs with QA_URL at `/app/`.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { crc32, deflateSync } from "node:zlib";
import { cameraBrowser } from "./camera-browser-harness.mjs";
import { SCENES_STORAGE_KEY } from "../src/scenes.js";

const outputDir = process.env.QA_OUT || "/Users/yun/CozyClay/.omo/evidence/previs-modes/previs-modes-r5/shots";
mkdirSync(outputDir, { recursive: true });
const STUB_PNG = stubPng();
const downloadDir = mkdtempSync(join(tmpdir(), "cozyclay-board-export-"));
const b = await cameraBrowser();
const downloads = await downloadWatcher(downloadDir);

// Page errors are collected in the page from the first script on, so a
// reload keeps counting.
await b.send("Page.addScriptToEvaluateOnNewDocument", { source: `(() => {
	window.__boardErrors = [];
	window.addEventListener('error', (event) => window.__boardErrors.push(String(event.message)));
	window.addEventListener('unhandledrejection', (event) => window.__boardErrors.push(String(event.reason?.message ?? event.reason)));
})()` });

const hookBus = () => b.evaluate(`(() => {
	const element = document.querySelector('.app');
	let fiber = element[Object.keys(element).find(key => key.startsWith('__reactFiber'))];
	while (fiber && !fiber.memoizedProps?.value?.bus) fiber = fiber.return;
	if (!fiber) throw new Error('AppContext provider not found');
	const context = fiber.memoizedProps.value;
	window.__storyboardBus = context.bus;
	window.__storyboardState = context.live;
})()`);

// A one-character scene with no shots, opened as a project of `previsMode`.
const seedProject = async (previsMode) => {
	await b.navigate(`${b.base.origin}/favicon.ico`);
	await b.evaluate(`(() => {
		localStorage.clear();
		localStorage.setItem('cozyclay.locale', 'en');
		localStorage.setItem('cozyclay.project-session.v1', JSON.stringify({ name: 'Board QA', previsMode: ${JSON.stringify(previsMode)}, updatedAt: Date.now() }));
		localStorage.setItem('${SCENES_STORAGE_KEY}', JSON.stringify({ version: 4, activeSceneId: 'board-qa', scenes: [{
			id: 'board-qa', name: 'Board QA', objects: [],
			shotDocument: { version: 4, frameCount: 144, waypoints: [], shots: [] },
			stage: { characters: [{ id: 'char-a', model: 'y-bot-tpose', x: 0, z: 0, rot: 0, hidden: false, pose: null, subject: 'a person' }], hasCharSheet: false, shotAspect: '16:9' }
		}] }));
	})()`);
	await openStudio();
};
const openStudio = async () => {
	await b.navigate(new URL("/app/", b.base));
	await b.ready();
	await hookBus();
};
const tabKeys = () => b.evaluate("[...document.querySelectorAll('.dock-tabs [role=tab]')].map(tab => tab.dataset.testid.replace('dock-tab-', '') + (tab.getAttribute('aria-selected') === 'true' ? '*' : ''))");
const stillCaptions = () => b.evaluate("window.__storyboardState.state.shots.filter(shot => shot.kind === 'still').sort((a, c) => a.startFrame - c.startFrame).map(shot => shot.caption)");
const cardCount = () => b.evaluate("document.querySelectorAll('[data-testid=board-card]').length");
const key = async (keyName, code, keyCode) => {
	await b.send("Input.dispatchKeyEvent", { type: "keyDown", key: keyName, code, windowsVirtualKeyCode: keyCode });
	await b.send("Input.dispatchKeyEvent", { type: "keyUp", key: keyName, code, windowsVirtualKeyCode: keyCode });
};
const hover = async (selector) => {
	const point = await b.centre(selector);
	await b.mouse("mouseMoved", { ...point, button: "none", buttons: 0 });
};
const nextFrame = () => b.evaluate("new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve(true))))");
const screenshot = async (name) => {
	await nextFrame();
	const path = `${outputDir}/${name}`;
	const image = await b.send("Page.captureScreenshot", { format: "png" });
	writeFileSync(path, Buffer.from(image.data, "base64"));
	console.log(`QA_SCREENSHOT ${path} bytes=${statSync(path).size}`);
};

try {
	await b.seed();
	await b.evaluate(`(() => {
		const element = document.querySelector('.app');
		let fiber = element[Object.keys(element).find(key => key.startsWith('__reactFiber'))];
		while (fiber && !fiber.memoizedProps?.value?.bus) fiber = fiber.return;
		if (!fiber) throw new Error('AppContext provider not found');
		const context = fiber.memoizedProps.value;
		window.__storyboardBus = context.bus;
		window.__storyboardState = context.live;
	})()`);
	await b.evaluate("window.__storyboardBus.run('character.update', { characterId: 'char-a', patch: { model: 'proxy-figure', x: 0, z: 0, rot: 0, posture: 'stand' } })");
	await b.change("!!window.__cozyclay?.editorCam", async () => {});
	await b.evaluate("window.__storyboardBus.run('shot.remove', { shotId: 'shot-a' }); window.__storyboardBus.run('shot.remove', { shotId: 'shot-b' });");
	const createOne = async caption => {
		const receipt = await b.evaluate(`window.__storyboardBus.run('shot.createStill', { caption: ${JSON.stringify(caption)} })`);
		assert.equal(receipt.ok, true, JSON.stringify(receipt));
	};
	await createOne("First panel");
	await createOne("Second panel");
	await b.evaluate("window.__cozyclay.scrub(48)");
	await b.change("window.__cozyclay.tlFrame === 48", async () => {});
	await b.evaluate("window.__storyboardBus.run('character.move', { characterId: 'char-a', x: 3, z: 0, rot: 0 })");
	await b.change("window.__storyboardState.state.shots[1]?.cast?.['char-a']?.x === 3", async () => {});
	assert.equal(await b.evaluate("window.__storyboardState.state.characters.find(c => c.id === 'char-a').x"), 0);
	const movedShot = `${outputDir}/task-11-still-2.png`;
	const movedImage = await b.send("Page.captureScreenshot", { format: "png" });
	writeFileSync(movedShot, Buffer.from(movedImage.data, "base64"));
	console.log(`QA_SCREENSHOT ${movedShot} bytes=${statSync(movedShot).size}`);
	await b.evaluate("window.__cozyclay.scrub(0)");
	await b.change("window.__cozyclay.tlFrame === 0", async () => {});
	assert.equal(await b.evaluate("window.__storyboardState.state.shots[0]?.cast?.['char-a']?.x ?? null"), null);
	console.log("PASS happy path: moving in still 2 writes only still 2 cast override");
	console.log("PASS happy path: scrubbing still 1 restores base placement and still 2 remains moved");

	await b.evaluate("window.__cozyclay.scrub(48)");
	await b.change("window.__cozyclay.tlFrame === 48", async () => {});
	await b.send("Input.dispatchKeyEvent", { type: "keyDown", key: "z", code: "KeyZ", windowsVirtualKeyCode: 90, modifiers: process.platform === "darwin" ? 4 : 2 });
	await b.send("Input.dispatchKeyEvent", { type: "keyUp", key: "z", code: "KeyZ", windowsVirtualKeyCode: 90, modifiers: process.platform === "darwin" ? 4 : 2 });
	await b.change("window.__storyboardState.state.shots[1]?.cast?.['char-a']?.x === undefined", async () => {});
	assert.equal(await b.evaluate("window.__storyboardState.state.characters.find(c => c.id === 'char-a').x"), 0);
	console.log("PASS happy path: Ctrl+Z once reverts only the still move");

	await b.evaluate("window.__cozyclay.scrub(120)");
	await b.change("window.__cozyclay.tlFrame === 120", async () => {});
	await b.evaluate("window.__storyboardBus.run('character.move', { characterId: 'char-a', x: 2, z: 0, rot: 0 })");
	await b.change("window.__storyboardState.state.characters.find(c => c.id === 'char-a').x === 2", async () => {});
	assert.equal(await b.evaluate("window.__storyboardState.state.shots.every(shot => !shot.cast?.['char-a'])"), true);
	console.log("PASS failure path: moving outside stills changes base placement and writes no override");
	const outsideShot = `${outputDir}/task-11-outside-still.png`;
	const outsideImage = await b.send("Page.captureScreenshot", { format: "png" });
	writeFileSync(outsideShot, Buffer.from(outsideImage.data, "base64"));
	console.log(`QA_SCREENSHOT ${outsideShot} bytes=${statSync(outsideShot).size}`);

	/* ------------------------------------------------- Board dock tab (#641) */
	await b.send("Emulation.setDeviceMetricsOverride", { width: 1600, height: 1000, deviceScaleFactor: 1, mobile: false });
	await seedProject("animation");
	assert.deepEqual(await tabKeys(), ["animation*", "assets"]);
	assert.equal(await b.evaluate("document.querySelector('[data-testid=dock-tab-board], [data-testid=dock-board]')"), null);
	console.log("PASS animation project: dock tabs Animation|Assets, no Board tab and no Board panel");

	await seedProject("storyboard");
	assert.deepEqual(await tabKeys(), ["board*", "assets"]);
	await b.change("!!document.querySelector('[data-testid=board-empty]')", async () => {});
	console.log("PASS storyboard project: dock tabs Board|Assets, Board selected, empty strip");

	await b.change("document.querySelectorAll('[data-testid=board-card]').length === 1", () => b.click("[data-testid=board-empty-add]"));
	assert.equal((await stillCaptions()).length, 1);
	console.log("PASS + Panel in the empty state adds card 1");

	// Failure path: deleting the only panel leaves the empty state with + Panel.
	await b.evaluate("document.querySelector('[data-testid=board-card]').focus()");
	await b.change("!!document.querySelector('[data-testid=board-empty] [data-testid=board-empty-add]')", () => key("Delete", "Delete", 46));
	assert.equal(await b.evaluate("window.__storyboardState.state.shots.length"), 0);
	assert.match(await b.evaluate("document.querySelector('[data-testid=board-empty]').textContent"), /No panels yet/);
	assert.equal(await b.evaluate("document.querySelectorAll('.dock-board .dock-board-add').length"), 1);
	assert.deepEqual(await b.evaluate("window.__boardErrors"), []);
	console.log("PASS failure path: Delete on the only focused card shows the empty state with + Panel, no page error");
	await screenshot("board-empty.png");

	for (const count of [1, 2, 3]) {
		const selector = count === 1 ? "[data-testid=board-empty-add]" : "[data-testid=board-add-panel]";
		await b.change(`document.querySelectorAll('[data-testid=board-card]').length === ${count}`, () => b.click(selector));
	}
	assert.equal(await cardCount(), 3);
	assert.deepEqual(await b.evaluate("[...document.querySelectorAll('[data-testid=board-card-index]')].map(node => node.textContent)"), ["1", "2", "3"]);
	console.log("PASS + Panel adds cards 1-3 in still order");

	const typeCaption = async (index, text) => {
		const selector = `[data-testid=board-card]:nth-child(${index}) [data-testid=board-card-caption]`;
		await b.click(selector);
		await b.send("Input.insertText", { text });
		await b.change(`window.__storyboardState.state.shots.filter(shot => shot.kind === 'still').sort((a, c) => a.startFrame - c.startFrame)[${index - 1}].caption === ${JSON.stringify(text)}`,
			() => b.click(".dock-board-count"));
	};
	await typeCaption(1, "One: she enters");
	await typeCaption(2, "Two: he turns");
	await typeCaption(3, "Three: they meet");
	assert.deepEqual(await stillCaptions(), ["One: she enters", "Two: he turns", "Three: they meet"]);
	console.log("PASS typing a caption and blurring writes shot.caption");

	await openStudio();
	await b.change("document.querySelectorAll('[data-testid=board-card]').length === 3", async () => {});
	assert.deepEqual(await stillCaptions(), ["One: she enters", "Two: he turns", "Three: they meet"]);
	assert.deepEqual(await b.evaluate("[...document.querySelectorAll('[data-testid=board-card-caption]')].map(node => node.value)"), ["One: she enters", "Two: he turns", "Three: they meet"]);
	console.log("PASS captions survive a reload");

	// The greybox thumbnail is captured after the 500 ms debounce.
	await b.change("document.querySelectorAll('[data-testid=board-card] .dock-board-image').length === 3", async () => {});
	assert.equal(await b.evaluate("[...document.querySelectorAll('.dock-board-image')].every(img => img.src.startsWith('data:image/png'))"), true);
	console.log("PASS every card shows a greybox thumbnail");

	const second = await b.evaluate("window.__storyboardState.state.shots.filter(shot => shot.kind === 'still').sort((a, c) => a.startFrame - c.startFrame)[1].startFrame");
	await b.change(`window.__cozyclay.tlFrame === ${second} && document.querySelector('[data-testid=board-card]:nth-child(2)')?.dataset.selected === 'true'`,
		() => b.click("[data-testid=board-card]:nth-child(2) .dock-board-thumb"));
	console.log(`PASS clicking card 2 selects it and moves the playhead to frame ${second}`);

	// HTML5 drag: card 3 dropped on the left half of card 1.
	await b.evaluate(`(async () => {
		const cards = [...document.querySelectorAll('[data-testid=board-card]')];
		const transfer = new DataTransfer();
		const frame = () => new Promise(resolve => requestAnimationFrame(resolve));
		const fire = (element, type, side) => {
			const box = element.getBoundingClientRect();
			element.dispatchEvent(new DragEvent(type, { bubbles: true, cancelable: true, dataTransfer: transfer,
				clientX: side === 'left' ? box.left + 4 : box.left + box.width / 2, clientY: box.top + box.height / 2 }));
		};
		fire(cards[2], 'dragstart');
		await frame();
		fire(cards[0], 'dragover', 'left');
		await frame();
		if (cards[0].dataset.drop !== 'before') throw new Error('no drop marker before card 1');
		fire(cards[0], 'drop', 'left');
		fire(cards[2], 'dragend');
	})()`);
	await b.change("document.querySelector('[data-testid=board-card] [data-testid=board-card-caption]')?.value === 'Three: they meet'", async () => {});
	assert.deepEqual(await stillCaptions(), ["Three: they meet", "One: she enters", "Two: he turns"]);
	const sequencer = await b.evaluate("[...document.querySelectorAll('.v2-sequencer [data-shot-kind=still]')].sort((a, c) => a.getBoundingClientRect().left - c.getBoundingClientRect().left).map(node => node.querySelector('.tl-shot-caption')?.textContent ?? '')");
	assert.deepEqual(sequencer, ["Three: they meet", "One: she enters", "Two: he turns"]);
	console.log(`PASS dragging card 3 before card 1 reorders the stills and the Sequencer: ${JSON.stringify(sequencer)}`);

	await hover("[data-testid=board-card]:nth-child(1)");
	await b.change("document.querySelectorAll('[data-testid=board-card]').length === 4", () => b.click("[data-testid=board-card]:nth-child(1) [data-action=duplicate]"));
	assert.deepEqual(await stillCaptions(), ["Three: they meet", "Three: they meet", "One: she enters", "Two: he turns"]);
	console.log("PASS Duplicate adds a card with the same caption right after it");

	const laterActions = await b.evaluate("[...document.querySelectorAll('[data-testid=board-card]:nth-child(1) [data-action]')].map(button => `${button.dataset.action}:${button.disabled ? button.dataset.disabledReason : 'enabled'}`)");
	assert.deepEqual(laterActions, ["duplicate:enabled", "delete:enabled", "stylize:enabled", "workflow:enabled", "export:enabled"]);
	console.log(`PASS card actions: ${laterActions.join(", ")}`);

	// Export on a card downloads that panel's pack (the Export menu's Panel pack).
	// The button is disabled with a reason while the job runs; the observer is
	// armed before the click so the transient state cannot be missed.
	const exportButton = "[data-testid=board-card]:nth-child(2) [data-action=export]";
	await hover("[data-testid=board-card]:nth-child(2)");
	const nextDownload = downloads.next();
	const busyReason = b.evaluate(`new Promise((resolve) => {
		const button = document.querySelector(${JSON.stringify(exportButton)});
		const observer = new MutationObserver(() => { if (button.disabled && button.dataset.disabledReason) { observer.disconnect(); resolve(button.dataset.disabledReason); } });
		observer.observe(button, { attributes: true });
		button.click();
	})`);
	const pack = await nextDownload;
	assert.equal(await busyReason, "export-running");
	console.log("PASS failure path: while the export job runs the card's Export is disabled with data-disabled-reason=export-running");
	assert.match(pack.name, /^cozyclay-panel-0[1-4]-[a-z0-9-]+\.zip$/);
	const listing = execFileSync("unzip", ["-Z1", pack.path], { encoding: "utf8" }).trim().split("\n");
	assert.ok(listing.length >= 4 && listing.every(name => name.startsWith(pack.name.match(/panel-0[1-4]/)[0] + "/")), JSON.stringify(listing));
	assert.ok(execFileSync("unzip", ["-t", pack.path], { encoding: "utf8" }).includes("No errors detected"));
	console.log(`PASS happy path: card 2 Export downloaded ${pack.name} ${JSON.stringify(listing)}`);
	await b.arm(`document.querySelector(${JSON.stringify(exportButton)}).disabled === false`);
	await b.settled();
	assert.equal(await b.evaluate(`document.querySelector(${JSON.stringify(exportButton)}).dataset.disabledReason ?? null`), null);
	console.log("PASS Export is enabled again once the job settles");

	const holdSelector = "[data-testid=board-card]:nth-child(1) [data-testid=board-card-hold]";
	await b.click(holdSelector);
	await b.evaluate(`document.querySelector(${JSON.stringify(holdSelector)}).select()`);
	await b.send("Input.insertText", { text: "3" });
	await b.change("(() => { const still = window.__storyboardState.state.shots.filter(shot => shot.kind === 'still').sort((a, c) => a.startFrame - c.startFrame)[0]; return still.endFrame - still.startFrame + 1 === 72; })()",
		() => key("Enter", "Enter", 13));
	const ranges = await b.evaluate("window.__storyboardState.state.shots.filter(shot => shot.kind === 'still').sort((a, c) => a.startFrame - c.startFrame).map(shot => [shot.startFrame, shot.endFrame])");
	assert.deepEqual(ranges[0], [0, 71]);
	assert.equal(ranges[1][0], 72);
	console.log(`PASS hold 3 s sets the first panel to 72 frames; stills now ${JSON.stringify(ranges)}`);

	assert.deepEqual(await b.evaluate("window.__boardErrors"), []);
	console.log("PASS zero page errors");

	await b.evaluate("document.activeElement?.blur()");
	await b.change("document.querySelectorAll('[data-testid=board-card] .dock-board-image').length === 4", async () => {});
	await hover("[data-testid=board-card]:nth-child(2)");
	for (const theme of ["light", "dark"]) {
		await b.evaluate(`(() => {
			document.documentElement.dataset.theme = ${JSON.stringify(theme)};
			window.dispatchEvent(new CustomEvent('cozyclay:theme-change', { detail: ${JSON.stringify(theme)} }));
		})()`);
		await screenshot(`board-${theme}.png`);
	}
	await screenshot("task-12-previs-modes.png");

	/* ------------------------------------------- panel Stylize (#643) */
	await b.evaluate(`(() => { document.documentElement.dataset.theme = 'dark'; window.dispatchEvent(new CustomEvent('cozyclay:theme-change', { detail: 'dark' })); })()`);
	const sidecar = await imageSidecarStub();
	try {
		const firstStill = "window.__storyboardState.state.shots.filter(shot => shot.kind === 'still').sort((a, c) => a.startFrame - c.startFrame)[0]";
		const card1 = "[data-testid=board-card]:nth-child(1)";
		assert.equal(await b.evaluate(`${firstStill}.stylizedAssetId`), null);

		// Happy path: the request is held until the card has shown its state.
		sidecar.mode = "hold";
		const paused = sidecar.next();
		await hover(card1);
		await b.change(`document.querySelector('${card1} [data-testid=board-card-stylizing]')?.textContent === 'Stylizing...' && document.querySelector('${card1} [data-action=stylize]').disabled`,
			() => b.click(`${card1} [data-action=stylize]`));
		const request = await paused;
		console.log(`PASS Stylize shows "${await b.evaluate(`document.querySelector('${card1} [data-testid=board-card-stylizing]').textContent`)}" on the card while /agent/image is pending`);
		await screenshot("task-14-stylizing.png");
		assert.deepEqual(Object.keys(request.body).sort(), ["imageDataUrl", "prompt", "quality"]);
		assert.equal(request.body.quality, "auto");
		assert.ok(request.body.imageDataUrl.startsWith("data:image/png;base64,"));
		assert.ok(request.body.prompt.includes("Three: they meet"), request.body.prompt);
		assert.ok(request.body.prompt.startsWith("Use the first image (a clay blocking frame) as the layout"), request.body.prompt);
		const frameSize = pngSize(request.body.imageDataUrl);
		console.log(`PASS request: POST ${request.url} quality=${request.body.quality} frame=${frameSize.width}x${frameSize.height} prompt=${JSON.stringify(request.body.prompt)}`);
		await b.change(`${firstStill}.stylizedAssetId?.startsWith('img-') && document.querySelector('${card1} .dock-board-thumb')?.dataset.stylized === 'true' && !!document.querySelector('${card1} .dock-board-inset') && !document.querySelector('${card1} [data-testid=board-card-stylizing]')`,
			() => sidecar.release(request, 200, { dataUrl: `data:image/png;base64,${STUB_PNG.toString("base64")}`, width: 64, height: 64 }));
		const stylizedId = await b.evaluate(`${firstStill}.stylizedAssetId`);
		const shown = await b.evaluate(`(async () => { const img = document.querySelector('${card1} .dock-board-image'); await img.decode(); return [img.naturalWidth, img.naturalHeight, document.querySelector('${card1} .dock-board-inset').src.startsWith('data:image/png')]; })()`);
		assert.deepEqual(shown, [64, 64, true]);
		assert.equal(await b.evaluate(`document.querySelector('${card1} [data-action=stylize]').textContent`), "Re-stylize");
		console.log(`PASS card 1 shows the 64x64 stylized image (${stylizedId}) with the greybox inset; the action now reads Re-stylize`);
		await hover(card1);
		await screenshot("task-14-previs-modes.png");

		// Remove clears and is undoable.
		await b.change(`${firstStill}.stylizedAssetId === null && !document.querySelector('${card1} .dock-board-thumb')?.dataset.stylized`, () => b.click(`${card1} [data-action=unstylize]`));
		await b.evaluate("document.activeElement?.blur()");
		await b.change(`${firstStill}.stylizedAssetId === ${JSON.stringify(stylizedId)} && document.querySelector('${card1} .dock-board-thumb')?.dataset.stylized === 'true'`, async () => {
			await b.send("Input.dispatchKeyEvent", { type: "keyDown", key: "z", code: "KeyZ", windowsVirtualKeyCode: 90, modifiers: process.platform === "darwin" ? 4 : 2 });
			await b.send("Input.dispatchKeyEvent", { type: "keyUp", key: "z", code: "KeyZ", windowsVirtualKeyCode: 90, modifiers: process.platform === "darwin" ? 4 : 2 });
		});
		console.log("PASS Remove clears the stylized image and one undo brings it back");

		// Failure path: an entitlement refusal is a toast and the card is unchanged.
		sidecar.mode = "entitlement";
		const before = await b.evaluate(`JSON.stringify(${firstStill})`);
		const refusedRequest = sidecar.next();
		await hover(card1);
		await b.change("document.querySelector('.toast')?.textContent === 'This account cannot generate images.'", () => b.click(`${card1} [data-action=stylize]`));
		// The toast lives 2.2 s: read it and take the picture before anything slower.
		const toastText = await b.evaluate("document.querySelector('.toast')?.textContent");
		await screenshot("task-14-entitlement.png");
		await refusedRequest;
		await b.change(`!document.querySelector('${card1} [data-testid=board-card-stylizing]')`, async () => {});
		assert.equal(await b.evaluate(`JSON.stringify(${firstStill})`), before);
		assert.equal(await b.evaluate(`document.querySelector('${card1} .dock-board-thumb').dataset.stylized`), "true");
		console.log(`PASS failure path: 403 entitlement -> toast "${toastText}"; the panel keeps ${stylizedId}`);
		assert.deepEqual(await b.evaluate("window.__boardErrors"), []);

		// Save the project to a file and reopen it in a profile whose asset
		// store is empty: the picture comes back from the file alone.
		const projectPath = `${outputDir}/task-14-board.cclayproject`;
		const saved = await b.evaluate("window.__cozyclayProject.export('Board stylize')");
		writeFileSync(projectPath, saved);
		const embedded = JSON.parse(saved).resources.assets.map(asset => asset.id);
		assert.ok(embedded.includes(stylizedId), JSON.stringify(embedded));
		console.log(`PASS saved ${projectPath} bytes=${statSync(projectPath).size} embeds ${stylizedId}`);
		await b.navigate(`${b.base.origin}/favicon.ico`);
		await b.evaluate("new Promise((resolve, reject) => { const request = indexedDB.deleteDatabase('cozyclay.assets'); request.onsuccess = () => resolve(true); request.onerror = () => reject(request.error); request.onblocked = () => resolve(true); })");
		await seedProject("storyboard");
		// Opening a missing database would create it without its store, so look first.
		assert.equal(await b.evaluate(`indexedDB.databases().then(list => !list.some(db => db.name === 'cozyclay.assets') ? 0 : new Promise(resolve => { const open = indexedDB.open('cozyclay.assets'); open.onsuccess = () => { const db = open.result; if (!db.objectStoreNames.contains('images')) { db.close(); resolve(0); return; } const count = db.transaction('images').objectStore('images').count(); count.onsuccess = () => { db.close(); resolve(count.result); }; }; }))`), 0);
		const opened = await b.evaluate(`window.__cozyclayProject.open(${JSON.stringify(readFileSync(projectPath, "utf8"))}).then(result => result.ok)`);
		assert.equal(opened, true);
		// Opening a project remounts the studio: hook the new context.
		await b.change("document.querySelectorAll('[data-testid=board-card]').length === 4", async () => {});
		await hookBus();
		await b.change(`${firstStill}?.stylizedAssetId === ${JSON.stringify(stylizedId)} && document.querySelector('${card1} .dock-board-thumb')?.dataset.stylized === 'true'`, async () => {});
		assert.equal(await b.evaluate(`(async () => { const img = document.querySelector('${card1} .dock-board-image'); await img.decode(); return img.naturalWidth; })()`), 64);
		console.log("PASS reopened from the file with an empty asset store: card 1 still shows the stylized image");
		await screenshot("task-14-reopened.png");
	} finally {
		sidecar.close();
	}
} finally {
	downloads.close();
	b.close();
	rmSync(downloadDir, { recursive: true, force: true });
}

/* ---------------------------------------------------- stub sidecar ---- */

// A 64x64 PNG, the stub's stylized picture.
function stubPng() {
	const chunk = (type, data) => {
		const length = Buffer.alloc(4); length.writeUInt32BE(data.length);
		const body = Buffer.concat([Buffer.from(type), data]);
		const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(body));
		return Buffer.concat([length, body, crc]);
	};
	const header = Buffer.alloc(13);
	header.writeUInt32BE(64, 0); header.writeUInt32BE(64, 4); header[8] = 8; header[9] = 2;
	const rows = Buffer.alloc(64 * (1 + 64 * 3));
	for (let y = 0; y < 64; y++) for (let x = 0; x < 64; x++) {
		const at = y * (1 + 64 * 3) + 1 + x * 3;
		rows[at] = 200; rows[at + 1] = 120 + x; rows[at + 2] = 60 + y * 2;
	}
	return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk("IHDR", header), chunk("IDAT", deflateSync(rows)), chunk("IEND", Buffer.alloc(0))]);
}

function pngSize(dataUrl) {
	const bytes = Buffer.from(dataUrl.slice(dataUrl.indexOf(",") + 1), "base64");
	return { width: bytes.readUInt32BE(16), height: bytes.readUInt32BE(20) };
}

/** /agent/image answered inside the browser through the CDP Fetch domain on a
 * second DevTools connection, so the suite needs no sidecar process. `next()`
 * resolves with the next intercepted request; mode "hold" keeps it paused
 * until `release()`, "entitlement" refuses it like a plan without images. */
async function imageSidecarStub() {
	const targets = await (await fetch(`http://127.0.0.1:${Number(process.env.CDP_PORT || 9222)}/json`)).json();
	const page = targets.find((target) => target.type === "page" && target.webSocketDebuggerUrl);
	const ws = new WebSocket(page.webSocketDebuggerUrl);
	await new Promise((resolve, reject) => { ws.onopen = resolve; ws.onerror = reject; });
	let id = 0;
	const pending = new Map();
	const send = (method, params = {}) => new Promise((resolve, reject) => {
		const requestId = ++id;
		pending.set(requestId, { resolve, reject });
		ws.send(JSON.stringify({ id: requestId, method, params }));
	});
	const stub = { mode: "hold", waiters: [] };
	const fulfill = (requestId, status, json) => send("Fetch.fulfillRequest", {
		requestId, responseCode: status,
		responseHeaders: [{ name: "content-type", value: "application/json" }],
		body: Buffer.from(JSON.stringify(json)).toString("base64"),
	});
	ws.onmessage = (event) => {
		const message = JSON.parse(event.data);
		if (message.id && pending.has(message.id)) {
			const { resolve, reject } = pending.get(message.id);
			pending.delete(message.id);
			if (message.error) reject(new Error(JSON.stringify(message.error)));
			else resolve(message.result);
			return;
		}
		if (message.method !== "Fetch.requestPaused") return;
		const { requestId, request } = message.params;
		const raw = request.postData ?? (request.postDataEntries ?? []).map((entry) => Buffer.from(entry.bytes ?? "", "base64").toString("utf8")).join("");
		const seen = { requestId, url: new URL(request.url).pathname, method: request.method, body: JSON.parse(raw) };
		if (stub.mode === "entitlement") fulfill(requestId, 403, { error: { code: "entitlement", message: "403 \u2014 This account cannot generate images.", status: 403 } });
		stub.waiters.shift()?.(seen);
	};
	await send("Fetch.enable", { patterns: [{ urlPattern: "*/agent/image", requestStage: "Request" }] });
	return {
		set mode(value) { stub.mode = value; },
		next: () => new Promise((resolve) => stub.waiters.push(resolve)),
		release: (seen, status, json) => fulfill(seen.requestId, status, json),
		close: () => { send("Fetch.disable").catch(() => {}).finally(() => ws.close()); },
	};
}

/* ------------------------------------------------------ downloads ---- */

/** Browser downloads land in `dir` under their guid; `next()` resolves with
 * the next completed one, subscribed before the click that starts it. */
async function downloadWatcher(dir) {
	const targets = await (await fetch(`http://127.0.0.1:${Number(process.env.CDP_PORT || 9222)}/json`)).json();
	const page = targets.find((target) => target.type === "page" && target.webSocketDebuggerUrl);
	const ws = new WebSocket(page.webSocketDebuggerUrl);
	await new Promise((resolve, reject) => { ws.onopen = resolve; ws.onerror = reject; });
	let id = 0;
	const pending = new Map();
	const names = new Map();
	const waiters = [];
	ws.onmessage = (event) => {
		const message = JSON.parse(event.data);
		if (message.id && pending.has(message.id)) {
			const { resolve, reject } = pending.get(message.id);
			pending.delete(message.id);
			if (message.error) reject(new Error(JSON.stringify(message.error)));
			else resolve(message.result);
		} else if (message.method === "Browser.downloadWillBegin") {
			names.set(message.params.guid, message.params.suggestedFilename);
		} else if (message.method === "Browser.downloadProgress" && message.params.state !== "inProgress") {
			const { guid, state } = message.params;
			const waiter = waiters.shift();
			if (!waiter) return;
			if (state === "completed") waiter.resolve({ name: names.get(guid), path: join(dir, guid) });
			else waiter.reject(new Error(`download ${names.get(guid)} ${state}`));
		}
	};
	const send = (method, params = {}) => new Promise((resolve, reject) => {
		const requestId = ++id;
		pending.set(requestId, { resolve, reject });
		ws.send(JSON.stringify({ id: requestId, method, params }));
	});
	await send("Browser.setDownloadBehavior", { behavior: "allowAndName", downloadPath: dir, eventsEnabled: true });
	return {
		next: () => new Promise((resolve, reject) => {
			const timer = setTimeout(() => reject(new Error("download timeout")), 120_000);
			waiters.push({ resolve: (value) => { clearTimeout(timer); resolve(value); }, reject: (error) => { clearTimeout(timer); reject(error); } });
		}),
		close: () => { send("Browser.setDownloadBehavior", { behavior: "default" }).catch(() => {}).finally(() => ws.close()); },
	};
}

#!/usr/bin/env node
// Storyboard browser QA: per-panel cast overrides (#640) and the Board dock
// tab (#641). Run through tools/qa-browser.mjs with QA_URL at `/app/?previs=1`.
import assert from "node:assert/strict";
import { mkdirSync, statSync, writeFileSync } from "node:fs";
import { cameraBrowser } from "./camera-browser-harness.mjs";
import { SCENES_STORAGE_KEY } from "../src/scenes.js";

const outputDir = process.env.QA_OUT || "/Users/yun/CozyClay/.omo/evidence/previs-modes/previs-modes-r5/shots";
mkdirSync(outputDir, { recursive: true });
const b = await cameraBrowser();

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
		localStorage.setItem('cozyclay.previs-modes', '1');
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
	await b.navigate(new URL("/app/?previs=1", b.base));
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
	assert.deepEqual(laterActions, ["duplicate:enabled", "delete:enabled", "stylize:coming in a later PR", "workflow:coming in a later PR", "export:coming in a later PR"]);
	console.log(`PASS card actions: ${laterActions.join(", ")}`);

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
} finally {
	b.close();
}

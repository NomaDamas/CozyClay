#!/usr/bin/env node
import assert from "node:assert/strict";
import { mkdirSync, statSync, writeFileSync } from "node:fs";
import { cameraBrowser } from "./camera-browser-harness.mjs";

const outputDir = process.env.QA_OUT || "/Users/yun/CozyClay/.omo/evidence/previs-modes/previs-modes-r2/shots";
mkdirSync(outputDir, { recursive: true });
const b = await cameraBrowser();
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
} finally {
	b.close();
}

#!/usr/bin/env node
// Real Studio acceptance: author Shot A, edit Shot B, return to A, exit
// shot-look, then open the Workflow embed. Every asynchronous assertion is
// subscribed before its triggering action (DOM, QA-state, or camera change).
import assert from "node:assert/strict";
import { cameraBrowser, assertPose } from "./camera-browser-harness.mjs";

const b = await cameraBrowser();
const shown = (selector) => `(() => { const e = document.querySelector(${JSON.stringify(selector)}); return !!e && !e.hidden && !!e.offsetParent; })()`;
const documentShots = async () => {
	const project = JSON.parse(await b.evaluate("window.__cozyclayProject.export('Shot-look QA')"));
	return project.scenes.scenes.find((scene) => scene.id === "camera-qa").shotDocument.shots;
};
const fly = async (dx, dy) => {
	const before = await b.pose();
	const p = await b.centre(".stage canvas");
	await b.mouse("mouseMoved", { ...p });
	await b.change("document.pointerLockElement === document.querySelector('.stage canvas')", () =>
		b.mouse("mousePressed", { ...p, button: "right", buttons: 2, clickCount: 1 }));
	await b.change(`Math.abs(window.__cozyclay.shotCam.rotation.y - ${before.yaw}) > 0.01`, () =>
		b.mouse("mouseMoved", { x: p.x + dx, y: p.y + dy, button: "right", buttons: 2 }));
	await b.change("document.pointerLockElement === null", () =>
		b.mouse("mouseReleased", { x: p.x + dx, y: p.y + dy, button: "right", buttons: 0, clickCount: 1 }));
	return b.pose();
};

try {
	await b.seed();
	assert.equal(await b.evaluate("globalThis.playMode"), false);
	assert.equal(await b.evaluate("document.querySelectorAll('.pane-tabs').length"), 0);
	assert.equal(await b.evaluate(shown(".vp-look-through")), true);
	const editor = await b.pose("editorCam");
	// A parked playhead must not restart or auto-play on entering shot-look.
	await b.change("window.__cozyclay.tlFrame === 12", () => b.evaluate("window.__cozyclay.scrub(12)"));
	await b.change("window.__cozyclay.lookThroughShot === true", () => b.click(".vp-look-through"));
	assert.equal(await b.evaluate("window.__cozyclay.preview"), false);
	assert.equal(await b.evaluate("window.__cozyclay.playing"), false);
	assert.equal(await b.evaluate("window.__cozyclay.tlFrame"), 12);
	assert.equal(await b.evaluate("window.__cozyclay.activeCam === window.__cozyclay.shotCam"), true);
	assert.equal(await b.evaluate("document.querySelector('[data-testid=shot-look-toggle]').getAttribute('aria-pressed')"), "true");
	assert.equal(await b.evaluate(shown(".vp-shot-preview")), false);
	assert.equal(await b.evaluate(shown(".vp-inset")), true);
	console.log("PASS Studio look-through is editable shot view, not the player; playhead and playback stay parked");

	const framedA = await fly(80, 24);
	await b.change("document.querySelectorAll('.tl-marker.cam').length > 1", () => b.click('[aria-label="Add camera key in Shot A"]'));
	const savedA = (await documentShots()).find((shot) => shot.id === "shot-a");
	assert.equal(savedA.cameraKeys.length, 1);
	assertPose(savedA.cameraKeys[0].framing, framedA, "Shot A key stores the actual flown lens");
	console.log("PASS Shot A right-drag changes the recording camera and the key strip saves that framing");

	await b.change("window.__cozyclay.tlFrame === 48 && Math.abs(window.__cozyclay.shotCam.rotation.y + 0.45) < 1e-5", () =>
		b.click('.tl-shot-block:has([aria-label="Add camera key in Shot B"]) .tl-shot-label'));
	assert.equal(await b.evaluate("window.__cozyclay.lookThroughShot"), true);
	const framedB = await fly(-65, -18);
	await b.change("document.querySelectorAll('.tl-marker.cam').length > 2", () => b.click('[aria-label="Add camera key in Shot B"]'));
	const afterB = await documentShots();
	assert.deepEqual(afterB.find((shot) => shot.id === "shot-a"), savedA, "editing B cannot mutate A's camera block or keys");
	const savedB = afterB.find((shot) => shot.id === "shot-b");
	assertPose(savedB.cameraKeys.find((key) => key.id !== "key-b").framing, framedB, "Shot B stores its independently flown framing");
	await b.change(`window.__cozyclay.tlFrame === 0 && Math.abs(window.__cozyclay.shotCam.rotation.y - ${framedA.yaw}) < 1e-5`, () =>
		b.click(".tl-shot-block .tl-shot-label"));
	assertPose(await b.pose(), framedA, "returning to A restores the authored framing");
	assertPose(await b.pose("editorCam"), editor, "neither shot edit moves the free camera");
	console.log("PASS Shot A saved -> Shot B edited and saved -> Shot A framing preserved in data and the live camera");

	await b.change("window.__cozyclay.lookThroughShot === false", () => b.escape());
	assert.equal(await b.evaluate("document.pointerLockElement"), null);
	assert.equal(await b.evaluate("window.__cozyclay.activeCam === window.__cozyclay.editorCam"), true);
	assert.equal(await b.evaluate(shown(".vp-shot-preview")), true);
	assert.equal(await b.evaluate("window.__cozyclay.playing"), false);
	console.log("PASS Escape leaves shot-look, restores the free camera and monitor, and leaves playback paused");

	await b.navigate(new URL("/app/?embed=playview", b.base));
	await b.ready();
	assert.equal(await b.evaluate("globalThis.playMode && window.__cozyclay.preview && window.__cozyclay.lookThroughShot"), true);
	assert.equal(await b.evaluate(shown(".viewport-titlebar")), false);
	assert.equal(await b.evaluate(shown(".vp-inset")), false);
	assert.equal(await b.evaluate(shown(".vp-shot-preview")), false);
	assert.equal(await b.evaluate("document.querySelectorAll('.vp-look-through-exit').length"), 0);
	const embedPose = await b.pose();
	const p = await b.centre(".stage canvas");
	await b.mouse("mousePressed", { ...p, button: "right", buttons: 2, clickCount: 1 });
	await b.mouse("mouseMoved", { x: p.x + 70, y: p.y + 20, button: "right", buttons: 2 });
	await b.mouse("mouseReleased", { x: p.x + 70, y: p.y + 20, button: "right", buttons: 0, clickCount: 1 });
	await b.escape();
	assert.equal(await b.evaluate("document.pointerLockElement"), null);
	assert.equal(await b.evaluate("globalThis.playMode"), true);
	assertPose(await b.pose(), embedPose, "Workflow player cannot fly the recording camera");
	console.log("PASS Workflow embed remains chrome-free, has no exit affordance, and disables fly navigation");
	console.log("qa-preview-browser: all behavioral checks passed");
} finally {
	b.close();
}

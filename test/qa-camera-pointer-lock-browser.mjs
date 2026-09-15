#!/usr/bin/env node
// Native Chromium pointer-lock acceptance. The Node companion deterministically
// covers both event orderings, denied lock, late grants, and stray pointerups.
import assert from "node:assert/strict";
import { cameraBrowser, assertPose } from "./camera-browser-harness.mjs";

const b = await cameraBrowser();
try {
	await b.seed();
	const shot = await b.pose();
	const editor = await b.pose("editorCam");
	const p = await b.centre(".stage canvas");
	await b.mouse("mouseMoved", { ...p });
	await b.change("document.pointerLockElement === document.querySelector('.stage canvas')", () =>
		b.mouse("mousePressed", { ...p, button: "right", buttons: 2, clickCount: 1 }));
	await b.change(`Math.abs(window.__cozyclay.editorCam.rotation.y - ${editor.yaw}) > 0.01`, () =>
		b.mouse("mouseMoved", { x: p.x + 90, y: p.y + 24, button: "right", buttons: 2 }));
	await b.change("document.pointerLockElement === null", () =>
		b.mouse("mouseReleased", { x: p.x + 90, y: p.y + 24, button: "right", buttons: 0, clickCount: 1 }));
	assertPose(await b.pose(), shot, "flying the free camera leaves the recording camera untouched");
	assert.equal(await b.evaluate("window.__cozyclayCameraGesture"), false);
	await b.escape();
	assert.equal(await b.evaluate("window.__cozyclay.lookThroughShot"), false);
	console.log("PASS free-camera right-drag acquires real pointer lock, turns the view, and releases without changing the shot");

	await b.change("window.__cozyclay.lookThroughShot === true", () => b.click('[data-testid="shot-look-toggle"]'));
	const shotPoint = await b.centre(".stage canvas");
	await b.mouse("mouseMoved", { ...shotPoint });
	await b.change("document.pointerLockElement === document.querySelector('.stage canvas')", () =>
		b.mouse("mousePressed", { ...shotPoint, button: "right", buttons: 2, clickCount: 1 }));
	await b.change("document.pointerLockElement === null", () => b.escape());
	assert.equal(await b.evaluate("window.__cozyclayCameraGesture"), false);
	// Chromium may consume the first Esc as its unlock gesture. If shot-look
	// remains, the very next Esc must leave, without any grace-period wait.
	if (await b.evaluate("window.__cozyclay.lookThroughShot")) {
		await b.change("window.__cozyclay.lookThroughShot === false", () => b.escape());
	}
	assert.equal(await b.evaluate("window.__cozyclay.activeCam === window.__cozyclay.editorCam"), true);
	assert.equal(await b.evaluate("globalThis.playMode"), false);
	await b.mouse("mouseReleased", { ...shotPoint, button: "right", buttons: 0, clickCount: 1 });
	console.log("PASS native Escape releases pointer lock; the immediate next Escape leaves shot-look if Chromium unlocks first");
	console.log("qa-camera-pointer-lock-browser: all behavioral checks passed");
} finally {
	b.close();
}

#!/usr/bin/env node
import assert from "node:assert/strict";
import { cameraBrowser } from "./camera-browser-harness.mjs";
import { SCENES_STORAGE_KEY } from "../src/scenes.js";

const b = await cameraBrowser();
try {
	const click = selector => b.evaluate(`(() => {
		const element = document.querySelector(${JSON.stringify(selector)});
		if (!element) throw new Error("missing element: " + ${JSON.stringify(selector)});
		element.click();
		return true;
	})()`);
	console.log("seed: navigate");
	await b.navigate(new URL("/app/?scene=city-block", b.base));
	await b.arm("window.__cozyclay?.frameCount === 432 && !!window.__cozyclay.motion");
	await b.settled();
	console.log("seed: ready");
	const seeded = await b.evaluate(`(async () => {
		const db = await new Promise((resolve, reject) => {
			const request = indexedDB.open("cozyclay.motions");
			request.onsuccess = () => resolve(request.result);
			request.onerror = () => reject(request.error);
		});
		const records = await new Promise((resolve, reject) => {
			const request = db.transaction("motions", "readonly").objectStore("motions").getAllKeys();
			request.onsuccess = () => resolve(request.result);
			request.onerror = () => reject(request.error);
		});
		db.close();
		const scene = JSON.parse(localStorage.getItem(${JSON.stringify(SCENES_STORAGE_KEY)}));
		return {
			keys: Object.keys(localStorage),
			scene: {
				activeSceneId: scene?.activeSceneId,
				name: scene?.scenes?.[0]?.name,
				motionRefs: scene?.scenes?.flatMap((entry) => entry.stage?.characters?.map((character) => character.motionRef) ?? []),
			},
			motionRecords: records,
			frameCount: window.__cozyclay.frameCount,
			motion: Boolean(window.__cozyclay.motion),
		};
	})()`);
	await b.evaluate("window.confirm = () => true");
	console.log("seed: dumped");
	await click('[data-testid="menu-file"]');
	console.log("new: file menu");
	await click('[data-testid="menubar-new"]');
	console.log("new: chooser");
	await b.arm("document.querySelector('[data-template-id=\"blank-stage\"]')");
	await b.settled();
	await click('[data-template-id="blank-stage"]');
	console.log("new: blank selected");
	await b.arm("document.querySelector('[data-testid=\"start-project-name\"]')");
	await b.settled();
	await click('[data-testid="start-create"]');
	console.log("new: created");
	await b.arm("document.querySelector('.studio-project-head') && window.__cozyclay?.frameCount === 360");
	await b.settled();
	const afterCreate = await b.evaluate(`(async () => {
		const db = await new Promise((resolve, reject) => {
			const request = indexedDB.open("cozyclay.motions");
			request.onsuccess = () => resolve(request.result);
			request.onerror = () => reject(request.error);
		});
		const records = await new Promise((resolve, reject) => {
			const request = db.transaction("motions", "readonly").objectStore("motions").getAllKeys();
			request.onsuccess = () => resolve(request.result);
			request.onerror = () => reject(request.error);
		});
		db.close();
		const scene = JSON.parse(localStorage.getItem(${JSON.stringify(SCENES_STORAGE_KEY)}));
		return {
		document: {
			activeSceneId: scene?.activeSceneId,
			name: scene?.scenes?.[0]?.name,
			motionRefs: scene?.scenes?.flatMap((entry) => entry.stage?.characters?.map((character) => character.motionRef) ?? []),
		},
		frameCount: window.__cozyclay.frameCount,
		motion: Boolean(window.__cozyclay.motion),
		dirty: Boolean(document.querySelector(".project-dirty-dot")),
		keys: Object.keys(localStorage),
		motionRecords: records,
		};
	})()`);
	console.log("new: dumped");
	assert.equal(afterCreate.document.name, "SCENE 01");
	assert.equal(afterCreate.frameCount, 360);
	assert.equal(afterCreate.motion, false);
	assert.equal(afterCreate.dirty, false);

	await b.navigate(new URL("/app/", b.base));
	// Wait for the restored studio, not for the take: the fix means no take comes back.
	await b.arm("document.querySelector('.studio-project-head') && typeof window.__cozyclay?.frameCount === 'number'");
	await b.settled();
	const afterReload = await b.evaluate(`(() => {
		const scene = JSON.parse(localStorage.getItem(${JSON.stringify(SCENES_STORAGE_KEY)}));
		return {
		document: {
			activeSceneId: scene?.activeSceneId,
			name: scene?.scenes?.[0]?.name,
			motionRefs: scene?.scenes?.flatMap((entry) => entry.stage?.characters?.map((character) => character.motionRef) ?? []),
		},
		frameCount: window.__cozyclay.frameCount,
		motion: Boolean(window.__cozyclay.motion),
		dirty: Boolean(document.querySelector(".project-dirty-dot")),
		};
	})()`);
	console.log("reload: dumped");
	console.log("project-session-reset:", JSON.stringify({
		seeded: {
			keys: seeded.keys,
			scene: seeded.scene,
			motionRecords: seeded.motionRecords,
			frameCount: seeded.frameCount,
			motion: seeded.motion,
		},
		afterCreate: {
			keys: afterCreate.keys,
			document: afterCreate.document,
			motionRecords: afterCreate.motionRecords,
			frameCount: afterCreate.frameCount,
			motion: afterCreate.motion,
			dirty: afterCreate.dirty,
		},
		afterReload,
	}));
	assert.equal(afterReload.document.name, "SCENE 01");
	assert.equal(afterReload.frameCount, 360);
	assert.equal(afterReload.motion, false);
	assert.equal(afterReload.dirty, false);
} finally {
	b.close();
}

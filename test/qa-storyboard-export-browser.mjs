#!/usr/bin/env node
// Storyboard exports (#644): in a storyboard project the Export menu offers
// exactly the six panel exports, all disabled (with a reason) until there is a
// panel; All panels downloads one zip with a panel-NN/ folder per panel; the
// animatic holds every panel for its hold; the cut list makes each still a
// clip as long as its hold. Downloads are the real browser downloads, read
// back from the folder Chrome writes them to. Run through tools/qa-browser.mjs
// with QA_URL at `/app/`.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { crc32, deflateSync } from "node:zlib";
import { ALL_FORMATS, BufferSource, Input } from "mediabunny";
import { cameraBrowser } from "./camera-browser-harness.mjs";
import { SCENES_STORAGE_KEY } from "../src/scenes.js";

const outputDir = process.env.QA_OUT || "/Users/yun/CozyClay/.omo/evidence/previs-modes/previs-modes-r7/shots";
mkdirSync(outputDir, { recursive: true });
const downloadDir = mkdtempSync(join(tmpdir(), "cozyclay-storyboard-export-"));
const b = await cameraBrowser();
const downloads = await downloadWatcher(downloadDir);

const EXPECTED = ["Contact sheet (PNG)", "Panel pack (zip)", "All panels (zip)", "Animatic (mp4)", "Cut list (OTIO)", "Depth + normal (PNG)"];

await b.send("Page.addScriptToEvaluateOnNewDocument", { source: `(() => {
	window.__exportErrors = [];
	window.addEventListener('error', (event) => window.__exportErrors.push(String(event.message)));
	window.addEventListener('unhandledrejection', (event) => window.__exportErrors.push(String(event.reason?.message ?? event.reason)));
})()` });

const hookBus = () => b.evaluate(`(() => {
	const element = document.querySelector('.app');
	let fiber = element[Object.keys(element).find(key => key.startsWith('__reactFiber'))];
	while (fiber && !fiber.memoizedProps?.value?.bus) fiber = fiber.return;
	if (!fiber) throw new Error('AppContext provider not found');
	window.__exportBus = fiber.memoizedProps.value.bus;
	window.__exportState = fiber.memoizedProps.value.live;
	return true;
})()`);

const seedProject = async (previsMode) => {
	await b.navigate(`${b.base.origin}/favicon.ico`);
	await b.evaluate(`(() => {
		localStorage.clear();
		localStorage.setItem('cozyclay.locale', 'en');
		localStorage.setItem('cozyclay.project-session.v1', JSON.stringify({ name: 'Export QA', previsMode: ${JSON.stringify(previsMode)}, updatedAt: Date.now() }));
		localStorage.setItem('${SCENES_STORAGE_KEY}', JSON.stringify({ version: 4, activeSceneId: 'export-qa', scenes: [{
			id: 'export-qa', name: 'Export QA', objects: [],
			shotDocument: { version: 4, frameCount: 144, waypoints: [], shots: [] },
			stage: { characters: [{ id: 'char-a', model: 'y-bot-tpose', x: 0, z: 0, rot: 0, hidden: false, pose: null, subject: 'a person' }], hasCharSheet: false, shotAspect: '16:9' }
		}] }));
	})()`);
	await b.navigate(new URL("/app/", b.base));
	await b.ready();
	await hookBus();
};

const openExportMenu = async () => {
	if (!await b.evaluate("!!document.querySelector('#export-menu-trigger')")) {
		await b.change("!!document.querySelector('#export-menu-trigger')", () => b.click("[data-testid=menu-file]"));
	}
	if (!await b.evaluate("!!document.querySelector('.export-menu')")) {
		await b.change("!!document.querySelector('.export-menu [role=menuitem]')", () => b.click("#export-menu-trigger"));
	}
};
const menuItems = () => b.evaluate("[...document.querySelectorAll('.export-menu [role=menuitem]')].map(item => ({ testId: item.dataset.testid, label: item.querySelector('.menubar-item-label')?.textContent, disabled: item.disabled, reason: item.dataset.disabledReason ?? null }))");
const screenshot = async (name) => {
	await b.evaluate("new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve(true))))");
	const path = `${outputDir}/${name}`;
	const image = await b.send("Page.captureScreenshot", { format: "png" });
	writeFileSync(path, Buffer.from(image.data, "base64"));
	console.log(`QA_SCREENSHOT ${path} bytes=${statSync(path).size}`);
};
const stills = () => b.evaluate("window.__exportState.state.shots.filter(shot => shot.kind === 'still').sort((a, c) => a.startFrame - c.startFrame).map(shot => ({ id: shot.id, startFrame: shot.startFrame, endFrame: shot.endFrame, caption: shot.caption, stylizedAssetId: shot.stylizedAssetId }))");
// Click one Export item and wait for the browser download it requests.
const exportDownload = async (testId) => {
	await openExportMenu();
	// The previous export job releases the menu when it settles.
	await b.arm(`document.querySelector('[data-testid=${testId}]')?.disabled === false`);
	await b.settled();
	const next = downloads.next();
	await b.click(`[data-testid=${testId}]`);
	const file = await next;
	console.log(`DOWNLOAD ${testId} -> ${file.name} bytes=${statSync(file.path).size}`);
	return file;
};

try {
	await b.send("Emulation.setDeviceMetricsOverride", { width: 1600, height: 1000, deviceScaleFactor: 1, mobile: false });

	/* ---------------------------------------- failure: zero panels */
	await seedProject("storyboard");
	assert.equal(await b.evaluate("document.querySelector('.app').dataset.previsMode"), "storyboard");
	await openExportMenu();
	const empty = await menuItems();
	console.log(`EMPTY_MENU ${JSON.stringify(empty)}`);
	assert.deepEqual(empty.map(item => item.label), EXPECTED);
	assert.ok(empty.every(item => item.disabled && item.reason === "no-panels"), JSON.stringify(empty));
	console.log("PASS failure path: with zero panels every storyboard export item is disabled with data-disabled-reason=no-panels");
	await screenshot("task-15-export-empty.png");
	await b.escape();

	/* ---------------------------------------- happy: two panels */
	for (const caption of ["She enters", "He turns"]) {
		const receipt = await b.evaluate(`window.__exportBus.run('shot.createStill', { caption: ${JSON.stringify(caption)} })`);
		assert.equal(receipt.ok, true, JSON.stringify(receipt));
	}
	// The cast is a capsule figure, the storyboard's stand-in.
	const proxy = await b.evaluate("window.__exportBus.run('character.add', { character: { id: 'char-proxy', model: 'proxy-figure', subject: 'A stand-in', x: 0, z: 0, rot: 0, posture: 'stand' } })");
	assert.equal(proxy.ok, true, JSON.stringify(proxy));
	let panels = await stills();
	const hold = await b.evaluate(`window.__exportBus.run('shot.setHold', { shotId: ${JSON.stringify(panels[1].id)}, hold: 24 })`);
	assert.equal(hold.ok, true, JSON.stringify(hold));
	// Panel 2 stands somewhere else: its cast override is what the animatic must show.
	await b.evaluate(`window.__cozyclay.scrub(${panels[1].startFrame})`);
	await b.arm(`window.__cozyclay.tlFrame === ${panels[1].startFrame}`);
	await b.settled();
	await b.evaluate("window.__exportBus.run('character.move', { characterId: 'char-a', x: 1.5, z: -1, rot: 90 })");
	// Panel 1 gets a stylized picture (an image asset, as Stylize stores it).
	const stylizedId = await b.evaluate(`(async () => {
		const { importImageFile } = await import('/src/scene-assets.js');
		const { rememberAsset } = await import('/src/scene-asset-cache.js');
		const bytes = Uint8Array.from(atob(${JSON.stringify(stubPng().toString("base64"))}), c => c.charCodeAt(0));
		const asset = await rememberAsset(await importImageFile(new File([bytes], 'panel stylized.png', { type: 'image/png' })));
		const receipt = window.__exportBus.run('shot.setStylized', { shotId: ${JSON.stringify(panels[0].id)}, assetId: asset.id });
		if (!receipt.ok) throw new Error(JSON.stringify(receipt));
		return asset.id;
	})()`);
	panels = await stills();
	assert.deepEqual(panels.map(p => [p.startFrame, p.endFrame, p.caption]), [[0, 47, "She enters"], [48, 71, "He turns"]]);
	assert.equal(panels[0].stylizedAssetId, stylizedId);
	assert.equal(await b.evaluate(`window.__exportState.state.shots[1].cast?.['char-a']?.x`), 1.5);
	console.log(`PANELS ${JSON.stringify(panels)}`);

	await openExportMenu();
	const menu = await menuItems();
	console.log(`STORYBOARD_MENU ${JSON.stringify(menu.map(item => item.label))}`);
	assert.deepEqual(menu.map(item => item.label), EXPECTED);
	assert.ok(menu.every(item => !item.disabled && item.reason === null), JSON.stringify(menu));
	assert.equal(await b.evaluate("[...document.querySelectorAll('.export-menu [role=menuitem]')].some(item => /Keyframe pack|Video \\(mp4\\)/.test(item.textContent))"), false);
	assert.equal(await b.evaluate("!!document.querySelector('[data-testid=export-keyframe-pack], [data-testid=export-video]')"), false);
	console.log("PASS storyboard Export menu lists exactly the six panel exports; no Keyframe pack, no shot Video");
	await screenshot("task-15-export-menu.png");

	// All panels: one zip, one folder per panel.
	const all = await exportDownload("export-all-panels");
	assert.equal(all.name, "cozyclay-panels.zip");
	const listing = execFileSync("unzip", ["-Z1", all.path], { encoding: "utf8" }).trim().split("\n");
	console.log(`ALL_PANELS_ENTRIES ${JSON.stringify(listing)}`);
	const folders = [...new Set(listing.map(name => name.split("/")[0]))];
	assert.deepEqual(folders, ["panel-01", "panel-02"]);
	assert.deepEqual(listing, [
		"panel-01/first.png", "panel-01/stylized.png", "panel-01/camera.json", "panel-01/prompt.txt", "panel-01/README.txt",
		"panel-02/first.png", "panel-02/camera.json", "panel-02/prompt.txt", "panel-02/README.txt",
	]);
	const cameras = ["panel-01", "panel-02"].map(folder => JSON.parse(execFileSync("unzip", ["-p", all.path, `${folder}/camera.json`], { encoding: "utf8" })));
	console.log(`ALL_PANELS_CAMERAS ${JSON.stringify(cameras.map(c => ({ startFrame: c.startFrame, endFrame: c.endFrame, hold: c.hold, kind: c.kind, fps: c.fps })))}`);
	assert.deepEqual(cameras.map(c => [c.startFrame, c.endFrame, c.hold, c.kind]), [[0, 0, 48, "still"], [48, 48, 24, "still"]]);
	const prompt2 = execFileSync("unzip", ["-p", all.path, "panel-02/prompt.txt"], { encoding: "utf8" });
	assert.match(prompt2, /^CAPTION: He turns$/m);
	assert.match(execFileSync("unzip", ["-p", all.path, "panel-01/README.txt"], { encoding: "utf8" }), /stylized\.png/);
	assert.doesNotMatch(execFileSync("unzip", ["-p", all.path, "panel-02/README.txt"], { encoding: "utf8" }), /stylized\.png/);
	assert.ok(execFileSync("unzip", ["-t", all.path], { encoding: "utf8" }).includes("No errors detected"));
	console.log("PASS All panels: one zip with panel-01/ and panel-02/, still camera.json (start===end, hold, kind still), caption in prompt.txt, stylized.png only for panel 1");

	// Panel pack: the selected panel only.
	await b.evaluate(`window.__cozyclay.scrub(${panels[1].startFrame})`);
	const single = await exportDownload("export-panel-pack");
	const singleListing = execFileSync("unzip", ["-Z1", single.path], { encoding: "utf8" }).trim().split("\n");
	console.log(`PANEL_PACK ${single.name} ${JSON.stringify(singleListing)}`);
	assert.match(single.name, /^cozyclay-panel-0[12]-[a-z0-9-]+\.zip$/);
	assert.equal(singleListing.length >= 4 && singleListing.every(name => name.startsWith(single.name.match(/panel-0[12]/)[0] + "/")), true);
	assert.ok(!singleListing.some(name => /\/(clip\.|last\.png)/.test(name)));
	console.log("PASS Panel pack: one panel folder, no clip.* and no last.png");

	// Animatic: frames 0..lastStill.endFrame.
	const animatic = await exportDownload("export-animatic");
	assert.equal(animatic.name, "cozyclay-animatic.mp4");
	const input = new Input({ source: new BufferSource(readFileSync(animatic.path)), formats: ALL_FORMATS });
	const track = await input.getPrimaryVideoTrack();
	const stats = await track.computePacketStats();
	const duration = await input.computeDuration();
	console.log(`ANIMATIC packets=${stats.packetCount} duration=${duration.toFixed(3)}s size=${track.displayWidth}x${track.displayHeight} expected=${panels.at(-1).endFrame + 1}`);
	assert.equal(stats.packetCount, panels.at(-1).endFrame + 1, "one video frame per timeline frame 0..last still end");
	assert.equal(await b.evaluate("document.querySelector('[data-testid=export-status]')?.dataset.kind"), "animatic");
	console.log(`PASS Animatic: ${stats.packetCount} frames = last still endFrame ${panels.at(-1).endFrame} + 1`);

	// Contact sheet: two cells of 480x300.
	const sheet = await exportDownload("export-contact-sheet");
	const sheetBytes = readFileSync(sheet.path);
	const sheetSize = [sheetBytes.readUInt32BE(16), sheetBytes.readUInt32BE(20)];
	console.log(`CONTACT_SHEET ${sheet.name} ${sheetSize[0]}x${sheetSize[1]}`);
	assert.deepEqual(sheetSize, [960, 300]);
	writeFileSync(`${outputDir}/task-15-contact-sheet.png`, sheetBytes);
	console.log(`QA_SCREENSHOT ${outputDir}/task-15-contact-sheet.png bytes=${statSync(`${outputDir}/task-15-contact-sheet.png`).size}`);

	// Cut list: each still is a clip as long as its hold.
	const otio = await exportDownload("export-otio");
	const clips = JSON.parse(readFileSync(otio.path, "utf8")).tracks.children[0].children;
	console.log(`OTIO ${JSON.stringify(clips.map(clip => [clip.OTIO_SCHEMA, clip.source_range.duration.value, clip.metadata.cozyclay?.kind]))}`);
	assert.deepEqual(clips.map(clip => clip.source_range.duration.value), [48, 24]);
	console.log("PASS Cut list: still clip durations 48/24 = holds");

	assert.deepEqual(await b.evaluate("window.__exportErrors"), []);
	console.log("PASS zero page errors");

	/* ---------------------------------------- animation projects keep their menu */
	await seedProject("animation");
	await openExportMenu();
	const animationMenu = await menuItems();
	console.log(`ANIMATION_MENU ${JSON.stringify(animationMenu.map(item => item.label))}`);
	assert.equal(animationMenu[0].label, "Keyframe pack (zip)");
	assert.ok(!animationMenu.some(item => ["Contact sheet (PNG)", "All panels (zip)", "Animatic (mp4)"].includes(item.label)));
	console.log("PASS animation project: Export menu unchanged (Keyframe pack first, no panel exports)");
} finally {
	downloads.close();
	b.close();
	rmSync(downloadDir, { recursive: true, force: true });
}

/* ------------------------------------------------------------ helpers ---- */

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

// A 64x64 PNG standing in for a stylized picture.
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

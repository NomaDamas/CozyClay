#!/usr/bin/env node
/**
 * Cutouts, end to end in a real browser.
 *
 * The record maths is covered by verify-scene-objects.mjs and the import path
 * by verify-scene-assets.mjs, both in node. What neither can prove is the part
 * that only exists in a running page: that a picked file decodes, lands in
 * IndexedDB, comes back as a texture, and hangs on a card of the right metric
 * size the right way up. This drives Chrome over CDP with a real file on a
 * real <input type="file">.
 *
 * Run: `npm run dev:ui` in one shell, then
 * `QA_URL=http://127.0.0.1:5180/app/ npm run qa:browser -- node test/verify-cutout-browser.mjs`.
 * The QA browser defaults to the studio route (`/app/`), not the landing page.
 */

import { deflateSync } from "node:zlib";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

/* ------------------------------------------------------- a test image ---- */

const CRC_TABLE = Array.from({ length: 256 }, (_, n) => {
	let c = n;
	for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
	return c >>> 0;
});
const crc32 = (buffer) => {
	let c = 0xffffffff;
	for (const byte of buffer) c = CRC_TABLE[(c ^ byte) & 0xff] ^ (c >>> 8);
	return (c ^ 0xffffffff) >>> 0;
};
const chunk = (type, data) => {
	const head = Buffer.alloc(8);
	head.writeUInt32BE(data.length, 0);
	head.write(type, 4, "ascii");
	const crc = Buffer.alloc(4);
	crc.writeUInt32BE(crc32(Buffer.concat([Buffer.from(type, "ascii"), data])), 0);
	return Buffer.concat([head, data, crc]);
};
/**
 * An RGBA PNG that is deliberately NOT square (so an aspect bug shows up as a
 * wrong width) and deliberately NOT symmetric top-to-bottom: the top half is
 * red, the bottom half green, and the outer 20% is fully transparent. A card
 * hung upside down, or one whose alpha is ignored, is visible in that alone.
 */
function testPng(width = 120, height = 240) {
	const raw = Buffer.alloc(height * (width * 4 + 1));
	let at = 0;
	for (let y = 0; y < height; y++) {
		raw[at++] = 0; // filter: none
		for (let x = 0; x < width; x++) {
			const transparent = x < width * 0.2 || x > width * 0.8;
			const top = y < height / 2;
			raw[at++] = transparent ? 0 : top ? 220 : 30;
			raw[at++] = transparent ? 0 : top ? 40 : 200;
			raw[at++] = 40;
			raw[at++] = transparent ? 0 : 255;
		}
	}
	const ihdr = Buffer.alloc(13);
	ihdr.writeUInt32BE(width, 0);
	ihdr.writeUInt32BE(height, 4);
	ihdr[8] = 8; // bit depth
	ihdr[9] = 6; // colour type: RGBA
	return Buffer.concat([
		Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
		chunk("IHDR", ihdr),
		chunk("IDAT", deflateSync(raw)),
		chunk("IEND", Buffer.alloc(0)),
	]);
}

/* ------------------------------------------------------------- driver ---- */

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
const send = (method, params = {}) =>
	new Promise((resolve, reject) => {
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
const waitFor = async (expression, { timeoutMs = 8000, intervalMs = 120 } = {}) => {
	const deadline = Date.now() + timeoutMs;
	while (Date.now() < deadline) {
		if (await evaluate(expression).catch(() => false)) return true;
		await sleep(intervalMs);
	}
	return false;
};

let failures = 0;
const expect = (name, condition, detail = "") => {
	console.log(`${condition ? "PASS" : "FAIL"} ${name}${condition ? "" : ` — ${detail}`}`);
	if (!condition) failures += 1;
};

await send("Page.enable");
await send("Runtime.enable");
await send("DOM.enable");
for (let i = 0; i < 60 && !(await evaluate("!!window.__sceneHistory && document.querySelectorAll('.hierarchy-row').length > 0").catch(() => false)); i++) {
	await sleep(200);
}

const dir = mkdtempSync(join(tmpdir(), "cozyclay-cutout-"));
const file = join(dir, "Doorway.png");
writeFileSync(file, testPng());

try {
	/* ------------------------------------------------------------ import --- */

	// The picker lives in the Props inspector, so the suite has to get there
	// the way a user does: select the Props row, then press the button.
	await evaluate("[...document.querySelectorAll('.hierarchy-row')].find((row) => /Props|소품/.test(row.textContent))?.click()");
	await sleep(300);
	const hasButton = await waitFor("!!document.querySelector('input[type=file][accept*=\"image/png\"]')");
	expect("the set offers an image import", hasButton);

	const { root } = await send("DOM.getDocument");
	const { nodeId } = await send("DOM.querySelector", { nodeId: root.nodeId, selector: 'input[type=file][accept*="image/png"]' });
	await send("DOM.setFileInputFiles", { nodeId, files: [file] });

	const arrived = await waitFor(
		"[...document.querySelectorAll('.hierarchy-row')].some((row) => row.textContent.includes('Doorway'))",
		{ timeoutMs: 10000 },
	);
	expect("a picked image becomes an object in the set", arrived);

	/* -------------------------------------------------------- the record --- */

	const inspector = await evaluate(`(() => {
		const height = document.querySelector('.inspector-scroll input[data-field="cutout-height"]');
		const width = document.querySelector('.inspector-scroll input[data-field="cutout-width"]');
		return { height: height ? Number(height.value) : null, width: width ? Number(width.value) : null };
	})()`);
	expect("a fresh card stands at the figure's height", inspector.height === 1.8, JSON.stringify(inspector));
	expect(
		"the card's width is derived from the picture, not guessed",
		inspector.width !== null && Math.abs(inspector.width - 0.9) < 0.01,
		JSON.stringify(inspector),
	);

	/* --------------------------------------------------------- the card --- */

	const card = await evaluate(`(() => {
		let node = window.__cozyclay?.shotCam;
		while (node && !node.isScene) node = node.parent;
		if (!node) return { error: 'no scene' };
		let mesh = null;
		node.traverse((object) => { if (object.isMesh && object.userData && 'cutoutTexture' in object.userData) mesh = object; });
		if (!mesh) return { error: 'no cutout mesh' };
		const map = mesh.material.map;
		const size = new (mesh.geometry.constructor === Object ? Object : Object)();
		return {
			hasTexture: !!map,
			textureWidth: map?.image?.width ?? null,
			textureHeight: map?.image?.height ?? null,
			flipY: map?.flipY ?? null,
			alphaTest: mesh.material.alphaTest,
			transparent: mesh.material.transparent,
			depthWrite: mesh.material.depthWrite,
			side: mesh.material.side,
			geometryWidth: mesh.geometry.parameters.width,
			geometryHeight: mesh.geometry.parameters.height,
			baseY: mesh.position.y,
			castShadow: mesh.castShadow,
		};
	})()`);
	expect("the imported picture is on the card", card.hasTexture === true, JSON.stringify(card));
	expect("the texture is the picture that was imported", card.textureWidth === 120 && card.textureHeight === 240, JSON.stringify(card));
	expect("the picture is not hung upside down", card.flipY === false, JSON.stringify(card));
	// 0.15, not 0.5: with alphaToCoverage spending the canvas's MSAA samples
	// on the silhouette, the test only has to reject what is genuinely
	// nothing — 0.5 would kill half-lit edge pixels the coverage pass resolves.
	expect(
		"the card is alpha-CUT, so it keeps writing depth",
		card.alphaTest === 0.15 && card.transparent === false && card.depthWrite === true,
		JSON.stringify(card),
	);
	expect("the card is metric: 1.8 m tall, 0.9 m wide", Math.abs(card.geometryHeight - 1.8) < 1e-6 && Math.abs(card.geometryWidth - 0.9) < 1e-6, JSON.stringify(card));
	expect("the card stands on the floor rather than through it", Math.abs(card.baseY - 0.9) < 1e-6, JSON.stringify(card));
	expect("a card seen edge-on is still a card", card.side === 2, JSON.stringify(card));

	/* ---------------------------------------------------------- resizing --- */

	await evaluate(`(() => {
		const input = document.querySelector('.inspector-scroll input[data-field="cutout-height"]');
		const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;
		setter.call(input, '3.6');
		input.dispatchEvent(new Event('change', { bubbles: true }));
		input.dispatchEvent(new Event('input', { bubbles: true }));
	})()`);
	await sleep(400);
	const resized = await evaluate(`(() => {
		let node = window.__cozyclay?.shotCam;
		while (node && !node.isScene) node = node.parent;
		let mesh = null;
		node.traverse((object) => { if (object.isMesh && object.userData && 'cutoutTexture' in object.userData) mesh = object; });
		return mesh ? { width: mesh.geometry.parameters.width, height: mesh.geometry.parameters.height } : null;
	})()`);
	expect(
		"editing the height rebuilds the card's width with it",
		Math.abs(resized.height - 3.6) < 1e-6 && Math.abs(resized.width - 1.8) < 1e-6,
		JSON.stringify(resized),
	);

	/* ------------------------------------------------------- persistence --- */

	await send("Page.reload");
	for (let i = 0; i < 150; i++) {
		await sleep(200);
		if (await evaluate("!!document.querySelector('canvas')").catch(() => false)) break;
	}
	for (let i = 0; i < 60 && !(await evaluate("!!window.__sceneHistory && document.querySelectorAll('.hierarchy-row').length > 0").catch(() => false)); i++) {
		await sleep(200);
	}
	const survived = await waitFor(
		`(() => {
			let node = window.__cozyclay?.shotCam;
			while (node && !node.isScene) node = node.parent;
			if (!node) return false;
			let mesh = null;
			node.traverse((object) => { if (object.isMesh && object.userData && 'cutoutTexture' in object.userData) mesh = object; });
			return !!mesh?.material?.map;
		})()`,
		{ timeoutMs: 15000 },
	);
	expect("the card and its picture come back after a reload", survived);

	expect("no uncaught page errors", pageErrors.length === 0, pageErrors.join(" | "));
} finally {
	rmSync(dir, { recursive: true, force: true });
	ws.close();
}

if (failures) process.exit(1);
console.log("all cutout browser checks PASS");

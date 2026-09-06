#!/usr/bin/env node
/** Browser QA for issue #123. Run through tools/qa-browser.mjs with the dev
 * server's live port exported:
 *
 *   COZYCLAY_LIVE_PORT=5314 npm run dev -- --port 5303
 *   QA_URL=http://127.0.0.1:5303/app/ CDP_PORT=9310 COZYCLAY_LIVE_PORT=5314 \
 *     node tools/qa-browser.mjs -- node test/qa-agent-commands-browser.mjs
 *
 * This script hosts the real local LiveHub the page's live-control client
 * connects to (the dev server only injects the port), then drives BOTH new
 * commands through the live socket, parses PNG IHDR bytes from the returned
 * data URL, imports a generated PNG, and proves one Ctrl+Z removes each
 * placed object. Evidence PNGs land in /tmp/agent-commands-qa/. */
import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { deflateSync } from "node:zlib";
import { fileURLToPath } from "node:url";

const { WebSocket } = createRequire(fileURLToPath(new URL("../mcp/package.json", import.meta.url)))("ws");
const { startLiveHub } = await import("../mcp/live-hub.mjs");

const CDP_PORT = Number(process.env.CDP_PORT || 9222);
const LIVE_PORT = Number(process.env.COZYCLAY_LIVE_PORT || 5184);
const OUT_DIR = "/tmp/agent-commands-qa";

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
/** Await a real state change by polling a probe until it holds; bounded. */
async function waitFor(label, probe, timeoutMs, intervalMs = 250) {
	const deadline = Date.now() + timeoutMs;
	let last;
	while (Date.now() < deadline) {
		last = await probe();
		if (last) return last;
		await sleep(intervalMs);
	}
	throw new Error(`Timed out waiting for ${label} (last: ${JSON.stringify(last)})`);
}

/* -------------------------------- CDP ---------------------------------- */
const targets = await (await fetch(`http://127.0.0.1:${CDP_PORT}/json`)).json();
const page = targets.find((target) => target.type === "page" && target.url.includes("/app/"))
	?? targets.find((target) => target.type === "page");
assert.ok(page, `no /app/ page target on CDP port ${CDP_PORT}`);
const cdp = new WebSocket(page.webSocketDebuggerUrl);
await new Promise((resolve, reject) => {
	cdp.onopen = resolve;
	cdp.onerror = reject;
});
let nextId = 1;
const pending = new Map();
cdp.onmessage = (event) => {
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
	cdp.send(JSON.stringify({ id, method, params }));
});
const evaluate = async (expression) => {
	const result = await send("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true });
	if (result.exceptionDetails) throw new Error(result.exceptionDetails.exception?.description ?? "page threw");
	return result.result?.value;
};
/** Ctrl+Z reaches the studio's window keydown handler exactly as a user's
 * chord does — the undo entry, not the DOM, is what the assertion reads. */
const pressCtrlZ = async () => {
	for (const type of ["rawKeyDown", "keyUp"]) {
		await send("Input.dispatchKeyEvent", {
			type,
			modifiers: 2, // Ctrl
			key: "z",
			code: "KeyZ",
			windowsVirtualKeyCode: 90,
			nativeVirtualKeyCode: 90,
		});
	}
};

/* ------------------------------ tiny PNG ------------------------------- */
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
	const body = Buffer.concat([Buffer.from(type, "ascii"), data]);
	const head = Buffer.alloc(4);
	head.writeUInt32BE(data.length);
	const crc = Buffer.alloc(4);
	crc.writeUInt32BE(crc32(body));
	return Buffer.concat([head, body, crc]);
};
/** A deterministic 16x16 red truecolor PNG, built from scratch so the QA has
 * no fixture dependency; the editor decodes it with its real import path. */
const tinyPngDataUrl = (width = 16, height = 16) => {
	const ihdr = Buffer.alloc(13);
	ihdr.writeUInt32BE(width, 0);
	ihdr.writeUInt32BE(height, 4);
	ihdr[8] = 8; // bit depth
	ihdr[9] = 2; // truecolor RGB
	const raw = Buffer.alloc((width * 3 + 1) * height);
	for (let row = 0; row < height; row++) {
		raw[row * (width * 3 + 1)] = 0; // filter: none
		for (let x = 0; x < width; x++) {
			const at = row * (width * 3 + 1) + 1 + x * 3;
			raw[at] = 0xd8; raw[at + 1] = 0x3a; raw[at + 2] = 0x2c;
		}
	}
	const png = Buffer.concat([
		Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
		chunk("IHDR", ihdr),
		chunk("IDAT", deflateSync(raw)),
		chunk("IEND", Buffer.alloc(0)),
	]);
	return `data:image/png;base64,${png.toString("base64")}`;
};
const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
/** Parse the IHDR box straight out of the data URL's bytes. */
const pngIhdr = (dataUrl) => {
	const buffer = Buffer.from(dataUrl.slice(dataUrl.indexOf(",") + 1), "base64");
	assert.deepEqual(buffer.subarray(0, 8), PNG_SIGNATURE, "PNG signature");
	assert.equal(buffer.readUInt32BE(8), 13, "IHDR length");
	assert.equal(buffer.toString("ascii", 12, 16), "IHDR");
	return { width: buffer.readUInt32BE(16), height: buffer.readUInt32BE(20), bytes: buffer };
};

/* ------------------------------- the run ------------------------------- */
await mkdir(OUT_DIR, { recursive: true });
const hub = await startLiveHub(LIVE_PORT);
assert.ok(hub, `live port ${LIVE_PORT} is taken — stop the other hub or point COZYCLAY_LIVE_PORT at a free one`);
const editor = await waitFor("the page's live-control client to connect", async () => {
	const handle = hub.workspaceHandles[0];
	return handle && hub.editors.get(handle)?.readyState === WebSocket.OPEN ? handle : null;
}, 90_000);
console.log(`editor connected: workspace ${editor}`);

const describeScene = () => hub.command("describe", {}, editor);

// capture_framing_png: the studio mounts its shot renderer asynchronously
// (Suspense on first paint), so a "not ready" answer means "poll again".
const shot = await waitFor("a renderable shot camera for capture_framing_png", async () => {
	try {
		return await hub.command("capture_framing_png", {}, editor);
	} catch (error) {
		if (/not ready/i.test(error.message)) return null;
		throw error;
	}
}, 45_000, 1_000);
assert.ok(shot.dataUrl.startsWith("data:image/png;base64,"), "capture_framing_png must return a PNG data URL");
const ihdr = pngIhdr(shot.dataUrl);
assert.equal(ihdr.width, shot.width, "IHDR width must match the reported width");
assert.equal(ihdr.height, shot.height, "IHDR height must match the reported height");
assert.equal(shot.width, 1920, "the default 16:9 shot pull is 1920 wide");
assert.equal(shot.height, 1080, "the default 16:9 shot pull is 1080 tall");
assert.equal(typeof shot.frame, "number", "frame must be the current timeline frame");
assert.ok(shot.shotId === null || typeof shot.shotId === "string", "shotId names the shot under the playhead");
await writeFile(`${OUT_DIR}/capture-framing.png`, ihdr.bytes);
console.log(`capture_framing_png ok: IHDR ${ihdr.width}x${ihdr.height} frame=${shot.frame} shotId=${shot.shotId}`);

const before = await describeScene();
const beforeCount = before.objects.length;

// import_asset, placeAs "cutout": the object lands through the Studio's own
// pipeline and describe (the same React state the UI reads) sees it at once.
const importArgs = { name: "QA Red Card.png", mimeType: "image/png", dataUrl: tinyPngDataUrl(), placeAs: "cutout" };
const placed = await hub.command("import_asset", importArgs, editor);
assert.match(placed.assetId, /^img-[0-9a-f]{32}$/, "assetId is the content-addressed digest (img- + 32 hex)");
assert.ok(placed.objectId, "objectId must name the placed object");
const cutoutObject = await waitFor("the imported cutout to enter the live scene", async () =>
	(await describeScene()).objects.find((object) => object.id === placed.objectId) ?? null, 10_000);
assert.equal(cutoutObject.renderer, "cutout");
const afterImport = await hub.command("capture_framing_png", {}, editor);
await writeFile(`${OUT_DIR}/import-cutout.png`, pngIhdr(afterImport.dataUrl).bytes);
console.log(`import_asset (cutout) ok: object ${placed.objectId} asset ${placed.assetId.slice(0, 12)}…`);

// ONE Ctrl+Z removes it — the whole point of import_asset.
await pressCtrlZ();
const afterUndo = await waitFor("the cutout to disappear after one Ctrl+Z", async () => {
	const objects = (await describeScene()).objects;
	return objects.some((object) => object.id === placed.objectId) ? null : objects;
}, 10_000);
assert.equal(afterUndo.length, beforeCount, "undo removes the import without touching the rest of the set");
console.log("one Ctrl+Z removed the cutout");

// import_asset, placeAs "backdrop": same pipeline, background-plate placement
// down the shot camera's view ray, turned to face the lens.
const backdropPlaced = await hub.command("import_asset", { ...importArgs, name: "QA Backdrop.png", placeAs: "backdrop" }, editor);
const backdropObject = await waitFor("the backdrop to enter the live scene", async () =>
	(await describeScene()).objects.find((object) => object.id === backdropPlaced.objectId) ?? null, 10_000);
const scene = await describeScene();
const cameraXZ = { x: scene.camera.x, z: scene.camera.z };
const distance = Math.hypot(backdropObject.x - cameraXZ.x, backdropObject.z - cameraXZ.z);
assert.ok(distance > 8, `a backdrop stands well down the view ray (got ${distance.toFixed(1)} m from the shot camera)`);
// Facing check: the card's +z normal (rot in degrees) must point back along
// the camera→card ray, i.e. the plate faces the lens rather than edge-on.
const yawRad = (backdropObject.rot * Math.PI) / 180;
const normal = { x: Math.sin(yawRad), z: Math.cos(yawRad) };
const dx = backdropObject.x - cameraXZ.x;
const dz = backdropObject.z - cameraXZ.z;
const facing = (normal.x * dx + normal.z * dz) / Math.hypot(dx, dz);
assert.ok(Math.abs(facing + 1) < 0.05, `the backdrop must face the shot camera (facing=${facing.toFixed(3)})`);
const withBackdrop = await hub.command("capture_framing_png", {}, editor);
await writeFile(`${OUT_DIR}/import-backdrop.png`, pngIhdr(withBackdrop.dataUrl).bytes);
console.log(`import_asset (backdrop) ok: object ${backdropPlaced.objectId} at ${distance.toFixed(1)} m from the shot camera`);

await pressCtrlZ();
await waitFor("the backdrop to disappear after one Ctrl+Z", async () =>
	(await describeScene()).objects.some((object) => object.id === backdropPlaced.objectId) ? null : true, 10_000);
console.log("one Ctrl+Z removed the backdrop");

console.log(`QA evidence saved: ${OUT_DIR}/capture-framing.png, ${OUT_DIR}/import-cutout.png, ${OUT_DIR}/import-backdrop.png`);
console.log("PASS qa-agent-commands-browser");
cdp.close();

#!/usr/bin/env node
/** Issue #123: capture_framing_png and import_asset round-trip over a real
 * local LiveHub with a fake editor socket, plus the editor-side dispatcher
 * contract from src/live-control.js. Asserts the command names round-trip
 * unchanged and the result frames carry the documented shapes. */
import assert from "node:assert/strict";
import { createServer } from "node:net";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";

// ws lives in the MCP runtime tree (the root install does not ship it); the
// same resolution tools/run-tests.mjs probes before running the MCP suites.
const mcpRequire = createRequire(fileURLToPath(new URL("../mcp/package.json", import.meta.url)));
const { WebSocket } = mcpRequire("ws");
const { LiveHub, startLiveHub } = await import("../mcp/live-hub.mjs");
const { dispatchLiveFrame, liveControlUrl } = await import("../src/live-control.js");

const reservePort = () => new Promise((resolve, reject) => {
	const server = createServer();
	server.once("error", reject);
	server.listen(0, "127.0.0.1", () => {
		const address = server.address();
		if (!address || typeof address === "string") return reject(new Error("Could not reserve a TCP port."));
		server.close((error) => error ? reject(error) : resolve(address.port));
	});
});
const withTimeout = (promise, label, milliseconds = 10_000) => {
	let timer;
	return Promise.race([
		promise,
		new Promise((_, reject) => { timer = setTimeout(() => reject(new Error(`Timed out waiting for ${label}.`)), milliseconds); }),
	]).finally(() => clearTimeout(timer));
};

// One transparent 1x1 PNG; the canned capture answer only has to survive the
// round trip intact — the browser QA parses real IHDR bytes from the editor.
const CANNED_PNG_DATA_URL = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";

const port = await reservePort();
const hub = await startLiveHub(port);
assert.ok(hub, `LiveHub should bind a reserved loopback port (got ${port})`);

const received = [];
let importFailNext = false;
const socket = new WebSocket(liveControlUrl(port));
const opened = new Promise((resolve, reject) => {
	socket.once("open", resolve);
	socket.once("error", reject);
});
socket.on("message", (raw) => {
	const frame = JSON.parse(raw.toString());
	if (frame.type === "workspace") {
		workspaceReady(frame.handle);
		return;
	}
	if (frame.type !== "cmd") return;
	received.push({ id: frame.id, name: frame.name, args: frame.args });
	const reply = (ok, body) => socket.send(JSON.stringify(
		ok ? { type: "result", id: frame.id, ok: true, value: body } : { type: "result", id: frame.id, ok: false, error: body },
	));
	if (frame.name === "capture_framing_png") {
		reply(true, {
			dataUrl: CANNED_PNG_DATA_URL,
			width: 1920,
			height: 1080,
			frame: 7,
			shotId: "shot-1",
		});
	}
	if (frame.name === "import_asset") {
		if (importFailNext) {
			importFailNext = false;
			reply(false, "The shot renderer is not ready");
			return;
		}
		reply(true, { assetId: `img-${"a".repeat(32)}`, objectId: "cutout" });
	}
});
let workspaceReady;
const workspace = new Promise((resolve) => { workspaceReady = resolve; });
await withTimeout(opened, "fake editor connection");
socket.send(JSON.stringify({ type: "hello", role: "editor", version: 1, workspaceId: "verify-agent-commands" }));
const handle = await withTimeout(workspace, "workspace handshake");

// 1. capture_framing_png: the name travels to the editor untouched and the
// documented value shape comes back to the awaiting caller.
const shot = await withTimeout(hub.command("capture_framing_png", {}, handle));
assert.equal(received.length, 1, "the fake editor should have received exactly one command");
assert.equal(received[0].name, "capture_framing_png");
assert.deepEqual(received[0].args, {});
assert.deepEqual(Object.keys(shot).sort(), ["dataUrl", "frame", "height", "shotId", "width"]);
assert.equal(shot.width, 1920);
assert.equal(shot.height, 1080);
assert.equal(shot.dataUrl, CANNED_PNG_DATA_URL, "the data URL must survive the round trip byte-for-byte");
assert.equal(shot.frame, 7);
assert.equal(shot.shotId, "shot-1");

// 2. import_asset: every argument the caller sends arrives whole at the
// editor, and the result names the asset and the placed object.
const importArgs = {
	name: "QA Card.png",
	mimeType: "image/png",
	dataUrl: CANNED_PNG_DATA_URL,
	placeAs: "cutout",
};
const placed = await withTimeout(hub.command("import_asset", importArgs, handle));
assert.equal(received.length, 2);
assert.equal(received[1].name, "import_asset");
assert.deepEqual(received[1].args, importArgs, "import_asset arguments must round-trip unchanged");
assert.deepEqual(Object.keys(placed).sort(), ["assetId", "objectId"]);
assert.equal(placed.assetId, `img-${"a".repeat(32)}`);
assert.equal(placed.objectId, "cutout");

// 3. backdrop placement is part of the documented arg domain.
const backdrop = await withTimeout(hub.command("import_asset", { ...importArgs, placeAs: "backdrop" }, handle));
assert.deepEqual(received[2].args, { ...importArgs, placeAs: "backdrop" });
assert.deepEqual(Object.keys(backdrop).sort(), ["assetId", "objectId"]);

// 4. An editor rejection surfaces as a failed command, never as silence.
importFailNext = true;
await assert.rejects(
	() => withTimeout(hub.command("import_asset", importArgs, handle)),
	/The shot renderer is not ready/,
);
assert.equal(received.length, 4, "the rejected command still reached the editor");

// 5. The editor half of the same contract: dispatchLiveFrame must answer both
// names with the documented result frames, success and failure alike.
const editorHandlers = {
	capture_framing_png: () => ({ dataUrl: CANNED_PNG_DATA_URL, width: 1920, height: 1080, frame: 0, shotId: null }),
	import_asset: async (args) => {
		if (args.placeAs !== "cutout" && args.placeAs !== "backdrop") throw new Error('placeAs must be "cutout" or "backdrop"');
		return { assetId: `img-${"b".repeat(32)}`, objectId: "cutout-2" };
	},
};
const okCapture = await dispatchLiveFrame(
	JSON.stringify({ type: "cmd", id: "c1", name: "capture_framing_png", args: {} }),
	editorHandlers,
);
assert.deepEqual(okCapture, {
	type: "result", id: "c1", ok: true,
	value: { dataUrl: CANNED_PNG_DATA_URL, width: 1920, height: 1080, frame: 0, shotId: null },
});
const okImport = await dispatchLiveFrame(
	JSON.stringify({ type: "cmd", id: "c2", name: "import_asset", args: { name: "x.png", dataUrl: CANNED_PNG_DATA_URL, placeAs: "backdrop" } }),
	editorHandlers,
);
assert.deepEqual(okImport, {
	type: "result", id: "c2", ok: true,
	value: { assetId: `img-${"b".repeat(32)}`, objectId: "cutout-2" },
});
const badImport = await dispatchLiveFrame(
	JSON.stringify({ type: "cmd", id: "c3", name: "import_asset", args: { name: "x.png", dataUrl: CANNED_PNG_DATA_URL, placeAs: "wallpaper" } }),
	editorHandlers,
);
assert.deepEqual(badImport, { type: "result", id: "c3", ok: false, error: 'placeAs must be "cutout" or "backdrop"' });

socket.close();
hub.server.close();
await withTimeout(new Promise((resolve) => socket.once("close", resolve)), "fake editor socket close");
await withTimeout(new Promise((resolve) => hub.server.once("close", resolve)), "hub close");

console.log("PASS verify-live-agent-commands: capture_framing_png + import_asset round-trip, shapes, rejection path, editor dispatch");

#!/usr/bin/env node
/** Real MCP + browser-editor coverage for G007 capture_frame. */
import assert from "node:assert/strict";
import { access, unlink, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { createServer } from "node:net";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { WebSocket } from "ws";

import { chromeArgs, resolveChromePath } from "./qa-chrome.mjs";

const root = fileURLToPath(new URL("..", import.meta.url));
const serverPath = fileURLToPath(new URL("./server.mjs", import.meta.url));
const peerArtifactPath = join(tmpdir(), `cozyclay-capture-${randomUUID()}.png`);
await writeFile(peerArtifactPath, "owned by another live MCP process", { mode: 0o600 });

const reservePort = () => new Promise((resolve, reject) => {
	const server = createServer();
	server.once("error", reject);
	server.listen(0, "127.0.0.1", () => {
		const address = server.address();
		if (!address || typeof address === "string") return reject(new Error("Could not reserve a TCP port."));
		server.close((error) => error ? reject(error) : resolve(address.port));
	});
});
const withTimeout = (promise, label, milliseconds = 30_000) => {
	let timer;
	return Promise.race([promise, new Promise((_, reject) => { timer = setTimeout(() => reject(new Error(`Timed out waiting for ${label}.`)), milliseconds); })]).finally(() => clearTimeout(timer));
};
const waitForOutput = (child, pattern, label) => withTimeout(new Promise((resolve, reject) => {
	let output = "";
	const inspect = (chunk) => {
		output += chunk.toString();
		if (pattern.test(output)) finish(resolve);
	};
	const onExit = (code, signal) => finish(reject, new Error(`${label} exited (${code ?? signal ?? "unknown"}): ${output}`));
	const finish = (callback, value) => {
		child.stdout.off("data", inspect); child.stderr.off("data", inspect); child.off("exit", onExit); callback(value);
	};
	child.stdout.on("data", inspect); child.stderr.on("data", inspect); child.once("exit", onExit);
}), label);
const terminate = async (child) => {
	if (!child || child.exitCode !== null || child.signalCode !== null) return;
	const exited = new Promise((resolve) => child.once("exit", resolve));
	child.kill("SIGTERM");
	await withTimeout(exited, "child cleanup", 5_000).catch(() => child.kill("SIGKILL"));
};
const verifyRejectedCapture = async ({ value, error, expected }) => {
	const port = await reservePort();
	const stalePath = `/tmp/cozyclay-capture-${randomUUID()}.png`;
	await writeFile(stalePath, Buffer.from("stale"), { mode: 0o600 });
	const staleAt = new Date(Date.now() - 2 * 10 * 60_000);
	await utimes(stalePath, staleAt, staleAt);
	const edgeClient = new Client({ name: "cozyclay-g007-capture-edge", version: "1.0.0" });
	const edgeTransport = new StdioClientTransport({ command: process.execPath, args: [serverPath, "--live-port", String(port)] });
	let socket;
	try {
		await edgeClient.connect(edgeTransport);
		await assert.rejects(access(stalePath), "startup sweep must remove a stale capture artifact");
		socket = new WebSocket(`ws://127.0.0.1:${port}/live`);
		let workspaceReady;
		const workspace = new Promise((resolve) => { workspaceReady = resolve; });
		await withTimeout(new Promise((resolve, reject) => {
			socket.once("open", resolve);
			socket.once("error", reject);
		}), "edge editor connection");
		socket.on("message", (raw) => {
			const frame = JSON.parse(raw.toString());
			if (frame.type === "workspace") {
				workspaceReady();
				return;
			}
			if (frame.type !== "cmd") return;
			if (frame.name === "describe") {
				socket.send(JSON.stringify({
					type: "result",
					id: frame.id,
					ok: true,
					value: {
						sceneName: "CAPTURE EDGE",
						camera: { x: 0, y: 1.6, z: 4.5, focalMm: 35, sensorId: "super35", aspectRatio: 16 / 9 },
						stage: { shotAspect: "16:9", sensorId: "super35", hasCharSheet: false },
						timeline: { currentFrame: 0, frameCount: 360, fps: 24 },
						characters: [],
						objects: [],
					},
				}));
				return;
			}
			if (frame.name === "capture_frame") {
				socket.send(JSON.stringify(error
					? { type: "result", id: frame.id, ok: false, error }
					: { type: "result", id: frame.id, ok: true, value }));
			}
		});
		socket.send(JSON.stringify({ type: "hello", role: "editor", version: 1, workspaceId: `g007-edge-${port}` }));
		await withTimeout(workspace, "edge workspace handshake");
		const result = await edgeClient.callTool({ name: "capture_frame", arguments: {} });
		assert.equal(result.isError, true, JSON.stringify(result));
		assert.match(result.content[0].text, expected);
		return result.content[0].text;
	} finally {
		if (socket?.readyState === WebSocket.OPEN) socket.close();
		await edgeClient.close().catch(() => {});
	}
};

const vitePort = await reservePort();
const livePort = await reservePort();
const cdpPort = await reservePort();
const vite = spawn(process.execPath, ["node_modules/vite/bin/vite.js", "--host", "127.0.0.1", "--port", String(vitePort), "--strictPort"], {
	cwd: root, env: { ...process.env, COZYCLAY_LIVE_PORT: String(livePort) }, stdio: ["ignore", "pipe", "pipe"],
});
const browser = spawn(resolveChromePath(), chromeArgs(cdpPort), {
	stdio: ["ignore", "pipe", "pipe"],
});
let cdp;
let client;
let artifactPath = null;
try {
	await waitForOutput(vite, new RegExp(`http://127\\.0\\.0\\.1:${vitePort}/`), "Vite");
	await waitForOutput(browser, /DevTools listening on (ws:\/\/[^\s]+)/, "Chrome");
	const targets = await (await fetch(`http://127.0.0.1:${cdpPort}/json`)).json();
	const page = targets.find((target) => target.type === "page" && target.webSocketDebuggerUrl);
	if (!page) throw new Error("Chrome did not expose a page target.");
	cdp = new WebSocket(page.webSocketDebuggerUrl);
	await withTimeout(new Promise((resolve, reject) => { cdp.once("open", resolve); cdp.once("error", reject); }), "CDP connection");
	let nextId = 1;
	const pending = new Map();
	let resolveEditorHello;
	const editorHello = new Promise((resolve) => { resolveEditorHello = resolve; });
	cdp.on("message", (raw) => {
		const frame = JSON.parse(raw.toString());
		if (frame.method === "Network.webSocketFrameSent") {
			try {
				const editorFrame = JSON.parse(frame.params.response.payloadData);
				if (editorFrame.type === "hello" && editorFrame.role === "editor") resolveEditorHello();
			} catch { /* CDP carries unrelated frames. */ }
		}
		if (!frame.id || !pending.has(frame.id)) return;
		const request = pending.get(frame.id); pending.delete(frame.id);
		frame.error ? request.reject(new Error(JSON.stringify(frame.error))) : request.resolve(frame.result);
	});
	const send = (method, params = {}) => new Promise((resolve, reject) => {
		const id = nextId++; pending.set(id, { resolve, reject }); cdp.send(JSON.stringify({ id, method, params }));
	});
	await send("Network.enable");
	await send("Page.enable");
	await send("Page.navigate", { url: `http://127.0.0.1:${vitePort}/app/` });
	client = new Client({ name: "cozyclay-g007-capture-verify", version: "1.0.0" });
	await client.connect(new StdioClientTransport({ command: process.execPath, args: [serverPath, "--live-port", String(livePort)] }));
	await withTimeout(editorHello, "editor live hello");
	await withTimeout(new Promise((resolve, reject) => {
		send("Runtime.evaluate", {
			expression: "window.__cozyclayMcpCaptureReady ? true : new Promise((resolve) => window.addEventListener('cozyclay:mcp-capture-ready', () => resolve(true), { once: true }))",
			awaitPromise: true,
		}).then((response) => response.exceptionDetails ? reject(new Error(response.exceptionDetails.text)) : resolve(response.result.value), reject);
	}), "MCP capture renderer readiness");
	await withTimeout(new Promise((resolve, reject) => {
		send("Runtime.evaluate", {
			expression: "window.__cozyclayMcpRigReady?.includes('char-a') ? true : new Promise((resolve) => window.addEventListener('cozyclay:mcp-rig-ready', (event) => event.detail === 'char-a' && resolve(true)))",
			awaitPromise: true,
		}).then((response) => response.exceptionDetails ? reject(new Error(response.exceptionDetails.text)) : resolve(response.result.value), reject);
	}), "character rig readiness");
	const call = (name, args = {}) => client.callTool({ name, arguments: args });
	const decoded = async (name, args) => {
		const result = await call(name, args);
		assert.equal(result.isError, undefined, JSON.stringify(result));
		return { result, body: JSON.parse(result.content[0].text) };
	};

	// Given the real editor's default scene and offscreen renderer
	// When MCP captures it through the live WebSocket
	// Then it returns a compressed 640x360 visual and engine-derived assertions without state mutation.
	const happy = await decoded("capture_frame");
	assert.equal(happy.body.width, 640);
	assert.equal(happy.body.height, 360);
	assert.equal(happy.body.mimeType, "image/png");
	assert.equal(happy.body.encoding, "base64");
	assert.ok(happy.body.byteSize > 0);
	assert.equal(happy.body.assertions.renderable, true);
	assert.equal(happy.body.assertions.blackFrame, false);
	assert.ok(happy.body.assertions.nonBlackPixels > 0);
	assert.equal(happy.body.stateHashBefore, happy.body.stateHashAfter);
	assert.equal(happy.result.content[1]?.type, "image");

	// Given a tall cube placed physically between the shot camera and character A
	// When the frame is captured
	// Then raycasts from engine geometry identify the occluder and count only exposed samples.
	const camera = await new Promise(async (resolve, reject) => {
		const response = await send("Runtime.evaluate", { expression: "(() => { const c = window.__cozyclay?.shotCam; return c ? { x: c.position.x, z: c.position.z } : null; })()", returnByValue: true });
		if (response.exceptionDetails) reject(new Error(response.exceptionDetails.text)); else resolve(response.result.value);
	});
	assert.ok(camera, "shot camera was not available for occlusion setup");
	const ratio = 0.55;
	const placed = await call("place_object", { kind: "cube", x: camera.x * (1 - ratio), z: camera.z * (1 - ratio), name: "G007 Occluder" });
	assert.equal(placed.isError, undefined, JSON.stringify(placed));
	const objectId = placed.content[0].text.match(/as (\S+)\./)?.[1];
	assert.ok(objectId, placed.content[0].text);
	const scaled = await call("update_object", { id: objectId, scale_x: 2.4, scale_y: 3, scale_z: 0.8 });
	assert.equal(scaled.isError, undefined, JSON.stringify(scaled));
	const occluded = await decoded("capture_frame");
	assert.equal(occluded.body.assertions.occludedBy, objectId, JSON.stringify(occluded.body.assertions));
	assert.ok(occluded.body.assertions.visiblePixelCount >= 0);
	const moved = await call("update_object", { id: objectId, x: camera.x + 8, z: camera.z });
	assert.equal(moved.isError, undefined, JSON.stringify(moved));
	const clear = await decoded("capture_frame");
	assert.equal(clear.body.assertions.occludedBy, null, JSON.stringify(clear.body.assertions));
	assert.ok(clear.body.assertions.visiblePixelCount > occluded.body.assertions.visiblePixelCount, JSON.stringify({ occluded: occluded.body.assertions, clear: clear.body.assertions }));

	// Given an intentionally tiny inline budget
	// When the same live capture exceeds it
	// Then the result names a local artifact with exact dimensions and compressed byte size.
	const artifact = await decoded("capture_frame", { max_inline_bytes: 1024 });
	artifactPath = artifact.body.artifact?.path ?? null;
	assert.ok(artifactPath, JSON.stringify(artifact.body));
	assert.equal(artifact.body.artifact.width, 640);
	assert.equal(artifact.body.artifact.height, 360);
	assert.equal(artifact.body.artifact.byteSize, artifact.body.byteSize);
	await assert.doesNotReject(access(artifactPath), "capture artifact must remain available until the MCP session closes");
	await assert.doesNotReject(access(peerArtifactPath), "starting another MCP process must not delete a fresh peer artifact");

	console.log(JSON.stringify({
		vitePort, livePort,
		happy: { width: happy.body.width, height: happy.body.height, byteSize: happy.body.byteSize, nonBlackPixels: happy.body.assertions.nonBlackPixels, stateHash: happy.body.stateHashBefore },
		occlusion: { objectId, occluded: occluded.body.assertions, clear: clear.body.assertions },
		artifact: artifact.body.artifact,
	}));
} finally {
	cdp?.close();
	await client?.close().catch(() => {});
	await Promise.all([terminate(browser), terminate(vite)]);
}
if (artifactPath) await assert.rejects(access(artifactPath), "stdio process exit must remove capture artifacts");
await assert.doesNotReject(access(peerArtifactPath), "one MCP process exiting must not delete another process's artifact");
await unlink(peerArtifactPath);

const blackFrame = await verifyRejectedCapture({
	value: {
		width: 640,
		height: 360,
		mimeType: "image/png",
		encoding: "base64",
		byteSize: 1,
		data: "AA==",
		assertions: { renderable: true, blackFrame: true, nonBlackPixels: 0 },
	},
	expected: /non-renderable or black/,
});
const noCamera = await verifyRejectedCapture({
	error: "No renderable shot camera is available for capture_frame.",
	expected: /No renderable shot camera/,
});
const oversize = await verifyRejectedCapture({
	value: {
		width: 640,
		height: 360,
		mimeType: "image/png",
		encoding: "base64",
		byteSize: 1_000_001,
		data: Buffer.alloc(1_000_001).toString("base64"),
		assertions: { renderable: true, blackFrame: false, nonBlackPixels: 1 },
		authoredStateBefore: "{}",
		authoredStateAfter: "{}",
	},
	expected: /maximum 1000000 bytes/,
});
console.log(JSON.stringify({ rejected: { blackFrame, noCamera, oversize } }));

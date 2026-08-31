#!/usr/bin/env node
/** Regression coverage for live scene parity and bounded scene reads. */
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { WebSocket } from "ws";

const serverPath = fileURLToPath(new URL("./server.mjs", import.meta.url));

const reservePort = () =>
	new Promise((resolve, reject) => {
		const server = createServer();
		server.once("error", reject);
		server.listen(0, "127.0.0.1", () => {
			const address = server.address();
			if (!address || typeof address === "string") {
				reject(new Error("Could not reserve a TCP port."));
				return;
			}
			server.close((error) => (error ? reject(error) : resolve(address.port)));
		});
	});

const withTimeout = (promise, label) => {
	let timer;
	return Promise.race([
		promise,
		new Promise((_, reject) => {
			timer = setTimeout(() => reject(new Error(`Timed out waiting for ${label}.`)), 2_000);
		}),
	]).finally(() => clearTimeout(timer));
};

const once = (target, event) =>
	withTimeout(
		new Promise((resolve, reject) => {
			target.once(event, resolve);
			target.once("error", reject);
		}),
		event,
	);

const clone = (value) => JSON.parse(JSON.stringify(value));
const livePort = await reservePort();
const projectDirectory = await mkdtemp(join(tmpdir(), "cozyclay-mcp-g004-"));
const liveUrl = `ws://127.0.0.1:${livePort}/live`;
let applySceneDocuments = true;
const editor = {
	document: {
		version: 3,
		activeSceneId: "scene-live",
		scenes: [{
			id: "scene-live",
			name: "LIVE TEST",
			stage: {
				shotAspect: "16:9",
				sensorId: "super35",
				hasCharSheet: false,
				characters: [{ id: "char-a", model: "y-bot-tpose", subject: "performer", x: 0, y: 0, z: 0, rot: 0, hidden: false }],
			},
			objects: Array.from({ length: 51 }, (_, index) => ({
				id: `cube-${index + 1}`,
				name: `Cube ${index + 1}`,
				renderer: "cube",
				x: index,
				y: 0,
				z: 0,
				rot: 0,
				scaleX: 1,
				scaleY: 1,
				scaleZ: 1,
				parent: null,
				footprint: { width: 1, depth: 1 },
				height: 1,
			})),
		}],
	},
};

const activeEditorScene = () =>
	editor.document.scenes.find((scene) => scene.id === editor.document.activeSceneId) ?? editor.document.scenes[0];

const describeEditor = () => {
	const scene = activeEditorScene();
	return {
		sceneName: scene.name,
		camera: { x: 0, y: 1.6, z: 4.5, focalMm: 35, sensorId: "super35", aspectRatio: 1.78 },
		stage: { shotAspect: scene.stage.shotAspect, sensorId: scene.stage.sensorId, hasCharSheet: scene.stage.hasCharSheet },
		timeline: { currentFrame: 0, frameCount: 240, fps: 24 },
		characters: clone(scene.stage.characters),
		objects: clone(scene.objects),
	};
};

const client = new Client({ name: "cozyclay-g004-scene-parity-verify", version: "1.0.0" });
const transport = new StdioClientTransport({
	command: process.execPath,
	args: [serverPath, "--live-port", String(livePort)],
	env: { ...process.env, COZYCLAY_PROJECT_ROOT: projectDirectory },
});
let socket;
try {
	await client.connect(transport);
	socket = new WebSocket(liveUrl);
	socket.on("message", (raw) => {
		const frame = JSON.parse(raw.toString());
		if (frame.type !== "cmd") return;
		try {
			if (frame.name === "describe") {
				socket.send(JSON.stringify({ type: "result", id: frame.id, ok: true, value: describeEditor() }));
				return;
			}
			if (frame.name === "load_scenes") {
				if (applySceneDocuments) editor.document = clone(frame.args.document);
				socket.send(JSON.stringify({
					type: "result",
					id: frame.id,
					ok: true,
					value: {
						sceneName: activeEditorScene().name,
						activeSceneId: editor.document.activeSceneId,
						scenes: editor.document.scenes.map((scene) => ({ id: scene.id, name: scene.name })),
					},
				}));
				return;
			}
			throw new Error(`Unexpected command: ${frame.name}`);
		} catch (error) {
			socket.send(JSON.stringify({ type: "result", id: frame.id, ok: false, error: error.message }));
		}
	});
	await once(socket, "open");
	socket.send(JSON.stringify({ type: "hello", role: "editor", version: 1 }));

	const call = (name, args = {}) => client.callTool({ name, arguments: args });
	const initial = await call("describe_scene");
	assert.equal(initial.isError, undefined, JSON.stringify(initial));

	// Given a 51-object scene
	// When describe_scene uses its default bounded read
	const bounded = await call("describe_scene", { object_cursor: 0, limit: 50 });
	// Then it declares the bound and the remaining object has a cursor path.
	assert.equal(bounded.isError, undefined, JSON.stringify(bounded));
	assert.match(bounded.content[0].text, /SET \(total: 51, returned: 50, truncated: true, revision: [a-f0-9]+\)/);
	assert.doesNotMatch(bounded.content[0].text, /cube-51/);
	const remainder = await call("describe_scene", { object_cursor: 50, limit: 50 });
	assert.match(remainder.content[0].text, /SET \(total: 51, returned: 1, truncated: false, revision: [a-f0-9]+\)/);
	assert.match(remainder.content[0].text, /cube-51/);

	// Given an editor that does not install the requested scene document
	// When add_scene receives a non-parity acknowledgement
	applySceneDocuments = false;
	const refused = await call("add_scene", { name: "REFUSED" });
	// Then the MCP tool must not report success.
	assert.equal(refused.isError, true, JSON.stringify(refused));
	assert.match(refused.content[0].text, /complete scene list and active scene/i);
	applySceneDocuments = true;

	// Given a connected editor
	// When add_scene reports success
	const added = await call("add_scene", { name: "LIVE SECOND" });
	// Then the server's saved list and the editor's list must agree.
	assert.equal(added.isError, undefined, JSON.stringify(added));
	const savedPath = join(projectDirectory, "live-scenes.cclayproject");
	const saved = await call("save_project", { path: savedPath });
	assert.equal(saved.isError, undefined, JSON.stringify(saved));
	const serverDocument = JSON.parse(await readFile(savedPath, "utf8")).scenes;
	assert.deepEqual(
		serverDocument.scenes.map((scene) => ({ id: scene.id, name: scene.name })),
		editor.document.scenes.map((scene) => ({ id: scene.id, name: scene.name })),
		"A successful add_scene must not leave different server and editor scene lists.",
	);
	const switched = await call("switch_scene", { name: "LIVE TEST" });
	assert.equal(switched.isError, undefined, JSON.stringify(switched));
	assert.equal(activeEditorScene().name, "LIVE TEST");

	const closed = once(socket, "close");
	socket.close();
	await closed;
	// The client-side close resolves before the hub has processed the
	// disconnect; poll until the hub itself reports fallback mode so the
	// headless assertions below test fallback, not close latency.
	const fallbackDeadline = Date.now() + 5_000;
	while (!(await call("live_status")).content[0].text.includes("No live editor")) {
		if (Date.now() > fallbackDeadline) throw new Error("live hub never noticed the editor disconnect");
		await new Promise((resolve) => setTimeout(resolve, 100));
	}

	// Given no connected editor
	// When scenes are created, switched, saved, and reopened
	const headlessAdded = await call("add_scene", { name: "HEADLESS" });
	const headlessSwitched = await call("switch_scene", { name: "HEADLESS" });
	const headlessDescribe = await call("describe_scene");
	const headlessPath = join(projectDirectory, "headless.cclayproject");
	const headlessSaved = await call("save_project", { path: headlessPath });
	const headlessOpened = await call("open_project", { path: headlessPath });
	// Then the memory-only fallback retains its complete project behavior.
	for (const result of [headlessAdded, headlessSwitched, headlessDescribe, headlessSaved, headlessOpened]) {
		assert.equal(result.isError, undefined, JSON.stringify(result));
	}
	assert.match(headlessDescribe.content[0].text, /Scene: HEADLESS/);

	console.log(JSON.stringify({
		livePort,
		serverSceneNames: serverDocument.scenes.map((scene) => scene.name),
		editorSceneNames: editor.document.scenes.map((scene) => scene.name),
		truncation: bounded.content[0].text.match(/SET \([^\n]+\)/)?.[0],
		headless: { added: !headlessAdded.isError, switched: !headlessSwitched.isError, opened: !headlessOpened.isError },
	}));
} finally {
	if (socket?.readyState === WebSocket.OPEN) socket.close();
	await client.close().catch(() => {});
	await rm(projectDirectory, { recursive: true, force: true });
}

const cleanupProbe = createServer();
await new Promise((resolve, reject) => {
	cleanupProbe.once("error", reject);
	cleanupProbe.listen(livePort, "127.0.0.1", resolve);
});
await new Promise((resolve, reject) => cleanupProbe.close((error) => (error ? reject(error) : resolve())));
console.log(JSON.stringify({ cleanup: { livePortReusable: true } }));

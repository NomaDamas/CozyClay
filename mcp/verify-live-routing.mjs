#!/usr/bin/env node
/** Regression coverage: a live mutation cannot cross a workspace boundary. */
import assert from "node:assert/strict";
import { createServer } from "node:net";
import { fileURLToPath } from "node:url";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { WebSocket } from "ws";
import { LiveHub } from "./live-hub.mjs";

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
const queueHub = new LiveHub();
queueHub.editors.set("queue-workspace", { readyState: WebSocket.OPEN });
queueHub.editors.set("other-workspace", { readyState: WebSocket.OPEN });
let releaseFirst;
let signalFirstStarted;
const firstStarted = new Promise((resolve) => { signalFirstStarted = resolve; });
const order = [];
const firstQueued = queueHub.runExclusive("first", "queue-workspace", async () => {
	order.push("first:start");
	signalFirstStarted();
	await new Promise((resolve) => { releaseFirst = resolve; });
	order.push("first:end");
});
const secondQueued = queueHub.runExclusive("second", "other-workspace", async () => {
	order.push("second");
});
await firstStarted;
assert.deepEqual(order, ["first:start"]);
releaseFirst();
await Promise.all([firstQueued, secondQueued]);
assert.deepEqual(order, ["first:start", "first:end", "second"]);

const livePort = await reservePort();
const url = `ws://127.0.0.1:${livePort}/live`;

const connectEditor = async (name, workspaceId = `${name}-workspace`) => {
	const state = {
		document: {
			version: 3,
			activeSceneId: `${name.toLowerCase()}-scene`,
			scenes: [{
				id: `${name.toLowerCase()}-scene`,
				name,
				objects: [],
				shotDocument: null,
				stage: { characters: [], hasCharSheet: false, shotAspect: "16:9", sensorId: "super35" },
			}],
		},
		sceneName: name,
		camera: { x: 0, y: 1.6, z: 4.5, focalMm: 35, sensorId: "super35", aspectRatio: 1.78 },
		stage: { shotAspect: "16:9", sensorId: "super35", hasCharSheet: false },
		timeline: { currentFrame: 0, frameCount: 240, fps: 24 },
		characters: [{ id: "char-a", model: "y-bot-tpose", subject: name, x: 0, y: 0, z: 0, rot: 0, hidden: false }],
		objects: [],
	};
	const socket = new WebSocket(url);
	const workspace = withTimeout(
		new Promise((resolve, reject) => {
			socket.on("message", (raw) => {
				const frame = JSON.parse(raw.toString());
				if (frame.type === "workspace" && typeof frame.handle === "string") resolve(frame.handle);
				if (frame.type === "cmd") {
					try {
						if (frame.name === "describe") socket.send(JSON.stringify({ type: "result", id: frame.id, ok: true, value: clone(state) }));
						else if (frame.name === "set_camera") {
							for (const key of ["x", "y", "z", "focalMm"]) if (frame.args[key] !== undefined) state.camera[key] = frame.args[key];
							socket.send(JSON.stringify({ type: "result", id: frame.id, ok: true, value: { camera: clone(state.camera) } }));
						} else if (frame.name === "load_scenes") {
							state.document = clone(frame.args.document);
							state.sceneName = state.document.scenes.find((scene) => scene.id === state.document.activeSceneId)?.name ?? "";
							socket.send(JSON.stringify({
								type: "result", id: frame.id, ok: true,
								value: {
									sceneName: state.sceneName,
									activeSceneId: state.document.activeSceneId,
									scenes: state.document.scenes.map(({ id, name: sceneName }) => ({ id, name: sceneName })),
								},
							}));
						} else socket.send(JSON.stringify({ type: "result", id: frame.id, ok: false, error: `Unexpected command: ${frame.name}` }));
					} catch (error) {
						reject(error);
					}
				}
			});
		}),
		`${name} workspace handle`,
	);
	await once(socket, "open");
	socket.send(JSON.stringify({ type: "hello", role: "editor", version: 1, workspaceId }));
	return { socket, state, workspace: await workspace };
};

const client = new Client({ name: "cozyclay-live-routing-verify", version: "1.0.0" });
const transport = new StdioClientTransport({ command: process.execPath, args: [serverPath, "--live-port", String(livePort)] });
let first;
let second;
let reconnected;
try {
	await client.connect(transport);
	const untrusted = new WebSocket(url, { headers: { Origin: "https://untrusted.example" } });
	await once(untrusted, "open");
	const untrustedClose = await withTimeout(new Promise((resolve) => untrusted.once("close", (code, reason) => resolve({ code, reason: reason.toString() }))), "untrusted origin close");
	assert.equal(untrustedClose.code, 1008);
	assert.match(untrustedClose.reason, /origin.*loopback/i);
	first = await connectEditor("FIRST");
	const duplicate = new WebSocket(url);
	await once(duplicate, "open");
	duplicate.send(JSON.stringify({ type: "hello", role: "editor", version: 1, workspaceId: "FIRST-workspace" }));
	const duplicateClose = await withTimeout(new Promise((resolve) => duplicate.once("close", (code, reason) => resolve({ code, reason: reason.toString() }))), "duplicate workspace close");
	assert.equal(duplicateClose.code, 1008);
	assert.match(duplicateClose.reason, /already connected/i);
	second = await connectEditor("SECOND");
	assert.notEqual(first.workspace, second.workspace, "each editor needs a distinct workspace handle");

	const call = (name, args = {}) => client.callTool({ name, arguments: args });
	/** Poll until the hub itself no longer lists this workspace — bounded, so
	 * a hub that truly never notices a disconnect still fails loudly. */
	const waitForWorkspaceGone = async (handle) => {
		const deadline = Date.now() + 5_000;
		for (;;) {
			const status = await call("live_status");
			if (!status.content[0].text.includes(handle)) return;
			if (Date.now() > deadline) throw new Error(`live hub never dropped workspace ${handle}`);
			await new Promise((resolve) => setTimeout(resolve, 100));
		}
	};
	const beforeBoundOther = clone(second.state);

	// Given two live editors and a command explicitly bound to the first handle
	// When MCP mutates the camera
	const bound = await call("set_camera", { workspace_handle: first.workspace, x: 11 });
	// Then only the requested editor changes; the other byte-for-byte survives.
	assert.equal(bound.isError, undefined, JSON.stringify(bound));
	assert.equal(first.state.camera.x, 11);
	assert.deepEqual(second.state, beforeBoundOther);
	const selectedRead = await call("describe_scene", { workspace_handle: first.workspace });
	assert.equal(selectedRead.isError, undefined, JSON.stringify(selectedRead));
	assert.match(selectedRead.content[0].text, /Scene: FIRST/);
	assert.doesNotMatch(selectedRead.content[0].text, /Scene: SECOND/);
	await call("add_scene", { name: "A2", workspace_handle: first.workspace });
	await call("add_scene", { name: "B2", workspace_handle: second.workspace });
	assert.deepEqual(first.state.document.scenes.map(({ name }) => name), ["FIRST", "A2"]);
	assert.deepEqual(second.state.document.scenes.map(({ name }) => name), ["SECOND", "B2"]);
	const beforeAmbiguousFirst = clone(first.state);
	const beforeAmbiguousSecond = clone(second.state);
	// Given two live editors
	// When a live mutation omits its workspace handle
	const ambiguous = await call("set_camera", { x: 22 });
	// Then the refusal names every candidate and applies nothing.
	assert.equal(ambiguous.isError, true, JSON.stringify(ambiguous));
	assert.match(ambiguous.content[0].text, new RegExp(first.workspace));
	assert.match(ambiguous.content[0].text, new RegExp(second.workspace));
	assert.deepEqual(first.state, beforeAmbiguousFirst);
	assert.deepEqual(second.state, beforeAmbiguousSecond);
	const ambiguousRead = await call("describe_scene");
	assert.equal(ambiguousRead.isError, true, JSON.stringify(ambiguousRead));
	assert.match(ambiguousRead.content[0].text, new RegExp(first.workspace));
	assert.match(ambiguousRead.content[0].text, new RegExp(second.workspace));

	const beforeUnknownFirst = clone(first.state);
	const beforeUnknownSecond = clone(second.state);
	const unknown = await call("set_camera", { workspace_handle: "workspace-stale-unknown", x: 33 });
	assert.equal(unknown.isError, true, JSON.stringify(unknown));
	assert.match(unknown.content[0].text, /unknown|stale/i);
	assert.deepEqual(first.state, beforeUnknownFirst);
	assert.deepEqual(second.state, beforeUnknownSecond);

	const formerHandle = second.workspace;
	const secondClosed = once(second.socket, "close");
	second.socket.close();
	await secondClosed;
	// The client-side close resolves before the hub has processed the
	// disconnect; until it does, formerHandle is still valid and the stale
	// check below would race. Poll the hub's own view.
	await waitForWorkspaceGone(formerHandle);
	reconnected = await connectEditor("RECONNECTED");
	assert.notEqual(reconnected.workspace, formerHandle, "reconnect must issue a fresh workspace handle");
	const beforeStale = clone(reconnected.state);
	const stale = await call("set_camera", { workspace_handle: formerHandle, x: 44 });
	assert.equal(stale.isError, true, JSON.stringify(stale));
	assert.match(stale.content[0].text, /unknown|stale/i);
	assert.deepEqual(reconnected.state, beforeStale);

	const firstClosed = once(first.socket, "close");
	first.socket.close();
	await firstClosed;
	// Same hub race as above: the no-handle path below is only unambiguous
	// once the hub has actually dropped the first workspace (first seen as a
	// two-workspace ambiguity error on a slow CI runner).
	await waitForWorkspaceGone(first.workspace);
	// Given exactly one live editor
	// When a mutation omits its handle
	const unboundSingle = await call("set_camera", { x: 55 });
	// Then the ordinary one-tab path remains unambiguous.
	assert.equal(unboundSingle.isError, undefined, JSON.stringify(unboundSingle));
	assert.equal(reconnected.state.camera.x, 55);

	const status = await call("live_status");
	assert.match(status.content[0].text, new RegExp(reconnected.workspace));
	console.log(JSON.stringify({
		livePort,
		handles: { first: first.workspace, second: formerHandle, reconnected: reconnected.workspace },
		isolation: { first: first.state, second: beforeBoundOther },
		ambiguity: ambiguous.content[0].text,
		stale: stale.content[0].text,
		guards: { untrustedOrigin: untrustedClose, duplicateWorkspace: duplicateClose },
		single: { isError: unboundSingle.isError ?? false, state: reconnected.state },
	}));
} finally {
	for (const editor of [first, second, reconnected]) {
		if (editor?.socket.readyState === WebSocket.OPEN) editor.socket.close();
	}
	await client.close().catch(() => {});
}

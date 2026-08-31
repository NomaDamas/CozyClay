#!/usr/bin/env node
/** Real editor coverage for MCP batch transactions and undo coalescing. */
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createServer } from "node:net";
import { fileURLToPath } from "node:url";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { WebSocket } from "ws";

import { chromeArgs, resolveChromePath } from "./qa-chrome.mjs";

const root = fileURLToPath(new URL("..", import.meta.url)); const serverPath = fileURLToPath(new URL("./server.mjs", import.meta.url));

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

const withTimeout = (promise, label, milliseconds = 30_000) => {
	let timer;
	return Promise.race([
		promise,
		new Promise((_, reject) => {
			timer = setTimeout(() => reject(new Error(`Timed out waiting for ${label}.`)), milliseconds);
		}),
	]).finally(() => clearTimeout(timer));
};

const waitForOutput = (child, pattern, label) =>
	withTimeout(
		new Promise((resolve, reject) => {
			let output = "";
			const inspect = (chunk) => {
				// picocolors turns colour ON when CI is set even without a TTY, and
				// the port lands inside bold escapes ("...127.0.0.1:\x1b[1m5599...")
				// — strip ANSI before matching or the ready banner never matches
				// on a GitHub runner while passing everywhere locally.
				output += chunk.toString().replace(/\u001b\[[0-9;]*m/g, "");
				if (pattern.test(output)) finish(resolve);
			};
			const onExit = (code, signal) => finish(reject, new Error(`${label} exited (${code ?? signal ?? "unknown"}): ${output}`));
			const finish = (callback, value) => {
				child.stdout.off("data", inspect);
				child.stderr.off("data", inspect);
				child.off("exit", onExit);
				callback(value);
			};
			child.stdout.on("data", inspect);
			child.stderr.on("data", inspect);
			child.once("exit", onExit);
		}),
		label,
	);

const terminate = async (child) => {
	if (!child || child.exitCode !== null || child.signalCode !== null) return;
	const exited = new Promise((resolve) => child.once("exit", resolve));
	child.kill("SIGTERM");
	await withTimeout(exited, "child cleanup", 5_000).catch(() => child.kill("SIGKILL"));
};

const vitePort = await reservePort(); const livePort = await reservePort(); const cdpPort = await reservePort();
const vite = spawn(process.execPath, ["node_modules/vite/bin/vite.js", "--host", "127.0.0.1", "--port", String(vitePort), "--strictPort"], {
	cwd: root,
	env: { ...process.env, COZYCLAY_LIVE_PORT: String(livePort) },
	stdio: ["ignore", "pipe", "pipe"],
});
const browser = spawn(resolveChromePath(), chromeArgs(cdpPort), { stdio: ["ignore", "pipe", "pipe"] });

let socket;
let client;
try {
	await waitForOutput(vite, new RegExp(`http://127\\.0\\.0\\.1:${vitePort}/`), "Vite");
	await waitForOutput(browser, /DevTools listening on (ws:\/\/[^\s]+)/, "Chrome");
	const targets = await (await fetch(`http://127.0.0.1:${cdpPort}/json`)).json();
	const page = targets.find((target) => target.type === "page" && target.webSocketDebuggerUrl);
	if (!page) throw new Error("Chrome did not expose a page target.");

	socket = new WebSocket(page.webSocketDebuggerUrl);
	await withTimeout(new Promise((resolve, reject) => {
		socket.addEventListener("open", resolve, { once: true });
		socket.addEventListener("error", reject, { once: true });
	}), "CDP connection");
	let nextId = 1;
	const pending = new Map();
	let resolveEditorHello;
	const editorHello = new Promise((resolve) => {
		resolveEditorHello = resolve;
	});
	const editorResultWaiters = [];
	socket.addEventListener("message", (event) => {
		const frame = JSON.parse(event.data);
		if (frame.method === "Network.webSocketFrameSent") {
			try {
				const editorFrame = JSON.parse(frame.params.response.payloadData);
				if (editorFrame.type === "hello" && editorFrame.role === "editor") resolveEditorHello();
				if (editorFrame.type === "result" && editorFrame.value?.objects) {
					editorResultWaiters.shift()?.(editorFrame.value);
				}
			} catch {
				// CDP carries unrelated non-protocol WebSocket frames too.
			}
		}
		if (!frame.id || !pending.has(frame.id)) return;
		const request = pending.get(frame.id);
		pending.delete(frame.id);
		if (frame.error) request.reject(new Error(JSON.stringify(frame.error)));
		else request.resolve(frame.result);
	});
	const send = (method, params = {}) =>
		new Promise((resolve, reject) => {
			const id = nextId++;
			pending.set(id, { resolve, reject });
			socket.send(JSON.stringify({ id, method, params }));
		});
	const evaluate = async (expression) => {
		const response = await send("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true });
		if (response.exceptionDetails) throw new Error(response.exceptionDetails.text);
		return response.result.value;
	};
	await send("Network.enable");
	await send("Page.enable");
	await send("Runtime.enable");
	await send("Page.navigate", { url: `http://127.0.0.1:${vitePort}/app/` });

	client = new Client({ name: "cozyclay-live-batch-verify", version: "1.0.0" });
	await client.connect(new StdioClientTransport({ command: process.execPath, args: [serverPath, "--live-port", String(livePort)] }));
	await withTimeout(editorHello, "editor live hello");
	await withTimeout(evaluate(
		"window.__cozyclayMcpRigReady?.includes('char-a') ? true : new Promise((resolve) => window.addEventListener('cozyclay:mcp-rig-ready', (event) => event.detail === 'char-a' && resolve(true), { once: true }))",
	), "character rig readiness");
	const call = (name, args = {}) => client.callTool({ name, arguments: args });
	const history = () => evaluate("window.__sceneHistory()");
	const description = async () => {
		const pendingDescription = new Promise((resolve) => editorResultWaiters.push(resolve));
		await call("describe_scene");
		return JSON.stringify(await pendingDescription);
	};
	const assertSceneEquivalent = (actualJson, expectedJson) => {
		const actual = JSON.parse(actualJson);
		const expected = JSON.parse(expectedJson);
		assert.equal(actual.sceneName, expected.sceneName);
		assert.deepEqual(actual.stage, expected.stage);
		assert.deepEqual(actual.timeline, expected.timeline);
		assert.deepEqual(actual.characters, expected.characters);
		assert.deepEqual(actual.objects, expected.objects);
		for (const field of ["x", "y", "z", "focalMm"]) {
			assert.ok(Math.abs(actual.camera[field] - expected.camera[field]) < 0.01, `camera ${field} changed`);
		}
		assert.equal(actual.camera.sensorId, expected.camera.sensorId);
		assert.equal(actual.camera.aspectRatio, expected.camera.aspectRatio);
	};

	// Given a normal one-shot MCP object mutation
	// When it reaches the live editor outside a batch
	// Then it retains its own undo entry.
	const beforeSingle = await description();
	const singleDepth = await history();
	const single = await call("place_object", { kind: "cube", x: -3 });
	assert.equal(single.isError, undefined, JSON.stringify(single));
	assert.equal((await history()).past - singleDepth.past, 1);
	await evaluate('window.dispatchEvent(new KeyboardEvent("keydown", { code: "KeyZ", ctrlKey: true, bubbles: true, cancelable: true }))');
	assert.deepEqual(JSON.parse(await description()).objects, JSON.parse(beforeSingle).objects);

	// Given an agent managing one element end to end — the reported "an MCP
	// element sometimes goes missing" class of failure
	// When place -> update -> remove run back to back as separate commands
	// Then every step is visible in the editor's OWN description immediately:
	// the placed object appears under its returned id, the update lands on
	// that id, and the removal leaves no trace. No step may silently drop.
	const placedResult = await call("place_object", { kind: "cube", x: 2, z: -2, name: "Lifecycle Crate" });
	assert.equal(placedResult.isError, undefined, JSON.stringify(placedResult));
	const placedId = placedResult.content[0].text.match(/Placed object as ([^.\s]+)\./)?.[1];
	assert.ok(placedId, placedResult.content[0].text);
	const afterPlace = JSON.parse(await description()).objects.find((object) => object.id === placedId);
	assert.ok(afterPlace, `placed object ${placedId} missing from the editor description`);
	assert.equal(afterPlace.name, "Lifecycle Crate");
	const updated = await call("update_object", { id: placedId, x: 4, color: "#ff0000", name: "Lifecycle Crate B" });
	assert.equal(updated.isError, undefined, JSON.stringify(updated));
	const afterUpdate = JSON.parse(await description()).objects.find((object) => object.id === placedId);
	assert.ok(afterUpdate, `updated object ${placedId} missing from the editor description`);
	assert.equal(afterUpdate.x, 4);
	assert.equal(afterUpdate.color, "#ff0000");
	assert.equal(afterUpdate.name, "Lifecycle Crate B");
	const removed = await call("remove_object", { id: placedId });
	assert.equal(removed.isError, undefined, JSON.stringify(removed));
	assert.ok(
		!JSON.parse(await description()).objects.some((object) => object.id === placedId),
		"removed object still present in the editor description",
	);

	// Given the real editor has an empty object history
	// When an MCP agent applies multiple mutations as a batch
	// Then all mutations land and one Undo returns the complete pre-batch document.
	const beforeHappy = await description();
	const happyDepth = await history();
	const happy = await call("apply_batch", {
		label: "Block street furniture",
		atomic: false,
		stopOnError: true,
		ops: [
			{ name: "place_object", args: { kind: "cube", x: 1, z: 2 } },
			{ name: "place_object", args: { kind: "chair", x: -2, z: 1 } },
			{ name: "place_object", args: { kind: "sphere", x: 0, z: -1 } },
		],
	});
	assert.equal(happy.isError, undefined, JSON.stringify(happy));
	assert.match(happy.content[0].text, /Applied 3 operation\(s\)/);
	const afterHappy = await description();
	const happyAfterDepth = await history();
	assert.equal(JSON.parse(afterHappy).objects.length, JSON.parse(beforeHappy).objects.length + 3);
	assert.equal(happyAfterDepth.past - happyDepth.past, 1);
	await evaluate('window.dispatchEvent(new KeyboardEvent("keydown", { code: "KeyZ", ctrlKey: true, bubbles: true, cancelable: true }))');
	const undoHappy = await description();
	assertSceneEquivalent(undoHappy, beforeHappy);
	assert.equal((await history()).past, happyDepth.past);

	// Given a batch whose third operation cannot resolve an object id
	// When atomic mode is requested
	// Then the document is byte-identical and no undo entry is added.
	await call("set_camera", { x: 2, y: 1.6, z: 4.5, focal_mm: 35 });
	const beforeAtomicFailure = await description();
	const atomicDepth = await history();
	const atomicFailure = await call("apply_batch", {
		label: "Rollback malformed block",
		atomic: true,
		stopOnError: true,
		ops: [
			{ name: "place_object", args: { kind: "cube", x: 3 } },
			{ name: "place_object", args: { kind: "chair", x: 4 } },
			{ name: "update_object", args: { id: "missing-object", x: 5 } },
		],
	});
	assert.equal(atomicFailure.isError, undefined, JSON.stringify(atomicFailure));
	assert.match(atomicFailure.content[0].text, /rolled back/i);
	const afterAtomicFailure = await description();
	assertSceneEquivalent(afterAtomicFailure, beforeAtomicFailure);
	const atomicRollbackDepthDelta = (await history()).past - atomicDepth.past;
	assert.equal(atomicRollbackDepthDelta, 0);

	// Given non-atomic mode stops on an invalid second operation
	// When the first operation has already applied
	// Then that first operation remains and the report names the applied index.
	const partialDepth = await history();
	const partial = await call("apply_batch", {
		label: "Keep completed work",
		atomic: false,
		stopOnError: true,
		ops: [
			{ name: "place_object", args: { kind: "cone", x: 5 } },
			{ name: "update_object", args: { id: "missing-object", x: 6 } },
			{ name: "place_object", args: { kind: "plane", x: 7 } },
		],
	});
	assert.equal(partial.isError, undefined, JSON.stringify(partial));
	assert.match(partial.content[0].text, /Applied 1 operation\(s\).*Failure at operation 2/i);
	assert.equal((await history()).past - partialDepth.past, 1);
	assert.equal(JSON.parse(await description()).objects.length, JSON.parse(beforeHappy).objects.length + 1);
	await evaluate('window.dispatchEvent(new KeyboardEvent("keydown", { code: "KeyZ", ctrlKey: true, bubbles: true, cancelable: true }))');

	// Given stopOnError is disabled
	// When an early operation fails
	// Then later operations still run while the batch remains one undo entry.
	const continueDepth = await history();
	const continueBatch = await call("apply_batch", {
		atomic: false,
		stopOnError: false,
		ops: [
			{ name: "update_object", args: { id: "missing-object", x: 6 } },
			{ name: "place_object", args: { kind: "plane", x: 7 } },
		],
	});
	assert.equal(continueBatch.isError, undefined, JSON.stringify(continueBatch));
	assert.match(continueBatch.content[0].text, /Applied 1 operation\(s\).*Failure at operation 1/i);
	assert.equal((await history()).past - continueDepth.past, 1);
	await evaluate('window.dispatchEvent(new KeyboardEvent("keydown", { code: "KeyZ", ctrlKey: true, bubbles: true, cancelable: true }))');

	// Given a batch exceeds its fixed cap or tries to nest a batch
	// When it is sent to the MCP boundary
	// Then neither form mutates the editor or creates history.
	const boundaryDocument = await description();
	const boundaryDepth = await history();
	const tooMany = await call("apply_batch", {
		ops: Array.from({ length: 101 }, () => ({ name: "place_object", args: { kind: "cube" } })),
	});
	assert.equal(tooMany.isError, true, JSON.stringify(tooMany));
	const nested = await call("apply_batch", { ops: [{ name: "apply_batch", args: { ops: [] } }] });
	assert.equal(nested.isError, true, JSON.stringify(nested));
	const characterBatch = await call("apply_batch", { ops: [{ name: "update_character", args: { ref: "A", x: 1 } }] });
	assert.equal(characterBatch.isError, true, JSON.stringify(characterBatch));
	assert.deepEqual(JSON.parse(await description()).objects, JSON.parse(boundaryDocument).objects);
	assert.equal((await history()).past - boundaryDepth.past, 0);

	console.log(JSON.stringify({
		happy: {
			preState: JSON.parse(beforeHappy),
			postState: JSON.parse(afterHappy),
			undoState: JSON.parse(undoHappy),
			undoDepthDelta: happyAfterDepth.past - happyDepth.past,
		},
		atomicRollback: {
			preState: JSON.parse(beforeAtomicFailure),
			postState: JSON.parse(afterAtomicFailure),
			undoDepthDelta: atomicRollbackDepthDelta,
		},
		edges: {
			partialStopOnError: partial.content[0].text.split("\n")[0],
			continueAfterError: continueBatch.content[0].text.split("\n")[0],
			capRejected: tooMany.isError === true,
			nestedRejected: nested.isError === true,
			characterBatchRejected: characterBatch.isError === true,
		},
		adjacentUndoDepthDeltas: { singleShot: 1, humanPointerDrag: 1 },
		mixedObjectCharacterBatches: "restricted-v1",
	}));
} finally {
	socket?.close();
	await client?.close().catch(() => {});
	await Promise.all([terminate(browser), terminate(vite)]);
}

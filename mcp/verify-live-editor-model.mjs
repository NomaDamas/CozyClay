#!/usr/bin/env node
/** Real-editor regression: add_character preserves an explicit mannequin model. */
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { createServer } from "node:net";
import { fileURLToPath } from "node:url";

import { chromeArgs, resolveChromePath } from "./qa-chrome.mjs";

const root = fileURLToPath(new URL("..", import.meta.url));
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

const vitePort = await reservePort();
const livePort = await reservePort();
const cdpPort = await reservePort();
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
	const devtools = await waitForOutput(browser, /DevTools listening on (ws:\/\/[^\s]+)/, "Chrome");
	void devtools;
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
	let liveHello;
	let xBotRequested;
	const editorFrames = [];
	const editorHello = new Promise((resolve) => {
		liveHello = resolve;
	});
	const xBotRequest = new Promise((resolve) => {
		xBotRequested = resolve;
	});
	socket.addEventListener("message", (event) => {
		const frame = JSON.parse(event.data);
		if (frame.method === "Network.requestWillBeSent" && frame.params.request.url.endsWith("/models/x-bot-tpose.fbx")) xBotRequested();
		if (frame.method === "Network.webSocketFrameSent") {
			const payload = frame.params.response.payloadData;
			try {
				const editorFrame = JSON.parse(payload);
				editorFrames.push(editorFrame);
				if (editorFrame.type === "hello" && editorFrame.role === "editor") liveHello();
			} catch {
				// CDP control responses are handled below; non-JSON payloads are not protocol frames.
			}
		}
		if (frame.id && pending.has(frame.id)) {
			const { resolve, reject } = pending.get(frame.id);
			pending.delete(frame.id);
			if (frame.error) reject(new Error(JSON.stringify(frame.error)));
			else resolve(frame.result);
			return;
		}
	});
	const send = (method, params = {}) =>
		new Promise((resolve, reject) => {
			const id = nextId++;
			pending.set(id, { resolve, reject });
			socket.send(JSON.stringify({ id, method, params }));
		});
	await send("Network.enable");
	await send("Page.enable");
	await send("Page.navigate", { url: `http://127.0.0.1:${vitePort}/app/` });

	client = new Client({ name: "cozyclay-live-editor-model-verify", version: "1.0.0" });
	await client.connect(new StdioClientTransport({ command: process.execPath, args: [serverPath, "--live-port", String(livePort)] }));
	await withTimeout(editorHello, "editor live hello");

	// Given the actual browser editor is connected over its live WebSocket
	// When MCP adds an explicit non-default mannequin
	const added = await client.callTool({
		name: "add_character",
		arguments: { subject: "an x-bot performer", model: "x-bot-tpose" },
	});
	await withTimeout(xBotRequest, "x-bot mesh request", 5_000);
	const described = await client.callTool({ name: "describe_scene", arguments: {} });
	// Then the real editor loads and reports X Bot through the live describe frame.
	assert.equal(added.isError, undefined, JSON.stringify(added));
	const describedFrames = editorFrames.filter((frame) => frame.type === "result" && frame.value?.characters);
	assert.ok(describedFrames.some((frame) => frame.value.characters.some((character) => character.model === "x-bot-tpose")), JSON.stringify(describedFrames));
	assert.match(described.content[0].text, /\[x-bot-tpose\]/, described.content[0].text);
	console.log(JSON.stringify({
		vitePort,
		livePort,
		model: "x-bot-tpose",
		editorDescribeReportedModel: true,
		mcpDescribeReportedModel: /\[x-bot-tpose\]/.test(described.content[0].text),
	}));
} finally {
	socket?.close();
	await client?.close().catch(() => {});
	await Promise.all([terminate(browser), terminate(vite)]);
}

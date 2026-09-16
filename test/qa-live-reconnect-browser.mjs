#!/usr/bin/env node
/**
 * Editor-side connection stability against a real hub, in a real Chrome.
 *
 * Follows mcp/verify-live-capture.mjs: this suite owns its Vite on a free port
 * (COZYCLAY_LIVE_PORT points the studio bundle at the hub), its own
 * startLiveHub, and a Chrome from mcp/qa-chrome.mjs. Nothing here is faked -
 * the studio bundle, the WebSocket hub, the reload, the hub restart and the
 * duplicated tab are all real.
 *
 * Run directly: node test/qa-live-reconnect-browser.mjs
 */
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createServer } from "node:net";
import { fileURLToPath } from "node:url";

import { startLiveHub } from "../mcp/live-hub.mjs";
import { chromeArgs, resolveChromePath } from "../mcp/qa-chrome.mjs";
import { LIVE_PING_INTERVAL_MS, LIVE_PONG_TIMEOUT_MS, LIVE_RECONNECT_MAX_MS, LIVE_WORKSPACE_ID_KEY } from "../src/live-control.js";

const root = fileURLToPath(new URL("..", import.meta.url));
const passed = [];
const pass = (message) => {
	passed.push(message);
	console.log(`PASS ${message}`);
};

const reservePort = () => new Promise((resolve, reject) => {
	const server = createServer();
	server.once("error", reject);
	server.listen(0, "127.0.0.1", () => {
		const address = server.address();
		if (!address || typeof address === "string") return reject(new Error("Could not reserve a TCP port."));
		server.close((error) => (error ? reject(error) : resolve(address.port)));
	});
});
const withTimeout = (promise, label, milliseconds = 30_000) => {
	let timer;
	return Promise.race([
		promise,
		new Promise((_, reject) => { timer = setTimeout(() => reject(new Error(`Timed out waiting for ${label}.`)), milliseconds); }),
	]).finally(() => clearTimeout(timer));
};
const waitForOutput = (child, pattern, label) => withTimeout(new Promise((resolve, reject) => {
	let output = "";
	const inspect = (chunk) => {
		// picocolors keeps colour on without a TTY under CI, and the port lands
		// inside the escapes, so strip ANSI before matching the ready banner.
		output += chunk.toString().replace(/\u001b\[[0-9;]*m/g, "");
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

/** Hub-side connection events, delivered in order and never dropped. */
function channel() {
	const queue = [];
	const waiters = [];
	return {
		push(value) {
			const waiter = waiters.shift();
			if (waiter) waiter(value); else queue.push(value);
		},
		next(label, milliseconds = 30_000) {
			if (queue.length > 0) return Promise.resolve(queue.shift());
			return withTimeout(new Promise((resolve) => waiters.push(resolve)), label, milliseconds);
		},
	};
}

function connectCdp(url) {
	const socket = new WebSocket(url);
	const pending = new Map();
	const listeners = new Set();
	let sequence = 0;
	socket.onmessage = ({ data }) => {
		const message = JSON.parse(data);
		if (!message.id) {
			for (const listener of [...listeners]) listener(message);
			return;
		}
		const request = pending.get(message.id);
		if (!request) return;
		pending.delete(message.id);
		clearTimeout(request.timer);
		if (message.error) request.reject(new Error(JSON.stringify(message.error))); else request.resolve(message.result);
	};
	const ready = new Promise((resolve, reject) => { socket.onopen = resolve; socket.onerror = reject; });
	const send = (method, params = {}) => new Promise((resolve, reject) => {
		sequence += 1;
		const id = sequence;
		const timer = setTimeout(() => { pending.delete(id); reject(new Error(`CDP timed out: ${method}`)); }, 40_000);
		pending.set(id, { resolve, reject, timer });
		socket.send(JSON.stringify({ id, method, params }));
	});
	// Resolves on the first matching CDP event; nothing here ever polls.
	const nextEvent = (method, matches, label, milliseconds) => withTimeout(new Promise((resolve) => {
		const listener = (message) => {
			if (message.method !== method || !matches(message.params)) return;
			listeners.delete(listener);
			resolve(message.params);
		};
		listeners.add(listener);
	}), label, milliseconds);
	return { send, ready, nextEvent, close: () => socket.close() };
}

const framePayload = (params) => {
	try {
		return JSON.parse(params.response?.payloadData ?? "");
	} catch {
		return null;
	}
};

const evaluate = async (page, expression) => {
	const result = await page.send("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true });
	if (result.exceptionDetails) throw new Error(result.exceptionDetails.exception?.description ?? result.exceptionDetails.text);
	return result.result?.value;
};
const readHandle = (page) => evaluate(page, `document.querySelector("[data-live-workspace]")?.dataset.liveWorkspace ?? ""`);
// Top-bar state is observed through a MutationObserver, never a poll or a
// sleep: the studio paints the handle when the workspace frame lands.
const waitForTopBar = (page, expected, label) => evaluate(page, `new Promise((resolve, reject) => {
	const expected = ${JSON.stringify(expected)};
	const read = () => document.querySelector("[data-live-workspace]")?.dataset.liveWorkspace ?? "";
	const finish = (settle, value) => { observer.disconnect(); clearTimeout(timer); settle(value); };
	const check = () => { if (read() === expected) finish(resolve, expected); };
	const observer = new MutationObserver(check);
	const timer = setTimeout(() => finish(reject, new Error(${JSON.stringify(label)} + ": top bar shows \\"" + read() + "\\", expected \\"" + expected + "\\"")), 25000);
	observer.observe(document.documentElement, { subtree: true, childList: true, attributes: true, characterData: true });
	check();
})`);

const vitePort = await reservePort();
const livePort = await reservePort();
const cdpPort = await reservePort();
const appUrl = `http://127.0.0.1:${vitePort}/app/`;
const connections = channel();
let rawConnections = 0;
const adopt = (hub) => {
	hub.server.on("connection", () => { rawConnections += 1; });
	hub.onWorkspaceConnected = ({ workspaceHandle, workspaceId }) => connections.push({ workspaceHandle, workspaceId, at: Date.now() });
	return hub;
};

const vite = spawn(process.execPath, ["node_modules/vite/bin/vite.js", "--host", "127.0.0.1", "--port", String(vitePort), "--strictPort"], {
	cwd: root, env: { ...process.env, COZYCLAY_LIVE_PORT: String(livePort) }, stdio: ["ignore", "pipe", "pipe"],
});
const browser = spawn(resolveChromePath(), chromeArgs(cdpPort), { stdio: ["ignore", "pipe", "pipe"] });
const startedHub = await startLiveHub(livePort);
assert.ok(startedHub, `QA must own live port ${livePort}; do not start dev-full alongside it`);
let hub = adopt(startedHub);
let page;
let duplicateTab;
try {
	await waitForOutput(vite, new RegExp(`http://127\\.0\\.0\\.1:${vitePort}/`), "Vite");
	await waitForOutput(browser, /DevTools listening on (ws:\/\/[^\s]+)/, "Chrome");
	const targets = await (await fetch(`http://127.0.0.1:${cdpPort}/json`)).json();
	const target = targets.find((entry) => entry.type === "page" && entry.webSocketDebuggerUrl);
	assert.ok(target, "Chrome did not expose a page target.");
	page = connectCdp(target.webSocketDebuggerUrl);
	await withTimeout(page.ready, "CDP connection");
	await page.send("Page.enable");
	await page.send("Runtime.enable");
	await page.send("Network.enable");

	// Given a studio opened against a live hub
	// When the workspace handshake completes
	// Then the top bar shows exactly the handle the hub issued.
	const firstConnected = connections.next("first editor connection");
	await page.send("Page.navigate", { url: appUrl });
	const first = await firstConnected;
	await waitForTopBar(page, first.workspaceHandle, "first connection");
	assert.equal(first.workspaceHandle, first.workspaceId, "the hub must issue this tab's own workspace id as its handle");
	pass(`studio connected as handle ${first.workspaceHandle} (its own workspace id)`);

	// Given a tab that reloads (the editor's most common disconnect)
	// When the studio reconnects
	// Then it comes back under the identity sessionStorage kept, not a new one.
	const reloadConnected = connections.next("reconnect after reload");
	await page.send("Page.reload", { ignoreCache: true });
	const reloaded = await reloadConnected;
	assert.equal(reloaded.workspaceId, first.workspaceId, "a reload must keep this tab's live identity");
	assert.equal(reloaded.workspaceHandle, first.workspaceHandle, "a reload must keep the visible handle");
	await waitForTopBar(page, first.workspaceHandle, "after reload");
	pass(`reload came back on the same handle ${reloaded.workspaceHandle}`);

	// Given a hub that dies and comes back on the same port
	// When the editor's backoff retries
	// Then it is connected again, as the same workspace, well inside the cap.
	const restartConnected = connections.next("reconnect after hub restart", 60_000);
	for (const client of hub.server.clients) client.terminate();
	await new Promise((resolve) => hub.server.close(resolve));
	await waitForTopBar(page, "", "hub down");
	pass("the top bar drops its stale handle while the hub is down");
	const restartedAt = Date.now();
	const restartedHub = await startLiveHub(livePort);
	assert.ok(restartedHub, "the hub could not retake its port");
	hub = adopt(restartedHub);
	const restarted = await restartConnected;
	const reconnectMs = restarted.at - restartedAt;
	assert.ok(reconnectMs < LIVE_RECONNECT_MAX_MS, `reconnect took ${reconnectMs} ms, over the ${LIVE_RECONNECT_MAX_MS} ms cap`);
	assert.equal(restarted.workspaceId, first.workspaceId, "a hub restart must not change this tab's live identity");
	assert.equal(restarted.workspaceHandle, first.workspaceHandle, "a hub restart must keep the visible handle");
	await waitForTopBar(page, first.workspaceHandle, "after hub restart");
	pass(`hub restart on port ${livePort} recovered in ${reconnectMs} ms on the same handle ${restarted.workspaceHandle}`);

	// Given a hub that advertises heartbeatMs in its workspace frame
	// When the editor's 20 s app-level ping goes out over the real socket
	// Then the hub answers it and the connection survives the round, so the
	// dead-hub detector never fires against a healthy hub.
	const pingBudget = LIVE_PING_INTERVAL_MS + LIVE_PONG_TIMEOUT_MS + 10_000;
	const pinged = page.nextEvent("Network.webSocketFrameSent", (params) => framePayload(params)?.type === "ping", "app-level ping", pingBudget);
	const ponged = page.nextEvent("Network.webSocketFrameReceived", (params) => framePayload(params)?.type === "pong", "hub pong", pingBudget);
	await pinged;
	await ponged;
	assert.equal(await readHandle(page), restarted.workspaceHandle, "an answered ping must leave the socket connected");
	assert.equal(hub.workspaceHandles.length, 1, `the answered ping must not have re-connected the editor: ${hub.workspaceHandles.join(", ")}`);
	pass(`the hub answered the editor's app-level ping and the socket stayed up as ${restarted.workspaceHandle}`);

	// Given a duplicated tab, which carries a copy of the original's
	// sessionStorage (seeded here exactly as Chrome's Duplicate tab does)
	// When the hub refuses the second socket as an already-connected id
	// Then that tab mints a new identity and both tabs end up connected.
	const created = await (await fetch(`http://127.0.0.1:${cdpPort}/json/new?url=about:blank`, { method: "PUT" })).json();
	assert.ok(created.webSocketDebuggerUrl, JSON.stringify(created));
	duplicateTab = connectCdp(created.webSocketDebuggerUrl);
	await withTimeout(duplicateTab.ready, "duplicate tab CDP connection");
	await duplicateTab.send("Page.enable");
	await duplicateTab.send("Runtime.enable");
	await duplicateTab.send("Page.addScriptToEvaluateOnNewDocument", {
		source: `try { sessionStorage.setItem(${JSON.stringify(LIVE_WORKSPACE_ID_KEY)}, ${JSON.stringify(first.workspaceId)}); } catch {}`,
	});
	const socketsBefore = rawConnections;
	const duplicateConnected = connections.next("duplicated tab connection");
	await duplicateTab.send("Page.navigate", { url: appUrl });
	const duplicate = await duplicateConnected;
	assert.notEqual(duplicate.workspaceId, first.workspaceId, "the duplicated tab must take a new identity");
	assert.ok(rawConnections - socketsBefore >= 2, `the duplicate must be refused once and retried (sockets: ${rawConnections - socketsBefore})`);
	await waitForTopBar(duplicateTab, duplicate.workspaceHandle, "duplicated tab");
	assert.notEqual(duplicate.workspaceHandle, restarted.workspaceHandle, "the two tabs must hold different handles");
	assert.equal(hub.workspaceHandles.length, 2, `both tabs must stay connected: ${hub.workspaceHandles.join(", ")}`);
	assert.equal(await readHandle(page), restarted.workspaceHandle, "the original tab must keep its handle");
	assert.equal(hub.workspaceId(restarted.workspaceHandle), first.workspaceId);
	pass(`duplicated tab took handle ${duplicate.workspaceHandle} (workspace id ${duplicate.workspaceId}) while the original stayed connected`);

	console.log(`QA_LIVE_RECONNECT PASS ${JSON.stringify({
		vitePort, livePort, reconnectMs, checks: passed.length,
		identities: { original: first.workspaceId, duplicate: duplicate.workspaceId },
		handles: { first: first.workspaceHandle, reloaded: reloaded.workspaceHandle, restarted: restarted.workspaceHandle, duplicate: duplicate.workspaceHandle },
	})}`);
} finally {
	page?.close();
	duplicateTab?.close();
	hub?.server?.close();
	await Promise.all([terminate(browser), terminate(vite)]);
}

#!/usr/bin/env node
import assert from "node:assert/strict";
import { execFile, fork } from "node:child_process";
import { once } from "node:events";
import { createServer as createHttpServer } from "node:http";
import { createConnection, createServer } from "node:net";
import { promisify } from "node:util";
import { spawnOwned, terminateOwned } from "../../tools/process-supervisor.mjs";

const execFileAsync = promisify(execFile);
const REPO = new URL("../..", import.meta.url);
const BRIDGE = "tools/ardy/bridge.mjs";
// Child readiness is event-driven; this timeout is only a deadlock bound.
// A loaded CI host can take more than five seconds to start a fresh Node/Vite
// pair even though no product timer is involved.
const READY_TIMEOUT_MS = 15_000;

function withTimeout(promise, label) {
	let timer;
	return Promise.race([
		promise,
		new Promise((_, reject) => {
			timer = setTimeout(() => reject(new Error(`${label} did not happen within ${READY_TIMEOUT_MS} ms`)), READY_TIMEOUT_MS);
		}),
	]).finally(() => clearTimeout(timer));
}

function listen(server, port = 0) {
	return new Promise((resolvePromise, reject) => {
		server.once("error", reject);
		server.listen(port, "127.0.0.1", () => {
			server.off("error", reject);
			resolvePromise(server.address().port);
		});
	});
}

function close(server) {
	return new Promise((resolvePromise, reject) => server.close((error) => (error ? reject(error) : resolvePromise())));
}

function waitForExit(child, label) {
	return withTimeout(once(child, "exit"), label);
}

async function listenerPids(port) {
	try {
		const { stdout } = await execFileAsync("lsof", ["-t", "-nP", `-iTCP:${port}`, "-sTCP:LISTEN"]);
		return stdout
			.trim()
			.split("\n")
			.filter(Boolean)
			.map(Number);
	} catch (error) {
		if (error.code === 1) return [];
		throw error;
	}
}

function canConnect(port) {
	return new Promise((resolvePromise) => {
		const socket = createConnection({ host: "127.0.0.1", port });
		socket.once("connect", () => {
			socket.destroy();
			resolvePromise(true);
		});
		socket.once("error", () => {
			socket.destroy();
			resolvePromise(false);
		});
	});
}

async function assertPortReleased(port, message) {
	const probe = createServer();
	try {
		await new Promise((resolvePromise, reject) => {
			probe.once("error", reject);
			probe.listen(port, "127.0.0.1", resolvePromise);
		});
	} catch (error) {
		assert.fail(`${message}: ${error.code ?? error.message}`);
	} finally {
		if (probe.listening) await close(probe);
	}
}

async function listenerPidsAfterConnect(port) {
	for (let attempt = 0; attempt < 20; attempt += 1) {
		const pids = await listenerPids(port);
		if (pids.length) return pids;
		await new Promise((resolvePromise) => setImmediate(resolvePromise));
	}
	return [];
}

async function reserveMainAndAdjacentPort() {
	for (;;) {
		const main = createServer();
		const mainPort = await listen(main);
		if (mainPort >= 65_534) {
			await close(main);
			continue;
		}
		const adjacent = createServer();
		try {
			await listen(adjacent, mainPort + 1);
			await close(main);
			return { mainPort, adjacent };
		} catch {
			await close(main);
		}
	}
}

function createOutputWatcher(child) {
	let output = "";
	const waiters = [];
	const append = (chunk) => {
		output += chunk.toString();
		for (const waiter of waiters.splice(0)) waiter();
	};
	child.stdout.on("data", append);
	child.stderr.on("data", append);
	return {
		all: () => output,
		waitFor(pattern, label) {
			return withTimeout(
				new Promise((resolvePromise) => {
					const check = () => {
						const match = pattern.exec(output);
						if (match) resolvePromise(match);
						else waiters.push(check);
					};
					check();
				}),
				label,
			).catch((error) => {
				throw new Error(`${error.message}\n${output}`);
			});
		},
	};
}

function launcherSpec(kind, port, env) {
	if (kind === "dev") {
		return {
			args: ["tools/dev-full.mjs", "--host", "127.0.0.1", "--port", String(port)],
			env: { CCLAY_MOTION_BACKEND: "kimodo", CCLAY_KIMODO_HOST: "test@kimodo", ...env },
		};
	}
	return {
		args: ["bin/cozyclay.mjs", "--host", "127.0.0.1", "--port", String(port), "--no-open", "--no-star"],
		env: { CCLAY_MOTION_BACKEND: "kimodo", ...env, CCLAY_KIMODO_HOST: "test@kimodo" },
	};
}

function launch(kind, port, env = {}) {
	const spec = launcherSpec(kind, port, { ...process.env, ...env });
	const child = spawnOwned(process.execPath, spec.args, {
		cwd: REPO,
		env: spec.env,
		stdio: ["ignore", "pipe", "pipe"],
	});
	return { child, output: createOutputWatcher(child) };
}

function launchPackageNoMotion(port) {
	const env = { ...process.env, CCLAY_MOTION_BACKEND: "kimodo" };
	delete env.CCLAY_KIMODO_HOST;
	delete env.COZYCLAY_BRIDGE_PORT;
	delete env.COZYCLAY_BRIDGE_URL;
	const child = spawnOwned(
		process.execPath,
		["bin/cozyclay.mjs", "--host", "127.0.0.1", "--port", String(port), "--no-open", "--no-star", "--no-motion"],
		{ cwd: REPO, env, stdio: ["ignore", "pipe", "pipe"] },
	);
	return { child, output: createOutputWatcher(child) };
}

async function expectNoMotionDoesNotProxyForeignBridge() {
	const foreign = createHttpServer((_req, res) => {
		res.writeHead(200, { "content-type": "application/json" });
		res.end(JSON.stringify({ foreign: true }));
	});
	let foreignListening = false;
	try {
		try {
			await listen(foreign, 5181);
			foreignListening = true;
		} catch (error) {
			if (error?.code !== "EADDRINUSE") throw error;
		}
		const reservation = createServer();
		const port = await listen(reservation);
		await close(reservation);
		const { child, output } = launchPackageNoMotion(port);
		try {
			await output.waitFor(/CozyClay is running at http:\/\/127\.0\.0\.1:(\d+)\/app\//, "package no-motion server readiness");
			const response = await fetch(`http://127.0.0.1:${port}/ardy/health`);
			const body = await response.text();
			assert.equal(response.status, 503, "no-motion /ardy routes return unavailable instead of proxying");
			assert.match(body, /motion sidecar is not running/, "no-motion response identifies the unavailable sidecar");
		} finally {
			await terminateOwned(child);
		}
	} finally {
		if (foreignListening) await close(foreign);
	}
}

async function expectViteProxyRequiresExplicitBridge() {
	const script = "import config from './vite.config.js'; console.log(JSON.stringify(config.server?.proxy?.['/ardy']?.target ?? null));";
	const withoutBridge = { ...process.env };
	delete withoutBridge.COZYCLAY_BRIDGE_PORT;
	delete withoutBridge.COZYCLAY_BRIDGE_URL;
	const none = await execFileAsync(process.execPath, ["--input-type=module", "-e", script], { cwd: REPO, env: withoutBridge });
	assert.equal(JSON.parse(none.stdout.trim()), null, "Vite UI-only mode does not proxy to a default bridge port");
	const explicit = await execFileAsync(process.execPath, ["--input-type=module", "-e", script], {
		cwd: REPO,
		env: { ...withoutBridge, COZYCLAY_BRIDGE_PORT: "61234" },
	});
	assert.equal(JSON.parse(explicit.stdout.trim()), "http://127.0.0.1:61234", "Vite preserves an explicit dev-full bridge endpoint");
}

async function expectLaunchFailure(kind, env, expected) {
	const reservation = createServer();
	const port = await listen(reservation);
	await close(reservation);
	const { child, output } = launch(kind, port, env);
	await waitForExit(child, `${kind} invalid bridge launch`);
	assert.match(output.all(), expected, `${kind} reports the bridge-port failure clearly`);
}

{
	const invalidHost = spawnOwned(process.execPath, ["bin/cozyclay.mjs", "--host", "0.0.0.0", "--no-open", "--no-star"], {
		cwd: REPO,
		stdio: ["ignore", "pipe", "pipe"],
	});
	const output = createOutputWatcher(invalidHost);
	const [code] = await waitForExit(invalidHost, "package non-loopback host rejection");
	assert.notEqual(code, 0, "package rejects non-loopback host with a failure exit code");
	assert.match(output.all(), /--host is restricted to 127\.0\.0\.1/, "package names the loopback-only restriction");
}

async function expectBridgeIpcReadiness() {
	const reservation = createServer();
	const port = await listen(reservation);
	await close(reservation);
	const child = fork(BRIDGE, [], {
		cwd: REPO,
		env: { ...process.env, CCLAY_MOTION_BACKEND: "kimodo", CCLAY_KIMODO_HOST: "test@kimodo", COZYCLAY_BRIDGE_PORT: String(port) },
		stdio: ["ignore", "ignore", "ignore", "ipc"],
		detached: true,
	});
	try {
		const [message] = await withTimeout(once(child, "message"), "bridge child readiness IPC");
		assert.deepEqual(message, { type: "cozyclay-bridge-ready", port }, "bridge identifies itself through IPC after listen");
	} finally {
		await terminateOwned(child);
	}
}

async function expectForeignListenerDoesNotReportBridgeReady() {
	const foreign = createServer();
	const port = await listen(foreign);
	const child = fork(BRIDGE, [], {
		cwd: REPO,
		env: { ...process.env, CCLAY_MOTION_BACKEND: "kimodo", CCLAY_KIMODO_HOST: "test@kimodo", COZYCLAY_BRIDGE_PORT: String(port) },
		stdio: ["ignore", "ignore", "ignore", "ipc"],
		detached: true,
	});
	try {
		const [message] = await withTimeout(once(child, "message"), "bridge child listen-failure IPC");
		assert.deepEqual(
			message,
			{ type: "cozyclay-bridge-listen-error", port, code: "EADDRINUSE" },
			"a foreign listener cannot satisfy bridge readiness",
		);
		await waitForExit(child, "bridge child after listen failure");
	} finally {
		await terminateOwned(child);
		await close(foreign);
	}
}

async function expectLifecycle(kind) {
	const { mainPort, adjacent } = await reserveMainAndAdjacentPort();
	const bridgeReservation = createServer();
	const bridgePort = await listen(bridgeReservation, mainPort + 2);
	await close(bridgeReservation);
	const { child, output } = launch(kind, mainPort);
	try {
		const ready = await output.waitFor(/motion dev bridge listening on http:\/\/127\.0\.0\.1:(\d+)/, `${kind} bridge readiness`);
		assert.equal(Number(ready[1]), bridgePort, `${kind} skips occupied main + 1`);
		assert.equal(await canConnect(bridgePort), true, `${kind} accepts TCP after readiness`);
		const bridgePids = await listenerPidsAfterConnect(bridgePort);
		assert.equal(bridgePids.length, 1, `${kind} bridge owns the selected port`);

		const [bridgePid] = bridgePids;
		assert.ok(bridgePid, `${kind} bridge is listening before unexpected exit`);
		const parentExit = waitForExit(child, `${kind} parent after bridge exit`);
		process.kill(bridgePid, "SIGTERM");
		const [code, signal] = await parentExit;
		assert.ok(code !== 0 || signal, `${kind} parent fails when its bridge exits unexpectedly`);
		await assertPortReleased(bridgePort, `${kind} unexpected bridge exit releases its port`);
	} finally {
		await terminateOwned(child);
		await close(adjacent);
	}

	const clean = await reserveMainAndAdjacentPort();
	const cleanupReservation = createServer();
	const cleanupPort = await listen(cleanupReservation, clean.mainPort + 2);
	await close(cleanupReservation);
	const next = launch(kind, clean.mainPort);
	try {
		const ready = await next.output.waitFor(/motion dev bridge listening on http:\/\/127\.0\.0\.1:(\d+)/, `${kind} cleanup bridge readiness`);
		assert.equal(Number(ready[1]), cleanupPort, `${kind} uses the expected cleanup bridge port`);
		await terminateOwned(next.child);
		await assertPortReleased(cleanupPort, `${kind} parent termination releases its bridge port`);
	} finally {
		await terminateOwned(next.child);
		await close(clean.adjacent);
	}
}

// Poll until the studio answers on `port`, or the child dies first.
async function waitForStudio(port, child) {
	for (;;) {
		if (child.exitCode !== null) throw new Error(`dev exited with code ${child.exitCode} before serving the studio`);
		try {
			const res = await fetch(`http://127.0.0.1:${port}/app/`);
			await res.arrayBuffer();
			return res;
		} catch {
			await new Promise((resolve) => setTimeout(resolve, 200));
		}
	}
}

// A fresh clone has no CCLAY_KIMODO_HOST, and that must not be a startup
// failure: `npm run dev` then serves the studio without motion generation, the
// way `npx cozyclay` and `npm run dev:ui` already do. The sidecar refuses to
// run without a box to talk to, so launching it anyway killed the studio over
// a variable a first-time contributor has no reason to have set.
async function expectDevStartsWithoutKimodoHost() {
	const reservation = createServer();
	const port = await listen(reservation);
	await close(reservation);
	const env = { ...process.env };
	delete env.CCLAY_KIMODO_HOST;
	const child = spawnOwned(process.execPath, ["tools/dev-full.mjs", "--host", "127.0.0.1", "--port", String(port)], {
		cwd: REPO,
		env,
		stdio: ["ignore", "pipe", "pipe"],
	});
	const output = createOutputWatcher(child);
	try {
		await output.waitFor(
			/CCLAY_KIMODO_HOST is not set .* without motion generation/,
			"dev names the missing Kimodo host without failing",
		);
		// Vite's banner is coloured on a CI runner and plain in a local pipe, so
		// readiness is the studio answering, not a line of output.
		const res = await withTimeout(waitForStudio(port, child), "dev studio response without a bridge");
		assert.equal(res.status, 200, "dev serves the studio without a bridge");
		assert.equal(child.exitCode, null, "dev stays up without a Kimodo host");
		assert.doesNotMatch(output.all(), /motion dev bridge listening/, "dev starts no bridge without a Kimodo host");
	} finally {
		await terminateOwned(child);
	}
}

await expectBridgeIpcReadiness();
await expectForeignListenerDoesNotReportBridgeReady();
await expectDevStartsWithoutKimodoHost();
await expectNoMotionDoesNotProxyForeignBridge();
await expectViteProxyRequiresExplicitBridge();
{
	const invalidMainPort = spawnOwned(process.execPath, ["bin/cozyclay.mjs", "--port", "65535", "--no-open", "--no-star"], {
		cwd: REPO,
		stdio: ["ignore", "pipe", "pipe"],
	});
	const output = createOutputWatcher(invalidMainPort);
	const [code] = await waitForExit(invalidMainPort, "package invalid main port");
	assert.notEqual(code, 0, "package rejects an invalid main port with a failure exit code");
	assert.match(output.all(), /--port must be an integer in 1\.\.65534/, "package validates a main port that leaves room for its bridge");
}
for (const kind of ["dev", "package"]) {
	await expectLaunchFailure(kind, { COZYCLAY_BRIDGE_PORT: "invalid" }, /COZYCLAY_BRIDGE_PORT=.*not a valid port/);
	const occupied = createServer();
	const port = await listen(occupied);
	try {
		await expectLaunchFailure(kind, { COZYCLAY_BRIDGE_PORT: String(port) }, /COZYCLAY_BRIDGE_PORT=.*already in use/);
	} finally {
		await close(occupied);
	}
	await expectLifecycle(kind);
}

console.log("all bridge launch checks PASS");

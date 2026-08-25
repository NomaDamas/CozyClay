#!/usr/bin/env node
/** The dev launcher, Vite build, and browser client share one loopback live port. */
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createServer } from "node:net";
import { fileURLToPath } from "node:url";
import { liveControlUrl } from "../src/live-control.js";

const root = fileURLToPath(new URL("..", import.meta.url));

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

const waitForOutput = (child, pattern, label, milliseconds) => {
	let output = "";
	return withTimeout(
		new Promise((resolve, reject) => {
			const inspect = (chunk) => {
				output += chunk.toString();
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
		milliseconds,
	).catch((error) => {
		// A bare timeout hides what the child actually said; name it.
		error.message += output ? `\nchild output:\n${output}` : "\n(child produced no output)";
		throw error;
	});
};

const terminate = async (child) => {
	if (child.exitCode !== null || child.signalCode !== null) return;
	const exited = new Promise((resolve) => child.once("exit", resolve));
	process.kill(-child.pid, "SIGTERM");
	await withTimeout(exited, "dev-full cleanup").catch(() => process.kill(-child.pid, "SIGKILL"));
};

const vitePort = await reservePort();
const livePort = await reservePort();
const child = spawn(process.execPath, ["tools/dev-full.mjs", "--host", "127.0.0.1", "--port", String(vitePort)], {
	cwd: root,
	detached: true,
	env: {
		...process.env,
		CCLAY_ARDY_MODE: "remote",
		CCLAY_ARDY_HOST: "test@ardy",
		COZYCLAY_LIVE_PORT: String(livePort),
	},
	stdio: ["ignore", "pipe", "pipe"],
});
try {
	// A cold Vite start on a CI runner optimizes dependencies first and can
	// take well past 30s; ci.yml's own dev-server step allows 120s for the
	// same boot.
	await waitForOutput(child, new RegExp(`http://127\\.0\\.0\\.1:${vitePort}/`), "dev-full Vite startup", 120_000);
	const source = await (await fetch(`http://127.0.0.1:${vitePort}/src/live-control.js`)).text();
	assert.match(source, new RegExp(`\"VITE_COZYCLAY_LIVE_PORT\": \"${livePort}\"`));
	assert.equal(liveControlUrl(String(livePort)), `ws://127.0.0.1:${livePort}/live`);
	assert.match(source, /ws:\/\/127\.0\.0\.1:/);
} finally {
	await terminate(child);
}

assert.equal(liveControlUrl(), "ws://127.0.0.1:5184/live");
console.log("configured live port contract passed");

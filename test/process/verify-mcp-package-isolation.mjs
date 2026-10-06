import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { once } from "node:events";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, watch } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";

const repo = new URL("../..", import.meta.url).pathname;
const packageVersion = JSON.parse(readFileSync(join(repo, "package.json"), "utf8")).version;
const scratch = mkdtempSync(join(tmpdir(), "cozyclay-mcp-package-"));
const npm = process.platform === "win32" ? "npm.cmd" : "npm";
const initialize = JSON.stringify({
	jsonrpc: "2.0",
	id: 1,
	method: "initialize",
	params: { protocolVersion: "2025-11-25", capabilities: {}, clientInfo: { name: "cozyclay-package-test", version: "1.0.0" } },
});

function run(command, args, options = {}) {
	const result = spawnSync(command, args, { encoding: "utf8", ...options });
	assert.equal(result.error, undefined, `${command} could not start: ${result.error?.message}`);
	return result;
}

function sha256(file) {
	return createHash("sha256").update(readFileSync(file)).digest("hex");
}

function reservePort() {
	return new Promise((resolvePort, reject) => {
		const server = createServer();
		server.once("error", reject);
		server.listen(0, "127.0.0.1", () => {
			const { port } = server.address();
			server.close(() => resolvePort(port));
		});
	});
}

/** Resolves once `<port>.json` appears in the live directory. Armed before the
 * launcher starts, bounded so a hub that never comes up fails the test. */
function endpointPublished(liveDirectory, port, timeout = 60_000) {
	mkdirSync(liveDirectory, { recursive: true });
	const file = `${port}.json`;
	return new Promise((resolvePublished, reject) => {
		const timer = setTimeout(() => { watcher.close(); reject(new Error(`live endpoint ${file} was not published`)); }, timeout);
		const watcher = watch(liveDirectory, (event, name) => {
			if (name === file && existsSync(join(liveDirectory, file))) { clearTimeout(timer); watcher.close(); resolvePublished(); }
		});
	});
}

/** The packed Studio launcher, stopped as a process group once the caller is
 * done with it; stdout and stderr are collected for the assertions. */
function startStudio(args, options) {
	const child = spawn(process.execPath, ["bin/cozyclay.mjs", ...args], {
		...options,
		detached: process.platform !== "win32",
		stdio: ["ignore", "pipe", "pipe"],
	});
	let stdout = "";
	let stderr = "";
	child.stdout.setEncoding("utf8");
	child.stderr.setEncoding("utf8");
	child.stdout.on("data", (chunk) => { stdout += chunk; });
	child.stderr.on("data", (chunk) => { stderr += chunk; });
	const stop = async () => {
		if (child.exitCode !== null) return;
		if (process.platform === "win32") {
			const taskkill = spawn("taskkill", ["/pid", String(child.pid), "/t", "/f"], { stdio: "ignore" });
			await once(taskkill, "exit");
		} else {
			process.kill(-child.pid, "SIGTERM");
		}
		await once(child, "close");
	};
	return { child, stop, output: () => ({ stdout, stderr }) };
}

function runMcp(command, args, options = {}) {
	return new Promise((resolvePromise, reject) => {
		const child = spawn(command, args, {
			...options,
			detached: process.platform !== "win32",
			stdio: ["pipe", "pipe", "pipe"],
		});
		let stdout = "";
		let stderr = "";
		let settled = false;
		let responseSeen = false;
		child.stdout.setEncoding("utf8");
		child.stderr.setEncoding("utf8");
		const finish = (result) => {
			if (settled) return;
			settled = true;
			resolvePromise(result);
		};
		const stopOwnedTree = async () => {
			if (child.exitCode !== null) return;
			if (process.platform === "win32") {
				const taskkill = spawn("taskkill", ["/pid", String(child.pid), "/t", "/f"], { stdio: "ignore" });
				await once(taskkill, "exit");
			} else {
				process.kill(-child.pid, "SIGTERM");
			}
		};
		child.stdout.on("data", async (chunk) => {
			stdout += chunk;
			if (responseSeen || !stdout.includes("\n")) return;
			responseSeen = true;
			await stopOwnedTree();
		});
		child.stderr.on("data", (chunk) => { stderr += chunk; });
		child.once("error", reject);
		child.once("close", (status, signal) => finish({
			status: responseSeen ? 0 : status,
			signal,
			stdout,
			stderr,
		}));
		child.stdin.end(`${initialize}\n`);
		delay(options.timeout ?? 120_000, undefined, { ref: false }).then(async () => {
			if (settled) return;
			await stopOwnedTree();
			reject(new Error(`Timed out waiting for packaged MCP response: ${stderr}`));
		});
	});
}

try {
	const packed = run(npm, ["pack", "--ignore-scripts", "--pack-destination", scratch], { cwd: repo });
	assert.equal(packed.status, 0, packed.stderr);
	const archive = join(scratch, packed.stdout.trim().split("\n").at(-1));
	const unpacked = run("tar", ["-xzf", archive, "-C", scratch]);
	assert.equal(unpacked.status, 0, unpacked.stderr);

	const packageRoot = join(scratch, "package");
	const rootManifest = join(packageRoot, "package.json");
	const rootLock = join(packageRoot, "package-lock.json");
	const manifestBefore = readFileSync(rootManifest);
	const manifestHashBefore = sha256(rootManifest);
	const cache = join(scratch, "npm-cache");
	const runtimeHome = join(scratch, "home");
	const environment = { ...process.env, HOME: runtimeHome, npm_config_cache: cache };

	const first = await runMcp(process.execPath, ["bin/cozyclay.mjs", "mcp"], {
		cwd: packageRoot,
		env: environment,
		timeout: 120_000,
	});
	assert.equal(first.status, 0, first.stderr);
	const initialized = JSON.parse(first.stdout.trim());
	assert.equal(initialized.id, 1, first.stdout);
	assert.equal(initialized.result.serverInfo.name, "cozyclay-mcp", first.stdout);
	assert.deepEqual(readFileSync(rootManifest), manifestBefore, "MCP install must not rewrite the published root manifest");
	assert.equal(sha256(rootManifest), manifestHashBefore, "MCP install must preserve the published root manifest hash");
	assert.equal(existsSync(rootLock), false, "MCP install must not create a root lockfile");
	assert.match(first.stderr, /installing MCP server dependencies/, first.stderr);
	const runtimeRoot = join(runtimeHome, ".cache", "cozyclay", "mcp-runtime", packageVersion);
	assert.equal(existsSync(join(runtimeRoot, "bin", "agent", "motion-runtime.mjs")), true, "isolated MCP runtime must include the motion runtime import");
	assert.equal(existsSync(join(runtimeRoot, "tools", "ardy", "bridge.mjs")), true, "isolated MCP runtime must include the motion bridge");
	assert.equal(existsSync(join(runtimeRoot, "dist", "models", "x-bot-tpose.fbx")), true, "isolated MCP runtime must include the bridge's FBX rigs");

	const second = await runMcp(process.execPath, ["bin/cozyclay.mjs", "mcp"], {
		cwd: packageRoot,
		env: environment,
		timeout: 30_000,
	});
	assert.equal(second.status, 0, second.stderr);
	assert.equal(JSON.parse(second.stdout.trim()).id, 1, second.stdout);
	assert.doesNotMatch(second.stderr, /installing MCP server dependencies/, second.stderr);

	// The Studio in the same package reaches its live hub through the runtime
	// `cclay mcp` just cached: the pane's tools and hub come from that staged
	// tree, so the hub publishes its endpoint instead of leaving the editor
	// "MCP offline" (#576).
	{
		const configHome = join(scratch, "studio-config");
		const liveDirectory = join(configHome, "cozyclay", "live");
		const [studioPort, hubPort] = await Promise.all([reservePort(), reservePort()]);
		const published = endpointPublished(liveDirectory, hubPort);
		const studio = startStudio(["--port", String(studioPort), "--no-open", "--no-motion", "--no-star", "--no-update-check"], {
			cwd: packageRoot,
			env: { ...environment, CI: "", XDG_CONFIG_HOME: configHome, COZYCLAY_LIVE_PORT: String(hubPort) },
		});
		try {
			await published;
			const endpoint = JSON.parse(readFileSync(join(liveDirectory, `${hubPort}.json`), "utf8"));
			assert.equal(endpoint.owner, "cozyclay", "the packaged Studio publishes its own hub");
			assert.equal(endpoint.pid, studio.child.pid, "the endpoint belongs to the launcher under test");
		} finally {
			await studio.stop();
		}
		const { stderr: studioStderr } = studio.output();
		assert.doesNotMatch(studioStderr, /Studio live tools unavailable/, studioStderr);
		assert.doesNotMatch(studioStderr, /installing MCP server dependencies/, "the Studio reuses the runtime cclay mcp installed");
		assert.deepEqual(readFileSync(rootManifest), manifestBefore, "the Studio launch must not rewrite the published root manifest");
	}

	// The packaged launcher's motion bridge imports three, which only the staged
	// runtime resolves. Offline there is no Kimodo box, so the strongest true
	// check is: the sidecar reports ready, the proxied health route answers, and
	// the launcher is still running afterwards instead of exiting.
	{
		const studioPort = await reservePort();
		const studio = startStudio(["--port", String(studioPort), "--no-open", "--no-star", "--no-update-check"], {
			cwd: packageRoot,
			env: { ...environment, CI: "", XDG_CONFIG_HOME: join(scratch, "motion-config"), COZYCLAY_LIVE_PORT: String(await reservePort()), CCLAY_KIMODO_HOST: "qa@127.0.0.1" },
		});
		try {
			await new Promise((resolveReady, reject) => {
				const timer = setTimeout(() => reject(new Error(`motion sidecar did not start: ${JSON.stringify(studio.output())}`)), 60_000);
				const onData = () => {
					if (!/Motion generation: sidecar running against qa@127\.0\.0\.1/.test(studio.output().stdout)) return;
					clearTimeout(timer);
					studio.child.off("exit", onExit);
					resolveReady();
				};
				const onExit = (code) => { clearTimeout(timer); reject(new Error(`launcher exited with ${code}: ${JSON.stringify(studio.output())}`)); };
				studio.child.stdout.on("data", onData);
				studio.child.once("exit", onExit);
				onData();
			});
			const health = await fetch(`http://127.0.0.1:${studioPort}/ardy/health`);
			assert.ok([200, 503].includes(health.status), `unexpected /ardy/health status ${health.status}`);
			await health.json();
			assert.equal(studio.child.exitCode, null, "the launcher keeps running with the motion bridge");
		} finally {
			await studio.stop();
		}
		const { stdout: motionStdout, stderr: motionStderr } = studio.output();
		assert.match(motionStdout, new RegExp(`CozyClay is running at http://127\\.0\\.0\\.1:${studioPort}/app/`), motionStdout);
		assert.doesNotMatch(motionStderr, /ERR_MODULE_NOT_FOUND|studio did not start/, motionStderr);
	}

	const concurrentHome = join(scratch, "concurrent-home");
	const concurrentEnv = {
		...environment,
		HOME: concurrentHome,
		npm_config_cache: join(scratch, "concurrent-cache"),
	};
	const concurrent = await Promise.all([
		runMcp(process.execPath, ["bin/cozyclay.mjs", "mcp"], { cwd: packageRoot, env: concurrentEnv }),
		runMcp(process.execPath, ["bin/cozyclay.mjs", "mcp"], { cwd: packageRoot, env: concurrentEnv }),
	]);
	for (const result of concurrent) {
		assert.equal(result.status, 0, result.stderr);
		assert.equal(JSON.parse(result.stdout.trim()).id, 1, result.stdout);
	}
	assert.deepEqual(readFileSync(rootManifest), manifestBefore, "concurrent MCP installs must not rewrite the root manifest");
	assert.equal(existsSync(rootLock), false, "concurrent MCP installs must not create a root lockfile");

	const failure = await runMcp(process.execPath, ["bin/cozyclay.mjs", "mcp"], {
		cwd: packageRoot,
		env: { ...environment, HOME: join(scratch, "offline-home"), npm_config_cache: join(scratch, "offline-cache"), npm_config_offline: "true" },
		timeout: 30_000,
	});
	assert.notEqual(failure.status, 0, failure.stderr);
	assert.match(failure.stderr, /npm ci failed.*Check your network connection and retry/i, failure.stderr);
	assert.equal(failure.stdout, "", "install diagnostics must never enter the MCP JSON-RPC stream");

	console.log("MCP packed-package isolation PASS");
} finally {
	rmSync(scratch, { recursive: true, force: true });
}

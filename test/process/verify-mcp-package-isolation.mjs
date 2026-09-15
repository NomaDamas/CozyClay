import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { once } from "node:events";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";

const repo = new URL("../..", import.meta.url).pathname;
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
	assert.equal(existsSync(join(runtimeHome, ".cache", "cozyclay", "mcp-runtime", "1.8.1", "bin", "agent", "motion-runtime.mjs")), true, "isolated MCP runtime must include the motion runtime import");

	const second = await runMcp(process.execPath, ["bin/cozyclay.mjs", "mcp"], {
		cwd: packageRoot,
		env: environment,
		timeout: 30_000,
	});
	assert.equal(second.status, 0, second.stderr);
	assert.equal(JSON.parse(second.stdout.trim()).id, 1, second.stdout);
	assert.doesNotMatch(second.stderr, /installing MCP server dependencies/, second.stderr);

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

/**
 * The one-click global update behind POST /__cozyclay/update.
 *
 * Two questions live here: may this launcher update itself at all
 * (canSelfUpdate), and what happened when it tried (an in-memory install
 * state the Studio polls). Nothing a request carries ever reaches npm: the
 * only argument that varies is a version that has passed an exact x.y.z test.
 */
import { execFile, spawn } from "node:child_process";
import { constants, accessSync, realpathSync } from "node:fs";
import { join } from "node:path";

const VERSION = /^\d+\.\d+\.\d+$/;
const ROOT_TIMEOUT_MS = 2000;
const INSTALL_TIMEOUT_MS = 5 * 60 * 1000;
const STDERR_CAP = 64 * 1024;

const ERROR_CODES = [
	["node_version", ["EBADENGINE"]],
	["permission", ["EACCES", "EPERM"]],
	["network", ["ENOTFOUND", "ETIMEDOUT", "ECONNREFUSED", "ECONNRESET", "EAI_AGAIN"]],
];

// COZYCLAY_NPM_BIN lets a test put a fake npm in front of both calls; win32
// keeps npm.cmd the way runUpdate spawns it.
function npmBinary(platform = process.platform) {
	return process.env.COZYCLAY_NPM_BIN || (platform === "win32" ? "npm.cmd" : "npm");
}

function npmRootGlobal(npmBin, platform) {
	return new Promise((resolve) => {
		execFile(npmBin, ["root", "-g"], { timeout: ROOT_TIMEOUT_MS, shell: platform === "win32", encoding: "utf8" }, (error, stdout) => {
			resolve(error ? null : String(stdout).trim() || null);
		});
	});
}

const selfUpdateCache = new Map();

/**
 * True only when all three hold: not Windows (U1 scope), this package's real
 * path is `<npm root -g>/cozyclay`, and that folder and its parent are
 * writable. Any doubt answers false, which falls back to a copied command.
 * Computed once per (pkgRoot, platform, npm) and kept in memory.
 */
export function canSelfUpdate({ pkgRoot, platform = process.platform, npmBin = npmBinary(platform) }) {
	const key = JSON.stringify([pkgRoot, platform, npmBin]);
	if (!selfUpdateCache.has(key)) selfUpdateCache.set(key, computeSelfUpdate(pkgRoot, platform, npmBin));
	return selfUpdateCache.get(key);
}

async function computeSelfUpdate(pkgRoot, platform, npmBin) {
	if (platform === "win32") return false;
	const root = await npmRootGlobal(npmBin, platform);
	if (!root) return false;
	try {
		const installed = realpathSync(join(root, "cozyclay"));
		if (realpathSync(pkgRoot) !== installed) return false;
		// npm swaps the folder, so the parent has to take writes as well.
		accessSync(installed, constants.W_OK);
		accessSync(realpathSync(root), constants.W_OK);
		return true;
	} catch {
		return false;
	}
}

function classOf(code) {
	return ERROR_CODES.find(([, codes]) => codes.includes(code))?.[0] ?? null;
}

/**
 * permission | network | node_version | npm_missing | other, from npm's
 * stderr and the spawn error (if any). The `npm error code X` line wins;
 * otherwise the first known code anywhere in the text decides.
 */
export function classifyNpmError(stderr = "", spawnError = null) {
	if (spawnError?.code === "ENOENT") return "npm_missing";
	const text = String(stderr ?? "");
	const lineCode = /npm (?:error|ERR!) code (\S+)/.exec(text)?.[1];
	if (lineCode && classOf(lineCode)) return classOf(lineCode);
	if (/Not compatible with your version of node/i.test(text)) return "node_version";
	for (const token of text.match(/\bE[A-Z_]{2,}\b/g) ?? []) {
		if (classOf(token)) return classOf(token);
	}
	return classOf(spawnError?.code) ?? "other";
}

/**
 * The launcher's install state: { phase, errorClass, startedAt, durationMs }.
 * startInstall is the lock: while a run is updating or has finished and waits
 * for a restart, it starts nothing and returns false.
 */
export function createInstaller({ timeoutMs = INSTALL_TIMEOUT_MS } = {}) {
	const state = { phase: "idle", errorClass: null, startedAt: null, durationMs: null };
	let timer = null;
	function finish(phase, errorClass) {
		if (state.phase !== "updating") return;
		clearTimeout(timer);
		Object.assign(state, { phase, errorClass, durationMs: Date.now() - state.startedAt });
	}
	function startInstall(version) {
		if (!VERSION.test(String(version))) throw new TypeError("cozyclay: refusing to install a version that is not x.y.z");
		if (state.phase === "updating" || state.phase === "restart_needed") return false;
		Object.assign(state, { phase: "updating", errorClass: null, startedAt: Date.now(), durationMs: null });
		const platform = process.platform;
		let child;
		try {
			child = spawn(npmBinary(platform), ["install", "-g", `cozyclay@${version}`, "--engine-strict"], {
				stdio: ["ignore", "pipe", "pipe"],
				shell: platform === "win32",
			});
		} catch (error) {
			finish("failed", classifyNpmError("", error));
			return true;
		}
		let stderr = "";
		child.stdout.resume();
		child.stderr.setEncoding("utf8");
		child.stderr.on("data", (chunk) => {
			if (stderr.length < STDERR_CAP) stderr += chunk.slice(0, STDERR_CAP - stderr.length);
		});
		timer = setTimeout(() => {
			child.kill("SIGTERM");
			finish("failed", "other");
		}, timeoutMs);
		timer.unref?.();
		child.on("error", (error) => finish("failed", classifyNpmError(stderr, error)));
		child.on("close", (code, signal) => {
			if (code === 0 && !signal) finish("restart_needed", null);
			else finish("failed", classifyNpmError(stderr));
		});
		return true;
	}
	return { startInstall, getState: () => ({ ...state }) };
}

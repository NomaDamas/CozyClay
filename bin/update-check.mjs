/**
 * The "a newer version exists" line, and the command that acts on it.
 *
 * Two rules keep this from becoming the thing people disable: it never blocks
 * the launch (fire it, print later, drop it on any error) and it never talks
 * unless there is actually something newer. No dependencies, same as the
 * launcher it serves.
 */
import { spawn } from "node:child_process";
import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const REGISTRY_URL = "https://registry.npmjs.org/cozyclay/latest";
const FETCH_TIMEOUT_MS = 2000;
const CACHE_TTL_MS = 24 * 60 * 60 * 1000;

// Numeric dotted compare, prereleases lose to their own release. Enough to
// answer "is the registry ahead of us"; anything more is a semver dependency.
export function compareVersions(a, b) {
	const parse = (v) => {
		const s = String(v).trim();
		const i = s.indexOf("-");
		// split("-", 2) would *drop* everything after the second hyphen, so
		// "1.4.0-next-rc" would compare as "next". Keep the whole tag.
		const core = i === -1 ? s : s.slice(0, i);
		const pre = i === -1 ? "" : s.slice(i + 1);
		return { parts: core.split(".").map((n) => Number.parseInt(n, 10) || 0), pre };
	};
	const left = parse(a);
	const right = parse(b);
	for (let i = 0; i < Math.max(left.parts.length, right.parts.length); i += 1) {
		const diff = (left.parts[i] ?? 0) - (right.parts[i] ?? 0);
		if (diff !== 0) return diff < 0 ? -1 : 1;
	}
	if (left.pre === right.pre) return 0;
	if (!left.pre) return 1;
	if (!right.pre) return -1;
	// Prerelease tags are dot-separated identifiers; numeric ones order
	// numerically, or beta.10 would look older than beta.2.
	const lp = left.pre.split(".");
	const rp = right.pre.split(".");
	for (let i = 0; i < Math.max(lp.length, rp.length); i += 1) {
		const x = lp[i];
		const y = rp[i];
		if (x === undefined) return -1;
		if (y === undefined) return 1;
		if (/^\d+$/.test(x) && /^\d+$/.test(y)) {
			const diff = Number(x) - Number(y);
			if (diff !== 0) return diff < 0 ? -1 : 1;
		} else if (x !== y) return x < y ? -1 : 1;
	}
	return 0;
}

// A registry answer whose cache write failed (a read-only home), by cache file.
// The write is best effort, so a good fetch must not depend on it.
const fetchedInProcess = new Map();

// The newer of the cache file and this process's own last fetch.
function readCache(cacheFile) {
	let disk = null;
	try {
		disk = JSON.parse(readFileSync(cacheFile, "utf8"));
	} catch {
		/* missing or unreadable: the in-process answer, if any, stands */
	}
	const memory = fetchedInProcess.get(cacheFile) ?? null;
	if (!disk) return memory;
	return memory && !(memory.checkedAt <= disk.checkedAt) ? memory : disk;
}

function writeCache(cacheFile, cacheDir, latest) {
	const entry = { latest, checkedAt: Date.now() };
	try {
		mkdirSync(cacheDir, { recursive: true });
		writeFileSync(cacheFile, JSON.stringify(entry, null, "\t"));
		fetchedInProcess.delete(cacheFile);
	} catch {
		// A read-only home is not a reason to fail a local dev server, nor to forget the answer.
		fetchedInProcess.set(cacheFile, entry);
	}
}

// Returns null on any failure rather than throwing: a network error must not
// unwind past the cache fallback in checkForUpdate.
async function fetchLatest() {
	let body;
	try {
		const res = await fetch(process.env.COZYCLAY_REGISTRY_URL || REGISTRY_URL, {
			headers: { accept: "application/json" },
			signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
		});
		if (!res.ok) return null;
		body = await res.json();
	} catch {
		return null;
	}
	if (typeof body?.version !== "string") return null;
	// COZYCLAY_REGISTRY_URL can point anywhere, and a junk string parses as
	// zeros further down, which reads as a downgrade. Only trust x.y.z.
	const version = body.version.trim().replace(/^v/, "");
	return /^\d+\.\d+\.\d+/.test(version) ? version : null;
}

/**
 * Resolves to the newer version string, or null. Never rejects: offline,
 * proxied, rate-limited and "npm is down" all mean "say nothing".
 */
export async function checkForUpdate(currentVersion, stateDir) {
	try {
		const cacheFile = join(stateDir, "update-check.json");
		const cached = readCache(cacheFile);
		let latest = cached?.latest ?? null;
		const age = Date.now() - cached?.checkedAt;
		// A future checkedAt (clock skew, edited cache) would otherwise look
		// fresh forever, and the check would never run again.
		const fresh = Number.isFinite(age) && age >= 0 && age <= CACHE_TTL_MS;
		if (!fresh) {
			const fetched = await fetchLatest();
			// A dead registry must not erase a known-good cached version, or the
			// notice silently stops working offline once the TTL lapses.
			if (fetched) {
				latest = fetched;
				writeCache(cacheFile, stateDir, fetched);
			}
		}
		if (!latest) return null;
		return compareVersions(latest, currentVersion) > 0 ? latest : null;
	} catch {
		return null;
	}
}

/**
 * "latest", "outdated" or "unknown" for the running version, read from the
 * cache checkForUpdate keeps. Synchronous and offline: the studio page asks on
 * every load, and a launch whose first check has not landed yet is "unknown".
 */
export function readUpdateStatus(currentVersion, stateDir) {
	try {
		const latest = readCache(join(stateDir, "update-check.json"))?.latest;
		if (typeof latest !== "string" || !/^\d+\.\d+\.\d+/.test(latest)) return "unknown";
		return compareVersions(latest, currentVersion) > 0 ? "outdated" : "latest";
	} catch {
		return "unknown";
	}
}

// The launcher's state file, shared with telemetry and the star prompt.
const stateFileOf = (stateDir) => join(stateDir, "state.json");

// A missing file is {}; a corrupt one is null, so nothing overwrites it.
function readStateFile(stateFile) {
	try {
		const parsed = JSON.parse(readFileSync(stateFile, "utf8"));
		return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : null;
	} catch (error) {
		return error?.code === "ENOENT" ? {} : null;
	}
}

// `--no-update-check`, COZYCLAY_NO_UPDATE_CHECK, CI and `cclay update --off`
// (updateNotice: false in the state file) each turn the launch line, the
// Studio chip and the one-click install off.
export function updateChecksOn(flag, env = process.env, stateDir = null) {
	if (!flag || env.CI || env.COZYCLAY_NO_UPDATE_CHECK) return false;
	return !stateDir || readStateFile(stateFileOf(stateDir))?.updateNotice !== false;
}

// `cclay update --off|--on`: keeps every other key, writes atomically, and
// says what changed and how to undo it. A corrupt or unwritable file is exit 1.
function setUpdateNotice(stateDir, on) {
	const stateFile = stateFileOf(stateDir);
	const state = readStateFile(stateFile);
	try {
		if (!state) throw new Error(`${stateFile} is not valid JSON`);
		mkdirSync(stateDir, { recursive: true });
		const temporary = `${stateFile}.${process.pid}.tmp`;
		writeFileSync(temporary, JSON.stringify({ ...state, updateNotice: on }, null, "\t"), { mode: 0o600 });
		renameSync(temporary, stateFile);
	} catch (error) {
		console.error(`cozyclay: could not save the update setting: ${error.message}`);
		return 1;
	}
	console.log(on
		? "Update notices are on: the launch line and the Studio chip are back. Undo with `cclay update --off`."
		: "Update notices are off: no launch line, no Studio chip. Undo with `cclay update --on`.");
	return 0;
}

/**
 * The registry's latest x.y.z with this launch's status: the shape behind
 * GET /__cozyclay/update and `cclay update --check`. The cache rules are
 * checkForUpdate's; `fresh` asks the registry even inside the TTL, and a dead
 * registry still falls back to the cached answer.
 */
export async function lookupLatest(currentVersion, stateDir, { fresh = false } = {}) {
	const cacheFile = join(stateDir, "update-check.json");
	if (fresh) {
		const fetched = await fetchLatest();
		if (fetched) writeCache(cacheFile, stateDir, fetched);
	} else {
		await checkForUpdate(currentVersion, stateDir);
	}
	const latest = readCache(cacheFile)?.latest;
	const known = typeof latest === "string" && /^\d+\.\d+\.\d+/.test(latest);
	return { latest: known ? latest : null, status: readUpdateStatus(currentVersion, stateDir) };
}

/**
 * `cclay update --check`: print, install nothing, and exit 0 when this is the
 * newest release, 10 when a newer one exists, 11 when the registry could not
 * answer and nothing is cached. Scripts and agents branch on the code.
 */
async function runUpdateCheck({ currentVersion, kind, stateDir }) {
	const { latest, status } = await lookupLatest(currentVersion, stateDir, { fresh: true });
	console.log(`current: ${currentVersion}\nlatest: ${latest ?? "unknown"}\nkind: ${kind}\nstatus: ${status}`);
	return { latest: 0, outdated: 10 }[status] ?? 11;
}

// npx/bunx runs from a temp dir, so there is no local install to upgrade in
// place; `npm install -g` is the one command that is right either way.
function runUpdate() {
	const npm = process.platform === "win32" ? "npm.cmd" : "npm";
	const child = spawn(npm, ["install", "-g", "cozyclay@latest", "--engine-strict"], { stdio: "inherit", shell: process.platform === "win32" });
	child.on("error", (err) => {
		console.error(`cozyclay: could not run npm: ${err.message}`);
		process.exit(1);
	});
	child.on("exit", (code, signal) => {
		if (signal || code !== 0) {
			process.exit(code ?? 1);
			return;
		}
		// Report what is on disk now, not what the registry says: those differ
		// the moment a publish lands mid-update.
		const installed = spawn(npm, ["ls", "-g", "--depth=0", "--json", "cozyclay"], {
			stdio: ["ignore", "pipe", "ignore"],
			shell: process.platform === "win32",
		});
		let out = "";
		installed.stdout.on("data", (chunk) => {
			out += chunk;
		});
		installed.on("error", () => process.exit(0));
		installed.on("exit", () => {
			let version = "";
			try {
				version = JSON.parse(out)?.dependencies?.cozyclay?.version ?? "";
			} catch {
				/* an unparseable `npm ls` only costs us the version in the message */
			}
			console.log(version ? `cozyclay ${version} installed.` : "cozyclay updated.");
			process.exit(0);
		});
	});
}

const UPDATE_FLAGS = new Set(["--check", "--off", "--on"]);

/**
 * `cclay update [--check|--off|--on]`. Resolves to the exit code, or null
 * while the bare install runs (it exits on its own). Anything else, including
 * two flags, is refused: `cclay update --help` must not install.
 */
export async function runUpdateCommand(args, { currentVersion, kind, stateDir }) {
	if (args.length > 1 || (args.length === 1 && !UPDATE_FLAGS.has(args[0]))) {
		console.error(`cozyclay: update takes at most one of --check, --off or --on (got ${args.join(" ")})`);
		return 1;
	}
	if (args[0] === "--check") return runUpdateCheck({ currentVersion, kind, stateDir });
	if (args[0]) return setUpdateNotice(stateDir, args[0] === "--on");
	runUpdate();
	return null;
}

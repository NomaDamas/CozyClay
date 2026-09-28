/**
 * The "a newer version exists" line, and the command that acts on it.
 *
 * Two rules keep this from becoming the thing people disable: it never blocks
 * the launch (fire it, print later, drop it on any error) and it never talks
 * unless there is actually something newer. No dependencies, same as the
 * launcher it serves.
 */
import { spawn } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
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

function readCache(cacheFile) {
	try {
		return JSON.parse(readFileSync(cacheFile, "utf8"));
	} catch {
		return null;
	}
}

function writeCache(cacheFile, cacheDir, latest) {
	try {
		mkdirSync(cacheDir, { recursive: true });
		writeFileSync(cacheFile, JSON.stringify({ latest, checkedAt: Date.now() }, null, "\t"));
	} catch {
		/* a read-only home is not a reason to fail a local dev server */
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

// npx/bunx runs from a temp dir, so there is no local install to upgrade in
// place; `npm install -g` is the one command that is right either way.
export function runUpdate() {
	const npm = process.platform === "win32" ? "npm.cmd" : "npm";
	const child = spawn(npm, ["install", "-g", "cozyclay@latest"], { stdio: "inherit", shell: process.platform === "win32" });
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

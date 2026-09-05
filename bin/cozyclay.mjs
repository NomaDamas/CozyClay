#!/usr/bin/env node
/**
 * cozyclay - run the studio from a published package.
 *
 * `npx cozyclay` / `bunx cozyclay` should behave like `npm run dev` does in a
 * clone: the studio in a browser, with the optional motion sidecar wired up.
 * The difference is that nothing is built here. The package ships the built
 * `dist/`, so this launcher only has to
 *
 *   - serve those files over loopback,
 *   - forward /ardy to its dynamically selected sidecar port (the same job Vite's dev proxy does),
 *   - keep the sidecar's lifetime tied to this process.
 *
 * It has no dependencies on purpose. A launcher that needs an install step
 * before it can serve a prebuilt app is a launcher that will break.
 */
import { spawn } from "node:child_process";
import { startBridge, terminateOwned } from "../tools/process-supervisor.mjs";
import { createReadStream, existsSync, mkdirSync, readFileSync, renameSync, statSync, writeFileSync } from "node:fs";
import { createServer, request as httpRequest } from "node:http";
import { homedir } from "node:os";
import { extname, join, normalize, resolve } from "node:path";
import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";
import { runMcp } from "./mcp-runtime.mjs";
import { openBrowser } from "./open-browser.mjs";
import { checkForUpdate, runUpdate } from "./update-check.mjs";
import { verifyPackageMarker } from "./package-signature.mjs";
import {
	markTelemetryNoticeShown,
	markTelemetryFirstLaunch,
	setTelemetryFirstLaunchSource,
	effectiveTelemetryEnabled,
	readTelemetryState,
	setTelemetryEnabled,
	takeRuntimeTelemetryConfig,
	TELEMETRY_NOTICE_VERSION,
} from "./telemetry-state.mjs";

const PKG_ROOT = resolve(fileURLToPath(new URL("..", import.meta.url)));
const SOURCE_CHECKOUT = existsSync(join(PKG_ROOT, ".git"));
let packageMetadata = {};
try {
	packageMetadata = JSON.parse(readFileSync(join(PKG_ROOT, "package.json"), "utf8"));
} catch {
	// An unreadable package is handled by the existing missing-build checks.
}
const DIST = join(PKG_ROOT, "dist");
const BRIDGE = join(PKG_ROOT, "tools", "ardy", "bridge.mjs");
const OFFICIAL_PACKAGE = (
	packageMetadata.name === "cozyclay"
	&& !SOURCE_CHECKOUT
	&& verifyPackageMarker(join(DIST, "cozyclay-package.json"), PKG_ROOT, packageMetadata)
);
const INSTALL_KIND = process.env.npm_config_global === "true"
	|| (PKG_ROOT.includes("/node_modules/") && !PKG_ROOT.includes("/_npx/"))
	? "global"
	: "npx";
// A bridge is optional. Keep the endpoint unset until this launcher owns a
// sidecar; otherwise /ardy requests could accidentally reach an unrelated
// process that happens to be listening on the bridge's historical default
// port (5181).
let bridge = null;
let bridgePort = null;

const TYPES = {
	".html": "text/html; charset=utf-8",
	".js": "text/javascript; charset=utf-8",
	".mjs": "text/javascript; charset=utf-8",
	".css": "text/css; charset=utf-8",
	".json": "application/json; charset=utf-8",
	".wasm": "application/wasm",
	".woff2": "font/woff2",
	".fbx": "application/octet-stream",
	".npz": "application/octet-stream",
	".png": "image/png",
	".jpg": "image/jpeg",
	".gif": "image/gif",
	".svg": "image/svg+xml",
	".ico": "image/x-icon",
};

function parseArgs(argv) {
	const opts = { port: 5180, host: "127.0.0.1", motion: true, open: true, star: true, updateCheck: true };
	for (let i = 0; i < argv.length; i += 1) {
		const arg = argv[i];
		if (arg === "--port" || arg === "-p") opts.port = Number(argv[++i]);
		else if (arg.startsWith("--port=")) opts.port = Number(arg.slice(7));
		else if (arg === "--host") opts.host = String(argv[++i]);
		else if (arg.startsWith("--host=")) opts.host = arg.slice(7);
		else if (arg === "--no-motion") opts.motion = false;
		else if (arg === "--no-open") opts.open = false;
		else if (arg === "--no-star") opts.star = false;
		else if (arg === "--no-update-check") opts.updateCheck = false;
		else if (arg === "--help" || arg === "-h") opts.help = true;
		else if (arg === "--version" || arg === "-v") opts.version = true;
		else {
			console.error(`cozyclay: unknown option ${arg}`);
			opts.help = true;
			opts.invalid = true;
		}
	}
	if (!Number.isInteger(opts.port) || opts.port < 1 || opts.port > 65534) {
		console.error("cozyclay: --port must be an integer in 1..65534");
		opts.help = true;
		opts.invalid = true;
	}
	if (opts.host !== "127.0.0.1") {
		console.error("cozyclay: --host is restricted to 127.0.0.1");
		opts.help = true;
		opts.invalid = true;
	}
	return opts;
}

const REPO_URL = "https://github.com/NomaDamas/CozyClay";
const STATE_DIR = join(process.env.XDG_CONFIG_HOME || join(homedir(), ".config"), "cozyclay");
const STATE_FILE = join(STATE_DIR, "state.json");
// Only worth asking someone who actually used the thing. A prompt three
// seconds in is a popup; a prompt after a real session is a question.
const STAR_AFTER_MS = Number(process.env.COZYCLAY_STAR_AFTER_MS ?? 60_000);

async function askFirstLaunchSource() {
	if (!process.stdin.isTTY || !process.stdout.isTTY) return null;
	const answer = await new Promise((resolve) => {
		const rl = createInterface({ input: process.stdin, output: process.stdout });
		rl.question("How did you hear about CozyClay? [x/hn/reddit/github/friend/other/skip] ", (value) => {
			rl.close();
			resolve(value.trim().toLowerCase());
		});
	});
	return ["x", "hn", "reddit", "github", "friend", "other"].includes(answer) ? answer : null;
}

const HELP = `cozyclay - browser-based 3D staging studio

  npx cozyclay              start the studio and open it
  npx cozyclay mcp          run the MCP server (for Claude, Cursor, any MCP client)
  cclay update              install the latest cozyclay globally (npm install -g)
  npx cozyclay --port 5200  serve on another port
  npx cozyclay --no-motion  skip the optional motion-generation sidecar
  npx cozyclay --no-open    do not open a browser
  npx cozyclay --no-star    never ask about starring the repo
  npx cozyclay --no-update-check
                            do not look for a newer release
  cclay telemetry status   show anonymous telemetry status
  cclay telemetry off      disable anonymous telemetry
  cclay telemetry on       enable anonymous telemetry

cclay is the same command, shorter: a global install gives you both.

Motion generation needs an SSH-reachable NVIDIA machine running Kimodo; point
the sidecar at it with CCLAY_KIMODO_HOST. Everything else - staging, posing,
paths, cameras, timeline, playback - runs locally with no extra setup.`;

function serveFile(res, path) {
	const type = TYPES[extname(path).toLowerCase()] ?? "application/octet-stream";
	res.writeHead(200, {
		"content-type": type,
		"content-length": statSync(path).size,
		// The studio is served from a local process a user just started; a
		// stale cache across versions is more confusing than a re-read.
		"cache-control": "no-cache",
	});
	createReadStream(path).pipe(res);
}

// Forward /ardy to the sidecar. Same contract as the Vite dev proxy, so the
// browser code needs no build-time knowledge of how it was launched.
function proxyToBridge(req, res) {
	if (!bridge || bridgePort === null || bridge.exitCode !== null || bridge.signalCode !== null) {
		req.resume();
		res.writeHead(503, { "content-type": "application/json; charset=utf-8" });
		res.end(JSON.stringify({ error: "motion sidecar is not running" }));
		return;
	}
	const upstream = httpRequest(
		{ host: "127.0.0.1", port: bridgePort, path: req.url, method: req.method, headers: req.headers },
		(upstreamRes) => {
			res.writeHead(upstreamRes.statusCode ?? 502, upstreamRes.headers);
			upstreamRes.pipe(res);
		},
	);
	upstream.on("error", () => {
		// An absent sidecar is an expected state, not a crash: the app treats a
		// failed probe as "generation unavailable" and carries on.
		res.writeHead(503, { "content-type": "application/json" });
		res.end(JSON.stringify({ error: "motion sidecar is not running" }));
	});
	req.pipe(upstream);
}

function readState() {
	try {
		return JSON.parse(readFileSync(STATE_FILE, "utf8"));
	} catch {
		return {};
	}
}

function writeState(patch) {
	try {
		mkdirSync(STATE_DIR, { recursive: true });
		const temporary = `${STATE_FILE}.${process.pid}.tmp`;
		writeFileSync(temporary, JSON.stringify({ ...readState(), ...patch }, null, "\t"), { mode: 0o600 });
		renameSync(temporary, STATE_FILE);
	} catch {
		/* a read-only home is not a reason to fail a local dev server */
	}
}

async function starCount() {
	try {
		const res = await fetch("https://api.github.com/repos/NomaDamas/CozyClay", {
			headers: { accept: "application/vnd.github+json" },
			signal: AbortSignal.timeout(2500),
		});
		if (!res.ok) return null;
		const body = await res.json();
		return Number.isInteger(body?.stargazers_count) ? body.stargazers_count : null;
	} catch {
		return null;
	}
}

// Asked once, on the way out, and never again on this machine. A CLI that
// nags on every run is worse than one that never asks.
async function maybeAskForStar(startedAt, opts) {
	if (!opts.star) return;
	if (process.env.CI || process.env.COZYCLAY_NO_STAR) return;
	if (!process.stdin.isTTY || !process.stdout.isTTY) return;
	if (Date.now() - startedAt < STAR_AFTER_MS) return;
	if (readState().starPromptedAt) return;

	writeState({ starPromptedAt: new Date().toISOString() });
	const stars = await starCount();
	const tally = stars === null ? "" : ` (${stars} so far)`;
	const rl = createInterface({ input: process.stdin, output: process.stdout });
	const answer = await new Promise((done) => {
		const timer = setTimeout(() => done(""), 12_000);
		rl.question(`\nWas CozyClay any good? A star helps people find it${tally}. Open GitHub? [Y/n] `, (a) => {
			clearTimeout(timer);
			done(a);
		});
	});
	rl.close();
	if (/^(y|yes|)$/i.test(answer.trim())) {
		openBrowser(REPO_URL);
		console.log("Thanks. Opening the repo.");
	} else {
		console.log(`Fair enough. ${REPO_URL} if you change your mind.`);
	}
}

// Read on every launch now, so it must not be able to take the launcher down:
// the version is cosmetic here, and "0.0.0" just suppresses a bogus notice.
function readVersion() {
	return typeof packageMetadata.version === "string" ? packageMetadata.version : "0.0.0";
}

const argv = process.argv.slice(2);
if (argv[0] === "mcp") {
	await runMcp(argv.slice(1));
} else if (argv[0] === "update") {
	// This branch bypasses parseArgs, so anything trailing would be swallowed
	// and `cclay update --help` would perform an unrequested global install.
	if (argv.length > 1) {
		console.error(`cozyclay: update takes no arguments (got ${argv.slice(1).join(" ")})`);
		process.exit(1);
	}
	runUpdate();
} else if (argv[0] === "telemetry") {
	const action = argv[1] ?? "status";
	if (argv.length > 2 || !["status", "on", "off"].includes(action)) {
		console.error("cozyclay: telemetry accepts status, on, or off");
		process.exit(1);
	}
	if (action === "on") setTelemetryEnabled(STATE_FILE, true);
	if (action === "off") setTelemetryEnabled(STATE_FILE, false);
	const state = readTelemetryState(STATE_FILE);
	const effective = OFFICIAL_PACKAGE && effectiveTelemetryEnabled(state);
	const reason = !OFFICIAL_PACKAGE
		? ` (${SOURCE_CHECKOUT ? "source checkout" : "unofficial package: digest mismatch"})`
		: state.telemetryEnabled && !effective
			? " (environment override)"
			: "";
	console.log(`Telemetry: ${effective ? "on" : "off"}${reason}`);
	if (action !== "status") console.log("Reload any open CozyClay studio tab to apply this setting.");
} else {

const opts = parseArgs(argv);
if (opts.help) {
	console.log(HELP);
	process.exit(opts.invalid ? 1 : 0);
}
const version = readVersion();
if (opts.version) {
	console.log(version);
	process.exit(0);
}
let runtimeTelemetry = takeRuntimeTelemetryConfig(STATE_FILE, {
	appVersion: version,
	officialPackage: OFFICIAL_PACKAGE,
	installKind: INSTALL_KIND,
});
if (runtimeTelemetry.firstLaunch && !readTelemetryState(STATE_FILE).firstLaunchHeardFrom) {
	const heardFrom = await askFirstLaunchSource();
	if (heardFrom) {
		setTelemetryFirstLaunchSource(STATE_FILE, heardFrom);
	runtimeTelemetry = takeRuntimeTelemetryConfig(STATE_FILE, {
		appVersion: version,
		officialPackage: OFFICIAL_PACKAGE,
		installKind: INSTALL_KIND,
	});
	}
}
const telemetryState = readTelemetryState(STATE_FILE);
if (
	runtimeTelemetry.telemetryEnabled
	&& telemetryState.noticeVersion < TELEMETRY_NOTICE_VERSION
) {
	console.log(
		"Anonymous usage metrics are on (no prompts, project content, filenames, or account information).\n" +
			"Disable anytime: cclay telemetry off",
	);
	markTelemetryNoticeShown(STATE_FILE);
}
// Fired before anything blocking and never awaited on the launch path: the
// notice is worth a line of output, never a second of startup.
const updatePending = opts.updateCheck && !process.env.CI && !process.env.COZYCLAY_NO_UPDATE_CHECK ? checkForUpdate(version, STATE_DIR) : null;
if (!existsSync(join(DIST, "app", "index.html"))) {
	console.error("cozyclay: this package is missing its build (dist/app/index.html).");
	console.error("cozyclay: from a clone, run `npm install && npm run build` first.");
	process.exit(1);
}

// The sidecar exits immediately without a box to talk to, so starting it
// unconditionally would greet a first-time `npx cozyclay` with an error it
// cannot act on. An unset CCLAY_KIMODO_HOST is the normal case, not a fault.
const kimodoHost = process.env.CCLAY_KIMODO_HOST?.trim();
let server = null;
const startedAt = Date.now();
let shuttingDown = false;
async function shutdown(exitCode = 0) {
	if (shuttingDown) return;
	shuttingDown = true;
	if (bridge) await terminateOwned(bridge);
	if (server?.listening) await new Promise((resolvePromise) => server.close(() => resolvePromise()));
	try {
		await maybeAskForStar(startedAt, opts);
	} catch {
		/* never let the goodbye prompt hold the process hostage */
	}
	process.exit(exitCode);
}
process.on("SIGINT", () => shutdown(130));
process.on("SIGTERM", () => shutdown(143));

if (opts.motion && kimodoHost && existsSync(BRIDGE)) {
	try {
		({ child: bridge, port: bridgePort } = await startBridge({
			command: process.execPath,
			args: [BRIDGE],
			cwd: PKG_ROOT,
			env: process.env,
			mainPort: opts.port,
			onSpawn: (child) => {
				bridge = child;
			},
			onReady: (child) => {
				child.once("exit", (code, signal) => {
					if (shuttingDown) return;
					console.error(`cozyclay: motion generation sidecar exited ${signal ? `from ${signal}` : `with code ${code ?? 0}`}.`);
					void shutdown(1);
				});
				child.once("error", (err) => {
					if (shuttingDown) return;
					console.error(`cozyclay: motion generation sidecar failed: ${err.message}`);
					void shutdown(1);
				});
			},
		}));
	} catch (err) {
		console.error(`cozyclay: motion generation sidecar failed: ${err.message}`);
		console.error("cozyclay: studio did not start; set COZYCLAY_BRIDGE_PORT to an available port or use --no-motion.");
		if (bridge) await terminateOwned(bridge);
		process.exit(1);
	}
}

server = createServer((req, res) => {
	const url = new URL(req.url ?? "/", "http://localhost");
	if (url.pathname === "/__cozyclay/telemetry") {
		if (req.method === "POST") {
			const origin = req.headers.origin;
			const expectedOrigin = `http://127.0.0.1:${opts.port}`;
			if (origin !== expectedOrigin) {
				res.writeHead(403, { "content-type": "application/json; charset=utf-8" });
				res.end(JSON.stringify({ error: "forbidden origin" }));
				return;
			}
			let body = "";
			req.setEncoding("utf8");
			req.on("data", (chunk) => {
				body += chunk;
				if (body.length > 1024) req.destroy();
			});
			req.on("end", () => {
				try {
					const value = JSON.parse(body);
					if (typeof value.enabled !== "boolean") throw new TypeError("enabled must be boolean");
					setTelemetryEnabled(STATE_FILE, value.enabled);
					runtimeTelemetry = takeRuntimeTelemetryConfig(STATE_FILE, {
						appVersion: version,
						officialPackage: OFFICIAL_PACKAGE,
						installKind: INSTALL_KIND,
					});
					res.writeHead(200, {
						"content-type": "application/json; charset=utf-8",
						"cache-control": "no-store",
					});
					res.end(JSON.stringify(runtimeTelemetry));
				} catch {
					res.writeHead(400, { "content-type": "application/json; charset=utf-8" });
					res.end(JSON.stringify({ error: "invalid telemetry setting" }));
				}
			});
			return;
		}
		res.writeHead(405, { allow: "POST", "content-type": "application/json; charset=utf-8" });
		res.end(JSON.stringify({ error: "method not allowed" }));
		return;
	}
	// Only the routes the bridge actually owns: /ardy/ is ALSO a public asset
	// directory (cskel27-rest.json), and those files live in dist/, not behind
	// the sidecar. Same rule as the Vite dev proxy bypass.
	if (/^\/ardy\/(health|bases|generate|footage|extract|motions)(\/|$)/.test(url.pathname)) {
		proxyToBridge(req, res);
		return;
	}
	let rel;
	try {
		rel = decodeURIComponent(url.pathname);
	} catch {
		res.writeHead(400, { "content-type": "text/plain; charset=utf-8" });
		res.end("invalid URL encoding");
		return;
	}
	// normalize + prefix check: a request must not escape dist/.
	let target = join(DIST, normalize(rel));
	if (!target.startsWith(DIST)) {
		res.writeHead(404, { "content-type": "text/plain; charset=utf-8" });
		res.end("not found");
		return;
	}
	// The build is multi-page: "/" is the landing and "/app/" is the studio, so a
	// directory has to resolve to its index the way a static host would. Without
	// this the studio 404s and the CLI only ever serves the landing page.
	if (existsSync(target) && statSync(target).isDirectory()) {
		target = join(target, "index.html");
	}
	if (!existsSync(target) || statSync(target).isDirectory()) {
		res.writeHead(404, { "content-type": "text/plain; charset=utf-8" });
		res.end("not found");
		return;
	}
	if (target === join(DIST, "app", "index.html")) {
		runtimeTelemetry = takeRuntimeTelemetryConfig(STATE_FILE, {
			appVersion: version,
			officialPackage: OFFICIAL_PACKAGE,
			installKind: INSTALL_KIND,
		});
		const runtime = runtimeTelemetry;
		if (runtime.firstLaunch) {
			markTelemetryFirstLaunch(STATE_FILE);
		}
		// __COZYCLAY_LIVE__ opts the production build into the loopback live
		// socket (src/App.jsx gates on DEV || this flag); without it an
		// npx-served studio can never attach to the MCP server's live hub.
		const script = `<script>window.__COZYCLAY_RUNTIME__ = ${JSON.stringify(runtime).replaceAll("<", "\\u003c")}; window.__COZYCLAY_LIVE__ = true;</script>`;
		const html = readFileSync(target, "utf8").replace("</head>", `${script}\n</head>`);
		res.writeHead(200, {
			"content-type": "text/html; charset=utf-8",
			"content-length": Buffer.byteLength(html),
			"cache-control": "no-store",
		});
		res.end(html);
		return;
	}
	serveFile(res, target);
});

server.on("error", (err) => {
	if (err && err.code === "EADDRINUSE") {
		console.error(`cozyclay: port ${opts.port} is taken. Try --port 5200.`);
		void shutdown(1);
		return;
	}
	throw err;
});

server.listen({ port: opts.port, host: "127.0.0.1", ipv6Only: false }, () => {
	// The package exists to open the studio, which the site serves from /app/.
	// Landing on "/" would greet someone who just typed `npx cozyclay` with a
	// marketing page.
	const url = `http://127.0.0.1:${opts.port}/app/`;
	console.log(`CozyClay is running at ${url}`);
	console.log("Use a Chromium-based browser — Safari and Firefox are not supported.");
	if (!opts.motion) console.log("Motion generation: off (--no-motion).");
	else if (bridge) console.log(`Motion generation: sidecar running against ${kimodoHost}.`);
	else
		console.log(
			"Motion generation: off. It runs on an SSH-reachable NVIDIA machine with Kimodo;\n" +
				"set CCLAY_KIMODO_HOST=user@host to turn it on. Everything else works without it.",
		);
	if (opts.open) openBrowser(url);
	void updatePending?.then((latest) => {
		// `cclay` only exists after a global install, so name the command that
		// works from an npx run too.
		if (latest) console.log(`cozyclay ${latest} is available (you have ${version}). Run: npm install -g cozyclay@latest`);
	});
});

}

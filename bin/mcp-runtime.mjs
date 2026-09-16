import { spawn } from "node:child_process";
import { copyFileSync, cpSync, existsSync, mkdirSync, mkdtempSync, renameSync, rmSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";

const PKG_ROOT = resolve(fileURLToPath(new URL("..", import.meta.url)));
const PACKAGE_VERSION = JSON.parse(await import("node:fs/promises").then((fs) => fs.readFile(join(PKG_ROOT, "package.json"), "utf8"))).version;
const MCP_RUNTIME_SOURCE = join(PKG_ROOT, "mcp", "runtime");
const MCP_RUNTIME = process.env.COZYCLAY_MCP_RUNTIME_DIR || join(
	process.env.XDG_CACHE_HOME || process.env.LOCALAPPDATA || join(homedir(), ".cache"),
	"cozyclay",
	"mcp-runtime",
	PACKAGE_VERSION,
);

function probeMcpRuntime(runtime = MCP_RUNTIME) {
	const server = join(runtime, "mcp", "server.mjs");
	if (!existsSync(server)) throw new Error("MCP server is missing");
	const runtimeRequire = createRequire(join(runtime, "package.json"));
	for (const dependency of ["@modelcontextprotocol/sdk/server/mcp.js", "three", "ws", "zod"]) runtimeRequire.resolve(dependency);
	return server;
}

function installMcpRuntime() {
	return new Promise((done) => {
		const parent = dirname(MCP_RUNTIME);
		mkdirSync(parent, { recursive: true });
		try {
			probeMcpRuntime();
			done({ code: 0 });
			return;
		} catch {
			// A killed older install can leave an incomplete final directory.
			// Only complete stagings are ever renamed here, so an invalid final
			// cache is safe to discard before this attempt begins.
			rmSync(MCP_RUNTIME, { recursive: true, force: true });
		}
		const staging = mkdtempSync(join(parent, `${basename(MCP_RUNTIME)}.install-`));
		copyFileSync(join(MCP_RUNTIME_SOURCE, "package.json"), join(staging, "package.json"));
		copyFileSync(join(MCP_RUNTIME_SOURCE, "package-lock.json"), join(staging, "package-lock.json"));
		cpSync(join(PKG_ROOT, "mcp"), join(staging, "mcp"), { recursive: true });
		mkdirSync(join(staging, "bin", "agent"), { recursive: true });
		copyFileSync(join(PKG_ROOT, "bin", "agent", "motion-runtime.mjs"), join(staging, "bin", "agent", "motion-runtime.mjs"));
		// The server publishes its live endpoint file from this module.
		copyFileSync(join(PKG_ROOT, "bin", "live-endpoint.mjs"), join(staging, "bin", "live-endpoint.mjs"));
		cpSync(join(PKG_ROOT, "src"), join(staging, "src"), { recursive: true });

		const npm = process.platform === "win32" ? "npm.cmd" : "npm";
		const child = spawn(npm, ["ci", "--no-audit", "--no-fund"], {
			cwd: staging,
			stdio: ["ignore", "pipe", "pipe"],
			shell: process.platform === "win32",
		});
		child.stdout.pipe(process.stderr);
		child.stderr.pipe(process.stderr);
		child.on("error", (error) => {
			rmSync(staging, { recursive: true, force: true });
			done({ code: 1, error });
		});
		child.on("exit", (code) => {
			if (code !== 0) {
				rmSync(staging, { recursive: true, force: true });
				done({ code: code ?? 1 });
				return;
			}
			try {
				probeMcpRuntime(staging);
				try {
					probeMcpRuntime();
					rmSync(staging, { recursive: true, force: true });
				} catch {
					try {
						renameSync(staging, MCP_RUNTIME);
					} catch (error) {
						// Another first run can publish its complete staging
						// directory first. Accept that winner only after the
						// same full probe; never execute a partial cache.
						probeMcpRuntime();
						rmSync(staging, { recursive: true, force: true });
					}
				}
				done({ code: 0 });
			} catch (error) {
				rmSync(staging, { recursive: true, force: true });
				done({ code: 1, error });
			}
		});
	});
}

export async function runMcp(rest) {
	if (!existsSync(join(PKG_ROOT, "mcp", "server.mjs")) || !existsSync(join(MCP_RUNTIME_SOURCE, "package-lock.json"))) {
		console.error("cozyclay: this build does not include the MCP server runtime.");
		process.exit(1);
	}

	let server;
	try {
		server = probeMcpRuntime();
	} catch {
		console.error("cozyclay: installing MCP server dependencies (one-time per CozyClay version)...");
		const result = await installMcpRuntime();
		if (result.code !== 0) {
			console.error(`cozyclay: npm ci failed${result.error ? `: ${result.error.message}` : ` (exit ${result.code})`}. Check your network connection and retry.`);
			console.error(`cozyclay: the published package was not changed; remove ${JSON.stringify(MCP_RUNTIME)} before retrying a damaged cache.`);
			process.exit(1);
		}
		try {
			server = probeMcpRuntime();
		} catch (error) {
			console.error(`cozyclay: MCP runtime is incomplete after npm ci: ${error.message}`);
			process.exit(1);
		}
	}
	const child = spawn(process.execPath, [server, ...rest], { stdio: "inherit" });
	child.on("exit", (code, signal) => process.exit(signal ? 1 : (code ?? 0)));
}

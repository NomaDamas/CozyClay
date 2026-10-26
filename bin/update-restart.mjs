/**
 * The supervised restart behind POST /__cozyclay/update/restart (#960).
 *
 * After a one-click install the running launcher still holds the old code.
 * restart() closes the HTTP server (closeAllConnections first, so an open SSE
 * stream cannot hold close() forever) and the live hub, then runs the new
 * global bin/cozyclay.mjs as a child on the same port with the same argv and
 * env and inherited stdio. This process stays the terminal's foreground job
 * and exits with the child's exit code. A child that has not bound the port
 * within 10 s gets the fallback line and exit 1.
 *
 * Everything with an effect is injected, so a test runs it without exiting.
 */
import { spawn as nodeSpawn } from "node:child_process";
import { connect } from "node:net";
import { globalLauncherPath } from "./update-install.mjs";

const BIND_TIMEOUT_MS = 10_000;
const HUB_CLOSE_MS = 3000;
const PROBE_MS = 150;
export const RESTART_FALLBACK = "cozyclay: the updated CozyClay did not start. Quit any CozyClay still running, then run `cclay` again.";

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** Stop accepting, drop every open connection (SSE included), resolve once the server has closed. */
export function closeServer(server) {
	if (!server?.listening) return Promise.resolve();
	server.closeAllConnections?.();
	return new Promise((resolve) => server.close(() => resolve()));
}

function portOpen(port) {
	return new Promise((resolve) => {
		const socket = connect({ port, host: "127.0.0.1" });
		socket.once("connect", () => { socket.destroy(); resolve(true); });
		socket.once("error", () => resolve(false));
	});
}

async function waitForBind(port, timeoutMs, gone) {
	const deadline = Date.now() + timeoutMs;
	while (Date.now() < deadline && !gone()) {
		if (await portOpen(port)) return true;
		await sleep(PROBE_MS);
	}
	return false;
}

/**
 * @param {object} options
 * @param {number} options.port the launcher's port, which the child binds again
 * @param {() => import("node:http").Server|null} options.getServer
 * @param {() => Promise<void>} [options.closeHub] closes the live hub (the agent handler's close)
 * @returns {{ target(): Promise<string|null>, restart(): Promise<void> }}
 */
export function createRestarter({
	port, getServer, closeHub = async () => {}, launcherPath = globalLauncherPath, argv = process.argv.slice(2), env = process.env,
	spawn = nodeSpawn, exit = (code) => process.exit(code), log = (line) => console.error(line), signals = process, bindTimeoutMs = BIND_TIMEOUT_MS,
}) {
	let target = null;
	let running = null;
	const resolveTarget = () => (target ??= Promise.resolve().then(launcherPath).catch(() => null));
	async function run() {
		const bin = await resolveTarget();
		if (!bin) { log(RESTART_FALLBACK); return; }
		await closeServer(getServer());
		await Promise.race([Promise.resolve().then(closeHub).catch(() => {}), sleep(HUB_CLOSE_MS)]);
		// The Studio tab reloads itself; a second browser tab would be noise.
		const args = argv.includes("--no-open") ? argv : [...argv, "--no-open"];
		const child = spawn(process.execPath, [bin, ...args], { stdio: "inherit", env });
		let exited = false, bound = false;
		// The child owns Ctrl+C and the goodbye prompt now; this process only passes signals on.
		for (const name of ["SIGINT", "SIGTERM"]) {
			signals.removeAllListeners(name);
			signals.on(name, () => { try { child.kill(name); } catch { /* already gone */ } });
		}
		child.once("error", () => { if (!exited) { exited = true; log(RESTART_FALLBACK); exit(1); } });
		child.once("exit", (code) => {
			if (exited) return;
			exited = true;
			if (!bound && code !== 0) log(RESTART_FALLBACK);
			exit(code ?? 1);
		});
		bound = await waitForBind(port, bindTimeoutMs, () => exited);
		if (bound || exited) return;
		exited = true;
		log(RESTART_FALLBACK);
		try { child.kill("SIGTERM"); } catch { /* already gone */ }
		exit(1);
	}
	return {
		target: resolveTarget,
		restart: () => (running ??= run()),
	};
}

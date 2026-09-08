/** Serial, bridge-owned SSH worker. Cached weights are on CPU between jobs.
 * Disconnect/timeout kills the worker; the next request starts a clean one.
 */
import { spawn } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { killGroup, streamLines, track } from "./proc.mjs";

export class PersistentGvhmrWorker {
	constructor({ prepare = async () => {}, start, idleMs = 10 * 60_000 }) {
		this.prepare = prepare;
		this.start = start;
		this.idleMs = idleMs;
		this.child = null;
		this.ready = null;
		this.active = null;
		this.idle = null;
	}

	run(request, { signal, onLine, timeoutMs = 30 * 60_000 } = {}) {
		if (signal?.aborted) return Promise.reject(new Error("extract-cancelled"));
		if (this.active) return Promise.reject(new Error("extract-worker-busy"));
		clearTimeout(this.idle);
		return new Promise((resolve, reject) => {
			const ctx = { request: { ...request, id: randomUUID() }, resolve, reject, signal, onLine,
				started: performance.now(), controller: new AbortController(), startupSeconds: 0 };
			this.active = ctx;
			ctx.abort = () => this.stop("extract-cancelled");
			signal?.addEventListener("abort", ctx.abort, { once: true });
			ctx.timer = setTimeout(() => this.stop("extract-timeout"), timeoutMs);
			this.begin(ctx).catch((err) => {
				if (this.active === ctx) this.stop(`extract-worker-start: ${err.message}`);
			});
		});
	}

	async begin(ctx) {
		if (this.child && this.ready) return this.dispatch(ctx);
		await this.prepare(ctx.controller.signal);
		if (this.active !== ctx) return; // cancellation while deploying must not spawn a late worker
		const child = this.start();
		this.child = child;
		track(child);
		child.stdin.on("error", (err) => {
			if (this.child === child) this.stop(`extract-worker-stdin: ${err.message}`);
		});
		streamLines(child.stdout, (line) => {
			if (this.child !== child) return;
			let msg;
			try { msg = JSON.parse(line); } catch { return this.stop("extract-worker-protocol"); }
			if (msg.event === "ready" && msg.protocol === 1 && !this.ready) {
				this.ready = msg;
				if (this.active) {
					this.active.startupSeconds = msg.startupSeconds;
					this.dispatch(this.active);
				}
				return;
			}
			const active = this.active;
			if (!active || !active.sent || msg.id !== active.request.id) return this.stop("extract-worker-protocol");
			if (msg.event === "error") return this.stop(`extract-worker-failed: ${msg.message}`);
			if (msg.event !== "done") return this.stop("extract-worker-protocol");
			this.finish(null, { ...msg.performance, workerStartupSeconds: active.startupSeconds,
				workerWallSeconds: (performance.now() - active.started) / 1000, runnerSha256: this.ready.runnerSha256 });
		});
		streamLines(child.stderr, (line) => {
			if (this.child === child) this.active?.onLine?.(line);
		});
		child.once("error", (err) => {
			if (this.child === child) this.stop(`extract-worker-spawn: ${err.message}`);
		});
		child.once("close", (code) => {
			if (this.child !== child) return;
			this.child = this.ready = null;
			this.finish(new Error(`extract-worker-exited: ${code}`));
		});
	}

	dispatch(ctx) {
		if (ctx.sent || this.active !== ctx) return;
		ctx.sent = true;
		this.child.stdin.write(`${JSON.stringify(ctx.request)}\n`);
	}

	finish(error, result) {
		const ctx = this.active;
		this.active = null;
		if (ctx) {
			clearTimeout(ctx.timer);
			ctx.signal?.removeEventListener("abort", ctx.abort);
			ctx.controller.abort();
			if (error) ctx.reject(error);
			else ctx.resolve(result);
		}
		if (this.child) {
			clearTimeout(this.idle);
			this.idle = setTimeout(() => this.stop(), this.idleMs);
			this.idle.unref();
		}
	}

	stop(reason = "extract-worker-stopped") {
		clearTimeout(this.idle);
		const child = this.child;
		this.child = this.ready = null;
		if (child) {
			child.stdin.end(); // remote EOF terminates active GPU work as well
			killGroup(child);
		}
		this.finish(new Error(reason));
	}
}

function setup(command, args, signal) {
	return new Promise((resolve, reject) => {
		if (signal.aborted) return reject(new Error("extract-cancelled"));
		const child = spawn(command, args, { detached: true, stdio: ["ignore", "ignore", "pipe"] });
		track(child);
		let error = "";
		const abort = () => killGroup(child);
		signal.addEventListener("abort", abort, { once: true });
		child.stderr.on("data", (chunk) => { error = (error + chunk).slice(-4096); });
		child.once("error", reject);
		child.once("close", (code) => {
			signal.removeEventListener("abort", abort);
			if (code === 0 && !signal.aborted) resolve();
			else reject(new Error(error.trim() || `${command} exited ${code}`));
		});
	});
}

const DETECTORS = ["yolo", "palette", "auto"];

/** Runner CLI flags shared by the one-shot ssh command and the worker.
 *  Pure so the flag wiring is testable without a box: the part-coloured
 *  mannequin (#137) is invisible to YOLO's person class (28/124 frames at
 *  conf 0.5 against 481/481 for a real person), so the runner's palette
 *  detector takes over on those clips. `auto` measures the palette first and
 *  keeps YOLO when the hue evidence is thin, which is why it is the default.
 */
export function gvhmrRunnerArgs({ staticCam = true, fMm = null, detector = "auto" } = {}) {
	const args = [];
	if (staticCam) args.push("--static-cam");
	if (fMm != null) args.push("--f-mm", String(Math.trunc(fMm)));
	args.push("--detector", DETECTORS.includes(detector) ? detector : "auto");
	return args;
}

/** CCLAY_EXTRACT_DETECTOR as the runner understands it. Anything unrecognised
 *  becomes `auto` rather than reaching the runner's argparse choices, where it
 *  would abort the extraction instead of degrading to the safe default. */
export function gvhmrDetectorFromEnv(env = process.env) {
	const value = env.CCLAY_EXTRACT_DETECTOR?.trim().toLowerCase() || "auto";
	return DETECTORS.includes(value) ? value : "auto";
}

const clients = new Map();
export function gvhmrWorker({ host, sshOptions, scpOptions }) {
	const key = JSON.stringify([host, sshOptions, scpOptions]);
	if (clients.has(key)) return clients.get(key);
	const files = ["cclay_gvhmr_worker.py", "gvhmr_fastpath.py", "gvhmr_trajectory.py"].map((name) => fileURLToPath(new URL(`../${name}`, import.meta.url)));
	const hash = createHash("sha256");
	for (const file of files) hash.update(readFileSync(file));
	const directory = `/tmp/cozyclay-gvhmr-worker-${hash.digest("hex").slice(0, 24)}`;
	const client = new PersistentGvhmrWorker({
		prepare: async (signal) => {
			await setup("ssh", [...sshOptions, host, `umask 077 && mkdir -p '${directory}'`], signal);
			await setup("scp", [...scpOptions, ...files, `${host}:${directory}/`], signal);
		},
		start: () => spawn("ssh", [...sshOptions, "-o", "ServerAliveInterval=15", "-o", "ServerAliveCountMax=2", host,
			`cd ~/cclay-ingest/GVHMR && exec .venv/bin/python -u '${directory}/cclay_gvhmr_worker.py'`],
			{ detached: true, stdio: ["pipe", "pipe", "pipe"] }),
	});
	clients.set(key, client);
	return client;
}

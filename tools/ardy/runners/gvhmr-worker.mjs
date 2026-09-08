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

// CozyClay's mocap input is the coloured mannequin.  Palette segmentation is
// therefore a contract, rather than a selectable heuristic: keeping this
// list to one value prevents an environment override from silently routing a
// take through YOLO or the auto detector.
const DETECTORS = ["palette"];
const KEYPOINTS = ["vitpose", "palette", "auto"];

/** Runner CLI flags shared by the one-shot ssh command and the worker.
 *  Pure so the flag wiring is testable without a box: the part-coloured
 *  mannequin (#137) is invisible to YOLO's person class (28/124 frames at
 *  conf 0.5 against 481/481 for a real person), so the runner always uses its
 *  palette detector.
 *
 *  `keypoints` picks what fills GVHMR's kp2d observation (#180). ViTPose has
 *  to infer joints a flat-coloured render gives it no cue for — measured on
 *  h3_warm_s7 its median body joint sits 10.4 % of bbox height off the
 *  palette joints, the shoulders 30-65 % — while the mannequin's per-segment
 *  hues put every joint exactly where two segment masks meet. `auto` follows
 *  the detector: palette keypoints for a palette-detected clip, ViTPose for
 *  real footage, which is the only place ViTPose is the better estimate.
 */
export function gvhmrRunnerArgs({ staticCam = true, fMm = null, detector = "palette", keypoints = "auto" } = {}) {
	const args = [];
	if (staticCam) args.push("--static-cam");
	if (fMm != null) args.push("--f-mm", String(Math.trunc(fMm)));
	// Always send the flag.  Omitting it would let the remote runner's own
	// default (`auto`) bypass the palette contract.
	args.push("--detector", "palette");
	args.push("--keypoints", KEYPOINTS.includes(keypoints) ? keypoints : "auto");
	return args;
}

/** CCLAY_EXTRACT_DETECTOR is retained for deployment compatibility, but cannot
 *  change the detector. Every value resolves to the palette contract. */
export function gvhmrDetectorFromEnv(env = process.env) {
	return "palette";
}

/** CCLAY_EXTRACT_KEYPOINTS as the runner understands it, degrading unknown
 *  values to `auto` for compatibility with the existing keypoint A/B switch. */
export function gvhmrKeypointsFromEnv(env = process.env) {
	const value = env.CCLAY_EXTRACT_KEYPOINTS?.trim().toLowerCase() || "auto";
	return KEYPOINTS.includes(value) ? value : "auto";
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

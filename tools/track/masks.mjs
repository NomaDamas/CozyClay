#!/usr/bin/env node
/**
 * masks.mjs — SAM2 video masks for the known-character tracker (#500).
 *
 * Runs tools/track/py/masks.py on the GPU box for one clip (video + GVHMR obs)
 * and caches the result at <cache-root>/<set>/<name>/masks/{masks.npz,masks.json,manifest.json}.
 * The cache key is sha256 over the video bytes, the obs bytes, the masks.py
 * bytes and the run parameters: changing any of them recomputes. A cache hit
 * also requires masks.npz / masks.json to match the sha256 recorded in the
 * manifest, so a corrupt or truncated file is recomputed, never served. Only the
 * video and the obs reach the box; no plate, truth mask or colour cue.
 *
 * Provenance: the masks must be computed from the video the obs was extracted
 * from. The obs manifest chain is followed (copy manifests via `source`, checked
 * against `sourceSha256`) to the original obs; when that records `videoSha256`
 * the video used here must have exactly that sha (else `obs-video-mismatch`),
 * and the masks manifest carries the origin's own label unchanged: "recorded"
 * (hashed at extraction; the default when the origin has no label) or
 * "backfilled-path" (hashed later by tools/track/backfill-provenance.mjs).
 * Sweep obs without a manifest (tools' serial sweep) record nothing: the item's
 * sweep input path is used (fal: the approved clip `item.video`) and a video
 * written after the obs is rejected (`obs-video-newer`); such manifests say
 * `provenance: "path-only"`.
 *
 *   node tools/track/masks.mjs --approved evidence/obs/approved.json [--items gt/walk,cube/bump]
 *   node tools/track/masks.mjs --video clip.mp4 --obs obs.npz --out <dir>
 */
import { spawn } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { readNpz } from "../kimodo/read-npz.mjs";
import { buildRemoteCommand, quote } from "./run-box.mjs";

const HERE = fileURLToPath(new URL(".", import.meta.url));
export const MASKS_SCRIPT = join(HERE, "py", "masks.py");
export const DEFAULT_CACHE_ROOT = process.env.COZYCLAY_OBS_ROOT ?? "evidence/obs/cache";
const DEFAULT_HOST = process.env.COZYFIT_HOST || "ubuntu-baremetal";
const sshBase = ["-o", "BatchMode=yes", "-o", "ConnectTimeout=15", "-o", "ServerAliveInterval=15", "-o", "ServerAliveCountMax=3"];
const port = process.env.CCLAY_EXTRACT_SSH_PORT;
const sshFlags = port ? [...sshBase, "-p", port] : sshBase;
const scpFlags = port ? [...sshBase, "-P", port] : sshBase;

export const USAGE = `usage: node tools/track/masks.mjs --approved <approved.json> [options]
       node tools/track/masks.mjs --video <clip.mp4> --obs <obs.npz> --out <dir> [options]

  --items a,b            set/name or name filter (default: every approved item)
  --obs-root <dir>       obs from <dir>/<set>/<name>/g5/obs.npz (default ${DEFAULT_CACHE_ROOT})
  --cache-root <dir>     masks to <dir>/<set>/<name>/masks/ (default: --obs-root)
  --chunk-frames 180     SAM2 frames per propagation chunk
  --prompt <mode>        centre | box | torso | upper | joints | all (default: masks.py's joints)
  --host <ssh-dest>      GPU box (default ${DEFAULT_HOST})
  --gpu-wait-min 30      wait this long for a busy GPU (never kills the other job)
  --force                recompute even when the cache key matches`;

const sha256 = (...parts) => { const h = createHash("sha256"); for (const p of parts) h.update(p); return h.digest("hex"); };
const fileSha = (path) => sha256(readFileSync(path));
const readJson = (path) => { try { return JSON.parse(readFileSync(path, "utf8")); } catch { return null; } };

/** The cache key: content of every input that can change the masks. */
export function masksCacheKey({ videoSha256, obsSha256, scriptSha256, params = {} }) {
	for (const [name, value] of Object.entries({ videoSha256, obsSha256, scriptSha256 })) {
		if (!/^[0-9a-f]{64}$/.test(value ?? "")) throw new Error(`masksCacheKey: ${name} must be a sha256 hex digest`);
	}
	const sorted = Object.fromEntries(Object.entries(params).sort(([a], [b]) => a.localeCompare(b)));
	return sha256(JSON.stringify({ video: videoSha256, obs: obsSha256, script: scriptSha256, params: sorted }));
}

/**
 * "cached" only when the manifest names this key and both outputs exist with
 * the sha256 the manifest recorded. `files` = { npz, json } shas or null.
 */
export function cacheState(manifest, key, files) {
	if (!manifest) return files ? "stale-unmanifested" : "missing";
	if (manifest.key !== key) return "stale-key";
	if (!files) return "missing";
	if (!manifest.masksSha256 || !manifest.masksJsonSha256) return "unverifiable";
	return files.npz === manifest.masksSha256 && files.json === manifest.masksJsonSha256 ? "cached" : "corrupt";
}

/**
 * Check the video against what the obs records about its own extraction video.
 * `origin` = the original obs manifest (after following copies) or null.
 */
export const HASHED_PROVENANCE = ["recorded", "backfilled-path"];
export function checkObsVideo({ origin, videoSha256, obsSha256, videoPath, videoMtimeMs, obsMtimeMs }) {
	const label = origin?.provenance;
	if (label !== undefined && label !== "path-only" && !HASHED_PROVENANCE.includes(label)) throw new Error(`obs-provenance-unknown: obs manifest provenance ${JSON.stringify(label)} is not ${[...HASHED_PROVENANCE, "path-only"].join("|")}`);
	if (HASHED_PROVENANCE.includes(label) && !origin.videoSha256) throw new Error(`obs-provenance-invalid: obs manifest says ${label} but records no videoSha256`);
	if (origin?.videoSha256) {
		if (label === "path-only") throw new Error("obs-provenance-invalid: obs manifest says path-only but records a videoSha256");
		if (origin.videoSha256 !== videoSha256) throw new Error(`obs-video-mismatch: the obs was extracted from video sha256 ${origin.videoSha256} (${origin.video ?? "?"}), not ${videoSha256} (${videoPath})`);
		if (origin.obsSha256 && origin.obsSha256 !== obsSha256) throw new Error(`obs-sha-mismatch: obs sha256 ${obsSha256} differs from its manifest's ${origin.obsSha256}`);
		return { provenance: label ?? "recorded", recordedVideoSha256: origin.videoSha256, recordedVideo: origin.video ?? null };
	}
	if (videoMtimeMs > obsMtimeMs) throw new Error(`obs-video-newer: ${videoPath} was written after the obs it would pair with; it cannot be the extraction video`);
	return { provenance: "path-only", recordedVideoSha256: null, recordedVideo: origin?.video ?? null };
}

/** Follow copy manifests (`source` + `sourceSha256`) to the original obs and its manifest. */
export function resolveObsOrigin(obs) {
	let path = resolve(obs);
	const copies = [];
	for (let hop = 0; hop < 4; hop += 1) {
		const manifest = readJson(join(dirname(path), "manifest.json"));
		if (!manifest?.source || resolve(manifest.source) === path) return { obs: path, manifest, copies };
		if (manifest.sourceSha256 && fileSha(path) !== manifest.sourceSha256) throw new Error(`obs-copy-mismatch: ${path} is not the ${manifest.source} its manifest names`);
		copies.push(path);
		path = resolve(manifest.source);
		if (!existsSync(path)) throw new Error(`obs-copy-mismatch: source ${path} is missing`);
	}
	throw new Error(`obs-copy-mismatch: manifest chain from ${obs} is too long`);
}

/** Structural check of a fetched masks.npz before it is committed to the cache. */
export function validateMasksNpz(path, frames) {
	const members = readNpz(path);
	const prob = members.prob?.shape, area = members.area?.shape;
	if (!prob || prob.length !== 3 || prob[0] !== frames || !(prob[1] > 0 && prob[2] > 0) || members.prob.dtype !== "<f2") throw new Error(`masks-invalid: prob ${JSON.stringify(prob ?? null)} ${members.prob?.dtype ?? ""} for ${frames} frames`);
	if (!area || area[0] !== frames || !members.reprompted) throw new Error(`masks-invalid: area/reprompted missing or wrong length in ${path}`);
	return prob;
}

/** Remote budget: model load + ~0.25 s/frame on the RTX 3070, 3x headroom, bounded. */
export function remoteTimeoutS(frames) {
	return Math.min(1800, Math.ceil(60 + 0.75 * Math.max(1, frames)));
}

/** The clip and obs a bench item's masks are computed from (same files the obs sweep used). */
export function itemMaskInputs(item, { obsRoot = DEFAULT_CACHE_ROOT, cacheRoot = obsRoot } = {}) {
	// The obs sweep extracted every item from item.video ?? <dir>/<variant>/video.mp4 (fal: the approved clip itself).
	const video = item.video ?? join(item.dir, item.variant, "video.mp4");
	return { video, obs: join(obsRoot, item.set, item.name, "g5", "obs.npz"), outDir: join(cacheRoot, item.set, item.name, "masks") };
}

function exec(program, args, { onLine, timeoutMs } = {}) {
	return new Promise((resolvePromise, reject) => {
		const child = spawn(program, args, { stdio: ["ignore", "pipe", "pipe"] });
		let output = "", pending = "", timer;
		const emit = (chunk) => {
			output += chunk; pending += chunk;
			const lines = pending.split(/[\r\n]+/); // tqdm redraws with \r
			pending = lines.pop() ?? "";
			for (const line of lines) if (line) onLine?.(line);
		};
		child.stdout.on("data", emit); child.stderr.on("data", emit);
		if (timeoutMs > 0) timer = setTimeout(() => child.kill("SIGTERM"), timeoutMs);
		child.once("error", (error) => { clearTimeout(timer); reject(error); });
		child.once("close", (code, signal) => {
			clearTimeout(timer);
			if (pending) onLine?.(pending);
			if (code === 0) resolvePromise(output);
			else reject(Object.assign(new Error(`${program} exited ${code ?? signal}: ${output.slice(-3000)}`), { code, output }));
		});
	});
}

async function runRemote({ host, video, obs, outDir, chunkFrames, prompt, frames, onLine }) {
	const remote = `/tmp/cozyfit-masks-${Date.now()}-${randomBytes(5).toString("hex")}`;
	const ssh = (command, options) => exec("ssh", [...sshFlags, host, command], options);
	const scp = (from, to) => exec("scp", [...scpFlags, from, to]);
	const staging = `${outDir}.tmp-${process.pid}`;
	let failure;
	try {
		await ssh(`umask 077 && mkdir ${quote(remote)}`);
		await scp(MASKS_SCRIPT, `${host}:${remote}/masks.py`);
		await scp(video, `${host}:${remote}/video.mp4`);
		await scp(obs, `${host}:${remote}/obs.npz`);
		const inner = buildRemoteCommand(remote, "masks.py", ["--video", `${remote}/video.mp4`, "--obs", `${remote}/obs.npz`, "--out", `${remote}/out`, "--chunk-frames", String(chunkFrames), ...(prompt ? ["--prompt", prompt] : [])]);
		const limit = remoteTimeoutS(frames);
		// The box enforces the bound itself so a dropped ssh never leaves SAM2 running.
		await ssh(`timeout -k 15 ${limit} bash -c ${quote(inner)}`, { onLine, timeoutMs: (limit + 60) * 1000 });
		rmSync(staging, { recursive: true, force: true });
		mkdirSync(staging, { recursive: true });
		await scp(`${host}:${remote}/out/masks.npz`, join(staging, "masks.npz"));
		await scp(`${host}:${remote}/out/masks.json`, join(staging, "masks.json"));
		return staging;
	} catch (error) {
		failure = error;
		rmSync(staging, { recursive: true, force: true });
		throw error;
	} finally {
		try { await ssh(`rm -rf ${quote(remote)}`); }
		catch (cleanupError) { if (!failure) throw cleanupError; }
	}
}

/** Row count of the obs person boxes; empty obs fails here, before any box work. */
function obsFrames(obsPath) {
	const shape = readNpz(obsPath).bbx_xys?.shape;
	if (!shape || shape.length !== 2 || shape[0] === 0 || shape[1] !== 3) throw new Error(`no-person-prompt: ${obsPath} has no person boxes (bbx_xys shape ${JSON.stringify(shape ?? null)})`);
	return shape[0];
}

/**
 * Masks for one clip, computed on the box unless the cache key matches.
 * Returns { path, jsonPath, manifest, cached }.
 */
export async function ensureMasks({ video, obs, outDir, host = DEFAULT_HOST, chunkFrames = 180, prompt, force = false, gpuWaitMin = 30, log = console.log } = {}) {
	for (const [name, path] of Object.entries({ video, obs })) if (!path || !existsSync(path)) throw new Error(`masks: missing ${name} ${path}`);
	const frames = obsFrames(obs);
	const params = { chunkFrames, prompt: prompt ?? "script-default" };
	const record = { videoSha256: fileSha(video), obsSha256: fileSha(obs), scriptSha256: fileSha(MASKS_SCRIPT), params };
	const origin = resolveObsOrigin(obs);
	const provenance = { ...checkObsVideo({ origin: origin.manifest, videoSha256: record.videoSha256, obsSha256: fileSha(origin.obs), videoPath: resolve(video), videoMtimeMs: statSync(video).mtimeMs, obsMtimeMs: statSync(origin.obs).mtimeMs }), originObs: origin.obs, obsCopies: origin.copies };
	const key = masksCacheKey(record);
	const path = join(outDir, "masks.npz"), jsonPath = join(outDir, "masks.json"), manifestPath = join(outDir, "manifest.json");
	const files = existsSync(path) && existsSync(jsonPath) ? { npz: fileSha(path), json: fileSha(jsonPath) } : null;
	const state = cacheState(readJson(manifestPath), key, files);
	if (state === "cached" && !force) return { path, jsonPath, manifest: readJson(manifestPath), cached: true, state };
	log(`masks: ${force ? "forced" : state}; computing on ${host}`);
	const deadline = Date.now() + gpuWaitMin * 60000;
	let staging;
	for (;;) {
		try {
			staging = await runRemote({ host, video, obs, outDir, chunkFrames, prompt, frames, onLine: (line) => { if (/^\[masks\]|no-person-prompt|Error|error:/.test(line)) log(line); } });
			break;
		} catch (error) {
			const message = String(error.message);
			if (/no-person-prompt/.test(message)) throw new Error(`no-person-prompt: ${obs} has no usable person box`);
			if (!/gpu-busy/.test(message) || Date.now() > deadline) throw error;
			log(`masks: GPU busy; waiting 30 s (${message.split("\n").find((l) => /gpu-busy/.test(l))?.trim().slice(0, 200)})`);
			await sleep(30000);
		}
	}
	let summary;
	try {
		summary = JSON.parse(readFileSync(join(staging, "masks.json"), "utf8"));
		if (summary.frames !== frames) throw new Error(`masks-invalid: masks.json frames ${summary.frames}, obs ${frames}`);
		validateMasksNpz(join(staging, "masks.npz"), frames);
	} catch (error) {
		rmSync(staging, { recursive: true, force: true });
		throw error;
	}
	const manifest = {
		key, ...record, video: resolve(video), obs: resolve(obs), script: MASKS_SCRIPT, ...provenance,
		masksSha256: fileSha(join(staging, "masks.npz")), masksJsonSha256: fileSha(join(staging, "masks.json")),
		host, frames: summary.frames, seconds: summary.seconds, peakReservedMiB: summary.peakReservedMiB, reprompted: summary.reprompted, anchor: summary.anchor, previousState: force ? "forced" : state, createdAt: new Date().toISOString(),
	};
	mkdirSync(outDir, { recursive: true });
	rmSync(manifestPath, { force: true }); // no window where a manifest vouches for half-renamed files
	for (const name of ["masks.npz", "masks.json"]) renameSync(join(staging, name), join(outDir, name));
	rmSync(staging, { recursive: true, force: true });
	writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 1)}\n`);
	return { path, jsonPath, manifest, cached: false, state };
}

export function parseArgs(argv) {
	const options = { obsRoot: DEFAULT_CACHE_ROOT, chunkFrames: 180, host: DEFAULT_HOST, gpuWaitMin: 30, force: false };
	const value = (i) => { if (i + 1 >= argv.length) throw new Error(`${argv[i]} needs a value`); return argv[i + 1]; };
	for (let i = 0; i < argv.length; i += 1) {
		const arg = argv[i];
		if (arg === "--help" || arg === "-h") options.help = true;
		else if (arg === "--force") options.force = true;
		else if (arg === "--approved") options.approved = value(i++);
		else if (arg === "--items") options.items = value(i++).split(",").filter(Boolean);
		else if (arg === "--obs-root") options.obsRoot = value(i++);
		else if (arg === "--cache-root") options.cacheRoot = value(i++);
		else if (arg === "--video") options.video = value(i++);
		else if (arg === "--obs") options.obs = value(i++);
		else if (arg === "--out") options.out = value(i++);
		else if (arg === "--host") options.host = value(i++);
		else if (arg === "--chunk-frames") options.chunkFrames = Number(value(i++));
		else if (arg === "--prompt") options.prompt = value(i++);
		else if (arg === "--gpu-wait-min") options.gpuWaitMin = Number(value(i++));
		else throw new Error(`unknown argument ${arg}`);
	}
	options.cacheRoot ??= options.obsRoot;
	if (!options.help) {
		const single = options.video || options.obs || options.out;
		if (single ? !(options.video && options.obs && options.out) || options.approved : !options.approved) throw new Error(USAGE);
		if (!(Number.isInteger(options.chunkFrames) && options.chunkFrames >= 2)) throw new Error("--chunk-frames must be an integer >= 2");
	}
	return options;
}

export function selectMaskItems(approved, filter) {
	const items = approved.items ?? [];
	if (!filter) return items;
	const chosen = filter.map((key) => {
		const hit = items.filter((item) => key === `${item.set}/${item.name}` || key === item.name);
		if (hit.length !== 1) throw new Error(`--items ${key}: ${hit.length ? "ambiguous" : "not in the approved list"}`);
		return hit[0];
	});
	return chosen;
}

async function main(argv = process.argv.slice(2)) {
	const options = parseArgs(argv);
	if (options.help) { console.log(USAGE); return; }
	const common = { host: options.host, chunkFrames: options.chunkFrames, prompt: options.prompt, force: options.force, gpuWaitMin: options.gpuWaitMin };
	if (options.video) {
		const result = await ensureMasks({ ...common, video: options.video, obs: options.obs, outDir: options.out });
		console.log(`${options.out}: ${result.cached ? "cached" : "computed"} frames=${result.manifest.frames} seconds=${result.manifest.seconds} peakReservedMiB=${result.manifest.peakReservedMiB} reprompted=${result.manifest.reprompted.length}`);
		return;
	}
	const items = selectMaskItems(JSON.parse(readFileSync(options.approved, "utf8")), options.items);
	let failed = 0;
	for (const item of items) {
		const label = `${item.set}/${item.name}`;
		try {
			const inputs = itemMaskInputs(item, options);
			const result = await ensureMasks({ ...common, ...inputs, log: (line) => console.log(`${label}: ${line}`) });
			console.log(`${label}: ${result.cached ? "cached" : `computed (was ${result.state})`} frames=${result.manifest.frames} seconds=${result.manifest.seconds} peakReservedMiB=${result.manifest.peakReservedMiB} reprompted=${result.manifest.reprompted.length} provenance=${result.manifest.provenance} video=${result.manifest.video} sha=${result.manifest.videoSha256.slice(0, 12)} -> ${result.path}`);
		} catch (error) {
			failed += 1;
			console.error(`${label}: FAILED ${error.message.split("\n")[0]}`);
		}
	}
	console.log(`masks: ${items.length - failed}/${items.length} ok`);
	if (failed) process.exitCode = 1;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
	main().catch((error) => { console.error(error.message); process.exitCode = error.message === USAGE ? 2 : 1; });
}

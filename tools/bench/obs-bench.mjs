#!/usr/bin/env node
/**
 * obs-bench.mjs — observation-ladder bench (#462). For each approved item:
 * extract the obs NPZ on the GPU box (serial, tools/bench/obs/remote.mjs),
 * fetch/cache the SMPL rest joints of its betas (tools/bench/obs/rest_joints.py),
 * build every requested ladder step (tools/bench/obs/ladder.mjs), write the
 * cskel27 take and score it.
 *
 *   <out>/<set>/<name>/
 *     bench.log                      timestamped item log
 *     obs-base/{obs.npz,manifest.json,extract.log}        GVHMR's own betas
 *     obs-mannequin/{obs.npz,betas.json,manifest.json,extract.log}
 *     input/video.mp4                fal only: normalised to the camera size, 24 fps
 *     <step>/{motion.npz,result.json,score.log,score/score.json}
 *
 * Only user-known inputs reach a step: the video, camera.json, the character
 * body (canonical cskel27 rest skeleton, mannequin betas), scene.json boxes
 * and the FIRST and LAST poses of the A/B source npz. Ground-truth joints,
 * masks and intermediate frames are read by the scorers only.
 */
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { appendFileSync, closeSync, copyFileSync, existsSync, mkdirSync, openSync, readFileSync, writeFileSync, rmSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { motionArraysToNpzMembers, writeNpz } from "../ardy/npz.mjs";
import { readNpz } from "../kimodo/read-npz.mjs";
import { backgroundDifferenceMask, paletteMask, PALETTE_THRESHOLDS } from "./cube-contact.mjs";
import * as THREE from "three";
import { FBXLoader } from "three/examples/jsm/loaders/FBXLoader.js";
import { applyMotionFrame } from "../../src/ardy/playback.js";
import { readEndpoints, regenerateJoints } from "./fit/motion.mjs";
import { maskIoU, mean, meanJointError } from "./metrics.mjs";
import { ladderStep, restInfo, STEPS } from "./obs/ladder.mjs";
import { extractObs } from "./obs/remote.mjs";
import { ensureMasks } from "../../tools/track/masks.mjs";
import { fallbackStep } from "../../tools/track/fallback.mjs";
import { runTracker } from "../../tools/track/remote.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, "../..");
const WRAPPER = join(HERE, "cclay_bench_extract_obs.py");
const REST_SCRIPT = join(HERE, "obs/rest_joints.py");
const MANNEQUIN = join(HERE, "obs/mannequin-betas.json");
const SSH = ["-o", "BatchMode=yes", "-o", "ConnectTimeout=15", ...(process.env.CCLAY_EXTRACT_SSH_PORT ? ["-p", process.env.CCLAY_EXTRACT_SSH_PORT] : [])];
const MANNEQUIN_STEPS = new Set(["G5", "Gbest", "T1"]);
export const OBS_BENCH_STEPS = Object.freeze([...STEPS, "T1"]);
export const DEFAULT_OBS_ROOT = process.env.COZYCLAY_OBS_ROOT ?? "evidence/obs/cache";

export const USAGE = `usage: node tools/bench/obs-bench.mjs --approved <approved.json> --out <dir> [options]

  --items a,b          item names (or set/name); default: every approved item
  --steps G0,...       any of ${OBS_BENCH_STEPS.join(",")} (default: all)
  --host <ssh-dest>    GPU box (default yun@ubuntu-baremetal)
  --rest-cache <dir>   SMPL rest-joint cache (default: <out>/../rest)
  --port 5198          Vite port for the scorers
  --cdp-port 9238      headless Chrome CDP port for the scorers
  --obs-root <dir>     read obs from <dir>/<set>/<name>/{base,g5}/obs.npz, the serial sweep's cache
                       (default ${DEFAULT_OBS_ROOT}); a missing file fails the item. Never touches the GPU.
  --extract            instead of --obs-root, run GVHMR on the box (serial; waits for a busy GPU)
  --gpu-wait-min 60    with --extract: wait this long for a busy GPU before failing the item
  --force-obs          with --extract: re-extract even when the manifest matches
  --character <model>  character rig (public/models/<model>.fbx) whose standing ankle height is the G3 floor plane (default y-bot-tpose)
  --force              rebuild and rescore steps whose result.json says ok
  --help               this text

Idempotent: a step whose result.json has ok=true is skipped; obs NPZs are
reused while video, K, betas and the wrapper are unchanged. One GPU
extraction at a time; items run serially.`;

export function parseArgs(argv) {
	const options = { steps: [...OBS_BENCH_STEPS], host: "yun@ubuntu-baremetal", port: 5198, cdpPort: 9238, gpuWaitMin: 60, force: false, forceObs: false, obsRoot: DEFAULT_OBS_ROOT, extract: false, character: "y-bot-tpose" };
	const names = { "--approved": "approved", "--out": "out", "--items": "items", "--steps": "steps", "--host": "host", "--rest-cache": "restCache", "--port": "port", "--cdp-port": "cdpPort", "--gpu-wait-min": "gpuWaitMin", "--obs-root": "obsRoot", "--character": "character" };
	for (let i = 0; i < argv.length; i++) {
		const flag = argv[i];
		if (flag === "--help" || flag === "-h") { options.help = true; continue; }
		if (flag === "--force") { options.force = true; continue; }
		if (flag === "--force-obs") { options.forceObs = true; continue; }
		if (flag === "--extract") { options.extract = true; continue; }
		if (!names[flag]) throw new Error(`unknown option ${flag}`);
		const value = argv[++i];
		if (value === undefined || value.startsWith("--")) throw new Error(`${flag} needs a value`);
		options[names[flag]] = value;
	}
	if (options.help) return options;
	for (const key of ["approved", "out"]) if (!options[key]) throw new Error(`--${key} is required`);
	if (typeof options.steps === "string") options.steps = options.steps.split(",").map((s) => s.trim()).filter(Boolean);
	const unknown = options.steps.filter((s) => !OBS_BENCH_STEPS.includes(s));
	if (unknown.length || !options.steps.length) throw new Error(`unknown steps ${unknown.join(",")}; known: ${OBS_BENCH_STEPS.join(",")}`);
	options.steps = OBS_BENCH_STEPS.filter((s) => options.steps.includes(s));
	if (typeof options.items === "string") options.items = options.items.split(",").map((s) => s.trim()).filter(Boolean);
	for (const key of ["port", "cdpPort", "gpuWaitMin"]) {
		options[key] = Number(options[key]);
		if (!(Number.isFinite(options[key]) && options[key] >= 0)) throw new Error(`--${key} must be a nonnegative number`);
	}
	options.approved = resolve(options.approved);
	options.out = resolve(options.out);
	options.restCache = resolve(options.restCache ?? join(dirname(options.out), "rest"));
	if (options.extract && argv.includes("--obs-root")) throw new Error("--extract and --obs-root are exclusive");
	options.obsRoot = options.extract ? null : resolve(options.obsRoot);
	return options;
}

export function selectItems(approved, names) {
	const items = approved.items;
	if (!names) return items;
	return names.map((name) => {
		const found = items.filter((item) => name === item.name || name === `${item.set}/${item.name}`);
		if (!found.length) throw new Error(`no approved item ${name}`);
		if (found.length > 1) throw new Error(`ambiguous item ${name}: use one of ${found.map((i) => `${i.set}/${i.name}`).join(", ")}`);
		return found[0];
	});
}

const readJson = (path) => (existsSync(path) ? JSON.parse(readFileSync(path, "utf8")) : null);
const putJson = (path, value) => { mkdirSync(dirname(path), { recursive: true }); writeFileSync(path, `${JSON.stringify(value, null, "\t")}\n`); };
const sha256 = (...parts) => { const h = createHash("sha256"); for (const p of parts) h.update(p); return h.digest("hex"); };
const fileSha = (path) => sha256(readFileSync(path));

function commitId() {
	const head = spawnSync("git", ["rev-parse", "HEAD"], { cwd: ROOT, encoding: "utf8" }).stdout.trim();
	const dirty = spawnSync("git", ["status", "--porcelain"], { cwd: ROOT, encoding: "utf8" }).stdout.trim();
	return head ? `${head}${dirty ? "-dirty" : ""}` : null;
}

/** Everything a real user has for this item, as paths. */
export function itemInputs(item, itemDir) {
	const camera = join(item.dir, item.variant, "camera.json");
	// fal items carry no source npz; their A/B poses are the scenario's GT npz (as exp3 used them).
	const source = item.source ?? join(dirname(dirname(item.dir)), "gt-motions", `${basename(item.dir)}.npz`);
	return {
		set: item.set,
		name: item.name,
		camera,
		video: item.set === "fal" ? join(itemDir, "input", "video.mp4") : join(item.dir, item.variant, "video.mp4"),
		rawVideo: item.video ?? join(item.dir, item.variant, "video.mp4"),
		source,
		scene: item.scene ?? null,
		// Skin renders are invisible to the palette detector (exp3 base condition yolo-vitpose).
		detector: item.variant === "skin" ? "yolo" : "palette",
	};
}

function ffprobe(path) {
	const out = spawnSync("ffprobe", ["-v", "error", "-select_streams", "v:0", "-show_entries", "stream=width,height,nb_frames", "-of", "json", path], { encoding: "utf8" });
	if (out.status) throw new Error(`ffprobe ${path}: ${out.stderr}`);
	return JSON.parse(out.stdout).streams[0];
}

/** fal clips come at the service's size/rate: bring them to the known camera's image and 24 fps (exp3's normalisation). */
function normalizeFalVideo(inputs, log) {
	if (existsSync(inputs.video)) return;
	const camera = readJson(inputs.camera), probe = ffprobe(inputs.rawVideo);
	if (Math.abs(probe.width / probe.height / (camera.width / camera.height) - 1) > 0.01) throw new Error("fal changed the aspect ratio; the known camera does not apply");
	mkdirSync(dirname(inputs.video), { recursive: true });
	const run = spawnSync("ffmpeg", ["-v", "error", "-y", "-i", inputs.rawVideo, "-vf", `scale=${camera.width}:${camera.height},fps=24`, "-c:v", "libx264", "-crf", "12", "-pix_fmt", "yuv420p", inputs.video], { encoding: "utf8" });
	if (run.status) throw new Error(`ffmpeg normalise failed: ${run.stderr}`);
	log(`normalised ${inputs.rawVideo} -> ${inputs.video}`);
}

async function ensureObs({ kind, inputs, itemDir, options, log }) {
	const dir = join(itemDir, `obs-${kind}`), output = join(dir, "obs.npz"), manifestPath = join(dir, "manifest.json");
	mkdirSync(dir, { recursive: true });
	let betasPath = null, betas = null;
	if (kind === "mannequin") {
		betas = readJson(MANNEQUIN).betas;
		betasPath = join(dir, "betas.json");
		writeFileSync(betasPath, `${JSON.stringify(betas)}\n`); // the wrapper wants a bare 10-float list
	}
	const K = readJson(inputs.camera).K;
	const signature = sha256(fileSha(inputs.video), JSON.stringify(K), JSON.stringify(betas), fileSha(WRAPPER), inputs.detector, "vitpose");
	const manifest = readJson(manifestPath);
	// The shared obs root (the control session's serial sweep cache) is the
	// default and is authoritative: read it, never contend for the GPU. It is
	// checked first so a re-extracted cache file replaces a stale local copy.
	if (options.obsRoot) {
		const shared = join(options.obsRoot, inputs.set, inputs.name, kind === "mannequin" ? "g5" : "base", "obs.npz");
		if (!existsSync(shared)) throw new Error(`obs-${kind}: missing ${shared}; the obs sweep has not produced it (see ${join(dirname(shared), "extract.log")}). This bench never extracts when --obs-root is in use; pass --extract to run GVHMR itself.`);
		const sourceSha256 = fileSha(shared);
		if (betas) {
			const used = Array.from(readNpz(shared).betas_used.data);
			const gap = Math.max(...used.map((v, i) => Math.abs(v - betas[i])));
			if (!(gap < 1e-5)) throw new Error(`obs-${kind}: ${shared} was extracted with betas ${JSON.stringify(used)}, not the current ${MANNEQUIN} (max diff ${gap}); re-run the sweep for this item`);
		}
		if (existsSync(output) && manifest?.sourceSha256 === sourceSha256) {
			log(`obs-${kind}: cached (${output} = ${shared})`);
			return { path: output, manifest };
		}
		const record = { signature, source: shared, sourceSha256, video: inputs.video, camera: inputs.camera, K, betas, detector: inputs.detector, keypoints: "vitpose", createdAt: new Date().toISOString() };
		copyFileSync(shared, output);
		putJson(manifestPath, record);
		log(`obs-${kind}: from obs root (${shared})`);
		return { path: output, manifest: record };
	}
	if (!options.forceObs && existsSync(output) && manifest?.signature === signature && !manifest.source) {
		log(`obs-${kind}: cached (${output})`);
		return { path: output, manifest };
	}
	const deadline = Date.now() + options.gpuWaitMin * 60000;
	for (;;) {
		try {
			log(`obs-${kind}: extracting on ${options.host} (${inputs.detector}+vitpose${betas ? ", mannequin betas" : ""})`);
			const started = Date.now();
			const run = await extractObs({ host: options.host, video: inputs.video, camera: inputs.camera, output, detector: inputs.detector, keypoints: "vitpose", betas: betasPath, log: join(dir, "extract.log") });
			const record = { signature, video: inputs.video, camera: inputs.camera, K, betas, detector: inputs.detector, keypoints: "vitpose", wrapperSha256: fileSha(WRAPPER), remote: run.remote, seconds: (Date.now() - started) / 1000, createdAt: new Date().toISOString() };
			putJson(manifestPath, record);
			log(`obs-${kind}: done in ${record.seconds.toFixed(1)} s`);
			return { path: output, manifest: record };
		} catch (error) {
			// Another sweep holds the GPU (refused up front, or it started between our
			// idle check and our allocation): wait, never kill it.
			const busy = /GPU busy|CUDA out of memory/;
			if (!busy.test(String(error.message)) || Date.now() > deadline) throw error;
			log(`obs-${kind}: GPU busy; retrying in 20 s (${String(error.message).split("\n").find((l) => busy.test(l))?.trim().slice(0, 300)})`);
			await sleep(20000);
		}
	}
}

const rigs = new Map();
/** The character's standing ankle-bone height: the A and B poses (user-known)
 * played on the character rig with the Studio's own playback code, lower
 * foot bone of each, averaged. This is where the rendered character's ankle
 * actually is (walk: 0.141 / 0.131 m, the render measures 0.141 at frame 0);
 * the canonical cskel27 skeleton's 0.058 m is not the rendered body. */
export function characterStandingAnkle(endpoints, model = "y-bot-tpose") {
	if (!rigs.has(model)) {
		const path = ["public", "dist"].map((d) => join(ROOT, d, "models", `${model}.fbx`)).find(existsSync);
		if (!path) throw new Error(`character model ${model}.fbx not found under public/ or dist/models`);
		const bytes = readFileSync(path);
		const rig = new FBXLoader().parse(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength), "");
		rig.scale.setScalar(0.01);
		rig.updateMatrixWorld(true);
		rigs.set(model, { rig, path });
	}
	const { rig, path } = rigs.get(model);
	const bone = (name) => { let found = null; rig.traverse((o) => { if (o.isBone && o.name === name) found = o; }); if (!found) throw new Error(`${model}: no bone ${name}`); return found; };
	const feet = [bone("mixamorigLeftFoot"), bone("mixamorigRightFoot")], position = new THREE.Vector3();
	const perPose = endpoints.map((pose) => {
		const motion = regenerateJoints({ frames: 1, fps: 24, rotMats: Float32Array.from(pose.rotMats), rootPos: Float32Array.from(pose.rootPos), posedJoints: new Float32Array(81), boneScale: new Float32Array(27).fill(1) });
		applyMotionFrame(rig, motion, 0);
		rig.updateMatrixWorld(true);
		return Math.min(...feet.map((b) => position.setFromMatrixPosition(b.matrixWorld).y));
	});
	return { height: mean(perPose), perPose, model: path, method: "lower mixamo foot bone of A and B through src/ardy/playback.js applyMotionFrame" };
}

/** SMPL rest joints for `betas`, computed on the box once and cached by (betas, helper) hash. */
function ensureRest(betas, options, log) {
	const key = sha256(Buffer.from(Float32Array.from(betas).buffer), readFileSync(REST_SCRIPT));
	const path = join(options.restCache, `${key}.json`);
	const cached = readJson(path);
	if (cached) return { rest: restInfo(cached), path, key };
	const list = JSON.stringify(Array.from(Float32Array.from(betas)));
	const run = spawnSync("ssh", [...SSH, options.host, `cd ~/cclay-ingest/GVHMR && CUDA_VISIBLE_DEVICES= .venv/bin/python - '${list}'`], { input: readFileSync(REST_SCRIPT), encoding: "utf8", timeout: 300000 });
	if (run.status !== 0) throw new Error(`rest_joints.py failed (${run.status}): ${run.stderr?.slice(-2000)}`);
	const value = JSON.parse(run.stdout.trim().split("\n").at(-1));
	putJson(path, { ...value, key, createdAt: new Date().toISOString() });
	log(`rest joints: computed ${path}`);
	return { rest: restInfo(value), path, key };
}

function sceneBoxes(scenePath) {
	if (!scenePath) return { boxes: [], placement: null };
	const scene = readJson(scenePath);
	return { boxes: [{ min: scene.min, max: scene.max }], placement: scene.placement };
}

function runLogged(args, logPath) {
	const fd = openSync(logPath, "a");
	try {
		const run = spawnSync(process.execPath, args, { cwd: ROOT, stdio: ["ignore", fd, fd], env: { ...process.env, COZYCLAY_LIVE_PORT: process.env.COZYCLAY_LIVE_PORT || String(5300 + 462) }, timeout: 30 * 60000 });
		if (run.status !== 0) throw new Error(`${basename(args[0])} exited ${run.status ?? run.signal}; see ${logPath}`);
	} finally { closeSync(fd); }
}

/** gt / cube: tools/bench/score.mjs against the rendered GT (with the scene box for cube). */
function scoreAgainstGt({ item, inputs, motionPath, stepDir, options }) {
	const out = join(stepDir, "score");
	const args = [join(HERE, "score.mjs"), "--gt", join(item.dir, item.variant), "--pred", motionPath, "--out", out, "--port", String(options.port), "--cdp-port", String(options.cdpPort)];
	if (inputs.scene) args.push("--box", JSON.stringify(sceneBoxes(inputs.scene).boxes[0]), "--gt-npz", inputs.source);
	runLogged(args, join(stepDir, "score.log"));
	const s = readJson(join(out, "score.json"));
	return {
		ateAlignedRmseM: s.trajectory.ateAlignedM.rmse, rootErrorRawRmseM: s.trajectory.rootErrorRawM.rmse, pathLengthRatio: s.trajectory.pathLengthRatio, displacementRatio: s.trajectory.displacementRatio,
		paMpjpeM: s.pose.paMpjpeM, mpjpeAlignedM: s.pose.mpjpeRootRelativeAlignedM, iouRaw: s.overlap.maskIoURawMean, iouAligned: s.overlap.maskIoUAlignedMean,
		endpointFirstRawM: s.endpoints.firstFrame.jointErrorRawM, endpointLastRawM: s.endpoints.lastFrame.jointErrorRawM, endpointLastAlignedM: s.endpoints.lastFrame.jointErrorAlignedM,
		contact: s.contact ? { predRaw: s.contact.predRaw, gt: s.contact.gt } : null,
	};
}

/** fal: exp3's fal scoring (no motion GT): A/B endpoint joint error, whole-clip box contact, unaligned proxy-mask IoU. */
export function scoreFal({ item, inputs, motionPath, stepDir, options }) {
	const out = join(stepDir, "score"), camera = readJson(inputs.camera), { boxes, placement } = sceneBoxes(inputs.scene);
	const args = [join(ROOT, "tools/gt-render/render.mjs"), "--out", out, "--no-video", "--camera", inputs.camera, "--port", String(options.port), "--cdp-port", String(options.cdpPort)];
	if (placement) args.push("--scene-box", JSON.stringify(placement), "--box", JSON.stringify(boxes[0]));
	args.push(motionPath);
	runLogged(args, join(stepDir, "score.log"));
	const rendered = join(out, basename(motionPath, ".npz"));
	const joints = readJson(join(rendered, "joints.json")), contact = readJson(join(rendered, "contact.json"));
	const ff = (a) => spawnSync("ffmpeg", ["-v", "error", ...a], { maxBuffer: 1 << 30 }).stdout;
	const size = camera.width * camera.height, frames = Number(ffprobe(inputs.video).nb_frames);
	const rgb = ff(["-i", inputs.video, "-f", "rawvideo", "-pix_fmt", "rgb24", "pipe:1"]);
	const plate = item.variant === "skin" ? ff(["-i", join(item.dir, "plate.png"), "-f", "rawvideo", "-pix_fmt", "rgb24", "pipe:1"]) : null;
	const masks = plate ? backgroundDifferenceMask(rgb, plate) : paletteMask(rgb);
	const predMask = ff(["-i", join(rendered, "mask/%06d.png"), "-f", "rawvideo", "-pix_fmt", "gray", "pipe:1"]);
	const count = Math.min(frames, joints.frames);
	const ious = Array.from({ length: count }, (_, i) => maskIoU(masks.subarray(i * size, (i + 1) * size), predMask.subarray(i * size, (i + 1) * size)).iou);
	// A/B as rendered: the GT render's first and last frames only.
	const endpoints = readJson(join(item.dir, item.variant, "joints.json"));
	const score = {
		clip: item.name, variant: item.variant, noMotionGroundTruth: true,
		endpointFirstM: meanJointError(joints.world[0], endpoints.world[0]), endpointLastM: meanJointError(joints.world.at(-1), endpoints.world.at(-1)),
		minDistanceM: contact ? Math.min(...contact.frames.map((v) => v.minDistanceM)) : null, maxPenetrationM: contact ? Math.max(...contact.frames.map((v) => v.maxPenetrationM)) : null,
		contactWindow: "entire clip: fal contact timing is unknown", overlapIoU: mean(ious),
		segmentation: plate ? { method: "background-difference", minChannelDifference: 30, plate: join(item.dir, "plate.png") } : { method: "palette-colour", ...PALETTE_THRESHOLDS },
		comparedFrames: count, sourceFrames: frames, predictionFrames: joints.frames, alignment: "none; fixed A-still camera", cameraAssumption: "no H3 camera drift", scorer: "tools/bench/obs-bench.mjs scoreFal (exp3 fal scoring)",
	};
	putJson(join(out, "score.json"), score);
	return { endpointFirstM: score.endpointFirstM, endpointLastM: score.endpointLastM, minDistanceM: score.minDistanceM, maxPenetrationM: score.maxPenetrationM, iou: score.overlapIoU };
}

export function trackerRigPath(character = "y-bot-tpose") {
	return join(ROOT, "node_modules", ".cache", "cozyfit", `rig-${character}.npz`);
}

function ensureTrackerRig(character, log) {
	const path = trackerRigPath(character);
	if (existsSync(path)) return path;
	mkdirSync(dirname(path), { recursive: true });
	const run = spawnSync(process.execPath, [join(ROOT, "tools/track/export-rig.mjs"), "--model", character, "--out", path], { cwd: ROOT, encoding: "utf8" });
	if (run.status !== 0 || !existsSync(path)) throw new Error(`tracker rig export failed: ${run.stderr || run.stdout}`);
	log(`T1: exported rig ${path}`);
	return path;
}

export async function runT1({ item, inputs, itemDir, stepDir, options, endpoints, g5MotionPath, obsPath, log, trackerRunner = runTracker, masksRunner = ensureMasks } = {}) {
	if (!g5MotionPath || !existsSync(g5MotionPath)) throw new Error("T1: G5 initializer is missing");
	const rigPath = ensureTrackerRig(options.character, log);
	const scenePath = inputs.scene ?? join(itemDir, "empty-scene.json");
	if (!inputs.scene) writeFileSync(scenePath, "[]\n");
	const endpointConfig = Object.fromEntries(endpoints.slice(0, 2).map((endpoint, index) => [index === 0 ? "a" : "b", {
		rootPos: Array.from(endpoint.rootPos),
		rotMats: Array.from(endpoint.rotMats),
	}]));
	const cameraPath = join(stepDir, "camera.json");
	mkdirSync(stepDir, { recursive: true });
	writeFileSync(cameraPath, `${JSON.stringify({ ...readJson(inputs.camera), tracker: { ...(readJson(inputs.camera).tracker ?? {}), endpoints: endpointConfig } }, null, "\t")}\n`);
	const attemptDir = join(stepDir, `tracker-${Date.now()}-${process.pid}`);
	mkdirSync(attemptDir, { recursive: true });
	try {
		const sourceVideo = item.set === "fal" ? inputs.rawVideo : inputs.video;
		const masks = await masksRunner({
			video: sourceVideo,
			obs: obsPath,
			outDir: join(options.obsRoot ?? itemDir, item.set, item.name, "masks"),
			host: options.host,
			log: (line) => log(`T1 masks: ${line}`),
		});
		const deadline = Date.now() + options.gpuWaitMin * 60000;
		let result;
		for (;;) {
			try {
				result = await trackerRunner({
					host: options.host,
					video: sourceVideo,
					obsPath,
					masksPath: masks.path,
					initMotionPath: g5MotionPath,
					cameraPath,
					scenePath,
					rigPath: rigPath,
					outDir: attemptDir,
					onLine: (line) => log(`T1: ${line}`),
				});
				break;
			} catch (error) {
				if (!/gpu-busy/.test(String(error.message)) || Date.now() > deadline) throw error;
				log(`T1: GPU busy; waiting 30 s (${String(error.message).split("\\n").find((line) => /gpu-busy/.test(line))?.trim() ?? error.message})`);
				await sleep(30000);
			}
		}
		if (result.diagnostics?.failure) throw new Error(`tracker failure: ${result.diagnostics.failure}`);
		copyFileSync(result.motionPath, join(stepDir, "motion.npz"));
		copyFileSync(result.diagnosticsPath, join(stepDir, "diagnostics.json"));
		return { diagnostics: result.diagnostics, fallback: null, trackerError: null };
	} catch (error) {
		const step = fallbackStep(endpoints);
		const fallbackDir = join(itemDir, step);
		const fallbackMotion = join(fallbackDir, "motion.npz");
		if (!existsSync(fallbackMotion)) throw new Error(`T1 tracker failed and ${step} motion is unavailable: ${error.message}`);
		copyFileSync(fallbackMotion, join(stepDir, "motion.npz"));
		const details = error instanceof AggregateError && error.errors?.length
			? error.errors.map((cause) => cause?.message ?? String(cause)).join(" | ")
			: error.message;
		return { diagnostics: null, fallback: step, trackerError: { message: details } };
	} finally {
		rmSync(attemptDir, { recursive: true, force: true });
	}
}

async function runItem(item, options, commit) {
	const itemDir = join(options.out, item.set, item.name);
	mkdirSync(itemDir, { recursive: true });
	const label = `${item.set}/${item.name}`;
	const log = (line) => { const text = `[${new Date().toISOString()}] ${line}`; appendFileSync(join(itemDir, "bench.log"), `${text}\n`); console.log(`${label}: ${line}`); };
	const inputs = itemInputs(item, itemDir);
	const pending = options.steps.filter((step) => options.force || !readJson(join(itemDir, step, "result.json"))?.ok);
	for (const step of options.steps.filter((s) => !pending.includes(s))) log(`${step}: skip (result.json ok; --force re-runs)`);
	if (!pending.length) return { failed: 0 };
	if (item.set === "fal") normalizeFalVideo(inputs, log);
	const camera = readJson(inputs.camera);
	const endpoints = readEndpoints(inputs.source);
	const ankle = characterStandingAnkle(endpoints, options.character);
	log(`character ankle plane ${ankle.height.toFixed(4)} m (${options.character}; A/B lower foot ${ankle.perPose.map((h) => h.toFixed(4)).join(", ")})`);
	const ctx = { camera, ankleHeight: ankle.height, endpoints, boxes: sceneBoxes(inputs.scene).boxes };
	const provenance = {};
	const load = async (kind) => {
		const obsRun = await ensureObs({ kind, inputs, itemDir, options, log });
		const obs = readNpz(obsRun.path);
		const rest = ensureRest(Array.from(obs.betas_used.data), options, log);
		provenance[kind] = { obs: obsRun.path, obsSha256: fileSha(obsRun.path), manifest: obsRun.manifest, rest: rest.path, betasUsed: Array.from(obs.betas_used.data) };
		return { obs, rest: rest.rest };
	};
	if (pending.some((s) => !MANNEQUIN_STEPS.has(s))) ctx.base = await load("base");
	if (pending.some((s) => MANNEQUIN_STEPS.has(s))) ctx.mannequin = await load("mannequin");
	const t1ObsPath = ctx.mannequin ? provenance.mannequin.obs : null;
	let failed = 0;
	for (const step of pending) {
		const stepDir = join(itemDir, step), motionPath = join(stepDir, "motion.npz");
		mkdirSync(stepDir, { recursive: true });
		const started = performance.now();
		const result = {
			ok: false, tool: "tools/bench/obs-bench.mjs", commit, createdAt: new Date().toISOString(), item, step,
			inputs: { camera: { path: inputs.camera, sha256: fileSha(inputs.camera) }, video: inputs.video, scene: inputs.scene, ankleHeightM: ctx.ankleHeight, ankle, endpoints: { path: inputs.source, frames: "first and last only" },
				obs: MANNEQUIN_STEPS.has(step) ? provenance.mannequin : provenance.base },
		};
		try {
			if (step === "T1") {
				const g5Path = join(itemDir, "G5", "motion.npz");
				const buildStep = ladderStep;
				if (!existsSync(g5Path)) {
					const g5 = buildStep("G5", ctx);
					mkdirSync(dirname(g5Path), { recursive: true });
					writeNpz(g5Path, motionArraysToNpzMembers(g5.motion));
				}
				const fallbackName = fallbackStep(endpoints), fallbackPath = join(itemDir, fallbackName, "motion.npz");
				if (!existsSync(fallbackPath)) {
					const fallbackBuilt = buildStep(fallbackName, ctx);
					mkdirSync(dirname(fallbackPath), { recursive: true });
					writeNpz(fallbackPath, motionArraysToNpzMembers(fallbackBuilt.motion));
				}
				const tracker = await runT1({ item, inputs, itemDir, stepDir, options, endpoints, g5MotionPath: g5Path, obsPath: t1ObsPath, log });
				result.fallback = tracker.fallback;
				if (tracker.trackerError) result.trackerError = tracker.trackerError;
				if (tracker.diagnostics) {
					result.diagnostics = tracker.diagnostics;
					result.runtimeS = tracker.diagnostics.runtime.trackerSeconds;
					result.peakVramMB = tracker.diagnostics.runtime.peakReservedMiB;
					result.lrSwitches = tracker.diagnostics.lrState.slice(1).filter((v, i) => v !== tracker.diagnostics.lrState[i]).length;
					result.occludedFrames = tracker.diagnostics.occluded.filter((row) => row.some(Boolean)).length;
				}
				result.motion = { path: motionPath };
			} else {
				const built = ladderStep(step, ctx);
				writeNpz(motionPath, motionArraysToNpzMembers(built.motion));
				result.motion = { path: motionPath, frames: built.motion.frames, fps: built.motion.fps };
				result.ladder = built.diagnostics;
			}
			log(`${step}: scoring`);
			result.score = item.set === "fal" ? scoreFal({ item, inputs, motionPath, stepDir, options }) : scoreAgainstGt({ item, inputs, motionPath, stepDir, options });
			result.ok = true;
			log(`${step}: ok ${JSON.stringify(result.score, (k, v) => (typeof v === "number" ? Number(v.toFixed(4)) : v))}`);
		} catch (error) {
			failed += 1;
			result.error = { message: error.message, stack: error.stack };
			log(`${step}: FAILED ${error.message}`);
		}
		result.seconds = (performance.now() - started) / 1000;
		putJson(join(stepDir, "result.json"), result);
	}
	return { failed };
}

export async function main(argv = process.argv.slice(2)) {
	const options = parseArgs(argv);
	if (options.help) { console.log(USAGE); return; }
	const items = selectItems(readJson(options.approved), options.items);
	const commit = commitId();
	let failed = 0;
	for (const item of items) {
		try {
			failed += (await runItem(item, options, commit)).failed;
		} catch (error) {
			failed += 1;
			const itemDir = join(options.out, item.set, item.name);
			mkdirSync(itemDir, { recursive: true });
			appendFileSync(join(itemDir, "bench.log"), `[${new Date().toISOString()}] ITEM FAILED ${error.stack}\n`);
			console.error(`${item.set}/${item.name}: ITEM FAILED ${error.message}`);
		}
	}
	if (failed) {
		console.error(`obs-bench: ${failed} failure(s)`);
		process.exitCode = 1;
	}
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
	main().catch((error) => { console.error(`obs-bench: ${error.stack ?? error}`); process.exitCode = 1; });
}

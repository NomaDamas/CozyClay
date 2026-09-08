/**
 * extract.mjs — the bridge's GPU motion-extraction side. The browser's
 * MediaPipe path is per-frame guessing (jittery, rough blocking only); this
 * route ships the footage to the ARDY box, runs SAM-3D-Body over the whole
 * clip (temporal context, real 3D body prior), converts the returned Mixamo
 * BVH to cskel27 arrays and serves them as an ordinary motion npz — so the
 * app loads a GPU-extracted take through the exact same loadMotion path an
 * ARDY generation uses.
 *
 * Same posture as generation: children die with the client connection, the
 * served npz enters the motion allowlist only after this process wrote and
 * verified it, and every failure is a NAMED reason.
 */

import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { killGroup, track } from "./runners/proc.mjs";
import { EXTRACT_FPS_MAX, conformToExtractFps } from "./footage.mjs";
import { motionArraysToNpzMembers, writeNpz } from "./npz.mjs";
import { bvhToCskel27Motion, parseBvh } from "./bvh-cskel27.mjs";
import { createPrivateArtifactDir, removePrivateArtifactDir } from "./artifacts.mjs";
import { readNpz } from "../kimodo/read-npz.mjs";
import { smplToCskel27Motion } from "./smpl-cskel27.mjs";
import { gvhmrDetectorFromEnv, gvhmrKeypointsFromEnv, gvhmrRunnerArgs, gvhmrWorker } from "./runners/gvhmr-worker.mjs";
import { guardTrajectoryFloor } from "./gvhmr-floor.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const OUT_DIR = join(HERE, "out");
const SAM_DIR = "~/cclay-ingest/SAM3DBody-cpp"; // the box-side checkout the old ingest pipeline left behind
// Non-interactive ssh shells carry no LD_LIBRARY_PATH, and the CUDA EP needs
// the cudnn that lives inside the ingest workspace's venv — without it the
// pipeline silently falls back to CPU and then refuses to load at all.
const SAM_ENV = 'LD_LIBRARY_PATH="$(echo $HOME/cclay-ingest/.venv/lib/python3.12/site-packages/nvidia/*/lib | tr \' \' :)"';
// GVHMR (SIGGRAPH Asia 24) — a VIDEO model, unlike SAM-3D-Body which solves
// every frame on its own with no floor and a monocular root. GVHMR predicts
// in a gravity-aligned world frame with temporal context and per-foot contact
// logits; on a locomotion clip SAM's support foot measured 250 cm/s of skate
// where a planted foot should read 0. The box-side runner
// (cclay_gvhmr_extract.py, kept in the GVHMR checkout) writes GVHMR's SMPL
// joint ROTATIONS (contract: GVHMR-NPZ.md) which smplToCskel27Motion
// retargets directly — lifting positions back to rotations, as the first
// cut did through the ProjFlow converter, discarded wrist orientation and
// limb twist and added 50 % hand jitter on the same clip. Select with
//   CCLAY_EXTRACT_BACKEND=gvhmr   (default: sam)
//   CCLAY_EXTRACT_STATIC_CAM=0    to run visual odometry for a moving camera
//                                 (default 1: tripod footage, skips the VO)
//   CCLAY_EXTRACT_DETECTOR        yolo | palette | auto (default auto) — which
//                                 detector frames the subject for GVHMR.
//                                 YOLO's person class barely sees the
//                                 part-coloured mannequin (#137): 28 of 124
//                                 frames at conf 0.5, against 481/481 for a
//                                 real person. `palette` finds it by its 12
//                                 limb hues instead (124/124 on the same
//                                 clip); `auto` measures the palette first
//                                 and keeps YOLO when the hues are absent.
//   CCLAY_EXTRACT_KEYPOINTS       vitpose | palette | auto (default auto) — auto keeps ViTPose
//     (fed the palette bbox); palette keypoints are opt-in because the AI
//     render shifts limb hues and, measured on issue #180, they make the 3D
//     result worse (foot slide 41 vs 25 cm/s, jitter 32 vs 13).
const EXTRACT_BACKEND = (process.env.CCLAY_EXTRACT_BACKEND?.trim() || "sam").toLowerCase();
const GVHMR_DIR = "~/cclay-ingest/GVHMR";
const GVHMR_STATIC_CAM = (process.env.CCLAY_EXTRACT_STATIC_CAM?.trim() || "1") !== "0";
const GVHMR_DETECTOR = gvhmrDetectorFromEnv();
const GVHMR_KEYPOINTS = gvhmrKeypointsFromEnv();
// Rollback keeps the original one-shot command completely unchanged.
const GVHMR_WORKER = process.env.CCLAY_GVHMR_WORKER?.trim() !== "0";
// Independent of preparation acceleration; disable to recover exact legacy output.
const GVHMR_TRAJECTORY = process.env.CCLAY_GVHMR_TRAJECTORY?.trim() !== "0";
const MAX_UPLOAD_BYTES = 300 * 1024 * 1024;
const EXTRACT_TIMEOUT_MS = 30 * 60 * 1000;
const SSH_BASE_OPTS = ["-o", "BatchMode=yes", "-o", "ConnectTimeout=15"];

// Extraction can run on a DIFFERENT machine than ARDY generation — e.g. a
// Slurm GPU cluster (measured ~5× the default box). Point it there with:
//   CCLAY_EXTRACT_HOST      ssh destination (default: CCLAY_ARDY_HOST)
//   CCLAY_EXTRACT_SSH_PORT  ssh port (default 22)
//   CCLAY_EXTRACT_TMP       REMOTE work dir for video/BVH — must be visible
//                           to the node that runs the job (a Slurm node's
//                           /tmp is node-local, use a shared home path)
//   CCLAY_EXTRACT_CMD       remote command invoked as `CMD <video> <bvh>`;
//                           it owns GPU allocation (srun …) and env. Unset →
//                           the default box invocation below.
function sshHost() {
	return process.env.CCLAY_EXTRACT_HOST?.trim() || process.env.CCLAY_ARDY_HOST?.trim() || "";
}
const EXTRACT_SSH_PORT = process.env.CCLAY_EXTRACT_SSH_PORT?.trim() || "";
const EXTRACT_TMP = process.env.CCLAY_EXTRACT_TMP?.trim() || "/tmp";
const EXTRACT_CMD = process.env.CCLAY_EXTRACT_CMD?.trim() || "";
const SSH_OPTS = EXTRACT_SSH_PORT ? [...SSH_BASE_OPTS, "-p", EXTRACT_SSH_PORT] : SSH_BASE_OPTS;
const SCP_OPTS = EXTRACT_SSH_PORT ? [...SSH_BASE_OPTS, "-P", EXTRACT_SSH_PORT] : SSH_BASE_OPTS;

/** Magic-byte sniff for the three photo formats browsers hand over. Returns
 *  an extension or null for anything else (i.e. actual video bytes). */
function imageExtOf(bytes) {
	if (bytes.length < 12) return null;
	if (bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return "jpg";
	if (bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47) return "png";
	if (bytes.subarray(0, 4).toString("latin1") === "RIFF" && bytes.subarray(8, 12).toString("latin1") === "WEBP") return "webp";
	return null;
}

/** Read a raw binary request body with a hard cap. The bridge's json readBody
 *  is utf-8 and would corrupt video bytes. */
function readVideoBody(req, limitBytes) {
	return new Promise((resolvePromise, reject) => {
		const chunks = [];
		let total = 0;
		req.on("data", (chunk) => {
			total += chunk.length;
			if (total > limitBytes) {
				reject(new Error("extract-upload-too-large"));
				req.destroy();
				return;
			}
			chunks.push(chunk);
		});
		req.on("end", () => resolvePromise(Buffer.concat(chunks)));
		req.on("error", (err) => reject(new Error(`request aborted: ${err.message}`)));
	});
}

function run(command, args, { children, timeoutMs, onLine }) {
	return new Promise((resolvePromise, reject) => {
		const child = spawn(command, args, { detached: true, stdio: ["ignore", "pipe", "pipe"] });
		children.add(child);
		track(child);
		let err = "";
		let buffered = "";
		const timer = timeoutMs
			? setTimeout(() => {
				killGroup(child);
				reject(new Error("extract-timeout"));
			}, timeoutMs)
			: null;
		const feed = (text) => {
			buffered += text;
			const lines = buffered.split(/[\r\n]/);
			buffered = lines.pop() ?? "";
			for (const line of lines) if (line) onLine?.(line);
		};
		child.stdout.on("data", (chunk) => feed(String(chunk)));
		child.stderr.on("data", (chunk) => {
			err += chunk;
			feed(String(chunk));
		});
		child.on("error", (error) => {
			if (timer) clearTimeout(timer);
			children.delete(child);
			reject(new Error(`spawn ${command}: ${error.message}`));
		});
		child.on("close", (code) => {
			if (timer) clearTimeout(timer);
			children.delete(child);
			if (code === 0) resolvePromise();
			else reject(new Error(err.split("\n").filter(Boolean).pop() || `${command} exited ${code}`));
		});
	});
}

/**
 * POST /ardy/extract — input is either JSON {footage:"<id>"} referencing a
 * bridge-downloaded clip, or the raw video bytes themselves. Answer ndjson:
 *   {event:"status", message}                  upload / extract / convert
 *   {event:"progress", stage:"extract", ratio} per-frame GPU movement
 *   {event:"done", motionUrl, frames, fps}
 *   {event:"error", message}                   a NAMED reason
 */
export async function handleExtract(req, res, { readBody, footagePath, registerMotion, artifactRoot = OUT_DIR }) {
	const started = performance.now();
	const host = sshHost();
	const contentType = req.headers["content-type"] ?? "";
	let localVideo = null;
	let uploadedTemp = null;
	let cappedTemp = null;
	let wrappedTemp = null;
	let stillExt = null;
	let artifactDir = null;

	if (/^application\/json\b/.test(contentType)) {
		let body;
		try {
			body = JSON.parse(await readBody(req));
		} catch (err) {
			res.writeHead(400, { "Content-Type": "application/json" });
			res.end(`${JSON.stringify({ ok: false, reason: err.message })}\n`);
			return;
		}
		localVideo = typeof body?.footage === "string" ? footagePath(body.footage) : null;
		if (!localVideo) {
			res.writeHead(404, { "Content-Type": "application/json" });
			res.end(`${JSON.stringify({ ok: false, reason: "extract-footage-unknown" })}\n`);
			return;
		}
	} else {
		let bytes;
		try {
			bytes = await readVideoBody(req, MAX_UPLOAD_BYTES);
		} catch (err) {
			res.writeHead(413, { "Content-Type": "application/json" });
			res.end(`${JSON.stringify({ ok: false, reason: err.message })}\n`);
			return;
		}
		if (bytes.length < 1024) {
			res.writeHead(400, { "Content-Type": "application/json" });
			res.end(`${JSON.stringify({ ok: false, reason: "extract-upload-empty" })}\n`);
			return;
		}
		artifactDir = createPrivateArtifactDir(artifactRoot, "extract");
		// A still photograph rides the same route as footage: it is sniffed by
		// magic bytes (the browser's photo-pose path posts the file untouched)
		// and wrapped into a short constant clip below, so SAM's offline
		// multi-pass pipeline sees ordinary frames instead of a JPEG named .mp4.
		stillExt = imageExtOf(bytes);
		uploadedTemp = join(artifactDir, stillExt ? `upload.${stillExt}` : "upload.mp4");
		writeFileSync(uploadedTemp, bytes);
		localVideo = uploadedTemp;
	}

	res.writeHead(200, { "Content-Type": "application/x-ndjson", "Cache-Control": "no-store" });
	const send = (obj) => {
		if (res.writableEnded) return;
		try {
			res.write(`${JSON.stringify(obj)}\n`);
		} catch {
			/* socket gone */
		}
	};
	const children = new Set();
	const abort = new AbortController();
	const cleanupLocal = () => {
		if (uploadedTemp) rmSync(uploadedTemp, { force: true });
		if (cappedTemp) rmSync(cappedTemp, { force: true });
		if (wrappedTemp) rmSync(wrappedTemp, { force: true });
	};
	const cleanupFailure = () => {
		cleanupLocal();
		if (artifactDir) removePrivateArtifactDir(artifactDir);
	};
	const fail = (message) => {
		send({ event: "error", message });
		res.end();
		cleanupFailure();
	};
	res.on("close", () => {
		if (!res.writableEnded) {
			abort.abort();
			console.error(`[bridge] client disconnected mid-extract; killing ${children.size} child group(s)`);
			for (const child of children) killGroup(child);
			children.clear();
			cleanupFailure();
		}
	});

	if (!host) {
		fail("extract-host-missing");
		return;
	}

	// A still becomes one second of itself at a modest rate: enough identical
	// frames for the offline pipeline's smoothing passes to settle on, few
	// enough that the GPU cost stays near a single frame. 1280 caps upload
	// size; -2 keeps the height even for yuv420p.
	if (stillExt) {
		send({ event: "status", message: "normalizing" });
		wrappedTemp = join(artifactDir, "still.mp4");
		try {
			await run("ffmpeg", [
				"-y", "-loop", "1", "-i", localVideo, "-t", "1", "-r", "12",
				"-vf", "scale='min(1280,iw)':-2,format=yuv420p", "-an", wrappedTemp,
			], { children, timeoutMs: 120000 });
		} catch (err) {
			console.error(`[bridge] still wrap failed: ${err.message}`);
			fail("footage-normalize-failed");
			return;
		}
		localVideo = wrappedTemp;
	}

	const stamp = `${Date.now()}-${randomBytes(3).toString("hex")}`;
	const remoteVideo = `${EXTRACT_TMP}/cclay-extract-${stamp}.mp4`;
	const remoteBvh = `${EXTRACT_TMP}/cclay-extract-${stamp}.bvh`;
	const cleanupRemote = () => {
		run("ssh", [...SSH_OPTS, host, `rm -rf ${remoteVideo} ${remoteBvh} ${remoteBvh.replace(/\.bvh$/, "")}_*.bvh ${remoteBvh.replace(/\.bvh$/, ".npz")} /tmp/cclay-gvhmr-${stamp}`], {
			children: new Set(),
			timeoutMs: 30000,
		}).catch(() => {});
	};

	// Both intake routes converge here, and only here is the rate SAM will see
	// certain: a bridge download was already normalized at the same ceiling
	// (so this probes ≤ the cap and re-encodes nothing — a second encode would
	// cost a generation of quality for no frames removed), while raw bytes
	// posted from the browser are whatever the user's camera shot. Frame rate
	// only: the clip keeps its length and its speed.
	artifactDir ??= createPrivateArtifactDir(artifactRoot, "extract");
	// Claimed before the pass runs, not after it succeeds: a half-written file
	// from an ffmpeg that died mid-encode has to be swept too, and the rm is a
	// no-op when the pass never wrote anything.
	cappedTemp = join(artifactDir, "capped.mp4");
	try {
		const conformed = await conformToExtractFps(localVideo, cappedTemp, {
			children,
			onCap: (fps) => {
				send({ event: "status", message: "normalizing" });
				console.error(`[bridge] extract input capped to ${fps} fps (ceiling ${EXTRACT_FPS_MAX})`);
			},
			onProgress: (ratio) => send({ event: "progress", stage: "normalize", ratio }),
		});
		if (conformed.capped) {
			localVideo = conformed.path;
		} else if (conformed.fps === null) {
			console.error("[bridge] extract input rate unreadable; sending it to the box as it is");
		}
	} catch (err) {
		console.error(`[bridge] extract fps cap failed: ${err.message}`);
		// The same ffmpeg pass the download path runs, so the same named
		// reason — the UI already tells the user a conversion is what broke.
		fail("footage-normalize-failed");
		return;
	}

	try {
		send({ event: "status", message: "uploading" });
		await run("scp", [...SCP_OPTS, localVideo, `${host}:${remoteVideo}`], { children, timeoutMs: 300000 });
	} catch (err) {
		console.error(`[bridge] extract upload failed: ${err.message}`);
		fail("extract-upload-failed");
		return;
	}

	// SAM-3D-Body's OFFLINE multi-pass renderer — the live binary's causal
	// filter lags in phase and skips the repair passes, and measured 80 %
	// more wrist jitter on the same clip. The offline pipeline runs identity
	// tracking, gap fill, spike interpolation (--interpolate-jitter), then
	// ZERO-PHASE forward+backward smoothing at 6 Hz, and --foot-contact's
	// per-foot leg IK pins planted feet against skate. --max-persons 2
	// matches the scene: CozyClay holds two subjects, so the two most
	// confident performers come back (one BVH each) and a single-person clip
	// simply yields one file.
	send({ event: "status", message: "extracting" });
	const gvhmr = EXTRACT_BACKEND === "gvhmr" && !EXTRACT_CMD;
	const remoteNpz = remoteBvh.replace(/\.bvh$/, ".npz");
	let extractionPerformance = null;
	try {
		const remoteCommand = EXTRACT_CMD
			? `${EXTRACT_CMD} ${remoteVideo} ${remoteBvh}`
			: gvhmr
			? `cd ${GVHMR_DIR} && .venv/bin/python cclay_gvhmr_extract.py ${remoteVideo} ${remoteNpz} ` +
				`${gvhmrRunnerArgs({ staticCam: GVHMR_STATIC_CAM, detector: GVHMR_DETECTOR, keypoints: GVHMR_KEYPOINTS }).join(" ")}` +
				` --out-root /tmp/cclay-gvhmr-${stamp}`
			: `cd ${SAM_DIR} && ${SAM_ENV} ./build/offline_sam_3dbody_render ` +
				`--onnx-dir ./onnx --gguf ./onnx/pipeline.gguf --yolo ./onnx/yolo.onnx ` +
				`--from ${remoteVideo} --bvh ${remoteBvh} --bvh-template ./mixamo.bvh --max-persons 2 ` +
				`--smoothing zero-phase --bw-cutoff 6 --interpolate-jitter --foot-contact`;
		const runOptions = {
				children,
				timeoutMs: EXTRACT_TIMEOUT_MS,
				onLine: (line) => {
					// "[pass1]   120 / 514 frames  (eta ~3 s)" — pass1 is the
					// GPU inference and dominates the wall clock.
					const progress = /\[pass1\]\s+(\d+)\s*\/\s*(\d+) frames/.exec(line);
					if (progress && Number(progress[2]) > 0) {
						send({ event: "progress", stage: "extract", ratio: Math.min(1, Number(progress[1]) / Number(progress[2])) });
					}
					// GVHMR's runner logs "[cclay] stage <name>" — four preprocess
					// stages then the model; a coarse ratio is better than none.
					const stage = /\[cclay\] stage (\w+)/.exec(line);
					if (stage) {
						const order = ["track", "vitpose", "features", "camera", "gvhmr", "joints"];
						const at = order.indexOf(stage[1]);
						if (at >= 0) send({ event: "progress", stage: "extract", ratio: at / order.length });
					}
				},
		};
		if (gvhmr && GVHMR_WORKER) {
			extractionPerformance = await gvhmrWorker({ host, sshOptions: SSH_OPTS, scpOptions: SCP_OPTS }).run({
				video: remoteVideo, output: remoteNpz, outRoot: `/tmp/cclay-gvhmr-${stamp}`, staticCam: GVHMR_STATIC_CAM,
				detector: GVHMR_DETECTOR, keypoints: GVHMR_KEYPOINTS, trajectory: GVHMR_TRAJECTORY,
			}, { signal: abort.signal, timeoutMs: EXTRACT_TIMEOUT_MS, onLine: runOptions.onLine });
			console.error(`[bridge] GVHMR performance ${JSON.stringify(extractionPerformance)}`);
		} else {
			await run("ssh", [...SSH_OPTS, host, remoteCommand], runOptions);
		}
	} catch (err) {
		console.error(`[bridge] extract run failed: ${err.message}`);
		cleanupRemote();
		fail(err.message === "extract-worker-busy" ? err.message : "extract-run-failed");
		return;
	}

	send({ event: "status", message: "converting" });
	// One BVH per tracked person. Person 0 must exist; person 1 is optional
	// (a single-person clip yields one file, and that is not an error).
	const motions = [];
	if (gvhmr) {
		// GVHMR's demo tracker follows ONE person, so exactly one npz comes back.
		const localNpz = join(artifactDir, "gvhmr.npz");
		try {
			await run("scp", [...SCP_OPTS, `${host}:${remoteNpz}`, localNpz], { children, timeoutMs: 120000 });
		} catch (err) {
			console.error(`[bridge] extract fetch failed: ${err.message}`);
			cleanupRemote();
			fail("extract-no-person");
			return;
		}
		try {
			const converted = smplToCskel27Motion(readNpz(localNpz));
			const guarded = guardTrajectoryFloor(converted, extractionPerformance?.trajectory?.events ?? []);
			motions.push(guarded.motion);
			if (extractionPerformance?.trajectory?.events?.length) extractionPerformance.trajectory.floor = guarded.diagnostics;
		} catch (err) {
			console.error(`[bridge] extract convert failed (gvhmr): ${err.message}`);
			cleanupRemote();
			fail("extract-convert-failed");
			return;
		} finally {
			rmSync(localNpz, { force: true });
		}
	}
	for (let person = 0; person < (gvhmr ? 0 : 2); person += 1) {
		const localBvh = join(artifactDir, `person-${person}.bvh`);
		try {
			await run("scp", [...SCP_OPTS, `${host}:${remoteBvh.replace(/\.bvh$/, "")}_${person}.bvh`, localBvh], {
				children,
				timeoutMs: 120000,
			});
		} catch (err) {
			if (person === 0) {
				console.error(`[bridge] extract fetch failed: ${err.message}`);
				cleanupRemote();
				fail("extract-no-person");
				return;
			}
			break;
		}
		try {
			motions.push(bvhToCskel27Motion(parseBvh(readFileSync(localBvh, "utf8"))));
		} catch (err) {
			console.error(`[bridge] extract convert failed (person ${person}): ${err.message}`);
			if (person === 0) {
				cleanupRemote();
				fail("extract-convert-failed");
				return;
			}
		} finally {
			rmSync(localBvh, { force: true });
		}
	}
	cleanupRemote();
	cleanupLocal();

	const takes = [];
	for (let person = 0; person < motions.length; person += 1) {
		const motion = motions[person];
		const id = person === 0 ? stamp : `${Date.now()}-${randomBytes(3).toString("hex")}`;
		const npzPath = join(artifactDir, `motion-${person}.npz`);
		try {
			// motion.personScale goes into the archive as `person_scale`: the
			// conversion divided this person's root travel by it, so the take
			// is only metrically right when the character is scaled by the same
			// number. Shipping it in the response alone would let a reload —
			// or any other path to the same npz — replay the stride at
			// canonical size. The response keeps the field for older clients.
			writeNpz(npzPath, motionArraysToNpzMembers(motion));
		} catch (err) {
			console.error(`[bridge] extract npz write failed (person ${person}): ${err.message}`);
			if (person === 0) {
				fail("extract-convert-failed");
				return;
			}
			continue;
		}
		registerMotion(id, npzPath);
		takes.push({
			motionUrl: `/ardy/motions/${id}`,
			frames: motion.frames,
			fps: motion.fps,
			personScale: motion.personScale,
			// person 1's placement RELATIVE to person 0, in the shared raw
			// camera space (real metres, X/Z on the floor plane).
			offsetX: person === 0 ? 0 : motion.rawRootStart[0] - motions[0].rawRootStart[0],
			offsetZ: person === 0 ? 0 : motion.rawRootStart[2] - motions[0].rawRootStart[2],
		});
	}
	send({
		event: "done",
		motionUrl: takes[0].motionUrl,
		frames: takes[0].frames,
		fps: takes[0].fps,
		personScale: takes[0].personScale,
		takes,
		...(extractionPerformance ? { performance: { ...extractionPerformance, totalSeconds: (performance.now() - started) / 1000 } } : {}),
	});
	res.end();
}

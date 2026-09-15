/**
 * runner.mjs — Kimodo backend for the generation bridge.
 *
 * Implements the same runner surface as tools/ardy/runners/{local,remote}.mjs
 * ({ mode, describe, probeHealth, listBases, singleCommand, sequenceCommand,
 * editCommand }) so bridge.mjs needs no backend-specific branch: it spawns the
 * returned command and greps its `done - <path> (<bytes>)` line exactly as it
 * does for ARDY.
 *
 * WHAT THIS BACKEND DOES NOT DO. Kimodo is wired here for text-to-motion
 * sequencing, root 2D paths, pinned poses, motion edit and scheduled
 * inpainting. Base clips remain ARDY-specific machinery in this repo (a base
 * clip is autoregressive history, which Kimodo has no input for) and refuse by
 * name instead of silently producing a take that ignored them.
 *
 * HOW SCHEDULED INPAINTING TRAVELS. Between this runner and the code that
 * actually builds the kimodo_gen command line (tools/kimodo/generate.mjs) sit
 * the two wrapper scripts run-sequence-on-box.mjs and run-edit-on-box.mjs,
 * whose argv is a stable contract shared with the ARDY wrappers. Preserve
 * inputs therefore ride the ENVIRONMENT, which is the channel every other
 * Kimodo tunable already uses (CCLAY_KIMODO_GEN_FPS, _DIFFUSION_STEPS,
 * _TRANSITION_FRAMES ...):
 *
 *   CCLAY_KIMODO_PRESERVE     JSON {basePath, sigmaS, sigmaE, strength,
 *                             editRanges, maskPath, rootFree}
 *   CCLAY_KIMODO_NATIVE_OUT   where this run keeps Kimodo's own npz, so a LATER
 *                             run can preserve from it
 *
 * The round-2 additions ride the same channel untouched: `editRanges[i].tracks`
 * scopes a range to its mask groups, and `rootFree` (set by the bridge when the
 * request also carries waypoints) frees the mask's `root` group for the whole
 * clip so the authored path owns the trajectory. Neither needs a flag here —
 * boxEnv forwards the preserve object verbatim and generate.mjs is the only
 * layer that interprets it. Waypoints themselves still travel on ARGV
 * (`--root-2d`), so a preserve + waypoints run uses BOTH channels at once; that
 * is why they compose without a merge step.
 */

import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { existsSync, readFileSync } from "node:fs";
import { spawn } from "node:child_process";

const HERE = dirname(fileURLToPath(import.meta.url));
const RUN_SEQUENCE = join(HERE, "run-sequence-on-box.mjs");
const RUN_EDIT = join(HERE, "run-edit-on-box.mjs");

const SSH_OPTS = ["-o", "BatchMode=yes", "-o", "ConnectTimeout=10"];

function run(argv, timeoutMs = 60_000) {
	return new Promise((resolve) => {
		const child = spawn(argv[0], argv.slice(1), { stdio: ["ignore", "pipe", "pipe"] });
		let stdout = "";
		let stderr = "";
		const timer = setTimeout(() => child.kill("SIGKILL"), timeoutMs);
		child.stdout.on("data", (c) => (stdout += c));
		child.stderr.on("data", (c) => (stderr += c));
		child.on("close", (code) => {
			clearTimeout(timer);
			resolve({ code, stdout, stderr });
		});
	});
}

/**
 * Where a run whose bridge output is `outputPath` keeps Kimodo's OWN npz.
 *
 * `--base_motion` reads the format kimodo_gen writes (77-joint somaskel, no fps
 * member); the file the bridge serves at /ardy/motions/<id> is the cskel27
 * conversion of it and cannot be fed back in. One place decides this name:
 * generate.mjs writes the file, baseMotionFor finds it again.
 */
export function nativeMotionPath(outputPath) {
	return `${String(outputPath).replace(/\.npz$/i, "")}.kimodo.npz`;
}

/** The preserve mask this run ships, kept beside the take for inspection. */
export function preserveMaskPath(outputPath) {
	return join(dirname(outputPath), "preserve-mask.json");
}

function unsupported(feature) {
	return () => {
		throw new Error(
			`the Kimodo backend does not implement ${feature}`
		);
	};
}

export function createKimodoRunner() {
	const HOST = process.env.CCLAY_KIMODO_HOST || "";
	let installed = {};
	try { installed = JSON.parse(readFileSync(process.env.CCLAY_KIMODO_BACKEND_FILE || `${process.env.HOME || ""}/.cozyclay/kimodo-backend.json`, "utf8")); } catch {}
	const BACKEND = process.env.CCLAY_KIMODO_BACKEND || installed.backend || "nvidia-cuda";
	const REPO = process.env.CCLAY_KIMODO_REPO || (BACKEND === "kimodo-mlx" ? "$HOME/.cozyclay/kimodo-mlx" : BACKEND.startsWith("kimodo.cpp") ? "$HOME/.cozyclay/kimodo.cpp" : "$HOME/.cozyclay/kimodo");
	const MODEL = process.env.CCLAY_KIMODO_MODEL || installed.model || "Kimodo-SOMA-RP-v1.1";
	const MOTION = process.env.CCLAY_KIMODO_MLX_MOTION || process.env.CCLAY_KIMODO_CPP_MOTION_GGUF || installed.motion || "";
	const TEXT = process.env.CCLAY_KIMODO_MLX_TEXT || process.env.CCLAY_KIMODO_CPP_TEXT_BUNDLE || installed.text || "";
	const TARGET_FPS = Number(process.env.CCLAY_KIMODO_TARGET_FPS || 24);

	if (!HOST && BACKEND === "nvidia-cuda") {
		throw new Error("CCLAY_KIMODO_HOST is required for the Kimodo backend (for example: user@gpu-box)");
	}

	async function probeHealth() {
		if (!HOST) return { ok: true, host: "local", encoder: "in-process", device: "local" };
		const remote = [
			`cd ${REPO}`,
			`DEV="$(.venv/bin/python -c 'import torch; print("cuda:0" if torch.cuda.is_available() else "cpu")')"`,
			`printf 'device=%s\\n' "$DEV"`,
		].join(" && ");
		const { code, stdout, stderr } = await run(["ssh", ...SSH_OPTS, HOST, remote]);
		if (code !== 0) {
			throw new Error(`ssh probe on ${HOST} failed (exit ${code}): ${stderr.trim().split("\n").pop()}`);
		}
		const device = /^device=(.*)$/m.exec(stdout)?.[1] ?? "unknown";
		// Kimodo needs no separate encoder sidecar: the text encoder loads in
		// the generation process (on the CPU by default here), so health has
		// nothing to report for it and says so rather than faking a port.
		return { ok: true, host: HOST, encoder: "in-process", device };
	}

	// Kimodo generates from text and constraints only — it takes no base clip,
	// so there is nothing to list. An empty listing is a valid answer, not a
	// failure, and the bridge already tolerates it.
	async function listBases() {
		return [];
	}

	// The environment every box wrapper inherits. Scheduled inpainting is
	// carried here rather than on argv (see the header); both keys are DELETED
	// when this run does not want them, because process.env is inherited from a
	// long-lived sidecar and a leftover value would silently preserve the wrong
	// take on the next request.
	function boxEnv({ output, keepNative = false, preserve = null } = {}) {
		const env = {
			...process.env,
			CCLAY_KIMODO_HOST: HOST,
			CCLAY_KIMODO_REPO: REPO,
			CCLAY_KIMODO_MODEL: MODEL,
			...(MOTION ? { CCLAY_KIMODO_MLX_MOTION: MOTION, CCLAY_KIMODO_CPP_MOTION_GGUF: MOTION } : {}),
			...(TEXT ? { CCLAY_KIMODO_MLX_TEXT: TEXT, CCLAY_KIMODO_CPP_TEXT_BUNDLE: TEXT } : {}),
		};
		delete env.CCLAY_KIMODO_NATIVE_OUT;
		delete env.CCLAY_KIMODO_PRESERVE;
		if (keepNative && output) env.CCLAY_KIMODO_NATIVE_OUT = nativeMotionPath(output);
		if (preserve && output) {
			// `preserve.basePath` is a take to reconstruct, NOT the ARDY `basePath`
			// (autoregressive history) that singleCommand still refuses below.
			env.CCLAY_KIMODO_PRESERVE = JSON.stringify({ ...preserve, maskPath: preserveMaskPath(output) });
		}
		return env;
	}

	// Which artifact of an earlier run can serve as this backend's preserve
	// base, or null when that take has none — it was spliced together rather
	// than generated whole, or it predates scheduled inpainting. The bridge
	// degrades to a plain generation and says so on the status stream.
	function baseMotionFor(motionPath) {
		const native = nativeMotionPath(motionPath);
		return existsSync(native) ? native : null;
	}

	function sequenceCommand({ segments, waypoints, poseFroms, seed, output, keepNative, preserve }) {
		const args = [RUN_SEQUENCE];
		for (const segment of segments) {
			args.push("--segment", segment.prompt, String(segment.durationS));
		}
		// Root waypoints become a Kimodo root2d constraint downstream; the same
		// 4-token shape the ARDY wrapper takes, so the bridge passes them through
		// unchanged regardless of backend.
		for (const waypoint of waypoints || []) {
			args.push(
				"--root-2d",
				String(waypoint.frame),
				String(waypoint.x),
				String(waypoint.z),
				waypoint.heading === null || waypoint.heading === undefined ? "none" : String(waypoint.heading)
			);
		}
		for (const entry of poseFroms || []) {
			args.push("--pose", entry.npz, String(entry.dstFrame));
		}
		if (Number.isInteger(seed)) args.push("--seed", String(seed));
		args.push("--target-fps", String(TARGET_FPS), "--output", output);
		return {
			command: process.execPath,
			args,
			env: boxEnv({ output, keepNative, preserve }),
			doneRe: /^run-kimodo-sequence: done - (.+) \((\d+) bytes\)$/,
			label: "run-kimodo-sequence",
		};
	}

	// A single prompt is just a one-segment sequence, but only when the request
	// carries none of the ARDY-only conditioning.
	function singleCommand({ prompt, durationS, seed, output, basePath, poseFroms, waypoints, keepNative, preserve }) {
		if (basePath) throw new Error("the Kimodo backend does not implement base clips");
		return sequenceCommand({
			segments: [{ prompt, durationS }],
			waypoints,
			keepNative,
			preserve,
			// Pinned poses become Kimodo `fullbody` constraints downstream. The
			// bridge hands them over as npz paths plus the clip frame to pin them
			// at; src-frame is an ARDY concept (which frame of a multi-frame npz to
			// read) and a cclay pose npz always holds exactly one.
			poseFroms,
			seed,
			output,
		});
	}

	// Regenerating a span is a whole-clip generation pinned to the source take on
	// both sides of the edit, then spliced back — Kimodo has no history input, so
	// the surrounding motion is expressed as constraints instead.
	function editCommand({ source, manifest, prompt, contextBefore, contextAfter, seed, output, preserve }) {
		const args = [
			RUN_EDIT,
			"--source", source,
			"--manifest", manifest,
			"--prompt", prompt,
			"--context-before", String(contextBefore ?? 0),
			"--context-after", String(contextAfter ?? 0),
			"--target-fps", String(TARGET_FPS),
		];
		if (Number.isInteger(seed)) args.push("--seed", String(seed));
		args.push("--output", output);
		return {
			command: process.execPath,
			args,
			// An edit SPLICES its regenerated span into the source take, so the
			// npz Kimodo wrote is not the take that comes out and must never be
			// kept as a base — keepNative stays off here. Preserving one is a
			// different direction and fully supported.
			env: boxEnv({ output, keepNative: false, preserve }),
			doneRe: /^run-kimodo-edit: done - (.+) \((\d+) bytes\)$/,
			label: "run-kimodo-edit",
		};
	}

	return {
		mode: "kimodo",
		describe: () => `${HOST ? `box ${HOST}` : "local"} (${BACKEND}, repo ${REPO}, model ${MODEL}, retimed to ${TARGET_FPS} fps)`,
		probeHealth,
		listBases,
		baseMotionFor,
		singleCommand,
		sequenceCommand,
		editCommand,
	};
}

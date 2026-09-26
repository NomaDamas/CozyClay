import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { createRunner } from "../tools/ardy/runners/index.mjs";
import { createKimodoRunner } from "../tools/kimodo/runner.mjs";
import { buildBackendCommand, generateOnBox } from "../tools/kimodo/generate.mjs";
import { readKimodoMotion, readNpz } from "../tools/kimodo/read-npz.mjs";
import { motionArraysToNpzMembers, writeNpz } from "../tools/ardy/npz.mjs";

function pass(label) { console.log(`PASS ${label}`); }

const SAVED = { ...process.env };
function withEnv(env, body) {
	for (const key of ["CCLAY_MOTION_BACKEND", "CCLAY_KIMODO_HOST"]) {
		delete process.env[key];
	}
	Object.assign(process.env, env);
	try {
		return body();
	} finally {
		for (const key of ["CCLAY_MOTION_BACKEND", "CCLAY_KIMODO_HOST", ...Object.keys(env)]) {
			delete process.env[key];
		}
		Object.assign(process.env, SAVED);
	}
}

const KIMODO_BOX = { CCLAY_KIMODO_HOST: "user@kimodo-box" };

// ---- Kimodo is the default -----------------------------------------------
assert.equal(withEnv(KIMODO_BOX, () => createRunner().mode), "kimodo");
pass("Kimodo is the default backend when a Kimodo host is configured");

// ---- explicit Kimodo selection --------------------------------------------
assert.equal(withEnv({ ...KIMODO_BOX, CCLAY_MOTION_BACKEND: "kimodo" }, () => createRunner().mode), "kimodo");
assert.equal(withEnv({ ...KIMODO_BOX, CCLAY_MOTION_BACKEND: "KIMODO" }, () => createRunner().mode), "kimodo");
pass("CCLAY_MOTION_BACKEND=kimodo selects the Kimodo runner");

// ---- stale backend names are refused --------------------------------------
assert.throws(
	() => withEnv({ ...KIMODO_BOX, CCLAY_MOTION_BACKEND: "ardy" }, () => createRunner()),
	/unknown CCLAY_MOTION_BACKEND "ardy"/
);
pass("the removed ARDY backend name is refused");

assert.throws(
	() => withEnv({ ...KIMODO_BOX, CCLAY_MOTION_BACKEND: "kimono" }, () => createRunner()),
	/unknown CCLAY_MOTION_BACKEND "kimono"/
);
pass("an unknown backend name is refused");

// ---- the Kimodo runner satisfies the interface the bridge calls -----------
const runner = withEnv({ ...KIMODO_BOX, CCLAY_MOTION_BACKEND: "kimodo" }, () => createRunner());
for (const method of ["probeHealth", "listBases", "singleCommand", "sequenceCommand", "editCommand"]) {
	assert.equal(typeof runner[method], "function", `runner must expose ${method}`);
}
assert.equal(typeof runner.describe(), "string");
pass("the Kimodo runner exposes every method bridge.mjs calls");

// ---- sequenceCommand is spawnable and matches its own doneRe --------------
const cmd = runner.sequenceCommand({
	segments: [
		{ prompt: "A person runs forward", durationS: 3 },
		{ prompt: "A person walks", durationS: 2 },
	],
	seed: 7,
	output: "/tmp/out.npz",
});
assert.ok(cmd.args.includes("--segment"));
assert.ok(cmd.args.includes("A person runs forward"));
assert.ok(cmd.args.includes("--output") && cmd.args.includes("/tmp/out.npz"));
assert.ok(cmd.args.includes("--seed") && cmd.args.includes("7"));
assert.ok(cmd.args.includes("--target-fps") && cmd.args.includes("24"));
assert.match("run-kimodo-sequence: done - /tmp/out.npz (12 bytes)", cmd.doneRe);
// The bridge parses the path and byte count out of that line.
const parsed = cmd.doneRe.exec("run-kimodo-sequence: done - /tmp/out.npz (12 bytes)");
assert.equal(parsed[1], "/tmp/out.npz");
assert.equal(parsed[2], "12");
pass("sequenceCommand builds a spawnable command whose done line the bridge can parse");

// ---- root waypoints are forwarded, not refused ----------------------------
// They become a Kimodo root2d constraint downstream. The --root-2d tokens must
// match the historical bridge wire shape so the bridge stays stable, and a
// null heading must serialise as the literal "none" rather than "null".
const pathed = runner.sequenceCommand({
	segments: [{ prompt: "A person walks", durationS: 3 }],
	waypoints: [
		{ frame: 0, x: 0, z: 0, heading: null },
		{ frame: 30, x: 1.5, z: 2, heading: 0.5 },
	],
	output: "/tmp/o.npz",
});
const rootFlagAt = pathed.args.indexOf("--root-2d");
assert.ok(rootFlagAt >= 0, "waypoints must reach the CLI as --root-2d");
assert.deepEqual(pathed.args.slice(rootFlagAt, rootFlagAt + 5), ["--root-2d", "0", "0", "0", "none"]);
assert.equal(pathed.args.filter((a) => a === "--root-2d").length, 2, "every waypoint must be forwarded");
assert.ok(pathed.args.includes("0.5"), "an authored heading must survive as a number");
pass("root waypoints are forwarded as --root-2d instead of refused");

// ---- unsupported paths STILL refuse by name -------------------------------
// Silently generating a take that ignored a pinned pose would be worse than
// refusing. This guards the waypoint work from unlocking constraint paths that
// were never built.
// A base clip is autoregressive history, which Kimodo has no input for, so it
// stays refused. This is the last unbuilt path and must not be unlocked by
// accident when a neighbouring feature lands.
assert.throws(
	() => runner.singleCommand({ prompt: "x", durationS: 1, basePath: "/base.npz", output: "/tmp/o.npz" }),
	/does not implement base clips/
);
pass("base clips still refuse by name rather than generating a wrong take");

// ---- motion edit is implemented -------------------------------------------
const edit = runner.editCommand({
	source: "/tmp/src.npz",
	manifest: "/tmp/edit-manifest.json",
	prompt: "A person waves",
	contextBefore: 8,
	contextAfter: 8,
	seed: 3,
	output: "/tmp/edited.npz",
});
assert.ok(edit.args.includes("--source") && edit.args.includes("/tmp/src.npz"));
assert.ok(edit.args.includes("--manifest") && edit.args.includes("/tmp/edit-manifest.json"));
assert.ok(edit.args.includes("--context-before") && edit.args.includes("8"));
assert.equal(edit.label, "run-kimodo-edit");
const editDone = edit.doneRe.exec("run-kimodo-edit: done - /tmp/edited.npz (42 bytes)");
assert.ok(editDone, "the bridge must be able to parse the edit done line");
assert.equal(editDone[1], "/tmp/edited.npz");
assert.equal(editDone[2], "42");
pass("editCommand builds a spawnable command whose done line the bridge can parse");

// ---- pinned poses are forwarded, not refused ------------------------------
// They become Kimodo `fullbody` constraints downstream. Each pose reaches the
// CLI as its npz path plus the clip frame to pin it at.
const pinned = runner.singleCommand({
	prompt: "A person kneels",
	durationS: 4,
	poseFroms: [
		{ npz: "/tmp/pose-a.npz", srcFrame: 0, dstFrame: 40 },
		{ npz: "/tmp/pose-b.npz", srcFrame: 0, dstFrame: 70 },
	],
	output: "/tmp/o.npz",
});
const poseAt = pinned.args.indexOf("--pose");
assert.ok(poseAt >= 0, "pinned poses must reach the CLI as --pose");
assert.deepEqual(pinned.args.slice(poseAt, poseAt + 3), ["--pose", "/tmp/pose-a.npz", "40"]);
assert.equal(pinned.args.filter((a) => a === "--pose").length, 2, "every pinned pose must be forwarded");
assert.ok(pinned.args.includes("/tmp/pose-b.npz") && pinned.args.includes("70"));
pass("pinned poses are forwarded as --pose instead of refused");

// ---- a single prompt is a one-segment sequence ----------------------------
const single = runner.singleCommand({ prompt: "A person waves", durationS: 2, output: "/tmp/o.npz" });
assert.ok(single.args.includes("A person waves"));
assert.equal(single.args.filter((a) => a === "--segment").length, 1);
pass("singleCommand degenerates to a one-segment sequence");

// ---- the backend needs a host ---------------------------------------------
assert.throws(
	() => withEnv({ CCLAY_MOTION_BACKEND: "kimodo" }, () => createKimodoRunner()),
	/CCLAY_KIMODO_HOST is required/
);
for (const backend of ["kimodo-mlx", "kimodo.cpp-metal", "kimodo.cpp-cpu"]) {
	const local = withEnv({ CCLAY_MOTION_BACKEND: "kimodo", CCLAY_KIMODO_BACKEND: backend }, () => createKimodoRunner());
	assert.match(local.describe(), /local/);
}
pass("CUDA requires a host while MLX/cpp runners are local and describe themselves as local");

// Exact argv contracts for every installed route.
const cuda = buildBackendCommand({ backend: "nvidia-cuda", repo: "/opt/kimodo", model: "m", prompt: "walk", duration: "2", frames: 60, steps: 10, seed: 7, output: "/tmp/take" });
assert.equal(cuda.command, "/opt/kimodo/.venv/bin/kimodo_gen");
assert.deepEqual(cuda.args, ["walk", "--duration", "2", "--diffusion_steps", "10", "--model", "m", "--seed", "7", "--output", "/tmp/take"]);
const mlx = buildBackendCommand({ backend: "kimodo-mlx", repo: "/opt/mlx", prompt: "walk", frames: 60, steps: 10, output: "/tmp/take" });
assert.deepEqual(mlx.args, ["-m", "kimodo_mlx", "generate", "--prompt", "walk", "--motion", "$HOME/.cozyclay/kimodo-mlx/models/nvidia-soma-rp-v1.1", "--text", "$HOME/.cozyclay/kimodo-mlx/models/llm2vec-text-bundle", "--frames", "60", "--steps", "10"]);
for (const backend of ["kimodo.cpp-metal", "kimodo.cpp-cpu"]) {
  const cpp = buildBackendCommand({ backend, repo: "/opt/cpp", prompt: "walk", frames: 60, steps: 10, output: "/tmp/take" });
  assert.deepEqual(cpp.args, ["$HOME/.cozyclay/kimodo.cpp/models/kimodo-soma-rp-v1.1-f32.gguf", "$HOME/.cozyclay/kimodo.cpp/generated/llm2vec-text-bundle", "$HOME/.cozyclay/kimodo.cpp/prompt.txt", "60", "10", "42", "/tmp/take"]);
  const seeded = buildBackendCommand({ backend, repo: "/opt/cpp", frames: 2, steps: 1, seed: 7, motionWeights: "/motion.gguf", textBundle: "/text", promptFile: "/prompt.txt", outputDir: "/output" });
  assert.deepEqual(seeded.args, ["/motion.gguf", "/text", "/prompt.txt", "2", "1", "7", "/output"]);
}
pass("all installed Kimodo backends have exact command contracts");

// Given: real little-endian local files, with identity and a 90-degree root yaw.
// Only the external generator is faked; both NPZ formats and retargeting are real.
const localFixture = mkdtempSync(join(tmpdir(), "kimodo-runner-test-"));
try {
	for (const backend of ["kimodo.cpp-metal", "kimodo.cpp-cpu", "kimodo-mlx"]) {
		let outputDir;
		const nativeOut = join(localFixture, `${backend}.kimodo.npz`);
		const lines = [];
		const spawnImpl = (command, args, options) => {
			assert.equal(options.cwd, "/fixture repo");
			if (backend === "kimodo-mlx") {
				assert.equal(command, `${process.env.HOME}/.cozyclay/kimodo-mlx-venv/bin/python`);
				assert.equal(args[0], fileURLToPath(new URL("../tools/kimodo/mlx-generate.py", import.meta.url)));
				assert.equal(args[args.indexOf("--prompt") + 1], "A person walks.");
				assert.equal(args[args.indexOf("--frames") + 1], "2");
				assert.equal(args[args.indexOf("--steps") + 1], "1");
				assert.equal(args[args.indexOf("--seed") + 1], "7");
				assert.ok(args.includes("--output-dir"));
				outputDir = args[args.indexOf("--output-dir") + 1];
			} else {
				assert.equal(command, `/fixture repo/${backend.endsWith("metal") ? "build-metal" : "build-cpu"}/kmd-generate`);
				assert.equal(args.length, 7, "cpp accepts only positional arguments");
				assert.equal(args[3], "2");
				assert.equal(args[4], "1");
				assert.equal(args[5], "7");
				assert.equal(readFileSync(args[2], "utf8"), "A person walks.\n");
				outputDir = args[6];
			}
			const roots = Buffer.alloc(2 * 3 * 4);
			[0, 1, 0, 0.25, 1, -0.5].forEach((value, index) => roots.writeFloatLE(value, index * 4));
			const rotations = Buffer.alloc(2 * 30 * 4 * 4);
			for (let joint = 0; joint < 2 * 30; joint += 1) rotations.writeFloatLE(1, (joint * 4 + 3) * 4);
			rotations.writeFloatLE(Math.SQRT1_2, (30 * 4 + 1) * 4);
			rotations.writeFloatLE(Math.SQRT1_2, (30 * 4 + 3) * 4);
			writeFileSync(join(outputDir, "root_positions.f32"), roots);
			writeFileSync(join(outputDir, "local_rotations_xyzw.f32"), rotations);
			const child = new EventEmitter();
			child.stdout = new EventEmitter();
			child.stderr = new EventEmitter();
			queueMicrotask(() => {
				child.stdout.emit("data", Buffer.from("generated 2 frames with 30 joints\n"));
				child.emit("close", 0);
			});
			return child;
		};
		// When: the local route runs through the existing Studio conversion.
		const result = await generateOnBox({
			backend, host: "", repo: "/fixture repo", segments: [{ prompt: "A person walks", duration: 2 / 30 }],
			diffusionSteps: 1, seed: 7, preserve: null, nativeOut, spawnImpl, onLine: (line) => lines.push(line),
		});
		// Then: the saved native take and the final Studio file contain real motion.
		assert.deepEqual(result.raw, { frames: 2, joints: 77, fps: 30 });
		assert.equal(result.nativeNpz, nativeOut);
		assert.ok(result.npzBytes > 0);
		assert.deepEqual(lines, ["generated 2 frames with 30 joints"]);
		assert.equal(existsSync(outputDir), false, "temporary runtime outputs are cleaned");
		const native = readKimodoMotion(nativeOut);
		assert.deepEqual(Array.from(native.posedJoints.slice(77 * 3, 77 * 3 + 3)), [0.25, 1, -0.5]);
		const yaw = [0, 0, 1, 0, 1, 0, -1, 0, 0];
		for (let i = 0; i < 9; i += 1) {
			assert.ok(Math.abs(native.globalRotMats[77 * 9 + i] - yaw[i]) < 1e-6);
			assert.ok(Math.abs(result.motion.rotMats[27 * 9 + i] - yaw[i]) < 1e-6);
		}
		const studioOut = join(localFixture, `${backend}.npz`);
		writeNpz(studioOut, motionArraysToNpzMembers(result.motion));
		const studio = readNpz(studioOut);
		assert.deepEqual(studio.posed_joints.shape, [2, 27, 3]);
		assert.deepEqual(studio.local_rot_mats.shape, [2, 27, 3, 3]);
		assert.ok(studio.posed_joints.data.every(Number.isFinite));
		assert.ok(result.motion.rootPos[3] > result.motion.rootPos[0]);
		pass(`${backend} f32 outputs reach native SOMA77 and Studio cskel27 NPZ`);
	}
	const localRequest = {
		backend: "kimodo.cpp-cpu", host: "", repo: "/fixture repo",
		segments: [{ prompt: "walk", duration: 1 }], preserve: null, nativeOut: "",
	};
	for (const extra of [
		{ segments: [{ prompt: "walk", duration: 1 }, { prompt: "run", duration: 1 }] },
		{ waypoints: [{ frame: 0, x: 0, z: 0 }, { frame: 24, x: 1, z: 1 }] },
		{ poses: [{ frame: 0 }] },
		{ preserve: { basePath: "/base.npz", sigmaS: 900, sigmaE: 100 } },
	]) {
		await assert.rejects(generateOnBox({
			...localRequest, ...extra,
			spawnImpl: () => assert.fail("unsupported local conditioning must not spawn"),
		}), /local.*single.*unconstrained/i);
	}
	pass("local routes refuse unsupported conditioning instead of ignoring it");

	const spawnError = Object.assign(new Error("fixture executable missing"), { code: "ENOENT" });
	await assert.rejects(generateOnBox({
		...localRequest,
		spawnImpl: () => {
			const child = new EventEmitter();
			queueMicrotask(() => child.emit("error", spawnError));
			return child;
		},
	}), (error) => error === spawnError);
	pass("local spawn errors reject the request");

	let failedDir;
	await assert.rejects(generateOnBox({
		...localRequest,
		spawnImpl: (_command, args) => {
			failedDir = args[6];
			const child = new EventEmitter();
			child.stderr = new EventEmitter();
			queueMicrotask(() => {
				child.stderr.emit("data", "fixture generator failed\n");
				child.emit("close", 9);
			});
			return child;
		},
	}), /exit 9/);
	assert.equal(existsSync(failedDir), false);
	pass("failed local generation is reported and its output directory cleaned");
} finally {
	rmSync(localFixture, { recursive: true, force: true });
}

console.log("OK verify-kimodo-runner");

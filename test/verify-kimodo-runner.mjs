import assert from "node:assert/strict";
import { createRunner } from "../tools/ardy/runners/index.mjs";
import { createKimodoRunner } from "../tools/kimodo/runner.mjs";
import { buildBackendCommand } from "../tools/kimodo/generate.mjs";

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
		for (const key of ["CCLAY_MOTION_BACKEND", "CCLAY_KIMODO_HOST"]) {
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
  assert.deepEqual(cpp.args, ["$HOME/.cozyclay/kimodo.cpp/models/kimodo-soma-rp-v1-f32.gguf", "$HOME/.cozyclay/kimodo.cpp/models/llm2vec-text-bundle", "$HOME/.cozyclay/kimodo.cpp/prompt.txt", "60", "10", "42", "/tmp/take"]);
}
pass("all installed Kimodo backends have exact command contracts");

console.log("OK verify-kimodo-runner");

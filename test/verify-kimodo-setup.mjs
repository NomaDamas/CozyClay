import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { spawnSync } from "node:child_process";

const setup = readFileSync(new URL("../tools/kimodo/setup-on-box.sh", import.meta.url), "utf8");
const wrapper = readFileSync(new URL("../tools/kimodo/setup-local.mjs", import.meta.url), "utf8");
const runner = readFileSync(new URL("../tools/ardy/runners/index.mjs", import.meta.url), "utf8");
const edit = readFileSync(new URL("../tools/kimodo/run-edit-on-box.mjs", import.meta.url), "utf8");

assert.match(setup, /set -euo pipefail/);
assert.match(setup, /--dry-run/);
assert.match(setup, /git clone --depth 1 https:\/\/github\.com\/nv-tlabs\/kimodo\.git/);
assert.match(setup, /if \[ ! -e "\$KIMODO_DIR\/.git" \]/);
assert.match(setup, /snapshot_download\(repo_id=f\\?"nvidia\/\{model\}"\)/);
assert.match(setup, /McGill-NLP\/LLM2Vec-Meta-Llama-3-8B-Instruct-mntp-supervised/);
assert.doesNotMatch(setup, /CCLAY_ARDY|\/ardy|ARDY/);
assert.match(wrapper, /CCLAY_KIMODO_HOST/);
assert.match(wrapper, /ssh/);
assert.match(runner, /return createKimodoRunner\(\);/);
assert.match(runner, /backend !== "kimodo"/);
assert.match(runner, /unknown CCLAY_MOTION_BACKEND/);
assert.doesNotMatch(runner, /createLocalRunner|createRemoteRunner|CCLAY_ARDY_MODE/);
assert.match(edit, /committed_keys:/);
assert.match(edit, /commit_verified: true/);
// The bridge only forwards a motion-edit report shaped like ARDY's: it must
// carry edit_range + history_range + future_range or tryParseReport drops it
// and the App refuses to install the regenerated take.
assert.match(edit, /edit_range: \[plan\.startFrame, plan\.endFrame\]/);
assert.match(edit, /history_range:/);
assert.match(edit, /future_range:/);
assert.doesNotMatch(edit, /edited_range/);
// --- install router: the dry-run route table -------------------------------
// The router picks a backend from detected OS/arch/RAM/CUDA; the detection
// inputs are env-overridable so the whole table runs offline in a dry-run.
const SCRIPT = new URL("../tools/kimodo/setup-on-box.sh", import.meta.url).pathname;

function dryRun(env = {}, args = []) {
	const clean = { ...process.env };
	for (const key of Object.keys(clean)) {
		if (key.startsWith("CCLAY_KIMODO_")) delete clean[key];
	}
	const r = spawnSync("bash", [SCRIPT, "--dry-run", ...args], {
		env: { ...clean, ...env },
		encoding: "utf8",
	});
	return { status: r.status, out: r.stdout + r.stderr };
}

const detect = (os, arch, ramGb, cuda) => ({
	CCLAY_KIMODO_DETECT_OS: os,
	CCLAY_KIMODO_DETECT_ARCH: arch,
	CCLAY_KIMODO_DETECT_RAM_GB: String(ramGb),
	CCLAY_KIMODO_DETECT_CUDA: String(cuda),
});

let r = dryRun(detect("Darwin", "arm64", 64, 0));
assert.equal(r.status, 0, r.out);
assert.match(r.out, /backend=kimodo-mlx/);
assert.match(r.out, /NomaDamas\/kimodo-mlx\.git/);
assert.match(r.out, /Llama-3-Kimodo-GGML/);

// At or below the 32 GB threshold the encoder cannot stay resident: stream.
r = dryRun(detect("Darwin", "arm64", 32, 0));
assert.equal(r.status, 0, r.out);
assert.match(r.out, /backend=kimodo\.cpp-metal/);
assert.match(r.out, /KIMODO_ENABLE_METAL=ON/);
assert.match(r.out, /0001-kimodo-ggml-metal\.patch/);
r = dryRun(detect("Darwin", "arm64", 16, 0));
assert.match(r.out, /backend=kimodo\.cpp-metal/);

r = dryRun(detect("Linux", "x86_64", 128, 1));
assert.equal(r.status, 0, r.out);
assert.match(r.out, /backend=nvidia-cuda/);
assert.match(r.out, /nv-tlabs\/kimodo\.git/);

r = dryRun(detect("Linux", "x86_64", 128, 0));
assert.equal(r.status, 0, r.out);
assert.match(r.out, /backend=kimodo\.cpp-cpu/);
assert.match(r.out, /localai-org\/kimodo\.cpp\.git/);
assert.doesNotMatch(r.out, /nv-tlabs/);

// An Intel Mac has no MLX/Metal path: the GGML CPU build is the route.
r = dryRun(detect("Darwin", "x86_64", 64, 0));
assert.match(r.out, /backend=kimodo\.cpp-cpu/);

// Explicit backend beats detection; a bad one is rejected by name.
r = dryRun({ ...detect("Linux", "x86_64", 128, 1), CCLAY_KIMODO_BACKEND: "kimodo-mlx" });
assert.match(r.out, /backend=kimodo-mlx/);
r = dryRun(detect("Darwin", "arm64", 64, 0), ["--backend", "nvidia-cuda"]);
assert.match(r.out, /backend=nvidia-cuda/);
r = dryRun(detect("Darwin", "arm64", 64, 0), ["--backend", "kimodo-turbo"]);
assert.equal(r.status, 1);
assert.match(r.out, /unknown backend: kimodo-turbo/);

// An OS with no supported route refuses with a hint instead of guessing.
r = dryRun(detect("SunOS", "i86pc", 64, 0));
assert.equal(r.status, 1);
assert.match(r.out, /unsupported OS: SunOS/);

console.log("OK verify-kimodo-setup");

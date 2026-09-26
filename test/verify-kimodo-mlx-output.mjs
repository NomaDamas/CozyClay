import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdtemp, mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const wrapper = fileURLToPath(new URL("../tools/kimodo/mlx-generate.py", import.meta.url));
assert.ok(existsSync(wrapper), "MLX array-output wrapper must exist");
const python = process.env.PYTHON || "python3";
const temp = await mkdtemp(join(tmpdir(), "kimodo-mlx-output-"));

// No NumPy/MLX substitute: real multidimensional buffer-protocol arrays exercise
// the serialization boundary. Only the unavailable inference runtime is faked.
// Optional KIMODO_TEST_NUMPY=1 also exercises real Fortran-order NumPy arrays
// when PYTHON points to an existing environment with NumPy; no install is needed.
const fakeRuntime = `
from array import array
from dataclasses import dataclass
from pathlib import Path
from types import SimpleNamespace
import os

@dataclass(frozen=True, slots=True)
class AssetManifest:
    motion: Path
    text: Path | None

@dataclass(frozen=True, slots=True)
class RuntimeConfig:
    seed: int
    steps: int
    backend: str = "auto"
    frames: int = 30

def generate(*, prompt, manifest, config):
    assert prompt == "walk; $(not-a-command)"
    assert manifest.motion == Path("motion weights")
    assert manifest.text == Path("text bundle")
    assert config.seed == int(os.environ.get("EXPECT_SEED", "7"))
    assert config.steps == int(os.environ.get("EXPECT_STEPS", "2"))
    assert config.frames == int(os.environ.get("EXPECT_FRAMES", "2"))
    assert config.backend == os.environ.get("EXPECT_BACKEND", "auto")
    mode = os.environ.get("FIXTURE_MODE", "valid")
    if mode == "runtime-error":
        raise RuntimeError("synthetic inference failure")
    frames = config.frames
    joints = 77 if mode == "soma77" else 30
    roots = array("f", [1.25, -2.5, 3.75] * frames)
    if mode == "nonfinite":
        roots[0] = float("nan")
    rotations = array("f", [0.0, 0.0, 0.0, 1.0] * frames * joints)
    rotations[4:8] = array("f", [0.0, 0.5, 0.0, 0.8660254])
    if mode == "bad-dtype":
        roots = array("d", roots)
    root_shape = [frames, 3] if mode != "bad-shape" else [3, frames]
    root_view = memoryview(roots).cast("B").cast(roots.typecode, shape=root_shape)
    rotation_view = memoryview(rotations).cast("B").cast("f", shape=[frames, joints, 4])
    if os.environ.get("KIMODO_TEST_NUMPY") == "1":
        import numpy as np
        root_view = np.array(root_view, order="F")
        rotation_view = np.array(rotation_view, order="F")
        assert not root_view.flags.c_contiguous
        assert not rotation_view.flags.c_contiguous
    return SimpleNamespace(
        backend="mlx-metal", elapsed_ms=12.5, output=b"not-the-arrays",
        root_positions=root_view, local_rotations_xyzw=rotation_view,
    )
`;

function invoke(output, { args = [], env = {} } = {}) {
	const result = spawnSync(python, [wrapper,
		"--prompt", "walk; $(not-a-command)", "--motion", "motion weights", "--text", "text bundle",
		"--frames", "2", "--steps", "2", "--seed", "7", "--output-dir", output, ...args,
	], {
		encoding: "utf8", timeout: 10_000,
		env: { ...process.env, PYTHONPATH: temp, PYTHONDONTWRITEBYTECODE: "1", ...env },
	});
	assert.ifError(result.error);
	return result;
}

try {
	await mkdir(join(temp, "kimodo_mlx"));
	await writeFile(join(temp, "kimodo_mlx", "__init__.py"), "");
	await writeFile(join(temp, "kimodo_mlx", "runtime.py"), fakeRuntime);

	// Given a verified [T,30,4] XYZW result and roots with distinct XYZ values,
	// when the real CLI runs, then files contain exactly C-order little-endian f32.
	const output = join(temp, "nested", "output with spaces");
	const result = invoke(output);
	assert.equal(result.status, 0, result.stderr);
	assert.equal(JSON.parse(result.stdout).joints, 30);
	assert.equal(JSON.parse(result.stdout).frames, 2);
	const roots = await readFile(join(output, "root_positions.f32"));
	const expectedRoots = Buffer.alloc(2 * 3 * 4);
	[1.25, -2.5, 3.75, 1.25, -2.5, 3.75].forEach((value, index) => expectedRoots.writeFloatLE(value, index * 4));
	assert.deepEqual(roots, expectedRoots);
	const rotations = await readFile(join(output, "local_rotations_xyzw.f32"));
	const expectedRotations = Buffer.alloc(2 * 30 * 4 * 4);
	for (let joint = 0; joint < 60; joint++) expectedRotations.writeFloatLE(1, (joint * 4 + 3) * 4);
	expectedRotations.writeFloatLE(0.5, 5 * 4);
	expectedRotations.writeFloatLE(0.8660254, 7 * 4);
	assert.deepEqual(rotations, expectedRotations);
	assert.deepEqual((await readdir(output)).sort(), ["local_rotations_xyzw.f32", "root_positions.f32"]);
	console.log("PASS MLX CLI forwards runtime arguments and writes exact little-endian frame/joint/XYZW arrays");

	// Given omitted optional generation settings, when the CLI runs, then the
	// upstream defaults (30 frames, 100 steps, seed 42, auto backend) are preserved.
	const defaults = spawnSync(python, [wrapper, "--prompt", "walk; $(not-a-command)",
		"--motion", "motion weights", "--text", "text bundle", "--output-dir", join(temp, "defaults")], {
		encoding: "utf8", timeout: 10_000,
		env: { ...process.env, PYTHONPATH: temp, PYTHONDONTWRITEBYTECODE: "1", EXPECT_SEED: "42", EXPECT_STEPS: "100", EXPECT_FRAMES: "30" },
	});
	assert.ifError(defaults.error);
	assert.equal(defaults.status, 0, defaults.stderr);
	assert.equal((await readFile(join(temp, "defaults", "root_positions.f32"))).length, 30 * 3 * 4);
	console.log("PASS omitted generation arguments retain upstream defaults");

	// Given explicit backend selection, when invoked, then RuntimeConfig receives it.
	const backend = invoke(join(temp, "backend"), { args: ["--backend", "mlx-metal"], env: { EXPECT_BACKEND: "mlx-metal" } });
	assert.equal(backend.status, 0, backend.stderr);
	console.log("PASS explicit backend is forwarded");

	for (const mode of ["soma77", "bad-shape", "bad-dtype", "nonfinite", "runtime-error"]) {
		// Given an incompatible or failed runtime result, when invoked, then no
		// output pair is published and the caller receives a nonzero exit status.
		const rejectedOutput = join(temp, mode);
		const rejected = invoke(rejectedOutput, { env: { FIXTURE_MODE: mode } });
		assert.equal(rejected.status, 2, `${mode}: ${rejected.stderr}`);
		assert.ok(rejected.stderr.trim(), `${mode} must explain its failure`);
		assert.equal(existsSync(rejectedOutput), false, `${mode} must fail before writing output`);
		console.log(`PASS ${mode} fails explicitly before writing arrays`);
	}

	// Given missing CLI inputs, when invoked, then argparse rejects before inference.
	const missing = spawnSync(python, [wrapper], { encoding: "utf8", timeout: 10_000 });
	assert.ifError(missing.error);
	assert.equal(missing.status, 2);
	assert.ok(missing.stderr.trim());
	console.log("PASS missing CLI inputs fail before loading the runtime");
} finally {
	await rm(temp, { recursive: true, force: true });
}

console.log("OK verify-kimodo-mlx-output");

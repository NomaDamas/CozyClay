import assert from "node:assert/strict";
import { gvhmrDetectorFromEnv, gvhmrRunnerArgs } from "../tools/ardy/runners/gvhmr-worker.mjs";

// CCLAY_EXTRACT_DETECTOR reaches the box-side runner as an argv flag, the same
// way --static-cam and --f-mm do: extract.mjs reads the env through
// gvhmrDetectorFromEnv and hands the value to gvhmrRunnerArgs.
const detectorOf = (args) => args[args.indexOf("--detector") + 1];
const fromEnv = (CCLAY_EXTRACT_DETECTOR) =>
	detectorOf(gvhmrRunnerArgs({ detector: gvhmrDetectorFromEnv({ CCLAY_EXTRACT_DETECTOR }) }));

// The env end of the wire: set it and the flag changes, leave it and it does not.
assert.equal(fromEnv("palette"), "palette");
assert.equal(fromEnv("yolo"), "yolo");
assert.equal(fromEnv(undefined), "auto");
assert.equal(fromEnv("  PALETTE "), "palette", "env values are trimmed and lowercased");
assert.equal(fromEnv("nonsense"), "auto", "an unknown env value must degrade, not abort the run");

// Default: `auto` measures the palette first and keeps YOLO when the
// part-colour hues are absent, so an unset env must not change real-person runs.
assert.equal(detectorOf(gvhmrRunnerArgs()), "auto");
assert.equal(detectorOf(gvhmrRunnerArgs({ staticCam: true })), "auto");

// Explicit selection, as the env would supply it.
for (const detector of ["yolo", "palette", "auto"]) {
	assert.equal(detectorOf(gvhmrRunnerArgs({ detector })), detector);
}
assert.deepEqual(gvhmrRunnerArgs({ staticCam: true, detector: "palette" }),
	["--static-cam", "--detector", "palette"]);

// An unknown value must not reach the runner's argparse choices, which would
// abort the whole extraction; fall back to the default instead.
for (const bogus of ["", "YOLO ", "sam", "palette; rm -rf /", null, undefined]) {
	assert.equal(detectorOf(gvhmrRunnerArgs({ detector: bogus })), "auto");
}

// The flag is additive: the existing camera flags keep their meaning.
assert.deepEqual(gvhmrRunnerArgs({ staticCam: false, fMm: 24, detector: "yolo" }),
	["--f-mm", "24", "--detector", "yolo"]);
assert.deepEqual(gvhmrRunnerArgs({ staticCam: true, fMm: 35.9, detector: "palette" }),
	["--static-cam", "--f-mm", "35", "--detector", "palette"]);

console.log("PASS GVHMR detector flag: default auto, explicit palette/yolo, invalid values rejected");

// The persistent box worker (tools/ardy/cclay_gvhmr_worker.py) builds the
// runner argv from the JSON request; the detector must ride along or the env
// is silently ignored on the default extraction path.
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
const workerPy = fileURLToPath(new URL("../tools/ardy/cclay_gvhmr_worker.py", import.meta.url));
const py = spawnSync("python3", ["-c", `
import ast, json, sys
src = open(sys.argv[1]).read(); tree = ast.parse(src)
fn = next(n for n in tree.body if isinstance(n, ast.FunctionDef) and n.name == "runner_argv")
consts = [n for n in tree.body if isinstance(n, ast.Assign) and any(getattr(t, "id", None) == "DETECTORS" for t in n.targets)]
ns = {}; exec(ast.unparse(ast.Module(body=consts + [fn], type_ignores=[])), ns)
print(json.dumps(ns["runner_argv"]({"video": "/v.mp4", "output": "/o.npz", "outRoot": "/r", "staticCam": True, "detector": "palette"}, "/runner.py")))
print(json.dumps(ns["runner_argv"]({"video": "/v.mp4", "output": "/o.npz", "outRoot": "/r"}, "/runner.py")))
`, workerPy], { encoding: "utf8" });
assert.equal(py.status, 0, `python helper missing or broken: ${py.stderr.slice(0, 300)}`);
const [withDetector, defaults] = py.stdout.trim().split("\n").map((line) => JSON.parse(line));
assert.deepEqual(withDetector.slice(-2), ["--detector", "palette"], "worker request detector reaches the runner argv");
assert.equal(defaults.includes("--detector"), false, "no detector key → runner default (auto)");
console.log("PASS GVHMR worker request: detector key becomes --detector on the runner argv");

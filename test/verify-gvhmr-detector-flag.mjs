import assert from "node:assert/strict";
import { gvhmrDetectorFromEnv, gvhmrKeypointsFromEnv, gvhmrRunnerArgs } from "../tools/ardy/runners/gvhmr-worker.mjs";

// The coloured-mannequin pipeline is palette-only. The legacy environment
// variable remains accepted for deployment compatibility, but must never
// select YOLO or the auto detector.
const detectorOf = (args) => args[args.indexOf("--detector") + 1];
const fromEnv = (CCLAY_EXTRACT_DETECTOR) =>
	detectorOf(gvhmrRunnerArgs({ detector: gvhmrDetectorFromEnv({ CCLAY_EXTRACT_DETECTOR }) }));

for (const value of ["palette", "yolo", "auto", undefined, "nonsense", "  YOLO "]) {
	assert.equal(fromEnv(value), "palette", `detector env ${String(value)} cannot bypass palette`);
}

// Defaults and explicit arguments are both forced to palette.
for (const detector of ["yolo", "palette", "auto", "sam", undefined]) {
	assert.equal(detectorOf(gvhmrRunnerArgs({ detector })), "palette");
}
assert.deepEqual(gvhmrRunnerArgs({ staticCam: true, detector: "palette" }),
	["--static-cam", "--detector", "palette", "--keypoints", "auto"]);

// The flag is additive: the existing camera flags keep their meaning.
assert.deepEqual(gvhmrRunnerArgs({ staticCam: false, fMm: 24, detector: "yolo" }),
	["--f-mm", "24", "--detector", "palette", "--keypoints", "auto"]);
assert.deepEqual(gvhmrRunnerArgs({ staticCam: true, fMm: 35.9, detector: "palette" }),
	["--static-cam", "--f-mm", "35", "--detector", "palette", "--keypoints", "auto"]);

console.log("PASS GVHMR detector flag: palette is fixed for defaults, env, and overrides");

// CCLAY_EXTRACT_KEYPOINTS (#180) rides the same wire: which estimator fills
// GVHMR's kp2d observation. ViTPose reads photographic cues a flat-coloured
// mannequin render does not carry (median body joint 10.4 % of bbox height
// off the palette joints, shoulders 30-65 %), so a part-coloured clip takes
// its joints from the limb masks instead.
const keypointsOf = (args) => args[args.indexOf("--keypoints") + 1];
const keypointsFromEnv = (CCLAY_EXTRACT_KEYPOINTS) =>
	keypointsOf(gvhmrRunnerArgs({ keypoints: gvhmrKeypointsFromEnv({ CCLAY_EXTRACT_KEYPOINTS }) }));

assert.equal(keypointsFromEnv("palette"), "palette");
assert.equal(keypointsFromEnv("vitpose"), "vitpose");
assert.equal(keypointsFromEnv(undefined), "auto");
assert.equal(keypointsFromEnv(" PALETTE "), "palette", "env values are trimmed and lowercased");
assert.equal(keypointsFromEnv("nonsense"), "auto", "an unknown env value must degrade, not abort the run");

// Default `auto` resolves to ViTPose inside the runner (palette keypoints are
// opt-in: measured worse on shifted render hues, issue #180); palette keypoints only
// where the palette detector claimed the clip, ViTPose on real footage.
assert.equal(keypointsOf(gvhmrRunnerArgs()), "auto");
for (const keypoints of ["vitpose", "palette", "auto"]) {
	assert.equal(keypointsOf(gvhmrRunnerArgs({ keypoints })), keypoints);
}
for (const bogus of ["", "VITPOSE ", "yolo", "palette; rm -rf /", null, undefined]) {
	assert.equal(keypointsOf(gvhmrRunnerArgs({ keypoints: bogus })), "auto");
}
// The two selections are independent: palette boxes with ViTPose joints is a
// legitimate A/B, and it is how the #180 baseline was measured.
assert.deepEqual(gvhmrRunnerArgs({ staticCam: true, detector: "palette", keypoints: "vitpose" }),
	["--static-cam", "--detector", "palette", "--keypoints", "vitpose"]);
assert.deepEqual(gvhmrRunnerArgs({ staticCam: true, detector: "palette", keypoints: "palette" }),
	["--static-cam", "--detector", "palette", "--keypoints", "palette"]);

console.log("PASS GVHMR keypoints flag: default auto, explicit palette/vitpose, invalid values rejected");

// The persistent box worker (tools/ardy/cclay_gvhmr_worker.py) builds the
// runner argv from the JSON request; the palette flag must always ride along
// so the remote runner's own default cannot silently switch to `auto`.
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
const workerPy = fileURLToPath(new URL("../tools/ardy/cclay_gvhmr_worker.py", import.meta.url));
const py = spawnSync("python3", ["-c", `
import ast, json, sys
src = open(sys.argv[1]).read(); tree = ast.parse(src)
fn = next(n for n in tree.body if isinstance(n, ast.FunctionDef) and n.name == "runner_argv")
consts = [n for n in tree.body if isinstance(n, ast.Assign) and any(getattr(t, "id", None) in ("DETECTORS", "KEYPOINTS") for t in n.targets)]
ns = {}; exec(ast.unparse(ast.Module(body=consts + [fn], type_ignores=[])), ns)
base = {"video": "/v.mp4", "output": "/o.npz", "outRoot": "/r"}
print(json.dumps(ns["runner_argv"]({**base, "staticCam": True, "detector": "palette"}, "/runner.py")))
print(json.dumps(ns["runner_argv"](base, "/runner.py")))
print(json.dumps(ns["runner_argv"]({**base, "staticCam": True, "detector": "palette", "keypoints": "palette"}, "/runner.py")))
print(json.dumps(ns["runner_argv"]({**base, "keypoints": "nonsense"}, "/runner.py")))
`, workerPy], { encoding: "utf8" });
assert.equal(py.status, 0, `python helper missing or broken: ${py.stderr.slice(0, 300)}`);
const [withDetector, defaults, withKeypoints, bogusKeypoints] = py.stdout.trim().split("\n").map((line) => JSON.parse(line));
assert.deepEqual(withDetector.slice(-2), ["--detector", "palette"], "worker request detector reaches the runner argv");
assert.deepEqual(defaults.slice(-2), ["--detector", "palette"], "worker always sends the palette detector");
console.log("PASS GVHMR worker request: detector key becomes --detector on the runner argv");

// Same for the keypoints selection, so CCLAY_EXTRACT_KEYPOINTS is honoured on
// the persistent-worker path and not only in the one-shot ssh command.
assert.deepEqual(withKeypoints.slice(-4), ["--detector", "palette", "--keypoints", "palette"],
	"worker request keypoints reaches the runner argv");
assert.equal(defaults.includes("--keypoints"), false, "no keypoints key → runner default (auto)");
assert.equal(bogusKeypoints.includes("--keypoints"), false,
	"an unknown keypoints value must not reach the runner's argparse choices");
console.log("PASS GVHMR worker request: keypoints key becomes --keypoints on the runner argv");

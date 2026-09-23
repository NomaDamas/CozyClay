#!/usr/bin/env node
// End-to-end MorphGS exporter regression: FBX -> MorphGS rig, MorphGS Animation.step
// ground truth -> CozyClay NPZ -> the real decodeMotionNpz/applyMotionFrame path.
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const root = resolve(new URL("..", import.meta.url).pathname);
const morphgs = join(root, "tools/morphgs");
const fbx = join(root, "public/models/x-bot-tpose.fbx");
const work = mkdtempSync(join(tmpdir(), "cozyclay-morphgs-"));
const source = join(work, "MorphGS");
const output = join(work, "truth");
const rig = join(output, "rigging/mesh_ori_rig.txt");
const truth = join(work, "truth");
const take = join(work, "take.npz");
const run = (file, args, options = {}) => execFileSync(file, args, { cwd: root, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], ...options });

function fail(message) {
  console.error(`FAIL MorphGS exporter: ${message}`);
  process.exitCode = 1;
}
try {
  if (process.env.MORPHGS_SOURCE) {
    run("git", ["clone", "--quiet", process.env.MORPHGS_SOURCE, source]);
    run("git", ["-C", source, "checkout", "--quiet", "87d38e4"]);
  } else {
    run("git", ["clone", "--quiet", "https://github.com/xodus777/MorphGS.git", source]);
    run("git", ["-C", source, "checkout", "--quiet", "87d38e4"]);
  }
  run("node", [join(morphgs, "fbx2morphgs.mjs"), fbx, output]);

  // FBXLoader emits 129 bones including 64 zero-length duplicate copies. The
  // --all-bones path must retain the 65 real bones and no duplicate names.
  const all = join(work, "all-bones");
  run("node", [join(morphgs, "fbx2morphgs.mjs"), fbx, all, "--all-bones"]);
  const allLines = readFileSync(join(all, "rigging/mesh_ori_rig.txt"), "utf8").trim().split("\n");
  const allJoints = allLines.filter((line) => line.split(/\s+/).length === 5);
  const allNames = allJoints.map((line) => line.split(/\s+/)[0]);
  if (allJoints.length !== 65 || new Set(allNames).size !== 65) throw new Error(`FBX bone regression: expected 65 unique bones, got ${allJoints.length}`);
  const fixed = "fixed_joint Spine LeftUpLeg RightUpLeg Neck LeftShoulder RightShoulder LeftHandEnd RightHandEnd";
  if (!readFileSync(rig, "utf8").includes(fixed)) throw new Error("fbx2morphgs did not append the required fixed_joint line");

  if (!process.env.MORPHGS_SKIP_TRUTH) {
    try { execFileSync("uv", ["--version"], { stdio: "ignore" }); } catch { throw new Error("uv is required to generate MorphGS truth (not a skip)"); }
    run("uv", ["run", "--no-project", "--with", "torch", "--with", "trimesh", "--with", "scipy", "--with", "numpy", "python", join(morphgs, "assets/gen_truth.py"), source, join(output, "mesh.obj"), rig, truth]);
    run("node", [join(morphgs, "morphgs-to-cskel27.mjs"), rig, join(truth, "rot_params.npy"), join(truth, "pred_joints.npy"), take, "--fps", "30", "--check"], { env: { ...process.env, COZYCLAY: root } });
    const playback = run("node", [join(morphgs, "assets/playback-check.mjs"), take, join(truth, "pred_joints.npy"), rig], { env: { ...process.env, COZYCLAY: root } });
    const rows = playback.split("\n").filter((line) => line.includes(" cm"));
    console.log(rows.join("\n"));
    const driven = rows.filter((line) => !/HandEnd|Toe_End|HeadTop_End/.test(line));
    const leaves = rows.filter((line) => /HandEnd|Toe_End|HeadTop_End/.test(line));
    const max = (lines) => Math.max(...lines.map((line) => Number(line.trim().split(/\s+/).at(-2))));
    const leafMax = Math.round(max(leaves) * 100) / 100; // playback-check prints millimetre precision; gate at the reported hundredth.
    if (max(driven) > 0.0001) throw new Error(`driven joint max error ${max(driven).toFixed(4)} cm exceeds 0.000 cm`);
    if (leafMax > 0.74) throw new Error(`leaf joint max error ${leafMax.toFixed(2)} cm exceeds 0.74 cm`);
    console.log(`PASS MorphGS exporter: driven <= 0.000 cm, leaves <= 0.74 cm (measured ${leafMax.toFixed(2)} cm)`);
  } else {
    console.log("PASS MorphGS exporter structural checks (MORPHGS_SKIP_TRUTH=1)");
  }
} catch (error) {
  fail(error.stderr?.toString().trim() || error.message);
} finally {
  rmSync(work, { recursive: true, force: true });
}

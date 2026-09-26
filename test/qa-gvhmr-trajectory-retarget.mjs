import assert from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { readNpz } from "../tools/kimodo/read-npz.mjs";
import { smplToCskel27Motion } from "../tools/ardy/smpl-cskel27.mjs";
import { motionArraysToNpzMembers, writeNpz } from "../tools/ardy/npz.mjs";
import { guardTrajectoryFloor } from "../tools/ardy/gvhmr-floor.mjs";
import { readFileSync } from "node:fs";

const [beforePath, afterPath, out] = process.argv.slice(2);
assert.ok(beforePath && afterPath && out, "before-SMPL after-SMPL evidence-directory");
mkdirSync(out, { recursive: true });
const raw = [beforePath, afterPath].map(readNpz);
const maxDiff = (a, b) => a.reduce((m, v, i) => Math.max(m, Math.abs(v - b[i])), 0);
const unchanged = {};
for (const name of ["fps", "contact", "smpl_global_orient", "smpl_body_pose", "smpl_betas", "smpl_rest_joints"]) {
	unchanged[name] = maxDiff(raw[0][name].data, raw[1][name].data);
	assert.ok(unchanged[name] < 1e-6, `${name} changed: ${unchanged[name]}`);
}
const motions = raw.map(smplToCskel27Motion);
const events = JSON.parse(readFileSync(join(out, "trajectory.json"))).events;
const guarded = guardTrajectoryFloor(motions[1], events);
motions[1] = guarded.motion;
writeFileSync(join(out, "floor-guard.json"), JSON.stringify(guarded.diagnostics, null, 2));
for (let i = 0; i < motions.length; i++) writeNpz(join(out, i ? "after.npz" : "before.npz"), motionArraysToNpzMembers(motions[i]));
const rows = motions.map((m) => ({ frames: m.frames, fps: m.fps,
	rootY: Array.from({ length: m.frames }, (_, f) => m.rootPos[f * 3 + 1]),
	lowestJointY: Array.from({ length: m.frames }, (_, f) => Math.min(...Array.from({ length: 27 }, (_, j) => m.posedJoints[(f * 27 + j) * 3 + 1]))),
}));
const metrics = { unchanged, rotMatsMaxDelta: maxDiff(motions[0].rotMats, motions[1].rotMats),
	boneScaleMaxDelta: maxDiff(motions[0].boneScale, motions[1].boneScale),
	rootXZMaxDelta: maxDiff(motions[0].rootPos.filter((_, i) => i % 3 !== 1), motions[1].rootPos.filter((_, i) => i % 3 !== 1)),
	before: rows[0], after: rows[1] };
writeFileSync(join(out, "retarget-metrics.json"), JSON.stringify(metrics, null, 2));
console.log(JSON.stringify({ unchanged, rotMatsMaxDelta: metrics.rotMatsMaxDelta, rootXZMaxDelta: metrics.rootXZMaxDelta,
	postLandingDropBefore: rows[0].rootY[300] - rows[0].rootY[348], postLandingDropAfter: rows[1].rootY[300] - rows[1].rootY[348],
	floorBefore: Math.min(...rows[0].lowestJointY), floorAfter: Math.min(...rows[1].lowestJointY) }, null, 2));

#!/usr/bin/env node
// Named key poses (src/motion3/poses.js): every pose holds QA-clean on Y Bot and X Bot, a key naming one expands to its
// channels (at, face, set overrides), and a spec of named poses compiles like the same spec written out.
import assert from "node:assert/strict";
import { compileSpec } from "../../src/motion3/pipeline.js";
import { skeletonFor } from "../../src/motion3/rigs/index.js";
import { motionScene } from "../../src/motion3/scene.js";
import { POSE_NAMES, poseChannels, expandPoses } from "../../src/motion3/poses.js";

const scene = motionScene([]);
for (const rig of ["y-bot-tpose", "x-bot-tpose"]) {
	const sk = skeletonFor(rig);
	for (const name of POSE_NAMES) {
		const r = compileSpec({ schema: "cozyclay.motion-spec.v1", frames: 12, fps: 24, keys: [{ f: 0, pose: name }] }, { sk, scene });
		assert.equal(r.qa.groups.length, 0, `${rig} ${name}: ${r.qa.groups.map(g => `${g.kind} ${g.subject}`).join(", ")}`);
	}
	console.log(`PASS ${rig}: all ${POSE_NAMES.length} poses hold QA-clean`);
}
const sk = skeletonFor("y-bot-tpose");
const moved = poseChannels("stand", sk, { at: [1, 2], face: 90 });
assert.deepEqual(moved.root, [1, 0.99, 2]);
assert.equal(moved.yaw, 90);
assert.ok(Math.abs(moved.foot_l[2] - 2 + 0.1) < 1e-6 && Math.abs(moved.foot_l[0] - 1) < 1e-6, JSON.stringify(moved.foot_l));
console.log("PASS at and face move and turn the pose (stand faced +X: the left foot toward -Z)");
const spec = expandPoses({ keys: [{ f: 0, pose: "stand" }, { f: 20, pose: "sit_floor", set: { spine_pitch: 12 } }] }, sk);
assert.ok(spec.keys.every(k => !("pose" in k)) && spec.keys[1].set.spine_pitch === 12 && spec.keys[1].set.root[1] === 0.16);
assert.throws(() => expandPoses({ keys: [{ f: 0, pose: "handstand" }] }, sk), /not a pose.*stand, ready/);
console.log("PASS a named key expands (set overrides it); an unknown name lists the poses");
console.log("verify-motion3-poses: all checks passed");

#!/usr/bin/env node
// #819 case 2: the 12 kg box the right hand holds out (the grasp browser QA's case d). Its LOAD patch puts the left palm
// on a face of the box; the face nearest the left shoulder (the top, by 0.3 mm) sent the hand through the box edge
// (QA 121), so the hint gives every face but the bottom and the right palm's as candidates and repair keeps the cheapest
// compiled (the +X face: QA 0). compareQa keeps a change with more groups only when it ends a LOAD and each new group
// is small.
import { compileSpec } from "../../src/motion3/pipeline.js";
import { motionScene } from "../../src/motion3/scene.js";
import { skeletonFor } from "../../src/motion3/rigs/index.js";
import { repairSpec } from "../../src/motion3/repair.js";
import { compareQa } from "../../src/motion3/qa/verdict.js";

let failures = 0;
function expect(name, condition, detail = "") {
	console.log(`${condition ? "PASS" : "FAIL"} ${name}${condition ? "" : ` - ${detail}`}`);
	if (!condition) failures += 1;
}
const sk = skeletonFor("y-bot-tpose"), I = sk.index, GRAB = 20, SIZE = 0.4, OUT = [-0.08, 1.2, 0.35];
const spec = { schema: "cozyclay.motion-spec.v1", fps: 24, frames: 60, props: { boxGrip: { hand: "r", origin: ["RightHandIndex2", "RightHandMiddle2"], points: {} } },
	use: [{ skill: "standIdle", args: { at: [0, 0], heading: 0 }, f0: 0 }], keys: [{ f: 0, set: { armw_r: 1, hand_r: OUT } }], objects: { box: { prop: "boxGrip", grab: GRAB, mass: 12 } } };
const P = compileSpec({ ...spec, objects: {}, props: {} }, { sk, scene: motionScene([]) }).out.frames[GRAB].s.P;
const palm = P[I.RightHandMiddle1].map((v, i) => (v + P[I.RightHand][i]) / 2);
const scene = motionScene([{ id: "box", name: "Box", renderer: "cube", x: palm[0], y: palm[1] - SIZE / 2 - 0.03, z: palm[2] + SIZE / 2 - 0.02, rot: 0, rotX: 0, rotZ: 0, scaleX: SIZE, scaleY: SIZE, scaleZ: SIZE, footprint: { width: 1, depth: 1 }, height: 1 }]);
const run = s => compileSpec(s, { sk, scene });

// the hint: 4 candidate faces, nearest the left shoulder first (the patch), none on the output
const one = run(spec), load = one.qa.groups.find(g => g.kind === "LOAD"), locals = (load?.candidates ?? []).map(p => p[0].value.boxOther.local);
expect("one hand: LOAD, QA 40", !!load && one.qa.total === 40, `QA ${one.qa.total}`);
expect("4 candidate faces, the first is the patch", locals.length === 4 && JSON.stringify(load.candidates[0]) === JSON.stringify(load.patch), JSON.stringify(locals));
expect("the candidates stay off the output", !Object.keys(load ?? {}).includes("candidates") && !JSON.stringify(one.qa).includes("candidates"));
const h = SIZE / 2, onFace = l => [0, 1, 2].filter(i => Math.abs(Math.abs(l[i] - (i === 1 ? h : 0)) - h) > 0.01 && Math.abs(Math.abs(l[i] - (i === 1 ? h : 0)) - h) < 0.03);
expect("each candidate sits 1-3 cm out of one face, none on the bottom", locals.every(l => onFace(l).length === 1 && l[1] > 0), JSON.stringify(locals));
expect("fix.grasp false: no LOAD, QA 0", run({ ...spec, fix: { grasp: false } }).qa.total === 0);

// repair compiles the faces and keeps the cheapest: the +X face, QA 40 -> 0 in one round
const fixed = repairSpec(spec, { rounds: 4 }, run), local = fixed.spec.anchors?.boxOther?.local ?? [];
expect("repair: QA 40 -> 0, the LOAD patch kept", fixed.result.qa.total === 0 && fixed.repair.applied[0]?.kind === "LOAD", JSON.stringify({ qa: fixed.result.qa.total, applied: fixed.repair.applied.map(a => a.kind) }));
expect("repair kept the +X face, not the top", local[0] > h && Math.abs(local[1] - h) < 1e-6, JSON.stringify(local));

// compareQa: more groups pass only when a LOAD ends and each new group has severity <= 5
const G = (kind, subject, severity) => ({ kind, subject, severity });
const base = { groups: [G("LOAD", "right holds box at 50 N m", 80.16)] };
const small = { groups: [G("COLLIDE", "farm_l x box", 1.03), G("POP", "LeftForeArm accel 8.58 cm/f^2 in one frame", 1.72)] };
const big = { groups: [G("COLLIDE", "farm_l x box", 58.8), G("POP", "LeftForeArm accel 8.58 cm/f^2 in one frame", 1.72)] };
expect("LOAD gone, two new groups of severity <= 5: better", compareQa(small, base).better, compareQa(small, base).why);
expect("LOAD gone, a new group of severity 58.8: not better (problems)", /^problems 1 -> 2/.test(compareQa(big, base).why), compareQa(big, base).why);
const soft = { groups: [G("COLLIDE", "hand_r x table", 80.16)] };
expect("a COLLIDE gone (not a hard failure), two small groups: not better (problems)", /^problems 1 -> 2/.test(compareQa(small, soft).why), compareQa(small, soft).why);
const kept = { groups: [G("LOAD", "right holds box at 50 N m", 80.16), G("BODY", "uarm_r into hips", 8)] };
const still = { groups: [G("LOAD", "right holds box at 40 N m", 70), G("POP", "x", 1), G("SPEED", "y", 1)] };
expect("LOAD still there: more groups are not better", /^problems 2 -> 3/.test(compareQa(still, kept).why), compareQa(still, kept).why);

if (failures) { console.error(`${failures} failure(s)`); process.exit(1); }
console.log("load faces: all checks passed");

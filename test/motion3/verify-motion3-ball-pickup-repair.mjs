#!/usr/bin/env node
// #819 case 1: the ball pickup (session 7f15b4ae) reaches into the table under the ball, COLLIDE hand_r x table 3.5 cm at
// f32 (QA 7). The COLLIDE hint raises that hand's reachGrip world anchor over the box's top by what the hit lacks, so
// repairSpec takes it to QA 0. Past ~3.5 cm the fingers miss the ball, so a deeper hit gets no anchor lift.
import { compileSpec } from "../../src/motion3/pipeline.js";
import { motionScene } from "../../src/motion3/scene.js";
import { skeletonFor } from "../../src/motion3/rigs/index.js";
import { repairSpec } from "../../src/motion3/repair.js";
import { BALL_SCENE, ballPickupSpec, MODEL } from "./fixtures/ball-pickup.mjs";

let failures = 0;
function expect(name, condition, detail = "") {
	console.log(`${condition ? "PASS" : "FAIL"} ${name}${condition ? "" : ` - ${detail}`}`);
	if (!condition) failures += 1;
}
const sk = skeletonFor(MODEL), scene = motionScene(BALL_SCENE), compile = s => compileSpec(s, { sk, scene });
const groups = r => r.qa.groups.map(g => `${g.kind}:${g.subject} ${g.worst}`).join(" | ");
const tableHit = r => r.qa.groups.find(g => g.kind === "COLLIDE" && g.subject === "hand_r x table");

const r0 = compile(ballPickupSpec()), hit = tableHit(r0), lift = hit?.patch?.find(o => o.path === "/anchors/orb/p");
expect("the spec as sent hits the table with the right hand", !!hit, groups(r0));
expect("its patch raises the orb anchor by worst - limit + 0.003", !!lift && Math.abs(lift.value[1] - (0.79 + hit.worst - hit.limit + 0.003)) < 1e-4 && lift.value[0] === -0.2 && lift.value[2] === 0.41, JSON.stringify(hit?.patch));

const { result, repair } = repairSpec(ballPickupSpec(), { rounds: 4 }, compile);
console.log(`  repair: rounds ${repair.rounds}, compiles ${repair.compiles}, rejected ${repair.rejected}, QA ${r0.qa.total} -> ${result.qa.total}`);
expect("repairSpec takes the ball pickup to QA 0", result.qa.total === 0, groups(result));
expect("through the anchor lift", repair.applied.some(a => a.kind === "COLLIDE" && a.patch.some(o => o.path === "/anchors/orb/p")), JSON.stringify(repair.applied.map(a => a.patch)));

// the anchor 3 cm lower: the hand goes 3.8 cm into the table, a lift of 3.6 cm is past what keeps the fingers on the ball
const low = ballPickupSpec();
low.anchors.orb.p = [-0.2, 0.76, 0.41];
const deep = tableHit(compile(low));
expect("a hit past the window gets no anchor lift", !!deep && deep.worst - deep.limit + 0.003 > 0.035 && !(deep.patch ?? []).some(o => o.path.startsWith("/anchors/")), JSON.stringify(deep && { worst: deep.worst, patch: deep.patch }));

if (failures) { console.log(`${failures} ball pickup repair check(s) failed`); process.exit(1); }
console.log("motion3 ball pickup repair: all checks passed");

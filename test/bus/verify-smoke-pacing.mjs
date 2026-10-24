#!/usr/bin/env node
// smokeCigarette paces its beats to fit a short span (live runs of "밤에 쪼그려 앉아 담배피는 장면을 10초
// 정도 만들어줘" first compiled 240 frames and were refused: it needed f1..f265). Between 75% of its
// own 264 frames and all of them every beat's frame is scaled, the switches keep their order, and
// observations.paced says so; below that it refuses with the frames and seconds it needs. At its
// own length nothing changes: the exitcar take and the standing smoke bake bit for bit as v3@6b8b3669.
import { takeHash as hashOf } from "../motion3/fixtures/take-hash.mjs";
import { compileSpec } from "../motion3/fixtures/legacy-compile.mjs";
import { motionScene } from "../../src/motion3/scene.js";
import { skeletonFor } from "../../src/motion3/rigs/index.js";
import { bakeTake } from "../../src/motion3/take.js";
import { SKILL_INFO } from "../../src/motion3/skills/info.js";
import { buildKit } from "../../src/kits/index.js";
import { SCENE_OBJECTS } from "../motion3/fixtures/exitcar-scene.mjs";

let failures = 0;
function expect(name, condition, detail = "") {
	console.log(`${condition ? "PASS" : "FAIL"} ${name}${condition ? "" : ` — ${detail}`}`);
	if (!condition) failures += 1;
}
const cig = buildKit("cigarette", [], { position: { x: 0.6, z: 0.5 } }), lit = buildKit("lighter", cig.records, { position: { x: 0.75, z: 0.5 } });
const kitScene = motionScene([...cig.records, ...lit.records, { id: "puff", name: "Exhale", renderer: "effect", x: 0, y: 1.5, z: 0.1, rot: 0, footprint: { width: 0, depth: 0 }, height: 0 }]);
const KIT = { cig: cig.rootId, lighter: lit.rootId, exhale: "puff" };
// the squat of the kits test (session d51e2c8d), keyed at f0; the skill starts at f1 like the live runs
const SQUAT = { root: [0, 0.45, -0.12], yaw: 0, pitch: 22, spine_pitch: 10, head_pitch: -12, foot_l: [0.16, 0.101, 0.02], foot_r: [-0.16, 0.101, 0.02], fyaw_l: 15, fyaw_r: -15, knee_l: [0.45, 0, 1], knee_r: [-0.45, 0, 1] };
const STAND = { use: [{ skill: "standIdle", f0: 0, args: { at: [0, 0], heading: 0 } }] };
const smoke = (frames, start, kit, args = {}) => ({ schema: "cozyclay.motion-spec.v1", fps: 24, frames, ...start,
	use: [...(start.use ?? []), { skill: "smokeCigarette", f0: 1, args: { ...args, ...(kit ? { kit: KIT } : {}) } }] });
const compile = (rig, spec, kit) => compileSpec(spec, { sk: skeletonFor(rig), scene: kit ? kitScene : { objects: {} } });
/** The frames each switch channel crosses 0.5, in order: [[f, "flame_vis on"], ...]. */
const switches = out => {
	const rows = [];
	for (const ch of ["cig_vis", "lit_vis", "flame_vis", "ember_vis", "exhale"]) {
		const v = out.baked[ch];
		for (let f = 1; f < v.length; f++) if ((v[f] > 0.5) !== (v[f - 1] > 0.5)) rows.push([f, `${ch} ${v[f] > 0.5 ? "on" : "off"}`]);
	}
	return rows.sort((a, b) => a[0] - b[0]);
};

// 1. 240 frames (10 s) from f1: paced 0.90, QA 0 on both rigs, with and without the kits
const nominal = compile("y-bot-tpose", smoke(266, { keys: [{ f: 0, set: SQUAT }] }, false), false);
for (const rig of ["y-bot-tpose", "x-bot-tpose"]) for (const kit of [false, true]) {
	const r = compile(rig, smoke(240, { keys: [{ f: 0, set: SQUAT }] }, kit), kit), label = `${rig} squat${kit ? " with kits" : ""}`;
	console.log(`  ${label}: QA ${r.qa.total}, ${JSON.stringify(r.observations.paced)}, used ${JSON.stringify(r.used)}`);
	expect(`${label}: 240 frames compile with QA 0`, r.qa.ok, JSON.stringify(r.qa.groups.slice(0, 3).map(g => [g.kind, g.subject, g.first, g.last])));
	expect(`${label}: the compile output says it is paced`, JSON.stringify(r.observations.paced) === JSON.stringify(["smokeCigarette paced 0.90 to fit f1..f239"])
		&& r.used[0].paced === 0.9 && r.used[0].end === 239, JSON.stringify([r.observations.paced, r.used]));
	expect(`${label}: the switches happen in the same order as at its own pace`,
		JSON.stringify(switches(r.out).map(s => s[1])) === JSON.stringify(switches(nominal.out).map(s => s[1])), JSON.stringify(switches(r.out)));
	if (kit) expect(`${label}: the kit's grab and release frames are paced too (f26, f33, f93)`, r.expanded.objects[cig.rootId].grab === 26
		&& r.expanded.objects[lit.rootId].grab === 33 && r.expanded.objects[lit.rootId].release === 93, JSON.stringify(r.expanded.objects));
}
const standing = compile("x-bot-tpose", smoke(240, STAND, true), true);
expect("standing, 240 frames with the kits: QA 0, paced", standing.qa.ok && standing.observations.paced?.length === 1, JSON.stringify(standing.qa.groups.slice(0, 2)));
const until = compile("y-bot-tpose", smoke(300, { keys: [{ f: 0, set: SQUAT }] }, false, { until: 240 }), false);
expect("args.until 240 in a longer spec paces to f1..f240 and holds after", until.qa.ok && until.observations.paced?.[0] === "smokeCigarette paced 0.90 to fit f1..f240", JSON.stringify(until.observations.paced));

// 2. the floor: 75% of 264 frames (f1..f199) still paces; one frame less is refused with what it needs
const floor = compile("y-bot-tpose", smoke(200, { keys: [{ f: 0, set: SQUAT }] }, true), true);
expect("at the floor (199 frames from f1, paced 0.75) QA 0", floor.qa.ok && floor.observations.paced?.[0] === "smokeCigarette paced 0.75 to fit f1..f199", JSON.stringify([floor.qa.total, floor.observations.paced]));
const refusal = spec => { try { compile("y-bot-tpose", spec, false); return ""; } catch (error) { return error.message; } };
const short = refusal(smoke(199, { keys: [{ f: 0, set: SQUAT }] }, false));
expect("one frame short of the floor is refused with the frames and seconds it needs",
	short === 'MOTION_SPEC_INVALID: use[0] smokeCigarette: needs frames f1..f199 at least: 199 frames, 8.3 s at 24 fps, paced 0.75 (265 frames, 11.0 s, at its own pace); it has f1..f198, so set frames >= 200 or frames: "auto"', short);
const shortUntil = refusal(smoke(300, { keys: [{ f: 0, set: SQUAT }] }, false, { until: 150 }));
expect("a short args.until says to raise it", shortUntil.endsWith("it has f1..f150, so set args.until >= 199"), shortUntil);
expect("motion.describe tells the range", SKILL_INFO.smokeCigarette.frames === "265 nominal; fits 199..264 by pacing", SKILL_INFO.smokeCigarette.frames);

// Flow (compiler/channels.js: the free spine, head and arms carry through keys and trail) re-baked the takes whose arms swing
// free (exitcar, walk, cup run3, the standing smokes, df6acdcc, 6262a69c); their QA did not change.
// 3. at its own length nothing changes (hashes of v3@6b8b3669; the exitcar's walk as the walk's natural rhythm bakes it)
const exitcar = { schema: "cozyclay.motion-spec.v1", fps: 24, frames: 730, use: [
	{ skill: "sitInSeat", f0: 0, args: { car: "Car", offset: [-0.06, 0.17, 0.023] } }, { skill: "exitCar", f0: 0, args: { car: "Car", side: "l" } },
	{ skill: "walkTo", f0: 246, args: { heading: [125, 150], steps: 8, step: 0.5, halfWidth: 0.1, lift: 0.08, turnDistance: 0.4, firstStep: 0.4 } },
	{ skill: "smokeCigarette", f0: 440 }] };
const xb = skeletonFor("x-bot-tpose"), car = compileSpec(exitcar, { sk: xb, scene: motionScene(SCENE_OBJECTS) });
// the exitCar skill's handle fit turns the hand onto the handle since lane wrist (compiler/grip.js; was df302cb1a12b1a31),
// and its walk strikes with the heel and pushes off the ball since the foot rockers (compiler/walk.js; was 74582d7bb52a8a7a),
// its elbows bend with the arm swing since the walk's arms (compiler/walk.js; was cde50567a618c2b2),
// its hips follow the legs since compiler/walk-pelvis.js (was 42daab3008d5072e),
// its holds breathe and shift their weight since the idle layer (compiler/idle.js; was 2f6c5ac393b2b2aa),
// its walk has a smaller heel strike and stride length variation (walk.js, gait-rhythm.js; was 9230a88561f639ab),
// its walk is hips-first (walk-pelvis.js, walk.js; was f0428b2edc4870f1),
// and its walk has the narrower foot width, flat-ish heel strike and less stride-time noise (walk.js, gait-rhythm.js; was d1e1f37c072d3d94; QA 0 before and after),
// its walk scales its knees, kick, strike and hips with its pace, the swing foot following the shank (walk.js, walk-pelvis.js; was 76db856fa910b0c0; QA 0 before and after),
// and its walk's upper body follows its pace and leads the legs (walk.js, head-steady.js; was 26b40e28f45e83b3; QA 0 before and after),
// and its head leads the walk's turns (head-lead.js; was b9ba45c96cc782c5; QA 0 before and after)
expect("the exitcar take from skills bakes bit for bit as before", hashOf(bakeTake(xb, car.out)) === "4c47b555a7cd8b53" && !car.observations.paced, hashOf(bakeTake(xb, car.out)));
// re-pinned when standIdle and walks began keying arm_hang (compiler/pose.js: a free forearm hangs plumb); QA unchanged
const HASHES = { "y-bot-tpose": "23c7c29a978ffeb1", "x-bot-tpose": "35bbaaf6f2607e62" };
for (const [rig, hash] of Object.entries(HASHES)) {
	const r = compile(rig, smoke(266, STAND, false), false), got = hashOf(bakeTake(skeletonFor(rig), r.out));
	expect(`${rig}: the standing smoke at its own length bakes bit for bit as before`, got === hash && !r.observations.paced && !("paced" in r.used[1]), got);
}

if (failures) { console.error(`${failures} smoke pacing check(s) failed`); process.exit(1); }
console.log("smoke pacing: all checks passed");

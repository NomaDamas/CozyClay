#!/usr/bin/env node
// Skill library: the car-exit fixture rebuilt from four skills (sitInSeat, exitCar, walkTo,
// smokeCigarette) compiles to QA 0 and matches the hand-written fixture; the car skills follow
// the car when it is moved, turned or mirrored (side "r"); standIdle, walkTo { to } and
// reachGrip work on their own; the agent's own keys win over a skill's.
import { EXITCAR_SPEC, SCENE_OBJECTS } from "./fixtures/exitcar-scene.mjs";
import { compileSpec, legacySpec } from "./fixtures/legacy-compile.mjs";
import { compileMotion } from "../../src/motion3/compiler/compile.js";
import { expandUse } from "../../src/motion3/skills/index.js";
import { resolveFrames } from "../../src/motion3/skills/frames-auto.js";
import { createSpecStore } from "../../src/motion3/spec-store.js";
import { motionScene } from "../../src/motion3/scene.js";
import { skeletonFor } from "../../src/motion3/rigs/index.js";
import { dist, add, apply, mul, ry } from "../../src/motion3/compiler/math.js";
import { compileSpec as compilePipeline } from "../../src/motion3/pipeline.js";

let failures = 0;
function expect(name, condition, detail = "") {
	console.log(`${condition ? "PASS" : "FAIL"} ${name}${condition ? "" : ` — ${detail}`}`);
	if (!condition) failures += 1;
}
const sk = skeletonFor("x-bot-tpose"), I = sk.index, car = motionScene(SCENE_OBJECTS);
const exitcar = (side = "l", sg = 1, yaw = 0) => ({ schema: "cozyclay.motion-spec.v1", fps: 24, frames: 730, label: "Get out of the convertible and smoke", use: [
	{ skill: "sitInSeat", f0: 0, args: { car: "Car", offset: [-0.06 * sg, 0.17, 0.023] } },
	{ skill: "exitCar", f0: 0, args: { car: "Car", side } },
	{ skill: "walkTo", f0: 246, args: { heading: [125 * sg + yaw, 150 * sg + yaw], steps: 8, step: 0.5, halfWidth: 0.1, lift: 0.08, turnDistance: 0.4, firstStep: 0.4 } },
	{ skill: "smokeCigarette", f0: 440 },
] });

// 1. The fixture from skills.
const spec = exitcar();
console.log(`  skill spec: ${JSON.stringify(spec).length} bytes vs the hand-written fixture ${JSON.stringify(EXITCAR_SPEC).length} bytes`);
const r = compileSpec(spec, { sk, scene: car });
console.log(`  compiled from skills: QA ${r.qa.total}, skills ${JSON.stringify(r.used)}, fixed ${JSON.stringify(r.fixed)}, ${JSON.stringify(r.ms)}`);
expect("the exitcar scene rebuilt from skills compiles to QA 0", r.qa.ok, JSON.stringify(r.qa.groups.slice(0, 3)));
expect("the skills report where each ends", JSON.stringify(r.used.map(u => u.end)) === "[0,246,440,729]", JSON.stringify(r.used));
for (const part of ["anchors", "props", "fits", "objects"]) expect(`same ${part} as the fixture`, JSON.stringify(r.expanded[part]) === JSON.stringify(EXITCAR_SPEC[part]), JSON.stringify(r.expanded[part]).slice(0, 200));
// the skills rebuild the fixture with the earlier lanes' compiler (fix.self: verify-motion3-self.mjs)
const ref = compileMotion(legacySpec(JSON.parse(JSON.stringify(EXITCAR_SPEC))), { sk, scene: car });
// but the head top in the swivel out of the seat: from the skill the head leads that turn (head-lead.js NOT_A_LOOK), the
// fixture keys the same look as the agent's own keys, which win
let worst = 0, lead = 0;
const swivel = (f, j) => f >= 70 && f <= 160 && j === I.HeadTop_End;
for (let f = 0; f < 730; f++) for (let j = 0; j < sk.names.length; j++) {
	const d = dist(ref.frames[f].s.P[j], r.out.frames[f].s.P[j]);
	if (swivel(f, j)) lead = Math.max(lead, d); else worst = Math.max(worst, d);
}
console.log(`  largest joint difference to the fixture over 730 frames: ${(worst * 1000).toFixed(1)} mm (the skills use the rig's ankle height 0.0873 m, the fixture 0.087)`);
expect("every joint within 1 cm of the hand-written fixture", worst < 0.01, worst);
expect("the head top in the swivel within 4 cm of it (the head leads that turn)", lead < 0.04, lead);

// 2. The same car moved and turned 40 deg, and mirrored with the driver door on the right.
const place = (yaw, mirror) => {
	const swap = id => id.replace(/_(L|R)$/, m => (m === "_L" ? "_R" : "_L")).replace(/_(F|R)(L|R)$/, (m, a, b) => `_${a}${b === "L" ? "R" : "L"}`);
	const base = motionScene(SCENE_OBJECTS.map(o => (mirror ? { ...o, id: swap(o.id), x: -o.x, rot: -o.rot, rotZ: -o.rotZ } : o))), Ry = ry(yaw), out = { objects: {} };
	for (const [id, b] of Object.entries(base.objects)) out.objects[id] = { ...b, pos: add(apply(Ry, b.pos), [3, 0, -1]), R: mul(Ry, b.R) };
	return out;
};
for (const [label, yaw, mirror] of [["moved and turned 40 deg", 40, false], ["mirrored, side r", 0, true], ["mirrored and turned -70 deg", -70, true]]) {
	const sg = mirror ? -1 : 1, rr = compileSpec(exitcar(mirror ? "r" : "l", sg, yaw), { sk, scene: place(yaw, mirror) });
	console.log(`  ${label}: QA ${rr.qa.total} (${rr.ms.total} ms)`);
	expect(`exitCar follows the car: ${label}, QA 0`, rr.qa.ok, JSON.stringify(rr.qa.groups.slice(0, 2).map(g => [g.kind, g.subject, g.hint])));
	if (mirror) expect(`  ${label}: the right hand grips the handle`, rr.expanded.fits[0].side === "r" && rr.expanded.checks.contacts[0].when === "w_handle_r");
}

// 3. Basic skills on their own: stand, walk to a point, reach and grip.
const empty = { objects: {} };
const walkTo = compileSpec({ schema: "cozyclay.motion-spec.v1", fps: 24, frames: 260,
	use: [{ skill: "standIdle", f0: 0, args: { at: [0, 0], heading: 0 } }, { skill: "walkTo", f0: 10, args: { to: [2, 3] } }] }, { sk, scene: empty });
const end = walkTo.out.frames[259].s.P[I.Hips];
console.log(`  walkTo { to: [2, 3] }: QA ${walkTo.qa.total}, hips end at ${end.map(v => v.toFixed(2))}, ${JSON.stringify(walkTo.used)}`);
expect("walkTo { to } walks clean and ends within 0.35 m of the point", walkTo.qa.ok && Math.hypot(end[0] - 2, end[2] - 3) < 0.35, JSON.stringify(walkTo.qa.groups.slice(0, 2)));
const grip = compileSpec({ schema: "cozyclay.motion-spec.v1", fps: 24, frames: 100,
	use: [{ skill: "standIdle", f0: 0, args: { at: [0, 0] } }, { skill: "reachGrip", f0: 10, args: { anchor: "bar", side: "r", define: { kind: "world", p: [-0.2, 1.2, 0.33] }, elbow: [-0.5, -1, -0.3] } }] }, { sk, scene: empty });
const held = grip.out.frames.filter(fr => fr.c.w_bar_r > 0.99);
console.log(`  reachGrip: QA ${grip.qa.total}, ${held.length} frames on the bar`);
expect("reachGrip: the fingers hold the bar with QA 0 (contact check included)", grip.qa.ok && held.length >= 20 && grip.expanded.checks.contacts.length === 1, JSON.stringify(grip.qa.groups.slice(0, 2)));

// 4. The agent's own key at a skill's frame wins; a skill error names the skill.
const own = expandUse({ ...exitcar(), keys: [{ f: 84, set: { door: -60 } }] }, { sk, scene: car }).spec;
const door = compileMotion(JSON.parse(JSON.stringify(own)), { sk, scene: car }, { fixes: false }).baked.door[84];
expect("an agent key overrides the skill's value on the same frame", door === -60, door);
let msg = "";
try { compileSpec({ ...exitcar(), use: [{ skill: "exitCar", f0: 0, args: { seat: "Nope" } }] }, { sk, scene: car }); } catch (error) { msg = error.message; }
expect("a skill names its bad argument", msg.includes("use[0] exitCar: args.seat \"Nope\" is not a scene object"), msg);

// 5. Too few frames names what the skill needs (smokeCigarette first paces down to 75% of its
//    length); frames "auto" ends where the last skill ends.
msg = "";
// (the walk's last step lands at f416; a take that ends after it only cuts the settle, lane M2)
try { compileSpec({ ...exitcar(), frames: 400 }, { sk, scene: car }); } catch (error) { msg = error.message; }
expect("a skill past the last frame says how many frames it needs", msg.includes('use[2] walkTo needs 194 frames from f246 (to f440), past the last frame f399; set frames >= 441 or frames: "auto"'), msg);
msg = "";
try { compileSpec({ ...exitcar(), frames: 600 }, { sk, scene: car }); } catch (error) { msg = error.message; }
expect("smokeCigarette short of its paced minimum says the frames and seconds it needs", msg.includes('use[3] smokeCigarette: needs frames f440..f638 at least: 199 frames, 8.3 s at 24 fps, paced 0.75 (265 frames, 11.0 s, at its own pace); it has f440..f599, so set frames >= 639 or frames: "auto"'), msg);
expect("frames auto: smokeCigarette (holding to the end) ends with its own motion", resolveFrames({ ...exitcar(), frames: "auto" }, { sk, scene: car }).frames === 705);

// 6. The spec store keeps the "auto" intent beside the resolved number (spec-store.js): get()
//    answers frames: "auto" for a spec compiled from it, even after the same spec is put again
//    unmarked (motion.qa re-measuring the take); a spec sent with a number stays a number.
const store = createSpecStore(), autoRun = compileSpec({ ...exitcar(), frames: "auto" }, { sk, scene: car });
const autoId = store.put(autoRun.spec);
store.put(structuredClone(autoRun.spec));
const numberId = store.put({ ...exitcar(), frames: 720 });
expect("spec store: a spec resolved from frames auto comes back as auto; the stored spec keeps the number",
	autoRun.spec.frames === 705 && store.get(autoId)?.frames === "auto" && store.get(numberId)?.frames === 720, JSON.stringify({ stored: autoRun.spec.frames, auto: store.get(autoId)?.frames }));

// walkTo { to, arrive }: the engine plans the cadence (walk-plan.js) instead of the agent sweeping period and step
const walkBy = (args, before = { at: [0, 0], heading: 0 }) => compilePipeline({ schema: "cozyclay.motion-spec.v1", fps: 24, frames: "auto",
	use: [{ skill: "standIdle", f0: 0, args: before }, { skill: "walkTo", f0: 1, args }] }, { sk, scene: motionScene([]) });
const endOf = r => r.used.find(u => u.skill === "walkTo").end, planned = r => (r.observations.planned ?? []).join(" ");
const by79 = walkBy({ to: [0.07, 2.0], arrive: 79 });
expect("arrive f79 for 2 m: a clean walk planned to end by f79 (the cadence the agent of session 260c7529 found after five sweeps)",
	by79.qa.total === 0 && endOf(by79) <= 79 && /^use\[1\] walkTo arrive f79: steps \d+, period \d+, swing \d+, step [\d.]+ m/.test(planned(by79)), `${by79.qa.total} f${endOf(by79)} ${planned(by79)}`);
expect("the stored spec keeps arrive and no planned args (a recompile plans again)", by79.spec.use[1].args.arrive === 79 && by79.spec.use[1].args.steps === undefined && by79.spec.frames === endOf(by79) + 1);
const by48 = walkBy({ to: [0.07, 2.0], arrive: 48 });
expect("arrive f48 for 2 m is too soon: the earliest clean walk, and the note says why and what to give", by48.qa.total === 0 && endOf(by48) > 48 && /f48 is too soon: even the quickest walk .* ends f\d+; give arrive >= f\d+/.test(planned(by48)), planned(by48));
const by140 = walkBy({ to: [0.07, 2.0], arrive: 140 });
expect("arrive f140 for 2 m: a slower walk that uses the time (ends f130..f140, a step every 16+ frames)", by140.qa.total === 0 && endOf(by140) <= 140 && endOf(by140) >= 130 && /period (1[6-9]|2\d)/.test(planned(by140)), planned(by140));
const turned = walkBy({ to: [3, 1.5], arrive: 100 }, { at: [1, 0], heading: 90 });
expect("the distance is read where the feet stand at f0 (after another skill)", turned.qa.total === 0 && endOf(turned) <= 100 && endOf(turned) >= 90, `${planned(turned)}`);
const fixed = walkBy({ to: [0.07, 2.0], arrive: 79, period: 12 });
expect("explicit steps/period/step/swing win: no plan", fixed.observations.planned === undefined);
expect("deterministic: the same request plans the same walk", planned(walkBy({ to: [0.07, 2.0], arrive: 79 })) === planned(by79));

if (failures) { console.error(`${failures} motion3 skills check(s) failed`); process.exit(1); }
console.log("motion3 skills: all checks passed");

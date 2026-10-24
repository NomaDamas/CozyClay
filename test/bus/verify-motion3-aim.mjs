#!/usr/bin/env node
// C16 aim keys (docs/motion-api-v3.1.md): a held-object key may give aim [x, y, z], the world
// direction of the object's +Y, with roll (degrees about it), in place of the quaternion rot. The
// baseball swing of session 294ac65a (the J2 fixture): its four rot keys written as aims compile to
// the same take, bit for bit; roll turns the object about aim; both rot and aim is refused; the
// compile output measures every key as drawn (observations.held); motion.keyObject writes aim keys.
// The car exit's take hash changed with the walk's narrower foot width, flat-ish heel strike and less stride-time noise
// (walk.js, gait-rhythm.js; QA 0 before and after), with the hips-first walk (walk-pelvis.js, walk.js; QA 0 before and after), and with
// the walk's smaller heel strike and stride length term (walk.js, gait-rhythm.js;
// QA 0 before and after), and before that with the walk's foot rockers (compiler/walk.js: its walk strikes with the heel and
// pushes off the ball), its arms (the elbows bend with the swing), its hips (compiler/walk-pelvis.js) and the idle layer of its
// holds (compiler/idle.js); the swing's changed with lane L2 (its sunk Y Bot soles lift onto the floor and the
// back foot pivots on its ball), the keyed swing's before that with lane K8 (the arm follows).
// Flow (compiler/channels.js: the free spine, head and arms carry through keys and trail) re-baked the takes whose arms swing
// free (exitcar, walk, cup run3, the standing smokes, df6acdcc, 6262a69c); their QA did not change.
import { takeHash as hashOf } from "../motion3/fixtures/take-hash.mjs";
import { SCENE_OBJECTS, CHARACTER, SWING_SPEC, SWING_KEYS, BAT } from "../motion3/fixtures/bat-swing.mjs";
import { EXITCAR_SPEC, SCENE_OBJECTS as CAR_OBJECTS, CHARACTER as DRIVER } from "../motion3/fixtures/exitcar-scene.mjs";
import { compileSpec } from "../motion3/fixtures/legacy-compile.mjs";
import { validateSpec } from "../../src/motion3/compiler/validate.js";
import { bakeTake } from "../../src/motion3/take.js";
import { motionScene } from "../../src/motion3/scene.js";
import { skeletonFor } from "../../src/motion3/rigs/index.js";
import { rootPoseAt } from "../../src/motion3/object-pose.js";
import { keyObject } from "../../src/motion3/key-edit.js";
import { quatFromMat, matFromQuat, mul, axisRot, angle, norm, sub } from "../../src/motion3/compiler/math.js";
import { qmul, qconj, qrot, qnorm, qdot, arcQuat } from "../../src/motion3/compiler/quat.js";

let failures = 0;
function expect(name, condition, detail = "") {
	console.log(`${condition ? "PASS" : "FAIL"} ${name}${condition ? "" : ` — ${detail}`}`);
	if (!condition) failures += 1;
}
const refusal = run => { try { run(); return ""; } catch (error) { return error.message; } };
const sk = skeletonFor(CHARACTER.model), scene = motionScene(SCENE_OBJECTS);
const withKeys = keys => { const sp = structuredClone(SWING_SPEC); sp.objects[BAT].keys = keys; return sp; };
const compile = keys => compileSpec(withKeys(keys), { sk, scene });
const Y = [0, 1, 0], col = (R, i) => [R[0][i], R[1][i], R[2][i]];

// 1. the car exit bakes the take of v3@9674cdcf with the walk's natural rhythm (compiler/gait-rhythm.js); the plain swing bakes lane L2's (soles on the floor, the back foot pivots on its ball),
// the keyed one lane N1's (its left hand, anchored to the bat, swivels its elbow clear of the torso: C14 second hand); both
// with lane Q1's flat feet (a foot flat on the floor keeps its heading until its heel lifts: it turned 7.2 deg flat)
const plain = compileSpec(SWING_SPEC, { sk, scene }), keyed = compile(SWING_KEYS), dsk = skeletonFor(DRIVER.model);
const car = compileSpec({ fps: 24, ...EXITCAR_SPEC }, { sk: dsk, scene: motionScene(CAR_OBJECTS) });
// re-pinned when standIdle and walks began keying arm_hang (compiler/pose.js: a free forearm hangs plumb); QA unchanged
// re-pinned when the walk scaled its knees, swing kick, heel strike and hips at the strike with its pace and the swing foot
// began following the shank (walk.js, walk-pelvis.js); QA 0 before and after
// re-pinned when the walk's upper body began following its pace and leading the legs (walk.js, head-steady.js); QA 0 before and after
// re-pinned when the head began leading the walk's turns (head-lead.js); QA 0 before and after
const hashes = { plain: hashOf(bakeTake(sk, plain.out)), keyed: hashOf(bakeTake(sk, keyed.out)), exitcar: hashOf(bakeTake(dsk, car.out)) };
expect("the car exit bakes the take of the grip turn on its door handle (compiler/grip.js), bit for bit; the swing without keys bakes the take of lane Q1, with the J2 rot keys the take of lane Q1",
	hashes.plain === "7e49b1630982dfc8" && hashes.keyed === "248dc5649b0c7499" && hashes.exitcar === "6dfc89e506976346", JSON.stringify(hashes));

// 2. the same keys as aims: +Y of each rot; roll = its turn about aim from where the plain carry holds the bat at that frame
const rollFrom = (q, from, aim) => {
	const r = qmul(q, qconj(qmul(arcQuat(qrot(from, Y), aim), from))), sg = r[3] < 0 ? -1 : 1;
	return 2 * Math.atan2(sg * (r[0] * aim[0] + r[1] * aim[1] + r[2] * aim[2]), sg * r[3]) * 180 / Math.PI;
};
const asAim = k => { const q = qnorm(k.rot), aim = qrot(q, Y); return { f: k.f, pos: k.pos, aim, roll: rollFrom(q, quatFromMat(rootPoseAt(plain.out, BAT, k.f).R), aim) }; };
const aims = SWING_KEYS.map(asAim), aimed = compile(aims);
console.log(`  the fixture's keys as aims: roll ${aims.map(a => a.roll.toFixed(4)).join(", ")} deg (the fixture turned the plain bat the short way onto each aim)`);
expect("aim keys derived from the J2 rot keys bake the same take, bit for bit", hashOf(bakeTake(sk, aimed.out)) === hashes.keyed, hashOf(bakeTake(sk, aimed.out)));
const held = aimed.observations.held?.[BAT];
expect("observations.held reads back the rot each aim key used (the fixture's rot) and measures each key as drawn",
	held?.length === 4 && held.every((h, i) => h.f === SWING_KEYS[i].f && JSON.stringify(h.rot) === JSON.stringify(SWING_KEYS[i].rot) && h.deg === 0 && h.cm === 0 && !h.got)
	&& /held: per key, deg = the drawn \+Y off the asked one/.test(aimed.observations.units), JSON.stringify(aimed.observations.held));
expect("rot keys get rows too, without rot; a spec without keys has no held", keyed.observations.held[BAT].every(h => !("rot" in h)) && !plain.observations.held);

// 3. what an agent writes: the barrel directions to 2 decimals, no roll -> the hand holds every key (no REACH)
const rough = compile(aims.map(a => ({ f: a.f, pos: a.pos, aim: a.aim.map(v => +v.toFixed(2)) })));
console.log(`  2-decimal aims, no roll: QA ${rough.qa.total} (rot keys ${keyed.qa.total}); held ${JSON.stringify(rough.observations.held[BAT].map(h => [h.f, h.deg, h.cm]))}`);
// WRIST (qa/wrist-checks.js) is left out of the comparison: an aim without roll takes the roll the arm holds most easily,
// which moves where the left wrist tops out; it is pinned below
const notWrist = r => r.qa.groups.filter(g => g.kind !== "WRIST").reduce((n, g) => n + g.count, 0);
expect("2-decimal aims with no roll: no REACH, every key drawn within 1 deg and 1 cm, the same QA total as the rot keys (WRIST aside)",
	!rough.qa.groups.some(g => g.kind === "REACH") && notWrist(rough) === notWrist(keyed) && rough.observations.held[BAT].every(h => h.deg < 1 && h.cm < 1), rough.qa.groups.map(g => `${g.kind} ${g.subject}`).join(" | "));
expect("WRIST: the two-hand swing asks the left wrist past its ulnar limit (35 deg) on a few frames, with rot keys and aims alike",
	[rough, keyed].every(r => r.qa.groups.some(g => g.kind === "WRIST" && /^hand_l ulnar deviation/.test(g.subject) && g.count <= 8)), [rough, keyed].map(r => r.qa.groups.filter(g => g.kind === "WRIST").map(g => `${g.subject} n${g.count}`).join(" | ")).join(" || "));
const rots = rough.observations.held[BAT].map(h => h.rot);
expect("the resolved rots are unit, on the 1e-5 grid and on one hemisphere", rots.every((q, i) => Math.abs(Math.hypot(...q) - 1) < 1e-4 && q.every(v => Math.abs(v * 1e5 - Math.round(v * 1e5)) < 1e-6) && (!i || qdot(q, rots[i - 1]) >= 0)));

// 4. roll: the contact key turned 30 deg about the bat draws as the rot key turned the same way
const R47 = matFromQuat(SWING_KEYS[2].rot), turned = mul(axisRot(col(R47, 1), 30), R47), rotKey = { ...SWING_KEYS[2], rot: quatFromMat(turned) };
const byRot = compile(SWING_KEYS.map((k, i) => (i === 2 ? rotKey : k))), byRoll = compile(SWING_KEYS.map((k, i) => (i === 2 ? { ...asAim(k), roll: asAim(k).roll + 30 } : k)));
let rollOff = 0;
for (let f = 30; f <= 70; f++) rollOff = Math.max(rollOff, ...[0, 1, 2].map(c => angle(col(rootPoseAt(byRot.out, BAT, f).R, c), col(rootPoseAt(byRoll.out, BAT, f).R, c))));
expect("roll turns an aim key about aim: roll + 30 draws the rot key turned 30 deg about the bat (<= 0.01 deg, f30-f70)", rollOff <= 0.01, `${rollOff}`);

// 5. far from feasible: the barrel asked to point out along the arm at contact (the shoulder to the grip; the wrist would
// fold back on the forearm whatever the elbow and the roll do) -> REACH, and the key row says how far (lane K8: the barrel at
// the batter's back, the old case here, is now held: the elbow swings, the forearm turns and the key takes the easiest roll)
const outward = norm(sub(SWING_KEYS[2].pos, plain.out.frames[47].s.P[sk.index.RightArm]));
const back = compile(SWING_KEYS.map((k, i) => (i === 2 ? { f: k.f, pos: k.pos, aim: outward } : k))), row = back.observations.held[BAT][2];
expect("a key the hand cannot hold: REACH, and its row gives the degrees off, the drawn +Y and the resolved rot", back.qa.groups.some(g => g.kind === "REACH") && row.deg > 20 && row.got?.length === 3 && row.rot?.length === 4,
	JSON.stringify(row));

// 6. validation (exact messages)
const bad = keys => refusal(() => validateSpec({ ...withKeys(keys), objects: { [BAT]: { ...SWING_SPEC.objects[BAT], keys } } }, { sk, scene }));
const k0 = { f: 40, pos: SWING_KEYS[0].pos };
expect("both rot and aim is refused", bad([{ ...k0, rot: SWING_KEYS[0].rot, aim: [0, 1, 0] }]).includes(`objects.${BAT}.keys[0] gives both rot and aim; give one: rot [x, y, z, w], or aim [x, y, z] (the world direction its +Y points) with roll`));
expect("neither, a zero aim, a bad roll and a roll without aim are refused by name",
	bad([{ ...k0 }]).includes(`objects.${BAT}.keys[0].rot must be a unit quaternion [x, y, z, w], got undefined; or give aim [x, y, z], the world direction its +Y points`)
	&& bad([{ ...k0, aim: [0, 0, 0] }]).includes(`objects.${BAT}.keys[0].aim must be a non-zero world direction [x, y, z] for the object's +Y (a bat: knob to barrel), got [0,0,0]`)
	&& bad([{ ...k0, aim: [0, 1, 0], roll: "x" }]).includes(`objects.${BAT}.keys[0].roll must be degrees about aim (a number), got "x"`)
	&& bad([{ ...k0, rot: SWING_KEYS[0].rot, roll: 10 }]).includes(`objects.${BAT}.keys[0].roll turns the object about aim; give aim [x, y, z] with it, or leave roll out (rot fixes the roll)`), bad([{ ...k0 }]));
expect("an unknown key field lists rot and aim", bad([{ ...k0, aimm: [0, 1, 0] }]).includes(`objects.${BAT}.keys[0] has unknown field "aimm"; did you mean "aim"?; a key is { f, pos: [x, y, z], rot: [x, y, z, w] } or { f, pos, aim: [x, y, z], roll? }`),
	bad([{ ...k0, aimm: [0, 1, 0] }]));

// 7. motion.keyObject writes an aim key (rounded), and refuses rot with aim
const edit = args => keyObject(withKeys(SWING_KEYS), scene, { objectId: BAT, frame: 47, pos: [0.41791, 1.16664, 0.24823], ...args });
const written = edit({ aim: [0.123456789, 0.5, 0.8], roll: 12.3456 }).spec.objects[BAT].keys.find(k => k.f === 47);
expect("motion.keyObject upserts { f, pos, aim, roll } (pos 0.1 mm, aim 1e-5, roll 0.01 deg)", JSON.stringify(written) === JSON.stringify({ f: 47, pos: [0.4179, 1.1666, 0.2482], aim: [0.12346, 0.5, 0.8], roll: 12.35 }), JSON.stringify(written));
expect("motion.keyObject refuses both rot and aim, and neither", /needs pos \[x, y, z\] and rot \[x, y, z, w\] or aim \[x, y, z\] \(\+ roll\), one of the two/.test(refusal(() => edit({ aim: [0, 1, 0], rot: [0, 0, 0, 1] })))
	&& /needs pos/.test(refusal(() => edit({}))));

if (failures) { console.error(`${failures} motion3 aim-key check(s) failed`); process.exit(1); }
console.log("motion3 aim keys: all checks passed");

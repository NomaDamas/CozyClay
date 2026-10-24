#!/usr/bin/env node
// Finger pose QA (qa/finger-checks.js): a finger bent back, twisted off its hinge or lying in its neighbour is a QA issue
// even while three other fingertips still touch the can; the shipped takes and every preset on both hands stay clean,
// and two presets keyed at 1 together share the curl instead of adding it (limbs.js).
import { compileSpec } from "../../src/motion3/pipeline.js";
import { motionScene } from "../../src/motion3/scene.js";
import { skeletonFor } from "../../src/motion3/rigs/index.js";
import { graspChecks, heldSpans } from "../../src/motion3/qa/grasp-checks.js";
import { fingerChecks, fingerFlexion } from "../../src/motion3/qa/finger-checks.js";
import { runMotionQa } from "../../src/motion3/qa/index.js";
import { rotateSubtree } from "../../src/motion3/compiler/skeleton.js";
import { axisRot, sub, norm } from "../../src/motion3/compiler/math.js";
import { palmAxes, fistCurl } from "../../src/motion3/compiler/limbs.js";
import { CAN_SCENE, canGripSpec } from "./fixtures/can-grip.mjs";
import { BALL_SCENE, ballPickupSpec, MODEL } from "./fixtures/ball-pickup.mjs";

let failures = 0;
function expect(name, condition, detail = "") {
	console.log(`${condition ? "PASS" : "FAIL"} ${name}${condition ? "" : ` - ${detail}`}`);
	if (!condition) failures += 1;
}
const kinds = issues => [...new Set(issues.map(i => i.kind))];

const cases = [["can", "y-bot-tpose", CAN_SCENE, canGripSpec()], ["can", "x-bot-tpose", CAN_SCENE, canGripSpec()], ["ball", MODEL, BALL_SCENE, ballPickupSpec()]];
for (const [name, model, sceneRecords, spec] of cases) {
	const sk = skeletonFor(model), scene = motionScene(sceneRecords), base = () => compileSpec(spec, { sk, scene }).out, J = n => sk.index[`RightHand${n}`];
	const clean = base(), held = heldSpans(clean)[0], judged = clean.frames.map((_, f) => f).filter(f => f >= held.from && f <= held.to && (!held.held || held.held(f)));
	expect(`${name} ${model}: the take has no finger pose issue`, fingerChecks(sk, clean).length === 0, JSON.stringify(fingerChecks(sk, clean).slice(0, 2)));
	const turn = (s, j, axis, deg) => rotateSubtree(sk, s, J(j), s.P[J(j)].slice(), axisRot(axis, deg));
	const mutants = {
		"index bent back 90 deg": [s => turn(s, "Index1", palmAxes(sk, s, "Right").l, -90), "FINGER_ROM"],
		"index tip bent back 80 deg": [s => turn(s, "Index3", palmAxes(sk, s, "Right").l, -80), "FINGER_ROM"],
		"middle twisted 180 deg": [s => turn(s, "Middle1", norm(sub(s.P[J("Middle2")], s.P[J("Middle1")])), 180), "FINGER_ROM"],
		"index folded into the middle": [s => turn(s, "Index1", palmAxes(sk, s, "Right").n, -40), "FINGER_SELF"],
	};
	for (const [label, [mutate, kind]] of Object.entries(mutants)) {
		const out = base();
		for (const f of judged) mutate(out.frames[f].s);
		expect(`${name} ${model}: ${label} is ${kind}`, kinds(fingerChecks(sk, out)).includes(kind), JSON.stringify(kinds(fingerChecks(sk, out))));
		if (name === "can" && label === "index bent back 90 deg") {
			expect(`${name} ${model}: ${label} passes the grasp checks alone (the gap this closes)`, graspChecks(sk, out).length === 0);
			const qa = runMotionQa(sk, out, spec), group = qa.groups.find(g => g.kind === "FINGER_ROM");
			expect(`${name} ${model}: QA reports it with a hint on fingers_r`, !qa.ok && /fingers_r/.test(group?.hint ?? ""), JSON.stringify(group));
		}
	}
}

for (const model of ["y-bot-tpose", "x-bot-tpose"]) {
	const sk = skeletonFor(model), pose = set => compileSpec({ schema: "cozyclay.motion-spec.v1", fps: 24, frames: 4, use: [{ skill: "standIdle", args: { heading: 0, at: [0, 0] }, f0: 0 }], keys: [{ f: 0, set }] }, { sk, scene: motionScene([]) }).out;
	for (const preset of ["relaxed", "fist", "grip", "point", "cigarette", "spherical"]) {
		const out = pose({ fingers_r: { [preset]: 1 }, fingers_l: { [preset]: 1 } });
		expect(`${model}: the ${preset} preset on both hands is clean`, fingerChecks(sk, out).length === 0, JSON.stringify(fingerChecks(sk, out).slice(0, 2)));
	}
	const stacked = pose({ fingers_r: { fist: 1, grip: 1 } }), flex = fingerFlexion(sk, stacked.frames[0].s, "Right", "Index");
	expect(`${model}: fist and grip keyed together curl no further than the fist`, flex.every((a, k) => a <= fistCurl("Index", k) + 0.5) && fingerChecks(sk, stacked).length === 0, JSON.stringify(flex));
	const pointed = pose({ fingers_r: { point: 1, cigarette: 1 } });
	expect(`${model}: point and cigarette keyed together do not bend the index back`, fingerFlexion(sk, pointed.frames[0].s, "Right", "Index").every(a => a >= 0), JSON.stringify(fingerFlexion(sk, pointed.frames[0].s, "Right", "Index")));
}

// the ball stays carried after reachGrip lets its grip go: the carry's grasp keeps the thumb wrapped on it
for (const model of ["y-bot-tpose", "x-bot-tpose"]) {
	const sk = skeletonFor(model), scene = motionScene(BALL_SCENE), out = compileSpec(ballPickupSpec(), { sk, scene }).out, held = heldSpans(out)[0];
	const thumbOff = issues => issues.filter(i => i.kind === "THUMB_OFF");
	expect(`ball pickup ${model}: the thumb stays on the ball while it is carried`, thumbOff(graspChecks(sk, out)).length === 0, JSON.stringify(thumbOff(graspChecks(sk, out)).slice(0, 2)));
	const J = n => sk.index[`RightHand${n}`], open = compileSpec(ballPickupSpec(), { sk, scene }).out;
	for (let f = held.from; f <= held.to; f++) rotateSubtree(sk, open.frames[f].s, J("Thumb1"), open.frames[f].s.P[J("Thumb1")].slice(), axisRot(palmAxes(sk, open.frames[f].s, "Right").n, 70));
	expect(`ball pickup ${model}: a thumb swung off the ball is THUMB_OFF`, thumbOff(graspChecks(sk, open)).length > 0);
}

// a caught ball sits toward the index side: the ring finger's curl passed beside it until it turns toward it at the knuckle
{
	const { buildKit } = await import("../../src/kits/index.js"), { objectPoseAt, partsOf } = await import("../../src/motion3/object-pose.js"), { capsuleDepth } = await import("../../src/motion3/shapes.js");
	const kit = buildKit("ball", [], { position: { x: 0, y: 1.6, z: 6 } }), id = kit.rootId, sk = skeletonFor("y-bot-tpose"), J = n => sk.index[`RightHand${n}`];
	const spec = { schema: "cozyclay.motion-spec.v1", fps: 24, frames: 64, use: [{ skill: "standIdle", args: { at: [0, 0], heading: 0 }, f0: 0 }, { skill: "catchObject", args: { object: id }, f0: 12 }], objects: { [id]: { fall: { at: 12, v: [0, 2.5, -9] } } } };
	const out = compileSpec(spec, { sk, scene: motionScene(kit.records) }).out, f = out.ctx.spec.objects[id].grab + 8, s = out.frames[f].s;
	const ball = partsOf(out.ctx.scene, id).map(p => ({ ...out.ctx.scene.objects[p], ...objectPoseAt(out, p, f) }));
	const ringGap = -Math.max(...ball.map(e => capsuleDepth(e, s.P[J("Ring3")], s.P[J("Ring4")], 0.009)));
	expect("catch y-bot: the ring finger closes onto the ball", ringGap <= 0.008, ringGap);
	expect("catch y-bot: no finger lies in another or past its range", fingerChecks(sk, out).length === 0, JSON.stringify(fingerChecks(sk, out).slice(0, 2)));
}

if (failures) { console.error(`${failures} finger pose check(s) failed`); process.exit(1); }
console.log("all finger pose checks passed");

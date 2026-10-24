#!/usr/bin/env node
// flow.headLead (src/motion3/compiler/head-lead.js): when the trunk turns the head turns first. A walk that turns
// toward its goal compiles clean with the head leading the pelvis by several frames (observations.life.lead), the
// offset bounded; headLead false leaves the head on the pelvis's frame; a recompile is identical; a look the keys
// set during the walk wins.
import { compileSpec } from "../../src/motion3/pipeline.js";
import { skeletonFor } from "../../src/motion3/rigs/index.js";
import { motionScene } from "../../src/motion3/scene.js";

let failures = 0;
function expect(name, condition, detail = "") {
	console.log(`${condition ? "PASS" : "FAIL"} ${name}${condition ? "" : ` — ${detail}`}`);
	if (!condition) failures += 1;
}
const sk = skeletonFor("x-bot-tpose"), scene = motionScene([]), json = JSON.stringify;
const turnWalk = (extra = {}) => ({ schema: "cozyclay.motion-spec.v1", fps: 24, frames: "auto", ...extra,
	use: [{ skill: "standIdle", f0: 0, args: { at: [0, 0], heading: 0 } }, { skill: "walkTo", f0: 6, args: { to: [3, 3] } }] });
const run = spec => compileSpec(spec, { sk, scene });
const pose = r => json(r.out.frames.map(fr => [fr.s.P, fr.s.R]));

const on = run(turnWalk()), off = run(turnWalk({ flow: { headLead: false } }));
const lead = on.observations.life.lead, flat = off.observations.life.lead;
console.log(`  walkTo [3,3]: ${on.out.frames.length} frames, qa ${on.qa.total}; lead on ${json(lead)}, off ${json(flat)}`);
expect("a turning walk compiles clean with the head on", on.qa.total === 0, json(on.qa.groups?.map(g => g.kind)));
expect("the head turns at least 3 frames before the pelvis", lead && lead[0] >= 3, json(lead));
expect("headLead false: the head turns with the pelvis (lag 0)", flat && flat[0] === 0, json(flat));
expect("headLead 0 is the same take as headLead false", pose(run(turnWalk({ flow: { headLead: 0 } }))) === pose(off));

const offset = on.out.baked.head_yaw.map((v, f) => v - (off.out.baked.head_yaw?.[f] ?? 0)), most = Math.max(...offset.map(Math.abs));
console.log(`  head yaw offset: max ${most.toFixed(2)} deg`);
expect("the head's lead is bounded to 30 degrees", most > 1 && most <= 30, most);
expect("a recompile is byte-identical", pose(run(turnWalk())) === pose(on));

// standing, a turn the keys give the body (yaw 0 -> 90 over 30 frames) leads too; QA reads the same
const stand = flow => run({ schema: "cozyclay.motion-spec.v1", fps: 24, frames: 80, ...(flow ? { flow } : {}),
	use: [{ skill: "standIdle", f0: 0, args: { at: [0, 0], heading: 0 } }], keys: [{ f: 10, set: { yaw: 0 } }, { f: 40, set: { yaw: 90 } }] });
const turned = stand(), still = stand({ headLead: false }), kinds = r => json(r.qa.groups.map(g => g.kind));
console.log(`  standing turn: lead on ${json(turned.observations.life.lead)}, off ${json(still.observations.life.lead)}; qa ${kinds(turned)} / ${kinds(still)}`);
expect("a standing turn: the head turns at least 3 frames before the pelvis, QA unchanged", turned.observations.life.lead?.[0] >= 3 && kinds(turned) === kinds(still), json(turned.observations.life.lead));

// a turn and back reads a lead too (its heading spans 90 degrees, its net turn is 0); a straight walk's sway is no turn
const there = run({ schema: "cozyclay.motion-spec.v1", fps: 24, frames: 120,
	use: [{ skill: "standIdle", f0: 0, args: { at: [0, 0], heading: 0 } }], keys: [{ f: 10, set: { yaw: 0 } }, { f: 40, set: { yaw: 90 } }, { f: 80, set: { yaw: 0 } }] }).observations.life.lead;
const straight = run({ ...turnWalk(), use: [{ skill: "standIdle", f0: 0, args: { at: [0, 0], heading: 0 } }, { skill: "walkTo", f0: 6, args: { to: [0, 6] } }] }).observations.life.lead;
expect("a turn and back reads its lead; a straight walk reads none", there?.[0] >= 3 && straight === null, json([there, straight]));
expect("headLead takes whole frames only", (() => { try { run(turnWalk({ flow: { headLead: 2.5 } })); return false; } catch (e) { return /headLead must be true, false or 0\.\.12 whole frames/.test(e.message); } })());

// a retime moves the walk's keys onto fractional frames: the lead still lands on frames
const retimed = run(turnWalk({ frames: 300, fix: { retime: true }, checks: { limits: { speedCore: 0.02 } } })), hy = retimed.out.baked.head_yaw;
expect("a retimed walk (keys on fractional frames) leads on whole frames", retimed.out.keys.some(k => k.f % 1) && Object.keys(hy).every(k => /^\d+$/.test(k)) && retimed.observations.life.lead?.[0] >= 3, json(retimed.observations.life.lead));

// a look the keys set during the walk wins: the head yaw is exactly what it is without the lead
const keys = [{ f: 40, set: { head_yaw: 20 } }, { f: 90, set: { head_yaw: -10 } }];
const looked = run(turnWalk({ keys })), lookedOff = run(turnWalk({ keys, flow: { headLead: false } }));
expect("keys on head_yaw during the walk: the lead leaves the head alone", json(looked.out.baked.head_yaw) === json(lookedOff.out.baked.head_yaw));

console.log(failures ? `${failures} motion3 head lead check(s) failed` : "motion3 head lead: all checks passed");
process.exit(failures ? 1 : 0);

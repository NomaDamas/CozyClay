#!/usr/bin/env node
// observations.gait (src/motion3/qa/gait-observe.js): a walk's numbers beside a person's. The default walkTo reads
// as measured when it was written (a slow stroll: about 74 steps a minute), and is warned for its cadence; a brisker
// walk (period 14, step 0.6: about 104) is not; QA and its verdict are untouched; a take without a walk has no gait.
import { compileSpec } from "../../src/motion3/pipeline.js";
import { skeletonFor } from "../../src/motion3/rigs/index.js";
import { motionScene } from "../../src/motion3/scene.js";

let failures = 0;
function expect(name, condition, detail = "") {
	console.log(`${condition ? "PASS" : "FAIL"} ${name}${condition ? "" : ` — ${detail}`}`);
	if (!condition) failures += 1;
}
const sk = skeletonFor("x-bot-tpose"), scene = motionScene([]), json = JSON.stringify;
const walk = (args, frames = "auto") => compileSpec({ schema: "cozyclay.motion-spec.v1", fps: 24, frames,
	use: [{ skill: "standIdle", f0: 0, args: { at: [0, 0], heading: 0 } }, { skill: "walkTo", f0: 6, args }] }, { sk, scene });
const near = (got, want) => Math.abs(got - want) <= 0.05 * Math.abs(want);

const four = walk({ to: [0, 4] }, 230), six = walk({ to: [0, 6] }), brisk = walk({ to: [0, 6], period: 14, step: 0.6 });
const g4 = four.observations.gait, g6 = six.observations.gait, gb = brisk.observations.gait;
for (const [name, r] of [["to [0,4]", four], ["to [0,6]", six], ["period 14, step 0.6", brisk]]) console.log(`  ${name}: qa ${r.qa.total}; ${json(r.observations.gait)}`);

// the probe's figures for the default walk: cadence 73.8 steps/min, step 0.475 m, 0.58 m/s, hips side to side 5.58 cm
expect("a walk answers observations.gait with its units", g6 && six.observations.units.includes("gait (") && g6.steps >= 10, json(g6));
expect("the default walk's cadence, step and speed read as measured (+-5%)", near(g6.cadence[0], 73.8) && g6.cadence[1] === "100-115" && near(g6.stepLength, 0.475) && near(g6.speed, 0.58), json(g6));
expect("its hips go side to side 5.58 cm (+-5%), both walks", near(g6.pelvis.lateral, 5.58) && near(g4.pelvis.lateral, 5.58), json([g4.pelvis, g6.pelvis]));
// per stride, its own trend out (a mean over the strides; the probe's 9.1 deg, 2.26 cm and 0.68 / 0.62 were one window's extremes)
expect("its pelvis turns about 7 deg, tilts about 7.6 deg and rises about 2.3 cm a stride (+-5%)", near(g4.pelvis.rotation, 6.9) && near(g6.pelvis.rotation, 7.3)
	&& near(g4.pelvis.obliquity, 7.6) && near(g6.pelvis.vertical, 2.3), json([g4.pelvis, g6.pelvis]));
expect("each foot is on the ground about two thirds of its stride (+-5%)", g6.stance.every(v => near(v, 0.66)) && g4.stance.every(v => near(v, 0.655)), json([g4.stance, g6.stance]));

expect("the default walk is warned for its cadence (74 < 80)", g6.warnings.some(w => /^cadence 73\.8 < 80$/.test(w)), json(g6.warnings));
expect("period 14, step 0.6 walks about 104 steps a minute, not warned for cadence", near(gb.cadence[0], 104.3) && !gb.warnings.some(w => /^cadence/.test(w)), json(gb));
expect("gait warnings leave QA alone", [four, six, brisk].every(r => r.qa.ok && r.qa.total === 0), json([four, six, brisk].map(r => r.qa.groups)));
expect("a recompile reads the same gait", json(walk({ to: [0, 6] }).observations.gait) === json(g6));

const shortObs = walk({ to: [0, 1.2] }).observations, short = shortObs.gait;
expect("a walk under 4 steps reports only its steps, without units", short && json(Object.keys(short)) === json(["steps"]) && short.steps < 4 && !shortObs.units.includes("gait ("), json(short));

// a retime moves the walk's keys onto fractional frames: the card reads frame indices
const retimed = compileSpec({ schema: "cozyclay.motion-spec.v1", fps: 24, frames: 300, fix: { retime: true }, checks: { limits: { speedCore: 0.02 } },
	use: [{ skill: "standIdle", f0: 0, args: { at: [0, 0], heading: 0 } }, { skill: "walkTo", f0: 6, args: { to: [0, 4] } }] }, { sk, scene });
expect("a retimed walk (keys on fractional frames) compiles and reads its gait", retimed.out.keys.some(k => k.f % 1) && retimed.observations.gait?.steps >= 4, json(retimed.observations.gait));

const still = compileSpec({ schema: "cozyclay.motion-spec.v1", fps: 24, frames: 60, use: [{ skill: "standIdle", f0: 0, args: { at: [0, 0], heading: 0 } }] }, { sk, scene });
expect("a take without a walk has no gait", !("gait" in still.observations) && !still.observations.units.includes("gait ("), json(Object.keys(still.observations)));

console.log(failures ? `${failures} motion3 gait check(s) failed` : "motion3 gait: all checks passed");
process.exit(failures ? 1 : 0);

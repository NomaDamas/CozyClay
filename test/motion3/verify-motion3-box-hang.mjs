#!/usr/bin/env node
// The bench box hang (M2 de4c3bd5, box-m2f-r1/r4/r5 at 240.0 s): a carry with walkTo { arrive } paid all 22 walk-plan probes on
// every compile, because the probe has no moving objects and the hands gripping the box missed it (arm REACH) on every
// candidate; then checkHints compiled two hint patches with no time bound. walk-plan.js leaves arm REACH out of a walk's
// issues; compile-job.js stops compiling hint patches past HINT_LIMIT_MS (a patch repair already compiled is still checked).
import { readFileSync } from "node:fs";
import { compileSpec } from "../../src/motion3/pipeline.js";
import { runCompileJob } from "../../src/motion3/compile-job.js";
import { checkHints } from "../../src/motion3/hint-check.js";
import { skeletonFor } from "../../src/motion3/rigs/index.js";
import { motionScene } from "../../src/motion3/scene.js";

let failures = 0;
const expect = (name, ok, detail = "") => { console.log(`${ok ? "PASS" : "FAIL"} ${name}${ok ? "" : ` — ${detail}`}`); if (!ok) failures++; };
const load = name => JSON.parse(readFileSync(new URL(`./fixtures/${name}`, import.meta.url), "utf8"));

// 1. the r5 carry plans its walk on a few probes (it took 22, ~25 s of a 34 s compile on the Mac)
const r5 = load("bench-box-m2f-r5-spec.json");
const planned = compileSpec({ fps: 24, ...r5.spec }, { sk: skeletonFor("x-bot-tpose"), scene: motionScene(r5.objects) }, {}).observations.planned ?? [];
const checked = Number(/\((\d+) checked\)/.exec(planned[0] ?? "")?.[1]);
expect("box carry: the walk is planned", planned.length === 1, JSON.stringify(planned));
expect("box carry: a clean walk is found within 6 probes (arm REACH on the gripped box does not count)", checked <= 6 && !/no candidate walked clean/.test(planned[0]), planned[0]);

// 2. checkHints: a compile that answers null (out of time) drops the patch and says so
const qa = { groups: [{ kind: "SLIDE", subject: "Left ball slides", count: 2, severity: 2, patch: [{ op: "add", path: "/keys/-", value: { f: 1, set: {} } }] }] };
checkHints({ keys: [] }, qa, () => null);
expect("checkHints: null from compile drops the patch", qa.groups[0].patch === undefined && /not compiled \(the compile had used its time\)/.test(qa.groups[0].patchTried ?? ""), JSON.stringify(qa.groups[0]));

// 3. compile-job: past the limit an uncompiled hint patch is not compiled; one repair compiled is still checked
const job = (doc, hintLimitMs) => runCompileJob({ model: "x-bot-tpose", scene: motionScene(doc.objects ?? []), spec: doc.spec, repair: { rounds: 1 }, hintLimitMs });
const box2 = job(load("bench-box2-spec.json"), 0).qa.groups.filter(g => g.patchTried);
expect("box2, hintLimitMs 0: its hint patches are not compiled", box2.length > 0 && box2.every(g => /not compiled/.test(g.patchTried)), JSON.stringify(box2.map(g => g.patchTried)));
const parkour = job(load("bench-parkour-spec.json"), 0).qa.groups.filter(g => g.patchTried);
expect("parkour, hintLimitMs 0: patches repair compiled are still checked", parkour.length > 0 && parkour.every(g => /compiled, did not help|helped/.test(g.patchTried) && !/not compiled/.test(g.patchTried)), JSON.stringify(parkour.map(g => g.patchTried)));

if (failures) { console.error(`${failures} box-hang check(s) failed`); process.exit(1); }
console.log("verify-motion3-box-hang: all checks passed");

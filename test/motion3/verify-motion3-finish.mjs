#!/usr/bin/env node
// compile-job.js finish pass (deep research 10, variant I): an installing compile (finish: true) left with 1-2 QA groups after its repair
// repairs once more, up to 6 rounds; repair.finish says how many rounds it kept (0: none helped). It never leaves more groups.
import { readFileSync } from "node:fs";
import { runCompileJob } from "../../src/motion3/compile-job.js";
import { motionScene } from "../../src/motion3/scene.js";

let failures = 0;
const expect = (name, ok, detail = "") => { console.log(`${ok ? "PASS" : "FAIL"} ${name}${ok ? "" : ` — ${detail}`}`); if (!ok) failures++; };
const doc = JSON.parse(readFileSync(new URL("./fixtures/bench-parkour-spec.json", import.meta.url), "utf8"));
const job = extra => runCompileJob({ model: "x-bot-tpose", scene: motionScene(doc.objects ?? []), spec: doc.spec, repair: { rounds: 2 }, ...extra });
const plain = job({}), done = job({ finish: true }), none = runCompileJob({ model: "x-bot-tpose", scene: motionScene(doc.objects ?? []), spec: doc.spec, finish: true });
const n = r => r.qa.groups.length;
expect("parkour ends the 2-round repair with 3-4 groups", n(plain) >= 3 && n(plain) <= 4, `${n(plain)}`);
expect("finish: over 2 groups the pass does not run (no repair.finish), same groups", done.repair?.finish === undefined && n(done) === n(plain), JSON.stringify({ finish: done.repair?.finish, groups: n(done) }));
expect("without repair (repair: false) there is no finish pass", none.repair === undefined);
expect("without finish nothing changes", plain.repair?.finish === undefined);
if (failures) { console.error(`${failures} finish check(s) failed`); process.exit(1); }
console.log("verify-motion3-finish: all checks passed");

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
// variant L: the main repair and the finish pass share one time cap (8 s, or the caller's repair.limitMs), and a main repair whose
// last round kept nothing has no finish pass
const fixture = name => JSON.parse(readFileSync(new URL(`./fixtures/${name}-spec.json`, import.meta.url), "utf8"));
const on = (d, extra) => runCompileJob({ model: d.model ?? "x-bot-tpose", scene: motionScene(d.objects ?? []), spec: d.spec, finish: true, thin: false, ...extra });
const sit = fixture("bench-sit"), ran = on(sit, { repair: { rounds: 1 } });
expect("bench-sit: 1 round keeps a patch, 1-2 groups left, the finish pass runs inside the default cap", ran.repair.applied.length >= 1 && ran.repair.finish >= 1, JSON.stringify(ran.repair));
const capped = on(sit, { repair: { rounds: 1, limitMs: 1 } });
expect("a used-up cap (limitMs: 1): no repair round and no finish pass", capped.repair.rounds === 0 && capped.repair.finish === undefined && capped.repair.compiles === 1, JSON.stringify(capped.repair));
const stalled = on(fixture("h-sit"), { repair: { rounds: 2 } });
expect("h-sit: a main round that keeps nothing leaves 2 groups and no finish pass", stalled.repair.applied.length === 0 && n(stalled) === 2 && stalled.repair.finish === undefined && stalled.repair.rounds === 1,
	JSON.stringify({ repair: stalled.repair, groups: n(stalled) }));
if (failures) { console.error(`${failures} finish check(s) failed`); process.exit(1); }
console.log("verify-motion3-finish: all checks passed");

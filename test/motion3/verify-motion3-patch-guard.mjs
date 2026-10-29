#!/usr/bin/env node
// patch-guard.js (deep research 5): PATCH_TOO_BROAD for a patch over 6 ops or one that mixes /anchors or /fix with key edits.
import { patchTooBroad } from "../../src/motion3/patch-guard.js";

let failures = 0;
const expect = (name, ok, detail = "") => { console.log(`${ok ? "PASS" : "FAIL"} ${name}${ok ? "" : ` — ${detail}`}`); if (!ok) failures++; };
const key = (f, ch, value) => ({ op: "replace", path: `/keys/@f=${f}/set/${ch}`, value });

expect("two key ops are not too broad", patchTooBroad([key(40, "hand_r", [0, 1, 0.3]), key(40, "elbow_r", [0, -1, 0])]) === null);
expect("an anchors-only or a fix-only patch is not too broad", patchTooBroad([{ op: "add", path: "/anchors/0", value: {} }]) === null && patchTooBroad([{ op: "add", path: "/fix", value: {} }]) === null);
expect("no patch, no note", patchTooBroad(undefined) === null && patchTooBroad([]) === null);
const seven = Array.from({ length: 7 }, (_, i) => key(10 * i, "yaw", i));
expect("7 ops are too broad", /^PATCH_TOO_BROAD 7 ops: applied/.test(patchTooBroad(seven) ?? ""), patchTooBroad(seven));
expect("6 ops are not", patchTooBroad(seven.slice(0, 6)) === null);
const mixed = patchTooBroad([key(40, "yaw", 10), { op: "add", path: "/anchors/0", value: {} }, { op: "add", path: "/fix", value: {} }]);
expect("anchors and fix mixed with key edits are too broad", /^PATCH_TOO_BROAD \/anchors and \/fix mixed with key edits/.test(mixed ?? ""), mixed);
expect("both reasons join", /^PATCH_TOO_BROAD 8 ops; \/fix mixed/.test(patchTooBroad([...seven, { op: "add", path: "/fix", value: {} }]) ?? ""));


if (failures) { console.error(`${failures} patch-guard check(s) failed`); process.exit(1); }
console.log("verify-motion3-patch-guard: all checks passed");

// Duration-balanced shards (#632): tools/test-shards.mjs is LPT over recorded
// seconds, deterministic, and a file with no record counts as the median.
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { assignShards, estimate, parseShard, reportDurations, slowestFirst } from "../tools/test-shards.mjs";

const durations = { a: 9, b: 7, c: 6, d: 5, e: 4, f: 4, g: 2, h: 1 };
const files = Object.keys(durations);

// LPT by hand: a b c d e f(tie with e, by path) g h onto 3 shards.
const split = assignShards(files, durations, 3);
assert.deepEqual(split.map((shard) => shard.files), [["a", "f"], ["b", "e", "g"], ["c", "d", "h"]]);
assert.deepEqual(split.map((shard) => shard.predicted), [13, 13, 12]);
assert.deepEqual(assignShards([...files].reverse(), durations, 3), split, "input order does not change the split");
assert.deepEqual(slowestFirst(["h", "f", "e", "a"], durations), ["a", "e", "f", "h"]);

// Unknown files count as the median of every recorded time.
assert.equal(estimate(["new"], { x: 1, y: 3, z: 10 }).get("new"), 3);
assert.equal(estimate(["new"], { x: 1, y: 3, z: 10, w: 20 }).get("new"), 6.5);
assert.equal(estimate(["new"], {}).get("new"), 1, "no records at all: every file weighs the same");
const withNew = assignShards(["a", "b", "new-1", "new-2"], { a: 10, b: 10, c: 2, d: 2, e: 2 }, 2);
assert.deepEqual(withNew.map((shard) => shard.files), [["a", "new-1"], ["b", "new-2"]], "new files spread instead of piling up");

// LPT bound: max - min shard sum never exceeds the largest single duration,
// and the shards always partition the input.
let seed = 632;
const random = () => (seed = (seed * 1103515245 + 12345) % 2 ** 31) / 2 ** 31;
for (let trial = 0; trial < 200; trial += 1) {
	const sample = Object.fromEntries(Array.from({ length: 1 + Math.floor(random() * 60) }, (_, index) => [`t${index}`, Math.round(random() ** 3 * 600) / 10]));
	const names = Object.keys(sample);
	const total = 1 + Math.floor(random() * 6);
	const shards = assignShards(names, sample, total);
	const sums = shards.map((shard) => shard.predicted);
	assert.ok(Math.max(...sums) - Math.min(...sums) <= Math.max(...Object.values(sample)) + 1e-9, `trial ${trial}: ${sums.join(", ")}`);
	assert.deepEqual(shards.flatMap((shard) => shard.files).sort(), [...names].sort(), `trial ${trial} partitions`);
	assert.deepEqual(assignShards(names, sample, total), shards, `trial ${trial} is deterministic`);
}

assert.deepEqual(parseShard("2/4"), { current: 2, total: 4 });
for (const bad of ["0/4", "5/4", "1/0", "x", undefined]) assert.throws(() => parseShard(bad), /--shard must be INDEX\/TOTAL/);

// --durations-out: sorted keys, seconds to one decimal; the step summary line
// goes to a scratch file, never to the summary of the CI job running this.
const scratch = mkdtempSync(join(tmpdir(), "cozyclay-test-shards-"));
try {
	const out = join(scratch, "durations.json");
	process.env.GITHUB_STEP_SUMMARY = join(scratch, "summary.md");
	reportDurations(new Map([["test/verify-b.mjs", 3.26], ["test/verify-a.mjs", 0.04]]), { out, selected: 2, predicted: 3 });
	assert.equal(readFileSync(out, "utf8"), '{\n\t"test/verify-a.mjs": 0,\n\t"test/verify-b.mjs": 3.3\n}\n');
	assert.equal(readFileSync(process.env.GITHUB_STEP_SUMMARY, "utf8"), "selected 2, predicted 3.0 s, actual 3.3 s\n");
} finally {
	rmSync(scratch, { recursive: true, force: true });
}

console.log("PASS test shards: LPT split, median for unknown files, max-min bound, durations format");

// tools/select-tests.mjs (#632 S2): changed files → the Node tests a PR runs,
// with a full run whenever the selector cannot vouch for the selection.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { ALWAYS_RUN, readManifest, safeSelect, selectTests, summaryTable } from "../tools/select-tests.mjs";

const root = mkdtempSync(join(tmpdir(), "cozyclay-select-tests-"));
process.on("exit", () => rmSync(root, { recursive: true, force: true }));
const write = (path, text) => {
	mkdirSync(dirname(join(root, path)), { recursive: true });
	writeFileSync(join(root, path), text);
};
// Twelve tests, one product module each, so one change stays under 50%.
for (let index = 0; index < 8; index += 1) {
	write(`src/m${index}.js`, `export const m${index} = ${index};\n`);
	write(`test/verify-m${index}.mjs`, `import { m${index} } from "../src/m${index}.js";\nconsole.log(m${index});\n`);
}
write("src/motion3/used.js", "export const used = 1;\n");
write("src/motion3/unused.js", "export const unused = 1;\n");
write("src/lonely.js", "export const lonely = 1;\n");
write("src/data.json", "{}\n");
write("src/lazy.js", "export const lazy = 1;\n");
write("bin/tool.mjs", "console.log(1);\n");
write("test/motion3/verify-motion3-a.mjs", 'import { used } from "../../src/motion3/used.js";\nconsole.log(used);\n');
write("test/verify-reads.mjs", [
	'import { readFileSync } from "node:fs";',
	'import { spawnSync } from "node:child_process";',
	'readFileSync(new URL("../src/data.json", import.meta.url), "utf8");',
	'await import("../src/lazy.js");',
	'spawnSync(process.execPath, ["bin/tool.mjs"]);',
].join("\n"));
write("test/verify-dynamic.mjs", 'const name = process.argv[2] ?? "m0";\nawait import(`../src/${name}.js`);\n');
const tests = [...Array.from({ length: 8 }, (_, index) => `test/verify-m${index}.mjs`), "test/motion3/verify-motion3-a.mjs", "test/verify-reads.mjs", "test/verify-dynamic.mjs"];
const manifest = [...tests.map((file) => ({ kind: "node", file })), { kind: "browser", file: "test/verify-x-browser.mjs" }];
write("test/verify-x-browser.mjs", "");
const select = (changed) => selectTests(changed, { root, manifest, always: [] });

// (a) one product file → only the tests that import it, plus the always-run set.
let result = select(["src/m3.js"]);
assert.equal(result.mode, "selected", result.reason);
assert.deepEqual(result.files, ["test/verify-dynamic.mjs", "test/verify-m3.mjs"]);
assert.equal(result.alwaysRun, 1, "the test with a non-literal import is the only always-run file");
assert.deepEqual(select(["test/verify-m5.mjs"]).files, ["test/verify-dynamic.mjs", "test/verify-m5.mjs"], "a changed test selects itself");
assert.deepEqual(select(["test/verify-x-browser.mjs", "docs/notes.md", "README.md"]).files, ["test/verify-dynamic.mjs"], "browser suites and docs need no Node shard");
console.log("PASS (a) a changed file selects only the tests that reach it");

// (b) a hub reaches most of the real suite: 50% or more runs everything.
const real = readManifest();
result = selectTests(["src/object-colors.js"], { manifest: real });
assert.equal(result.mode, "full");
assert.match(result.reason, /50% or more/);
assert.equal(result.selected, result.total);
console.log(`PASS (b) the src/object-colors.js hub falls back to full (${result.reason})`);

// (c) package, workflow and runner files always force a full run.
for (const file of ["package.json", ".github/workflows/ci.yml", "tools/run-tests.mjs", "tools/loc-baseline.json", "test/bus/app-fixture.mjs", "test/motion3/fixtures/a.json"]) {
	result = selectTests(["src/m0.js", file], { root, manifest });
	assert.equal(result.mode, "full", file);
	assert.equal(result.reason, `full-run trigger: ${file}`);
}
console.log("PASS (c) package, workflow, runner, baseline and fixture changes force full");

// (d) nothing imports the file: same-directory tests, else full.
assert.deepEqual(select(["src/motion3/unused.js"]).files, ["test/motion3/verify-motion3-a.mjs", "test/verify-dynamic.mjs"]);
result = select(["src/lonely.js"]);
assert.equal(result.mode, "full");
assert.equal(result.reason, "no test reaches src/lonely.js");
write("test/verify-unlisted.mjs", "");
result = select(["src/m1.js"]);
assert.deepEqual([result.mode, result.reason], ["full", "inventory mismatch: test/verify-unlisted.mjs"]);
rmSync(join(root, "test/verify-unlisted.mjs"));
console.log("PASS (d) the path-prefix fallback, then full; an unlisted test is an inventory mismatch");

// (e) literal source reads, dynamic imports and spawned scripts are dependencies.
for (const file of ["src/data.json", "src/lazy.js", "bin/tool.mjs"]) {
	assert.deepEqual(select([file]).files, ["test/verify-dynamic.mjs", "test/verify-reads.mjs"], file);
}
console.log("PASS (e) readFileSync(new URL(...)), import(\"...\") and spawn literals are tracked");

// (f) a test that builds its import path at run time always runs.
assert.ok(select(["src/m7.js"]).files.includes("test/verify-dynamic.mjs"));
assert.ok(select(["src/motion3/used.js"]).files.includes("test/verify-dynamic.mjs"));
console.log("PASS (f) a non-literal import puts the test in the always-run set");

// (g) any selector exception is a full run.
result = safeSelect(["src/m0.js"], { root: join(root, "missing"), manifest: undefined });
assert.equal(result.mode, "full");
assert.match(result.reason, /^selector error: /);
result = safeSelect(["src/m0.js"], { root, manifest: null });
assert.deepEqual([result.mode, /^selector error: /.test(result.reason)], ["full", true]);
console.log("PASS (g) a selector exception falls back to full");

// (h) a file read whose path is built at run time is treated like a non-literal import: always run,
// unless the path has a fixed directory (a dependency on that directory) or is a parameter fed literals.
const reads = join(root, "reads");
const put = (path, text) => { mkdirSync(dirname(join(reads, path)), { recursive: true }); writeFileSync(join(reads, path), text); };
for (let index = 0; index < 6; index += 1) {
	put(`src/r${index}.js`, `export const r${index} = ${index};\n`);
	put(`test/verify-r${index}.mjs`, `import { r${index} } from "../src/r${index}.js";\nconsole.log(r${index});\n`);
}
put("src/shapes/box.js", "export const box = 1;\n");
put("test/verify-concat.mjs", 'import { readFileSync } from "node:fs";\nreadFileSync("src/" + process.argv[2], "utf8");\n');
put("test/verify-template-dir.mjs", 'import { readFileSync } from "node:fs";\nconst name = process.argv[2] ?? "box";\nreadFileSync(new URL(`../src/shapes/${name}.js`, import.meta.url), "utf8");\n');
put("test/verify-param.mjs", 'import { readFileSync } from "node:fs";\nconst text = ["../src/r5.js"].map(path => readFileSync(new URL(path, import.meta.url), "utf8"));\nconsole.log(text);\n');
const readTests = [...Array.from({ length: 6 }, (_, index) => `test/verify-r${index}.mjs`), "test/verify-concat.mjs", "test/verify-template-dir.mjs", "test/verify-param.mjs"];
const pick = (changed) => selectTests(changed, { root: reads, manifest: readTests.map((file) => ({ kind: "node", file })), always: [] });
result = pick(["src/r1.js"]);
assert.equal(result.mode, "selected", result.reason);
assert.deepEqual(result.files, ["test/verify-concat.mjs", "test/verify-r1.mjs"], "a concatenated read path always runs; a template with a fixed directory does not");
assert.equal(result.alwaysRun, 1);
assert.deepEqual(pick(["src/shapes/box.js"]).files, ["test/verify-concat.mjs", "test/verify-template-dir.mjs"], "`../src/shapes/${name}.js` depends on src/shapes/");
assert.deepEqual(pick(["src/r5.js"]).files, ["test/verify-concat.mjs", "test/verify-param.mjs", "test/verify-r5.mjs"], "a parameter fed literal paths depends on those files");
console.log("PASS (h) non-literal readFileSync/new URL paths: always run, directory prefix, or literal call sites");

// The smoke set stays small and runnable; the CI summary carries every field.
assert.ok(ALWAYS_RUN.length <= 10 && ALWAYS_RUN.includes("test/bus/verify-manifest.mjs"));
const runnableReal = new Set(real.filter(({ kind }) => kind === "node" || kind === "mcp-deps").map(({ file }) => file));
for (const file of ALWAYS_RUN) assert.ok(runnableReal.has(file), file);
assert.match(summaryTable({ changed: 2, mode: "selected", reason: "", selected: 5, total: 9, alwaysRun: 3 }), /\| 2 \| selected \| - \| 5 \/ 9 \| 3 \|/);

// run-tests.mjs --only-from: the selection goes through the balanced shards,
// a shard left with no files still passes, and mode "full" runs everything.
const listed = (args) => {
	const run = spawnSync(process.execPath, ["tools/run-tests.mjs", "--list", ...args], { encoding: "utf8" });
	assert.equal(run.status, 0, run.stderr);
	return [...run.stdout.matchAll(/^RUN node (\S+)/gm)].map((match) => match[1]);
};
const picked = ["test/bus/verify-manifest.mjs", "test/verify-root-path.mjs"];
write("selected.json", JSON.stringify({ mode: "selected", files: picked }));
const shards = [1, 2, 3, 4].map((index) => listed(["--only-from", join(root, "selected.json"), "--shard", `${index}/4`]));
assert.deepEqual(shards.flat().sort(), picked);
assert.ok(shards.some((files) => files.length === 0), "two files leave at least one empty shard");
write("full.json", JSON.stringify({ mode: "full", files: [] }));
assert.equal(listed(["--only-from", join(root, "full.json")]).length, listed([]).length);
console.log("PASS run-tests --only-from shards the selection; empty shards and full mode work");

// Every shard splits the same list: a selection that did not arrive fails the shard, never a lone full run.
const workflow = readFileSync(new URL("../.github/workflows/ci.yml", import.meta.url), "utf8");
const download = /- uses: actions\/download-artifact@v4\n((?: {8}.*\n)+)/.exec(workflow)?.[1] ?? "";
assert.match(download, /name: test-selection/);
assert.doesNotMatch(download, /continue-on-error/, "a failed selection download fails the shard");
assert.match(workflow, /if \[ ! -f test-selection\.json \]; then echo "::error[^\n]*exit 1; fi/);
assert.match(workflow, /--only-from test-selection\.json\n/);
console.log("PASS ci.yml: a shard without the selection artifact fails instead of running everything");

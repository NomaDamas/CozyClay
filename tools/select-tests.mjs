#!/usr/bin/env node
// Change-based test selection for pull requests (#632).
//   git diff --name-only --no-renames origin/main...HEAD | node tools/select-tests.mjs --out selection.json
// reads changed paths (stdin, or --changed FILE) and writes the Node tests a
// shard must run: `node tools/run-tests.mjs --only-from selection.json`.
// Anything the selector cannot vouch for becomes mode "full" with a reason.
import { spawnSync } from "node:child_process";
import { appendFileSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { buildGraph, reverseIndex, sweepVerifyFiles } from "./test-graph.mjs";

const ROOT = fileURLToPath(new URL("..", import.meta.url));

// Changes that can alter any test's outcome, or the selection itself.
const FULL_TRIGGERS = [
	/^package(-lock)?\.json$/, /^mcp\/package(-lock)?\.json$/, /^(vite|eslint)\.config\.js$/, /^knip\.json$/,
	/^tools\/(run-tests|test-shards|select-tests|test-graph|qa-browser)\.mjs$/, /^tools\/[^/]+-baseline\.json$/,
	/^\.github\/workflows\/[^/]+\.ya?ml$/,
	/^test\/bus\/[^/]+-fixture\.mjs$/, /^test\/fixtures\//, /^test\/motion3\/fixtures\//, /^test\/camera-browser-harness\.mjs$/,
];
// The paths ci.yml's `changes` job already treats as not needing tests.
const IGNORED = (file) => file.startsWith(".metrics/") || /^docs\/.*\.md$/.test(file) || /^[^/]+\.md$/.test(file);
// Browser suites run in their own CI lanes, never on the Node shards.
const BROWSER_ONLY = (file) => file.startsWith("test/") && /(?:^|\/)qa-[^/]*\.mjs$|-browser\.mjs$/.test(file);

// Cheap boot checks that run on every selected PR (at most 10).
export const ALWAYS_RUN = [
	"test/bus/verify-manifest.mjs",
	"test/verify-mcp-invariants.mjs",
	"test/verify-package-agent-imports.mjs",
	"test/verify-error-boundary.mjs",
	"test/verify-tool-handlers.mjs",
	"test/verify-pwa.mjs",
	"mcp/verify.mjs",
];

// `node tools/run-tests.mjs --list`, as [{ file, kind }]. mcp-deps entries are
// runnable on a shard (it installs mcp/node_modules) even if not here.
export function readManifest(root = ROOT) {
	const result = spawnSync(process.execPath, ["tools/run-tests.mjs", "--list"], { cwd: root, encoding: "utf8" });
	if (result.status !== 0) throw new Error(`run-tests --list failed: ${result.stderr.trim().split("\n")[0]}`);
	return [...result.stdout.matchAll(/^(?:RUN|EXCLUDE) (\S+) (\S+) - /gm)].map(([, kind, file]) => ({ kind, file }));
}

// Test directories a path falls back to when no test reaches it, deepest
// first: src/motion3/a/b.js → test/motion3/a/, test/motion3/. A top-level
// directory never maps (it would be the whole suite).
function prefixesFor(file) {
	const parts = file.split("/").slice(0, -1);
	const prefixes = [];
	for (let depth = parts.length; depth >= 2; depth -= 1) {
		const directory = parts.slice(0, depth);
		prefixes.push(`${directory.join("/")}/`);
		if (["src", "bin", "tools"].includes(directory[0])) prefixes.push(`test/${directory.slice(1).join("/")}/`);
	}
	return prefixes;
}

const full = (reason, base) => ({ ...base, mode: "full", reason, files: base.runnable, selected: base.total });

export function selectTests(changed, { root = ROOT, manifest = readManifest(root), always = ALWAYS_RUN } = {}) {
	const runnable = manifest.filter(({ kind }) => kind === "node" || kind === "mcp-deps").map(({ file }) => file).sort();
	const runnableSet = new Set(runnable);
	const inventory = new Set(manifest.map(({ file }) => file));
	const paths = [...new Set(changed.map((file) => file.trim()).filter(Boolean))];
	const base = { changed: paths.length, total: runnable.length, alwaysRun: 0, runnable };
	const trigger = paths.find((file) => FULL_TRIGGERS.some((pattern) => pattern.test(file)));
	if (trigger) return full(`full-run trigger: ${trigger}`, base);
	const unknown = [...sweepVerifyFiles(root, "test"), ...sweepVerifyFiles(root, "mcp")].filter((file) => !inventory.has(file));
	if (unknown.length > 0) return full(`inventory mismatch: ${unknown.slice(0, 3).join(", ")}`, base);

	const graph = buildGraph(root, runnable);
	const readers = reverseIndex(graph);
	const alwaysSet = new Set([...always.filter((file) => runnableSet.has(file)), ...runnable.filter((file) => graph.get(file).unresolved)]);
	const selected = new Set(alwaysSet);
	for (const file of paths) {
		if (IGNORED(file) || (inventory.has(file) && !runnableSet.has(file))) continue;
		if (runnableSet.has(file)) selected.add(file);
		const tests = readers(file);
		if (tests.size === 0 && BROWSER_ONLY(file)) continue;
		for (const prefix of tests.size > 0 ? [] : prefixesFor(file)) {
			for (const test of runnable) if (test.startsWith(prefix)) tests.add(test);
			if (tests.size > 0) break;
		}
		if (tests.size === 0 && !runnableSet.has(file)) return full(`no test reaches ${file}`, { ...base, alwaysRun: alwaysSet.size });
		for (const test of tests) selected.add(test);
	}
	const result = { ...base, alwaysRun: alwaysSet.size, mode: "selected", reason: "", files: [...selected].sort(), selected: selected.size };
	if (selected.size * 2 >= runnable.length) return full(`selection ${selected.size}/${runnable.length} is 50% or more`, result);
	return result;
}

// Any exception is a full run: a selector bug must never skip a test.
export function safeSelect(changed, options) {
	try {
		return selectTests(changed, options);
	} catch (error) {
		return { mode: "full", reason: `selector error: ${error.message}`, changed: changed.length, files: [], selected: 0, total: 0, alwaysRun: 0 };
	}
}

export function summaryTable({ changed, mode, reason, selected, total, alwaysRun }) {
	return [
		"### Test selection (#632)", "",
		"| Changed files | Mode | Fallback reason | Selected / total | Always run |", "|---|---|---|---|---|",
		`| ${changed} | ${mode} | ${reason.replaceAll("|", "\\|") || "-"} | ${selected} / ${total} | ${alwaysRun} |`, "",
	].join("\n");
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
	const flag = (name) => process.argv[process.argv.indexOf(name) + 1];
	const input = process.argv.includes("--changed") ? readFileSync(flag("--changed"), "utf8") : readFileSync(0, "utf8");
	const { runnable, ...selection } = safeSelect(input.split("\n"));
	const json = `${JSON.stringify(selection, null, "\t")}\n`;
	if (process.argv.includes("--out")) writeFileSync(flag("--out"), json);
	else process.stdout.write(json);
	if (process.env.GITHUB_STEP_SUMMARY && existsSync(process.env.GITHUB_STEP_SUMMARY)) appendFileSync(process.env.GITHUB_STEP_SUMMARY, summaryTable(selection));
	console.error(`select-tests: ${selection.mode} ${selection.selected}/${selection.total}${selection.reason ? ` (${selection.reason})` : ""}`);
}

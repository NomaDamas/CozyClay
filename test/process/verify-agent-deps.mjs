#!/usr/bin/env node
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";

const REPO = new URL("../..", import.meta.url);
const npm = process.platform === "win32" ? "npm.cmd" : "npm";
const manifest = JSON.parse(readFileSync(new URL("../../package.json", import.meta.url), "utf8"));

assert.equal(
	manifest.dependencies?.["@earendil-works/pi-ai"],
	"0.85.1",
	"@earendil-works/pi-ai must be pinned exactly, no caret or range",
);
assert.equal(
	manifest.dependencies?.["@earendil-works/pi-agent-core"],
	"0.85.1",
	"@earendil-works/pi-agent-core must be pinned exactly, no caret or range",
);
assert.equal(manifest.engines?.node, ">=22.19.0", "engines.node must require Node 22.19.0 or newer");

await import("@earendil-works/pi-ai/providers/faux");
await import("@earendil-works/pi-agent-core");

const packed = spawnSync(npm, ["pack", "--dry-run", "--json", "--ignore-scripts"], { cwd: REPO.pathname, encoding: "utf8" });
assert.equal(packed.error, undefined, `npm pack could not start: ${packed.error?.message}`);
assert.equal(packed.status, 0, packed.stderr);
const listing = JSON.parse(packed.stdout);
const entries = Array.isArray(listing) ? listing.flatMap((entry) => entry.files ?? []) : (listing.files ?? []);
const forbidden = entries.map((entry) => entry.path ?? entry).filter((path) => path.includes("node_modules"));
assert.deepEqual(forbidden, [], "packed tarball must not contain node_modules entries");

console.log("agent dependency pins PASS");

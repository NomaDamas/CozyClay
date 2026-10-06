#!/usr/bin/env node
// The npm package ships bin/ and src/ but not the studio's devDependencies
// (`three` and friends live only in node_modules of a source checkout and in
// the staged MCP runtime). Everything the launcher and the agent sidecar can
// import on a Studio turn must therefore stay off `three`: one transitive
// import is enough to turn every turn into "502 — agent unavailable" for
// `npx cozyclay` users while a source checkout keeps passing (#8 of the
// 2026-10-06 first-run audit; chain was studio-tools → motion/generation →
// scenes → scene-objects → three).
//
// Static walk: follow every relative `import ... from "..."`, `export ... from
// "..."` and `import("...")` string literal reachable from the launcher, the
// agent sidecar and the live CLI. Bare specifiers other than `three` are
// runtime dependencies or node built-ins and are not followed; `mcp/` targets
// are loaded from the staged runtime (which installs `three`) and are not
// followed either.
import assert from "node:assert/strict";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const roots = [
	"bin/cozyclay.mjs",
	...readdirSync(join(root, "bin", "agent")).filter((name) => name.endsWith(".mjs")).map((name) => `bin/agent/${name}`),
	...readdirSync(join(root, "bin", "live")).filter((name) => name.endsWith(".mjs")).map((name) => `bin/live/${name}`),
];

const SPECIFIER = /(?:^|\n)[ \t]*(?:import|export)[^'"\n;]*?from[ \t]*['"]([^'"]+)['"]|import\([ \t]*['"]([^'"]+)['"][ \t]*\)/g;

function specifiers(file) {
	const source = readFileSync(file, "utf8");
	const out = [];
	for (const match of source.matchAll(SPECIFIER)) out.push(match[1] ?? match[2]);
	return out;
}

function resolveRelative(from, specifier) {
	const target = resolve(dirname(from), specifier);
	for (const candidate of [target, `${target}.js`, `${target}.mjs`, join(target, "index.js")]) {
		try {
			if (statSync(candidate).isFile()) return candidate;
		} catch { /* try the next candidate */ }
	}
	return null;
}

const seen = new Map();
const offenders = [];
function walk(file, chain) {
	if (seen.has(file)) return;
	seen.set(file, chain);
	for (const specifier of specifiers(file)) {
		if (specifier === "three" || specifier.startsWith("three/")) {
			offenders.push([...chain, file].map((entry) => relative(root, entry)).join(" -> ") + ` -> ${specifier}`);
			continue;
		}
		if (!specifier.startsWith(".")) continue;
		const target = resolveRelative(file, specifier);
		if (!target || relative(root, target).startsWith("mcp/")) continue;
		walk(target, [...chain, file]);
	}
}

for (const entry of roots) walk(join(root, entry), []);

assert.ok(seen.size > 20, `expected to walk the sidecar's import graph, walked ${seen.size} files`);
assert.deepEqual(offenders, [], `the npm package cannot resolve \`three\`; these launcher/agent import chains reach it:\n${offenders.join("\n")}`);
console.log(`verify-package-agent-imports: ${seen.size} files reachable from bin/ stay off three`);

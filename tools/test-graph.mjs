// Test → file dependency graph for change-based test selection (#632).
// Each test's set is a superset of what it loads: static imports, literal
// dynamic imports, literal spawned scripts, and every string literal in a
// reached file that names an existing repository file or directory (which
// covers readFileSync(new URL("../src/x.js", import.meta.url)) and
// join(root, "src/x.js")). A test-side file whose import() or spawned script
// path cannot be read as a literal marks the test unresolved: it always runs.
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, normalize, relative } from "node:path";

const CODE = /\.(?:m?js|jsx|cjs)$/;
const EXTENSIONS = ["", ".js", ".jsx", ".mjs", ".cjs", "/index.js", "/index.jsx", "/index.mjs"];
const STATIC_IMPORT = /\b(?:import|export)\b[^;"'`]*?\bfrom\s*(["'])([^"'\n]+)\1|\bimport\s*(["'])([^"'\n]+)\3/g;
const DYNAMIC_IMPORT = /\bimport\(\s*([^)]*)\)/g;
const SPAWN = /\b(?:spawn|spawnSync|execFile|execFileSync|fork)\(\s*process\.execPath\s*,\s*\[([^\]]{0,300})/g;
const JOINED = /\b(?:join|resolve)\(\s*[\w.$]+\s*,((?:\s*["'][^"'$\n]+["']\s*,?)+)\)/g;
const PATH_LITERAL = /(["'`])((?:\.{0,2}\/)?[\w@.-]+(?:\/[\w@.-]*)*)\1/g;
const STRING = /^\s*(["'`])([^"'`$]*)\1\s*$/;

// Repository-relative, forward slashes; null for anything outside the tree or in node_modules.
function repoPath(root, absolute) {
	const path = relative(root, absolute).replaceAll("\\", "/");
	return path && !path.startsWith("..") && !path.split("/").includes("node_modules") ? path : null;
}

function resolveFile(root, from, specifier) {
	if (!/^(?:\.{1,2}\/|\/)/.test(specifier)) return null; // bare package or node: builtin
	const base = specifier.startsWith("/") ? join(root, specifier) : join(root, dirname(from), specifier);
	for (const extension of EXTENSIONS) {
		const candidate = normalize(base.split("?")[0] + extension);
		if (existsSync(candidate) && statSync(candidate).isFile()) return repoPath(root, candidate);
	}
	return null;
}

// A literal like "src/motion3/x.js", "../src/" or "./fixtures/a.json": the
// existing file or directory it names, relative to the file or to the root.
function resolveLiteral(root, from, literal) {
	if (!literal.includes("/") && !/\.\w+$/.test(literal)) return null;
	const bases = literal.startsWith("/") ? [join(root, literal)] : [join(root, dirname(from), literal), join(root, literal)];
	for (const base of bases) {
		const path = existsSync(base) ? repoPath(root, base) : null;
		if (!path || path === "." ) continue;
		if (statSync(base).isFile()) return { file: path };
		if (path.includes("/") || literal.endsWith("/")) return { directory: `${path}/` };
	}
	return null;
}

// An argument is literal when it is a string, or an expression or one-level
// `const name = ...` binding whose path part is a string without `${`.
function firstElement(list) {
	let depth = 0;
	for (let index = 0; index < list.length; index += 1) {
		if ("([{".includes(list[index])) depth += 1;
		else if (")]}".includes(list[index])) depth -= 1;
		if (depth < 0 || (depth === 0 && list[index] === ",")) return list.slice(0, index);
	}
	return list;
}

function literalArgument(source, argument, bound = false) {
	const text = argument.trim();
	if (!text || STRING.test(text) || /^["']-/.test(text) || text.startsWith("`data:") || text === "fileURLToPath(import.meta.url)") return true;
	if (/^`[\w./-]+[?#]/.test(text)) return true; // a cache-busting query on a literal path
	if (text.includes("${") || text.includes("+")) return false;
	if (/["'][^"'$]+["']/.test(text)) return true;
	const name = /^([A-Za-z_$][\w$]*)(?:\.href|\.pathname)?$/.exec(text)?.[1];
	if (!name || name === "import") return false;
	const binding = new RegExp(`\\b(?:const|let|var)\\s+${name.replace("$", "\\$")}\\s*(?:=|of)\\s*([^;\\n]+)`).exec(source);
	return Boolean(binding && !bound && literalArgument(source, binding[1], true));
}

function scanFile(root, file) {
	const source = readFileSync(join(root, file), "utf8");
	const imports = new Set();
	const files = new Set();
	const directories = new Set();
	let unresolved = null;
	for (const match of source.matchAll(STATIC_IMPORT)) imports.add(match[2] ?? match[4]);
	for (const [, argument] of source.matchAll(DYNAMIC_IMPORT)) {
		const literal = STRING.exec(argument)?.[2] ?? /^\s*`([\w./-]+)[?#]/.exec(argument)?.[1];
		if (literal) imports.add(literal);
		else if (!literalArgument(source, argument)) unresolved ??= `import(${argument.trim().slice(0, 60)})`;
	}
	for (const [, list] of source.matchAll(SPAWN)) {
		const argument = firstElement(list);
		if (!literalArgument(source, argument)) unresolved ??= `spawn(process.execPath, [${argument.trim().slice(0, 60)}])`;
	}
	for (const specifier of imports) {
		const resolved = resolveFile(root, file, specifier);
		if (resolved) files.add(resolved);
	}
	for (const [, , literal] of source.matchAll(PATH_LITERAL)) {
		const resolved = resolveLiteral(root, file, literal);
		if (resolved?.file) files.add(resolved.file);
		else if (resolved?.directory) directories.add(resolved.directory);
	}
	for (const [, segments] of source.matchAll(JOINED)) {
		const literal = [...segments.matchAll(/["']([^"']+)["']/g)].map((match) => match[1]).join("/");
		const resolved = resolveLiteral(root, file, literal.includes("/") ? literal : `./${literal}`);
		if (resolved?.file) files.add(resolved.file);
		else if (resolved?.directory) directories.add(resolved.directory);
	}
	files.delete(file);
	return { files, directories, unresolved };
}

const isTestSide = (file) => file.startsWith("test/") || /^mcp\/verify[^/]*\.mjs$/.test(file);

// Per test: every reachable file, every directory a reached file names, and
// the first non-literal load found on the test side (null when none).
export function buildGraph(root, tests) {
	const scans = new Map();
	const scan = (file) => {
		if (!scans.has(file)) scans.set(file, CODE.test(file) ? scanFile(root, file) : { files: new Set(), directories: new Set(), unresolved: null });
		return scans.get(file);
	};
	const graph = new Map();
	for (const test of tests) {
		const files = new Set([test]);
		const directories = new Set();
		let unresolved = null;
		for (const file of files) {
			const result = scan(file);
			for (const next of result.files) files.add(next);
			for (const directory of result.directories) directories.add(directory);
			if (isTestSide(file)) unresolved ??= result.unresolved && `${file}: ${result.unresolved}`;
		}
		graph.set(test, { files, directories, unresolved });
	}
	return graph;
}

// File → tests that reach it, plus the directory entries for a prefix match.
export function reverseIndex(graph) {
	const byFile = new Map();
	const byDirectory = new Map();
	for (const [test, { files, directories }] of graph) {
		for (const file of files) byFile.set(file, [...(byFile.get(file) ?? []), test]);
		for (const directory of directories) byDirectory.set(directory, [...(byDirectory.get(directory) ?? []), test]);
	}
	return (file) => {
		const tests = new Set(byFile.get(file) ?? []);
		for (const [directory, readers] of byDirectory) if (file.startsWith(directory)) for (const test of readers) tests.add(test);
		return tests;
	};
}

// The same `verify*.mjs` sweep tools/run-tests.mjs uses, to detect a test the
// manifest does not know about.
export function sweepVerifyFiles(root, directory) {
	const absolute = join(root, directory);
	if (!existsSync(absolute)) return [];
	return readdirSync(absolute, { withFileTypes: true }).flatMap((entry) => {
		const path = `${directory}/${entry.name}`;
		if (entry.isDirectory()) return entry.name === "node_modules" ? [] : sweepVerifyFiles(root, path);
		return entry.isFile() && /^verify(-.*)?\.mjs$/.test(entry.name) ? [path] : [];
	});
}

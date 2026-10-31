// The runnable part of a `script` the model is still writing, for the live sketch (sculpt-sketch.mjs): the code
// streamed so far, cut back to the longest stretch of whole lines that compiles once its open brackets are closed.
// Compile only: node:vm's Script parses the text and never runs it here; the cut then runs in a throwaway sandbox
// with stub tools (sketch-sandbox.mjs).
import { Script } from "node:vm";

/** Line ends tried per pass, newest first; a long statement still being written fails them all and the last good cut stays. */
const MAX_CUTS = 48;
const ESCAPES = { n: "\n", t: "\t", r: "\r", b: "\b", f: "\f", v: "\v", 0: "\0" };
const OPENERS = { "{": "}", "(": ")", "[": "]" };
// After one of these a `/` starts a regex literal; after a value it divides.
const REGEX_AFTER = /(?:^|[(,=:[!&|?{};+\-*%<>~^])$/;
const REGEX_WORDS = new Set(["return", "typeof", "case", "do", "else", "in", "of", "void", "delete", "throw", "new", "await", "yield"]);
const DECLARED = /\b(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=|,\s*([A-Za-z_$][\w$]*)\s*=\s*[[{]/g;
const DECLARED_FUNCTIONS = /\b(?:async\s+)?function\s+([A-Za-z_$][\w$]*)\s*\(/g;

/** A JSON string body decoded up to its closing quote, or up to the last whole character while it is still streaming. */
function decodeStreamed(body) {
	let out = "";
	for (let at = 0; at < body.length; at += 1) {
		const char = body[at];
		if (char === "\"") return out;
		if (char !== "\\") { out += char; continue; }
		const next = body[at + 1];
		if (next === undefined) return out;
		if (next === "u") {
			const hex = body.slice(at + 2, at + 6);
			if (!/^[0-9a-fA-F]{4}$/.test(hex)) return out;
			out += String.fromCharCode(parseInt(hex, 16));
			at += 5;
			continue;
		}
		out += ESCAPES[next] ?? next;
		at += 1;
	}
	return out;
}

/** The script's code so far: pi-ai's partially parsed arguments when the provider fills them, else the raw argument JSON. */
export function streamedCode(call, raw = "") {
	if (typeof call?.arguments?.code === "string") return call.arguments.code;
	const start = /"code"\s*:\s*"/.exec(raw);
	return start ? decodeStreamed(raw.slice(start.index + start[0].length)) : "";
}

/** Where a template literal's text ends from `at`: { at, open } (open: a `${` expression starts), or null at the end of the text. */
function templateEnd(code, at) {
	for (let index = at; index < code.length; index += 1) {
		if (code[index] === "\\") index += 1;
		else if (code[index] === "`") return { at: index, open: false };
		else if (code[index] === "$" && code[index + 1] === "{") return { at: index + 1, open: true };
	}
	return null;
}

/** The index of a regex literal's last flag from its opening `/`, or -1 when the line ends first (then it was a division). */
function regexEnd(code, at) {
	let inClass = false;
	for (let index = at + 1; index < code.length; index += 1) {
		const char = code[index];
		if (char === "\n") return -1;
		if (char === "\\") index += 1;
		else if (char === "[") inClass = true;
		else if (char === "]") inClass = false;
		else if (char === "/" && !inClass) {
			while (/[a-z]/i.test(code[index + 1] ?? "")) index += 1;
			return index;
		}
	}
	return -1;
}

/**
 * scanCode(code) -> { close, declarations } | null. close: the text that closes every bracket `code` leaves open (a
 * `try {` gets an empty catch, an open template expression its backquote); declarations: where a `const` or `let`
 * starts a statement outside every bracket. Null when the code ends inside a string, template text or block
 * comment. A heuristic: the compile check that follows is the judge.
 */
export function scanCode(code) {
	const stack = [], declarations = [];
	let last = "", word = "", gap = false;
	for (let at = 0; at < code.length; at += 1) {
		const char = code[at];
		if (/\s/.test(char)) {
			if (!gap && !stack.length && (word === "const" || word === "let") && code[at - word.length - 1] !== ".") declarations.push(at - word.length);
			gap = true;
			continue;
		}
		if (char === "/" && code[at + 1] === "/") { const end = code.indexOf("\n", at); if (end < 0) break; at = end; continue; }
		if (char === "/" && code[at + 1] === "*") { const end = code.indexOf("*/", at + 2); if (end < 0) return null; at = end + 1; continue; }
		if (char === "\"" || char === "'") {
			let end = at + 1;
			for (; end < code.length && code[end] !== char && code[end] !== "\n"; end += 1) if (code[end] === "\\") end += 1;
			if (code[end] !== char) return null;
			at = end; last = char; word = ""; gap = false;
			continue;
		}
		const closesTemplate = char === "}" && stack.at(-1) === "}`";
		if (char === "`" || closesTemplate) {
			if (closesTemplate) stack.pop();
			const end = templateEnd(code, at + 1);
			if (!end) return null;
			if (end.open) stack.push("}`");
			at = end.at; last = "`"; word = ""; gap = false;
			continue;
		}
		if (char === "/" && (REGEX_AFTER.test(last) || REGEX_WORDS.has(word))) {
			const end = regexEnd(code, at);
			if (end > 0) { at = end; last = "/"; word = ""; gap = false; continue; }
		}
		if (OPENERS[char]) stack.push(char === "{" && word === "try" ? "}catch{}" : OPENERS[char]);
		else if ("})]".includes(char) && stack.at(-1)?.[0] === char) stack.pop();
		word = /[\w$]/.test(char) ? (!gap && /[\w$]/.test(last) ? word : "") + char : "";
		last = char; gap = false;
	}
	return { close: stack.reverse().join(""), declarations };
}

/** Whether `text` parses as the body codemode runs it as (an async function), inside the try block the sketch wraps it in. */
function compiles(text) {
	try { new Script(`(async (tools, console) => { try {\n${text}\n} finally {} })`); return true; } catch { return false; }
}

/** `text` with its top-level `const`/`let` turned into `var` (padded to the same length), so the sketch's finally
 * block still sees what the cut declared when a later line threw. */
const hoisted = (text, declarations) => declarations.reduceRight((out, at) => `${out.slice(0, at)}${out.startsWith("const", at) ? "var  " : "var"}${out.slice(at + (out.startsWith("const", at) ? 5 : 3))}`, text);

/**
 * runnablePrefix(code, { after = 0, whole = false }) -> { end, source } | null: the longest cut of `code` at a line
 * end past `after` (or all of it, when `whole`: the call is complete) whose text compiles with its open brackets
 * closed. A cut inside a line could hold half a number, so a streaming call is cut at line ends only. `source` is
 * that text, hoisted, plus its closers.
 */
export function runnablePrefix(code, { after = 0, whole = false } = {}) {
	const cuts = whole ? [code.length] : [];
	for (let at = code.lastIndexOf("\n"); at > after && cuts.length < MAX_CUTS; at = code.lastIndexOf("\n", at - 1)) cuts.push(at);
	for (const end of cuts) {
		const text = code.slice(0, end), scanned = scanCode(text);
		if (!scanned || !text.trim()) continue;
		const body = hoisted(text, scanned.declarations);
		if (compiles(`${body}\n${scanned.close}`)) return { start: after, end, source: `${body}\n${scanned.close}` };
		if (scanned.close && compiles(body)) return { start: after, end, source: body };
	}
	return null;
}

/** The names `source` declares (`var S = [`, `, D = [`), whose arrays of parts the sandbox looks at once the cut has run. */
export function declaredNames(source) {
	const names = new Set();
	for (const match of source.matchAll(DECLARED)) if (names.size < 40) names.add(match[1] ?? match[2]);
	for (const match of source.matchAll(DECLARED_FUNCTIONS)) if (names.size < 40) names.add(match[1]);
	return [...names].filter((name) => !name.startsWith("__cozy"));
}

/** Only the newly arrived statements, with their open blocks closed and declarations hoisted. */
export function statementDelta(code, cut) {
	const text = code.slice(cut.start, cut.end), scanned = scanCode(text);
	if (!scanned) return cut.source;
	const body = hoisted(text, scanned.declarations);
	return `${body}\n${scanned.close}`;
}

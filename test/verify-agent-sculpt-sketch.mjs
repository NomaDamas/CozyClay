#!/usr/bin/env node
// The live sculpt sketch (bin/agent/sculpt-sketch.mjs, src/sculpt-sketch-state.js): a script call streamed in
// chunks, built from a real Studio session's 8 KB script, grows its sketch frame by frame with the right parts and
// placement, stays within its caps, never reaches a real tool, survives broken code, and clears; the browser keeps
// it per call and drops it when the call's tool.done (or the turn's end) arrives.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { parseStreamingJson } from "@earendil-works/pi-ai/utils/json-parse";
import { createSculptSketch, sculptSketchGroups } from "../bin/agent/sculpt-sketch.mjs";
import { declaredNames, runnablePrefix, scanCode, streamedCode } from "../bin/agent/sketch-code.mjs";
import { dryRunSketch } from "../bin/agent/sketch-sandbox.mjs";
import { createReasoningFrames } from "../bin/agent/turn-frames.mjs";
import { SCULPT_SHAPES, SCULPT_SHAPE_KEYS } from "../src/sculpt-shapes.js";
import { clearSculptSketch, sculptSketchFrame, sculptSketchSnapshot, sketchDrawnParts, subscribeSculptSketch } from "../src/sculpt-sketch-state.js";

const { calls: [stallCall, goodsCall] } = JSON.parse(readFileSync(new URL("./fixtures/agent-sculpt-scripts.json", import.meta.url), "utf8"));
const env = { shapes: SCULPT_SHAPES, keys: SCULPT_SHAPE_KEYS };
const partCount = (frame) => frame.groups.reduce((sum, group) => sum + group.parts.length, 0);
const findPart = (frame, id) => frame.groups.flatMap((group) => group.parts).find((part) => part.id === id);

/**
 * Streams `args` as one tool call the way pi-ai does: toolcall_start, the argument JSON in `chunk`-character deltas
 * (with the partially parsed arguments when `parsed`, or `{}` like the faux provider), toolcall_end. The clock moves
 * `stepMs` per delta and every pending sketch settles before the next one, so the frames are deterministic.
 */
async function streamCall({ name, args, id = "call-1", chunk = 60, stepMs = 120, parsed = true, sketch: given, frames = [] }) {
	let now = 0;
	const sketch = given ?? createSculptSketch((frame) => frames.push(frame), () => now);
	const json = JSON.stringify(args), partial = { content: [] };
	const block = { type: "toolCall", id, name, arguments: {} };
	partial.content[0] = block;
	sketch.onMessageEvent({ type: "toolcall_start", contentIndex: 0, partial });
	for (let at = 0; at < json.length; at += chunk) {
		const delta = json.slice(at, at + chunk);
		if (parsed) block.arguments = parseStreamingJson(json.slice(0, at + chunk));
		now += stepMs;
		sketch.onMessageEvent({ type: "toolcall_delta", contentIndex: 0, delta, partial });
		await sketch.settled();
	}
	block.arguments = args;
	sketch.onMessageEvent({ type: "toolcall_end", contentIndex: 0, toolCall: block, partial });
	await sketch.settled();
	return { sketch, frames };
}

// 1. The real 8.4 KB script, streamed with pi-ai's partial arguments: the sketch grows, then names and places the stall.
{
	const { sketch, frames } = await streamCall({ name: "script", args: { code: stallCall.code } });
	assert.ok(frames.length >= 6, `the stall grows over several frames (${frames.length})`);
	assert.ok(frames.every((frame) => frame.type === "sculpt.sketch" && frame.index === 0 && frame.callId === "call-1"));
	const counts = frames.map(partCount);
	for (let at = 1; at < counts.length; at += 1) assert.ok(counts[at] >= counts[at - 1], `parts never shrink while it streams: ${counts.join(" ")}`);
	assert.ok(counts[0] > 0 && counts[0] < 20, `the first frame comes early, with the first parts (${counts[0]})`);
	assert.ok(frames.every((frame) => partCount(frame) <= 300 && JSON.stringify(frame).length <= 48 * 1024), "every frame stays within its caps");
	const last = frames.at(-1);
	assert.equal(last.groups.length, 1);
	assert.deepEqual({ key: last.groups[0].key, name: last.groups[0].name, placement: last.groups[0].placement }, { key: "a0", name: "Yatai Stall", placement: { x: 0, y: 0, z: -2, rot: 0 } });
	assert.equal(partCount(last), 60);
	assert.deepEqual(findPart(last, "body"), { id: "body", shape: "box", size: [1.52, 0.6, 0.85], position: [0, 0.58, 0], color: "#c4503c" });
	// camelCase ids the real recipe refused become ids it accepts; { x, y, z } becomes [x, y, z]; a mirror stays one.
	assert.deepEqual(findPart(last, "wheel-f"), { id: "wheel-f", shape: "cylinder", size: [0.36, 0.07, 0.36], position: [0.5, 0.18, 0.36], rotation: [90, 0, 0], color: "#4a3b2e", mirror: true });
	assert.equal(findPart(last, "rope").shape, "tube");
	assert.equal(findPart(last, "rope").path.length, 3);
	assert.equal(findPart(last, "jar").profile.length, 7);
	assert.equal(findPart(last, "vine").count, 160);
	assert.ok(!("material" in findPart(last, "body")) && !("detail" in findPart(last, "body")), "looks stay out of the sketch");
	assert.ok(frames.slice(0, -1).every((frame) => !frame.groups[0].placement), "the placement arrives with the object.sculpt call");
	// The message ran its tools: the sketch stays for the browser to drop at tool.done.
	sketch.onMessageEvent({ type: "done", reason: "toolUse" });
	assert.equal(frames.at(-1), last);
}

// 2. Two sculpts (stall + goods, ids fixed in code after the pushes), streamed like the faux provider: raw deltas only.
{
	const { sketch, frames } = await streamCall({ name: "script", args: { code: goodsCall.code }, parsed: false, chunk: 45 });
	assert.ok(frames.length >= 6);
	const last = frames.at(-1);
	assert.deepEqual(last.groups.map((group) => [group.name, group.placement?.z, group.parts.length]), [["Yatai Stall", -2, 33], ["Stall Goods", -2, 27]]);
	assert.ok(findPart(last, "rail-top") && findPart(last, "wood-box"), "ids as the script's own fix() left them");
	assert.ok(frames.some((frame) => frame.groups.length === 2 && !frame.groups[1].name), "the goods show before their call is written");
	// An aborted message clears what it showed, once.
	sketch.onMessageEvent({ type: "error", reason: "aborted" });
	assert.deepEqual(frames.at(-1), { type: "sculpt.sketch", index: 0, callId: "call-1", groups: [] });
	sketch.onMessageEvent({ type: "error", reason: "aborted" });
	assert.equal(frames.filter((frame) => !frame.groups.length).length, 1);
}

// 3. The cutter: whole lines only while streaming, brackets closed, template/string ends refused; the raw fallback decodes escapes.
{
	assert.equal(scanCode("for (const z of [1,2]) {\n  hang.forEach((h,i)=>{ S.push(x);").close, "})}");
	assert.equal(scanCode("const fix=s=>s.replace(/([a-z0-9])([A-Z])/g,'$1-$2');\ntry {\n const a = `x${b + ({").close, "})}`}catch{}");
	assert.equal(scanCode("const a = `still ${open} text"), null);
	assert.equal(scanCode("const a = 'half"), null);
	assert.deepEqual(scanCode("const S = [];\nlet t = 1;\nfor (const z of S) {}").declarations, [0, 14]);
	assert.equal(runnablePrefix("const S = [];\nS.push({ id: 'a', size: [0.3", {}).source.trim(), "var   S = [];");
	assert.equal(runnablePrefix("syntax error here (((\n", {}), null);
	assert.deepEqual(declaredNames("var   S = [], D = [];\nfunction f() { const c = 1; }"), ["S", "D", "c"]);
	assert.equal(streamedCode({ arguments: {} }, `{"code":"const a = \\"q\\\\n\\";\\nS.pu`), "const a = \"q\\n\";\nS.pu");
	assert.equal(streamedCode({ arguments: {} }, "{\"code\":\"x\\u00"), "x");
}

// 4. The sandbox has no capability: no tools, no host. Broken, hostile or endless code yields nothing harmful.
{
	const run = (code) => dryRunSketch(runnablePrefix(code, { whole: true }).source, declaredNames(code), env);
	const probe = await run(`const S = []; S.push({ id: "tools-" + ALL_TOOLS.length, shape: "box", size: [1, 1, 1] });
		S.push({ id: [typeof fetch, typeof process, typeof require].join("-"), shape: "box", size: [1, 1, 1] });
		const r = await tools.run_action({ action: "object.remove", args: { ids: ["everything"] } });
		S.push({ id: "fake-" + r.status, shape: "box", size: [1, 1, 1] });`);
	assert.deepEqual(probe.groups[0].parts.map((part) => part.id), ["tools-0", "undefined-undefined-undefined", "fake-completed"]);
	const started = Date.now();
	assert.equal(await run("const S = [{ id: 'a', shape: 'box', size: [1, 1, 1] }];\nwhile (true) {}"), null, "an endless loop times out");
	assert.ok(Date.now() - started < 2000, "and within the sketch's deadline");
	assert.deepEqual((await run("const S = [];\nconst big = [];\nfor (;;) big.push('x'.repeat(1 << 20));"))?.groups ?? [], [], "a heap bomb fails inside its small heap");
	// A cut that throws part way still reports what it built; a cycle of parents and junk come back harmless.
	const thrown = await run("const S = [{ id: 'a', shape: 'box', size: [1, 1, 1] }];\nmissing.call();\nS.push({ id: 'b', shape: 'box', size: [1, 1, 1] });");
	assert.deepEqual(thrown.groups[0].parts.map((part) => part.id), ["a"]);
	const junk = sculptSketchGroups({ groups: [{ key: "a0", placement: { x: "1", z: 2 }, parts: [{ id: 1, shape: "box", size: [1, 2] }, { shape: "nope", size: [1, 1, 1] }, { id: "Ok Part", shape: "blob", size: { x: 1, y: 2, z: 3 }, color: "red", op: undefined }, { id: "cut", shape: "box", size: [1, 1, 1], op: "subtract" }] }] }, env);
	assert.deepEqual(junk, [{ key: "a0", placement: { z: 2 }, parts: [{ id: "ok-part", shape: "blob", size: [1, 2, 3] }] }]);
	const frames = [];
	const sketch = createSculptSketch((frame) => frames.push(frame), () => 1e9);
	for (const code of ["}}}{{{", "\u0000\u0001", "const x = ;"]) {
		sketch.onMessageEvent({ type: "toolcall_end", contentIndex: 0, toolCall: { type: "toolCall", id: "bad", name: "script", arguments: { code } } });
		await sketch.settled();
	}
	sketch.onMessageEvent({ type: "toolcall_end", contentIndex: 0, toolCall: { type: "toolCall", id: "bad", name: "script", arguments: { code: 42 } } });
	sketch.onMessageEvent(null);
	sketch.onMessageEvent({ type: "toolcall_delta", contentIndex: 3, partial: null });
	await sketch.settled();
	assert.deepEqual(frames, [], "broken calls send nothing");
}

// 5. A direct run_action object.sculpt: partially parsed parts, the half-written last one held back until the end.
{
	const parts = Array.from({ length: 6 }, (_, n) => ({ id: `leg${n}`, shape: "cylinder", size: [0.05, 0.4, 0.05], position: { x: n * 0.1, y: 0.2, z: 0 } }));
	const args = { action: "object.sculpt", args: { name: "Bench", recipe: { version: 1, parts }, placement: { x: 1, y: 0, z: 2, rot: 90 } } };
	const { frames } = await streamCall({ name: "run_action", args, chunk: 30, stepMs: 300 });
	const counts = frames.map(partCount);
	assert.ok(counts.length >= 3 && counts.every((count, at) => !at || count >= counts[at - 1]), counts.join(" "));
	assert.ok(counts.slice(0, -1).every((count) => count < 6));
	assert.deepEqual(frames.at(-1).groups, [{ key: "d", name: "Bench", placement: { x: 1, y: 0, z: 2, rot: 90 }, parts: parts.map((part, n) => ({ id: `leg${n}`, shape: "cylinder", size: [0.05, 0.4, 0.05], position: [n * 0.1, 0.2, 0].map((value) => Math.round(value * 1e4) / 1e4) })) }]);
	// A catalogue add uses the same preview; read-only tools never sketch.
	const other = await streamCall({ name: "run_action", args: { action: "object.add", args: { kind: "cube" } } });
	assert.equal(partCount(other.frames.at(-1)), 1);
	assert.equal(other.frames.at(-1).groups[0].parts[0].shape, "box");
	const inspect = await streamCall({ name: "inspect_studio", args: { scope: "document" } });
	assert.deepEqual(inspect.frames, []);
}

// 6. turn-frames.mjs carries the sketch beside tool.compose.
{
	const frames = [];
	let now = 0;
	const reasoning = createReasoningFrames((frame) => frames.push(frame), () => now);
	const block = { type: "toolCall", id: "c9", name: "script", arguments: { code: "// Benches\nconst S = [];\nS.push({ id: 'seat', shape: 'box', size: [1, 0.1, 0.4], position: [0, 0.45, 0] });\n" } };
	reasoning.onMessageEvent({ type: "toolcall_start", contentIndex: 0, partial: { content: [block] } });
	now = 1000;
	reasoning.onMessageEvent({ type: "toolcall_delta", contentIndex: 0, delta: "x", partial: { content: [block] } });
	await new Promise((resolve) => setTimeout(resolve, 600));
	assert.deepEqual(frames.map((frame) => frame.type), ["tool.compose", "sculpt.sketch"]);
	assert.equal(frames[1].groups[0].parts[0].id, "seat");
}

// 7. The browser: one sketch per call, dropped at its tool.done (a trailing frame cannot bring it back), cleared with the turn.
{
	let notified = 0;
	const unsubscribe = subscribeSculptSketch(() => { notified += 1; });
	const group = (key, parts) => ({ key, parts });
	const box = (id, extra = {}) => ({ id, shape: "box", size: [1, 1, 1], ...extra });
	sculptSketchFrame({ type: "sculpt.sketch", index: 0, callId: "a", groups: [group("a0", [box("x")])] });
	sculptSketchFrame({ type: "sculpt.sketch", index: 1, callId: "b", groups: [group("a0", [box("y")])] });
	assert.deepEqual(sculptSketchSnapshot().map((entry) => entry.key), ["a/a0", "b/a0"]);
	const before = sculptSketchSnapshot();
	sculptSketchFrame({ type: "tool.compose", index: 0, name: "script" });
	assert.equal(sculptSketchSnapshot(), before, "other frames leave the snapshot alone");
	sculptSketchFrame({ type: "tool.done", callId: "a", ok: true });
	sculptSketchFrame({ type: "sculpt.sketch", index: 0, callId: "a", groups: [group("a0", [box("late")])] });
	assert.deepEqual(sculptSketchSnapshot().map((entry) => entry.key), ["b/a0"]);
	sculptSketchFrame({ type: "sculpt.sketch", index: 1, callId: "b", groups: [] });
	assert.deepEqual(sculptSketchSnapshot(), []);
	sculptSketchFrame({ type: "sculpt.sketch", index: 2, groups: [group("d", [box("z")])] });
	sculptSketchFrame({ type: "sculpt.sketch", index: 2, callId: "late-id", groups: [group("d", [box("z"), box("w")])] });
	assert.deepEqual(sculptSketchSnapshot().map((entry) => entry.key), ["late-id/d"], "the id a provider names late replaces the index");
	sculptSketchFrame({ type: "done" });
	assert.deepEqual(sculptSketchSnapshot(), []);
	sculptSketchFrame({ type: "sculpt.sketch", index: 0, callId: "a", groups: [group("a0", [box("again")])] });
	assert.equal(sculptSketchSnapshot().length, 1, "a new turn may reuse a call id");
	clearSculptSketch();
	assert.deepEqual(sculptSketchSnapshot(), []);
	assert.equal(notified, 9);
	unsubscribe();
	// Lenient per part: a bad part or an orphan is dropped, not the sketch; mirrors and parents expand.
	const drawn = sketchDrawnParts([
		box("body", { color: "#c4503c" }), box("arm", { parent: "body", position: [0.6, 0, 0], mirror: true }), box("hand", { parent: "arm", position: [0.2, 0, 0] }),
		box("orphan", { parent: "not-yet" }), { id: "torus", shape: "torus", size: [1, 1, 2] }, box("body"), { id: "BAD id", shape: "box", size: [1, 1, 1] }, null,
	]);
	assert.deepEqual(drawn.map((part) => part.id), ["body", "arm", "hand", "arm.mirror", "hand.mirror"]);
	assert.deepEqual(drawn.find((part) => part.id === "hand.mirror").matrix.slice(12, 15), [-0.8, 0, 0]);
}

// 8. Ordinary scene arrangements grow while their ops stream: world placement, scale and primitive shapes carry over.
{
	const args = { ops: [
		{ op: "create", source: { kind: "cube" }, name: "Crate", position: { world: { x: 1, y: 0, z: 2 } }, scale: { x: 2, y: 1, z: 1 }, rotationDeg: { x: 0, y: 90, z: 0 } },
		{ op: "create", source: { kind: "sphere" }, name: "Ball", position: { world: { x: -1, y: 0, z: 2 } } },
		{ op: "create", source: { kind: "empty" }, name: "No geometry" },
		{ op: "create", source: { kind: "cube" }, name: "Needs live relation", position: { relativeTo: "Crate", side: "left", gapM: 1 } },
	] };
	const { frames } = await streamCall({ name: "arrange_objects", args, chunk: 100, stepMs: 300 });
	assert.ok(frames.length >= 2 && partCount(frames.at(-1)) === 2);
	const last = frames.at(-1);
	assert.deepEqual(last.groups[0].placement, { x: 1, y: 0, z: 2, rot: 90 });
	assert.deepEqual(last.groups[0].parts[0], { id: "body", shape: "box", size: [2, 1, 1], position: [0, 0.5, 0] });
	assert.equal(last.groups[1].parts[0].shape, "blob");
	assert.ok(!last.groups.some(group => group.name === "No geometry"), "an Empty never becomes fake geometry");
	assert.ok(!last.groups.some(group => group.name === "Needs live relation"), "a relation is never guessed at the origin");
}

// 9. A script dry run also records arrangements and direct cast adds, without executing a real tool.
{
	const code = `await tools.arrange_objects({ ops: [{ op: "create", source: { kind: "cylinder" }, name: "Column", position: { world: { x: 2, y: 0, z: -1 } } }] });
	await tools.run_action({ action: "objects.batch", args: { ops: [{ name: "object.add", args: { kind: "cube", name: "Batched crate", placement: { x: 4, y: 0, z: 1 } } }] } });
	await tools.run_action({ action: "character.add", args: { character: { subject: "Alex", x: 0, y: 0, z: 3, rot: 45, scale: 1, tint: "#ff0000" } } });`;
	const { frames } = await streamCall({ name: "script", args: { code }, parsed: false, chunk: 70 });
	const last = frames.at(-1);
	assert.equal(last.groups.length, 3);
	assert.equal(findPart(last, "body").shape, "cylinder");
	assert.deepEqual(last.groups.find(group => group.name === "Batched crate").placement, { x: 4, y: 0, z: 1, rot: 0 });
	const alex = last.groups.find(group => group.name === "Alex");
	assert.deepEqual(alex.placement, { x: 0, y: 0, z: 3, rot: 45 });
	assert.deepEqual(alex.parts[0], { id: "body", shape: "blob", size: [0.7, 1.8, 0.7], position: [0, 0.9, 0], color: "#ff0000" });
	const direct = await streamCall({ name: "run_action", args: { action: "objects.batch", args: { ops: [{ name: "object.add", args: { kind: "sphere", name: "Direct batch", placement: { x: 1, y: 0, z: 1 } } }] } } });
	assert.equal(partCount(direct.frames.at(-1)), 1);
	assert.equal(direct.frames.at(-1).groups[0].name, "Direct batch");
}

// 10. More than sixteen creation calls still arrive one by one; no early-call cutoff.
{
	const code = Array.from({ length: 24 }, (_, i) => `await tools.run_action({ action: "object.add", args: { kind: "cube", name: "Part ${i}", placement: { x: ${i * 0.25}, y: 0, z: 0 } } });`).join("\n");
	const { frames } = await streamCall({ name: "script", args: { code }, parsed: false, chunk: 55, stepMs: 300 });
	assert.ok(frames.length >= 3, JSON.stringify(frames.map(partCount)));
	assert.equal(partCount(frames.at(-1)), 24);
	assert.ok(partCount(frames.at(-2)) < 24, "parts accumulate while more code streams");
	assert.deepEqual(frames.at(-1).groups.at(-1).placement, { x: 5.75, y: 0, z: 0, rot: 0 });
}

console.log("PASS verify-agent-sculpt-sketch: sculpts, scene primitives and characters sketch as they stream; dry runs, caps, no tools, broken code and browser lifecycle");

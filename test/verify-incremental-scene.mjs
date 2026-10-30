#!/usr/bin/env node
import assert from "node:assert/strict";
import { createIncrementalScene } from "../bin/agent/incremental-scene.mjs";
import { createReasoningFrames } from "../bin/agent/turn-frames.mjs";

const objects = [], characters = [], calls = [];
let revision = 0;
const receipt = (action, ids) => ({ ok: true, action, status: "applied", receiptId: `r-${revision}`, revision: { before: revision - 1, after: revision }, affectedIds: ids, warnings: [] });
function record(action, args) {
	calls.push({ action, args });
	const ids = [];
	if (action === "object.add") { const id = args.name || `${args.kind}-${objects.length}`; objects.push({ id, ...args }); ids.push(id); }
	if (action === "character.add") { const id = args.subject || `character-${characters.length}`; characters.push({ id, ...args }); ids.push(id); }
	if (action === "objects.arrange" || action === "characters.arrange") for (const op of args.ops) {
		const target = action === "objects.arrange" ? objects : characters;
		if (op.op === "create") { if (op.color) throw Object.assign(new Error("color is not accepted here"), { code: "INVALID_ARGUMENT" }); const id = op.name === "Parent" ? "object-parent" : op.name || `created-${target.length}`; target.push({ id, ...op }); ids.push(id); }
		else if (op.op === "update") { const id = op.id ?? op.characterId, row = target.find(row => row.id === id); if (row) Object.assign(row, op); ids.push(id); }
	}
	return receipt(action, ids);
}
const tools = ["run_action", "arrange_objects", "arrange_characters"].map(name => ({ name,
	handler: async (args) => { await new Promise(resolve => setTimeout(resolve, 2)); return name === "run_action" ? record(args.action, args.args) : record(name === "arrange_objects" ? "objects.arrange" : "characters.arrange", args); },
}));
const incremental = createIncrementalScene({ tools });
const wrapped = tools.map(tool => incremental.wrap(tool));
const run = (action, args, callId = "script-1") => wrapped[0].handler({ action, args }, { callId });

// Stream a real script through the same reasoning/sketch path used by the runner.
let now = 0;
const reasoning = createReasoningFrames(() => {}, () => now, { onScene: incremental.onScene });
const code = [
	`await tools.run_action({ action: "object.add", args: { kind: "cube", name: "A", placement: { x: 0, y: 0, z: 0 } } });`,
	`await tools.run_action({ action: "object.add", args: { kind: "cylinder", name: "B", placement: { x: 1, y: 0, z: 0 } } });`,
	`await tools.run_action({ action: "object.set", args: { id: "A", set: { name: "A renamed" } } });`,
].join("\n");
const block = { type: "toolCall", name: "script", arguments: {} }, partial = { content: [block] };
reasoning.onMessageEvent({ type: "toolcall_start", contentIndex: 0, partial });
const json = JSON.stringify({ code });
for (let at = 0; at < json.length; at += 55) {
	now += 300;
	reasoning.onMessageEvent({ type: "toolcall_delta", contentIndex: 0, delta: json.slice(at, at + 55), partial });
	await new Promise(resolve => setTimeout(resolve, 0));
}
block.arguments = { code };
block.id = "script-1"; // the provider names the call only when it closes
reasoning.onMessageEvent({ type: "toolcall_end", contentIndex: 0, toolCall: block, partial });
await reasoning.settled();
await incremental.settled();
assert.deepEqual(objects.map(object => object.id), ["A", "B"], "completed creation commands run for real while the script streams");
await run("object.add", { kind: "cube", name: "A", placement: { x: 0, y: 0, z: 0 } });
await run("object.add", { kind: "cylinder", name: "B", placement: { x: 1, y: 0, z: 0 } });
await run("object.set", { id: "A", set: { name: "A renamed" } });
assert.deepEqual(objects.map(object => object.id), ["A", "B"], "the final script does not duplicate early objects");
assert.equal(calls.filter(call => call.action === "object.add").length, 2);
assert.equal(calls.filter(call => call.action === "object.set").length, 1, "the remaining non-create action still runs");

// A direct arrangement replays only its update after its creates were streamed.
const arrangeCall = "arrange-1";
incremental.onScene({ callId: arrangeCall, index: 1, scene: [{ kind: "objects", ops: [
	{ op: "create", source: { kind: "cube" }, name: "Parent" },
	{ op: "create", source: { kind: "sphere" }, name: "Child", parent: "Parent" },
] }] });
await incremental.settled();
await wrapped[1].handler({ ops: [
	{ op: "create", source: { kind: "cube" }, name: "Parent" },
	{ op: "create", source: { kind: "sphere" }, name: "Child", parent: "Parent" },
	{ op: "update", id: "Parent", name: "Parent updated" },
] }, { callId: arrangeCall });
assert.equal(objects.filter(object => object.id === "object-parent").length, 1);
assert.equal(objects.filter(object => object.id === "Child").length, 1);
assert.equal(calls.filter(call => call.action === "objects.arrange").length, 3, "two early creates plus the final update, with no in-flight replay");
assert.ok(calls.filter(call => call.action === "objects.arrange").some(call => call.args.ops[0].parent === "object-parent"), "the named parent was replaced with its real id");

// A direct all-create arrangement waits for the in-flight early calls instead of replaying them.
incremental.onScene({ callId: "house-1", index: 2, scene: [{ kind: "objects", ops: [
	{ op: "create", source: { kind: "empty" }, name: "House" },
	{ op: "create", source: { kind: "cube" }, name: "Walls", parent: "House" },
	{ op: "create", source: { kind: "cube" }, name: "Roof", parent: "House" },
] }] });
const houseCalls = calls.filter(call => call.action === "objects.arrange").length;
await wrapped[1].handler({ ops: [
	{ op: "create", source: { kind: "empty" }, name: "House" },
	{ op: "create", source: { kind: "cube" }, name: "Walls", parent: "House" },
	{ op: "create", source: { kind: "cube" }, name: "Roof", parent: "House" },
] }, { callId: "house-1" });
assert.equal(calls.filter(call => call.action === "objects.arrange").length, houseCalls + 3, "the direct all-create arrangement executes only the three early creates");
for (const id of ["House", "Walls", "Roof"]) assert.equal(objects.filter(object => object.id === id).length, 1);

// A model retry with a new tool-call id reuses named objects from the partially valid first call.
incremental.onScene({ callId: "retry-1", index: 3, scene: [{ kind: "objects", ops: [
	{ op: "create", source: { kind: "empty" }, name: "RetryHouse" },
	{ op: "create", source: { kind: "cube" }, name: "RetryWalls", parent: "RetryHouse", color: "#fff" },
] }] });
await incremental.settled();
incremental.onScene({ callId: "retry-2", index: 3, scene: [{ kind: "objects", ops: [
	{ op: "create", source: { kind: "empty" }, name: "RetryHouse" },
	{ op: "create", source: { kind: "cube" }, name: "RetryWalls", parent: "RetryHouse" },
] }] });
await wrapped[1].handler({ ops: [
	{ op: "create", source: { kind: "empty" }, name: "RetryHouse" },
	{ op: "create", source: { kind: "cube" }, name: "RetryWalls", parent: "RetryHouse" },
] }, { callId: "retry-2" });
assert.equal(objects.filter(object => object.id === "RetryHouse").length, 1);
assert.equal(objects.filter(object => object.id === "RetryWalls").length, 1);

// Batch and cast creation use the same once-only path.
await run("objects.batch", { ops: [{ name: "object.add", args: { kind: "cone", name: "Batched" } }] }, "batch-1");
await run("character.add", { subject: "Alex", x: 0, y: 0, z: 2 }, "cast-1");
await incremental.settled();
assert.equal(objects.filter(object => object.id === "Batched").length, 1);
assert.equal(characters.filter(character => character.id === "Alex").length, 1);
console.log("PASS incremental scene: real creation while streaming, no final duplicates, remaining ops, batches and cast");

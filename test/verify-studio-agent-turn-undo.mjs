#!/usr/bin/env node
import assert from "node:assert/strict";
import { createAppContext } from "../src/app-context.js";
import { createCommandBus } from "../src/command-bus.js";
import { createDocumentStore } from "../src/document-store.js";
import { createStudioCommandJournal } from "../src/studio-agent-commands.js";

const host = { workspaceId: "workspace", documentEpoch: "document", sceneId: "scene", sceneEpoch: "epoch" };
const revision = { current: 0 };
let previsMode = "storyboard";
const app = createAppContext();
const castStore = createDocumentStore({ owned: { characters: [] }, dev: false });
const objectStore = createDocumentStore({ owned: { objects: [] }, dev: false });
const cast = {
	documentStore: castStore,
	beginAction: targetId => castStore.beginAction("characters", targetId),
	write(update) {
		const before = castStore.read("characters");
		const next = typeof update === "function" ? update(before) : update;
		castStore.write("characters", next);
		if (next !== before) revision.current++;
		return next;
	},
	read: () => castStore.read("characters"),
};
const objects = {
	documentStore: objectStore,
	beginAction: targetId => objectStore.beginAction("objects", targetId),
	write(update) {
		const before = objectStore.read("objects");
		const next = typeof update === "function" ? update(before) : update;
		objectStore.write("objects", next);
		if (next !== before) revision.current++;
		return next;
	},
	read: () => objectStore.read("objects"),
};
app.registerStoreDomain("cast", cast);
app.registerStoreDomain("objects", objects);
app.updatePorts({ revision });

const actions = {
	"character.add": {
		id: "character.add", kind: "mutation", undoDomain: "cast", exposure: "public",
	},
	"object.add": {
		id: "object.add", kind: "mutation", undoDomain: "objects", exposure: "public",
	},
};
const registry = {
	state: () => ({}),
	prepare(id, args) { return { entry: actions[id], args }; },
	invoke(entry, args) {
		if (entry.id === "character.add") {
			cast.write(rows => [...rows, args.character]);
			return { affectedIds: [args.character.id], summary: "Added character" };
		}
		objects.write(rows => [...rows, args.object]);
		return { affectedIds: [args.object.id], summary: "Added object" };
	},
};
const journal = createStudioCommandJournal({ host });
const receipts = new Map();
const ports = {
	read: () => ({
		host, revision: revision.current, previsMode, busy: false,
		domainRevisions: { cast: revision.current, objects: revision.current },
	}),
	journal: () => journal,
	recordAction: (...args) => app.recordAction(...args),
	beginAction: (...args) => app.beginAction(...args),
	revision,
	isRetained: receipt => Boolean(app.storeDomainForReceipt(receipt)),
	canUndo: receipt => Boolean(app.storeDomainForReceipt(receipt)?.canUndo(receipt.undo.historyEntryId)),
	undo: () => app.nextStoreHistory(false)?.stepHistory(false),
	redo: () => app.nextStoreHistory(true)?.stepHistory(true),
	history: redo => app.historyEntry(redo),
	receipt: id => receipts.get(id),
	readTarget: id => id,
	remember: receipt => { receipts.set(receipt.receiptId, receipt); return receipt; },
};
const bus = createCommandBus({ registry, ports });
const request = (name, args, extra = {}) => ({
	origin: "agent", name, args, commandId: crypto.randomUUID(),
	host, expectedRevision: revision.current, ...extra,
});
const turnId = crypto.randomUUID();
const begin = bus.run("agent.turn.begin", { turnId }, request("run_action", { action: "agent.turn.begin", args: { turnId } }, { turnId }));
assert.equal(begin.ok, true, JSON.stringify(begin));

const character = bus.run("character.add", { character: { id: "character-1" } }, request("run_action", { action: "character.add", args: { character: { id: "character-1" } } }, { turnId }));
assert.equal(character.ok, true, JSON.stringify(character));
assert.deepEqual(character.undo, { historyEntryId: turnId, entries: 1, canUndoDirect: false });
const object = bus.run("object.add", { object: { id: "object-1" } }, request("run_action", { action: "object.add", args: { object: { id: "object-1" } } }, { turnId }));
assert.equal(object.ok, true, JSON.stringify(object));
assert.deepEqual(object.undo, { historyEntryId: turnId, entries: 1, canUndoDirect: false });

const finish = bus.run("agent.turn.finish", { turnId }, request("run_action", { action: "agent.turn.finish", args: { turnId } }, { turnId }));
assert.equal(finish.ok, true, JSON.stringify(finish));
assert.equal(finish.authored, true);
assert.equal(finish.undo.entries, 1);
assert.equal(typeof finish.undo.historyEntryId, "string");
assert.deepEqual(cast.read(), [{ id: "character-1" }]);
assert.deepEqual(objects.read(), [{ id: "object-1" }]);

const undone = bus.run("edit.undo", {}, request("run_action", { action: "edit.undo", args: {} }));
assert.equal(undone.ok, true, JSON.stringify(undone));
assert.equal(undone.status, "undone");
assert.deepEqual(cast.read(), []);
assert.deepEqual(objects.read(), []);

const animationRevision = revision.current;
const animation = bus.run("character.add", { character: { id: "character-2" } }, {
	origin: "agent", name: "run_action", args: { action: "character.add", args: { character: { id: "character-2" } } },
	commandId: crypto.randomUUID(), host, expectedRevision: animationRevision,
});
assert.equal(animation.ok, true, JSON.stringify(animation));
assert.equal(animation.undo.entries, 1);
assert.notEqual(animation.undo.historyEntryId, finish.undo.historyEntryId);
console.log("PASS storyboard agent turn composes cast and object mutations into one undo entry");
console.log(`PASS ordinary agent command remains per-command undo: ${animation.undo.entries} entry`);

// #715: an animation project opens the same turn transaction. Every mutation of
// one user message lands as exactly one history entry, undone by one edit.undo.
previsMode = "animation";
const preTurn = { cast: cast.read(), objects: objects.read(), entry: app.historyEntry(false) };
const animationTurnId = crypto.randomUUID();
const control = (action, id) => bus.run(action, { turnId: id }, request("run_action", { action, args: { turnId: id } }, { turnId: id }));
const opened = control("agent.turn.begin", animationTurnId);
assert.equal(opened.ok, true, `an animation project opens a turn transaction: ${JSON.stringify(opened)}`);
const turnMutations = [
	["character.add", { character: { id: "character-3" } }],
	["object.add", { object: { id: "object-2" } }],
	["object.add", { object: { id: "object-3" } }],
];
for (const [action, args] of turnMutations) {
	const mutation = bus.run(action, args, request("run_action", { action, args }, { turnId: animationTurnId }));
	assert.equal(mutation.ok, true, JSON.stringify(mutation));
	assert.deepEqual(mutation.undo, { historyEntryId: animationTurnId, entries: 1, canUndoDirect: false });
}
const refusedUndo = bus.run("edit.undo", {}, request("run_action", { action: "edit.undo", args: {} }));
assert.equal(refusedUndo.code, "TARGET_BUSY", "history traversal waits for the open turn");
const closed = control("agent.turn.finish", animationTurnId);
assert.equal(closed.ok, true, JSON.stringify(closed));
assert.equal(closed.authored, true);
assert.equal(closed.undo.entries, 1);
assert.equal(app.historyEntry(false), closed.undo.historyEntryId, "the turn is the newest history entry");
assert.deepEqual(cast.read(), [...preTurn.cast, { id: "character-3" }]);
assert.deepEqual(objects.read(), [...preTurn.objects, { id: "object-2" }, { id: "object-3" }]);
const undoneTurn = bus.run("edit.undo", { receiptId: closed.receiptId }, request("run_action", { action: "edit.undo", args: { receiptId: closed.receiptId } }));
assert.equal(undoneTurn.ok, true, JSON.stringify(undoneTurn));
assert.equal(undoneTurn.status, "undone");
assert.deepEqual({ cast: cast.read(), objects: objects.read(), entry: app.historyEntry(false) }, preTurn, "one edit.undo restores the pre-turn document and history frontier");
console.log(`PASS animation agent turn composes ${turnMutations.length} mutations into one history entry undone by one edit.undo`);

// A rolled-back turn restores every owner it touched and leaves no entry.
const preRollback = { cast: cast.read(), objects: objects.read(), entry: app.historyEntry(false) };
const rollbackTurnId = crypto.randomUUID();
assert.equal(control("agent.turn.begin", rollbackTurnId).ok, true);
for (const [action, args] of turnMutations) assert.equal(bus.run(action, args, request("run_action", { action, args }, { turnId: rollbackTurnId })).ok, true);
assert.equal(cast.read().length, preRollback.cast.length + 1);
const cancelled = control("agent.turn.cancel", rollbackTurnId);
assert.equal(cancelled.ok, true, JSON.stringify(cancelled));
assert.equal(cancelled.authored, false);
assert.equal(cancelled.undo, null);
assert.deepEqual({ cast: cast.read(), objects: objects.read(), entry: app.historyEntry(false) }, preRollback, "agent.turn.cancel restores the pre-turn document without a history entry");
const afterRollback = bus.run("character.add", { character: { id: "character-4" } }, request("run_action", { action: "character.add", args: { character: { id: "character-4" } } }, { turnId: rollbackTurnId }));
assert.equal(afterRollback.code, "STALE_TARGET", "a cancelled turn admits no more mutations");
console.log("PASS agent.turn.cancel rolls the whole turn back with no history entry");

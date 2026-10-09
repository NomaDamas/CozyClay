#!/usr/bin/env node
import assert from "node:assert/strict";
import { createAppContext } from "../src/app-context.js";
import { createCommandBus } from "../src/command-bus.js";
import { createDocumentStore } from "../src/document-store.js";
import { createStudioCommandJournal } from "../src/studio-agent-commands.js";

const host = { workspaceId: "workspace", documentEpoch: "document", sceneId: "scene", sceneEpoch: "epoch" };
const revision = { current: 0 };
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
		host, revision: revision.current, previsMode: "storyboard", busy: false,
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

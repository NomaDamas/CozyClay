#!/usr/bin/env node
// The Studio `script` tool (#715): one model call runs a JavaScript body that
// calls the turn's Studio tools N times inside a pi-codemode sandbox. The
// fixture editor is a real command bus behind a fake live hub, so the turn
// transaction (agent.turn.begin/finish/cancel) and history are the real ones.
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { once } from "node:events";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createAgentHandler } from "../bin/agent/agent-routes.mjs";
import { createAppContext } from "../src/app-context.js";
import { createCommandBus } from "../src/command-bus.js";
import { createDocumentStore } from "../src/document-store.js";
import { createStudioCommandJournal } from "../src/studio-agent-commands.js";
import { STUDIO_TOOL_FAMILIES } from "../src/studio-agent-protocol.js";
import { createFakeModel } from "./fixtures/fake-model.mjs";

const sessionDir = mkdtempSync(join(tmpdir(), "cozyclay-agent-script-"));
process.env.COZYCLAY_AGENT_SESSIONS_DIR = sessionDir;
process.on("exit", () => rmSync(sessionDir, { recursive: true, force: true }));

const png = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=";
const identity = { workspaceId: "tab-7", documentEpoch: "doc-3", sceneId: "scene-main", sceneEpoch: "scene-open-4" };
const revision = { current: 41 };

// --- the fixture editor: one object owner, a real bus and real history ---
const app = createAppContext();
const objectStore = createDocumentStore({ owned: { objects: [] }, dev: false });
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
app.registerStoreDomain("objects", objects);
app.updatePorts({ revision });
const actions = { "object.add": { id: "object.add", kind: "mutation", undoDomain: "objects", exposure: "public" } };
const registry = {
	state: () => ({}),
	prepare(id, args) { if (!actions[id]) throw Object.assign(new Error(`Unknown action ${id}`), { code: "INVALID_ARGUMENT" }); return { entry: actions[id], args }; },
	invoke(entry, args) { objects.write(rows => [...rows, args.object]); return { affectedIds: [args.object.id], summary: "Added object" }; },
};
const receipts = new Map();
const journal = createStudioCommandJournal({ host: identity });
const bus = createCommandBus({ registry, ports: {
	read: () => ({ host: identity, revision: revision.current, previsMode: "animation", busy: false, domainRevisions: { objects: revision.current } }),
	journal: () => journal,
	recordAction: (...args) => app.recordAction(...args),
	beginAction: (...args) => app.beginAction(...args),
	isRetained: receipt => Boolean(app.storeDomainForReceipt(receipt)),
	canUndo: receipt => app.historyEntry(false) === receipt.undo.historyEntryId,
	undo: () => app.nextStoreHistory(false)?.stepHistory(false),
	redo: () => app.nextStoreHistory(true)?.stepHistory(true),
	history: redo => app.historyEntry(redo),
	receipt: id => receipts.get(id),
	readTarget: id => id,
	readback: id => ({ token: id }),
	remember: receipt => { receipts.set(receipt.receiptId, receipt); return receipt; },
} });

const context = () => ({
	schema: "studio-context-v1",
	host: { surface: "studio", workspaceHandle: "handle-12", ...identity },
	revision: { scene: revision.current, physics: 9, view: 18 },
	units: { distance: "m", angle: "deg", up: "+Y", yawZero: "+Z", yawPositiveToward: "+X", pivot: "base", fps: 24, rangeEnd: "exclusive" },
	scene: { name: "Workshop", aspect: "16:9", floorY: 0, frameCount: 144, objectCount: objects.read().length, characterCount: 0, previsMode: "animation" },
	selection: null, activeCharacterId: null,
	view: { mode: "scene", frame: 0, playing: false, lookThrough: false, grid: false, autoColor: false }, shot: null, camera: null,
	entities: [], entityPage: { returned: 0, total: 0, truncated: false, nextCursor: null },
	shots: [], shotsTruncated: false, assets: [], recentReceipts: [], jobs: [],
	capabilities: { profile: "studio-slice-1", tools: [...STUDIO_TOOL_FAMILIES], rigReady: true, cameraReady: false, bridgeReady: false },
});

// The live hub forwards run_action to the bus exactly as studio-app-binding's
// runAction does; inspect/verify/image answer like the editor.
const commands = [];
const liveHub = {
	command: async (name, payload) => {
		commands.push({ name, action: payload?.args?.action ?? null });
		if (name === "inspect_studio") return { context: { revision: { scene: revision.current } } };
		if (name === "verify_result") return { receiptId: null, revision: { scene: revision.current, physics: 9, view: 18 }, stale: false, checks: { coverage: "current-scene-targets" }, visualRefs: [{ imageId: "capture-1" }], unsupportedChecks: [] };
		if (name === "resolve_studio_image") return { imageId: "capture-1", dataUrl: png, revision: { scene: revision.current } };
		if (name === "run_action") {
			const { name: _name, args, ...options } = payload;
			return bus.run(args.action, args.args, { ...options, origin: "agent", turnId: payload.turnId });
		}
		throw new Error(`unexpected hub command ${name}`);
	},
};
const studioRuntime = { readContext: async () => context() };

async function readSse(response, onEvent) {
	const reader = response.body.getReader(), decoder = new TextDecoder(), events = [];
	let buffer = "", raw = "";
	for (;;) {
		const { value, done } = await reader.read();
		if (done) break;
		const chunk = decoder.decode(value, { stream: true });
		raw += chunk; buffer += chunk;
		let index;
		while ((index = buffer.indexOf("\n\n")) !== -1) {
			const match = /^data: (.+)$/m.exec(buffer.slice(0, index));
			buffer = buffer.slice(index + 2);
			if (!match) continue;
			const event = JSON.parse(match[1]);
			events.push(event);
			await onEvent?.(event);
		}
	}
	return { events, raw };
}

async function scriptTurn(code) {
	const fake = createFakeModel();
	fake.script([{ type: "toolCall", id: "script-1", name: "script", arguments: { code } }, "done"]);
	let server;
	const handler = createAgentHandler({ auth: { getAccessToken: async () => "token" }, codex: { parseQuotaHeaders: () => ({ primary: {}, credits: {} }) }, models: fake.models, fauxProvider: fake.fauxProvider, liveHub, studioRuntime, port: () => server.address().port });
	server = createServer((req, res) => handler(req, res).catch(error => { if (!res.headersSent) { res.writeHead(500); res.end(error.stack); } else if (!res.writableEnded) res.end(); }));
	server.listen(0, "127.0.0.1"); await once(server, "listening");
	const origin = `http://127.0.0.1:${server.address().port}`;
	commands.length = 0;
	const envelope = { surface: "studio", sessionId: crypto.randomUUID(), turnId: crypto.randomUUID(), text: "ring of pillars", context: context() };
	const response = await fetch(`${origin}/agent/turn`, { method: "POST", signal: AbortSignal.timeout(30000), headers: { origin, "content-type": "application/json" }, body: JSON.stringify(envelope) });
	assert.equal(response.status, 200);
	const stream = await readSse(response);
	await handler.close(); await new Promise(resolve => server.close(resolve));
	return { ...stream, modelCalls: fake.calls };
}

const toolCommands = () => commands.filter(command => command.name !== "resolve_studio_image" && !String(command.action).startsWith("agent.turn."));

// --- (a) one script call runs 7 commands as one tool call and one history entry ---
{
	const preTurn = { objects: objects.read(), entry: app.historyEntry(false) };
	const { events, raw, modelCalls } = await scriptTurn(`
		const scene = await tools.inspect_studio({ scope: "scene" });
		const placed = [];
		for (let i = 0; i < 5; i++) {
			const angle = (2 * Math.PI * i) / 5;
			const receipt = await tools.run_action({ action: "object.add", args: { object: { id: "pillar-" + i, x: Number((3 * Math.cos(angle)).toFixed(3)), y: 0, z: Number((3 * Math.sin(angle)).toFixed(3)) } } });
			placed.push(receipt.affectedIds[0]);
		}
		const check = await tools.verify_result({ targets: placed, checks: ["placement"] });
		text("placed " + placed.length + " at revision " + scene.context.revision.scene);
		return { placed, visualStatus: check.visualStatus, carriesImage: "dataUrl" in check };
	`);
	assert.deepEqual(toolCommands().map(command => command.action ?? command.name), ["inspect_studio", "object.add", "object.add", "object.add", "object.add", "object.add", "verify_result"], "the fixture hub received the script's 7 commands");
	assert.deepEqual(commands.filter(command => String(command.action).startsWith("agent.turn.")).map(command => command.action), ["agent.turn.begin", "agent.turn.finish"], "the animation turn is one transaction");
	const starts = events.filter(event => event.type === "tool.start"), dones = events.filter(event => event.type === "tool.done");
	assert.deepEqual(starts.map(event => [event.name, event.label]), [["script", "Run a script"]], "exactly one tool.start, for script");
	assert.equal(dones.length, 1, "exactly one tool.done");
	const result = dones[0].result;
	assert.equal(dones[0].ok, true, JSON.stringify(dones[0]));
	assert.equal(result.ok, true, JSON.stringify(result));
	assert.equal(result.calls.length, 7);
	assert.deepEqual(result.calls.map(call => call.name), ["inspect_studio", "run_action", "run_action", "run_action", "run_action", "run_action", "verify_result"]);
	assert.ok(result.calls.every(call => call.ok));
	assert.deepEqual(result.value, { placed: ["pillar-0", "pillar-1", "pillar-2", "pillar-3", "pillar-4"], visualStatus: "attached", carriesImage: false });
	assert.deepEqual(result.output, ["placed 5 at revision 41"]);
	assert.ok(!JSON.stringify(result).includes("dataUrl"), "no dataUrl anywhere in the script result");
	assert.ok(!raw.includes("data:image/"), "no image bytes anywhere in the SSE stream");
	assert.ok(!JSON.stringify(modelCalls.at(-1).messages).includes("data:image/"), "no image bytes reach the model");
	const placed = objects.read().slice(preTurn.objects.length);
	assert.equal(placed.length, 5);
	assert.ok(placed.every(object => Math.abs(Math.hypot(object.x, object.z) - 3) < 0.01), "positions were computed on a 3 m circle");
	const receiptFrames = events.filter(event => event.type === "receipt");
	assert.equal(receiptFrames.length, 1, "one receipt frame for the turn");
	const turnReceipt = receiptFrames[0].receipt;
	assert.equal(turnReceipt.undo.entries, 1);
	assert.equal(app.historyEntry(false), turnReceipt.undo.historyEntryId, "the turn is exactly one history entry");
	const undone = bus.run("edit.undo", { receiptId: turnReceipt.receiptId }, { origin: "agent", commandId: crypto.randomUUID(), host: identity, expectedRevision: revision.current });
	assert.equal(undone.status, "undone", JSON.stringify(undone));
	assert.deepEqual({ objects: objects.read(), entry: app.historyEntry(false) }, preTurn, "one edit.undo restores the pre-turn document");
	console.log("PASS one script call runs 7 commands: one tool.start/done pair, calls[7], no image bytes, one history entry");
}

// --- (c) a script that throws after 3 edits rolls the whole turn back ---
{
	const preTurn = { objects: objects.read(), entry: app.historyEntry(false) };
	const { events } = await scriptTurn(`
		for (let i = 0; i < 3; i++) await tools.run_action({ action: "object.add", args: { object: { id: "crate-" + i, x: i, y: 0, z: 0 } } });
		throw new Error("ran out of room");
	`);
	const dones = events.filter(event => event.type === "tool.done");
	assert.equal(dones.length, 1);
	const result = dones[0].result;
	assert.equal(result.ok, false, JSON.stringify(result));
	assert.equal(result.error.kind, "script");
	assert.match(result.error.message, /ran out of room/);
	assert.equal(result.calls.length, 3, "calls[] says how far the script got");
	assert.ok(result.calls.every(call => call.ok && call.name === "run_action"));
	assert.equal(result.rollback?.status, "rolled_back", JSON.stringify(result));
	assert.equal(typeof result.rollback.receiptId, "string");
	assert.deepEqual(commands.filter(command => String(command.action).startsWith("agent.turn.")).map(command => command.action), ["agent.turn.begin", "agent.turn.cancel", "agent.turn.begin", "agent.turn.finish"]);
	assert.deepEqual({ objects: objects.read(), entry: app.historyEntry(false) }, preTurn, "the turn transaction rolled back to the pre-turn document");
	assert.equal(events.filter(event => event.type === "receipt").length, 0, "a rolled-back turn authors nothing");
	console.log("PASS a script that throws after 3 edits rolls the turn back and reports calls[3]");
}

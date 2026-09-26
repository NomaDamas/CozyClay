import assert from "node:assert/strict";
import { createFirstEditTracker, createSemanticState } from "../src/semantic-edit.js";
import { createSceneObject } from "../src/scene-objects.js";
import { createSceneHistoryStore } from "../src/scene-history.js";
import { dispatchLiveFrame } from "../src/live-control.js";
import { startExportAttempt, startMotionRequest } from "../src/analytics.js";
import { readFileSync } from "node:fs";
import { requestKeyframePack, KEYFRAME_PACK_RESULT } from "../src/workflow/keyframe-pack-request.js";

// Same authored setter/store for user callbacks and both programmatic callers.
// These are shared-boundary fixtures, not a claim that Agent exposes new tools.
for (const first of ["user", "agent", "mcp"]) {
	const events = [];
	const track = (event, props) => events.push({ event, props });
	const observe = createFirstEditTracker(track);
	let objects = [];
	const store = createSceneHistoryStore(objects, {
		onObjects(next) { objects = next; },
		onCommit(a, b) { observe("craft", "objects", a, b); },
	});
	const object = createSceneObject("cube", []);
	const mutate = () => store.applyAtomic(() => [object]);
	const handlers = { place_object: mutate };
	const callers = {
		user: mutate,
		agent: () => dispatchLiveFrame(JSON.stringify({ type: "cmd", id: "local-agent", name: "place_object", args: {} }), handlers),
		mcp: () => dispatchLiveFrame(JSON.stringify({ type: "cmd", id: "local-mcp", name: "place_object", args: {} }), handlers),
	};
	// Given one successful scene edit, When the other adapters echo its value,
	// Then one mount-scoped semantic edit survives all three arrival orders.
	await callers[first]();
	for (const channel of ["user", "agent", "mcp"]) await callers[channel]();
	assert.equal(objects.length, 1);
	assert.deepEqual(events, [{ event: "craft:first_edit", props: { edit_kind: "object_insert", definition_version: 1 } }]);

	// Prompt authoring alone never creates generation demand.
	const prompts = createSemanticState([], () => {}, (domain, a, b) => observe("craft", domain, a, b), "promptClips");
	prompts.edit([{ id: "private", text: "private", startFrame: 0, endFrame: 24 }]);
	assert.equal(events.filter(({ event }) => event.startsWith("motion:")).length, 0);
	const motion = startMotionRequest({ surface: first === "mcp" ? "mcp" : "timeline", input_mode: "prompt" }, { capture: track, now: () => 0 });
	motion.preflight({ ok: true, backend: "local_kimodo" }); motion.start(); motion.succeed(); motion.apply();
	// The same lifecycle's duplicate completion/application callbacks are echoes,
	// whereas another explicit request correctly owns another fresh ID.
	for (const channel of ["user", "agent", "mcp"]) { motion.succeed(); motion.apply(); }
	assert.equal(events.filter(({ event }) => event === "motion:generate_requested").length, 1);
	assert.equal(events.filter(({ event }) => event === "motion:job_succeeded").length, 1);
	assert.equal(events.filter(({ event }) => event === "motion:result_applied").length, 1);
}

// Execute the actual embed export callback. Workflow owns the one top-level
// attempt; the iframe pipeline does not count its internal pack/video again.
const source = readFileSync(new URL("../src/App.jsx", import.meta.url), "utf8");
const start = source.indexOf("const exportPack = async") + "const exportPack = ".length;
const end = source.indexOf("\n\t\t};", start) + "\n\t\t}".length;
assert.ok(start > 0 && end > start);
for (const first of ["user", "agent", "mcp"]) {
	const events = [];
	const track = (event, props) => events.push({ event, props });
	const attempts = (metadata) => startExportAttempt(metadata, { capture: track, now: () => 0 });
	const listeners = new Set();
	const parent = {
		postMessage(message) {
			assert.equal(message.type, KEYFRAME_PACK_RESULT);
			for (const listener of [...listeners]) listener({ source: iframe, data: message });
		},
	};
	const liveStateRef = { current: {
		shots: [{}], shotIndexForPack: () => 0,
		buildShotKeyframePack: async () => ({ name: "private.zip", bytes: new Uint8Array([1, 2]), entries: [] }),
	} };
	const exportPack = new Function("startExportAttempt", "liveStateRef", "window", `return (${source.slice(start, end)});`)(attempts, liveStateRef, { parent });
	const iframe = { postMessage(message) { void exportPack(message.shotId, message.surface === "workflow"); } };
	const owner = attempts({ surface: "workflow", export_kind: "keyframe_pack", format: "zip" });
	await requestKeyframePack(iframe, {
		surface: "workflow", timeoutMs: 0,
		addListener: (_name, listener) => listeners.add(listener),
		removeListener: (_name, listener) => listeners.delete(listener),
	});
	owner.succeed(); owner.succeed();
	assert.deepEqual(events.map(({ event }) => event), ["export:attempt_started", "export:attempt_succeeded"], first);
}
console.log("PASS user-first/agent-first/MCP-first shared edit and motion echoes; real embed export ownership");

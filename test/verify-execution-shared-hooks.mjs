import assert from "node:assert/strict";
import { createHistoryReceipts, startUserEdits, telemetrySeam } from "../src/command-bus-telemetry.js";
import { createAppContext } from "../src/app-context.js";
import { startExportAttempt } from "../src/export-attempt.js";
import { readFileSync } from "node:fs";
import { requestKeyframePack, KEYFRAME_PACK_RESULT } from "../src/workflow/keyframe-pack-request.js";

// The user's, the agent's and an MCP client's receipts for the same edit reach one
// bus-receipt path. Only the user's own committed receipt is an edit, once per mount.
for (const first of ["user", "agent", "mcp"]) {
	const events = [];
	const restore = telemetrySeam({ track: (event, props) => events.push({ event, props }) });
	try {
		startUserEdits("craft");
		const receipts = createHistoryReceipts({});
		let n = 0;
		const place = (origin) => receipts.remember({ ok: true, authored: true, receiptId: `r-${++n}` }, { id: "object.add", origin });
		const callers = { user: () => place("ui"), agent: () => place("agent"), mcp: () => place("mcp") };
		// Given one successful scene edit, When the other adapters echo it,
		// Then one mount-scoped first edit survives all three arrival orders.
		callers[first]();
		for (const channel of ["user", "agent", "mcp"]) callers[channel]();
		assert.deepEqual(events.filter(({ event }) => event.endsWith(":first_edit")), [{ event: "craft:first_edit", props: { edit_kind: "object_insert", definition_version: 2 } }], first);

		// Prompt authoring alone never creates generation demand.
		receipts.remember({ ok: true, authored: true, receiptId: `r-${++n}` }, { id: "motion.set", origin: "ui", args: { prompt: "private" } });
		assert.equal(events.filter(({ event }) => event.startsWith("motion:")).length, 0);
	} finally { restore(); }
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
	const exportPack = new Function("startExportAttempt", "appContext", "window", `return (${source.slice(start, end)});`)(attempts, createAppContext({ state: liveStateRef }), { parent });
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

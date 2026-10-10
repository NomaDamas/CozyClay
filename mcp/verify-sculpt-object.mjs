#!/usr/bin/env node
/** sculpt_object (#730): a recipe in, a clay prop out — in memory without an editor, admitted as object.sculpt with one. */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import { mcpToolCategory } from "../src/execution-telemetry.js";
import { createToolHandlers, setLiveHub } from "./tool-handlers.mjs";

const turtle = JSON.parse(readFileSync(new URL("../test/fixtures/sculpt-nerd-turtle.json", import.meta.url), "utf8"));
const pillar = { parts: [{ id: "body", shape: "cylinder", size: [0.4, 1.2, 0.4], position: [0, 0.6, 0] }] };

assert.equal(mcpToolCategory("sculpt_object"), "scene_write");
const tools = createToolHandlers({});
const sculpt = tools.find((tool) => tool.name === "sculpt_object");
assert.ok(sculpt, "sculpt_object is registered");
assert.equal(sculpt.live, true);
assert.equal(sculpt.annotations.openWorldHint, false, "a recipe never reaches outside the scene");
assert.match(sculpt.description, /^Unlike place_object and import_mesh, sculpt_object /);
const describe = tools.find((tool) => tool.name === "describe_scene");

/* ------------------------------------------------ memory-only MCP ---- */

setLiveHub(null);
const made = await sculpt.handler({ recipe: turtle, name: "Nerd turtle", x: 1, z: -1, facing: 20 });
assert.equal(made.isError, undefined, made.content[0].text);
assert.match(made.content[0].text, /^Sculpted Nerd turtle as sculpt: [\d.]+ x [\d.]+ m, 0\.\d+ m tall\./);
assert.match((await describe.handler({})).content[0].text, /sculpt {2}Nerd turtle {2}at x 1, y 0, z -1 {2}yaw 20deg/);

const refused = await sculpt.handler({ recipe: { parts: [{ id: "head", shape: "blob", size: [0.4, 40, 0.4] }] } });
assert.equal(refused.isError, true);
assert.match(refused.content[0].text, /^Recipe refused at parts\[head\]\.size\[1\]/);

const resculpt = await sculpt.handler({ id: "sculpt", recipe: pillar });
assert.equal(resculpt.isError, undefined, resculpt.content[0].text);
assert.match(resculpt.content[0].text, /^Re-sculpted Nerd turtle as sculpt: 0\.4 x 0\.4 m, 1\.2 m tall\./);
assert.match((await describe.handler({})).content[0].text, /sculpt {2}Nerd turtle {2}at x 1, y 0, z -1/, "re-sculpt keeps the transform");

const notSculpt = await sculpt.handler({ id: "ghost", recipe: pillar });
assert.match(notSculpt.content[0].text, /No object "ghost"/);
const orphan = await sculpt.handler({ recipe: pillar, parent: "ghost" });
assert.match(orphan.content[0].text, /No object "ghost" to attach to/);
const child = await sculpt.handler({ recipe: pillar, parent: "sculpt" });
assert.match(child.content[0].text, /as sculpt-2: .* under sculpt\./);

/* ---------------------------------------------------- live editor ---- */

const commands = [];
const host = { workspaceId: "workspace", documentEpoch: "document", sceneId: "scene", sceneEpoch: "epoch" };
let revision = 0;
setLiveHub({
	connected: true,
	command: async (name, args) => {
		commands.push({ name, args });
		if (name === "inspect_studio") return { context: { host, revision: { scene: revision } }, actions: [{ id: "object.sculpt" }] };
		assert.equal(name, "run_action", `unexpected live command ${name}`);
		assert.equal(args.args.action, "object.sculpt");
		const before = revision++;
		return { ok: true, status: "applied", kind: "mutation", action: "object.sculpt", commandId: args.commandId, receiptId: `receipt-${revision}`,
			host, authored: true, revision: { before, after: revision }, affectedIds: ["sculpt"], delta: [], checks: {}, warnings: [],
			undo: { historyEntryId: `history-${revision}`, entries: 1, canUndoDirect: true }, summary: "Sculpted Sculpt (sculpt): 1 parts." };
	},
});
const live = await sculpt.handler({ recipe: pillar, x: 2, facing: 15, parent: "chair" });
assert.equal(live.isError, undefined, live.content[0].text);
const run = commands.find((entry) => entry.name === "run_action");
assert.ok(run, "the live path admits a command");
assert.deepEqual(run.args.args.args, { recipe: pillar, placement: { x: 2, rot: 15 }, parent: "chair" }, "the recipe goes to the editor untouched; it validates there");

setLiveHub(null);
console.log("PASS verify-sculpt-object (MCP): memory create/refuse/re-sculpt/parent, live admission as object.sculpt");

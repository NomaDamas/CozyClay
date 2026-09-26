#!/usr/bin/env node
import assert from "node:assert/strict";
import { createAgentTools } from "../bin/agent/agent-tools.mjs";
import { createStudioTools } from "../bin/agent/studio-tools.mjs";
import { STUDIO_TOOL_FAMILIES, STUDIO_TOOL_SCHEMAS } from "../src/studio-agent-protocol.js";
import { toAgentTools } from "../bin/agent/pi-tools.mjs";

const liveHub = {
	command: async () => ({ ok: true, receiptId: "receipt-1" }),
};
const studioTools = createStudioTools({ liveHub, workspaceHandle: "workspace-1", session: { admission: null } });
const workflowTools = createAgentTools({
	liveHub,
	handlers: [
		{ name: "describe_scene", description: "Describe the scene.", handler: async () => ({ scene: "fixture" }) },
		{ name: "describe_shot", description: "Describe the shot.", handler: async () => ({ shot: "fixture" }) },
	],
	session: { signal: new AbortController().signal, images: new Map(), codex: {}, workspaceHandle: null, workflowHandle: null },
	emit: () => {},
});
const studioAdapterInputs = studioTools.map((tool) => ({ ...tool, handler: async () => ({ ok: true }) }));
const allTools = toAgentTools([...studioAdapterInputs, ...workflowTools]);
assert.equal(studioTools.map((tool) => tool.name).join(","), STUDIO_TOOL_FAMILIES.join(","));
assert.ok(allTools.length >= 17);
assert.ok(allTools.every((tool) => typeof tool.execute === "function" && tool.parameters));
assert.equal(allTools.find((tool) => tool.name === "inspect_studio").label, "Read the scene");

const imageTool = toAgentTools([{
	name: "verify_result",
	description: "Verify a result.",
	parameters: STUDIO_TOOL_SCHEMAS.verify_result,
	handler: async () => ({ ok: true, dataUrl: "data:image/png;base64,AAAA", imageId: "x", width: 2, height: 3, prompt: "fixture" }),
}])[0];
const imageResult = await imageTool.execute("call-image", { checks: ["framing"] });
assert.equal(imageResult.content.filter((part) => part.type === "image").length, 1);
assert.equal(imageResult.content[1].type, "image");
assert.equal(imageResult.content[1].mimeType, "image/png");
assert.equal(imageResult.content[1].data, "AAAA");
assert.equal(Object.hasOwn(imageResult.details, "dataUrl"), false);
assert.equal(Object.hasOwn(imageResult.details, "image"), false, "details.image must not exist: structuredClone drops the non-enumerable seam, so pi's harness never sees it");
assert.equal(Object.hasOwn(JSON.parse(JSON.stringify(imageResult.details)), "dataUrl"), false);

const failingTool = toAgentTools([{
	name: "patch_elements",
	description: "Patch elements.",
	parameters: STUDIO_TOOL_SCHEMAS.patch_elements,
	handler: async () => { throw Object.assign(new Error("stale target"), { code: "STALE_TARGET", receipt: { recovery: { action: "inspect", retryAllowed: false } } }); },
}])[0];
await assert.rejects(failingTool.execute("call-failure", { ops: [{ target: { kind: "stage" }, set: {} }] }), /STALE_TARGET: stale target \(inspect, do not retry\)/);

let called = false;
const validationTool = toAgentTools([{
	name: "patch_elements",
	description: "Patch elements.",
	parameters: STUDIO_TOOL_SCHEMAS.patch_elements,
	handler: async () => { called = true; return { ok: true }; },
}])[0];
await assert.rejects(validationTool.execute("call-invalid", { ops: [] }), /minItems/);
assert.equal(called, false);

console.log(`tools=${allTools.length}`);

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { executeLocalWorkflowGraph } from "../src/workflow/local-workflow.js";

const graph = {
	version: 1,
	nodes: [
		{ id: "text-1", type: "text", position: { x: 0, y: 0 }, data: { prompt: "hero enters" } },
		{ id: "concat-1", type: "concat", position: { x: 0, y: 0 }, data: { template: "{prompt} at dusk" } },
		{ id: "scene-1", type: "scene", position: { x: 0, y: 0 }, data: { sceneId: "scene-a", assetInputs: ["asset-1"] } },
	],
	edges: [
		{ id: "e1", source: "text-1", target: "concat-1" },
		{ id: "e2", source: "concat-1", target: "scene-1", targetHandle: "asset" },
	],
};

const result = executeLocalWorkflowGraph(graph, { runId: "run-1" });
assert.deepEqual(result.order, ["text-1", "concat-1", "scene-1"]);
assert.equal(result.nodes.find((node) => node.id === "concat-1").data.outputs[0].value, "hero enters at dusk");
assert.equal(result.nodes.find((node) => node.id === "text-1").data.outputHistory[0].id, "run-1");
assert.equal(result.nodes.find((node) => node.id === "scene-1").data.status, "complete");
const builderSource = readFileSync(new URL("../src/workflow/WorkflowBuilder.jsx", import.meta.url), "utf8");
assert.equal(/fetch\s*\(/i.test(builderSource), false, "WorkflowBuilder does not call a remote service");
console.log("local workflow checks PASS");

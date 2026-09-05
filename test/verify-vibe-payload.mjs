import assert from "node:assert/strict";
import { applyVibeRunUpdates, extractVibeRunUpdates, remoteWorkflowNodeCount, summarizeVibeRunStatus, toVibeNodeRunRequest, toVibeWorkflowPayload, workflowCost } from "../src/workflow/vibe-payload.js";

const graph = {
	version: 1,
	nodes: [
		{ id: "text-1", type: "text", position: { x: 1, y: 2 }, data: { prompt: "a quiet alley", model: "text-passthrough" } },
		{ id: "image-1", type: "image", position: { x: 3, y: 4 }, data: { model: "image-passthrough" } },
		{ id: "scene-1", type: "scene", position: { x: 5, y: 6 }, data: { sceneName: "Stage" } },
	],
	edges: [
		{ id: "e1", source: "text-1", target: "image-1", sourceHandle: "output", targetHandle: "input" },
		{ id: "e2", source: "image-1", target: "scene-1", sourceHandle: "output", targetHandle: "asset" },
	],
};

const payload = toVibeWorkflowPayload(graph, { name: "Shot 01" });
assert.equal(payload.workflow_id, null);
assert.equal(payload.name, "Shot 01");
assert.equal(payload.data.nodes.length, 2);
assert.deepEqual(payload.data.nodes[1], {
	id: "image-1",
	category: "image",
	model: "image-passthrough",
	input_params: {},
	output_params: { resultUrl: null, outputs: [] },
	params: { image_url: "{{ text-1.outputs[0].value }}" },
	position: { x: 3, y: 4 },
	inputs: ["text-1"],
});
assert.equal(payload.edges.length, 1);
assert.equal(remoteWorkflowNodeCount(graph), 2);
assert.equal(workflowCost({ ...graph, nodes: graph.nodes.map((node, index) => ({ ...node, data: { ...node.data, cost: index === 0 ? 0.125 : index === 1 ? "0.375" : 0 } })) }), 0.5);
assert.deepEqual(toVibeNodeRunRequest({ ...graph, nodes: graph.nodes.map((node) => node.id === "image-1" ? { ...node, data: { ...node.data, cost: 0.25 } } : node) }, "image-1", "run-1"), {
	run_id: "run-1",
	model: "image-passthrough",
	params: { image_url: "{{ text-1.outputs[0].value }}" },
	cost: 0.25,
	node_id: "image-1",
});
assert.equal(toVibeNodeRunRequest(graph, "scene-1", "run-1"), null);
assert.deepEqual(summarizeVibeRunStatus({ nodes: { "text-1": [{ status: "succeeded" }], "image-1": [{ status: "completed" }] } }), { terminal: true, ok: true, status: "complete" });
assert.deepEqual(summarizeVibeRunStatus({ nodes: { "image-1": [{ status: "failed" }] } }), { terminal: true, ok: false, status: "error" });
assert.deepEqual(summarizeVibeRunStatus({ nodes: { "image-1": [{ status: "processing" }] } }), { terminal: false, ok: false, status: "running" });
assert.deepEqual(summarizeVibeRunStatus({ runData: { nodes: { "image-1": [{ status: "succeeded" }] } } }), { terminal: true, ok: true, status: "complete" });
const runStatus = { runData: { nodes: { "text-1": [{ id: "run-1", status: "succeeded", result: { outputs: [{ value: "a quiet alley" }] } }] } } };
assert.deepEqual(extractVibeRunUpdates(runStatus)["text-1"], {
	status: "succeeded",
	isLoading: false,
	outputs: [{ value: "a quiet alley" }],
	resultUrl: "a quiet alley",
	errorMsg: null,
	outputHistory: [],
	latestRun: { id: "run-1", status: "succeeded", result: { outputs: [{ value: "a quiet alley" }] } },
});
const withHistory = applyVibeRunUpdates({ version: 1, nodes: [{ id: "text-1", type: "text", position: { x: 0, y: 0 }, data: { outputHistory: [{ id: "old" }] } }], edges: [] }, runStatus);
assert.equal(withHistory.nodes[0].data.outputHistory.length, 2);
assert.equal(withHistory.nodes[0].data.outputHistory[1].id, "run-1");
const resultKeyStatus = { nodes: { "text-1": [{ status: "succeeded", result: { id: "result-1", outputs: [{ value: "same" }] } }] } };
const resultKeyGraph = applyVibeRunUpdates(withHistory, resultKeyStatus);
assert.equal(resultKeyGraph.nodes[0].data.outputHistory.at(-1).result.id, "result-1");
const processingGraph = applyVibeRunUpdates(resultKeyGraph, { nodes: { "text-1": [{ status: "processing" }] } });
assert.equal(processingGraph.nodes[0].data.resultUrl, "same");
assert.equal(processingGraph.nodes[0].data.isLoading, true);
const uploaded = toVibeWorkflowPayload({ version: 1, nodes: [{ id: "upload-1", type: "upload", position: { x: 0, y: 0 }, data: { fileName: "take.mp4", fileUrl: "blob:take" } }], edges: [] });
assert.equal(uploaded.data.nodes[0].category, "video");
assert.equal(uploaded.data.nodes[0].model, "video-passthrough");
assert.equal(uploaded.data.nodes[0].params.video_url, "blob:take");
const api = toVibeWorkflowPayload({ version: 1, nodes: [{ id: "api-1", type: "api", position: { x: 0, y: 0 }, data: { model: "foo/bar", params: '{"strength":0.7}' } }], edges: [] });
assert.deepEqual(api.data.nodes[0].input_params.params, { strength: 0.7 });
console.log("Vibe workflow payload adapter checks passed");

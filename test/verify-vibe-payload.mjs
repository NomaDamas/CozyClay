import assert from "node:assert/strict";
import { remoteWorkflowNodeCount, summarizeVibeRunStatus, toVibeWorkflowPayload } from "../src/workflow/vibe-payload.js";

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
assert.deepEqual(summarizeVibeRunStatus({ nodes: { "text-1": [{ status: "succeeded" }], "image-1": [{ status: "completed" }] } }), { terminal: true, ok: true, status: "complete" });
assert.deepEqual(summarizeVibeRunStatus({ nodes: { "image-1": [{ status: "failed" }] } }), { terminal: true, ok: false, status: "error" });
assert.deepEqual(summarizeVibeRunStatus({ nodes: { "image-1": [{ status: "processing" }] } }), { terminal: false, ok: false, status: "running" });
const uploaded = toVibeWorkflowPayload({ version: 1, nodes: [{ id: "upload-1", type: "upload", position: { x: 0, y: 0 }, data: { fileName: "take.mp4", fileUrl: "blob:take" } }], edges: [] });
assert.equal(uploaded.data.nodes[0].category, "video");
assert.equal(uploaded.data.nodes[0].model, "video-passthrough");
assert.equal(uploaded.data.nodes[0].params.video_url, "blob:take");
const api = toVibeWorkflowPayload({ version: 1, nodes: [{ id: "api-1", type: "api", position: { x: 0, y: 0 }, data: { model: "foo/bar", params: '{"strength":0.7}' } }], edges: [] });
assert.deepEqual(api.data.nodes[0].input_params.params, { strength: 0.7 });
console.log("Vibe workflow payload adapter checks passed");

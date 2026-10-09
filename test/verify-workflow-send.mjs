#!/usr/bin/env node
// Send a storyboard panel to the Workflow canvas (#645): the helper appends
// one Upload node (the panel PNG as a data URL) and one Video generation node
// wired upload -> video, below what is already on the canvas, and leaves every
// existing node and edge exactly as it was.
import assert from "node:assert/strict";
import { normalizeWorkflowGraph, WORKFLOW_STORAGE_KEY } from "../src/project.js";
import { appendPanelToWorkflowGraph, bytesToDataUrl, panelVideoPrompt, sendPanelToWorkflow } from "../src/workflow-send.js";

const DATA_URL = "data:image/png;base64,iVBORw0KGgo=";
const META = { focalMm: 35, fovDeg: 54, aspect: "16:9", size: { width: 1280, height: 720 }, cast: [{ name: "Mina" }], frameRange: { start: 0, end: 47 }, fps: 24, shotTitle: "Panel 1" };
const prompt = panelVideoPrompt(META, "  She turns toward the door.  ");

const draft = normalizeWorkflowGraph({
	version: 1,
	nodes: [
		{ id: "text-1", type: "text", position: { x: 80, y: 100 }, data: { label: "Text", prompt: "keep me" } },
		{ id: "image-1", type: "image", position: { x: 380, y: 340 }, data: { label: "Image", model: "image-passthrough" } },
	],
	edges: [{ id: "e-text-1-image-1", source: "text-1", target: "image-1", sourceHandle: "output", targetHandle: "input" }],
});
const before = structuredClone(draft);

// prompt = the video shot prompt, then the trimmed caption
assert.ok(prompt.startsWith("SHOT: Panel 1"));
assert.ok(prompt.includes("MOTION:"), "video target adds the MOTION line");
assert.ok(prompt.endsWith("\nCAPTION: She turns toward the door."));
assert.equal(panelVideoPrompt(META, "   "), panelVideoPrompt(META, ""), "an empty caption adds nothing");
console.log("PASS panelVideoPrompt = buildShotPrompt(video) + caption");

const next = appendPanelToWorkflowGraph(draft, { dataUrl: DATA_URL, fileName: "panel-1.png", prompt, now: 1000 });
assert.deepEqual(draft, before, "the input draft is not mutated");
assert.deepEqual(next.nodes.slice(0, 2), before.nodes, "existing nodes are deepEqual");
assert.deepEqual(next.edges.slice(0, 1), before.edges, "existing edges are deepEqual");
assert.equal(next.nodes.length, 4);
assert.equal(next.edges.length, 2);
const [upload, video] = next.nodes.slice(2);
assert.equal(upload.type, "upload");
assert.equal(upload.data.image_url, DATA_URL);
assert.equal(upload.data.fileUrl, DATA_URL);
assert.deepEqual(upload.data.outputs, [{ value: DATA_URL }]);
assert.equal(upload.data.fileName, "panel-1.png");
assert.equal(video.type, "video");
assert.equal(video.data.model, "video-generation");
assert.equal(video.data.prompt, prompt);
assert.equal(video.data.formValues.prompt, prompt);
assert.equal(video.data.formValues.provider, "comfy");
assert.deepEqual(next.edges[1], { id: `e-${upload.id}-${video.id}`, source: upload.id, target: video.id, sourceHandle: "output", targetHandle: "input" });
assert.deepEqual(normalizeWorkflowGraph(next), next, "normalizeWorkflowGraph accepts the result unchanged");
console.log("PASS one upload node + one connected video node, existing nodes and edges deepEqual");

// positioned below every existing node, left-aligned with the canvas
assert.deepEqual(upload.position, { x: 80, y: 340 + 280 });
assert.deepEqual(video.position, { x: 80 + 380, y: 340 + 280 });
assert.deepEqual(appendPanelToWorkflowGraph(null, { dataUrl: DATA_URL }).nodes.map((node) => node.type), ["upload", "video"], "an empty draft still works");
console.log("PASS new nodes sit below the existing ones");

// ids never collide with existing nodes
const crowded = normalizeWorkflowGraph({ nodes: [{ id: "upload-1000", type: "upload", position: { x: 0, y: 0 }, data: {} }, { id: "video-1000", type: "video", position: { x: 0, y: 0 }, data: {} }] });
const twice = appendPanelToWorkflowGraph(crowded, { dataUrl: DATA_URL, now: 1000 });
assert.equal(new Set(twice.nodes.map((node) => node.id)).size, 4);
assert.throws(() => appendPanelToWorkflowGraph(draft, { dataUrl: "not an image" }), /panel image/);
console.log("PASS ids are unique and a non-image is refused");

// the stored draft: appended, event fired, a second send stacks below the first
const store = new Map([[WORKFLOW_STORAGE_KEY, JSON.stringify(draft)]]);
const storage = { getItem: (key) => store.get(key) ?? null, setItem: (key, value) => store.set(key, value) };
const first = sendPanelToWorkflow({ dataUrl: DATA_URL, prompt }, storage, 2000);
assert.deepEqual(JSON.parse(store.get(WORKFLOW_STORAGE_KEY)), first);
const second = sendPanelToWorkflow({ dataUrl: DATA_URL, prompt }, storage, 3000);
assert.equal(second.nodes.length, 6);
assert.deepEqual(second.nodes.slice(0, 4), first.nodes, "the earlier send is untouched by the later one");
assert.ok(second.nodes[4].position.y > first.nodes[2].position.y);
console.log("PASS the stored draft keeps earlier sends and stacks new ones");

// a failing store throws (so the Board can toast) and leaves the draft as it was
const full = { getItem: (key) => store.get(key) ?? null, setItem: () => { throw new DOMException("quota", "QuotaExceededError"); } };
const kept = store.get(WORKFLOW_STORAGE_KEY);
assert.throws(() => sendPanelToWorkflow({ dataUrl: DATA_URL, prompt }, full), /quota/);
assert.equal(store.get(WORKFLOW_STORAGE_KEY), kept);
assert.throws(() => sendPanelToWorkflow({ dataUrl: DATA_URL, prompt }, null), /storage is unavailable/);
console.log("PASS a storage failure surfaces and leaves the draft alone");

assert.equal(bytesToDataUrl(new Uint8Array([137, 80, 78, 71]), "image/png"), "data:image/png;base64,iVBORw==");
console.log("PASS bytesToDataUrl");

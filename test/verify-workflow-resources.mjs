#!/usr/bin/env node
/**
 * verify-workflow-resources (#230): generated pictures in workflow node data
 * are found in every slot they can land in, pulled out into content-addressed
 * asset records on save, and put back on open so the graph is deep-equal to
 * what the canvas had. Video, blob: and http(s) outputs are classified, never
 * moved.
 */
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { crc32, deflateSync } from "node:zlib";
import {
	WORKFLOW_OUTPUT_FIELDS,
	imageDimensions,
	internWorkflowOutputs,
	isAssetRef,
	outputKind,
	resolveWorkflowOutputs,
	workflowOutputRefs,
} from "../src/workflow/workflow-resources.js";
import { assetIdForBytes, normalizeAsset } from "../src/scene-assets.js";
import { normalizeWorkflowGraph } from "../src/project.js";

/* ------------------------------------------------------------ fixtures --- */

function pngChunk(type, payload) {
	const length = Buffer.alloc(4);
	length.writeUInt32BE(payload.length);
	const body = Buffer.concat([Buffer.from(type, "latin1"), payload]);
	const crc = Buffer.alloc(4);
	crc.writeUInt32BE(crc32(body));
	return Buffer.concat([length, body, crc]);
}

/** A real RGBA PNG of the given size; `seed` changes the pixels so two calls
 * produce two different pictures with two different ids. */
function pngBytes(width, height, seed) {
	const header = Buffer.alloc(13);
	header.writeUInt32BE(width, 0);
	header.writeUInt32BE(height, 4);
	header[8] = 8; header[9] = 6; header[10] = 0; header[11] = 0; header[12] = 0;
	const raw = Buffer.alloc((width * 4 + 1) * height);
	for (let y = 0; y < height; y += 1) for (let x = 0; x < width; x += 1) raw.set([(x * 37 + seed) & 255, (y * 91 + seed) & 255, seed & 255, 255], y * (width * 4 + 1) + 1 + x * 4);
	return new Uint8Array(Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), pngChunk("IHDR", header), pngChunk("IDAT", deflateSync(raw)), pngChunk("IEND", Buffer.alloc(0))]));
}

const dataUrl = (type, bytes) => `data:${type};base64,${Buffer.from(bytes).toString("base64")}`;
const expectedId = (bytes) => `img-${createHash("sha256").update(bytes).digest("hex").slice(0, 32)}`;

const frame = pngBytes(4, 3, 1);
const takeOne = pngBytes(2, 2, 2);
const takeTwo = pngBytes(2, 2, 3);
const frameUrl = dataUrl("image/png", frame);
const takeOneUrl = dataUrl("image/png", takeOne);
const takeTwoUrl = dataUrl("image/png", takeTwo);
const videoUrl = "data:video/mp4;base64,AAAAIGZ0eXBpc29tAAACAGlzb21pc28yYXZjMW1wNDE=";
const blobUrl = "blob:http://127.0.0.1:5180/1c1d1b5e-6a45-4f0a-9d4e-0f0c1a2b3c4d";
const httpUrl = "https://example.com/renders/take-3.mp4";

const graph = normalizeWorkflowGraph({
	version: 1,
	nodes: [
		{ id: "scene-1", type: "cozyScene", position: { x: 0, y: 0 }, data: { sceneName: "Alley", preview: "render", lastOutput: { renderUrl: frameUrl, sceneUrl: "/app/", jobId: null, meta: { fps: 24 }, references: [] }, outputs: [{ value: frameUrl }], resultUrl: frameUrl } },
		{ id: "image-1", type: "image", position: { x: 300, y: 0 }, data: { model: "image-generation", versions: [{ dataUrl: takeOneUrl, prompt: "take 1", referenceDataUrl: null, frameDataUrl: frameUrl, at: 1 }, { dataUrl: takeTwoUrl, prompt: "take 2", referenceDataUrl: null, frameDataUrl: frameUrl, at: 2 }], versionIndex: 1, outputs: [{ value: takeTwoUrl }], resultUrl: takeTwoUrl, pinReferences: false } },
		{ id: "video-1", type: "video", position: { x: 600, y: 0 }, data: { provider: "fal", videoUrl, resultUrl: videoUrl, outputs: [{ value: videoUrl }], preservation: null } },
		{ id: "video-2", type: "video", position: { x: 600, y: 200 }, data: { provider: "comfy", videoUrl: httpUrl, resultUrl: httpUrl, outputs: [{ value: httpUrl }] } },
		{ id: "upload-1", type: "upload", position: { x: 0, y: 300 }, data: { fileName: "ref.png", mimeType: "image/png", fileUrl: takeOneUrl, image_url: takeOneUrl, localPreview: true, outputs: [{ value: takeOneUrl }] } },
		{ id: "upload-2", type: "upload", position: { x: 0, y: 500 }, data: { fileName: "clip.mp4", mimeType: "video/mp4", fileUrl: blobUrl, outputs: [{ value: blobUrl }] } },
		{ id: "prompt-1", type: "shotPrompt", position: { x: 300, y: 300 }, data: { prompt: "wide two-shot", outputs: [{ value: "wide two-shot" }], resultUrl: null } },
		{ id: "empty-1", type: "default", position: { x: 0, y: 0 }, data: {} },
	],
	edges: [{ id: "e1", source: "scene-1", target: "image-1", sourceHandle: "render", targetHandle: "input" }],
});
const snapshot = structuredClone(graph);

/* -------------------------------------------------------- outputKind ----- */

assert.equal(outputKind(frameUrl), "data-url");
assert.equal(outputKind(videoUrl), "data-url");
assert.equal(outputKind(httpUrl), "http");
assert.equal(outputKind("http://127.0.0.1:5180/app/"), "http");
assert.equal(outputKind(blobUrl), "blob");
assert.equal(outputKind("/app/"), "other");
assert.equal(outputKind("wide two-shot"), "other");
assert.equal(outputKind({ assetRef: "img-0123456789abcdef0123456789abcdef" }), "asset-ref");
assert.equal(outputKind({ assetRef: "not-an-id" }), null, "a ref must carry a real asset id");
assert.equal(outputKind(null), null);
assert.equal(outputKind(""), null);
assert.equal(outputKind(42), null);
assert.ok(isAssetRef({ assetRef: "img-0123456789abcdef0123456789abcdef" }));
assert.equal(isAssetRef("img-0123456789abcdef0123456789abcdef"), false, "a bare id string is not a ref");
console.log("PASS workflow resources: output values classify as data-url / http / blob / asset-ref / other");

/* ------------------------------------------------- workflowOutputRefs ---- */

assert.deepEqual(WORKFLOW_OUTPUT_FIELDS, ["resultUrl", "videoUrl", "lastOutput.renderUrl", "lastOutput.sceneUrl", "versions[].dataUrl", "fileUrl", "outputs[].value"]);
const refs = workflowOutputRefs(graph);
const refKey = (ref) => `${ref.nodeId}:${ref.field}`;
const byKey = new Map(refs.map((ref) => [refKey(ref), ref]));
assert.deepEqual(byKey.get("scene-1:resultUrl"), { nodeId: "scene-1", field: "resultUrl", value: frameUrl, kind: "data-url" });
assert.deepEqual(byKey.get("scene-1:lastOutput.renderUrl"), { nodeId: "scene-1", field: "lastOutput.renderUrl", value: frameUrl, kind: "data-url" });
assert.deepEqual(byKey.get("scene-1:lastOutput.sceneUrl"), { nodeId: "scene-1", field: "lastOutput.sceneUrl", value: "/app/", kind: "other" });
assert.deepEqual(byKey.get("scene-1:outputs[0].value"), { nodeId: "scene-1", field: "outputs[0].value", value: frameUrl, kind: "data-url" });
assert.deepEqual(byKey.get("image-1:versions[0].dataUrl"), { nodeId: "image-1", field: "versions[0].dataUrl", value: takeOneUrl, kind: "data-url" });
assert.deepEqual(byKey.get("image-1:versions[1].dataUrl"), { nodeId: "image-1", field: "versions[1].dataUrl", value: takeTwoUrl, kind: "data-url" });
assert.deepEqual(byKey.get("video-1:videoUrl"), { nodeId: "video-1", field: "videoUrl", value: videoUrl, kind: "data-url" });
assert.deepEqual(byKey.get("video-2:videoUrl"), { nodeId: "video-2", field: "videoUrl", value: httpUrl, kind: "http" });
assert.deepEqual(byKey.get("video-2:outputs[0].value"), { nodeId: "video-2", field: "outputs[0].value", value: httpUrl, kind: "http" });
assert.deepEqual(byKey.get("upload-1:fileUrl"), { nodeId: "upload-1", field: "fileUrl", value: takeOneUrl, kind: "data-url" });
assert.deepEqual(byKey.get("upload-2:fileUrl"), { nodeId: "upload-2", field: "fileUrl", value: blobUrl, kind: "blob" });
assert.deepEqual(byKey.get("prompt-1:outputs[0].value"), { nodeId: "prompt-1", field: "outputs[0].value", value: "wide two-shot", kind: "other" });
assert.equal(byKey.has("prompt-1:resultUrl"), false, "a null slot is not a ref");
assert.equal(byKey.has("image-1:versions[0].frameDataUrl"), false, "a version's inputs are not outputs");
assert.equal(byKey.has("upload-1:image_url"), false, "upload input aliases are not outputs");
assert.equal(refs.filter((ref) => ref.nodeId === "empty-1").length, 0);
assert.equal(refs.length, 19, `every populated output slot is listed once (got ${refs.map(refKey).join(", ")})`);
assert.deepEqual(workflowOutputRefs(null), []);
assert.deepEqual(workflowOutputRefs({ nodes: [{ id: "x" }, null, { id: "y", data: { resultUrl: httpUrl } }] }), [{ nodeId: "y", field: "resultUrl", value: httpUrl, kind: "http" }]);
console.log("PASS workflow resources: refs come from resultUrl, videoUrl, lastOutput, versions[], fileUrl and outputs[]");

/* ----------------------------------------------------- imageDimensions --- */

assert.deepEqual(imageDimensions(frame), { width: 4, height: 3 });
assert.deepEqual(imageDimensions(Buffer.from("GIF89a" + "\x10\x00\x20\x00", "latin1")), { width: 16, height: 32 });
assert.deepEqual(imageDimensions(Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x04, 0x4a, 0x46, 0xff, 0xc0, 0x00, 0x0b, 0x08]), Buffer.from([0x01, 0x00, 0x02, 0x80, 0x03])])), { width: 640, height: 256 });
assert.deepEqual(imageDimensions(Buffer.concat([Buffer.from("RIFF\0\0\0\0WEBPVP8X", "latin1"), Buffer.from([0x0a, 0, 0, 0, 0x10, 0, 0, 0, 0x7f, 0x01, 0x00, 0x3f, 0x01, 0x00])])), { width: 384, height: 320 });
assert.equal(imageDimensions(new Uint8Array([1, 2, 3])), null, "an unknown header has no size");
assert.equal(imageDimensions(Buffer.from("GIF89a")), null, "a truncated header has no size");
console.log("PASS workflow resources: pixel size read from PNG / GIF / JPEG / WebP headers");

/* ----------------------------------------------- internWorkflowOutputs --- */

const interned = await internWorkflowOutputs(graph, { assetIdForBytes: (bytes) => assetIdForBytes(bytes, globalThis.crypto.subtle) });
assert.deepEqual(graph, snapshot, "interning does not mutate the graph it is given");
const ids = { frame: expectedId(frame), takeOne: expectedId(takeOne), takeTwo: expectedId(takeTwo) };
assert.deepEqual(interned.assets.map((asset) => asset.id).sort(), Object.values(ids).sort(), "one record per distinct picture, even when a picture sits in several slots");
for (const asset of interned.assets) {
	assert.equal(asset.type, "image/png");
	assert.equal(asset.role, "workflow-output");
	assert.ok(asset.bytes instanceof ArrayBuffer, "asset bytes are an ArrayBuffer, the shape the asset store and createProjectDocument take");
	assert.equal(await assetIdForBytes(asset.bytes, globalThis.crypto.subtle), asset.id, "the record's bytes hash to its id");
	assert.ok(normalizeAsset(asset), "the record passes the asset store's own validation");
}
assert.deepEqual(interned.assets.find((asset) => asset.id === ids.frame), { id: ids.frame, type: "image/png", width: 4, height: 3, name: "", role: "workflow-output", bytes: interned.assets.find((asset) => asset.id === ids.frame).bytes });

const node = (g, id) => g.nodes.find((entry) => entry.id === id);
const scene = node(interned.graph, "scene-1");
assert.deepEqual(scene.data.resultUrl, { assetRef: ids.frame });
assert.deepEqual(scene.data.lastOutput.renderUrl, { assetRef: ids.frame });
assert.deepEqual(scene.data.outputs, [{ value: { assetRef: ids.frame } }]);
assert.equal(scene.data.lastOutput.sceneUrl, "/app/", "a plain path is left alone");
assert.deepEqual(scene.data.lastOutput.meta, { fps: 24 }, "the rest of lastOutput is untouched");
assert.equal(scene.data.sceneName, "Alley");
const image = node(interned.graph, "image-1");
assert.deepEqual(image.data.versions.map((version) => version.dataUrl), [{ assetRef: ids.takeOne }, { assetRef: ids.takeTwo }]);
assert.equal(image.data.versions[0].frameDataUrl, frameUrl, "a version's input frame is not an output and stays inline");
assert.equal(image.data.versions[0].prompt, "take 1");
assert.deepEqual(image.data.resultUrl, { assetRef: ids.takeTwo });
assert.equal(image.data.versionIndex, 1);
const video = node(interned.graph, "video-1");
assert.equal(video.data.videoUrl, videoUrl, "a video data URL is not an image asset and stays inline");
assert.equal(video.data.resultUrl, videoUrl);
assert.deepEqual(video.data.outputs, [{ value: videoUrl }]);
assert.equal(node(interned.graph, "video-2").data.videoUrl, httpUrl, "http(s) stays external");
assert.equal(node(interned.graph, "video-2").data.resultUrl, httpUrl);
const upload = node(interned.graph, "upload-1");
assert.deepEqual(upload.data.fileUrl, { assetRef: ids.takeOne });
assert.deepEqual(upload.data.outputs, [{ value: { assetRef: ids.takeOne } }]);
assert.equal(upload.data.image_url, takeOneUrl, "upload input aliases are not in the output field list and stay inline");
assert.equal(node(interned.graph, "upload-2").data.fileUrl, blobUrl, "blob: stays inline");
assert.deepEqual(node(interned.graph, "prompt-1").data, snapshot.nodes.find((entry) => entry.id === "prompt-1").data, "a text-only node is untouched");
assert.equal(node(interned.graph, "prompt-1"), node(graph, "prompt-1"), "an untouched node keeps its identity");
assert.equal(node(interned.graph, "empty-1"), node(graph, "empty-1"));
assert.deepEqual(interned.graph.edges, graph.edges);
assert.equal(interned.graph.version, graph.version);
const internedRefs = workflowOutputRefs(interned.graph);
assert.equal(internedRefs.filter((ref) => ref.kind === "asset-ref").length, 9, "every image slot now reads as an asset-ref");
assert.equal(internedRefs.filter((ref) => ref.kind === "data-url").length, 3, "the video data URL slots still read as data-url");
assert.equal(internedRefs.filter((ref) => ref.kind === "http").length, 3);
assert.equal(internedRefs.filter((ref) => ref.kind === "blob").length, 2);

// Pictures the asset store would refuse are left in place rather than
// embedded as records the reader would drop.
const odd = { version: 1, edges: [], nodes: [
	{ id: "svg", position: { x: 0, y: 0 }, data: { resultUrl: "data:image/svg+xml;base64,PHN2Zy8+" } },
	{ id: "nohdr", position: { x: 0, y: 0 }, data: { resultUrl: "data:image/png;base64,AAAA" } },
	{ id: "utf8", position: { x: 0, y: 0 }, data: { resultUrl: "data:image/png,%89PNG" } },
] };
const oddInterned = await internWorkflowOutputs(odd, { assetIdForBytes: (bytes) => assetIdForBytes(bytes, globalThis.crypto.subtle) });
assert.deepEqual(oddInterned.assets, []);
assert.deepEqual(oddInterned.graph, odd, "unsupported or unreadable image data URLs stay exactly as they were");
assert.deepEqual(await internWorkflowOutputs(null, {}), { graph: null, assets: [] });
console.log("PASS workflow resources: data:image/* outputs intern to { assetRef } + content-addressed asset records");

/* ---------------------------------------------- resolveWorkflowOutputs --- */

const assetsById = new Map(interned.assets.map((asset) => [asset.id, asset]));
const resolved = resolveWorkflowOutputs(interned.graph, assetsById);
assert.deepEqual(resolved, snapshot, "intern -> resolve round-trips to the original graph");
assert.deepEqual(resolveWorkflowOutputs(interned.graph, interned.assets), snapshot, "an asset array works as the lookup too");
assert.deepEqual(resolveWorkflowOutputs(interned.graph, Object.fromEntries(assetsById)), snapshot, "a plain id -> record object works as the lookup too");
assert.deepEqual(normalizeWorkflowGraph(JSON.parse(JSON.stringify(interned.graph))), interned.graph, "the interned graph survives the project file's JSON normalization");
assert.deepEqual(resolveWorkflowOutputs(normalizeWorkflowGraph(JSON.parse(JSON.stringify(interned.graph))), assetsById), snapshot, "…and still resolves after it");

// Typed-array bytes (what the asset store hands back after a structured clone
// in some browsers) resolve the same way.
const viewAssets = new Map([...assetsById].map(([id, asset]) => [id, { ...asset, bytes: new Uint8Array(asset.bytes) }]));
assert.deepEqual(resolveWorkflowOutputs(interned.graph, viewAssets), snapshot);

// A ref whose asset is gone is kept as a ref: the manifest reports it as
// missing instead of the slot silently emptying.
const partial = new Map(assetsById);
partial.delete(ids.takeOne);
const partiallyResolved = resolveWorkflowOutputs(interned.graph, partial);
assert.deepEqual(node(partiallyResolved, "upload-1").data.fileUrl, { assetRef: ids.takeOne });
assert.deepEqual(node(partiallyResolved, "image-1").data.versions[0].dataUrl, { assetRef: ids.takeOne });
assert.equal(node(partiallyResolved, "image-1").data.versions[1].dataUrl, takeTwoUrl, "the sibling version with a present asset still resolves");
assert.equal(node(partiallyResolved, "scene-1").data.resultUrl, frameUrl);
assert.deepEqual(workflowOutputRefs(partiallyResolved).filter((ref) => ref.kind === "asset-ref").map((ref) => `${ref.nodeId}:${ref.field}`), ["image-1:versions[0].dataUrl", "upload-1:fileUrl", "upload-1:outputs[0].value"]);
assert.deepEqual(resolveWorkflowOutputs(interned.graph, new Map()), interned.graph, "no assets at all leaves every ref in place");
assert.equal(resolveWorkflowOutputs(null, assetsById), null);
assert.equal(resolveWorkflowOutputs(graph, assetsById).nodes.every((entry, index) => entry === graph.nodes[index]), true, "a graph without refs keeps every node's identity");
console.log("PASS workflow resources: assetRef -> data URL restores the runtime node shape; absent assets stay as refs");

console.log("verify-workflow-resources: ok");

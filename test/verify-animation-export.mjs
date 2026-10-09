#!/usr/bin/env node
import assert from "node:assert/strict";
import { webcrypto } from "node:crypto";
import { buildAnimationProjectFromStoryboard, createProjectDocument, readProjectDocument } from "../src/project.js";
import { createSceneDocument } from "../src/scenes.js";
import { createShotAuthoringDocument } from "../src/shot-authoring.js";
import { assetIdForBytes } from "../src/scene-assets.js";

globalThis.crypto ??= webcrypto;

const imageBytes = new Uint8Array([1, 2, 3, 4]);
const imageId = await assetIdForBytes(imageBytes);
const sceneDocument = createSceneDocument("Storyboard");
sceneDocument.scenes[0].objects = [{ id: "poster", renderer: "cutout", assetId: imageId, sourceAssetId: imageId, matteAssetId: "" }];
sceneDocument.scenes[0].shotDocument = createShotAuthoringDocument({
	frameCount: 144,
	shots: [
		{ id: "still-1", name: "Panel 1", startFrame: 0, endFrame: 47, kind: "still", caption: "One", cast: { hero: { x: 1, z: 2, rot: 3 } }, stylizedAssetId: imageId, cameraKeys: [{ id: "key-1", frame: 0, framing: { pos: { x: 1, y: 2, z: 3 }, yaw: 4, pitch: 5, fovDeg: 35 } }] },
		{ id: "still-2", name: "Panel 2", startFrame: 48, endFrame: 95, kind: "still", caption: "Two", cast: { hero: { x: 4, z: 5, rot: 6 } }, cameraKeys: [] },
		{ id: "still-3", name: "Panel 3", startFrame: 96, endFrame: 143, kind: "still", caption: "Three", cast: { hero: { x: 7, z: 8, rot: 9 } }, cameraKeys: [] },
	],
});
const source = createProjectDocument({
	scenesDocument: sceneDocument,
	workspaceLayout: { hierarchyWidth: 320 },
	customPoses: [{ id: "pose", bones: { hips: [0, 0, 0] } }],
	name: "Boards",
	previsMode: "storyboard",
	assets: [{ id: imageId, type: "image/png", width: 1, height: 1, name: "poster.png", bytes: imageBytes }],
	workflow: { version: 1, nodes: [], edges: [] },
});
const read = readProjectDocument(JSON.stringify(source));
assert.equal(read.ok, true);
const before = structuredClone(read.project);
const animation = buildAnimationProjectFromStoryboard(read.project);
assert.equal(animation.version, 5);
assert.equal(animation.previsMode, "animation");
assert.equal(animation.name, "Boards - Animation");
assert.equal(animation.scenes.scenes[0].shotDocument.frameCount, 144);
assert.deepEqual(animation.scenes.scenes[0].shotDocument.shots.map(({ kind, startFrame, endFrame, cameraKeys, caption, cast, stylizedAssetId }) => ({ kind, startFrame, endFrame, cameraKeys, caption, cast, stylizedAssetId })), [
		{ kind: "clip", startFrame: 0, endFrame: 47, cameraKeys: source.scenes.scenes[0].shotDocument.shots[0].cameraKeys, caption: "One", cast: { hero: { x: 1, z: 2, rot: 3 } }, stylizedAssetId: imageId },
		{ kind: "clip", startFrame: 48, endFrame: 95, cameraKeys: [], caption: "Two", cast: { hero: { x: 4, z: 5, rot: 6 } }, stylizedAssetId: null },
		{ kind: "clip", startFrame: 96, endFrame: 143, cameraKeys: [], caption: "Three", cast: { hero: { x: 7, z: 8, rot: 9 } }, stylizedAssetId: null },
	]);
assert.deepEqual(animation.resources.assets.map((asset) => asset.id), [imageId]);
assert.deepEqual(read.project, before, "export does not mutate the source project");
assert.equal(readProjectDocument(JSON.stringify(animation)).ok, true, "the exported envelope reads back successfully");
console.log("animation export transform PASS: 3 stills became 3 clips with preserved ranges, cameras, cast and assets");
console.log("animation export transform PASS: source project remained unchanged and the v5 envelope round-tripped");

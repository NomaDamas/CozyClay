#!/usr/bin/env node
import assert from "node:assert/strict";
import {
	COZY_SCENE_INPUTS,
	COZY_SCENE_OUTPUTS,
	COZY_SCENE_NODE_TYPE,
	applyCozyScenePatch,
	applyCozySceneRunResult,
	normalizeCozySceneData,
	toCozySceneRunRequest,
} from "../src/workflow/cozy-scene-node.js";

const defaults = normalizeCozySceneData({ sceneName: 42, frame: "bad", controls: { camera: { yaw: "35" } } });
assert.equal(defaults.type, COZY_SCENE_NODE_TYPE);
assert.equal(defaults.sceneName, "CozyClay Scene");
assert.equal(defaults.frame, 0);
assert.equal(defaults.controls.camera.yaw, 35);
assert.deepEqual(COZY_SCENE_INPUTS.map(({ id }) => id), ["asset", "motion"]);
assert.deepEqual(COZY_SCENE_OUTPUTS.map(({ id }) => id), ["render", "scene"]);

const changed = applyCozyScenePatch(defaults, { frame: 14, controls: { playing: true, camera: { pitch: -8 } }, assetInputs: ["asset-1"] });
assert.equal(changed.frame, 14);
assert.equal(changed.controls.playing, true);
assert.equal(changed.controls.camera.yaw, 35, "nested camera fields remain controlled when only pitch changes");
assert.equal(changed.controls.camera.pitch, -8);
assert.deepEqual(changed.assetInputs, ["asset-1"]);
assert.equal(defaults.frame, 0, "patching never mutates the original envelope");

const request = toCozySceneRunRequest({ id: "node-1", data: { ...changed, sceneId: "scene-1", motionInputs: ["motion-1"] } }, { projectId: "project-1" });
assert.equal(request.type, COZY_SCENE_NODE_TYPE);
assert.equal(request.nodeId, "node-1");
assert.deepEqual(request.inputs, { asset: ["asset-1"], motion: ["motion-1"] });
assert.deepEqual(request.context, { projectId: "project-1" });

const complete = applyCozySceneRunResult(changed, { jobId: "job-1", renderUrl: "/render.mp4", sceneUrl: "/scene.json" });
assert.equal(complete.status, "complete");
assert.equal(complete.preview, "render");
assert.equal(complete.lastOutput.jobId, "job-1");
const failed = applyCozySceneRunResult(changed, { error: "bridge unavailable" });
assert.equal(failed.status, "error");
assert.equal(failed.statusMessage, "bridge unavailable");

console.log("cozy scene node adapter checks passed");

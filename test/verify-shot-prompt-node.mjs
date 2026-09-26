import assert from "node:assert/strict";
import { shotPromptFromInputs, shotPromptNodeData, shotPromptTarget } from "../src/workflow/shot-prompt-node.js";

const meta = {
	focalMm: 35,
	fovDeg: 38,
	aspect: "16:9",
	size: { width: 1920, height: 1080 },
	cameraMove: { dolly: true, crane: false, rail: false },
	keyLight: { intensity: 1, azimuthDeg: 45, elevationDeg: 30 },
	cast: [{ name: "Alpha", model: "y-bot" }],
	frameRange: { start: 0, end: 71 },
	fps: 24,
	shotTitle: "Shot 1",
};

const defaults = shotPromptNodeData();
assert.deepEqual(defaults, { label: "Shot Prompt", target: "image", referenceOwnsCamera: true, prompt: "" });
console.log("PASS shot prompt node defaults: image target, reference owns camera, empty prompt");

const noMeta = shotPromptFromInputs({ meta: null, target: "image" });
assert.equal(noMeta.prompt, "");
assert.equal(noMeta.error, "Connect a Scene node first.");
assert.equal(shotPromptFromInputs({}).error, "Connect a Scene node first.", "a missing input object reads as no Scene");
console.log("PASS a Shot Prompt node without Scene metadata reports the connect error");

const image = shotPromptFromInputs({ meta, target: "image", referenceOwnsCamera: true });
assert.equal(image.error, null);
const lines = image.prompt.split("\n");
assert.equal(lines[0], "SHOT: Shot 1, 3s, 16:9");
assert.equal(lines[1], "LENS: 35mm, long shot", "a 38deg field of view reads as a long shot");
assert.match(image.prompt, /^CAMERA: follow the reference clip's framing/m, "the reference owns the camera by default");
assert.match(image.prompt, /^CAST: Alpha$/m);
assert.match(image.prompt, /^LOOK: clay previs, neutral look$/m, "no intent falls back to the neutral look");
assert.ok(!image.prompt.includes("MOTION:"), "an image target carries no motion line");
console.log("PASS an image Shot Prompt lists shot, lens, camera, light, cast and look");

const video = shotPromptFromInputs({ meta, intent: "  moody rim light, dusk  ", target: "video", referenceOwnsCamera: false });
assert.match(video.prompt, /^LOOK: moody rim light, dusk$/m, "the Text intent is trimmed into the LOOK line");
assert.match(video.prompt, /^CAMERA: smooth dolly move$/m, "unchecking reference-owns-camera describes the scene's own move");
assert.match(video.prompt, /^MOTION: motion and blocking come from the reference/m, "a video target adds the motion line");
console.log("PASS a video Shot Prompt uses the intent, the scene camera move, and a motion line");

assert.equal(shotPromptFromInputs({ meta, intent: "   ", target: "image" }).prompt, image.prompt, "a whitespace-only intent changes nothing");
assert.equal(shotPromptFromInputs({ meta, target: "sculpture" }).prompt, image.prompt, "an unknown target falls back to image");
assert.equal(shotPromptTarget("video"), "video");
assert.equal(shotPromptTarget(undefined), "image");
console.log("PASS blank intents and unknown targets fall back to the image prompt");

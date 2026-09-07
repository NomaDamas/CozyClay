import assert from "node:assert/strict";
import { shotCaptureMeta } from "../src/shot-meta.js";
import { VIDEO_MODEL_PRESETS, presetById, checkShotAgainstPreset } from "../src/model-presets.js";

const shot = {
	name: "Shot 2",
	startFrame: 48,
	endFrame: 95,
	targetModel: "seedance-2.5",
	camera: {
		mode: "rail",
		dollyTiming: { cuts: [] },
		craneHeight: { points: [{ t: 0, height: 1.6 }, { t: 1, height: 2.4 }] },
		railFollow: { mode: "range", startFrame: 0, endFrame: 47 },
	},
};
const stage = { keyLight: { x: 2, y: 3, z: 1, intensity: 1.1 } };
const cast = [{ name: "Ari", model: "y-bot-tpose" }, { name: "Bo", model: "x-bot-tpose" }];

const meta = shotCaptureMeta({
	shot,
	shotIndex: 1,
	stage,
	cast,
	fps: 24,
	aspectKey: "16:9",
	size: { width: 1920, height: 1080 },
	frame: 60,
	lens: { focalMm: 35, fovDeg: 42 },
});

assert.equal(meta.aspect, "16:9");
assert.deepEqual(meta.size, { width: 1920, height: 1080 });
assert.deepEqual(meta.frameRange, { start: 48, end: 95 });
assert.equal(meta.fps, 24);
assert.equal(meta.frame, 60);
assert.equal(meta.shotIndex, 1);
assert.equal(meta.shotTitle, "Shot 2");
assert.equal(meta.targetModel, "seedance-2.5");
assert.deepEqual(meta.keyLight, stage.keyLight);
assert.deepEqual(meta.cast, [{ name: "Ari", model: "y-bot-tpose" }, { name: "Bo", model: "x-bot-tpose" }]);
// The lens lives on the stage, not in the camera block: the capture still
// reports it, because a still without a focal length cannot be re-shot.
assert.equal(meta.focalMm, 35);
assert.equal(meta.fovDeg, 42);
console.log("PASS shot meta: lens, aspect, size, cut range, cast and target model");

// cameraMove is derived from what the block actually carries.
assert.deepEqual(meta.cameraMove, { dolly: true, crane: true, rail: true });
const still = shotCaptureMeta({ shot: { ...shot, camera: { mode: "keys" } }, aspectKey: "9:16" });
assert.deepEqual(still.cameraMove, { dolly: false, crane: false, rail: false }, "a keys-only block moves on none of the three axes");
const railedOff = shotCaptureMeta({ shot: { ...shot, camera: { ...shot.camera, railFollow: { mode: "off" }, dollyTiming: null, craneHeight: null } } });
assert.deepEqual(railedOff.cameraMove, { dolly: false, crane: false, rail: false }, "a switched-off rail is not a dolly move");
console.log("PASS shot meta: cameraMove flags follow dollyTiming, craneHeight and railFollow");

// A capture taken with nothing authored still describes itself honestly:
// nulls, never undefined or a thrown read of a missing shot.
const empty = shotCaptureMeta();
assert.deepEqual(empty, {
	focalMm: null,
	fovDeg: null,
	aspect: null,
	size: { width: null, height: null },
	cameraMove: { dolly: false, crane: false, rail: false },
	keyLight: null,
	cast: [],
	frameRange: { start: null, end: null },
	fps: null,
	shotIndex: null,
	shotTitle: null,
	targetModel: null,
	frame: null,
});
const named = shotCaptureMeta({ cast: [{ subject: "a young woman in a red coat", model: "y-bot-tpose" }] });
assert.deepEqual(named.cast, [{ name: "a young woman in a red coat", model: "y-bot-tpose" }], "the studio's subject line is the cast member's name");
const untargeted = shotCaptureMeta({ shot: { name: "Shot 1", startFrame: 0, endFrame: 47 }, cast: null, fps: Number.NaN });
assert.equal(untargeted.targetModel, null, "a shot with no target model reports null, not undefined");
assert.equal(untargeted.fps, null, "a non-finite fps falls back to null");
assert.deepEqual(untargeted.cast, [], "a missing cast is an empty cast");
console.log("PASS shot meta: missing shot, cast and fps fall back to nulls");

// The target model is the id of a shipped preset, so the timeline can measure
// the cut against it without a second lookup table.
assert.ok(presetById(meta.targetModel), "the stored target model names a shipped preset");
assert.deepEqual(
	VIDEO_MODEL_PRESETS.map((preset) => preset.id).includes(meta.targetModel),
	true,
);
const frames = meta.frameRange.end - meta.frameRange.start + 1;
const check = checkShotAgainstPreset({ frames, fps: meta.fps, aspect: meta.aspect }, presetById(meta.targetModel));
assert.equal(check.ok, false, "48 frames @ 24 fps is 2s, off Seedance's 5s/10s grid");
assert.match(check.warnings.join("; "), /too long/);
console.log("PASS shot meta: targetModel feeds checkShotAgainstPreset directly");

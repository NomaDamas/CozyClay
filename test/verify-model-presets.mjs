import assert from "node:assert/strict";
import { VIDEO_MODEL_PRESETS, presetById, checkShotAgainstPreset } from "../src/model-presets.js";

const KNOWN_ASPECTS = new Set(["16:9", "9:16", "21:9", "1:1", "4:3", "12:7"]);

// Inventory shape: every preset carries the full descriptor.
assert.ok(Array.isArray(VIDEO_MODEL_PRESETS) && VIDEO_MODEL_PRESETS.length >= 4, "presets ship as a non-empty array");
for (const preset of VIDEO_MODEL_PRESETS) {
	assert.ok(preset.id && preset.name && preset.vendor, `${preset.id}: identity fields present`);
	assert.ok(Number.isFinite(preset.fps) && preset.fps > 0, `${preset.id}: fps is a positive number`);
	assert.ok(Array.isArray(preset.aspects) && preset.aspects.length > 0, `${preset.id}: aspects listed`);
	for (const aspect of preset.aspects) assert.ok(KNOWN_ASPECTS.has(aspect), `${preset.id}: ${aspect} comes from the known aspect set`);
	assert.ok(Number.isInteger(preset.maxWidth) && preset.maxWidth > 0, `${preset.id}: maxWidth is a positive integer`);
	assert.ok(Number.isInteger(preset.maxHeight) && preset.maxHeight > 0, `${preset.id}: maxHeight is a positive integer`);
	assert.ok(typeof preset.notes === "string" && preset.notes.length > 0, `${preset.id}: notes is a non-empty string`);
	assert.ok(Array.isArray(preset.durationsSeconds), `${preset.id}: durationsSeconds is an array`);
}
console.log("PASS every preset carries id/name/vendor, fps, aspects, max size, notes and durationsSeconds");

// The four required models match the spec'd capability grids.
const seedance = presetById("seedance-2.5");
assert.deepEqual(seedance.durationsSeconds, [], "seedance-2.5 takes any reference-video length, not fixed slots");
assert.equal(seedance.minSeconds, 2, "seedance-2.5 reference clips are at least 2s");
assert.equal(seedance.maxSeconds, 30, "seedance-2.5 reference clips cap at 30s");
assert.equal(seedance.fps, 24, "seedance-2.5 runs at 24 fps");
assert.deepEqual(seedance.aspects, ["16:9", "9:16", "21:9", "1:1"], "seedance-2.5 aspect set");

const kling = presetById("kling-2");
assert.deepEqual(kling.durationsSeconds, [5, 10], "kling-2 clips are 5s or 10s");
assert.equal(kling.fps, 30, "kling-2 runs at 30 fps");
assert.deepEqual(kling.aspects, ["16:9", "9:16", "1:1"], "kling-2 aspect set");
assert.ok(kling.notes.includes("Motion Control"), "kling-2 notes carry the Motion Control caveat");

const veo = presetById("veo-3");
assert.deepEqual(veo.durationsSeconds, [8], "veo-3 clips are fixed 8s");
assert.equal(veo.fps, 24, "veo-3 runs at 24 fps");
assert.deepEqual(veo.aspects, ["16:9", "9:16"], "veo-3 aspect set");

const minimax = presetById("minimax-h3-selfhosted");
assert.deepEqual(minimax.durationsSeconds, [], "minimax-h3 self-hosted has a continuous grid, not slots");
assert.equal(minimax.maxSeconds, 10, "minimax-h3 self-hosted caps clips at 10s");
assert.equal(minimax.fps, 24, "minimax-h3 self-hosted runs at 24 fps");
for (const aspect of ["12:7", "16:9", "9:16"]) assert.ok(minimax.aspects.includes(aspect), `minimax supports ${aspect}`);

assert.equal(presetById("does-not-exist"), undefined, "presetById misses cleanly");
console.log("PASS seedance-2.5, kling-2, veo-3 and minimax-h3-selfhosted match their capability grids");

// Shot validation: a clean shot passes with no warnings.
assert.deepEqual(checkShotAgainstPreset({ frames: 240, fps: 24, aspect: "16:9" }, seedance), { ok: true, warnings: [] }, "10s 16:9 seedance shot fits");
assert.deepEqual(checkShotAgainstPreset({ frames: 72, fps: 24, aspect: "9:16" }, seedance), { ok: true, warnings: [] }, "3s 9:16 seedance shot fits");
console.log("PASS shots inside a preset's grid validate clean");

// Duration violations warn with the exact "too long" text.
const tooLong = checkShotAgainstPreset({ frames: 744, fps: 24, aspect: "16:9" }, seedance);
assert.equal(tooLong.ok, false, "a 31s seedance shot is rejected");
assert.equal(tooLong.warnings.length, 1, "one warning per violated limit");
assert.equal(tooLong.warnings[0], "too long: 31s exceeds the 30s limit for Seedance 2.5", "duration warning names the 30s cap");

const tooShort = checkShotAgainstPreset({ frames: 24, fps: 24, aspect: "16:9" }, seedance);
assert.equal(tooShort.ok, false, "a 1s seedance shot is rejected");
assert.equal(tooShort.warnings.length, 1, "one warning per violated limit");
assert.equal(tooShort.warnings[0], "too short: 1s is under the 2s minimum for Seedance 2.5", "short clip warning names the 2s minimum");

const veoLong = checkShotAgainstPreset({ frames: 240, fps: 24, aspect: "16:9" }, veo);
assert.equal(veoLong.warnings.length, 1, "10s exceeds veo's fixed 8s clip");
assert.match(veoLong.warnings[0], /^too long: 10s is not an allowed clip length for Veo 3/, "veo duration warning text");

const klingFps = checkShotAgainstPreset({ frames: 300, fps: 30, aspect: "16:9" }, kling);
assert.deepEqual(klingFps, { ok: true, warnings: [] }, "kling durations are judged at the shot's own 30 fps");
console.log("PASS seedance reference-video limits and veo duration warnings");

// Continuous-grid presets only reject clips past maxSeconds.
const minimaxAtLimit = checkShotAgainstPreset({ frames: 240, fps: 24, aspect: "12:7" }, minimax);
assert.deepEqual(minimaxAtLimit, { ok: true, warnings: [] }, "exactly 10s fits minimax's limit");
const minimaxShort = checkShotAgainstPreset({ frames: 60, fps: 24, aspect: "16:9" }, minimax);
assert.deepEqual(minimaxShort, { ok: true, warnings: [] }, "2.5s is fine on a continuous grid");
const minimaxOver = checkShotAgainstPreset({ frames: 264, fps: 24, aspect: "9:16" }, minimax);
assert.equal(minimaxOver.ok, false, "11s breaks the 10s cap");
assert.equal(minimaxOver.warnings.length, 1, "only the duration limit is violated");
assert.equal(minimaxOver.warnings[0], "too long: 11s exceeds the 10s limit for MiniMax H3 (self-hosted)", "continuous-grid warning text");
console.log("PASS minimax self-hosted accepts any length up to 10s and warns past it");

// Aspect violations warn, and can stack with the duration warning.
const badAspect = checkShotAgainstPreset({ frames: 120, fps: 24, aspect: "4:3" }, seedance);
assert.equal(badAspect.ok, false, "4:3 is not a seedance aspect");
assert.equal(badAspect.warnings.length, 1, "aspect alone yields one warning");
assert.equal(badAspect.warnings[0], "aspect 4:3 is not supported by Seedance 2.5 (allowed: 16:9, 9:16, 21:9, 1:1)", "aspect warning text");

const both = checkShotAgainstPreset({ frames: 744, fps: 24, aspect: "4:3" }, seedance);
assert.equal(both.warnings.length, 2, "one warning per violated limit, both together");
assert.match(both.warnings[0], /^too long:/, "duration warning comes first");
assert.match(both.warnings[1], /^aspect 4:3 is not supported/, "aspect warning comes second");

const kling21x9 = checkShotAgainstPreset({ frames: 150, fps: 30, aspect: "21:9" }, kling);
assert.equal(kling21x9.warnings.length, 1, "kling rejects 21:9");
assert.match(kling21x9.warnings[0], /^aspect 21:9 is not supported by Kling 2\.0/, "kling aspect warning text");

const minimax21x9 = checkShotAgainstPreset({ frames: 120, fps: 24, aspect: "21:9" }, minimax);
assert.equal(minimax21x9.warnings.length, 1, "minimax rejects 21:9");
assert.match(minimax21x9.warnings[0], /^aspect 21:9 is not supported/, "minimax aspect warning text");
console.log("PASS unsupported aspects produce the exact aspect warning and stack with duration warnings");

console.log("PASS model presets: inventory, grids and checkShotAgainstPreset verified");

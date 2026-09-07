import assert from "node:assert/strict";
import { buildShotPrompt, shotSizeFromFov } from "../src/shot-prompt.js";

const CAMERA_SENTENCE = "follow the reference clip's framing and camera motion exactly";
const MOTION_SENTENCE = "motion and blocking come from the reference; keep timing";

const meta = {
	focalMm: 35,
	fovDeg: 55,
	aspect: "16:9",
	size: { width: 1280, height: 720 },
	cameraMove: { dolly: true, crane: false, rail: false },
	keyLight: { intensity: 0.9, azimuthDeg: 45, elevationDeg: 60 },
	cast: [{ name: "Momo", model: "clay-hero" }, { name: "Pixel", model: "clay-side" }],
	frameRange: { start: 0, end: 119 },
	fps: 24,
	shotTitle: "Rooftop chase",
	intent: "moody clay rooftop at dusk",
};

// Image target, default options: the reference owns the camera.
const imagePrompt = buildShotPrompt(meta, { target: "image" });
const imageLines = imagePrompt.split("\n");
assert.equal(imageLines[0], "SHOT: Rooftop chase, 5s, 16:9", "SHOT line carries title, duration and aspect");
assert.equal(imageLines[1], "LENS: 35mm, normal shot", "LENS line carries focal mm and the fov-derived shot size");
assert.equal(imageLines[2], `CAMERA: ${CAMERA_SENTENCE}`, "referenceOwned camera emits the exact follow sentence");
assert.ok(imageLines[3].startsWith("LIGHT: high front right key light, strong"), `LIGHT line reads ${imageLines[3]}`);
assert.equal(imageLines[4], "CAST: Momo, Pixel", "CAST line lists names");
assert.equal(imageLines[5], "LOOK: moody clay rooftop at dusk", "LOOK line is the user's intent verbatim");
assert.equal(imageLines.length, 6, "image prompts carry no MOTION line");
assert.equal(imagePrompt.split(CAMERA_SENTENCE).length - 1, 1, "the camera path appears only in the CAMERA line");
console.log("PASS image prompt: labelled lines, default camera ownership, no MOTION line");

// Video target adds the MOTION line and keeps the camera sentence single.
const videoPrompt = buildShotPrompt(meta, { target: "video" });
const videoLines = videoPrompt.split("\n");
assert.equal(videoLines[videoLines.length - 1], `MOTION: ${MOTION_SENTENCE}`, "video prompts end with the MOTION line");
assert.equal(videoLines.length, 7, "video prompt has one more line than image");
assert.equal(videoPrompt.split(CAMERA_SENTENCE).length - 1, 1, "the camera sentence is never repeated");
const videoLook = videoLines.find((line) => line.startsWith("LOOK:"));
assert.equal(videoLook, "LOOK: moody clay rooftop at dusk", "LOOK stays verbatim even in video prompts");
assert.ok(!/\bdolly\b|\bcrane\b|\brail\b/i.test(videoLook), "the LOOK line never repeats the camera path");
console.log("PASS video prompt adds MOTION and never repeats the camera path in LOOK");

// referenceOwnsCamera: false hands the camera description to the prompt.
const movedPrompt = buildShotPrompt(meta, { target: "video", referenceOwnsCamera: false });
const movedCamera = movedPrompt.split("\n").find((line) => line.startsWith("CAMERA:"));
assert.ok(!movedCamera.includes("follow the reference"), "the follow sentence disappears when the shot owns the camera");
assert.match(movedCamera, /dolly/i, "the dolly move is described in plain words");
assert.equal(movedPrompt.split("dolly").length - 1, 1, "the move description appears exactly once in the prompt");
assert.equal(movedPrompt.split("\n").find((line) => line.startsWith("LOOK:")), "LOOK: moody clay rooftop at dusk", "LOOK still never repeats the camera path");

const craneMeta = { ...meta, cameraMove: { dolly: false, crane: true, rail: true } };
const craneCamera = buildShotPrompt(craneMeta, { target: "image", referenceOwnsCamera: false }).split("\n").find((line) => line.startsWith("CAMERA:"));
assert.match(craneCamera, /crane/i, "crane is described in plain words");
assert.match(craneCamera, /rail/i, "rail is described in plain words");

const stillMeta = { ...meta, cameraMove: { dolly: false, crane: false, rail: false } };
const stillCamera = buildShotPrompt(stillMeta, { target: "image", referenceOwnsCamera: false }).split("\n").find((line) => line.startsWith("CAMERA:"));
assert.match(stillCamera, /locked-off/i, "no moves means a locked-off camera");
console.log("PASS referenceOwnsCamera:false swaps the CAMERA line for plain move words");

// Shot-size word is derived from fov, not from the focal length alone.
assert.equal(shotSizeFromFov(90), "wide", "90 degrees of fov reads wide");
assert.equal(shotSizeFromFov(60), "normal", "60 degrees of fov reads normal");
assert.equal(shotSizeFromFov(30), "long", "30 degrees of fov reads long");
assert.equal(shotSizeFromFov(0), "normal", "a degenerate fov falls back to normal");
const longMeta = { ...meta, focalMm: 35, fovDeg: 30 };
assert.equal(buildShotPrompt(longMeta, { target: "image" }).split("\n")[1], "LENS: 35mm, long shot", "the LENS line uses the fov-derived word");
console.log("PASS shotSizeFromFov maps fov degrees to wide/normal/long");

// Fallbacks: empty intent, no key light, empty cast, partial-second shots.
const bare = buildShotPrompt(
	{
		...meta,
		shotTitle: "",
		intent: "   ",
		keyLight: null,
		cast: [],
		frameRange: { start: 24, end: 83 },
	},
	{ target: "video" },
);
const bareLines = bare.split("\n");
assert.equal(bareLines[0], "SHOT: untitled shot, 2.5s, 16:9", "untitled shots get a placeholder and durations keep fractions");
assert.equal(bareLines[3], "LIGHT: no key light, ambient fill", "a missing key light is stated, not dropped");
assert.equal(bareLines[4], "CAST: none", "an empty cast reads as none");
assert.equal(bareLines[5], "LOOK: clay previs, neutral look", "a whitespace-only intent falls back to the neutral look");

const padded = buildShotPrompt({ ...meta, intent: "  rain-slick alley, warm sodium glow  " }, { target: "image" });
assert.equal(padded.split("\n").find((line) => line.startsWith("LOOK:")), "LOOK: rain-slick alley, warm sodium glow", "a padded intent still reads as the user's words");
console.log("PASS fallbacks: empty intent, no key light, empty cast, fractional durations");

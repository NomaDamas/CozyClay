#!/usr/bin/env node
// Shot document v5 (#626): kind, caption, per-shot cast overrides and a
// stylized asset slot, with a v4 body migrating by gaining only the defaults.
import assert from "node:assert/strict";
import {
	SHOT_AUTHORING_KEY,
	SHOT_AUTHORING_LEGACY_KEYS,
	SHOT_AUTHORING_QUARANTINE_KEY,
	SHOT_AUTHORING_VERSION,
	STILL_HOLD_DEFAULT,
	STILL_HOLD_MAX,
	createShotAuthoringDocument,
	readShotAuthoring,
	readShotAuthoringDocument,
	serializeShotAuthoring,
	shotHold,
} from "../src/shot-authoring.js";
import { assetIdFromDigest, meshIdFromDigest } from "../src/scene-assets.js";

const V5_FIELDS = ["kind", "caption", "cast", "stylizedAssetId"];
const framing = { pos: { x: 0, y: 1.6, z: 5 }, yaw: 0.25, pitch: -0.1, fovDeg: 40 };
const imageId = assetIdFromDigest("ab".repeat(32));
const meshId = meshIdFromDigest("cd".repeat(32));
const read = (shots, frameCount = 240) => readShotAuthoringDocument({ version: SHOT_AUTHORING_VERSION, frameCount, waypoints: [], shots });
const only = (shot, frameCount) => {
	const result = read([shot], frameCount);
	assert.equal(result.status, "valid");
	return result.state.shots[0];
};

// v4 -> v5: every v4 field survives byte-identical; only the defaults are added.
const v4Shots = createShotAuthoringDocument({
	frameCount: 240,
	shots: [
		{ id: "shot-a", name: "Hero", startFrame: 0, endFrame: 95, cameraKeys: [{ id: "key-a", frame: 12, framing }], targetModel: "seedance-2.5",
			camera: { mode: "rail", cameraRail: [{ x: -2, z: 1 }, { x: 3, z: 4 }], railFollow: { mode: "range", startFrame: 4, endFrame: 60 }, followCam: { distance: 4 } } },
		{ id: "shot-b", name: "Wide", startFrame: 96, endFrame: 239 },
	],
}).shots.map((shot) => Object.fromEntries(Object.entries(shot).filter(([key]) => !V5_FIELDS.includes(key))));
const v4Body = { version: 4, frameCount: 240, waypoints: [{ id: "wp-a", frame: 0, x: 1, z: 2, heading: null }], shots: v4Shots };
const migrated = readShotAuthoringDocument(JSON.parse(JSON.stringify(v4Body)));
assert.equal(migrated.status, "migrated", "a v4 body is rewritten as v5, so it reports migrated");
assert.equal(migrated.state.frameCount, 240);
assert.equal(JSON.stringify(migrated.state.waypoints), JSON.stringify(v4Body.waypoints));
assert.equal(migrated.state.shots.length, v4Shots.length);
migrated.state.shots.forEach((shot, index) => {
	const { kind, caption, cast, stylizedAssetId, ...rest } = shot;
	assert.equal(JSON.stringify(rest), JSON.stringify(v4Shots[index]), `v4 fields of ${shot.id} are byte-identical`);
	assert.deepEqual({ kind, caption, cast, stylizedAssetId }, { kind: "clip", caption: "", cast: {}, stylizedAssetId: null });
});
// The migrated body writes as v5 and then reads back as current.
const rewritten = JSON.parse(serializeShotAuthoring(migrated.state));
assert.equal(rewritten.version, 5);
assert.equal(readShotAuthoring(JSON.stringify(rewritten)).status, "valid");
assert.deepEqual(readShotAuthoring(JSON.stringify(rewritten)).state.shots, migrated.state.shots);

// Keys step with the version; a v4 body is the newest legacy body.
assert.equal(SHOT_AUTHORING_VERSION, 5);
assert.equal(SHOT_AUTHORING_KEY, "cozyclay.shot-authoring.v5");
assert.equal(SHOT_AUTHORING_QUARANTINE_KEY, "cozyclay.shot-authoring.v5.quarantine");
assert.deepEqual([...SHOT_AUTHORING_LEGACY_KEYS], ["cozyclay.shot-authoring.v4", "cozyclay.shot-authoring.v3", "cozyclay.shot-authoring.v2", "cozyclay.shot-authoring.v1"]);
assert.equal(readShotAuthoringDocument({ version: 6, shots: [] }).status, "future");

// A still holding a single frame survives with its kind.
assert.equal(STILL_HOLD_DEFAULT, 48);
assert.equal(STILL_HOLD_MAX, 240);
const still = only({ id: "shot-still", name: "Beat", startFrame: 10, endFrame: 10, kind: "still" });
assert.equal(still.kind, "still");
assert.equal(still.startFrame, 10);
assert.equal(still.endFrame, 10);
assert.equal(shotHold(still), 1);
assert.equal(shotHold({ startFrame: 0, endFrame: STILL_HOLD_DEFAULT - 1 }), STILL_HOLD_DEFAULT);
assert.equal(only({ id: "s", startFrame: 0, endFrame: 10, kind: "gif" }).kind, "clip", "an unknown kind falls back to clip");

// Cast overrides: a non-finite entry is dropped, valid siblings survive.
const pose = { id: "pose-wave", label: "Wave", bones: { hips: [0, 0, 0, 1] } };
const cast = only({
	id: "shot-cast", startFrame: 0, endFrame: 47,
	cast: {
		"char-a": { x: 1.5, z: -2, rot: 90, posture: "sit", pose, extra: "dropped" },
		"char-b": { x: Number.NaN, z: 0, rot: 0 },
		"char-c": { x: 0, z: Number.POSITIVE_INFINITY, rot: 0 },
		"char-d": { x: 0, z: 0, rot: "90" },
		"char-e": { x: -1, z: 3, rot: -45, posture: "fly", pose: "not-a-pose" },
		"": { x: 0, z: 0, rot: 0 },
		"char-f": null,
	},
}).cast;
assert.deepEqual(Object.keys(cast), ["char-a", "char-e"]);
assert.deepEqual(cast["char-a"], { x: 1.5, z: -2, rot: 90, posture: "sit", pose });
assert.notEqual(cast["char-a"].pose, pose, "the pose is a detached copy");
assert.deepEqual(cast["char-e"], { x: -1, z: 3, rot: -45 }, "unknown posture and non-object pose are omitted");
for (const posture of ["stand", "sit", "lie"]) assert.equal(only({ id: "p", startFrame: 0, endFrame: 1, cast: { a: { x: 0, z: 0, rot: 0, posture } } }).cast.a.posture, posture);
assert.deepEqual(only({ id: "c", startFrame: 0, endFrame: 1, cast: [{ x: 0, z: 0, rot: 0 }] }).cast, {}, "an array is not a cast map");
const proto = only({ id: "c", startFrame: 0, endFrame: 1, cast: JSON.parse('{"__proto__":{"x":1,"z":2,"rot":3}}') }).cast;
assert.equal(Object.getPrototypeOf(proto), Object.prototype, "a __proto__ id never rewires the map");

// Caption: trimmed, at most 500 characters.
assert.equal(only({ id: "c", startFrame: 0, endFrame: 1, caption: "x".repeat(600) }).caption.length, 500);
assert.equal(only({ id: "c", startFrame: 0, endFrame: 1, caption: "  She looks up.  " }).caption, "She looks up.");
assert.equal(only({ id: "c", startFrame: 0, endFrame: 1, caption: 42 }).caption, "");
assert.equal([...only({ id: "c", startFrame: 0, endFrame: 1, caption: "😀".repeat(600) }).caption].length, 500, "the cap counts characters, not UTF-16 units");

// Stylized asset: image asset ids only.
assert.equal(only({ id: "a", startFrame: 0, endFrame: 1, stylizedAssetId: imageId }).stylizedAssetId, imageId);
assert.equal(only({ id: "a", startFrame: 0, endFrame: 1, stylizedAssetId: meshId }).stylizedAssetId, null, "a mesh id is not an image");
assert.equal(only({ id: "a", startFrame: 0, endFrame: 1, stylizedAssetId: "image-authored" }).stylizedAssetId, null);

console.log("verify-shot-document-v5: ok");

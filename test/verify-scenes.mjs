#!/usr/bin/env node
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import {
	LEGACY_SCENE_STORAGE_KEY,
	PREVIOUS_SCENES_STORAGE_KEY,
	SCENES_QUARANTINE_KEY,
	SCENES_STORAGE_KEY,
	SCENES_VERSION,
	activeScene,
	activeSceneIndex,
	addScene,
	createScene,
	createSceneDocument,
	createSceneStage,
	duplicateScene,
	loadSceneDocumentFromStorage,
	createCharacterEntry,
	migrateStageFrames,
	readSceneDocument,
	removeScene,
	renameScene,
	serializeSceneDocument,
	takeAnchor,
} from "../src/scenes.js";

let scenes = [];
scenes = addScene(scenes);
scenes = addScene(scenes);
scenes = addScene(scenes, "Kitchen");
scenes = addScene(scenes, "Kitchen");
assert.deepEqual(scenes.map((scene) => scene.name), ["SCENE 01", "SCENE 02", "Kitchen", "Kitchen 2"]);
assert.equal(new Set(scenes.map((scene) => scene.id)).size, scenes.length);

const namedScenes = [
	createScene("Kitchen"),
];
namedScenes.push(createScene(" kitchen ", namedScenes));
namedScenes.push(createScene("Ｋｉｔｃｈｅｎ", namedScenes));
namedScenes.push(createScene("골목 & 카페 <밤> 🎬", namedScenes));
namedScenes.push(createScene("골목 & 카페 <밤> 🎬", namedScenes));
assert.deepEqual(namedScenes.map((scene) => scene.name), ["Kitchen", "kitchen 2", "Ｋｉｔｃｈｅｎ 3", "골목 & 카페 <밤> 🎬", "골목 & 카페 <밤> 🎬 2"]);

scenes[0].objects = [{ id: "chair", transform: { x: 1 } }];
scenes[0].shotDocument = { version: 99, cameraBlocks: [{ id: "sealed", keys: [1, 2] }] };
scenes[0].stage = createSceneStage({
	charA: { x: 4, z: -2, rot: 35 },
	charB: { x: 7, z: 1, rot: -90 },
	showB: true,
	shotAspect: "9:16",
	sensorId: "super35",
	poseA: { id: "hero", bones: { hips: [1, 2, 3] } },
	poseB: { id: "support", bones: { hips: [4, 5, 6] } },
});
// v2 cast envelopes fold into the characters list on normalization
assert.equal(scenes[0].stage.characters.length, 2, "showB: true restores the second actor");
assert.equal(scenes[0].stage.characters[0].x, 4);
assert.equal(scenes[0].stage.characters[0].pose.id, "hero");
assert.equal(scenes[0].stage.characters[1].rot, -90);
assert.equal(scenes[0].stage.characters[1].pose.id, "support");
assert.equal(scenes[0].stage.charA, undefined, "legacy cast keys do not survive normalization");
// user tints persist through normalization; junk tints reset to model default
const tinted = createSceneStage({ characters: [
	{ id: "char-a", model: "y-bot-tpose", x: 0, z: 0, rot: 0, tint: "#a1b2c3", subject: "one" },
	{ id: "char-b", model: "x-bot-tpose", x: 1, z: 0, rot: 0, tint: "red", subject: "two" },
] });
assert.equal(tinted.characters[0].tint, "#a1b2c3", "a valid user tint survives");
assert.equal(tinted.characters[1].tint, null, "an invalid tint falls back to the model default");
const duplicated = duplicateScene(scenes, 0);
assert.equal(duplicated[1].name, "SCENE 03");
assert.notEqual(duplicated[1].objects, scenes[0].objects);
assert.notEqual(duplicated[1].objects[0].transform, scenes[0].objects[0].transform);
assert.notEqual(duplicated[1].shotDocument.cameraBlocks, scenes[0].shotDocument.cameraBlocks);
assert.notEqual(duplicated[1].stage, scenes[0].stage);
assert.notEqual(duplicated[1].stage.characters, scenes[0].stage.characters);
assert.notEqual(duplicated[1].stage.characters[0], scenes[0].stage.characters[0]);
assert.notEqual(duplicated[1].stage.characters[0].pose.bones, scenes[0].stage.characters[0].pose.bones);
assert.equal(duplicated[1].stage.shotAspect, "9:16");
assert.equal(duplicated[1].stage.sensorId, "super35");
duplicated[1].objects[0].transform.x = 8;
duplicated[1].shotDocument.cameraBlocks[0].keys.push(3);
duplicated[1].stage.characters[0].x = 99;
duplicated[1].stage.characters[0].pose.bones.hips[0] = 99;
assert.equal(scenes[0].objects[0].transform.x, 1);
assert.deepEqual(scenes[0].shotDocument.cameraBlocks[0].keys, [1, 2]);
assert.equal(scenes[0].stage.characters[0].x, 4, "moving the duplicate's actor cannot contaminate the source scene");
assert.equal(scenes[0].stage.characters[0].pose.bones.hips[0], 1, "posing the duplicate's actor cannot contaminate the source scene");
assert.equal(createSceneStage({ shotAspect: "invalid" }).shotAspect, "16:9", "invalid shot aspects repair to the default");
assert.equal(createSceneStage({ shotAspect: "2.39:1" }).shotAspect, "2.39:1", "scope aspect survives stage normalization");
assert.equal(createSceneStage({}).sensorId, "fullFrame", "fullFrame is the default filmback");
assert.equal(createSceneStage({ sensorId: "super16" }).sensorId, "super16", "a named filmback survives stage normalization");
assert.equal(createSceneStage({ sensorId: "unknown" }).sensorId, "fullFrame", "an unknown filmback repairs to fullFrame");

const isolatedScenes = [createScene("A"), createScene("B")];
isolatedScenes[0].stage.characters[0].x = 8;
assert.equal(isolatedScenes[1].stage.characters[0].x, 0, "moving Scene A's actor leaves Scene B unchanged");

const sharedCameraSettings = { lens: 35, metadata: JSON.parse('{"__proto__":{"safe":true}}') };
const sharedSource = createScene("Shared");
sharedSource.objects = [{ id: "camera", settings: sharedCameraSettings }];
sharedSource.shotDocument = { primary: sharedCameraSettings, backup: sharedCameraSettings };
const sharedDuplicate = duplicateScene([sharedSource], 0)[1];
assert.notEqual(sharedDuplicate.shotDocument.primary, sharedCameraSettings);
assert.equal(sharedDuplicate.shotDocument.primary, sharedDuplicate.shotDocument.backup, "shared nested references stay shared inside the copy");
assert.deepEqual(sharedDuplicate.shotDocument.primary.metadata, sharedCameraSettings.metadata, "opaque keys survive deep copy");
assert.ok(Object.hasOwn(sharedDuplicate.shotDocument.primary.metadata, "__proto__"));
sharedDuplicate.shotDocument.primary.lens = 85;
assert.equal(sharedCameraSettings.lens, 35, "mutating duplicate shot data cannot contaminate the source");
sharedSource.objects[0].settings.lens = 24;
assert.equal(sharedDuplicate.objects[0].settings.lens, 35, "mutating source objects cannot contaminate the duplicate");
sharedSource.shotDocument.primary.lens = 18;
assert.equal(sharedDuplicate.shotDocument.primary.lens, 85, "mutating source shot data cannot contaminate the duplicate");

const renamed = renameScene(scenes, 2, "SCENE 01");
assert.equal(renamed[2].name, "SCENE 03");
assert.equal(renameScene(scenes, 2, "  "), scenes);
const finalSceneList = [scenes[0]];
assert.equal(removeScene(finalSceneList, 0), finalSceneList, "the final scene is protected without replacing state");
assert.equal(removeScene(scenes, 1).length, scenes.length - 1);

assert.equal(activeSceneIndex(scenes, scenes[2].id), 2);
assert.equal(activeSceneIndex(scenes, "missing"), 0);
assert.equal(activeSceneIndex([], "missing"), -1);
assert.equal(activeScene(scenes, scenes[1].id), scenes[1]);
assert.equal(activeScene([], null), null);

const document = createSceneDocument();
document.scenes = scenes;
document.activeSceneId = scenes[2].id;
const restored = readSceneDocument(serializeSceneDocument(document));
assert.equal(restored.status, "valid");
assert.equal(restored.document.activeSceneId, scenes[2].id);
assert.deepEqual(restored.document.scenes[0].shotDocument, scenes[0].shotDocument);

const legacyStage = createSceneStage({ charA: { x: 6, z: 2, rot: 45 }, showB: true, poseA: { id: "legacy-pose" } });
assert.equal(legacyStage.characters.length, 2, "the legacy cast migrates into the characters list");
assert.equal(legacyStage.characters[0].x, 6);
assert.equal(legacyStage.characters[0].pose.id, "legacy-pose");
const repaired = readSceneDocument(JSON.stringify({
	version: 1,
	activeSceneId: "missing",
	stage: legacyStage,
	scenes: [
		{ id: "good", name: "Set", objects: [{ id: "box" }, null], shotDocument: { futureShape: [1] } },
		{ id: "good", name: "duplicate id", objects: [] },
		null,
		{ id: "bad-objects", name: "Bad", objects: "nope" },
	],
}));
assert.equal(repaired.status, "migrated");
assert.equal(repaired.dropped, 3);
assert.equal(repaired.document.scenes.length, 1);
assert.equal(repaired.document.scenes[0].objects.length, 1);
assert.equal(repaired.document.activeSceneId, "good");
assert.deepEqual(repaired.document.scenes[0].stage, legacyStage, "the old global actor setup is copied into the migrated scene");

const multiSceneMigration = readSceneDocument(JSON.stringify({
	version: 1,
	activeSceneId: "old-a",
	stage: legacyStage,
	scenes: [
		{ id: "old-a", name: "A", objects: [] },
		{ id: "old-b", name: "B", objects: [] },
	],
}));
assert.equal(multiSceneMigration.status, "migrated");
assert.deepEqual(multiSceneMigration.document.scenes.map((scene) => scene.stage), [legacyStage, legacyStage], "every old scene receives the actor setup users were seeing");
assert.notEqual(multiSceneMigration.document.scenes[0].stage, multiSceneMigration.document.scenes[1].stage);
multiSceneMigration.document.scenes[0].stage.characters[0].x = -3;
assert.equal(multiSceneMigration.document.scenes[1].stage.characters[0].x, 6, "migrated scenes own independent actor envelopes");

const legacyObjects = [{ id: "hero-chair", renderer: "chair", x: 3 }, { id: "car", renderer: "car", nested: { untouched: true } }];
const migrated = readSceneDocument(null, JSON.stringify({ version: 1, objects: legacyObjects }));
assert.equal(migrated.status, "migrated");
assert.equal(migrated.document.scenes.length, 1);
assert.deepEqual(migrated.document.scenes[0].objects, legacyObjects, "legacy user work survives byte-shaped migration");
assert.equal(migrated.document.scenes[0].name, "SCENE 01");

assert.equal(readSceneDocument("{broken").status, "corrupt");
assert.equal(readSceneDocument(JSON.stringify({ version: SCENES_VERSION + 1, scenes: [] })).status, "future");
assert.equal(readSceneDocument(JSON.stringify({ version: SCENES_VERSION + 1, newerShape: true })).status, "future");
assert.equal(readSceneDocument(null, "{broken").status, "corrupt");

class FakeStorage {
	constructor(entries = {}) { this.values = new Map(Object.entries(entries)); this.writes = []; }
	getItem(key) { return this.values.get(key) ?? null; }
	setItem(key, value) { this.values.set(key, value); this.writes.push([key, value]); }
}

const legacyRaw = JSON.stringify({ version: 1, objects: legacyObjects });
const migrationStorage = new FakeStorage({ [LEGACY_SCENE_STORAGE_KEY]: legacyRaw });
const storageMigration = loadSceneDocumentFromStorage(migrationStorage);
assert.equal(storageMigration.status, "migrated");
assert.ok(migrationStorage.getItem(SCENES_STORAGE_KEY));
assert.equal(migrationStorage.getItem(LEGACY_SCENE_STORAGE_KEY), legacyRaw, "legacy backup is not deleted");
const persistedMigration = readSceneDocument(migrationStorage.getItem(SCENES_STORAGE_KEY));
assert.deepEqual(persistedMigration.document.scenes[0].objects, legacyObjects, "legacy objects survive migrate, persist, and reload without loss");
persistedMigration.document.scenes[0].objects[1].nested.untouched = false;
assert.equal(legacyObjects[1].nested.untouched, true, "migrated objects do not retain references to the legacy input");

const previousScenesRaw = JSON.stringify({
	version: 1,
	activeSceneId: "previous-a",
	stage: legacyStage,
	scenes: [{ id: "previous-a", name: "Previous", objects: [] }],
});
const previousScenesStorage = new FakeStorage({ [PREVIOUS_SCENES_STORAGE_KEY]: previousScenesRaw });
assert.equal(loadSceneDocumentFromStorage(previousScenesStorage).status, "migrated");
assert.deepEqual(readSceneDocument(previousScenesStorage.getItem(SCENES_STORAGE_KEY)).document.scenes[0].stage, legacyStage);
assert.equal(previousScenesStorage.getItem(PREVIOUS_SCENES_STORAGE_KEY), previousScenesRaw, "the v1 scene backup is not deleted");

const corruptRaw = "{broken scenes";
const corruptStorage = new FakeStorage({ [SCENES_STORAGE_KEY]: corruptRaw });
assert.equal(loadSceneDocumentFromStorage(corruptStorage).status, "corrupt");
assert.equal(corruptStorage.getItem(SCENES_QUARANTINE_KEY), corruptRaw);
assert.equal(corruptStorage.getItem(SCENES_STORAGE_KEY), corruptRaw, "quarantine never overwrites corrupt source bytes");

const corruptLegacyStorage = new FakeStorage({ [LEGACY_SCENE_STORAGE_KEY]: "{broken legacy" });
assert.equal(loadSceneDocumentFromStorage(corruptLegacyStorage).status, "corrupt");
assert.equal(corruptLegacyStorage.getItem(SCENES_QUARANTINE_KEY), "{broken legacy");
assert.equal(corruptLegacyStorage.getItem(LEGACY_SCENE_STORAGE_KEY), "{broken legacy", "corrupt legacy source remains available for recovery");

const futureRaw = JSON.stringify({ version: 9, scenes: [{ id: "future" }] });
const futureStorage = new FakeStorage({ [SCENES_STORAGE_KEY]: futureRaw });
assert.equal(loadSceneDocumentFromStorage(futureStorage).status, "future");
assert.deepEqual(futureStorage.writes, [], "future data is left untouched");
assert.equal(futureStorage.getItem(SCENES_STORAGE_KEY), futureRaw);

assert.equal(SCENES_VERSION, 4);
assert.match(SCENES_STORAGE_KEY, /\.v4$/);
assert.notEqual(SCENES_STORAGE_KEY, SCENES_QUARANTINE_KEY);
assert.notEqual(SCENES_STORAGE_KEY, PREVIOUS_SCENES_STORAGE_KEY);
assert.notEqual(SCENES_STORAGE_KEY, LEGACY_SCENE_STORAGE_KEY);
assert.ok(createScene("SCENE 01", scenes).id);

/* --------------- v4: per-character stature and the 24 fps clock ------------ */

// Every cast member carries the stature its take was extracted at. Canonical
// is 1; a hand-edited body can never persist a giant or a gnome.
assert.equal(createCharacterEntry({}).scale, 1, "a cast member is canonical stature by default");
assert.equal(createCharacterEntry({ scale: 1.24 }).scale, 1.24, "a stored stature survives normalization");
assert.equal(createCharacterEntry({ scale: 0 }).scale, 1, "a zero stature is not a stature");
assert.equal(createCharacterEntry({ scale: -1.2 }).scale, 1, "a negative stature is not a stature");
assert.equal(createCharacterEntry({ scale: "1.2" }).scale, 1, "a non-numeric stature is not a stature");
assert.equal(createCharacterEntry({ scale: 99 }).scale, 3, "an absurd stature clamps to the band");
assert.equal(createCharacterEntry({ scale: 0.05 }).scale, 0.2, "a tiny stature clamps to the band");
assert.equal(createCharacterEntry({ y: -2 }).y, 0, "lift cannot sink below the deck");
assert.equal(createCharacterEntry({ y: 10 }).y, 10, "lift has no ceiling — a crane shot may hoist the body");
const sceneCalibration = { scale: 1.12, yawDeg: 14, offsetX: 0.4, offsetY: 0.08, offsetZ: -0.2 };
const calibratedEntry = createCharacterEntry({ motionRef: { url: "/ardy/motions/calibrated.npz", calibration: sceneCalibration } });
assert.deepEqual(calibratedEntry.motionRef.calibration, sceneCalibration, "scene calibration survives character normalization");
assert.notEqual(calibratedEntry.motionRef.calibration, sceneCalibration, "scene calibration is owned by the normalized entry");
sceneCalibration.offsetX = 99;
assert.equal(calibratedEntry.motionRef.calibration.offsetX, 0.4, "mutating the source calibration cannot rewrite the entry");
const clampedCalibration = createCharacterEntry({ motionRef: { url: "/ardy/motions/clamped.npz", calibration: { scale: 99, yawDeg: 540, offsetX: 101 } } }).motionRef.calibration;
assert.deepEqual(clampedCalibration, { scale: 10, yawDeg: -180, offsetX: 100, offsetY: 0, offsetZ: 0 }, "persisted calibration uses the bounded scene envelope");
assert.equal(createCharacterEntry({ motionRef: { url: "/ardy/motions/legacy.npz" } }).motionRef.calibration, undefined, "legacy motion refs remain free of calibration fields");
const staturedStage = createSceneStage({ characters: [{ id: "char-a", scale: 1.18 }, { id: "char-b" }] });
assert.equal(staturedStage.characters[0].scale, 1.18, "a stored stature survives the stage envelope");
assert.equal(staturedStage.characters[1].scale, 1, "a cast member without a take stays canonical");
const staturedRoundTrip = readSceneDocument(serializeSceneDocument({
	version: SCENES_VERSION,
	activeSceneId: "s-scale",
	scenes: [{ id: "s-scale", name: "Scale", objects: [], shotDocument: null, stage: staturedStage }],
}));
assert.equal(createSceneStage(staturedRoundTrip.document.scenes[0].stage).characters[0].scale, 1.18, "stature survives save and reload");

// A v3 document's frame numbers were authored while the timeline ran at
// 20 fps. Read at 24 without conversion, every scene would silently lose a
// sixth of its duration, so the reader multiplies by 24/20 exactly once.
const v3Stage = {
	characters: [{
		id: "char-a",
		model: "y-bot-tpose",
		x: 0, z: 0, rot: 0,
		layer: {
			waypoints: [{ frame: 0, x: 0, z: 0, heading: null }, { frame: 40, x: 1, z: 2, heading: null }, { frame: 100, x: 2, z: 3, heading: null }],
			promptClips: [
				{ id: "clip-1", text: "walks in", startFrame: 40, endFrame: 80 },
				{ id: "clip-2", text: "stops", startFrame: 80, endFrame: 120 },
			],
		},
	}],
	hasCharSheet: false,
	shotAspect: "16:9",
};
const v3Read = readSceneDocument(JSON.stringify({
	version: 3,
	activeSceneId: "s1",
	scenes: [{ id: "s1", name: "Set", objects: [], shotDocument: null, stage: v3Stage }],
}));
assert.equal(v3Read.status, "migrated");
const v4Layer = v3Read.document.scenes[0].stage.characters[0].layer;
assert.deepEqual(v4Layer.waypoints.map((waypoint) => waypoint.frame), [0, 48, 120], "waypoint frames move onto the 24 fps clock");
assert.deepEqual(
	v4Layer.promptClips.map((clip) => [clip.startFrame, clip.endFrame]),
	[[48, 96], [96, 144]],
	"prompt blocks land exactly on the new 48-frame grid"
);
assert.equal(v4Layer.waypoints[1].x, 1, "the clock migration touches frames only, never positions");
assert.equal(v4Layer.promptClips[0].text, "walks in", "prompt text survives the clock migration");
assert.equal(createSceneStage(v3Read.document.scenes[0].stage).characters[0].scale, 1, "a v3 cast member reads back at canonical stature");
const v3Rewritten = readSceneDocument(serializeSceneDocument(v3Read.document));
assert.equal(v3Rewritten.status, "valid");
assert.deepEqual(
	v3Rewritten.document.scenes[0].stage.characters[0].layer.waypoints.map((waypoint) => waypoint.frame),
	[0, 48, 120],
	"a migrated document is not scaled a second time on reload"
);

// The same conversion is exported for a project FILE, which carries its own
// scene document and never passes through the storage reader.
const migratedStage = migrateStageFrames(v3Stage);
assert.deepEqual(migratedStage.characters[0].layer.waypoints.map((waypoint) => waypoint.frame), [0, 48, 120]);
assert.deepEqual(v3Stage.characters[0].layer.waypoints.map((waypoint) => waypoint.frame), [0, 40, 100], "the source stage is not mutated");
// Ascending order and the half-open no-overlap rule hold even for a body that
// never had them.
const disorderly = migrateStageFrames({ characters: [{ id: "char-a", layer: {
	waypoints: [{ frame: 100, x: 0, z: 0 }, { frame: 40, x: 0, z: 0 }, { frame: 40, x: 9, z: 9 }],
	promptClips: [{ id: "b", startFrame: 80, endFrame: 120 }, { id: "a", startFrame: 40, endFrame: 90 }],
} }] });
assert.deepEqual(disorderly.characters[0].layer.waypoints.map((waypoint) => waypoint.frame), [48, 120], "duplicate frames collapse and the list stays ascending");
const disorderlyClips = disorderly.characters[0].layer.promptClips;
assert.deepEqual(disorderlyClips.map((clip) => [clip.startFrame, clip.endFrame]), [[48, 108], [108, 144]], "overlapping blocks are pushed apart, never left overlapping");
assert.ok(disorderlyClips.every((clip, index) => index === 0 || clip.startFrame >= disorderlyClips[index - 1].endFrame));

// Extra extraction takes stand at their filmed offset, rotated into the
// active character's facing.
assert.deepEqual(takeAnchor({ x: 0, z: 0, rot: 0 }, 0.8, 0.2), { x: 0.8, z: 0.2 });
const rotatedAnchor = takeAnchor({ x: 1, z: -1, rot: 90 }, 1, 0);
assert.ok(Math.abs(rotatedAnchor.x - 1) < 1e-9 && Math.abs(rotatedAnchor.z + 2) < 1e-9, "a quarter turn sends a +X offset to -Z");
assert.deepEqual(takeAnchor(null, undefined, NaN), { x: 0, z: 0 }, "junk placement resolves to the origin, never NaN");

const appSource = readFileSync(new URL("../src/App.jsx", import.meta.url), "utf8");
assert.match(
	appSource,
	/actorStageRef\.current = \{[\s\S]{0,280}shotAspect: shotAspectKey,[\s\S]{0,80}sensorId,/,
	"the outgoing scene snapshots actor state, shot aspect and filmback"
);
assert.match(appSource, /setCharacters\(stage\.characters\)/, "opening a scene restores its cast");
const openSceneBody = /function openScene\(scene, nextScenes\) \{([\s\S]*?)\n\t\}/.exec(appSource)?.[1] ?? "";
assert.doesNotMatch(
	openSceneBody,
	/setRigs\(\{\}\)/,
	"opening a scene preserves mounted rig instances so motion can load immediately"
);
assert.match(
	appSource,
	/const targetCharacter = charactersRef\.current\.find\(\(entry\) => entry\.id === targetCharacterId\)[\s\S]*?await waitForRig\(targetCharacter\.id\)/,
	"motion loading waits for the active rig instead of losing the request to mount timing"
);
const batchSource = /apply_batch:\s*\(args\) => \{([\s\S]*?)\n\t\t\t\},\n\t\t\t\/\/ Authoring blocks/.exec(appSource)?.[1] ?? "";
assert.match(
	batchSource,
	/const token = storeRef\.current\.begin[\s\S]*?try \{[\s\S]*?finally \{[\s\S]*?batchToken = null;[\s\S]*?storeRef\.current\.end\(token,/,
	"apply_batch always releases its transaction and restores mutation state",
);
assert.match(
	openSceneBody,
	/setRigMountEpoch\(\(value\) => value \+ 1\)/,
	"opening a scene remounts characters so their rig callbacks report again"
);
assert.doesNotMatch(appSource, /InstallApp/, "the premature Install app control is no longer mounted or imported");

console.log("all scene document checks PASS");

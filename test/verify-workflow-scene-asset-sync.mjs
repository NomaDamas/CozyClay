#!/usr/bin/env node
import {
	SCENE_SYNC_EVENT,
	SCENE_PLAYBACK_EVENT,
	SCENE_PLAYBACK_STORAGE_KEY,
	appendAssetCutout,
	applyMotionToCharacter,
	importImageIntoActiveScene,
	publishScenePlayback,
	readStoredSceneDocument,
	subscribeToSceneDocuments,
	subscribeToScenePlayback,
} from "../src/workflow/scene-asset-sync.js";
import { createSceneDocument } from "../src/scenes.js";

let failures = 0;
function expect(name, condition, detail = "") {
	console.log(`${condition ? "PASS" : "FAIL"} ${name}${condition ? "" : ` — ${detail}`}`);
	if (!condition) failures += 1;
}

const asset = {
	id: `img-${"a".repeat(32)}`,
	type: "image/png",
	width: 1200,
	height: 800,
	bytes: new Uint8Array([1, 2, 3]).buffer,
	name: "hero.png",
};
const document = createSceneDocument();
const added = appendAssetCutout(document, asset, { placement: { x: 2, z: -1 } });
expect("asset patch adds one active-scene cutout", added.changed && added.object?.assetId === asset.id && added.document.scenes[0].objects.length === 1);
expect("asset patch preserves placement", added.object?.x === 2 && added.object?.z === -1);
expect("asset patch keeps the input immutable", document.scenes[0].objects.length === 0);
const duplicate = appendAssetCutout(added.document, asset);
expect("the same asset is not duplicated", !duplicate.changed && duplicate.reason === "already-in-scene" && added.document.scenes[0].objects.length === 1);
expect("invalid assets are rejected", appendAssetCutout(document, { id: "foreign" }).reason === "invalid-asset");
const motionDocument = createSceneDocument();
const motionPatch = applyMotionToCharacter(motionDocument, "char-1", { url: "/ardy/motions/take.npz" });
expect("motion patch rejects a missing character", !motionPatch.changed && motionPatch.reason === "character-not-found");
const castDocument = { ...motionDocument, scenes: motionDocument.scenes.map((scene) => ({ ...scene, stage: { ...scene.stage, characters: [{ ...scene.stage.characters[0], id: "hero" }] } })) };
const appliedMotion = applyMotionToCharacter(castDocument, "hero", { url: "/ardy/motions/take.npz", motionRef: { prompt: "walk" } });
expect("motion patch updates only the selected character", appliedMotion.changed && appliedMotion.document.scenes[0].stage.characters[0].motionRef.url === "/ardy/motions/take.npz" && appliedMotion.document.scenes[0].stage.characters[0].layer);

const listeners = new Map();
const target = {
	addEventListener(name, callback) { listeners.set(name, callback); },
	removeEventListener(name) { listeners.delete(name); },
};
const storageValues = new Map();
const storage = {
	getItem(key) { return storageValues.get(key) ?? null; },
	setItem(key, value) { storageValues.set(key, value); },
};
let seen = [];
const unsubscribe = subscribeToSceneDocuments((next, meta) => seen.push({ next, meta }), { storage, target });
target.dispatchEvent = (event) => listeners.get(event.type)?.(event);
const published = await importImageIntoActiveScene(new Blob(["bytes"], { type: "image/png" }), {
	document,
	storage,
	target,
	importer: async () => asset,
	remember: async (record) => record,
});
expect("workflow import returns the stored asset", published.asset.id === asset.id);
expect("workflow import announces same-tab changes", seen.length === 1 && seen[0].meta.source === "same-tab" && seen[0].next.scenes[0].objects.length === 1);
expect("workflow import writes the scenes storage key", !!storage.getItem("cozyclay.scenes.v4"));
const storedDocument = readStoredSceneDocument(storage);
expect("stored scene can be read back", storedDocument.scenes[0].objects[0].assetId === asset.id);
listeners.get("storage")?.({ key: "cozyclay.scenes.v4", newValue: storage.getItem("cozyclay.scenes.v4") });
expect("storage events announce cross-tab changes", seen.at(-1)?.meta.source === "storage");
const seenBeforeCorrupt = seen.length;
listeners.get("storage")?.({ key: "cozyclay.scenes.v4", newValue: "{broken" });
expect("corrupt cross-tab scene bytes are ignored", seen.length === seenBeforeCorrupt);
unsubscribe();
expect("unsubscribe removes both event listeners", listeners.size === 0);
expect("event name is stable", SCENE_SYNC_EVENT === "cozyclay:scene-change");

let playback = [];
const stopPlayback = subscribeToScenePlayback((command) => playback.push(command), { storage, target });
const command = publishScenePlayback({ activeSceneId: document.activeSceneId, frame: 12, playing: true }, { storage, target });
expect("playback command announces same-tab controls", playback.length === 1 && playback[0].frame === 12 && playback[0].playing === true);
expect("playback command writes a transient storage value", storage.getItem(SCENE_PLAYBACK_STORAGE_KEY)?.includes('"frame":12'));
listeners.get("storage")?.({ key: SCENE_PLAYBACK_STORAGE_KEY, newValue: storage.getItem(SCENE_PLAYBACK_STORAGE_KEY) });
expect("playback storage events announce cross-tab controls", playback.length === 2 && playback[1].activeSceneId === document.activeSceneId);
stopPlayback();
expect("playback event name is stable", SCENE_PLAYBACK_EVENT === "cozyclay:scene-playback" && command.issuedAt > 0);

if (failures) {
	console.error(`\n${failures} failure(s)`);
	process.exit(1);
}
console.log("\nverify-workflow-scene-asset-sync: all green");

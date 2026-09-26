#!/usr/bin/env node
import assert from "node:assert/strict";
import {
	activeSceneCharacters,
	characterHandleId,
	characterIdFromHandle,
	characterMotionPatch,
	connectedCharacterIds,
	motionInputOutput,
	normalizeMotionInputData,
} from "../src/workflow/motion-input.js";

const normalized = normalizeMotionInputData({ motionUrl: "/ardy/motions/walk.npz", targetCharacterId: "char-a", frames: "24", fps: "24" });
assert.equal(normalized.url, "/ardy/motions/walk.npz");
assert.equal(normalized.characterId, "char-a");
assert.equal(normalized.frames, 24);
assert.equal(characterHandleId("char-a"), "character:char-a");
assert.equal(characterIdFromHandle("character:char-a"), "char-a");
assert.equal(characterIdFromHandle("motion"), null);

const output = motionInputOutput(normalized);
assert.deepEqual({ url: output.url, characterId: output.characterId, handle: output.handle }, {
	url: "/ardy/motions/walk.npz", characterId: "char-a", handle: "character:char-a",
});
const patch = characterMotionPatch("char-a", { url: "/ardy/motions/walk.npz", motionRef: { prompt: "walk" } });
assert.deepEqual(patch, { characterId: "char-a", motionRef: { prompt: "walk", url: "/ardy/motions/walk.npz", fileName: null, mimeType: "application/octet-stream" } });

const edges = [
	{ source: "motion-1", target: "scene-1", targetHandle: "character:char-a" },
	{ source: "motion-2", target: "scene-1", targetHandle: "character:char-b" },
	{ source: "motion-3", target: "scene-2", targetHandle: "character:char-c" },
];
assert.deepEqual(connectedCharacterIds(edges, "scene-1"), ["char-a", "char-b"]);

const storage = new Map([["cozyclay.scenes.v4", JSON.stringify({ version: 4, activeSceneId: "scene-2", scenes: [
	{ id: "scene-1", name: "One", objects: [], stage: { characters: [{ id: "old" }] } },
	{ id: "scene-2", name: "Two", objects: [], stage: { characters: [{ id: "char-a", subject: "Hero", model: "x-bot-tpose" }] } },
] })]]);
const fakeStorage = { getItem: (key) => storage.get(key) ?? null };
assert.deepEqual(activeSceneCharacters(fakeStorage), [{ id: "char-a", name: "Hero", model: "x-bot-tpose", motionRef: null }]);

console.log("motion input adapter checks passed");

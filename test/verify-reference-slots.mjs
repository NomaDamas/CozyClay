// Reference slots (#167): the cast member's identity image and the stage's
// environment reference live in the scene document, so they must survive a
// save/load round trip and must never hold anything but inline image bytes —
// a file:// or http:// path would break the moment the project moves.
import assert from "node:assert/strict";
import {
	createCharacterEntry,
	createSceneStage,
	normalizeReferenceImage,
	readSceneDocument,
	SCENES_VERSION,
	serializeSceneDocument,
} from "../src/scenes.js";

const png = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=";
const jpeg = "data:image/jpeg;base64,/9j/4AAQSkZJRg==";

/* --- the character slot ---------------------------------------------------- */

assert.equal(createCharacterEntry(null, 0).identityImage, null, "a fresh cast member has no identity image");
assert.equal(createCharacterEntry({ identityImage: png }, 0).identityImage, png, "a PNG data URL is kept");
assert.equal(createCharacterEntry({ identityImage: jpeg }, 0).identityImage, jpeg, "a JPEG data URL is kept");
for (const bad of ["https://example.com/face.png", "file:///tmp/face.png", "data:text/plain;base64,aGk=", "", 42, {}, [], true, null, undefined]) {
	assert.equal(createCharacterEntry({ identityImage: bad }, 0).identityImage, null, `rejected: ${JSON.stringify(bad)}`);
}
assert.equal(normalizeReferenceImage(png), png);
assert.equal(normalizeReferenceImage("data:video/mp4;base64,AAA"), null, "only images are references");

/* --- the stage slot -------------------------------------------------------- */

assert.equal(createSceneStage().environmentImage, null, "a fresh stage has no environment reference");
assert.equal(createSceneStage({ environmentImage: png }).environmentImage, png);
assert.equal(createSceneStage({ environmentImage: "https://example.com/set.png" }).environmentImage, null, "a remote URL is not a stored reference");

/* --- persistence ----------------------------------------------------------- */

const stage = createSceneStage({
	characters: [{ id: "char-a", subject: "Alpha", identityImage: png }, { id: "char-b", subject: "Beta" }],
	environmentImage: jpeg,
});
const document = { version: SCENES_VERSION, activeSceneId: "s1", scenes: [{ id: "s1", name: "SCENE 01", objects: [], shotDocument: null, stage }] };
const read = readSceneDocument(serializeSceneDocument(document));
assert.equal(read.status, "valid");
const loaded = read.document.scenes[0].stage;
assert.equal(loaded.characters[0].identityImage, png, "the identity image survives save/load");
assert.equal(loaded.characters[1].identityImage, null, "an empty slot stays empty");
assert.equal(loaded.environmentImage, jpeg, "the environment reference survives save/load like shotAspect");

// An older document has neither field; loading it must not invent one.
const legacy = readSceneDocument(JSON.stringify({
	version: SCENES_VERSION,
	activeSceneId: "s1",
	scenes: [{ id: "s1", name: "SCENE 01", objects: [], shotDocument: null, stage: { characters: [{ id: "char-a" }], shotAspect: "16:9" } }],
}));
assert.equal(legacy.document.scenes[0].stage.characters[0].identityImage, null);
assert.equal(legacy.document.scenes[0].stage.environmentImage, null);

console.log("PASS reference slots: identityImage / environmentImage validated and persisted");

// Project envelope v5: the project-level previsMode field, its defaults for
// v2-v4 files, the future-version refusal, the session record, and the scenes
// domain boundaries (blank creation, file open) that set it.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import {
	createProjectDocument,
	readProjectDocument,
	normalizePrevisMode,
	loadProjectSession,
	storeProjectSession,
	PREVIS_MODES,
	DEFAULT_PREVIS_MODE,
	PROJECT_VERSION,
	PROJECT_SESSION_KEY,
} from "../src/project.js";
import { createSceneDocument } from "../src/scenes.js";
import { projectFixture, ok } from "./bus/project-fixture.mjs";

const text = (path) => readFileSync(new URL(path, import.meta.url), "utf8");

assert.deepEqual(PREVIS_MODES, ["storyboard", "animation"]);
assert.equal(DEFAULT_PREVIS_MODE, "animation");
assert.equal(normalizePrevisMode("storyboard"), "storyboard");
for (const unknown of ["bogus", undefined, null, 1, "Storyboard"]) assert.equal(normalizePrevisMode(unknown), "animation", `${String(unknown)} normalizes to the default`);

// (a) a new document is v5 and carries previsMode right after name.
const scenesDocument = createSceneDocument("SCENE 01");
const storyboard = createProjectDocument({ scenesDocument, name: "Boards", previsMode: "storyboard" });
assert.equal(storyboard.version, 5);
assert.equal(storyboard.version, PROJECT_VERSION);
assert.equal(storyboard.previsMode, "storyboard");
const keys = Object.keys(storyboard);
assert.equal(keys[keys.indexOf("name") + 1], "previsMode", "previsMode is the envelope field right after name");
assert.equal("previsMode" in storyboard.scenes, false, "previsMode is project-level, never on the scenes document");
assert.equal(createProjectDocument({ scenesDocument }).previsMode, "animation", "an omitted mode is written as the default");
assert.equal(readProjectDocument(JSON.stringify(storyboard)).project.previsMode, "storyboard", "a v5 round trip keeps the mode");

// (b) an older file without the field reads as animation, unchanged otherwise.
const cityBlock = text("../public/scenes/city-block.cclayproject");
const cityBlockRead = readProjectDocument(cityBlock);
assert.equal(cityBlockRead.ok, true);
assert.equal(cityBlockRead.project.previsMode, "animation");
assert.ok(JSON.parse(cityBlock).version < 5 && !("previsMode" in JSON.parse(cityBlock)), "the bundled starter is a pre-v5 file without the field");
for (const version of [2, 3, 4]) {
	const legacy = { ...storyboard, version };
	delete legacy.previsMode;
	const read = readProjectDocument(JSON.stringify(legacy));
	assert.equal(read.ok, true, `v${version} stays readable`);
	assert.equal(read.project.previsMode, "animation", `v${version} defaults to animation`);
}

// (c) an unknown mode in a v5 file reads as the default.
const bogus = readProjectDocument(JSON.stringify({ ...storyboard, previsMode: "bogus" }));
assert.equal(bogus.ok, true);
assert.equal(bogus.project.previsMode, "animation");

// (d) a newer envelope is still refused with the existing future reason.
assert.deepEqual(readProjectDocument(JSON.stringify({ ...storyboard, version: 6 })), { ok: false, reason: "future" });

// The committed v5 fixture (the cross-version QA input) reads as storyboard.
const fixture = text("./fixtures/previs-v5.cclayproject");
const fixtureRead = readProjectDocument(fixture);
assert.equal(fixtureRead.ok, true);
assert.equal(JSON.parse(fixture).version, 5);
assert.equal(fixtureRead.project.previsMode, "storyboard");

// Session record: previsMode sits beside the session name.
const memory = new Map();
const storage = { getItem: (key) => memory.get(key) ?? null, setItem: (key, value) => memory.set(key, value), removeItem: (key) => memory.delete(key) };
assert.equal(storeProjectSession("Boards", "storyboard", storage), true);
assert.equal(JSON.parse(memory.get(PROJECT_SESSION_KEY)).previsMode, "storyboard");
assert.equal(loadProjectSession(storage).previsMode, "storyboard");
memory.set(PROJECT_SESSION_KEY, JSON.stringify({ name: "Old session" }));
assert.deepEqual(loadProjectSession(storage), { name: "Old session", previsMode: "animation", updatedAt: 0 }, "a pre-v5 session record restores as animation");

// Scenes domain: blank creation, file open and reload restore set the mode.
const f = projectFixture();
const session = () => JSON.parse(f.storage.get(PROJECT_SESSION_KEY));
try {
	assert.equal(f.project.metadata().previsMode, "animation", "a session without the field starts as animation");
	ok(await f.run("project.new", { name: "Boards", previsMode: "storyboard" }));
	assert.equal(f.project.metadata().previsMode, "storyboard", "blank creation takes the options previsMode");
	assert.equal(session().previsMode, "storyboard", "the session record stores the new mode");
	assert.equal(JSON.parse(f.project.collectProjectSnapshot("Boards")).previsMode, "storyboard", "the project document input carries the mode");
	assert.equal(f.project.document().project.previsMode, "storyboard", "the shared project document exposes the mode");
	ok(await f.run("scene.create"));
	assert.equal(f.project.metadata().previsMode, "storyboard", "a scene edit keeps the project mode");
	assert.equal((await f.run("project.new", { name: "Bad", previsMode: "bogus" })).ok, false, "the bus refuses an unknown mode");

	ok(await f.run("project.open", { serialized: cityBlock }));
	assert.equal(f.project.metadata().previsMode, "animation", "opening a pre-v5 file applies animation");
	assert.equal(session().previsMode, "animation");
	ok(await f.run("project.open", { serialized: fixture }));
	assert.equal(f.project.metadata().previsMode, "storyboard", "opening a v5 file applies its mode");
	assert.equal(session().previsMode, "storyboard");
	ok(await f.run("project.new", { name: "Defaulted" }));
	assert.equal(f.project.metadata().previsMode, "animation", "blank creation without options defaults to animation");
} finally {
	f.dispose();
}

// A reload mounts the domain from the stored session record.
const reload = projectFixture({ session: { name: "Boards", previsMode: "storyboard" } });
try {
	assert.equal(reload.project.metadata().name, "Boards");
	assert.equal(reload.project.metadata().previsMode, "storyboard", "a reload restores the session mode");
} finally {
	reload.dispose();
}

console.log("PASS project previsMode: v5 envelope, v2-v4 default, bogus default, future refusal, session record, blank/open domain boundaries");

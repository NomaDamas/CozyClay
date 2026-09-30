#!/usr/bin/env node
import assert from "node:assert/strict";
import { resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const sourceRoot = process.env.COZYCLAY_ROOT
	? resolve(process.env.COZYCLAY_ROOT)
	: fileURLToPath(new URL("../", import.meta.url));
const { chooseIkEntryPose } = await import(pathToFileURL(resolve(sourceRoot, "src/ik-camera.js")).href);

const editorPose = { source: "editor" };
const shotPose = { source: "shot" };
const rememberedPose = { source: "remembered" };

assert.equal(
	chooseIkEntryPose({ rememberedPose: null, editorPose, shotPose, lookThroughShot: false }),
	editorPose,
	"a first IK entry seeds from the editor view",
);
assert.equal(
	chooseIkEntryPose({ rememberedPose, editorPose, shotPose, lookThroughShot: false }),
	rememberedPose,
	"a remembered poser view wins for the same character",
);
assert.equal(
	chooseIkEntryPose({ rememberedPose: null, editorPose, shotPose, lookThroughShot: true }),
	shotPose,
	"look-through-shot IK entry seeds from the shot view",
);
assert.equal(
	chooseIkEntryPose({ rememberedPose, editorPose, shotPose, lookThroughShot: true }),
	rememberedPose,
	"a remembered poser view still wins over look-through-shot",
);

console.log("PASS IK entry camera seeding decisions");

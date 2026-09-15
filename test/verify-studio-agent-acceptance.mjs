#!/usr/bin/env node
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { createFixtureMotion } from "./fixtures/studio-agent-motion.mjs";
const scene = JSON.parse(await readFile(new URL("./fixtures/studio-agent-scene.json", import.meta.url)));
assert.equal(scene.schema, "studio-agent-qa-scene-v1");
assert.equal(scene.fps, 24);
assert.equal(scene.characters.length, 2);
const motion = createFixtureMotion();
assert.equal(motion.mode, "fixture-only");
assert.equal(motion.frames, scene.frameCount);
assert.equal(motion.fps, scene.fps);
assert.equal(motion.rootPos.length, motion.frames * 3);
assert.equal(motion.posedJoints.length, motion.frames * 27 * 3);
assert.equal(motion.rotMats.length, motion.frames * 27 * 9);
assert(motion.rotMats.every((value) => Number.isFinite(value)));
console.log("Studio Agent acceptance fixture: PASS (deterministic fixture-only mode)");

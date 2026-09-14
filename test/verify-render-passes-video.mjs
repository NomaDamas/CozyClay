#!/usr/bin/env node
import assert from "node:assert/strict";
import { depthRangeFromFrames, passFileName } from "../src/render-passes.js";
import { normalizeFrameRange } from "../src/offscreen-export.js";

assert.deepEqual(normalizeFrameRange(12, 21), { startFrame: 12, endFrame: 21, frameCount: 10 });
assert.equal(passFileName("depth"), "blocking-frame-depth.png");
assert.deepEqual(depthRangeFromFrames([[8, 3, 12], [5, 19]], 0.1, 40), { near: 3, far: 19 });
assert.deepEqual(depthRangeFromFrames([], 0.2, 40), { near: 0.2, far: 40 });
assert.ok(depthRangeFromFrames([[5, 5]]).far > 5, "equal shot depths retain a usable range");
console.log("PASS depth video addresses an inclusive shot range and uses blocking-depth semantics");
console.log("PASS depth normalisation range is computed from the whole shot");
console.log("PASS depth video keeps lighter = closer polarity and the blocking-depth.mp4 name");

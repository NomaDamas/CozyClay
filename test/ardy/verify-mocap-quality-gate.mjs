#!/usr/bin/env node
import assert from "node:assert/strict";
import { DEFAULT_LIMITS, evaluateQuality } from "../../tools/ardy/mocap-quality-gate.mjs";

const good = evaluateQuality({
	frames: 120, footSlideCmPerS: 1.2, jitterMmPerFrame2: 2.5,
	framesBelowFloor: 0, deepestBelowFloorCm: 0, rootTravelM: 1,
});
assert.equal(good.pass, true);
assert.equal(good.checks.length, 4);

const bad = evaluateQuality({
	frames: 120, footSlideCmPerS: 6.75, jitterMmPerFrame2: 11.165,
	framesBelowFloor: 5, deepestBelowFloorCm: 0.8, rootTravelM: 1.54,
});
assert.equal(bad.pass, false);
assert.deepEqual(bad.checks.filter((check) => !check.pass).map((check) => check.name), ["foot-slide", "jitter", "below-floor-fraction"]);

const relaxed = evaluateQuality(bad.metrics, {
	...DEFAULT_LIMITS, maxFootSlideCmPerS: 7, maxJitterMmPerFrame2: 12,
	maxBelowFloorFraction: .05,
});
assert.equal(relaxed.pass, true);

const sceneAndVideo = evaluateQuality({ ...good.metrics,
	verticalContactErrorCm: 1.2, cameraDriftPx: 0.8, backgroundDriftP95: 3.5,
});
assert.equal(sceneAndVideo.pass, true);
assert.deepEqual(sceneAndVideo.checks.slice(-3).map((check) => check.name), ["vertical-contact", "camera-drift", "background-drift"]);
const drifting = evaluateQuality({ ...good.metrics, cameraDriftPx: 4 });
assert.equal(drifting.pass, false);
assert.equal(drifting.checks.at(-1).name, "camera-drift");
console.log("PASS mocap quality gate covers foot slide, jitter, and floor penetration with overrideable limits");

import { mocapMetricsFromMotion } from "../../tools/ardy/mocap-metrics.mjs";
import { qualityReportForMotion } from "../../tools/ardy/extract.mjs";
const frames = 4;
const posedJoints = new Float32Array(frames * 27 * 3);
const rootPos = new Float32Array(frames * 3);
for (let f = 0; f < frames; f += 1) {
  rootPos[f * 3] = f * 0.01;
  for (let j = 0; j < 27; j += 1) {
    const o = (f * 27 + j) * 3;
    posedJoints[o] = 0;
    posedJoints[o + 1] = 0.1;
    posedJoints[o + 2] = 0;
  }
}
const motion = { frames, fps: 24, posedJoints, rootPos };
const measured = mocapMetricsFromMotion(motion);
assert.equal(measured.frames, frames);
assert.equal(measured.fps, 24);
assert.equal(measured.framesBelowFloor, 0);
assert.equal(measured.jitterMmPerFrame2, 0);
const report = qualityReportForMotion(motion);
assert.equal(report.pass, true);
assert.equal(report.metrics.frames, frames);
console.log("PASS in-memory motion metrics feed the extraction quality report");

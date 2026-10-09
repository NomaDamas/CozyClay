#!/usr/bin/env node
// Drift proof for the golden SSE parity fixtures: re-record both scenarios
// from the live agent loops and require an exact match with the recorded JSON.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { recordGolden } from "./fixtures/agent-sse-golden.mjs";

const golden = JSON.parse(readFileSync(fileURLToPath(new URL("./fixtures/agent-sse-golden.json", import.meta.url)), "utf8"));
const recorded = await recordGolden();
assert.deepEqual(recorded.W, golden.W, "the recorded Workflow SSE frames drifted from test/fixtures/agent-sse-golden.json");
assert.deepEqual(recorded.S, golden.S, "the recorded Studio SSE frames drifted from test/fixtures/agent-sse-golden.json");
assert.equal(golden.W[0].type, "quota", "the workflow turn opens with its quota frame");
assert.ok(golden.W.some((frame) => frame.type === "tool.start" && frame.name === "run_workflow"), "the workflow golden pins run_workflow");
assert.ok(golden.B.some((frame) => frame.type === "tool.start" && frame.name === "run_action" && frame.args?.action === "shot.createStill"), "the storyboard golden pins shot.createStill");
assert.ok(golden.B.some((frame) => frame.type === "tool.start" && frame.name === "frame_shot"), "the storyboard golden pins frame_shot");
for (const removed of ["capture_blocking_frame", "render_from_frame", "place_image_in_scene"]) {
	assert.ok(![...golden.W, ...golden.S].some((frame) => frame.name === removed), `${removed} is never scripted`);
}
console.log(`PASS golden SSE parity: W=${golden.W.length} frames, S=${golden.S.length} frames`);

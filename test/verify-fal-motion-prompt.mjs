// Locks in buildH3MotionPrompt (#380): the extractor reads a locked-off
// plate, so the camera and the scene stay pinned; the character's heading is
// the action's to decide (a "no yaw turn" lock fought every action that
// turns and made the motion stiff); and tempo words are never injected (the
// user measured "slow / deliberate" as the source of awkward motion).
import assert from "node:assert/strict";
import { buildH3MotionPrompt } from "../src/fal-motion-client.js";

const TEMPO = /\b(slow|slowly|deliberate|deliberately|unhurried)\b/i;

for (const interpolate of [false, true]) {
	const text = buildH3MotionPrompt("walk to the bench and sit", { interpolate });
	assert.match(text, /camera fixed/i, "camera lock present");
	assert.match(text, /full-body character framing/i, "full-body framing present");
	assert.match(text, /scene, lighting, floor, and every object unchanged/i, "scene lock present");
	assert.match(text, /one continuous shot/i, "single-shot lock present");
	assert.doesNotMatch(text, /yaw|spin|facing direction unchanged|heading/i, "no heading/rotation lock");
	assert.doesNotMatch(text, TEMPO, "no tempo words injected");
}
// A caller's own tempo word is theirs; the builder adds none of its own.
assert.doesNotMatch(buildH3MotionPrompt("").replace(/^.*\n/, ""), TEMPO);
console.log("verify-fal-motion-prompt: ok");

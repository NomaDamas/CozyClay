#!/usr/bin/env node
// Still shots (storyboard panels) through the real shots owner and command
// bus: create, hold, caption, reorder and duplicate keep the stills end to end
// from frame 0, refuse past the frame cap, and land as one history entry each.
import assert from "node:assert/strict";
import { shotsFixture } from "./bus/shots-fixture.mjs";
import { createShot } from "../src/cuts.js";
import { assetIdFromDigest } from "../src/scene-assets.js";
import { reflowStillShots, STILL_HOLD_DEFAULT, STILL_HOLD_MAX } from "../src/shot-authoring.js";

const FULL = "Storyboard is full (28800 frames); shorten a hold or remove a panel.";
const still = (name, start, hold, extra = {}) => ({ ...createShot(name, start, start + hold - 1), kind: "still", ...extra });

// Pure reflow: stills in array order from frame 0, clips untouched.
{
	const clip = { ...createShot("Clip", 500, 539), id: "clip" };
	const out = reflowStillShots([still("A", 10, 5), clip, still("B", 90, 3)]);
	assert.deepEqual(out.map(s => [s.name, s.startFrame, s.endFrame]), [["A", 0, 4], ["B", 5, 7], ["Clip", 500, 539]]);
	assert.equal(out[2], clip, "clip shots are left untouched");
	console.log("PASS reflowStillShots lays stills end to end and leaves clips alone");
}

const f = shotsFixture();
try {
	const camera = f.actual.readStudioState().camera;
	const shots = () => f.live.current.shots;
	const ranges = () => shots().map(s => [s.startFrame, s.endFrame]);
	const byCaption = caption => shots().find(s => s.caption === caption);
	// One command = one entry in the shared history (app-context remember())
	// and one snapshot on the shot store, named by the receipt.
	function once(id, args) {
		const clock = f.scope.appContext.undoClock, depth = f.shots.documentStore.depths().past;
		const receipt = f.run(id, args);
		assert.equal(receipt.ok, true, `${id}: ${JSON.stringify(receipt)}`);
		assert.equal(f.scope.appContext.undoClock, clock + 1, `${id} adds one shared history entry`);
		assert.equal(f.shots.documentStore.depths().past, depth + 1, `${id} adds one shot snapshot`);
		assert.equal(receipt.undo.entries, 1);
		assert.equal(f.scope.appContext.historyEntry(), receipt.undo.historyEntryId);
		return receipt;
	}
	function refused(id, args, code, message) {
		const before = f.snapshot(), clock = f.scope.appContext.undoClock;
		const receipt = f.run(id, args, "agent");
		assert.equal(receipt.ok, false, `${id} must be refused`);
		assert.equal(receipt.code, code, JSON.stringify(receipt));
		if (message) assert.equal(receipt.message, message);
		assert.deepEqual(f.snapshot(), before, `${id} leaves the document unchanged`);
		assert.equal(f.scope.appContext.undoClock, clock);
		return receipt;
	}

	f.shots.load({ shots: [], frameCount: 120, camera });
	for (const caption of ["One", "Two", "Three"]) once("shot.createStill", { caption });
	assert.deepEqual(ranges(), [[0, 47], [48, 95], [96, 143]]);
	assert.ok(shots().every(s => s.kind === "still" && s.cameraKeys.length === 1 && s.cameraKeys[0].frame === s.startFrame), "each still is keyed with the current framing at its start");
	assert.equal(f.live.current.timeline.frameCount, 144);
	assert.equal(STILL_HOLD_DEFAULT, 48);
	console.log("PASS createStill x3 -> [0,47] [48,95] [96,143], one history entry each");

	once("shot.setHold", { shotId: byCaption("Two").id, hold: 24 });
	assert.deepEqual(ranges(), [[0, 47], [48, 71], [72, 119]]);
	console.log("PASS setHold(second, 24) -> [48,71] [72,119]");

	const reordered = once("shot.reorder", { shotId: byCaption("Three").id, index: 0 });
	assert.deepEqual(shots().map(s => [s.caption, s.startFrame, s.endFrame]), [["Three", 0, 47], ["One", 48, 95], ["Two", 96, 119]]);
	assert.equal(byCaption("Three").cameraKeys[0].frame, 0, "camera keys travel with the still");
	console.log("PASS reorder(third, 0) -> it starts at 0 and the others shift");

	assert.equal(f.run("edit.undo", { receiptId: reordered.receiptId }).status, "undone");
	assert.deepEqual(ranges(), [[0, 47], [48, 71], [72, 119]], "one undo restores the whole reorder");
	assert.deepEqual(shots().map(s => s.caption), ["One", "Two", "Three"]);
	console.log("PASS one Undo reverts a reorder and its reflow together");

	once("shot.setCaption", { shotId: byCaption("One").id, caption: "  Two at a table  " });
	assert.equal(shots()[0].caption, "Two at a table", "captions are trimmed");

	// Give the first still a per-shot cast and a stylized frame, then copy it.
	const asset = assetIdFromDigest("ab".repeat(32));
	const cast = { "actor-a": { x: 1, z: 2, rot: 90, posture: "sit" } };
	f.shots.load({ shots: shots().map((s, i) => i === 0 ? { ...s, cast, stylizedAssetId: asset } : s), frameCount: 144, camera });
	const source = shots()[0];
	once("shot.duplicate", { shotId: source.id });
	assert.equal(shots().length, 4);
	const copy = shots()[1];
	assert.notEqual(copy.id, source.id);
	assert.deepEqual([copy.kind, copy.caption, copy.cast, copy.stylizedAssetId], ["still", "Two at a table", cast, asset]);
	assert.deepEqual(copy.camera, source.camera);
	assert.deepEqual(ranges(), [[0, 47], [48, 95], [96, 119], [120, 167]]);
	assert.equal(f.live.current.timeline.frameCount, 168);
	console.log("PASS duplicate keeps caption/cast/stylizedAssetId and inserts after the source");

	refused("shot.setHold", { shotId: copy.id, hold: 0 }, "INVALID_ARGUMENT");
	refused("shot.setHold", { shotId: copy.id, hold: STILL_HOLD_MAX + 1 }, "INVALID_ARGUMENT");
	refused("shot.createStill", { hold: 0 }, "INVALID_ARGUMENT");
	refused("shot.createStill", { hold: 241 }, "INVALID_ARGUMENT");
	once("shot.setHold", { shotId: copy.id, hold: STILL_HOLD_MAX });
	console.log("PASS a hold of 0 or 241 is refused; 240 is accepted");

	// A clip is not a still: no hold, no still order.
	f.shots.load({ shots: [{ ...createShot("Clip", 0, 23), id: "clip-a" }], frameCount: 144, camera });
	refused("shot.setHold", { shotId: "clip-a", hold: 12 }, "INVALID_ARGUMENT");
	refused("shot.reorder", { shotId: "clip-a", index: 0 }, "INVALID_ARGUMENT");
	refused("shot.reorder", { shotId: "clip-a" }, "INVALID_ARGUMENT", "shot.reorder takes exactly one of startFrame or index.");
	refused("shot.reorder", { shotId: "clip-a", index: 0, startFrame: 4 }, "INVALID_ARGUMENT", "shot.reorder takes exactly one of startFrame or index.");
	refused("shot.createStill", {}, "TARGET_NOT_READY");
	console.log("PASS clip shots refuse hold/index and stills never overlap a clip");

	// 120 stills x 240 frames = 28800, the timeline cap: anything more is refused.
	const panels = Array.from({ length: 120 }, (_, i) => still(`P${i}`, i * 240, i === 119 ? 200 : 240));
	f.shots.load({ shots: panels, frameCount: 28800, camera });
	once("shot.setHold", { shotId: shots()[119].id, hold: 240 });
	assert.equal(shots()[119].endFrame, 28799);
	assert.equal(f.live.current.timeline.frameCount, 28800);
	refused("shot.createStill", { hold: 1 }, "INVALID_ARGUMENT", FULL);
	refused("shot.duplicate", { shotId: shots()[0].id }, "INVALID_ARGUMENT", FULL);
	f.shots.load({ shots: panels, frameCount: 28800, camera });
	refused("shot.createStill", { hold: 41 }, "INVALID_ARGUMENT", FULL);
	once("shot.createStill", { hold: 40 });
	assert.equal(shots().at(-1).endFrame, 28799);
	console.log(`PASS the frame-cap refusal appears past 28800 frames: "${FULL}"`);
} finally { f.dispose(); }

// In a storyboard project shot.create adds a still (delegates to createStill).
const g = shotsFixture();
try {
	const unregister = g.scope.appContext.registerStoreDomain("scenes", { metadata: () => ({ previsMode: "storyboard" }), document: () => ({}) });
	g.shots.load({ shots: [], frameCount: 120, camera: g.actual.readStudioState().camera });
	g.live.current.timeline.currentFrame = 30;
	for (let i = 0; i < 2; i++) assert.equal(g.run("shot.create").ok, true);
	assert.deepEqual(g.live.current.shots.map(s => [s.kind, s.startFrame, s.endFrame]), [["still", 0, 47], ["still", 48, 95]]);
	unregister();
	assert.equal(g.run("shot.create").ok, true);
	assert.equal(g.live.current.shots.find(s => s.kind === "clip")?.startFrame, 96, "an animation project still adds a clip at the playhead's free gap");
	console.log("PASS shot.create adds a still in a storyboard project and a clip otherwise");
} finally { g.dispose(); }

console.log("still shots verified");

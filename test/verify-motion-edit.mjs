import assert from "node:assert/strict";
import { CSKEL27_JOINTS } from "../src/ardy/cskel27.js";
import {
	createMotionEdit,
	motionEditDuration,
	motionFrameToTimelineFrame,
	remapFrameKeyMap,
	remapTimelineFrame,
	motionSegmentSpeedForFrames,
	removeMotionSegment,
	renderMotionEdit,
	setMotionSegmentSpeed,
	splitMotionEdit,
	timelineFrameToMotionFrame,
	trimMotionEdit,
} from "../src/ardy/motion-edit.js";

function pass(label) { console.log(`PASS ${label}`); }
function near(actual, expected, tolerance = 0.01) {
	assert.ok(Math.abs(actual - expected) <= tolerance, `${actual} vs ${expected}`);
}

function linearMotion(frames) {
	const joints = CSKEL27_JOINTS.length;
	const rotMats = new Float32Array(frames * joints * 9);
	const rootPos = new Float32Array(frames * 3);
	const posedJoints = new Float32Array(frames * joints * 3);
	for (let frame = 0; frame < frames; frame += 1) {
		for (let joint = 0; joint < joints; joint += 1) {
			const r = (frame * joints + joint) * 9;
			rotMats[r] = 1;
			rotMats[r + 4] = 1;
			rotMats[r + 8] = 1;
			const p = (frame * joints + joint) * 3;
			posedJoints[p] = frame;
		}
		rootPos[frame * 3] = frame;
	}
	return { frames, fps: 24, rotMats, rootPos, posedJoints };
}

{
	const edit = createMotionEdit(240);
	assert.deepEqual(edit, [{ id: "motion-0", sourceStart: 0, sourceEnd: 239, speed: 1 }]);
	assert.equal(motionEditDuration(edit), 240);
	assert.equal(timelineFrameToMotionFrame(edit, 0), 0);
	assert.equal(timelineFrameToMotionFrame(edit, 239), 239);
	pass("an untouched take is one 1x segment with identity sampling");
}

{
	const split = splitMotionEdit(createMotionEdit(240), 96);
	assert.deepEqual(split.map(({ sourceStart, sourceEnd, speed }) => ({ sourceStart, sourceEnd, speed })), [
		{ sourceStart: 0, sourceEnd: 95, speed: 1 },
		{ sourceStart: 96, sourceEnd: 239, speed: 1 },
	]);
	assert.equal(splitMotionEdit(split, 0), split);
	assert.equal(splitMotionEdit(split, 240), split);
	assert.equal(splitMotionEdit(split, 96), split);
	pass("cutting at the playhead creates a non-destructive source boundary once");
}

{
	const split = splitMotionEdit(createMotionEdit(240), 96);
	const slow = setMotionSegmentSpeed(split, split[1].id, 0.5);
	assert.equal(motionEditDuration(slow), 96 + 288);
	assert.equal(timelineFrameToMotionFrame(slow, 95), 95);
	assert.equal(timelineFrameToMotionFrame(slow, 96), 96);
	near(timelineFrameToMotionFrame(slow, 97), 96.5);
	assert.equal(timelineFrameToMotionFrame(slow, 383), 239);
	pass("a 0.5x segment doubles only its own timeline duration");
}

{
	const edit = [
		{ id: "a", sourceStart: 0, sourceEnd: 47, speed: 2 },
		{ id: "b", sourceStart: 48, sourceEnd: 95, speed: 0.25 },
	];
	assert.equal(motionEditDuration(edit), 24 + 192);
	assert.equal(timelineFrameToMotionFrame(edit, 23), 47);
	assert.equal(timelineFrameToMotionFrame(edit, 24), 48);
	assert.equal(timelineFrameToMotionFrame(edit, 215), 95);
	pass("fast and slow segments join without skipping their seam poses");
}

{
	const split = splitMotionEdit(createMotionEdit(240), 96);
	const slow = setMotionSegmentSpeed(split, split[1].id, 0.5);
	const trimmed = trimMotionEdit(slow, 48, 239);
	assert.deepEqual(trimmed.map(({ sourceStart, sourceEnd, speed }) => ({ sourceStart, sourceEnd, speed })), [
		{ sourceStart: 48, sourceEnd: 95, speed: 1 },
		{ sourceStart: 96, sourceEnd: 167, speed: 0.5 },
	]);
	assert.equal(motionEditDuration(trimmed), 48 + 144);
	pass("outer trim handles preserve cuts and speed inside the kept range");
}

{
	const edit = createMotionEdit(20);
	for (const speed of [0, -1, 8.1, Number.NaN]) {
		assert.throws(() => setMotionSegmentSpeed(edit, edit[0].id, speed), /setMotionSegmentSpeed:/);
	}
	const decimal = setMotionSegmentSpeed(edit, edit[0].id, 0.7);
	assert.equal(decimal[0].speed, 0.7);
	assert.equal(setMotionSegmentSpeed(edit, edit[0].id, 0.66)[0].speed, 0.7);
	assert.equal(setMotionSegmentSpeed(edit, edit[0].id, 1.01)[0].speed, 1);
	pass("speed accepts continuous 0.1x steps and rejects off-grid values");
}

{
	const split = splitMotionEdit(createMotionEdit(4), 2);
	const slowed = setMotionSegmentSpeed(split, split[1].id, 0.5);
	const rendered = renderMotionEdit(linearMotion(4), slowed);
	assert.equal(rendered.frames, 6);
	assert.equal(rendered.rootPos[0], 0);
	assert.equal(rendered.rootPos[3], 1);
	assert.equal(rendered.rootPos[6], 2);
	near(rendered.rootPos[9], 2.5);
	assert.equal(rendered.rootPos[12], 3);
	assert.equal(rendered.rootPos[15], 3);
	pass("rendering a slow segment creates a normal 24 fps clip for every consumer");
}

{
	const split = splitMotionEdit(splitMotionEdit(createMotionEdit(240), 60), 180);
	assert.equal(split.length, 3);
	const removed = removeMotionSegment(split, split[1].id);
	assert.deepEqual(removed.map(({ sourceStart, sourceEnd }) => ({ sourceStart, sourceEnd })), [
		{ sourceStart: 0, sourceEnd: 59 },
		{ sourceStart: 180, sourceEnd: 239 },
	]);
	assert.equal(motionEditDuration(removed), 120);
	// the source stays intact: rendering after removal still samples the original frames
	const rendered = renderMotionEdit(linearMotion(240), removed);
	near(rendered.rootPos[0], 0);
	near(rendered.rootPos[60 * 3], 180);
	// guards: unknown id and the final segment are both no-ops
	assert.equal(removeMotionSegment(removed, "nope"), removed);
	const only = createMotionEdit(240);
	assert.equal(removeMotionSegment(only, only[0].id), only);
	pass("removing a segment deletes its span and keeps the source restorable");
}

{
	const [segment] = createMotionEdit(240);
	assert.equal(motionSegmentSpeedForFrames(segment, 240), 1);
	assert.equal(motionSegmentSpeedForFrames(segment, 480), 0.5);
	assert.equal(motionSegmentSpeedForFrames(segment, 120), 2);
	// clamped to the numeric input's own range and 0.1 grid
	assert.equal(motionSegmentSpeedForFrames(segment, 1), 4);
	assert.equal(motionSegmentSpeedForFrames(segment, 100000), 0.1);
	assert.equal(motionSegmentSpeedForFrames(segment, 230), 1);
	// a resized width round-trips through the speed it produced
	const speed = motionSegmentSpeedForFrames(segment, 300);
	assert.equal(speed, 0.8);
	pass("stretch widths map onto the clamped 0.1x speed grid");
}

/* -------------------- timeline pin migration (#79) -------------------- */
{
	// 96-frame take, one segment slowed to 0.5x -> 192 timeline frames.
	const identity = createMotionEdit(96);
	const slowed = setMotionSegmentSpeed(identity, identity[0].id, 0.5);
	assert.equal(motionEditDuration(slowed), 192);
	assert.equal(remapTimelineFrame(identity, slowed, 0), 0);
	assert.equal(remapTimelineFrame(identity, slowed, 95), 191, "the last frame maps to the last frame");
	near(remapTimelineFrame(identity, slowed, 40), 80, 1.01);
	pass("a slowdown moves pinned frames proportionally");

	// keys after an edited segment shift by the length delta
	const cutAt = splitMotionEdit(identity, 48);
	assert.equal(cutAt.length, 2);
	const slowFirst = setMotionSegmentSpeed(cutAt, cutAt[0].id, 0.5);
	const shifted = remapTimelineFrame(cutAt, slowFirst, 80);
	assert.equal(shifted, 80 + 48, "a key past the slowed segment shifts by the added frames");
	assert.equal(remapTimelineFrame(cutAt, slowFirst, 20), 40, "a key inside the slowed segment scales");
	pass("trailing pins shift by the segment's length delta");

	// a cut with no timing change is an identity mapping
	for (const frame of [0, 24, 47, 48, 60, 95]) {
		assert.equal(remapTimelineFrame(identity, cutAt, frame), frame);
	}
	pass("a pure cut migrates nothing");

	// deleting a segment drops the keys whose source is gone
	const removed = removeMotionSegment(cutAt, cutAt[0].id);
	assert.equal(remapTimelineFrame(cutAt, removed, 20), null, "keys in the deleted segment drop");
	assert.equal(remapTimelineFrame(cutAt, removed, 70), 70 - 48, "keys after it slide left");
	pass("segment deletion drops orphaned pins and slides the rest");

	// map migration: values ride along; a speed-up collision keeps the FIRST key
	const doubled = setMotionSegmentSpeed(identity, identity[0].id, 2);
	const keys = new Map([[40, "a"], [41, "b"], [90, "c"]]);
	const migrated = remapFrameKeyMap(keys, identity, doubled);
	assert.equal(migrated.get(20), "a", "the earlier key wins the collision slot");
	assert.equal(migrated.get(45), "c");
	assert.equal(migrated.size, 2, "collided keys are not duplicated");
	pass("remapFrameKeyMap migrates values and resolves collisions first-wins");

	// round trip: slow then restore -> keys return to their original frames
	const back = remapFrameKeyMap(remapFrameKeyMap(new Map([[13, 1], [64, 2], [95, 3]]), identity, slowed), slowed, identity);
	assert.deepEqual([...back.keys()], [13, 64, 95]);
	pass("a retime and its reset round-trip every key home");

	// inverse sanity
	assert.equal(motionFrameToTimelineFrame(slowed, 0), 0);
	assert.equal(motionFrameToTimelineFrame(slowed, 95), 191);
	assert.equal(motionFrameToTimelineFrame(removed, 10), null, "deleted source frames have no timeline home");
	pass("motionFrameToTimelineFrame inverts the sampling map");
}

/* --------------------------- App wiring pins --------------------------- */
{
	const { motionFixture, seedMotion } = await import('./bus/motion-fixture.mjs');
	const f = motionFixture();
	const ok = receipt => { assert.equal(receipt.ok, true, JSON.stringify(receipt)); return receipt; };
	try {
		f.motion.load([{ id: 'actor-a', take: seedMotion(48) }]);
		ok(f.run('ik.setKey', { characterId: 'actor-a', frame: 24, tracks: { head: { q: [{ x: 0, y: 0, z: 0, w: 1 }] } } }));
		ok(f.run('character.setPromptBlocks', { characterId: 'actor-a', blocks: [{ id: 'pin', startFrame: 12, endFrame: 36, text: 'Pinned' }] }));
		const frames = () => f.motion.layer('actor-a').ikKeys.map(row => row.frame);
		const clips = () => f.cast.read()[0].layer.promptClips;
		ok(f.motion.applyMotionTrim(12, 47));
		assert.deepEqual(frames(), [12], 'trims migrate keys instead of clearing them');
		assert.equal(clips()[0].startFrame, 0); assert.equal(clips()[0].endFrame, 24);
		ok(f.motion.resetMotionTrim());
		assert.deepEqual(frames(), [24], 'reset rides surviving keys home');
		assert.equal(clips()[0].startFrame, 12); assert.equal(clips()[0].endFrame, 36);
		const segment = f.motion.motionFor('actor-a').editSegments[0];
		ok(f.motion.changeMotionSegmentSpeed(segment.id, 0.5));
		assert.deepEqual(frames(), [49], 'segment speed maps frame 24 of [0,47] onto [0,95]');
		assert.equal(clips()[0].startFrame, 24); assert.equal(clips()[0].endFrame, 73);
		pass('UI trim, reset and segment speed retain IK keys and prompt pins through owned commands');
	} finally { f.dispose(); }
}

console.log("verify-motion-edit: all checks passed");

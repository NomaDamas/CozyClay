/**
 * 3D PINS (순간 찍기) — the third line-edit gesture, end to end on the pure side.
 *
 * A pin is "this joint is exactly HERE at this moment": one frame, one world
 * point, and nothing said about the frames around it. That is the sparse end of
 * the same axis a drawn line sits at the dense end of, and it is the end
 * ProjFlow was actually measured on — its whole spatial-control table is 1, 2,
 * 5, 49 and 196 keyframes with exact satisfaction, the flow prior filling the
 * gaps. So the machinery a stroke needs (a camera, a frame association, a
 * timing rule, a seam ease) is all absent here, and the things that replace it
 * are what this file pins down:
 *
 *   1. THE RANGE IS DERIVED from the pins (pinsFrameRange) — nobody types
 *      numbers, exactly as nobody types them for a drawn stroke.
 *   2. THE WIRE RULES are shared with the drawn path (validateLineEditFields in
 *      tools/projflow/replay.mjs), so a pins edit stored in a recipe validates
 *      on the C10 replay path for free.
 *   3. THE CLOCK. Pins scale 24 -> 20 fps with the SAME rounding rule the range
 *      uses, or a pin lands outside the range that contains it.
 *   4. THE SCREEN-TO-WORLD step (unprojectDeltaC6) keeps the joint's own depth,
 *      which is the only reading of a 2D drag that does not invent one.
 *
 * Pure node, no DOM and no GPU: `node test/verify-line-edit-pins.mjs`.
 */
import assert from "node:assert/strict";
import {
	LINE_EDIT_PINS_MAX,
	LINE_EDIT_PINS_MIN,
	PIN_CONTEXT_FRAMES,
	PIN_SOLO_WINDOW_FRAMES,
	cameraToC6,
	pinsFrameRange,
	projectPointC6,
	projectTrailCurve,
	reprojectCurveWorld,
	unprojectDeltaC6,
	upsertPin,
	validateLineEdit,
} from "../src/line-edit.js";
import { validateLineEditFields } from "../tools/projflow/replay.mjs";
import { scalePins, toGenFrames, scaleFrameRange } from "../tools/projflow/line-edit-job.mjs";

let passed = 0;
// AWAITS, unlike the sibling draw file's helper: the job check below is async,
// and a non-awaiting harness would print "ok" for a test whose assertions had
// not run yet — which is exactly what it did on the first draft.
const test = async (name, fn) => {
	try {
		await fn();
		passed += 1;
		console.log(`  ok  ${name}`);
	} catch (err) {
		console.error(`  FAIL  ${name}`);
		console.error(err?.stack || err);
		process.exitCode = 1;
	}
};

const pin = (frame, position = [0.1, 1.2, -0.3]) => ({ frame, position });
/** A complete, valid pins payload — the thing the app actually sends. */
const payload = (overrides = {}) => ({
	sourceMotion: "/ardy/motions/1787999132404-498158",
	track: "head",
	frameRange: { startFrame: 82, endFrame: 118 },
	pins3d: [pin(100)],
	prompt: "a person falls backwards",
	...overrides,
});

console.log("pinsFrameRange — the pins choose the frames");

await test("a single pin gets a window of about 1.5 s centred on it", () => {
	const range = pinsFrameRange([pin(100)], 192);
	assert.equal(range.endFrame - range.startFrame, PIN_SOLO_WINDOW_FRAMES);
	assert.equal(range.startFrame, 82);
	assert.equal(range.endFrame, 118);
	// The pin is INSIDE its own half-open range — the wire checks this and a
	// range that excluded its pin would be refused as self-contradictory.
	assert.ok(100 >= range.startFrame && 100 < range.endFrame);
});

await test("two pins span themselves plus half a second of context each side", () => {
	const range = pinsFrameRange([pin(60), pin(96)], 192);
	assert.equal(range.startFrame, 60 - PIN_CONTEXT_FRAMES);
	assert.equal(range.endFrame, 97 + PIN_CONTEXT_FRAMES);
	for (const frame of [60, 96]) assert.ok(frame >= range.startFrame && frame < range.endFrame);
});

await test("a pin near the clip's edge slides its window in rather than off", () => {
	const head = pinsFrameRange([pin(3)], 192);
	assert.equal(head.startFrame, 0);
	assert.equal(head.endFrame, PIN_SOLO_WINDOW_FRAMES);
	assert.ok(3 >= head.startFrame && 3 < head.endFrame);
	const tail = pinsFrameRange([pin(190)], 192);
	assert.equal(tail.endFrame, 192);
	assert.equal(tail.startFrame, 192 - PIN_SOLO_WINDOW_FRAMES);
	assert.ok(190 >= tail.startFrame && 190 < tail.endFrame);
});

await test("a clip shorter than the window is clipped, and every pin still fits", () => {
	const range = pinsFrameRange([pin(5)], 12);
	assert.equal(range.startFrame, 0);
	assert.equal(range.endFrame, 12);
	// The invariant that matters at every clip length: the pin is inside.
	for (let clip = 2; clip <= 60; clip += 1) {
		for (const frame of [0, 1, Math.floor(clip / 2), clip - 1]) {
			const r = pinsFrameRange([pin(frame)], clip);
			assert.ok(r, `no range for pin ${frame} in a ${clip}-frame clip`);
			assert.ok(r.startFrame >= 0 && r.endFrame <= clip, `range ${r.startFrame}..${r.endFrame} leaves a ${clip}-frame clip`);
			assert.ok(frame >= r.startFrame && frame < r.endFrame, `pin ${frame} outside ${r.startFrame}..${r.endFrame}`);
		}
	}
});

await test("no pins, or no clip, is no range", () => {
	assert.equal(pinsFrameRange([], 192), null);
	assert.equal(pinsFrameRange(null, 192), null);
	assert.equal(pinsFrameRange([pin(0)], 1), null);
	assert.equal(pinsFrameRange([pin(0)], undefined), null);
});

console.log("upsertPin — placing, replacing, capping");

await test("pinning the same frame twice REPLACES rather than stacking", () => {
	const first = upsertPin([], pin(100, [0, 1, 0]));
	const second = upsertPin(first, pin(100, [0, 2, 0]));
	assert.equal(second.length, 1);
	assert.deepEqual(second[0].position, [0, 2, 0]);
	// ...and the input is untouched, like every other edit in this module.
	assert.deepEqual(first[0].position, [0, 1, 0]);
});

await test("pins come back sorted by frame however they were placed", () => {
	let pins = [];
	for (const frame of [140, 20, 90, 5]) pins = upsertPin(pins, pin(frame));
	assert.deepEqual(pins.map((p) => p.frame), [5, 20, 90, 140]);
});

await test("over the cap the OLDEST pin is dropped, never the new one", () => {
	let pins = [];
	for (let i = 0; i <= LINE_EDIT_PINS_MAX; i += 1) pins = upsertPin(pins, pin(i * 10));
	assert.equal(pins.length, LINE_EDIT_PINS_MAX);
	// The gesture just made must always be visible in the result.
	assert.equal(pins[pins.length - 1].frame, LINE_EDIT_PINS_MAX * 10);
	assert.equal(pins[0].frame, 10, "the earliest pin is the one that goes");
});

await test("garbage is refused by identity, so the caller's list survives", () => {
	const pins = [pin(10)];
	assert.equal(upsertPin(pins, null), pins);
	assert.equal(upsertPin(pins, { frame: 1.5, position: [0, 0, 0] }), pins);
	assert.equal(upsertPin(pins, { frame: 10, position: [0, 0] }), pins);
	assert.equal(upsertPin(pins, { frame: 10, position: [0, Number.NaN, 0] }), pins);
	assert.equal(LINE_EDIT_PINS_MIN, 1, "one pin is a legal edit — a line needs two points, a pin needs none");
});

console.log("validation — the app gate and the wire gate agree");

/** Both validators must accept/refuse the same payload; only the message
 * wording differs (one is localized copy, one is a wire string). */
const bothAgree = (body, { valid }) => {
	const app = validateLineEdit(body, { clipFrames: 192 });
	const wire = validateLineEditFields(body, 192, "lineEdit");
	if (valid) {
		assert.equal(app, null, `app validator refused a valid payload: ${app?.message}`);
		assert.equal(wire, null, `wire validator refused a valid payload: ${wire}`);
	} else {
		assert.ok(app, "the app validator must refuse");
		assert.ok(wire, "the wire validator must refuse");
	}
	return { app, wire };
};

await test("a well-formed pins payload passes both gates", () => {
	bothAgree(payload(), { valid: true });
	bothAgree(payload({ pins3d: [pin(90), pin(100), pin(110)] }), { valid: true });
});

await test("pins and points2d together are refused — one edit is one gesture", () => {
	const { wire } = bothAgree(payload({ points2d: [[0.2, 0.2], [0.8, 0.8]] }), { valid: false });
	assert.match(wire, /either points2d .* or pins3d/);
});

await test("a camera beside pins is refused rather than ignored", () => {
	const camera = cameraToC6({ fovDeg: 45, aspect: 16 / 9, matrixWorldInverse: identityView(), width: 1600, height: 900 });
	const { wire } = bothAgree(payload({ camera }), { valid: false });
	assert.match(wire, /camera' must be omitted/);
});

await test("frames must be strictly ascending", () => {
	bothAgree(payload({ pins3d: [pin(110), pin(90)] }), { valid: false });
	const { wire } = bothAgree(payload({ pins3d: [pin(100), pin(100)] }), { valid: false });
	assert.match(wire, /strictly ascending/);
});

await test("a pin outside its own frameRange is refused", () => {
	bothAgree(payload({ pins3d: [pin(200)] }), { valid: false });
	// endFrame is EXCLUSIVE: a pin on it names a frame the splice throws away.
	const { wire } = bothAgree(payload({ frameRange: { startFrame: 82, endFrame: 118 }, pins3d: [pin(118)] }), { valid: false });
	assert.match(wire, /outside frameRange/);
	bothAgree(payload({ frameRange: { startFrame: 82, endFrame: 118 }, pins3d: [pin(117)] }), { valid: true });
});

await test("the count is bounded at both ends", () => {
	bothAgree(payload({ pins3d: [] }), { valid: false });
	const many = Array.from({ length: LINE_EDIT_PINS_MAX + 1 }, (_, i) => pin(90 + i));
	const { wire } = bothAgree(payload({ frameRange: { startFrame: 82, endFrame: 118 }, pins3d: many }), { valid: false });
	assert.match(wire, new RegExp(`capped at ${LINE_EDIT_PINS_MAX} pins`));
});

await test("malformed pin entries are named individually", () => {
	bothAgree(payload({ pins3d: [{ position: [0, 0, 0] }] }), { valid: false });
	bothAgree(payload({ pins3d: [{ frame: 100.5, position: [0, 0, 0] }] }), { valid: false });
	bothAgree(payload({ pins3d: [{ frame: 100, position: [0, 0] }] }), { valid: false });
	const { wire } = bothAgree(payload({ pins3d: [{ frame: 100, position: [0, Number.POSITIVE_INFINITY, 0] }] }), { valid: false });
	assert.match(wire, /pins3d\[0\]\.position/);
});

await test("a DRAWN payload still validates exactly as before — no message drifted", () => {
	const camera = cameraToC6({ fovDeg: 45, aspect: 16 / 9, matrixWorldInverse: identityView(), width: 1600, height: 900 });
	const drawn = {
		sourceMotion: "/ardy/motions/x",
		track: "leftHand",
		frameRange: { startFrame: 10, endFrame: 40 },
		points2d: [[0.2, 0.2], [0.8, 0.8]],
		camera,
		prompt: "p",
	};
	assert.equal(validateLineEdit(drawn, { clipFrames: 192 }), null);
	assert.equal(validateLineEditFields(drawn, 192, "lineEdit"), null);
	// The one message a pins payload could have hijacked: a drawn edit with too
	// few points must still be told about POINTS, not about pins.
	assert.match(
		validateLineEditFields({ ...drawn, points2d: [[0.2, 0.2]] }, 192, "lineEdit"),
		/points2d' needs at least 2 points/,
	);
});

await test("a pinned edit survives into a take's recipe and validates as a C10 replay entry", async () => {
	// The payoff of sharing one validator: pins flow into recipes and out onto
	// the replay path with no code of their own. The one thing that was NOT free
	// is the whitelist in take-recipe.js — a key missing from REPLAY_KEYS drops
	// the pin silently and the regenerated take quietly loses the refinement.
	const { freshRecipe, withLineEdit, replayPayload } = await import("../src/take-recipe.js");
	const { validateReplay } = await import("../tools/projflow/replay.mjs");
	const stored = withLineEdit(
		freshRecipe({ seed: 1, blocks: [{ prompt: "a person falls backwards", duration: 8 }] }),
		{ ...payload(), seed: 7 },
	);
	const replay = replayPayload(stored);
	assert.equal(replay.length, 1);
	assert.deepEqual(replay[0].pins3d, payload().pins3d, "the pins must survive the recipe whitelist");
	assert.equal(replay[0].sourceMotion, undefined, "replay rebinds the source");
	assert.equal(validateReplay({ replay }, 192), null);
});

console.log("the clock — pins scale like the range that holds them");

await test("a pin claims the generation frames its app frame is REBUILT from", () => {
	// Not a rounding, a BRACKET. retimeMotion rebuilds app frame f from gen
	// floor(f*20/24) and the next, blended; app 100 sits at gen 83.33, so both
	// 83 and 84 have to hold the pin or the blend averages it away. Measured
	// before this rule: the box was exact at gen 83 (9.5e-7 m) and the finished
	// take still missed the pin by 27 cm.
	const genFrames = toGenFrames(192);
	assert.equal(genFrames, 160);
	assert.deepEqual(scalePins([pin(100)], genFrames).map((p) => p.frame), [83, 84]);
	// One app frame in six lands exactly on a generation frame and needs no
	// second: 6 * 20/24 = 5 exactly.
	assert.deepEqual(scalePins([pin(6)], genFrames).map((p) => p.frame), [5]);
	assert.deepEqual(scalePins([pin(0)], genFrames).map((p) => p.frame), [0]);
	// Every emitted frame carries the SAME position — a bracket is one statement
	// said twice, not two statements.
	const bracket = scalePins([pin(100, [1, 2, 3])], genFrames);
	for (const p of bracket) assert.deepEqual(p.position, [1, 2, 3]);
	// The invariant that makes it safe: every emitted frame is inside the scaled
	// range (driver.py refuses the edit otherwise), checked exhaustively over
	// every app frame of a real clip.
	for (let frame = 0; frame < 192; frame += 1) {
		const range = pinsFrameRange([pin(frame)], 192);
		const gen = scaleFrameRange(range, genFrames);
		for (const scaledPin of scalePins([pin(frame)], genFrames)) {
			assert.ok(
				scaledPin.frame >= gen.start && scaledPin.frame <= gen.end,
				`app frame ${frame} -> gen ${scaledPin.frame} escapes gen range ${gen.start}..${gen.end}`,
			);
		}
	}
	// And the output is always strictly ascending, which both the driver and the
	// wire validator require.
	for (let frame = 0; frame < 192; frame += 1) {
		const out = scalePins([pin(frame)], genFrames);
		for (let i = 1; i < out.length; i += 1) assert.ok(out[i].frame > out[i - 1].frame);
	}
});

await test("positions ride through the clock change untouched", () => {
	const [scaled] = scalePins([pin(100, [1.5, -2.25, 0.125])], 160);
	assert.deepEqual(scaled.position, [1.5, -2.25, 0.125]);
});

await test("brackets that overlap collapse to one row per frame, last pin wins", () => {
	// Adjacent app pins share a bracket frame; two rows on one frame would be
	// two contradictory answers for the ridge to average into a third.
	const scaled = scalePins([pin(100, [0, 0, 0]), pin(101, [9, 9, 9])], 160);
	const frames = scaled.map((p) => p.frame);
	assert.deepEqual(frames, [...new Set(frames)], "one row per generation frame");
	assert.deepEqual([...frames].sort((a, b) => a - b), frames, "still ascending");
	// 100 -> {83, 84}, 101 -> {84, 85}: the shared 84 belongs to the LATER pin.
	assert.deepEqual(frames, [83, 84, 85]);
	assert.deepEqual(scaled.find((p) => p.frame === 84).position, [9, 9, 9], "the later pin wins");
	assert.deepEqual(scaled.find((p) => p.frame === 83).position, [0, 0, 0]);
});

await test("scalePins refuses rubbish rather than shipping it to the box", () => {
	assert.throws(() => scalePins([], 160), /non-empty/);
	assert.throws(() => scalePins(null, 160), /non-empty/);
	assert.throws(() => scalePins([{ frame: 1.5, position: [0, 0, 0] }], 160), /is not a \{ frame, position/);
	assert.throws(() => scalePins([{ frame: 1, position: [0, 0] }], 160), /is not a \{ frame, position/);
});

console.log("unprojectDeltaC6 — the screen drag becomes a 3D target");

/** three's matrixWorldInverse for a camera at (0, 1.4, 4) looking down -Z. */
function identityView() {
	// Column-major, translation in the last column: world -> camera is a pure
	// translation for an unrotated camera.
	return [
		1, 0, 0, 0,
		0, 1, 0, 0,
		0, 0, 1, 0,
		0, -1.4, -4, 1,
	];
}

await test("dragging by du/dv lands the point exactly under the pointer", () => {
	const camera = cameraToC6({ fovDeg: 45, aspect: 16 / 9, matrixWorldInverse: identityView(), width: 1600, height: 900 });
	const point = [0.3, 1.1, -0.6];
	const before = projectPointC6(camera, ...point);
	const [du, dv] = [0.08, -0.05];
	const delta = unprojectDeltaC6(camera, point, du, dv);
	assert.ok(delta);
	const moved = [point[0] + delta[0], point[1] + delta[1], point[2] + delta[2]];
	const after = projectPointC6(camera, ...moved);
	// THE claim: the joint follows the pointer, to float precision.
	assert.ok(Math.abs(after[0] - (before[0] + du)) < 1e-9, `u landed at ${after[0]}, wanted ${before[0] + du}`);
	assert.ok(Math.abs(after[1] - (before[1] + dv)) < 1e-9, `v landed at ${after[1]}, wanted ${before[1] + dv}`);
});

await test("the drag keeps the point's own DEPTH — it slides, it does not dolly", () => {
	const camera = cameraToC6({ fovDeg: 45, aspect: 16 / 9, matrixWorldInverse: identityView(), width: 1600, height: 900 });
	const point = [0, 1.2, -1];
	const delta = unprojectDeltaC6(camera, point, 0.2, 0.2);
	const depth = (p) => camera.R[6] * p[0] + camera.R[7] * p[1] + camera.R[8] * p[2] + camera.t[2];
	const moved = [point[0] + delta[0], point[1] + delta[1], point[2] + delta[2]];
	assert.ok(Math.abs(depth(moved) - depth(point)) < 1e-12, "the image-plane drag changed the depth");
});

await test("a farther point moves FARTHER in world for the same screen drag", () => {
	// Perspective, stated as a test: the same pointer travel is more metres when
	// the joint is deeper, which is what makes the drag feel right.
	const camera = cameraToC6({ fovDeg: 45, aspect: 16 / 9, matrixWorldInverse: identityView(), width: 1600, height: 900 });
	const near = unprojectDeltaC6(camera, [0, 1, 2], 0.1, 0);
	const far = unprojectDeltaC6(camera, [0, 1, -6], 0.1, 0);
	assert.ok(Math.hypot(...far) > Math.hypot(...near) * 2);
});

await test("a point at or behind the lens has no image plane to slide in", () => {
	const camera = cameraToC6({ fovDeg: 45, aspect: 16 / 9, matrixWorldInverse: identityView(), width: 1600, height: 900 });
	// Behind the camera (which sits at z = 4 looking down -Z).
	assert.equal(unprojectDeltaC6(camera, [0, 1, 9], 0.1, 0), null);
	assert.equal(unprojectDeltaC6(camera, [0, 1, -1], Number.NaN, 0), null);
	assert.equal(unprojectDeltaC6(null, [0, 1, -1], 0.1, 0), null);
	assert.equal(unprojectDeltaC6(camera, [0, 1], 0.1, 0), null);
});

console.log("reprojectCurveWorld — the drifted ghost is world-anchored, not stale uv");

/** matrixWorldInverse for a camera at (4, 1.4, 0) looking down -X — the same
 * subject as identityView's camera, seen from 90 degrees around. Rows are the
 * camera basis (X=(0,0,-1), Y=(0,1,0), Z=(1,0,0)), translation -R*position. */
function orbitedView() {
	return [
		0, 0, 1, 0,
		0, 1, 0, 0,
		-1, 0, 0, 0,
		0, -1.4, -4, 1,
	];
}

const reprojectFixtures = () => {
	const from = cameraToC6({ fovDeg: 45, aspect: 16 / 9, matrixWorldInverse: identityView(), width: 1600, height: 900 });
	const to = cameraToC6({ fovDeg: 45, aspect: 16 / 9, matrixWorldInverse: orbitedView(), width: 1600, height: 900 });
	// A short trail wandering in front of BOTH cameras (near the origin).
	const trail = new Float32Array([
		-0.4, 1.0, -0.2,
		-0.2, 1.1, -0.1,
		0.0, 1.2, 0.0,
		0.2, 1.1, 0.1,
		0.4, 1.0, 0.2,
	]);
	return { from, to, trail };
};

await test("an UNEDITED curve reprojects onto the trajectory under the new lens", () => {
	const { from, to, trail } = reprojectFixtures();
	const range = { startFrame: 0, endFrame: 5 };
	const authored = projectTrailCurve({ trail, frameRange: range, camera: from });
	const ghost = reprojectCurveWorld(authored, trail, from, to);
	const direct = projectTrailCurve({ trail, frameRange: range, camera: to });
	assert.equal(ghost.length, 5);
	for (let i = 0; i < 5; i += 1) {
		assert.ok(Math.abs(ghost[i].u - direct[i].u) < 1e-9, `frame ${i}: u ${ghost[i].u} vs ${direct[i].u}`);
		assert.ok(Math.abs(ghost[i].v - direct[i].v) < 1e-9, `frame ${i}: v ${ghost[i].v} vs ${direct[i].v}`);
		assert.equal(ghost[i].frame, i);
	}
});

await test("an EDITED point shows its world displacement through the new lens", () => {
	const { from, to, trail } = reprojectFixtures();
	const authored = projectTrailCurve({ trail, frameRange: { startFrame: 0, endFrame: 5 }, camera: from });
	// Pull frame 2 by a known uv offset in the authoring view.
	const [du, dv] = [0.06, -0.04];
	const edited = authored.map((p, i) => (i === 2 ? { ...p, u: p.u + du, v: p.v + dv } : p));
	const ghost = reprojectCurveWorld(edited, trail, from, to);
	// The contract, spelled with the same public building blocks the pin
	// gesture uses: lift the uv offset at the joint's own depth, then look at
	// that WORLD point from the new camera.
	const base = [trail[6], trail[7], trail[8]];
	const delta = unprojectDeltaC6(from, base, du, dv);
	const expected = projectPointC6(to, base[0] + delta[0], base[1] + delta[1], base[2] + delta[2]);
	assert.ok(Math.abs(ghost[2].u - expected[0]) < 1e-9, `u ${ghost[2].u} vs ${expected[0]}`);
	assert.ok(Math.abs(ghost[2].v - expected[1]) < 1e-9, `v ${ghost[2].v} vs ${expected[1]}`);
});

await test("reprojection refuses rubbish and passes nulls through by slot", () => {
	const { from, to, trail } = reprojectFixtures();
	assert.equal(reprojectCurveWorld(null, trail, from, to), null);
	assert.equal(reprojectCurveWorld([], null, from, to), null);
	assert.equal(reprojectCurveWorld([], trail, null, to), null);
	assert.equal(reprojectCurveWorld([], trail, from, null), null);
	const sparse = [null, { frame: 1, u: 0.5, v: 0.5 }, { frame: 99, u: 0.5, v: 0.5 }];
	const out = reprojectCurveWorld(sparse, trail, from, to);
	assert.equal(out.length, 3);
	assert.equal(out[0], null, "a null slot stays null");
	assert.ok(out[1], "a valid slot survives");
	assert.equal(out[2], null, "a frame off the trail's end has no anchor");
});

console.log("the job's pin -> row arithmetic, with the box stubbed out");

await test("runLineEditJob sends pins (not points2d, not a camera) on the generation clock", async () => {
	const { runLineEditJob } = await import("../tools/projflow/line-edit-job.mjs");
	const { mkdtempSync, writeFileSync } = await import("node:fs");
	const { tmpdir } = await import("node:os");
	const { join } = await import("node:path");
	const { motionArraysToNpzMembers, writeNpz } = await import("../tools/ardy/npz.mjs");
	const { NUM_JOINTS, writeNpyFloat32 } = await import("../tools/projflow/generate.mjs");

	// A tiny but REAL take: 48 frames of the CANONICAL cskel27 body drifting
	// forward, so every conversion below runs on the same arrays production uses
	// AND on a skeleton whose bone frames are well-posed. A made-up ladder of
	// points is collinear, and the rotation lift refuses collinear bodies for
	// good reasons that have nothing to do with pins.
	const { canonicalCskel27Reference } = await import("../src/ardy/to-cskel27.js");
	const rest = canonicalCskel27Reference().posed_joints;
	const frames = 48;
	const posedJoints = new Float32Array(frames * 27 * 3);
	for (let f = 0; f < frames; f += 1) {
		for (let j = 0; j < 27; j += 1) {
			posedJoints[(f * 27 + j) * 3] = rest[j][0];
			posedJoints[(f * 27 + j) * 3 + 1] = rest[j][1];
			posedJoints[(f * 27 + j) * 3 + 2] = rest[j][2] + 0.01 * f;
		}
	}
	const rotMats = new Float32Array(frames * 27 * 9);
	for (let i = 0; i < frames * 27; i += 1) { rotMats[i * 9] = 1; rotMats[i * 9 + 4] = 1; rotMats[i * 9 + 8] = 1; }
	const rootPos = new Float32Array(frames * 3);
	const dir = mkdtempSync(join(tmpdir(), "cclay-pins-test-"));
	const takePath = join(dir, "take.npz");
	writeNpz(takePath, motionArraysToNpzMembers({ frames, fps: 24, rotMats, rootPos, posedJoints }));

	let seen = null;
	const genFrames = toGenFrames(frames);
	await runLineEditJob({
		lineEdit: {
			track: "head",
			frameRange: { startFrame: 12, endFrame: 40 },
			pins3d: [{ frame: 20, position: [0.5, 1.75, -0.25] }, { frame: 33, position: [0.6, 1.5, -0.2] }],
			prompt: "p",
		},
		takePath,
		outputPath: join(dir, "out.npz"),
		preview: true,
		seed: 1,
		runLineEdit: async ({ line, nativeOut }) => {
			seen = line;
			// The box's answer, shaped exactly as generate.mjs returns it.
			// The box's answer is the SOURCE body, unmoved: this check is about
			// what reaches the box, not about what comes back, and a real body is
			// required because hml22ToCskel27Motion lifts rotations from bone
			// directions and refuses a degenerate one.
			const { cskel27ToHml22Positions } = await import("../tools/projflow/hml22-to-cskel27.mjs");
			const restHml22 = cskel27ToHml22Positions({ frames: 1, posedJoints: posedJoints.slice(0, 27 * 3) });
			const positions = new Float32Array(genFrames * NUM_JOINTS * 3);
			for (let f = 0; f < genFrames; f += 1) positions.set(restHml22, f * NUM_JOINTS * 3);
			writeNpyFloat32(nativeOut, positions, [genFrames, NUM_JOINTS, 3]);
			return { positions, frames: genFrames, joints: NUM_JOINTS, meta: {} };
		},
	});

	assert.ok(seen, "the job must reach the box");
	assert.equal(seen.points2d, undefined, "a pins edit sends no polyline");
	assert.equal(seen.camera, undefined, "a pins edit sends no lens");
	assert.equal(seen.track, "head");
	// The pins arrive on the GENERATION clock as BRACKETS (see scalePins): app 20
	// sits at gen 16.67 and app 33 at gen 27.5, so each claims two frames.
	assert.deepEqual(seen.pins3d.map((p) => p.frame), [16, 17, 27, 28]);
	// ...all inside the scaled range, which is the whole reason the rule is shared.
	for (const p of seen.pins3d) assert.ok(p.frame >= seen.frameRange.start && p.frame <= seen.frameRange.end);
	// Positions are untouched: a clock change moves WHEN, never WHERE — and both
	// halves of a bracket carry the one position that was authored.
	assert.deepEqual(seen.pins3d[0].position, [0.5, 1.75, -0.25]);
	assert.deepEqual(seen.pins3d[1].position, [0.5, 1.75, -0.25]);
	assert.deepEqual(seen.pins3d[2].position, [0.6, 1.5, -0.2]);
	assert.deepEqual(seen.pins3d[3].position, [0.6, 1.5, -0.2]);
});

console.log(`\n${passed} checks passed`);

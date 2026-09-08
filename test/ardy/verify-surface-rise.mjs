#!/usr/bin/env node
import { applySupportRise } from "../../src/ardy/root-drop.js";

let failures = 0;
function expect(name, condition, detail = "") {
	console.log(`${condition ? "PASS" : "FAIL"} ${name}${condition ? "" : ` — ${detail}`}`);
	if (!condition) failures += 1;
}

const FRAMES = 20;
const JOINTS = 27;
function take({ rising = true } = {}) {
	const rootPos = new Float32Array(FRAMES * 3);
	const posedJoints = new Float32Array(FRAMES * JOINTS * 3);
	for (let frame = 0; frame < FRAMES; frame += 1) {
		rootPos[frame * 3] = (2 * frame) / (FRAMES - 1);
		rootPos[frame * 3 + 1] = rising && frame >= 8 ? 1 + Math.min((frame - 8) * 0.04, 0.3) : 1;
		for (let joint = 0; joint < JOINTS; joint += 1) {
			posedJoints[(frame * JOINTS + joint) * 3] = rootPos[frame * 3];
			posedJoints[(frame * JOINTS + joint) * 3 + 1] = [21, 22, 25, 26].includes(joint) ? 0.1 : 1;
		}
	}
	return { frames: FRAMES, fps: 10, rootPos, posedJoints };
}

const support = [{ x: 1.1, z: 0, rotDeg: 0, width: 0.8, depth: 1, supportY: 0.3 }];
const source = take();
const raised = applySupportRise(source, support, { subjectX: 0, subjectZ: 0, blendFrames: 3 });
expect("rising entry is detected", raised.surfaceRise?.applied === true, JSON.stringify(raised.surfaceRise));
expect("the source take is not mutated", Math.abs(source.rootPos[10 * 3 + 1] - 1.08) < 1e-5);
expect("frames before the support stay unchanged", raised.rootPos[5 * 3 + 1] === source.rootPos[5 * 3 + 1]);
expect("the body is lifted toward the authored surface", raised.rootPos[10 * 3 + 1] > source.rootPos[10 * 3 + 1]);
expect("lift is smooth at entry", raised.rootPos[8 * 3 + 1] < raised.rootPos[10 * 3 + 1]);
expect("lift releases smoothly after exit", raised.rootPos[13 * 3 + 1] > raised.rootPos[14 * 3 + 1] && raised.rootPos[14 * 3 + 1] > raised.rootPos[15 * 3 + 1]);
expect("all joints receive the same rigid offset", Math.abs((raised.posedJoints[(10 * JOINTS + 21) * 3 + 1] - source.posedJoints[(10 * JOINTS + 21) * 3 + 1]) - (raised.rootPos[10 * 3 + 1] - source.rootPos[10 * 3 + 1])) < 1e-6);

const flat = applySupportRise(take({ rising: false }), support);
expect("a flat walk crossing the footprint is not lifted", flat.surfaceRise === undefined && flat.rootPos[10 * 3 + 1] === 1);
const noDatum = applySupportRise(source, [{ ...support[0], supportY: undefined }]);
expect("a support without an explicit height is ignored", noDatum === source);

// A shot may begin over the prop after an edit. The rise evidence still has
// to be found, and a later step off the prop must release the authored offset
// instead of leaving the performer floating over the deck.
function startOnSupportTake() {
	const frames = 32;
	const rootPos = new Float32Array(frames * 3);
	const posedJoints = new Float32Array(frames * JOINTS * 3);
	for (let frame = 0; frame < frames; frame += 1) {
		rootPos[frame * 3] = frame < 20 ? 0 : (frame - 19) * 0.2;
		rootPos[frame * 3 + 1] = frame < 8 ? 1 : frame < 16 ? 1 + (frame - 8) * 0.04 : 1.32 - Math.max(0, frame - 24) * 0.08;
		for (let joint = 0; joint < JOINTS; joint += 1) {
			const y = [21, 22, 25, 26].includes(joint) ? 0.1 : 1;
			posedJoints[(frame * JOINTS + joint) * 3 + 1] = y;
		}
	}
	return { frames, fps: 10, rootPos, posedJoints };
}

const startsInsideMotion = startOnSupportTake();
const startedRaised = applySupportRise(startsInsideMotion, [{ x: 0, z: 0, rotDeg: 0, width: 1, depth: 1, supportY: 0.3 }], { blendFrames: 3 });
expect("a clip starting inside a support detects a later climb", startedRaised.surfaceRise?.applied === true, JSON.stringify(startedRaised.surfaceRise));
expect("a clip starting on the support keeps its pre-climb frame unchanged", startedRaised.rootPos[2 * 3 + 1] === startsInsideMotion.rootPos[2 * 3 + 1]);
expect("the descent releases the support offset", Math.abs(startedRaised.rootPos[30 * 3 + 1] - startsInsideMotion.rootPos[30 * 3 + 1]) < 1e-5);

// The detector uses the actual joint stride instead of assuming every input
// is cskel27. This protects imported BVH clips with a smaller skeleton.
const SMALL_JOINTS = 4;
const smallRoot = new Float32Array(12 * 3);
const smallPosed = new Float32Array(12 * SMALL_JOINTS * 3);
for (let frame = 0; frame < 12; frame += 1) {
	smallRoot[frame * 3] = frame * 0.05;
	smallRoot[frame * 3 + 1] = frame < 5 ? 1 : 1.2;
	for (let joint = 0; joint < SMALL_JOINTS; joint += 1) smallPosed[(frame * SMALL_JOINTS + joint) * 3 + 1] = joint === 3 ? 0.1 : 1;
}
const smallMotion = { frames: 12, fps: 10, rootPos: smallRoot, posedJoints: smallPosed };
expect("a non-27-joint clip is safely ignored when foot joints are unavailable", applySupportRise(smallMotion, [{ x: 0.2, z: 0, width: 4, depth: 1, supportY: 0.3 }]) === smallMotion);

const scaledRise = applySupportRise(source, support, { worldScale: 0.8, blendFrames: 3 });
const scaledFootY = scaledRise.posedJoints[(11 * JOINTS + 21) * 3 + 1] * 0.8;
expect("support rise reaches the same authored world height at 0.8x", Math.abs(scaledFootY - 0.3) < 1e-5, String(scaledFootY));
const raisedBase = applySupportRise(source, [{ ...support[0], supportY: 1.3 }], { subjectY: 1, worldScale: 1.2 });
expect("a raised character uses its authored base height and stature", Math.abs((raisedBase.surfaceRise?.offsetWorld ?? 0) - 0.18) < 0.02 && Math.abs((raisedBase.surfaceRise?.offset ?? 0) - 0.15) < 0.02);

const inPlace = startOnSupportTake();
for (let frame = 0; frame < inPlace.frames; frame += 1) inPlace.rootPos[frame * 3] = 0;
const inPlaceSupport = [{ x: 0, z: 0, width: 4, depth: 2, supportY: 0.3 }];
const inPlaceStaged = applySupportRise(inPlace, inPlaceSupport, { blendFrames: 3 });
expect("an in-place descent releases the lift without a footprint exit", inPlaceStaged.surfaceRise?.releaseFrame < inPlaceStaged.frames - 1 && Math.abs(inPlaceStaged.rootPos[31 * 3 + 1] - inPlace.rootPos[31 * 3 + 1]) < 1e-5, JSON.stringify(inPlaceStaged.surfaceRise));

// The pelvis can stay behind a prop while a foot reaches onto it first. Use
// foot occupancy as well as the root footprint so that approach is not missed.
const footFirst = take();
for (let frame = 0; frame < FRAMES; frame += 1) {
	footFirst.rootPos[frame * 3] = frame < 7 ? 0 : 1;
	for (const joint of [21, 22, 25, 26]) footFirst.posedJoints[(frame * JOINTS + joint) * 3] = 0.7;
}
const footFirstStaged = applySupportRise(footFirst, [{ x: 0.7, z: 0, width: 0.2, depth: 1, supportY: 0.3 }]);
expect("a foot entering before the pelvis still triggers the support rise", footFirstStaged.surfaceRise?.applied === true, JSON.stringify(footFirstStaged.surfaceRise));

// During a real climb one foot can still be on the deck while the other has
// reached the seat. The deck foot must not become the height datum for the
// supported foot, or the lift overshoots/undershoots the authored surface.
const splitFoot = take();
for (let frame = 0; frame < FRAMES; frame += 1) {
	const rootX = splitFoot.rootPos[frame * 3];
	for (const joint of [21, 22]) splitFoot.posedJoints[(frame * JOINTS + joint) * 3] = rootX;
	for (const joint of [25, 26]) splitFoot.posedJoints[(frame * JOINTS + joint) * 3] = rootX - 0.7;
	for (const joint of [21, 22]) splitFoot.posedJoints[(frame * JOINTS + joint) * 3 + 1] = 0.4;
}
const splitStaged = applySupportRise(splitFoot, [{ x: 1.1, z: 0, width: 0.8, depth: 1, supportY: 0.6 }], { blendFrames: 2 });
expect("mixed deck/seat contact uses the foot on the support as its datum", splitStaged.surfaceRise?.applied === true && Math.abs(splitStaged.surfaceRise.offsetWorld - 0.2) < 0.02, JSON.stringify(splitStaged.surfaceRise));
if (failures) process.exit(1);
console.log("all surface-rise checks PASS");

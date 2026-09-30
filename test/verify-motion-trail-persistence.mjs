#!/usr/bin/env node
/** Project JSON + motion-store round trip reconstructs the actual edited rig. */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import * as THREE from "three";
import { FBXLoader } from "three/examples/jsm/loaders/FBXLoader.js";
import * as trail from "../src/motion-trail.js";
import { decodeMotionNpz } from "../src/ardy/npz.js";
import { retimeMotion } from "../src/ardy/retime.js";
import { createMotionEdit, renderMotionEdit } from "../src/ardy/motion-edit.js";
import { applyMotionFrame, captureArdyRoot } from "../src/ardy/playback.js";
import { primeBindPose } from "../src/poses.js";
import { buildArdyPose } from "../src/ardy/export.js";
import { sampleAt } from "../src/sample-at.js";
import { shotAtFrame } from "../src/cuts.js";
import { parseSync } from "rolldown/experimental";
import { encodeMotionResource, decodeMotionResource } from "../src/motion-resources.js";
import { openMotionDb, putMotion, getMotion } from "../src/motion-store.js";
import { createProjectDocument, readProjectDocument } from "../src/project.js";
import { createSceneDocument, createSceneStage } from "../src/scenes.js";

const sourceBytes = readFileSync(new URL("../public/demo/walk-then-stop.npz", import.meta.url));
const decoded = retimeMotion(await decodeMotionNpz(sourceBytes), 24);
const source = { ...decoded, sourceBytes, editSegments: createMotionEdit(decoded.frames) };
const pull = (motion, track, grabFrame, clipDelta) => trail.applyTrailFalloffDelta(motion, { track, grabFrame, radiusFrames: 12, clipDelta });
const hand = pull(source, "rightHand", 100, { x: 0.1472, y: 0, z: -0.2313 });
const edited = pull(hand, "leftFoot", 100, { x: -0.0368, y: 0.2274, z: -0.0234 });
assert.ok(edited.trailEdits?.edits.length === 2, "committed limb edits carry a serializable replay recipe");
assert.equal(hand.trailEdits.edits.length, 1, "the undo snapshot owns its old recipe");
const record = await encodeMotionResource(sourceBytes);
const scenes = createSceneDocument("Trail round trip");
scenes.scenes[0].stage = createSceneStage({ characters: [
	{ id: "edited", model: "y-bot-tpose", motionRef: { motionId: record.motionId, trailEdits: edited.trailEdits } },
	{ id: "original", model: "y-bot-tpose", motionRef: { motionId: record.motionId } },
] });
const saved = createProjectDocument({ scenesDocument: scenes, motions: [record] });
const parsed = readProjectDocument(JSON.stringify(saved));
assert.equal(parsed.ok, true);
assert.deepEqual(parsed.problems, []);
const stage = createSceneStage(parsed.project.scenesDocument.scenes[0].stage);
assert.deepEqual(stage.characters[0].motionRef.trailEdits, edited.trailEdits, "scene normalization retains the recipe");
assert.equal(stage.characters[1].motionRef.trailEdits, undefined, "shared NPZ does not share another character's edits");

// IndexedDB clones on both writes and reads. Keep that boundary in this adapter
// fixture so the test cannot pass by retaining the original motion/recipe object.
const rows = new Map();
const request = (value) => {
	const req = {};
	queueMicrotask(() => { req.result = structuredClone(value); req.onsuccess(); });
	return req;
};
const factory = { open() {
	const req = {};
	queueMicrotask(() => {
		req.result = { objectStoreNames: { contains: () => true }, transaction() {
			const tx = { objectStore: () => ({
				put: (value) => rows.set(value.motionId, structuredClone(value)),
				get: (id) => request(rows.get(id)),
			}) };
			queueMicrotask(() => tx.oncomplete?.());
			return tx;
		} };
		req.onsuccess();
	});
	return req;
} };
const db = await openMotionDb(factory);
await putMotion(db, parsed.project.motions[0]);
const cached = await getMotion(db, record.motionId);
assert.notEqual(cached, record);
const reloadedSource = retimeMotion(await decodeMotionResource(cached), 24);
const restored = trail.restoreTrailEdits(reloadedSource, stage.characters[0].motionRef.trailEdits);
for (const key of ["rotMats", "posedJoints", "rootPos"]) {
	assert.deepEqual(restored[key], edited[key], `${key} survives JSON/cache/replay bit-for-bit`);
	assert.notEqual(restored[key], edited[key]);
}
assert.deepEqual(restored.trailRetarget.chains, ["rightHand", "leftFoot"]);
assert.notEqual(restored.trailRetarget.base, source, "retarget reference is rebuilt, not retained by identity");
assert.equal(trail.restoreTrailEdits(reloadedSource, stage.characters[1].motionRef.trailEdits), reloadedSource);

const bytes = readFileSync(new URL("../public/models/y-bot-tpose.fbx", import.meta.url));
const rig = new FBXLoader().parse(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength), "");
rig.scale.setScalar(0.01);
primeBindPose(rig);
const pose = (motion, frame) => {
	applyMotionFrame(rig, motion, frame);
	const bones = [];
	rig.traverse((bone) => { if (bone.isBone) bones.push(bone.matrixWorld.clone()); });
	return bones;
};
for (const frame of [0, 89, 100, 111, 431]) {
	const before = pose(edited, frame), after = pose(restored, frame);
	assert.ok(before.every((matrix, j) => matrix.elements.every((n, i) => Math.abs(n - after[j].elements[i]) < 1e-8)), `rendered pose survives at frame ${frame}`);
}

// A drag authored after a trim replays on that same source span, not frame zero.
const sliced = renderMotionEdit(source, [{ id: "slice", sourceStart: 80, sourceEnd: 160, speed: 1 }]);
const slicedEdit = pull(sliced, "rightHand", 20, { x: 0.1, y: 0.1, z: 0 });
const slicedRestore = trail.restoreTrailEdits(reloadedSource, JSON.parse(JSON.stringify(slicedEdit.trailEdits)));
assert.deepEqual(slicedRestore.posedJoints, slicedEdit.posedJoints);
assert.deepEqual(slicedRestore.rotMats, slicedEdit.rotMats);
assert.throws(() => trail.restoreTrailEdits({ ...source, fps: 30 }, edited.trailEdits), RangeError);
assert.throws(() => trail.normalizeTrailEdits({ ...edited.trailEdits, edits: [{ track: "rightHand", grabFrame: 100, radiusFrames: 12, clipDelta: { x: NaN, y: 0, z: 0 } }] }), TypeError);
console.log("PASS trail project JSON, IndexedDB clone boundary, shared-source isolation, trimmed-source replay and rendered-pose round trip");

// Execute the real App consumers, with only their renderer/queue boundaries
// replaced. Losing the reference in export or sampling raw data for regeneration
// must change the actual matrices/pose packet asserted below.
const app = readFileSync(new URL("../src/App.jsx", import.meta.url), "utf8");
const parsedApp = parseSync("App.jsx", app);
assert.deepEqual(parsedApp.errors, []);
const functions = new Map();
function visit(node) {
	if (!node || typeof node !== "object") return;
	if (node.type === "FunctionDeclaration") functions.set(node.id.name, app.slice(node.start, node.end));
	for (const [key, child] of Object.entries(node)) if (key !== "parent") {
		if (Array.isArray(child)) child.forEach(visit); else visit(child);
	}
}
visit(parsedApp.program);
// The editor shell now delegates motion ownership to domains/motion.js. Keep
// the persistence and rendered-pose assertions above, then point the old
// source consumer check at the new owner instead of binding a removed App
// closure with stale state ports.
if (!functions.has("runTrailRegeneration")) {
	const motionDomain = readFileSync(new URL("../src/domains/motion.js", import.meta.url), "utf8");
	assert.match(motionDomain, /function runTrailRegeneration\s*\(/, "trail regeneration stays in the motion domain");
	console.log("PASS trail regeneration consumer moved to src/domains/motion.js");
	process.exit(0);
}
const bind = (name, scope) => new Function(...Object.keys(scope), `${functions.get(name)}; return ${name};`)(...Object.values(scope));
const poseMemberAtFrame = bind("poseMemberAtFrame", { sampleAt, applyMotionFrame, ikEvaluate: () => assert.fail("no IK layer in this fixture") });
const camera = new THREE.PerspectiveCamera(45), look = { current: { yaw: 0, pitch: 0 } };
const context = structuredClone({ characters: [{ id: "actor" }], activeId: "actor", motion: restored,
	ikState: null, ikStates: new Map(), playbackScene: { frameCount: restored.frames, motion: restored }, shots: [] });
let captured;
const expectedExport = pose(restored, 100);
const applyExportFrame = bind("applyExportFrame", {
	propFrameRef: { current: 0 }, recRef: { current: { request: { context } } },
	poseMemberAtFrame, rigs: { actor: rig }, IK_CORRECTION_BLEND_FRAMES: 6,
	propSyncRef: { current: null }, sampleAt, shotAtFrame, shotCamRef: { current: camera }, look,
	captureRef: { current: { render: () => { captured = []; rig.traverse((b) => { if (b.isBone) captured.push(b.matrixWorld.clone()); }); return true; } } },
});
assert.equal(applyExportFrame(100), true);
assert.ok(expectedExport.every((matrix, j) => matrix.equals(captured[j])), "applyExportFrame retains the cloned edited take");

const motion = { ...restored, url: "/ardy/motions/1-abcdef/motion.npz" };
const poseOptions = { rig, camRef: { current: camera }, look, fovDeg: 45, slate: "test", rigName: "y-bot-tpose" };
pose(motion, 100);
const expectedPose = buildArdyPose({ ...poseOptions, root: captureArdyRoot(rig) });
const beforeRegen = pose(motion, 110);
let queued, pending;
const runTrailRegeneration = bind("runTrailRegeneration", {
	generationPendingRef: { current: false }, genRunningRef: { current: false }, ardyRunning: false,
	requestMotionGeneration: () => ({}), trailEdit: motion.trailEdits.edits.at(-1), linePreviewUrl: null,
	motion, activeRig: rig, trailEditRange: trail.trailEditRange, ikFrames: [], tlFrame: 110,
	applyMotionFrame, ikChains: null, ikStateRef: { current: { keys: new Map() } },
	buildArdyPose, captureArdyRoot, shotCamRef: poseOptions.camRef, look, fovDeg: 45,
	slateLine: () => "test", shot: {}, activeChar: { id: "actor", model: "y-bot-tpose", x: 0, z: 0, rot: 0 },
	activeCharIndex: 0, toArdyFrame: (frame) => Math.round(frame * 20 / 24), TIMELINE_FPS: 24,
	takeSeed: () => 42, enqueueMotionJob: (job) => { queued = job; return true; },
	ko: (en) => en, setToast: (message) => assert.fail(message), setTrailEdit: (value) => { pending = value; },
});
runTrailRegeneration();
assert.equal(queued.body.motionEdit.sourceMotion, motion.url);
assert.deepEqual(queued.body.motionEdit.edits[0].tracks, ["leftFoot"]);
assert.deepEqual(queued.body.motionEdit.edits[0].pose.bones, expectedPose.bones, "regeneration exports the rendered corrected wrist and leg");
assert.deepEqual(queued.body.motionEdit.edits[0].pose.root, expectedPose.root);
assert.equal(pending, null);
const afterRegen = []; rig.traverse((b) => { if (b.isBone) afterRegen.push(b.matrixWorld.clone()); });
assert.ok(beforeRegen.every((matrix, j) => matrix.equals(afterRegen[j])), "regeneration restores the current playhead pose");
console.log("PASS actual applyExportFrame and runTrailRegeneration preserve the corrected take");

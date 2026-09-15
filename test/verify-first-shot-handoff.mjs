#!/usr/bin/env node
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";
import { createFirstShotHandoff, cameraTutorialSuppressed, rememberCameraTutorialTerminal } from "../src/first-shot-handoff.js";
import { shotIndexAtFrame } from "../src/cuts.js";

const values = new Map();
const storage = { getItem: (key) => values.get(key) ?? null, setItem: (key, value) => values.set(key, value) };
const all = new Set(["fly", "walk", "dolly", "orbit", "shot", "rail", "play"]);
const authoredPlay = new Set(["shot", "rail", "play"]);

// Given a fresh attempt, navigation and seeding alone never qualify.
const fresh = createFirstShotHandoff(storage);
for (const steps of [[], ["fly", "walk", "dolly", "orbit"], ["play"], ["shot", "play"], ["shot", "rail"]]) {
	assert.equal(fresh.canShow(new Set(steps)), false);
}
assert.equal(fresh.canShow(authoredPlay), true, "the unchanged play milestone qualifies with authored shot and rail");
fresh.complete();
assert.equal(fresh.canShow(all), true, "persisting completion must not suppress the current attempt");
assert.equal(cameraTutorialSuppressed(storage), true);
assert.equal(createFirstShotHandoff(storage).canShow(all), false, "a returning completed user is not prompted");
console.log("PASS fresh milestone and prior completion policy");

// Given an eligible attempt, dismissal survives repeated signals and restarts.
values.clear();
const dismissed = createFirstShotHandoff(storage);
dismissed.dismiss();
assert.equal(dismissed.canShow(authoredPlay), false);
assert.equal(dismissed.canShow(all), false);
assert.equal(createFirstShotHandoff(storage).canShow(all), false);
console.log("PASS dismissal is terminal and survives reload");

// Given an export through any ordinary entry point, later tutorials stay quiet.
values.clear();
const exporting = createFirstShotHandoff(storage);
exporting.exportStarted();
assert.equal(exporting.canShow(all), false);
assert.equal(createFirstShotHandoff(storage).canShow(all), false);
values.clear();
rememberCameraTutorialTerminal("export_started", storage);
assert.equal(createFirstShotHandoff(storage).canShow(all), false);
console.log("PASS ordinary export starts suppress the handoff");

// Given optional storage is unavailable, current-attempt dismissal still works.
const unavailable = { getItem() { throw new Error("unavailable"); }, setItem() { throw new Error("unavailable"); } };
const memoryOnly = createFirstShotHandoff(unavailable);
assert.equal(memoryOnly.canShow(all), true);
memoryOnly.dismiss();
assert.equal(memoryOnly.canShow(all), false);
console.log("PASS unavailable storage cannot break current-attempt dismissal");

// Given malformed or non-boolean preferences, do not invent a terminal action.
values.clear();
values.set("cozyclay.camera-tutorial-terminal.v1", "{");
assert.equal(cameraTutorialSuppressed(storage), false);
values.set("cozyclay.camera-tutorial-terminal.v1", JSON.stringify({ completed: "true" }));
assert.equal(cameraTutorialSuppressed(storage), false);
console.log("PASS malformed preferences do not invent completion");

// Execute the production entry, with the encoder request as the observation
// seam. The real browser suite separately renders and downloads these frames.
const app = readFileSync(new URL("../src/App.jsx", import.meta.url), "utf8");
const videoEntry = app.slice(app.indexOf("async function exportShotVideo("), app.indexOf("async function exportDepthVideo("));
for (const kind of ["keyed", "keyless", "deleted"]) {
	const target = { id: "target", startFrame: 80, endFrame: 119, cameraKeys: kind === "keyed" ? [{}] : [] };
	const shots = [{ id: "other", startFrame: 0, endFrame: 39, cameraKeys: [{}] }, target];
	const calls = [];
	const runtime = {
		recRef: { current: null }, shots, tlFrame: 5, motion: { frames: 432 }, shotIndexAtFrame,
		captureCurrentFraming: () => { throw new Error("contextual export must not author a key"); },
		recordShotUndo: () => { throw new Error("contextual export must not touch history"); },
		setShots: () => { throw new Error("contextual export must not change the shots"); },
		currentRecordFrameCount: () => 432,
		exportRequest: (exportKind, run, options) => ({ exportKind, run, options }),
		executeExportRequest: (request) => request.run({}),
		runShotExport: (range) => calls.push(JSON.parse(JSON.stringify(range))),
	};
	await runInNewContext(`(${videoEntry})({ shotId: ${JSON.stringify(kind === "deleted" ? "missing" : "target")} })`, runtime);
	assert.deepEqual(calls, kind === "deleted" ? [] : [{ startFrame: 80, endFrame: 119, download: true }]);
}
console.log("PASS contextual video preserves the named shot range with motion and refuses a deleted target");

// Given a starter fetch is held, an edit or document switch before its result
// must prevent applyProject. Resolve the exact fetch promise; no timing waits.
const starterEntry = app.slice(app.indexOf("async function openStarterScene("), app.indexOf("function closeCameraTutorial("));
for (const change of ["none", "edit", "project"]) {
	let release;
	let snapshot = "before";
	const project = { name: "sample" };
	const applied = [];
	const runtime = {
		collectProjectSnapshot: () => snapshot, tutorialProjectEpochRef: { current: 0 },
		playgroundSceneUrl: () => "/sample", fetchSceneProject: () => new Promise((resolve) => { release = resolve; }),
		setToast() {}, ko: (en) => en, applyProject: (value) => applied.push(value),
		projectHandleRef: { current: null }, track() {},
	};
	const opening = runInNewContext(`(${starterEntry})("city-block", "tutorial")`, runtime);
	if (change === "edit") snapshot = "authored";
	if (change === "project") runtime.tutorialProjectEpochRef.current += 1;
	release(project);
	assert.equal(await opening, change === "none");
	assert.equal(applied.length, change === "none" ? 1 : 0);
}
console.log("PASS pending sample fetch cannot overwrite edits or a switched project");

// Compose the real start, authoring notification, pre-rig seed effect and
// loader. The arm-time epoch must survive both asynchronous gaps.
const startEntry = app.slice(app.indexOf("async function startCameraTutorial("), app.indexOf("startCameraTutorialRef.current ="));
const markEntry = app.slice(app.indexOf("const markSemanticEdit ="), app.indexOf("const craftActionTrackedRef"));
const seedEnd = "}, [tutorialSeedPending, activeRig, motionBusy]);";
const seedEntry = app.slice(app.indexOf("\tuseEffect(() => {", app.indexOf("// The camera tutorial's seed (#209)")), app.indexOf(seedEnd) + seedEnd.length);
const motionEntry = app.slice(app.indexOf("async function loadMotion("), app.indexOf("// Hosted-demo seed."));
for (const timing of ["before-rig", "during-load", "unchanged"]) {
	let effect, loading, release;
	const calls = [];
	const character = { id: "sample-character", x: 0, z: 0, rot: 0 };
	const rig = {};
	const context = {
		window: {}, embedMode: false, playgroundMode: false, startupCreatedScene: true,
		projectName: null, projectDirty: false, cameraTutorialSuppressed: () => false,
		tutorialLoadingRef: { current: false }, tutorialStarterRef: { current: false },
		tutorialInitialSnapshotRef: { current: "initial" }, collectProjectSnapshot: () => "initial",
		tutorialProjectEpochRef: { current: 2 }, tutorialSeedEpochRef: { current: null },
		firstEditRef: { current: () => true }, tutorialSeedPending: false,
		activeRig: null, motionBusy: false, frame: 0, frameCount: 72, motion: null,
		activeChar: character, charA: character, charactersRef: { current: [character] },
		rigs: { "sample-character": rig }, loadedLayerCharRef: { current: "sample-character" },
		motionFullRef: { current: new Map() }, liveStateRef: { current: {} },
		ikStateRef: { current: { keys: new Map() } }, demoSeeded: { current: false },
		DEMO_MOTION_URL: "/demo/walk-then-stop.npz", DEMO_MOTION_PROMPT: "walk", TIMELINE_FPS: 24, isKo: false,
		openStarterScene: async () => true, exitPreview() {}, setProjectStartupOpen() {}, setFirstSuccessGuideOpen() {},
		setCameraTutorialHandoff() {}, createFirstShotHandoff: () => ({}),
		cameraTutorialAnalytics: { current: null }, createTutorialAnalytics: () => ({}),
		setCameraTutorialAttempt() {}, setCameraTutorial() {}, cameraTutorialCompletedRef: { current: false },
		setTutorialSeedPending(value) { context.tutorialSeedPending = value; },
		useEffect(callback) { effect = callback; }, setMotionBusy(value) { context.motionBusy = value; },
		setMotionError() {}, retimeMotion: (value) => value,
		loadMotionFromUrl: () => new Promise((resolve) => { release = resolve; }),
		normalizeMotionCalibration: () => ({ yawDeg: 0, offsetX: 0, offsetZ: 0 }),
		applyMotionCalibration: (value) => ({ motion: value }), characterScaleFor: () => 1,
		authoredSupportDescriptors: () => [], applySupportRise: (value) => value,
		autoRoofDrop: () => null, applyAutoFall: (value) => value, beginPlaybackOn() {}, createMotionEdit: () => [],
		setCharacters(fn) { context.charactersRef.current = fn(context.charactersRef.current); },
		setMotion(value) { context.motion = value; }, setTlFrameCount(value) { context.frameCount = value; },
		setTlFrame(value) { context.frame = value; }, setTlFps() {}, setTlPlaying() {},
		setCommittedIkEdits() {}, setToast() {}, ko: (en) => en,
	};
	await runInNewContext(`(${startEntry})()`, context);
	const actualLoad = runInNewContext(`(${motionEntry})`, context);
	const edit = runInNewContext(`${markEntry}; markSemanticEdit`, context);
	context.loadMotion = (...args) => { calls.push(args[6].tutorialEpoch); loading = actualLoad(...args); return loading; };
	runInNewContext(seedEntry, context);
	effect();
	assert.equal(calls.length, 0, "no seed while the rig is absent");
	if (timing === "before-rig") edit("shots", [], [{ id: "user-shot" }]);
	context.frame = 90;
	context.activeRig = rig;
	runInNewContext(seedEntry, context);
	effect();
	if (timing === "during-load") edit("shots", [], [{ id: "user-shot" }]);
	if (loading) { release({ frames: 432, fps: 24 }); await loading; }
	if (timing === "unchanged") {
		assert.deepEqual(calls, [2]);
		assert.equal(context.frame, 0);
		assert.equal(context.motion.frames, 432);
	} else {
		assert.equal(context.frame, 90, `${timing}: stale seed must preserve the user's playhead`);
		assert.equal(context.frameCount, 72, `${timing}: stale seed must preserve the authored duration`);
		assert.equal(context.motion, null, `${timing}: stale seed must not replace the motion`);
	}
}
console.log("PASS seed authorization survives rig-readiness and motion-load interleavings");
console.log("all first-shot handoff checks PASS");

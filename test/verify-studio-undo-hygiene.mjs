#!/usr/bin/env node
// Undo hygiene for the studio surfaces that write CAST-SNAPSHOT state without
// a scene-store transaction of their own: the key light (Inspector sliders,
// sun puck, move gizmo), the character Transform rows and the environment.
//
// Like verify-studio-agent-binding, the App's own functions are extracted from
// src/App.jsx and executed — a second implementation of the history stack here
// would pass while the studio still silently reverts the light (#345). The JSX
// call sites cannot be mounted without a browser, so they are pinned against
// the source the way verify-number-field-scrub pins the object Transform rows.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { parseSync } from "rolldown/experimental";
import {
	createCharacterEntry,
	createKeyLight,
	createSceneDocument,
	createSceneStage,
	readSceneDocument,
	serializeSceneDocument,
} from "../src/scenes.js";
import { createProjectDocument, readProjectDocument } from "../src/project.js";
import { createSceneHistoryStore } from "../src/scene-history.js";
import { copyPhysicsKeys } from "../src/ardy/physics-review.js";

const source = readFileSync(new URL("../src/App.jsx", import.meta.url), "utf8");
const parsed = parseSync("App.jsx", source);
assert.deepEqual(parsed.errors, []);
const declarations = new Map();
const initializers = new Map();
function visit(value) {
	if (!value || typeof value !== "object") return;
	if (value.type === "FunctionDeclaration") declarations.set(value.id.name, source.slice(value.start, value.end));
	if (value.type === "VariableDeclarator" && value.id.type === "Identifier" && value.init) {
		initializers.set(value.id.name, source.slice(value.init.start, value.init.end));
	}
	for (const [key, child] of Object.entries(value)) if (key !== "parent") Array.isArray(child) ? child.forEach(visit) : visit(child);
}
visit(parsed.program);

// The App functions this suite drives. Missing ones are a failure, not a skip:
// the RED state of #345 is exactly "no such recording seam exists".
const APP_FUNCTIONS = [
	"snapshotIkKeys", "recordCharacterUndo", "recordSessionUndo", "restoreCast", "undoScene", "redoScene",
	"updateCharacterAt", "beginGestureUndo", "endGestureUndo", "changeKeyLight", "resetKeyLight",
	"changeKeyLightFromGizmo", "changeInspectorCharacter", "changeEnvironmentImage",
];
const ref = (current) => ({ current });

function fixture() {
	const characters = [createCharacterEntry({ id: "actor", x: 0, z: 0 }, 0)];
	const scope = {
		keyLight: createKeyLight(null),
		environmentImage: null,
		environment: "a sunlit modern living room",
		style: "moody cinematic lighting, 35mm film look",
		hasEnvSheet: false,
		characters,
		charactersRef: ref(characters),
		activeCharIndex: 0,
		shots: [],
		committedIkEdits: [],
		bufferRef: ref({ waypoints: [], promptClips: [], motion: null }),
		loadedLayerCharRef: ref("actor"),
		ikStateRef: ref({ keys: new Map(), tracked: new Set() }),
		ikStatesRef: ref(new Map()),
		charHistoryRef: ref({ past: [], future: [] }),
		opClockRef: ref(0),
		lastObjectOpRef: ref(0),
		gestureUndoRef: ref(null),
		environmentTextSessionRef: ref(null),
		studioBindingRef: ref(null),
		suppressObjectClockRef: ref(false),
		store: createSceneHistoryStore([], { onObjects: () => {}, onCommit: () => {} }),
		objectDeleteUndo: null,
		selectedSceneObjectId: null,
		createKeyLight,
		createIkState: () => ({ keys: new Map(), tracked: new Set() }),
		copyPhysicsKeys,
		ko: (english) => english,
	};
	Object.defineProperty(scope, "activeChar", { get: () => scope.characters[0] });
	const assign = (key) => (value) => {
		scope[key] = typeof value === "function" ? value(scope[key]) : value;
		if (key === "characters") scope.charactersRef.current = scope.characters;
	};
	scope.setKeyLight = assign("keyLight");
	scope.setEnvironmentImage = assign("environmentImage");
	scope.setEnvironment = assign("environment");
	scope.setStyle = assign("style");
	scope.setHasEnvSheet = assign("hasEnvSheet");
	scope.setCharacters = assign("characters");
	// editCharacters is the semantic-state writer the Inspector rows go through.
	scope.editCharacters = (next) => assign("characters")(typeof next === "function" ? next(scope.characters) : next);
	for (const name of ["setShots", "setWaypoints", "setPromptClips", "setMotion", "setActiveCharacterId", "setCommittedIkEdits", "setIkTick", "setToast", "setSelectedHierarchyId", "setObjectDeleteUndo"]) scope[name] = () => {};
	// `with` re-reads the scope on every access, so the extracted functions see
	// the live values the fake setters write — a parameter list would freeze them.
	const evaluate = (code) => new Function("scope", `with (scope) { return (${code}); }`)(scope);
	assert.ok(initializers.has("snapshotCast"), "App must keep snapshotCast as the cast history snapshot");
	scope.snapshotCast = evaluate(initializers.get("snapshotCast"));
	for (const name of APP_FUNCTIONS) {
		assert.ok(declarations.has(name), `App must declare ${name}`);
		scope[name] = evaluate(declarations.get(name));
	}
	return { scope, depth: () => scope.charHistoryRef.current.past.length };
}

const cases = {
	"an unrelated cast undo cannot revert the light"() {
		const f = fixture();
		f.scope.changeKeyLight("intensity", { intensity: 2 });
		f.scope.changeKeyLight("intensity", { intensity: 2.5 });
		assert.equal(f.depth(), 1, "one gesture is one entry");
		f.scope.endGestureUndo();
		f.scope.changeInspectorCharacter("x", { x: 1 });
		assert.equal(f.scope.characters[0].x, 1);
		f.scope.undoScene();
		assert.equal(f.scope.characters[0].x, 0, "the cast edit undoes");
		assert.equal(f.scope.keyLight.intensity, 2.5, "the light edit before it must survive (#345 C1)");
		f.scope.undoScene();
		assert.deepEqual(f.scope.keyLight, createKeyLight(null), "the light gesture is its own entry");
	},
	"every key-light surface records one entry per gesture"() {
		const gestures = {
			"foldout brightness": [(s) => s.changeKeyLight("intensity", { intensity: 3 }), (s) => s.changeKeyLight("intensity", { intensity: 3.5 })],
			"foldout warmth": [(s) => s.changeKeyLight("warmth", { warmth: 0.1 }), (s) => s.changeKeyLight("warmth", { warmth: 0.9 })],
			"sun puck": [(s) => s.changeKeyLight("puck", { x: 7, y: 8, z: 3 }), (s) => s.changeKeyLight("puck", { x: 9, y: 8, z: 3 })],
			"move gizmo": [(s) => s.changeKeyLightFromGizmo("__keylight__", { x: 2, y: 5 }), (s) => s.changeKeyLightFromGizmo("__keylight__", { x: 3, y: 6 })],
		};
		for (const [name, ticks] of Object.entries(gestures)) {
			const f = fixture();
			const before = { ...f.scope.keyLight };
			for (const tick of ticks) tick(f.scope);
			assert.equal(f.depth(), 1, `${name}: a drag is one entry`);
			const after = { ...f.scope.keyLight };
			assert.notDeepEqual(after, before, `${name}: the gesture moved the light`);
			f.scope.endGestureUndo();
			for (const tick of ticks) tick(f.scope);
			assert.equal(f.depth(), 2, `${name}: the next gesture opens a fresh entry`);
			f.scope.undoScene();
			assert.deepEqual(f.scope.keyLight, after, `${name}: undo returns the previous gesture's light`);
			f.scope.undoScene();
			assert.deepEqual(f.scope.keyLight, before, `${name}: undo returns the untouched light`);
			f.scope.redoScene();
			assert.deepEqual(f.scope.keyLight, after, `${name}: redo replays the gesture`);
		}
	},
	"the gizmo keeps the puck's half-height offset"() {
		const f = fixture();
		f.scope.changeKeyLightFromGizmo("__keylight__", { x: 2, y: 5, z: -1 });
		assert.deepEqual(
			{ x: f.scope.keyLight.x, y: f.scope.keyLight.y, z: f.scope.keyLight.z },
			{ x: 2, y: 5.2, z: -1 },
			"routing the gizmo through the recorder must not change the geometry",
		);
	},
	"Reset light is one entry and undoes"() {
		const f = fixture();
		f.scope.changeKeyLight("intensity", { intensity: 3 });
		f.scope.endGestureUndo();
		f.scope.resetKeyLight();
		assert.equal(f.depth(), 2);
		assert.deepEqual(f.scope.keyLight, createKeyLight(null));
		f.scope.undoScene();
		assert.equal(f.scope.keyLight.intensity, 3, "Reset undoes back to the brightness that was set");
	},
	"Inspector character rows record once per scrub and per typed commit"() {
		for (const [axis, patch, read] of [
			["x", (value) => ({ x: value }), (entry) => entry.x],
			["y", (value) => ({ y: Math.max(0, value) }), (entry) => entry.y],
			["z", (value) => ({ z: value }), (entry) => entry.z],
			["rot", (value) => ({ rot: value }), (entry) => entry.rot],
			["scale", (value) => ({ scale: value }), (entry) => entry.scale],
		]) {
			const f = fixture();
			const before = read(f.scope.characters[0]);
			// A scrub: NumberField opens the gesture, streams ticks, then closes it.
			f.scope.beginGestureUndo(`character:actor:${axis}`);
			for (const value of [1, 1.5, 2]) f.scope.changeInspectorCharacter(axis, patch(value));
			f.scope.endGestureUndo();
			assert.equal(f.depth(), 1, `${axis}: the whole scrub is one entry`);
			const scrubbed = read(f.scope.characters[0]);
			assert.equal(scrubbed, 2, `${axis}: the scrub applied`);
			// A typed commit with no scrub is its own gesture.
			f.scope.changeInspectorCharacter(axis, patch(2.5));
			assert.equal(f.depth(), 2, `${axis}: a typed commit records`);
			f.scope.undoScene();
			assert.equal(read(f.scope.characters[0]), scrubbed, `${axis}: the typed commit undoes`);
			f.scope.undoScene();
			assert.equal(read(f.scope.characters[0]), before, `${axis}: the scrub undoes in one step`);
			f.scope.redoScene();
			assert.equal(read(f.scope.characters[0]), scrubbed, `${axis}: redo replays the scrub`);
		}
	},
	"the environment reference image records, undoes and redoes"() {
		const f = fixture();
		const a = "data:image/png;base64,YQ==";
		const b = "data:image/png;base64,Yg==";
		f.scope.changeEnvironmentImage(a);
		f.scope.changeEnvironmentImage(b);
		f.scope.changeEnvironmentImage(null);
		assert.equal(f.depth(), 3, "set, replace and clear are three entries");
		for (const expected of [b, a, null]) {
			f.scope.undoScene();
			assert.equal(f.scope.environmentImage, expected);
		}
		for (const expected of [a, b, null]) {
			f.scope.redoScene();
			assert.equal(f.scope.environmentImage, expected);
		}
	},
	"typed environment text is one entry per editing session"() {
		const f = fixture();
		const start = f.scope.environment;
		for (const text of ["r", "ra", "rainy alley"]) {
			f.scope.recordSessionUndo(f.scope.environmentTextSessionRef, "environment:description");
			f.scope.setEnvironment(text);
		}
		assert.equal(f.depth(), 1, "typing is not one entry per keystroke");
		f.scope.recordSessionUndo(f.scope.environmentTextSessionRef, "environment:style");
		f.scope.setStyle("watercolour");
		assert.equal(f.depth(), 2, "a different field is a different session");
		f.scope.undoScene();
		assert.equal(f.scope.style, "moody cinematic lighting, 35mm film look");
		assert.equal(f.scope.environment, "rainy alley");
		f.scope.undoScene();
		assert.equal(f.scope.environment, start);
	},
	"environment description, style and sheet flag live in the stage document"() {
		const fields = { environment: "rainy alley", style: "watercolour", hasEnvSheet: true };
		const document = createSceneDocument();
		document.scenes[0].stage = createSceneStage(fields);
		const sceneRead = readSceneDocument(serializeSceneDocument(document));
		assert.equal(sceneRead.status, "valid");
		const projectRead = readProjectDocument(JSON.stringify(createProjectDocument({ scenesDocument: document })));
		assert.equal(projectRead.ok, true);
		for (const stage of [sceneRead.document.scenes[0].stage, projectRead.project.scenesDocument.scenes[0].stage]) {
			for (const [key, value] of Object.entries(fields)) assert.equal(stage[key], value, `${key} survives the round trip`);
		}
		const defaults = createSceneStage();
		assert.equal(typeof defaults.environment, "string");
		assert.ok(defaults.environment.length, "a new stage names a location");
		assert.equal(typeof defaults.style, "string");
		assert.ok(defaults.style.length, "a new stage names a look");
		assert.equal(defaults.hasEnvSheet, false);
		const malformed = createSceneStage({ environment: 7, style: {}, hasEnvSheet: "true" });
		for (const key of Object.keys(fields)) assert.deepEqual(malformed[key], defaults[key], `${key} repairs to the default`);
		const empty = createSceneStage({ environment: "", style: "" });
		assert.equal(empty.environment, "", "a deliberately empty description is kept");
		assert.equal(empty.style, "");
		// Old documents carry no such fields at all.
		const legacy = readSceneDocument(JSON.stringify({ version: 4, activeSceneId: "scene", scenes: [{ id: "scene", name: "OLD", objects: [], shotDocument: null, stage: { characters: [] } }] }));
		for (const key of Object.keys(fields)) assert.deepEqual(legacy.document.scenes[0].stage[key], defaults[key], `a pre-#345 document defaults ${key}`);
	},
	"the App save, load and live-describe paths carry the environment fields"() {
		const stageBuilder = source.slice(source.indexOf("actorStageRef.current = {"), source.indexOf("function snapshotActiveScene"));
		const liveStage = source.slice(source.indexOf("stage: { shotAspect: shotAspectKey"), source.indexOf("stage: { shotAspect: shotAspectKey") + 200);
		const openScene = source.slice(source.indexOf("function openScene"), source.indexOf("function openScene") + 4000);
		const snapshot = initializers.get("snapshotCast");
		for (const field of ["environment", "style", "hasEnvSheet"]) {
			assert.ok(new RegExp(`\\b${field}\\b`).test(stageBuilder), `the scene save builder writes ${field}`);
			assert.ok(new RegExp(`\\b${field}\\b`).test(liveStage), `the live describe stage reports ${field}`);
			assert.ok(new RegExp(`stage\\.${field}`).test(openScene), `opening a scene restores ${field}`);
			assert.ok(new RegExp(`\\b${field}\\b`).test(snapshot), `the undo snapshot carries ${field}`);
		}
		assert.ok(/startupStage\.environment\b/.test(source), "the first painted session reads the stored description");
		assert.ok(/startupStage\.style\b/.test(source), "the first painted session reads the stored look");
		assert.ok(/startupStage\.hasEnvSheet\b/.test(source), "the first painted session reads the stored sheet flag");
	},
	"the studio call sites are wired to the recording seams"() {
		const lightFoldout = source.slice(source.indexOf('<Foldout hidden={!keyLightSelected}'), source.indexOf('<Foldout hidden={!isCameraSelection}'));
		assert.ok(/onChange=\{\(value\) => changeKeyLight\("intensity"/.test(lightFoldout), "the Brightness slider records");
		assert.ok(/onChange=\{\(value\) => changeKeyLight\("warmth"/.test(lightFoldout), "the Warm/Cool slider records");
		assert.ok(/onClick=\{resetKeyLight\}/.test(lightFoldout), "Reset light records");
		const puck = source.slice(source.indexOf("<KeyLightPuck"), source.indexOf("<KeyLightPuck") + 900);
		assert.ok(/onChange=\{\(patch\) => changeKeyLight\("puck", patch\)\}/.test(puck), "the sun puck records on its first move");
		assert.ok(/onDragEnd=\{endGestureUndo\}/.test(puck), "the sun puck closes its gesture with the prop it already accepts");
		const gizmo = source.slice(source.indexOf("object={cameraGizmoObject ?? lightGizmoObject ?? selectedSceneObject}"), source.indexOf("onGroundClick={waypointMode"));
		assert.ok(/id === "__keylight__" \? changeKeyLightFromGizmo/.test(gizmo), "the gizmo still routes the light through its own writer");
		assert.ok(/if \(lightGizmoObject\) endGestureUndo\(\);/.test(gizmo), "the light gizmo closes its gesture on drag end");
		const transform = source.slice(source.indexOf('title={workflowMode === "motion" ? ko("Placement"'), source.indexOf('<Foldout hidden={!isCharacterSelection} defaultOpen={false} title={ko("Rig"'));
		for (const axis of ["x", "y", "z"]) {
			assert.ok(new RegExp(`onChange: \\(${axis}\\) => changeInspectorCharacter\\("${axis}"`).test(transform), `the ${axis} row records`);
			assert.ok(new RegExp(`onScrubStart: \\(\\) => beginGestureUndo\\(\`character:\\$\\{activeChar\\.id\\}:${axis}\``).test(transform), `the ${axis} row opens one entry at scrub start`);
		}
		assert.equal((transform.match(/onScrubEnd: endGestureUndo/g) ?? []).length, 5, "every character position field closes its scrub");
		assert.ok(/onChange=\{\(rot\) => changeInspectorCharacter\("rot", \{ rot \}\)\}/.test(transform), "the Rotation slider records");
		assert.ok(/onChange=\{\(scale\) => changeInspectorCharacter\("scale", \{ scale \}\)\}/.test(transform), "the Scale slider records");
		const environmentFoldout = source.slice(source.indexOf('<Foldout hidden={selectedHierarchyId !== "environment"}'), source.indexOf('<Foldout hidden={selectedHierarchyId !== "props"}'));
		assert.ok(/changeEnvironmentImage\(dataUrl\)/.test(environmentFoldout), "picking an environment reference records");
		assert.ok(/onClear=\{\(\) => changeEnvironmentImage\(null\)\}/.test(environmentFoldout), "clearing the environment reference records");
		assert.ok(/recordSessionUndo\(environmentTextSessionRef, "environment:description"\)/.test(environmentFoldout), "the description records one entry per typing session");
		assert.ok(/recordSessionUndo\(environmentTextSessionRef, "environment:style"\)/.test(environmentFoldout), "the look records one entry per typing session");
		assert.ok(/recordCharacterUndo\(\); setHasEnvSheet/.test(environmentFoldout), "the environment sheet toggle records");
		assert.ok(/window\.addEventListener\("pointerup", end, true\)/.test(source), "a pointer release ends the open gesture");
		assert.ok(/window\.addEventListener\("keyup", end, true\)/.test(source), "a key release ends the open gesture");
	},
};

let failures = 0;
for (const [name, run] of Object.entries(cases)) {
	try {
		run();
		console.log("PASS", name);
	} catch (error) {
		failures += 1;
		console.error("FAIL", name, "\n  " + String(error?.message).split("\n").join("\n  "));
	}
}
const total = Object.keys(cases).length;
console.log(`Studio undo hygiene: ${total - failures}/${total} passed`);
process.exit(failures ? 1 : 0);

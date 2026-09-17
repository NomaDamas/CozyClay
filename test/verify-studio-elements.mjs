#!/usr/bin/env node
import assert from "node:assert/strict";
import { STUDIO_ELEMENTS, elementByPath, elementsFor } from "../src/studio-elements.js";
import { buildPatchSchema, patchValueSchema, STUDIO_PATCHABLE_PATHS, STUDIO_PATCH_KINDS, validateStudioSchema } from "../src/studio-agent-protocol.js";
import { createCharacterEntry, createSceneStage } from "../src/scenes.js";
import { normalizeSceneObject } from "../src/scene-objects.js";
import { createShotAuthoringDocument } from "../src/shot-authoring.js";

const normalizers = {
	createCharacterEntry,
	createSceneStage,
	normalizeSceneObject,
	repairCamera: (camera) => createShotAuthoringDocument({ frameCount: 96, shots: [{ id: "shot-test", startFrame: 0, endFrame: 95, camera }] }).shots[0].camera,
};
const allowedTypes = new Set(["number", "string", "boolean", "vec3", "color", "enum", "id", "image", "array"]);
const allowedExposure = new Set(["patch", "composite", "readonly", "todo"]);
const allowedDomains = new Set(["cast", "objects", "shot", "stage", null]);
const allowedNormalizers = new Set([...Object.keys(normalizers), null]);

function validate(entries) {
	const paths = new Set();
	for (const entry of entries) {
		assert.equal(typeof entry.path, "string");
		assert.ok(entry.path && !paths.has(entry.path), `duplicate path: ${entry.path}`);
		paths.add(entry.path);
		assert.ok(allowedTypes.has(entry.type), `unknown type: ${entry.path}`);
		assert.equal(typeof entry.persisted, "boolean", entry.path);
		assert.ok(allowedExposure.has(entry.agentExposure), `unknown agent exposure: ${entry.path}`);
		assert.ok(allowedDomains.has(entry.undoDomain), `unknown undo domain: ${entry.path}`);
		assert.ok(allowedNormalizers.has(entry.normalizer), `unknown normalizer: ${entry.normalizer}`);
		if (entry.type === "enum") assert.ok(Array.isArray(entry.enum) && entry.enum.length > 0, entry.path);
		if (entry.min !== undefined) assert.ok(Number.isFinite(entry.min), entry.path);
		if (entry.max !== undefined) assert.ok(Number.isFinite(entry.max), entry.path);
		if (entry.min !== undefined && entry.max !== undefined) assert.ok(entry.min <= entry.max, entry.path);
	}
}

validate(STUDIO_ELEMENTS);
assert.throws(() => validate([STUDIO_ELEMENTS[0], STUDIO_ELEMENTS[0]]), /duplicate path/);
assert.throws(() => validate([{ ...STUDIO_ELEMENTS[0], normalizer: "unknown" }]), /unknown normalizer/);
assert.throws(() => validate([{ ...STUDIO_ELEMENTS[0], undoDomain: "unknown" }]), /unknown undo domain/);
assert.ok(Object.isFrozen(STUDIO_ELEMENTS));
for (const entry of STUDIO_ELEMENTS) {
	assert.ok(Object.isFrozen(entry), entry.path);
	if (entry.enum) assert.ok(Object.isFrozen(entry.enum), entry.path);
	assert.equal(elementByPath(entry.path), entry);
}
assert.equal(elementByPath("missing.path"), undefined);
for (const name of [...Object.keys(normalizers), null]) {
	assert.deepEqual(elementsFor(name), STUDIO_ELEMENTS.filter((entry) => entry.normalizer === name));
}

const get = (value, path) => path.split(".").reduce((current, key) => current?.[key], value);
const rail = [{ x: -2, z: 1 }, { x: 3, z: 4 }];
const framing = { pos: { x: 2, y: 3, z: 4 }, yaw: 0.25, pitch: -0.2, fovDeg: 42 };

const shotDocument = (shot) => createShotAuthoringDocument({ frameCount: 96, shots: [{ id: "shot-test", startFrame: 0, endFrame: 95, ...shot }] }).shots[0];

function makeCase(entry) {
	if (entry.path === "shot.targetModel") {
		const input = { targetModel: "seedance-2.5" };
		return { input, output: shotDocument(input), read: (output) => output.targetModel ?? null };
	}
	if (entry.normalizer === "createCharacterEntry") {
		const input = { id: "char-test", model: "y-bot-tpose", layer: { waypoints: [], promptClips: [] }, motionRef: { url: "https://example.test/original.npz" } };
		const field = entry.path.slice("character.".length);
		if (field === "tint") input.tint = "#a1b2c3";
		if (field === "identityImage") input.identityImage = "data:image/png;base64,AAAA";
		if (field === "pose") input.pose = { id: "pose-authored", label: "Authored", bones: { hips: [0, 0, 0, 1] } };
		if (field === "position") Object.assign(input, { x: 1.25, y: 2.5, z: -3.75 });
		if (field === "rot") input.rot = 15;
		if (field === "scale") input.scale = 1.75;
		if (field === "subject") input.subject = "authored-test";
		if (field === "hidden") input.hidden = true;
		if (field === "model") input.model = "x-bot-tpose";
		if (field === "promptBlocks") input.layer.promptClips = [{ id: "prompt-authored", startFrame: 12, endFrame: 36, prompt: "Walk forward" }];
		if (field === "motionRef.url") input.motionRef.url = "https://example.test/authored.npz";
		if (field === "motionRef.motionId") input.motionRef = { motionId: "a".repeat(64), url: "https://example.test/authored.npz" };
		return { input, output: createCharacterEntry(input), read: (output) => field === "position" ? [output.x, output.y, output.z] : field === "promptBlocks" ? output.layer.promptClips : field === "pose" ? output.pose?.id ?? null : get(output, field) };
	}
	if (entry.normalizer === "createSceneStage") {
		const input = { characters: [], shotAspect: "16:9", keyLight: { x: 6, y: 9, z: 4, intensity: 1.12, warmth: 0.5 } };
		const field = entry.path.slice("stage.".length);
		if (field === "camera") input.shotAspect = "9:16";
		if (field === "environmentImage") input.environmentImage = "data:image/png;base64,BBBB";
		if (field === "environment") input.environment = "a rainy rooftop at dusk";
		if (field === "style") input.style = "handheld 16mm, sodium streetlight";
		if (field === "hasEnvSheet") input.hasEnvSheet = true;
		if (field.startsWith("keyLight.")) input.keyLight = { x: -1.5, y: 7.25, z: 2.5, intensity: 2.75, warmth: 0.25 };
		return { input, output: createSceneStage(input), read: (output) => field.startsWith("keyLight.") ? output.keyLight[field.slice("keyLight.".length)] : field === "camera" ? output.shotAspect : output[field] };
	}
	if (entry.normalizer === "normalizeSceneObject") {
		const field = entry.path.slice("object.".length);
		const input = { id: "object-test", renderer: "cube", x: 0, y: 0, z: 0, rot: 0, rotX: 0, rotZ: 0, scaleX: 1, scaleY: 1, scaleZ: 1, name: "Cube", color: "#c2c6c8", parent: null, path: null };
		if (field === "renderer") input.renderer = "sphere";
		if (field === "position") Object.assign(input, { x: 1.25, y: 2.5, z: -3.75 });
		if (field === "rotation") Object.assign(input, { rot: 15, rotX: 25, rotZ: -35 });
		if (field === "scale") Object.assign(input, { scaleX: 1.25, scaleY: 1.5, scaleZ: 1.75 });
		if (field === "name") input.name = "Authored prop";
		if (field === "color") input.color = "#a1b2c3";
		if (field === "parent") input.parent = "parent-object";
		if (field === "path") input.path = { points: [{ x: 1, y: 0, z: 2 }, { x: 4, y: 1, z: 5 }] };
		if (field === "cutout") Object.assign(input, { renderer: "cutout", assetId: "image-authored", aspect: 1.5, height: 2 });
		return {
			input,
			output: normalizeSceneObject(input),
			read: (output) => field === "position" ? [output.x, output.y, output.z]
				: field === "rotation" ? [output.rot, output.rotX, output.rotZ]
				: field === "scale" ? [output.scaleX, output.scaleY, output.scaleZ]
				: field === "cutout" ? output.assetId : get(output, field),
		};
	}
	if (entry.normalizer === "repairCamera") {
		const input = { mode: "rail", cameraRail: rail, railFollow: null, craneHeight: null, dollyTiming: null, followCam: {} };
		return { input, output: normalizers.repairCamera(input), read: (output) => output.cameraRail };
	}
	return null;
}

const expected = new Map([
	["character.position", [1.25, 2.5, -3.75]],
	["character.rot", 15],
	["character.scale", 1.75],
	["character.subject", "authored-test"],
	["character.hidden", true],
	["character.model", "x-bot-tpose"],
	["character.promptBlocks", [{ id: "prompt-authored", startFrame: 12, endFrame: 36, prompt: "Walk forward" }]],
	["character.motionRef.url", "https://example.test/authored.npz"],
	["character.motionRef.motionId", "a".repeat(64)],
	["character.tint", "#a1b2c3"],
	["character.identityImage", "data:image/png;base64,AAAA"],
	["character.pose", "pose-authored"],
	["stage.camera", "9:16"],
	["stage.keyLight.x", -1.5],
	["stage.keyLight.y", 7.25],
	["stage.keyLight.z", 2.5],
	["stage.keyLight.intensity", 2.75],
	["stage.keyLight.warmth", 0.25],
	["stage.environmentImage", "data:image/png;base64,BBBB"],
	["stage.environment", "a rainy rooftop at dusk"],
	["stage.style", "handheld 16mm, sodium streetlight"],
	["stage.hasEnvSheet", true],
	["shot.targetModel", "seedance-2.5"],
	["object.renderer", "sphere"],
	["object.position", [1.25, 2.5, -3.75]],
	["object.rotation", [15, 25, -35]],
	["object.scale", [1.25, 1.5, 1.75]],
	["object.name", "Authored prop"],
	["object.color", "#a1b2c3"],
	["object.parent", "parent-object"],
	["object.path", { points: [{ x: 1, y: 0, z: 2 }, { x: 4, y: 1, z: 5 }], timing: null, speed: 0, faceTravel: true, loop: false, extend: false }],
	["object.cutout", "image-authored"],
]);

let verified = 0;
let todo = 0;
for (const entry of STUDIO_ELEMENTS) {
	if (entry.agentExposure === "todo") {
		todo += 1;
		console.log(`TODO ${entry.path}`);
	}
	if (!entry.persisted || entry.agentExposure === "todo" || !entry.normalizer) continue;
	const testCase = makeCase(entry);
	assert.ok(testCase, `no fixture for ${entry.path}`);
	const expectedValue = expected.get(entry.path);
	assert.notEqual(expectedValue, undefined, `no non-default fixture for ${entry.path}`);
	assert.deepEqual(testCase.read(testCase.output), expectedValue, `persistence lost ${entry.path}`);
	verified += 1;
}

/* Reverse completeness: every element the table exposes to the agent as a
 * patch is carriable by the generated patch schema, and nothing else is. */
const generated = buildPatchSchema(STUDIO_ELEMENTS);
const sample = {
	number: (entry) => (entry.min ?? 0) + ((entry.max ?? 1) - (entry.min ?? 0)) / 2,
	boolean: () => true,
	enum: (entry) => entry.enum[0],
	id: () => "sample-id",
	color: () => "#a1b2c3",
	image: () => "data:image/png;base64,AAAA",
	vec3: () => ({ x: 1, y: 2, z: 3 }),
	string: () => "sample text",
	array: (entry) => (entry.path === "object.path"
		? { points: [{ x: 0, y: 0, z: 0 }, { x: 1, y: 0, z: 1 }] }
		: entry.path === "shot.cameraKeys"
			? [{ frame: 4, framing: { pos: { x: 0, y: 1, z: 2 }, yaw: 0.1, pitch: -0.2, fovDeg: 40 } }]
			: [{ startFrame: 0, endFrame: 24, text: "walk" }]),
};
let patchable = 0;
for (const entry of STUDIO_ELEMENTS) {
	const kind = STUDIO_PATCH_KINDS.find((candidate) => entry.path.startsWith(`${candidate}.`));
	if (entry.agentExposure !== "patch") {
		if (kind) assert.equal(STUDIO_PATCHABLE_PATHS[kind].includes(entry.path), false, `${entry.path} is not exposed for patching`);
		continue;
	}
	assert.ok(kind, `patch element outside every patch kind: ${entry.path}`);
	const key = entry.path.slice(kind.length + 1);
	assert.ok(patchValueSchema(entry), `no value schema for patch element ${entry.path}`);
	assert.ok(generated[kind].properties[key], `buildPatchSchema omits ${entry.path}`);
	assert.ok(STUDIO_PATCHABLE_PATHS[kind].includes(entry.path), `${entry.path} is missing from the published vocabulary`);
	// The declared value must actually pass its own generated schema.
	validateStudioSchema(generated[kind].properties[key], sample[entry.type](entry));
	patchable += 1;
}
for (const kind of STUDIO_PATCH_KINDS) {
	for (const path of STUDIO_PATCHABLE_PATHS[kind]) assert.equal(elementByPath(path)?.agentExposure, "patch", `${path} is published without a patch declaration`);
}

console.log(`elements=${STUDIO_ELEMENTS.length} persisted-verified=${verified} patchable=${patchable} todo=${todo}`);

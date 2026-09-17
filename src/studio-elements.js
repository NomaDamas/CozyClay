// The authored Studio surface, declared once for future patch, schema and
// history layers. This module is intentionally data-only: it does not import
// React or any persistence implementation.

const freezeEntry = (entry) => Object.freeze({
	...entry,
	...(entry.enum ? { enum: Object.freeze([...entry.enum]) } : {}),
});

const entries = [
	{ path: "character.position", type: "vec3", persisted: true, undoDomain: "cast", agentExposure: "patch", normalizer: "createCharacterEntry", note: "x/y/z metres" },
	{ path: "character.rot", type: "number", persisted: true, undoDomain: "cast", agentExposure: "patch", normalizer: "createCharacterEntry", note: "yaw degrees" },
	{ path: "character.scale", type: "number", persisted: true, undoDomain: "cast", agentExposure: "patch", normalizer: "createCharacterEntry", min: 0.2, max: 3 },
	{ path: "character.subject", type: "string", persisted: true, undoDomain: "cast", agentExposure: "patch", normalizer: "createCharacterEntry" },
	{ path: "character.hidden", type: "boolean", persisted: true, undoDomain: "cast", agentExposure: "patch", normalizer: "createCharacterEntry" },
	{ path: "character.model", type: "enum", persisted: true, undoDomain: "cast", agentExposure: "patch", normalizer: "createCharacterEntry", enum: ["y-bot-tpose", "x-bot-tpose"] },
	{ path: "character.tint", type: "color", persisted: true, undoDomain: "cast", agentExposure: "todo", normalizer: "createCharacterEntry", note: "agent exposure gap" },
	{ path: "character.identityImage", type: "image", persisted: true, undoDomain: "cast", agentExposure: "todo", normalizer: "createCharacterEntry", note: "agent exposure gap" },
	{ path: "character.pose", type: "id", persisted: true, undoDomain: "cast", agentExposure: "todo", normalizer: "createCharacterEntry", note: "static pose; agent exposure gap" },
	{ path: "character.waypoints", type: "array", persisted: true, undoDomain: "cast", agentExposure: "todo", normalizer: "createCharacterEntry", note: "agent exposure gap" },
	{ path: "character.promptBlocks", type: "array", persisted: true, undoDomain: "cast", agentExposure: "patch", normalizer: "createCharacterEntry", note: "stored at layer.promptClips" },
	{ path: "character.motionRef.url", type: "string", persisted: true, undoDomain: "cast", agentExposure: "patch", normalizer: "createCharacterEntry" },
	{ path: "character.motionRef.motionId", type: "id", persisted: true, undoDomain: "cast", agentExposure: "patch", normalizer: "createCharacterEntry" },
	{ path: "character.sessionMotion", type: "array", persisted: false, undoDomain: "cast", agentExposure: "readonly", normalizer: "createCharacterEntry", note: "dropped by createCharacterEntry" },
	{ path: "character.ikKeys", type: "array", persisted: false, undoDomain: "cast", agentExposure: "todo", normalizer: "createCharacterEntry", note: "dropped by createCharacterEntry" },
	{ path: "object.renderer", type: "enum", persisted: true, undoDomain: "objects", agentExposure: "patch", normalizer: "normalizeSceneObject", enum: ["cube", "sphere", "capsule", "cylinder", "cone", "plane", "chair", "car", "small-plane"] },
	{ path: "object.position", type: "vec3", persisted: true, undoDomain: "objects", agentExposure: "patch", normalizer: "normalizeSceneObject" },
	{ path: "object.rotation", type: "vec3", persisted: true, undoDomain: "objects", agentExposure: "patch", normalizer: "normalizeSceneObject", note: "rot/rotX/rotZ degrees" },
	{ path: "object.scale", type: "vec3", persisted: true, undoDomain: "objects", agentExposure: "patch", normalizer: "normalizeSceneObject" },
	{ path: "object.name", type: "string", persisted: true, undoDomain: "objects", agentExposure: "patch", normalizer: "normalizeSceneObject" },
	{ path: "object.color", type: "color", persisted: true, undoDomain: "objects", agentExposure: "patch", normalizer: "normalizeSceneObject" },
	{ path: "object.parent", type: "id", persisted: true, undoDomain: "objects", agentExposure: "patch", normalizer: "normalizeSceneObject" },
	{ path: "object.attach", type: "id", persisted: true, undoDomain: "objects", agentExposure: "todo", normalizer: "normalizeSceneObject", note: "agent exposure gap" },
	{ path: "object.path", type: "array", persisted: true, undoDomain: "objects", agentExposure: "patch", normalizer: "normalizeSceneObject" },
	{ path: "object.remove", type: "boolean", persisted: true, undoDomain: "objects", agentExposure: "patch", normalizer: null, note: "lifecycle operation, not a document field" },
	{ path: "object.cutout", type: "image", persisted: true, undoDomain: "objects", agentExposure: "composite", normalizer: "normalizeSceneObject", note: "assetId-backed cutout record" },
	{ path: "stage.keyLight", type: "array", persisted: true, undoDomain: "stage", agentExposure: "todo", normalizer: "createSceneStage", note: "x/y/z/intensity/warmth; agent exposure gap" },
	{ path: "stage.environmentImage", type: "image", persisted: true, undoDomain: "stage", agentExposure: "todo", normalizer: "createSceneStage", note: "agent exposure gap" },
	{ path: "environment.description", type: "string", persisted: false, undoDomain: null, agentExposure: "readonly", normalizer: null, note: "session state, not in scenes.js" },
	{ path: "stage.camera", type: "enum", persisted: true, undoDomain: "stage", agentExposure: "patch", normalizer: "createSceneStage", enum: ["16:9", "2.39:1", "9:16", "1:1", "4:3", "12:7"], note: "shotAspect/cameraPresetId/sensorId" },
	{ path: "shot.crud", type: "array", persisted: true, undoDomain: "shot", agentExposure: "todo", normalizer: null, note: "create/split/duplicate/reorder/remove/range; agent exposure gap" },
	{ path: "shot.cameraKeys", type: "array", persisted: true, undoDomain: "shot", agentExposure: "patch", normalizer: null },
	{ path: "shot.cameraRail", type: "array", persisted: true, undoDomain: "shot", agentExposure: "todo", normalizer: "repairCamera", note: "rail/crane/dolly timing; agent exposure gap" },
	{ path: "shot.targetModel", type: "id", persisted: true, undoDomain: "shot", agentExposure: "todo", normalizer: null, note: "agent exposure gap" },
	{ path: "shot.freeCamera", type: "vec3", persisted: false, undoDomain: "shot", agentExposure: "readonly", normalizer: null, note: "transient until keyed" },
	{ path: "scenes", type: "array", persisted: true, undoDomain: null, agentExposure: "composite", normalizer: null },
	{ path: "project", type: "string", persisted: true, undoDomain: null, agentExposure: "composite", normalizer: null, note: "save/open project file" },
	{ path: "selection", type: "id", persisted: false, undoDomain: null, agentExposure: "readonly", normalizer: null },
	{ path: "timeline", type: "number", persisted: false, undoDomain: null, agentExposure: "readonly", normalizer: null },
	{ path: "view.mode", type: "enum", persisted: false, undoDomain: null, agentExposure: "readonly", normalizer: null, enum: ["scene", "camera", "motion"] },
	{ path: "view.partColoursGuideModeInset", type: "array", persisted: false, undoDomain: null, agentExposure: "todo", normalizer: null, note: "partColours/guideMode/inset; not a document field" },
	{ path: "read.sceneDescription", type: "string", persisted: false, undoDomain: null, agentExposure: "readonly", normalizer: null },
	{ path: "read.captureFrame", type: "image", persisted: false, undoDomain: null, agentExposure: "readonly", normalizer: null },
	{ path: "undo", type: "boolean", persisted: false, undoDomain: null, agentExposure: "readonly", normalizer: null },
];

export const STUDIO_ELEMENTS = Object.freeze(entries.map(freezeEntry));

export function elementByPath(path) {
	return STUDIO_ELEMENTS.find((entry) => entry.path === path);
}

export function elementsFor(normalizer) {
	return STUDIO_ELEMENTS.filter((entry) => entry.normalizer === normalizer);
}

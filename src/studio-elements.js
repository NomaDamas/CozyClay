// The authored Studio surface, declared once for future patch, schema and
// history layers. This module is intentionally data-only: it does not import
// React or any persistence implementation. agentExposure "action" means the
// agent edits the element through the registered Studio actions it names in
// `actions` (src/studio-actions.js), the same code path as the UI controls.

const freezeBounds = (bounds) => bounds && typeof bounds === "object"
	? Object.freeze({ ...bounds })
	: bounds;

const freezeEntry = (entry) => Object.freeze({
	...entry,
	...(entry.enum ? { enum: Object.freeze([...entry.enum]) } : {}),
	...(entry.actions ? { actions: Object.freeze([...entry.actions]) } : {}),
	...(entry.min && typeof entry.min === "object" ? { min: freezeBounds(entry.min) } : {}),
	...(entry.max && typeof entry.max === "object" ? { max: freezeBounds(entry.max) } : {}),
	...(entry.gizmo ? { gizmo: Object.freeze({ min: freezeBounds(entry.gizmo.min), max: freezeBounds(entry.gizmo.max) }) } : {}),
});

const entries = [
	{ path: "character.position", type: "vec3", persisted: true, undoDomain: "cast", agentExposure: "patch", normalizer: "createCharacterEntry", min: { x: -240, y: 0, z: -240 }, max: { x: 240, y: 240, z: 240 }, gizmo: { min: { x: -4, y: 0, z: -4 }, max: { x: 4, y: 240, z: 4 } }, note: "y is the feet" },
	{ path: "character.rot", type: "number", persisted: true, undoDomain: "cast", agentExposure: "patch", normalizer: "createCharacterEntry", min: -180, max: 180, angle: true, note: "yaw degrees, wrapped at the upper bound" },
	{ path: "character.scale", type: "number", persisted: true, undoDomain: "cast", agentExposure: "patch", normalizer: "createCharacterEntry", min: 0.2, max: 3 },
	{ path: "character.subject", type: "string", persisted: true, undoDomain: "cast", agentExposure: "patch", normalizer: "createCharacterEntry" },
	{ path: "character.hidden", type: "boolean", persisted: true, undoDomain: "cast", agentExposure: "patch", normalizer: "createCharacterEntry" },
	{ path: "character.model", type: "enum", persisted: true, undoDomain: "cast", agentExposure: "patch", normalizer: "createCharacterEntry", enum: ["y-bot-tpose", "x-bot-tpose"] },
	{ path: "character.tint", type: "color", persisted: true, undoDomain: "cast", agentExposure: "patch", normalizer: "createCharacterEntry" },
	{ path: "character.identityImage", type: "image", persisted: true, undoDomain: "cast", agentExposure: "patch", normalizer: "createCharacterEntry", note: "data:image only" },
	{ path: "character.pose", type: "id", persisted: true, undoDomain: "cast", agentExposure: "patch", normalizer: "createCharacterEntry" },
	{ path: "character.waypoints", type: "array", persisted: true, undoDomain: "cast", agentExposure: "action", normalizer: "createCharacterEntry", actions: ["character.addWaypoint", "character.moveWaypoint", "character.removeWaypoint", "character.clearWaypoints"], note: "root path pins, addressed by frame" },
	{ path: "character.promptBlocks", type: "array", persisted: true, undoDomain: "cast", agentExposure: "patch", normalizer: "createCharacterEntry", note: "stored at layer.promptClips" },
	{ path: "character.motionRef.url", type: "string", persisted: true, undoDomain: "cast", agentExposure: "patch", normalizer: "createCharacterEntry" },
	{ path: "character.motionRef.motionId", type: "id", persisted: true, undoDomain: "cast", agentExposure: "patch", normalizer: "createCharacterEntry" },
	{ path: "character.sessionMotion", type: "array", persisted: false, undoDomain: "cast", agentExposure: "readonly", normalizer: "createCharacterEntry", note: "dropped by createCharacterEntry" },
	{ path: "character.ikKeys", type: "array", persisted: false, undoDomain: "cast", agentExposure: "action", normalizer: "createCharacterEntry", actions: ["character.setIkKey", "character.removeIkKey", "character.clearIkKeys"], note: "dropped by createCharacterEntry; keys travel as JSON quaternions/positions" },
	{ path: "object.renderer", type: "enum", persisted: true, undoDomain: "objects", agentExposure: "patch", normalizer: "normalizeSceneObject", enum: ["cube", "sphere", "capsule", "cylinder", "cone", "plane", "chair", "car", "small-plane"] },
	{ path: "object.position", type: "vec3", persisted: true, undoDomain: "objects", agentExposure: "patch", normalizer: "normalizeSceneObject", min: { x: -240, y: 0, z: -240 }, max: { x: 240, y: 240, z: 240 }, note: "y is the object's base: y=0 rests on the floor; height/supportY rise from it" },
	{ path: "object.rotation", type: "vec3", persisted: true, undoDomain: "objects", agentExposure: "patch", normalizer: "normalizeSceneObject", min: { x: -180, y: -180, z: -180 }, max: { x: 180, y: 180, z: 180 }, note: "rot/rotX/rotZ degrees, wrapped at the upper bound" },
	{ path: "object.scale", type: "vec3", persisted: true, undoDomain: "objects", agentExposure: "patch", normalizer: "normalizeSceneObject", min: { x: 0.1, y: 0.1, z: 0.1 }, max: { x: 100, y: 100, z: 100 } },
	{ path: "object.name", type: "string", persisted: true, undoDomain: "objects", agentExposure: "patch", normalizer: "normalizeSceneObject" },
	{ path: "object.color", type: "color", persisted: true, undoDomain: "objects", agentExposure: "patch", normalizer: "normalizeSceneObject" },
	{ path: "object.parent", type: "id", persisted: true, undoDomain: "objects", agentExposure: "patch", normalizer: "normalizeSceneObject" },
	{ path: "object.attach", type: "id", persisted: true, undoDomain: "objects", agentExposure: "action", normalizer: "normalizeSceneObject", actions: ["object.attach", "object.detach"], note: "carried by a character's root or bone; channels convert so the prop stays put" },
	{ path: "object.path", type: "array", persisted: true, undoDomain: "objects", agentExposure: "patch", normalizer: "normalizeSceneObject" },
	{ path: "object.remove", type: "boolean", persisted: true, undoDomain: "objects", agentExposure: "patch", normalizer: null, note: "lifecycle operation, not a document field" },
	{ path: "object.cutout", type: "image", persisted: true, undoDomain: "objects", agentExposure: "composite", normalizer: "normalizeSceneObject", note: "assetId-backed cutout record" },
	{ path: "stage.keyLight.x", type: "number", persisted: true, undoDomain: "stage", agentExposure: "patch", normalizer: "createSceneStage", min: -30, max: 30 },
	{ path: "stage.keyLight.y", type: "number", persisted: true, undoDomain: "stage", agentExposure: "patch", normalizer: "createSceneStage", min: 0.5, max: 30 },
	{ path: "stage.keyLight.z", type: "number", persisted: true, undoDomain: "stage", agentExposure: "patch", normalizer: "createSceneStage", min: -30, max: 30 },
	{ path: "stage.keyLight.intensity", type: "number", persisted: true, undoDomain: "stage", agentExposure: "patch", normalizer: "createSceneStage", min: 0, max: 4 },
	{ path: "stage.keyLight.warmth", type: "number", persisted: true, undoDomain: "stage", agentExposure: "patch", normalizer: "createSceneStage", min: 0, max: 1 },
	{ path: "stage.environmentImage", type: "image", persisted: true, undoDomain: "stage", agentExposure: "patch", normalizer: "createSceneStage", note: "data:image only" },
	{ path: "stage.environment", type: "string", persisted: true, undoDomain: "stage", agentExposure: "patch", normalizer: "createSceneStage", note: "location description every shot prompt is built from" },
	{ path: "stage.style", type: "string", persisted: true, undoDomain: "stage", agentExposure: "patch", normalizer: "createSceneStage", note: "look / style line for shot prompts" },
	{ path: "stage.hasEnvSheet", type: "boolean", persisted: true, undoDomain: "stage", agentExposure: "patch", normalizer: "createSceneStage", note: "author supplies an environment sheet instead of a description" },
	{ path: "stage.camera", type: "enum", persisted: true, undoDomain: "stage", agentExposure: "patch", normalizer: "createSceneStage", enum: ["16:9", "2.39:1", "9:16", "1:1", "4:3", "12:7", "fal 480P"], note: "shotAspect/cameraPresetId/sensorId" },
	{ path: "shot.crud", type: "array", persisted: true, undoDomain: "shot", agentExposure: "action", normalizer: null, actions: ["shot.create", "shot.split", "shot.duplicate", "shot.remove", "shot.setRange", "shot.reorder"], note: "create/split/duplicate/reorder/remove/range through the shared action registry" },
	{ path: "shot.cameraKeys", type: "array", persisted: true, undoDomain: "shot", agentExposure: "patch", normalizer: null, frameMin: 0 },
	{ path: "shot.cameraRail", type: "array", persisted: true, undoDomain: "shot", agentExposure: "action", normalizer: "repairCamera", actions: ["shot.setCameraRail", "shot.clearCameraRail"], note: "rail points; crane/dolly timing follow the shot's camera block" },
	{ path: "shot.targetModel", type: "id", persisted: true, undoDomain: "shot", agentExposure: "patch", normalizer: "repairCamera" },
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

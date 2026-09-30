// The authored Studio surface, declared once for future patch, schema and
// history layers. This module is intentionally data-only: it does not import
// React or any persistence implementation. Fields use generic set/read;
// lifecycle and composite elements name the commands that own them.

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
	{ path: "character.position", type: "vec3", persisted: true, undoDomain: "cast", normalizer: "createCharacterEntry", min: { x: -240, y: 0, z: -240 }, max: { x: 240, y: 240, z: 240 }, gizmo: { min: { x: -4, y: 0, z: -4 }, max: { x: 4, y: 240, z: 4 } }, note: "y is the feet" },
	{ path: "character.rot", type: "number", persisted: true, undoDomain: "cast", normalizer: "createCharacterEntry", min: -180, max: 180, angle: true, note: "yaw degrees, wrapped at the upper bound" },
	{ path: "character.scale", type: "number", persisted: true, undoDomain: "cast", normalizer: "createCharacterEntry", min: 0.2, max: 3 },
	{ path: "character.subject", type: "string", persisted: true, undoDomain: "cast", normalizer: "createCharacterEntry" },
	{ path: "character.hidden", type: "boolean", persisted: true, undoDomain: "cast", normalizer: "createCharacterEntry" },
	{ path: "character.model", type: "enum", persisted: true, undoDomain: "cast", normalizer: "createCharacterEntry", enum: ["y-bot-tpose", "x-bot-tpose"] },
	{ path: "character.tint", type: "color", persisted: true, undoDomain: "cast", normalizer: "createCharacterEntry" },
	{ path: "character.identityImage", type: "image", persisted: true, undoDomain: "cast", normalizer: "createCharacterEntry", note: "data:image only" },
	{ path: "character.pose", type: "id", persisted: true, undoDomain: "cast", normalizer: "createCharacterEntry" },
	{ path: "character.waypoints", type: "array", persisted: true, undoDomain: "cast", normalizer: "createCharacterEntry", actions: ["character.addWaypoint", "character.moveWaypoint", "character.removeWaypoint", "character.clearWaypoints"], note: "root path pins, addressed by frame" },
	{ path: "character.promptBlocks", type: "array", persisted: true, undoDomain: "cast", normalizer: "createCharacterEntry", note: "stored at layer.promptClips" },
	{ path: "character.motionRef.url", type: "string", persisted: true, undoDomain: "cast", normalizer: "createCharacterEntry" },
	{ path: "character.motionRef.motionId", type: "id", persisted: true, undoDomain: "cast", normalizer: "createCharacterEntry" },
	{ path: "character.sessionMotion", type: "array", persisted: false, undoDomain: "cast", normalizer: "createCharacterEntry", note: "dropped by createCharacterEntry" },
	{ path: "character.ikKeys", type: "array", persisted: false, undoDomain: "cast", normalizer: "createCharacterEntry", actions: ["character.setIkKey", "character.removeIkKey", "character.clearIkKeys"], note: "dropped by createCharacterEntry; keys travel as JSON quaternions/positions" },
	{ path: "object.renderer", type: "enum", persisted: true, undoDomain: "objects", normalizer: "normalizeSceneObject", enum: ["cube", "sphere", "capsule", "cylinder", "cone", "plane", "chair", "car", "small-plane"] },
	{ path: "object.position", type: "vec3", persisted: true, undoDomain: "objects", normalizer: "normalizeSceneObject", min: { x: -240, y: 0, z: -240 }, max: { x: 240, y: 240, z: 240 }, note: "y is the object's base: y=0 rests on the floor; height/supportY rise from it" },
	{ path: "object.rotation", type: "vec3", persisted: true, undoDomain: "objects", normalizer: "normalizeSceneObject", min: { x: -180, y: -180, z: -180 }, max: { x: 180, y: 180, z: 180 }, note: "rot/rotX/rotZ degrees, wrapped at the upper bound" },
	{ path: "object.scale", type: "vec3", persisted: true, undoDomain: "objects", normalizer: "normalizeSceneObject", min: { x: 0.1, y: 0.1, z: 0.1 }, max: { x: 100, y: 100, z: 100 } },
	{ path: "object.name", type: "string", persisted: true, undoDomain: "objects", normalizer: "normalizeSceneObject" },
	{ path: "object.color", type: "color", persisted: true, undoDomain: "objects", normalizer: "normalizeSceneObject" },
	{ path: "object.parent", type: "id", persisted: true, undoDomain: "objects", normalizer: "normalizeSceneObject" },
	{ path: "object.attach", type: "id", persisted: true, undoDomain: "objects", normalizer: "normalizeSceneObject", actions: ["object.attach", "object.detach"], note: "carried by a character's root or bone; channels convert so the prop stays put" },
	{ path: "object.path", type: "array", persisted: true, undoDomain: "objects", normalizer: "normalizeSceneObject" },
	{ path: "object.remove", type: "boolean", persisted: true, undoDomain: "objects", normalizer: null, note: "lifecycle operation, not a document field" },
	{ path: "object.cutout", type: "image", persisted: true, undoDomain: "objects", normalizer: "normalizeSceneObject", actions: ["asset.import"], note: "assetId-backed cutout record; imported pictures and models are placed by asset.import" },
	{ path: "stage.keyLight.x", type: "number", persisted: true, undoDomain: "stage", normalizer: "createSceneStage", min: -30, max: 30 },
	{ path: "stage.keyLight.y", type: "number", persisted: true, undoDomain: "stage", normalizer: "createSceneStage", min: 0.5, max: 30 },
	{ path: "stage.keyLight.z", type: "number", persisted: true, undoDomain: "stage", normalizer: "createSceneStage", min: -30, max: 30 },
	{ path: "stage.keyLight.intensity", type: "number", persisted: true, undoDomain: "stage", normalizer: "createSceneStage", min: 0, max: 4 },
	{ path: "stage.keyLight.warmth", type: "number", persisted: true, undoDomain: "stage", normalizer: "createSceneStage", min: 0, max: 1 },
	{ path: "stage.environmentImage", type: "image", persisted: true, undoDomain: "stage", normalizer: "createSceneStage", note: "data:image only" },
	{ path: "stage.environment", type: "string", persisted: true, undoDomain: "stage", normalizer: "createSceneStage", note: "location description every shot prompt is built from" },
	{ path: "stage.style", type: "string", persisted: true, undoDomain: "stage", normalizer: "createSceneStage", note: "look / style line for shot prompts" },
	{ path: "stage.hasEnvSheet", type: "boolean", persisted: true, undoDomain: "stage", normalizer: "createSceneStage", note: "author supplies an environment sheet instead of a description" },
	{ path: "stage.camera", documentPath: "shotAspect", type: "enum", persisted: true, undoDomain: "stage", normalizer: "createSceneStage", enum: ["16:9", "2.39:1", "9:16", "1:1", "4:3", "12:7", "fal 480P"], note: "output aspect ratio" },
	{ path: "stage.cameraPresetId", type: "id", nullable: true, persisted: true, undoDomain: "stage", normalizer: "createSceneStage" },
	{ path: "stage.sensorId", type: "enum", persisted: true, undoDomain: "stage", normalizer: "createSceneStage", enum: ["super16", "super35", "fullFrame", "65mm"] },
	{ path: "shot.crud", type: "array", persisted: true, undoDomain: "shot", normalizer: null, actions: ["shot.create", "shot.split", "shot.duplicate", "shot.remove", "shot.setRange", "shot.reorder"], note: "create/split/duplicate/reorder/remove/range through the shared action registry" },
	{ path: "shot.cameraKeys", type: "array", persisted: true, undoDomain: "shot", normalizer: null, frameMin: 0 },
	{ path: "shot.cameraRail", type: "array", persisted: true, undoDomain: "shot", normalizer: "repairCamera", actions: ["shot.setCameraRail", "shot.clearCameraRail"], note: "rail points; crane/dolly timing follow the shot's camera block" },
	{ path: "shot.targetModel", type: "id", persisted: true, undoDomain: "shot", normalizer: "repairCamera" },
	{ path: "shot.freeCamera", type: "vec3", persisted: false, undoDomain: "shot", normalizer: null, note: "transient until keyed" },
	{ path: "scenes", type: "array", persisted: true, undoDomain: null, normalizer: null, actions: ["scene.create", "scene.duplicate", "scene.rename", "scene.delete", "scene.switch"], note: "the project's scene list and the open scene; outside the undo history" },
	{ path: "project", type: "string", persisted: true, undoDomain: null, normalizer: null, actions: ["project.save"], note: "save to the current project file; opening one needs the user's file picker" },
	{ path: "selection", type: "id", persisted: false, undoDomain: null, normalizer: null },
	{ path: "timeline", type: "number", persisted: false, undoDomain: null, normalizer: null },
	{ path: "view.mode", type: "enum", persisted: false, undoDomain: null, normalizer: null, enum: ["scene", "camera", "motion"] },
	{ path: "view.partColoursGuideModeInset", type: "array", persisted: false, undoDomain: null, normalizer: null, actions: ["view.setPartColours", "view.setGuideMode", "view.setInset"], note: "partColours/guideMode/inset; viewer settings, not document fields" },
	{ path: "read.sceneDescription", type: "string", persisted: false, undoDomain: null, normalizer: null },
	{ path: "read.captureFrame", type: "image", persisted: false, undoDomain: null, normalizer: null },
	{ path: "undo", type: "boolean", persisted: false, undoDomain: null, normalizer: null },
];

export const STUDIO_ELEMENTS = Object.freeze(entries.map(freezeEntry));

export function elementByPath(path) {
	return STUDIO_ELEMENTS.find((entry) => entry.path === path);
}

export function elementsFor(normalizer) {
	return STUDIO_ELEMENTS.filter((entry) => entry.normalizer === normalizer);
}

// One writable vocabulary for UI and agent commands, not a second allowlist.
export const isSettableElement = element => element.persisted !== false && !element.actions && !element.readOnly;

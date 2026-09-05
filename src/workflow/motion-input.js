import { SCENES_STORAGE_KEY, readSceneDocument } from "../scenes.js";

export const MOTION_INPUT_NODE_TYPE = "motion-input";
export const MOTION_INPUT_NODE_VERSION = 1;

function text(value, fallback = "") {
	return typeof value === "string" ? value : fallback;
}

function clone(value) {
	if (value === null || typeof value !== "object") return value;
	if (Array.isArray(value)) return value.map(clone);
	return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, clone(item)]));
}

/** Normalize a Motion Input node's serializable state. Object URLs are kept
 * in `objectUrl` for this tab only; `url` remains the durable same-origin ref. */
export function normalizeMotionInputData(input = {}) {
	const source = input && typeof input === "object" ? input : {};
	const url = text(source.url || source.motionUrl);
	const objectUrl = text(source.objectUrl);
	const characterId = text(source.characterId || source.targetCharacterId, "");
	return {
		type: MOTION_INPUT_NODE_TYPE,
		version: MOTION_INPUT_NODE_VERSION,
		label: text(source.label, "Motion Input"),
		url: url || objectUrl,
		objectUrl: objectUrl || null,
		fileName: text(source.fileName),
		mimeType: text(source.mimeType, "application/octet-stream"),
		characterId,
		status: text(source.status, url || objectUrl ? "ready" : "idle"),
		frames: Number.isFinite(Number(source.frames)) ? Math.max(0, Math.round(Number(source.frames))) : null,
		fps: Number.isFinite(Number(source.fps)) ? Number(source.fps) : null,
		motionRef: source.motionRef && typeof source.motionRef === "object" ? clone(source.motionRef) : null,
	};
}

export function characterHandleId(characterId) {
	const id = text(characterId).trim();
	return id ? `character:${id}` : "character";
}

export function characterIdFromHandle(handle) {
	const value = text(handle).trim();
	return value.startsWith("character:") ? value.slice("character:".length) || null : null;
}

export function motionInputOutput(input = {}) {
	const data = normalizeMotionInputData(input);
	return {
		type: MOTION_INPUT_NODE_TYPE,
		version: MOTION_INPUT_NODE_VERSION,
		url: data.url || null,
		objectUrl: data.objectUrl,
		fileName: data.fileName || null,
		mimeType: data.mimeType,
		characterId: data.characterId || null,
		handle: data.characterId ? characterHandleId(data.characterId) : null,
		frames: data.frames,
		fps: data.fps,
		motionRef: data.motionRef,
	};
}

/** Build the Scene patch for a connected Motion Input output. */
export function characterMotionPatch(characterId, input = {}) {
	const data = normalizeMotionInputData({ ...input, characterId });
	return {
		characterId: data.characterId || null,
		motionRef: {
			...(data.motionRef && typeof data.motionRef === "object" ? clone(data.motionRef) : {}),
			url: data.url || data.objectUrl || null,
			fileName: data.fileName || null,
			mimeType: data.mimeType,
		},
	};
}

/** Return active-scene cast entries without coupling the workflow UI to App. */
export function activeSceneCharacters(storage = globalThis.localStorage) {
	try {
		const raw = storage?.getItem(SCENES_STORAGE_KEY);
		const result = readSceneDocument(raw);
		const scene = result.document?.scenes?.find((entry) => entry.id === result.document.activeSceneId) || result.document?.scenes?.[0];
		return Array.isArray(scene?.stage?.characters)
			? scene.stage.characters.filter((entry) => entry && typeof entry.id === "string" && entry.id).map((entry, index) => ({ id: entry.id, name: entry.subject || `Character ${index + 1}`, model: entry.model || null, motionRef: entry.motionRef || null }))
			: [];
	} catch {
		return [];
	}
}

/** Convert connected Scene handles to the character ids they address. */
export function connectedCharacterIds(edges = [], sceneId) {
	if (!Array.isArray(edges)) return [];
	return [...new Set(edges.filter((edge) => edge?.target === sceneId).map((edge) => characterIdFromHandle(edge.targetHandle)).filter(Boolean))];
}


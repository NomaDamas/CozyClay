// Pure multi-scene document model. No three.js, no React.
// A Scene is the set; shotDocument and stage are sealed department envelopes.
// This module stores and copies those envelopes but never opens or validates them.

import { DEFAULT_SENSOR_FORMAT, SENSOR_FORMATS } from "./shot.js";
import { normalizeStableItems } from "./stable-items.js";

export const SCENES_VERSION = 4;
export const SCENES_STORAGE_KEY = "cozyclay.scenes.v4";
export const SCENES_QUARANTINE_KEY = "cozyclay.scenes.v4.quarantine";
export const PREVIOUS_SCENES_STORAGE_KEY = "cozyclay.scenes.v3";
export const V2_SCENES_STORAGE_KEY = "cozyclay.scenes.v2";
export const V1_SCENES_STORAGE_KEY = "cozyclay.scenes.v1";
export const LEGACY_SCENE_STORAGE_KEY = "cozyclay.scene.v1";
/** Newest-first fallback chain: a user arriving from any older build still
 * finds their scenes, and the reader migrates whatever body it lands on. */
export const LEGACY_SCENES_STORAGE_KEYS = Object.freeze([
	PREVIOUS_SCENES_STORAGE_KEY,
	V2_SCENES_STORAGE_KEY,
	V1_SCENES_STORAGE_KEY,
]);

/** v3 and older authored every frame number on ARDY's 20 fps clock; v4 reads
 * them on the 24 fps production clock. The numbers are MULTIPLIED, never
 * reinterpreted: a waypoint at frame 40 meant 2.0 s and must still mean 2.0 s,
 * which is frame 48 — reinterpreting it would silently speed the scene up. */
export const LEGACY_FRAME_FPS = 20;
export const TIMELINE_FRAME_FPS = 24;
export const toTimelineFrame = (frame) =>
	Math.round((frame * TIMELINE_FRAME_FPS) / LEGACY_FRAME_FPS);

/** Rigged character models shipped in public/models. The id is both the FBX
 * file stem and the wire `source.rig` value sent to ARDY. */
export const CHARACTER_MODEL_IDS = Object.freeze(["y-bot-tpose", "x-bot-tpose"]);
export const DEFAULT_CHARACTER_MODEL = "y-bot-tpose";
export const DEFAULT_SUBJECT_ONE = "a young woman in a tan coat";
export const DEFAULT_SUBJECT_TWO = "a man in a dark coat";

export const DEFAULT_SCENE_STAGE = Object.freeze({
	characters: Object.freeze([
		Object.freeze({ id: "char-a", model: DEFAULT_CHARACTER_MODEL, x: 0, z: 0, rot: 0, hidden: false, pose: null, subject: DEFAULT_SUBJECT_ONE }),
	]),
	hasCharSheet: false,
	shotAspect: "16:9",
	cameraPresetId: null,
	sensorId: DEFAULT_SENSOR_FORMAT,
	// The key light the user can grab: position of the sun puck, the rig's
	// master brightness, and a warm/cool colour offset. Values mirror the
	// tuned StageLights defaults, so a stage saved before the light was
	// movable renders exactly as it did.
	keyLight: Object.freeze({ x: 6, y: 9, z: 4, intensity: 1.12, warmth: 0.5 }),
});

/** Clamp a stored key light back into the stage's usable envelope. */
export function createKeyLight(value) {
	const source = plainObject(value) ? value : {};
	const fallback = DEFAULT_SCENE_STAGE.keyLight;
	const finite = (entry, base) => (typeof entry === "number" && Number.isFinite(entry) ? entry : base);
	return {
		x: Math.max(-30, Math.min(30, finite(source.x, fallback.x))),
		y: Math.max(0.5, Math.min(30, finite(source.y, fallback.y))),
		z: Math.max(-30, Math.min(30, finite(source.z, fallback.z))),
		intensity: Math.max(0, Math.min(4, finite(source.intensity, fallback.intensity))),
		// 0 = cool daylight, 0.5 = the tuned warm default, 1 = sunset amber
		warmth: Math.max(0, Math.min(1, finite(source.warmth, fallback.warmth))),
	};
}

let sceneSequence = 1;

const plainObject = (value) => !!value && typeof value === "object" && !Array.isArray(value);

// Persistence values are JSON-shaped. Recursing here keeps duplicateScene
// independent without borrowing the shot document's schema or runtime types.
function cloneValue(value, copies = new WeakMap()) {
	if (value === null || typeof value === "string" || typeof value === "boolean") return value;
	if (typeof value === "number") return Number.isFinite(value) ? value : null;
	if (typeof value !== "object") return null;
	if (copies.has(value)) return copies.get(value);
	if (Array.isArray(value)) {
		const copy = [];
		copies.set(value, copy);
		for (const entry of value) copy.push(cloneValue(entry, copies));
		return copy;
	}
	const copy = {};
	copies.set(value, copy);
	for (const [key, entry] of Object.entries(value)) {
		Object.defineProperty(copy, key, {
			value: cloneValue(entry, copies),
			enumerable: true,
			writable: true,
			configurable: true,
		});
	}
	return copy;
}

const finiteOr = (value, fallback) => (Number.isFinite(value) ? value : fallback);

/** Stature band for a cast member. Wider than ardy/npz.js's mocap band
 * (0.6-1.5, a sanity clamp on ESTIMATED statures): the gizmo's scale handles
 * are a deliberate artistic ask, and a previs giant or child is legitimate. */
export const CHARACTER_SCALE_MIN = 0.2;
export const CHARACTER_SCALE_MAX = 3;
const clampScale = (value) => (Number.isFinite(value) && value > 0
	? Math.max(CHARACTER_SCALE_MIN, Math.min(CHARACTER_SCALE_MAX, value))
	: 1);

/** Where an extra extraction take's performer stands: the filmed offset from
 * person 0, rotated into the ACTIVE character's facing. Pure geometry, so the
 * placement can be proven without a renderer. */
export function takeAnchor(active, offsetX, offsetZ) {
	const rad = (finiteOr(active?.rot, 0) * Math.PI) / 180;
	const dx = finiteOr(offsetX, 0);
	const dz = finiteOr(offsetZ, 0);
	return {
		x: finiteOr(active?.x, 0) + dx * Math.cos(rad) + dz * Math.sin(rad),
		z: finiteOr(active?.z, 0) - dx * Math.sin(rad) + dz * Math.cos(rad),
	};
}

/** One character entry in the stage envelope. `source` may be a v3 entry, a
 * partial (spawn dialog), or null — every field falls back to a sane default
 * and every object is freshly owned by the caller. */
export function createCharacterEntry(source = null, index = 0) {
	const s = plainObject(source) ? source : {};
	return {
		id: typeof s.id === "string" && s.id ? s.id : `char-${index + 1}`,
		model: CHARACTER_MODEL_IDS.includes(s.model) ? s.model : DEFAULT_CHARACTER_MODEL,
		x: finiteOr(s.x, 0),
		// Lift floors at the deck; there is deliberately no ceiling, so every
		// writer (inspector field, viewport gizmo, load path) shares max(0, y).
		y: Math.max(0, finiteOr(s.y, 0)),
		z: finiteOr(s.z, 0),
		rot: finiteOr(s.rot, 0),
		hidden: s.hidden === true,
		// User-picked body tint; null means "model default" (y-bot clay, x-bot
		// whiter clay) so the entry survives future default tweaks.
		tint: typeof s.tint === "string" && /^#[0-9a-fA-F]{6}$/.test(s.tint) ? s.tint : null,
		pose: plainObject(s.pose) ? cloneValue(s.pose) : null,
		// Stature multiplier: 1 is the canonical body, an extracted take carries
		// the FILMED person's leg ratio. It persists with the entry because the
		// take's root travel was authored against it — see the render path.
		scale: clampScale(s.scale),
		subject: typeof s.subject === "string" ? s.subject : index === 0 ? DEFAULT_SUBJECT_ONE : DEFAULT_SUBJECT_TWO,
		// The character's animation layer: its own root path and prompt-block
		// schedule. The generated clip itself is heavy, so only a lightweight
		// reference (bridge URL + generation params) is persisted — enough to
		// re-fetch and decode it on the next session.
		layer: normalizeLayer(s.layer),
		motionRef: normalizeMotionRef(s.motionRef),
	};
}

function normalizeMotionRef(ref) {
	if (!plainObject(ref) || typeof ref.url !== "string" || !ref.url) return null;
	return {
		url: ref.url,
		prompt: typeof ref.prompt === "string" ? ref.prompt : "",
		rotationDeg: Number.isFinite(ref.rotationDeg) ? ref.rotationDeg : 0,
		anchorX: Number.isFinite(ref.anchorX) ? ref.anchorX : 0,
		anchorZ: Number.isFinite(ref.anchorZ) ? ref.anchorZ : 0,
	};
}

function normalizeLayer(layer) {
	const source = plainObject(layer) ? layer : {};
	return {
		waypoints: normalizeStableItems(cloneValue(source.waypoints), "waypoint"),
		promptClips: normalizeStableItems(cloneValue(source.promptClips), "prompt-clip"),
	};
}

function normalizeStageLayers(stage) {
	const source = plainObject(stage) ? stage : {};
	const ids = new Set();
	return {
		...source,
		characters: Array.isArray(source.characters)
			? source.characters.map((character) => ({
				...character,
				layer: {
					waypoints: normalizeStableItems(cloneValue(character.layer?.waypoints), "waypoint", ids),
					promptClips: normalizeStableItems(cloneValue(character.layer?.promptClips), "prompt-clip", ids),
				},
			}))
			: source.characters,
	};
}

export function createCharacterLayer() {
	return { waypoints: [], promptClips: [] };
}

/** Retime one animation layer from the 20 fps authoring clock onto the 24 fps
 * production clock. Frame numbers only: positions, headings and prompt text
 * are untouched. The mapping is strictly increasing, so ascending order and
 * the gaps between prompt blocks survive it — the guards below re-establish
 * both anyway, because a hand-edited body may never have had them. Prompt
 * ranges are half-open [start, end), matching movePromptClipFrames: touching
 * blocks are legal, overlapping ones are not. */
function migrateLayerFrames(layer) {
	if (!plainObject(layer)) return layer;
	const next = { ...cloneValue(layer) };
	if (Array.isArray(layer.waypoints)) {
		const byFrame = new Map();
		for (const waypoint of layer.waypoints) {
			if (!plainObject(waypoint) || !Number.isFinite(waypoint.frame)) continue;
			const frame = Math.max(0, toTimelineFrame(Math.round(waypoint.frame)));
			byFrame.set(frame, { ...cloneValue(waypoint), frame });
		}
		next.waypoints = [...byFrame.values()].sort((a, b) => a.frame - b.frame);
	}
	if (Array.isArray(layer.promptClips)) {
		const ordered = layer.promptClips
			.filter((clip) => plainObject(clip) && Number.isFinite(clip.startFrame) && Number.isFinite(clip.endFrame))
			.sort((a, b) => a.startFrame - b.startFrame);
		const clips = [];
		let floor = 0;
		for (const clip of ordered) {
			const startFrame = Math.max(floor, toTimelineFrame(Math.round(clip.startFrame)));
			const endFrame = Math.max(startFrame, toTimelineFrame(Math.round(clip.endFrame)));
			clips.push({ ...cloneValue(clip), startFrame, endFrame });
			floor = endFrame;
		}
		next.promptClips = clips;
	}
	return next;
}

/** v3 → v4 for one stage envelope: every frame-bearing number in every cast
 * member's layer moves onto the production clock. Exported because a project
 * FILE carries its own scene document and needs the same migration. */
export function migrateStageFrames(stage) {
	if (!plainObject(stage) || !Array.isArray(stage.characters)) return stage;
	return {
		...stage,
		characters: stage.characters.map((entry) => (plainObject(entry) && plainObject(entry.layer)
			? { ...entry, layer: migrateLayerFrames(entry.layer) }
			: entry)),
	};
}

/** Stage envelopes before v3 stored a fixed cast (charA/charB/showB/poseA/
 * poseB/subject/subject2). Fold that cast into the characters list so the
 * rest of the app only ever sees one shape. */
function migrateLegacyCast(source) {
	const cast = [createCharacterEntry({ ...plainObject(source.charA) ? source.charA : {}, id: "char-a", pose: source.poseA ?? null, subject: source.subject ?? DEFAULT_SUBJECT_ONE }, 0)];
	if (source.showB === true) {
		cast.push(createCharacterEntry({ ...plainObject(source.charB) ? source.charB : {}, id: "char-b", pose: source.poseB ?? null, subject: source.subject2 ?? DEFAULT_SUBJECT_TWO }, 1));
	}
	return cast;
}

const STAGE_ENVELOPE_KEYS = new Set([
	"characters", "hasCharSheet", "shotAspect", "sensorId", "keyLight",
	"charA", "charB", "showB", "poseA", "poseB", "subject", "subject2",
]);

export function createSceneStage(stage = null) {
	const source = plainObject(stage) ? stage : {};
	const characters = Array.isArray(source.characters) && source.characters.length
		? source.characters.map((entry, index) => createCharacterEntry(entry, index))
		: migrateLegacyCast(source);
	// Unknown extra keys (shotAspect was one, once) ride along so the envelope
	// stays sealed-but-lossless; legacy cast keys are deliberately dropped.
	const extras = {};
	for (const [key, value] of Object.entries(source)) {
		if (!STAGE_ENVELOPE_KEYS.has(key)) extras[key] = cloneValue(value);
	}
	return {
		...extras,
		characters,
		hasCharSheet: source.hasCharSheet === true,
		shotAspect: ["16:9", "2.39:1", "9:16", "1:1", "4:3", "12:7"].includes(source.shotAspect)
			? source.shotAspect
			: DEFAULT_SCENE_STAGE.shotAspect,
		// `sensorFormat` was this field's name for one unreleased day; read it so
		// a stage saved in that window still loads with its camera intact.
		sensorId: Object.hasOwn(SENSOR_FORMATS, source.sensorId ?? source.sensorFormat)
			? (source.sensorId ?? source.sensorFormat)
			: DEFAULT_SCENE_STAGE.sensorId,
		keyLight: createKeyLight(source.keyLight),
	};
}

function uniqueId(existing) {
	const ids = new Set(existing.map((scene) => scene?.id));
	let id;
	do id = `scene-${Date.now().toString(36)}-${sceneSequence++}`;
	while (ids.has(id));
	return id;
}

function uniqueName(requested, existing) {
	const nameKey = (name) => typeof name === "string" ? name.normalize("NFKC").toLowerCase() : "";
	const names = new Set(existing.map((scene) => nameKey(scene?.name)));
	const hasName = (name) => names.has(nameKey(name));
	const base = typeof requested === "string" && requested.trim() ? requested.trim() : "SCENE 01";
	if (!hasName(base)) return base;
	const numbered = base.match(/^(.*?)(\d+)$/);
	if (numbered) {
		const [, prefix, digits] = numbered;
		for (let number = Number(digits) + 1; ; number += 1) {
			const candidate = `${prefix}${String(number).padStart(digits.length, "0")}`;
			if (!hasName(candidate)) return candidate;
		}
	}
	for (let number = 2; ; number += 1) {
		const candidate = `${base} ${number}`;
		if (!hasName(candidate)) return candidate;
	}
}

export function createScene(name = "SCENE 01", existing = []) {
	return { id: uniqueId(existing), name: uniqueName(name, existing), objects: [], shotDocument: null, stage: createSceneStage() };
}

export function addScene(scenes, name = "SCENE 01") {
	const list = Array.isArray(scenes) ? scenes : [];
	return [...list, createScene(name, list)];
}

export function duplicateScene(scenes, index) {
	if (!Array.isArray(scenes) || index < 0 || index >= scenes.length) return scenes;
	const source = scenes[index];
	const duplicate = createScene(source.name, scenes);
	duplicate.objects = cloneValue(source.objects);
	duplicate.shotDocument = cloneValue(source.shotDocument);
	duplicate.stage = createSceneStage(source.stage);
	return [...scenes.slice(0, index + 1), duplicate, ...scenes.slice(index + 1)];
}

export function renameScene(scenes, index, name) {
	if (!Array.isArray(scenes) || index < 0 || index >= scenes.length || typeof name !== "string" || !name.trim()) return scenes;
	const others = scenes.filter((_, sceneIndex) => sceneIndex !== index);
	const nextName = uniqueName(name, others);
	if (nextName === scenes[index].name) return scenes;
	return scenes.map((scene, sceneIndex) => sceneIndex === index ? { ...scene, name: nextName } : scene);
}

export function removeScene(scenes, index) {
	if (!Array.isArray(scenes) || scenes.length <= 1 || index < 0 || index >= scenes.length) return scenes;
	return scenes.filter((_, sceneIndex) => sceneIndex !== index);
}

export function activeSceneIndex(scenes, activeSceneId) {
	if (!Array.isArray(scenes) || !scenes.length) return -1;
	const index = scenes.findIndex((scene) => scene.id === activeSceneId);
	return index < 0 ? 0 : index;
}

export function activeScene(scenes, activeSceneId) {
	const index = activeSceneIndex(scenes, activeSceneId);
	return index < 0 ? null : scenes[index];
}

export function createSceneDocument() {
	const scene = createScene();
	return { version: SCENES_VERSION, activeSceneId: scene.id, scenes: [scene] };
}

function repairScene(record, existing, fallbackNumber, fallbackStage, legacyClock = false) {
	if (!plainObject(record) || typeof record.id !== "string" || !record.id || !Array.isArray(record.objects)) return null;
	if (existing.some((scene) => scene.id === record.id)) return null;
	const stage = normalizeStageLayers(createSceneStage(cloneValue(plainObject(record.stage) ? record.stage : fallbackStage)));
	return {
		id: record.id,
		name: uniqueName(typeof record.name === "string" ? record.name : `SCENE ${String(fallbackNumber).padStart(2, "0")}`, existing),
		objects: record.objects.filter(plainObject).map((object) => cloneValue(object)),
		// The shot document is a sealed envelope with its OWN version, and it
		// migrates its own frames when its reader opens it.
		shotDocument: cloneValue(record.shotDocument ?? null),
		stage: legacyClock ? migrateStageFrames(stage) : stage,
	};
}

function repairDocument(payload, fallbackStage = DEFAULT_SCENE_STAGE, legacyClock = false) {
	const scenes = [];
	let dropped = 0;
	for (const record of payload.scenes) {
		const scene = repairScene(record, scenes, scenes.length + 1, fallbackStage, legacyClock);
		if (scene) scenes.push(scene);
		else dropped += 1;
	}
	if (!scenes.length) scenes.push(createScene());
	const index = activeSceneIndex(scenes, payload.activeSceneId);
	return { document: { version: SCENES_VERSION, activeSceneId: scenes[index].id, scenes }, dropped };
}

function parse(raw) {
	try {
		return JSON.parse(raw);
	} catch {
		return null;
	}
}

/** Tagged, side-effect-free reader. The caller decides when quarantine bytes
 * are written; future payloads are deliberately returned without a document. */
export function readSceneDocument(raw, legacyRaw = null) {
	if (raw === null || raw === undefined || raw === "") {
		if (legacyRaw !== null && legacyRaw !== undefined && legacyRaw !== "") {
			const legacy = parse(legacyRaw);
			if (!plainObject(legacy) || legacy.version !== 1 || !Array.isArray(legacy.objects)) {
				return { status: "corrupt", document: createSceneDocument(), dropped: 0, quarantineRaw: legacyRaw };
			}
			const document = createSceneDocument();
			document.scenes[0].objects = legacy.objects.filter(plainObject).map((object) => cloneValue(object));
			return { status: "migrated", document, dropped: legacy.objects.length - document.scenes[0].objects.length };
		}
		return { status: "absent", document: createSceneDocument(), dropped: 0 };
	}

	const payload = parse(raw);
	if (!plainObject(payload) || !Number.isInteger(payload.version) || payload.version < 1) {
		return { status: "corrupt", document: createSceneDocument(), dropped: 0, quarantineRaw: raw };
	}
	if (payload.version > SCENES_VERSION) return { status: "future", document: null, dropped: 0 };
	if (!Array.isArray(payload.scenes)) {
		return { status: "corrupt", document: createSceneDocument(), dropped: 0, quarantineRaw: raw };
	}
	const migrating = payload.version < SCENES_VERSION;
	// Anything below v4 was authored while the timeline ran at 20 fps. The
	// fallback stage (a v1 global cast) rides the same conversion, applied
	// once, inside repairScene — whichever stage that scene ends up with.
	const legacyClock = payload.version < 4;
	const repaired = repairDocument(payload, createSceneStage(payload.stage), legacyClock);
	return { status: migrating ? "migrated" : "valid", ...repaired };
}

export function serializeSceneDocument(document) {
	return JSON.stringify({ version: SCENES_VERSION, activeSceneId: document.activeSceneId, scenes: document.scenes });
}

/** Storage adapter: quarantine corrupt bytes, persist successful migration,
 * and never write over a future document. The legacy key remains as a backup. */
export function loadSceneDocumentFromStorage(storage) {
	let raw = storage.getItem(SCENES_STORAGE_KEY);
	for (const key of LEGACY_SCENES_STORAGE_KEYS) {
		if (raw) break;
		raw = storage.getItem(key);
	}
	const legacyRaw = raw ? null : storage.getItem(LEGACY_SCENE_STORAGE_KEY);
	const result = readSceneDocument(raw, legacyRaw);
	if (result.status === "corrupt" && result.quarantineRaw !== undefined) {
		storage.setItem(SCENES_QUARANTINE_KEY, result.quarantineRaw);
	}
	if (result.status === "migrated") {
		storage.setItem(SCENES_STORAGE_KEY, serializeSceneDocument(result.document));
	}
	return result;
}

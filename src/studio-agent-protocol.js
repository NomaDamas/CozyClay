// Shared by the browser and sidecar. No Node, React, renderer or provider imports.
import { STUDIO_ELEMENTS } from "./studio-elements.js";

export const STUDIO_PROTOCOL_VERSION = "studio-agent-v1";
export const STUDIO_CONTEXT_MAX_BYTES = 16 * 1024;
export const STUDIO_CONTEXT_LIMITS = Object.freeze({ entities: 24, shots: 8, assets: 6, recentReceipts: 3, jobs: 8 });
export const STUDIO_TOOL_FAMILIES = Object.freeze(["inspect_studio", "operate_studio", "arrange_objects", "arrange_characters", "patch_elements", "frame_shot", "generate_motion", "verify_result", "undo_edit"]);
/** One patch target kind per authored commit domain: character→cast,
 * object→objects, shot→shot, stage→stage. */
export const STUDIO_PATCH_KINDS = Object.freeze(["character", "object", "shot", "stage"]);
export const STUDIO_PATCH_DOMAINS = Object.freeze({ character: "cast", object: "objects", shot: "shot", stage: "stage" });
export const STUDIO_ERROR_CODES = Object.freeze([
	"INVALID_ARGUMENT", "INVALID_CONTEXT", "INVALID_IDENTITY", "INVALID_TURN_ID", "INVALID_SESSION_ID", "INVALID_RECEIPT", "INVALID_RANGE", "INVALID_REQUEST",
	"UNKNOWN_TOOL", "UNKNOWN_VARIANT", "DUPLICATE_NAME", "CONTEXT_LIMIT", "CONTEXT_TOO_LARGE", "AMBIGUOUS_TARGET", "AMBIGUOUS_BASIS", "TARGET_NOT_READY", "TARGET_BUSY",
	"STALE_TARGET", "STALE_SCENE", "STALE_ENVIRONMENT", "STALE_CURSOR", "CAPABILITY_MISSING", "LIVE_HUB_UNAVAILABLE", "AUTH_REQUIRED", "RATE_LIMITED", "BACKEND_UNAVAILABLE",
	"VERIFICATION_FAILED", "REPAIR_REGRESSED", "CANCELLED", "UNCERTAIN_APPLY", "UNDO_CONFLICT",
]);
export const STUDIO_VARIANTS = freezeStudioData({
	selectionKinds: ["scene", "object", "character", "rig", "camera"], modes: ["scene", "camera", "motion"], shotModes: ["keys", "follow", "rail"],
	framingSizes: ["extreme close-up", "close-up", "medium close-up", "medium shot", "medium-wide shot", "wide shot", "extreme wide shot"],
	framingViews: ["front", "front three-quarter", "profile", "rear three-quarter", "back"], framingLevels: ["ground", "low", "hip", "eye", "high", "overhead"],
	framingSides: ["left", "right"], positionSides: ["left", "right", "front", "behind"], positionBases: ["world", "subject", "shot_camera"], collisionPolicies: ["report", "avoid"],
	objectOps: ["create", "update", "remove", "group", "ungroup"], characterOps: ["create", "update", "remove"],
	inspectScopes: ["selection", "scene", "entities", "shot", "motion", "catalogue"], receiptStatuses: ["applied", "partial", "noop", "transient", "installed", "undone"],
	opStatuses: ["applied", "partial", "noop"],
	jobStates: ["queued", "generating", "preparing", "verifying", "repairing", "committing", "reconciling", "installed", "review_required", "failed", "cancelled", "stale_target", "stale_environment"],
});

export class StudioProtocolError extends Error {
	constructor(code, message, details = {}) { super(message); this.name = "StudioProtocolError"; this.code = code; this.details = details; }
	toJSON() { return { code: this.code, message: this.message, ...(Object.keys(this.details).length ? { details: this.details } : {}) }; }
}
export const studioError = (code, message, details) => ({ ok: false, error: new StudioProtocolError(code, message, details).toJSON() });
export const utf8ByteLength = (text) => new TextEncoder().encode(text).byteLength;
export function freezeStudioData(value) {
	if (value && typeof value === "object" && !Object.isFrozen(value)) { for (const child of Object.values(value)) freezeStudioData(child); Object.freeze(value); }
	return value;
}
const fail = (code, message, path = "$", extra = {}) => { throw new StudioProtocolError(code, message, { path, ...extra }); };
const record = value => value !== null && typeof value === "object" && !Array.isArray(value);
const text = (maxLength = 120) => ({ type: "string", minLength: 1, maxLength });
const number = (minimum, maximum) => ({ type: "number", ...(minimum !== undefined ? { minimum } : {}), ...(maximum !== undefined ? { maximum } : {}) });
const integer = (minimum = 0, maximum = Number.MAX_SAFE_INTEGER) => ({ ...number(minimum, maximum), type: "integer" });
const bool = { type: "boolean" };
const literal = value => ({ const: value });
const choices = values => ({ type: "string", enum: values });
const nullable = schema => ({ oneOf: [schema, { type: "null" }] });
const array = (items, maxItems, minItems = 0, uniqueItems = false) => ({ type: "array", items, minItems, maxItems, ...(uniqueItems ? { uniqueItems } : {}) });
const object = (required, optional = {}) => ({ type: "object", properties: { ...required, ...optional }, required: Object.keys(required), additionalProperties: false });
const union = (...oneOf) => ({ oneOf });
const id = { ...text(), pattern: "^[A-Za-z0-9][A-Za-z0-9._:-]*$" };
const uuidSchema = { ...text(36), pattern: "^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-8][0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}$" };
export const isUuid = value => typeof value === "string" && new RegExp(uuidSchema.pattern).test(value);
const vec3 = object({ x: number(), y: number(), z: number() });
const positive = { type: "number", exclusiveMinimum: 0 };
const positiveVec3 = object({ x: positive, y: positive, z: positive });
const range = { ...object({ startFrame: integer(), endFrameExclusive: integer(1) }), "x-studio-range": true };
const ids = (max = 100, min = 1) => array(id, max, min, true);
const name = text(120);
const identityFields = { workspaceId: id, documentEpoch: id, sceneId: id, sceneEpoch: id };
const identity = object(identityFields);
const host = object({ surface: literal("studio"), ...identityFields, workspaceHandle: nullable(id) });
const revision = object({ scene: integer(), physics: integer(), view: integer() });
const selection = nullable(object({ kind: choices(STUDIO_VARIANTS.selectionKinds), id }, { hierarchyId: id }));
const view = object({ mode: choices(STUDIO_VARIANTS.modes), frame: integer(), playing: bool, lookThrough: bool, grid: bool, autoColor: bool });
const position = union(
	object({ world: vec3 }),
	object({ relativeTo: id, basis: choices(STUDIO_VARIANTS.positionBases), side: choices(STUDIO_VARIANTS.positionSides), gapM: number(0), support: union(literal("floor"), object({ objectId: id })) }),
	object({ between: ids(2, 2), fraction: number(0, 1), support: literal("floor") }),
	object({ onObject: id }, { offsetXZ: object({ x: number(), z: number() }) }),
);
const facing = union(object({ yawDeg: number() }), object({ towardId: id }), object({ sameAsId: id }), object({ awayFromId: id }));
const framing = union(
	object({ intent: object({ size: choices(STUDIO_VARIANTS.framingSizes), view: choices(STUDIO_VARIANTS.framingViews), level: choices(STUDIO_VARIANTS.framingLevels), side: choices(STUDIO_VARIANTS.framingSides) }, { focalMm: positive }) }),
	object({ exact: object({ position: vec3, lookAt: vec3, focalMm: positive }) }),
);
const objectOp = union(
	object({ op: literal("create"), source: object({ kind: id }), position }, { name, facing, scale: positiveVec3 }),
	object({ op: literal("update"), id }, { position, facing, rotationDeg: vec3, scale: positiveVec3, color: text(32), name }),
	object({ op: literal("remove"), id }),
	object({ op: literal("group"), parentId: id, childIds: ids() }),
	object({ op: literal("ungroup"), childIds: ids() }),
);
const characterOp = union(
	object({ op: literal("create"), name, position }, { facing, scale: positive }),
	object({ op: literal("update"), characterId: id }, { position, facing, scale: positive, name, hidden: bool }),
	object({ op: literal("remove"), characterId: id }),
);
const generateSource = object({ kind: literal("generate"), beats: array(object({ text: text(2000) }, { seconds: number(0.5, 60) }), 8, 1) }, { durationSeconds: number(2, 60), seed: integer(-2147483648, 2147483647) });
const source = union(generateSource, object({ kind: literal("reuse"), artifactId: id }));

/* ----------------------------------------------- element patches ----
 * The accepted fields of `patch_elements` are DERIVED from the element
 * declaration table (src/studio-elements.js): one property per element whose
 * agentExposure is "patch", keyed by the path inside its kind, typed by the
 * declared type and bounded by the declared min/max/enum. Structured values
 * (schedules, routes, pictures) declare their shape here, because the table
 * records what an element IS, not how JSON carries it. */
const dataImage = { ...text(2 * 1024 * 1024), pattern: "^data:image/[A-Za-z0-9.+-]+[;,]" };
const promptBlock = object({ startFrame: integer(), endFrame: integer(1), text: text(2000) }, { id });
const cameraKey = object({ frame: integer(), framing: object({ pos: vec3, yaw: number(), pitch: number(), fovDeg: number(1, 179) }) }, { id });
const objectRoute = nullable(object({ points: array(vec3, 64, 2) }, { speed: number(0, 50), faceTravel: bool, loop: bool, extend: bool }));
const PATCH_VALUE_SCHEMAS = {
	"character.pose": nullable(id), "character.identityImage": nullable(dataImage), "character.promptBlocks": array(promptBlock, 64),
	"object.parent": nullable(id), "object.path": objectRoute, "stage.environmentImage": nullable(dataImage),
	"shot.cameraKeys": array(cameraKey, 64), "shot.targetModel": nullable(id),
};
/** One declared element as a JSON value schema, or null when the declaration
 * carries no carriable shape (a structured element without a declared value
 * schema above). Null elements are omitted from the patch schema, and
 * test/verify-studio-elements.mjs fails the moment the table declares one. */
export function patchValueSchema(element) {
	if (Object.hasOwn(PATCH_VALUE_SCHEMAS, element.path)) return PATCH_VALUE_SCHEMAS[element.path];
	if (element.type === "number") return number(element.min, element.max);
	if (element.type === "boolean") return bool;
	if (element.type === "enum") return choices([...element.enum]);
	if (element.type === "id") return id;
	if (element.type === "color") return { ...text(32), pattern: "^#[0-9a-fA-F]{6}$" };
	if (element.type === "image") return nullable(dataImage);
	if (element.type === "vec3") return vec3;
	if (element.type === "string") return text(240);
	return null;
}
/** Pure: feed it any element table and read back the `set` schema per kind. */
export function buildPatchSchema(elements) {
	const kinds = {};
	for (const kind of STUDIO_PATCH_KINDS) {
		const properties = {};
		for (const element of elements) {
			if (element.agentExposure !== "patch" || !element.path.startsWith(`${kind}.`)) continue;
			const schema = patchValueSchema(element);
			if (schema) properties[element.path.slice(kind.length + 1)] = schema;
		}
		kinds[kind] = { type: "object", properties, required: [], additionalProperties: false };
	}
	return kinds;
}
export const STUDIO_PATCH_SET_SCHEMAS = freezeStudioData(buildPatchSchema(STUDIO_ELEMENTS));
export const STUDIO_PATCHABLE_PATHS = freezeStudioData(Object.fromEntries(STUDIO_PATCH_KINDS.map(kind =>
	[kind, Object.keys(STUDIO_PATCH_SET_SCHEMAS[kind].properties).map(key => `${kind}.${key}`)])));
const patchOp = union(
	object({ target: object({ kind: literal("character"), id }), set: STUDIO_PATCH_SET_SCHEMAS.character }),
	object({ target: object({ kind: literal("object"), id }), set: STUDIO_PATCH_SET_SCHEMAS.object }),
	object({ target: object({ kind: literal("shot") }, { id }), set: STUDIO_PATCH_SET_SCHEMAS.shot }),
	object({ target: object({ kind: literal("stage") }), set: STUDIO_PATCH_SET_SCHEMAS.stage }),
);
const toolSchemas = {
	inspect_studio: object({ scope: choices(STUDIO_VARIANTS.inspectScopes) }, { ids: ids(32), query: name, cursor: text(512), limit: { ...integer(1, 32), default: 12 } }),
	operate_studio: object({}, { selection, shotId: id, frame: integer(), playing: bool, mode: choices(STUDIO_VARIANTS.modes), view: object({}, { lookThrough: bool, grid: bool, autoColor: bool }) }),
	arrange_objects: object({ ops: array(objectOp, 100, 1) }, { collisionPolicy: { ...choices(STUDIO_VARIANTS.collisionPolicies), default: "report" } }),
	arrange_characters: object({ ops: array(characterOp, 8, 1) }),
	patch_elements: object({ ops: array(patchOp, 32, 1) }),
	frame_shot: object({ subjectIds: ids(1), framing }, { shotId: id, keyAtFrame: integer() }),
	generate_motion: object({ characterId: id, source }, { repair: { ...choices(["bounded", "none"]), default: "bounded" } }),
	verify_result: object({ checks: array(choices(["placement", "framing", "motion"]), 3, 1, true) }, { receiptId: id, targets: ids(), range: union(literal("whole_clip"), range), visual: { ...choices(["none", "frame", "contact_sheet"]), default: "none" } }),
	undo_edit: object({ receiptId: id }),
};
export const STUDIO_TOOL_SCHEMAS = freezeStudioData(toolSchemas);
export const STUDIO_CATALOGUE = freezeStudioData(STUDIO_TOOL_FAMILIES.map(name => ({ name, slice: 1, parameters: toolSchemas[name] })));

// Bounded observations, never a document/pose/asset transport. Every nested
// object is closed. Null distinguishes unavailable data from measured zero.
const bounds = object({ min: vec3, max: vec3 });
const entity = object({ id, kind: choices(["object", "character", "rig"]), token: id }, {
	name, detailsOmitted: bool, position: vec3, yawDeg: number(), rotationDeg: vec3, scale: union(positive, positiveVec3), bounds: nullable(bounds),
	libraryKind: id, renderer: id, parentId: nullable(id), attachment: nullable(object({ characterId: id, bone: nullable(id) })), pathPointCount: integer(0, 64),
	motion: object({ takeId: nullable(id), frames: integer(), ikKeyCount: integer(), promptBlockCount: integer() }, { poseId: nullable(id), keyIds: ids(8, 0) }),
	capabilities: object({ rigReady: bool, ik: bool, measuredFeet: bool }),
});
const shotSummary = object({ id, name, range, keyCount: integer() }, { subjectIds: ids(24, 0) });
const currentShot = object({ id, name, range, mode: choices(STUDIO_VARIANTS.shotModes) }, { subjectIds: ids(24, 0) });
const camera = object({ position: vec3, lookAt: vec3, focalMm: positive, sensorId: id, slate: name });
const assetSummary = object({ imageId: id, origin: choices(["user_attachment", "scene_asset", "capture"]) }, { name });
const jobSummary = object({ id, characterId: id, state: choices(STUDIO_VARIANTS.jobStates) }, { targetIds: ids(24, 0), progress: nullable(number(0, 1)), phase: name });
const contextSchema = object({
	schema: literal("studio-context-v1"), host, revision,
	units: object({ distance: literal("m"), angle: literal("deg"), up: literal("+Y"), yawZero: literal("+Z"), yawPositiveToward: literal("+X"), fps: literal(24), rangeEnd: literal("exclusive") }),
	scene: object({ name, aspect: text(40), floorY: number(), frameCount: integer(), objectCount: integer(), characterCount: integer() }),
	selection, activeCharacterId: nullable(id), view, shot: nullable(currentShot), camera: nullable(camera),
	entities: array(entity, 24), entityPage: object({ returned: integer(0, 24), total: integer(), truncated: bool, nextCursor: nullable(text(512)) }),
	shots: array(shotSummary, 8), shotsTruncated: bool, assets: array(assetSummary, 6),
	recentReceipts: array(object({ id, summary: name, canUndoDirect: bool }), 3), jobs: array(jobSummary, 8),
	capabilities: object({ profile: literal("studio-slice-1"), tools: array(choices(STUDIO_TOOL_FAMILIES), 9, 0, true) }, { rigReady: bool, cameraReady: bool, bridgeReady: bool }),
});
const guardSchema = object({ ...identityFields, targetId: id, token: id });
const efforts = ["none", "minimal", "low", "medium", "high", "xhigh", "max", "ultra"];
const turnSchema = object({ surface: literal("studio"), sessionId: uuidSchema, turnId: uuidSchema, text: text(16000), context: contextSchema }, { model: text(120), effort: choices(efforts), attachFrame: bool });
const stopSchema = object({ surface: literal("studio"), sessionId: uuidSchema, turnId: uuidSchema }, { jobId: id });
const revisions = object({ before: integer(), after: integer() });
const undo = object({ historyEntryId: id, entries: literal(1), canUndoDirect: bool });
const installed = object({ characterId: id, beforeTakeId: nullable(id), takeId: id, targetToken: id, frameCount: integer(1), fps: literal(24), durationSeconds: positive, blocks: array(object({ sourceBeat: integer(0, 7), startFrame: integer(), endFrameExclusive: integer(1) }), 120, 1), selectionChanged: literal(false) });
const verification = object({ id, status: choices(["verified", "unverified"]), profile: literal("studio-motion-v1"), range, evaluatedFrames: integer(), physicsRevision: integer(), limitations: array(name, 12) }, {
	surfaceMeasured: bool, maxFloorPenetrationM: number(0), maxContactSlipM: number(0), maxContactFloatM: number(0), unsupportedFrames: integer(), supportedCollisionFrames: integer(), continuityRegressed: bool,
	semanticStatus: choices(["pending_image_review", "passed", "failed", "unavailable"]),
});
// One measured value per patched element path. Exactly one typed member is
// carried, so a picture is reported by its measured size and a schedule by its
// length instead of turning the receipt into a document transport.
const patchedValue = object({ path: text(120) }, { number: number(), text: text(512), flag: bool, vec: vec3, count: integer(), bytes: integer() });
const readback = object({}, { position: vec3, yawDeg: number(), rotationDeg: vec3, scale: union(positive, positiveVec3), name, color: text(32), hidden: bool, modelId: id, renderer: id,
	parentId: nullable(id), childIds: ids(100, 0), removed: bool, range, camera, keyId: id, frame: integer(), subjectIds: ids(24, 0), selection, activeCharacterId: nullable(id), shotId: nullable(id), view, token: id, takeId: nullable(id), statureM: positive,
	patched: array(patchedValue, 32, 1) });
const checks = object({ coverage: name }, { relationSatisfied: bool, overlapIds: ids(100, 0), actualGapM: number(), requestedGapM: number(0), maximumFootprintOverlapM: number(0),
	basis: choices(STUDIO_VARIANTS.positionBases), clipped: bool, occluded: bool, behindCamera: bool, screenFraction: number(0), derivedSize: choices(STUDIO_VARIANTS.framingSizes), support: name, baseY: number(), facesTargetId: id });
const warning = object({ code: id }, { id, message: name, suggestedOutwardDeltaM: number(), count: integer() });
const receiptBase = { ok: literal(true), commandId: id, receiptId: id, host: identity, status: choices(STUDIO_VARIANTS.receiptStatuses), authored: bool, revision: revisions, affectedIds: ids(100, 0),
	delta: array(object({ id, after: readback }), 8), checks, undo: nullable(undo), warnings: array(warning, 12) };
const batchDetails = { counts: object({ created: integer(), updated: integer(), deleted: integer() }), detailCursor: nullable(text(512)) };
// Per-operation outcome for path-addressed commands: which ops landed whole,
// which lost a field to a domain normalizer, and exactly which paths were lost.
const opResults = array(object({ index: integer(), status: choices(STUDIO_VARIANTS.opStatuses) }, { droppedPaths: array(text(120), 32, 1) }), 32, 1);
const authoredReceipt = { ...receiptBase, authored: literal(true), undo };
const receiptVariants = {
	applied: object({ ...authoredReceipt, status: literal("applied") }, { mutated: literal(true), ops: opResults, ...batchDetails }),
	partial: object({ ...authoredReceipt, status: literal("partial"), ops: opResults }, { mutated: literal(true), ...batchDetails }),
	noop: object({ ...receiptBase, status: literal("noop"), authored: literal(false), mutated: literal(false), undo: literal(null) }, { ops: opResults }),
	transient: object({ ...receiptBase, status: literal("transient"), authored: literal(false), view: revisions, undo: literal(null) }, { mutated: bool }),
	installed: object({ ...authoredReceipt, status: literal("installed"), jobId: id, artifactId: id, installed, verification }, {
		mutated: literal(true), explicitUnverifiedAcceptance: bool,
		repairs: object({ autoPhysicsInvocations: integer(0, 1), fixCollisionsInvocations: integer(0, 1), remaining: integer(0, 2) }), ...batchDetails,
	}),
	undone: object({ ...authoredReceipt, status: literal("undone"), undoneReceiptId: id, restoredTargets: array(guardSchema, 100, 1) }, { mutated: literal(true), ...batchDetails }),
};
const receiptSchema = union(...Object.values(receiptVariants));
const failureSchema = object({ ok: literal(false), commandId: id, host: identity, code: choices(STUDIO_ERROR_CODES), phase: choices(["admission", "execution", "prepare", "verify", "repair", "commit", "reconcile", "undo"]),
	affectedIds: ids(100, 0), expectedTargets: array(guardSchema, 24), currentTargets: array(guardSchema, 24), mutated: union(bool, literal("unknown")),
	preserved: object({ authoredState: choices(["unchanged", "changed", "unknown"]) }), recovery: object({ action: choices(["none", "inspect", "retry", "new_intent", "reconcile", "sign_in"]) }, { retryAllowed: bool }),
}, { message: name, candidates: array(object({ id, kind: choices(["object", "character", "rig"]), position: nullable(vec3) }), 5) });

// These are JSON Schema data, not validators with hidden browser dependencies.
// x-studio-range is the sole relational schema annotation: end > start.
export const StudioSchemas = freezeStudioData({ catalogue: STUDIO_CATALOGUE, variants: STUDIO_VARIANTS, Vec3: vec3, FrameRange: range, PositionSpec: position, FacingSpec: facing,
	ObjectOp: objectOp, CharacterOp: characterOp, Framing: framing, GenerateSource: generateSource, Source: source, Identity: identity, Host: host, TargetGuard: guardSchema,
	Entity: entity, ShotSummary: shotSummary, StudioContextV1: contextSchema, StudioTurn: turnSchema, StudioStop: stopSchema, Receipt: receiptSchema, ReceiptVariants: receiptVariants, Failure: failureSchema });

/** Validate the closed JSON Schema subset used above; return a detached value
 * with declared defaults. Errors contain schema paths, never payload values. */
export function validateStudioSchema(schema, value, code = "INVALID_ARGUMENT", path = "$") {
	if (schema.oneOf) {
		const matches = [];
		for (const branch of schema.oneOf) {
			try { matches.push(validateStudioSchema(branch, value, code, path)); }
			catch (error) { if (!(error instanceof StudioProtocolError)) throw error; }
		}
		if (matches.length !== 1) fail(code, "Expected exactly one supported variant.", path);
		return matches[0];
	}
	if (Object.hasOwn(schema, "const")) { if (value !== schema.const) fail(code, "Invalid constant.", path); return value; }
	if (schema.type === "null") { if (value !== null) fail(code, "Expected null.", path); return null; }
	if (schema.type === "object") {
		if (!record(value)) fail(code, "Expected object.", path);
		for (const key of Object.keys(value)) if (!Object.hasOwn(schema.properties, key)) fail(code, "Unexpected field.", path);
		const result = {};
		for (const [key, child] of Object.entries(schema.properties)) {
			if (Object.hasOwn(value, key)) result[key] = validateStudioSchema(child, value[key], code, `${path}.${key}`);
			else if (schema.required.includes(key)) fail(code, "Required field missing.", `${path}.${key}`);
			else if (Object.hasOwn(child, "default")) result[key] = structuredClone(child.default);
		}
		if (schema["x-studio-range"] && result.endFrameExclusive <= result.startFrame) fail(code, "Frame range must be nonempty and half-open.", path);
		return result;
	}
	if (schema.type === "array") {
		if (!Array.isArray(value) || value.length < schema.minItems || value.length > schema.maxItems) fail(code, "Array outside supported bounds.", path);
		const result = value.map((item, i) => validateStudioSchema(schema.items, item, code, `${path}[${i}]`));
		if (schema.uniqueItems && new Set(result.map(item => JSON.stringify(item))).size !== result.length) fail(code, "Duplicate array member.", path);
		return result;
	}
	if (schema.type === "string") {
		if (typeof value !== "string" || !value.trim() || (schema.maxLength !== undefined && [...value].length > schema.maxLength) || (schema.pattern && !new RegExp(schema.pattern).test(value))) fail(code, "Invalid or oversized string.", path);
		if (schema.enum && !schema.enum.includes(value)) fail(code, "Unsupported enum value.", path);
		return value;
	}
	if (schema.type === "boolean") { if (typeof value !== "boolean") fail(code, "Expected boolean.", path); return value; }
	if (schema.type === "number" || schema.type === "integer") {
		if (typeof value !== "number" || !Number.isFinite(value) || (schema.type === "integer" && !Number.isSafeInteger(value)) || (schema.minimum !== undefined && value < schema.minimum) || (schema.maximum !== undefined && value > schema.maximum) || (schema.exclusiveMinimum !== undefined && value <= schema.exclusiveMinimum)) fail(code, "Number outside supported bounds.", path);
		return value;
	}
	throw new Error("Unsupported internal Studio schema.");
}
export const validateStudioIdentity = value => validateStudioSchema(identity, value, "INVALID_IDENTITY");
export const validateFrameRange = value => freezeStudioData(validateStudioSchema(range, value, "INVALID_RANGE"));

export function mandatoryStudioTargetIds(context) {
	return [...new Set([
		...(["object", "character", "rig"].includes(context.selection?.kind) ? [context.selection.id] : []),
		...(context.activeCharacterId ? [context.activeCharacterId] : []), ...(context.shot?.subjectIds ?? []),
		...context.jobs.flatMap(job => [job.characterId, ...(job.targetIds ?? [])]),
	])];
}
export function validateStudioContext(value) {
	// Budget check before inspecting strings/arrays; still reject nonfinite values
	// structurally below (JSON itself would otherwise turn them into null).
	const bytes = utf8ByteLength(JSON.stringify(value) ?? "");
	if (bytes > STUDIO_CONTEXT_MAX_BYTES) fail("CONTEXT_TOO_LARGE", "Studio context exceeds 16 KiB.", "$", { bytes, maxBytes: STUDIO_CONTEXT_MAX_BYTES });
	const c = validateStudioSchema(contextSchema, value, "INVALID_CONTEXT");
	const unique = new Set(c.entities.map(e => e.id));
	if (unique.size !== c.entities.length) fail("INVALID_CONTEXT", "Duplicate entity ID.");
	for (const targetId of mandatoryStudioTargetIds(c)) if (!unique.has(targetId)) fail("TARGET_NOT_READY", "Mandatory target is absent from context.");
	if (c.activeCharacterId && !c.entities.some(e => e.id === c.activeCharacterId && e.kind === "character")) fail("INVALID_CONTEXT", "Active target is not a character.");
	if (["object", "character", "rig"].includes(c.selection?.kind) && !c.entities.some(e => e.id === c.selection.id && e.kind === c.selection.kind)) fail("INVALID_CONTEXT", "Selection kind disagrees with the selected entity.");
	if (c.selection?.kind === "scene" && c.selection.id !== c.host.sceneId) fail("INVALID_CONTEXT", "Selected scene is not the bound scene.");
	for (const e of c.entities) {
		if (e.bounds && ["x", "y", "z"].some(axis => e.bounds.min[axis] > e.bounds.max[axis])) fail("INVALID_CONTEXT", "Inverted entity bounds.");
		if (e.kind === "object" && typeof e.scale === "number") fail("INVALID_CONTEXT", "Objects use three-axis scale.");
		if (e.kind !== "object" && record(e.scale)) fail("INVALID_CONTEXT", "Cast uses scalar scale.");
	}
	const p = c.entityPage;
	if (p.returned !== c.entities.length || p.total < p.returned || p.truncated !== (p.total > p.returned) || (p.truncated ? p.nextCursor === null : p.nextCursor !== null)) fail("INVALID_CONTEXT", "Entity pagination is inconsistent.");
	if (c.view.frame >= Math.max(1, c.scene.frameCount)) fail("INVALID_CONTEXT", "Playhead is outside the scene.");
	if (new Set(c.shots.map(s => s.id)).size !== c.shots.length) fail("INVALID_CONTEXT", "Duplicate shot ID.");
	for (const shot of [...c.shots, ...(c.shot ? [c.shot] : [])]) if (shot.range.endFrameExclusive > c.scene.frameCount) fail("INVALID_CONTEXT", "Shot is outside the scene.");
	if (c.shot && !c.shots.some(s => s.id === c.shot.id && s.range.startFrame === c.shot.range.startFrame && s.range.endFrameExclusive === c.shot.range.endFrameExclusive)) fail("INVALID_CONTEXT", "Current shot and range must survive projection.");
	return c;
}
export function validateStudioTurnEnvelope(value) {
	if (!record(value) || value.surface !== "studio") fail("INVALID_REQUEST", "Expected Studio envelope.");
	if (!isUuid(value.turnId)) fail("INVALID_TURN_ID", "Studio turnId must be a UUID.");
	if (!isUuid(value.sessionId)) fail("INVALID_SESSION_ID", "Studio sessionId must be a UUID.");
	validateStudioContext(value.context);
	return validateStudioSchema(turnSchema, value, "INVALID_REQUEST");
}
export const validateStudioStopEnvelope = value => validateStudioSchema(stopSchema, value, "INVALID_REQUEST");
export function validateTargetGuard(expected, current) {
	const a = validateStudioSchema(guardSchema, expected, "STALE_TARGET");
	const b = validateStudioSchema(guardSchema, current, "STALE_TARGET");
	if (Object.keys(a).some(key => a[key] !== b[key])) fail("STALE_TARGET", "Workspace, scene, epoch or target incarnation/content changed.", "$", { currentTargets: [b] });
	return true;
}
/** readContext must be authoritative for the explicitly submitted host, never
 * selected by connection order. View-only refreshes do not invalidate guards. */
export function validateStudioContextFreshness(submitted, current) {
	const a = validateStudioContext(submitted), b = validateStudioContext(current);
	if (!a.host.workspaceHandle || !b.host.workspaceHandle) fail("LIVE_HUB_UNAVAILABLE", "A connected editor handle is required.");
	if (Object.keys(host.properties).some(key => a.host[key] !== b.host[key])) fail("STALE_SCENE", "Studio host binding changed.", "$", { currentHost: b.host });
	for (const target of a.entities) {
		const actual = b.entities.find(e => e.id === target.id);
		if (!actual) fail("STALE_TARGET", "Submitted target is no longer available in the authoritative projection.");
		validateTargetGuard({ ...pickIdentity(a.host), targetId: target.id, token: target.token }, { ...pickIdentity(b.host), targetId: actual.id, token: actual.token });
	}
	if (a.revision.scene !== b.revision.scene || a.revision.physics !== b.revision.physics) fail("STALE_SCENE", "Authored context changed; obtain fresh intent.");
	return true;
}
const pickIdentity = value => Object.fromEntries(Object.keys(identityFields).map(key => [key, value[key]]));

function validateGenerationTiming(value) {
	const timed = value.beats.filter(beat => beat.seconds !== undefined).length;
	if ((value.durationSeconds !== undefined && timed !== 0) || (value.durationSeconds === undefined && timed !== value.beats.length)) fail("INVALID_ARGUMENT", "Use total duration or a duration for every beat, not mixed timing.");
	const total = value.durationSeconds ?? value.beats.reduce((sum, beat) => sum + beat.seconds, 0);
	if (total < 2 || total > 60 || total / value.beats.length < 0.5) fail("INVALID_ARGUMENT", "Generation must be 2-60 seconds with at least 0.5 seconds per beat.");
	return total;
}
/** Unknown paths are answered with the paths that DO exist for that kind, so a
 * caller never has to guess the vocabulary from a rejection. */
function validatePatchPaths(args) {
	const kinds = new Set();
	for (const op of Array.isArray(args?.ops) ? args.ops : []) {
		const kind = record(op) ? op.target?.kind : undefined;
		if (!STUDIO_PATCH_KINDS.includes(kind)) continue;
		kinds.add(kind);
		for (const key of record(op.set) ? Object.keys(op.set) : []) {
			if (!Object.hasOwn(STUDIO_PATCH_SET_SCHEMAS[kind].properties, key)) {
				fail("INVALID_ARGUMENT", `Unknown ${kind} path "${kind}.${key}". Valid ${kind} paths: ${STUDIO_PATCHABLE_PATHS[kind].join(", ")}.`);
			}
		}
	}
	// One patch is one commit domain and one history entry: a receipt asserts a
	// single revision step and exactly one undo entry, so a mixed batch could
	// not describe itself honestly.
	if (kinds.size > 1) fail("INVALID_ARGUMENT", "One domain per patch: split character, object, shot and stage edits into separate commands.");
}
export function validateStudioCommand(command) {
	if (!record(command) || !STUDIO_TOOL_FAMILIES.includes(command.name)) fail("UNKNOWN_TOOL", "Unsupported Studio tool.");
	if (command.name === "patch_elements") validatePatchPaths(command.args);
	const { args } = validateStudioSchema(object({ name: choices(STUDIO_TOOL_FAMILIES), args: toolSchemas[command.name] }), command);
	if (command.name === "inspect_studio" && args.ids && args.query !== undefined) fail("INVALID_ARGUMENT", "IDs and query are exclusive.");
	if (command.name === "operate_studio" && (!Object.keys(args).length || (args.view && !Object.keys(args.view).length))) fail("INVALID_ARGUMENT", "Transient operation must specify an action.");
	if (args.ops) {
		const names = args.ops.filter(op => op.op === "create" && op.name !== undefined).map(op => op.name.normalize("NFC").trim());
		if (new Set(names).size !== names.length) fail("DUPLICATE_NAME", "Create names must be unique; resolve existing targets by ID.");
		for (const op of args.ops) {
			if (op.op === "update" && Object.keys(op).length === 2) fail("INVALID_ARGUMENT", "Update has no fields.");
			if (op.facing && op.rotationDeg) fail("INVALID_ARGUMENT", "Facing and exact rotation are exclusive.");
			if (op.op === "group" && op.childIds.includes(op.parentId)) fail("INVALID_ARGUMENT", "Cannot group an object under itself.");
			if (args.collisionPolicy === "avoid" && (!["create", "update"].includes(op.op) || !op.position?.relativeTo)) fail("INVALID_ARGUMENT", "Avoid requires a side-relative position for every operation.");
		}
	}
	if (command.name === "generate_motion" && args.source.kind === "generate") {
		args.source.beats = args.source.beats.map(beat => ({ ...beat, text: beat.text.trim().replace(/\s+/g, " ") }));
		validateGenerationTiming(args.source);
	}
	if (command.name === "frame_shot" && args.framing.exact && JSON.stringify(args.framing.exact.position) === JSON.stringify(args.framing.exact.lookAt)) fail("INVALID_ARGUMENT", "Camera position and aim cannot coincide.");
	if (command.name === "patch_elements") {
		for (const op of args.ops) if (!Object.keys(op.set).length) fail("INVALID_ARGUMENT", "Patch has no fields.");
	}
	if (command.name === "verify_result") {
		if (Boolean(args.receiptId) === Boolean(args.targets)) fail("INVALID_ARGUMENT", "Exactly one of receiptId or targets is required.");
		if (args.checks.includes("motion") && args.range === undefined) args.range = "whole_clip";
	}
	return { name: command.name, args };
}
export function compileStudioBeats(value) {
	const source = validateStudioSchema(generateSource, value);
	const totalSeconds = validateGenerationTiming(source);
	const frameCount = Math.round(totalSeconds * 24);
	const blocks = []; let cumulative = 0, startFrame = 0;
	for (const [sourceBeat, beat] of source.beats.entries()) {
		cumulative += beat.seconds ?? totalSeconds / source.beats.length;
		const end = sourceBeat === source.beats.length - 1 ? frameCount : Math.round(cumulative * 24);
		const pieces = Math.ceil((end - startFrame) / 120), start = startFrame;
		for (let i = 0; i < pieces; i++) {
			const endFrameExclusive = start + Math.round((end - start) * (i + 1) / pieces);
			blocks.push({ sourceBeat, text: beat.text.trim().replace(/\s+/g, " "), startFrame, endFrameExclusive }); startFrame = endFrameExclusive;
		}
	}
	return freezeStudioData({ fps: 24, frameCount, durationSeconds: frameCount / 24, blocks });
}
export function validateReceipt(value) {
	if (value?.ok === false) {
		const r = validateStudioSchema(failureSchema, value, "INVALID_RECEIPT");
		if (utf8ByteLength(JSON.stringify(r)) > 8192) fail("INVALID_RECEIPT", "Failure receipt exceeds 8 KiB.");
		if ((r.mutated === false && r.preserved.authoredState !== "unchanged") || (r.mutated === true && r.preserved.authoredState !== "changed") || (r.mutated === "unknown" && (r.preserved.authoredState !== "unknown" || r.recovery.action !== "reconcile" || r.recovery.retryAllowed === true))) fail("INVALID_RECEIPT", "Failure must preserve uncertainty and actual state evidence.");
		return freezeStudioData(r);
	}
	const r = validateStudioSchema(receiptSchema, value, "INVALID_RECEIPT");
	if (utf8ByteLength(JSON.stringify(r)) > 8192) fail("INVALID_RECEIPT", "Receipt exceeds 8 KiB; use a detail cursor.");
	if (r.delta.some(d => !r.affectedIds.includes(d.id) || !Object.keys(d.after).length)) fail("INVALID_RECEIPT", "Readback must identify affected targets and actual state.");
	if (r.ops) {
		const dropped = r.ops.some(op => op.status === "partial");
		if (r.ops.some((op, index) => op.index !== index)) fail("INVALID_RECEIPT", "Operation results must report every operation in order.");
		if (r.ops.some(op => (op.status === "partial") !== Boolean(op.droppedPaths?.length))) fail("INVALID_RECEIPT", "A partial operation must name the paths the domain dropped, and only a partial one may.");
		if (r.status === "applied" && dropped) fail("INVALID_RECEIPT", "Applied status cannot hide a dropped path.");
		if (r.status === "partial" && !dropped) fail("INVALID_RECEIPT", "Partial status requires at least one dropped path.");
		if (r.status === "noop" && r.ops.some(op => op.status === "applied")) fail("INVALID_RECEIPT", "A noop cannot report an applied operation.");
	}
	if (r.status === "noop" || r.status === "transient") {
		if (r.authored || r.undo !== null || r.revision.before !== r.revision.after) fail("INVALID_RECEIPT", "Non-authored operations cannot create history or advance authored revision.");
		if (r.status === "noop" && (r.mutated !== false || r.delta.length)) fail("INVALID_RECEIPT", "Noop must prove no mutation.");
		if (r.status === "transient" && (!r.view || r.view.after < r.view.before || !r.delta.length)) fail("INVALID_RECEIPT", "Transient receipt requires view revisions and actual readback.");
	} else {
		if (!r.authored || !r.undo || r.revision.after !== r.revision.before + 1 || !r.affectedIds.length || !r.delta.length || r.mutated === false) fail("INVALID_RECEIPT", "Authored mutation requires one revision and one undo entry with actual readback.");
		if (r.delta.length < r.affectedIds.length && !r.detailCursor) fail("INVALID_RECEIPT", "Omitted batch readback requires a detail cursor.");
	}
	if (r.status === "undone") {
		if (new Set(r.restoredTargets.map(t => t.targetId)).size !== r.affectedIds.length || r.restoredTargets.some(t => !r.affectedIds.includes(t.targetId) || Object.keys(identityFields).some(key => t[key] !== r.host[key]))) fail("INVALID_RECEIPT", "Undo must identify every restored target and its new token in the bound host.");
	}
	if (r.status === "installed") {
		if (!r.jobId || !r.artifactId || !r.installed || !r.verification || !r.affectedIds.includes(r.installed.characterId)) fail("INVALID_RECEIPT", "Installation requires correlated target, artifact and verification evidence.");
		const { frameCount, blocks } = r.installed; let previous = 0;
		for (const block of blocks) { if (block.startFrame !== previous || block.endFrameExclusive <= previous || block.endFrameExclusive - previous > 120) fail("INVALID_RECEIPT", "Installed schedule is not contiguous or bounded."); previous = block.endFrameExclusive; }
		if (previous !== frameCount || r.installed.durationSeconds !== frameCount / 24 || r.verification.range.startFrame !== 0 || r.verification.range.endFrameExclusive !== frameCount || r.verification.evaluatedFrames > frameCount) fail("INVALID_RECEIPT", "Installed schedule and verification coverage disagree.");
		if (r.verification.status === "verified" && r.verification.evaluatedFrames !== frameCount) fail("INVALID_RECEIPT", "Verified motion requires whole-clip coverage.");
		if (r.verification.status === "unverified" && r.explicitUnverifiedAcceptance !== true) fail("INVALID_RECEIPT", "Unverified installation requires explicit user acceptance.");
	} else if (r.installed || r.verification || r.jobId || r.artifactId || r.repairs || r.explicitUnverifiedAcceptance !== undefined) fail("INVALID_RECEIPT", "Installation evidence is exclusive to installed receipts.");
	return freezeStudioData(r);
}

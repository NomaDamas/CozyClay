import {
	STUDIO_CONTEXT_MAX_BYTES, STUDIO_CONTEXT_LIMITS, StudioSchemas, StudioProtocolError,
	validateStudioContext, validateStudioSchema, mandatoryStudioTargetIds, utf8ByteLength, freezeStudioData,
} from "./studio-agent-protocol.js";

const escapeContext = context => JSON.stringify(context).replaceAll("<", "\\u003c").replaceAll(">", "\\u003e").replaceAll("&", "\\u0026");
const fail = (code, message) => { throw new StudioProtocolError(code, message); };
export function encodeStudioContext(context) {
	const encoded = escapeContext(validateStudioContext(context));
	if (utf8ByteLength(encoded) > STUDIO_CONTEXT_MAX_BYTES) fail("CONTEXT_TOO_LARGE", "Escaped Studio context exceeds 16 KiB.");
	return encoded;
}
export function buildStudioHistoryItem(context, userText) {
	if (typeof userText !== "string") fail("INVALID_REQUEST", "User text must be a string.");
	return { role: "user", content: [{ type: "input_text", text: `<studio-context>\n${encodeStudioContext(context)}\n</studio-context>` }, { type: "input_text", text: userText }] };
}
export function studioCacheKey(context, projectionKind = "scene") {
	const c = validateStudioContext(context);
	if (typeof projectionKind !== "string" || !projectionKind || projectionKind.length > 120) fail("INVALID_ARGUMENT", "Projection kind must be a bounded string.");
	return JSON.stringify([c.host.workspaceId, c.host.documentEpoch, c.host.sceneEpoch, c.revision.scene, projectionKind]);
}
export function studioEntityCursor(context, offset) {
	if (!Number.isSafeInteger(offset) || offset < 0) fail("INVALID_ARGUMENT", "Cursor offset must be nonnegative.");
	return JSON.stringify([context.host.workspaceId, context.host.documentEpoch, context.host.sceneEpoch, context.revision.scene, offset]);
}
export function validateStudioCursor(cursor, context) {
	let parts;
	try { parts = JSON.parse(cursor); } catch { fail("STALE_CURSOR", "Malformed projection cursor."); }
	if (!Array.isArray(parts) || parts.length !== 5 || !Number.isSafeInteger(parts[4]) || parts[4] < 0 || studioEntityCursor(context, parts[4]) !== cursor) fail("STALE_CURSOR", "Cursor belongs to an earlier projection.");
	return parts[4];
}

// Caller supplies a projection of authoritative refs, not the project document.
// The expanded arrays are validated against the same closed row schemas BEFORE
// truncation so forbidden data cannot hide in an omitted row.
export function buildStudioContext(input) {
	const c = structuredClone(input);
	const boundDisplay = value => {
		if (!value || typeof value !== "object") return;
		for (const [key, child] of Object.entries(value)) {
			if (["name", "summary", "slate", "phase"].includes(key) && typeof child === "string") value[key] = [...child].slice(0, 120).join("");
			else boundDisplay(child);
		}
	};
	boundDisplay(c);
	const schema = StudioSchemas.StudioContextV1;
	const expanded = { ...schema, properties: { ...schema.properties } };
	for (const key of ["entities", "shots", "assets", "recentReceipts"]) expanded.properties[key] = { ...schema.properties[key], maxItems: 10000 };
	const raw = validateStudioSchema(expanded, c, "INVALID_CONTEXT");
	if (new Set(raw.entities.map(e => e.id)).size !== raw.entities.length) fail("INVALID_CONTEXT", "Duplicate entity ID.");
	const mandatory = mandatoryStudioTargetIds(raw);
	if (mandatory.length > STUDIO_CONTEXT_LIMITS.entities) fail("CONTEXT_LIMIT", "Mandatory targets exceed 24; narrow the operation rather than omit a target.");
	for (const id of mandatory) if (!raw.entities.some(e => e.id === id)) fail("TARGET_NOT_READY", "Mandatory target is not available.");
	const rank = new Map(mandatory.map((id, i) => [id, i]));
	const anchor = raw.entities.find(e => e.id === mandatory[0])?.position;
	const distance = e => anchor && e.position ? (e.position.x - anchor.x) ** 2 + (e.position.y - anchor.y) ** 2 + (e.position.z - anchor.z) ** 2 : 0;
	const compareIds = (a, b) => a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
	raw.entities.sort((a, b) => (rank.get(a.id) ?? Infinity) - (rank.get(b.id) ?? Infinity) || distance(a) - distance(b) || compareIds(a, b));
	const total = raw.entities.length;
	raw.entities = raw.entities.slice(0, STUDIO_CONTEXT_LIMITS.entities);
	raw.shots.sort((a, b) => Number(b.id === raw.shot?.id) - Number(a.id === raw.shot?.id) || compareIds(a, b));
	raw.shotsTruncated = raw.shots.length > STUDIO_CONTEXT_LIMITS.shots;
	raw.shots = raw.shots.slice(0, STUDIO_CONTEXT_LIMITS.shots);
	raw.assets = raw.assets.slice(0, STUDIO_CONTEXT_LIMITS.assets);
	raw.recentReceipts = raw.recentReceipts.slice(0, STUDIO_CONTEXT_LIMITS.recentReceipts);
	const page = () => { raw.entityPage = { returned: raw.entities.length, total, truncated: raw.entities.length < total, nextCursor: raw.entities.length < total ? studioEntityCursor(raw, raw.entities.length) : null }; };
	page();
	if (utf8ByteLength(escapeContext(raw)) > STUDIO_CONTEXT_MAX_BYTES) {
		// Compact every mandatory target before dropping any detail or bystander.
		raw.entities = raw.entities.map(e => ({ id: e.id, kind: e.kind, token: e.token, detailsOmitted: true }));
		while (raw.entities.length > mandatory.length && utf8ByteLength(escapeContext(raw)) > STUDIO_CONTEXT_MAX_BYTES) { raw.entities.pop(); page(); }
		while (raw.shots.length && raw.shots.at(-1).id !== raw.shot?.id && utf8ByteLength(escapeContext(raw)) > STUDIO_CONTEXT_MAX_BYTES) { raw.shots.pop(); raw.shotsTruncated = true; }
		while (raw.assets.length && utf8ByteLength(escapeContext(raw)) > STUDIO_CONTEXT_MAX_BYTES) raw.assets.pop();
		while (raw.recentReceipts.length && utf8ByteLength(escapeContext(raw)) > STUDIO_CONTEXT_MAX_BYTES) raw.recentReceipts.pop();
	}
	encodeStudioContext(raw); // Never slice JSON bytes or silently lose a target.
	return freezeStudioData(raw);
}

// Local editor-boundary physics projection. Task 5 supplies these normalized
// physical fields and monotonic IK/motion/calibration stamps from all layers.
// It must not derive stamps from selection or send this projection to the model.
const id = { type: "string", minLength: 1, maxLength: 120, pattern: "^[A-Za-z0-9][A-Za-z0-9._:-]*$" };
const num = { type: "number" }, positive = { type: "number", exclusiveMinimum: 0 }, nonnegative = { type: "number", minimum: 0 };
const int = { type: "integer", minimum: 0, maximum: Number.MAX_SAFE_INTEGER }, bool = { type: "boolean" };
const nullable = schema => ({ oneOf: [schema, { type: "null" }] });
const object = fields => ({ type: "object", properties: fields, required: Object.keys(fields), additionalProperties: false });
const array = (items, maxItems = 10000, minItems = 0) => ({ type: "array", items, minItems, maxItems });
const vec = StudioSchemas.Vec3;
const timing = object({ cuts: array(object({ t: nonnegative, d: nonnegative }), 64), envelopes: array(array(nonnegative, 24, 24), 65, 1) });
const path = object({ points: array(vec, 64, 2), speed: nonnegative, faceTravel: bool, loop: bool, extend: bool, timing: nullable(timing) });
const physicalObject = object({ id, renderer: id, position: vec, rotationDeg: vec, scale: object({ x: positive, y: positive, z: positive }),
	footprint: object({ width: nonnegative, depth: nonnegative }), height: nonnegative, supportY: num, parentId: nullable(id), attachment: nullable(object({ characterId: id, bone: nullable(id) })), path: nullable(path), hidden: bool });
const physicalCharacter = object({ id, incarnation: id, modelId: nullable(id), rigId: nullable(id), rigReady: bool, hidden: bool, position: vec, yawDeg: num, scale: positive,
	takeId: nullable(id), sessionMotionId: nullable(id), motionRevision: int, calibrationRevision: int, ikRevision: int,
	waypoints: array(object({ frame: int, position: vec }), 10000) });
export const PHYSICS_FINGERPRINT_SCHEMA = freezeStudioData(object({ objects: array(physicalObject), characters: array(physicalCharacter), floor: object({ model: id, y: num }), frameCount: int }));
export function physicsFingerprintInput(input) {
	// Ignore explicitly nonphysical source fields. Nested physical shapes remain
	// closed and validated, including path timing and every inactive actor stamp.
	const select = (schema, value) => Object.fromEntries(Object.keys(schema.properties).map(key => [key, value[key]]));
	const projected = {
		objects: input.objects.map(value => select(physicalObject, value)),
		characters: input.characters.map(value => select(physicalCharacter, value)),
		floor: select(PHYSICS_FINGERPRINT_SCHEMA.properties.floor, input.floor), frameCount: input.frameCount,
	};
	const normalized = validateStudioSchema(PHYSICS_FINGERPRINT_SCHEMA, projected);
	for (const rows of [normalized.objects, normalized.characters]) {
		if (new Set(rows.map(row => row.id)).size !== rows.length) fail("INVALID_ARGUMENT", "Duplicate physical target ID.");
		rows.sort((a, b) => a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
	}
	return freezeStudioData(normalized);
}

// Pure, browser-independent contracts for the bounded Studio Agent surface.

export const STUDIO_PROTOCOL_VERSION = "studio-agent-v1";
export const STUDIO_CONTEXT_MAX_BYTES = 16 * 1024;
export const STUDIO_CONTEXT_LIMITS = Object.freeze({ entities: 24, shots: 8, assets: 6, recentReceipts: 3 });
export const STUDIO_TOOL_FAMILIES = Object.freeze([
	"inspect_studio", "operate_studio", "arrange_objects", "arrange_characters",
	"frame_shot", "generate_motion", "verify_result", "undo_edit",
]);
export const STUDIO_VARIANTS = Object.freeze({
	selectionKinds: Object.freeze(["scene", "object", "character", "rig", "camera"]),
	modes: Object.freeze(["scene", "camera", "motion"]),
	framingSizes: Object.freeze(["extreme close-up", "close-up", "medium close-up", "medium shot", "medium-wide shot", "wide shot", "extreme wide shot"]),
	framingViews: Object.freeze(["front", "front three-quarter", "profile", "rear three-quarter", "back"]),
	framingLevels: Object.freeze(["ground", "low", "hip", "eye", "high", "overhead"]),
	framingSides: Object.freeze(["left", "right"]),
	positionSides: Object.freeze(["left", "right", "front", "behind"]),
	positionBases: Object.freeze(["world", "subject", "shot_camera"]),
	collisionPolicies: Object.freeze(["report", "avoid"]),
});
export const STUDIO_CATALOGUE = Object.freeze(STUDIO_TOOL_FAMILIES.map((name) => Object.freeze({ name, slice: 1 })));

const isRecord = (value) => value !== null && typeof value === "object" && !Array.isArray(value);
const isNonEmpty = (value) => typeof value === "string" && value.trim().length > 0;
const isFiniteInteger = (value) => Number.isInteger(value) && Number.isFinite(value);
export const isUuid = (value) => typeof value === "string" && /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value);
const fail = (code, message, details = {}) => { throw new StudioProtocolError(code, message, details); };

export class StudioProtocolError extends Error {
	constructor(code, message, details = {}) { super(message); this.name = "StudioProtocolError"; this.code = code; this.details = details; }
	toJSON() { return { code: this.code, message: this.message, ...(Object.keys(this.details).length ? { details: this.details } : {}) }; }
}
export const studioError = (code, message, details) => ({ ok: false, error: { code, message, ...(details ? { details } : {}) } });

export function validateStudioIdentity(value, label = "identity") {
	if (!isRecord(value)) fail("INVALID_IDENTITY", `${label} must be an object`);
	for (const key of ["workspaceId", "documentEpoch", "sceneId", "sceneEpoch"]) if (!isNonEmpty(value[key])) fail("INVALID_IDENTITY", `${label}.${key} is required`);
	if (value.workspaceHandle !== null && value.workspaceHandle !== undefined && !isNonEmpty(value.workspaceHandle)) fail("INVALID_IDENTITY", "workspaceHandle must be non-empty or null");
	return value;
}

export function validateFrameRange(range) {
	if (!isRecord(range) || !isFiniteInteger(range.startFrame) || range.startFrame < 0 || !isFiniteInteger(range.endFrameExclusive) || range.endFrameExclusive <= range.startFrame) fail("INVALID_RANGE", "frame range must be half-open and non-empty");
	return Object.freeze({ startFrame: range.startFrame, endFrameExclusive: range.endFrameExclusive });
}

export function validateStudioContext(context) {
	if (!isRecord(context) || context.schema !== "studio-context-v1") fail("INVALID_CONTEXT", "schema must be studio-context-v1");
	validateStudioIdentity(context.host);
	if (!isRecord(context.revision) || !isFiniteInteger(context.revision.scene) || context.revision.scene < 0 || !isFiniteInteger(context.revision.physics) || context.revision.physics < 0 || !isFiniteInteger(context.revision.view) || context.revision.view < 0) fail("INVALID_CONTEXT", "revision must contain non-negative integer scene, physics and view values");
	if (!isRecord(context.scene) || !isFiniteInteger(context.scene.frameCount) || context.scene.frameCount <= 0) fail("INVALID_CONTEXT", "scene.frameCount must be positive");
	for (const [key, max] of Object.entries(STUDIO_CONTEXT_LIMITS)) if (!Array.isArray(context[key]) || context[key].length > max) fail("CONTEXT_LIMIT", `${key} exceeds its bounded limit`, { max });
	if (context.selection !== null && context.selection !== undefined && (!isRecord(context.selection) || !isNonEmpty(context.selection.id))) fail("INVALID_CONTEXT", "selection must be null or an identified target");
	if (context.activeCharacterId !== null && context.activeCharacterId !== undefined && !isNonEmpty(context.activeCharacterId)) fail("INVALID_CONTEXT", "activeCharacterId must be null or non-empty");
	const bytes = Buffer.byteLength(JSON.stringify(context), "utf8");
	if (bytes > STUDIO_CONTEXT_MAX_BYTES) fail("CONTEXT_TOO_LARGE", "Studio context exceeds 16 KiB", { bytes, maxBytes: STUDIO_CONTEXT_MAX_BYTES });
	return context;
}

export function validateStudioTurnEnvelope(value) {
	if (!isRecord(value) || value.surface !== "studio") return null;
	if (!isUuid(value.turn_id)) fail("INVALID_TURN_ID", "Studio turn_id must be a UUID");
	if (!isUuid(value.sessionId)) fail("INVALID_SESSION_ID", "Studio sessionId must be a UUID");
	validateStudioContext(value.context);
	if (!isNonEmpty(value.text)) fail("INVALID_REQUEST", "Studio text is required");
	return value;
}

export function validateTargetGuard(guard, current) {
	if (!isRecord(guard) || !isRecord(current)) fail("STALE_TARGET", "target guard is unavailable");
	for (const key of ["documentEpoch", "sceneEpoch", "token"]) if (guard[key] !== current[key]) fail("STALE_TARGET", `target ${key} is stale`, { expected: guard[key], actual: current[key] });
	return true;
}

export function validateStudioCommand(command) {
	if (!isRecord(command) || !STUDIO_TOOL_FAMILIES.includes(command.name)) fail("UNKNOWN_TOOL", "unsupported Studio tool", { name: command?.name });
	if (!isRecord(command.args)) fail("INVALID_ARGUMENT", "Studio tool arguments must be an object");
	if (command.args.variant !== undefined && !["intent", "exact", "world", "relative", "between", "onObject", "create", "update", "remove", "group", "ungroup", "attach", "detach", "path"].includes(command.args.variant)) fail("UNKNOWN_VARIANT", "unsupported Studio argument variant", { variant: command.args.variant });
	if (Array.isArray(command.args.ops)) {
		const names = command.args.ops.filter((op) => isRecord(op) && op.op === "create" && isNonEmpty(op.name)).map((op) => op.name);
		if (new Set(names).size !== names.length) fail("DUPLICATE_NAME", "Studio create operations must have unique names");
	}
	return command;
}

export function validateReceipt(receipt) {
	if (!isRecord(receipt) || receipt.ok !== true || !isNonEmpty(receipt.commandId) || !isNonEmpty(receipt.receiptId) || !["applied", "installed", "undone"].includes(receipt.status) || !Array.isArray(receipt.affectedIds)) fail("INVALID_RECEIPT", "receipt is not a valid Studio mutation receipt");
	return receipt;
}

export const StudioSchemas = Object.freeze({ catalogue: STUDIO_CATALOGUE, variants: STUDIO_VARIANTS, context: "studio-context-v1", receipt: "studio-receipt-v1" });

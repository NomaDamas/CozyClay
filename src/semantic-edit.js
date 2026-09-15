import { createCameraBlock } from "./camera-block.js";

export const FIRST_EDIT_VERSION = 1;
export const FIRST_EDIT_KINDS = Object.freeze([
	"pose_edit", "object_insert", "cutout_insert", "object_transform",
	"shot_add", "shot_edit", "camera_key_record", "rail_edit",
	"prompt_block_add", "prompt_block_edit",
]);

// Compare authored values, not object identities. Solvers and pointer callbacks
// can reconstruct the same pose with floating-point roundoff. Values stay local;
// only the closed edit-kind vocabulary ever crosses the analytics boundary.
function equal(a, b) {
	if (a === b) return true;
	if (typeof a === "number" && typeof b === "number") return Math.abs(a - b) < 1e-8;
	if (!a || !b || typeof a !== "object" || typeof b !== "object") return false;
	if (a instanceof Map || b instanceof Map) {
		return a instanceof Map && b instanceof Map && a.size === b.size
			&& [...a].every(([key, value]) => b.has(key) && equal(value, b.get(key)));
	}
	const keys = Object.keys(a);
	return keys.length === Object.keys(b).length && keys.every((key) => Object.hasOwn(b, key) && equal(a[key], b[key]));
}
const poseValue = (pose) => ({ bones: pose?.bones ?? {}, rootY: pose?.rootY ?? 0 });
const blockValues = (blocks) => blocks.map(({ id, ...value }) => value);
const keyValues = (keys = []) => keys.map(({ frame, framing }) => ({ frame, framing }));
const shotValue = (shot) => ({ ...shot, camera: createCameraBlock(shot.camera), cameraKeys: keyValues(shot.cameraKeys) });

export function semanticEditKind(domain, before, after) {
	if (before === after) return null;
	if (domain === "pose") return equal(before, after) ? null : "pose_edit";
	if (domain === "promptClips") {
		if (equal(blockValues(before), blockValues(after))) return null;
		return after.length > before.length ? "prompt_block_add" : "prompt_block_edit";
	}
	if (domain === "objects") {
		const added = after.find((item) => !before.some((previous) => previous.id === item.id));
		if (added) return added.renderer === "cutout" ? "cutout_insert" : "object_insert";
		return equal(before, after) ? null : "object_transform";
	}
	if (domain === "characters") {
		if (after.some((item) => !before.some((previous) => previous.id === item.id))) return "object_insert";
		for (const item of after) {
			const previous = before.find((entry) => entry.id === item.id);
			if (previous && !equal(poseValue(previous.pose), poseValue(item.pose))) return "pose_edit";
		}
		// Motion buffers/layer synchronization are passive, not cast transforms.
		const placement = (items) => items.map(({ id, x, y = 0, z, rot, scale = 1, hidden = false, model, tint, subject, identityImage }) => ({ id, x, y, z, rot, scale, hidden, model, tint, subject, identityImage }));
		return equal(placement(before), placement(after)) ? null : "object_transform";
	}
	if (domain === "shots") {
		if (after.some((item) => !before.some((previous) => previous.id === item.id))) return "shot_add";
		for (const item of after) {
			const previous = before.find((entry) => entry.id === item.id);
			if (!previous) continue;
			const camera = createCameraBlock(item.camera), oldCamera = createCameraBlock(previous.camera);
			if (["cameraRail", "craneHeight", "railFollow", "dollyTiming"].some((key) => !equal(camera[key], oldCamera[key]))) return "rail_edit";
			const keys = item.cameraKeys ?? [], oldKeys = previous.cameraKeys ?? [];
			if (keys.length > oldKeys.length || keys.some((key) => {
				const old = oldKeys.find((entry) => entry.frame === key.frame);
				return old && !equal(old.framing, key.framing);
			})) return "camera_key_record";
		}
		return equal(before.map(shotValue), after.map(shotValue)) ? null : "shot_edit";
	}
	return null;
}

export function createFirstEditTracker(emit) {
	// Dedupe once per editor App mount, independently for Studio and Playground.
	// Scene/project switches and history do not reset it; no install persistence.
	const seen = new Set();
	return (surface, domain, before, after) => {
		if (!["craft", "playground"].includes(surface) || seen.has(surface)) return false;
		const kind = semanticEditKind(domain, before, after);
		if (!kind) return false;
		seen.add(surface);
		emit(`${surface}:first_edit`, { edit_kind: kind, definition_version: FIRST_EDIT_VERSION });
		return true;
	};
}

// Synchronous mutation owner shared by UI and live commands. Keeping the before
// value here avoids stale React closures and analytics inside replayable updater
// functions. Passive writes (load, history, navigation) advance the same value
// without reporting; a rejected reducer never publishes or reports anything.
export function createSemanticState(initial, publish, observe, domain) {
	let current = initial;
	const apply = (update, authored) => {
		const before = current;
		const after = typeof update === "function" ? update(before) : update;
		current = after;
		publish(after);
		if (authored) observe(domain, before, after);
		return after;
	};
	return { set: (update) => apply(update, false), edit: (update) => apply(update, true) };
}

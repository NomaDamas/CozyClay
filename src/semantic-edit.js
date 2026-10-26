// 2: counted from the user's own command-bus receipts (#922); 1 diffed domain values and
// missed shot, camera and object edits in the real Studio.
export const FIRST_EDIT_VERSION = 2;
export const FIRST_EDIT_KINDS = Object.freeze([
	"pose_edit", "object_insert", "cutout_insert", "object_transform",
	"shot_add", "shot_edit", "camera_key_record", "rail_edit",
	"prompt_block_add", "prompt_block_edit",
]);

/** (surface, kind) -> the surface's first edit, once: `${surface}:first_edit` with a closed kind. */
export function createFirstEditRecorder(emit) {
	// Dedupe once per editor App mount, independently for Studio and Playground.
	// Scene/project switches and history do not reset it; no install persistence.
	const seen = new Set();
	const record = (surface, kind) => {
		if (!["craft", "playground"].includes(surface) || seen.has(surface) || !FIRST_EDIT_KINDS.includes(kind)) return false;
		seen.add(surface);
		emit(`${surface}:first_edit`, { edit_kind: kind, definition_version: FIRST_EDIT_VERSION });
		return true;
	};
	record.seen = surface => seen.has(surface);
	return record;
}

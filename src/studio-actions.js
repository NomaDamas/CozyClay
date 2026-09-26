// One Studio action registry for the editor UI and the agent. The
// declarations below are data shared with the sidecar (ids, descriptions,
// input schemas, kinds); the editor registers ONE implementation per id, and
// both its UI controls and the agent's `run_action` family call
// `registry.run(id, args)`. No React, renderer or Node imports.
import { StudioProtocolError, StudioSchemas, freezeStudioData, validateStudioSchema } from "./studio-agent-protocol.js";

/** mutation: authored, undoable, answered with a journal receipt.
 * transient: view state only. job: starts long-running work (a generation). */
export const STUDIO_ACTION_KINDS = freezeStudioData(["mutation", "transient", "job"]);

const idSchema = StudioSchemas.TargetGuard.properties.targetId;
const frame = { type: "integer", minimum: 0, maximum: Number.MAX_SAFE_INTEGER };
const input = (required = {}, optional = {}) => ({ type: "object", properties: { ...required, ...optional }, required: Object.keys(required), additionalProperties: false });
const shotId = { shotId: idSchema };
const characterId = { characterId: idSchema };
/** A world floor point in metres; y is the floor. */
const floorPoint = input({ x: { type: "number" }, z: { type: "number" } });
const waypointFrame = { ...frame, minimum: 1 };
const WAYPOINT_RULES = "Pins sit at least 8 frames apart, the walk between two pins must stay within 0.5-3 m/s, and x/z are clamped to +/-11 m; a pin that breaks a rule is refused with the frame or distance that would work.";

export const STUDIO_ACTIONS = freezeStudioData([
	{ id: "shot.create", label: "Add shot", kind: "mutation", undoDomain: "shot", input: input(),
		description: "Add a new shot at the playhead, keyed with the current camera framing (the timeline's + Add shot). Move the playhead first with operate_studio { frame }. When the playhead is inside a shot, the new one goes in the next free gap." },
	{ id: "shot.split", label: "Split shot", kind: "mutation", undoDomain: "shot", input: input(shotId),
		description: "Cut a shot in two at the playhead. The playhead must be inside that shot, after its first frame; the second half starts at the playhead." },
	{ id: "shot.duplicate", label: "Duplicate shot", kind: "mutation", undoDomain: "shot", input: input(shotId),
		description: "Copy a shot, its camera and its keys into the next free gap on the timeline." },
	{ id: "shot.remove", label: "Delete shot", kind: "mutation", undoDomain: "shot", input: input(shotId),
		description: "Delete a shot and leave its frames as free-camera time." },
	{ id: "shot.setRange", label: "Set shot range", kind: "mutation", undoDomain: "shot", input: input({ ...shotId, range: StudioSchemas.FrameRange }),
		description: "Move a shot's start and end to a half-open frame range. Edges are clamped to the timeline and refused where they would overlap another shot; the receipt's delta shows the range that landed." },
	{ id: "shot.reorder", label: "Move shot", kind: "mutation", undoDomain: "shot", input: input({ ...shotId, startFrame: frame }),
		description: "Move a shot in time to start at startFrame, keeping its length and camera keys. Refused (a noop) where it would overlap another shot." },
	{ id: "motion.generateAllBlocks", label: "Generate all blocks", kind: "job", input: input(),
		description: "Generate the active character's motion from all of its prompt blocks, like the timeline's Generate all blocks button. It starts a job and returns status \"started\"; the take lands in the editor when the job finishes. Counts as the one motion generation of this message." },
	{ id: "character.addWaypoint", label: "Add root waypoint", kind: "mutation", undoDomain: "cast", input: input({ ...characterId, position: floorPoint }, { frame: waypointFrame }),
		description: `Pin a character's root path: at frame, the character's root stands at position (world x/z metres). Frame 0 is the character's own spot, so pins start at frame 1 and each frame holds one pin. Omit frame to pace the pin at a walk (1.4 m/s) from the previous one. ${WAYPOINT_RULES} Read paths with inspect_studio { scope: "motion" }.` },
	{ id: "character.moveWaypoint", label: "Move root waypoint", kind: "mutation", undoDomain: "cast", input: input({ ...characterId, frame: waypointFrame, position: floorPoint }),
		description: `Move the character's root waypoint at frame to a new floor position (world x/z metres), keeping its frame. ${WAYPOINT_RULES}` },
	{ id: "character.removeWaypoint", label: "Remove root waypoint", kind: "mutation", undoDomain: "cast", input: input({ ...characterId, frame: waypointFrame }),
		description: "Remove the character's root waypoint at frame." },
	{ id: "character.clearWaypoints", label: "Clear root path", kind: "mutation", undoDomain: "cast", input: input(characterId),
		description: "Remove every root waypoint of the character, leaving its motion unconstrained by a path." },
	{ id: "object.duplicate", label: "Duplicate object", kind: "mutation", undoDomain: "objects", input: input({}, { objectId: idSchema }),
		description: "Copy a scene object (the selected one when objectId is omitted) and place the copy half a metre beside it." },
]);
export const STUDIO_ACTION_IDS = freezeStudioData(STUDIO_ACTIONS.map(action => action.id));

const fail = (code, message) => { throw new StudioProtocolError(code, message); };
const unknown = (id, known) => fail("INVALID_ARGUMENT", `Unknown Studio action "${id}". Known actions: ${known.join(", ")}. List them with inspect_studio { scope: "actions" }.`);

export function studioActionDeclaration(id) {
	return STUDIO_ACTIONS.find(action => action.id === id) ?? unknown(id, STUDIO_ACTION_IDS);
}

/** `readState` is the editor's current action state; when it is supplied,
 * run() refuses an unavailable action with its reason before anything runs. */
export function createStudioActionRegistry({ readState } = {}) {
	const entries = new Map();
	const availability = (entry, state) => {
		const verdict = entry.available(state);
		if (verdict !== true && (typeof verdict !== "string" || !verdict.trim())) throw new Error(`Studio action ${entry.id} must answer availability with true or a reason.`);
		return verdict;
	};
	const registry = {
		register(entry) {
			if (typeof entry?.id !== "string" || !new RegExp(idSchema.pattern).test(entry.id)) throw new Error("A Studio action needs an id.");
			if (entries.has(entry.id)) throw new Error(`Studio action ${entry.id} is already registered.`);
			if (!STUDIO_ACTION_KINDS.includes(entry.kind)) throw new Error(`Studio action ${entry.id} has an unknown kind.`);
			if (entry.input?.type !== "object" || !entry.input.properties || !Array.isArray(entry.input.required)) throw new Error(`Studio action ${entry.id} needs an object input schema.`);
			if (typeof entry.available !== "function") throw new Error(`Studio action ${entry.id} needs available(state).`);
			if (typeof entry.run !== "function") throw new Error(`Studio action ${entry.id} needs run(args).`);
			entries.set(entry.id, Object.freeze({ ...entry }));
			return registry;
		},
		get(id) { return entries.get(id) ?? unknown(id, [...entries.keys()]); },
		ids() { return [...entries.keys()]; },
		/** Available actions carry their description and input schema;
		 * unavailable ones carry the reason instead of arguments. */
		list(state = readState?.()) {
			return [...entries.values()].map(entry => {
				const verdict = availability(entry, state);
				const row = { id: entry.id, label: entry.label, kind: entry.kind, description: entry.description };
				return verdict === true ? { ...row, available: true, input: entry.input } : { ...row, available: false, reason: verdict };
			});
		},
		run(id, args = {}) {
			const entry = registry.get(id);
			const validated = validateStudioSchema(entry.input, args ?? {}, "INVALID_ARGUMENT", "$.args");
			if (readState) {
				const verdict = availability(entry, readState());
				if (verdict !== true) fail("TARGET_NOT_READY", verdict);
			}
			const result = entry.run(validated);
			if (!Array.isArray(result?.affectedIds) || result.affectedIds.some(value => typeof value !== "string") || typeof result.summary !== "string") {
				throw new Error(`Studio action ${id} must return { affectedIds, summary }.`);
			}
			return { affectedIds: [...result.affectedIds], summary: result.summary };
		},
	};
	return registry;
}

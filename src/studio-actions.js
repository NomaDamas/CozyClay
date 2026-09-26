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
/** The tracks an IK key stores (src/ardy/ik.js IK_TRACKS and FK_TRACKS). A
 * chain track keys its three bones (upper, lower, end); a joint track one. */
export const STUDIO_IK_CHAIN_TRACKS = freezeStudioData(["leftHand", "rightHand", "leftFoot", "rightFoot"]);
export const STUDIO_IK_JOINT_TRACKS = freezeStudioData(["hips", "spine", "chest", "neck", "head", "leftShoulder", "rightShoulder"]);
const num = { type: "number" };
const perBone = items => ({ type: "array", items, minItems: 1, maxItems: 3 });
const quaternion = input({ x: num, y: num, z: num, w: num });
/** One track's key: the IK state's { q, p, baseQ, basePos, chainP,
 * keepTranslations } with quaternions as {x,y,z,w} and positions as {x,y,z}. */
const ikTrackKey = input({}, { q: perBone(quaternion), p: StudioSchemas.Vec3, baseQ: perBone(quaternion), basePos: StudioSchemas.Vec3,
	chainP: perBone(StudioSchemas.Vec3), keepTranslations: { type: "boolean" } });
const ikTracks = input({}, Object.fromEntries([...STUDIO_IK_CHAIN_TRACKS, ...STUDIO_IK_JOINT_TRACKS].map(track => [track, ikTrackKey])));
/** The bones an object can ride (src/scene-objects.js SCENE_ATTACH_BONES). */
export const STUDIO_ATTACH_BONES = freezeStudioData(["hips", "spine", "chest", "neck", "head", "leftShoulder", "leftElbow", "leftHand",
	"rightShoulder", "rightElbow", "rightHand", "leftKnee", "leftFoot", "rightKnee", "rightFoot"]);
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
	{ id: "character.setIkKey", label: "Set IK key", kind: "mutation", undoDomain: "motion", input: input({ ...characterId, frame, tracks: ikTracks }),
		description: "Key a character's IK correction layer at frame, the same key a pose drag bakes. tracks maps a track id to its key: q is the bones' LOCAL rotations as unit quaternions {x,y,z,w}, three for a chain track (leftHand, rightHand, leftFoot, rightFoot: upper, lower and end bone) and one for a joint track (hips, spine, chest, neck, head, leftShoulder, rightShoulder); p is a joint's local position {x,y,z} (the hips' height and lean). Optional baseQ/basePos give the take's own pose the key was made over, so it applies as a delta on the take; chainP gives a chain's three local bone positions; keepTranslations keeps them over the take's. A key needs q or p. Each named track replaces its key at frame and starts evaluating; other tracks at that frame stay. Keyed frames are in inspect_studio { scope: \"motion\" } ikKeyFrames." },
	{ id: "character.removeIkKey", label: "Delete IK key", kind: "mutation", undoDomain: "motion", input: input({ ...characterId, frame }),
		description: "Delete the character's whole IK key at frame (every track keyed there), like the Full-Body lane's delete." },
	{ id: "character.clearIkKeys", label: "Clear IK keys", kind: "mutation", undoDomain: "motion", input: input(characterId),
		description: "Delete every IK key of the character, returning it to its take or pose without corrections." },
	{ id: "shot.setCameraRail", label: "Set camera rail", kind: "mutation", undoDomain: "shot",
		input: input({ ...shotId, points: { type: "array", items: floorPoint, minItems: 2, maxItems: 512 } }),
		description: "Lay a shot's dolly rail through points (world floor x/z metres, in travel order) and put the shot's camera on it, like drawing the rail in the Top-View. It replaces any rail the shot had; an authored rail-follow range is kept, otherwise the camera travels the rail over the whole shot. Read rails with inspect_studio { scope: \"shot\" }." },
	{ id: "shot.clearCameraRail", label: "Delete camera rail", kind: "mutation", undoDomain: "shot", input: input(shotId),
		description: "Delete a shot's camera rail; the shot's camera goes back to following its subject at the current distance." },
	{ id: "object.attach", label: "Attach to character", kind: "mutation", undoDomain: "objects",
		input: input({ objectId: idSchema, ...characterId }, { bone: { type: "string", enum: STUDIO_ATTACH_BONES } }),
		description: "Make a scene object ride a character, like dropping it on the character's Hierarchy row: on one bone (a cup in the right hand: bone \"rightHand\") or, with bone omitted, on the character's animated root so it travels with the body. The object keeps its place on screen: its position, rotation and scale are rewritten into the new frame (local to that bone while attached), and it leaves any group. Needs the character's rig on stage." },
	{ id: "object.detach", label: "Detach object", kind: "mutation", undoDomain: "objects", input: input({ objectId: idSchema }),
		description: "Put an attached or grouped object back in the world where it is now, like the Inspector's Detach or dropping it on the Props row: it stops following the character, keeps its current world placement and leaves any group." },
	{ id: "object.duplicate", label: "Duplicate object", kind: "mutation", undoDomain: "objects", input: input({}, { objectId: idSchema }),
		description: "Copy a scene object (the selected one when objectId is omitted) and place the copy half a metre beside it." },
]);
export const STUDIO_ACTION_IDS = freezeStudioData(STUDIO_ACTIONS.map(action => action.id));

const fail = (code, message) => { throw new StudioProtocolError(code, message); };

/** A refusal an editor control can also meet. `message` is written for the
 * model; `uiMessage` is the localized text the editor's UI door shows a
 * person. A refusal without one stays silent in the UI. */
export function studioActionRefusal(code, message, uiMessage) {
	return Object.assign(new StudioProtocolError(code, message), { uiMessage });
}
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

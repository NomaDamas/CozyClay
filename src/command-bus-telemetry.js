// The command bus's friction signals: studio:refused (one per refusal, capped per
// key), the history receipts an undo can name, and edit:undone for the user's own
// undos (domains/scene-undo.js). Only closed values leave: a refusal code, a
// command group, an edit kind, an age bucket. Never ids, args or messages.
import { EDIT_GROUPS, recordSemanticEdit, track } from './analytics.js';
import { createFirstEditRecorder } from './semantic-edit.js';
import { admit, bump } from './analytics-friction.js';
import { bucketAge, refusalCodeOf } from './analytics-strict.js';
import { noteEditGesture } from './post-turn-edits.js';

let send = track, clock = () => Date.now();
const REFUSALS_PER_KEY = 3, UNDOS_PER_SESSION = 20, STAMPS_KEPT = 500;

// Command id prefix to studio:refused group; anything else is "other".
const GROUPS = [
	[/^objects?\./, 'object'], [/^shot\./, 'shot'], [/^(characters?|cast)\./, 'cast'], [/^scene\./, 'scene'],
	[/^(?:motion|ik)\./, 'motion'], [/^edit\./, 'edit'], [/^task\./, 'task'], [/^agent\./, 'agent'],
];
export const commandGroup = id => GROUPS.find(([pattern]) => pattern.test(String(id)))?.[1] ?? 'other';

// The one table from a committed command to its closed edit kind (FIRST_EDIT_KINDS,
// semantic-edit.js); its group (EDIT_GROUPS, analytics.js) follows from the kind.
// A shot's camera framing, keys and lens record a camera key; its rail, crane and
// mode are a rail edit; bone and IK keys are pose; placing or adding a character
// counts as an object, as it does for object_insert. Everything else is no edit kind.
const EDIT_KINDS = [
	[/^shot\.(create|createStill|duplicate|split)$/, 'shot_add'],
	[/^shot\.(setCameraRail|clearCameraRail|setCameraMode)$/, 'rail_edit'],
	[/^shot\.(setCamera|addKey|moveKey|removeKey|clearKeys|setLens|frame|captureCamera|placeCamera)$/, 'camera_key_record'],
	[/^shot\./, 'shot_edit'],
	[/^(character\.(setPose|setIkKey|removeIkKey|clearIkKeys)|ik\.|motion\.rangePin\.)/, 'pose_edit'],
	[/^(object\.(add|duplicate|sculpt|createKit)|character\.add)$/, 'object_insert'],
	[/^(objects?\.|character\.(set|remove|update|move)$|characters\.arrange$|cast\.replace$)/, 'object_transform'],
	// The take's fields carry its prompt (motion.take.prompt).
	[/^motion\.set$/, 'prompt_block_edit'],
];
// Built on first use: this module loads inside an import cycle (analytics.js -> semantic-edit.js ->
// command-bus.js -> here), where EDIT_GROUPS is not initialized yet.
let groups = null;
const groupOf = kind => (groups ??= new Map(Object.entries(EDIT_GROUPS).flatMap(([group, kinds]) => kinds.map(entry => [entry, group])))).get(kind);
/** A command's closed edit kind, or null; `placeAs` (asset.import's closed enum) tells a cutout from a mesh. */
export function firstEditKindOf(action, placeAs) {
	if (action === 'asset.import') return placeAs === 'cutout' ? 'cutout_insert' : 'object_insert';
	return EDIT_KINDS.find(([pattern]) => pattern.test(String(action)))?.[1] ?? null;
}
const AGENT_WORK = new Set(['agent.turn.finish', 'task.finish']);
/** The edit:undone / post-turn group of a command: pose, camera, object, shot, prompt, agent_turn or other. */
export function editKind(action, origin = 'ui', placeAs) {
	// What the agent made (its turn, a task, or an edit it ran on its own) is undone as agent work.
	if (AGENT_WORK.has(action) || origin !== 'ui') return 'agent_turn';
	return groupOf(firstEditKindOf(action, placeAs)) ?? 'other';
}

// The user's own edits feed the session edit buckets and the surface's first edit
// (definition_version 2). App starts a new mount boundary with startUserEdits.
let editSurface = 'craft', firstEdit = createFirstEditRecorder((event, props) => send(event, props));
export function startUserEdits(surface) {
	editSurface = surface;
	firstEdit = createFirstEditRecorder((event, props) => send(event, props));
}

const emit = (event, props) => {
	try { send(event, props); } catch { /* telemetry is advisory */ }
};

/** A refusal receipt: the session counter always moves; the event, at most 3 times per (code, group, origin). */
export function noteRefusal(value, origin, id) {
	// A cancel the caller asked for is not a refusal.
	if (value.code === 'CANCELLED') return;
	const by = origin === 'ui' ? 'ui' : 'agent', code = refusalCodeOf(value.code), group = commandGroup(id);
	bump(by === 'ui' ? 'refusals_ui' : 'refusals_agent');
	if (admit(`studio:refused:${code}:${group}:${by}`, REFUSALS_PER_KEY)) emit('studio:refused', { code, origin: by, phase: value.phase, group });
}

// receiptId -> { at, kind }: when a history receipt was recorded and what it did.
const stamps = new Map();

/**
 * The bus's history receipts by history entry id (what edit.undo restores), each
 * stamped when it was recorded. Gesture rule: a drag is one transaction whose
 * receipt is recorded at run.commit, and any later receipt naming the same entry
 * replaces the earlier one, so an entry's age runs from its LAST receipt: the
 * time since the user finished that edit, not since they started it.
 */
export function createHistoryReceipts(ports) {
	const receipts = new Map();
	return {
		get: historyEntryId => receipts.get(historyEntryId),
		/** `id` the command, `action` the command a transaction ran (run.commit of a drag). */
		remember(recorded, { id, origin, action, placeAs }) {
			// Session friction: an undo the user made (agent undos are the agent's own correction).
			if (id === 'edit.undo' && origin === 'ui' && recorded.status === 'undone') bump('undos');
			// The user's edit that changed the scene, once per receipt (a drag commits once): the session edit
			// buckets, the first edit and agent:post_turn_edit. Agent, MCP and undo/redo receipts never count.
			if (origin === 'ui' && recorded.authored === true && !id.startsWith('edit.')) noteUserEdit(firstEditKindOf(action ?? id, placeAs));
			if (recorded.undo?.canUndoDirect && !id.startsWith('edit.')) {
				receipts.set(recorded.undo.historyEntryId, recorded);
				stamps.set(recorded.receiptId, { at: clock(), kind: editKind(action ?? id, origin, placeAs) });
				while (stamps.size > STAMPS_KEPT) stamps.delete(stamps.keys().next().value);
			}
			for (const [key, receipt] of receipts) if (ports.isRetained?.(receipt) === false) { receipts.delete(key); stamps.delete(receipt.receiptId); }
		},
	};
}

function noteUserEdit(kind) {
	if (!kind) return;
	try { recordSemanticEdit(kind); firstEdit(editSurface, kind); } catch { /* telemetry is advisory */ }
	noteEditGesture(groupOf(kind));
}

const RESULTS = { undone: 'done', noop: 'noop' };
/** The user's undo (`via` key, menu or button): its receipt, or null for an IK drag preview backed out. */
export function noteUndone(via, receipt) {
	const result = !receipt ? 'done' : receipt.ok === false ? 'refused' : RESULTS[receipt.status];
	if (!result || !admit('edit:undone', UNDOS_PER_SESSION)) return;
	// A native history entry no receipt names (or nothing undone at all) is "other", with no age.
	const stamp = result === 'done' && receipt ? stamps.get(receipt.undoneReceiptId) : null;
	emit('edit:undone', { kind: receipt ? stamp?.kind ?? 'other' : 'ik_preview', via, result, ...(stamp ? { age: bucketAge(clock() - stamp.at) } : {}) });
}

/** Tests only: capture what is sent and drive the clock; returns the restore. */
export function telemetrySeam({ track: capture = track, now = () => Date.now() } = {}) {
	const previous = [send, clock];
	send = capture; clock = now;
	return () => { [send, clock] = previous; stamps.clear(); };
}

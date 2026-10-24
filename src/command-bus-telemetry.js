// The command bus's friction signals: studio:refused (one per refusal, capped per
// key), the history receipts an undo can name, and edit:undone for the user's own
// undos (domains/scene-undo.js). Only closed values leave: a refusal code, a
// command group, an edit kind, an age bucket. Never ids, args or messages.
import { track } from './analytics.js';
import { admit, bump } from './analytics-friction.js';
import { bucketAge, refusalCodeOf } from './analytics-strict.js';

let send = track, clock = () => Date.now();
const REFUSALS_PER_KEY = 3, UNDOS_PER_SESSION = 20, STAMPS_KEPT = 500;

// Command id prefix to studio:refused group; anything else is "other".
const GROUPS = [
	[/^objects?\./, 'object'], [/^shot\./, 'shot'], [/^(characters?|cast)\./, 'cast'], [/^scene\./, 'scene'],
	[/^motion\./, 'motion'], [/^edit\./, 'edit'], [/^task\./, 'task'], [/^agent\./, 'agent'],
];
export const commandGroup = id => GROUPS.find(([pattern]) => pattern.test(String(id)))?.[1] ?? 'other';

// The undone entry's action id to edit:undone kind. Groups follow EDIT_GROUPS
// (analytics.js) and the semantic kinds (semantic-edit.js): a shot's camera
// framing, keys, lens, rail and mode are camera; bone and IK keys are pose;
// placing or adding a character counts as an object, as it does for object_insert.
const KINDS = [
	[/^shot\.(setCamera|setCameraRail|clearCameraRail|setCameraMode|addKey|moveKey|removeKey|clearKeys|setLens|frame|captureCamera|placeCamera)$/, 'camera'],
	[/^shot\./, 'shot'],
	[/^(character\.(setPose|setIkKey|removeIkKey|clearIkKeys)|ik\.|motion\.rangePin\.)/, 'pose'],
	[/^(objects?\.|character\.(set|add|remove|update|move)$|characters\.arrange$|cast\.replace$)/, 'object'],
	// The take's fields carry its prompt (motion.take.prompt).
	[/^motion\.set$/, 'prompt'],
];
const AGENT_WORK = new Set(['agent.turn.finish', 'task.finish']);
export function editKind(action, origin = 'ui') {
	// What the agent made (its turn, a task, or an edit it ran on its own) is undone as agent work.
	if (AGENT_WORK.has(action) || origin !== 'ui') return 'agent_turn';
	return KINDS.find(([pattern]) => pattern.test(String(action)))?.[1] ?? 'other';
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
		remember(recorded, { id, origin, action }) {
			// Session friction: an undo the user made (agent undos are the agent's own correction).
			if (id === 'edit.undo' && origin === 'ui' && recorded.status === 'undone') bump('undos');
			if (recorded.undo?.canUndoDirect && !id.startsWith('edit.')) {
				receipts.set(recorded.undo.historyEntryId, recorded);
				stamps.set(recorded.receiptId, { at: clock(), kind: editKind(action ?? id, origin) });
				while (stamps.size > STAMPS_KEPT) stamps.delete(stamps.keys().next().value);
			}
			for (const [key, receipt] of receipts) if (ports.isRetained?.(receipt) === false) { receipts.delete(key); stamps.delete(receipt.receiptId); }
		},
	};
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

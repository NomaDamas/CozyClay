// The single mutation owner for scene objects. All four producer classes —
// gizmo, plan board, inspector number scrubs, one-shot hierarchy/inspector
// atomics — mutate through this store so a drag becomes exactly ONE undo
// entry and can be cancelled. No React, node-importable (the test seam).
import {
	createHistory,
	pushHistory,
	undoHistory,
	redoHistory,
	canUndo as historyCanUndo,
	canRedo as historyCanRedo,
	createTransactions,
	beginTransaction,
	isCurrentTransaction,
	endTransaction,
	settleTransaction,
} from "./history.js";

// Invariant, stated once: whenever no transaction is open,
// `store.present()` is reference-equal to `store.objects`. `history` is
// assigned in exactly four places — applyAtomic, end(commit:true), settle,
// and undo/redo — and every one pushes or steps to the POST-change present.
export function createSceneHistoryStore(initialObjects, { onObjects, onCommit }) {
	let objects = initialObjects;
	let history = createHistory(initialObjects);
	const tx = createTransactions();
	let before = null;

	function emit(next) {
		objects = next;
		onObjects?.(next);
	}
	// A settle is triggered by the user starting something else; the
	// travel already applied is real and becomes its own entry, so the
	// very next Ctrl+Z discards it deliberately.
	function settle(notify = true) {
		if (settleTransaction(tx) === null) return;
		history = pushHistory(history, objects);
		if (notify) onCommit?.(before, objects);
		before = null;
	}
	return {
		get objects() {
			return objects;
		},

		// Public so the present === objects invariant is assertable from
		// Node and from QA without touching private state.
		present() {
			return history.present;
		},

		// Settle any open drag first, then apply one atomic mutation. A fn
		// that returns the same array creates no entry (coalescing).
		applyAtomic(fn) {
			settle();
			const next = fn(objects);
			if (next === objects) return;
			const previous = objects;
			emit(next);
			history = pushHistory(history, next);
			onCommit?.(previous, next);
		},

		// Settle first so a nested begin commits the previous drag as ONE
		// entry; history is not touched at begin.
		begin(owner, cancel) {
			settle();
			before = objects;
			return beginTransaction(tx, { owner, cancel });
		},

		// Stream applies land on the live array only while the token is the
		// current transaction; history is not touched here.
		applyIn(token, fn) {
			if (!isCurrentTransaction(tx, token)) return;
			const next = fn(objects);
			if (next === objects) return;
			emit(next);
		},

		end(token, { commit }) {
			if (!endTransaction(tx, token)) return false;
			if (commit) {
				// pushHistory coalesces: nothing applied pushes nothing.
				history = pushHistory(history, objects);
				onCommit?.(before, objects);
			} else {
				// Rollback restores the whole pre-drag array by reference —
				// strictly more correct than replaying one record.
				emit(before);
			}
			before = null;
			return true;
		},

		settle,

		undo() {
			settle(false);
			const stepped = undoHistory(history);
			if (stepped === null) return null;
			history = stepped;
			emit(stepped.present);
			return stepped.present;
		},

		redo() {
			settle(false);
			const stepped = redoHistory(history);
			if (stepped === null) return null;
			history = stepped;
			emit(stepped.present);
			return stepped.present;
		},

		canUndo() {
			return historyCanUndo(history);
		},

		canRedo() {
			return historyCanRedo(history);
		},

		depths() {
			return { past: history.past.length, future: history.future.length };
		},
	};
}

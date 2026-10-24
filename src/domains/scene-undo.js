import { ko } from "../locale.js";

// The Studio's Ctrl+Z / Ctrl+Shift+Z and Edit menu: one bus step each, with the reason when nothing moves.
export function createSceneUndo(appContext) {
	// `via`: the user's key, menu or button (edit:undone). The agent's undo_edit does not come through here.
	function undoScene(via) {
		// Through the bus (command-bus-telemetry.js): extracted App fixtures see only appContext here.
		const note = receipt => { try { appContext.bus.noteUndone?.(via, receipt); } catch { /* telemetry is advisory */ } };
		// An un-applied IK drag is a preview outside history: Ctrl+Z backs it out first.
		if (appContext.shared.motionDomain?.cancelPendingIkEdit?.()) {
			appContext.notify(ko("IK edit undone", "IK 수정을 되돌렸어요"));
			note(null);
			return { ok: true, status: 'done' };
		}
		const receipt = appContext.bus.run('edit.undo');
		note(receipt);
		// A refusal says why: the last edit belongs to a running task (parallel tasks), which its own card undoes.
		if (receipt.status === 'noop' || receipt.ok === false) appContext.notify(receipt.ok === false ? ko(receipt.message ?? "Undo was refused", `실행 취소 불가: ${receipt.message ?? ""}`) : ko("Nothing to undo", "실행 취소할 작업이 없어요"));
		return receipt;
	}
	function redoScene() {
		const receipt = appContext.bus.run('edit.redo');
		if (receipt.status === 'noop') appContext.notify(ko("Nothing to redo", "다시 실행할 작업이 없어요"));
		return receipt;
	}
	return { undoScene, redoScene };
}

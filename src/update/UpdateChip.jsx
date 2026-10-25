import { useCallback, useEffect, useRef, useState } from "react";
import { ko } from "../locale.js";
import { createUpdatePoller } from "./update-client.js";
import { noteNoticeShown, noteUpdateClicked, noteUpdatePolled } from "./update-telemetry.js";
import UpdateDialog from "./UpdateDialog.jsx";
import "./update.css";

// The update notice (U1): a quiet top-bar chip, never a toast and never a dialog
// that opens by itself. It renders nothing on a hosted page (the poller is a
// no-op without window.__COZYCLAY_RUNTIME__) and nothing until a poll says so.
function chipLabel(state) {
	const v = state.latest;
	switch (state.view) {
		case "updating": return ko("Updating…", "업데이트 중…", "正在更新…");
		case "restart_needed": return ko("Restart to finish", "다시 시작하면 끝나요", "重启以完成");
		case "failed": return ko("Update failed", "업데이트 실패", "更新失败");
		default: return ko(`Update ${v}`, `${v} 업데이트`, `更新到 ${v}`);
	}
}

export default function UpdateChip() {
	const [state, setState] = useState(null);
	const [open, setOpen] = useState(false);
	const poller = useRef(null);
	useEffect(() => {
		const instance = createUpdatePoller({
			onState: ({ state: next, info }) => {
				setState(next);
				noteNoticeShown(next);
				noteUpdatePolled(info);
			},
		});
		poller.current = instance;
		return () => { instance.stop(); if (poller.current === instance) poller.current = null; };
	}, []);
	const view = state?.view ?? "hidden";
	const close = useCallback(() => setOpen(false), []);
	const dismiss = useCallback((action) => {
		if (!state?.latest) return;
		noteUpdateClicked(action, state.kind);
		poller.current?.dismiss(state.latest);
		setOpen(false);
	}, [state]);
	const update = useCallback(() => {
		if (state) noteUpdateClicked("update_now", state.kind);
		void poller.current?.update();
	}, [state]);
	if (view === "hidden") return null;
	return (
		<span className="update-chip-wrap">
			<button
				type="button"
				className="update-chip"
				data-testid="update-chip"
				data-update-view={view}
				aria-haspopup="dialog"
				aria-expanded={open}
				onClick={() => setOpen((value) => !value)}
			>
				<i className="update-chip-dot" aria-hidden="true" />
				<span className="update-chip-text">{chipLabel(state)}</span>
			</button>
			{view === "available" && (
				<button
					type="button"
					className="update-chip-dismiss"
					data-testid="update-dismiss"
					aria-label={ko("Dismiss this version", "이 버전 알림 닫기", "忽略此版本")}
					title={ko("Dismiss this version", "이 버전 알림 닫기", "忽略此版本")}
					onClick={() => dismiss("dismiss")}
				>
					<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M6 6l12 12M18 6L6 18" /></svg>
				</button>
			)}
			{open && (
				<UpdateDialog
					state={state}
					onClose={close}
					onLater={() => dismiss("later")}
					onUpdate={update}
					onAction={(action) => noteUpdateClicked(action, state.kind)}
				/>
			)}
		</span>
	);
}

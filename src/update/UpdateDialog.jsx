import { useEffect, useId, useRef, useState, useSyncExternalStore } from "react";
import { createPortal } from "react-dom";
import { useStudioShell } from "../shell/studio-shell-context.js";
import { agentTurnRunning, subscribeAgentTurns } from "../workflow/agent-turn-telemetry.js";
import { ko } from "../locale.js";
import { updateBlocked } from "./update-client.js";

// The update dialog: the MenuDialog markup (src/shell/MenuBar.jsx) and its
// menubar-dialog-* classes, copied rather than shared (that file has no LOC room).
// Every string passes its Chinese text: interpolated strings never match the
// English-keyed ZH dictionary (src/locale.js).
const failureCopy = {
	permission: () => ko("npm can't write to its global folder. Copy the command and run it yourself, or fix the folder permissions.", "npm이 전역 폴더에 쓸 수 없어요. 명령을 복사해 직접 실행하거나 폴더 권한을 고치세요.", "npm 无法写入其全局文件夹。请复制命令自行运行，或修复文件夹权限。"),
	network: () => ko("Couldn't reach the npm registry. Check your connection and try again.", "npm 레지스트리에 연결하지 못했어요. 연결을 확인하고 다시 시도하세요.", "无法连接 npm 注册表。请检查网络连接后重试。"),
	node_version: () => ko("This version needs Node.js 22.19 or newer. Update Node, then run the command.", "이 버전은 Node.js 22.19 이상이 필요해요. Node를 업데이트한 뒤 명령을 실행하세요.", "此版本需要 Node.js 22.19 或更高版本。请先更新 Node，再运行该命令。"),
	npm_missing: () => ko("npm isn't on your PATH. Copy the command and run it in a terminal that has npm.", "PATH에서 npm을 찾을 수 없어요. npm이 있는 터미널에서 명령을 실행하세요.", "PATH 中找不到 npm。请复制命令，在装有 npm 的终端中运行。"),
	other: () => ko("The update didn't finish. Copy the command and run it in a terminal.", "업데이트가 끝나지 않았어요. 명령을 복사해 터미널에서 실행하세요.", "更新未完成。请复制命令并在终端中运行。"),
};

function titleOf(state) {
	const v = state.latest;
	if (state.view === "updating") return ko("Updating…", "업데이트 중…", "正在更新…");
	if (state.view === "restart_needed") return ko("Restart to finish", "다시 시작하면 끝나요", "重启以完成");
	if (state.view === "failed") return ko("Update failed", "업데이트 실패", "更新失败");
	return ko(`CozyClay ${v} is available`, `CozyClay ${v} 버전이 나왔어요`, `CozyClay ${v} 已发布`);
}

function bodyOf(state) {
	const v = state.latest;
	if (state.view === "updating") return ko(`Installing ${v}. This takes about a minute.`, `${v} 설치 중이에요. 1분쯤 걸려요.`, `正在安装 ${v}，大约需要一分钟。`);
	if (state.view === "restart_needed") {
		return ko(`Updated to ${v}. Quit CozyClay in the terminal (Ctrl+C), then run \`cclay\` again.`,
			`${v} 설치 완료. 터미널에서 CozyClay를 종료(Ctrl+C)하고 \`cclay\`를 다시 실행하세요.`,
			`已更新到 ${v}。请在终端中退出 CozyClay（Ctrl+C），然后重新运行 \`cclay\`。`);
	}
	if (state.view === "failed") return (failureCopy[state.errorClass] ?? failureCopy.other)();
	if (state.kind === "npx") {
		return ko("Quit CozyClay in the terminal and run `npx cozyclay` again. npx fetches the newest version each time (internet needed).",
			"터미널에서 CozyClay를 종료하고 `npx cozyclay`를 다시 실행하세요. npx가 매번 최신 버전을 받아요 (인터넷 필요).",
			"请在终端中退出 CozyClay，然后重新运行 `npx cozyclay`。npx 每次都会获取最新版本（需要联网）。");
	}
	return null;
}

/** navigator.clipboard, else a hidden textarea and execCommand("copy"). Resolves true when copied. */
async function copyText(text) {
	try {
		await navigator.clipboard.writeText(text);
		return true;
	} catch {
		try {
			const area = document.createElement("textarea");
			area.value = text;
			area.setAttribute("readonly", "");
			area.style.position = "fixed";
			area.style.opacity = "0";
			document.body.appendChild(area);
			area.select();
			const ok = document.execCommand("copy");
			area.remove();
			return ok;
		} catch {
			return false;
		}
	}
}

export default function UpdateDialog({ state, onClose, onLater, onUpdate, onAction }) {
	const closeRef = useRef(null);
	const titleId = useId();
	// "Copied" belongs to the view it was pressed in: a later phase shows its own command afresh.
	const [copiedView, setCopiedView] = useState(null);
	const copied = copiedView === state.view;
	const { exportStatus, recState } = useStudioShell();
	const agentRunning = useSyncExternalStore(subscribeAgentTurns, agentTurnRunning, () => false);
	const blocked = updateBlocked({ agentRunning, exportStatus, recState });
	useEffect(() => {
		closeRef.current?.focus();
		const onKey = (event) => {
			if (event.key !== "Escape") return;
			event.preventDefault();
			onClose();
		};
		document.addEventListener("keydown", onKey);
		return () => document.removeEventListener("keydown", onKey);
	}, [onClose]);
	const copy = async () => {
		onAction("copy_command");
		const view = state.view;
		setCopiedView((await copyText(state.command)) ? view : null);
	};
	const startsInstall = state.actions.includes("update_now") || state.actions.includes("retry");
	const body = bodyOf(state);
	return createPortal(
		<div className="menubar-dialog-backdrop" onPointerDown={(event) => { if (event.target === event.currentTarget) onClose(); }}>
			<div className="menubar-dialog update-dialog" role="dialog" aria-modal="true" aria-labelledby={titleId} data-dialog="update" data-testid="update-dialog" data-update-view={state.view}>
				<header className="menubar-dialog-head">
					<h2 id={titleId}>{titleOf(state)}</h2>
					<button type="button" ref={closeRef} className="menubar-dialog-close" aria-label={ko("Close", "닫기", "关闭")} onClick={onClose}>
						<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M6 6l12 12M18 6L6 18" /></svg>
					</button>
				</header>
				<div className="menubar-dialog-body">
					{state.view === "available" && state.current && (
						<p className="menubar-dialog-meta">{ko(`You have ${state.current}.`, `지금은 ${state.current} 버전이에요.`, `当前版本为 ${state.current}。`)}</p>
					)}
					{body && <p className="update-dialog-text">{body}</p>}
					{state.actions.includes("copy_command") && <code className="update-dialog-command">{state.command}</code>}
					{state.view === "available" && state.notesUrl && (
						<p>
							<a className="update-dialog-notes" data-testid="update-notes" href={state.notesUrl} target="_blank" rel="noopener noreferrer" onClick={() => onAction("release_notes")}>
								{ko("What's new", "바뀐 내용 보기", "更新内容")}
							</a>
						</p>
					)}
					{startsInstall && blocked && (
						<p className="update-dialog-busy" data-testid="update-busy">{ko("Finish the current turn or export first.", "진행 중인 턴이나 내보내기를 먼저 마치세요.", "请先完成当前的回合或导出。")}</p>
					)}
					<div className="update-dialog-actions">
						{state.actions.includes("update_now") && (
							<button type="button" className="update-dialog-primary" data-testid="update-now" disabled={blocked} onClick={onUpdate}>
								{ko("Update now", "지금 업데이트", "立即更新")}
							</button>
						)}
						{state.actions.includes("retry") && (
							<button type="button" className="update-dialog-primary" data-testid="update-retry" disabled={blocked} onClick={onUpdate}>
								{ko("Try again", "다시 시도", "重试")}
							</button>
						)}
						{state.actions.includes("copy_command") && (
							<button type="button" data-testid="update-copy" data-copied={copied || undefined} onClick={() => void copy()}>
								{copied ? ko("Copied", "복사했어요", "已复制") : ko("Copy command", "명령 복사", "复制命令")}
							</button>
						)}
						{state.actions.includes("later") && (
							<button type="button" data-testid="update-later" onClick={onLater}>{ko("Later", "나중에", "稍后")}</button>
						)}
						{state.view === "restart_needed" && (
							<button type="button" onClick={onClose}>{ko("Close", "닫기", "关闭")}</button>
						)}
					</div>
				</div>
			</div>
		</div>,
		document.body,
	);
}

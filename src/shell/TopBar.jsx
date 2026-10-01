import { useRef, useState } from "react";
import { useStudioShell } from "./studio-shell-context.js";
import ProjectPanel from "../panels/ProjectPanel.jsx";
import MenuBar, { MenuPopover } from "./MenuBar.jsx";
import { SaveState } from "./StatusBar.jsx";
import { ko, isKo } from "../locale.js";
import "./topbar.css";

// 2a top bar: File/Edit/Window/Help, then only the MCP state and the one
// primary action. Save and Export live in File (G7). #570: the project name
// and its save state head the left column (ProjectHead below).
export default function TopBar({ preferences }) {
	const { recState, liveHubStatus, liveWorkspaceHandle } = useStudioShell();
	const connected = liveHubStatus === "connected";
	return (
		<header className="topbar v2-topbar" data-rec-state={recState}>
			<MenuBar preferences={preferences} />
			<div className="topbar-spacer" />
			<span
				className={"topbar-mcp" + (liveWorkspaceHandle ? " live-workspace-handle" : "")}
				data-state={connected ? "connected" : "disconnected"}
				data-live-workspace={liveWorkspaceHandle || undefined}
				title={liveWorkspaceHandle || ko("No MCP client is attached to this studio", "이 스튜디오에 연결된 MCP 클라이언트가 없어요")}
			>
				<i className="topbar-mcp-dot" aria-hidden="true" />
				<span className="topbar-mcp-text">{connected ? ko("MCP connected", "MCP 연결됨") : ko("MCP offline", "MCP 꺼짐")}</span>
			</span>
			<GenerateMotion />
		</header>
	);
}

// #570: the project heads the left column — its name opens the project menu,
// the line under it is the save state.
export function ProjectHead() {
	const {
		projectMenuOpen, setProjectMenuOpen, projectDirty, projectName, projectStartupOpen,
		projectManifest, saveStatus,
	} = useStudioShell();
	return (
		<div className="topbar-project studio-project-head">
			<ProjectPanel
				projectMenuOpen={projectMenuOpen}
				setProjectMenuOpen={setProjectMenuOpen}
				projectDirty={projectDirty}
				projectName={projectName}
				projectStartupOpen={projectStartupOpen}
				projectManifest={projectManifest}
			/>
			<SaveState status={saveStatus} />
		</div>
	);
}

// "Generate Motion" is today's Scene generate (G6) and the one home for
// generation (IS-2): with authored prompt blocks it runs them all, as the
// removed Details "Generate all blocks" did; otherwise it runs the prompt.
// The caret holds the take bar's Scene actions; a refused action says why in
// place and in a toast (R3).
function GenerateMotion() {
	const {
		runArdy, sceneGenerateDisabledReason, sceneAgainDisabledReason, runSceneAgain,
		addSceneBlock, tlFrame, setToast, ardyRunning, promptClips, runStudioAction,
	} = useStudioShell();
	const hasBlocks = promptClips.some((clip) => clip.text.trim());
	const [open, setOpen] = useState(false);
	const caretRef = useRef(null);
	const reason = sceneGenerateDisabledReason();
	const actions = [
		{ id: "new", label: ko("Start over", "새로 만들기"), reason, run: () => runArdy({ fresh: true }) },
		{ id: "again", label: ko("Take it again", "다시 뽑기"), reason: sceneAgainDisabledReason(), run: runSceneAgain },
		{ id: "block", label: isKo ? `프레임 ${tlFrame}에 블록 추가` : `Add block at frame ${tlFrame}`, reason: "", run: addSceneBlock },
	];
	return (
		<div className="topbar-generate" role="group" aria-label={ko("Generate Motion", "모션 생성")}>
			<button
				type="button"
				className="topbar-generate-main"
				data-testid="topbar-generate"
				aria-disabled={reason ? "true" : undefined}
				data-disabled-reason={reason || undefined}
				title={reason || ko("Generate motion from the prompt and blocks", "프롬프트와 블록으로 모션을 생성합니다")}
				onClick={() => (reason ? setToast(reason) : hasBlocks ? runStudioAction("motion.generateAllBlocks") : runArdy())}
			>
				{ardyRunning ? ko("Generating…", "생성 중…") : (
					<>
						<span className="topbar-generate-full">{ko("Generate Motion", "모션 생성")}</span>
						<span className="topbar-generate-short">{ko("Generate", "생성")}</span>
					</>
				)}
			</button>
			<button
				type="button"
				className="topbar-generate-caret"
				data-testid="topbar-generate-menu"
				ref={caretRef}
				aria-haspopup="menu"
				aria-expanded={open}
				aria-label={ko("More generate actions", "생성 작업 더 보기")}
				onClick={() => setOpen((value) => !value)}
			>
				<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M6 9l6 6 6-6" /></svg>
			</button>
			{open && (
				<MenuPopover anchorRef={caretRef} align="end" onClose={() => setOpen(false)} label={ko("Generate actions", "생성 작업")}>
					{actions.map((action) => (
						<button
							type="button"
							role="menuitem"
							key={action.id}
							className="menubar-item"
							data-generate-action={action.id}
							aria-disabled={action.reason ? "true" : undefined}
							data-disabled-reason={action.reason || undefined}
							onClick={() => {
								setOpen(false);
								if (action.reason) setToast(action.reason);
								else action.run();
							}}
						>
							<span className="menubar-item-label">{action.label}</span>
							{action.reason && <small className="menubar-item-reason">{action.reason}</small>}
						</button>
					))}
				</MenuPopover>
			)}
		</div>
	);
}

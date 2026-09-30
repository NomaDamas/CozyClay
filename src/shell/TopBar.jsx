import { useStudioShell } from "./studio-shell-context.js";
import ProjectPanel from "../panels/ProjectPanel.jsx";
import { ko } from "../locale.js";

export default function TopBar({ preferences }) {
	const {
		projectMenuOpen, setProjectMenuOpen, projectDirty, projectName, projectStartupOpen,
		requestNewProject, setProjectStartupOpen, setProjectBrowserOpen, runStudioAction, saveProject,
		projectManifest, projectSaveState, recState, exportMenuTriggerRef, exportMenuOpen,
		exportShotIdRef, setExportMenuAnchor, setExportMenuOpen, exportStatus, exportPhaseLabel,
		exportMenuAnchor, resultOpen, exportFeedback, shots, exportKeyframePacks,
		hasCameraKeys, motion, exportRenderPasses, exportDepthVideo, exportStoryboard,
		downloadOtioCutList, projectStatus, liveWorkspaceHandle,
	} = useStudioShell();
	return (
		<header className="topbar">
			<div className="logo">
				<span className="wordmark">
					Cozy <span>Clay</span>
				</span>
			</div>
			<ProjectPanel
				projectMenuOpen={projectMenuOpen}
				setProjectMenuOpen={setProjectMenuOpen}
				projectDirty={projectDirty}
				projectName={projectName}
				projectStartupOpen={projectStartupOpen}
				requestNewProject={requestNewProject}
				setProjectStartupOpen={setProjectStartupOpen}
				setProjectBrowserOpen={setProjectBrowserOpen}
				runStudioAction={runStudioAction}
				saveProject={saveProject}
				projectManifest={projectManifest}
			/>
			<div className="topbar-actions">
				<a className="topbar-action workflow-topbar-link" href="/workflow/" aria-label={ko("Open Workflow", "워크플로 열기")}>{ko("Workflow", "워크플로우")}</a>
				<div className="project-actions" aria-label={ko("Project actions", "프로젝트 작업")}>
					<button
						type="button"
						className="topbar-action project-save-action"
						data-testid="topbar-save"
						disabled={projectSaveState === "saving"}
						onClick={() => void runStudioAction("project.save")}
					>
						{projectSaveState === "saving" ? ko("Saving…", "저장 중…") : ko("Save", "저장")}
					</button>
					{/* One Export menu for every delivery this studio makes (#193,
					    R4). The keyframe pack leads because it is the pack an AI video
					    tool is fed; items whose precondition is missing are not
					    rendered disabled — the footer line says what to author first. */}
					{/* One element cannot carry two data-testids: the topbar contract
					    keeps the attribute, the menu contract gets the same handle as an
					    id, so both selectors still reach this one trigger. */}
					<div className="export-menu-wrap">
						<button
							type="button"
							className={"topbar-action project-export-action" + (recState === "recording" ? " recording" : "")}
							data-testid="topbar-export"
							id="export-menu-trigger"
							ref={exportMenuTriggerRef}
							aria-expanded={exportMenuOpen}
							aria-haspopup="menu"
							title={ko("Exports: keyframe pack, video, passes, storyboard, cut list", "내보내기: 키프레임 팩·영상·패스·스토리보드·컷 목록")}
							onClick={(event) => {
								exportShotIdRef.current = null;
								// The panel is fixed to the viewport and anchored to this
								// trigger in JS, the way it was in the PlayView bar: one
								// popover geometry for the studio's export menu wherever
								// its trigger lives.
								const box = event.currentTarget.getBoundingClientRect();
								const menuWidth = Math.min(340, window.innerWidth - 16);
								setExportMenuAnchor({
									top: box.bottom + 6,
									right: Math.min(Math.max(8, window.innerWidth - box.right), Math.max(8, window.innerWidth - menuWidth - 8)),
								});
								setExportMenuOpen((open) => !open);
							}}
						>
							{ko("Export", "내보내기")}
							{exportStatus && <span className="export-trigger-state" data-phase={exportStatus.phase}>{exportPhaseLabel(exportStatus.phase)}</span>}
							<span className="caret">▾</span>
						</button>
						{exportMenuOpen && (
							<div
								className="project-menu export-menu"
								role="menu"
								style={{ top: `${exportMenuAnchor.top}px`, right: `${exportMenuAnchor.right}px` }}
							>
								{!(resultOpen && exportStatus?.kind === "frame") && exportFeedback()}
								<button
									type="button"
									role="menuitem"
									className="export-menu-primary"
									data-testid="export-keyframe-pack"
									disabled={!shots.length || recState === "recording"}
									data-disabled-reason={shots.length ? undefined : "no-shots"}
									title={shots.length
										? ko("First/last frames, clip, camera and prompt as one zip — hold Shift for every shot", "첫/마지막 프레임·클립·카메라·프롬프트를 zip 하나로 — Shift를 누르면 모든 샷")
										: ko("Add a shot first — a pack describes one cut", "샷을 먼저 추가하세요 — 팩은 컷 하나를 설명합니다")}
									onClick={(event) => void exportKeyframePacks(event.shiftKey, exportShotIdRef.current)}
								>
									{ko("Keyframe pack (zip)", "키프레임 팩 (zip)")}
									<small>{ko("Shift: every shot", "Shift: 모든 샷")}</small>
								</button>
								{(shots.length > 0 || hasCameraKeys || motion) && (
									<button
										type="button"
										role="menuitem"
										data-testid="export-video"
										disabled={recState === "recording"}
										title={ko("Render the shot to an MP4 — camera move and character motion, no editor chrome", "샷을 MP4로 렌더링합니다 — 카메라 움직임과 캐릭터 모션만, 편집 UI는 제외")}
										onClick={() => void runStudioAction("export.shotVideo", exportShotIdRef.current ? { shotId: exportShotIdRef.current } : {})}
									>
										{ko("Video (mp4)", "영상 (mp4)")}
									</button>
								)}
								<button
									type="button"
									role="menuitem"
									data-testid="export-render-passes"
									disabled={recState === "recording"}
									title={ko("Depth and normal conditioning plates of the current framing", "현재 프레이밍의 뎁스·노멀 컨디션 플레이트")}
									onClick={exportRenderPasses}
								>
									{ko("Depth + normal passes", "뎁스 + 노멀 패스")}
								</button>
								<button
									type="button"
									role="menuitem"
									data-testid="export-depth-video"
									disabled={!shots.length || recState === "recording"}
									data-disabled-reason={shots.length ? undefined : "no-shots"}
									title={ko("Depth pass of the whole shot as an mp4 for video-model conditioning", "샷 전체의 뎁스 패스를 mp4로 — 영상 모델 컨디셔닝용")}
									onClick={() => void exportDepthVideo(exportShotIdRef.current)}
								>
									{ko("Depth (mp4)", "뎁스 (mp4)")}
								</button>
								<button
									type="button"
									role="menuitem"
									data-testid="export-storyboard"
									disabled={!shots.length || recState === "recording"}
									data-disabled-reason={shots.length ? undefined : "no-shots"}
									title={shots.length
										? ko("Contact sheet of every shot with its prompt", "모든 샷과 프롬프트를 담은 콘택트 시트")
										: ko("Add a shot first — a storyboard is one row per shot", "샷을 먼저 추가하세요 — 스토리보드는 샷마다 한 줄입니다")}
									onClick={() => void exportStoryboard()}
								>
									{ko("Storyboard (PNG)", "스토리보드 (PNG)")}
								</button>
								{shots.length > 0 && (
									<button
										type="button"
										role="menuitem"
										data-testid="export-otio"
										title={ko("Download OTIO cut list", "OTIO 컷 목록 다운로드")}
										onClick={downloadOtioCutList}
									>
										{ko("OTIO cut list", "OTIO 컷 목록")}
									</button>
								)}
								{!shots.length && (
									<p className="export-menu-hint">
										{hasCameraKeys || motion
											? ko("Add a shot to export OTIO", "OTIO를 내보내려면 샷을 추가하세요")
											: ko("Add a shot to export video or OTIO", "영상·OTIO를 내보내려면 샷을 추가하세요")}
									</p>
								)}
							</div>
						)}
					</div>
					<span
						className={"project-save-status status-" + projectSaveState}
						data-testid="project-save-status"
						role="status"
						aria-live="polite"
					>
						{projectStatus}
					</span>
				</div>
				{liveWorkspaceHandle && (
					<span className="live-workspace-handle" data-live-workspace={liveWorkspaceHandle} title={liveWorkspaceHandle}>
						{ko("Live workspace", "라이브 작업공간")} {liveWorkspaceHandle}
					</span>
				)}
				{preferences}
			</div>
		</header>
	);
}

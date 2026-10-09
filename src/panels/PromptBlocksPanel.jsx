import { useState } from "react";
import Foldout from "./Foldout.jsx";
import { ko, isKo } from "../locale.js";
import { Field, Dropdown } from "../ui.jsx";
import { LINE_EDIT_TRACK_OPTIONS, MIN_CURVE_POINTS, lineTrackLabel } from "../app-stage.jsx";
import { LINE_EDIT_PINS_MAX, DRAG_RADIUS_MIN, DRAG_RADIUS_MAX, MAX_LINE_POINTS, PINNED_CURVE_ENDS } from "../line-edit.js";
import { motionReadinessMessage, MotionReadiness } from "../motion-readiness-ui.jsx";
import { useCastTransaction } from '../domains/cast.js';
import { useMotionCommands } from '../domains/motion.js';
import { useStudioShell } from '../shell/studio-shell-context.js';
import "./motion.css";

export default function PromptBlocksPanel({
	isCharacterSelection, promptBlocksReveal, promptClips, selectedPromptId, setSelectedPromptId,
	setArdyPrompt, setTlFrame, tlFrameCount, ardySeed, changeArdySeed, motion, lineEditMode,
	toggleLineEditMode, linePreviewUrl, lineCurve, lineDrifted, lineTrack, setLineTrack, linePinMode,
	setLinePinMode, linePins, lineClipFrames, lineEditRange, setLineRange, lineRadius, changeLineRadius,
	lineCurveDirty, lineEditFrom, lineEditTo, lineCurvePointCount, lineDriftHint, lineCurveHidden,
	linePreviewBusy, linePreviewMs, linePreviewError, generationBusy, bridgeChecking, bridge,
	lineReadinessState, runLineEdit, openMotionSetup, recheckMotionHealth, resetLineCurve, exitLineEditMode,
	readinessState, ardyRunning, cancelArdy, ardyStatus, ardyOutcome,
}) {
	const { run, begin, commit, characterId } = useCastTransaction();
	const { refineDisabledReason, workflowMode, previsMode } = useStudioShell();
	const selectedClip = promptClips.find((clip) => clip.id === selectedPromptId) ?? null;
	const refineReason = refineDisabledReason();
	// A storyboard has no prompt blocks to author or edit.
	if (previsMode === "storyboard") return null;
	// Generate, Start over, Take it again and Add block live in the top bar's
	// Generate Motion button and its caret menu, their one home (R1).
	return (
<>
<Foldout hidden={!isCharacterSelection} defaultOpen={false} openSignal={promptBlocksReveal} title={ko("Prompt Blocks", "프롬프트 블록")}>
					<p className="inspector-hint">{ko("Blocks define what is generated over each frame range. Selecting one also moves editing context to that prompt.", "블록은 각 프레임 범위에서 생성될 내용을 정합니다. 블록을 선택하면 편집 기준도 해당 프롬프트로 이동합니다.")}</p>
						<div className="inspector-list">
							{promptClips.map((clip) => (
								<button
									type="button"
									key={clip.id}
									className={selectedPromptId === clip.id ? "active" : ""}
									onClick={() => {
										setSelectedPromptId(clip.id);
										setArdyPrompt(clip.text);
										setTlFrame(Math.min(clip.startFrame, tlFrameCount - 1));
									}}
								>
								<span>{clip.text || ko("Untitled motion", "이름 없는 모션")}</span>
									<small>{clip.startFrame}–{clip.endFrame}f</small>
								</button>
							))}
						</div>
						{selectedClip && (
							<Field label={ko("Range", "구간")}>
								<span className="motion-block-range" data-block-range={`${selectedClip.startFrame}-${selectedClip.endFrame}`}>
									{selectedClip.startFrame}–{selectedClip.endFrame} f
								</span>
							</Field>
						)}
						{selectedPromptId && (
						<Field label={ko("Prompt", "프롬프트")}>
								<input
									type="text"
									value={promptClips.find((clip) => clip.id === selectedPromptId)?.text ?? ""}
									onBlur={commit}
									onChange={(event) => {
										begin();
										run('character.changePromptBlock', { characterId, id: selectedPromptId, text: event.target.value });
										setArdyPrompt(event.target.value);
									}}
								placeholder={ko("describe this motion block", "이 모션 블록을 설명하세요")}
								/>
							</Field>
						)}
						{/* The seed belongs with the button that consumes it. Duration does
						    not appear at all: the blocks' own frame ranges are the length. */}
						<Field label={ko("Seed", "시드")}>
							<input
								type="text"
								inputMode="numeric"
								value={ardySeed}
								onChange={(e) => changeArdySeed(e.target.value)}
								placeholder={ko("empty = random", "비우면 랜덤")}
							/>
						</Field>
						{/* Scheduled inpainting used to live here, beside the batch button.
						    It now folds into Scene > Advanced above the timeline (contract
						    C12): it is a dial on a regeneration, so it belongs with the
						    regeneration entry rather than with the block list. */}
						{/* Line editing (contract C6). It sits beside the preserve slider
						    because it answers the same question from the other side —
						    preserve says how much of the take to KEEP, a line says exactly
						    where one joint must GO — and because both need a take with a
						    bridge source, so the whole section is absent until there is one
						    rather than present and inert. */}
						{motion?.url && (
							<Field label={ko("Line editing", "라인 편집")}>
								{/* Refine: the take bar's second entry, until it becomes motion tool E. */}
								<button
									type="button"
									className={"btn full" + (lineEditMode ? " primary" : "")}
									data-take-mode="refine"
									data-disabled-reason={refineReason || undefined}
									aria-pressed={lineEditMode}
									title={ko(
										"The joint's own path is drawn on the viewport — grab a point on it and pull, or draw a new path on empty space; the joint then follows it exactly. The view still orbits normally (Alt+drag).",
										"관절이 지나가는 궤적이 뷰포트에 그려집니다 — 궤적 위의 점을 잡아 끌거나, 빈 곳에 새 궤적을 그리면 관절이 그 경로를 정확히 따라갑니다. 시점은 평소처럼 돌릴 수 있어요 (Alt+드래그).",
									)}
									onClick={toggleLineEditMode}
								>
									{lineEditMode ? ko("Path editing on", "궤적 편집 켜짐") : ko("Drag the path", "궤적을 잡아 끌기")}
								</button>
								{lineEditMode && (
									<div
										className="line-edit-panel"
										data-line-preview={linePreviewUrl ? "true" : undefined}
										// "The line is detached from this view" — the panel's own copy of
										// what the stage already carries, so a test (or a screenshot) can
										// read the state from whichever of the two it is looking at.
										data-line-drift={lineCurve && lineDrifted ? "true" : undefined}
									>
										<Field label={ko("Joint", "관절")}>
											<Dropdown
												value={lineTrack}
												options={LINE_EDIT_TRACK_OPTIONS}
												onChange={setLineTrack}
												ariaLabel={ko("Joint whose path is edited", "궤적을 편집할 관절")}
											/>
										</Field>
										{/* THE GESTURE SELECTOR. Pressing on the joint is how BOTH a
										    curve drag and a pin start, so the two cannot share a
										    press and a modal toggle is the honest way to say which
										    one the next press means. Named for what it does at the
										    moment it does it, not for the wire field. */}
										<button
											type="button"
											className={"btn full" + (linePinMode ? " primary" : "")}
											data-line-pin-mode={linePinMode ? "true" : "false"}
											onClick={() => setLinePinMode((on) => !on)}
										>
											{linePinMode
												? ko("Pinning moments", "순간 찍는 중")
												: ko("Pin a moment", "순간 찍기")}
										</button>
										{linePinMode && (
											<p className="inspector-hint">
												{linePins.length
													? (isKo
														? `${linePins.length}개(최대 ${LINE_EDIT_PINS_MAX}개)를 찍었어요 — 프레임 ${linePins.map((pin) => pin.frame).join(", ")}. 사이 동작은 모델이 채웁니다`
														: `${linePins.length} pinned (max ${LINE_EDIT_PINS_MAX}) — frames ${linePins.map((pin) => pin.frame).join(", ")}. The model fills the movement between them`)
													: ko(
														"Scrub to a moment, then drag the green handle to where the joint should be. The take keeps its own timing; only that instant is pinned.",
														"원하는 순간으로 재생 위치를 옮긴 뒤, 초록 손잡이를 관절이 있어야 할 자리로 끌어 주세요. 그 순간만 고정되고 나머지 타이밍은 그대로예요.",
													)}
											</p>
										)}
										{/* No range picker exists elsewhere in the app that a line
										    edit could borrow, so the whole clip is the default and
										    these two numbers only ever NARROW it. endFrame is
										    exclusive, like every other half-open range on this wire. */}
										<Field label={ko("Frame range", "프레임 구간")}>
											<div className="line-edit-range-row">
												<input
													type="number"
													min={0}
													max={Math.max(0, lineClipFrames - 2)}
													value={lineEditRange?.startFrame ?? 0}
													onChange={(event) => setLineRange((current) => ({
														startFrame: Math.round(Number(event.target.value)) || 0,
														endFrame: current?.endFrame ?? lineClipFrames,
													}))}
												/>
												<span aria-hidden="true">–</span>
												<input
													type="number"
													min={2}
													max={lineClipFrames}
													value={lineEditRange?.endFrame ?? lineClipFrames}
													onChange={(event) => setLineRange((current) => ({
														startFrame: current?.startFrame ?? 0,
														endFrame: Math.round(Number(event.target.value)) || 0,
													}))}
												/>
											</div>
										</Field>
										{/* How far a pull carries along the path, in FRAMES — the
										    sigma of the Gaussian falloff, said in the unit the user
										    is looking at. Narrow is a beat, wide is a whole gesture. */}
										<Field label={ko("Influence", "영향 범위")}>
											<div className="line-edit-radius-row">
												<input
													type="range"
													min={DRAG_RADIUS_MIN}
													max={DRAG_RADIUS_MAX}
													step={1}
													value={lineRadius}
													aria-label={ko("How many frames a pull carries along the path", "잡아당길 때 궤적을 따라 함께 움직이는 프레임 수")}
													onChange={(event) => changeLineRadius(event.target.value)}
												/>
												<span className="line-edit-radius-value">
													{isKo ? `${lineRadius}프레임` : `${lineRadius} frames`}
												</span>
											</div>
										</Field>
										<p className="inspector-hint">
											{lineCurveDirty
												? (isKo
													? `${lineEditFrom}–${lineEditTo} 프레임을 편집했어요 — ${lineCurvePointCount}개 점(최대 ${MAX_LINE_POINTS}개)을 보내고, 양 끝은 원래 궤적에서 부드럽게 이어져 이음매가 튀지 않아요. 다시 끌거나 다시 그려서 다듬을 수 있어요`
													: `Frames ${lineEditFrom}–${lineEditTo} edited — ${lineCurvePointCount} points (max ${MAX_LINE_POINTS}); both ends ease out of the original path, so the seams do not pop. Pull it again, or draw over it, to refine`)
												: ko(
													"Draw along the path to reroute that section — the frames you drew over become the range, and the take's own timing is kept. Or grab a yellow dot and pull.",
													"궤적을 따라 그리면 그 구간만 새로 지나갑니다 — 그린 만큼이 편집 구간이 되고, 원래 속도감은 그대로 유지돼요. 노란 점을 잡아 끌어도 됩니다.",
												)}
										</p>
										{/* The one thing users assume a modal viewport tool takes away.
										    Said out loud, because "can I still orbit?" is the first
										    question and the answer decides whether the mode is usable. */}
										{/* THE DETACHED STATE. Said inline, next to the edit it is about,
										    and in the same words the refused gesture answers with. It is
										    a status, not a warning: nothing was lost and nothing needs
										    doing — the only thing that changed is that the line cannot be
										    drawn in a view it was not aimed through. */}
										{lineCurve && lineDrifted && (
											<p className="inspector-hint line-edit-drift" aria-live="polite">
												{lineDriftHint()}
											</p>
										)}
										<p className="inspector-hint">
											{lineCurveDirty
												? ko(
													"You can still orbit (Alt+drag), pan and fly freely — the edit survives it. It was aimed through one lens, so while the view is elsewhere the line is drawn ghosted and a new pull waits; Generate, undo and Reset work from anywhere.",
													"시점은 자유롭게 돌리고(Alt+드래그) 옮길 수 있어요 — 편집은 그대로 남습니다. 다만 이 궤적은 처음 시점 기준이라, 시점을 옮기면 흐리게만 보이고 새로 끌기는 잠시 멈춰요. 생성·되돌리기·원래대로는 언제든 됩니다.",
												)
												: ko(
													"You can still orbit (Alt+drag), pan and fly freely; the path follows the view until you pull or draw it.",
													"시점은 평소처럼 자유롭게 돌리고(Alt+드래그) 옮길 수 있어요. 끌거나 그리기 전까지 궤적은 시점을 따라갑니다.",
												)}
										</p>
										{lineEditRange && lineEditRange.endFrame - lineEditRange.startFrame < MIN_CURVE_POINTS && (
											<p className="inspector-hint">
												{isKo
													? `구간이 너무 짧아요 — 양 끝 ${PINNED_CURVE_ENDS}프레임씩이 고정이라 ${MIN_CURVE_POINTS}프레임 이상이어야 잡을 점이 생겨요`
													: `This range is too short — with ${PINNED_CURVE_ENDS} pinned frames at each end it needs at least ${MIN_CURVE_POINTS} frames before anything can be grabbed`}
											</p>
										)}
										{lineCurveHidden > 0 && (
											<p className="inspector-hint">
												{isKo
													? `${lineCurveHidden}프레임이 화면 밖이라 잡을 수 없어요 — 구간 전체가 보이도록 카메라를 잡아 주세요`
													: `${lineCurveHidden} frame(s) are outside the frame and cannot be grabbed — frame the whole range in view`}
											</p>
										)}
										{/* ------------------------- the preview line -------------------
										    One quiet row that says which of three things is true: a
										    draft is being made, a draft is on screen (and how long it
										    took), or the last one failed and the curve is still here.
										    Deliberately not a spinner over the viewport — the artist
										    is LOOKING at the viewport, and the answer arrives there. */}
										{linePreviewBusy && (
											<p className="inspector-hint line-preview-busy" aria-live="polite">
												{ko("Previewing the pull…", "당긴 결과 미리보는 중…")}
											</p>
										)}
										{!linePreviewBusy && linePreviewUrl && (
											<p className="inspector-hint line-preview-live">
												{ko(
													"The viewport is showing this edit at full quality — press Generate to keep it as the take.",
													"뷰포트가 지금 이 편집의 최종 품질 결과예요 — 아래 생성을 누르면 테이크로 확정됩니다.",
												)}
												{linePreviewMs > 0 && (
													<span className="line-preview-time">
														{isKo ? ` 미리보기 ${(linePreviewMs / 1000).toFixed(1)}s` : ` preview ${(linePreviewMs / 1000).toFixed(1)}s`}
													</span>
												)}
											</p>
										)}
										{/* A failed draft is not a failed edit: the pull survives it and
										    the button below still runs the real thing. */}
										{linePreviewError && (
											<p className="inspector-hint line-preview-error">
												{isKo ? `미리보기 실패 — ${linePreviewError} (생성은 그대로 됩니다)` : `Preview failed — ${linePreviewError} (Generate still works)`}
											</p>
										)}
										<button
											type="button"
											className="btn primary full generate"
											disabled={!lineCurveDirty || generationBusy || bridgeChecking || bridge === null}
											title={generationBusy ? ko("A generation is already running", "이미 생성이 돌고 있어요")
												: !lineCurveDirty
													? ko("Pull the path on the viewport first", "먼저 뷰포트에서 궤적을 잡아당겨 주세요")
													: motionReadinessMessage(lineReadinessState)}
											onClick={runLineEdit}
										>
											{ko("Generate the line edit", "라인 편집 생성")}
										</button>
										<MotionReadiness state={lineReadinessState} checking={bridgeChecking} onSetup={() => openMotionSetup("line")} onRetry={recheckMotionHealth} />
										<button type="button" className="btn ghost full" disabled={!lineCurveDirty} onClick={resetLineCurve}>
											{ko("Reset the curve", "원래대로")}
										</button>
										<button type="button" className="btn ghost full" onClick={exitLineEditMode}>
											{ko("Exit line editing (Esc)", "라인 편집 끝내기 (Esc)")}
										</button>
									</div>
								)}
							</Field>
						)}
						{ardyRunning && (
							<button type="button" className="btn ghost full" onClick={cancelArdy}>
								{ko("Cancel run", "실행 취소")}
							</button>
						)}
						{!lineEditMode && <MotionReadiness state={readinessState} checking={bridgeChecking} onSetup={openMotionSetup} onRetry={recheckMotionHealth} />}
						{ardyRunning && ardyStatus && <p className="ardy-status" role="status">{ardyStatus}</p>}
						{!ardyRunning && ardyOutcome?.ok === false && <p className="ardy-status" role="alert">{ardyOutcome.message}</p>}
						{!ardyRunning && ardyOutcome?.ok === true && <p className="ardy-status" role="status">{ko("Motion generation complete", "모션 생성 완료")}</p>}
						{motion?.url && <MotionAdvanced />}
					</Foldout>
					<TakesSection hidden={!isCharacterSelection || workflowMode === "scene" || workflowMode === "camera"} />
</>
	);
}

/* Motion › Advanced: the dials that decide how much of the loaded take a
   regeneration keeps. Folded away because the default (half preserved, whole
   body free) is right almost always. */
function MotionAdvanced() {
	const { preserveStrength, setPreserveStrength, waypointMode, preserveTracksLine } = useStudioShell();
	const [open, setOpen] = useState(false);
	return (
		<div className="motion-advanced">
			<button type="button" className="motion-advanced-head" aria-expanded={open} onClick={() => setOpen((value) => !value)}>
				<span className="v2-details-foldout-arrow foldout-arrow" data-open={open ? "true" : "false"} aria-hidden="true" />
				{ko("Advanced", "고급")}
			</button>
			{open && (
				<div className="motion-advanced-body">
					<label className="row">
						<span>{ko("Keep current take", "현재 테이크 유지")}</span>
						<input
							type="range"
							data-preserve-strength
							min={0}
							max={1}
							step={0.05}
							value={preserveStrength}
							title={ko(
								"How hard the regeneration holds the loaded take outside the frames you edited.",
								"수정하지 않은 프레임에서 로드된 테이크를 얼마나 강하게 유지할지 정합니다.",
							)}
							onChange={(event) => setPreserveStrength(Number(event.target.value))}
						/>
						<span className="val preserve-strength-value">{Math.round(preserveStrength * 100)}%</span>
					</label>
					{/* The slider value IS the preserve strength: 0 (left) is a fresh
					    take and 1 (right) holds the original hardest. */}
					<p className="inspector-hint motion-preserve-scale">
						<span>{ko("generate fresh", "새로 생성")}</span>
						<span>{ko("keep original", "원본 유지")}</span>
					</p>
					{waypointMode && preserveStrength > 0 && (
						<p className="inspector-hint">
							{ko(
								"the drawn path replaces the root; the body keeps the take's style",
								"경로는 새로 그려지고, 동작 스타일은 원본을 유지해요",
							)}
						</p>
					)}
					{preserveStrength > 0 && preserveTracksLine && (
						<p className="inspector-hint preserve-tracks-summary">{preserveTracksLine}</p>
					)}
				</div>
			)}
		</div>
	);
}

/* Takes (G6): every successful run leaves a checkpoint. Clicking a row loads
   that take back and restores the recipe it was saved with; loading never
   drops a row, so an experiment can always be walked back. */
function TakesSection({ hidden }) {
	const { run } = useMotionCommands();
	const { takeVersions, takeSourceUrl, takeRecipe, replayNotices, linePreviewUrl } = useStudioShell();
	return (
		<Foldout hidden={hidden} title={ko("Takes", "테이크")}>
			<div
				className="motion-takes"
				data-take-source={takeSourceUrl || undefined}
				// The draft's url beside the take's own, so "the viewport swapped but
				// the take did not" is one comparison rather than an inference.
				data-line-preview={linePreviewUrl ? "true" : undefined}
				data-line-preview-url={linePreviewUrl || undefined}
			>
				{takeVersions.length > 0 ? (
					<div className="motion-take-list" role="group" aria-label={ko("Take versions", "테이크 버전")}>
						{takeVersions.map((entry, index) => {
							const current = entry.motionUrl === takeSourceUrl;
							return (
								<button
									type="button"
									key={entry.motionUrl}
									className={"motion-take-row" + (current ? " current" : "")}
									data-version-url={entry.motionUrl}
									data-version-current={current ? "true" : undefined}
									aria-pressed={current}
									title={`${entry.label} · ${new Date(entry.savedAt).toLocaleTimeString()}`}
									onClick={() => run('motion.loadVersion', { motionUrl: entry.motionUrl })}
								>
									<span className="motion-take-index">v{index + 1}</span>
									<span className="motion-take-label">{entry.label}</span>
									<span className="motion-take-time">
										{new Date(entry.savedAt).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", hourCycle: "h23" })}
									</span>
								</button>
							);
						})}
					</div>
				) : (
					<p className="inspector-hint">{ko("No takes yet. Generate creates one.", "아직 테이크가 없어요. 생성하면 하나가 생깁니다.")}</p>
				)}
				{/* C10's per-entry replay verdict. Non-blocking: the take is loaded,
				    one refinement just did not survive the trip onto it. */}
				{replayNotices.map((entry) => (
					<p className="inspector-hint replay-notice" key={`${entry.index}-${entry.track}`} data-replay-index={entry.index} data-replay-track={entry.track}>
						{entry.ok === false
							? (isKo
								? `다듬기 ${entry.index + 1}(${lineTrackLabel(entry.track)})은 다시 적용되지 않았어요 — 나머지는 그대로 이어졌습니다${entry.error ? ` (${entry.error})` : ""}`
								: `Refinement ${entry.index + 1} (${lineTrackLabel(entry.track)}) was not re-applied — the rest carried over${entry.error ? ` (${entry.error})` : ""}`)
							: (isKo
								? `다듬기 ${entry.index + 1}(${lineTrackLabel(entry.track)})은 블록 경계에 걸쳐 있어요 — 결과가 이전과 조금 다를 수 있습니다`
								: `Refinement ${entry.index + 1} (${lineTrackLabel(entry.track)}) straddles a block boundary — the result may differ slightly from before`)}
					</p>
				))}
				{/* A seedless recipe is an IMPORTED take: it reloads but cannot be
				    rebuilt, so the footer says so rather than printing "seed null". */}
				{takeRecipe && (
					<p className="motion-takes-footer take-recipe-summary">
						{isKo
							? `시드 ${Number.isInteger(takeRecipe.seed) ? takeRecipe.seed : "알 수 없음(불러온 테이크)"} · 블록 ${takeRecipe.blocks.length}개 · 다듬기 ${takeRecipe.lineEdits.length}개`
							: `Seed ${Number.isInteger(takeRecipe.seed) ? takeRecipe.seed : "unknown (imported take)"} · ${takeRecipe.blocks.length} block(s) · ${takeRecipe.lineEdits.length} refinement(s)`}
					</p>
				)}
			</div>
		</Foldout>
	);
}

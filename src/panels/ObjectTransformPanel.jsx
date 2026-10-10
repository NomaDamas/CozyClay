import { useContext, useEffect, useRef } from "react";
import { AppContext } from "../app-context.js";
import Foldout from "./Foldout.jsx";
import { ko, isKo } from "../locale.js";
import { Field, Vector3Row } from "../ui.jsx";
import { sceneObjectNameDisplayKo } from "../app-stage.jsx";
import { MESH_KIND, CUTOUT_KIND, EMPTY_KIND, SCULPT_KIND, CUTOUT_DEFAULT_HEIGHT, OBJECT_COLORS, normalizeObjectColor } from "../scene-objects.js";
import { MESH_HEIGHT_MIN } from "../scene-mesh.js";
import { autoColorHex } from "../auto-color.js";
import { isImeComposing } from "../ime.js";

export default function ObjectTransformPanel({
	selectedSceneObject, snapEnabled, setSnapEnabled, attachTargetLabel,
	sceneObjects, beginSceneTransaction, endSceneTransaction, matteCanvasRef, matteStats, matteMode,
	setMatteMode, matteEditorRef, matteTolerance, setMatteTolerance, matteBrush, setMatteBrush, matteShrink,
	setMatteShrink, matteFeather, setMatteFeather, matteBusy, autoColor,
	recentObjectColors, rememberSceneObjectColor, objectColorDraft, setObjectColorDraft,
}) {
	const app = useContext(AppContext), session = useRef(null);
	const run = (...args) => {
		const result = app.bus.run(...args);
		const show = receipt => { if (!receipt.ok) app.notify(receipt.message); return receipt; };
		return result?.then ? result.then(show) : show(result);
	};
	function finish(commit = true) {
		const active = session.current;
		if (!active) return;
		session.current = null;
		return endSceneTransaction(active.txId, { commit });
	}
	function begin(field) {
		if (session.current?.field !== field) finish();
		if (!session.current) {
			const txId = beginSceneTransaction({ owner: `inspector:${field}`, cancel: () => { session.current = null; } });
			session.current = { field, txId };
		}
		return session.current.txId;
	}
	const updateArgs = (patch, txId) => txId
		? ['run.update', { txId, args: { id: selectedSceneObject.id, patch } }]
		: ['object.update', { id: selectedSceneObject.id, patch }];
	const endKey = event => {
		if ((event.key === 'Enter' && !isImeComposing(event)) || event.key === 'Escape') {
			event.stopPropagation(); finish(event.key === 'Enter'); setObjectColorDraft(null);
		}
	};
	useEffect(() => () => finish(false), [selectedSceneObject?.id]);
	return (
<Foldout hidden={!selectedSceneObject} title={ko("Transform", "변환")}>
						{selectedSceneObject && (
							<>
								<p className="inspector-hint v2-details-hint">
								{ko("Type a value and press Enter, or drag a number sideways to scrub (Shift for fine).", "값을 입력하고 Enter를 누르거나 숫자를 좌우로 끌어 조절하세요(Shift는 미세 조정).")}
								</p>
								<label className="check snap-toggle details-toggle-row">
									<span>
									{isKo ? (
										<>
											그리드 스냅 — <kbd>Ctrl</kbd>을 누르면 반대로 작동
										</>
									) : (
										<>
											Snap to grid — hold <kbd>Ctrl</kbd> to invert
										</>
									)}
									</span>
									<input type="checkbox" checked={snapEnabled} onChange={(event) => setSnapEnabled(event.target.checked)} />
								</label>
						<Field label={ko("Name", "이름")}>
									<input
										type="text"
								value={sceneObjectNameDisplayKo(selectedSceneObject.name)}
										onChange={(event) => run(...updateArgs({ name: event.target.value }, begin('name')))}
										onBlur={() => finish()}
										onKeyDown={endKey}
									/>
								</Field>
								{/* A carried prop has no grouping parent to pick — the character
								    IS its parent — so the dropdown gives way to what it is
								    riding and the way off it. Detaching here is the Props drop,
								    numbers and all. */}
								{selectedSceneObject.attach ? (
									<Field label={ko("Attached to", "부착 대상")}>
										<div className="attach-target">
											<span>{attachTargetLabel(selectedSceneObject.attach)}</span>
											<button
												type="button"
												className="btn ghost"
												onClick={() => run('object.detach', { objectId: selectedSceneObject.id })}
												title={ko("Put it back in the set, where it is now", "지금 있는 자리에 그대로 세트로 되돌립니다")}
											>
												{ko("Detach", "분리")}
											</button>
										</div>
									</Field>
								) : (
								<Field label={ko("Parent", "상위 그룹")}>
									<select
										value={selectedSceneObject.parent ?? ""}
										onChange={(event) => {
											const parent = event.target.value || null;
											run(parent ? 'object.group' : 'object.ungroup', { ...(parent ? { parent } : {}), children: [selectedSceneObject.id] });
										}}
									>
										<option value="">{ko("(none)", "(없음)")}</option>
										{sceneObjects
											.filter((object) => object.id !== selectedSceneObject.id)
											.map((object) => (
												<option key={object.id} value={object.id}>{sceneObjectNameDisplayKo(object.name)}</option>
											))}
									</select>
								</Field>
								)}
								<Vector3Row
							label={ko("Position", "위치")}
									fields={[
										{ axis: "X", value: selectedSceneObject.x, step: 0.05, precision: 2, scrubRange: 5, onChange: (x, token) => run(...updateArgs({ x }, token)), onScrubStart: beginSceneTransaction, onScrubEnd: endSceneTransaction },
										{ axis: "Y", value: selectedSceneObject.y ?? 0, step: 0.05, precision: 2, scrubRange: 5, onChange: (y, token) => run(...updateArgs({ y }, token)), onScrubStart: beginSceneTransaction, onScrubEnd: endSceneTransaction },
										{ axis: "Z", value: selectedSceneObject.z, step: 0.05, precision: 2, scrubRange: 5, onChange: (z, token) => run(...updateArgs({ z }, token)), onScrubStart: beginSceneTransaction, onScrubEnd: endSceneTransaction },
									]}
								/>
								<Vector3Row
							label={ko("Rotation", "회전")}
									fields={[
										{ axis: "X", value: selectedSceneObject.rotX ?? 0, step: 1, precision: 1, scrubRange: 180, onChange: (rotX, token) => run(...updateArgs({ rotX }, token)), onScrubStart: beginSceneTransaction, onScrubEnd: endSceneTransaction },
										{ axis: "Y", value: selectedSceneObject.rot, step: 1, precision: 1, scrubRange: 180, onChange: (rot, token) => run(...updateArgs({ rot }, token)), onScrubStart: beginSceneTransaction, onScrubEnd: endSceneTransaction },
										{ axis: "Z", value: selectedSceneObject.rotZ ?? 0, step: 1, precision: 1, scrubRange: 180, onChange: (rotZ, token) => run(...updateArgs({ rotZ }, token)), onScrubStart: beginSceneTransaction, onScrubEnd: endSceneTransaction },
									]}
								/>
								<Vector3Row
							label={ko("Scale", "크기")}
									fields={[
										{ axis: "X", value: selectedSceneObject.scaleX ?? 1, step: 0.05, precision: 2, scrubRange: 4, onChange: (scaleX, token) => run(...updateArgs({ scaleX }, token)), onScrubStart: beginSceneTransaction, onScrubEnd: endSceneTransaction },
										{ axis: "Y", value: selectedSceneObject.scaleY ?? 1, step: 0.05, precision: 2, scrubRange: 4, onChange: (scaleY, token) => run(...updateArgs({ scaleY }, token)), onScrubStart: beginSceneTransaction, onScrubEnd: endSceneTransaction },
										{ axis: "Z", value: selectedSceneObject.scaleZ ?? 1, step: 0.05, precision: 2, scrubRange: 4, onChange: (scaleZ, token) => run(...updateArgs({ scaleZ }, token)), onScrubStart: beginSceneTransaction, onScrubEnd: endSceneTransaction },
									]}
								/>
								{selectedSceneObject.renderer === MESH_KIND && (
									<>
										<Field label={ko("Height (m)", "높이 (m)")}>
											<input
												type="number"
												data-field="mesh-height"
												min={MESH_HEIGHT_MIN}
												step="0.05"
												value={selectedSceneObject.height ?? 1}
												onChange={(event) => run(...updateArgs({ height: Number(event.target.value) }, begin('height')))}
												onBlur={() => finish()} onKeyDown={endKey}
											/>
										</Field>
										<label className="check details-toggle-row">
											<span>{ko("Clay", "클레이")}</span>
											<input
												type="checkbox"
												data-field="mesh-clay"
												checked={selectedSceneObject.clay === true}
												onChange={(event) => run(...updateArgs({ clay: event.target.checked }))}
											/>
										</label>
									</>
								)}
								{selectedSceneObject.renderer === CUTOUT_KIND && (
									<>
										<Field label={ko("Card height (m)", "판 높이 (m)")}>
											<input
												type="number"
												data-field="cutout-height"
												min="0.05"
												step="0.05"
												value={selectedSceneObject.height ?? CUTOUT_DEFAULT_HEIGHT}
												onChange={(event) => run(...updateArgs({ height: Number(event.target.value) }, begin('height')))}
												onBlur={() => finish()} onKeyDown={endKey}
											/>
										</Field>
										<Field label={ko("Card width (m)", "판 너비 (m)")}>
											<input
												type="number"
												data-field="cutout-width"
												min="0.05"
												step="0.05"
												value={Number((selectedSceneObject.footprint?.width ?? 0).toFixed(2))}
												onChange={(event) => run(...updateArgs({ width: Number(event.target.value) }, begin('width')))}
												onBlur={() => finish()} onKeyDown={endKey}
											/>
										</Field>
										<p className="inspector-hint">
											{isKo
												? `높이를 바꾸면 너비는 사진 비율(${(selectedSceneObject.aspect ?? 1).toFixed(2)})을 따라갑니다. 너비만 따로 정하거나 기즈모의 가로축을 끌면 사진이 늘어납니다. 사진 속에서 크기를 알 수 있는 것(문 2 m, 사람 1.8 m)에 맞추세요.`
												: `Width follows the picture's aspect (${(selectedSceneObject.aspect ?? 1).toFixed(2)}) as you change the height. Set it on its own — or drag the gizmo's X axis — to stretch the picture. Measure against something you know: a door is 2 m, a person 1.8 m.`}
										</p>
										{Math.abs((selectedSceneObject.stretch ?? 1) - 1) > 0.005 && (
											<p className="inspector-hint">
												<button
													type="button"
													className="ghost"
													data-field="cutout-unstretch"
													onClick={() => run(...updateArgs({ stretch: 1 }))}
												>
													{isKo
														? `사진 비율로 되돌리기 (지금 ${((selectedSceneObject.stretch ?? 1) * 100).toFixed(0)}%)`
														: `Back to the picture's proportions (now ${((selectedSceneObject.stretch ?? 1) * 100).toFixed(0)}%)`}
												</button>
											</p>
										)}
										<div className="matte-editor">
											{!!selectedSceneObject.matteAssetId && (
												<p className="inspector-hint matte-state">
													{ko(
														"This card's background is removed. You are editing the original photograph — apply again to change what goes.",
														"이 카드는 배경이 지워진 상태입니다. 지금 보이는 것은 원본 사진이며, 다시 적용하면 지워지는 범위가 바뀝니다.",
													)}
												</p>
											)}
											<canvas
												ref={matteCanvasRef}
												className="matte-canvas"
												// Focusable for the space-drag pan, not for a shortcut: undo
												// belongs to the buttons here. Ctrl+Z is the scene's, and one
												// key meaning two different undos in two different panels is
												// worse than a key that means one thing everywhere.
												tabIndex={0}
												aria-label={ko("Background editor — drag over the background to cut it out", "배경 편집기 — 배경 위를 드래그하면 그 영역이 잘려 나갑니다")}
											/>
											<p className="inspector-hint">
												{matteStats.painted
													? isKo
														? `사진의 ${Math.round(matteStats.coverage * 100)}%가 선택됨 — 보라색이 지워집니다.`
														: `${Math.round(matteStats.coverage * 100)}% of the picture marked — purple is what goes.`
													: ko(
															"Drag over the background — the cut grows out from wherever the brush touches.",
															"배경 위를 드래그하세요 — 브러시가 닿은 곳에서 같은 배경으로 번져 나가며 잘립니다.",
														)}
											</p>
										</div>
										{/* Two hands: what the brush does on the left, what to do
										    about what it did on the right. Clear sits under Undo and
										    Redo because it is the same kind of act — taking work
										    back — only all of it. */}
										<div className="matte-tools">
											<div className="presets matte-modes">
												<button
													type="button"
													className={matteMode === "paint" ? "active" : ""}
													onClick={() => {
														setMatteMode("paint");
														matteEditorRef.current?.setMode("paint");
													}}
												>
													{ko("Cut out", "누끼 따기")}
												</button>
												<button
													type="button"
													className={matteMode === "erase" ? "active" : ""}
													onClick={() => {
														setMatteMode("erase");
														matteEditorRef.current?.setMode("erase");
													}}
												>
													{ko("Bring back", "되살리기")}
												</button>
											</div>
											{/* Icons, not words: undo, redo and clear are the same three
											    acts in every tool anyone has used, and spelling them out
											    took more width than the two that actually name what this
											    brush does. The label lives in the tooltip and in the
											    accessible name. */}
											<div className="matte-history">
												<div className="presets matte-modes matte-icons">
													<button
														type="button"
														disabled={!matteStats.canUndo}
														title={ko("Undo", "실행 취소")}
														aria-label={ko("Undo", "실행 취소")}
														onClick={() => matteEditorRef.current?.undo()}
													>
														<span aria-hidden="true">↩️</span>
													</button>
													<button
														type="button"
														disabled={!matteStats.canRedo}
														title={ko("Redo", "다시 실행")}
														aria-label={ko("Redo", "다시 실행")}
														onClick={() => matteEditorRef.current?.redo()}
													>
														<span aria-hidden="true">↪️</span>
													</button>
												</div>
												<div className="presets matte-modes matte-icons matte-clear">
													<button
														type="button"
														title={ko("Clear the selection", "선택 모두 지우기")}
														aria-label={ko("Clear the selection", "선택 모두 지우기")}
														onClick={() => matteEditorRef.current?.clear()}
													>
														<span aria-hidden="true">🗑️</span>
													</button>
												</div>
											</div>
										</div>
										<div className="matte-slider">
											<label htmlFor="matte-tolerance">{ko("Tolerance", "허용치")}</label>
											<input
												id="matte-tolerance"
												type="range"
												min="0.02"
												max="0.6"
												step="0.01"
												value={matteTolerance}
												onChange={(event) => {
													const value = Number(event.target.value);
													setMatteTolerance(value);
													matteEditorRef.current?.setTolerance(value);
												}}
											/>
											<input
												type="number"
												data-field="matte-tolerance"
												min="0.02"
												max="0.6"
												step="0.01"
												value={matteTolerance}
												aria-label={ko("Tolerance", "허용치")}
												onChange={(event) => {
													const value = Number(event.target.value);
													if (!Number.isFinite(value)) return;
													setMatteTolerance(value);
													matteEditorRef.current?.setTolerance(value);
												}}
											/>
										<div className="matte-slider">
											<label htmlFor="matte-brush">{ko("Brush", "붓 크기")}</label>
											<input
												id="matte-brush"
												type="range"
												min="2"
												max="200"
												step="1"
												value={matteBrush}
												onChange={(event) => {
													const value = Number(event.target.value);
													setMatteBrush(value);
													matteEditorRef.current?.setBrush(value);
												}}
											/>
											<input
												type="number"
												data-field="matte-brush"
												min="2"
												max="200"
												step="1"
												value={matteBrush}
												aria-label={ko("Brush size", "붓 크기")}
												onChange={(event) => {
													const value = Number(event.target.value);
													if (!Number.isFinite(value)) return;
													setMatteBrush(value);
													matteEditorRef.current?.setBrush(value);
												}}
											/>
										</div>
										<div className="matte-slider">
											<label htmlFor="matte-shrink">{ko("Edge shrink", "가장자리 먹기")}</label>
											<input
												id="matte-shrink"
												type="range"
												min="0"
												max="3"
												step="0.5"
												value={matteShrink}
												onChange={(event) => setMatteShrink(Number(event.target.value))}
											/>
											<input
												type="number"
												data-field="matte-shrink"
												min="0"
												max="3"
												step="0.5"
												value={matteShrink}
												aria-label={ko("Edge shrink", "가장자리 먹기")}
												onChange={(event) => {
													const value = Number(event.target.value);
													if (Number.isFinite(value)) setMatteShrink(value);
												}}
											/>
										</div>
										<div className="matte-slider">
											<label htmlFor="matte-feather">{ko("Edge feather", "가장자리 부드럽게")}</label>
											<input
												id="matte-feather"
												type="range"
												min="0"
												max="3"
												step="0.5"
												value={matteFeather}
												onChange={(event) => setMatteFeather(Number(event.target.value))}
											/>
											<input
												type="number"
												data-field="matte-feather"
												min="0"
												max="3"
												step="0.5"
												value={matteFeather}
												aria-label={ko("Edge feather", "가장자리 부드럽게")}
												onChange={(event) => {
													const value = Number(event.target.value);
													if (Number.isFinite(value)) setMatteFeather(value);
												}}
											/>
										</div>
										</div>
										<p className="inspector-hint">
											{ko(
												"Tolerance is how far a drag spreads: low keeps to one flat colour, high walks across a shaded wall. It applies to the next drag and to Auto-detect, not to what is already purple.",
												"허용치는 드래그가 얼마나 번질지입니다. 낮으면 한 가지 색에 머무르고, 높으면 명암이 변하는 벽까지 따라갑니다. 이미 칠한 보라가 아니라 다음 드래그와 자동 인식에 적용됩니다.",
											)}
										</p>
										<button
											type="button"
											className="btn ghost full"
											onClick={() => {
												const added = matteEditorRef.current?.autoDetect(matteTolerance) ?? 0;
												if (!added) {
													app.notify(
														isKo
															? "자동 인식이 더 칠할 곳을 찾지 못했어요 — 허용치를 높이거나 직접 칠하세요"
															: "Auto-detect found nothing new to paint — raise the tolerance, or paint it by hand",
													);
												}
											}}
										>
											{ko("Auto-detect background", "배경 자동 인식")}
										</button>
										<button
											type="button"
											className="btn primary full matte-apply"
											disabled={matteBusy || !matteStats.painted}
											onClick={() => run('object.matte', { objectId: selectedSceneObject.id })}
										>
											{matteBusy
												? ko("Removing…", "지우는 중…")
												: matteStats.painted
													? isKo
														? `보라색 부분 지우기 — 사진의 ${Math.round(matteStats.coverage * 100)}%`
														: `Remove what is purple — ${Math.round(matteStats.coverage * 100)}% of the picture`
													: ko("Nothing is marked yet", "아직 선택된 부분이 없습니다")}
										</button>
										<p className="inspector-hint">
											{ko(
												"Cut out grows the selection from wherever you drag; Bring back is the same growth fenced to what is already selected, so one drag returns a wrongly-cut region whole. Applying removes exactly what is purple and trims the empty margin — the card keeps the original photograph and this selection, so you can come back and change your mind.",
												"누끼 따기는 드래그한 자리에서 선택 영역을 키우고, 되살리기는 그 성장을 이미 선택된 범위 안으로 가둔 것이라 잘못 잘린 부분이 드래그 한 번에 통째로 돌아옵니다. 적용하면 보라색 부분만 지우고 여백을 잘라냅니다 — 원본 사진과 지금 선택한 영역은 카드에 남아 있어 언제든 다시 열어 고칠 수 있습니다.",
											)}
										</p>
									</>
								)}
								{selectedSceneObject.renderer !== CUTOUT_KIND && selectedSceneObject.renderer !== EMPTY_KIND && selectedSceneObject.renderer !== SCULPT_KIND && (selectedSceneObject.renderer !== MESH_KIND || selectedSceneObject.clay) && (
									// One swatch shows the colour; the row opens only when you want
									// to change it, instead of six chips sitting there all day.
									<details className="object-colors-pop">
										<summary
										className="object-color current"
										style={{ background: selectedSceneObject.color }}
										aria-label={ko("Object colour", "오브젝트 색상")}
										title={ko("Object colour", "오브젝트 색상")}
									/>
									{/* The displayed color while auto-color mode is on — the "hex"
									    made visible. Computed inline off the RAW object; the swatch
									    above keeps showing the authored color it returns to. */}
									{autoColor && (
										<span className="auto-color-hex">{ko("auto ", "자동 ")}{autoColorHex(selectedSceneObject.id)}</span>
									)}
									<div className="object-colors" role="group" aria-label={ko("Object colour", "오브젝트 색상")}>
										{OBJECT_COLORS.map((color) => (
											<button
												type="button"
												key={color}
												className={"object-color" + (selectedSceneObject.color === color ? " active" : "")}
												style={{ background: color }}
												aria-label={isKo ? `색상 ${color}` : `Colour ${color}`}
												aria-pressed={selectedSceneObject.color === color}
												onClick={(event) => {
													run(...updateArgs({ color }));
													event.currentTarget.closest("details")?.removeAttribute("open");
												}}
											/>
										))}
										{/* Recently mixed tints, fenced off from the presets by a
										    rule: they are this browser's memory, not the palette,
										    and MCP's update_object can put any hex on a prop — an
										    author has to be able to reach the same colour back. */}
										{recentObjectColors.length > 0 && <span className="object-colors-split" aria-hidden="true" />}
										{recentObjectColors.map((color) => (
											<button
												type="button"
												key={color}
												className={"object-color" + (selectedSceneObject.color === color ? " active" : "")}
												style={{ background: color }}
												aria-label={isKo ? `최근 색상 ${color}` : `Recent colour ${color}`}
												aria-pressed={selectedSceneObject.color === color}
												onClick={(event) => {
													run(...updateArgs({ color }));
													rememberSceneObjectColor(color);
													event.currentTarget.closest("details")?.removeAttribute("open");
												}}
											/>
										))}
										{/* The free colour: the native picker for choosing one, the
										    hex field for typing or reading back an exact value. Neither
										    closes the popover the way a preset does — a picker drag and
										    a half-typed hex both fire change after change, and a row
										    that vanished mid-edit would be unusable. */}
										<input
											type="color"
											className="object-color object-color-free"
											value={normalizeObjectColor(selectedSceneObject.color) ?? "#ffffff"}
											title={ko("Custom colour", "직접 고른 색상")}
											aria-label={ko("Custom colour", "직접 고른 색상")}
											onChange={(event) => {
												const color = normalizeObjectColor(event.target.value);
												if (!color) return;
												run(...updateArgs({ color }, begin('color')));
												rememberSceneObjectColor(color);
											}}
											onBlur={() => finish()} onKeyDown={endKey}
										/>
										<input
											type="text"
											className="object-color-hex"
											// Idle, the field IS the object's colour — including one an
											// agent set through MCP's update_object, which the palette
											// alone could never show. Mid-edit the draft takes over.
											value={objectColorDraft ?? selectedSceneObject.color}
											spellCheck={false}
											maxLength={7}
											placeholder="#rrggbb"
											title={ko("Colour hex", "색상 hex")}
											aria-label={ko("Colour hex", "색상 hex")}
											onChange={(event) => {
												setObjectColorDraft(event.target.value);
												const color = normalizeObjectColor(event.target.value);
												if (!color) return; // a typo is a keystroke, not a repaint
												run(...updateArgs({ color }, begin('hex')));
												rememberSceneObjectColor(color);
											}}
											onBlur={() => { finish(); setObjectColorDraft(null); }}
											onKeyDown={endKey}
										/>
										</div>
									</details>
								)}
							</>
						)}
					</Foldout>
	);
}

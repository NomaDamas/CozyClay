import Foldout from "./Foldout.jsx";
import { ko, isKo } from "../locale.js";
import { Field } from "../ui.jsx";
import { VIDEO_MODEL_PRESETS } from "../model-presets.js";
import { useBus } from "../app-context.js";

export default function CameraPanel({ isCameraSelection, shot, moveSequence, cameraKeys, activeShot }) {
	const { run } = useBus();
	return (
<Foldout hidden={!isCameraSelection} title={ko("Camera", "카메라")}>
						<div className="readout v2-details-readout">
						<span title={ko("camera to subject", "카메라와 피사체 거리")}>{shot.distance.toFixed(2)} m</span>
						<span title={ko("nearest prime on the cropped filmback", "크롭된 필름백 기준 가장 가까운 단렌즈")}>{shot.focalMm} mm</span>
						<span title={ko("angle relative to the subject's eyes", "피사체 눈높이 기준 각도")}>{shot.elevationDeg.toFixed(0)}°</span>
						</div>
						<h3 className="move-head v2-details-subsection-title">{ko("Move keys", "움직임 키")}</h3>
						{moveSequence ? (
							<div className="move-slate v2-details-value-box" title={ko("derived from the keyframings, not chosen from a list", "목록에서 고른 값이 아니라 키프레임에서 계산된 움직임입니다")}>
								{moveSequence.displaySlate} · {moveSequence.spanS}{ko("s", "초")}
							</div>
						) : (
							<div className="move-slate v2-details-value-box">
								{cameraKeys.length === 1
									? (isKo ? `프레임 ${cameraKeys[0].frame}부터 고정 샷 — 샷 블록 아래 빈 줄을 클릭해 움직임을 추가하세요` : `locked-off hold from frame ${cameraKeys[0].frame} — click the empty lower strip in a Shot block to add a move`)
									: ko("click a Shot block's lower strip to key the current framing at that frame", "샷 블록 아래 빈 줄을 클릭하면 해당 프레임에 현재 프레이밍을 저장합니다")}
							</div>
						)}

						<h3 className="move-head v2-details-subsection-title">{ko("Follow cam", "팔로우 카메라")}</h3>
						<p className="camera-editor-pointer">
							{activeShot
								? ko(`Editing ${activeShot.name} in the timeline camera bar below.`, `아래 타임라인 카메라 바에서 ${activeShot.name}을 편집합니다.`)
								: ko("Select a Shot block below to edit its camera.", "아래에서 샷 블록을 선택하면 카메라를 편집할 수 있습니다.")}
						</p>

						{/* Which generator this cut is being made FOR. Nothing here
						    re-times or re-crops the shot — the timeline simply warns
						    when the cut runs past the target's clip length or leaves
						    its delivery aspects. */}
						<h3 className="move-head v2-details-subsection-title">{ko("Target model", "타깃 모델")}</h3>
						<p className="inspector-hint v2-details-hint">
							{ko("The timeline flags this shot when the cut runs past the model's clip length or leaves its delivery ratios. Nothing is re-timed or re-cropped.", "컷 길이나 화면 비율이 모델 한계를 벗어나면 타임라인이 표시해줘요. 자동으로 재조정하지는 않습니다.")}
						</p>
						<Field label={ko("Cut for", "맞출 모델")}>
							<select
								data-shot-target-model
								aria-label={ko("Target video model", "타깃 영상 모델")}
								disabled={!activeShot}
								value={activeShot?.targetModel ?? ""}
								onChange={(event) => run('shot.set', { id: activeShot.id, set: { targetModel: event.target.value || null } })}
							>
								<option value="">{ko("None", "없음")}</option>
								{VIDEO_MODEL_PRESETS.map((entry) => (
									<option key={entry.id} value={entry.id}>{entry.name}</option>
								))}
							</select>
						</Field>
					</Foldout>
	);
}

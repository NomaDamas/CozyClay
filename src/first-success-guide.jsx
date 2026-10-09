import { useEffect, useState } from "react";
import { ko } from "./locale.js";

const ANIMATION_STEPS = [
	{
		en: "Select a character in the Outliner.",
		ko: "아웃라이너에서 캐릭터를 선택하세요.",
		hintEn: "Click Character 1 (or its row) to make it active.",
		hintKo: "캐릭터 1(또는 캐릭터 행)을 클릭하면 활성화됩니다.",
	},
	{
		en: "Move it in the Scene view.",
		ko: "장면 보기에서 캐릭터를 움직이세요.",
		hintEn: "Drag the character marker on the floor to place it.",
		hintKo: "바닥의 캐릭터 마커를 드래그해 배치하세요.",
	},
	{
		en: "Press K to set a key at the current frame.",
		ko: "현재 프레임에서 K를 눌러 키를 설정하세요.",
		hintEn: "The key appears on the timeline as your first pose checkpoint.",
		hintKo: "첫 포즈 체크포인트가 타임라인에 표시됩니다.",
	},
	{
		en: "Scrub the timeline or press Space to play.",
		ko: "타임라인을 문지르거나 Space를 눌러 재생하세요.",
		hintEn: "Seeing the playhead move is your first visible result.",
		hintKo: "재생 헤드가 움직이면 첫 결과를 확인한 것입니다.",
	},
];

const STORYBOARD_STEPS = [
	{
		en: "Open the Agent panel (Cmd/Ctrl+B).",
		ko: "에이전트 패널을 여세요 (Cmd/Ctrl+B).",
		hintEn: "The Agent panel is where you describe each panel.",
		hintKo: "에이전트 패널에서 각 패널을 설명합니다.",
	},
	{
		en: "Describe one scene in a sentence.",
		ko: "장면 하나를 한 문장으로 설명하세요.",
		hintEn: "One sentence per turn is enough for one panel.",
		hintKo: "패널 하나에는 한 문장이면 충분합니다.",
	},
	{
		en: "Your panel appears on the Board.",
		ko: "패널이 보드에 나타납니다.",
		hintEn: "Open the Board tab to see the new panel card.",
		hintKo: "보드 탭에서 새 패널 카드를 확인하세요.",
	},
	{
		en: "Stylize it, or export the panel pack.",
		ko: "스타일을 입히거나 패널 팩으로 내보내세요.",
		hintEn: "Use Stylize on the card, or export the panel pack.",
		hintKo: "카드에서 스타일을 입히거나 패널 팩으로 내보내세요.",
	},
];

export const STEPS_BY_MODE = { animation: ANIMATION_STEPS, storyboard: STORYBOARD_STEPS };

/** A compact, dismissible first-run checklist that follows the v2 shell grammar. */
export default function FirstSuccessGuide({ open, onDismiss, previsMode = "animation" }) {
	const storyboard = previsMode === "storyboard";
	const STEPS = STEPS_BY_MODE[storyboard ? "storyboard" : "animation"];
	const [step, setStep] = useState(0);
	useEffect(() => {
		if (open) setStep(0);
	}, [open]);
	if (!open) return null;
	const complete = step >= STEPS.length;

	return (
		<aside className="v2-first-success-guide first-success-guide" role="dialog" aria-labelledby="first-success-guide-title" aria-describedby="first-success-guide-description">
			<div className="v2-first-success-guide-head first-success-guide-head">
				<div>
					<strong id="first-success-guide-title">{ko("Your first 60 seconds", "첫 60초")}</strong>
					<span>{complete ? ko("Core loop complete", "핵심 흐름 완료") : ko(`Step ${step + 1} of ${STEPS.length}`, `${step + 1} / ${STEPS.length} 단계`)}</span>
				</div>
				<button type="button" className="v2-first-success-guide-close first-success-guide-close" onClick={onDismiss} aria-label={ko("Dismiss guide", "가이드 닫기")}>×</button>
			</div>
			{complete ? (
				<div className="v2-first-success-guide-complete first-success-guide-complete" id="first-success-guide-description" role="status">
					<div className="v2-first-success-guide-check first-success-guide-check">✓</div>
					<strong>{storyboard ? ko("You made your first panel.", "첫 패널을 만들었어요.") : ko("You made your first shot.", "첫 샷을 만들었어요.")}</strong>
					<p>{storyboard ? ko("Describe, review on the Board, then stylize or export. You can close this guide and keep adding panels.", "설명하고, 보드에서 확인한 뒤 스타일을 입히거나 내보내세요. 가이드를 닫고 패널을 계속 추가하세요.") : ko("Select, move, key, and play are the core CozyClay loop. You can close this guide and keep blocking.", "선택하고, 움직이고, 키를 찍고, 재생하는 것이 CozyClay의 핵심 흐름입니다. 가이드를 닫고 계속 블로킹하세요.")}</p>
					<button type="button" className="v2-first-success-guide-next first-success-guide-next btn primary" onClick={onDismiss}>{ko("Continue editing", "편집 계속하기")}</button>
				</div>
			) : (
				<>
					<p id="first-success-guide-description" className="v2-first-success-guide-intro first-success-guide-intro">{ko("Follow these four actions to see a result quickly.", "네 가지 동작으로 빠르게 결과를 확인해 보세요.")}</p>
					<ol className="v2-first-success-guide-steps first-success-guide-steps">
						{STEPS.map((item, index) => (
							<li key={item.en} className={index < step ? "done" : index === step ? "current" : ""}>
								<span className="v2-first-success-guide-step-mark first-success-guide-step-mark">{index < step ? "✓" : index + 1}</span>
								<div><strong>{ko(item.en, item.ko)}</strong>{index === step && <span>{ko(item.hintEn, item.hintKo)}</span>}</div>
							</li>
						))}
					</ol>
					<button type="button" className="v2-first-success-guide-next first-success-guide-next btn primary" onClick={() => setStep((value) => value + 1)}>
						{ko(step === STEPS.length - 1 ? "Mark complete" : "I did this", step === STEPS.length - 1 ? "완료로 표시" : "했어요")}
					</button>
				</>
			)}
			<button type="button" className="v2-first-success-guide-skip first-success-guide-skip" onClick={onDismiss}>{ko("Skip guide", "가이드 건너뛰기")}</button>
		</aside>
	);
}

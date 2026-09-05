import { useEffect, useState } from "react";
import { ko } from "./locale.js";

const STEPS = [
	{
		en: "Select a character in the Hierarchy panel.",
		ko: "계층 패널에서 캐릭터를 선택하세요.",
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

/** A small, dismissible first-run checklist shown after creating a project. */
export default function FirstSuccessGuide({ open, onDismiss }) {
	const [step, setStep] = useState(0);
	useEffect(() => {
		if (open) setStep(0);
	}, [open]);
	if (!open) return null;
	const complete = step >= STEPS.length;

	return (
		<aside className="first-success-guide" role="dialog" aria-labelledby="first-success-guide-title" aria-describedby="first-success-guide-description">
			<div className="first-success-guide-head">
				<div>
					<strong id="first-success-guide-title">{ko("Your first 60 seconds", "첫 60초")}</strong>
					<span>{complete ? ko("Core loop complete", "핵심 흐름 완료") : ko(`Step ${step + 1} of ${STEPS.length}`, `${step + 1} / ${STEPS.length} 단계`)}</span>
				</div>
				<button type="button" className="first-success-guide-close" onClick={onDismiss} aria-label={ko("Dismiss guide", "가이드 닫기")}>×</button>
			</div>
			{complete ? (
				<div className="first-success-guide-complete" id="first-success-guide-description" role="status">
					<div className="first-success-guide-check">✓</div>
					<strong>{ko("You made your first shot.", "첫 샷을 만들었어요.")}</strong>
					<p>{ko("Select, move, key, and play are the core CozyClay loop. You can close this guide and keep blocking.", "선택하고, 움직이고, 키를 찍고, 재생하는 것이 CozyClay의 핵심 흐름입니다. 가이드를 닫고 계속 블로킹하세요.")}</p>
					<button type="button" className="btn primary" onClick={onDismiss}>{ko("Continue editing", "편집 계속하기")}</button>
				</div>
			) : (
				<>
					<p id="first-success-guide-description" className="first-success-guide-intro">{ko("Follow these four actions to see a result quickly.", "네 가지 동작으로 빠르게 결과를 확인해 보세요.")}</p>
					<ol className="first-success-guide-steps">
						{STEPS.map((item, index) => (
							<li key={item.en} className={index < step ? "done" : index === step ? "current" : ""}>
								<span className="first-success-guide-step-mark">{index < step ? "✓" : index + 1}</span>
								<div><strong>{ko(item.en, item.ko)}</strong>{index === step && <span>{ko(item.hintEn, item.hintKo)}</span>}</div>
							</li>
						))}
					</ol>
					<button type="button" className="btn primary first-success-guide-next" onClick={() => setStep((value) => value + 1)}>
						{ko(step === STEPS.length - 1 ? "Mark complete" : "I did this", step === STEPS.length - 1 ? "완료로 표시" : "했어요")}
					</button>
				</>
			)}
			<button type="button" className="first-success-guide-skip" onClick={onDismiss}>{ko("Skip guide", "가이드 건너뛰기")}</button>
		</aside>
	);
}

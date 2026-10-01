import { useEffect, useState } from "react";

// Closed choices only (analytics USE_CASE_VALUES / TEAM_VALUES): no free text
// ever leaves the browser from this card.
const USE_CASES = Object.freeze([
	["animation", "Animation", "애니메이션"],
	["film", "Film / drama", "영화·드라마"],
	["game", "Game", "게임"],
	["ad_mv", "Ad / music video", "광고·뮤비"],
	["personal", "Personal project", "개인 작업"],
	["other", "Something else", "기타"],
]);
const TEAMS = Object.freeze([
	["team", "With a team or company", "팀·회사에서"],
	["solo", "On my own", "혼자"],
]);

/**
 * One optional question after the first successful export (#466). Two taps:
 * what the export is for, then team or solo. Closing it at any point counts as
 * a skip, and the card never comes back on this browser profile.
 */
export default function UseCaseQuestion({ open, isKo, onAnswer }) {
	const [useCase, setUseCase] = useState(null);
	const label = (en, ko) => (isKo ? ko : en);
	useEffect(() => {
		if (!open) setUseCase(null);
	}, [open]);
	if (!open) return null;
	const close = () => onAnswer(useCase ?? "skip", "skip");
	return (
		<section
			className="use-case-ask"
			role="dialog"
			aria-modal="false"
			aria-labelledby="use-case-ask-title"
			onKeyDown={(event) => {
				if (event.key === "Escape") close();
			}}
		>
			<div className="use-case-ask-head">
				<strong id="use-case-ask-title">{label("Quick question (optional)", "짧은 질문 (선택)")}</strong>
				<button type="button" className="use-case-ask-close" aria-label={label("Close", "닫기")} onClick={close}>
					×
				</button>
			</div>
			<p className="use-case-ask-prompt">
				{useCase
					? label("Who are you making it with?", "누구와 작업하나요?")
					: label("What are you making with CozyClay?", "CozyClay로 뭘 만들고 있나요?")}
			</p>
			<div className="use-case-ask-choices" role="group" aria-label={useCase ? label("Team or solo", "팀 또는 혼자") : label("Use case", "용도")}>
				{(useCase ? TEAMS : USE_CASES).map(([value, en, ko]) => (
					<button
						key={value}
						type="button"
						onClick={() => (useCase ? onAnswer(useCase, value) : setUseCase(value))}
					>
						{label(en, ko)}
					</button>
				))}
			</div>
			<p className="use-case-ask-note">{label("Anonymous. Only the choice is sent.", "익명이에요. 고른 항목만 전송돼요.")}</p>
		</section>
	);
}

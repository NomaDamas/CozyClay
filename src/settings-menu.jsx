import { useEffect, useRef, useState } from "react";
import { getAnalyticsOptOut, setAnalyticsOptOut } from "./analytics.js";
import { LOCALE, ko, localeChosen, setLocale } from "./locale.js";

// App settings — language and analytics — behind one labelled topbar trigger
// (#193, docs/studio-ui-ia.md R4). Neither item edits the document, so they do
// not belong on the Save/Export row as bare toggles.
//
// The panel is a group of toggle buttons rather than role="menu": aria-pressed
// is the state contract the analytics opt-out already shipped with, and only
// role="button" supports it. Tab order is DOM order, Escape returns focus to
// the trigger.
const LANGUAGES = [
	{ id: "en", label: "English", action: "Switch to English" },
	{ id: "ko", label: "한국어", action: "한국어로 전환" },
];

export default function SettingsMenu() {
	const [open, setOpen] = useState(false);
	const [optedOut, setOptedOut] = useState(getAnalyticsOptOut);
	const triggerRef = useRef(null);

	// Dismissal mirrors the project menu: listen only while open, ignore
	// presses inside the wrap so the trigger keeps toggling, close on Escape
	// and hand focus back to the control the operator came from.
	useEffect(() => {
		if (!open) return undefined;
		const onPointerDown = (event) => {
			if (event.target instanceof Element && event.target.closest(".settings-menu-wrap")) return;
			setOpen(false);
		};
		const onKeyDown = (event) => {
			if (event.key !== "Escape") return;
			setOpen(false);
			triggerRef.current?.focus();
		};
		document.addEventListener("pointerdown", onPointerDown);
		window.addEventListener("keydown", onKeyDown);
		return () => {
			document.removeEventListener("pointerdown", onPointerDown);
			window.removeEventListener("keydown", onKeyDown);
		};
	}, [open]);

	// First-run cue: the studio starts in English even on a Korean browser, so
	// the only visible hint that Korean exists used to be the old locale button.
	// Until a language is stored, a ko-* browser sees the trigger in Korean.
	const koreanBrowser = typeof navigator !== "undefined" && (navigator.language ?? "").startsWith("ko");
	const label = !localeChosen && koreanBrowser ? "한국어" : ko("Settings", "설정");

	return (
		<div className="settings-menu-wrap">
			<button
				type="button"
				className="topbar-action settings-menu-trigger"
				data-testid="settings-menu-trigger"
				aria-expanded={open}
				aria-haspopup="true"
				title={ko("Language and analytics", "언어 및 사용 통계")}
				ref={triggerRef}
				onClick={() => setOpen((value) => !value)}
			>
				{label}
				<span className="caret">▾</span>
			</button>
			{open && (
				<div className="project-menu settings-menu" role="group" aria-label={ko("Settings", "설정")}>
					<h4>{ko("Language", "언어")}</h4>
					{LANGUAGES.map((language) => (
						<button
							key={language.id}
							type="button"
							data-testid={`settings-locale-${language.id}`}
							aria-pressed={LOCALE === language.id}
							title={language.action}
							onClick={() => setLocale(language.id)}
						>
							{language.label}
							<span className="mark" aria-hidden="true">{LOCALE === language.id ? "✓" : ""}</span>
						</button>
					))}
					<h4>{ko("Privacy", "개인정보")}</h4>
					<button
						type="button"
						data-testid="settings-analytics"
						aria-pressed={!optedOut}
						title={optedOut
							? ko("Turn anonymous analytics on", "익명 사용 통계 켜기")
							: ko("Turn anonymous analytics off", "익명 사용 통계 끄기")}
						onClick={async () => {
							const actual = await setAnalyticsOptOut(!optedOut);
							setOptedOut(actual);
						}}
					>
						{ko("Anonymous analytics", "익명 사용 통계")}
						<span className="mark">{optedOut ? ko("off", "끔") : ko("on", "켬")}</span>
					</button>
					{/* Learning the camera is not a document edit and not a topbar
					    button (R4): the tutorial opens from this closed popover, so the
					    mode budgets in docs/studio-ui-ia.md §1 are untouched. */}
					<h4>{ko("Help", "도움말")}</h4>
					<button
						type="button"
						data-testid="settings-camera-tutorial"
						title={ko("Learn the camera in seven steps", "일곱 단계로 카메라 익히기")}
						onClick={() => {
							window.dispatchEvent(new CustomEvent("cozyclay:camera-tutorial", { detail: { open: true } }));
							setOpen(false);
						}}
					>
						{ko("Camera tutorial", "카메라 튜토리얼")}
					</button>
				</div>
			)}
		</div>
	);
}

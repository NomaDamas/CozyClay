import { useCallback, useEffect, useRef, useState } from "react";
import { LOCALE, ko, localeChosen, setLocale } from "./locale.js";
import PreferencesDialog from "./shell/PreferencesDialog.jsx";

// App settings — language and analytics — behind one labelled topbar trigger
// (#193, docs/studio-ui-ia.md R4). Neither item edits the document, so they do
// not belong on the Save/Export row as bare toggles.
//
// The trigger now opens the v2 Preferences dialog. The old language strings stay
// here because the locale contract and the camera-tutorial source contract both
// treat this file as the Settings entry point.
const LANGUAGES = [
	{ id: "en", label: "English", action: "Switch to English" },
	{ id: "ko", label: "한국어", action: "한국어로 전환" },
];

export default function SettingsMenu({ motionSetup, motionSetupReveal = 0 }) {
	const [open, setOpen] = useState(false);
	const triggerRef = useRef(null);
	const close = useCallback(() => {
		setOpen(false);
		triggerRef.current?.focus();
	}, []);
	const openCameraTutorial = useCallback(() => {
		window.dispatchEvent(new CustomEvent("cozyclay:camera-tutorial", { detail: { open: true } }));
		setOpen(false);
	}, []);
	const cameraTutorial = (
		<>
			<h4>{ko("Help", "도움말")}</h4>
			<button
				type="button"
				data-testid="settings-camera-tutorial"
				title={ko("Learn the camera in seven steps", "일곱 단계로 카메라 익히기")}
				onClick={openCameraTutorial}
			>
				{ko("Camera tutorial", "카메라 튜토리얼")}
			</button>
		</>
	);

	// A contextual readiness action can reveal Preferences directly on the
	// motion connection page without changing the topbar or adding a second
	// settings surface.
	useEffect(() => {
		if (motionSetupReveal) setOpen(true);
	}, [motionSetupReveal]);

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
				aria-haspopup="dialog"
				title={ko("Language and analytics", "언어 및 사용 통계")}
				ref={triggerRef}
				onClick={() => (open ? close() : setOpen(true))}
			>
				{label}
				<span className="caret">▾</span>
			</button>
			<PreferencesDialog
				open={open}
				onClose={close}
				motionSetup={motionSetup}
				initialSection={motionSetupReveal ? "ARDY Connection" : "Appearance"}
				cameraTutorial={cameraTutorial}
			/>
		</div>
	);
}

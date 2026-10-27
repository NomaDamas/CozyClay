import { useCallback, useRef, useState } from "react";
import { ko, localeChosen } from "./locale.js";
import PreferencesDialog from "./shell/PreferencesDialog.jsx";

// App settings — language — behind one labelled topbar trigger
// (#193, docs/studio-ui-ia.md R4). Neither item edits the document, so they do
// not belong on the Save/Export row as bare toggles.
//
// The trigger now opens the v2 Preferences dialog. The old language strings stay
// here because the locale contract treats this file as the Settings entry point.
const LANGUAGES = [
	{ id: "en", label: "English", action: "Switch to English" },
	{ id: "ko", label: "한국어", action: "한국어로 전환" },
	{ id: "zh", label: "简体中文", action: "切换到中文" },
];

export default function SettingsMenu() {
	const [open, setOpen] = useState(false);
	const triggerRef = useRef(null);
	const close = useCallback(() => {
		setOpen(false);
		triggerRef.current?.focus();
	}, []);

	// First-run cue: the studio starts in English even on a Korean browser, so
	// the only visible hint that Korean exists used to be the old locale button.
	// Until a language is stored, a ko-* browser sees the trigger in Korean.
	const koreanBrowser = typeof navigator !== "undefined" && (navigator.language ?? "").startsWith("ko");
	const chineseBrowser = typeof navigator !== "undefined" && (navigator.language ?? "").startsWith("zh");
	const firstRunCue = koreanBrowser ? "한국어" : chineseBrowser ? "简体中文" : null;
	const label = !localeChosen && firstRunCue ? firstRunCue : ko("Settings", "설정", "设置");

	return (
		<div className="settings-menu-wrap">
			<button
				type="button"
				className="topbar-action settings-menu-trigger"
				data-testid="settings-menu-trigger"
				aria-expanded={open}
				aria-haspopup="dialog"
				title={ko("Language settings", "언어 설정", "语言设置")}
				ref={triggerRef}
				onClick={() => (open ? close() : setOpen(true))}
			>
				{label}
				<span className="caret">▾</span>
			</button>
			<PreferencesDialog
				open={open}
				onClose={close}
				initialSection="Appearance"
			/>
		</div>
	);
}

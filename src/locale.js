// CozyClay UI locale. English is the default; Korean is opt-in.
//
// An explicit choice saved in localStorage wins. Without one, the UI always
// starts in English regardless of browser or operating-system language.
// The locale is fixed for the lifetime of the page — every label goes through
// ko() at render time, so switching saves the choice and reloads.
const KEY = "cozyclay.locale";

function stored() {
	try {
		const value = localStorage.getItem(KEY);
		return value === "ko" || value === "en" ? value : null;
	} catch {
		return null;
	}
}

export const LOCALE = stored() ?? "en";
export const isKo = LOCALE === "ko";
// Whether the operator has ever picked a language. A Korean browser that has
// not chosen yet still gets the English default, so the Settings trigger wears
// "한국어" as its first-run cue until a choice is stored (#193).
export const localeChosen = stored() !== null;

/** Pick the label for the active locale: ko("Frame", "프레임"). */
export function ko(en, koText) {
	return isKo ? koText : en;
}

export function setLocale(next) {
	if (next !== "ko" && next !== "en") return;
	try {
		localStorage.setItem(KEY, next);
	} catch {
		// Private mode without storage: the toggle still works for this load.
	}
	window.location.reload();
}

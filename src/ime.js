// Browsers report an Enter key from an active input method editor as a
// composing key event. Chromium and Safari also use the legacy 229 keyCode;
// keep both signals so text commits never trigger an action first.
export function isImeComposing(event) {
	return Boolean(event?.isComposing || event?.nativeEvent?.isComposing || event?.keyCode === 229 || event?.which === 229);
}

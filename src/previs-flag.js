export const PREVIS_FLAG_KEY = "cozyclay.previs-modes";

export function previsModesEnabled() {
	const params = new URLSearchParams(globalThis.location?.search ?? "");
	const requested = params.get("previs");
	if (requested === "1") {
		globalThis.localStorage?.setItem(PREVIS_FLAG_KEY, "1");
		return true;
	}
	if (requested === "0") {
		globalThis.localStorage?.removeItem(PREVIS_FLAG_KEY);
		return false;
	}
	return globalThis.localStorage?.getItem(PREVIS_FLAG_KEY) === "1";
}

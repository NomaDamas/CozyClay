// UI preference only. No progress, project content, IDs or analytics events.
const TERMINAL_KEY = "cozyclay.camera-tutorial-terminal.v1";

function readTerminal(storage) {
	try {
		return JSON.parse((storage ?? globalThis.localStorage)?.getItem(TERMINAL_KEY) || "null");
	} catch {
		return null;
	}
}

export function cameraTutorialSuppressed(storage) {
	const terminal = readTerminal(storage);
	return terminal?.dismissed === true || terminal?.completed === true || terminal?.export_started === true;
}

export function rememberCameraTutorialTerminal(reason, storage) {
	try {
		(storage ?? globalThis.localStorage)?.setItem(TERMINAL_KEY, JSON.stringify({ [reason]: true }));
	} catch {
		// Storage is optional; an attempt also owns its in-memory dismissal.
	}
}

export function createFirstShotHandoff(storage) {
	let closed = cameraTutorialSuppressed(storage);
	return {
		canShow(done) {
			return !closed && ["shot", "rail", "play"].every((kind) => done.has(kind));
		},
		complete() {
			// Future attempts stay quiet; this completed attempt keeps its action.
			rememberCameraTutorialTerminal("completed", storage);
		},
		dismiss() {
			closed = true;
			rememberCameraTutorialTerminal("dismissed", storage);
		},
		exportStarted() {
			closed = true;
			rememberCameraTutorialTerminal("export_started", storage);
		},
	};
}

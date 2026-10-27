// The install scene: a local terminal page (scenes/terminal.html) prints
// output lines and types on the last line, captured like any Studio frame.
// Consecutive terminal steps continue the same page, so a prompt printed by
// one step can be answered by the next.
import { pathToFileURL } from "node:url";

export const TERMINAL_URL = pathToFileURL(new URL("./scenes/terminal.html", import.meta.url).pathname).href;

/**
 * The timed events the terminal page plays for one step: one `line` per
 * printed line, then one `char` per typed character and an `enter`. Pure,
 * so it is tested. About 12 typed characters a second, lines 0.6 s apart.
 */
export function terminalSequence({ print = [], type = "" }, { startMs = 400, lineMs = 600, charMs = 83, typeAfterMs = 500, enterMs = 450 } = {}) {
	const events = [];
	let at = startMs;
	print.forEach((line, index) => {
		if (index > 0) at += lineMs;
		events.push({ at, kind: "line", text: line });
	});
	if (type) {
		if (print.length) at += typeAfterMs;
		for (const [index, character] of [...type].entries()) {
			if (index > 0) at += charMs;
			events.push({ at, kind: "char", text: character });
		}
		at += enterMs;
		events.push({ at, kind: "enter" });
	}
	return { events, totalMs: at };
}

/** Play one terminal step: on a fresh page when asked or when the page is elsewhere, else continuing. */
export async function playTerminal(cdp, scene) {
	if (scene.fresh || (await cdp.evaluate("location.href")) !== TERMINAL_URL) {
		const loaded = cdp.once("Page.loadEventFired");
		await cdp.send("Page.navigate", { url: TERMINAL_URL });
		await loaded;
	}
	const { events, totalMs } = terminalSequence(scene);
	await cdp.evaluate(`window.__terminal.play(${JSON.stringify(events)})`);
	await new Promise((resolve) => setTimeout(resolve, totalMs + 200));
}

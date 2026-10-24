// The storyboard contact sheet is drawn on a bare 2d canvas, which has no
// stylesheet to inherit from: it gets the studio's own type stack explicitly
// so the sheet reads like the app it came out of.
export const STORYBOARD_FONT = '12px Inter, "Pretendard", "Noto Sans KR", system-ui, -apple-system, "Segoe UI", Helvetica, Arial, sans-serif';
// One unwrapped caption line at 12px inside a 480px cell holds about 64
// characters before it runs into the next column.
const STORYBOARD_CAPTION_CHARS = 64;

/** Cut a caption to what one unwrapped cell line holds. */
export function storyboardLine(text) {
	return text.length > STORYBOARD_CAPTION_CHARS ? `${text.slice(0, STORYBOARD_CAPTION_CHARS - 1)}\u2026` : text;
}

/** Fold a labelled shot prompt into the one line a board cell can hold. */
export function storyboardCaption(prompt) {
	return storyboardLine(prompt
		.split("\n")
		.filter((line) => line.startsWith("SHOT:") || line.startsWith("LENS:"))
		.map((line) => line.slice(line.indexOf(":") + 1).trim())
		.join(" · "));
}

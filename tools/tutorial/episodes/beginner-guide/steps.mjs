// Step builders for the beginner-guide chapters, so each chapter file reads
// like its storyboard table: a caption (CAP), a spotlight (SPOT), a card.

/** { ko, en } */
export const t = (ko, en) => ({ ko, en });

/** A spotlight with its callout; `caption` makes it the start of a captioned cue. */
export const spot = (id, target, label, note, { hold = 4000, caption, glide } = {}) => ({
	id,
	...(caption ? { narration: caption } : {}),
	spotlight: target,
	...(label ? { label } : {}),
	...(note ? { note } : {}),
	hold,
	...(glide === false ? { glide } : {}),
});

/** A chapter title card (2.5 s). */
export const chapterCard = (id, title, subtitle) => ({ id, card: { title, subtitle }, hold: 2500 });

/** Spotlights in a row that share one storyboard row: the label and note split on " / " when both split evenly. */
export function spots(idPrefix, targets, label, note, { hold = 3000, caption } = {}) {
	const parts = (pair) => ({ ko: pair.ko.split(" / "), en: pair.en.split(" / ") });
	const labels = parts(label), notes = parts(note);
	const even = [labels, notes].every((pair) => pair.ko.length === targets.length && pair.en.length === targets.length);
	return targets.map((target, index) => spot(`${idPrefix}${"abcdefgh"[index]}`, target,
		even ? t(labels.ko[index], labels.en[index]) : label,
		even ? t(notes.ko[index], notes.en[index]) : note,
		{ hold, caption: index === 0 ? caption : undefined }));
}

export const clear = (id) => ({ id, spotlight: null });

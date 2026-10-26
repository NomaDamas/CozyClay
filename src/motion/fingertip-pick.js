/**
 * The fingertip a press grabs. Candidates are `{ id, gap, reach, ... }`: the
 * press's pixel distance to the tip's projected centre, and how far the tip
 * reaches on screen. In range tips are tried nearest first, and the first one
 * `isExposed(candidate)` accepts wins, so a tip the body hides (behind the palm
 * or other fingers) is skipped for the next visible one. Null when no exposed
 * tip is in range: the press is left for the IK handles (#913).
 */
export function pickFingertip(candidates, isExposed) {
	return candidates
		.filter((candidate) => candidate.gap <= candidate.reach)
		.sort((a, b) => a.gap - b.gap)
		.find((candidate) => isExposed(candidate)) ?? null;
}

/** Pick for a pointerdown and claim the event only when a tip is picked; otherwise it passes on untouched. */
export function claimFingertip(event, candidates, isExposed) {
	const picked = pickFingertip(candidates, isExposed);
	if (picked) { event.stopImmediatePropagation(); event.stopPropagation(); event.preventDefault(); }
	return picked;
}

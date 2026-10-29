// Contact and flight classes of a take's frames (fill-density.js classifySpans; the key thinning pass, thin.js, thins only the
// free frames). limbContact and floorAnkle are the shared classifiers:
//   contact: a hand on an anchor or a goal / checks.contacts naming a hand, or a foot off the floor (on a support)
//   flight:  both feet more than 5 cm above the take's lowest authored ankle for 4+ frames (a stride's 2-3 frames is not a flight)
const LIFT = 0.05;
export const FLIGHT_MIN = 4;
const HAND = /hand|wrist|finger|thumb|index|palm/i, FOOT = /foot|toe|ankle/i;

/**
 * Whether a goal or contacts check names a limb in contact over [a, b]: any hand, or a foot that is off the floor there (on a
 * support, more than 5 cm above the take's floor ankle). A foot "landed / still" on the floor is locomotion, not a plant.
 */
export function limbContact(refs, [a, b], baked, floor) {
	const text = JSON.stringify(refs ?? "");
	if (HAND.test(text)) return true;
	if (!FOOT.test(text) || floor === null) return false;
	const sides = /left/i.test(text) && !/right/i.test(text) ? ["foot_l"] : /right/i.test(text) && !/left/i.test(text) ? ["foot_r"] : ["foot_l", "foot_r"];
	for (let f = Math.max(0, a); f <= b; f++) if (sides.some(ch => baked[ch]?.[f]?.[1] > floor + LIFT)) return true;
	return false;
}

/** The ankle height of a foot on the floor in this take: the lowest foot target any authored key sets. */
export function floorAnkle(keys) {
	const ys = keys.flatMap(k => ["foot_l", "foot_r"].map(ch => k.set?.[ch]?.[1]).filter(Number.isFinite));
	return ys.length ? Math.min(...ys) : null;
}

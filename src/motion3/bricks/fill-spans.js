// Gaps the fill leaves to the compiler: hand plants, flights and checked spans. The model in-betweens full-body poses from
// motion-capture runs; it slides a planted hand and flattens a flight (the parkour benchmark: palms never reached the wall,
// 3-7x the foot slide). Fill covers run-up and recovery; hand plants and jumps stay the author's poses.
//   hand_contact: a hand on an anchor (w_<anchor>_l/r on) at either end, or a goal / contacts check whose points name a hand
//                 or foot over a frame range that touches the gap (every authored pose keys hand_l/r with armw on, so a hand
//                 target alone is no contact)
//   airborne:     a foot target more than 5 cm above the take's lowest planted ankle at either end, or both feet above it
//                 for 2+ frames of the compiled curve inside the gap
//   check_span:   a checks.clearance span covers part of the gap
// supports and allow name no frames, so they do not mark a span.
const LIFT = 0.05;
const LIMB = /hand|foot|toe|wrist|ankle|finger/i;

const rangeOf = (at, frames) => (Array.isArray(at) ? [at[0], at[1]] : Number.isFinite(at) ? [at, at] : [0, frames - 1]);
// a span covers a gap when it overlaps its inside (a span that only meets the gap at a shared key frame does not); a one-frame
// contact on a key frame touches both gaps beside that key
const touches = ([a, b], fa, fb) => (a === b ? a >= fa && a <= fb : a < fb && b > fa);

/** Frames of a weight channel above 0.99 (a check's `when: "w_x_l"`), as one [first, last] range, or null. */
function weightRange(baked, channel) {
	const values = baked[channel];
	if (!values) return null;
	const on = values.map((v, f) => (v > 0.99 ? f : -1)).filter(f => f >= 0);
	return on.length ? [on[0], on.at(-1)] : null;
}

/** The ankle height of a foot on the floor in this take: the lowest foot target any authored key sets. */
export function floorAnkle(keys) {
	const ys = keys.flatMap(k => ["foot_l", "foot_r"].map(ch => k.set?.[ch]?.[1]).filter(Number.isFinite));
	return ys.length ? Math.min(...ys) : null;
}

/** Why gap fa-fb stays the compiler's ("hand_contact" | "airborne" | "check_span"), or null. keys: the spec's authored keys. */
export function spanReason(spec, keys, baked, fa, fb) {
	const frames = Number.isFinite(spec.frames) ? spec.frames : fb + 1;
	const ends = keys.filter(k => k.f === fa || k.f === fb);
	if (ends.some(k => Object.entries(k.set ?? {}).some(([ch, v]) => /^w_.+_[lr]$/.test(ch) && v > 0.5))) return "hand_contact";
	for (const goal of spec.goals ?? []) if (LIMB.test(JSON.stringify([goal.near, goal.above, goal.still])) && touches(rangeOf(goal.at, frames), fa, fb)) return "hand_contact";
	for (const check of spec.checks?.contacts ?? []) {
		const span = typeof check.when === "string" ? weightRange(baked, check.when) : rangeOf(check.when, frames);
		if (span && LIMB.test(String(check.point ?? "")) && touches(span, fa, fb)) return "hand_contact";
	}
	const floor = floorAnkle(keys);
	if (floor !== null) {
		const up = (k, ch) => (k.set?.[ch]?.[1] ?? -Infinity) > floor + LIFT;
		if (ends.some(k => up(k, "foot_l") || up(k, "foot_r"))) return "airborne";
		let run = 0;
		for (let f = fa + 1; f < fb; f++) {
			const l = baked.foot_l?.[f]?.[1], r = baked.foot_r?.[f]?.[1];
			run = l > floor + LIFT && r > floor + LIFT ? run + 1 : 0;
			if (run >= 2) return "airborne";
		}
	}
	for (const check of spec.checks?.clearance ?? []) if (touches(rangeOf(check.frames, frames), fa, fb)) return "check_span";
	return null;
}

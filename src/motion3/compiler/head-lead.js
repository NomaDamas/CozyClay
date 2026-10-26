// When the trunk turns the head turns first: a person's head leads the pelvis into a turn by about 200 ms (about 5
// frames at 24 fps), walking or standing. The head takes the turn the trunk (the root's and the spine's yaw) makes
// over the next LEAD frames, no more than MAX degrees (half the neck's turn one way); inside a walk its heading, so the
// head leads the walk's turns, not each step's sway (head-steady.js steadies that). Inside every walk (start to last
// step, head-steady.js walkSpans) and around every turn of the trunk faster than TURN deg/frame (from LEAD + FADE
// frames before it, so the head starts first), faded in and out over FADE frames, and never where the spec's own keys move
// head_yaw during that span (keys on it, or on either side of it, that differ): a keyed look wins; a head held still
// (a stance's head_yaw 0) leads. A skill's own look that rides a turn (NOT_A_LOOK: exitCar's head as it swivels out of
// the seat) is not a keyed look: the lead goes on top of it. The agent's keys, and every other skill's, still win.
import { walkSpans } from "./head-steady.js";

const MAX = 30, TURN = 0.3, FADE = 8, STRIDE = 33;
const NOT_A_LOOK = /\bwalk(To)? (start|step \d+|end)$|^use\[\d+\] exitCar$/; // walk.js keys, OWN_LOOK skills (skills/car.js)

/** Inside a walk the trunk's heading, its sway each step taken out: the median over about a stride keeps a turn's timing. */
function heading(trunk, walks) {
	const out = trunk.slice(), half = Math.floor(STRIDE / 2), n = trunk.length;
	for (const [f0, f1] of walks) for (let f = Math.max(0, f0); f <= Math.min(n - 1, f1); f++) {
		const w = trunk.slice(Math.max(0, f - half), Math.min(n, f + half + 1)).sort((a, b) => a - b);
		out[f] = w.length % 2 ? w[(w.length - 1) / 2] : (w[w.length / 2 - 1] + w[w.length / 2]) / 2;
	}
	return out;
}

/** Frame runs [f0, f1] (inclusive) where the trunk turns faster than TURN, widened by `before` and `after` frames. */
function turnSpans(trunk, frameCount, before, after) {
	const spans = [];
	for (let f = 0; f < frameCount - 1; f++) {
		if (Math.abs(trunk[f + 1] - trunk[f]) <= TURN) continue;
		const a = Math.max(0, f - before), b = Math.min(frameCount - 1, f + 1 + after), last = spans.at(-1);
		if (last && a <= last[1] + 1) last[1] = Math.max(last[1], b);
		else spans.push([a, b]);
	}
	return spans;
}

/** Overlapping or touching spans joined. */
function merged(spans) {
	const out = [];
	for (const [a, b] of [...spans].sort((x, y) => x[0] - y[0])) {
		const last = out.at(-1);
		if (last && a <= last[1] + 1) last[1] = Math.max(last[1], b);
		else out.push([a, b]);
	}
	return out;
}

/** The keys outside walks that move head_yaw during [f0, f1]: those in it and the nearest on either side differ. */
function looked(keys, f0, f1) {
	const looks = keys.filter(k => k.set?.head_yaw !== undefined && !NOT_A_LOOK.test(k.src ?? "")).sort((a, b) => a.f - b.f);
	const near = [looks.filter(k => k.f < f0).at(-1), ...looks.filter(k => k.f >= f0 && k.f <= f1), looks.find(k => k.f > f1)].filter(Boolean);
	return near.some(k => JSON.stringify(k.set.head_yaw) !== JSON.stringify(near[0].set.head_yaw));
}

/** Adds the turn the trunk makes over the next `lead` frames to the baked head yaw (in place); lead 0 is off. */
export function leadHead(baked, keys, frameCount, lead = 5) {
	if (!(lead > 0)) return;
	const zero = new Array(frameCount).fill(0), yaw = baked.yaw ?? zero, spine = baked.spine_yaw ?? zero;
	// a retime keeps its keys on fractional frames (fix/retime.js): the spans are frame indices
	const walks = walkSpans(keys).map(([a, b]) => [Math.ceil(a), Math.floor(b)]), trunk = heading(yaw.map((v, f) => v + spine[f]), walks), at = f => trunk[Math.min(frameCount - 1, f)];
	const spans = merged([...walks, ...turnSpans(trunk, frameCount, lead + FADE, FADE)]);
	let head = null;
	for (const [f0, f1] of spans) {
		if (looked(keys, f0, f1)) continue;
		head ??= (baked.head_yaw ?? zero).slice();
		for (let f = Math.max(0, f0); f <= Math.min(frameCount - 1, f1); f++) {
			const fade = Math.min(1, (f - f0) / FADE, (f1 - f) / FADE), d = Math.max(-MAX, Math.min(MAX, at(f + lead) - trunk[f]));
			head[f] += d * fade * fade * (3 - 2 * fade);
		}
	}
	if (head) baked.head_yaw = head;
}

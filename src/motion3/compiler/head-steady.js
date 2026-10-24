// While a walk runs the head keeps the gaze steadier than the trunk: the trunk's quick sway (the root's and the
// spine's yaw, pitch and roll less their moving average over about a stride, so a turn, a lean or a bow the keys
// hold is not swayed against) is taken back by the head, a part of it (STEADY) and no more than LIMIT degrees; little
// of the pitch: a person's head nods with the trunk's dip at each step.
// Only from a walk's start to its last step (walk.js tags them "<tag> start", "<tag> step <n>"; the settle after
// holds still, and a take cut in it ends the same), faded in and out over FADE frames, and never on a head axis the
// spec's own keys move during that walk: a keyed look wins. The average holds the take's end value past its end.
const STEADY = { yaw: 0.5, pitch: 0.2, roll: 0.7 }, LIMIT = { yaw: 4, pitch: 6, roll: 10 }, WINDOW = 33, FADE = 8;
const AXES = ["yaw", "pitch", "roll"];

/** The walk spans in the keys, start to last step: [[f0, f1], ...]. */
export function walkSpans(keys) {
	const spans = new Map();
	for (const k of keys) {
		const m = / (start|step \d+)$/.exec(k.src ?? ""), tag = m && k.src.slice(0, -m[0].length);
		if (!m || !/\bwalk(To)?$/.test(tag)) continue;
		const span = spans.get(tag) ?? [Infinity, -Infinity];
		spans.set(tag, [Math.min(span[0], k.f), Math.max(span[1], k.f)]);
	}
	return [...spans.values()].filter(([a, b]) => b > a);
}

const movingAverage = (xs, w) => {
	const half = Math.floor(w / 2), at = i => xs[Math.max(0, Math.min(xs.length - 1, i))];
	return xs.map((_, f) => { let s = 0; for (let i = f - half; i <= f + half; i++) s += at(i); return s / (2 * half + 1); });
};

/** Adds the head's share of the trunk's sway to the baked head channels inside every walk (in place). */
export function steadyHead(baked, keys, frameCount) {
	const spans = walkSpans(keys);
	if (!spans.length) return;
	const series = name => baked[name] ?? new Array(frameCount).fill(0);
	for (const axis of AXES) {
		const spine = series(`spine_${axis}`), trunk = series(axis).map((v, f) => v + spine[f]);
		const mean = movingAverage(trunk, WINDOW);
		let head = null;
		for (const [f0, f1] of spans) {
			const keyed = keys.some(k => k.f >= f0 && k.f <= f1 && k.set?.[`head_${axis}`] !== undefined && !/\bwalk(To)? (start|step \d+|end)$/.test(k.src ?? ""));
			if (keyed) continue;
			head ??= series(`head_${axis}`).slice();
			for (let f = Math.max(0, f0); f <= Math.min(frameCount - 1, f1); f++) {
				const fade = Math.min(1, (f - f0) / FADE, (f1 - f) / FADE), sway = Math.max(-LIMIT[axis], Math.min(LIMIT[axis], trunk[f] - mean[f]));
				head[f] -= STEADY[axis] * sway * fade * fade * (3 - 2 * fade);
			}
		}
		if (head) baked[`head_${axis}`] = head;
	}
}

// Key density by span: hand/foot contact and flight are authored densely, free motion sparsely. The take's frames are classed
// from the compiled curve: contact (a hand or foot on an anchor, or a goal / checks.contacts naming one, +-2 frames), flight
// (both feet more than 5 cm above the lowest authored ankle for 4+ frames, +-2), else free. The key thinning pass (thin.js)
// removes keys only in the free spans.
import { floorAnkle, limbContact, FLIGHT_MIN } from "./fill-spans.js";
import { isFillKey } from "./fill-src.js";

const PAD = 2, LIFT = 0.05;
const rangeOf = at => (Array.isArray(at) ? [at[0], at[1]] : Number.isFinite(at) ? [at, at] : null);

/** Per-frame kinds ("contact" > "flight" > "free") and their runs as spans [{ f0, f1, kind }]. */
export function classifySpans(spec, baked, frames) {
	const kind = new Array(frames).fill("free"), mark = (a, b, k) => {
		for (let f = Math.max(0, a - PAD); f <= Math.min(frames - 1, b + PAD); f++) if (kind[f] !== "contact") kind[f] = k;
	};
	const floor = floorAnkle((spec.keys ?? []).filter(k => !isFillKey(k)));
	if (floor !== null) {
		let start = -1;
		for (let f = 0; f <= frames; f++) {
			const up = f < frames && baked.foot_l?.[f]?.[1] > floor + LIFT && baked.foot_r?.[f]?.[1] > floor + LIFT;
			if (up && start < 0) start = f;
			if (!up && start >= 0) { if (f - start >= FLIGHT_MIN) mark(start, f - 1, "flight"); start = -1; }
		}
	}
	const contact = [];
	for (const [ch, values] of Object.entries(baked)) if (/^w_.+_[lr]$/.test(ch)) values.forEach((v, f) => { if (v > 0.5) contact.push([f, f]); });
	for (const goal of spec.goals ?? []) { const r = rangeOf(goal.at); if (r && limbContact([goal.near, goal.above, goal.still], r, baked, floor)) contact.push(r); }
	for (const check of spec.checks?.contacts ?? []) { const r = rangeOf(check.when); if (r && limbContact(check.point, r, baked, floor)) contact.push(r); }
	for (const [a, b] of contact) for (let f = Math.max(0, a - PAD); f <= Math.min(frames - 1, b + PAD); f++) kind[f] = "contact";
	const spans = [];
	kind.forEach((k, f) => { if (spans.at(-1)?.kind === k) spans.at(-1).f1 = f; else spans.push({ f0: f, f1: f, kind: k }); });
	return { kind, spans };
}

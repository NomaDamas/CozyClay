// Key density by span: free motion is sparse and MotionBricks fills it; hand/foot contact and flight are authored densely.
// The take's frames are classed from the compiled curve: contact (a hand or foot on an anchor, or a goal / checks.contacts
// naming one, +-2 frames), flight (both feet more than 5 cm above the lowest authored ankle for 2+ frames, +-2), else free.
// Notes name keys[n] like QA hints:
//   KEYS_TOO_DENSE  two authored keys closer than 8 frames in a free span (no room for the fill; the keys stay)
//   CONTACT_UNKEYED two authored keys more than 12 frames apart across a contact span
//   FLIGHT_UNKEYED  a flight without an authored key at its apex or at its landing
import { floorAnkle } from "./fill-spans.js";
import { isFillKey } from "./fill-src.js";

const PAD = 2, LIFT = 0.05, FREE_MIN = 8, CONTACT_MAX = 12;
const LIMB = /hand|foot|toe|wrist|ankle|finger/i;
const rangeOf = (at, frames) => (Array.isArray(at) ? [at[0], at[1]] : Number.isFinite(at) ? [at, at] : null);

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
			if (!up && start >= 0) { if (f - start >= 2) mark(start, f - 1, "flight"); start = -1; }
		}
	}
	const contact = [];
	for (const [ch, values] of Object.entries(baked)) if (/^w_.+_[lr]$/.test(ch)) values.forEach((v, f) => { if (v > 0.5) contact.push([f, f]); });
	for (const goal of spec.goals ?? []) if (LIMB.test(JSON.stringify([goal.near, goal.above, goal.still]))) { const r = rangeOf(goal.at, frames); if (r) contact.push(r); }
	for (const check of spec.checks?.contacts ?? []) if (LIMB.test(String(check.point ?? ""))) { const r = rangeOf(check.when, frames); if (r) contact.push(r); }
	for (const [a, b] of contact) for (let f = Math.max(0, a - PAD); f <= Math.min(frames - 1, b + PAD); f++) kind[f] = "contact";
	const spans = [];
	kind.forEach((k, f) => { if (spans.at(-1)?.kind === k) spans.at(-1).f1 = f; else spans.push({ f0: f, f1: f, kind: k }); });
	return { kind, spans };
}

/** The density notes for the spec's keys (indices as stored: QA's keys[n]). */
export function densityNotes(keys, kind, spans, baked) {
	const authored = keys.map((k, i) => ({ k, i })).filter(({ k }) => !isFillKey(k)), notes = [];
	const name = ({ k, i }) => `keys[${i}] f${k.f}`;
	for (let n = 1; n < authored.length; n++) {
		const a = authored[n - 1], b = authored[n], gap = b.k.f - a.k.f;
		if (gap <= 0) continue;
		const inside = kind.slice(a.k.f, b.k.f + 1);
		if (gap < FREE_MIN && inside.every(k => k === "free")) notes.push(`KEYS_TOO_DENSE no room for the fill between ${name(a)} and ${name(b)} (${gap} frames; free motion keys every 8-18 frames, remove one)`);
		// across a plant, not only its +-2 padding brushing a free gap
		if (gap > CONTACT_MAX && inside.filter(k => k === "contact").length > 2 * PAD + 1) notes.push(`CONTACT_UNKEYED ${name(a)} and ${name(b)} are ${gap} frames apart across a hand/foot contact; key it at least every ${CONTACT_MAX} frames`);
	}
	const near = f => authored.some(({ k }) => Math.abs(k.f - f) <= PAD);
	for (const span of spans.filter(s => s.kind === "flight")) {
		let apex = span.f0;
		for (let f = span.f0; f <= span.f1; f++) if ((baked.root?.[f]?.[1] ?? 0) > (baked.root?.[apex]?.[1] ?? 0)) apex = f;
		const land = Math.max(span.f0, span.f1 - PAD), missing = [!near(apex) && `the apex (about f${apex})`, !near(land) && `the landing (about f${land})`].filter(Boolean);
		if (missing.length) notes.push(`FLIGHT_UNKEYED the flight f${span.f0}-f${span.f1} has no authored key at ${missing.join(" or ")}; write those poses`);
	}
	return notes;
}

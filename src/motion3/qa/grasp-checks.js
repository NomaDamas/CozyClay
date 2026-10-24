// Does the hand hold what it carries (#816)? The COLLIDE check excuses the holding hand and forearm (object-checks.js)
// and nothing judged the fingers, so a ball riding the finger middles, through them, scored QA 0 (session 7f15b4ae).
// On the physical-grasp path: a carry with no at/along (it rests in the hand) or naming a carry grasp, on grab..release,
// and a fit on an object anchor with grasp while it holds (its weight and its fingers' grip at least HELD: the reach has
// arrived and the skill has the hand closed; the object
// still rests where it stands, so SUPPORT does not judge it). A carry pinned with at/along and no
// grasp type (a cigarette, a lighter) keeps its preset grip and is not judged here. With fix.grasp false the carries it
// would seat are judged as they are held (the preset grip; qa/hints-grasp.js turns grasp back on); fix: false judges none.
// The fingers are phalanx capsules
// (PHALANX m) against the held object's shapes (shapes.js: a ball is round, not its box):
//   FINGER_PEN  "<Bone> into <id>": a phalanx's skin deeper than PEN in it
//   THUMB_OFF   "<side> thumb off <id>": a power or spherical hold whose fingers grip it with the thumb tip farther than GAP
//   FINGER_GAP  "<side> fingers off <id>": fewer than 3 of the 4 fingertips within GAP of its surface (pinch: the thumb
//               and the index); the thumb and two fingers hold too (a tripod: a small ball the ring and little fingers do
//               not reach)
//   SUPPORT     "<id> not supported": nothing touching it from below holds its centre over its contacts (within
//               SUPPORT_TOL across), no thumb presses against the fingers (OPPOSE deg between their contact normals)
//               and the contacts do not enclose it (their normals no more than ENCLOSE deg apart)
import { add, scale, dot, norm, apply } from "../compiler/math.js";
import { isCarried } from "../carried.js";
import { spanOf, partsOf, objectPoseAt } from "../object-pose.js";
import { SETTLE, seatsInHand } from "../seat.js";
import { shapeOf, normalAt, closestPoint, capsuleDepth } from "../shapes.js";

const PHALANX = 0.009, PALM = 0.022, PEN = 0.004, GAP = 0.008, HELD = 0.995, SUPPORT_TOL = 0.01, OPPOSE = 120, ENCLOSE = 150, BELOW = -0.3, ARRIVED = 0.03;
const FINGERS = ["Index", "Middle", "Ring", "Pinky"], SIDE = { l: "Left", r: "Right" };

/** The grasp a held object takes when the spec names none: a sphere's hand cups it, a cylinder's wraps it. */
function defaultGrasp(scene, id) {
	const parts = partsOf(scene, id), kind = parts.length === 1 ? shapeOf(scene.objects[parts[0]]).kind : "box";
	return kind === "sphere" ? "spherical" : kind === "cylinder" ? "power" : null;
}

/** The held carries and grasp fits, each { id, k (hand), grasp, from, to } in absolute frames, with the frames a fit weighs in. */
export function heldSpans(out) {
	const { spec: asked, scene } = out.ctx, spans = [], spec = asked.fix?.grasp === false ? { ...asked, fix: { ...asked.fix, grasp: true } } : asked;
	for (const [id, o] of Object.entries(spec.objects ?? {})) {
		// the carries grasp physics seats (with fix.grasp false: the ones it would)
		if (!isCarried(o) || !seatsInHand(spec, o, scene, id)) continue;
		const k = spec.props?.[o.prop]?.hand, [from, to] = spanOf(out, o);
		// judged once the object has settled into the hand (seat.js): the grab itself is the transition
		if (k) spans.push({ id, k, grasp: o.grasp ?? defaultGrasp(scene, id), from: from + SETTLE + 1, to });
	}
	for (const fit of spec.fits ?? []) {
		const a = spec.anchors?.[fit.anchor];
		// a rim socket (a steering wheel) keeps its rim grip: the fingers do not close on the disc the scene draws (finger-close.js)
		if (a?.kind !== "object" || !a.grasp || out.ctx.sockets?.get(fit.anchor)?.rim) continue;
		const ch = `w_${fit.anchor}_${fit.side}`, f0 = out.f0 ?? 0, fingers = out.baked?.[`fingers_${fit.side}`];
		const grip = f => Object.entries(fingers?.[f] ?? {}).reduce((acc, [p, v]) => acc + (p === "relaxed" ? 0 : v || 0), 0);
		const held = f => (out.baked?.[ch]?.[f] ?? 0) >= HELD && grip(f) >= HELD;
		spans.push({ id: a.object, k: fit.side, grasp: a.grasp, from: f0, to: f0 + out.frames.length - 1, held, rests: true });
	}
	return spans;
}

const entriesAt = (out, id, f) => partsOf(out.ctx.scene, id).map(p => ({ ...out.ctx.scene.objects[p], ...objectPoseAt(out, p, f) }));

function handCapsules(sk, s, k) {
	const S = SIDE[k], P = j => s.P[sk.index[`${S}Hand${j}`]], out = [{ bone: `${S}Hand`, finger: "palm", a: s.P[sk.index[`${S}Hand`]], b: P("Middle1"), r: PALM }];
	for (const f of [...FINGERS, "Thumb"]) for (let i = 1; i <= 3; i++) out.push({ bone: `${S}Hand${f}${i}`, finger: f, tip: i === 3, a: P(`${f}${i}`), b: P(`${f}${i + 1}`), r: PHALANX });
	return out;
}

function contacts(capsules, entries) {
	return capsules.map(c => {
		let best = { depth: -Infinity };
		for (const e of entries) { const d = capsuleDepth(e, c.a, c.b, c.r); if (d > best.depth) best = { depth: d, entry: e }; }
		const mid = scale(add(c.a, c.b), 0.5), at = best.entry && closestPoint(best.entry, mid);
		return { ...c, depth: best.depth, at, normal: best.entry && normalAt(best.entry, mid) };
	});
}

function hullDistance(p, pts) {
	if (!pts.length) return Infinity;
	const q = [p[0], p[2]], xs = pts.map(v => [v[0], v[2]]);
	const segDist = (a, b) => { const ab = [b[0] - a[0], b[1] - a[1]], t = Math.max(0, Math.min(1, ((q[0] - a[0]) * ab[0] + (q[1] - a[1]) * ab[1]) / ((ab[0] ** 2 + ab[1] ** 2) || 1))); return Math.hypot(q[0] - a[0] - t * ab[0], q[1] - a[1] - t * ab[1]); };
	const hull = monotoneHull(xs);
	if (hull.length >= 3 && hull.every((a, i) => { const b = hull[(i + 1) % hull.length]; return (b[0] - a[0]) * (q[1] - a[1]) - (b[1] - a[1]) * (q[0] - a[0]) >= 0; })) return 0;
	return Math.min(...hull.map((a, i) => segDist(a, hull[(i + 1) % hull.length])));
}
function monotoneHull(points) {
	const p = [...points].sort((a, b) => a[0] - b[0] || a[1] - b[1]), cross = (o, a, b) => (a[0] - o[0]) * (b[1] - o[1]) - (a[1] - o[1]) * (b[0] - o[0]);
	if (p.length < 3) return p;
	const lower = [], upper = [];
	for (const v of p) { while (lower.length >= 2 && cross(lower.at(-2), lower.at(-1), v) <= 0) lower.pop(); lower.push(v); }
	for (const v of p.reverse()) { while (upper.length >= 2 && cross(upper.at(-2), upper.at(-1), v) <= 0) upper.pop(); upper.push(v); }
	return [...lower.slice(0, -1), ...upper.slice(0, -1)];
}

function frameIssues(sk, s, h, entries, push, f) {
	const touch = contacts(handCapsules(sk, s, h.k), entries), side = SIDE[h.k].toLowerCase();
	// a reach whose hand never got there is REACH's and CONTACT's to report, not the fingers'
	if (h.rests && touch[0].depth < -ARRIVED) return;
	for (const c of touch) if (c.finger !== "palm" && c.depth > PEN) push("FINGER_PEN", `${c.bone} into ${h.id}`, f, c.depth, PEN);
	const tipOn = finger => touch.some(c => c.finger === finger && c.tip && c.depth >= -GAP);
	const fingersOn = FINGERS.filter(tipOn).length, thumb = tipOn("Thumb");
	// a pinch holds between the thumb and the index; a small ball in a tripod (the thumb and two fingers); else three fingers
	const gripped = h.grasp === "pinch" ? thumb && tipOn("Index") : fingersOn >= 3 || (thumb && fingersOn >= 2);
	if (!gripped) push("FINGER_GAP", `${side} fingers off ${h.id}`, f, fingersOn + (thumb ? 1 : 0), h.grasp === "pinch" ? 2 : 3);
	// a power or spherical hold closes the thumb against the fingers: three fingertips on the ball with the thumb out passed
	else if (!thumb && (h.grasp === "power" || h.grasp === "spherical")) push("THUMB_OFF", `${side} thumb off ${h.id}`, f, -Math.max(...touch.filter(c => c.finger === "Thumb" && c.tip).map(c => c.depth)), GAP);
	const on = touch.filter(c => c.depth >= -GAP && c.normal);
	const c0 = scale(entries.reduce((acc, e) => add(acc, add(e.pos, apply(e.R, [0, e.half[1], 0]))), [0, 0, 0]), 1 / entries.length);
	const under = on.filter(c => c.normal[1] <= BELOW).map(c => c.at);
	const thumbN = on.filter(c => c.finger === "Thumb").map(c => c.normal), fingerN = on.filter(c => FINGERS.includes(c.finger)).map(c => c.normal);
	const mean = v => (v.length ? norm(v.reduce(add, [0, 0, 0])) : null), tn = mean(thumbN), fn = mean(fingerN);
	const opposed = tn && fn && (Math.acos(Math.max(-1, Math.min(1, dot(tn, fn)))) * 180) / Math.PI >= OPPOSE;
	const angle = (a, b) => (Math.acos(Math.max(-1, Math.min(1, dot(a, b)))) * 180) / Math.PI;
	const enclosed = on.some((a, i) => on.slice(i + 1).some(b => angle(a.normal, b.normal) >= ENCLOSE));
	if (!h.rests && !opposed && !enclosed && hullDistance(c0, under) > SUPPORT_TOL) push("SUPPORT", `${h.id} not supported`, f, Math.min(1, hullDistance(c0, under)), SUPPORT_TOL);
}

/** FINGER_PEN, FINGER_GAP and SUPPORT issues of every held span (frames index out.frames, as every check's). */
export function graspChecks(sk, out) {
	// fix.grasp false is judged too: the hand that keeps its preset grip is what its hint turns grasp back on for
	if (out.ctx.spec.fix === false) return [];
	const issues = [], f0 = out.f0 ?? 0, push = (kind, msg, i, value, limit) => issues.push({ kind, msg, frame: i, value: +value.toFixed(4), limit });
	for (const h of heldSpans(out)) {
		for (let f = Math.max(h.from, f0); f <= Math.min(h.to, f0 + out.frames.length - 1); f++) {
			if (h.held && !h.held(f)) continue;
			const entries = entriesAt(out, h.id, f);
			if (entries.length) frameIssues(sk, out.frames[f - f0].s, h, entries, push, f - f0);
		}
	}
	return issues;
}

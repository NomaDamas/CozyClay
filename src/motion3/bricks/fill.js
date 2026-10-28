// Fills the gaps between authored key poses with MotionBricks motion, as sparse spec keys marked src: "fill".
// Per gap (two adjacent authored key frames): compile the spec as it stands, read 4 context poses ending at the first key
// and 4 target poses from the second (30 fps apart) as SOMA poses, run the model once with the token count that matches
// the gap, read the motion back as channels, bend each channel so it starts and ends exactly on the compiled values at the
// two keys, and keep the fewest keys that reproduce it. Authored keys are never touched; a re-fill (at: frame) replaces
// the fill keys of the gaps around that frame only. Gaps run in order and the spec is compiled again after each, so the
// next gap's context is the motion just filled. The model runs elsewhere (run: feed -> { out, tokens }).
import { somaPose } from "./reverse.js";
import { somaFK, toCozyPoint } from "./soma.js";
import { encodePoses, decodeMotion, MIN_TOKENS, MAX_TOKENS } from "./model-io.js";
import { frameChannels, unwrapSeries, roundChannels } from "./forward.js";
import { pickKeys } from "./rekey.js";
import { isFillKey, shortHash, fillSrc, editedFill, fillGapOf } from "./fill-src.js";
import { spanReason } from "./fill-spans.js";
import { quatFromMat, matFromQuat } from "../compiler/math.js";

const STEP = 24 / 30; // one model frame in spec frames
const isFill = isFillKey;
const lerp = (a, b, t) => (Array.isArray(a) ? a.map((v, i) => v + (b[i] - v) * t) : a + (b - a) * t);

function nlerpRot(A, B, t) {
	const a = quatFromMat(A), b = quatFromMat(B), s = a[0] * b[0] + a[1] * b[1] + a[2] * b[2] + a[3] * b[3] < 0 ? -1 : 1;
	const q = a.map((v, i) => v + (s * b[i] - v) * t), n = Math.hypot(...q);
	return matFromQuat(q.map(v => v / n));
}

/** The SOMA pose at fractional spec frame t of a compiled take (frames clamp to the take). */
function poseAt(sk, frames, cache, t) {
	t = Math.max(0, Math.min(frames.length - 1, t));
	const i = Math.min(Math.floor(t), frames.length - 2), u = Math.max(0, t - i);
	const at = f => cache.get(f) ?? cache.set(f, somaPose(sk, frames[f].s)).get(f);
	if (frames.length < 2 || u === 0) return at(Math.max(0, Math.min(i, frames.length - 1)));
	const a = at(i), b = at(i + 1), root = lerp(a.root, b.root, u), R = a.R.map((r, j) => nlerpRot(r, b.R[j], u));
	return { root, R, P: somaFK(root, R) };
}

/** Authored key frames in order and the gaps between neighbours (only those with frames to fill), optionally those around `at`. */
function fillGaps(keys, at, minGap = 2) {
	const fs = [...new Set(keys.filter(k => !isFill(k)).map(k => k.f))].sort((a, b) => a - b);
	const gaps = fs.slice(1).map((fb, i) => [fs[i], fb]).filter(([fa, fb]) => fb - fa >= minGap);
	return at === undefined ? gaps : gaps.filter(([fa, fb]) => fa <= at && at <= fb);
}

function tokensFor(fa, fb) {
	const n = (fb - fa) / STEP + 1, tok = Math.round((n + 6) / 4);
	if (tok > MAX_TOKENS) throw new Error(`FILL_GAP_TOO_LONG: f${fa}-f${fb} needs ${Math.round(n)} model frames; one call fills at most ${MAX_TOKENS * 4 - 6} (${Math.floor((MAX_TOKENS * 4 - 7) * STEP)} spec frames). Add a key pose in between.`);
	return Math.max(MIN_TOKENS, tok);
}

/** Dense channels over spec frames fa..fb from the decoded motion, ends bent onto the compiled values there. */
function spanChannels(motion, fa, fb, baked) {
	const gen = motion.map(m => frameChannels(m.P.map(toCozyPoint))), n = gen.length, out = [];
	for (let f = fa; f <= fb; f++) {
		const x = (f - fa) / (fb - fa) * (n - 1), i = Math.min(Math.floor(x), n - 2), u = x - i;
		out.push(Object.fromEntries(Object.keys(gen[0]).map(k => [k, lerp(gen[i][k], gen[i + 1][k], u)])));
	}
	unwrapSeries(out, Object.fromEntries(Object.entries(baked).map(([k, v]) => [k, v[fa]])));
	const diff = (x, y) => (Array.isArray(x) ? x.map((v, i) => v - y[i]) : x - y);
	for (const k of Object.keys(out[0])) {
		if (!baked[k]) continue;
		const s = diff(baked[k][fa], out[0][k]), e = diff(baked[k][fb], out[out.length - 1][k]);
		out.forEach((ch, i) => { const w = i / (out.length - 1); ch[k] = Array.isArray(s) ? ch[k].map((v, c) => v + s[c] * (1 - w) + e[c] * w) : ch[k] + s * (1 - w) + e * w; });
	}
	const planted = out.map((_, i) => motion[Math.round(i / (out.length - 1) * (n - 1))].contacts);
	lockFeet(out, planted);
	return out;
}

/**
 * A foot the model plants (heel and toe contact) stays put: over each planted run its ankle and angles hold the value
 * where the run starts, or where it ends when the run reaches the gap's end (the authored key there), or slide straight
 * between the two keys when the run spans the whole gap (then any slide is the author's).
 */
function lockFeet(out, planted) {
	const last = out.length - 1;
	for (const [k, h] of [["l", 0], ["r", 2]]) {
		const on = planted.map(c => c[h] > 0.5 && c[h + 1] > 0.5);
		for (let i = 0; i <= last; i++) {
			if (!on[i]) continue;
			let j = i;
			while (j < last && on[j + 1]) j++;
			for (const ch of [`foot_${k}`, `fyaw_${k}`, `fpitch_${k}`]) {
				const a = out[i][ch], b = out[j][ch];
				for (let f = i; f <= j; f++) {
					const w = i === 0 && j === last ? f / last : j === last && i > 0 ? 1 : 0;
					out[f][ch] = lerp(a, b, w);
				}
			}
			i = j;
		}
	}
}

function sparseKeys(dense, fa, gap) {
	const byF = new Map();
	for (const ch of Object.keys(dense[0])) {
		for (const i of pickKeys(ch, dense.map(d => d[ch]))) {
			if (!byF.has(i)) byF.set(i, {});
			byF.get(i)[ch] = dense[i][ch];
		}
	}
	return [...byF].sort((a, b) => a[0] - b[0]).map(([i, set]) => { const rounded = roundChannels(set); return { f: fa + i, set: rounded, src: fillSrc(rounded, gap) }; });
}

const merge = (keys, add) => [...keys, ...add].map((k, i) => [k, i]).sort((a, b) => a[0].f - b[0].f || a[1] - b[1]).map(([k]) => k);

// 8: a 12-frame grid's gaps go to the model too (6 tokens, 18 model frames compressed onto the gap); under 8 the curve stays the compiler's
const MIN_AUTO_GAP = 8, MAX_GAP = 46;
/**
 * A gap longer than one call (46 frames) gets the compiler's own pose at its middle as an authored pass-through key
 * (src: "pass"), again until every gap fits; the channels are the ones the authored keys set.
 */
function passThrough(spec, compile) {
	let keys = [...(spec.keys ?? [])], added = 0;
	for (let guard = 0; guard < 64; guard++) {
		const fs = [...new Set(keys.filter(k => !isFill(k)).map(k => k.f))].sort((a, b) => a - b);
		const i = fs.findIndex((f, n) => n > 0 && f - fs[n - 1] > MAX_GAP);
		if (i < 0) break;
		const mid = Math.round((fs[i - 1] + fs[i]) / 2), baked = compile({ ...spec, keys }).out.baked;
		const names = [...new Set(keys.filter(k => !isFill(k)).flatMap(k => Object.keys(k.set ?? {})))].filter(ch => baked[ch]);
		const set = Object.fromEntries(names.map(ch => [ch, Array.isArray(baked[ch][mid]) ? baked[ch][mid].map(v => Math.round(v * 1e5) / 1e5) : typeof baked[ch][mid] === "number" ? Math.round(baked[ch][mid] * 1e4) / 1e4 : baked[ch][mid]]));
		keys = merge(keys, [{ f: mid, set, src: "pass" }]); added++;
	}
	return { spec: { ...spec, keys }, added };
}

/** Fill policy from the measured limits: the model sprints rather than stretch time, so a gap whose floor travel beats walking speed is not
 * its job (FILL_GAP_TOO_FAR); a big change (hips 0.4 m, lying down, airborne) is filled but named. Root, pitch, feet: the compiled spec at the gap's ends. */
const WALK = 1.1, STAND_ANKLE = 0.11;
export function gapCheck(baked, fa, fb) {
	const a = baked.root?.[fa], b = baked.root?.[fb], seconds = (fb - fa) / 24, warnings = [];
	const travel = a && b ? Math.hypot(b[0] - a[0], b[2] - a[2]) : 0;
	if (a && b && Math.abs(b[1] - a[1]) >= 0.4) warnings.push(`f${fa}-f${fb}: the hips move ${Math.abs(b[1] - a[1]).toFixed(2)} m up or down; write the mid pose yourself if the fill looks wrong`);
	if (Math.abs(baked.pitch?.[fb] ?? 0) > 60) warnings.push(`f${fb}: the body lies down; the model fills lying poorly, write the mid pose`);
	const planted = k => (baked[`foot_${k}`]?.[fa]?.[1] ?? 0) <= STAND_ANKLE, up = k => (baked[`foot_${k}`]?.[fb]?.[1] ?? 0) > (baked[`foot_${k}`]?.[fa]?.[1] ?? 0) + 0.05;
	if (["l", "r"].some(k => planted(k) && up(k))) warnings.push(`f${fb}: a foot leaves the floor (a jump?); write the mid pose (knees bending, feet rising)`);
	const far = travel > seconds * WALK ? `FILL_GAP_TOO_FAR: f${fa}-f${fb} travels ${travel.toFixed(2)} m in ${seconds.toFixed(2)} s (over ${WALK} m/s, the model would sprint); add a pass-through pose every ~1 m with more frames, or use the walkTo skill for this leg` : null;
	return { travel, seconds, far, warnings };
}

/**
 * spec: a motion spec with 2+ authored key poses. ctx: { sk, compile: spec -> compileSpec result, run: async feed -> { out, tokens } }.
 * opts.at: re-fill only the gaps around this frame. opts.auto: a gap too far for the model is left to the compiler (noted) instead of
 * refusing the call. Returns { spec, gaps: [{ f: [fa, fb], tokens, frames, keys, ms } | { f, skipped }], calls, warnings }.
 */
export async function fillSpec(spec, { sk, compile, run }, { at, auto = false } = {}) {
	// a fill key someone edited is the author's from now on: it stays, and the gaps beside it fill again around it
	const promoted = (spec.keys ?? []).filter(editedFill).length;
	spec = { ...spec, keys: (spec.keys ?? []).map(k => (editedFill(k) ? Object.fromEntries(Object.entries(k).filter(([field]) => field !== "src")) : k)) };
	// auto (motion.compile): a gap under 8 frames stays the compiler's; one over 46 gets pass-through poses first
	const passed = auto ? passThrough(spec, compile) : { spec, added: 0 };
	spec = passed.spec;
	const gaps = fillGaps(spec.keys ?? [], at, auto ? MIN_AUTO_GAP : 2);
	// a gap whose two authored ends did not change keeps its fill (unless at names it)
	const ends = gaps.map(([fa, fb]) => shortHash(spec.keys.filter(k => !isFill(k) && (k.f === fa || k.f === fb)).map(k => [k.f, k.set])));
	const keep = gaps.map(([fa, fb], i) => { const inside = spec.keys.filter(k => isFill(k) && k.f > fa && k.f < fb); return at === undefined && inside.length > 0 && inside.every(k => fillGapOf(k) === ends[i]); });
	let keys = spec.keys.filter(k => !(isFill(k) && gaps.some(([fa, fb], i) => !keep[i] && k.f > fa && k.f < fb)));
	const report = [], warnings = [], skipped = [];
	for (const [i, [fa, fb]] of gaps.entries()) {
		if (keep[i]) { report.push({ f: [fa, fb], kept: true }); continue; }
		// one token count, the gap's own: the output is as long as the gap, never a sprint stretched to fit
		const tokens = tokensFor(fa, fb), r = compile({ ...spec, keys }), cache = new Map(), check = gapCheck(r.out.baked, fa, fb);
		// hand plants, flights and checked spans stay the author's (fill-spans.js)
		const reason = spanReason(spec, keys.filter(k => !isFill(k)), r.out.baked, fa, fb);
		if (reason) { skipped.push({ f: [fa, fb], reason }); report.push({ f: [fa, fb], skipped: reason }); continue; }
		warnings.push(...check.warnings);
		if (check.far) {
			if (!auto) throw new Error(check.far);
			skipped.push({ f: [fa, fb], reason: "too_far" }); report.push({ f: [fa, fb], skipped: check.far.replace(/^FILL_GAP_TOO_FAR: /, "compiler interpolation kept: ") });
			continue;
		}
		const poses = [...[3, 2, 1, 0].map(n => fa - n * STEP), ...[0, 1, 2, 3].map(n => fb + n * STEP)].map(t => poseAt(sk, r.out.frames, cache, t));
		const { feed, align } = encodePoses(poses, [tokens]);
		const t0 = performance.now(), res = await run(feed), ms = performance.now() - t0;
		const fill = sparseKeys(spanChannels(decodeMotion(res.out, res.tokens, align), fa, fb, r.out.baked), fa, ends[i]);
		keys = merge(keys, fill);
		report.push({ f: [fa, fb], tokens: res.tokens, frames: res.tokens * 4 - 6, keys: fill.length, ms: Math.round(ms) });
	}
	return { spec: { ...spec, keys }, gaps: report, calls: report.filter(g => !g.skipped && !g.kept).length, ...(skipped.length ? { skipped } : {}), ...(promoted ? { promoted } : {}),
		...(passed.added ? { passThrough: passed.added } : {}), ...(warnings.length ? { warnings } : {}) };
}

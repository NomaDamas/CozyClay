// C6. Hint fixes -> JSON Patch (RFC 6902, json-patch.js) on the agent's own spec.
//
// A hint function may return fix (non-enumerable on the group, never in the output):
//   { channel: "hand_l", f: 106, delta: [dx, dy, dz] | n }   move a keyed channel by delta at f
//   { channel: "elbow_r", f: 120, value: [x, y, z] | n }      set a channel at f
//   { path: "/fix/retime", value: true }                      set a spec path
//   { path: "/anchors/cupHandle/p", delta: [dx, dy, dz] }     move a spec value by delta
//   { channel: "root", f, delta, hold: true }                  move the body that stands at f
//   { ops: userSpec => [{ op, path, value }] }                 the operations for the agent's spec (a second hand: load.js)
//     + candidates: [ops, ...]                                 other ways to the same end, which compile repair alone can
//                                                              price: g.candidates (non-enumerable, never in the output)
// Each becomes g.patch = [{ op, path, value }] against opts.userSpec (the spec as the agent sent
// it, use[] not expanded): a user key that sets the channel within f +-2 -> replace
// /keys/<i>/set/<ch> (a delta: with the agent's keys next to it that hold the same value, so a held
// pose moves whole instead of sliding from one end to the other); a standIdle stance moved sideways -> /use/<i>/args/at; otherwise add
// /keys/- with the frame's value moved. A path fix replaces the value, or adds it when only the
// last step is missing (or the top-level /fix object). A hold fix moves what placed the body
// at f by the delta's x and z: a standIdle args.at, a walkTo's length (firstStep with 2 steps,
// else step; its to when steps follow from it), or the run of the agent's root keys around f.
// g.patch is set only when the patch applies to userSpec and changes it.
import { applyPatch } from "../json-patch.js";

const NEAR = 2;
const round4 = v => (Array.isArray(v) ? v.map(round4) : typeof v === "number" ? Math.round(v * 1e4) / 1e4 : v);
const tokens = path => path.split("/").slice(1).map(t => t.replaceAll("~1", "/").replaceAll("~0", "~"));
const pointer = parts => parts.map(t => `/${String(t).replaceAll("~", "~0").replaceAll("/", "~1")}`).join("");
const isNum = x => typeof x === "number" && Number.isFinite(x);

/** The value at a JSON pointer, or undefined. */
function valueAt(doc, parts) {
	let node = doc;
	for (const t of parts) {
		if (node === null || typeof node !== "object" || !Object.hasOwn(node, t)) return undefined;
		node = node[t];
	}
	return node;
}

/** v moved by d (same shape: a number, or a vector of numbers), else undefined. */
function moved(v, d) {
	if (isNum(v) && isNum(d)) return v + d;
	if (Array.isArray(v) && Array.isArray(d) && v.length === d.length && v.every(isNum) && d.every(isNum)) return v.map((x, i) => x + d[i]);
	return undefined;
}

/** The user key nearest f (within NEAR frames) that sets channel ch, as its index; -1 if none. */
function userKey(userSpec, ch, f) {
	let best = -1;
	(userSpec.keys ?? []).forEach((k, i) => {
		if (!k?.set || !Object.hasOwn(k.set, ch) || !isNum(k.f) || Math.abs(k.f - f) > NEAR) return;
		if (best < 0 || Math.abs(k.f - f) < Math.abs(userSpec.keys[best].f - f)) best = i;
	});
	return best;
}

/** a and b the same channel value (a number or a vector) within 1e-6. */
const same = (a, b) => (isNum(a) && isNum(b) ? Math.abs(a - b) <= 1e-6
	: Array.isArray(a) && Array.isArray(b) && a.length === b.length && a.every((x, j) => isNum(x) && isNum(b[j]) && Math.abs(x - b[j]) <= 1e-6));

/**
 * User key i and the agent's keys next to it in frame order (no other source's key of ch between) that set
 * ch to the same value: the hold a delta moves. The order is X.keys(ch) when the context has it, else the
 * agent's own keys by frame.
 */
function heldSpan(X, userSpec, ch, i) {
	const keys = userSpec.keys, held = j => j >= 0 && same(keys[j]?.set?.[ch], keys[i].set[ch]);
	const order = X?.keys ? X.keys(ch).map(k => Number(/^keys\[(\d+)\]$/.exec(k.src)?.[1] ?? -1))
		: keys.map((k, j) => j).filter(j => keys[j]?.set && Object.hasOwn(keys[j].set, ch) && isNum(keys[j].f)).sort((a, b) => keys[a].f - keys[b].f);
	const at = order.indexOf(i);
	if (at < 0) return [i];
	let a = at, b = at;
	while (a > 0 && held(order[a - 1])) a -= 1;
	while (b < order.length - 1 && held(order[b + 1])) b += 1;
	return order.slice(a, b + 1);
}

/** A standIdle stance moved by the root's sideways delta: /use/<i>/args/at. */
function standPatch(X, userSpec, fix, near) {
	const m = /^use\[(\d+)\] standIdle$/.exec(near?.src ?? ""), d = fix.delta;
	if (!m || fix.channel !== "root" || !Array.isArray(d) || Math.hypot(d[0], d[2]) < Math.abs(d[1])) return null;
	const i = Number(m[1]), u = userSpec.use?.[i], root = X.fr(near.f).c.root;
	if (u?.skill !== "standIdle") return null;
	const at = Array.isArray(u.args?.at) ? u.args.at : root && [root[0], root[2]];
	if (!at) return null;
	const value = round4(at.map((v, j) => v + (j === 0 ? d[0] : j === at.length - 1 ? d[2] : 0)));
	if (!u.args) return [{ op: "add", path: `/use/${i}/args`, value: { at: value } }];
	return [{ op: Object.hasOwn(u.args, "at") ? "replace" : "add", path: `/use/${i}/args/at`, value }];
}

/** A walkTo made longer or shorter by the delta along the body's heading at f (null when it is mostly sideways). */
function walkPatch(X, userSpec, i, fix) {
	const u = userSpec.use?.[i], a = u?.args ?? {}, d = fix.delta, h = (X.fr(fix.f).c.yaw ?? 0) * Math.PI / 180;
	const along = d[0] * Math.sin(h) + d[2] * Math.cos(h);
	if (u?.skill !== "walkTo" || Math.abs(d[0] * Math.cos(h) - d[2] * Math.sin(h)) > Math.abs(along)) return null;
	const set = (arg, value) => [u.args ? { op: Object.hasOwn(a, arg) ? "replace" : "add", path: `/use/${i}/args/${arg}`, value: round4(value) } : { op: "add", path: `/use/${i}/args`, value: { [arg]: round4(value) } }];
	if (a.steps === undefined && Array.isArray(a.to)) return set("to", a.to.map((v, j) => v + (j === 0 ? d[0] : j === a.to.length - 1 ? d[2] : 0)));
	const steps = a.steps ?? 8, arg = steps <= 2 ? "firstStep" : "step", now = a[arg] ?? (arg === "step" ? 0.5 : 0.4), value = now + along / Math.max(1, steps - 2);
	return steps >= 2 && value > 0.05 ? set(arg, value) : null;
}

/** The agent's root keys around f (no skill root key between them) moved by the delta's x and z. */
function rootRunPatch(X, userSpec, fix) {
	const list = X.keys("root"), mine = k => /^keys\[\d+\]$/.test(k.src);
	const at = list.findLastIndex(k => k.f <= fix.f);
	if (at < 0 || !mine(list[at])) return null;
	let a = at, b = at;
	while (a > 0 && mine(list[a - 1])) a -= 1;
	while (b < list.length - 1 && mine(list[b + 1])) b += 1;
	return list.slice(a, b + 1).map(k => {
		const j = Number(/\d+/.exec(k.src)[0]), r = userSpec.keys?.[j]?.set?.root;
		return Array.isArray(r) && r.length === 3 ? { op: "replace", path: `/keys/${j}/set/root`, value: round4([r[0] + fix.delta[0], r[1], r[2] + fix.delta[2]]) } : null;
	}).filter(Boolean);
}

/** fix.hold: what placed the body at f (the root key at or before it) moves. */
function bodyPatch(X, userSpec, fix) {
	if (!Array.isArray(fix.delta) || !X?.fr) return null;
	const prev = X.bracket("root", fix.f).prev, m = /^use\[(\d+)\] (standIdle|walkTo)\b/.exec(prev?.src ?? "");
	if (m?.[2] === "standIdle") return standPatch(X, userSpec, fix, prev);
	if (m?.[2] === "walkTo") return walkPatch(X, userSpec, Number(m[1]), fix);
	const run = prev && rootRunPatch(X, userSpec, fix);
	return run?.length ? run : null;
}

function channelPatch(X, userSpec, fix) {
	const { channel: ch, f } = fix;
	if (typeof ch !== "string" || !isNum(f)) return null;
	if (fix.hold) return bodyPatch(X, userSpec, fix);
	const to = v => (fix.value !== undefined ? fix.value : moved(v, fix.delta));
	const i = userKey(userSpec, ch, f);
	if (i >= 0) {
		const ops = (fix.delta !== undefined ? heldSpan(X, userSpec, ch, i) : [i]).map(j => {
			const value = to(userSpec.keys[j].set[ch]);
			return value === undefined ? null : { op: "replace", path: pointer(["keys", j, "set", ch]), value: round4(value) };
		});
		return ops.includes(null) ? null : ops;
	}
	if (!X?.fr) return null;
	const { prev, next } = X.bracket(ch, f);
	const near = prev && f - prev.f <= NEAR ? prev : next && next.f - f <= NEAR ? next : null;
	const stand = fix.delta !== undefined && standPatch(X, userSpec, fix, near);
	if (stand) return stand;
	const value = to(X.fr(f).c[ch]);
	return value === undefined ? null : [{ op: "add", path: "/keys/-", value: { f: Math.round(f), set: { [ch]: round4(value) } } }];
}

function pathPatch(userSpec, fix) {
	if (typeof fix.path !== "string" || !fix.path.startsWith("/")) return null;
	const parts = tokens(fix.path), now = valueAt(userSpec, parts);
	const value = fix.delta === undefined ? fix.value : now === undefined && fix.path.endsWith("/offset") ? fix.delta : moved(now, fix.delta);
	if (value === undefined) return null;
	if (now !== undefined) return [{ op: "replace", path: fix.path, value: round4(value) }];
	const parent = valueAt(userSpec, parts.slice(0, -1));
	if (parent !== undefined) return [{ op: "add", path: fix.path, value: round4(value) }];
	// a missing top-level object (spec.fix): add it with the one member
	if (parts.length === 2 && parts[0] === "fix") return [{ op: "add", path: pointer([parts[0]]), value: { [parts[1]]: round4(value) } }];
	return null;
}

/** The patch for one fix, or null when it does not apply mechanically or changes nothing. */
function patchOf(fix, X, userSpec) {
	const patch = fix.ops ? fix.ops(userSpec) : (fix.channel !== undefined ? channelPatch(X, userSpec, fix) : fix.path !== undefined ? pathPatch(userSpec, fix) : null);
	if (!patch) return null;
	try {
		return JSON.stringify(applyPatch(userSpec, patch)) === JSON.stringify(userSpec) ? null : patch;
	} catch {
		return null;
	}
}

/**
 * attachPatches(groups, { X, userSpec }) -> groups (the same array)
 * @param {object[]} groups  ranked QA groups, each maybe with a non-enumerable g.fix
 * @param {{ X: object, userSpec?: object }} ctx  X = the explain context (qa/explain.js: X.out,
 *   X.spec the expanded spec, X.keys(ch), X.bracket(ch, f)); userSpec undefined = no patches
 */
export function attachPatches(groups, { X, userSpec } = {}) {
	if (!userSpec || typeof userSpec !== "object") return groups;
	for (const g of groups) {
		if (!g.fix) continue;
		try {
			const patch = patchOf(g.fix, X, userSpec), more = patch && (g.fix.candidates ?? []).map(ops => patchOf({ ops }, X, userSpec)).filter(Boolean);
			if (patch) g.patch = patch;
			if (more?.length > 1) Object.defineProperty(g, "candidates", { value: more, enumerable: false, configurable: true });
		} catch {
			// a fix the context cannot place (no frame, no key table) gets no patch
		}
	}
	return groups;
}

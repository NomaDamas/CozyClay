// C6. Is one compile's QA better than another's: the one rule repair (repair.js) keeps a change by and the hint check
// (hint-check.js) offers a patch by. Better means all of
//   less       the summed severity (severity.js) drops
//   goals      no more goals fail, and every goal that held still holds
//   problems   no more issue groups than before, unless a HARD group is gone and every new group is SMALL: a second
//              hand that ends a LOAD may leave a forearm grazing the box, which the next repair round can finish
//   trade      what got worse (a new group, or a group whose severity rose) costs at most half of what got better
// Logs: a hint patch applied as sent made the take worse 49% of the time, and repair moved the root and broke the arms;
// a lower sum alone let a change through that traded one failure for several new ones.
import { groupKey } from "./severity.js";

const groupsOf = qa => qa?.groups ?? [];
const sevOf = qa => groupsOf(qa).reduce((sum, g) => sum + (g.severity ?? 0), 0);
const heldOf = qa => (qa?.goals ?? []).filter(g => g.ok).map(g => g.name);
const failedOf = qa => (qa?.goals ?? []).filter(g => !g.ok).length;
const TRADE = 0.5;
// failures the take cannot keep (a hand that cannot hold its load), and the severity (severity.js) a new group may have
// for a change that ends one to pass with more groups: 5 is a few frames just past a limit, never a held failure
const HARD = new Set(["LOAD"]), SMALL = 5;
const r2 = x => Math.round(x * 100) / 100;

/** The group severities by key (severity.js groupKey). */
function byKey(qa) {
	const m = new Map();
	for (const g of groupsOf(qa)) m.set(groupKey(g), (m.get(groupKey(g)) ?? 0) + (g.severity ?? 0));
	return m;
}

/**
 * compareQa(next, base) -> { better, why, sev: [base, next], problems: [base, next], worse: [{ key, severity: [a, b] }] }
 * why: the first rule that failed ("" when better); worse: the groups that got worse, worst first (at most 3).
 */
export function compareQa(next, base) {
	const a = byKey(base), b = byKey(next);
	let rise = 0, drop = 0;
	const worse = [];
	for (const [k, v] of b) { const was = a.get(k) ?? 0; if (v > was + 1e-9) { rise += v - was; worse.push({ key: k, severity: [r2(was), r2(v)] }); } else drop += was - v; }
	for (const [k, v] of a) if (!b.has(k)) drop += v;
	worse.sort((x, y) => y.severity[1] - y.severity[0] - (x.severity[1] - x.severity[0]));
	const sev = [r2(sevOf(base)), r2(sevOf(next))], problems = [groupsOf(base).length, groupsOf(next).length];
	const lost = heldOf(base).filter(n => !heldOf(next).includes(n));
	const ends = groupsOf(base).some(g => HARD.has(g.kind) && !b.has(groupKey(g))) && [...b].every(([k, v]) => a.has(k) || v <= SMALL);
	const why = !(sevOf(next) < sevOf(base) - 1e-9) ? `summed severity ${sev[0]} -> ${sev[1]}`
		: failedOf(next) > failedOf(base) || lost.length ? `goal ${lost.length ? `"${lost[0]}" no longer holds` : "failures rose"}`
			: problems[1] > problems[0] && !ends ? `problems ${problems[0]} -> ${problems[1]}`
				: rise > TRADE * drop + 1e-9 ? `${worse[0]?.key} got worse (${worse[0]?.severity.join(" -> ")})` : "";
	return { better: !why, why, sev, problems, worse: worse.slice(0, 3) };
}

/** next is no worse than base: no more problems (at as many, the summed severity does not rise), no more goals fail, none that held is lost. */
export const noWorse = (next, base) => (groupsOf(next).length < groupsOf(base).length || (groupsOf(next).length === groupsOf(base).length && sevOf(next) <= sevOf(base) + 1e-9))
	&& failedOf(next) <= failedOf(base) && heldOf(base).every(n => heldOf(next).includes(n));

/** Severity of the group with key `key` in qa (0 when it is gone). */
export const severityIn = (qa, key) => groupsOf(qa).filter(g => groupKey(g) === key).reduce((s, g) => s + (g.severity ?? 0), 0);

// A hybrid project's rig take that stopped paying: the compile result says so in one line, so the
// agent proposes capsule figures before more repairs instead of reading output.stuck as advisory
// (bin/agent/studio-prompt.mjs, the hybrid cast gate).

/** QA group kinds that a rig rarely repairs by more compiles: contact, collision, balance, body. */
export const HYBRID_HARD_KINDS = Object.freeze(["LOAD", "COLLIDE", "BODY", "SELF", "PERSON"]);
export const HYBRID_CAPSULE_HINT = "hybrid project: propose capsule figures to the user before more repairs";

/**
 * The hint for a compile in a project with this castStyle, or null. It fires in a hybrid project
 * only on a failing take (qa.ok false), when the repair watch said stuck or cap, or when the worst
 * non-GOAL group (qa.groups is ranked) is hard. A stuck note on a passing take (the watch's
 * "already passed QA" polish) is no reason to leave the rig.
 */
export function hybridCapsuleHint(castStyle, { stuck, qa } = {}) {
	if (castStyle !== "hybrid" || qa?.ok !== false) return null;
	const top = (qa?.groups ?? []).find(group => group.kind !== "GOAL");
	return stuck || HYBRID_HARD_KINDS.includes(top?.kind) ? HYBRID_CAPSULE_HINT : null;
}

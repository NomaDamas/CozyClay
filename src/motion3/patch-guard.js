// A check on a base + patch compile (deep research 5, 828 compile rounds):
//   PATCH_TOO_BROAD  more than 6 ops, or /anchors or /fix mixed with key edits: a note; the patch is still applied
//                    (patches of 7+ ops made 2.7 new problems per round, against 1-1.6)
const MAX_OPS = 6;
const head = op => String(op?.path ?? "").split("/")[1] ?? "";

/** The PATCH_TOO_BROAD note for a patch, or null. */
export function patchTooBroad(patch) {
	if (!Array.isArray(patch)) return null;
	const heads = new Set(patch.map(head)), mixed = heads.has("keys") ? ["anchors", "fix"].filter(h => heads.has(h)) : [];
	const why = [...(patch.length > MAX_OPS ? [`${patch.length} ops`] : []), ...(mixed.length ? [`/${mixed.join(" and /")} mixed with key edits`] : [])];
	return why.length ? `PATCH_TOO_BROAD ${why.join("; ")}: applied, but a fix touches only the key and channel the group's cause names, at most 2 ops per round; anchors or fix changes go in their own round` : null;
}

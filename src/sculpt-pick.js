// Part picking in Sculpt mode (#740 S7). Pure: no React, no DOM. A sculpt's
// meshes carry their part id as `userData.sculptPart` (sculpt-geometry.js); a
// mirrored copy's id ends in SCULPT_MIRROR_SUFFIX and resolves to the part the
// recipe actually holds, because that is the part an edit writes.
import { SCULPT_MIRROR_SUFFIX } from "./sculpt-recipe.js";

/** `{ partId, mirrored }` for a mesh's part id, or null when it has none. */
function resolveSculptPart(name) {
	if (typeof name !== "string" || !name) return null;
	const mirrored = name.endsWith(SCULPT_MIRROR_SUFFIX);
	return { partId: mirrored ? name.slice(0, -SCULPT_MIRROR_SUFFIX.length) : name, mirrored };
}

/**
 * The part nearest along the raycaster's ray among `roots` and their
 * descendants, or null on a miss. Only meshes tagged as sculpt parts count:
 * a hit on anything else (the turntable, an outline shell) is passed over.
 */
export function pickSculptPart(raycaster, roots) {
	const hits = raycaster.intersectObjects(roots, true);
	const hit = hits.find((entry) => entry.object.userData?.sculptPart);
	return hit ? resolveSculptPart(hit.object.userData.sculptPart) : null;
}

/**
 * The recipe's authored parts as an indented tree, parents before children
 * in recipe order: `{ id, shape, depth, parent, mirror }`. `mirror` is true
 * when the part is drawn twice, by its own flag or a mirrored ancestor's.
 */
export function sculptPartTree(recipe) {
	const parts = Array.isArray(recipe?.parts) ? recipe.parts : [];
	const rows = [];
	const visit = (parent, depth, mirrored) => {
		for (const part of parts) {
			if ((part.parent ?? null) !== parent) continue;
			const mirror = mirrored || part.mirror === true;
			rows.push({ id: part.id, shape: part.shape, depth, parent, mirror });
			visit(part.id, depth + 1, mirror);
		}
	};
	visit(null, 0, false);
	return rows;
}

/** The mesh ids a selected part draws as: the part and its mirrored copy. */
export function sculptPartMeshIds(selected) {
	return selected ? [selected.partId, `${selected.partId}${SCULPT_MIRROR_SUFFIX}`] : [];
}

/** An open menu or modal dialog owns Escape: the part selection waits until it has closed. */
export function overlayOwnsEscape(root = globalThis.document) {
	return Boolean(root?.querySelector?.('[role="menu"], [role="dialog"][aria-modal="true"], dialog[open]'));
}

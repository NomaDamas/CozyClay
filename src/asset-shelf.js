/**
 * Which stored images the Assets shelf may show.
 *
 * The asset store holds more than the user imported: cutting a background out
 * writes the matte mask and the cut render back as assets of their own, so a
 * raw `listAssetIds` would show every photograph twice and its purple mask
 * besides. The shelf's rule is SOURCE-vs-DERIVED:
 *
 *   show an id iff it is someone's ORIGINAL — a cutout's `sourceAssetId`, an
 *   unmatted cutout's `assetId`, or a stored picture no scene references —
 *   and hide the ids that exist only as machinery: a `matteAssetId`, or the
 *   rendered `assetId` of a matted cutout (`assetId !== sourceAssetId`).
 *
 * Source status wins a tie: duplicating a cut card before re-matting can make
 * one id both a rendered picture and another card's original, and a picture
 * anyone started from belongs on the shelf.
 *
 * Pure on purpose — ids and scene records in, ids out — so the node suite
 * (test/verify-asset-shelf.mjs) can pin the rule without a browser.
 */

import { isAssetId, isMeshAssetId, isSupportedMeshType } from "./scene-assets.js";
import { CUTOUT_KIND, MESH_KIND } from "./scene-objects.js";

/** A compact, locale-neutral byte label for the storage manager. */
export function formatAssetBytes(value) {
	const bytes = Math.max(0, Number(value) || 0);
	if (bytes < 1024) return `${Math.round(bytes)} B`;
	const units = ["KB", "MB", "GB"];
	const exponent = Math.min(Math.floor(Math.log(bytes) / Math.log(1024)), units.length);
	const amount = bytes / 1024 ** exponent;
	return `${amount >= 10 ? Math.round(amount) : Number(amount.toFixed(1))} ${units[exponent - 1]}`;
}

/** Some stored derivatives name themselves; leave unmarked records as images.
 * Meshes are identified by id or MIME so a GLB never appears as a picture in
 * the storage manager, even when its filename looks like a matte. */
export function assetKind(asset) {
	if (isMeshAssetId(asset?.id) || isSupportedMeshType(asset?.type)) return "mesh";
	return /\bmatte$/i.test(String(asset?.name ?? "").trim()) ? "matte" : "image";
}

/** The lineage walk both views share: which ids the scenes call source, and
 * which they call pipeline output. */
function classifyLineage(scenes) {
	const sources = new Set();
	const derived = new Set();
	for (const scene of Array.isArray(scenes) ? scenes : []) {
		for (const object of Array.isArray(scene?.objects) ? scene.objects : []) {
			if (object?.renderer === MESH_KIND) {
				if (isAssetId(object.assetId)) sources.add(object.assetId);
				continue;
			}
			if (object?.renderer !== CUTOUT_KIND) continue;
			const { assetId, sourceAssetId, matteAssetId } = object;
			if (isAssetId(sourceAssetId)) sources.add(sourceAssetId);
			if (isAssetId(assetId)) {
				// A cutout without lineage (or whose picture IS its original) is
				// unmatted; a differing pair means the picture on the card was
				// rendered by the matte and is not something the user imported.
				const matted = isAssetId(sourceAssetId) && sourceAssetId !== assetId;
				(matted ? derived : sources).add(assetId);
			}
			if (isAssetId(matteAssetId)) derived.add(matteAssetId);
		}
	}
	return { sources, derived };
}

/**
 * The ids the scenes prove to be pipeline outputs right now. The scan stamps
 * these onto their stored records (`role: "derived"`) so a store written
 * before the role field existed is backfilled while the proving cutout still
 * lives — once the card is deleted the lineage is gone and an unmarked
 * derivative would be indistinguishable from an import.
 */
export function derivedAssetIds(scenes) {
	const { sources, derived } = classifyLineage(scenes);
	return new Set([...derived].filter((id) => !sources.has(id)));
}

/** The stored ids the shelf shows, in stored order. */
export function sourceAssetIds(storedIds, scenes, derivedIds = new Set()) {
	const { sources, derived } = classifyLineage(scenes);
	for (const id of Array.isArray(derivedIds) || derivedIds instanceof Set ? derivedIds : []) derived.add(id);
	return (Array.isArray(storedIds) ? storedIds : []).filter(
		(id) => isAssetId(id) && (sources.has(id) || !derived.has(id)),
	);
}

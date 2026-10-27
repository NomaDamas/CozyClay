// Multi-view sculpt comparison (#970): one sculpt scored against several views
// of its subject (the blueprint's front, side and back crops), each by
// compareSculptToReference, then blended by weight into one IoU.
import { compareSculptToReference } from "./sculpt-compare.js";
import { patchSculptRecipe } from "./sculpt-recipe.js";

/** The default weight of each view: the front carries the likeness, the side the depth, the back the rest. */
export const VIEW_WEIGHTS = Object.freeze({ front: 0.6, side: 0.25, back: 0.15 });
/** A view whose subject's height:width differs from the front's by more than this is drawn at another scale or pose: weight 0. */
export const VIEW_RATIO_TOLERANCE = 0.35;

/** front (|yaw| <= 45), back (|yaw| >= 135) or side, from the camera yaw in degrees. */
export function viewOfYaw(yaw) {
	const turn = Math.abs(((Number(yaw) % 360) + 540) % 360 - 180);
	return turn <= 45 ? "front" : turn >= 135 ? "back" : "side";
}

/**
 * The weight each view gets. `views` are [{ yaw, weight?, heightToWidth }]:
 * an explicit weight replaces the table's; then any view whose height:width
 * differs from the front's by more than VIEW_RATIO_TOLERANCE gets weight 0 with
 * the reason. The front is the front view nearest yaw 0; without one the ratio
 * rule is skipped. Returns [{ weight, excluded? }] in the views' order.
 */
export function viewWeights(views) {
	const fronts = views.map((view, index) => ({ index, yaw: Math.abs(Number(view.yaw)) })).filter(({ index }) => viewOfYaw(views[index].yaw) === "front");
	const front = fronts.sort((a, b) => a.yaw - b.yaw)[0];
	const frontRatio = front ? views[front.index].heightToWidth : null;
	return views.map((view, index) => {
		const weight = view.weight ?? VIEW_WEIGHTS[viewOfYaw(view.yaw)];
		if (!front || index === front.index || !(frontRatio > 0)) return { weight };
		const difference = Math.abs(view.heightToWidth / frontRatio - 1);
		if (difference <= VIEW_RATIO_TOLERANCE) return { weight };
		return { weight: 0, excluded: `height:width ${view.heightToWidth.toFixed(2)} differs from the front's ${frontRatio.toFixed(2)} by ${Math.round(difference * 100)}% (over ${VIEW_RATIO_TOLERANCE * 100}%)` };
	});
}

const round = value => Number(value.toFixed(3));

/**
 * Score `recipe` against every view ([{ yaw, image, weight? }], images RGBA) and
 * blend the IoUs by weight. The report is the heaviest view's (its sheet too),
 * with `iou` the weighted one and `views` one row per view.
 */
function scoreViews(recipe, views, elevation, weights) {
	const results = views.map(view => compareSculptToReference(recipe, view.image, { yaw: view.yaw, elevation }));
	const used = weights ?? viewWeights(views.map((view, index) => ({ yaw: view.yaw, weight: view.weight, heightToWidth: 1 / results[index].report.widthToHeight.reference })));
	const total = used.reduce((sum, row) => sum + row.weight, 0);
	if (!(total > 0)) throw new Error("No view carries any weight: every view was excluded or given weight 0.");
	const primary = used.reduce((best, row, index) => (row.weight > used[best].weight ? index : best), 0);
	const iou = results.reduce((sum, result, index) => sum + result.report.iou * used[index].weight, 0) / total;
	const rows = results.map(({ report }, index) => ({ view: viewOfYaw(views[index].yaw), yaw: views[index].yaw, weight: round(used[index].weight / total), iou: report.iou,
		widthToHeight: report.widthToHeight, missingByBand: report.missingByBand, extraByPart: report.extraByPart.slice(0, 3), ...(used[index].excluded ? { excluded: used[index].excluded } : {}) }));
	return { result: { report: { ...results[primary].report, iou: round(iou), views: rows }, sheet: results[primary].sheet }, weights: used };
}

/**
 * The multi-view twin of scoreSculptAgainstReference: same return shape
 * ({ result, ranked?, refused? }), so sculpt.compare and compare_sculpt answer
 * one way. Candidates are scored on the same views with the same weights.
 */
export function scoreSculptAgainstViews(recipe, views, { elevation = 0, candidates } = {}) {
	if (!Array.isArray(views) || !views.length) throw new Error("views needs at least one { yaw, reference }.");
	const { result, weights } = scoreViews(recipe, views, elevation);
	if (!candidates) return { result };
	const ranked = [{ label: "current", result }];
	const refused = [];
	for (const candidate of candidates) {
		const patched = patchSculptRecipe(recipe, candidate.edits);
		if (!patched.ok) refused.push({ label: candidate.label, error: patched.error });
		else ranked.push({ label: candidate.label, result: scoreViews(patched.recipe, views, elevation, weights).result });
	}
	ranked.sort((a, b) => b.result.report.iou - a.result.report.iou);
	return { result, ranked, refused };
}

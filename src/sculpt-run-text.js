// The text of a sculpt run's turns (sculpt-run.js): the first turn's draft
// request, each refinement round's request, and the recipe rules both carry.

// The reference as sculpt.compare takes it: the stored asset when there is one.
export const referenceArg = reference => (reference?.assetId ? { assetId: reference.assetId } : { dataUrl: reference?.dataUrl });

// The recipe rules the agent needs to get object.sculpt right the first time (sculpt-recipe.js).
const RECIPE_RULES = "Recipe: { \"version\": 1, \"parts\": [{ \"id\", \"shape\", \"size\": [x,y,z] metres, \"position\": [x,y,z] centre, \"rotation\": [x,y,z] degrees, \"color\": \"#rrggbb\", \"parent\"?, \"mirror\"?, \"roundness\"? 0-1, \"taper\"? }] }. id: lowercase a-z, 0-9 and -, starting with a letter or digit, at most 40 characters. shape is exactly one of blob, box, cylinder, torus, frame, lathe, tube, extrude, loft, convex, scatter (no cone, sphere or other names): lathe { \"profile\": [[r 0-1, y 0-1], ...] } for turned forms (pot, bottle, bowl), tube { \"path\": [[x,y,z] each -0.5..0.5 of size], \"thickness\" m } for ropes, tails, handles and limbs that bend, extrude { \"outline\": [[x,y] -0.5..0.5] } for flat cut shapes (ears, fins, leaves, signs), loft { \"sections\": [{ \"y\", \"w\", \"d\" }, ...] } for bodies whose cross-section changes, convex { \"seed\" } for rocks. Any part may add \"detail\": { \"amount\": 0-1 } for a lumpy surface, \"gradient\": { \"color\" } for a two-tone blend, or \"op\": \"subtract\" to cut its parent (a mouth, a hollow). Up to 48 parts after mirrors. Floor is y=0 (feet touch it), front is +z, the subject's left is +x, mirror: true adds the reflection across x=0. roundness works backwards from its name: 0 is a smooth ellipsoid and 1 is a rounded box. roundness belongs only on blob, box and extrude, taper only on blob, cylinder and tube: leave both off the other shapes. Keep roundness at 0.2 or below on every organic part (body, belly, head, face, limbs); go above 0.3 only for hard-edged objects. Use box only for hard-edged things.";

// A compact score for the next turn: what is missing where, and which parts stick out.
function reportText(report) {
	if (!report) return "";
	const extra = Array.isArray(report.extraByPart) ? report.extraByPart.slice(0, 4) : report.extraByPart;
	return ` Score detail: ${JSON.stringify({ widthToHeight: report.widthToHeight, missingByBand: report.missingByBand, extraByPart: extra })}.`;
}

function outlineText(outline) {
	if (!outline) return "";
	return ` The harness measured the reference outline in pixels (front view; x is a fraction of the subject's height from its centre, + toward image right = the subject's own left; y is a fraction of height from the head top; spans are the filled runs across each slice): ${JSON.stringify(outline)}. Put parts on these measurements.`;
}

// The blueprint views attached after the reference (#970), named the way sculpt.compare reads yaw.
const VIEW_WORDS = { side: "camera on the subject's own left, so it faces image left", back: "camera behind the subject" };
function viewsText(views) {
	if (!views?.length) return "";
	return ` Also attached, after the reference: the blueprint's ${views.map(view => `${view.view} view (yaw ${view.yaw}, ${VIEW_WORDS[view.view] ?? "orthographic"})`).join(" and ")}. Take depth and what the front hides from them; the harness scores against the front and these views together, by weight.`;
}

export function makeTurnText(reference, sculptId, continuation, outline = null, views = []) {
	const ref = JSON.stringify(referenceArg(reference));
	if (continuation) {
		return [
			`Round ${continuation.round} of ${continuation.maxRounds}. The harness scored sculpt ${sculptId} at IoU ${continuation.iou ?? "unknown"} against the reference${views.length ? ` and the blueprint's ${views.map(view => view.view).join(" and ")} views (weighted)` : ""}.${reportText(continuation.report)}`,
			`Write 3-6 candidate edit sets that fix the biggest mismatch (proportion first, then placement), rank them with ONE run_action sculpt.compare { "id": "${sculptId}", "reference": ${ref}, "candidates": [{ "label", "edits" }] },`,
			`apply the best-ranked set with ONE run_action object.sculpt { "id": "${sculptId}", "edits": [...] }, then end the turn with one short line. Do not inspect first; the harness scores the result after your turn.`,
			RECIPE_RULES,
		].join(" ");
	}
	return [
		`Sculpt the subject of the attached reference image as a clay recipe.${viewsText(views)}`,
		outline
			? `Use the measured outline below, scaled to a real-world height in metres.${outlineText(outline)}`
			: "First measure the visible outline in the image: the subject's bounding box, then where the head top, each limb tip and the feet sit as fractions of its height, and convert them to metres for a real-world height.",
		sculptId
			? `Then rewrite sculpt ${sculptId} with ONE run_action object.sculpt { "id": "${sculptId}", "recipe": ... }, keeping parts on the measured landmarks.`
			: "Then create it with ONE run_action object.sculpt { \"name\", \"recipe\" }, keeping parts on the measured landmarks.",
		"No inspect calls are needed and do not call sculpt.compare: the harness scores the sculpt after your turn and tells you the result.",
		"End the turn with one short line naming what the image hides.",
		RECIPE_RULES,
	].join(" ");
}

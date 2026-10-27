// sculpt.compare: the editor's read-only way to score a sculpt against its
// reference, one view ({ reference, yaw }) or several weighted ones
// ({ views: [{ yaw, reference, weight }] }, #970). A job that never commits, so
// its receipt is `completed` with the score as output, authored false and no
// undo. The scoring is MCP compare_sculpt's (sculpt-compare.js, sculpt-views.js).
import { SCULPT_KIND } from '../scene-objects.js';
import { rankingRow, scoreSculptAgainstReference } from '../sculpt-compare.js';
import { scoreSculptAgainstViews } from '../sculpt-views.js';
import { browserSculptImages, shrinkRgba } from './sculpt-images.js';
import { fail } from './shared.js';
import { StudioSchemas } from '../studio-agent-protocol.js';

const id = StudioSchemas.TargetGuard.properties.targetId;
const input = (properties, required = Object.keys(properties)) => ({ type: 'object', properties, required, additionalProperties: false });
const openObject = { type: 'object', properties: {}, additionalProperties: true };
const yaw = { type: 'number', minimum: -180, maximum: 180 };
const reference = { oneOf: [input({ assetId: id }), input({ dataUrl: { type: 'string', pattern: '^data:image/(png|jpeg|webp|gif);base64,', maxLength: 6000000 } })] };
export const sculptCompare = { id: 'sculpt.compare', label: 'Compare a sculpt with its reference', kind: 'job', timeoutMs: 60000,
	description: 'Score a sculpt\'s silhouette against a reference image without changing anything: IoU, width-to-height delta, missing area by height band (top, middle, bottom), parts that stick out, and a reference | overlay sheet (grey both, red missing, blue extra) as sheetDataUrl. reference is { assetId } of a project image or { dataUrl }. yaw is the reference camera azimuth in degrees (0 in front, positive toward the subject\'s own left); omitted tries -45..45 and keeps the best. Instead of reference, views [{ yaw, reference, weight? }] scores several views of the subject (a blueprint\'s front 0, side 90, back 180) and blends their IoUs by weight (default front 0.6, side 0.25, back 0.15; a view whose height:width differs from the front\'s by more than 35% gets 0); the output adds one row per view. candidates (up to 12 { label, edits }) are scored from the same view(s) and ranked against the current sculpt; none is applied. Apply the winner with object.sculpt { id, edits }.',
	input: input({ id, reference, yaw, elevation: { type: 'number', minimum: -60, maximum: 60 },
		views: { type: 'array', minItems: 1, maxItems: 4, items: input({ yaw, reference, weight: { type: 'number', minimum: 0, maximum: 1 } }, ['yaw', 'reference']) },
		candidates: { type: 'array', minItems: 1, maxItems: 12, items: input({ label: { type: 'string', maxLength: 60 }, edits: { type: 'array', minItems: 1, maxItems: 48, items: openObject } }) } }, ['id']) };
// A receipt is at most 8 KiB, so the sheet is shrunk until the whole output fits this.
const SCULPT_COMPARE_OUTPUT_BYTES = 6500;

/** The run function for sculpt.compare; `objectOf` resolves an id or fails STALE_TARGET. */
export const runSculptCompare = (ports, objectOf) => async ({ id: objectId, reference, views, yaw, elevation = 0, candidates }, context) => {
	const target = objectOf(objectId);
	if (target.renderer !== SCULPT_KIND || !target.recipe) fail('INVALID_ARGUMENT', `${objectId} is a ${target.renderer}, not a sculpt.`);
	if ((reference === undefined) === (views === undefined)) fail('INVALID_ARGUMENT', 'Give exactly one of reference (one view) or views (several weighted views).');
	const images = ports.sculptImages ?? browserSculptImages;
	let decoded, scored;
	try { decoded = views ? await Promise.all(views.map(async view => ({ ...view, image: await images.decode(view.reference) }))) : await images.decode(reference); }
	catch (error) { fail('INVALID_ARGUMENT', `Could not read the reference image: ${error?.message || error}`); }
	context?.signal?.throwIfAborted();
	try { scored = views ? scoreSculptAgainstViews(target.recipe, decoded, { elevation, candidates }) : scoreSculptAgainstReference(target.recipe, decoded, { yaw, elevation, candidates }); }
	catch (error) { fail('INVALID_ARGUMENT', error?.message || String(error)); }
	const { result, ranked, refused } = scored;
	const output = { id: objectId, ...result.report };
	if (ranked) Object.assign(output, { ranking: [...ranked.map(row => rankingRow(row, result)), ...refused.map(({ label, error }) => ({ label, refused: error }))],
		sheetLabel: ranked[0].label, note: `Nothing was applied. Apply the winner with object.sculpt { id: "${objectId}", edits }.` });
	const sheet = (ranked ? ranked[0].result : result).sheet;
	const room = SCULPT_COMPARE_OUTPUT_BYTES - JSON.stringify(output).length;
	// The full-size sheet is always tried, however narrow; shrinking stops at 64 px.
	for (let factor = 1; factor === 1 || sheet.width / factor >= 64; factor *= 2) {
		const dataUrl = await images.encodePng(factor === 1 ? sheet : shrinkRgba(sheet, factor));
		if (dataUrl.length + 40 <= room) { Object.assign(output, { sheetDataUrl: dataUrl, ...(factor > 1 ? { sheetScale: 1 / factor } : {}) }); break; }
	}
	if (!output.sheetDataUrl) output.sheetOmitted = 'The overlay sheet does not fit in a receipt at a readable size; read missingByBand and extraByPart.';
	const lead = ranked ? `best ${ranked[0].label} at IoU ${ranked[0].result.report.iou} (current ${result.report.iou}), ${candidates.length} candidates scored, none applied` : `IoU ${result.report.iou}`;
	const where = views ? `${views.length} weighted views (${result.report.views.map(row => `${row.view} ${row.weight}`).join(', ')})` : `the reference at yaw ${result.report.view.yaw}`;
	return { affectedIds: [], output, summary: `Compared ${target.name || objectId} with ${where}: ${lead}.` };
};

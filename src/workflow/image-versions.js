/**
 * Version history for the Image node. Every generation is kept so an author
 * can step back to an earlier take, A/B two of them, and regenerate against
 * the very same inputs. Free of React and of the DOM so the rules are
 * testable with plain node data objects.
 */

/** How many generations a node keeps. Data URLs are large and the whole graph
 * lives in localStorage, so the history is deliberately short. */
export const MAX_VERSIONS = 12;

const list = (data) => (Array.isArray(data?.versions) ? data.versions : []);

/** The versions array plus the index the node currently shows. */
export function versionState(data) {
	const versions = list(data);
	if (!versions.length) return { versions, index: -1, current: null };
	const index = Math.min(Math.max(Number.isInteger(data?.versionIndex) ? data.versionIndex : versions.length - 1, 0), versions.length - 1);
	return { versions, index, current: versions[index] };
}

/**
 * Append one generation. Returns the node data patch: the capped versions
 * array, the new index, and the outputs/resultUrl the rest of the graph reads.
 */
export function appendVersion(data, entry) {
	const versions = [...list(data), { ...entry }].slice(-MAX_VERSIONS);
	const index = versions.length - 1;
	return { versions, versionIndex: index, outputs: [{ value: versions[index].dataUrl }], resultUrl: versions[index].dataUrl };
}

/** Move the shown version. Out-of-range indices clamp, so prev/next at the
 * ends are no-ops rather than blanking the preview. */
export function selectVersion(data, index) {
	const versions = list(data);
	if (!versions.length) return { versions, versionIndex: 0, outputs: [], resultUrl: null };
	const next = Math.min(Math.max(Math.trunc(Number(index) || 0), 0), versions.length - 1);
	return { versions, versionIndex: next, outputs: [{ value: versions[next].dataUrl }], resultUrl: versions[next].dataUrl };
}

/**
 * The frame and reference a run should use. With `pinReferences` on, the
 * pinned version's inputs win over whatever the edges resolve to this run, so
 * only the prompt changes between takes. Falls back to the upstream values
 * whenever nothing is pinned or the pinned entry lacks a frame.
 */
export function pinnedInputs(data, fallback = {}) {
	const source = fallback.source ?? null;
	const reference = fallback.reference ?? null;
	if (!data?.pinReferences) return { source, reference, pinned: false };
	const { current } = versionState(data);
	if (!current?.frameDataUrl) return { source, reference, pinned: false };
	return { source: current.frameDataUrl, reference: current.referenceDataUrl ?? null, pinned: true };
}

/** Index of the second image in an A/B comparison, clamped into range. */
export function compareIndex(data) {
	const { versions, index } = versionState(data);
	if (versions.length < 2) return index;
	const raw = Number.isInteger(data?.abIndex) ? data.abIndex : index - 1;
	const clamped = Math.min(Math.max(raw, 0), versions.length - 1);
	return clamped === index ? (index === 0 ? 1 : index - 1) : clamped;
}

/** Toolbar label: 1-based position over the total, e.g. "3/5". */
export function versionLabel(data) {
	const { versions, index } = versionState(data);
	return versions.length ? `${index + 1}/${versions.length}` : "0/0";
}

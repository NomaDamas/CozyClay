/**
 * Project resource manifest: everything a project points at, and whether the
 * bytes are here.
 *
 * A `.cclayproject` is only portable when every picture, motion clip, pose
 * and workflow output it names travels with it. This module answers "which
 * ones do, which ones live on a server, and which ones are gone" from the
 * documents already in memory. It is a runtime calculation: nothing here is
 * written to the file, and nothing here decodes or hashes bytes.
 *
 * Statuses:
 *   embedded  — the record is in `assets` / `motions` / `poseLibrary`, or the
 *               workflow output is a data: URL that will be interned on save.
 *   external  — reachable by URL only (a bridge take, an http(s) output).
 *   missing   — nothing to load. An image that the browser still holds in
 *               IndexedDB is flagged `stored: true` so the integrator can
 *               offer to embed it instead of reporting it lost.
 *
 * Inputs are never trusted: a scene document mid-migration, a half-written
 * library entry or a garbage id produce fewer items, never a throw.
 */
import { isAssetId } from "./scene-assets.js";

/** Lineage fields on a scene object, in `assetUsageCounts` order: the card's
 * rendered picture, the photograph it was cut from, and the selection mask. */
const IMAGE_LINEAGE_FIELDS = Object.freeze(["assetId", "sourceAssetId", "matteAssetId"]);

const STATUS_RANK = Object.freeze({ embedded: 2, external: 1, missing: 0 });

function plainObject(value) {
	return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function nonEmptyString(value) {
	return typeof value === "string" && value ? value : null;
}

/** Decoded size of a base64 string, without decoding it. */
function base64ByteLength(text) {
	const clean = text.replace(/\s+/g, "");
	if (!clean) return 0;
	const padding = clean.endsWith("==") ? 2 : clean.endsWith("=") ? 1 : 0;
	return Math.max(0, Math.floor((clean.length * 3) / 4) - padding);
}

/** Byte count of a record's payload however it is held: a stored asset has
 * an ArrayBuffer, a project file has base64, a motion record has a number. */
function byteSize(value) {
	if (typeof value === "number") return Number.isFinite(value) && value >= 0 ? value : null;
	if (value instanceof ArrayBuffer) return value.byteLength;
	if (ArrayBuffer.isView(value)) return value.byteLength;
	if (typeof value === "string") return base64ByteLength(value);
	return null;
}

function dataUrlByteLength(url) {
	const comma = url.indexOf(",");
	if (comma < 0) return 0;
	const header = url.slice(0, comma);
	const payload = url.slice(comma + 1);
	return /;base64$/i.test(header) ? base64ByteLength(payload) : payload.length;
}

/** Records keyed by their id, from an array, a Map or an id-keyed object.
 * The first record wins so a duplicated id cannot flip a status. */
function recordsById(source, key) {
	const map = new Map();
	const add = (record, fallbackId) => {
		const id = nonEmptyString(record?.[key]) ?? nonEmptyString(fallbackId);
		if (id && !map.has(id)) map.set(id, plainObject(record) ? record : {});
	};
	if (source instanceof Map) for (const [id, record] of source) add(record, id);
	else if (Array.isArray(source)) for (const record of source) add(record);
	else if (plainObject(source)) for (const [id, record] of Object.entries(source)) add(record, id);
	return map;
}

function idSet(source) {
	const out = new Set();
	const iterable = source instanceof Map ? source.keys() : source;
	if (!iterable || typeof iterable === "string" || typeof iterable[Symbol.iterator] !== "function") return out;
	for (const id of iterable) if (typeof id === "string") out.add(id);
	return out;
}

function deepEqual(a, b) {
	if (a === b) return true;
	if (Array.isArray(a) || Array.isArray(b)) {
		if (!Array.isArray(a) || !Array.isArray(b) || a.length !== b.length) return false;
		return a.every((value, index) => deepEqual(value, b[index]));
	}
	if (plainObject(a) && plainObject(b)) {
		const keys = Object.keys(a);
		if (keys.length !== Object.keys(b).length) return false;
		return keys.every((key) => Object.hasOwn(b, key) && deepEqual(a[key], b[key]));
	}
	return false;
}

function scenesOf(scenesDocument) {
	return Array.isArray(scenesDocument?.scenes) ? scenesDocument.scenes : [];
}

function objectsOf(scene) {
	return Array.isArray(scene?.objects) ? scene.objects : [];
}

function charactersOf(scene) {
	return Array.isArray(scene?.stage?.characters) ? scene.stage.characters : [];
}

/**
 * One item per (kind, id). A second sighting of the same resource only adds
 * a ref — unless it resolves BETTER (a character that carries a url for a
 * motion another character names by id alone), in which case the status is
 * upgraded so the manifest is not order-dependent.
 */
function collector(kind) {
	const items = new Map();
	return {
		items,
		note(id, resolution, ref) {
			let item = items.get(id);
			if (!item) {
				item = { kind, id, status: "missing", refs: [] };
				items.set(id, item);
			}
			if (STATUS_RANK[resolution.status] >= STATUS_RANK[item.status]) {
				item.status = resolution.status;
				if (Number.isFinite(resolution.bytes)) item.bytes = resolution.bytes;
				if (resolution.url) item.url = resolution.url;
			}
			if (resolution.stored) item.stored = true;
			if (ref) item.refs.push(ref);
			return item;
		},
	};
}

function resolveImage(id, assetsById, storedIds) {
	const stored = storedIds.has(id);
	const asset = assetsById.get(id);
	if (asset) return { status: "embedded", bytes: byteSize(asset.bytes), stored };
	return { status: "missing", stored };
}

function resolveMotion(motionId, url, motionsById) {
	const record = motionId ? motionsById.get(motionId) : null;
	if (record) return { status: "embedded", bytes: byteSize(record.bytes) ?? byteSize(record.data) };
	if (url) return { status: "external", url };
	return { status: "missing" };
}

function defaultWorkflowOutputRefs() {
	return [];
}

/**
 * The manifest.
 *
 * `workflowOutputRefs(graph)` is injected rather than imported so this module
 * does not depend on the workflow track landing first; without it, the
 * workflow contributes nothing. Its contract: an array of
 * `{ nodeId, field, value, kind: "data-url"|"http"|"asset-ref"|"blob"|"other" }`.
 */
export function resourceManifest(options) {
	const {
		scenesDocument,
		workflow,
		poseLibrary,
		assets,
		motions,
		storedAssetIds,
		workflowOutputRefs,
	} = plainObject(options) ? options : {};

	const assetsById = recordsById(assets, "id");
	const motionsById = recordsById(motions, "motionId");
	const storedIds = idSet(storedAssetIds);
	const scenes = scenesOf(scenesDocument);

	const images = collector("image");
	const motionItems = collector("motion");
	const poses = collector("pose");
	const outputs = collector("workflow-output");

	/* ---- images: every lineage id on every scene object ---- */
	for (const scene of scenes) {
		const sceneId = nonEmptyString(scene?.id) ?? undefined;
		for (const object of objectsOf(scene)) {
			if (!plainObject(object)) continue;
			const objectId = nonEmptyString(object.id) ?? undefined;
			for (const field of IMAGE_LINEAGE_FIELDS) {
				const id = object[field];
				if (!isAssetId(id)) continue;
				images.note(id, resolveImage(id, assetsById, storedIds), { sceneId, objectId, field });
			}
		}
	}

	/* ---- motions: motionId (embedded) → url (external) → missing ---- */
	for (const scene of scenes) {
		const sceneId = nonEmptyString(scene?.id) ?? undefined;
		for (const character of charactersOf(scene)) {
			const ref = character?.motionRef;
			if (!plainObject(ref)) continue;
			const motionId = nonEmptyString(ref.motionId);
			const url = nonEmptyString(ref.url);
			const id = motionId ?? url;
			if (!id) continue;
			const characterId = nonEmptyString(character.id) ?? undefined;
			motionItems.note(id, resolveMotion(motionId, url, motionsById), { sceneId, characterId, field: "motionRef" });
		}
	}

	/* ---- poses: the library is embedded; a character wearing one is a ref ---- */
	const library = [];
	for (const entry of Array.isArray(poseLibrary) ? poseLibrary : []) {
		if (!plainObject(entry) || !plainObject(entry.bones)) continue;
		const id = nonEmptyString(entry.id);
		if (!id || poses.items.has(id)) continue;
		poses.note(id, { status: "embedded" });
		library.push({ id, bones: entry.bones });
	}
	if (library.length) {
		for (const scene of scenes) {
			const sceneId = nonEmptyString(scene?.id) ?? undefined;
			for (const character of charactersOf(scene)) {
				const bones = character?.pose?.bones;
				if (!plainObject(bones)) continue;
				const match = library.find((entry) => deepEqual(entry.bones, bones));
				if (!match) continue;
				poses.note(match.id, { status: "embedded" }, { sceneId, characterId: nonEmptyString(character.id) ?? undefined, field: "pose" });
			}
		}
	}

	/* ---- workflow outputs: what a node is holding on to ---- */
	const refs = (typeof workflowOutputRefs === "function" ? workflowOutputRefs : defaultWorkflowOutputRefs)(workflow);
	for (const ref of Array.isArray(refs) ? refs : []) {
		if (!plainObject(ref)) continue;
		const nodeId = nonEmptyString(ref.nodeId);
		const field = nonEmptyString(ref.field);
		if (!nodeId || !field) continue;
		const location = { nodeId, field };
		const id = `${nodeId}:${field}`;
		const { value } = ref;
		if (ref.kind === "data-url" && typeof value === "string") {
			outputs.note(id, { status: "embedded", bytes: dataUrlByteLength(value) }, location);
		} else if (ref.kind === "http" && typeof value === "string") {
			outputs.note(id, { status: "external", url: value }, location);
		} else if (ref.kind === "asset-ref") {
			// An interned output IS an image: the picture item gains the node as
			// a ref, and the output mirrors its status without recounting bytes.
			const assetId = typeof value === "string" ? value : value?.assetRef;
			if (isAssetId(assetId)) {
				const resolution = resolveImage(assetId, assetsById, storedIds);
				images.note(assetId, resolution, location);
				outputs.note(id, { status: resolution.status, stored: resolution.stored }, location);
			} else {
				outputs.note(id, { status: "missing" }, location);
			}
		} else {
			// blob: URLs die with the page; anything else is unrecognisable.
			outputs.note(id, { status: "missing", url: typeof value === "string" && !value.startsWith("data:") ? value : undefined }, location);
		}
	}

	const items = [...images.items.values(), ...motionItems.items.values(), ...poses.items.values(), ...outputs.items.values()];
	const totals = { embedded: 0, external: 0, missing: 0, bytes: 0 };
	for (const item of items) {
		totals[item.status] += 1;
		if (Number.isFinite(item.bytes)) totals.bytes += item.bytes;
	}
	return { items, totals, missing: items.filter((item) => item.status === "missing") };
}

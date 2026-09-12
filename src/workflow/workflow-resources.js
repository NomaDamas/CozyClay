/**
 * Workflow outputs as project resources (#230).
 *
 * Image, Video, Scene and Upload nodes keep what they produced inline in node
 * data as data: URLs. Left alone, a `.cclayproject` carries every generated
 * PNG twice over (resultUrl, outputs[0].value, each version) and nothing tells
 * the author which of those pictures will survive a move to another browser.
 * This module gives the save path a way to pull those pictures out into the
 * project's content-addressed `resources.assets` and the open path a way to
 * put them back, so the running graph never learns the file changed shape.
 *
 * Only `data:image/*` URLs of a type the asset store accepts are interned.
 * Video data URLs, blob: URLs and http(s) URLs stay in place and are merely
 * classified so the resource manifest can report them. Everything else in a
 * node's data is passed through untouched, by reference.
 *
 * No React, no DOM: `atob`/`btoa` and Web Crypto exist in the browser and in
 * Node, so the intern -> resolve round trip is verifiable under Node.
 */

import { ASSET_IMAGE_TYPES, ASSET_MAX_SOURCE_BYTES, assetIdForBytes as defaultAssetIdForBytes, isAssetId } from "../scene-assets.js";

/** The node-data fields a generated output can land in. `[]` marks an array. */
export const WORKFLOW_OUTPUT_FIELDS = Object.freeze([
	"resultUrl",
	"videoUrl",
	"lastOutput.renderUrl",
	"lastOutput.sceneUrl",
	"versions[].dataUrl",
	"fileUrl",
	"outputs[].value",
]);

function plainRecord(value) {
	if (!value || typeof value !== "object") return false;
	const prototype = Object.getPrototypeOf(value);
	return prototype === Object.prototype || prototype === null;
}

/** A value already swapped for an embedded asset: `{ assetRef: "img-…" }`. */
export function isAssetRef(value) {
	return plainRecord(value) && isAssetId(value.assetRef);
}

/** Classify one output value; null for values that are not an output at all. */
export function outputKind(value) {
	if (isAssetRef(value)) return "asset-ref";
	if (typeof value !== "string") return null;
	if (/^data:/i.test(value)) return "data-url";
	if (/^https?:\/\//i.test(value)) return "http";
	if (/^blob:/i.test(value)) return "blob";
	return value.trim() ? "other" : null;
}

/* ------------------------------------------------------------- paths ---- */

function outputPaths(data) {
	const paths = [["resultUrl"], ["videoUrl"], ["lastOutput", "renderUrl"], ["lastOutput", "sceneUrl"], ["fileUrl"]];
	if (Array.isArray(data.versions)) data.versions.forEach((_, index) => paths.push(["versions", index, "dataUrl"]));
	if (Array.isArray(data.outputs)) data.outputs.forEach((_, index) => paths.push(["outputs", index, "value"]));
	return paths;
}

function fieldName(path) {
	return path.map((key, index) => (typeof key === "number" ? `[${key}]` : index ? `.${key}` : key)).join("");
}

function getPath(data, path) {
	let value = data;
	for (const key of path) {
		if (!value || typeof value !== "object") return undefined;
		value = value[key];
	}
	return value;
}

/** Copy-on-write along `path`; every untouched sibling keeps its identity. */
function setPath(data, path, value) {
	if (!path.length) return value;
	const [key, ...rest] = path;
	const copy = Array.isArray(data) ? [...data] : { ...data };
	copy[key] = setPath(data[key], rest, value);
	return copy;
}

function nodesOf(graph) {
	return Array.isArray(graph?.nodes) ? graph.nodes : null;
}

/** Walk every output slot of every node, replacing values through `visit`. */
async function mapOutputs(graph, visit) {
	const nodes = [];
	for (const node of nodesOf(graph)) {
		if (!plainRecord(node) || !plainRecord(node.data)) {
			nodes.push(node);
			continue;
		}
		let data = node.data;
		for (const path of outputPaths(data)) {
			const value = getPath(data, path);
			const next = await visit(value);
			if (next !== value) data = setPath(data, path, next);
		}
		nodes.push(data === node.data ? node : { ...node, data });
	}
	return { ...graph, nodes };
}

/* -------------------------------------------------------------- refs ---- */

/**
 * Every output slot that holds something, with where it lives and what it is.
 * `field` reads like a path (`versions[2].dataUrl`) so a manifest row can point
 * the author at the exact slot.
 */
export function workflowOutputRefs(graph) {
	const refs = [];
	for (const node of nodesOf(graph) ?? []) {
		if (!plainRecord(node) || typeof node.id !== "string" || !plainRecord(node.data)) continue;
		for (const path of outputPaths(node.data)) {
			const value = getPath(node.data, path);
			const kind = outputKind(value);
			if (kind) refs.push({ nodeId: node.id, field: fieldName(path), value, kind });
		}
	}
	return refs;
}

/* ----------------------------------------------------------- data URLs -- */

function bytesToBase64(bytes) {
	let binary = "";
	for (let offset = 0; offset < bytes.length; offset += 0x8000) binary += String.fromCharCode(...bytes.subarray(offset, offset + 0x8000));
	return btoa(binary);
}

const IMAGE_DATA_URL = /^data:(image\/[a-z0-9.+-]+);base64,([A-Za-z0-9+/]+={0,2})$/;

/**
 * Decode a data URL the asset store can hold. Returns null for anything that
 * would not come back byte-for-byte identical from the stored record — an
 * unsupported type, a non-canonical encoding, an oversized picture — so such
 * a value is left in the graph exactly as it was.
 */
function parseImageDataUrl(value) {
	const match = typeof value === "string" ? IMAGE_DATA_URL.exec(value) : null;
	if (!match) return null;
	const [, type, base64] = match;
	if (!ASSET_IMAGE_TYPES.includes(type) || base64.length % 4) return null;
	let bytes;
	try {
		bytes = Uint8Array.from(atob(base64), (char) => char.charCodeAt(0));
	} catch {
		return null;
	}
	if (!bytes.byteLength || bytes.byteLength > ASSET_MAX_SOURCE_BYTES || bytesToBase64(bytes) !== base64) return null;
	return { type, bytes };
}

/**
 * Pixel size from the container header, no decoder needed. The asset record
 * needs a positive width/height to pass `normalizeAsset`; a picture whose
 * header cannot be read is not interned rather than embedded as a record the
 * reader would drop.
 */
export function imageDimensions(bytes) {
	const b = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
	const view = new DataView(b.buffer, b.byteOffset, b.byteLength);
	const ascii = (offset, length) => String.fromCharCode(...b.subarray(offset, offset + length));
	const size = (width, height) => (width > 0 && height > 0 ? { width, height } : null);
	try {
		if (b[0] === 0x89 && ascii(1, 3) === "PNG") return size(view.getUint32(16), view.getUint32(20));
		if (ascii(0, 4) === "GIF8") return size(view.getUint16(6, true), view.getUint16(8, true));
		if (ascii(0, 4) === "RIFF" && ascii(8, 4) === "WEBP") {
			const chunk = ascii(12, 4);
			if (chunk === "VP8 ") return size(view.getUint16(26, true) & 0x3fff, view.getUint16(28, true) & 0x3fff);
			if (chunk === "VP8L") return size(1 + (((b[22] & 0x3f) << 8) | b[21]), 1 + (((b[24] & 0x0f) << 10) | (b[23] << 2) | ((b[22] & 0xc0) >> 6)));
			if (chunk === "VP8X") return size(1 + (b[24] | (b[25] << 8) | (b[26] << 16)), 1 + (b[27] | (b[28] << 8) | (b[29] << 16)));
			return null;
		}
		if (b[0] === 0xff && b[1] === 0xd8) {
			let offset = 2;
			while (offset + 9 < b.length) {
				if (b[offset] !== 0xff) return null;
				const marker = b[offset + 1];
				if (marker === 0xff) { offset += 1; continue; }
				// SOF0..SOF15 carry the frame size; C4/C8/CC are tables, not frames.
				if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) return size(view.getUint16(offset + 7), view.getUint16(offset + 5));
				if (marker === 0x01 || (marker >= 0xd0 && marker <= 0xd8)) { offset += 2; continue; }
				offset += 2 + view.getUint16(offset + 2);
			}
		}
	} catch {
		// A truncated header: fall through to "unknown size".
	}
	return null;
}

/* --------------------------------------------------------- intern/resolve */

/**
 * Save path. Every `data:image/*` output becomes `{ assetRef }` and the bytes
 * come back once per distinct picture as an asset record in the shape the
 * asset store and `createProjectDocument` already take (`bytes` is an
 * ArrayBuffer). The input graph is not mutated; untouched node data keeps its
 * identity so a later deep-equal proves nothing else moved.
 */
export async function internWorkflowOutputs(graph, { assetIdForBytes = defaultAssetIdForBytes } = {}) {
	if (!nodesOf(graph)) return { graph, assets: [] };
	const assets = new Map();
	const idsByUrl = new Map();
	const next = await mapOutputs(graph, async (value) => {
		if (typeof value !== "string" || !value.startsWith("data:image/")) return value;
		let id = idsByUrl.get(value);
		if (!id) {
			const parsed = parseImageDataUrl(value);
			const dimensions = parsed && imageDimensions(parsed.bytes);
			if (!dimensions) return value;
			id = await assetIdForBytes(parsed.bytes);
			idsByUrl.set(value, id);
			if (!assets.has(id)) assets.set(id, { id, type: parsed.type, ...dimensions, name: "", role: "workflow-output", bytes: parsed.bytes.buffer });
		}
		return { assetRef: id };
	});
	return { graph: next, assets: [...assets.values()] };
}

function assetLookup(assetsById) {
	if (assetsById instanceof Map) return (id) => assetsById.get(id) ?? null;
	if (Array.isArray(assetsById)) {
		const byId = new Map(assetsById.filter((asset) => asset && typeof asset.id === "string").map((asset) => [asset.id, asset]));
		return (id) => byId.get(id) ?? null;
	}
	return (id) => (plainRecord(assetsById) && Object.prototype.hasOwnProperty.call(assetsById, id) ? assetsById[id] : null);
}

function assetBytes(asset) {
	if (asset?.bytes instanceof ArrayBuffer) return new Uint8Array(asset.bytes);
	if (ArrayBuffer.isView(asset?.bytes)) return new Uint8Array(asset.bytes.buffer, asset.bytes.byteOffset, asset.bytes.byteLength);
	return null;
}

/**
 * Open path. Every `{ assetRef }` becomes the data URL the node had before
 * the save, so the runtime node shape is what the canvas already renders. A
 * ref whose asset is not in `assetsById` is left as it is: the manifest reports
 * it as missing instead of the graph quietly losing the slot.
 */
export function resolveWorkflowOutputs(graph, assetsById) {
	if (!nodesOf(graph)) return graph;
	const lookup = assetLookup(assetsById);
	const urls = new Map();
	const nodes = [];
	for (const node of graph.nodes) {
		if (!plainRecord(node) || !plainRecord(node.data)) {
			nodes.push(node);
			continue;
		}
		let data = node.data;
		for (const path of outputPaths(data)) {
			const value = getPath(data, path);
			if (!isAssetRef(value)) continue;
			const id = value.assetRef;
			if (!urls.has(id)) {
				const asset = lookup(id);
				const bytes = assetBytes(asset);
				urls.set(id, bytes && typeof asset.type === "string" ? `data:${asset.type};base64,${bytesToBase64(bytes)}` : null);
			}
			const url = urls.get(id);
			if (url) data = setPath(data, path, url);
		}
		nodes.push(data === node.data ? node : { ...node, data });
	}
	return { ...graph, nodes };
}

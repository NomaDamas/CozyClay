/**
 * Pictures the author attaches to a turn (#367).
 *
 * Kept free of React and of the DOM it cannot inject: the composer hands this
 * module a File that arrived by paste or drop, and it decides what actually
 * travels in the turn body. A region screenshot is a PNG, and a retina PNG is
 * tens of megabytes of losslessly encoded desktop — more than the envelope
 * carries and more than the model needs — so anything over the budget is
 * decoded once, capped to 1600px on its longest side and re-encoded as JPEG.
 * Anything under it is sent verbatim: no re-encode, no generation loss.
 */
import { fileToDataUrl, imageFileFromTransfer } from "./clipboard-image.js";

export const ATTACHMENT_MAX_COUNT = 4;
export const ATTACHMENT_MAX_DIMENSION = 1600;
export const ATTACHMENT_MAX_BYTES = 4 * 1024 * 1024;
export const ATTACHMENT_JPEG_QUALITY = 0.85;
/** The turn envelope accepts exactly these three, so the composer refuses the
 * rest here rather than letting the sidecar reject a turn the author sent. */
export const ATTACHMENT_TYPES = Object.freeze(["image/png", "image/jpeg", "image/webp"]);
export const ATTACHMENT_LIMIT_NOTICE = "Up to 4 images per message";
export const ATTACHMENT_TYPE_NOTICE = "Attach a PNG, JPEG or WebP image";
export const ATTACHMENT_FAILED_NOTICE = "That image could not be attached";

const EXTENSION_TYPES = { png: "image/png", jpg: "image/jpeg", jpeg: "image/jpeg", webp: "image/webp" };

/** The supported type a file carries, or null. A file dragged out of some
 * applications arrives with an empty type, so its name is the only evidence. */
export function attachmentType(file) {
	const declared = String(file?.type ?? "").toLowerCase();
	if (ATTACHMENT_TYPES.includes(declared)) return declared;
	if (declared) return null;
	const extension = String(file?.name ?? "").toLowerCase().match(/\.([a-z0-9]+)$/)?.[1];
	return EXTENSION_TYPES[extension] ?? null;
}

/** Whether a drag is carrying files at all. `dataTransfer.files` is empty
 * during dragover (the browser withholds it until the drop), so the types list
 * is the only thing that can decide whether to accept the drag. */
export function transferCarriesFiles(transfer) {
	return Array.from(transfer?.types ?? []).includes("Files");
}

/**
 * The attachable images on a paste or drop, and how many pictures were refused
 * for their format. A transfer with no image at all yields neither: the
 * composer must let that paste through as text.
 */
export function attachmentFilesFromTransfer(transfer) {
	const candidates = Array.from(transfer?.files ?? []);
	if (!candidates.length) {
		// Safari, and a screenshot pasted from some applications, expose the
		// bitmap only through `items`.
		const single = imageFileFromTransfer(transfer);
		if (single) candidates.push(single);
	}
	const images = [];
	let unsupported = 0;
	for (const file of candidates) {
		if (attachmentType(file)) images.push(file);
		else if (String(file?.type ?? "").startsWith("image/")) unsupported += 1;
	}
	return { images, unsupported };
}

/** Decoded byte length of a base64 data URL, without decoding it. */
export function dataUrlByteLength(dataUrl) {
	const base64 = String(dataUrl ?? "").slice(String(dataUrl ?? "").indexOf(",") + 1);
	if (!base64) return 0;
	const padding = base64.endsWith("==") ? 2 : base64.endsWith("=") ? 1 : 0;
	return Math.max(0, Math.floor(base64.length * 3 / 4) - padding);
}

/** The box `width`x`height` fits into with its longest side at most `max`. */
export function fitWithin(width, height, max = ATTACHMENT_MAX_DIMENSION) {
	const longest = Math.max(width, height);
	if (!Number.isFinite(longest) || longest <= 0) return null;
	if (longest <= max) return { width: Math.round(width), height: Math.round(height), scaled: false };
	const ratio = max / longest;
	return { width: Math.max(1, Math.round(width * ratio)), height: Math.max(1, Math.round(height * ratio)), scaled: true };
}

/** What fits in the pending list, and how many pictures had to be refused. */
export function appendAttachments(current = [], incoming = [], max = ATTACHMENT_MAX_COUNT) {
	const room = Math.max(0, max - current.length);
	return { attachments: [...current, ...incoming.slice(0, room)], rejected: Math.max(0, incoming.length - room) };
}

const BASE64_CHUNK = 0x8000;
const bytesToBase64 = (bytes) => {
	let binary = "";
	for (let i = 0; i < bytes.length; i += BASE64_CHUNK) binary += String.fromCharCode.apply(null, bytes.subarray(i, i + BASE64_CHUNK));
	return btoa(binary);
};

/** A Blob (or anything with arrayBuffer()/type) as a data URL. */
export async function blobToDataUrl(blob, type) {
	const bytes = new Uint8Array(await blob.arrayBuffer());
	return `data:${type || blob.type || "image/jpeg"};base64,${bytesToBase64(bytes)}`;
}

function defaultCanvas(width, height) {
	if (typeof OffscreenCanvas === "function") return new OffscreenCanvas(width, height);
	throw new Error("this browser cannot resize images — OffscreenCanvas is unavailable");
}

function dataUrlToBlob(dataUrl) {
	const comma = dataUrl.indexOf(",");
	const type = dataUrl.slice(5, dataUrl.indexOf(";"));
	const binary = atob(dataUrl.slice(comma + 1));
	const bytes = new Uint8Array(binary.length);
	for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
	return new Blob([bytes], { type });
}

/**
 * The data URL that will actually be sent. Under the byte budget the original
 * bytes are kept; over it the picture is capped to `maxDimension` on its
 * longest side and re-encoded as JPEG, which is the only re-encode that turns
 * a screenshot into something a turn can carry.
 */
export async function shrinkAttachmentDataUrl(dataUrl, {
	decode = globalThis.createImageBitmap,
	makeCanvas = defaultCanvas,
	toBlob = dataUrlToBlob,
	maxBytes = ATTACHMENT_MAX_BYTES,
	maxDimension = ATTACHMENT_MAX_DIMENSION,
	quality = ATTACHMENT_JPEG_QUALITY,
} = {}) {
	if (dataUrlByteLength(dataUrl) <= maxBytes) return dataUrl;
	if (typeof decode !== "function") throw new Error("this browser cannot decode images — createImageBitmap is unavailable");
	const bitmap = await decode(toBlob(dataUrl));
	try {
		const target = fitWithin(bitmap.width, bitmap.height, maxDimension);
		if (!target) throw new Error("that image has no usable size");
		const canvas = makeCanvas(target.width, target.height);
		const context = canvas.getContext("2d");
		if (!context) throw new Error("this browser cannot resize images — no 2D context");
		context.drawImage(bitmap, 0, 0, target.width, target.height);
		return await blobToDataUrl(await canvas.convertToBlob({ type: "image/jpeg", quality }), "image/jpeg");
	} finally {
		bitmap?.close?.();
	}
}

/** The name the model is told the picture by; bounded by the envelope's own
 * 120-character field rather than trusting a file name from the desktop. */
export function attachmentName(file) {
	const name = String(file?.name ?? "").trim();
	if (!name || name === "image.png") return "pasted-image.png";
	return name.slice(0, 120);
}

/** One pasted or dropped file as `{ dataUrl, name }`, ready for the turn. The
 * media type is the resolved one: a file dragged in without a type would
 * otherwise be labelled PNG whatever its bytes are. */
export async function attachmentFromFile(file, options = {}) {
	const { readDataUrl = fileToDataUrl, ...shrink } = options;
	const type = attachmentType(file) ?? "image/png";
	const read = await readDataUrl(file);
	const raw = read.startsWith(`data:${type};`) ? read : `data:${type};${read.slice(read.indexOf(";") + 1)}`;
	return { dataUrl: await shrinkAttachmentDataUrl(raw, shrink), name: attachmentName(file) };
}

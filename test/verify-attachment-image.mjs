#!/usr/bin/env node
// Composer image attachments (#367), proved without a browser.
//
// The rules that decide what actually travels with a turn — which pasted files
// count, how many fit, and when a screenshot is re-encoded instead of sent as
// a multi-megabyte PNG — live in src/workflow/attachment-image.js so they can
// be driven here with a fake canvas.
import assert from "node:assert/strict";
import {
	appendAttachments,
	attachmentFilesFromTransfer,
	attachmentFromFile,
	attachmentName,
	attachmentType,
	ATTACHMENT_JPEG_QUALITY,
	ATTACHMENT_MAX_BYTES,
	ATTACHMENT_MAX_COUNT,
	ATTACHMENT_MAX_DIMENSION,
	blobToDataUrl,
	dataUrlByteLength,
	fitWithin,
	shrinkAttachmentDataUrl,
	transferCarriesFiles,
} from "../src/workflow/attachment-image.js";

let failures = 0;
const expect = (name, condition, detail = "") => {
	console.log(`${condition ? "PASS" : "FAIL"} ${name}${condition ? "" : ` — ${detail}`}`);
	if (!condition) failures += 1;
};

const fakeFile = (name, type, bytes = new Uint8Array([1, 2, 3])) => ({
	name,
	type,
	size: bytes.length,
	arrayBuffer: async () => bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength),
});
const dataUrlOfBytes = (byteLength, type = "image/png") => `data:${type};base64,${"A".repeat(Math.ceil(byteLength / 3) * 4)}`;

// --- what counts as an attachable picture ---------------------------------
expect("a pasted PNG is attachable", attachmentType(fakeFile("shot.png", "image/png")) === "image/png");
expect("JPEG and WebP are attachable", attachmentType(fakeFile("a.jpg", "image/jpeg")) === "image/jpeg" && attachmentType(fakeFile("a.webp", "image/webp")) === "image/webp");
expect("a GIF is not attachable — the envelope cannot carry it", attachmentType(fakeFile("a.gif", "image/gif")) === null);
expect("a text file is not attachable", attachmentType(fakeFile("notes.txt", "text/plain")) === null);
expect("a typeless drop falls back to its extension", attachmentType(fakeFile("shot.JPEG", "")) === "image/jpeg" && attachmentType(fakeFile("archive.zip", "")) === null);

{
	const png = fakeFile("shot.png", "image/png");
	const gif = fakeFile("loop.gif", "image/gif");
	const txt = fakeFile("notes.txt", "text/plain");
	const fromFiles = attachmentFilesFromTransfer({ files: [txt, png, gif], items: [] });
	expect("a drop keeps every supported image and counts the refused ones", fromFiles.images.length === 1 && fromFiles.images[0] === png && fromFiles.unsupported === 1, JSON.stringify(fromFiles.images.map((file) => file.name)));
	const fromItems = attachmentFilesFromTransfer({ files: [], items: [{ kind: "string", type: "text/plain" }, { kind: "file", type: "image/png", getAsFile: () => png }] });
	expect("a clipboard that only exposes items still yields the bitmap", fromItems.images.length === 1 && fromItems.images[0] === png);
	const textOnly = attachmentFilesFromTransfer({ files: [], items: [{ kind: "string", type: "text/plain" }] });
	expect("a text paste yields nothing to attach", textOnly.images.length === 0 && textOnly.unsupported === 0);
	expect("a missing transfer is tolerated", attachmentFilesFromTransfer(null).images.length === 0);
	expect("a drag is accepted only while it carries files", transferCarriesFiles({ types: ["Files"] }) === true && transferCarriesFiles({ types: ["text/plain"] }) === false);
}

// --- how many fit ----------------------------------------------------------
{
	expect("the pending list holds four", ATTACHMENT_MAX_COUNT === 4);
	const first = appendAttachments([], [1, 2, 3]);
	expect("three pasted pictures all fit", first.attachments.length === 3 && first.rejected === 0);
	const fifth = appendAttachments(first.attachments, [4, 5]);
	expect("the fifth is refused, not silently dropped", fifth.attachments.length === 4 && fifth.rejected === 1, JSON.stringify(fifth));
	expect("a full list refuses everything", appendAttachments(fifth.attachments, [6]).rejected === 1);
}

// --- sizes -----------------------------------------------------------------
expect("byte length is read from the base64 without decoding it", dataUrlByteLength("data:image/png;base64,AAAA") === 3 && dataUrlByteLength("data:image/png;base64,AAA=") === 2 && dataUrlByteLength("") === 0);
expect("a picture inside the box is not scaled", JSON.stringify(fitWithin(1600, 900)) === JSON.stringify({ width: 1600, height: 900, scaled: false }));
expect("the longest side is capped at 1600", JSON.stringify(fitWithin(3840, 2160)) === JSON.stringify({ width: 1600, height: 900, scaled: true }));
expect("a tall picture is capped on its height", JSON.stringify(fitWithin(1000, 4000)) === JSON.stringify({ width: 400, height: 1600, scaled: true }));
expect("a sizeless picture has no target", fitWithin(0, 0) === null);

// --- the re-encode, driven through a fake canvas ---------------------------
{
	const drawn = [];
	const encoded = [];
	const jpegBytes = new Uint8Array(512).fill(7);
	const makeCanvas = (width, height) => ({
		width,
		height,
		getContext: () => ({ drawImage: (...args) => drawn.push({ width, height, args: args.slice(1) }) }),
		convertToBlob: async (options) => { encoded.push(options); return { type: options.type, arrayBuffer: async () => jpegBytes.buffer }; },
	});
	const decoded = [];
	const decode = async (blob) => { decoded.push(blob); return { width: 3840, height: 2160, close() { this.closed = true; } }; };
	const toBlob = (dataUrl) => ({ fake: true, length: dataUrl.length });

	const small = dataUrlOfBytes(1024);
	expect("a small screenshot is sent verbatim — no re-encode, no generation loss", await shrinkAttachmentDataUrl(small, { decode, makeCanvas, toBlob }) === small);
	expect("nothing is decoded for a small screenshot", decoded.length === 0 && encoded.length === 0);

	const huge = dataUrlOfBytes(ATTACHMENT_MAX_BYTES + 1024);
	const shrunk = await shrinkAttachmentDataUrl(huge, { decode, makeCanvas, toBlob });
	expect("an oversized PNG is re-encoded as JPEG", shrunk.startsWith("data:image/jpeg;base64,"), shrunk.slice(0, 40));
	expect("the re-encode is quality 0.85", encoded.length === 1 && encoded[0].type === "image/jpeg" && encoded[0].quality === ATTACHMENT_JPEG_QUALITY, JSON.stringify(encoded));
	expect("the canvas is the capped box, not the original", drawn.length === 1 && drawn[0].width === 1600 && drawn[0].height === 900, JSON.stringify(drawn));
	expect("the picture is drawn into the whole canvas", JSON.stringify(drawn[0].args) === JSON.stringify([0, 0, 1600, 900]));
	expect("the re-encoded bytes are what comes back", dataUrlByteLength(shrunk) === jpegBytes.length, String(dataUrlByteLength(shrunk)));
	expect("the result is under the budget the envelope was sized for", dataUrlByteLength(shrunk) <= ATTACHMENT_MAX_BYTES);
	expect("the decoded bitmap is released", decoded.length === 1);
	expect("the cap is the documented one", ATTACHMENT_MAX_DIMENSION === 1600 && ATTACHMENT_MAX_BYTES === 4 * 1024 * 1024);

	// A file with no size at all cannot be re-encoded into anything.
	await assert.rejects(() => shrinkAttachmentDataUrl(huge, { decode: async () => ({ width: 0, height: 0 }), makeCanvas, toBlob }), /usable size/);
	expect("a picture with no usable size is refused, never sent as zero bytes", true);
}

// --- one file, end to end --------------------------------------------------
{
	const bytes = new Uint8Array([0x89, 0x50, 0x4e, 0x47]);
	const file = fakeFile("Screenshot 2026-09-18.png", "image/png", bytes);
	const attachment = await attachmentFromFile(file);
	expect("the file becomes a data URL of its own bytes", attachment.dataUrl === "data:image/png;base64,iVBORw==", attachment.dataUrl);
	expect("the file keeps its name for the model", attachment.name === "Screenshot 2026-09-18.png");
	const typeless = await attachmentFromFile(fakeFile("shot.webp", "", bytes));
	expect("a typeless drop is labelled by its extension, not guessed as PNG", typeless.dataUrl.startsWith("data:image/webp;base64,"), typeless.dataUrl);
	expect("a clipboard bitmap gets a name of its own", attachmentName({ name: "image.png" }) === "pasted-image.png" && attachmentName({}) === "pasted-image.png");
	expect("an overlong desktop name is bounded by the envelope field", attachmentName({ name: `${"a".repeat(400)}.png` }).length === 120);
	expect("a blob converts to a data URL of its own type", await blobToDataUrl({ type: "image/jpeg", arrayBuffer: async () => new Uint8Array([255, 216, 255]).buffer }) === "data:image/jpeg;base64,/9j/");
}

if (failures) {
	console.error(`${failures} FAILURES`);
	process.exitCode = 1;
} else {
	console.log("all attachment image checks PASS");
}

/**
 * Motion resources: a validated ARDY npz archive packaged so a `.cclayproject`
 * can carry the take itself instead of a bridge URL that dies with the run.
 *
 * A record is content-addressed: `motionId` is the SHA-256 of the raw archive
 * bytes, so a scene's `character.motionRef.motionId` names the exact bytes it
 * was authored against. Decoding re-derives the hash and re-runs the full npz
 * validation, so a tampered or truncated record is rejected before playback
 * ever sees it. Every rejection is an NpzError carrying a machine-readable
 * `code` (bad-base64 | length-mismatch | hash-mismatch | bad-npz | too-large).
 *
 * No React, no three.js, no fetch: this module runs identically in the
 * browser and under Node (Web Crypto + atob/btoa are available in both).
 */

import { decodeMotionNpz, NpzError } from "./ardy/npz.js";

/** Per-motion raw archive cap; matches the npz reader's download cap. */
export const MOTION_MAX_BYTES = 192 * 1024 * 1024;

const MOTION_ID_RE = /^[0-9a-f]{64}$/i;
const BASE64_RE = /^[A-Za-z0-9+/]*={0,2}$/;

function codedError(code, message) {
	const error = new NpzError(message);
	error.code = code;
	return error;
}

function asBytes(value) {
	if (value instanceof Uint8Array) return value;
	if (value instanceof ArrayBuffer) return new Uint8Array(value);
	if (ArrayBuffer.isView(value)) return new Uint8Array(value.buffer, value.byteOffset, value.byteLength);
	throw new TypeError("motion bytes must be a Uint8Array or ArrayBuffer");
}

/** Lowercase hex SHA-256 of raw bytes — the motionId of an archive. */
export async function sha256Hex(value) {
	const bytes = asBytes(value);
	const subtle = globalThis.crypto?.subtle;
	if (!subtle) throw new Error("Web Crypto SHA-256 is unavailable");
	const digest = await subtle.digest("SHA-256", bytes);
	let hex = "";
	for (const byte of new Uint8Array(digest)) hex += byte.toString(16).padStart(2, "0");
	return hex;
}

function bytesToBase64(bytes) {
	let binary = "";
	for (let offset = 0; offset < bytes.length; offset += 0x8000) {
		binary += String.fromCharCode(...bytes.subarray(offset, offset + 0x8000));
	}
	return btoa(binary);
}

function base64ToBytes(text) {
	if (typeof text !== "string" || text.length % 4 !== 0 || !BASE64_RE.test(text)) {
		throw codedError("bad-base64", "motion resource data is not valid base64");
	}
	let binary;
	try {
		binary = atob(text);
	} catch {
		throw codedError("bad-base64", "motion resource data is not valid base64");
	}
	const bytes = new Uint8Array(binary.length);
	for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
	return bytes;
}

/** Decoded byte count of a base64 string, without decoding it. */
function base64DecodedLength(text) {
	let padding = 0;
	if (text.endsWith("==")) padding = 2;
	else if (text.endsWith("=")) padding = 1;
	return (text.length / 4) * 3 - padding;
}

const META_KEYS = ["prompt", "sourceUrl", "personScale", "createdAt"];

/**
 * Validate an npz archive and package it as a project motion record:
 * { motionId, encoding: "base64", data, bytes, frames, fps, name?, meta? }.
 *
 * `meta` may carry `name` (kept top-level) and prompt / sourceUrl /
 * personScale / createdAt (kept under `meta`). personScale defaults to the
 * value the archive itself carries so the record is self-describing.
 */
export async function encodeMotionResource(value, meta = {}) {
	const bytes = asBytes(value);
	if (bytes.byteLength > MOTION_MAX_BYTES) {
		throw codedError("too-large", `motion resource is ${bytes.byteLength} bytes, over the ${MOTION_MAX_BYTES} byte cap`);
	}
	let motion;
	try {
		motion = await decodeMotionNpz(bytes);
	} catch (error) {
		if (error instanceof NpzError && !error.code) error.code = "bad-npz";
		throw error;
	}
	const motionId = await sha256Hex(bytes);
	const record = {
		motionId,
		encoding: "base64",
		data: bytesToBase64(bytes),
		bytes: bytes.byteLength,
		frames: motion.frames,
		fps: motion.fps,
	};
	const source = meta && typeof meta === "object" ? meta : {};
	if (typeof source.name === "string" && source.name) record.name = source.name;
	const extra = { personScale: motion.personScale };
	for (const key of META_KEYS) {
		if (source[key] !== undefined && source[key] !== null) extra[key] = source[key];
	}
	record.meta = extra;
	return record;
}

/**
 * Unpack a motion record back into a decoded motion. Checks, in order: size
 * cap, base64 syntax, declared byte length, SHA-256 against motionId, then
 * the full npz validation. Returns the decodeMotionNpz result plus
 * { motionId, sourceBytes } — exactly what loadMotionFromUrl returns, so the
 * restore path treats an embedded take and a downloaded one the same way.
 */
export async function decodeMotionResource(record) {
	if (!record || typeof record !== "object") {
		throw codedError("bad-base64", "motion resource must be an object with base64 data");
	}
	if (Number.isFinite(record.bytes) && record.bytes > MOTION_MAX_BYTES) {
		throw codedError("too-large", `motion resource declares ${record.bytes} bytes, over the ${MOTION_MAX_BYTES} byte cap`);
	}
	if (record.encoding !== "base64" || typeof record.data !== "string") {
		throw codedError("bad-base64", "motion resource must contain base64 data");
	}
	if (base64DecodedLength(record.data) > MOTION_MAX_BYTES) {
		throw codedError("too-large", `motion resource data decodes past the ${MOTION_MAX_BYTES} byte cap`);
	}
	const bytes = base64ToBytes(record.data);
	if (bytes.byteLength > MOTION_MAX_BYTES) {
		throw codedError("too-large", `motion resource is ${bytes.byteLength} bytes, over the ${MOTION_MAX_BYTES} byte cap`);
	}
	if (!Number.isInteger(record.bytes) || record.bytes !== bytes.byteLength) {
		throw codedError("length-mismatch", `motion resource declares ${record.bytes} bytes but carries ${bytes.byteLength}`);
	}
	const declaredId = typeof record.motionId === "string" && MOTION_ID_RE.test(record.motionId) ? record.motionId.toLowerCase() : null;
	const motionId = await sha256Hex(bytes);
	if (declaredId !== motionId) {
		throw codedError("hash-mismatch", "motion resource bytes do not match its motionId");
	}
	let motion;
	try {
		motion = await decodeMotionNpz(bytes);
	} catch (error) {
		if (error instanceof NpzError && !error.code) error.code = "bad-npz";
		throw error;
	}
	return { ...motion, motionId, sourceBytes: bytes };
}

/**
 * Where a character's motion should come from on restore. Embedded bytes win
 * over a URL: the URL is a bridge run that may be gone, the bytes are here.
 *   { kind: "embedded", record } | { kind: "url", url } | { kind: "missing" }
 */
export function resolveMotionSource(motionRef, motionsById) {
	if (!motionRef || typeof motionRef !== "object") return { kind: "missing" };
	if (typeof motionRef.motionId === "string" && motionsById && typeof motionsById.get === "function") {
		const record = motionsById.get(motionRef.motionId.toLowerCase());
		if (record) return { kind: "embedded", record };
	}
	if (typeof motionRef.url === "string" && motionRef.url) return { kind: "url", url: motionRef.url };
	return { kind: "missing" };
}

export { loadMotionFromUrl } from "./ardy/npz.js";

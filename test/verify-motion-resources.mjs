#!/usr/bin/env node
/**
 * verify-motion-resources: an ARDY npz packaged as a project motion record
 * round-trips byte-for-byte, is content-addressed by SHA-256, rejects every
 * tampered form with a specific code, and decodes to a playable motion
 * without a bridge or a URL.
 */
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import {
	MOTION_MAX_BYTES,
	decodeMotionResource,
	encodeMotionResource,
	resolveMotionSource,
	sha256Hex,
} from "../src/motion-resources.js";
import { NpzError, decodeMotionNpz } from "../src/ardy/npz.js";

const fixturePath = new URL("../public/demo/walk-then-stop.npz", import.meta.url);
const bytes = new Uint8Array(readFileSync(fixturePath));
const expectedId = createHash("sha256").update(bytes).digest("hex");
const reference = await decodeMotionNpz(bytes);

async function rejectsWithCode(promise, code) {
	let caught = null;
	try {
		await promise;
	} catch (error) {
		caught = error;
	}
	assert.ok(caught instanceof NpzError, `${code}: rejection must be an NpzError, got ${caught?.constructor?.name ?? "nothing"}`);
	assert.equal(caught.code, code, `${code}: error.code (${caught.message})`);
	return caught;
}

// --- hashing -----------------------------------------------------------------
assert.equal(await sha256Hex(bytes), expectedId, "sha256Hex matches node:crypto");
assert.equal(await sha256Hex(bytes.buffer), expectedId, "sha256Hex accepts an ArrayBuffer");
assert.match(await sha256Hex(new Uint8Array(0)), /^[0-9a-f]{64}$/, "digest is 64 lowercase hex");

// --- encode ------------------------------------------------------------------
const record = await encodeMotionResource(bytes, { name: "walk then stop", prompt: "walks then stops", sourceUrl: "/ardy/motions/run-1.npz" });
assert.equal(record.motionId, expectedId, "motionId is the SHA-256 of the raw archive");
assert.equal(record.encoding, "base64");
assert.equal(record.bytes, bytes.byteLength, "bytes records the raw length");
assert.equal(record.frames, reference.frames, "frames comes from the npz");
assert.equal(record.fps, reference.fps, "fps comes from the npz");
assert.equal(record.name, "walk then stop");
assert.deepEqual(record.meta, { personScale: reference.personScale, prompt: "walks then stops", sourceUrl: "/ardy/motions/run-1.npz" }, "meta keeps only spec fields plus the archive's own personScale");
assert.equal(Buffer.from(record.data, "base64").toString("base64"), record.data, "data is canonical base64");
assert.deepEqual(Object.keys(record), ["motionId", "encoding", "data", "bytes", "frames", "fps", "name", "meta"], "record has the spec'd shape and nothing else");
const bare = await encodeMotionResource(bytes);
assert.equal(bare.name, undefined, "no name unless one was given");
assert.deepEqual(bare.meta, { personScale: reference.personScale }, "meta without caller fields is just personScale");
assert.equal(JSON.parse(JSON.stringify(record)).data, record.data, "record is plain JSON");

// --- decode round trip -------------------------------------------------------
const restored = await decodeMotionResource(record);
assert.ok(restored.sourceBytes instanceof Uint8Array, "sourceBytes is a Uint8Array");
assert.equal(restored.sourceBytes.byteLength, bytes.byteLength);
assert.ok(Buffer.from(restored.sourceBytes).equals(Buffer.from(bytes)), "embedded bytes round-trip exactly");
assert.equal(restored.motionId, expectedId, "decoded motion carries its motionId");
assert.equal(restored.frames, reference.frames, "frames decoded from the record alone");
assert.equal(restored.fps, reference.fps, "fps decoded from the record alone");
assert.ok(restored.rotMats instanceof Float32Array && restored.rotMats.length === reference.rotMats.length, "rotMats decoded from the record alone");
assert.ok(restored.rootPos instanceof Float32Array && restored.rootPos.length === reference.frames * 3, "rootPos decoded from the record alone");
assert.ok(restored.posedJoints instanceof Float32Array && restored.posedJoints.length === reference.posedJoints.length, "posedJoints decoded");
assert.equal(restored.personScale, reference.personScale);
assert.deepEqual(Array.from(restored.rotMats.subarray(0, 9)), Array.from(reference.rotMats.subarray(0, 9)), "first matrix matches a direct decode");
// A JSON round trip (what a .cclayproject actually is) is enough on its own.
const reparsed = await decodeMotionResource(JSON.parse(JSON.stringify(record)));
assert.equal(reparsed.motionId, expectedId, "decode works from parsed JSON");
// Uppercase ids are still the same content.
const upper = await decodeMotionResource({ ...record, motionId: record.motionId.toUpperCase() });
assert.equal(upper.motionId, expectedId, "motionId normalizes to lowercase");

// --- rejections --------------------------------------------------------------
await rejectsWithCode(decodeMotionResource({ ...record, motionId: "0".repeat(64) }), "hash-mismatch");
await rejectsWithCode(decodeMotionResource({ ...record, motionId: "not-a-hash" }), "hash-mismatch");
await rejectsWithCode(decodeMotionResource({ ...record, motionId: undefined }), "hash-mismatch");
await rejectsWithCode(decodeMotionResource({ ...record, data: `${record.data.slice(0, -2)}!!` }), "bad-base64");
await rejectsWithCode(decodeMotionResource({ ...record, data: record.data.slice(0, -1) }), "bad-base64");
await rejectsWithCode(decodeMotionResource({ ...record, data: 42 }), "bad-base64");
await rejectsWithCode(decodeMotionResource({ ...record, encoding: "hex" }), "bad-base64");
await rejectsWithCode(decodeMotionResource(null), "bad-base64");
await rejectsWithCode(decodeMotionResource({ ...record, bytes: record.bytes + 1 }), "length-mismatch");
await rejectsWithCode(decodeMotionResource({ ...record, bytes: undefined }), "length-mismatch");
await rejectsWithCode(decodeMotionResource({ ...record, bytes: MOTION_MAX_BYTES + 1 }), "too-large");
// Oversized data is refused from its base64 length before any decode work.
const hugeData = "A".repeat(Math.ceil((MOTION_MAX_BYTES + 3) / 3) * 4);
await rejectsWithCode(decodeMotionResource({ ...record, bytes: 1, data: hugeData }), "too-large");
await rejectsWithCode(encodeMotionResource(new Uint8Array(MOTION_MAX_BYTES + 1)), "too-large");
// Bytes whose hash matches but that are not a motion npz: the npz reader's
// own error, tagged bad-npz.
const junk = new TextEncoder().encode("not a zip archive at all");
const junkRecord = { motionId: await sha256Hex(junk), encoding: "base64", data: Buffer.from(junk).toString("base64"), bytes: junk.byteLength, frames: 1, fps: 24 };
const junkError = await rejectsWithCode(decodeMotionResource(junkRecord), "bad-npz");
assert.match(junkError.message, /End of Central Directory/, "bad-npz keeps the reader's specific message");
await rejectsWithCode(encodeMotionResource(junk), "bad-npz");
// A truncated archive: hash is recomputed over the truncated bytes, so it is
// the npz layer that catches it.
const truncated = bytes.subarray(0, bytes.byteLength - 64);
await rejectsWithCode(decodeMotionResource({ motionId: await sha256Hex(truncated), encoding: "base64", data: Buffer.from(truncated).toString("base64"), bytes: truncated.byteLength }), "bad-npz");

// --- resolveMotionSource ------------------------------------------------------
const motionsById = new Map([[record.motionId, record]]);
assert.deepEqual(resolveMotionSource({ motionId: record.motionId, url: "/ardy/motions/gone.npz" }, motionsById), { kind: "embedded", record }, "embedded wins over url");
assert.deepEqual(resolveMotionSource({ motionId: record.motionId.toUpperCase() }, motionsById), { kind: "embedded", record }, "lookup is case-insensitive");
assert.deepEqual(resolveMotionSource({ motionId: "f".repeat(64), url: "/ardy/motions/run.npz" }, motionsById), { kind: "url", url: "/ardy/motions/run.npz" }, "unknown motionId falls back to url");
assert.deepEqual(resolveMotionSource({ url: "/ardy/motions/run.npz" }, motionsById), { kind: "url", url: "/ardy/motions/run.npz" }, "url-only ref");
assert.deepEqual(resolveMotionSource({ motionId: "f".repeat(64) }, motionsById), { kind: "missing" }, "unknown motionId without url is missing");
assert.deepEqual(resolveMotionSource({ motionId: record.motionId }, new Map()), { kind: "missing" }, "no motions at all is missing");
assert.deepEqual(resolveMotionSource({ motionId: record.motionId }, undefined), { kind: "missing" }, "no map at all is missing");
assert.deepEqual(resolveMotionSource(null, motionsById), { kind: "missing" }, "no ref is missing");
assert.deepEqual(resolveMotionSource({ prompt: "walk" }, motionsById), { kind: "missing" }, "ref without id or url is missing");

console.log("verify-motion-resources: ok");

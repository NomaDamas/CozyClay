/**
 * FBX sniff and bounds: magic / version without three.js, then the loader.
 *
 * GLB boxes stay JSON and OBJ boxes stay `v` text. An FBX box needs
 * `FBXLoader.parse` + world matrices. Callers in `scene-mesh.js` keep the
 * three-free paths; this file is the three.js boundary.
 */
import { Box3, Vector3 } from "three";
import { FBXLoader } from "three/examples/jsm/loaders/FBXLoader.js";

/** Same 23-ish prefix three.js uses (`Kaydara FBX Binary  \\0`). */
const FBX_BINARY_MAGIC = "Kaydara\u0020FBX\u0020Binary\u0020\u0020\0";
const FBX_SNIFF_BYTES = 64 * 1024;

function bytesAsUint8(bytes) {
	if (bytes instanceof ArrayBuffer) return new Uint8Array(bytes);
	if (ArrayBuffer.isView(bytes)) return new Uint8Array(bytes.buffer, bytes.byteOffset, bytes.byteLength);
	return null;
}

/** `FBXLoader.parse` wants a real ArrayBuffer, not a view into a larger pool. */
export function arrayBufferOf(bytes) {
	if (bytes instanceof ArrayBuffer) return bytes;
	if (ArrayBuffer.isView(bytes)) return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);
	return null;
}

export function isFbxBinaryMagic(bytes) {
	const view = bytesAsUint8(bytes);
	if (!view || view.byteLength < FBX_BINARY_MAGIC.length) return false;
	for (let i = 0; i < FBX_BINARY_MAGIC.length; i++) {
		if (view[i] !== FBX_BINARY_MAGIC.charCodeAt(i)) return false;
	}
	return true;
}

/** ASCII `FBXVersion:` in the first 64 KB, or null when the header is silent. */
export function readFbxVersion(bytes) {
	const view = bytesAsUint8(bytes);
	if (!view || !view.byteLength) return null;
	const slice = view.subarray(0, Math.min(view.byteLength, FBX_SNIFF_BYTES));
	const text = new TextDecoder("utf-8").decode(slice);
	const match = text.match(/FBXVersion: (\d+)/);
	if (!match) return null;
	const version = Number(match[1]);
	return Number.isFinite(version) ? version : null;
}

export function parseFbxGroup(bytes) {
	const buffer = arrayBufferOf(bytes);
	if (!buffer || !buffer.byteLength) return null;
	return new FBXLoader().parse(buffer, "");
}

/**
 * World-space box of an FBX after `updateMatrixWorld`. Empty, flat, or
 * unreadable graphs return null so import/shelf spawn can toast
 * "no measurable geometry" — same never-throw contract as parseGlbBounds.
 */
export function parseFbxBounds(bytes) {
	try {
		const group = parseFbxGroup(bytes);
		if (!group) return null;
		group.updateMatrixWorld(true);
		const box = new Box3().setFromObject(group);
		const size = box.getSize(new Vector3());
		if (!(size.y > 0) || !Number.isFinite(size.y)) return null;
		return {
			min: { x: box.min.x, y: box.min.y, z: box.min.z },
			max: { x: box.max.x, y: box.max.y, z: box.max.z },
		};
	} catch {
		return null;
	}
}

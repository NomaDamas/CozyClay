/**
 * Bounded browser reader for ARDY motion npz archives.
 *
 * A numpy savez() archive is a zip of .npy members. The dev sidecar writes
 * STORED archives (tools/ardy/npz.mjs), but a box-generated motion is a real
 * numpy archive, which may use DEFLATE, so both zip methods are supported.
 * Deflate is decoded with the platform's DecompressionStream("deflate-raw");
 * no dependency is added and no package file changes.
 *
 * Every bound is explicit: archive size, per-member decompressed size, npy
 * header length, frame count, and fps range all have caps (the frame/fps caps
 * mirror CozyClay's motion_retarget.MAX_FRAMES / FPS_BOUNDS). Every member is
 * validated (magic, version, header dict, dtype, C order, exact byte length,
 * CRC-32, finite values, proper rotation matrices) before it is accepted, and
 * malformed input is rejected with a specific NpzError instead of a silent
 * fallback.
 *
 * The archive is parsed from the central directory (EOCD at the end), which
 * always carries the authoritative sizes regardless of data-descriptor flags
 * in the local headers. Zip64 archives are out of scope: the caps here are
 * far below 4 GiB, so a zip64 record is rejected explicitly.
 */

import { CSKEL27_JOINTS } from "./cskel27.js";

const MAX_ARCHIVE_BYTES = 192 * 1024 * 1024; // download cap
const MAX_MEMBER_BYTES = 192 * 1024 * 1024; // decompressed member cap
const MAX_NPY_HEADER_BYTES = 16 * 1024; // matches CozyClay's cap
const MAX_FRAMES = 24000; // matches CozyClay motion_retarget.MAX_FRAMES
const FPS_MIN = 1;
const FPS_MAX = 240; // matches CozyClay motion_retarget.FPS_BOUNDS
// Same tolerance motion_retarget uses for squared row/column norms, pairwise
// dots, and determinant; float32 serialization noise sits far below 1e-3.
const ROTATION_MATRIX_TOLERANCE = 1e-3;
// Bounds on the stature a take may ask the character to take on. The estimate
// is a ratio of leg lengths measured off a video, so a bad detection must
// never be able to produce a giant or a gnome; the clamp lives next to the
// decode because that is where the number enters the app.
export const CHARACTER_SCALE_MIN = 0.6;
export const CHARACTER_SCALE_MAX = 1.5;

const ZIP_EOCD_SIG = 0x06054b50;
const ZIP_CENTRAL_SIG = 0x02014b50;
const ZIP_LOCAL_SIG = 0x04034b50;
const ZIP64_EOCD_SIG = 0x06064b50;
const FLAG_ENCRYPTED = 0x0001;
const FLAG_PATCHED = 0x0020;
const FLAG_STRONG = 0x0040;

export class NpzError extends Error {
	constructor(message) {
		super(message);
		this.name = "NpzError";
	}
}

/* --- CRC-32 (IEEE 802.3, reflected) -------------------------------------- */

const CRC_TABLE = (() => {
	const table = new Uint32Array(256);
	for (let n = 0; n < 256; n += 1) {
		let c = n;
		for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
		table[n] = c >>> 0;
	}
	return table;
})();

function crc32(bytes) {
	let c = 0xffffffff;
	for (let i = 0; i < bytes.length; i += 1) c = CRC_TABLE[(c ^ bytes[i]) & 0xff] ^ (c >>> 8);
	return (c ^ 0xffffffff) >>> 0;
}

/* --- zip container -------------------------------------------------------- */

/** Locate the End of Central Directory record, scanning back from EOF. */
function findEocd(view) {
	// EOCD is 22 bytes + a comment of up to 65535; the scan window also covers
	// a possible zip64 locator (20 bytes) parked just before it.
	const window = Math.min(view.byteLength, 22 + 65535 + 20);
	const start = view.byteLength - window;
	for (let i = view.byteLength - 22; i >= start; i -= 1) {
		if (view.getUint32(i, true) !== ZIP_EOCD_SIG) continue;
		const totalEntries = view.getUint16(i + 10, true);
		const cdSize = view.getUint32(i + 12, true);
		const cdOffset = view.getUint32(i + 16, true);
		if (cdOffset === 0xffffffff || cdSize === 0xffffffff || totalEntries === 0xffff) {
			throw new NpzError("npz uses zip64 records, which are out of scope");
		}
		return { totalEntries, cdSize, cdOffset };
	}
	throw new NpzError("npz has no End of Central Directory record");
}

/** Parse the central directory into a name -> entry map (authoritative sizes). */
function parseCentralDirectory(view, cdOffset, cdSize) {
	const end = cdOffset + cdSize;
	if (end > view.byteLength) throw new NpzError("npz central directory is truncated");
	const entries = new Map();
	let offset = cdOffset;
	while (offset < end) {
		if (view.getUint32(offset, true) !== ZIP_CENTRAL_SIG) {
			throw new NpzError("npz central directory is corrupt (bad record signature)");
		}
		const flags = view.getUint16(offset + 8, true);
		const method = view.getUint16(offset + 10, true);
		const crc = view.getUint32(offset + 16, true);
		const compSize = view.getUint32(offset + 20, true);
		const uncompSize = view.getUint32(offset + 24, true);
		const nameLen = view.getUint16(offset + 28, true);
		const extraLen = view.getUint16(offset + 30, true);
		const commentLen = view.getUint16(offset + 32, true);
		const localOffset = view.getUint32(offset + 42, true);
		const nameBytes = new Uint8Array(view.buffer, view.byteOffset + offset + 46, nameLen);
		const name = new TextDecoder("latin1").decode(nameBytes);
		if (localOffset === 0xffffffff || compSize === 0xffffffff || uncompSize === 0xffffffff) {
			throw new NpzError(`npz member ${name} uses zip64 sizes, which are out of scope`);
		}
		entries.set(name, { name, flags, method, crc, compSize, uncompSize, localOffset });
		offset += 46 + nameLen + extraLen + commentLen;
	}
	return entries;
}

/** Locate a member's compressed payload via its local file header. */
function locateMember(view, entry) {
	const off = entry.localOffset;
	if (off + 30 > view.byteLength) throw new NpzError(`npz member ${entry.name} local header is truncated`);
	if (view.getUint32(off, true) !== ZIP_LOCAL_SIG) {
		throw new NpzError(`npz member ${entry.name} local header is corrupt`);
	}
	const flags = view.getUint16(off + 6, true);
	const method = view.getUint16(off + 8, true);
	const nameLen = view.getUint16(off + 26, true);
	const extraLen = view.getUint16(off + 28, true);
	let localComp = view.getUint32(off + 18, true);
	if (flags & (FLAG_ENCRYPTED | FLAG_PATCHED | FLAG_STRONG)) {
		throw new NpzError(`npz member ${entry.name} uses unsupported encryption/patching flags`);
	}
	if (method !== entry.method) throw new NpzError(`npz member ${entry.name} method mismatch between local and central headers`);
	// Recent numpy writes a zip64 extra field in local headers even for small
	// members, leaving the 32-bit size fields at 0xFFFFFFFF. Resolve it: the
	// extra's 8-byte sizes appear only for the fields that are 0xFFFFFFFF.
	if (localComp === 0xffffffff) {
		let found = false;
		let extra = off + 30 + nameLen;
		const extraEnd = extra + extraLen;
		while (extra + 4 <= extraEnd) {
			const id = view.getUint16(extra, true);
			const size = view.getUint16(extra + 2, true);
			if (extra + 4 + size > extraEnd) {
				throw new NpzError(`npz member ${entry.name} zip64 extra field is truncated`);
			}
			if (id === 0x0001) {
				let at = extra + 4;
				let uncomp64 = null;
				let comp64 = null;
				const localUncomp = view.getUint32(off + 22, true);
				if (localUncomp === 0xffffffff) {
					uncomp64 = view.getBigUint64(at, true);
					at += 8;
				}
				if (localComp === 0xffffffff) {
					comp64 = view.getBigUint64(at, true);
				}
				if (comp64 !== null) {
					if (comp64 > 0xffffffffn) {
						throw new NpzError(`npz member ${entry.name} uses zip64 sizes, which are out of scope`);
					}
					localComp = Number(comp64);
				}
				if (uncomp64 !== null && uncomp64 !== BigInt(entry.uncompSize)) {
					throw new NpzError(`npz member ${entry.name} size mismatch between local and central headers`);
				}
				found = true;
				break;
			}
			extra += 4 + size;
		}
		if (!found) throw new NpzError(`npz member ${entry.name} local header is corrupt (missing zip64 extra)`);
	}
	// Writers that use data descriptors leave the local sizes at 0; when they
	// are present they must agree with the central directory.
	if (localComp !== 0 && localComp !== entry.compSize) {
		throw new NpzError(`npz member ${entry.name} size mismatch between local and central headers`);
	}
	const dataStart = off + 30 + nameLen + extraLen;
	if (dataStart + entry.compSize > view.byteLength) {
		throw new NpzError(`npz member ${entry.name} payload is truncated`);
	}
	return new Uint8Array(view.buffer, view.byteOffset + dataStart, entry.compSize);
}

/** Inflate a raw-deflate member with the platform primitive, bounded by `cap`. */
async function inflateRaw(bytes, cap) {
	if (typeof DecompressionStream !== "function") {
		throw new NpzError("this browser cannot decode deflate npz members (DecompressionStream unsupported)");
	}
	const reader = new Blob([bytes]).stream().pipeThrough(new DecompressionStream("deflate-raw")).getReader();
	const chunks = [];
	let total = 0;
	for (;;) {
		const { done, value } = await reader.read();
		if (done) break;
		total += value.byteLength;
		if (total > cap) {
			await reader.cancel();
			throw new NpzError(`deflate member exceeds the ${cap} byte cap`);
		}
		chunks.push(value);
	}
	const out = new Uint8Array(total);
	let offset = 0;
	for (const chunk of chunks) {
		out.set(chunk, offset);
		offset += chunk.byteLength;
	}
	return out;
}

/* --- npy member ----------------------------------------------------------- */

const DTYPE_RE = /^([<>=|])([A-Za-z?])([0-9]{1,4})$/;

/**
 * Parse one .npy member. Returns { shape, kind, itemsize, littleEndian,
 * data: Uint8Array } where `data` starts at the array payload (the npy header
 * has already been validated). Throws NpzError on anything malformed.
 */
function parseNpyMember(bytes, memberName) {
	if (bytes.length < 10) throw new NpzError(`npy member ${memberName} is too short`);
	if (bytes[0] !== 0x93 || bytes[1] !== 0x4e || bytes[2] !== 0x55 || bytes[3] !== 0x4d || bytes[4] !== 0x50 || bytes[5] !== 0x59) {
		throw new NpzError(`npy member ${memberName} has an invalid magic`);
	}
	let prefixLen;
	let headerLen;
	if (bytes[6] === 1 && bytes[7] === 0) {
		prefixLen = 10; // magic(6) + version(2) + header length(2)
		headerLen = bytes[8] | (bytes[9] << 8);
	} else if ((bytes[6] === 2 || bytes[6] === 3) && bytes[7] === 0) {
		prefixLen = 12; // magic(6) + version(2) + header length(4)
		headerLen = bytes[8] | (bytes[9] << 8) | (bytes[10] << 16) | (bytes[11] << 24);
	} else {
		throw new NpzError(`npy member ${memberName} uses an unsupported version (${bytes[6]}.${bytes[7]})`);
	}
	if (headerLen <= 0 || headerLen > MAX_NPY_HEADER_BYTES) {
		throw new NpzError(`npy member ${memberName} header length ${headerLen} is out of range`);
	}
	if (prefixLen + headerLen > bytes.length) throw new NpzError(`npy member ${memberName} header is truncated`);

	let text;
	try {
		text = new TextDecoder("latin1").decode(bytes.subarray(prefixLen, prefixLen + headerLen));
	} catch {
		throw new NpzError(`npy member ${memberName} header is not decodable text`);
	}
	const descrMatch = /['"]descr['"]\s*:\s*['"]([^'"]+)['"]/.exec(text);
	const orderMatch = /['"]fortran_order['"]\s*:\s*(True|False)/.exec(text);
	const shapeMatch = /['"]shape['"]\s*:\s*\(([^()]*)\)/.exec(text);
	if (!descrMatch || !orderMatch || !shapeMatch) {
		throw new NpzError(`npy member ${memberName} header is missing descr/fortran_order/shape`);
	}
	if (orderMatch[1] !== "False") {
		throw new NpzError(`npy member ${memberName} must be C order (fortran_order False)`);
	}
	const dims = shapeMatch[1]
		.split(",")
		.map((s) => s.trim())
		.filter((s) => s !== "")
		.map((s) => {
			const n = Number(s);
			if (!Number.isInteger(n) || n < 0) throw new NpzError(`npy member ${memberName} has an invalid shape dimension '${s}'`);
			return n;
		});
	const dtypeMatch = DTYPE_RE.exec(descrMatch[1]);
	if (!dtypeMatch) throw new NpzError(`npy member ${memberName} has an invalid dtype '${descrMatch[1]}'`);
	const [, byteOrder, kind, itemsizeText] = dtypeMatch;
	const itemsize = Number(itemsizeText);

	const itemCount = dims.reduce((a, b) => a * b, 1);
	const payloadBytes = itemCount * itemsize;
	if (prefixLen + headerLen + payloadBytes > bytes.length) {
		throw new NpzError(`npy member ${memberName} payload is truncated (expected ${payloadBytes} bytes)`);
	}
	return {
		shape: dims,
		kind,
		itemsize,
		littleEndian: byteOrder !== ">",
		data: bytes.subarray(prefixLen + headerLen, prefixLen + headerLen + payloadBytes),
	};
}

/** float32 view (little-endian); big-endian archives are byte-swapped. */
function float32Of(parsed, label) {
	if (parsed.kind !== "f" || parsed.itemsize !== 4) {
		throw new NpzError(`${label} must be float32, got descr kind '${parsed.kind}'/${parsed.itemsize}`);
	}
	const bytes = parsed.data;
	if (!parsed.littleEndian) {
		const swapped = new Uint8Array(bytes.byteLength);
		const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
		const out = new DataView(swapped.buffer);
		for (let i = 0; i < bytes.byteLength; i += 4) out.setUint32(i, view.getUint32(i, false), true);
		return new Float32Array(swapped.buffer);
	}
	// A real box-generated npz's npy payload may start at a byteOffset that is
	// not 4-byte aligned relative to the archive ArrayBuffer (zip local-header
	// and npy header lengths are arbitrary bytes). Float32Array requires its
	// byteOffset to be a multiple of 4, so keep the zero-copy view only when
	// the payload is already aligned; otherwise copy the exact payload bytes
	// into a fresh aligned buffer first. The copy is byte-identical, so the
	// big-endian swap path above is unaffected and all downstream size/dtype/
	// shape/finite/rotation validation still sees the same values.
	if (bytes.byteOffset % 4 === 0) {
		return new Float32Array(bytes.buffer, bytes.byteOffset, bytes.byteLength / 4);
	}
	const aligned = new Uint8Array(bytes.byteLength);
	aligned.set(bytes);
	return new Float32Array(aligned.buffer);
}

/** scalar integer value (fps); returns Number. */
function scalarIntOf(parsed, label) {
	if (parsed.kind !== "i" && parsed.kind !== "u") {
		throw new NpzError(`${label} must be an integer scalar, got descr kind '${parsed.kind}'`);
	}
	if (parsed.shape.length > 1 || (parsed.shape.length === 1 && parsed.shape[0] !== 1)) {
		throw new NpzError(`${label} must be a scalar (shape () or (1,)), got shape (${parsed.shape.join(", ")})`);
	}
	const view = new DataView(parsed.data.buffer, parsed.data.byteOffset, parsed.data.byteLength);
	const little = parsed.littleEndian;
	let value;
	switch (parsed.itemsize) {
		case 1: value = parsed.kind === "u" ? view.getUint8(0) : view.getInt8(0); break;
		case 2: value = parsed.kind === "u" ? view.getUint16(0, little) : view.getInt16(0, little); break;
		case 4: value = parsed.kind === "u" ? view.getUint32(0, little) : view.getInt32(0, little); break;
		case 8: {
			const big = view.getBigInt64(0, little);
			if (big > 4294967295n || big < -2147483648n) {
				throw new NpzError(`${label} value ${big} is out of range`);
			}
			value = Number(big);
			break;
		}
		default:
			throw new NpzError(`${label} has unsupported integer itemsize ${parsed.itemsize}`);
	}
	if (!Number.isFinite(value)) throw new NpzError(`${label} is not a finite number`);
	return value;
}

/** scalar float value (person_scale); returns Number. An integer member is
 *  accepted too, so a writer that stored a whole-number scale still reads. */
function scalarFloatOf(parsed, label) {
	if (parsed.kind === "i" || parsed.kind === "u") return scalarIntOf(parsed, label);
	if (parsed.kind !== "f") {
		throw new NpzError(`${label} must be a float scalar, got descr kind '${parsed.kind}'`);
	}
	if (parsed.shape.length > 1 || (parsed.shape.length === 1 && parsed.shape[0] !== 1)) {
		throw new NpzError(`${label} must be a scalar (shape () or (1,)), got shape (${parsed.shape.join(", ")})`);
	}
	const view = new DataView(parsed.data.buffer, parsed.data.byteOffset, parsed.data.byteLength);
	let value;
	if (parsed.itemsize === 4) value = view.getFloat32(0, parsed.littleEndian);
	else if (parsed.itemsize === 8) value = view.getFloat64(0, parsed.littleEndian);
	else throw new NpzError(`${label} has unsupported float itemsize ${parsed.itemsize}`);
	if (!Number.isFinite(value)) throw new NpzError(`${label} is not a finite number`);
	return value;
}

/** Validate one 3x3 matrix: finite, orthonormal rows/columns, det +1. */
function checkRotationMatrix(rows, frame, joint) {
	const columns = [
		[rows[0][0], rows[1][0], rows[2][0]],
		[rows[0][1], rows[1][1], rows[2][1]],
		[rows[0][2], rows[1][2], rows[2][2]],
	];
	for (const vectors of [rows, columns]) {
		for (const vector of vectors) {
			const squaredNorm = vector[0] * vector[0] + vector[1] * vector[1] + vector[2] * vector[2];
			if (!Number.isFinite(squaredNorm) || Math.abs(squaredNorm - 1) > ROTATION_MATRIX_TOLERANCE) {
				throw new NpzError(`motion npz frame ${frame} joint ${joint}: row/column squared norm ${squaredNorm} is not 1`);
			}
		}
		for (const [first, second] of [[0, 1], [0, 2], [1, 2]]) {
			const dot =
				vectors[first][0] * vectors[second][0] +
				vectors[first][1] * vectors[second][1] +
				vectors[first][2] * vectors[second][2];
			if (!Number.isFinite(dot) || Math.abs(dot) > ROTATION_MATRIX_TOLERANCE) {
				throw new NpzError(`motion npz frame ${frame} joint ${joint}: row/column dot ${dot} is not 0`);
			}
		}
	}
	const determinant =
		rows[0][0] * (rows[1][1] * rows[2][2] - rows[1][2] * rows[2][1]) -
		rows[0][1] * (rows[1][0] * rows[2][2] - rows[1][2] * rows[2][0]) +
		rows[0][2] * (rows[1][0] * rows[2][1] - rows[1][1] * rows[2][0]);
	if (!Number.isFinite(determinant) || Math.abs(determinant - 1) > ROTATION_MATRIX_TOLERANCE) {
		throw new NpzError(`motion npz frame ${frame} joint ${joint}: determinant ${determinant} is not +1`);
	}
}

/* --- archive decode ------------------------------------------------------- */

/**
 * Decode an ARDY motion npz from raw bytes.
 *
 * Returns { frames, fps, personScale, rotMats, rootPos, posedJoints } with `rotMats` a
 * Float32Array of frames*27*9 row-major 3x3 matrices (cskel27 joint order),
 * `rootPos` a Float32Array of frames*3 (x, y, z) ARDY-world root positions,
 * and `posedJoints` a Float32Array of frames*27*3 ARDY-world joint
 * positions (the positional-skinning reference — playback.js drives bone
 * positions straight from it). Throws NpzError on anything malformed.
 *
 * `personScale` is the filmed performer's stature relative to the canonical
 * body, carried by the optional `person_scale` member. The extraction divided
 * the root translation by it, so applying the frames without applying the
 * scale exaggerates every stride — the two must move together. An archive
 * without the member (an ARDY-generated take, or one written before the
 * member existed) reports 1: canonical body, unscaled travel.
 */
export async function decodeMotionNpz(bytes) {
	if (bytes.byteLength > MAX_ARCHIVE_BYTES) {
		throw new NpzError(`motion npz is ${bytes.byteLength} bytes, over the ${MAX_ARCHIVE_BYTES} byte cap`);
	}
	const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
	const eocd = findEocd(view);
	const entries = parseCentralDirectory(view, eocd.cdOffset, eocd.cdSize);

	const names = ["local_rot_mats.npy", "root_positions.npy", "fps.npy", "posed_joints.npy"];
	const missing = names.filter((n) => !entries.has(n));
	if (missing.length) throw new NpzError(`motion npz is missing members: ${missing.join(", ")}`);
	// person_scale is optional: only a filmed take has a performer to measure,
	// and archives predating the member are still valid motions.
	const read = [...names, ...["person_scale.npy", "bone_scale.npy"].filter((name) => entries.has(name))];

	const members = {};
	for (const name of read) {
		const entry = entries.get(name);
		if (entry.uncompSize > MAX_MEMBER_BYTES) {
			throw new NpzError(`motion npz member ${name} decompresses to ${entry.uncompSize} bytes, over the ${MAX_MEMBER_BYTES} byte cap`);
		}
		let payload = locateMember(view, entry);
		if (entry.method === 8) payload = await inflateRaw(payload, MAX_MEMBER_BYTES);
		else if (entry.method !== 0) throw new NpzError(`motion npz member ${name} uses unsupported zip method ${entry.method}`);
		if (payload.byteLength !== entry.uncompSize) {
			throw new NpzError(`motion npz member ${name} decompressed to ${payload.byteLength} bytes, expected ${entry.uncompSize}`);
		}
		if (crc32(payload) !== entry.crc) {
			throw new NpzError(`motion npz member ${name} failed its CRC-32 check (corrupt data)`);
		}
		members[name] = payload;
	}

	const rotParsed = parseNpyMember(members["local_rot_mats.npy"], "local_rot_mats");
	const posParsed = parseNpyMember(members["root_positions.npy"], "root_positions");
	const fpsParsed = parseNpyMember(members["fps.npy"], "fps");
	const jointsParsed = parseNpyMember(members["posed_joints.npy"], "posed_joints");

	const joints = CSKEL27_JOINTS.length;
	if (rotParsed.shape.length !== 4 || rotParsed.shape[1] !== joints || rotParsed.shape[2] !== 3 || rotParsed.shape[3] !== 3) {
		throw new NpzError(`local_rot_mats must have shape (F, ${joints}, 3, 3), got (${rotParsed.shape.join(", ")})`);
	}
	if (posParsed.shape.length !== 2 || posParsed.shape[1] !== 3) {
		throw new NpzError(`root_positions must have shape (F, 3), got (${posParsed.shape.join(", ")})`);
	}
	const frames = rotParsed.shape[0];
	if (frames < 1 || frames > MAX_FRAMES) {
		throw new NpzError(`motion npz has ${frames} frames, outside 1..${MAX_FRAMES}`);
	}
	if (posParsed.shape[0] !== frames) {
		throw new NpzError(`root_positions frame count ${posParsed.shape[0]} differs from local_rot_mats (${frames})`);
	}
	if (jointsParsed.shape.length !== 3 || jointsParsed.shape[1] !== joints || jointsParsed.shape[2] !== 3) {
		throw new NpzError(`posed_joints must have shape (F, ${joints}, 3), got (${jointsParsed.shape.join(", ")})`);
	}
	if (jointsParsed.shape[0] !== frames) {
		throw new NpzError(`posed_joints frame count ${jointsParsed.shape[0]} differs from local_rot_mats (${frames})`);
	}
	const fps = scalarIntOf(fpsParsed, "fps");
	if (fps < FPS_MIN || fps > FPS_MAX) {
		throw new NpzError(`motion fps ${fps} is outside ${FPS_MIN}..${FPS_MAX}`);
	}
	let personScale = 1;
	if (members["person_scale.npy"]) {
		personScale = scalarFloatOf(parseNpyMember(members["person_scale.npy"], "person_scale"), "person_scale");
		// A stored zero or negative would mirror the trajectory or collapse the
		// body; that is corrupt data, not a scale to clamp into range.
		if (!(personScale > 0)) throw new NpzError(`motion person_scale ${personScale} must be positive`);
	}

	// bone_scale (mocap takes): the performer's bone lengths over the canonical
	// body, one factor per cskel27 joint. Absent means canonical (all ones).
	let boneScale = null;
	if (members["bone_scale.npy"]) {
		const parsed = parseNpyMember(members["bone_scale.npy"], "bone_scale");
		if (parsed.shape.length !== 1 || parsed.shape[0] !== joints) {
			throw new NpzError(`bone_scale must have shape (${joints}), got (${parsed.shape.join(", ")})`);
		}
		boneScale = float32Of(parsed, "bone_scale");
		for (let j = 0; j < joints; j += 1) {
			if (!(boneScale[j] > 0) || !Number.isFinite(boneScale[j])) throw new NpzError(`motion bone_scale[${j}] ${boneScale[j]} must be positive`);
		}
	}

	const rotMats = float32Of(rotParsed, "local_rot_mats");
	const rootPos = float32Of(posParsed, "root_positions");
	const posedJoints = float32Of(jointsParsed, "posed_joints");
	if (rotMats.length !== frames * joints * 9 || rootPos.length !== frames * 3 || posedJoints.length !== frames * joints * 3) {
		throw new NpzError("motion npz member byte lengths do not match their shapes");
	}

	// Full validation before anything is accepted: every rotation matrix must
	// be a proper rotation and every root position finite.
	const m = rotMats;
	for (let f = 0; f < frames; f += 1) {
		const base = f * joints * 9;
		for (let j = 0; j < joints; j += 1) {
			const o = base + j * 9;
			checkRotationMatrix(
				[
					[m[o], m[o + 1], m[o + 2]],
					[m[o + 3], m[o + 4], m[o + 5]],
					[m[o + 6], m[o + 7], m[o + 8]],
				],
				f,
				j,
			);
		}
	}
	for (let i = 0; i < rootPos.length; i += 1) {
		if (!Number.isFinite(rootPos[i])) throw new NpzError(`motion npz root_positions contains a non-finite value at index ${i}`);
	}
	for (let i = 0; i < posedJoints.length; i += 1) {
		if (!Number.isFinite(posedJoints[i])) throw new NpzError(`motion npz posed_joints contains a non-finite value at index ${i}`);
	}

	const motion = { frames, fps, personScale, rotMats, rootPos, posedJoints };
	if (boneScale) motion.boneScale = boneScale;
	return motion;
}

/**
 * The character scale a decoded take implies, clamped to the sane stature
 * band. THE INVARIANT: a take's root travel was authored against this scale,
 * so every path that applies a motion must apply this too — leaving them apart
 * is what makes a filmed stride overshoot and the feet slide.
 *
 * `fallback` is for a take whose npz predates the member but whose scale
 * arrived some other way (the extraction response). No scale anywhere means
 * canonical: 1.
 */
export function characterScaleFor(motion, fallback = 1) {
	const raw = Number.isFinite(motion?.personScale) && motion.personScale > 0
		? motion.personScale
		: Number.isFinite(fallback) && fallback > 0
			? fallback
			: 1;
	return Math.max(CHARACTER_SCALE_MIN, Math.min(CHARACTER_SCALE_MAX, raw));
}

/**
 * Fetch and decode a motion npz from the bridge's motionUrl.
 *
 * The download is size-capped (Content-Length when present, plus the actual
 * body) and every decode error surfaces as an NpzError with a specific
 * message; a missing/stale run id is a plain fetch error.
 */
export async function loadMotionFromUrl(url, { signal } = {}) {
	let res;
	try {
		res = await fetch(url, { signal });
	} catch (err) {
		throw new NpzError(`motion download failed: ${err?.message || String(err)}`);
	}
	if (!res.ok) {
		throw new NpzError(`motion download failed (HTTP ${res.status})`);
	}
	const declared = Number(res.headers.get("content-length"));
	if (Number.isFinite(declared) && declared > MAX_ARCHIVE_BYTES) {
		throw new NpzError(`motion download is ${declared} bytes, over the ${MAX_ARCHIVE_BYTES} byte cap`);
	}
	let blob;
	try {
		blob = await res.blob();
	} catch (err) {
		throw new NpzError(`motion download failed: ${err?.message || String(err)}`);
	}
	if (blob.size > MAX_ARCHIVE_BYTES) {
		throw new NpzError(`motion download is ${blob.size} bytes, over the ${MAX_ARCHIVE_BYTES} byte cap`);
	}
	const buffer = await blob.arrayBuffer();
	const bytes = new Uint8Array(buffer);
	const motion = await decodeMotionNpz(bytes);
	// The validated archive rides along so a project save can embed the take
	// (src/motion-resources.js) without a second download. Playback keeps
	// reading the decoded arrays; nothing on that path looks at sourceBytes.
	motion.sourceBytes = bytes;
	return motion;
}

// Minimal STORE-only ZIP writer. No dependencies: we only need to bundle
// keyframe packs (PNGs, clips, JSON) without re-compressing them, so the
// classic ZIP container is written by hand. UTF-8 entry names get the
// language flag (bit 11) so tools like `unzip` decode them correctly.

const CRC_TABLE = (() => {
	const table = new Uint32Array(256);
	for (let n = 0; n < 256; n++) {
		let c = n;
		for (let k = 0; k < 8; k++) {
			c = (c & 1) ? (0xedb88320 ^ (c >>> 1)) : (c >>> 1);
		}
		table[n] = c >>> 0;
	}
	return table;
})();

/** CRC-32 (IEEE 802.3) of a byte sequence, as an unsigned 32-bit number. */
export function crc32(bytes) {
	let crc = 0xffffffff;
	for (let i = 0; i < bytes.length; i++) {
		crc = CRC_TABLE[(crc ^ bytes[i]) & 0xff] ^ (crc >>> 8);
	}
	return (crc ^ 0xffffffff) >>> 0;
}

const encoder = new TextEncoder();

// Fixed epoch so packs are byte-reproducible: 2026-01-01 00:00:00 local time.
const DOS_TIME = 0;
const DOS_DATE = ((2026 - 1980) << 9) | (1 << 5) | 1;

const FLAG_UTF8 = 0x0800;
const METHOD_STORE = 0;
const VERSION_NEEDED = 20;

function writeU16(bytes, offset, value) {
	bytes[offset] = value & 0xff;
	bytes[offset + 1] = (value >>> 8) & 0xff;
}

function writeU32(bytes, offset, value) {
	bytes[offset] = value & 0xff;
	bytes[offset + 1] = (value >>> 8) & 0xff;
	bytes[offset + 2] = (value >>> 16) & 0xff;
	bytes[offset + 3] = (value >>> 24) & 0xff;
}

/**
 * Build a STORE-only ZIP archive from in-memory entries.
 * @param {Array<{ name: string, data: Uint8Array | string }>} entries
 * @returns {Uint8Array} the raw ZIP bytes
 */
export function buildZip(entries) {
	if (!Array.isArray(entries)) throw new TypeError("buildZip expects an array of { name, data } entries");
	const prepared = entries.map((entry) => {
		const nameBytes = encoder.encode(entry.name);
		const data = typeof entry.data === "string" ? encoder.encode(entry.data) : entry.data;
		if (!(data instanceof Uint8Array)) throw new TypeError(`entry "${entry.name}" data must be a Uint8Array or string`);
		return { nameBytes, data, crc: crc32(data) };
	});

	const localSize = prepared.reduce((sum, e) => sum + 30 + e.nameBytes.length + e.data.length, 0);
	const centralSize = prepared.reduce((sum, e) => sum + 46 + e.nameBytes.length, 0);
	const out = new Uint8Array(localSize + centralSize + 22);

	let offset = 0;
	const headerOffsets = [];
	for (const { nameBytes, data, crc } of prepared) {
		headerOffsets.push(offset);
		writeU32(out, offset, 0x04034b50); // local file header signature
		writeU16(out, offset + 4, VERSION_NEEDED);
		writeU16(out, offset + 6, FLAG_UTF8);
		writeU16(out, offset + 8, METHOD_STORE);
		writeU16(out, offset + 10, DOS_TIME);
		writeU16(out, offset + 12, DOS_DATE);
		writeU32(out, offset + 14, crc);
		writeU32(out, offset + 18, data.length); // compressed (stored) size
		writeU32(out, offset + 22, data.length); // uncompressed size
		writeU16(out, offset + 26, nameBytes.length);
		writeU16(out, offset + 28, 0); // extra field length
		out.set(nameBytes, offset + 30);
		offset += 30 + nameBytes.length;
		out.set(data, offset);
		offset += data.length;
	}

	const centralOffset = offset;
	for (let i = 0; i < prepared.length; i++) {
		const { nameBytes, data, crc } = prepared[i];
		writeU32(out, offset, 0x02014b50); // central directory header signature
		writeU16(out, offset + 4, VERSION_NEEDED); // version made by
		writeU16(out, offset + 6, VERSION_NEEDED); // version needed
		writeU16(out, offset + 8, FLAG_UTF8);
		writeU16(out, offset + 10, METHOD_STORE);
		writeU16(out, offset + 12, DOS_TIME);
		writeU16(out, offset + 14, DOS_DATE);
		writeU32(out, offset + 16, crc);
		writeU32(out, offset + 20, data.length);
		writeU32(out, offset + 24, data.length);
		writeU16(out, offset + 28, nameBytes.length);
		writeU16(out, offset + 30, 0); // extra field length
		writeU16(out, offset + 32, 0); // comment length
		writeU16(out, offset + 34, 0); // disk number start
		writeU16(out, offset + 36, 0); // internal attributes
		writeU32(out, offset + 38, 0); // external attributes
		writeU32(out, offset + 42, headerOffsets[i]);
		out.set(nameBytes, offset + 46);
		offset += 46 + nameBytes.length;
	}

	const centralSizeActual = offset - centralOffset;
	writeU32(out, offset, 0x06054b50); // end of central directory signature
	writeU16(out, offset + 4, 0); // disk number
	writeU16(out, offset + 6, 0); // central directory disk
	writeU16(out, offset + 8, prepared.length);
	writeU16(out, offset + 10, prepared.length);
	writeU32(out, offset + 12, centralSizeActual);
	writeU32(out, offset + 16, centralOffset);
	writeU16(out, offset + 20, 0); // comment length
	return out;
}

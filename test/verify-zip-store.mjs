import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { crc32, buildZip } from "../src/zip-store.js";

const run = promisify(execFile);

assert.equal(crc32(new TextEncoder().encode("hello")), 0x3610a686, "crc32('hello') matches the known CRC-32 value");
assert.equal(crc32(new Uint8Array(0)), 0, "crc32 of the empty sequence is 0");
assert.equal(crc32(new TextEncoder().encode("The quick brown fox jumps over the lazy dog")), 0x414fa339, "crc32 matches the classic test vector");
console.log("PASS crc32: known vectors for 'hello', the empty sequence, and the quick brown fox");

const zip = buildZip([
	{ name: "notes/안녕.txt", data: "first entry, utf-8 name" },
	{ name: "frame.png", data: new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3]) },
]);

// Structural spot checks: local header, central directory, EOCD signatures.
const u16 = (o) => zip[o] | (zip[o + 1] << 8);
const u32 = (o) => (zip[o] | (zip[o + 1] << 8) | (zip[o + 2] << 16) | (zip[o + 3] << 24)) >>> 0;
assert.equal(u32(0), 0x04034b50, "starts with a local file header signature");
assert.equal(u16(6) & 0x0800, 0x0800, "UTF-8 flag (bit 11) is set on the local header");
assert.equal(u16(8), 0, "entries are STOREd, not deflated");
assert.equal(u32(14), crc32(new TextEncoder().encode("first entry, utf-8 name")), "local header stores the entry CRC");
assert.equal(u32(zip.length - 22), 0x06054b50, "ends with an end-of-central-directory signature");
assert.equal(u16(zip.length - 12), 2, "EOCD counts two entries");

const dir = await mkdtemp(join(tmpdir(), "cozyclay-zip-store-"));
const zipPath = join(dir, "pack.zip");
try {
	await writeFile(zipPath, zip);
	const { stdout } = await run("unzip", ["-t", zipPath]);
	assert.match(stdout, /No errors detected/, `unzip -t reports a healthy archive:\n${stdout}`);
	console.log("PASS buildZip: unzip -t accepts the archive");
	console.log(`  ${stdout.trim().split("\n").join("\n  ")}`);
} finally {
	await rm(dir, { recursive: true, force: true });
}

console.log("PASS zip-store: crc32 vectors, structure, and unzip -t on a written archive");

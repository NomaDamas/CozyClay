#!/usr/bin/env node
// Export-workspace helper: safe names, collision numbering, directory writes and
// the download fallback that keeps an export from getting lost.
import assert from "node:assert/strict";
import { sanitizeExportName, collisionName, writeBlobToDirectory, saveExport } from "../src/export-workspace.js";

class FakeFileHandle {
	constructor(directory, name) {
		this.directory = directory;
		this.name = name;
	}

	async createWritable() {
		return {
			write: async (blob) => {
				if (this.directory.failWrites) throw new Error("disk full");
				this.directory.files.set(this.name, blob);
			},
			close: async () => {},
			abort: async () => {},
		};
	}
}

class FakeDirectory {
	constructor(name = "Exports", { failWrites = false } = {}) {
		this.name = name;
		this.files = new Map();
		this.failWrites = failWrites;
	}

	async getFileHandle(name, options = {}) {
		if (this.files.has(name)) return new FakeFileHandle(this, name);
		if (options.create) {
			this.files.set(name, new Blob([]));
			return new FakeFileHandle(this, name);
		}
		throw Object.assign(new Error(`missing ${name}`), { name: "NotFoundError" });
	}

	async removeEntry(name) {
		this.files.delete(name);
	}
}

class ReadOnlyDirectory {
	constructor() { this.name = "Read only"; }

	async getFileHandle() {
		throw Object.assign(new Error("permission denied"), { name: "NotAllowedError" });
	}
}

assert.equal(sanitizeExportName("../../evil.mp4"), "evil.mp4", "path segments cannot escape the chosen folder");
assert.equal(sanitizeExportName("shot:01?.mp4"), "shot-01-.mp4", "reserved characters become dashes");
assert.equal(sanitizeExportName(".hidden"), "hidden", "leading dots are stripped");
assert.equal(sanitizeExportName("   "), "cozyclay-export", "a blank name gets a safe default");
console.log("PASS export names are sanitized without path traversal");

assert.equal(collisionName("shot.zip", 2), "shot (2).zip", "an extension stays on the numbered name");
assert.equal(collisionName("README", 1), "README (1)", "an extensionless name is numbered too");
console.log("PASS collision names keep their extension");

const directory = new FakeDirectory();
directory.files.set("shot.zip", new Blob(["old"]));
directory.files.set("shot (1).zip", new Blob(["older"]));
const written = await writeBlobToDirectory(directory, new Blob(["new"], { type: "application/zip" }), "shot.zip");
assert.equal(written.name, "shot (2).zip", "the first free numbered name is used");
assert.equal(await directory.files.get("shot (2).zip").text(), "new", "the new bytes land in the free file");
assert.equal(await directory.files.get("shot.zip").text(), "old", "an existing export is never overwritten");
console.log("PASS directory writes never overwrite an existing export");

const concurrent = new FakeDirectory();
const [firstRace, secondRace] = await Promise.all([
	writeBlobToDirectory(concurrent, new Blob(["one"]), "race.zip"),
	writeBlobToDirectory(concurrent, new Blob(["two"]), "race.zip"),
]);
assert.deepEqual([firstRace.name, secondRace.name].sort(), ["race (1).zip", "race.zip"], "overlapping writes claim different names");
assert.deepEqual((await Promise.all([...concurrent.files.values()].map((blob) => blob.text()))).sort(), ["one", "two"], "neither concurrent export is overwritten");
console.log("PASS overlapping writes are serialized into distinct files");

const failing = new FakeDirectory("Exports", { failWrites: true });
await assert.rejects(writeBlobToDirectory(failing, new Blob(["broken"]), "failed.zip"), /disk full/);
assert.equal(failing.files.has("failed.zip"), false, "a failed write leaves no empty target behind");
console.log("PASS a failed write removes its incomplete file");

const downloads = [];
const workspaceResult = await saveExport(new Blob(["pack"]), "shot.zip", {
	directory,
	download: (source, name) => downloads.push({ source, name }),
});
assert.equal(workspaceResult.method, "workspace");
assert.equal(workspaceResult.name, "shot (3).zip");
assert.equal(workspaceResult.folderName, "Exports");
assert.equal(downloads.length, 0, "a workspace write does not also download");
console.log("PASS a granted workspace receives the export without a browser download");

const fallbackDownloads = [];
const fallback = await saveExport(new Blob(["pack"]), "shot.zip", {
	directory: null,
	download: (source, name) => fallbackDownloads.push({ source, name }),
});
assert.equal(fallback.method, "download");
assert.equal(fallbackDownloads.length, 1, "no workspace falls back to one browser download");
assert.equal(fallbackDownloads[0].name, "shot.zip");
assert.ok(fallbackDownloads[0].source instanceof Blob, "the fallback receives the original export bytes");
console.log("PASS no workspace falls back to the existing browser download");

const failedDownloads = [];
const failed = await saveExport(new Blob(["pack"]), "shot.zip", {
	directory: new ReadOnlyDirectory(),
	download: (source, name) => failedDownloads.push({ source, name }),
});
assert.equal(failed.method, "download");
assert.equal(failed.reason, "workspace-write-failed");
assert.equal(failedDownloads.length, 1, "a workspace write failure still hands the export off");
assert.equal(failedDownloads[0].name, "shot.zip");
console.log("PASS a workspace failure falls back to a browser download");

const permissionDownloads = [];
const permission = await saveExport(new Blob(["pack"]), "permission.zip", {
	directory,
	permission: "prompt",
	download: (source, name) => permissionDownloads.push({ source, name }),
});
assert.equal(permission.method, "download");
assert.equal(permission.reason, "workspace-permission");
assert.equal(permissionDownloads.length, 1, "a demoted permission falls back to a browser download");
console.log("PASS a workspace needs granted permission before it receives an export");

const dataUrlDirectory = new FakeDirectory();
const dataUrlDownloads = [];
const dataUrl = `data:text/plain;base64,${Buffer.from("data-url").toString("base64")}`;
const dataUrlResult = await saveExport(dataUrl, "note.txt", {
	directory: dataUrlDirectory,
	download: (source, name) => dataUrlDownloads.push({ source, name }),
});
assert.equal(dataUrlResult.method, "workspace");
assert.equal(await dataUrlDirectory.files.get("note.txt").text(), "data-url", "a data URL is written as its decoded bytes");
assert.equal(dataUrlDownloads.length, 0);
console.log("PASS a data URL export is written to the workspace");

// export:saved: one closed method/reason pair per saved file, never a name.
const saved = [];
const spy = (event, props) => saved.push({ event, props });
const ignore = () => {};
await saveExport(new Blob(["a"]), "private-a.zip", { directory: new FakeDirectory(), download: ignore, track: spy });
await saveExport(new Blob(["b"]), "private-b.zip", { download: ignore, track: spy });
await saveExport(new Blob(["c"]), "private-c.zip", { directory: null, download: ignore, track: spy });
await saveExport(new Blob(["d"]), "private-d.zip", { directory: new FakeDirectory(), permission: "denied", download: ignore, track: spy });
await saveExport(new Blob(["e"]), "private-e.zip", { directory: new ReadOnlyDirectory(), download: ignore, track: spy });
assert.deepEqual(saved, [
	{ event: "export:saved", props: { method: "workspace", reason: "none" } },
	{ event: "export:saved", props: { method: "download", reason: "unsupported" } },
	{ event: "export:saved", props: { method: "download", reason: "no_workspace" } },
	{ event: "export:saved", props: { method: "download", reason: "permission" } },
	{ event: "export:saved", props: { method: "download", reason: "write_failed" } },
]);
console.log("PASS every save reports export:saved with its method and closed fallback reason");

console.log("all export workspace checks PASS");

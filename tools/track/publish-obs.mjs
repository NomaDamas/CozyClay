#!/usr/bin/env node
/**
 * publish-obs.mjs - publish the mannequin observations an `obs-bench --extract`
 * run produced into the shared obs root that later runs read
 * (tools/bench/obs-bench.mjs ensureObs: <obsRoot>/<set>/<name>/g5/obs.npz).
 *
 *   node tools/track/publish-obs.mjs --run <obs-bench out dir> --obs-root <dir> [--dry-run]
 *
 * For every <run>/<set>/<name>/obs-mannequin/{obs.npz,manifest.json,extract.log}:
 *   - the manifest must describe a genuine extraction (no `source`: not itself
 *     a copy from an obs root) whose signature still matches the video on disk
 *     (sha256(video sha, K, betas, wrapper sha, detector, keypoints), the
 *     formula obs-bench signs extractions with), so the obs belong to that video;
 *   - obs.npz and extract.log are copied; manifest.json is the run's manifest
 *     plus videoSha256, obsSha256 and publishedFrom (deterministic content);
 *   - an existing target file with different bytes is never replaced: the item
 *     is refused and nothing of it is written. Identical files are left alone.
 * Writes <run>/publish.json and exits 1 when any item is refused or incomplete.
 */
import { createHash } from "node:crypto";
import { copyFileSync, existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const sha = (...parts) => { const h = createHash("sha256"); for (const p of parts) h.update(p); return h.digest("hex"); };
const fileSha = (path) => sha(readFileSync(path));
const FILES = ["obs.npz", "extract.log", "manifest.json"];

export const USAGE = "usage: node tools/track/publish-obs.mjs --run <obs-bench out dir> --obs-root <dir> [--dry-run]";

export function parseArgs(argv) {
	const o = { dryRun: false };
	for (let i = 0; i < argv.length; i += 1) {
		const flag = argv[i];
		if (flag === "--dry-run") { o.dryRun = true; continue; }
		if (flag === "--help" || flag === "-h") { o.help = true; continue; }
		if (flag !== "--run" && flag !== "--obs-root") throw new Error(`unknown option ${flag}`);
		const value = argv[++i];
		if (value === undefined || value.startsWith("--")) throw new Error(`${flag} needs a value`);
		o[flag === "--run" ? "run" : "obsRoot"] = resolve(value);
	}
	if (!o.help && (!o.run || !o.obsRoot)) throw new Error("--run and --obs-root are required");
	return o;
}

/** <run>/<set>/<name>/obs-mannequin dirs. */
export function runItems(run) {
	const dirs = (p) => readdirSync(p).filter((n) => statSync(join(p, n)).isDirectory());
	const out = [];
	for (const set of dirs(run)) for (const name of dirs(join(run, set))) if (existsSync(join(run, set, name, "obs-mannequin"))) out.push({ set, name, dir: join(run, set, name, "obs-mannequin") });
	return out;
}

/** The files to publish for one item, or a reason it cannot be published. */
export function plan({ set, name, dir }, obsRoot) {
	const label = `${set}/${name}`;
	const missing = FILES.filter((f) => !existsSync(join(dir, f)));
	if (missing.length) return { item: label, status: "incomplete", missing };
	let manifest;
	try { manifest = JSON.parse(readFileSync(join(dir, "manifest.json"), "utf8")); } catch (error) { return { item: label, status: "refused", reason: `unreadable manifest.json: ${error.message}` }; }
	if (!manifest || typeof manifest !== "object") return { item: label, status: "refused", reason: "manifest.json is not an object" };
	if (manifest.source) return { item: label, status: "refused", reason: `manifest records source ${manifest.source}: a copy from an obs root, not an extraction` };
	for (const key of ["signature", "video", "K", "betas", "detector", "keypoints", "wrapperSha256"]) if (manifest[key] === undefined) return { item: label, status: "refused", reason: `manifest has no ${key}` };
	if (!existsSync(manifest.video)) return { item: label, status: "refused", reason: `video ${manifest.video} is gone` };
	const videoSha256 = fileSha(manifest.video);
	const signature = sha(videoSha256, JSON.stringify(manifest.K), JSON.stringify(manifest.betas), manifest.wrapperSha256, manifest.detector, manifest.keypoints);
	if (signature !== manifest.signature) return { item: label, status: "refused", reason: `signature mismatch: ${manifest.video} (sha256 ${videoSha256}) is not the video these obs were extracted from` };
	const obsSha256 = fileSha(join(dir, "obs.npz"));
	const published = `${JSON.stringify({ ...manifest, videoSha256, obsSha256, publishedFrom: dir }, null, "\t")}\n`;
	const target = join(obsRoot, set, name, "g5");
	const files = [
		{ name: "obs.npz", bytes: readFileSync(join(dir, "obs.npz")), from: join(dir, "obs.npz") },
		{ name: "extract.log", bytes: readFileSync(join(dir, "extract.log")), from: join(dir, "extract.log") },
		{ name: "manifest.json", bytes: Buffer.from(published) },
	].map((f) => ({ ...f, to: join(target, f.name), state: !existsSync(join(target, f.name)) ? "new" : readFileSync(join(target, f.name)).equals(f.bytes) ? "same" : "different" }));
	const clash = files.filter((f) => f.state === "different");
	if (clash.length) return { item: label, status: "refused", reason: `existing different file(s) not overwritten: ${clash.map((f) => f.to).join(", ")}`, target };
	return { item: label, status: files.every((f) => f.state === "same") ? "same" : "publish", target, videoSha256, obsSha256, detector: manifest.detector, files };
}

export function publish(options) {
	const results = runItems(options.run).map((item) => {
		const p = plan(item, options.obsRoot);
		if (p.status === "publish" && !options.dryRun) {
			mkdirSync(p.target, { recursive: true });
			for (const f of p.files) if (f.state === "new") (f.from ? copyFileSync(f.from, f.to) : writeFileSync(f.to, f.bytes));
			// Read back: what is on disk is what was planned.
			for (const f of p.files) if (!readFileSync(f.to).equals(f.bytes)) throw new Error(`${f.to}: read-back differs after publishing`);
			p.status = "published";
		}
		const { files, ...rest } = p;
		return { ...rest, ...(files ? { files: files.map((f) => ({ name: f.name, state: f.state })) } : {}) };
	});
	return { run: options.run, obsRoot: options.obsRoot, dryRun: options.dryRun, createdAt: new Date().toISOString(), results, ok: results.length > 0 && results.every((r) => ["published", "same", "publish"].includes(r.status)) };
}

export function main(argv = process.argv.slice(2)) {
	let options;
	try { options = parseArgs(argv); } catch (error) { console.error(`publish-obs: ${error.message}\n${USAGE}`); return 2; }
	if (options.help) { console.log(USAGE); return 0; }
	const report = publish(options);
	for (const r of report.results) console.log(`${r.item}: ${r.status}${r.reason ? ` - ${r.reason}` : ""}${r.missing ? ` - missing ${r.missing.join(", ")}` : ""}`);
	if (!report.results.length) console.error(`publish-obs: no <set>/<name>/obs-mannequin under ${options.run}`);
	if (!options.dryRun) writeFileSync(join(options.run, "publish.json"), `${JSON.stringify(report, null, "\t")}\n`);
	return report.ok ? 0 : 1;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) process.exitCode = main();

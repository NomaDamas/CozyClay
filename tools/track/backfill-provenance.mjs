#!/usr/bin/env node
/**
 * backfill-provenance.mjs - give sweep obs that never recorded their video a
 * provenance manifest (#500, plan todo 22c).
 *
 *   node tools/track/backfill-provenance.mjs --approved <approved.json> [--approved <more.json>] --obs-root <dir> [--dry-run]
 *
 * For every approved item and each <obs-root>/<set>/<name>/{base,g5}/obs.npz:
 *   - a manifest that already records videoSha256 (provenance absent or
 *     "recorded", e.g. publish-obs skin manifests) is left byte-for-byte alone;
 *   - otherwise the video is the one the manifest names, or (no manifest) the
 *     path the obs sweep extracted from - item.video ?? <dir>/<variant>/video.mp4,
 *     masks.mjs itemMaskInputs - and it must not be newer than the obs
 *     (masks.mjs checkObsVideo's `obs-video-newer` rule), else the item is refused;
 *   - manifest.json gains { video, videoSha256, obsSha256, detector (from
 *     extract.log when the manifest has none), provenance: "backfilled-path",
 *     backfilledAt, backfilledBy }. obs.npz is never written; its sha is checked
 *     unchanged after the manifest is written;
 *   - an earlier backfill with the same video/obs sha is left alone ("same");
 *     one that disagrees is refused.
 * Exits 1 when any obs is refused.
 */
import { createHash } from "node:crypto";
import { existsSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { checkObsVideo, itemMaskInputs } from "./masks.mjs";

export const USAGE = "usage: node tools/track/backfill-provenance.mjs --approved <approved.json> [--approved <more.json>] --obs-root <dir> [--dry-run]";
export const KINDS = ["base", "g5"];
const BY = "tools/track/backfill-provenance.mjs";
const fileSha = (path) => createHash("sha256").update(readFileSync(path)).digest("hex");

export function parseArgs(argv) {
	const o = { approved: [], dryRun: false };
	for (let i = 0; i < argv.length; i += 1) {
		const flag = argv[i];
		if (flag === "--dry-run") { o.dryRun = true; continue; }
		if (flag === "--help" || flag === "-h") { o.help = true; continue; }
		if (flag !== "--approved" && flag !== "--obs-root") throw new Error(`unknown option ${flag}`);
		const value = argv[++i];
		if (value === undefined || value.startsWith("--")) throw new Error(`${flag} needs a value`);
		if (flag === "--approved") o.approved.push(resolve(value)); else o.obsRoot = resolve(value);
	}
	if (!o.help && (!o.approved.length || !o.obsRoot)) throw new Error("--approved and --obs-root are required");
	return o;
}

/** "palette" | "yolo" | ... from the wrapper's "detector: <name> selected" log line, or null. */
export function detectorFromLog(path) {
	if (!existsSync(path)) return null;
	return /detector: ([A-Za-z0-9_-]+) selected/.exec(readFileSync(path, "latin1"))?.[1] ?? null;
}

/** What to do for one obs dir; never writes. */
export function plan(item, kind, obsRoot, now = new Date().toISOString()) {
	const label = `${item.set}/${item.name}/${kind}`;
	const dir = join(obsRoot, item.set, item.name, kind), obs = join(dir, "obs.npz"), manifestPath = join(dir, "manifest.json");
	if (!existsSync(obs)) return null;
	let manifest = null;
	if (existsSync(manifestPath)) {
		try { manifest = JSON.parse(readFileSync(manifestPath, "utf8")); } catch (error) { return { item: label, status: "refused", reason: `unreadable manifest.json: ${error.message}` }; }
		if (!manifest || typeof manifest !== "object" || Array.isArray(manifest)) return { item: label, status: "refused", reason: "manifest.json is not an object" };
		if (manifest.source) return { item: label, status: "refused", reason: `manifest is a copy of ${manifest.source}, not an obs root manifest` };
		if (manifest.videoSha256 && (manifest.provenance ?? "recorded") === "recorded") return { item: label, status: "recorded", video: manifest.video ?? null, videoSha256: manifest.videoSha256 };
	}
	const video = resolve(manifest?.video ?? itemMaskInputs(item, { obsRoot }).video);
	if (!existsSync(video)) return { item: label, status: "refused", reason: `video ${video} is missing` };
	const videoSha256 = fileSha(video), obsSha256 = fileSha(obs);
	try { checkObsVideo({ origin: null, videoSha256, obsSha256, videoPath: video, videoMtimeMs: statSync(video).mtimeMs, obsMtimeMs: statSync(obs).mtimeMs }); }
	catch (error) { return { item: label, status: "refused", reason: error.message }; }
	if (manifest?.provenance === "backfilled-path") {
		if (manifest.videoSha256 === videoSha256 && manifest.obsSha256 === obsSha256 && manifest.video === video) return { item: label, status: "same", video, videoSha256 };
		return { item: label, status: "refused", reason: `existing backfill (video ${manifest.videoSha256}, obs ${manifest.obsSha256}) disagrees with ${video} (${videoSha256}) / obs ${obsSha256}` };
	}
	if (manifest && manifest.provenance !== undefined) return { item: label, status: "refused", reason: `manifest provenance ${manifest.provenance} is neither recorded nor backfilled-path` };
	const detector = manifest?.detector ?? detectorFromLog(join(dir, "extract.log"));
	const next = {
		...(manifest ?? {}),
		video, videoSha256, obsSha256,
		detector, ...(manifest?.detector ? {} : { detectorSource: detector ? "extract.log" : "unknown" }),
		provenance: "backfilled-path", backfilledAt: now, backfilledBy: BY,
		backfillRule: "video = the path the obs sweep extracted from (item.video ?? <dir>/<variant>/video.mp4), hashed after the fact; not newer than obs.npz",
	};
	return { item: label, status: "backfill", manifestPath, obs, obsSha256, video, videoSha256, detector, bytes: `${JSON.stringify(next, null, "\t")}\n` };
}

export function backfill({ approved, obsRoot, dryRun = false, now }) {
	const items = approved.flatMap((path) => JSON.parse(readFileSync(path, "utf8")).items ?? []);
	const results = [];
	for (const item of items) for (const kind of KINDS) {
		const p = plan(item, kind, obsRoot, now);
		if (!p) continue;
		if (p.status === "backfill" && !dryRun) {
			writeFileSync(p.manifestPath, p.bytes);
			if (fileSha(p.obs) !== p.obsSha256) throw new Error(`${p.obs} changed while backfilling`);
			p.status = "backfilled";
		}
		const { bytes, ...rest } = p;
		results.push(rest);
	}
	return { obsRoot, dryRun, results, ok: results.length > 0 && results.every((r) => r.status !== "refused") };
}

export function main(argv = process.argv.slice(2)) {
	let options;
	try { options = parseArgs(argv); } catch (error) { console.error(`backfill-provenance: ${error.message}\n${USAGE}`); return 2; }
	if (options.help) { console.log(USAGE); return 0; }
	const report = backfill(options);
	for (const r of report.results) console.log(`${r.item}: ${r.status}${r.reason ? ` - ${r.reason}` : ""}${r.videoSha256 ? ` video=${r.video} sha=${r.videoSha256.slice(0, 12)}` : ""}${r.detector ? ` detector=${r.detector}` : ""}`);
	const counts = report.results.reduce((acc, r) => ({ ...acc, [r.status]: (acc[r.status] ?? 0) + 1 }), {});
	console.log(`backfill-provenance: ${Object.entries(counts).map(([k, v]) => `${k} ${v}`).join(", ") || "no obs found"}${options.dryRun ? " (dry run)" : ""}`);
	return report.ok ? 0 : 1;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) process.exitCode = main();

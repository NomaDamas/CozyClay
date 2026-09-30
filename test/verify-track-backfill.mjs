import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { backfill, detectorFromLog } from "../tools/track/backfill-provenance.mjs";

const sha = (bytes) => createHash("sha256").update(bytes).digest("hex");
const root = mkdtempSync(join(tmpdir(), "track-backfill-"));
try {
	const obsRoot = join(root, "cache"), data = join(root, "data");
	const old = new Date("2026-01-01T00:00:00Z"), later = new Date("2026-02-01T00:00:00Z");
	// Truth item: sweep video is <dir>/<variant>/video.mp4; fal item: item.video.
	const items = [
		{ set: "gt", name: "walk", variant: "shaded", dir: join(data, "gt-walk") },
		{ set: "fal", name: "stepup-skin-02", variant: "skin", dir: join(data, "gt-stepup"), video: join(data, "fal-stepup-skin-02.mp4") },
		{ set: "gt", name: "late", variant: "shaded", dir: join(data, "gt-late") },
	];
	const skin = [{ set: "gt-skin", name: "walk", variant: "skin", dir: join(data, "gt-walk") }];
	const videoOf = (item) => item.video ?? join(item.dir, item.variant, "video.mp4");
	for (const item of [...items, ...skin]) {
		mkdirSync(join(videoOf(item), ".."), { recursive: true });
		writeFileSync(videoOf(item), `video ${item.set}/${item.name}`);
		utimesSync(videoOf(item), old, old);
	}
	const obsDir = (item, kind) => join(obsRoot, item.set, item.name, kind);
	for (const item of items) for (const kind of ["base", "g5"]) {
		mkdirSync(obsDir(item, kind), { recursive: true });
		writeFileSync(join(obsDir(item, kind), "obs.npz"), `obs ${item.name} ${kind}`);
		writeFileSync(join(obsDir(item, kind), "extract.log"), `[cclay] detector: ${item.variant === "skin" ? "yolo" : "palette"} selected\n`);
		utimesSync(join(obsDir(item, kind), "obs.npz"), later, later);
	}
	// The late item's video was rewritten after its obs: the path cannot be vouched for.
	utimesSync(videoOf(items[2]), new Date("2026-03-01T00:00:00Z"), new Date("2026-03-01T00:00:00Z"));
	// A publish-obs skin manifest already records its video: it must stay byte-for-byte.
	mkdirSync(obsDir(skin[0], "g5"), { recursive: true });
	writeFileSync(join(obsDir(skin[0], "g5"), "obs.npz"), "obs skin");
	const skinManifest = `${JSON.stringify({ video: videoOf(skin[0]), videoSha256: sha(readFileSync(videoOf(skin[0]))), detector: "yolo" }, null, "\t")}\n`;
	writeFileSync(join(obsDir(skin[0], "g5"), "manifest.json"), skinManifest);
	const approved = join(root, "approved.json"), approvedSkin = join(root, "approved-skin.json");
	writeFileSync(approved, JSON.stringify({ items }));
	writeFileSync(approvedSkin, JSON.stringify({ items: skin }));
	const obsBefore = Object.fromEntries([...items].flatMap((item) => ["base", "g5"].map((kind) => [`${item.name}/${kind}`, sha(readFileSync(join(obsDir(item, kind), "obs.npz")))])));

	assert.equal(detectorFromLog(join(obsDir(items[0], "g5"), "extract.log")), "palette");
	const dry = backfill({ approved: [approved, approvedSkin], obsRoot, dryRun: true });
	assert.equal(dry.results.filter((r) => r.status === "backfill").length, 4);
	assert.throws(() => readFileSync(join(obsDir(items[0], "g5"), "manifest.json")), /ENOENT/, "dry run writes nothing");

	const report = backfill({ approved: [approved, approvedSkin], obsRoot, now: "2026-09-30T00:00:00.000Z" });
	const status = Object.fromEntries(report.results.map((r) => [r.item, r.status]));
	assert.deepEqual(status, {
		"gt/walk/base": "backfilled", "gt/walk/g5": "backfilled",
		"fal/stepup-skin-02/base": "backfilled", "fal/stepup-skin-02/g5": "backfilled",
		"gt/late/base": "refused", "gt/late/g5": "refused",
		"gt-skin/walk/g5": "recorded",
	});
	assert.equal(report.ok, false, "a refused obs fails the run");
	assert.match(report.results.find((r) => r.item === "gt/late/g5").reason, /^obs-video-newer/);
	assert.throws(() => readFileSync(join(obsDir(items[2], "g5"), "manifest.json")), /ENOENT/, "refused obs get no manifest");

	const truth = JSON.parse(readFileSync(join(obsDir(items[0], "g5"), "manifest.json"), "utf8"));
	assert.equal(truth.provenance, "backfilled-path");
	assert.equal(truth.backfilledAt, "2026-09-30T00:00:00.000Z");
	assert.equal(truth.video, videoOf(items[0]));
	assert.equal(truth.videoSha256, sha(readFileSync(videoOf(items[0]))));
	assert.equal(truth.obsSha256, obsBefore["walk/g5"]);
	assert.equal(truth.detector, "palette");
	const fal = JSON.parse(readFileSync(join(obsDir(items[1], "g5"), "manifest.json"), "utf8"));
	assert.equal(fal.video, items[1].video, "fal backfills the approved clip, not a run's normalised copy");
	assert.equal(fal.detector, "yolo");
	for (const item of items) for (const kind of ["base", "g5"]) assert.equal(sha(readFileSync(join(obsDir(item, kind), "obs.npz"))), obsBefore[`${item.name}/${kind}`], "obs.npz untouched");
	assert.equal(readFileSync(join(obsDir(skin[0], "g5"), "manifest.json"), "utf8"), skinManifest, "recorded manifest unchanged");

	// Idempotent: a second run leaves the backfill (and its timestamp) alone.
	const again = backfill({ approved: [approved], obsRoot, now: "2026-10-01T00:00:00.000Z" });
	assert.equal(again.results.find((r) => r.item === "gt/walk/g5").status, "same");
	assert.equal(JSON.parse(readFileSync(join(obsDir(items[0], "g5"), "manifest.json"), "utf8")).backfilledAt, "2026-09-30T00:00:00.000Z");
	// A video that changed since the backfill is refused, never re-hashed over.
	writeFileSync(videoOf(items[0]), "different video");
	utimesSync(videoOf(items[0]), old, old);
	const changed = backfill({ approved: [approved], obsRoot });
	assert.equal(changed.results.find((r) => r.item === "gt/walk/g5").status, "refused");
	assert.match(changed.results.find((r) => r.item === "gt/walk/g5").reason, /existing backfill/);

	console.log("verify-track-backfill: backfills shaded/fal sweep obs by path, keeps recorded manifests and obs.npz unchanged, refuses newer videos, idempotent");
} finally { rmSync(root, { recursive: true, force: true }); }

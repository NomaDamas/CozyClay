#!/usr/bin/env node
// #500 todo 5: the SAM2 mask cache is keyed by content (video, obs, masks.py,
// params), a cache hit needs the outputs' recorded sha256 (corrupt files are
// recomputed, never served), and masks are computed from the video the obs was
// extracted from (recorded video sha must match; copy manifests are followed).
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { cacheState, checkObsVideo, itemMaskInputs, masksCacheKey, parseArgs, remoteTimeoutS, resolveObsOrigin, selectMaskItems, USAGE, validateMasksNpz } from "../tools/track/masks.mjs";

const sha = (c) => c.repeat(64);
const base = { videoSha256: sha("a"), obsSha256: sha("b"), scriptSha256: sha("c"), params: { chunkFrames: 180 } };
const key = masksCacheKey(base);
assert.match(key, /^[0-9a-f]{64}$/);
assert.equal(masksCacheKey({ ...base, params: { chunkFrames: 180 } }), key, "deterministic");
for (const change of [{ videoSha256: sha("d") }, { obsSha256: sha("d") }, { scriptSha256: sha("d") }, { params: { chunkFrames: 90 } }]) {
	assert.notEqual(masksCacheKey({ ...base, ...change }), key, `key must change with ${Object.keys(change)[0]}`);
}
assert.throws(() => masksCacheKey({ ...base, scriptSha256: "" }), /sha256/);

// Cache state: key, presence and content integrity.
const good = { key, masksSha256: sha("1"), masksJsonSha256: sha("2") };
const files = { npz: sha("1"), json: sha("2") };
assert.equal(cacheState(good, key, files), "cached");
assert.equal(cacheState({ ...good, key: masksCacheKey({ ...base, scriptSha256: sha("e") }) }, key, files), "stale-key", "an edited masks.py invalidates");
assert.equal(cacheState(good, key, { ...files, npz: sha("9") }), "corrupt", "a changed/truncated masks.npz is not served");
assert.equal(cacheState(good, key, { ...files, json: sha("9") }), "corrupt");
assert.equal(cacheState({ key }, key, files), "unverifiable", "a manifest without output shas cannot vouch for the files");
assert.equal(cacheState(good, key, null), "missing");
assert.equal(cacheState(null, key, files), "stale-unmanifested");
assert.equal(cacheState(null, key, null), "missing");

// Provenance: recorded video sha must match; without a record, a video newer than the obs is rejected.
const recorded = { video: "/e/gt/walk/skin/video.mp4", videoSha256: sha("a"), obsSha256: sha("b") };
assert.equal(checkObsVideo({ origin: recorded, videoSha256: sha("a"), obsSha256: sha("b"), videoPath: "v", videoMtimeMs: 2, obsMtimeMs: 1 }).provenance, "recorded");
assert.throws(() => checkObsVideo({ origin: recorded, videoSha256: sha("f"), obsSha256: sha("b"), videoPath: "v", videoMtimeMs: 0, obsMtimeMs: 1 }), /obs-video-mismatch/);
assert.throws(() => checkObsVideo({ origin: recorded, videoSha256: sha("a"), obsSha256: sha("f"), videoPath: "v", videoMtimeMs: 0, obsMtimeMs: 1 }), /obs-sha-mismatch/);
assert.equal(checkObsVideo({ origin: null, videoSha256: sha("a"), obsSha256: sha("b"), videoPath: "v", videoMtimeMs: 1, obsMtimeMs: 2 }).provenance, "path-only");
assert.throws(() => checkObsVideo({ origin: null, videoSha256: sha("a"), obsSha256: sha("b"), videoPath: "re-encode.mp4", videoMtimeMs: 3, obsMtimeMs: 2 }), /obs-video-newer/);
// Regression (todo 22 follow-up): the origin's label is carried through unchanged, never upgraded to "recorded".
const check = (origin) => checkObsVideo({ origin, videoSha256: sha("a"), obsSha256: sha("b"), videoPath: "v", videoMtimeMs: 1, obsMtimeMs: 2 });
assert.equal(check({ ...recorded, provenance: "recorded" }).provenance, "recorded");
assert.deepEqual(check({ ...recorded, provenance: "backfilled-path", backfilledAt: "2026-09-30T00:00:00.000Z" }), { provenance: "backfilled-path", recordedVideoSha256: sha("a"), recordedVideo: recorded.video });
assert.throws(() => checkObsVideo({ origin: { ...recorded, provenance: "backfilled-path" }, videoSha256: sha("f"), obsSha256: sha("b"), videoPath: "v", videoMtimeMs: 1, obsMtimeMs: 2 }), /obs-video-mismatch/, "a backfilled sha is enforced like a recorded one");
assert.equal(check({ video: "/e/v.mp4", provenance: "path-only" }).provenance, "path-only");
assert.throws(() => checkObsVideo({ origin: { provenance: "path-only" }, videoSha256: sha("a"), obsSha256: sha("b"), videoPath: "v", videoMtimeMs: 3, obsMtimeMs: 2 }), /obs-video-newer/);
assert.throws(() => check({ ...recorded, provenance: "path-only" }), /obs-provenance-invalid/);
assert.throws(() => check({ video: "/e/v.mp4", provenance: "backfilled-path" }), /obs-provenance-invalid/, "a hashed label without a sha is not silently downgraded");
assert.throws(() => check({ ...recorded, provenance: "guessed" }), /obs-provenance-unknown/);

// Copy manifests (obs-bench's obs-mannequin/manifest.json) lead back to the source obs.
const dir = mkdtempSync(join(tmpdir(), "verify-track-masks-"));
try {
	const fileSha = (p) => createHash("sha256").update(readFileSync(p)).digest("hex");
	mkdirSync(join(dir, "cache/g5"), { recursive: true });
	mkdirSync(join(dir, "run/obs-mannequin"), { recursive: true });
	writeFileSync(join(dir, "cache/g5/obs.npz"), "OBS");
	writeFileSync(join(dir, "cache/g5/manifest.json"), JSON.stringify(recorded));
	writeFileSync(join(dir, "run/obs-mannequin/obs.npz"), "OBS");
	writeFileSync(join(dir, "run/obs-mannequin/manifest.json"), JSON.stringify({ source: join(dir, "cache/g5/obs.npz"), sourceSha256: fileSha(join(dir, "cache/g5/obs.npz")), video: "/run/input/video.mp4" }));
	const origin = resolveObsOrigin(join(dir, "run/obs-mannequin/obs.npz"));
	assert.equal(origin.obs, join(dir, "cache/g5/obs.npz"));
	assert.equal(origin.manifest.videoSha256, sha("a"), "the recorded sha comes from the source obs, not the copy's video path");
	assert.deepEqual(origin.copies, [join(dir, "run/obs-mannequin/obs.npz")]);
	// A backfill-provenance.mjs manifest on the origin reaches the masks manifest as backfilled-path through the copy chain.
	writeFileSync(join(dir, "cache/g5/manifest.json"), JSON.stringify({ ...recorded, obsSha256: fileSha(join(dir, "cache/g5/obs.npz")), provenance: "backfilled-path", backfilledAt: "2026-09-30T00:00:00.000Z" }));
	const backfilled = resolveObsOrigin(join(dir, "run/obs-mannequin/obs.npz"));
	assert.equal(checkObsVideo({ origin: backfilled.manifest, videoSha256: sha("a"), obsSha256: fileSha(backfilled.obs), videoPath: "v", videoMtimeMs: 1, obsMtimeMs: 2 }).provenance, "backfilled-path");
	writeFileSync(join(dir, "run/obs-mannequin/obs.npz"), "TAMPERED");
	assert.throws(() => resolveObsOrigin(join(dir, "run/obs-mannequin/obs.npz")), /obs-copy-mismatch/);
	// A fetched masks.npz that is not a valid mask archive is rejected before it reaches the cache.
	writeFileSync(join(dir, "bad.npz"), "not a zip");
	assert.throws(() => validateMasksNpz(join(dir, "bad.npz"), 124));
} finally {
	rmSync(dir, { recursive: true, force: true });
}

assert.ok(remoteTimeoutS(124) >= 120 && remoteTimeoutS(124) <= 300);
assert.ok(remoteTimeoutS(362) > remoteTimeoutS(124) && remoteTimeoutS(1e6) === 1800);

const gt = { set: "gt-skin", name: "walk", variant: "skin", dir: "/e/gt/walk" };
assert.deepEqual(itemMaskInputs(gt, { obsRoot: "/c" }), { video: "/e/gt/walk/skin/video.mp4", obs: "/c/gt-skin/walk/g5/obs.npz", outDir: "/c/gt-skin/walk/masks" });
const fal = { set: "fal", name: "bump-skin-01", variant: "skin", dir: "/e/exp3/gt/bump", video: "/e/exp3/fal/clips/bump-skin-01/video.mp4" };
assert.equal(itemMaskInputs(fal, { obsRoot: "/c" }).video, fal.video, "fal masks use the approved clip the obs sweep extracted from, not a run's re-encode");

const approved = { items: [gt, fal, { ...gt, set: "gt" }] };
assert.deepEqual(selectMaskItems(approved, ["gt-skin/walk"]), [gt]);
assert.throws(() => selectMaskItems(approved, ["walk"]), /ambiguous/);
assert.throws(() => selectMaskItems(approved, ["nope"]), /not in the approved list/);

assert.equal(parseArgs(["--approved", "a.json"]).cacheRoot, "evidence/obs/cache");
assert.throws(() => parseArgs(["--video", "v.mp4"]), (e) => e.message === USAGE);
assert.throws(() => parseArgs(["--approved", "a.json", "--chunk-frames", "1"]), /chunk-frames/);
assert.throws(() => parseArgs(["--approved", "a.json", "--fal-video-root", "x"]), /unknown argument/);

// The box-side script never names truth or scorer inputs.
const script = readFileSync(new URL("../tools/track/py/masks.py", import.meta.url), "utf8");
assert.ok(!/plate\.png|\/mask\/|joints\.json|gt-motions/.test(script), "masks.py must not read truth artifacts");
console.log("verify-track-masks: cache key, integrity, provenance and item inputs passed");

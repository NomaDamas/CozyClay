#!/usr/bin/env node
/**
 * The Multi-Model footage ingest, driven as the app drives it.
 *
 * WHY this suite exists: the panel's job is to turn an address into REAL
 * numbers on the timeline. A staging UI that reports "ready" without having
 * read a single byte is the exact failure this project keeps finding, so every
 * assertion here is about measured input: named rejections for addresses that
 * cannot be fetched, streamed progress that never invents a denominator, and
 * frame maths derived from a probed duration and a measured rate.
 */
import assert from "node:assert/strict";
import {
	downloadProgress,
	fetchFootageBlob,
	footageSummary,
	fpsFromFrameTimes,
	frameCountFor,
	normalizeSourceUrl,
	probeFootage,
	requestBridgeFootage,
	segmentationReceipt,
	sourceLabel,
	trajectoryReceipt,
} from "../src/multimodel-ingest.js";

let failures = 0;
assert.equal(trajectoryReceipt(null), "");
assert.equal(segmentationReceipt(null), "");
assert.match(segmentationReceipt({ detector: "palette", detectionRate: .98, coverage: { mean: .12 }, longestGapFrames: 2, hueErrorDeg: { p95: 8 } }, true), /98%.*12%.*2프레임.*8°/);
assert.match(trajectoryReceipt({ status: "unchanged", rejected: [{ reason: "world-endpoint-unsettled" }] }), /not applied.*never settles/);
assert.match(trajectoryReceipt({ status: "corrected", changedFrames: 67, rejected: [{ reason: "uncertain-depth" }] }, true), /67프레임.*1구간 미해결/);
assert.match(trajectoryReceipt({ status: "disabled" }, true), /꺼짐/);
const ok = (name, condition, detail = "") => {
	console.log(`${condition ? "PASS" : "FAIL"} ${name}${condition ? "" : ` — ${detail}`}`);
	if (!condition) failures += 1;
};

/* ------------------------------- addresses ------------------------------- */

ok("an absolute https address normalises", normalizeSourceUrl("https://example.com/a.mp4").url === "https://example.com/a.mp4");
ok("a root-relative path is kept verbatim", normalizeSourceUrl("/media/cozyclay-demo.mp4").url === "/media/cozyclay-demo.mp4");
ok("surrounding whitespace is trimmed, not rejected", normalizeSourceUrl("  /media/a.mp4  ").url === "/media/a.mp4");
ok("an empty address is refused by name", normalizeSourceUrl("   ").reason === "url-empty");
ok("a protocol-relative address is refused by name", normalizeSourceUrl("//evil.example/a.mp4").reason === "url-protocol-relative");
ok("a javascript: address is refused by name", normalizeSourceUrl("javascript:alert(1)").reason === "url-scheme-unsupported");
ok("a data: address is refused by name", normalizeSourceUrl("data:video/mp4;base64,AAA").reason === "url-scheme-unsupported");
ok("a non-string address is refused by name", normalizeSourceUrl(null).reason === "url-not-string");
// A player page is not footage, and the platform blocks the read anyway;
// reporting it as a network fault sends the user debugging their own wifi.
ok("a YouTube watch page is refused as a page, not as a network fault", normalizeSourceUrl("https://www.youtube.com/watch?v=dQw4w9WgXcQ").reason === "url-platform-page");
ok("a youtu.be short link is refused the same way", normalizeSourceUrl("https://youtu.be/dQw4w9WgXcQ").reason === "url-platform-page");
ok("a Vimeo page is refused the same way", normalizeSourceUrl("https://vimeo.com/123456").reason === "url-platform-page");
ok("a direct file on an ordinary host is still accepted", normalizeSourceUrl("https://cdn.example.com/boxing.mp4").ok === true);
ok("a host merely containing youtube in a label is not caught", normalizeSourceUrl("https://youtube.example.com/a.mp4").ok === true);

ok("the label is the file, not the query", sourceLabel("https://h/x/boxing.mp4?token=abc#t=1") === "boxing.mp4");

/* -------------------------------- progress ------------------------------- */

ok("progress is a ratio while the total is known", downloadProgress(50, 200) === 0.25);
ok("progress never exceeds 1 when a server undercounts", downloadProgress(300, 200) === 1);
ok("progress is null without a content length", downloadProgress(50, 0) === null);
ok("progress is null when the total is not a number", downloadProgress(50, NaN) === null);

/* --------------------------------- frames -------------------------------- */

ok("frame count includes the frame at t=0", frameCountFor(1, 30) === 31);
ok("a 17.1333 s clip at 30 fps exposes 514 frames", frameCountFor(513 / 30, 30) === 514);
ok("a zero-length clip still has one frame", frameCountFor(0, 30) === 1);
ok("an unknown rate cannot fabricate frames", frameCountFor(10, 0) === 1);

const measured = fpsFromFrameTimes([0, 1 / 30, 2 / 30, 3 / 30, 4 / 30, 5 / 30]);
ok("a real 30 fps cadence measures 30", measured.fps === 30 && measured.measured === true, JSON.stringify(measured));
const measured24 = fpsFromFrameTimes([0, 1 / 24, 2 / 24, 3 / 24, 4 / 24]);
ok("a real 24 fps cadence measures 24", measured24.fps === 24 && measured24.measured === true, JSON.stringify(measured24));
const unmeasured = fpsFromFrameTimes([], 30);
ok("no samples means the rate is reported as unmeasured", unmeasured.fps === 30 && unmeasured.measured === false);
const duplicated = fpsFromFrameTimes([0, 0, 0, 0], 25);
ok("stalled identical timestamps do not become an infinite rate", duplicated.fps === 25 && duplicated.measured === false, JSON.stringify(duplicated));

ok(
	"the summary reports what was read, and flags an unmeasured rate",
	footageSummary({ width: 1920, height: 1080, durationS: 17.1333, fps: 30, fpsMeasured: false, frames: 514, bytes: 4968050 })
		=== "1920×1080 · 17.13s · 30 fps? · 514 frames · 4.7 MB",
	footageSummary({ width: 1920, height: 1080, durationS: 17.1333, fps: 30, fpsMeasured: false, frames: 514, bytes: 4968050 }),
);

/* -------------------------------- download ------------------------------- */

const streamResponse = (chunks, { total = null, status = 200, type = "video/mp4" } = {}) => ({
	ok: status >= 200 && status < 300,
	status,
	headers: { get: (name) => (name === "content-length" ? (total === null ? null : String(total)) : type) },
	body: {
		getReader() {
			let index = 0;
			return {
				read: async () => (index < chunks.length ? { done: false, value: chunks[index++] } : { done: true, value: undefined }),
			};
		},
	},
});

const chunks = [new Uint8Array(40), new Uint8Array(40), new Uint8Array(20)];
const seen = [];
const downloaded = await fetchFootageBlob("/media/a.mp4", {
	fetchImpl: async () => streamResponse(chunks, { total: 100 }),
	onProgress: (progress) => seen.push(progress.ratio),
});
ok("the whole body is streamed, not sampled", downloaded.bytes === 100, String(downloaded.bytes));
ok("progress moves monotonically to 1", seen.length >= 3 && seen[0] === 0.4 && seen.at(-1) === 1, JSON.stringify(seen));

const noLength = [];
await fetchFootageBlob("/media/a.mp4", {
	fetchImpl: async () => streamResponse(chunks, { total: null }),
	onProgress: (progress) => noLength.push(progress.ratio),
});
ok("a length-less response reports null progress, never a guess", noLength.slice(0, -1).every((value) => value === null), JSON.stringify(noLength));

const rejected = await fetchFootageBlob("/missing.mp4", { fetchImpl: async () => streamResponse([], { status: 404 }) }).catch((error) => error.message);
ok("a 404 is refused by status, not treated as empty footage", rejected === "http-404", String(rejected));

// A dev server's SPA fallback answers 200 text/html for a missing path; the
// old code handed that HTML to the decoder and blamed the codec.
const spaFallback = await fetchFootageBlob("/media/missing.mp4", {
	fetchImpl: async () => streamResponse([new Uint8Array(120)], { total: 120, type: "text/html; charset=utf-8" }),
}).catch((error) => error.message);
ok("an HTML fallback page is named as a wrong target, not a codec fault", spaFallback === "not-a-video", String(spaFallback));

const jsonBody = await fetchFootageBlob("/api/thing", {
	fetchImpl: async () => streamResponse([new Uint8Array(10)], { total: 10, type: "application/json" }),
}).catch((error) => error.message);
ok("a JSON body is refused before it reaches the decoder", jsonBody === "not-a-video", String(jsonBody));

const octetStream = await fetchFootageBlob("/media/a.mp4", {
	fetchImpl: async () => streamResponse([new Uint8Array(10)], { total: 10, type: "application/octet-stream" }),
});
ok("an octet-stream video is still accepted", octetStream.bytes === 10, String(octetStream.bytes));

const refused = await fetchFootageBlob("https://no-cors.example/a.mp4", {
	fetchImpl: async () => {
		throw new TypeError("Failed to fetch");
	},
}).catch((error) => error.message);
ok("a blocked cross-origin fetch is named, not swallowed", refused === "fetch-failed", String(refused));

const aborted = await fetchFootageBlob("/media/a.mp4", {
	fetchImpl: async () => {
		const error = new Error("aborted");
		error.name = "AbortError";
		throw error;
	},
}).catch((error) => error.name);
ok("an abort propagates as an abort, not as a failure", aborted === "AbortError", String(aborted));

/* --------------------------------- probe --------------------------------- */

function fakeVideo({ duration = 17.1333, width = 1920, height = 1080, fail = false, frameTimes = null } = {}) {
	const listeners = {};
	const video = {
		duration,
		videoWidth: width,
		videoHeight: height,
		currentTime: 0,
		addEventListener(type, fn) {
			(listeners[type] ??= []).push(fn);
		},
		load() {
			queueMicrotask(() => {
				for (const fn of listeners[fail ? "error" : "loadedmetadata"] ?? []) fn();
			});
		},
		play: async () => {},
		pause() {},
	};
	if (frameTimes) {
		let index = 0;
		video.requestVideoFrameCallback = (fn) => {
			queueMicrotask(() => fn(0, { mediaTime: frameTimes[Math.min(index++, frameTimes.length - 1)] }));
		};
	}
	return video;
}

const probed = await probeFootage("blob:x", {
	createVideo: () => fakeVideo({ frameTimes: Array.from({ length: 12 }, (_, i) => i / 30) }),
});
ok("a probe reports the decoded duration and size", probed.durationS === 17.1333 && probed.width === 1920 && probed.height === 1080);
ok("a probe measures the real rate and derives the frame count", probed.fps === 30 && probed.fpsMeasured === true && probed.frames === 514, JSON.stringify(probed));

const undecodable = await probeFootage("blob:x", { createVideo: () => fakeVideo({ fail: true }) }).catch((error) => error.message);
ok("an undecodable container fails closed by name", undecodable === "decode-failed", String(undecodable));

const noDuration = await probeFootage("blob:x", { createVideo: () => fakeVideo({ duration: NaN }) }).catch((error) => error.message);
ok("an unreadable duration never becomes a timeline length", noDuration === "duration-unreadable", String(noDuration));

const noSize = await probeFootage("blob:x", { createVideo: () => fakeVideo({ width: 0 }) }).catch((error) => error.message);
ok("unreadable dimensions are refused by name", noSize === "dimensions-unreadable", String(noSize));

const silent = await probeFootage("blob:x", { createVideo: () => fakeVideo(), timeoutMs: 40, fallbackFps: 30 }).catch((error) => error.message);
ok("a probe with no rVFC still reports an unmeasured rate", silent.fps === 30 && silent.fpsMeasured === false, JSON.stringify(silent));

const declared = await probeFootage("blob:x", { createVideo: () => fakeVideo(), knownFps: 24 });
ok("an encoder-declared rate outranks measurement and is never a guess",
	declared.fps === 24 && declared.fpsMeasured === true && declared.frames === 412, JSON.stringify(declared));

const stalled = await probeFootage("blob:x", {
	createVideo: () => {
		const video = fakeVideo();
		video.load = () => {}; // metadata never arrives
		return video;
	},
	timeoutMs: 30,
}).catch((error) => error.message);
ok("a source that never yields metadata times out by name", stalled === "probe-timeout", String(stalled));

assert.equal(typeof footageSummary(null), "string");

/* --- requestBridgeFootage --------------------------------------------------- */

function ndjsonResponse(lines, { status = 200 } = {}) {
	const encoder = new TextEncoder();
	const chunks = lines.map((line) => encoder.encode(`${JSON.stringify(line)}\n`));
	let index = 0;
	return {
		ok: status >= 200 && status < 300,
		status,
		json: async () => lines[0],
		body: {
			getReader: () => ({
				read: async () =>
					index < chunks.length ? { done: false, value: chunks[index++] } : { done: true },
			}),
		},
	};
}

{
	const progress = [];
	const done = await requestBridgeFootage("https://www.youtube.com/watch?v=x", {
		fetchImpl: async (target, init) => {
			assert.equal(target, "/ardy/footage");
			assert.equal(JSON.parse(init.body).url, "https://www.youtube.com/watch?v=x");
			return ndjsonResponse([
				{ event: "status", message: "downloading" },
				{ event: "progress", stage: "download", ratio: 0.4 },
				{ event: "progress", stage: "normalize", ratio: 0.9 },
				{ event: "done", url: "/ardy/footage/1-abc123.mp4", title: "Clip", durationS: 12, fps: 24 },
			]);
		},
		onProgress: (entry) => progress.push(entry),
	});
	ok("a bridge download surfaces staged progress and the local address",
		done.url === "/ardy/footage/1-abc123.mp4" && progress.length === 2 && progress[1].stage === "normalize");
}

const bridgeNamedError = await requestBridgeFootage("https://youtu.be/x", {
	fetchImpl: async () => ndjsonResponse([{ event: "error", message: "footage-too-long" }]),
}).catch((error) => error.message);
ok("a bridge error event fails closed by its own name", bridgeNamedError === "footage-too-long");

const bridgeIncomplete = await requestBridgeFootage("https://youtu.be/x", {
	fetchImpl: async () => ndjsonResponse([{ event: "status", message: "downloading" }]),
}).catch((error) => error.message);
ok("a stream that ends without footage never reads as success", bridgeIncomplete === "bridge-footage-incomplete");

const bridgeHttp = await requestBridgeFootage("https://youtu.be/x", {
	fetchImpl: async () => ({ ok: false, status: 400, json: async () => ({ ok: false, reason: "footage-url-invalid" }) }),
}).catch((error) => error.message);
ok("an HTTP refusal carries the bridge's named reason", bridgeHttp === "footage-url-invalid");

const bridgeDown = await requestBridgeFootage("https://youtu.be/x", {
	fetchImpl: async () => { throw new TypeError("fetch failed"); },
}).catch((error) => error.message);
ok("an unreachable bridge is named, not a network stack trace", bridgeDown === "bridge-unreachable");

// The bridge caps footage at 30 fps before extraction ever sees it (SAM's
// per-frame error at 60 fps measured five times the foot wobble of the same
// session at 30, and a 24 fps timeline cannot show the extra frames anyway).
// The rate it then reports is the rate of the file it actually wrote, so the
// app has to take that word over what playback suggests — otherwise the
// timeline counts 1804 frames in a clip that holds 902.
{
	const done = await requestBridgeFootage("https://www.youtube.com/watch?v=x", {
		fetchImpl: async () =>
			ndjsonResponse([
				{ event: "done", url: "/ardy/footage/1-abc123.mp4", title: "60 fps take", durationS: 30.05, fps: 30 },
			]),
	});
	ok("a 60 fps download comes back declared at the capped rate", done.fps === 30, JSON.stringify(done));
	const onCapped = await probeFootage("blob:x", {
		createVideo: () => fakeVideo({ duration: 30.05, frameTimes: Array.from({ length: 12 }, (_, i) => i / 60) }),
		knownFps: done.fps,
	});
	ok(
		"the timeline counts frames at the bridge's capped rate, not the source's",
		onCapped.fps === 30 && onCapped.frames === 902 && onCapped.frames === frameCountFor(30.05, 30),
		JSON.stringify(onCapped),
	);
}

console.log(`\nfailures: ${failures}`);
process.exit(failures === 0 ? 0 : 1);

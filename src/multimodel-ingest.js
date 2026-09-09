// multimodel-ingest.js — the footage side of Multi-Model source, with no React
// and no DOM of its own, so the node suite drives exactly the code the app runs.
//
// The stages are the real ones a footage ingest has: normalise the address,
// download the bytes (with progress, because a 5 MB take on a slow link is a
// visible wait), then probe the decoded media for the numbers the timeline
// needs. Every failure is a NAMED reason: "it didn't work" is not a diagnosis,
// and a silent fallback to a plausible-looking default is how footage that was
// never read ends up looking ingested.

export const INGEST_STAGES = Object.freeze(["idle", "fetching", "probing", "ready", "error"]);

/** A successful extraction is not proof that vertical recovery was applied. */
export function trajectoryReceipt(report, korean = false) {
	if (!report) return "";
	if (report.status === "disabled") return korean ? "낙하 보정 꺼짐" : "Descent recovery off";
	if (report.status === "corrected") {
		const rejected = report.rejected?.length ?? 0;
		return korean
			? `낙하 보정 ${report.changedFrames}프레임 적용${rejected ? ` · ${rejected}구간 미해결` : ""}`
			: `Descent recovery: ${report.changedFrames} frames corrected${rejected ? ` · ${rejected} unresolved spans` : ""}`;
	}
	const reason = report.rejected?.[0]?.reason ?? report.reason ?? "unknown";
	const labels = {
		"world-endpoint-unsettled": ["3D endpoint never settles", "3D 끝점이 안정되지 않음"],
		"no-confident-delayed-descent": ["no confident delayed descent detected", "확실한 낙하 지연이 검출되지 않음"],
		"moving-camera-not-supported": ["moving-camera recovery unsupported", "이동 카메라 보정 미지원"],
		"uncertain-keypoints": ["body tracking uncertain", "관절 추적 불확실"],
		"uncertain-depth": ["depth change too large", "깊이 변화가 큼"],
		"moving-landing": ["landing does not stay still", "착지 후 이동이 계속됨"],
		"no-observed-landing": ["landing not observed", "착지를 확인할 수 없음"],
		"landing-observation-too-short": ["not enough footage after landing", "착지 이후 영상이 너무 짧음"],
		"excessive-correction": ["recovery exceeds its safety bound", "보정량이 안전 범위를 초과함"],
	};
	return `${korean ? "낙하 보정 미적용" : "Descent recovery not applied"}: ${labels[reason]?.[korean ? 1 : 0] ?? reason}`;
}

/** Human-readable evidence from the palette detector, when the GVHMR worker
 * exposes it. Older bridges may omit the report. */
export function segmentationReceipt(report, korean = false) {
	if (!report) return "";
	if (report.available === false) return korean ? "색 세그멘테이션 측정 불가" : "Palette segmentation metrics unavailable";
	if (report.detector !== "palette" || !Number.isFinite(report.detectionRate)) return "";
	const rate = Math.round(report.detectionRate * 100);
	const coverage = Number.isFinite(report.coverage?.mean) ? Math.round(report.coverage.mean * 100) : null;
	const range = Number.isFinite(report.coverage?.p10) && Number.isFinite(report.coverage?.p90)
		? `${Math.round(report.coverage.p10 * 100)}–${Math.round(report.coverage.p90 * 100)}%`
		: null;
	const parts = Number.isFinite(report.parts?.mean) ? Math.round(report.parts.mean) : null;
	const gap = Number.isFinite(report.longestGapFrames) ? report.longestGapFrames : 0;
	const hue = Number.isFinite(report.hueErrorDeg?.p95) ? Math.round(report.hueErrorDeg.p95) : null;
	if (korean) return `색 세그멘테이션: ${rate}% 검출${coverage === null ? "" : ` · 마스크 ${coverage}%${range ? ` (${range})` : ""}`}${parts === null ? "" : ` · 색 파트 ${parts}개`}${gap ? ` · 최대 끊김 ${gap}프레임` : ""}${hue === null ? "" : ` · 색 오차 P95 ${hue}°`}`;
	return `Palette segmentation: ${rate}% detected${coverage === null ? "" : ` · ${coverage}% mask${range ? ` (${range})` : ""}`}${parts === null ? "" : ` · ${parts} colour parts`}${gap ? ` · longest gap ${gap} frames` : ""}${hue === null ? "" : ` · hue error P95 ${hue}°`}`;
}

// Addresses we accept: absolute http(s), or a root-relative path served by this
// origin. Protocol-relative "//host" is refused because it silently inherits
// the page scheme, and blob:/data:/javascript: are refused from the text field
// because the only legitimate blob here is one this module minted itself.
export function normalizeSourceUrl(raw) {
	if (typeof raw !== "string") return { ok: false, reason: "url-not-string" };
	const value = raw.trim();
	if (value.length === 0) return { ok: false, reason: "url-empty" };
	if (value.startsWith("//")) return { ok: false, reason: "url-protocol-relative" };
	if (value.startsWith("/")) return { ok: true, url: value };
	if (/^https?:\/\//i.test(value)) {
		let parsed;
		try {
			parsed = new URL(value);
		} catch {
			return { ok: false, reason: "url-malformed" };
		}
		if (isPlatformPageUrl(parsed.toString())) return { ok: false, reason: "url-platform-page" };
		return { ok: true, url: parsed.toString() };
	}
	return { ok: false, reason: "url-scheme-unsupported" };
}

// Video platforms serve a player PAGE, never a fetchable file, and block
// cross-origin reads outright. Saying "CORS or offline" for these sends the
// user hunting a network fault that does not exist, so they are named on sight
// and never dialled at all.
const PLATFORM_PAGE_HOSTS = /(?:^|\.)(?:youtube\.com|youtu\.be|vimeo\.com|tiktok\.com|instagram\.com|facebook\.com|twitter\.com|x\.com|bilibili\.com|naver\.com|kakao\.com)$/i;

export function isPlatformPageUrl(url) {
	if (typeof url !== "string") return false;
	try {
		return PLATFORM_PAGE_HOSTS.test(new URL(url).hostname);
	} catch {
		return false;
	}
}

/**
 * POST to a bridge ndjson route and stream the answer. Progress events
 * surface through `onProgress({ stage, ratio })`, an error event throws its
 * NAMED message, and the resolved value is the `done` event — the caller
 * checks the field it needs so a truncated stream never reads as success.
 */
async function streamBridgeNdjson(path, init, { fetchImpl, onProgress, defaultError } = {}) {
	const doFetch = fetchImpl ?? globalThis.fetch;
	if (typeof doFetch !== "function") throw new Error("fetch-unavailable");
	let response;
	try {
		response = await doFetch(path, init);
	} catch {
		throw new Error("bridge-unreachable");
	}
	if (!response.ok) {
		let reason = `http-${response.status}`;
		try {
			reason = (await response.json())?.reason ?? reason;
		} catch {
			/* body was not json; the status is the reason */
		}
		throw new Error(reason);
	}
	const text = response.body?.getReader ? null : await response.text();
	let buffered = "";
	let done = null;
	const handleLine = (line) => {
		if (!line.trim()) return;
		let event;
		try {
			event = JSON.parse(line);
		} catch {
			return; // a torn line mid-stream; the buffer keeps the remainder
		}
		if (event.event === "progress") onProgress?.({ stage: event.stage, ratio: event.ratio });
		else if (event.event === "error") throw new Error(event.message || defaultError);
		else if (event.event === "done") done = event;
	};
	if (text !== null) {
		for (const line of text.split("\n")) handleLine(line);
	} else {
		const reader = response.body.getReader();
		const decoder = new TextDecoder();
		for (;;) {
			const { done: finished, value } = await reader.read();
			if (finished) break;
			buffered += decoder.decode(value, { stream: true });
			const lines = buffered.split("\n");
			buffered = lines.pop() ?? "";
			for (const line of lines) handleLine(line);
		}
		if (buffered) handleLine(buffered);
	}
	return done;
}

/**
 * Ask the dev bridge to fetch a platform page's video server-side (yt-dlp +
 * ffmpeg constant-rate normalize at the source's own fps) and hand back a
 * local /ardy/footage/… address the ordinary ingest can download.
 */
export async function requestBridgeFootage(url, options = {}) {
	const done = await streamBridgeNdjson(
		"/ardy/footage",
		{
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ url }),
		},
		{ ...options, defaultError: "footage-download-failed" }
	);
	if (!done || typeof done.url !== "string") throw new Error("bridge-footage-incomplete");
	return done;
}

/**
 * Ask the dev bridge to run GPU motion extraction (GVHMR on the ARDY
 * box) over footage it already holds ({ footage: id }) or over uploaded
 * bytes (a Blob). Resolves to `{ motionUrl, frames, fps, quality, segmentation }` — an ordinary
 * /ardy/motions address the app loads exactly like a generated take.
 */
export async function requestBridgeExtract(source, options = {}) {
	const init = typeof source?.footage === "string"
		? {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ footage: source.footage }),
		}
		: {
			method: "POST",
			headers: { "Content-Type": "application/octet-stream" },
			body: source,
		};
	const done = await streamBridgeNdjson("/ardy/extract", init, {
		...options,
		defaultError: "extract-run-failed",
	});
	if (!done || typeof done.motionUrl !== "string") throw new Error("bridge-extract-incomplete");
	return done;
}

/** The name shown for a source: the last path segment, never the query soup. */
export function sourceLabel(url) {
	if (typeof url !== "string" || url.length === 0) return "";
	const withoutQuery = url.split(/[?#]/)[0];
	const segment = withoutQuery.split("/").filter(Boolean).pop();
	return segment ?? withoutQuery;
}

/** 0..1 while the total is known; null when the server sent no length — a
 *  progress bar that invents a denominator lies about how far along it is. */
export function downloadProgress(received, total) {
	if (!Number.isFinite(total) || total <= 0) return null;
	if (!Number.isFinite(received) || received < 0) return null;
	return Math.min(1, received / total);
}

/** Frames the timeline exposes for a clip: the frame at t=0 plus every whole
 *  frame inside the duration. Same rule the baked-take timing uses. */
export function frameCountFor(durationS, fps) {
	if (!(durationS > 0) || !(fps > 0)) return 1;
	return Math.max(1, Math.floor(durationS * fps + 1e-6) + 1);
}

/** Measured inter-frame periods → the clip's real rate. Falls back only when
 *  there is nothing to measure; a guessed rate is reported as such by the
 *  caller, never laundered into a measurement. */
export function fpsFromFrameTimes(times, fallback = 30) {
	if (!Array.isArray(times) || times.length < 3) return { fps: fallback, measured: false };
	const periods = [];
	for (let i = 1; i < times.length; i += 1) {
		const period = times[i] - times[i - 1];
		if (period > 1e-4) periods.push(period);
	}
	if (periods.length === 0) return { fps: fallback, measured: false };
	periods.sort((a, b) => a - b);
	const median = periods[Math.floor(periods.length / 2)];
	if (!(median > 0)) return { fps: fallback, measured: false };
	return { fps: Math.round(1 / median), measured: true };
}

export function formatBytes(bytes) {
	if (!Number.isFinite(bytes) || bytes < 0) return "";
	if (bytes < 1024) return `${bytes} B`;
	if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)} KB`;
	return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

/** The one-line receipt under the panel: what was actually read, not what was
 *  requested. Every field here comes from the decoded media. */
export function footageSummary(footage) {
	if (!footage) return "";
	const parts = [
		`${footage.width}×${footage.height}`,
		`${footage.durationS.toFixed(2)}s`,
		`${footage.fps} fps${footage.fpsMeasured ? "" : "?"}`,
		`${footage.frames} frames`,
	];
	if (Number.isFinite(footage.bytes) && footage.bytes > 0) parts.push(formatBytes(footage.bytes));
	return parts.join(" · ");
}

/**
 * Download with progress. Streaming is the point: a response read in one gulp
 * cannot report progress, and the caller needs to show movement on a long
 * fetch. A server that sends no content-length yields null progress rather
 * than a fabricated percentage.
 */
export async function fetchFootageBlob(url, { fetchImpl, onProgress, signal } = {}) {
	const doFetch = fetchImpl ?? globalThis.fetch;
	if (typeof doFetch !== "function") throw new Error("fetch-unavailable");
	let response;
	try {
		response = await doFetch(url, { signal });
	} catch (error) {
		if (error?.name === "AbortError") throw error;
		// A cross-origin host without CORS fails here with an opaque
		// TypeError; naming it is the difference between "broken" and
		// "that host does not allow browser downloads".
		throw new Error("fetch-failed");
	}
	if (!response.ok) throw new Error(`http-${response.status}`);
	const totalHeader = Number(response.headers?.get?.("content-length"));
	const total = Number.isFinite(totalHeader) && totalHeader > 0 ? totalHeader : null;
	const type = response.headers?.get?.("content-type") ?? "";
	// A dev server's SPA fallback answers 200 text/html for a missing file, and
	// a 404 page decodes as "unsupported video" — which blames the codec for a
	// wrong address. Anything announced as html/json is a wrong target, said so.
	if (/^(?:text\/html|application\/json|text\/plain)\b/i.test(type)) throw new Error("not-a-video");
	if (!response.body?.getReader) {
		const blob = await response.blob();
		onProgress?.({ received: blob.size, total: blob.size, ratio: 1 });
		return { blob, bytes: blob.size, type };
	}
	const reader = response.body.getReader();
	const chunks = [];
	let received = 0;
	for (;;) {
		const { done, value } = await reader.read();
		if (done) break;
		chunks.push(value);
		received += value.byteLength ?? value.length ?? 0;
		onProgress?.({ received, total, ratio: downloadProgress(received, total) });
	}
	const blob = new Blob(chunks, { type: type || "video/mp4" });
	onProgress?.({ received, total: total ?? received, ratio: 1 });
	return { blob, bytes: received, type };
}

/**
 * Probe the decoded video for the numbers the timeline consumes. The element
 * is injected so this is drivable without a browser; in the app it is a real
 * <video>. Frame times come from requestVideoFrameCallback when the browser
 * has it — that is a measurement of the actual presented frames, not a guess
 * from the container.
 */
export async function probeFootage(objectUrl, { createVideo, timeoutMs = 15000, fallbackFps = 30, knownFps = null } = {}) {
	const video = createVideo();
	video.src = objectUrl;
	video.muted = true;
	video.playsInline = true;
	video.preload = "auto";

	await new Promise((resolve, reject) => {
		let settled = false;
		const timer = setTimeout(() => {
			if (settled) return;
			settled = true;
			reject(new Error("probe-timeout"));
		}, timeoutMs);
		const finish = (error) => {
			if (settled) return;
			settled = true;
			clearTimeout(timer);
			if (error) reject(error);
			else resolve();
		};
		video.addEventListener("loadedmetadata", () => finish(null), { once: true });
		// A container the browser cannot decode fires error, not metadata.
		video.addEventListener("error", () => finish(new Error("decode-failed")), { once: true });
		video.load?.();
	});

	const durationS = Number(video.duration);
	const width = Number(video.videoWidth);
	const height = Number(video.videoHeight);
	if (!(durationS > 0)) throw new Error("duration-unreadable");
	if (!(width > 0) || !(height > 0)) throw new Error("dimensions-unreadable");

	// A rate the encoder itself declared (the bridge normalizes footage to a
	// constant fps) outranks a playback measurement — and is never a guess.
	const declared = Number.isFinite(knownFps) && knownFps > 0;
	const times = declared ? [] : await collectFrameTimes(video);
	const { fps, measured } = declared
		? { fps: knownFps, measured: true }
		: fpsFromFrameTimes(times, fallbackFps);
	return {
		durationS,
		width,
		height,
		fps,
		fpsMeasured: measured,
		frames: frameCountFor(durationS, fps),
	};
}

// Play a fraction of a second muted and record when frames are actually
// presented. Without requestVideoFrameCallback there is nothing honest to
// measure, so the caller is told the rate was not measured.
async function collectFrameTimes(video, sampleCount = 12) {
	if (typeof video.requestVideoFrameCallback !== "function") return [];
	const times = [];
	try {
		await video.play?.();
	} catch {
		return []; // autoplay refused: no measurement, and we say so
	}
	await new Promise((resolve) => {
		const stopAt = Date.now() + 2000;
		const step = (_now, meta) => {
			times.push(meta?.mediaTime ?? 0);
			if (times.length >= sampleCount || Date.now() > stopAt) {
				resolve();
				return;
			}
			video.requestVideoFrameCallback(step);
		};
		video.requestVideoFrameCallback(step);
	});
	video.pause?.();
	video.currentTime = 0;
	return times;
}

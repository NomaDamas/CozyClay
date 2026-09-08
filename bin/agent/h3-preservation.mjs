import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawn } from "node:child_process";

/**
 * H3 is an image-to-video model: a prompt can request a locked camera, but it
 * cannot prove that the returned pixels stayed on that camera.  This module
 * is the output-side guard.  It compares several decoded frames with the
 * uploaded plate in a border band where the animated performer normally is
 * absent. A request is accepted only when the output dimensions/aspect and
 * the measured plate drift are inside the contract.
 */

export const H3_OUTPUT_LIMITS = Object.freeze({
	// JPEG/AVC quantisation and the model's first-frame reconstruction create a
	// small amount of noise. A real camera move changes many edge pixels by much
	// more than this value.
	edgeP95Rgb: 14,
	edgeMeanRgb: 6,
	// The full-frame 80th percentile catches a camera translation in the
	// middle of the set even when the border happens to be covered by a subject.
	globalP80Rgb: 16,
	cameraDriftPx: 2,
	aspectError: 0.01,
	borderFraction: 0.12,
});

/** Estimate a rigid camera translation against the plate in the static band. */
export function estimateH3CameraShift(reference, frame, width, height, { borderFraction = H3_OUTPUT_LIMITS.borderFraction, maxShift = 4 } = {}) {
	const borderX = Math.max(1, Math.floor(width * borderFraction));
	const borderY = Math.max(1, Math.floor(height * borderFraction));
	if (width <= borderX * 2 + 2 || height <= borderY * 2 + 2) return { x: 0, y: 0, errorRgb: 0, distancePx: 0 };
	let best = { x: 0, y: 0, error: Infinity }; let baseline = Infinity;
	for (let dy = -maxShift; dy <= maxShift; dy += 1) for (let dx = -maxShift; dx <= maxShift; dx += 1) {
		let sum = 0; let count = 0;
		for (let y = borderY; y < height - borderY; y += 6) for (let x = borderX; x < width - borderX; x += 6) {
			if (x + dx < 0 || x + dx >= width || y + dy < 0 || y + dy >= height) continue;
			const a = (y * width + x) * 3; const b = ((y + dy) * width + x + dx) * 3;
			sum += (Math.abs(reference[a] - frame[b]) + Math.abs(reference[a + 1] - frame[b + 1]) + Math.abs(reference[a + 2] - frame[b + 2])) / 3;
			count += 1;
		}
		const error = sum / Math.max(1, count);
		if (dx === 0 && dy === 0) baseline = error;
		if (error < best.error) best = { x: dx, y: dy, error };
	}
	const improvementRgb = Math.max(0, baseline - best.error);
	// A flat/softly lit border has many equally good translations. Only treat a
	// shift as camera evidence when the alignment materially improves error.
	const distancePx = improvementRgb >= 8 ? Math.hypot(best.x, best.y) : 0;
	return { x: best.x, y: best.y, errorRgb: best.error, baselineErrorRgb: baseline, improvementRgb, distancePx };
}

function run(command, args, input = null) {
	return new Promise((resolve, reject) => {
		const child = spawn(command, args, { stdio: ["pipe", "pipe", "pipe"] });
		const out = []; const err = [];
		child.stdout.on("data", (chunk) => out.push(chunk));
		child.stderr.on("data", (chunk) => err.push(chunk));
		child.once("error", reject);
		child.once("close", (code) => {
			if (code === 0) resolve({ stdout: Buffer.concat(out), stderr: Buffer.concat(err).toString("utf8") });
			else reject(new Error(`${command} exited ${code}: ${Buffer.concat(err).toString("utf8").trim()}`));
		});
		if (input) child.stdin.end(input); else child.stdin.end();
	});
}

async function decode(path, width, height, seek = null, inputFormat = null) {
	const args = ["-hide_banner", "-loglevel", "error"];
	if (seek !== null) args.push("-ss", String(Math.max(0, seek)));
	if (inputFormat) args.push("-f", inputFormat);
	args.push("-i", path, "-vf", `scale=${width}:${height}:flags=bicubic`, "-frames:v", "1", "-f", "rawvideo", "-pix_fmt", "rgb24", "pipe:1");
	const { stdout } = await run("ffmpeg", args);
	const expected = width * height * 3;
	if (stdout.length < expected) throw new Error(`decoded frame is ${stdout.length} bytes; expected ${expected}`);
	return stdout.subarray(0, expected);
}

async function decodeNearest(path, width, height, seek, duration) {
	// Short test clips and variable frame rate outputs may have no frame at an
	// arbitrary timestamp near the end. Walk backwards to the nearest decoded
	// frame instead of treating a valid clip as an inspection failure.
	for (let offset = 0; offset <= Math.max(1, duration); offset += 1 / 12) {
		try { return await decode(path, width, height, Math.max(0, seek - offset)); } catch { /* try the preceding frame */ }
	}
	throw new Error("H3 output has no decodable video frame.");
}

async function probe(path) {
	const { stdout } = await run("ffprobe", ["-v", "error", "-select_streams", "v:0", "-show_entries", "stream=width,height,duration,nb_frames,r_frame_rate", "-of", "json", path]);
	const stream = JSON.parse(stdout.toString("utf8"))?.streams?.[0];
	if (!stream || !Number.isFinite(Number(stream.width)) || !Number.isFinite(Number(stream.height))) throw new Error("H3 output has no video stream metadata.");
	const [rateNumerator, rateDenominator] = String(stream.r_frame_rate || "").split("/").map(Number);
	const fps = rateNumerator > 0 && rateDenominator > 0 ? rateNumerator / rateDenominator : null;
	return { width: Number(stream.width), height: Number(stream.height), seconds: Number.isFinite(Number(stream.duration)) ? Number(stream.duration) : null, frames: Number.isFinite(Number(stream.nb_frames)) ? Number(stream.nb_frames) : null, fps };
}

/** Compare a decoded RGB frame to the plate. Returns mean and p95 RGB error. */
export function compareH3Plate(reference, frame, width, height, { borderFraction = H3_OUTPUT_LIMITS.borderFraction } = {}) {
	if (!(reference instanceof Uint8Array) || !(frame instanceof Uint8Array) || reference.length < width * height * 3 || frame.length < width * height * 3) throw new TypeError("compareH3Plate needs two decoded RGB frames");
	const borderX = Math.max(1, Math.floor(width * borderFraction));
	const borderY = Math.max(1, Math.floor(height * borderFraction));
	const errors = []; const globalErrors = [];
	for (let y = 0; y < height; y += 2) for (let x = 0; x < width; x += 2) {
		const i = (y * width + x) * 3;
		const d = (Math.abs(reference[i] - frame[i]) + Math.abs(reference[i + 1] - frame[i + 1]) + Math.abs(reference[i + 2] - frame[i + 2])) / 3;
		globalErrors.push(d);
		if (x < borderX || x >= width - borderX || y < borderY || y >= height - borderY) errors.push(d);
	}
	errors.sort((a, b) => a - b);
	globalErrors.sort((a, b) => a - b);
	const mean = errors.reduce((sum, value) => sum + value, 0) / Math.max(1, errors.length);
	const p95 = errors[Math.min(errors.length - 1, Math.floor(errors.length * 0.95))] ?? 255;
	const globalP80 = globalErrors[Math.min(globalErrors.length - 1, Math.floor(globalErrors.length * 0.8))] ?? 255;
	const camera = estimateH3CameraShift(reference, frame, width, height, { borderFraction });
	return { meanRgb: mean, p95Rgb: p95, globalP80Rgb: globalP80, cameraDriftPx: camera.distancePx, cameraShift: { x: camera.x, y: camera.y }, cameraErrorRgb: camera.errorRgb, cameraImprovementRgb: camera.improvementRgb, samples: errors.length, globalSamples: globalErrors.length };
}

/**
 * Decode and validate an H3 output against the uploaded first frame. This is
 * deliberately fail-closed: if ffmpeg/ffprobe cannot inspect the result, the
 * caller must not present it as a scene-locked take.
 */
export async function inspectH3Output({ imageDataUrl, videoBytes, expectedWidth, expectedHeight, limits = H3_OUTPUT_LIMITS }) {
	if (!imageDataUrl?.startsWith("data:image/")) throw new Error("H3 preservation requires the uploaded first image.");
	if (!Buffer.isBuffer(videoBytes) || videoBytes.length === 0) throw new Error("H3 preservation requires non-empty video bytes.");
	const dir = await mkdtemp(join(tmpdir(), "cozyclay-h3-"));
	const mime = /^data:([^;,]+)/.exec(imageDataUrl)?.[1] || "image/png";
	const extension = mime.includes("jpeg") || mime.includes("jpg") ? "jpg" : mime.includes("webp") ? "webp" : "png";
	const imagePath = join(dir, `plate.${extension}`); const videoPath = join(dir, "output.mp4");
	try {
		const match = /^data:[^;,]+;base64,(.+)$/.exec(imageDataUrl);
		if (!match) throw new Error("H3 preservation received an invalid image data URL.");
		await writeFile(imagePath, Buffer.from(match[1], "base64"));
		await writeFile(videoPath, videoBytes);
		const meta = await probe(videoPath);
		const plateMeta = await probe(imagePath);
		const width = meta.width; const height = meta.height;
		// H3 may quantise the canvas to its own 32-pixel grid (the current
		// 12:7 workflow returns 1152x672 even when the UI requested 16:9).
		// Compare against the uploaded plate's authored aspect first; otherwise
		// a valid locked shot would be rejected solely for model canvas padding.
		const requestedAspect = Number(plateMeta.width) / Number(plateMeta.height)
			|| (Number(expectedWidth) / Number(expectedHeight));
		const outputAspect = width / height;
		const aspectError = Number.isFinite(requestedAspect) && requestedAspect > 0 ? Math.abs(outputAspect - requestedAspect) / requestedAspect : 0;
		if (aspectError > limits.aspectError) throw new Error(`H3 preservation failed: output aspect drift ${(aspectError * 100).toFixed(2)}%.`);
		const reference = await decode(imagePath, width, height);
		const duration = Number.isFinite(meta.seconds) && meta.seconds > 0 ? meta.seconds : 1;
		// Container duration points just past the final decoded frame. Clamp all
		// seeks to that frame so short clips (and VFR outputs) cannot fail closed
		// merely because a probe sample landed in the tail gap.
		const frameStep = Number.isFinite(meta.fps) && meta.fps > 0 ? 1 / meta.fps : 1 / 24;
		const lastFrameTime = Math.max(0, duration - frameStep);
		const times = [...new Set([0, lastFrameTime * 0.25, lastFrameTime * 0.5, lastFrameTime * 0.75, lastFrameTime])];
		const frames = [];
		for (const time of times) frames.push(compareH3Plate(reference, await decodeNearest(videoPath, width, height, time, duration), width, height, limits));
		const worst = frames.reduce((acc, item) => ({ meanRgb: Math.max(acc.meanRgb, item.meanRgb), p95Rgb: Math.max(acc.p95Rgb, item.p95Rgb), globalP80Rgb: Math.max(acc.globalP80Rgb, item.globalP80Rgb), cameraDriftPx: Math.max(acc.cameraDriftPx, item.cameraDriftPx) }), { meanRgb: 0, p95Rgb: 0, globalP80Rgb: 0, cameraDriftPx: 0 });
		const pass = worst.p95Rgb <= limits.edgeP95Rgb && worst.meanRgb <= limits.edgeMeanRgb && worst.globalP80Rgb <= limits.globalP80Rgb && worst.cameraDriftPx <= limits.cameraDriftPx;
		return { pass, width, height, seconds: meta.seconds, aspectError, frames, worst, limits };
	} finally {
		await rm(dir, { recursive: true, force: true });
	}
}

export async function inspectH3OutputFromData({ imageDataUrl, videoBytes, expectedWidth, expectedHeight, limits }) {
	return inspectH3Output({ imageDataUrl, videoBytes, expectedWidth, expectedHeight, limits });
}

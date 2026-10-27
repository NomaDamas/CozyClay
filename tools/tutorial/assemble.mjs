// ffmpeg side of the tutorial recorder: find the binary (an external
// requirement, never an npm dependency) and turn timestamped frames into a
// constant-rate mp4.
import { spawn, spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { once } from "node:events";

const CANDIDATES = [process.env.FFMPEG, "ffmpeg", "/opt/homebrew/bin/ffmpeg", "/usr/local/bin/ffmpeg", "/usr/bin/ffmpeg"].filter(Boolean);

/** { path, version } of the first ffmpeg that runs; throws one actionable line when none does. */
export function findFfmpeg() {
	for (const path of CANDIDATES) {
		const probe = spawnSync(path, ["-version"], { encoding: "utf8" });
		if (probe.status === 0) return { path, version: probe.stdout.split("\n")[0] };
	}
	throw new Error("ffmpeg not found: install it (brew install ffmpeg, apt install ffmpeg) or set FFMPEG=/path/to/ffmpeg");
}

/**
 * Encode `frames` ([{ file, ms }] in `dir`, ms from the start of the recording,
 * sorted) into `output` at a constant `fps`. The screencast only sends a frame
 * when the page changes, so output frame k repeats the newest capture at
 * k / fps, and the video lasts exactly `endMs` — the clock the srt cues use.
 */
export async function encode({ ffmpeg, dir, frames, endMs, fps, output }) {
	const args = ["-hide_banner", "-loglevel", "error", "-y", "-f", "image2pipe", "-c:v", "mjpeg", "-framerate", String(fps), "-i", "-", "-vf", "scale=trunc(iw/2)*2:trunc(ih/2)*2,format=yuv420p", "-c:v", "libx264", "-preset", "medium", "-crf", "20", "-movflags", "+faststart", output];
	const child = spawn(ffmpeg, args, { stdio: ["pipe", "ignore", "pipe"] });
	let stderr = "";
	child.stderr.on("data", (chunk) => { stderr += chunk; });
	const exited = once(child, "close");
	let source = 0;
	let cached = { index: -1, data: null };
	for (let index = 0; index < Math.round((endMs / 1000) * fps); index += 1) {
		while (source + 1 < frames.length && frames[source + 1].ms <= (index * 1000) / fps) source += 1;
		if (cached.index !== source) cached = { index: source, data: readFileSync(join(dir, frames[source].file)) };
		if (!child.stdin.write(cached.data)) await once(child.stdin, "drain");
	}
	child.stdin.end();
	const [code] = await exited;
	if (code !== 0) throw new Error(`ffmpeg failed (exit ${code}): ${stderr.trim()}`);
	return `${ffmpeg} ${args.join(" ")}`;
}

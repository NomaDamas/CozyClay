// Final assembly for the tutorial recorder: the silent capture gets a caption
// band under the frame (so a caption never covers the UI the step points at),
// one caption PNG per cue in that band, and the voice clips laid on the cue
// windows. This ffmpeg has neither libass nor freetype, so captions are images
// and the graph is built here. Pure, so the test checks it without ffmpeg.

const seconds = (ms) => (ms / 1000).toFixed(3);

/**
 * ffmpeg argv for `output`. `cues` are contiguous [{ id, startMs, endMs }];
 * `clips` maps a cue id to { path, audioS } (may be empty: captions only);
 * `captions` holds one PNG per cue, `bandHeight` px tall.
 */
export function muxArgs({ base, output, cues, clips, captions, endMs, bandHeight }) {
	for (const cue of cues) {
		const clip = clips.get(cue.id);
		if (clip && clip.audioS * 1000 > cue.endMs - cue.startMs) {
			throw new Error(`the voice clip for ${cue.id} runs ${clip.audioS.toFixed(2)} s, longer than its ${seconds(cue.endMs - cue.startMs)} s cue; record again so the hold follows the clip`);
		}
	}
	const voiced = clips.size > 0;
	const inputs = ["-i", base];
	// Each audio segment runs from its cue start to the next cue start (the first from 0, the last to the end).
	const segments = cues.map((cue, index) => ({ cue, fromMs: index === 0 ? 0 : cue.startMs, toMs: index + 1 < cues.length ? cues[index + 1].startMs : endMs }));
	const filters = [];
	if (voiced) {
		segments.forEach(({ cue, fromMs, toMs }, index) => {
			const length = seconds(toMs - fromMs);
			const clip = clips.get(cue.id);
			inputs.push(...(clip ? ["-i", clip.path] : ["-f", "lavfi", "-t", length, "-i", "anullsrc=r=48000:cl=mono"]));
			const delay = index === 0 && cue.startMs > 0 ? `,adelay=delays=${Math.round(cue.startMs)}:all=1` : "";
			filters.push(`[${index + 1}:a]aresample=48000,aformat=channel_layouts=mono${delay},apad=whole_dur=${length},atrim=end=${length}[a${index}]`);
		});
		filters.push(`${segments.map((_, index) => `[a${index}]`).join("")}concat=n=${segments.length}:v=0:a=1[aout]`);
	}
	const firstCaption = voiced ? cues.length + 1 : 1;
	for (const caption of captions) inputs.push("-i", caption);
	filters.push(`[0:v]pad=iw:ih+${bandHeight}:0:0:color=0x111111[v]`);
	cues.forEach((cue, index) => {
		filters.push(`[${index ? `v${index - 1}` : "v"}][${firstCaption + index}:v]overlay=0:H-h:enable='between(t,${seconds(cue.startMs)},${seconds(cue.endMs)})'[v${index}]`);
	});
	return [
		"-hide_banner", "-loglevel", "error", "-y", ...inputs,
		"-filter_complex", filters.join(";"),
		"-map", cues.length ? `[v${cues.length - 1}]` : "[v]", ...(voiced ? ["-map", "[aout]", "-c:a", "aac", "-b:a", "128k"] : []),
		"-c:v", "libx264", "-preset", "medium", "-crf", "20", "-pix_fmt", "yuv420p",
		"-t", seconds(endMs), "-movflags", "+faststart", output,
	];
}

/** Caption band height for a frame height: about 13%, even, so two lines fit. */
export const bandHeightFor = (height) => Math.round((height * 0.13) / 2) * 2;

/** ffmpeg argv cutting [startMs, endMs) of the finished episode into one chapter file, re-encoded for exact cuts. */
export function chapterCutArgs({ input, output, startMs, endMs, audio }) {
	return [
		"-hide_banner", "-loglevel", "error", "-y", "-ss", seconds(startMs), "-t", seconds(endMs - startMs), "-i", input,
		"-c:v", "libx264", "-preset", "medium", "-crf", "20", "-pix_fmt", "yuv420p",
		...(audio ? ["-c:a", "aac", "-b:a", "128k"] : ["-an"]), "-movflags", "+faststart", output,
	];
}

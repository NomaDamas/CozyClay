// Optional voice stage for the tutorial recorder. It runs before recording,
// because each cue's hold comes from its clip length. Per narrated step: the
// author's own recording at tools/tutorial/voice/<episode>/<id>.<lang>.<ext>
// wins; otherwise macOS `say` reads the step; with neither, the step is silent
// and the video keeps its burned-in caption.
import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { join } from "node:path";

const SAY_VOICES = { ko: "Yuna", en: "Samantha" };
const EXTENSIONS = ["wav", "m4a", "mp3", "aiff"];

/** The author's clip for one step and language, or null. */
export function userClip(voiceDir, id, language) {
	return EXTENSIONS.map((extension) => join(voiceDir, `${id}.${language}.${extension}`)).find(existsSync) ?? null;
}

/** What the voice reads: `speech` overrides the caption text (pronunciation of English names in Korean, say). */
export const speechText = (step, language) => step.speech?.[language] ?? step.narration[language];

/** True when `say` can speak this language with its voice (macOS only). */
function sayAvailable(language) {
	const list = spawnSync("say", ["-v", "?"], { encoding: "utf8" });
	return list.status === 0 && new RegExp(`^${SAY_VOICES[language]}\\s`, "m").test(list.stdout);
}

/**
 * Clips for every narrated step in `language`: Map id -> { path, audioS, source }.
 * Steps without a user clip and without `say` are left out.
 */
export function prepareVoice({ steps, language, voiceDir, workDir, ffprobe, useSay = true }) {
	const say = useSay && sayAvailable(language);
	const clips = new Map();
	for (const step of steps.filter((item) => item.narration)) {
		let path = userClip(voiceDir, step.id, language);
		const source = path ? "user" : "say";
		if (!path && !say) continue;
		if (!path) {
			path = join(workDir, `${step.id}.${language}.wav`);
			const spoken = spawnSync("say", ["-v", SAY_VOICES[language], "--data-format=LEI16@48000", "-o", path, speechText(step, language)], { encoding: "utf8" });
			if (spoken.status !== 0) throw new Error(`say failed for step ${step.id}: ${spoken.stderr.trim()}`);
		}
		const probe = spawnSync(ffprobe, ["-v", "error", "-show_entries", "format=duration", "-of", "csv=p=0", path], { encoding: "utf8" });
		const audioS = Number(probe.stdout.trim());
		if (probe.status !== 0 || !(audioS > 0)) throw new Error(`ffprobe could not read ${path}`);
		clips.set(step.id, { path, audioS, source });
	}
	return clips;
}

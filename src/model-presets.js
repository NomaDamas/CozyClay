// Pure data + validation helpers for the video models CozyClay can target.
// No DOM, no imports: everything here runs in node tests and in the browser.

export const VIDEO_MODEL_PRESETS = [
	{
		id: "seedance-2.5",
		name: "Seedance 2.5",
		vendor: "ByteDance",
		durationsSeconds: [5, 10],
		fps: 24,
		aspects: ["16:9", "9:16", "21:9", "1:1"],
		maxWidth: 2560,
		maxHeight: 1440,
		notes: "Clips are exactly 5s or 10s; frame count must land on the grid.",
	},
	{
		id: "kling-2",
		name: "Kling 2.0",
		vendor: "Kuaishou",
		durationsSeconds: [5, 10],
		fps: 30,
		aspects: ["16:9", "9:16", "1:1"],
		maxWidth: 1920,
		maxHeight: 1080,
		notes: "Clips are exactly 5s or 10s at 30 fps; no 21:9 delivery.",
	},
	{
		id: "veo-3",
		name: "Veo 3",
		vendor: "Google",
		durationsSeconds: [8],
		fps: 24,
		aspects: ["16:9", "9:16"],
		maxWidth: 1920,
		maxHeight: 1080,
		notes: "Fixed 8s clips with native audio; landscape or portrait only.",
	},
	{
		id: "minimax-h3-selfhosted",
		name: "MiniMax H3 (self-hosted)",
		vendor: "MiniMax",
		durationsSeconds: [],
		maxSeconds: 10,
		fps: 24,
		aspects: ["12:7", "16:9", "9:16"],
		maxWidth: 1540,
		maxHeight: 900,
		notes: "Self-hosted: any clip length up to 10s; durationsSeconds is empty because the grid is continuous.",
	},
];

const ASPECT_TOLERANCE = 1e-6;

export function presetById(id) {
	return VIDEO_MODEL_PRESETS.find((preset) => preset.id === id);
}

function secondsText(seconds) {
	return `${Number(seconds.toFixed(2))}s`;
}

// shot = { frames, fps, aspect }, preset = one of VIDEO_MODEL_PRESETS.
// Returns { ok, warnings } with one warning per violated limit:
// a clip that is too long for the preset, and an unsupported aspect.
export function checkShotAgainstPreset(shot, preset) {
	const warnings = [];
	if (!preset) return { ok: false, warnings: ["unknown preset"] };

	const seconds = (shot.frames || 0) / (shot.fps || preset.fps);
	if (Array.isArray(preset.durationsSeconds) && preset.durationsSeconds.length > 0) {
		const onGrid = preset.durationsSeconds.some((allowed) => Math.abs(seconds - allowed) < ASPECT_TOLERANCE);
		if (!onGrid) {
			const allowed = preset.durationsSeconds.map(secondsText).join(" or ");
			warnings.push(`too long: ${secondsText(seconds)} is not an allowed clip length for ${preset.name} (allowed: ${allowed})`);
		}
	} else if (Number.isFinite(preset.maxSeconds) && seconds > preset.maxSeconds + ASPECT_TOLERANCE) {
		warnings.push(`too long: ${secondsText(seconds)} exceeds the ${preset.maxSeconds}s limit for ${preset.name}`);
	}

	if (!preset.aspects.includes(shot.aspect)) {
		warnings.push(`aspect ${shot.aspect} is not supported by ${preset.name} (allowed: ${preset.aspects.join(", ")})`);
	}

	return { ok: warnings.length === 0, warnings };
}

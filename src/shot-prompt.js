// Builds the labelled text prompt sent alongside a reference clip when a shot
// goes to an image or video model. Pure string building: no DOM, no imports.

const CAMERA_FOLLOWS_REFERENCE = "follow the reference clip's framing and camera motion exactly";
const NEUTRAL_LOOK = "clay previs, neutral look";
const MOTION_LINE = "motion and blocking come from the reference; keep timing";

// FOV degrees -> 35mm-equivalent focal length -> shot-size word.
// A wide field of view reads as a wide shot; a narrow one as a long shot.
export function shotSizeFromFov(fovDeg) {
	if (!Number.isFinite(fovDeg) || fovDeg <= 0) return "normal";
	const equivalentFocalMm = 18 / Math.tan((fovDeg * Math.PI) / 360);
	if (equivalentFocalMm <= 20) return "wide";
	if (equivalentFocalMm <= 40) return "normal";
	return "long";
}

function secondsText(seconds) {
	return `${Number(seconds.toFixed(2))}s`;
}

function cameraWords(cameraMove) {
	const parts = [];
	if (cameraMove?.dolly) parts.push("smooth dolly move");
	if (cameraMove?.crane) parts.push("gentle crane move");
	if (cameraMove?.rail) parts.push("sliding rail move");
	return parts.length > 0 ? parts.join("; ") : "locked-off camera, no move";
}

const AZIMUTH_WORDS = ["front", "front right", "right", "back right", "back", "back left", "left", "front left"];

function azimuthWord(azimuthDeg) {
	if (!Number.isFinite(azimuthDeg)) return "";
	const normalized = ((azimuthDeg % 360) + 360) % 360;
	return AZIMUTH_WORDS[Math.round(normalized / 45) % 8];
}

function elevationWord(elevationDeg) {
	if (!Number.isFinite(elevationDeg)) return "";
	if (elevationDeg >= 50) return "high";
	if (elevationDeg <= 10) return "low";
	return "level";
}

function intensityWord(intensity) {
	if (!Number.isFinite(intensity)) return "moderate";
	if (intensity >= 0.8) return "strong";
	if (intensity >= 0.35) return "moderate";
	return "dim";
}

function lightWords(keyLight) {
	if (!keyLight) return "no key light, ambient fill";
	const direction = [elevationWord(keyLight.elevationDeg), azimuthWord(keyLight.azimuthDeg)].filter(Boolean).join(" ") || "even";
	return `${direction} key light, ${intensityWord(keyLight.intensity)}`;
}

// meta = { focalMm, fovDeg, aspect, size, cameraMove, keyLight, cast,
//          frameRange, fps, shotTitle, intent }
// options = { target: "image" | "video", referenceOwnsCamera: boolean (default true) }
export function buildShotPrompt(meta, options = {}) {
	const target = options.target === "video" ? "video" : "image";
	const referenceOwnsCamera = options.referenceOwnsCamera !== false;

	const frames = Math.max(0, (meta.frameRange?.end ?? 0) - (meta.frameRange?.start ?? 0) + 1);
	const seconds = frames / (meta.fps || 24);
	const intent = typeof meta.intent === "string" ? meta.intent.trim() : "";

	const lines = [
		`SHOT: ${meta.shotTitle || "untitled shot"}, ${secondsText(seconds)}, ${meta.aspect || ""}`.trimEnd(),
		`LENS: ${meta.focalMm}mm, ${shotSizeFromFov(meta.fovDeg)} shot`,
		referenceOwnsCamera ? `CAMERA: ${CAMERA_FOLLOWS_REFERENCE}` : `CAMERA: ${cameraWords(meta.cameraMove)}`,
		`LIGHT: ${lightWords(meta.keyLight)}`,
		`CAST: ${(meta.cast || []).map((member) => member.name).join(", ") || "none"}`,
		`LOOK: ${intent || NEUTRAL_LOOK}`,
	];
	if (target === "video") lines.push(`MOTION: ${MOTION_LINE}`);

	return lines.join("\n");
}

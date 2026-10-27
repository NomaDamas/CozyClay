// Sculpt blueprint (#739): one image-generation request that turns any single
// reference picture into an orthographic model sheet, the drawing a sculpt is
// built from. The template names no subject: everything subject-specific comes
// from the attached reference and the operator's optional notes.
import { referenceMask } from "./sculpt-compare.js";

/** The sheet's fixed layout, as fractions of the image: a 2 x 2 grid. FRONT and
 * SIDE share the top row so their head and foot lines are the same pixels;
 * BACK and TOP fill the bottom row. A later step crops each view by these. */
export const BLUEPRINT_LAYOUT = Object.freeze([
	Object.freeze({ view: "front", label: "Front", x: 0, y: 0, width: 0.5, height: 0.5 }),
	Object.freeze({ view: "side", label: "Left side", x: 0.5, y: 0, width: 0.5, height: 0.5 }),
	Object.freeze({ view: "back", label: "Back", x: 0, y: 0.5, width: 0.5, height: 0.5 }),
	Object.freeze({ view: "top", label: "Top", x: 0.5, y: 0.5, width: 0.5, height: 0.5 }),
]);

/** Landscape, so each quarter is wide enough for a wide subject. */
export const BLUEPRINT_SIZE = "1536x1024";

const BLUEPRINT_POSES = Object.freeze(["keep", "neutral"]);

const POSE_RULES = {
	keep: "Pose: exactly the pose in the reference, the same in all four views.",
	neutral: "Pose: a neutral rest pose, the same in all four views: standing or sitting upright, symmetrical, limbs held slightly away from the body so nothing crosses or hides the torso, mouth closed unless it is always open.",
};

/**
 * The full prompt for one model sheet. `pose` is "keep" (the reference's own
 * pose) or "neutral"; `notes` is free text from the operator (what the subject
 * is, what to fix), passed through as written.
 */
export function buildBlueprintPrompt({ pose = "keep", notes = "" } = {}) {
	if (!BLUEPRINT_POSES.includes(pose)) throw new Error(`pose must be one of ${BLUEPRINT_POSES.join(", ")}`);
	const note = String(notes ?? "").trim().replace(/\s+/g, " ").slice(0, 600);
	return [
		"Make an orthographic model sheet (a turnaround blueprint for building a 3D model) of the main subject in the attached reference image.",
		"Layout: one landscape image split into a 2 x 2 grid of four equal panels. Top-left: FRONT view. Top-right: LEFT SIDE view, seen from the subject's own left, so the subject faces image left. Bottom-left: BACK view. Bottom-right: TOP view, seen from directly above, with the subject's front pointing down the image.",
		"Projection: true orthographic in every panel. No perspective, no foreshortening, no tilt. The camera is level with the subject and looks straight at it.",
		"Scale: one scale for all four panels. In the FRONT and LEFT SIDE panels the subject's highest point sits on the same horizontal line and its lowest point sits on the same horizontal line.",
		"Framing: each panel shows the whole subject, centred, with a clear margin on every side. Nothing is cropped, and no part crosses into another panel.",
		"Subject: the same subject as the reference, with the same identity, proportions, colours and markings. Add nothing and remove nothing. Show what the reference hides in the way most consistent with what it shows.",
		"Leave out everything that is not part of the subject itself: motion lines, sparkles, speech marks, drop shadows, backgrounds, frames, stitching or paper texture, and any surface the subject is printed or sewn on.",
		POSE_RULES[pose],
		"Style: clean flat colours with a thin dark outline, even shadowless lighting, no cast shadows, no ground plane, no texture noise.",
		"Background: plain pure white (#FFFFFF) in every panel, with no grid lines, borders or frames.",
		"Do not write any text, labels, numbers or arrows.",
		...(note ? [`Notes from the operator: ${note}`] : []),
	].join("\n");
}

/** The /agent/image body for a sheet: the reference rides as the edited image,
 * and `composition: "sheet"` tells the sidecar to send the prompt as written. */
export function blueprintRequest({ reference, pose = "keep", notes = "" }) {
	if (!reference?.dataUrl) throw new Error("a blueprint needs a reference image");
	return { prompt: buildBlueprintPrompt({ pose, notes }), imageDataUrl: reference.dataUrl, composition: "sheet", quality: "high", size: BLUEPRINT_SIZE };
}

/** What a failed sheet tells the operator. A safety refusal is the one an
 * operator can act on, so it says what usually causes it and what to try. */
export function blueprintErrorMessage(error, fallback) {
	const text = String(error?.message ?? "");
	if (/safety system|content policy|moderation/i.test(text)) {
		return "The image model refused this reference. Well-known characters and brands are the usual cause. Try an original design, or describe the subject in Notes as your own take on it.";
	}
	return fallback;
}

/** The camera yaw each compared view was drawn from (sculpt-compare.js: 0 in
 * front, positive toward the subject's own left). TOP looks straight down and is
 * cropped but not compared: sculpt.compare's elevation stops at 60 degrees. */
export const BLUEPRINT_VIEW_YAWS = Object.freeze({ front: 0, side: 90, back: 180 });

/** One panel of an RGBA sheet, cut on whole pixels from the layout fractions. */
export function cropBlueprintPanel(image, { x, y, width, height }) {
	const left = Math.round(x * image.width), top = Math.round(y * image.height);
	const w = Math.round((x + width) * image.width) - left, h = Math.round((y + height) * image.height) - top;
	const data = new Uint8Array(w * h * 4);
	for (let row = 0; row < h; row += 1) {
		const start = ((top + row) * image.width + left) * 4;
		data.set(image.data.subarray(start, start + w * 4), row * w * 4);
	}
	return { width: w, height: h, data };
}

/**
 * Cut a generated sheet (RGBA) into its views by BLUEPRINT_LAYOUT and mask each
 * one. A view whose mask fails (no subject, no background, or a subject that
 * touches the panel edge and so was cut or spills into its neighbour) is dropped
 * with a notice. Returns { views: [{ view, label, yaw, image, mask }], notices }.
 */
export function cropBlueprintViews(sheet, layout = BLUEPRINT_LAYOUT) {
	const views = [], notices = [];
	for (const panel of layout) {
		const image = cropBlueprintPanel(sheet, panel);
		try {
			const { width, height, mask, source } = referenceMask(image);
			let minX = width, maxX = -1, minY = height, maxY = -1;
			for (let i = 0; i < mask.length; i += 1) if (mask[i]) {
				const px = i % width, py = (i - px) / width;
				minX = Math.min(minX, px); maxX = Math.max(maxX, px); minY = Math.min(minY, py); maxY = Math.max(maxY, py);
			}
			if (minX === 0 || minY === 0 || maxX === width - 1 || maxY === height - 1) throw new Error("the subject touches the panel edge");
			const box = { x: minX / width, y: minY / height, width: (maxX - minX + 1) / width, height: (maxY - minY + 1) / height };
			views.push({ view: panel.view, label: panel.label, yaw: BLUEPRINT_VIEW_YAWS[panel.view] ?? null, image, mask: { source, box } });
		} catch (error) {
			notices.push(`${panel.label} view dropped: ${String(error?.message || error).replace(/\.$/, "")}.`);
		}
	}
	return { views, notices };
}

/** The cropped views of a generated sheet as PNG data URLs, through an image
 * port ({ decode, encodePng }: commands/sculpt-images.js in the browser). */
export async function blueprintViewImages(sheetDataUrl, images) {
	const { views, notices } = cropBlueprintViews(await images.decode({ dataUrl: sheetDataUrl }));
	return { notices, views: await Promise.all(views.map(async ({ view, label, yaw, image, mask }) => ({ view, label, yaw, mask, width: image.width, height: image.height, dataUrl: await images.encodePng(image) }))) };
}

/** What a sculpt run takes from a sheet: its side and back views (the front is the reference itself). */
export const blueprintRunViews = (sheet) => (sheet?.views ?? []).filter((view) => view.view === "side" || view.view === "back")
	.map(({ view, yaw, dataUrl }) => ({ view, yaw, dataUrl, name: `blueprint-${view}.png` }));

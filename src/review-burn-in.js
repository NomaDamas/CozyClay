import { timecodeAt } from "./shot-review.js";

export function reviewSlate({ shot, frame, fps = 24, focalMm, projectName, focusDistance = null }) {
	return {
		title: [projectName, shot?.name].filter(Boolean).join(" / ") || "CozyClay",
		detail: [
			`F ${String(frame).padStart(4, "0")}`,
			timecodeAt(frame, fps),
			Number.isFinite(focalMm) ? `${Math.round(focalMm)}mm` : null,
			Number.isFinite(focusDistance) ? `FOCUS ${focusDistance.toFixed(2)}m` : null,
		].filter(Boolean).join("  ·  "),
	};
}

let surface = null;
function canvasFor(width, height) {
	if (typeof document === "undefined") return null;
	if (!surface) surface = document.createElement("canvas");
	if (surface.width !== width || surface.height !== height) { surface.width = width; surface.height = height; }
	return surface;
}

/** RGBA is already top-down when this runs in the encoder. The returned array
 * is separately owned, so the render target and hash inputs never alias. */
export function burnInRgba(pixels, width, height, slate) {
	const canvas = canvasFor(width, height);
	if (!canvas) return pixels;
	const context = canvas.getContext("2d", { willReadFrequently: true });
	context.putImageData(new ImageData(new Uint8ClampedArray(pixels), width, height), 0, 0);
	const font = Math.max(12, Math.round(height / 45));
	const pad = Math.round(font * 0.65);
	context.font = `600 ${font}px ui-monospace, SFMono-Regular, Menlo, monospace`;
	context.textBaseline = "middle";
	context.fillStyle = "rgba(5, 7, 9, 0.72)";
	context.fillRect(0, 0, width, font + pad * 2);
	context.fillRect(0, height - font - pad * 2, width, font + pad * 2);
	context.fillStyle = "#ffffff";
	context.fillText(slate.title, pad, pad + font / 2);
	context.textAlign = "right";
	context.fillText(slate.detail, width - pad, height - pad - font / 2);
	context.textAlign = "left";
	return context.getImageData(0, 0, width, height).data;
}

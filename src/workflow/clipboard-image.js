/**
 * Images arriving on the canvas by paste or drop. Kept free of React so the
 * extraction rules can be tested with plain DataTransfer-shaped objects.
 */

/** First image file in a paste or drop DataTransfer, or null. */
export function imageFileFromTransfer(transfer) {
	const files = Array.from(transfer?.files ?? []);
	const direct = files.find((file) => file.type.startsWith("image/"));
	if (direct) return direct;
	// Safari and some apps expose a pasted bitmap only through items.
	for (const item of Array.from(transfer?.items ?? [])) {
		if (item.kind === "file" && item.type.startsWith("image/")) {
			const file = item.getAsFile?.();
			if (file) return file;
		}
	}
	return null;
}

/** Read a File as a data URL. Object URLs die on reload and cannot be sent
 * to the sidecar, so everything that lands on the canvas becomes a data URL. */
export async function fileToDataUrl(file) {
	const bytes = new Uint8Array(await file.arrayBuffer());
	let binary = "";
	for (let i = 0; i < bytes.length; i += 0x8000) binary += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
	return `data:${file.type || "image/png"};base64,${btoa(binary)}`;
}

/** Node data for an image that arrived by paste or drop. */
export function pastedImageNodeData(file, dataUrl) {
	const name = file.name && file.name !== "image.png" ? file.name : `pasted-${new Date().toISOString().slice(0, 19).replace(/[:T]/g, "-")}.png`;
	return { fileName: name, mimeType: file.type || "image/png", fileUrl: dataUrl, image_url: dataUrl, localPreview: true, outputs: [{ value: dataUrl }] };
}

/** Whether a paste aimed at `target` should land on the canvas. The Agent
 * composer autofocuses, so most real pastes target a textarea; a plain text
 * field cannot hold an image, so the canvas takes it. Text stays in the field
 * and a rich editor keeps images it can hold. */
export function canvasTakesPaste(target, transfer) {
	if (!imageFileFromTransfer(transfer)) return false;
	if (!target || typeof target.matches !== "function") return true;
	return !(target.isContentEditable || target.matches("[contenteditable=true]"));
}

// Storyboard composition: lays a shot list out as a grid of thumbnails on a
// 2d canvas. The canvas factory is injected so both the app (real canvas)
// and tests (recording stub) can supply it.

export const STORYBOARD_PROMPT_CHARS = 90;
/** The greybox inset beside a stylized panel: half the drawn picture's width
 * and height (a quarter of its area), in its bottom-right corner. */
export const STORYBOARD_INSET_SCALE = 0.5;

/** The line under a cell: the panel's own caption when it has one, else the
 * prompt line the cell was given. */
export function storyboardCellText(shot) {
	const caption = typeof shot.caption === "string" ? shot.caption.trim() : "";
	return (caption || String(shot.prompt ?? "")).slice(0, STORYBOARD_PROMPT_CHARS);
}

/**
 * Compose a storyboard grid canvas.
 * @param {object} args
 * @param {Array<{ title: string, durationSeconds: number, prompt: string, image: CanvasImageSource | null, stylized?: CanvasImageSource | null, caption?: string }>} args.shots
 *   `image` is the greybox frame; with `stylized` the cell shows the stylized
 *   picture and the greybox as an inset. `caption` wins over `prompt`.
 * @param {number} [args.columns] grid columns, default 3
 * @param {{ width: number, height: number }} [args.cell] per-cell size, default 320x180
 * @param {(width: number, height: number) => { width: number, height: number, getContext: (kind: string) => CanvasRenderingContext2D }} args.createCanvas
 * @returns {unknown} the canvas returned by createCanvas
 */
export function composeStoryboard({ shots, columns = 3, cell = { width: 320, height: 180 }, createCanvas }) {
	const cols = Math.max(1, Math.floor(columns));
	const rows = Math.max(1, Math.ceil(shots.length / cols));
	const width = cols * cell.width;
	const height = rows * cell.height;
	const canvas = createCanvas(width, height);
	const ctx = canvas.getContext("2d");

	const pad = 8;
	const thumbHeight = Math.round(cell.height * 0.6);

	ctx.fillStyle = "#101014";
	ctx.fillRect(0, 0, width, height);

	shots.forEach((shot, i) => {
		const x = (i % cols) * cell.width;
		const y = Math.floor(i / cols) * cell.height;
		const image = shot.stylized || shot.image;
		if (image) {
			const iw = image.width || image.videoWidth || 1;
			const ih = image.height || image.videoHeight || 1;
			const availW = cell.width - pad * 2;
			const availH = thumbHeight - pad;
			const scale = Math.min(availW / iw, availH / ih);
			const dw = iw * scale;
			const dh = ih * scale;
			const dx = x + pad + (availW - dw) / 2;
			const dy = y + pad + (availH - dh) / 2;
			ctx.drawImage(image, dx, dy, dw, dh);
			if (shot.stylized && shot.image) {
				const iw2 = dw * STORYBOARD_INSET_SCALE;
				const ih2 = dh * STORYBOARD_INSET_SCALE;
				ctx.drawImage(shot.image, dx + dw - iw2, dy + dh - ih2, iw2, ih2);
			}
		} else {
			ctx.fillStyle = "#2a2a32";
			ctx.fillRect(x + pad, y + pad, cell.width - pad * 2, thumbHeight - pad);
		}

		const textX = x + pad;
		let textY = y + thumbHeight + 16;
		ctx.fillStyle = "#f2f2f5";
		ctx.fillText(String(shot.title ?? ""), textX, textY);
		textY += 14;
		ctx.fillStyle = "#9a9aa5";
		ctx.fillText(`${shot.durationSeconds}s`, textX, textY);
		textY += 14;
		ctx.fillText(storyboardCellText(shot), textX, textY);
	});

	return canvas;
}

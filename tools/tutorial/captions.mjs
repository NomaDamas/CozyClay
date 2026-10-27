// Caption PNGs for the tutorial recorder, drawn by the same headless Chrome
// that recorded the episode: one transparent image per cue, as wide as the
// video and as tall as the caption band under it (tools/tutorial/mux.mjs).
import { writeFileSync } from "node:fs";
import { join } from "node:path";

const FONT = `"Apple SD Gothic Neo","Noto Sans CJK KR","Noto Sans KR","Malgun Gothic",sans-serif`;
const escape = (text) => text.replace(/[&<>]/g, (character) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;" })[character]);

function captionHtml(text, width, height) {
	const size = Math.round(width * 0.024);
	return `<!doctype html><meta charset="utf-8"><style>
html,body{margin:0;background:transparent}
body{width:${width}px;height:${height}px;display:flex;align-items:center;justify-content:center;background:rgba(0,0,0,.62)}
p{margin:0 ${Math.round(width * 0.06)}px;font:600 ${size}px/1.35 ${FONT};color:#fff;text-align:center;word-break:keep-all;overflow-wrap:normal}
</style><p>${escape(text)}</p>`;
}

/** One PNG per text in `dir`, rendered through the open CDP page; returns their paths. */
export async function renderCaptions(cdp, { texts, width, height, dir, language }) {
	const loaded = cdp.once("Page.loadEventFired");
	await cdp.send("Page.navigate", { url: "about:blank" });
	await loaded;
	await cdp.send("Emulation.setDefaultBackgroundColorOverride", { color: { r: 0, g: 0, b: 0, a: 0 } });
	const paths = [];
	for (const [index, text] of texts.entries()) {
		const html = captionHtml(text, width, height);
		// Korean wraps at spaces only (keep-all); a line that still overflows the
		// width, or text taller than the band, gets a smaller font, never a broken word.
		await cdp.evaluate(`(async () => {
			document.open(); document.write(${JSON.stringify(html)}); document.close();
			await document.fonts.ready;
			const text = document.querySelector("p");
			let size = parseFloat(getComputedStyle(text).fontSize);
			while (size > 16 && (text.scrollWidth > text.clientWidth || text.scrollHeight > ${height})) text.style.fontSize = (size -= 2) + "px";
		})()`);
		const shot = await cdp.send("Page.captureScreenshot", { format: "png", clip: { x: 0, y: 0, width, height, scale: 1 } });
		const path = join(dir, `caption-${String(index).padStart(2, "0")}.${language}.png`);
		writeFileSync(path, Buffer.from(shot.data, "base64"));
		paths.push(path);
	}
	return paths;
}

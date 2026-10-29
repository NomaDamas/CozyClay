// Per-shot review data. Kept beside the shot so project save/load, duplicate,
// split and undo use the existing shot-document history instead of a side store.

const finiteUnit = value => Number.isFinite(value) && value >= 0 && value <= 1;
const text = (value, max) => typeof value === "string" ? Array.from(value.trim()).slice(0, max).join("") : "";

export function repairReview(value, { startFrame = 0, endFrame = Number.MAX_SAFE_INTEGER } = {}) {
	if (!value || typeof value !== "object" || Array.isArray(value)) return null;
	const comments = (Array.isArray(value.comments) ? value.comments : []).flatMap(row => {
		if (!row || !Number.isInteger(row.frame) || row.frame < startFrame || row.frame > endFrame || !text(row.text, 1000)) return [];
		return [{
			id: text(row.id, 100) || `comment-${row.frame}`,
			frame: row.frame,
			text: text(row.text, 1000),
			resolved: row.resolved === true,
		}];
	}).slice(-200);
	const annotations = (Array.isArray(value.annotations) ? value.annotations : []).flatMap(row => {
		if (!row || !Number.isInteger(row.frame) || row.frame < startFrame || row.frame > endFrame || !Array.isArray(row.points)) return [];
		const points = row.points.filter(point => Array.isArray(point) && point.length === 2 && point.every(finiteUnit))
			.slice(0, 512).map(point => [point[0], point[1]]);
		if (points.length < 2) return [];
		return [{
			id: text(row.id, 100) || `stroke-${row.frame}`,
			frame: row.frame,
			color: /^#[0-9a-f]{6}$/i.test(row.color) ? row.color : "#ffbf47",
			points,
		}];
	}).slice(-100);
	const review = { burnIn: value.burnIn === true, comments, annotations };
	return review.burnIn || comments.length || annotations.length ? review : null;
}

export function emptyReview() {
	return { burnIn: false, comments: [], annotations: [] };
}

export function reviewAtFrame(review, frame) {
	const current = review ?? emptyReview();
	return {
		comments: (current.comments ?? []).filter(row => row.frame === frame),
		annotations: (current.annotations ?? []).filter(row => row.frame === frame),
	};
}

export function timecodeAt(frame, fps = 24) {
	const safeFrame = Math.max(0, Math.round(frame));
	const safeFps = Math.max(1, Math.round(fps));
	const seconds = Math.floor(safeFrame / safeFps);
	const pad = value => String(value).padStart(2, "0");
	return `${pad(Math.floor(seconds / 3600))}:${pad(Math.floor(seconds / 60) % 60)}:${pad(seconds % 60)}:${pad(safeFrame % safeFps)}`;
}

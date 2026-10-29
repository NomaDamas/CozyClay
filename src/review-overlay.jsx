import { useEffect, useRef } from "react";
import { useStudioShell } from "./shell/studio-shell-context.js";
import { emptyReview, reviewAtFrame } from "./shot-review.js";
import { useViewportTools } from "./viewport-tools.js";

function paint(canvas, annotations, draft) {
	const rect = canvas.getBoundingClientRect(), ratio = Math.min(globalThis.devicePixelRatio || 1, 2);
	const width = Math.max(1, Math.round(rect.width * ratio)), height = Math.max(1, Math.round(rect.height * ratio));
	if (canvas.width !== width || canvas.height !== height) { canvas.width = width; canvas.height = height; }
	const context = canvas.getContext("2d");
	context.clearRect(0, 0, width, height);
	context.lineCap = "round"; context.lineJoin = "round"; context.lineWidth = 3 * ratio;
	for (const stroke of [...annotations, ...(draft ? [draft] : [])]) {
		if (stroke.points.length < 2) continue;
		context.strokeStyle = stroke.color;
		context.beginPath();
		stroke.points.forEach(([x, y], index) => index ? context.lineTo(x * width, y * height) : context.moveTo(x * width, y * height));
		context.stroke();
	}
}

export default function ReviewOverlay() {
	const { activeShot, tlFrame, runStudioAction } = useStudioShell();
	const { annotate } = useViewportTools();
	const canvasRef = useRef(null), draftRef = useRef(null);
	const strokes = reviewAtFrame(activeShot?.review ?? emptyReview(), tlFrame).annotations;
	useEffect(() => {
		const canvas = canvasRef.current;
		if (!canvas) return undefined;
		const redraw = () => paint(canvas, strokes, draftRef.current);
		redraw();
		const observer = new ResizeObserver(redraw);
		observer.observe(canvas);
		return () => observer.disconnect();
	}, [strokes, activeShot?.id, tlFrame, annotate]);
	const point = event => {
		const rect = event.currentTarget.getBoundingClientRect();
		return [Math.max(0, Math.min(1, (event.clientX - rect.left) / rect.width)), Math.max(0, Math.min(1, (event.clientY - rect.top) / rect.height))];
	};
	if (!activeShot) return null;
	return <canvas ref={canvasRef} className={"review-overlay" + (annotate ? " active" : "")} data-testid="review-overlay"
		onPointerDown={event => {
			if (!annotate || event.button !== 0) return;
			event.preventDefault(); event.currentTarget.setPointerCapture(event.pointerId);
			const next = { id: `stroke-${crypto.randomUUID()}`, frame: tlFrame, color: "#ffbf47", points: [point(event)] };
			draftRef.current = next;
		}}
		onPointerMove={event => {
			if (!draftRef.current || !annotate) return;
			const next = { ...draftRef.current, points: [...draftRef.current.points, point(event)] };
			draftRef.current = next; paint(canvasRef.current, strokes, next);
		}}
		onPointerUp={event => {
			const finished = draftRef.current;
			draftRef.current = null;
			if (!finished) return;
			event.currentTarget.releasePointerCapture(event.pointerId);
			if (finished.points.length < 2) return;
			runStudioAction("shot.setReview", { shotId: activeShot.id, review: { ...(activeShot.review ?? emptyReview()), annotations: [...activeShot.review?.annotations ?? [], finished] } });
		}}
		onPointerCancel={() => { draftRef.current = null; paint(canvasRef.current, strokes, null); }}
	/>;
}

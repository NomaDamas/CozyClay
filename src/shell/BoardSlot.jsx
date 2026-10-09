import { useEffect, useRef, useState } from "react";
import { useStudioShell } from "./studio-shell-context.js";
import { ko } from "../locale.js";
import { assetRecord } from "../scene-asset-cache.js";
import { STILL_HOLD_MAX } from "../shot-authoring.js";

// A card's greybox is re-captured this long after the last document edit, so
// a drag or a typing burst costs one capture pass, not one per change.
const THUMB_DEBOUNCE_MS = 500;
const PANEL_DRAG_TYPE = "application/x-cozyclay-panel";
const LATER_PR = "coming in a later PR";

/** The stylized picture behind a panel, as an object URL for its lifetime. */
function useStylizedUrl(assetId) {
	const [url, setUrl] = useState(null);
	useEffect(() => {
		setUrl(null);
		if (!assetId) return undefined;
		let live = true;
		let objectUrl = null;
		assetRecord(assetId).then((record) => {
			if (!live || !record) return;
			objectUrl = URL.createObjectURL(new Blob([record.bytes], { type: record.type }));
			setUrl(objectUrl);
		}, (error) => console.warn(`[cozyclay] stylized panel ${assetId} could not be read`, error));
		return () => {
			live = false;
			if (objectUrl) URL.revokeObjectURL(objectUrl);
		};
	}, [assetId]);
	return url;
}

/** Board: the storyboard's stills as a strip of panel cards, in still order.
 * Every edit goes through the shot commands, so the Sequencer, undo and the
 * Agent see the same document. */
export default function BoardSlot({ active = true }) {
	const { shots, activeShot, tlFps, runStudioAction, selectTimelineShot, capturePanelThumbnail, sceneRevision } = useStudioShell();
	const stills = shots.filter((entry) => entry.kind === "still").sort((a, b) => a.startFrame - b.startFrame);
	const [thumbs, setThumbs] = useState({});
	const [dragId, setDragId] = useState(null);
	const [drop, setDrop] = useState(null);
	const stillsRef = useRef(stills);
	stillsRef.current = stills;
	const captureRef = useRef(capturePanelThumbnail);
	captureRef.current = capturePanelThumbnail;
	const stripRef = useRef(null);
	const countRef = useRef(stills.length);

	const stillsKey = stills.map((entry) => `${entry.id}:${entry.startFrame}`).join(",");
	useEffect(() => {
		if (!active || !stillsKey) return undefined;
		const timer = setTimeout(() => {
			const next = {};
			for (const entry of stillsRef.current) {
				try {
					next[entry.id] = captureRef.current(entry);
				} catch (error) {
					console.warn(`[cozyclay] panel ${entry.id} thumbnail failed`, error);
					next[entry.id] = null;
				}
			}
			setThumbs(next);
		}, THUMB_DEBOUNCE_MS);
		return () => clearTimeout(timer);
	}, [active, sceneRevision, stillsKey]);

	// A new panel lands at the end of the strip: bring it into view.
	useEffect(() => {
		if (stills.length > countRef.current) stripRef.current?.lastElementChild?.scrollIntoView?.({ block: "nearest", inline: "nearest" });
		countRef.current = stills.length;
	}, [stills.length]);

	const fps = tlFps || 24;
	const addPanel = () => runStudioAction("shot.createStill", {});

	function dropTarget(event, entry) {
		const box = event.currentTarget.getBoundingClientRect();
		return { id: entry.id, after: event.clientX > box.left + box.width / 2 };
	}

	function reorderTo(target) {
		const moving = dragId;
		setDragId(null);
		setDrop(null);
		if (!moving || !target || moving === target.id) return;
		const others = stills.filter((entry) => entry.id !== moving);
		const index = others.findIndex((entry) => entry.id === target.id) + (target.after ? 1 : 0);
		if (stills.findIndex((entry) => entry.id === moving) === index) return;
		runStudioAction("shot.reorder", { shotId: moving, index });
	}

	return (
		<section className="dock-board" aria-label={ko("Board", "보드")} data-testid="dock-board" hidden={!active}>
			<header className="dock-board-head">
				<span className="dock-board-count">{ko(`${stills.length} panels`, `패널 ${stills.length}개`)}</span>
				{/* An empty board offers + Panel once, in its empty state. */}
				{stills.length > 0 && (
					<button type="button" className="dock-board-add" data-testid="board-add-panel" title={ko("Add a panel after the last one, framed by the current camera", "현재 카메라 구도로 마지막 패널 뒤에 패널 추가")} onClick={addPanel}>
						{ko("+ Panel", "+ 패널")}
					</button>
				)}
			</header>
			{stills.length === 0 ? (
				<div className="dock-board-empty" data-testid="board-empty">
					<p>{ko("No panels yet. Each panel is one held picture of the scene through the shot camera.", "아직 패널이 없어요. 패널 하나는 샷 카메라로 본 장면 한 장을 일정 시간 보여 줍니다.")}</p>
					<button type="button" className="dock-board-add" data-testid="board-empty-add" title={ko("Add the first panel, framed by the current camera", "현재 카메라 구도로 첫 패널 추가")} onClick={addPanel}>{ko("+ Panel", "+ 패널")}</button>
				</div>
			) : (
				<ol className="dock-board-strip" ref={stripRef} data-testid="board-strip">
					{stills.map((entry, index) => (
						<PanelCard
							key={entry.id}
							shot={entry}
							index={index}
							fps={fps}
							thumb={thumbs[entry.id] ?? null}
							selected={activeShot?.id === entry.id}
							dragging={dragId === entry.id}
							dropSide={drop?.id === entry.id ? (drop.after ? "after" : "before") : null}
							onSelect={() => selectTimelineShot(entry.id)}
							onRemove={() => runStudioAction("shot.remove", { shotId: entry.id })}
							onDuplicate={() => runStudioAction("shot.duplicate", { shotId: entry.id })}
							onCaption={(caption) => runStudioAction("shot.setCaption", { shotId: entry.id, caption })}
							onHold={(hold) => runStudioAction("shot.setHold", { shotId: entry.id, hold })}
							onDragStart={(event) => {
								event.dataTransfer.effectAllowed = "move";
								event.dataTransfer.setData(PANEL_DRAG_TYPE, entry.id);
								setDragId(entry.id);
							}}
							onDragOver={(event) => {
								if (!dragId) return;
								event.preventDefault();
								event.dataTransfer.dropEffect = "move";
								const next = dropTarget(event, entry);
								if (drop?.id !== next.id || drop?.after !== next.after) setDrop(next);
							}}
							onDrop={(event) => {
								event.preventDefault();
								reorderTo(dropTarget(event, entry));
							}}
							onDragEnd={() => { setDragId(null); setDrop(null); }}
						/>
					))}
				</ol>
			)}
		</section>
	);
}

function PanelCard({ shot, index, fps, thumb, selected, dragging, dropSide, onSelect, onRemove, onDuplicate, onCaption, onHold, onDragStart, onDragOver, onDrop, onDragEnd }) {
	const stylized = useStylizedUrl(shot.stylizedAssetId);
	const hold = shot.endFrame - shot.startFrame + 1;
	const seconds = Number((hold / fps).toFixed(2));
	const stop = (event) => event.stopPropagation();

	function commitCaption(event) {
		const next = event.currentTarget.value.trim();
		if (next !== (shot.caption ?? "")) onCaption(next);
	}

	function commitHold(event) {
		const value = Number(event.currentTarget.value);
		const frames = Math.round(value * fps);
		if (!Number.isFinite(value) || frames < 1 || frames > STILL_HOLD_MAX) {
			event.currentTarget.value = String(seconds);
			return;
		}
		if (frames !== hold) onHold(frames);
	}

	return (
		<li
			className="dock-board-card"
			data-testid="board-card"
			data-shot-id={shot.id}
			data-selected={selected || undefined}
			data-dragging={dragging || undefined}
			data-drop={dropSide ?? undefined}
			tabIndex={0}
			draggable
			aria-label={ko(`Panel ${index + 1}`, `패널 ${index + 1}`)}
			aria-current={selected ? "true" : undefined}
			onClick={onSelect}
			onKeyDown={(event) => {
				if (event.target !== event.currentTarget) return;
				if (event.key === "Delete") {
					event.preventDefault();
					event.stopPropagation();
					onRemove();
				} else if (event.key === "Enter") {
					onSelect();
				}
			}}
			onDragStart={onDragStart}
			onDragOver={onDragOver}
			onDrop={onDrop}
			onDragEnd={onDragEnd}
		>
			<div className="dock-board-actions">
				<button type="button" data-action="duplicate" title={ko("Duplicate this panel after itself", "이 패널을 바로 뒤에 복제")} onClick={(event) => { stop(event); onDuplicate(); }}>{ko("Duplicate", "복제")}</button>
				<button type="button" data-action="delete" className="danger" title={ko("Delete this panel (Delete)", "이 패널 삭제 (Delete)")} onClick={(event) => { stop(event); onRemove(); }}>{ko("Delete", "삭제")}</button>
				<button type="button" data-action="stylize" disabled title={ko("Stylize — coming in a later PR", "스타일화 — 다음 PR에서 제공")} data-disabled-reason={LATER_PR}>{ko("Stylize", "스타일화")}</button>
				<button type="button" data-action="workflow" disabled title={ko("Send to Workflow — coming in a later PR", "워크플로로 보내기 — 다음 PR에서 제공")} data-disabled-reason={LATER_PR}>{ko("Send to Workflow", "워크플로로")}</button>
				<button type="button" data-action="export" disabled title={ko("Export — coming in a later PR", "내보내기 — 다음 PR에서 제공")} data-disabled-reason={LATER_PR}>{ko("Export", "내보내기")}</button>
			</div>
			<div className="dock-board-thumb" data-stylized={stylized ? "true" : undefined}>
				{stylized ? <img className="dock-board-image" src={stylized} alt="" draggable={false} /> : thumb && <img className="dock-board-image" src={thumb} alt="" draggable={false} />}
				{stylized && thumb && <img className="dock-board-inset" src={thumb} alt="" draggable={false} />}
				<span className="dock-board-index" data-testid="board-card-index">{index + 1}</span>
			</div>
			<textarea
				key={`caption:${shot.caption ?? ""}`}
				className="dock-board-caption"
				data-testid="board-card-caption"
				aria-label={ko(`Panel ${index + 1} caption`, `패널 ${index + 1} 캡션`)}
				placeholder={ko("Action or dialogue", "동작 또는 대사")}
				defaultValue={shot.caption ?? ""}
				maxLength={500}
				rows={2}
				onClick={stop}
				onBlur={commitCaption}
			/>
			<label className="dock-board-hold" onClick={stop}>
				<span>{ko("Hold", "홀드")}</span>
				<input
					key={`hold:${hold}`}
					type="number"
					data-testid="board-card-hold"
					min={1 / fps}
					max={STILL_HOLD_MAX / fps}
					step={0.5}
					defaultValue={seconds}
					aria-label={ko(`Panel ${index + 1} hold in seconds`, `패널 ${index + 1} 홀드 (초)`)}
					onBlur={commitHold}
					onKeyDown={(event) => { if (event.key === "Enter") event.currentTarget.blur(); }}
				/>
				<span>{ko("s", "초")}</span>
			</label>
		</li>
	);
}

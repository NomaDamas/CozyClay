import { useEffect, useState } from "react";
import { ko } from "./locale.js";
import { CHARACTER_MODEL_IDS } from "./scenes.js";
import { OBJECT_LIBRARY } from "./scene-objects.js";
import { displayObjectGroupName, displayObjectLabel } from "./object-catalog.jsx";
import { assetAspect } from "./scene-assets.js";
import { assetKind, formatAssetBytes } from "./asset-shelf.js";
import { assetRecord } from "./scene-asset-cache.js";
import ResourceStatus from "./resource-status.jsx";

/** Casting assets offered in the bottom Assets tab. `id` doubles as the FBX
 * file stem and the ARDY wire rig name (see scenes.js). */
export const CHARACTER_ASSETS = CHARACTER_MODEL_IDS.map((id) => ({
	id,
	label: id === "y-bot-tpose" ? "Y Bot" : "X Bot",
}));

function CharacterPreview({ model }) {
	const yBot = model === "y-bot-tpose";
	return (
		<svg className="asset-card-preview" viewBox="0 0 48 48" aria-hidden="true">
			<circle cx="24" cy="8.5" r="5.5" />
			<path d="M18 15.5 15.5 29h17L30 15.5Z" />
			<path className="preview-limb" d={yBot ? "M18 18 10 25M30 18l8 7" : "M18 18 7 18M30 18h11"} />
			<path className="preview-limb" d="m20 29-4 12m12-12 4 12" />
		</svg>
	);
}

function ObjectPreview({ kind, color }) {
	const fill = color || "#b8bec3";
	const common = { fill, stroke: "#d7dde0", strokeWidth: 1.2, strokeLinejoin: "round" };
	let shape;
	switch (kind) {
		case "cube":
			shape = <>
				<path {...common} d="m9 16 15-8 15 8-15 8Z" />
				<path {...common} d="m9 16 15 8v16L9 31Z" opacity=".82" />
				<path {...common} d="m39 16-15 8v16l15-9Z" opacity=".62" />
			</>;
			break;
		case "sphere":
			shape = <>
				<circle {...common} cx="24" cy="24" r="16" />
				<path className="preview-detail" d="M11 24h26M24 8c8 8 8 24 0 32M24 8c-8 8-8 24 0 32" />
			</>;
			break;
		case "capsule":
			shape = <>
				<rect {...common} x="14" y="5" width="20" height="38" rx="10" />
				<path className="preview-detail" d="M15 17h18M15 31h18" />
			</>;
			break;
		case "cylinder":
			shape = <>
				<path {...common} d="M11 14c0-4 26-4 26 0v20c0 5-26 5-26 0Z" />
				<ellipse cx="24" cy="14" rx="13" ry="5" fill={fill} stroke="#d7dde0" strokeWidth="1.2" />
				<path className="preview-detail" d="M11 34c0 5 26 5 26 0" />
			</>;
			break;
		case "cone":
			shape = <>
				<path {...common} d="m24 6 14 31H10Z" />
				<ellipse cx="24" cy="37" rx="14" ry="4" fill={fill} stroke="#d7dde0" strokeWidth="1.2" />
			</>;
			break;
		case "plane":
			shape = <>
				<path {...common} d="M7 28 29 14l12 7-22 14Z" />
				<path className="preview-detail" d="m7 28 12 7 22-14" />
			</>;
			break;
		case "chair":
			shape = <>
				<path {...common} d="M13 8h18v17H13Z" />
				<path {...common} d="M12 25h24v8H12Z" />
				<path className="preview-limb" d="M15 33v10m18-10v10M13 25V8" />
			</>;
			break;
		case "car":
			shape = <>
				<path {...common} d="M7 27h5l5-9h15l7 9h3v9H7Z" />
				<path className="preview-detail" d="M17 18h15l4 9H13Z" />
				<circle cx="15" cy="36" r="4" fill="#181a1c" stroke="#d7dde0" />
				<circle cx="35" cy="36" r="4" fill="#181a1c" stroke="#d7dde0" />
			</>;
			break;
		case "small-plane":
			shape = <path {...common} d="M22 5h4l3 15 13 8v4l-13-3-2 12 5 3v2l-8-2-8 2v-2l5-3-2-12-13 3v-4l13-8Z" />;
			break;
		default:
			shape = <rect {...common} x="10" y="10" width="28" height="28" rx="4" />;
	}
	return <svg className="asset-card-preview" viewBox="0 0 48 48" aria-hidden="true">{shape}</svg>;
}

/** Shelf thumbnail edge: enough pixels for a 108 px card on a 2x display. */
const THUMB_WIDTH = 96;

/**
 * id → Promise<{ url, aspect, name } | null>, for the session. Thumbnails are
 * derived data — the bytes are content-addressed, so an id's picture never
 * changes — which makes a module Map the whole cache story: a tab switch or a
 * re-render redraws nothing, and a reload just re-decodes 96 px thumbs.
 */
const thumbCache = new Map();

function loadThumb(id) {
	if (!thumbCache.has(id)) {
		thumbCache.set(id, (async () => {
			const record = await assetRecord(id);
			// A missing record means another tab swept it — undefined, so the
			// card hides. A present record whose bytes fail below resolves null
			// instead, and the card stays visible so it can be deleted.
			if (!record) return undefined;
			const bitmap = await createImageBitmap(new Blob([record.bytes], { type: record.type }), {
				resizeWidth: THUMB_WIDTH,
				resizeQuality: "high",
			});
			const canvas = document.createElement("canvas");
			canvas.width = bitmap.width;
			canvas.height = bitmap.height;
			canvas.getContext("2d").drawImage(bitmap, 0, 0);
			bitmap.close?.();
			return {
				url: canvas.toDataURL(),
				aspect: assetAspect(record) ?? 1,
				name: record.name,
				bytesLabel: formatAssetBytes(record.bytes.byteLength),
				kind: assetKind(record),
			};
		})().catch(() => null));
	}
	return thumbCache.get(id);
}

/** The grab wire every card shares: left button only, App owns the rest. */
function grabProps(onAssetGrab, payload) {
	return {
		onPointerDown: (event) => {
			if (event.button !== 0) return;
			event.preventDefault();
			onAssetGrab?.(payload, event);
		},
	};
}

/** One imported picture. The card renders immediately as a skeleton and the
 * thumbnail lands when the decode does — the grid never waits on a decode. */
function ImageAssetCard({ id, onAssetGrab }) {
	// null = decoding (skeleton), undefined = record gone, object = ready. A
	// cached thumb still starts null for one microtask; no frame is lost.
	const [thumb, setThumb] = useState(null);
	useEffect(() => {
		let alive = true;
		loadThumb(id).then((result) => {
			if (alive) setThumb(result ?? undefined);
		});
		return () => {
			alive = false;
		};
	}, [id]);
	// undefined = the record is gone (another tab swept it); show nothing
	// rather than a card that spawns a blank quad. null = the record is
	// there but its bytes did not decode — the card MUST stay visible, or
	// the failure leaves garbage the storage manager cannot even show.
	if (thumb === undefined) return null;
	const label = thumb?.name?.replace(/\.[^.]+$/, "") || ko("Image", "이미지");
	const failed = thumb === null;
	return (
		<button
			type="button"
			className={"asset-card" + (failed ? " asset-card-failed" : "")}
			title={failed
				? ko(`${label} — could not decode; delete it from Manage storage`, `${label} — 불러오지 못했어요. 저장소 관리에서 삭제할 수 있어요`)
				: ko(`Drag ${label} into the scene`, `${label}을(를) 씬에 드래그하세요`)}
			{...(failed ? {} : grabProps(onAssetGrab, { kind: "image", assetId: id, label, aspect: thumb?.aspect ?? 1, thumb: thumb?.url ?? null }))}
		>
			{thumb ? (
				<img className="asset-card-thumb" src={thumb.url} alt="" draggable={false} />
			) : (
				<span className="asset-card-thumb asset-card-thumb-skeleton" aria-hidden="true" />
			)}
			<span className="asset-card-label">{label}</span>
			<span className="asset-card-kind">{failed ? ko("Unreadable", "읽을 수 없음") : ko("Image", "이미지")}</span>
		</button>
	);
}

function StorageAssetRow({ id, onDelete, deleting, usageCount = 0, graphSignature }) {
	const [thumb, setThumb] = useState(null);
	// Capture the graph observed when the explicit confirmation opens. A render
	// caused by a concurrent scene edit must not silently update its authority.
	const [confirmation, setConfirmation] = useState(null);
	const inUse = usageCount > 0;
	useEffect(() => {
		let alive = true;
		loadThumb(id).then((result) => {
			if (alive) setThumb(result ?? undefined);
		});
		return () => {
			alive = false;
		};
	}, [id]);
	// Same rule as the shelf card: a decode failure must stay visible so the
	// one screen whose job is deleting broken assets can actually reach it.
	if (thumb === undefined) return null;
	const failed = thumb === null;
	const name = thumb?.name || (failed ? ko("(unreadable image)", "(읽을 수 없는 이미지)") : ko("Untitled image", "이름 없는 이미지"));
	const usageLabel = ko(`Used by ${usageCount} scene object${usageCount === 1 ? "" : "s"}`, `${usageCount}개 씬 오브젝트에서 사용 중`);
	const deleteLabel = ko(`Delete ${name} from storage`, `${name}을(를) 저장소에서 삭제`);
	const confirmationId = `asset-storage-warning-${id}`;
	return (
		<li className="asset-storage-row">
			{thumb ? <img className="asset-storage-thumb" src={thumb.url} alt="" /> : <span className="asset-storage-thumb asset-card-thumb-skeleton" aria-hidden="true" />}
			<div className="asset-storage-details">
				<strong title={name}>{name}</strong>
				<span>{thumb ? `${thumb.kind === "matte" ? ko("Matte", "매트") : ko("Image", "이미지")} · ${thumb.bytesLabel}` : ko("Loading details…", "세부 정보 불러오는 중…")}</span>
				{inUse && <span className="asset-storage-usage">{usageLabel}</span>}
			</div>
			{confirmation ? (
				<div className="asset-storage-confirm">
					<span id={confirmationId} role="alert">{inUse
						? ko(`Permanently delete this image from storage? It is used by ${usageCount} scene object${usageCount === 1 ? "" : "s"} and those objects will lose it.`, `저장소에서 이 이미지를 영구 삭제할까요? ${usageCount}개 씬 오브젝트가 사용 중이며 해당 오브젝트에서 사라집니다.`)
						: ko("Unused by every scene. Delete it?", "모든 씬에서 사용되지 않아요. 삭제할까요?")}</span>
					<button type="button" className="asset-storage-delete" aria-label={deleteLabel} aria-describedby={confirmationId} disabled={deleting} onClick={async () => {
						if (await onDelete(id, inUse ? usageCount : undefined, confirmation.graphSignature)) setConfirmation(null);
					}}>{ko("Delete", "삭제")}</button>
					<button type="button" className="asset-storage-cancel" disabled={deleting} onClick={() => setConfirmation(null)}>{ko("Cancel", "취소")}</button>
				</div>
			) : (
				<button type="button" className="asset-storage-delete" aria-label={deleteLabel} disabled={deleting || !thumb} onClick={() => setConfirmation({ graphSignature })}>
					{deleting ? ko("Deleting…", "삭제 중…") : ko("Delete", "삭제")}
				</button>
			)}
		</li>
	);
}

function StorageManager({ unusedAssetIds, usedAssetIds, usageCounts, graphSignature, trashCount, onDelete, onUndo, deletingAssetId }) {
	const loading = unusedAssetIds === null || usedAssetIds === null;
	const empty = !loading && unusedAssetIds.length === 0 && usedAssetIds.length === 0;
	return (
		<section className="asset-storage-manager" aria-label={ko("Manage storage", "저장 공간 관리")}>
			<div className="asset-storage-head">
				<div>
					<h3>{ko("Manage storage", "저장 공간 관리")}</h3>
					<p>{ko("Review unused and in-use stored images. Deleted images can be restored until this page is reloaded.", "사용하지 않는 이미지와 사용 중인 저장 이미지를 확인하세요. 삭제한 이미지는 이 페이지를 새로 고치기 전까지 복원할 수 있어요.")}</p>
				</div>
				{trashCount > 0 && <button type="button" className="asset-storage-undo" onClick={onUndo}>{ko(`Undo last delete (${trashCount})`, `마지막 삭제 실행 취소 (${trashCount})`)}</button>}
			</div>
			{loading ? (
				<div className="asset-storage-list" aria-busy="true">
					{[0, 1].map((n) => <span className="asset-storage-row asset-storage-row-skeleton" key={n} aria-hidden="true" />)}
				</div>
			) : empty ? (
				<p className="assets-empty">{ko("No stored image assets.", "저장된 이미지 에셋이 없어요.")}</p>
			) : <>
				<section className="asset-storage-section is-unused" aria-labelledby="asset-storage-unused-title">
					<h4 id="asset-storage-unused-title">{ko("Unused", "미사용")}</h4>
					{unusedAssetIds.length === 0 ? (
						<p className="assets-empty">{ko("No unused image assets. Every stored image is still used by a scene.", "사용되지 않는 이미지 에셋이 없어요. 저장된 모든 이미지를 씬에서 사용 중입니다.")}</p>
					) : (
						<ul className="asset-storage-list">
							{unusedAssetIds.map((id) => <StorageAssetRow key={id} id={id} onDelete={onDelete} deleting={deletingAssetId === id} graphSignature={graphSignature} />)}
						</ul>
					)}
				</section>
				<section className="asset-storage-section is-used" aria-labelledby="asset-storage-used-title">
					<h4 id="asset-storage-used-title">{ko("In use", "사용 중")}</h4>
					{usedAssetIds.length === 0 ? (
						<p className="assets-empty">{ko("No stored image assets are used by a scene.", "씬에서 사용하는 저장 이미지 에셋이 없어요.")}</p>
					) : (
						<ul className="asset-storage-list">
							{usedAssetIds.map((id) => <StorageAssetRow key={id} id={id} usageCount={usageCounts.get(id) ?? 0} onDelete={onDelete} deleting={deletingAssetId === id} graphSignature={graphSignature} />)}
						</ul>
					)}
				</section>
			</>}
		</section>
	);
}

/**
 * Bottom-window asset shelf: everything placeable, one grid — the cast, the
 * object catalogue and the user's imported pictures, each under its own
 * heading. The drag itself is owned by App (ghost overlay + ground raycast on
 * drop); the pane only reports the grab with a discriminated payload.
 *
 * `imageAssetIds` is null while App's asset scan is in flight, then the list
 * of SOURCE ids (see asset-shelf.js) — derived mattes and cut renders never
 * reach this component.
 */
export default function AssetPane({ onAssetGrab, imageAssetIds, manageStorage, onManageStorageToggle, unusedAssetIds, usedAssetIds, usageCounts, graphSignature, trashCount, onDeleteUnusedAsset, onUndoDelete, deletingAssetId, resourceManifest }) {
	return (
		<div className="assets-shelf">
			{resourceManifest ? <ResourceStatus manifest={resourceManifest} compact /> : null}
			<div className="assets-shelf-toolbar">
				<button type="button" className="assets-manage-toggle" aria-pressed={manageStorage} onClick={onManageStorageToggle}>
					{manageStorage ? ko("Back to assets", "에셋으로 돌아가기") : ko("Manage storage", "저장 공간 관리")}
				</button>
			</div>
			{manageStorage ? (
				<StorageManager unusedAssetIds={unusedAssetIds} usedAssetIds={usedAssetIds} usageCounts={usageCounts} graphSignature={graphSignature} trashCount={trashCount} onDelete={onDeleteUnusedAsset} onUndo={onUndoDelete} deletingAssetId={deletingAssetId} />
			) : <>
				<section className="assets-section">
					<h3 className="assets-section-title">{ko("Characters", "인물")}</h3>
					<div className="assets-grid">
						{CHARACTER_ASSETS.map((asset) => (
							<button
								type="button"
								className="asset-card"
								key={asset.id}
								title={ko(`Drag ${asset.label} into the scene`, `${asset.label}을(를) 씬에 드래그하세요`)}
								{...grabProps(onAssetGrab, { kind: "character", id: asset.id, label: asset.label })}
							>
								<CharacterPreview model={asset.id} />
								<span className="asset-card-label">{asset.label}</span>
								<span className="asset-card-kind">{ko("Character", "인물")}</span>
							</button>
						))}
					</div>
				</section>
				<section className="assets-section">
					<h3 className="assets-section-title">{ko("Objects", "오브젝트")}</h3>
					<div className="assets-grid">
						{OBJECT_LIBRARY.map((entry) => (
							<button
								type="button"
								className="asset-card"
								key={entry.kind}
								title={ko(
									`Drag ${entry.label} into the scene`,
									`${displayObjectLabel(entry.label)}을(를) 씬에 드래그하세요`,
								)}
								{...grabProps(onAssetGrab, { kind: "object", objectKind: entry.kind, label: displayObjectLabel(entry.label), color: entry.color })}
							>
								<ObjectPreview kind={entry.kind} color={entry.color} />
								<span className="asset-card-label">{displayObjectLabel(entry.label)}</span>
								<span className="asset-card-kind">{displayObjectGroupName(entry.group)}</span>
							</button>
						))}
					</div>
				</section>
				<section className="assets-section">
					<h3 className="assets-section-title">{ko("My images", "내 이미지")}</h3>
					{imageAssetIds === null ? (
						<div className="assets-grid" aria-busy="true">
							{[0, 1, 2].map((n) => <span className="asset-card asset-card-skeleton" key={n} aria-hidden="true" />)}
						</div>
					) : imageAssetIds.length === 0 ? (
						<p className="assets-empty">
							{ko(
								"No imported images yet. Use \u201cImport image as cutout\u201d in the Props inspector, or drop or paste a picture into the studio.",
								"아직 가져온 이미지가 없어요. 소품 인스펙터의 \u201c이미지를 컷아웃으로 가져오기\u201d를 사용하거나, 이미지를 스튜디오에 드래그하거나 붙여넣으세요.",
							)}
						</p>
					) : (
						<div className="assets-grid">
							{imageAssetIds.map((id) => <ImageAssetCard key={id} id={id} onAssetGrab={onAssetGrab} />)}
						</div>
					)}
				</section>
			</>}
		</div>
	);
}

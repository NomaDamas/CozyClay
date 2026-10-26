// The Content pane's Sculpts folder (#740 S9 + S13): one tile per sculpt card
// on the shelf (sculpt-shelf.js). A tile drags into the scene like any other
// asset and carries its recipe, so a drop needs no store read. A selected card
// can be exported as `.cozysculpt.json` or deleted; Import (or dropping card
// files on the folder) brings cards in.
import { useEffect, useRef, useState, useSyncExternalStore } from "react";
import { ko } from "./locale.js";
import { ContentTile, grabProps } from "./content-tile.jsx";
import { SearchEmpty } from "./search-friction.js";
import { deleteSculptCard, exportSculptCard, importSculptCardFiles, refreshSculptShelf, sculptShelfCards, subscribeSculptShelf } from "./sculpt-shelf.js";
import { SCULPT_FILE_SUFFIX } from "./sculpt-shelf-file.js";

const sculptKey = (id) => `sculpt:${id}`;

export default function SculptShelf({ query, selectedKey, onSelect, onAssetGrab, onAssetPlace }) {
	const cards = useSyncExternalStore(subscribeSculptShelf, sculptShelfCards, sculptShelfCards);
	const [note, setNote] = useState("");
	const [confirmDelete, setConfirmDelete] = useState(null);
	const fileRef = useRef(null);
	useEffect(() => { void refreshSculptShelf(); }, []);
	const selected = cards?.find((card) => sculptKey(card.id) === selectedKey) ?? null;
	const visible = (cards ?? []).filter((card) => !query || card.name.toLowerCase().includes(query));
	const importFiles = async (files) => setNote(await importSculptCardFiles(files));
	const tiles = cards === null
		? [0, 1, 2].map((n) => <span className="content-tile is-loading" key={`loading-${n}`} aria-hidden="true"><span className="content-tile-thumb"><span className="content-tile-skeleton" /></span></span>)
		: visible.map((card) => {
			const key = sculptKey(card.id);
			const payload = { kind: "sculpt", id: card.id, label: card.name, name: card.name, recipe: card.recipe, thumb: card.thumb };
			return (
				<ContentTile key={key} assetKey={key} label={card.name} type={ko("Sculpt", "조형물", "雕塑")}
					title={ko(`Drag ${card.name} into the scene, or double-click to place it at the origin`, `${card.name}을(를) 씬에 드래그하거나 더블클릭해 원점에 놓으세요`, `将 ${card.name} 拖入场景，或双击将其放在原点`)}
					preview={card.thumb ? <img className="content-tile-img" src={card.thumb} alt="" draggable={false} /> : <span className="content-tile-skeleton" aria-hidden="true" />}
					selected={selectedKey === key} onSelect={onSelect} grab={grabProps(onAssetGrab, payload)} onPlace={() => onAssetPlace?.(payload)} />
			);
		});
	return (
		<div className="sculpt-shelf" data-testid="sculpt-shelf"
			onDragOver={(event) => { if (event.dataTransfer?.types?.includes("Files")) event.preventDefault(); }}
			onDrop={(event) => {
				const files = [...(event.dataTransfer?.files ?? [])].filter((file) => file.name.toLowerCase().endsWith(".json"));
				if (!files.length) return;
				event.preventDefault();
				event.stopPropagation();
				void importFiles(files);
			}}>
			<div className="sculpt-shelf-actions">
				<button type="button" data-testid="sculpt-shelf-import" onClick={() => fileRef.current?.click()}>{ko("Import…", "가져오기…", "导入…")}</button>
				<input ref={fileRef} type="file" hidden multiple accept={`${SCULPT_FILE_SUFFIX},.json,application/json`} data-testid="sculpt-shelf-file"
					onChange={(event) => { const files = [...event.target.files]; event.target.value = ""; void importFiles(files); }} />
				{selected && <>
					<button type="button" data-testid="sculpt-shelf-export" onClick={async () => setNote(await exportSculptCard(selected))}>{ko("Export", "내보내기", "导出")}</button>
					{confirmDelete === selected.id ? <>
						<button type="button" className="sculpt-shelf-delete" data-testid="sculpt-shelf-delete-confirm"
							onClick={async () => { setConfirmDelete(null); onSelect(null); await deleteSculptCard(selected.id); setNote(ko(`Deleted ${selected.name} from the shelf`, `${selected.name} 선반에서 삭제함`, `已从架子删除 ${selected.name}`)); }}>
							{ko(`Delete ${selected.name}?`, `${selected.name} 삭제할까요?`, `删除 ${selected.name}？`)}
						</button>
						<button type="button" onClick={() => setConfirmDelete(null)}>{ko("Cancel", "취소")}</button>
					</> : <button type="button" data-testid="sculpt-shelf-delete" onClick={() => setConfirmDelete(selected.id)}>{ko("Delete", "삭제")}</button>}
				</>}
				{note && <span className="sculpt-shelf-note" role="status" data-testid="sculpt-shelf-note">{note}</span>}
			</div>
			{cards !== null && !cards.length
				? <p className="content-empty">{ko("No sculpts on the shelf yet. Press Save to shelf in Sculpt mode (5), or import a .cozysculpt.json.", "선반에 조형물이 아직 없어요. 조형 모드(5)에서 선반에 저장을 누르거나 .cozysculpt.json을 가져오세요.")}</p>
				: query && !visible.length
					? <SearchEmpty surface="assets" query={query}><p className="content-empty">{ko("Nothing matches this search.", "검색 결과가 없어요.")}</p></SearchEmpty>
					: <div className="content-grid" role="list">{tiles}</div>}
		</div>
	);
}

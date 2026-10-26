import { useEffect, useRef } from "react";
import { ko } from "../locale.js";

// The sculpt's parts as an indented tree (#740 S7). Pure view: Sculpt mode
// owns the selection; a row press selects that part, the same state a click
// on the turntable sets. A mirrored part is listed once, as the recipe has it.
// `notice` is the part gizmo's last refusal (#740 S8), shown under the list.
export default function SculptPartTree({ tree, selected, onSelect, notice = null }) {
	const listRef = useRef(null);
	const selectedId = selected?.partId ?? null;
	// A pick on the turntable brings its row into view.
	useEffect(() => {
		if (selectedId) listRef.current?.querySelector("[aria-pressed='true']")?.scrollIntoView?.({ block: "nearest" });
	}, [selectedId]);
	if (!tree?.length) return null;
	return (
		<div className="sculpt-parts" data-testid="sculpt-part-tree">
			<div className="sculpt-label">
				<span>{ko("Parts", "부품", "部件")}</span>
				<small title={selectedId ? ko("W move · E rotate · R scale (Shift: uniform) · Esc to deselect", "W 이동 · E 회전 · R 크기 (Shift: 균등) · Esc로 선택 해제", "W 移动 · E 旋转 · R 缩放（Shift：等比）· 按 Esc 取消选择") : undefined}>
					{selectedId ? ko("W move · E rotate · R scale", "W 이동 · E 회전 · R 크기", "W 移动 · E 旋转 · R 缩放") : ko(`${tree.length} parts`, `부품 ${tree.length}개`, `${tree.length} 个部件`)}
				</small>
			</div>
			<ul className="sculpt-part-list" ref={listRef} aria-label={ko("Sculpt parts", "조형 부품", "雕塑部件")}>
				{tree.map((row) => {
					const on = row.id === selectedId;
					return (
						<li key={row.id}>
							<button type="button" className="sculpt-part-row" data-testid="sculpt-part-row" data-part={row.id} aria-pressed={on}
								data-mirrored={on && selected.mirrored ? "true" : undefined} style={{ "--sculpt-part-depth": row.depth }}
								onClick={() => onSelect?.({ partId: row.id, mirrored: false })}>
								<span className="sculpt-part-id">{row.id}</span>
								{on && selected.mirrored && <span className="sculpt-part-tag">{ko("mirror copy", "미러 사본", "镜像副本")}</span>}
								<span className="sculpt-part-shape">{row.mirror ? `${row.shape} ×2` : row.shape}</span>
							</button>
						</li>
					);
				})}
			</ul>
			{notice && <p className="inspector-hint sculpt-error" role="alert" data-testid="sculpt-part-notice">{notice}</p>}
		</div>
	);
}

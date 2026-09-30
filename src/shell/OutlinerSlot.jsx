import { useStudioShell } from "./studio-shell-context.js";
import { ko } from "../locale.js";
import HierarchyPanel from "../hierarchy-panel.jsx";

export default function OutlinerSlot() {
	const {
		projectDirty, projectName, projectStartupOpen, selectedHierarchyId, selectHierarchy,
		aimEditorAtKeyLight, characters, showB, motion, ikFrames,
		ikMode, rowIdForCharIndex, activeCharIndex, waypoints, sceneObjects,
		scenes, activeSceneId, selectSceneDocument, createSceneDocumentFromUi, duplicateSceneDocumentFromUi,
		renameSceneDocumentFromUi, deleteSceneDocumentFromUi, addSceneObject, renameSceneObject, runStudioAction,
		deleteSceneObject, frameSelection, toggleHierarchyHidden, propsDrop, hierarchyReparent,
		agentTouchedRows,
	} = useStudioShell();
	return (
		<aside className="panel hierarchy-left" aria-label={ko("Hierarchy", "계층")}>
		{/* Project > Scene: the project is the document root, scenes live
		    inside it — the picker sits at the top of the hierarchy column. */}
		<div className="hierarchy-project" data-dirty={projectDirty || undefined}>
			<span className="hierarchy-project-label">{ko("Project", "프로젝트")}</span>
			<strong>{projectName ?? (projectStartupOpen ? ko("Choose Project", "프로젝트 선택") : ko("Untitled", "제목 없음"))}</strong>
			{projectDirty && <i className="project-dirty-dot" aria-label={ko("Unsaved changes", "저장되지 않은 변경사항")} />}
		</div>
		<HierarchyPanel
			selectedId={selectedHierarchyId}
			onSelect={(id) => {
				selectHierarchy(id);
				if (id === "light") aimEditorAtKeyLight();
			}}
			characters={characters}
			showB={showB}
			motionFrames={motion?.frames ?? 0}
			ikFrames={ikFrames.length}
			ikMode={ikMode}
			ikRowId={rowIdForCharIndex(activeCharIndex)}
			waypointCount={waypoints.length}
			sceneObjects={sceneObjects}
			scenes={scenes}
			activeSceneId={activeSceneId}
			onSceneSelect={selectSceneDocument}
			onSceneCreate={createSceneDocumentFromUi}
			onSceneDuplicate={duplicateSceneDocumentFromUi}
			onSceneRename={renameSceneDocumentFromUi}
			onSceneDelete={deleteSceneDocumentFromUi}
			onAddObject={addSceneObject}
			onRenameObject={renameSceneObject}
			onDuplicateObject={(objectId) => runStudioAction("object.duplicate", objectId ? { objectId } : {})}
			onDeleteObject={deleteSceneObject}
			onFrameObject={frameSelection}
			onToggleHidden={toggleHierarchyHidden}
			propsDrop={propsDrop}
			reparent={hierarchyReparent}
			touchedIds={agentTouchedRows}
		/>
		</aside>
	);
}

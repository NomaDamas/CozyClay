import { useEffect, useState } from "react";
import { useStudioShell } from "./studio-shell-context.js";
import { ko } from "../locale.js";
import AssetPane from "../asset-pane.jsx";

const CONTENT_COLLAPSED_KEY = "cozyclay.dock.content-collapsed.v1";

function readContentCollapsed() {
	try {
		return globalThis.localStorage?.getItem(CONTENT_COLLAPSED_KEY) === "1";
	} catch {
		return false;
	}
}

function writeContentCollapsed(value) {
	try {
		globalThis.localStorage?.setItem(CONTENT_COLLAPSED_KEY, value ? "1" : "0");
	} catch (error) {
		console.warn(`[cozyclay] could not store ${CONTENT_COLLAPSED_KEY}`, error);
	}
}

// #570: the object library (Content | Log) is the dock's Assets tab. It stays
// mounted while the Animation tab is up, hidden.
export default function LibrarySlot({ active = true }) {
	const {
		setBottomTab, beginAssetDrag, shelfImageIds, shelfMeshIds,
		manageAssetStorage, setManageAssetStorage, unusedAssetIds, usedAssetIds, usageCounts,
		projectAssetGraphSignature, assetTrash, deleteUnusedAsset, undoDeletedAsset, deletingAssetId,
		projectManifest, takeVersions, loadTakeVersion, shots, selectTimelineShot, allPoses,
		spawnCharacter, addSceneObject, runStudioAction,
	} = useStudioShell();
	const [collapsed, setCollapsed] = useState(readContentCollapsed);
	const [shelfShown, setShelfShown] = useState(false);

	// App scans imported assets only while they are on screen.
	useEffect(() => {
		const visible = active && shelfShown;
		setBottomTab(visible ? "assets" : "timeline");
	}, [active, shelfShown, setBottomTab]);

	// Double-click in Content: the same payloads the drag carries, placed at
	// the origin through the named domain actions.
	function placeAssetAtOrigin(payload) {
		const origin = { x: 0, z: 0 };
		if (payload.kind === "character") spawnCharacter(payload.id, origin.x, origin.z);
		else if (payload.kind === "object") addSceneObject(payload.objectKind, origin);
		else if (payload.kind === "image" || payload.kind === "mesh") {
			runStudioAction("asset.import", { assetId: payload.assetId, placeAs: payload.kind === "mesh" ? "mesh" : "cutout", placement: origin });
		}
	}

	return (
		<section className="assets-pane studio-library" aria-label={ko("Library", "라이브러리")} data-content-collapsed={collapsed || undefined} hidden={!active}>
			<AssetPane
				onAssetGrab={beginAssetDrag}
				onAssetPlace={placeAssetAtOrigin}
				imageAssetIds={shelfImageIds}
				meshAssetIds={shelfMeshIds}
				manageStorage={manageAssetStorage}
				onManageStorageToggle={() => setManageAssetStorage((current) => !current)}
				unusedAssetIds={unusedAssetIds}
				usedAssetIds={usedAssetIds}
				usageCounts={usageCounts}
				graphSignature={projectAssetGraphSignature}
				trashCount={assetTrash.length}
				onDeleteUnusedAsset={deleteUnusedAsset}
				onUndoDelete={undoDeletedAsset}
				deletingAssetId={deletingAssetId}
				resourceManifest={projectManifest}
				shots={shots}
				takeVersions={takeVersions}
				poses={allPoses}
				onShotOpen={selectTimelineShot}
				onTakeOpen={loadTakeVersion}
				collapsed={collapsed}
				onCollapsedChange={(next) => {
					setCollapsed(next);
					writeContentCollapsed(next);
				}}
				onShelfVisibleChange={setShelfShown}
			/>
		</section>
	);
}

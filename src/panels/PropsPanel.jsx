import Foldout from "./Foldout.jsx";
import { ko } from "../locale.js";
import AddObjectMenu from "../object-catalog.jsx";
import { ASSET_IMAGE_TYPES } from "../scene-assets.js";
import { sceneObjectNameDisplayKo, sceneRendererLabelKo } from "../app-stage.jsx";

export default function PropsPanel({
	selectedHierarchyId, inspectorDrop, addSceneObject, cutoutInputRef, meshInputRef, importCutout,
	importMesh, sceneObjects, selectHierarchy,
}) {
	return (
<Foldout hidden={selectedHierarchyId !== "props"} title={ko("Props", "소품")}>
					<div className="props-drop v2-details-props" data-drop={inspectorDrop.over ? "over" : "target"} {...inspectorDrop.handlers}>
					<p className="inspector-hint v2-details-hint">{ko("Everything you add to the set lives here. Pick one to edit it, or click it in the shot view. Drop a picture anywhere here — or on the shot view — to stand it up as a cutout. You can also drop a .glb, .obj or .fbx to import a 3D object.", "세트에 추가한 모든 소품이 여기에 모입니다. 편집하려면 하나를 고르거나 샷 뷰에서 클릭하세요. 사진을 이 영역이나 샷 뷰에 끌어다 놓으면 컷아웃으로 세워집니다. .glb, .obj 또는 .fbx 파일을 놓으면 3D 오브젝트로 가져옵니다.")}</p>
					<AddObjectMenu onAdd={addSceneObject} label={ko("Add object to the set", "세트에 오브젝트 추가")} />
					<button
						type="button"
						className="btn ghost full"
						onClick={() => cutoutInputRef.current?.click()}
						title={ko("A photo of the real thing, standing in the set as a card", "실제 사진을 판때기로 세워 세트에 배치합니다")}
					>
						{ko("Import image as cutout", "이미지를 컷아웃으로 가져오기")}
					</button>
					<button
						type="button"
						className="btn ghost full"
						onClick={() => meshInputRef.current?.click()}
						title={ko("A GLB, OBJ or FBX model standing in the set", "GLB, OBJ 또는 FBX 모델을 세트에 배치합니다")}
					>
						{ko("Import 3D object", "3D 오브젝트 가져오기")}
					</button>
					<input
						ref={cutoutInputRef}
						type="file"
						hidden
						accept={ASSET_IMAGE_TYPES.join(",")}
						onChange={(event) => {
							const [file] = event.target.files ?? [];
							// Cleared before the await: picking the same file twice in a
							// row has to fire change twice, and it will not if the input
							// still holds it.
							event.target.value = "";
							importCutout(file);
						}}
					/>
					<input
						ref={meshInputRef}
						type="file"
						hidden
						accept=".glb,.obj,.fbx,model/gltf-binary,model/obj,model/fbx"
						onChange={(event) => {
							const [file] = event.target.files ?? [];
							event.target.value = "";
							importMesh(file);
						}}
					/>
						<div className="inspector-list compact">
							{sceneObjects.map((object) => (
								<button
									type="button"
									key={object.id}
									onClick={() => selectHierarchy(`object:${object.id}`)}
								>
									<span>{sceneObjectNameDisplayKo(object.name)}</span>
								<small>{sceneRendererLabelKo(object.renderer)}</small>
								</button>
							))}
						</div>
					</div>
					</Foldout>
	);
}

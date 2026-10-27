// Chapter 3 · Stage: the Outliner rows, select, move, add, undo, save.
import { chapterCard, clear, spot, spots, t } from "./steps.mjs";

const row = (id) => `[data-node-id="${id}"] > button.hierarchy-row`;

export default {
	id: "stage",
	title: t("3 · 무대", "3 · Stage"),
	steps: [
		chapterCard("3.0", t("3 · 무대", "3 · Stage"), t("선택, 이동, 추가, 되돌리기, 저장", "Select, move, add, undo, save")),
		spot("3.1", row("shot"), t("장면 01", "SCENE 01"), t("장면의 루트", "The scene root"), { hold: 3000, caption: t("아웃라이너의 맨 위는 장면입니다.", "The top row is the scene.") }),
		spot("3.2", row("camera"), t("카메라", "Camera"), t("샷 카메라", "The shot camera"), { hold: 3000, caption: t("카메라는 샷을 찍는 카메라입니다.", "Camera is the shot camera.") }),
		spot("3.3", row("light"), t("조명", "Light"), t("키 라이트", "The key light"), { hold: 3000, caption: t("조명은 키 라이트입니다.", "Light is the key light.") }),
		spot("3.4", row("characterA"), t("캐릭터 1", "Character 1"), t("출연자. 리그 폴더에 몸 부위가 있음", "The cast; its Rig folder holds the body parts"), {
			caption: t("캐릭터 1은 출연자입니다. 아래 리그 폴더에 몸 부위 그룹이 있습니다.", "Character 1 is the cast. Its Rig folder holds the body part groups."),
		}),
		...spots("3.5", [row("environment"), row("props")], t("환경 / 소품", "Environment / Props"), t("세트와 추가한 오브젝트의 폴더", "Folders for the set and for added objects"), {
			caption: t("환경은 세트, 소품은 추가한 오브젝트가 들어가는 폴더입니다. 새 프로젝트에서는 비어 있습니다.", "Environment is the set, Props holds objects you add. Both are empty in a new project."),
		}),
		clear("3.6a"),
		{
			id: "3.6",
			narration: t("캐릭터를 누르면 오른쪽 디테일에 속성이 나오고 장면에 기즈모가 뜹니다. 변환 섹션을 펼치면 정확한 값을 적을 수 있습니다.", "Click the character: Details on the right shows its properties and a gizmo appears. Open Transform for exact values."),
			click: row("characterA"),
			until: "[data-testid=\"details-selection\"]",
		},
		spot("3.6b", "section.inspector-pane", t("디테일", "Details"), t("선택한 항목의 속성: 변환, 리그, 포즈", "Properties of the selection: Transform, Rig, Pose")),
		spot("3.7", "[data-fid=\"tool_move\"]", t("이동 (W)", "Move (W)"), t("바닥 핸들을 끌어 옮기기", "Drag the floor handle"), {
			caption: t("이동 도구가 기본입니다. 바닥의 네모 핸들을 끌면 평면 위에서 움직이고, 화살표는 한 축으로만 움직입니다.", "Move is the default tool. Drag the square floor handle to slide on the ground, or an arrow for one axis."),
		}),
		clear("3.7b"),
		{ id: "3.7c", drag: { from: { js: "window.__characterGizmoHandles?.().find((handle) => handle.axis === 'plane:xz')" }, to: { dx: -120, dy: 45 } } },
		{ id: "3.8", narration: t("E는 회전입니다. 고리를 끌어 돌립니다.", "E is Rotate. Drag a ring to turn it."), key: "E" },
		spot("3.8b", "[data-fid=\"tool_rotate\"]", t("회전 (E)", "Rotate (E)"), t("회전 기즈모", "Rotate gizmo"), { hold: 3000 }),
		{ id: "3.9", narration: t("R은 크기입니다. W로 이동으로 돌아옵니다.", "R is Scale. W returns to Move."), key: "R" },
		spot("3.9b", "[data-fid=\"tool_scale\"]", t("크기 (R)", "Scale (R)"), t("크기 기즈모", "Scale gizmo"), { hold: 3000 }),
		{ id: "3.9c", key: "W" },
		spot("3.10", "[data-testid=\"snap-toggle\"]", t("스냅 5cm · 5°", "Snap 5cm · 5°"), t("격자 스냅. 드래그 중 Ctrl로 반전", "Grid snapping; hold Ctrl while dragging to invert"), {
			hold: 3000,
			caption: t("격자 스냅이 켜져 있어 5cm, 5° 단위로 움직입니다. 끄거나 드래그 중 Ctrl을 누르면 자유롭게 움직입니다.", "Snapping is on, so moves step by 5 cm and 5°. Turn it off, or hold Ctrl while dragging, for free movement."),
		}),
		clear("3.11a"),
		{ id: "3.11", narration: t("+로 큐브 같은 기본 도형, 조명, 두 번째 캐릭터나 카메라를 추가합니다.", "+ adds primitives such as a cube, lights, and a second character or camera."), click: "[data-testid=\"viewport-add\"]" },
		spot("3.11b", ".add-object-menu", t("추가", "Add"), t("기본 도형, 조명, 효과, 장면(캐릭터·카메라)", "Primitives, Lights, Effects, Scene (Character, Camera)")),
		{ id: "3.12", narration: t("큐브가 소품 폴더에 생기고 선택됩니다. 같은 기즈모로 옮깁니다.", "The cube lands in Props and is selected. Move it with the same gizmo."), click: ".add-object-item:has(.add-object-swatch.cube)" },
		spot("3.12b", row("props"), t("소품", "Props"), t("추가한 오브젝트가 들어감", "Added objects land here")),
		{ id: "3.13", narration: t("모든 편집은 ⌘Z로 되돌립니다. 에이전트가 바꾼 것도 한 단계씩 되돌아갑니다.", "Every edit undoes with ⌘Z, including each change the agent makes."), key: "Mod+Z" },
		spot("3.13b", "[data-testid=\"menu-edit\"]", t("편집 › 되돌리기", "Edit › Undo"), t("⌘Z / ⇧⌘Z", "⌘Z, ⇧⌘Z"), { hold: 3000 }),
		{
			id: "3.14",
			narration: t("⌘S로 저장합니다. 브라우저 저장소에 남고, 시작 화면의 최근 목록에 나옵니다.", "⌘S saves. It stays in the browser store and shows up under Recent on the start screen."),
			key: "Mod+S",
			until: "[data-testid=\"project-save-status\"]:not(.status-dirty)",
		},
		spot("3.14b", "[data-testid=\"project-save-status\"]", t("저장됨", "Saved"), t("⌘S", "⌘S")),
		clear("3.14c"),
	],
};

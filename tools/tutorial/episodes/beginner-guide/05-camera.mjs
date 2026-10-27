// Chapter 5 · Camera and shots: Camera mode, lens and aspect, one shot.
import { chapterCard, clear, spot, spots, t } from "./steps.mjs";

export default {
	id: "camera",
	title: t("5 · 카메라와 샷", "5 · Camera and shots"),
	steps: [
		chapterCard("5.0", t("5 · 카메라와 샷", "5 · Camera and shots"), t("샷 하나 만들기", "Make one shot")),
		{ id: "5.1", narration: t("카메라 모드에서는 샷 카메라를 움직이고 샷을 편집합니다.", "Camera mode moves the shot camera and edits shots."), key: "3" },
		spot("5.1b", "[data-fid=\"mode_camera\"]", t("카메라 모드 (3)", "Camera mode (3)"), t("카메라 조준과 샷 편집", "Aim the camera, edit shots")),
		spot("5.2", ".vp-overlay-left", t("카메라 이동 W / 회전 E", "Move camera W / Rotate camera E"), t("같은 키, 카메라에 적용", "Same keys, applied to the camera"), {
			hold: 3000,
			caption: t("W와 E가 이제 카메라를 움직이고 돌립니다.", "W and E now move and aim the camera."),
		}),
		...spots("5.3", ["[data-testid=\"lens-value\"]", "[data-testid=\"ratio-value\"]"], t("렌즈 / 화면비", "Lens / Aspect"), t("24mm 단렌즈 또는 화각, 16:9 등", "A prime lens or field of view, 16:9 and others"), {
			caption: t("렌즈는 24mm 같은 단렌즈나 화각으로 고르고, 화면비는 16:9가 기본입니다.", "Pick a prime lens such as 24mm or a field of view; the aspect ratio defaults to 16:9."),
		}),
		spot("5.4", [".tl-track-chip.camera", "button.tl-track-add.cut"], t("카메라 컷", "Camera Cuts"), t("샷 블록이 놓이는 레인", "The lane of shot blocks"), {
			caption: t("샷은 카메라 컷 레인에 블록으로 놓입니다. 아직 없으니 +로 만듭니다.", "Shots sit on the Camera Cuts lane as blocks. None yet, so we add one with +."),
		}),
		clear("5.5a"),
		{ id: "5.5", narration: t("재생 헤드 자리에 40프레임짜리 샷 1이 생깁니다. 24fps에서 1.7초입니다.", "Shot 1 appears at the playhead, 40 frames long: 1.7 s at 24 fps."), click: "button.tl-track-add.cut", until: ".tl-shot-block" },
		spot("5.5b", ".tl-shot-block", t("Shot 1", "Shot 1"), t("재생 헤드에서 시작, 40프레임", "Starts at the playhead, 40 frames")),
		spot("5.6", ".tl-shot-edge.end", t("끝 길이 조절", "Resize end"), t("가장자리를 끌어 길이 변경", "Drag an edge to change the length"), {
			hold: 3000,
			caption: t("블록 가장자리를 끌어 길이를 바꿉니다. 블록 위 버튼으로 분할·복제·삭제합니다.", "Drag an edge to change the length. The buttons above the block split, duplicate or delete it."),
		}),
		spot("5.7", [".vp-pane.vp-shot-preview", ".dock-shot-ratios"], t("샷 카메라", "Shot Camera"), t("샷 1이 보는 화면", "What Shot 1 sees"), {
			caption: t("샷 카메라 미리보기가 샷 1의 화면을 보여 줍니다. 아래 버튼으로 16:9, 2.39, 4:3, 1:1, 9:16을 고릅니다.", "The Shot Camera preview shows Shot 1. The buttons below pick 16:9, 2.39, 4:3, 1:1 or 9:16."),
		}),
		spot("5.8", "button.dock-shot-look", t("샷 시점", "Look through"), t("샷 카메라로 보기, Esc로 복귀", "See through the shot camera, Esc returns"), {
			caption: t("샷 시점을 누르면 장면 보기가 샷 카메라가 됩니다. Esc로 돌아옵니다.", "Look through turns the Scene view into the shot camera. Esc returns."),
		}),
		clear("5.8b"),
		{ id: "5.8c", click: "button.dock-shot-look" },
		{ id: "5.8d", hold: 3000 },
		{ id: "5.8e", key: "Escape" },
		spot("5.9", "[data-fid=\"camera_key_add\"]", t("카메라 키", "Camera key"), t("프레임을 눌러 현재 프레이밍 저장", "Click a frame to store the framing"), {
			hold: 3000,
			caption: t("카메라를 움직인 뒤 이 띠의 프레임을 누르면 그 프레이밍이 키로 저장됩니다. 키가 둘 이상이면 카메라가 그 사이를 움직입니다.", "After you move the camera, click a frame on this strip to key the framing. Two or more keys make the camera move between them."),
		}),
		...spots("5.10", ["[data-lane-label=\"Rail\"]", "[data-lane-label=\"Crane\"]"], t("레일 / 크레인", "Rail / Crane"), t("돌리 속도 곡선 / 크레인 높이 곡선", "Dolly speed curve / crane height curve"), {
			caption: t("레일은 그려 둔 레일을 따라가는 돌리 속도, 크레인은 높이 곡선입니다. 샷이 생긴 뒤에 씁니다.", "Rail is the dolly speed along a drawn rail, Crane is the height curve. You use them once a shot exists."),
		}),
		clear("5.10c"),
	],
};

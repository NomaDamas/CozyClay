// Episode 1, "First video in 5 minutes": start screen to a keyframe-pack
// export, following the measured beginner path. The in-app first-success
// guide stays on screen and advances as each of its steps is done. The walk
// take is compiled in the page because the recording has no signed-in agent;
// the narration says so.
import { skeletonFor } from "../../../src/motion3/rigs/index.js";
import { castFirstCharacter } from "./cast.mjs";

const skeleton = skeletonFor("y-bot-tpose");
const rest = (bone) => skeleton.restWorldPos[skeleton.index[bone]];
const ankle = rest("LeftFoot")[1];
const WALK = {
	schema: "cozyclay.motion-spec.v1",
	fps: 24,
	frames: 240,
	keys: [{ f: 0, set: { root: [0, rest("Hips")[1] - 0.01, 0], yaw: 0, foot_l: [0.09, ankle, -0.03], foot_r: [-0.09, ankle, 0.03], fyaw_l: 0, fyaw_r: 0, armw_r: 0 } }],
	generators: [{ type: "walk", f0: 6, steps: 8, heading: [0, 0] }],
};
const GUIDE_NEXT = ".v2-first-success-guide-next";

export default [
	{
		id: "install",
		narration: {
			ko: "터미널에서 npx cozyclay를 실행하면 브라우저에 스튜디오가 열립니다.",
			en: "Run npx cozyclay in a terminal and the studio opens in your browser.",
		},
		speech: { ko: "터미널에서 엔피엑스 코지클레이를 실행하면 브라우저에 스튜디오가 열립니다.", en: "Run N P X cozyclay in a terminal and the studio opens in your browser." },
		wait: ".v2-start-screen",
	},
	{
		id: "create",
		narration: {
			ko: "\"새 프로젝트\"에 이름을 적고 \"생성\"을 누르세요. 빈 무대에서 시작합니다.",
			en: "Pick \"New project\", name it, and press \"Create\". You start from an empty stage.",
		},
		type: { into: "[data-testid=start-project-name]", text: "my_first_video" },
	},
	{ id: "create-click", click: "[data-testid=start-create]", until: ".timeline" },
	// The character rig takes about a second to load after Create.
	{ id: "rig-load", hold: 1500 },
	...castFirstCharacter("cast", {
		ko: "장면 보기의 \"추가\" 메뉴에서 Y Bot을 골라 캐릭터를 놓으세요.",
		en: "Open Add in the Scene view and pick Y Bot to place a character.",
	}),
	{
		id: "select",
		narration: { ko: "아웃라이너에서 \"캐릭터 1\"을 고르세요.", en: "Select \"Character 1\" in the Outliner." },
		click: "[data-node-id=characterA] .hierarchy-row",
	},
	{ id: "guide-select", click: GUIDE_NEXT },
	{
		id: "move",
		narration: { ko: "장면 보기에서 바닥의 핸들을 끌어 옮기세요.", en: "Drag the handle on the floor in the Scene view to place it." },
		drag: { from: { js: "window.__characterGizmoHandles?.().find((handle) => handle.axis === 'plane:xz')" }, to: { dx: -120, dy: 45 } },
	},
	{ id: "guide-move", click: GUIDE_NEXT },
	{
		id: "agent",
		narration: {
			ko: "Cmd/Ctrl+B로 에이전트 패널을 엽니다. 여기서 \"Sign in with ChatGPT\"로 로그인하면 동작을 말로 요청할 수 있어요.",
			en: "Press Cmd/Ctrl+B to open the Agent panel. Sign in here, then describe the motion you want.",
		},
		speech: { ko: "커맨드 또는 컨트롤 B로 에이전트 패널을 엽니다. 여기서 \"Sign in with ChatGPT\"로 로그인하면 동작을 말로 요청할 수 있어요.", en: "Press Command or Control B to open the Agent panel. Sign in here, then describe the motion you want." },
		key: "Mod+B",
		until: "[data-agent-card=signed-out]",
	},
	{
		id: "motion",
		narration: {
			ko: "로그인한 뒤 요청하면 테이크가 \"바디\" 레인에 올라옵니다. 여기서는 완성된 걷기 테이크를 바로 불러왔어요.",
			en: "Once you are signed in, the take lands on the Body lane. Here we load a finished walk take.",
		},
		key: "Mod+B",
	},
	// The walk starts where the "move" step left the character: the studio's
	// own character state offsets the spec's root and feet on the floor.
	{
		id: "motion-compile",
		eval: `(() => {
			const character = window.__cozyclay.characters[0], { x, z } = character;
			const spec = ${JSON.stringify(WALK)};
			const set = spec.keys[0].set;
			for (const name of ["root", "foot_l", "foot_r"]) set[name] = [set[name][0] + x, set[name][1], set[name][2] + z];
			return window.__cozyclay.runStudioAction("motion.compile", { characterId: character.id, spec });
		})()`,
	},
	{ id: "guide-ask", click: GUIDE_NEXT },
	{
		id: "play",
		narration: {
			ko: "Space를 누르면 재생되고, 타임라인을 문질러 확인할 수도 있어요. 재생 헤드가 움직이면 첫 결과입니다.",
			en: "Press Space to play, or scrub the timeline. Seeing the playhead move is your first visible result.",
		},
		key: "Space",
		// The play button gains "on" while playing; its aria-label is translated.
		until: ".tl-btn.play.on",
	},
	// The walk carries the character out of the viewport by frame ~100; pausing
	// near frame 36 keeps it in view for the shot and export steps.
	{ id: "playing", hold: 1500 },
	{ id: "pause", key: "Space" },
	{ id: "guide-complete", click: GUIDE_NEXT },
	{ id: "guide-close", click: GUIDE_NEXT },
	{
		id: "shot",
		narration: { ko: "카메라 컷 레인의 \"+\"를 누르면 짧은 샷이 추가됩니다.", en: "Press \"+\" on the Camera Cuts lane to add a short shot." },
		click: ".tl-track-add.cut",
	},
	{
		id: "export",
		narration: {
			ko: "파일, 내보내기에서 \"키프레임 팩 (zip)\"을 고르거나 Cmd/Ctrl+E를 누르세요. 첫 프레임, 마지막 프레임, 참고 클립, 프롬프트가 한 zip에 담깁니다.",
			en: "Choose File, Export, \"Keyframe pack (zip)\", or press Cmd/Ctrl+E. First frame, last frame, reference clip and prompt land in one zip.",
		},
		speech: { ko: "파일, 내보내기에서 키프레임 팩 집을 고르거나 커맨드 또는 컨트롤 E를 누르세요. 첫 프레임, 마지막 프레임, 참고 클립, 프롬프트가 한 집 파일에 담깁니다.", en: "Choose File, Export, Keyframe pack zip, or press Command or Control E. First frame, last frame, reference clip and prompt land in one zip." },
		key: "Mod+E",
	},
	// The last sentence finishes with the export toast still on screen.
	{ id: "export-toast", hold: 1000 },
];

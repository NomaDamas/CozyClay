// Episode "beginner-guide": install to the first keyframe pack, pointing at
// each feature before using it. One file per chapter under beginner-guide/,
// transcribed from the storyboard.
import install from "./beginner-guide/00-install.mjs";
import start from "./beginner-guide/01-start.mjs";
import layout from "./beginner-guide/02-layout.mjs";
import stage from "./beginner-guide/03-stage.mjs";
import motion from "./beginner-guide/04-motion.mjs";
import camera from "./beginner-guide/05-camera.mjs";
import exportChapter from "./beginner-guide/06-export.mjs";

export default {
	title: { ko: "CozyClay 초심자 가이드", en: "CozyClay beginner guide" },
	subtitle: { ko: "설치부터 첫 키프레임 팩 내보내기까지 · 7개 챕터", en: "From install to your first keyframe pack · 7 chapters" },
	firstChapter: 0,
	chapters: [install, start, layout, stage, motion, camera, exportChapter],
};

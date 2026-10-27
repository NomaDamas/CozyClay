// Chapter 0 · Install: the terminal scene with the real first-run output.
import { chapterCard, spot, t } from "./steps.mjs";

export default {
	id: "install",
	title: t("0 · 설치", "0 · Install"),
	steps: [
		{ id: "opening", card: "opening", hold: 3000 },
		chapterCard("0.0", t("0 · 설치", "0 · Install"), t("명령 한 줄", "One command")),
		{
			id: "0.1",
			narration: t("Node.js 22.19 이상과 Chrome 같은 Chromium 브라우저가 필요합니다. 설치는 명령 한 줄입니다.", "You need Node.js 22.19 or newer and a Chromium browser such as Chrome. The install is one command."),
			terminal: {},
			hold: 0,
		},
		{
			id: "0.2",
			narration: t("터미널에 npx cozyclay를 입력하고 Enter를 누르세요. 첫 실행은 패키지를 내려받느라 잠시 걸립니다.", "Type npx cozyclay and press Enter. The first run downloads the package, so it takes a moment."),
			terminal: { type: "npx cozyclay" },
			hold: 600,
		},
		{
			id: "0.3",
			narration: t("어디서 알게 됐는지 묻는 질문이 한 번 나옵니다. 답하거나 skip을 입력하세요.", "It asks once where you heard about CozyClay. Answer, or type skip."),
			terminal: { print: ["How did you hear about CozyClay? [x/hn/reddit/github/site/friend/other/skip] "], type: "skip" },
			hold: 600,
		},
		{
			id: "0.4",
			narration: t("익명 사용 통계가 켜져 있다는 안내입니다. cclay telemetry off로 언제든 끌 수 있습니다.", "Anonymous usage metrics are on. Turn them off any time with cclay telemetry off."),
			terminal: { print: ["Anonymous usage metrics are on (no prompts, project content, filenames, or account information).", "Disable anytime: cclay telemetry off"] },
			hold: 600,
		},
		{
			id: "0.5",
			narration: t("스튜디오가 http://127.0.0.1:5180/app/ 에서 실행되고 브라우저가 자동으로 열립니다. Safari와 Firefox는 지원하지 않습니다.", "The studio runs at http://127.0.0.1:5180/app/ and your browser opens it. Safari and Firefox are not supported."),
			terminal: { print: ["CozyClay is running at http://127.0.0.1:5180/app/", "Use a Chromium-based browser — Safari and Firefox are not supported."] },
			hold: 300,
		},
		spot("0.5b", { css: "#screen .line", text: "CozyClay is running at" }),
	],
};

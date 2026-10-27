#!/usr/bin/env node
// Tutorial recorder without a browser, `say` or ffmpeg: the episode schema,
// chapters, the hold rule and the srt writer (tools/tutorial/episode.mjs), the
// callout placement (overlay.mjs), the terminal sequence (terminal.mjs), the
// voice clip lookup (voice.mjs), the mux and chapter-cut argv (mux.mjs), and
// the shipped episodes.
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runInNewContext } from "node:vm";
import firstVideo from "../tools/tutorial/episodes/first-video.mjs";
import beginnerGuide from "../tools/tutorial/episodes/beginner-guide.mjs";
import stubTour from "../tools/tutorial/episodes/stub-tour.mjs";
import { ADD_CHARACTER, FIRST_CHARACTER_ROW } from "../tools/tutorial/episodes/cast.mjs";
import { DEFAULT_WPS, chapterFileName, isTarget, joinTexts, localizeTarget, normalizeEpisode, readingMs, srtTime, stepHoldMs, toSrt, validateEpisode } from "../tools/tutorial/episode.mjs";
import { bandHeightFor, chapterCutArgs, muxArgs } from "../tools/tutorial/mux.mjs";
import { calloutPlacement } from "../tools/tutorial/overlay.mjs";
import { createInput } from "../tools/tutorial/cursor.mjs";
import { terminalSequence } from "../tools/tutorial/terminal.mjs";
import { speechText, userClip } from "../tools/tutorial/voice.mjs";

let failures = 0;
const expect = (name, condition, detail = "") => {
	console.log(`${condition ? "PASS" : "FAIL"} ${name}${condition ? "" : ` — ${detail}`}`);
	if (!condition) failures += 1;
};
const narration = { en: "one two three four five", ko: "하나 둘 셋" };
const step = (extra) => ({ id: "a", narration, ...extra });
const errorsFor = (extra) => validateEpisode([step(extra)]);

const FIXTURE = [
	{ id: "open", narration, wait: ".v2-start-screen" },
	{ id: "name", narration, type: { into: "[data-testid=start-project-name]", text: "my_first_video" } },
	{ id: "create", click: "[data-testid=start-create]", until: ".timeline" },
	{ id: "move", narration, drag: { from: { js: "window.__characterGizmoHandles()[0]" }, to: { dx: -120, dy: 45 } } },
	{ id: "setup", eval: "window.__cozyclay.runStudioAction('noop', {})" },
];
const fixtureErrors = validateEpisode(FIXTURE);
expect("an episode mixing narrated and silent steps is valid", fixtureErrors.length === 0, fixtureErrors.join("; "));
const shippedErrors = validateEpisode(firstVideo);
expect("the first-video episode is valid", shippedErrors.length === 0, shippedErrors.join("; "));
const shippedMs = firstVideo.filter((item) => item.narration).reduce((total, item) => total + stepHoldMs(0, item.narration, DEFAULT_WPS), 0);
expect("the first-video narration runs 60 to 120 seconds", shippedMs >= 60000 && shippedMs <= 120000, `${shippedMs}ms`);

for (const [label, extra] of [["click", { click: "#go" }], ["click list", { click: ["#a", "#b"] }], ["type", { type: "hello" }], ["key", { key: "Mod+B" }], ["drag to selector", { drag: { from: "#a", to: "#b" } }], ["drag by offset", { drag: { from: "#a", to: { dx: 10, dy: -5 } } }], ["wait selector", { wait: ".ready" }], ["wait ms", { wait: 500 }], ["hold", { hold: 800 }], ["until", { click: "#go", until: ".done" }], ["type into", { type: { into: "#name", text: "x" } }], ["drag from js", { drag: { from: { js: "({ x: 1, y: 2 })" }, to: { dx: 1, dy: 1 } } }], ["eval", { eval: "1 + 1" }]]) {
	const errors = errorsFor(extra);
	expect(`a ${label} step is valid`, errors.length === 0, errors.join("; "));
}
expect("an empty episode is rejected", validateEpisode([]).length === 1);
expect("a step without an action is rejected", /exactly one action/.test(errorsFor({}).join()));
expect("a step with two actions is rejected", /found 2/.test(errorsFor({ click: "#a", key: "Space" }).join()));
expect("a silent first step is valid", validateEpisode([{ id: "a", hold: 1 }]).length === 0);
expect("a silent step after a narrated one is valid", validateEpisode([step({ hold: 1 }), { id: "b", hold: 1 }]).length === 0);
expect("a type into without text is rejected", /type needs/.test(errorsFor({ type: { into: "#name" } }).join()));
expect("an empty eval is rejected", /eval needs/.test(errorsFor({ eval: " " }).join()));
expect("a step missing Korean narration is rejected", /narration needs ko and en/.test(validateEpisode([{ id: "a", narration: { en: "hi" }, hold: 1 }]).join()));
expect("duplicate ids are rejected", /duplicate id/.test(validateEpisode([step({ hold: 1 }), step({ hold: 1 })]).join()));
expect("an unknown field is rejected", /unknown field speed/.test(errorsFor({ hold: 1, speed: 2 }).join()));
expect("a drag without a target is rejected", /drag needs/.test(errorsFor({ drag: { from: "#a" } }).join()));
expect("a negative hold is rejected", /hold needs/.test(errorsFor({ hold: -1 }).join()));
expect("an empty click list is rejected", /click needs/.test(errorsFor({ click: [] }).join()));

const even = { ko: 2.5, en: 2.5 };
expect("reading time is 1.2 s plus the slower language", readingMs(narration, even) === 3200, String(readingMs(narration, even)));
expect("each language reads at its own rate", readingMs(narration, { ko: 1, en: 2.5 }) === 4200, String(readingMs(narration, { ko: 1, en: 2.5 })));
expect("a video reads in its own language", readingMs(narration, { ko: 1, en: 2.5 }, "en") === 3200 && readingMs(narration, { ko: 1, en: 2.5 }, "ko") === 4200);
expect("reading speeds default to ko 1.6 and en 2.5 words per second", DEFAULT_WPS.ko === 1.6 && DEFAULT_WPS.en === 2.5);
expect("a callout reads its label and note together", readingMs(joinTexts({ ko: "아웃라이너", en: "Outliner" }, { ko: "장면 목록", en: "Every item in the scene" }), DEFAULT_WPS, "en") === 3600);
expect("without a clip a step holds for its reading time when the action is quick", stepHoldMs(300, narration, even) === 3200 && stepHoldMs(300, narration, even, null, "en") === 3200);
expect("a step holds for its action when the action is slow", stepHoldMs(4500, narration, even) === 4500 && stepHoldMs(4500, narration, even, 2) === 4500);
expect("with a clip the hold is the clip plus 0.4 s, rounded up", stepHoldMs(300, narration, even, 4.66) === 5060 && stepHoldMs(0, narration, even, 1.0001) === 1401);
expect("a clip overrides the words-per-second estimate", stepHoldMs(0, narration, { ko: 0.1, en: 0.1 }, 2) === 2400);
expect("speech overrides what the voice reads, not the caption", speechText({ narration, speech: { ko: "말" } }, "ko") === "말" && speechText({ narration, speech: { ko: "말" } }, "en") === narration.en);
expect("speech must be ko or en text", /speech\.fr/.test(errorsFor({ hold: 1, speech: { fr: "x" } }).join()) && errorsFor({ hold: 1, speech: { ko: "말" } }).length === 0);

// Voice lookup: the author's clip wins in wav, m4a, mp3, aiff order; nothing else is a clip.
const voiceDir = mkdtempSync(join(tmpdir(), "tutorial-voice-test-"));
mkdirSync(voiceDir, { recursive: true });
for (const name of ["create.ko.mp3", "create.ko.m4a", "create.en.aiff", "play.ko.txt"]) writeFileSync(join(voiceDir, name), "");
expect("a user clip is found by id and language", userClip(voiceDir, "create", "en") === join(voiceDir, "create.en.aiff"));
expect("m4a wins over mp3", userClip(voiceDir, "create", "ko") === join(voiceDir, "create.ko.m4a"));
expect("other extensions and missing steps have no clip", userClip(voiceDir, "play", "ko") === null && userClip(voiceDir, "export", "ko") === null);
rmSync(voiceDir, { recursive: true, force: true });

// Mux graph: three cues, the middle one silent.
const muxCues = [{ id: "a", startMs: 500, endMs: 3000 }, { id: "b", startMs: 3000, endMs: 5000 }, { id: "c", startMs: 5000, endMs: 9000 }];
const muxClips = new Map([["a", { path: "a.wav", audioS: 2 }], ["c", { path: "c.wav", audioS: 3.5 }]]);
const args = muxArgs({ base: "cap.mp4", output: "out.mp4", cues: muxCues, clips: muxClips, captions: ["0.png", "1.png", "2.png"], endMs: 9800, bandHeight: 130 });
const graph = args[args.indexOf("-filter_complex") + 1];
expect("inputs are the capture, a clip or silence per cue, then the captions", JSON.stringify(args.slice(4, 18)) === JSON.stringify(["-i", "cap.mp4", "-i", "a.wav", "-f", "lavfi", "-t", "2.000", "-i", "anullsrc=r=48000:cl=mono", "-i", "c.wav", "-i", "0.png"]), JSON.stringify(args.slice(4, 18)));
expect("the first clip waits for its cue and fills to the next cue", graph.includes("[1:a]aresample=48000,aformat=channel_layouts=mono,adelay=delays=500:all=1,apad=whole_dur=3.000,atrim=end=3.000[a0]"), graph);
expect("the last clip fills to the end of the video", graph.includes("apad=whole_dur=4.800,atrim=end=4.800[a2]") && graph.includes("[a0][a1][a2]concat=n=3:v=0:a=1[aout]"), graph);
expect("a caption band is added under the frame", graph.includes("[0:v]pad=iw:ih+130:0:0:color=0x111111[v]"), graph);
expect("each caption shows for its cue window", graph.includes("[v][4:v]overlay=0:H-h:enable='between(t,0.500,3.000)'[v0]") && graph.includes("[v1][6:v]overlay=0:H-h:enable='between(t,5.000,9.000)'[v2]"), graph);
expect("the output is h264 + aac, faststart, cut at the end", args.includes("[aout]") && args.includes("aac") && args.includes("libx264") && args.at(-4) === "9.800" && args.includes("+faststart"));
const silent = muxArgs({ base: "cap.mp4", output: "out.mp4", cues: muxCues, clips: new Map(), captions: ["0.png", "1.png", "2.png"], endMs: 9800, bandHeight: 130 });
expect("without clips the video has captions and no audio", !silent.includes("aac") && silent[silent.indexOf("-filter_complex") + 1].includes("[v][1:v]overlay"));
let tooLong = "";
try { muxArgs({ base: "cap.mp4", output: "out.mp4", cues: muxCues, clips: new Map([["b", { path: "b.wav", audioS: 2.5 }]]), captions: [], endMs: 9800, bandHeight: 130 }); } catch (error) { tooLong = error.message; }
expect("a clip longer than its cue stops the mux", /clip for b runs 2\.50 s, longer than its 2\.000 s cue/.test(tooLong), tooLong);
expect("the caption band is about 13% of the frame and even", bandHeightFor(1000) === 130 && bandHeightFor(1080) === 140);

expect("srt time pads every field", srtTime(3723004) === "01:02:03,004", srtTime(3723004));
expect("srt time clamps negatives to zero", srtTime(-20) === "00:00:00,000");
const cues = [{ startMs: 500, endMs: 2500, narration }, { startMs: 2500, endMs: 61000.4, narration: { en: "next", ko: "다음" } }];
const expectedEn = "1\n00:00:00,500 --> 00:00:02,500\none two three four five\n\n2\n00:00:02,500 --> 00:01:01,000\nnext\n";
expect("the srt writer numbers cues and spans each hold", toSrt(cues, "en") === expectedEn, JSON.stringify(toSrt(cues, "en")));
expect("the Korean track carries the Korean narration", toSrt(cues, "ko").includes("\n하나 둘 셋\n") && toSrt(cues, "ko").endsWith("다음\n"));

// Chapters: shape, naming, validation of the teaching actions.
expect("the stub tour is valid", validateEpisode(stubTour).length === 0, validateEpisode(stubTour).join("; "));
expect("the stub tour has five chapters", normalizeEpisode(stubTour).chapters.map((chapter) => chapter.id).join() === "intro,install,start,editor,outro");
expect("a flat episode is one unnamed chapter", JSON.stringify(normalizeEpisode([{ id: "a", hold: 1 }]).chapters.map((chapter) => [chapter.id, chapter.title])) === '[["main",null]]' && normalizeEpisode([]).chaptered === false);
expect("chapter files carry the chapter number", chapterFileName(0, "install", "ko") === "00-install.ko.mp4" && chapterFileName(12, "export", "en") === "12-export.en.mp4");
expect("chapters number from 1 unless the episode says otherwise", normalizeEpisode({ chapters: [] }).firstChapter === 1 && normalizeEpisode(beginnerGuide).firstChapter === 0);
const guideErrors = validateEpisode(beginnerGuide);
expect("the beginner guide is valid", guideErrors.length === 0, guideErrors.join("; "));
expect("the beginner guide has the storyboard's seven chapters", normalizeEpisode(beginnerGuide).chapters.map((chapter) => chapter.id).join() === "install,start,layout,stage,motion,camera,export");
const guideSteps = beginnerGuide.chapters.flatMap((chapter) => chapter.steps);
// A new project is an empty stage (#986): an episode adds a character before it first touches one.
for (const [name, episode] of [["first-video", firstVideo], ["beginner-guide", beginnerGuide], ["stub-tour", stubTour]]) {
	const steps = normalizeEpisode(episode).chapters.flatMap((chapter) => chapter.steps);
	const first = steps.findIndex((step) => JSON.stringify(step).includes(FIRST_CHARACTER_ROW) && step.menu?.then !== ADD_CHARACTER);
	const cast = steps.findIndex((step) => step.menu?.then === ADD_CHARACTER);
	expect(`${name}: a character is cast before the first step that uses one`, first === -1 || (cast !== -1 && cast < first), JSON.stringify({ first, cast }));
}
expect("the beginner guide opens and closes with cards", guideSteps[0].card === "opening" && guideSteps.at(-1).card?.chapters === true);
expect("every beginner-guide caption has both languages", guideSteps.filter((step) => step.narration).every((step) => step.narration.ko && step.narration.en) && guideSteps.filter((step) => step.narration).length >= 60, String(guideSteps.filter((step) => step.narration).length));
const pair = { ko: "가", en: "a" };
const chaptered = (steps, extra = {}) => validateEpisode({ title: pair, chapters: [{ id: "one", title: pair, steps }], ...extra });
expect("a spotlight with label and note is valid", chaptered([{ id: "s", spotlight: ".x", label: pair, note: pair, hold: 2000 }]).length === 0);
expect("a spotlight may ring a target without a callout", chaptered([{ id: "s", spotlight: ".x" }]).length === 0);
expect("a note needs a label", /spotlight needs/.test(chaptered([{ id: "s", spotlight: ".x", note: pair }]).join()));
expect("a spotlight may ring the union of targets", chaptered([{ id: "s", spotlight: [".a", { css: ".b", text: "B" }], label: pair }]).length === 0 && /click needs/.test(chaptered([{ id: "c", click: [[".a", ".b"]] }]).join()));
expect("spotlight null clears", chaptered([{ id: "s", spotlight: null }]).length === 0);
expect("label belongs to a spotlight only", /unknown field label/.test(chaptered([{ id: "s", click: ".x", label: pair }]).join()));
expect("hold times a spotlight, card or terminal, nothing else", /hold only times/.test(chaptered([{ id: "s", click: ".x", hold: 5 }]).join()) && chaptered([{ id: "t", terminal: { type: "npx cozyclay" }, hold: 5 }]).length === 0);
expect("a terminal step prints, types or both, nothing else", chaptered([{ id: "t", terminal: {} }, { id: "u", terminal: { print: ["a"], type: "skip", fresh: true } }]).length === 0 && /terminal needs/.test(chaptered([{ id: "v", terminal: { typed: "x" } }]).join()));

// Targets: CSS, CSS with text, JS, per-language maps.
expect("targets: css, css with text, js, per-language", [".a", { css: ".a", text: "A" }, { css: ".a", text: pair }, { js: "document.body" }, { ko: ".k", en: ".e" }].every((target) => isTarget(target)));
expect("not targets: empty, half a language map, an array outside a spotlight", ![" ", { ko: ".k" }, { css: "" }, [".a"]].some((target) => isTarget(target)) && isTarget([".a"], { union: true }));
expect("a per-language target resolves for the UI language", localizeTarget({ ko: "select[aria-label=\"단위\"]", en: "select[aria-label=\"Units\"]" }, "ko") === "select[aria-label=\"단위\"]" && localizeTarget({ css: ".m", text: pair }, "en").text === "a" && JSON.stringify(localizeTarget([{ ko: ".k", en: ".e" }, ".x"], "en")) === "[\".e\",\".x\"]");
expect("menu needs open and then", chaptered([{ id: "m", menu: { open: "#a", then: "#b" } }]).length === 0 && /menu needs/.test(chaptered([{ id: "m", menu: { open: "#a" } }]).join()));
expect("cards: opening, closing or a titled chapter card", chaptered([{ id: "o", card: "opening" }, { id: "c", card: "closing" }, { id: "t", card: { title: pair, subtitle: pair } }]).length === 0 && /card needs/.test(chaptered([{ id: "x", card: { subtitle: pair } }]).join()));
expect("an opening card needs the episode title", /opening card needs the episode title/.test(validateEpisode({ chapters: [{ id: "one", steps: [{ id: "o", card: "opening" }] }] }).join()));
expect("studio must be true", chaptered([{ id: "s", studio: true }]).length === 0 && /studio must be true/.test(chaptered([{ id: "s", studio: "yes" }]).join()));
expect("chapter ids are file-safe and unique", /lowercase/.test(validateEpisode({ chapters: [{ id: "Bad Id", steps: [{ id: "a", hold: 1 }] }] }).join()) && /duplicate id/.test(validateEpisode({ chapters: [{ id: "a", steps: [{ id: "x", hold: 1 }] }, { id: "a", steps: [{ id: "y", hold: 1 }] }] }).join()));
expect("step ids are unique across chapters", /duplicate id/.test(validateEpisode({ chapters: [{ id: "a", steps: [{ id: "x", hold: 1 }] }, { id: "b", steps: [{ id: "x", hold: 1 }] }] }).join()));

// Callout placement: right, left, below, above, then the roomiest side clamped.
const viewport = { width: 1600, height: 1000 };
const box = { width: 300, height: 80 };
const place = (x, y, width, height) => calloutPlacement({ x, y, width, height }, box, viewport);
expect("a callout goes right of a target with room", JSON.stringify(place(100, 400, 200, 50)) === JSON.stringify({ side: "right", x: 316, y: 385 }), JSON.stringify(place(100, 400, 200, 50)));
expect("a callout goes left when the right edge is near", JSON.stringify(place(1350, 400, 200, 50)) === JSON.stringify({ side: "left", x: 1034, y: 385 }), JSON.stringify(place(1350, 400, 200, 50)));
expect("a callout goes below a full-width target", JSON.stringify(place(20, 100, 1560, 60)) === JSON.stringify({ side: "below", x: 650, y: 176 }), JSON.stringify(place(20, 100, 1560, 60)));
expect("a callout goes above a full-width target at the bottom", JSON.stringify(place(20, 880, 1560, 60)) === JSON.stringify({ side: "above", x: 650, y: 784 }), JSON.stringify(place(20, 880, 1560, 60)));
const huge = place(0, 0, 1600, 1000);
expect("a callout for a target filling the frame is clamped inside it", huge.x >= 12 && huge.x + box.width <= 1588 && huge.y >= 12 && huge.y + box.height <= 988, JSON.stringify(huge));
expect("a callout beside a target at the top edge stays inside", place(1300, 0, 280, 20).y === 12, JSON.stringify(place(1300, 0, 280, 20)));

// Terminal: printed lines 0.6 s apart, then the typed answer at ~12 chars/s, then Enter.
const sequence = terminalSequence({ print: ["one", "two"], type: "ab" });
expect("the terminal prints each line, then types, then presses Enter", sequence.events.map((event) => event.kind + (event.text ?? "")).join() === "lineone,linetwo,chara,charb,enter", JSON.stringify(sequence.events));
expect("the terminal events are timed in order", JSON.stringify(sequence.events.map((event) => event.at)) === "[400,1000,1500,1583,2033]" && sequence.totalMs === 2033, JSON.stringify(sequence));
expect("typing alone starts right away", JSON.stringify(terminalSequence({ type: "a" }).events.map((event) => event.at)) === "[400,850]");
expect("an empty terminal step plays nothing", terminalSequence({}).events.length === 0);

// Chapter cuts and an episode without captions.
const cut = chapterCutArgs({ input: "full.mp4", output: "02-install.ko.mp4", startMs: 3400, endMs: 10900, audio: false });
expect("a chapter cut seeks to its start and runs its length", cut.join(" ").includes("-ss 3.400 -t 7.500 -i full.mp4") && cut.includes("-an") && cut.at(-1) === "02-install.ko.mp4");
expect("a voiced chapter cut keeps aac", chapterCutArgs({ input: "a", output: "b", startMs: 0, endMs: 1000, audio: true }).includes("aac"));
const bare = muxArgs({ base: "cap.mp4", output: "out.mp4", cues: [], clips: new Map(), captions: [], endMs: 3000, bandHeight: 130 });
expect("an episode without narration still gets the band and no audio", bare.includes("[v]") && !bare.includes("aac"));

// Typing into a structured target ({ css, text } or { js }) resolves the field
// through __tutorialFind, the way a click does; document.querySelector would
// coerce the object to "[object Object]" and throw.
for (const into of ["[data-testid=start-project-name]", { css: "input", text: "Name" }, { js: "document.body" }]) {
	class Field { selected = false; events = 0; select() { this.selected = true; } scrollIntoView() {} dispatchEvent() { this.events += 1; } }
	Object.defineProperty(Field.prototype, "value", { configurable: true, get() { return this.v ?? ""; }, set(text) { this.v = text; } });
	const field = new Field(), seen = [], errors = [];
	const sandbox = {
		window: { __tutorialFind: (spec) => (JSON.stringify(spec) === JSON.stringify(into) ? { el: field, rect: { x: 0, y: 0, width: 10, height: 10 } } : null), __tutorialCursor: new Proxy({}, { get: () => () => {} }) },
		document: { querySelector: (selector) => { if (typeof selector !== "string") throw new SyntaxError(`'${selector}' is not a valid selector`); return null; }, activeElement: null },
		Event: class { constructor(type) { this.type = type; } }, Object, Math, JSON,
	};
	const cdp = {
		send: async () => {},
		waitFor: async () => true,
		evaluate: async (expression) => {
			seen.push(expression);
			try { return runInNewContext(expression, sandbox); } catch (error) { errors.push(error.message); return null; }
		},
	};
	await createInput(cdp, { mac: false }).type({ into, text: "ok" });
	expect(`type() into ${JSON.stringify(into)} selects and sets the field it clicked`, errors.length === 0 && field.selected && field.value === "ok" && field.events === 1, JSON.stringify({ errors, selected: field.selected, value: field.value }));
	expect(`type() into ${JSON.stringify(into)} never hands a target to document.querySelector`, !seen.some((expression) => expression.includes("document.querySelector(")));
}

if (failures > 0) {
	console.error(`\n${failures} tutorial recorder check(s) failed`);
	process.exit(1);
}
console.log("\nAll tutorial recorder checks passed");

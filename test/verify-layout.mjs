#!/usr/bin/env node
import { readFileSync } from "node:fs";

let failures = 0;
function expect(name, condition) {
	console.log(`${condition ? "PASS" : "FAIL"} ${name}`);
	if (!condition) failures += 1;
}

// The studio source spans App.jsx and app-stage.jsx (module-level extraction); pin against both.
const app = readFileSync(new URL("../src/App.jsx", import.meta.url), "utf8")
	+ readFileSync(new URL("../src/app-stage.jsx", import.meta.url), "utf8");
const css = readFileSync(new URL("../src/styles.css", import.meta.url), "utf8");
const planview = readFileSync(new URL("../src/planview.jsx", import.meta.url), "utf8");
const timeline = readFileSync(new URL("../src/ardy/timeline.jsx", import.meta.url), "utf8");
const dualview = readFileSync(new URL("../src/dualview.jsx", import.meta.url), "utf8");
const offscreenExport = readFileSync(new URL("../src/offscreen-export.js", import.meta.url), "utf8");
const ui = readFileSync(new URL("../src/ui.jsx", import.meta.url), "utf8");

expect("workspace layout persists across reloads", app.includes("WORKSPACE_LAYOUT_KEY") && app.includes("localStorage.setItem"));
expect("sidebar width has a pointer resize path", app.includes('beginWorkspaceResize("sidebar"'));
expect("frame monitor height has a pointer resize path", app.includes('beginWorkspaceResize("timeline"'));
expect("inset view has a diagonal resize path", app.includes("beginInsetResize") && app.includes("vp-inset-resize"));
expect("inset view collapses to its tag pill", app.includes("insetCollapsed") && app.includes("vp-inset-caret") && css.includes(".vp-inset.collapsed"));
expect("collapse toggle lives inside the tag strip", !app.includes("vp-inset-collapse\"") && css.includes(".vp-inset-caret"));
expect("the tag drags the inset in both states", app.includes("onPointerDown={beginInsetDrag}"));
expect("inset collapse state persists with the workspace layout", app.includes("insetCollapsed: false") && app.includes("WORKSPACE_LAYOUT_KEY"));
expect("collapsed inset skips its render pass", dualview.includes("insetCollapsed = false") && dualview.includes("if (!insetCollapsed) draw("));
expect("resize handle hides while collapsed", app.includes("{!workspaceLayout.insetCollapsed && ("));
expect("resize grip is visible on the clay viewport", css.includes(".vp-inset-resize:before,") && css.includes("rgba(255, 252, 247, .85)"));
expect("Top-View plan zooms with the wheel over the inset", app.includes('pane.addEventListener("wheel", onWheel, { passive: false })') && app.includes("current.planZoom * Math.pow"));
expect("plan zoom persists with the workspace layout", app.includes("planZoom: 1,") && app.includes("WORKSPACE_LAYOUT_KEY"));
expect("zoom shrinks the ortho extent, not the pane", dualview.includes("planZoom = 1") && dualview.includes("PLAN_EXTENT / Math.max(0.25, planZoom)"));
expect("demand loop wakes on mount and model commit", dualview.includes("requestAnimationFrame(() => requestAnimationFrame(invalidate))") && app.includes("const frame = requestAnimationFrame(invalidate);"));
expect("double-click no longer swaps Scene and Top-View", !app.includes('setViewMode((current) => (current === "plan" ? "shot" : "plan"))'));
expect("Scene toolbar exposes shot preset, aspect, FOV, recenter, and Top-View controls", app.includes("viewport-toolbar-field shot-field") && app.includes("SHOT_ASPECT_PRESETS") && app.includes("viewport-fov-control") && app.includes("Recenter on subject") && app.includes('ko("Top", "탑")'));
expect("Scene and PlayView tools share one horizontal title bar", app.includes('className="viewport-titlebar"') && css.includes(".viewport-titlebar") && css.includes("position: static"));
expect("PlayView toolbar exposes framing readouts, playback, and recording", app.includes("editor-toolbar play-tools") && app.includes("shotOutput.label") && app.includes("toggleShotRecording"));
// Letterbox bars are editor chrome. Painting them with the scene background
// put a sheet of near-white either side of the frame the moment a narrower
// aspect was picked; they wear the editor's own tone now, and the scene draw
// is scissored to the image so the sky inside the frame is unchanged.
expect(
	"letterbox bars are painted in the editor's tone, not the sky",
	dualview.includes('export const LETTERBOX = new THREE.Color("#1e1e1e");') &&
	dualview.includes("gl.setClearColor(LETTERBOX, 1);") &&
	css.includes("--bg: #1e1e1e"),
);
expect(
	"the scene draw is scissored to the image so the bars survive it",
	dualview.includes("gl.setScissor(img.x, imgY, img.w, img.h);\n\t\t\tgl.setViewport(img.x, imgY, img.w, img.h);"),
);
expect("selected aspect reaches the shot renderer", app.includes("shotAspect={shotOutput.aspect}") && dualview.includes("shotAspect = SHOT_ASPECT") && dualview.includes("fitAspect(mainRect, shotAspect)"));
expect("video and still capture use the selected output dimensions", app.includes("width: shotOutput.width") && app.includes("width={shotOutput.width}") && app.includes("canvas.width = shotOutput.width"));
expect("double-clicking the inset body folds it", app.includes('event.target.closest?.(".vp-inset-tag")') && app.includes("insetCollapsed: !current.insetCollapsed"));
expect("the tag strip works like a foldout header", app.includes("if (!moved && ev.detail <= 1) {") && app.includes("insetToggledAtRef"));
expect("one fold per gesture, even on a double-click", app.includes("if (e.detail > 1) return;") && app.includes("ev.detail <= 1"));
expect("body double-click skips tag-started gestures", app.includes("Date.now() - insetToggledAtRef.current < 450"));
expect("workspace has a dedicated left hierarchy window", app.includes('className="panel hierarchy-left"') && app.includes('beginWorkspaceResize("hierarchy"'));
expect("inspector is always visible beside the scene", app.includes("inspector-sidebar") && !app.includes("rightPanelTab"));
expect("legacy hierarchy/inspector splitter is removed", !app.includes("hierarchy-splitter"));
expect("bottom window exposes only Animation and Assets tabs", app.includes("bottom-window-tabs") && app.includes('bottomTab === "assets"') && !app.includes("console-pane") && !app.includes('bottomTab === "console"'));
expect("ARDY status stays inline without a console history surface", app.includes("reportArdyStatus") && !app.includes("consoleLines"));
// The sidebar has no tabs: one Inspector, driven by the hierarchy selection,
// so every panel is reached by selecting the thing that owns it.
expect("the sidebar has no mode tabs left", !app.includes("sidebarTab") && !app.includes("inspector-tabs") && !css.includes(".inspector-tabs"));
expect("the legacy ARDY motion inspector card is removed", !app.includes('title={ko("ARDY motion", "ARDY 모션")}'));
expect("the camera owns the lens controls", app.includes('<Foldout hidden={!isCameraSelection} title={ko("Camera", "카메라")}>'));
expect(
	"the legacy image/video generation prompt inspector is removed",
	!app.includes('<Foldout hidden={!(isSceneSelection || isCharacterSelection)} title={ko("Prompt", "프롬프트")}>'),
);
expect(
	"the prompt does not leak onto selections that do not own it",
	!app.includes('hidden={!isCameraSelection} title={ko("Prompt"') && app.includes('<Foldout hidden={!isCameraSelection} title={ko("Camera", "카메라")}>'),
);
expect("selection routing is derived once, not repeated per foldout", app.includes("const isCharacterSelection = selectedHierarchyId ===") && app.includes("const inspectorHasContent ="));
expect("an unowned selection explains itself instead of showing a blank column", app.includes("data-inspector-empty") && css.includes(".inspector-empty"));
expect("the heavy motion pipeline starts collapsed", app.includes("function Foldout({ title, hidden, defaultOpen = true, openSignal = 0, children })") && app.includes("useState(defaultOpen)"));
expect("Prompt Block panel exposes one batch generation action", app.includes("prompt-block-generate") && app.includes("Generate all ${promptClips.length} blocks"));
expect("new sessions start without prompt blocks", app.includes("const DEFAULT_PROMPT_CLIPS = [];") && app.includes("useState(null)"));
expect("new sessions start with an empty motion prompt", app.includes('const [ardyPrompt, setArdyPrompt] = useState("");'));
expect(
	"recording captures the clean render without a frame stamp",
	app.includes("capture: applyExportFrame") &&
		!app.includes("burnInCapture") &&
		app.includes("sampleAt(playbackScene, shotAtFrame(shots, frame), frame)"),
);
expect(
	"recording uses current motion content instead of a stale timeline tail",
	app.includes("currentRecordFrameCount") &&
		app.includes("timelineContentExtent(") &&
		app.includes("endFrame: resolvedEndFrame"),
);
expect("recording uses WebCodecs with explicit timestamps and frame count", offscreenExport.includes("new VideoEncoderClass") && offscreenExport.includes("timestamp: Math.round(index * frameDurationUs)") && offscreenExport.includes("chunks.length !== range.frameCount"));
expect("recording no longer uses MediaRecorder or a wall-clock capture loop", !app.includes("MediaRecorder") && !app.includes("performance.now()") && !app.includes("captureStream"));
expect("pre-motion timeline initializes to 15 seconds", app.includes("const DEFAULT_DURATION_S = 15"));
expect("motion preview stays at native 1x speed", app.includes("const DEFAULT_PLAYBACK_SPEED = 1") && app.includes("playbackSpeed={DEFAULT_PLAYBACK_SPEED}"));
expect("timeline cadence and readout expose native preview speed", timeline.includes("fps * playbackSpeed") && timeline.includes("playbackSpeed.toFixed(2)"));
expect("legacy greeting demo migration is removed", !app.includes("GREETING_DEMO_MIGRATION_KEY") && !app.includes('id: "demo-rise"'));
expect("batch generation spans through the final block frame", app.includes("Math.max(...clips.map((clip) => clip.endFrame))") && app.includes("Math.ceil(totalFrames / TIMELINE_FPS)"));
expect("batch generation forwards all prompt clips", app.includes("promptClipsOverride: clips") && app.includes("hasPromptSchedule"));
expect("normal motion generation excludes the prompt block schedule", app.includes("promptClipsOverride = []"));
// The pin decision moved into ardy/pose-pin.js so it can be tested directly
// (test/ardy/verify-pose-pin.mjs); the call site only has to route it.
expect(
	"unedited batch blocks use one unpinned autoregressive schedule",
	app.includes("const pinPlan = planPosePin({") && app.includes("else if (hasPromptSchedule) body.segments = toArdySegments(segments)"),
);
expect(
	"the pose pin is an explicit, off-by-default choice",
	app.includes("const [ardyStartFromPose, setArdyStartFromPose] = useState(false);") &&
	app.includes("startFromPose: ardyStartFromPose") &&
	app.includes("data-ardy-start-from-pose"),
);
expect(
	"the pinned pose can be placed anywhere in the clip",
	app.includes('const POSE_PLACEMENTS = ["start", "middle", "end", "playhead"];') &&
	app.includes("poseFrame: posePlacementFrame(ardyPosePlacement, clipFrames, tlFrame)") &&
	app.includes("data-pose-placement={placement}"),
);
expect(
	"the placement names the exact frame it will pin",
	app.includes("data-pose-placement-frame"),
);
// Prompt Blocks starts collapsed and can sit below the fold, so selecting a
// block on the timeline has to open it AND bring it on screen — otherwise the
// click reads as doing nothing at all.
expect(
	"a collapsed panel can be revealed from outside the Inspector",
	app.includes("openSignal = 0") && app.includes("if (openSignal <= 0) return undefined;") && app.includes('scrollIntoView({ block: "nearest" })'),
);
expect(
	"selecting or adding a prompt block reveals the panel that edits it",
	app.includes("const revealPromptBlocks = () => setPromptBlocksReveal((n) => n + 1);") &&
	app.includes("openSignal={promptBlocksReveal}") &&
	(app.match(/revealPromptBlocks\(\);/g) ?? []).length >= 2,
);
expect(
	"a schedule conflict is reported instead of silently dropping the pose",
	app.includes("pinPlan.blockedBy === PIN_BLOCKED.SCHEDULE"),
);
expect("IK-edited blocks use the motion edit session", app.includes("const editedSegments") && app.includes("body.motionEdit = {") && app.includes("sourceMotion: motion.url"));
expect("IK regeneration inherits loaded clip duration", app.includes("motion && ikFrames.length > 0") && app.includes("motion.frames / motion.fps"));
expect("motion edits send only tracked pending joints", app.includes("ikStateRef.current.keys.get(timelineFrame)?.keys()") && app.includes("tracks:"));
expect("successful motion edits commit and clear pending IK", app.includes("setCommittedIkEdits") && app.includes("job.ikState.keys.clear()") && app.includes("job.ikState.tracked.clear()"));
expect("pending IK clears only after exact commit verification", app.includes("editCommitReport?.commit_verified !== true") && app.includes("ARDY returned motion without verified authored IK keys"));
expect("failed key verification leaves pending IK intact", app.indexOf("ARDY returned motion without verified authored IK keys") < app.indexOf("job.ikState.keys.clear()"));
expect(
	"inactive live motion and its prompt clips commit in one character update",
	app.includes("targetPromptClips =") &&
		app.includes("sessionMotion: loaded,") &&
		app.includes("promptClips: targetPromptClips"),
);
expect(
	"a deleted inactive motion target cannot clear the active editing motion",
	app.includes("if (targetCharacterId === loadedLayerCharRef.current) setMotion(null);"),
);
// Given B owns a completed motion while A becomes the editing buffer during
// decode or the B-rig wait, when completion resumes, then B keeps both its
// take and prompt schedule without installing either into A.
expect(
	"a B completion after selection changes retains B ownership through decode and rig waits",
	app.includes("const targetCharacter = charactersRef.current.find((entry) => entry.id === targetCharacterId);") && app.includes("const targetStillExists = charactersRef.current.some((entry) => entry.id === targetCharacter.id);") && app.includes("const bufferOwnsTarget = targetCharacter.id === loadedLayerCharRef.current;") && app.includes("if (bufferOwnsTarget) {") && app.includes("setPromptClips(targetPromptClips);"),
);
// Given A starts a completion and B becomes active before it settles, when
// the target-owned completion resumes, then B's editing buffer receives B's
// clip and prompts and an A failure cannot clear B's motion.
expect(
	"an active B receives its own completion after an A to B selection interleaving",
	app.includes("const targetCharacterId = args.characterId ?? liveStateRef.current.activeCharacterId;") && app.includes("const targetPromptClips = clips;") && app.includes("targetCharacterId,") && app.includes("if (targetCharacterId === loadedLayerCharRef.current) setMotion(null);"),
);
expect("individual block generation action is removed", !app.includes("Generate selected block"));
expect("Prompt Block edits stay synced with ARDY input", app.includes("changePromptClip(selectedPromptId") && app.includes("setArdyPrompt(event.target.value)"));
expect("desktop stage fills the remaining viewport", css.includes("aspect-ratio: auto") && css.includes("height: 100%"));
expect("sidebar width is bounded", css.includes("min-width: 280px") && css.includes("max-width: 50vw"));
expect("timeline height is bounded", css.includes("min-height: 110px") && css.includes("max-height: 58vh"));
expect("timeline IK text controls size to their labels", css.includes(".tl-btn.ik {") && css.includes("min-width: 48px") && css.includes("white-space: nowrap"));
// Floor-click authoring: waypoints are placed by clicking the set floor, so
// frame 0 is owned implicitly — the request prepends Subject 1's position and
// authored pins can never claim frame 0 or earlier.
expect("the active character exclusively owns the frame zero root start", app.includes("{ frame: 0, x: activeChar.x, z: activeChar.z, heading: null }") && app.includes("waypoint.frame <= 0") && !app.includes("Frame 0 is the start of the root path — it can't be removed"));
expect("root guidance sends the aligned, densified path to ARDY", app.includes("alignArdyPath(rootPath, activeChar.rot") && app.includes("body.waypoints = ardyWaypoints"));
expect(
	"a root path and a prompt schedule are sent together, judged per block",
	app.includes("if (hasPromptSchedule && !hasBlockEdits) body.segments = toArdySegments(segments);") &&
	app.includes("judgeAuthoredPath(rootPath, TIMELINE_FPS, clipFrames, { chained: hasPromptSchedule })") &&
	app.includes("PROMPT_BLOCK_MAX_FRAMES"),
);
expect(
	"ARDY bridge health recovers after the sidecar starts late",
	app.includes("const BRIDGE_RECHECK_MS = 3000;") &&
	app.includes("const refreshBridge = () => checkBridge().then") &&
	app.includes("const id = window.setInterval(refreshBridge, BRIDGE_RECHECK_MS);") &&
	app.includes("return () => {") &&
	app.includes("window.clearInterval(id);"),
);
expect(
	"disabled Prompt Block generation explains the exact missing prerequisite",
	app.includes('ko("Waiting for the ARDY bridge — it reconnects automatically"') &&
	app.includes('ko("Add a prompt block and describe its motion first"'),
);
expect("generated motion anchors frame zero at the active character", app.includes("anchorX: activeChar.x") && app.includes("anchorZ: activeChar.z") && app.includes("anchorFrame: 0"));
expect("returned playback has no CozyClay root coordinate warp", !app.includes("warpMotionRootToPath"));
expect("Top-View root path draws from Subject 1 without a duplicate marker", planview.includes("[{ x: start.x, z: start.z }, ...waypoints]") && planview.includes("waypoints.map((w, i)"));
expect(
	"Top-View characters use their real meshes without covering hex pucks",
	planview.includes("<Puck color={color} showBody={false} {...state(puckId)} />") &&
	planview.includes("listIndex === 0 ? SUBJECT_ONE_COLOR : SUBJECT_TWO_COLOR") &&
	planview.includes("stem: makes the handle read as attached"),
);
expect(
	"Top-View uses saturated role colors and readable path widths",
	planview.includes('const CAMERA_COLOR = "#007f9e"') &&
	planview.includes('const SUBJECT_ONE_COLOR = "#2457d6"') &&
	planview.includes('const RAIL_COLOR = "#7137c8"') &&
	planview.includes("lineWidth={3}") && planview.includes("lineWidth={live ? 2.5 : 3.5}"),
);
expect(
	"Top-View shows ARDY player endpoints and direction while composing a rail",
	planview.includes("function SubjectMovementGuide") &&
	planview.includes("directionTriangle") &&
	planview.includes('ko("ARDY START", "ARDY 시작")') &&
	planview.includes('ko("ARDY END", "ARDY 끝")') &&
	planview.includes("point.x.toFixed(1)") &&
	planview.includes('ko("PLAYER STILL", "플레이어 정지")') &&
	planview.includes("(railDraw || cameraRailPoints) && <SubjectMovementGuide"),
);
expect(
	"only generated ARDY motion drives the player guide",
	app.includes("subjectTrack={motion ? subjectTrack : null}") &&
	!app.includes("subjectTrackStart=") &&
	!app.includes("subjectTrackEnd="),
);
// Subject Height is world lift: floored at the deck, unbounded above. The
// control keeps its compact .cslider body — the track stays a useful 0..4
// band — while `softMax` lets the head scrub past 4 like a NumberField axis
// and the readout shows the true stored value. Both write paths (head
// scrub, viewport gizmo) agree on max(0, y).
expect(
	"Subject transforms have one inspector home with the direct tools",
	app.includes('<Foldout hidden={!isCharacterSelection} title={ko("Transform", "변환")}>') &&
	app.includes('{ axis: "X", value: activeChar.x, step: 0.05') &&
	app.includes('{ axis: "Y", value: activeChar.y ?? 0, step: 0.05') &&
	app.includes('{ axis: "Z", value: activeChar.z, step: 0.05') &&
	app.includes('label={ko("Rotation", "회전")}') &&
	app.includes('label={ko("Scale", "크기")}') &&
	app.includes('data-transform-controls'),
);
expect(
	"the character gizmo no longer caps lift at 4 m",
	app.includes("if (patch.y !== undefined) next.y = Math.max(0, patch.y);") &&
	!app.includes("clamp(patch.y, 0, 4)"),
);
expect(
	"the head scrub is floored at min with no upper clamp",
	ui.includes("onChange(Math.max(min, drag.base + (e.clientX - drag.x) * step * multiplier));"),
);
expect(
	"a soft-max readout shows the true stored value past the track",
	ui.includes("const shown = softMax ? floored : snapped;"),
);
expect("resize handles opt out on compact layouts", css.includes(".workspace-splitter,") && css.includes("display: none"));

/* ----------------------------- video capture ---------------------------- */
// Footage → takes → cast. The pins below hold the invariants that make an
// extracted take play at the right size, on the right layer, at the right
// place — each of them was a bug in the two-character prototype.
expect(
	"a character owns a Video capture foldout without a legacy ARDY card",
	app.includes('hidden={!advancedMode || !isCharacterSelection}') &&
	app.includes('title={ko("Video capture", "영상 모캡")}') &&
	!app.includes('title={ko("ARDY motion", "ARDY 모션")}'),
);
expect(
	"Advanced OFF hides the Video capture foldout",
	app.includes('localStorage?.getItem("cozyclay.advanced") === "true"'),
);
expect(
	"Advanced OFF hides the Video capture foldout",
	app.includes('hidden={!advancedMode || !isCharacterSelection}') && app.includes('localStorage?.getItem("cozyclay.advanced") === "true"'),
);
expect(
	"ingest and extraction reach the ported core modules",
	app.includes('from "./multimodel-ingest.js"') &&
	app.includes('from "./pose-extract/index.js"') &&
	app.includes("probeFootage(objectUrl") &&
	app.includes("knownFps: Number.isFinite(source.fps) ? source.fps : null"),
);
expect(
	"extraction routes to the GPU box when the bridge is up and the browser otherwise",
	app.includes("if (bridge?.ok) return extractMultiModelMotionGpu();") &&
	app.includes("return extractMultiModelMotionBrowser();") &&
	app.includes("requestBridgeExtract(") &&
	app.includes("createPoseDetector()"),
);
expect("every named ingest failure is a message in both locales", app.includes("const MULTIMODEL_REASONS = {") && app.includes('MULTIMODEL_REASONS[code]?.[isKo ? 1 : 0] ?? code'));
// THE INVARIANT: extraction divided root travel by the filmed person's
// stature, so the clip and the scale must be applied together.
expect(
	"a character's stature comes from its own take and is applied on the world transform",
	app.includes("const scale = characterScaleFor(decoded);") &&
	app.includes("clone.scale.setScalar(0.01 * scale)") &&
	app.includes("scale: entry.scale ?? 1") &&
	app.includes("scale={view.scale}"),
);
expect(
	"each extra take carries its own stature, never the active character's",
	app.includes("scale: characterScaleFor(clip, take.personScale),") &&
	app.includes("scale: take.scale,"),
);
expect(
	"the response person scale is only a fallback for an npz that stores none",
	app.includes("if (personScale === 1 && Number.isFinite(declared)) {") &&
	app.includes("personScale = characterScaleFor(null, declared);"),
);
expect(
	"stature survives the save: only the session clip is stripped from the stage",
	app.includes("characters: characters.map(({ sessionMotion, ...entry }) => entry)") &&
	app.includes("scale: characterScaleFor(decoded, item.scale ?? 1)"),
);
expect(
	"extra takes land on their OWN layer, not through the editing buffer",
	app.includes("async function deliverExtraTakes(") &&
	app.includes("takeAnchor(active, take.offsetX, take.offsetZ)") &&
	app.includes("sessionMotion: {") &&
	app.includes("!entry.sessionMotion && !entry.motionRef"),
);
expect(
	"trim composes from the per-character full-take map",
	app.includes("const motionFullRef = useRef(new Map());") &&
	app.includes("const full = motionFullRef.current.get(activeChar.id);") &&
	// The trim reads its previous edit once so pin migration (#79) and the
	// slice compose from the same segments.
	app.includes("trimMotionEdit(previous, start, end)") &&
	app.includes("const sliced = renderMotionEdit(full, segments);"),
);
expect(
	"a cut take drops its source url and clears the IK keys authored on the old frames",
	app.includes("setMotion({ ...sliced, url: null });") &&
	app.includes("ikStateRef.current.keys.clear();"),
);
expect(
	"a browser-baked take is trimmable too",
	app.indexOf("motionFullRef.current.set(activeChar.id, loaded);") > 0 &&
	(app.match(/motionFullRef\.current\.set\(/g) ?? []).length >= 4,
);
expect(
	"the timeline receives the active take and both trim handlers",
	app.includes("onMotionTrim={applyMotionTrim}") &&
	app.includes("onMotionTrimReset={resetMotionTrim}") &&
	app.includes("motion={motion ? {") &&
	app.includes("frames: motion.frames,") &&
	app.includes("segments: motionEditLayout("),
);
expect("a deleted character takes its full take with it", app.includes("motionFullRef.current.delete(charId);"));

const CSS = readFileSync(new URL("../src/styles.css", import.meta.url), "utf8");
/** The body of the LAST rule with this exact selector, so later overrides win. */
function readRule(selector) {
  const needle = selector.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const re = new RegExp(needle + "\\s*\\{([^}]*)\\}", "g");
  let last = "", m;
  while ((m = re.exec(CSS))) last = m[1];
  return last;
}

/* ---------------------------------------------------- inspector overflow --- */
// The last open section used to carry `flex: 1` — a zero basis that squeezed a
// tall section (the matte editor and its help text) down to whatever space was
// left, where the card's own `overflow: hidden` then cut it off. The scroll
// container above saw nothing to scroll, so the cut text was unreachable.

const lastCardRule = readRule(".inspector-scroll > .card.foldout.open:last-child");
expect(
  "the last inspector section may grow but never shrink below its content",
  /flex:\s*1\s+0\s+auto/.test(lastCardRule),
  lastCardRule,
);
expect(
  "the last inspector section does not clip what it should hand upward",
  /overflow:\s*visible/.test(lastCardRule),
  lastCardRule,
);
// `overflow: auto` is set in the base rule and never revoked, so assert across
// every `.inspector-scroll` block rather than only the last one.
const scrollRules = [...CSS.matchAll(/\.inspector-scroll\s*\{([^}]*)\}/g)].map((m) => m[1]);
expect(
  "the inspector scroll container still owns the scrolling",
  scrollRules.some((body) => /overflow:\s*auto/.test(body)) &&
    !scrollRules.some((body) => /overflow(-y)?:\s*(hidden|clip)/.test(body)),
  scrollRules.join(" | ").slice(0, 200),
);


if (failures) process.exit(1);
console.log("all resizable workspace checks PASS");

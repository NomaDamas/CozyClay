import { useMotion } from "./domains/motion.js";
import { useCast } from "./domains/cast.js";
import { useShots } from "./domains/shots.js";
import { useObjects } from "./domains/objects.js";
import { useScenes } from "./domains/scenes.js";
import { useStage } from "./domains/stage.js";
import StudioShell from "./shell/StudioShell.jsx";
import ViewportToolbar from "./shell/ViewportToolbar.jsx";
import { StudioShellContext } from "./shell/studio-shell-context.js";

import {
	useCallback,
	useEffect,
	useMemo,
	useRef,
	useState,
} from "react";
import {
	Canvas,
} from "@react-three/fiber";
import {
	OrthographicCamera,
	PerspectiveCamera,
} from "@react-three/drei";
import * as THREE from "three";

import { checkBridge, generate as ardyGenerate } from "./ardy/client.js";
import {
	loadMotionFromUrl,
} from "./ardy/npz.js";

import { motionUrlFromQuery } from "./ardy/motion-url.js";

import {
	applyMotionFrame,
	restorePlaybackBones,
	snapshotPlaybackBones,
} from "./ardy/playback.js";

import {
	TRAIL_EFFECTOR_JOINTS,
	jointTrailPoints,
	worldPointToClip,
} from "./motion-trail.js";

import { FlyControls, aimAt, forwardFrom } from "./controls.jsx";
import { createLiveControl, loadLiveWorkspaceId, mintLiveWorkspaceId } from "./live-control.js";
import { createFirstEditTracker, semanticEditKind } from "./semantic-edit.js";

import AgentPanel from "./workflow/AgentPanel.jsx";
import { StudioProtocolError } from "./studio-agent-protocol.js";
import { elementByPath } from "./studio-elements.js";
import {
	resolveStudioToast,
} from "./studio-actions.js";
import { createStudioAppActions } from "./commands/index.js";
import { STORYBOARD_MOTION_REFUSAL } from "./commands/view.js";

import { createStudioAppBinding } from "./studio-app-binding.js";
import { AppContext, createAppContext } from "./app-context.js";
import { clone as cloneSkeleton } from "three/examples/jsm/utils/SkeletonUtils.js";

import { PlanBoard } from "./planview.jsx";
import { resolveCharacterPlacement } from "./root-path.js";
import { autoColorHex, loadAutoColor } from "./auto-color.js";
import { DualRender, fitAspect, GIZMO_LAYER } from "./dualview.jsx";
import { GridFloor } from "./grid-floor.jsx";
import { GRID_BACKGROUND, GRID_FOG, stageBackground, readStoredGridView, writeStoredGridView } from "./grid-view.js";
import { useUiTheme } from "./theme.js";
import {
	CURVE_GRAB_RADIUS_PX,
	DRAG_RADIUS_DEFAULT,
	DRAG_RADIUS_MAX,
	DRAG_RADIUS_MIN,
	DRAG_WEIGHT_EPSILON,
	DRAW_MIN_STROKE_POINTS,
	DRAW_MIN_STROKE_PX,
	MAX_LINE_POINTS,
	MIN_LINE_POINTS,
	cameraDrifted,
	cameraToC6,
	changedFrameRange,
	curveToPoints2d,
	curvesEqual,
	sliceCurveToRange,
	dragCurve,
	dragWeight,
	isCurveEndPinned,
	isCurvePointOnScreen,
	nearestCurvePoint,
	projectTrailCurve,
	projectPointC6,
	reprojectCurveWorld,
	drawStrokeEdit,
	unprojectDeltaC6,
	pinsFrameRange,
	upsertPin,
	validateLineEdit,
} from "./line-edit.js";

import { Room, StageLights } from "./room.jsx";
import {
	createShotAuthoringDocument,
} from "./shot-authoring.js";
import {
	buildFollowTrack,
	buildRail,
	buildRailFollowTrack,
	simplifyStroke,
} from "./camera-follow.js";
import {
	createCameraBlock,
} from "./camera-block.js";
import {
	RAIL_SCHEDULE_LEGACY,
	RAIL_SCHEDULE_RANGE,
	resolveRailSchedule,
} from "./camera-rail-schedule.js";
import { ObjectCarrier, SetProps } from "./props.jsx";
import {
	CUTOUT_KIND,
	MESH_KIND,
	isEffectivelyHidden,
	objectSize,
	sceneObjectIdFromHierarchy,
} from "./scene-objects.js";

import {
	assetGraphSignature,
	assetUsageCounts,
	deleteAsset,
	deleteAssetWithGraphGuard,
	getAsset,
	imageFilesFromClipboard,
	isImageAssetId,
	isMeshAssetId,
	isSupportedMeshType,
	listAssetIds,
	openAssetDb,
	putAsset,
	unreachableAssetIds,
} from "./scene-assets.js";
import { derivedAssetIds, sourceAssetIds } from "./asset-shelf.js";
import { assetRecord, evictAssetTexture, rememberAsset } from "./scene-asset-cache.js";
import { evictMeshScene } from "./scene-mesh-cache.js";
import { subscribeToSceneDocuments, subscribeToScenePlayback } from "./workflow/scene-asset-sync.js";
import {
	decodeMask,
} from "./matte.js";
import { createMatteEditor } from "./matte-editor.js";
import {
	SCENES_STORAGE_KEY,
	SCENES_VERSION,
	activeSceneIndex,
	createSceneStage,
	isProxyFigure,
	normalizeReferenceImage,
} from "./scenes.js";
import {
	hasFileSystemAccess,
	loadProjectSession,
	loadStoredProjectHandle,
	queryHandlePermission,
	requestHandlePermission,
	readProjectDocument,
	WORKFLOW_STORAGE_KEY,
} from "./project.js";
import ProjectBrowser, { ProjectNameDialog } from "./project-browser.jsx";
import FirstSuccessGuide from "./first-success-guide.jsx";
import UseCaseQuestion from "./use-case-question.jsx";
import { CameraTutorial } from "./camera-tutorial.jsx";
import { createTutorialAnalytics } from "./tutorial-analytics.js";
import { cameraTutorialSuppressed, createFirstShotHandoff, rememberCameraTutorialTerminal } from "./first-shot-handoff.js";
import ObjectGizmo from "./object-gizmo.jsx";

import {
	SaveBlockedDialog,
} from "./resource-status.jsx";

import ResultModal from "./result-modal.jsx";
import {
	I2vMotionModal,
} from "./i2v-motion-studio.jsx";

import { demoSeedGate, hasLineEditCapability, motionReadiness } from "./motion-readiness.js";

import { PWA_UPDATE_EVENT } from "./pwa.js";
import {
	createObjectPath,
	objectTransformAt,
	pathMetrics,
	strokeToPathPoints,
	MAX_PATH_POINTS,
} from "./object-path.js";
import { carriedPointAt, sceneObjectsAt } from "./object-travel.js";
import {
	analyticsActive,
	exportFailureCode,
	recordSemanticEdit,
	recordUseCase,
	shouldAskUseCase,
	startExportAttempt,
	track,
	trackActivation,
	trackFeature,
} from "./analytics.js";
import { ko, isKo } from "./locale.js";
import { characterCapabilities, kindRefusal } from "./character-kind.js";
import {
	isPlaygroundEmbed,
} from "./playground.js";
import { STARTER_SCENES } from "./starter-scenes.js";
import { PART_COLOURS } from "./part-colours.js";
import {
	DEFAULT_POSE,
	applyHipsOffset,
	applyPose,
} from "./poses.js";
import {
	IkHandles,
	PoseHandles,
	RangePinMarker,
	warmPoseThumbnails,
} from "./posestudio.jsx";

import {
	createIkState,
	ikEvaluate,
	ikKeyframes,
	ikSeedTargets,
	resolveIkRig,
	shareContactMeasurements,
} from "./ardy/ik.js";
import {
	buildCollisionCapsules,
	detectPenetrations,
	supportsCollisionCleanup,
} from "./ardy/fix-collisions.js";
import {
	blockerSummary,
} from "./ardy/collision-blockers.js";
import { computeCenterOfMass, markerPositions } from "./ardy/auto-physics.js";
import {
	physicsKeyStamp,
} from "./ardy/physics-review.js";

import {
	Toast,
} from "./ui.jsx";
import { useRenderActivity } from "./use-render-activity.js";

import {
	CUSTOM_MOVE,
	IMAGE_MODELS,
	SUBJECT_HEIGHT_M,
	composePrompt,
	deriveShot,
	fovToFocalMm,
} from "./shot.js";
import { captureFraming, classifyMove, moveSequenceSlate, moveSequencePhrase } from "./camera-move.js";
import { sampleAt } from "./sample-at.js";
import { exportOffscreenVideo } from "./offscreen-export.js";
import { parseRigNodeId } from "./hierarchy-model.js";
import { timelineContentExtent } from "./timeline-extent.js";
import {
	GUIDE_LABELS,
	guideGeometry,
	nextGuideMode,
	readStoredGuideMode,
	writeStoredGuideMode,
} from "./shot-guides.js";
import { shotCaptureMeta } from "./shot-meta.js";
import { buildShotPrompt } from "./shot-prompt.js";
import { keyframePackEntries, keyframePackName } from "./keyframe-pack.js";
import { buildZip } from "./zip-store.js";
import { composeStoryboard } from "./storyboard.js";
import { DEPTH_RANGE_M, depthRangeFromFrames, passFileName, renderPass } from "./render-passes.js";

import { motionApiOrigin, I2V_MOTION_SHOT_ASPECT } from "./i2v-motion-client.js";
import { serializeOtio } from "./otio.js";
import "./shell/mode.css";
import { readPoseFadeOpacity, suspendPoseFade, writePoseFadeOpacity } from "./pose-fade.js";
import {
	shotAtFrame,
	shotIndexAtFrame,
} from "./cuts.js";
import {
	ASSET_DELETE_UNDO_MS,
	BRIDGE_RECHECK_MS,
	CameraGlide,
	CameraRailScenePreview,
	CaptureRig,
	Character,
	ContextLossGuard,
	CraneHandles,
	DEFAULT_CAMERA_POSITION,
	DEFAULT_DURATION_S,
	DEMO_MOTION_PROMPT,
	DEMO_MOTION_URL,
	EditorCamSeed,
	FollowCamRig,
	GIZMO_HOTKEYS,
	KeyLightPuck,
	LINE_CURVE_MARKER_STRIDE,
	LINE_CURVE_REFUSALS,
	LINE_EDIT_DEFAULT_TRACK,
	LINE_EDIT_REFUSALS,
	LINE_PREVIEW_DEBOUNCE_MS,
	MCP_CAPTURE_H,
	MCP_CAPTURE_W,
	MotionTrails,
	MoveRig,
	OBJECT_DELETE_UNDO_MS,
	ObjectPathHandles,
	RIG_HIERARCHY_FOCUS,
	RenderLoopController,
	SHOT_ASPECT_PRESETS,
	ShotCameraGhost,
	ShotLookApplier,
	ShotPathPreview,
	ShotRig,
	TIMELINE_FPS,
	ViewportLayoutInvalidator,
	WORKSPACE_LAYOUT_KEY,
	attachFrameMatrix,
	buildPromptSchedule,
	captureMcpFrame,
	characterModelUrl,
	defaultCharacterTint,
	ikTracksInRange,
	loadSceneStartup,
	loadWorkspaceLayout,
	moveSequenceSlateKo,
	preserveTracksSummary,
	slateLineKo,
	useStageFilesDrop,
} from "./app-stage.jsx";

/**
 * Composition guides stretched over whichever DOM rect currently shows the
 * shot frame. The SVG uses a 0..100 space with preserveAspectRatio="none":
 * proportional guides (thirds, golden, safe) stay correct under any aspect,
 * and non-scaling strokes keep the ink one pixel wide. Overlay only — it
 * never reaches the WebGL scene or exported pixels.
 */
function ShotGuideOverlay({ mode, aspect, className = "" }) {
	const geometry = guideGeometry(mode);
	if (geometry.lines.length === 0 && geometry.rects.length === 0) return null;
	// The viewBox carries the shot aspect and "meet" centers it, so the SVG
	// letterboxes itself exactly like the framed render underneath — the same
	// fit rule, computed by the same engine, with no JS measurement.
	const spanX = 100 * (aspect || 1);
	const sx = (value) => (value / 100) * spanX;
	return (
		<div className={"shot-guides " + className} aria-hidden="true" data-guide-mode={mode}>
			<svg viewBox={`0 0 ${spanX} 100`} preserveAspectRatio="xMidYMid meet">
				{geometry.lines.map((l, index) => (
					<line key={index} x1={sx(l.x1)} y1={l.y1} x2={sx(l.x2)} y2={l.y2} vectorEffect="non-scaling-stroke" />
				))}
				{geometry.rects.map((r) => (
					<rect key={r.kind} x={sx(r.x)} y={r.y} width={sx(r.width)} height={r.height} className={"guide-" + r.kind} vectorEffect="non-scaling-stroke" />
				))}
			</svg>
		</div>
	);
}

// Below this the mean landmark visibility is too low to claim the fit measured
// the photograph rather than guessed at it. Same number the fit diagnostics are
// scaled on (0..1 visibility), so it reads as "less than half seen".
const PHOTO_POSE_LOW_CONFIDENCE = 0.5;
const CHARACTER_POSITION_BOUNDS = elementByPath("character.position").gizmo;
const CHARACTER_SCALE_BOUNDS = elementByPath("character.scale");

// How long an agent receipt keeps its targets lit in the hierarchy. Long
// enough to find the row after reading the chat line, short enough that it is
// never mistaken for selection. Paired with --agent-touch in styles.css, which
// fades the same highlight out over the same two seconds.
const AGENT_RECEIPT_HIGHLIGHT_MS = 2000;

// The storyboard contact sheet is drawn on a bare 2d canvas, which has no
// stylesheet to inherit from: it gets the studio's own type stack explicitly
// so the sheet reads like the app it came out of.
const STORYBOARD_FONT = '12px Inter, "Pretendard", "Noto Sans KR", system-ui, -apple-system, "Segoe UI", Helvetica, Arial, sans-serif';
// One unwrapped caption line at 12px inside a 480px cell holds about 64
// characters before it runs into the next column.
const STORYBOARD_CAPTION_CHARS = 64;

/** Cut a caption to what one unwrapped cell line holds. */
function storyboardLine(text) {
	return text.length > STORYBOARD_CAPTION_CHARS ? `${text.slice(0, STORYBOARD_CAPTION_CHARS - 1)}\u2026` : text;
}

/** Fold a labelled shot prompt into the one line a board cell can hold. */
function storyboardCaption(prompt) {
	return storyboardLine(prompt
		.split("\n")
		.filter((line) => line.startsWith("SHOT:") || line.startsWith("LENS:"))
		.map((line) => line.slice(line.indexOf(":") + 1).trim())
		.join(" · "));
}

// cskel27 joint names are rig vocabulary — "RightForeArm" means nothing to
// someone holding a photograph. Every joint collapses into one of six groups a
// viewer can check against their own picture, ordered so the sentence always
// reads limbs before body.
const RELEASED_BONE_LABELS = [
	["LeftArm", "left arm", "왼팔"],
	["RightArm", "right arm", "오른팔"],
	["LeftLeg", "left leg", "왼다리"],
	["RightLeg", "right leg", "오른다리"],
	["Torso", "torso", "몸통"],
	["Head", "head", "머리"],
];

function releasedBoneGroup(name) {
	const side = name.startsWith("Left") ? "Left" : name.startsWith("Right") ? "Right" : "";
	const part = side ? name.slice(side.length) : name;
	if (part === "UpLeg" || part === "Leg" || part === "Foot" || part === "ToeBase") return side + "Leg";
	if (part === "Shoulder" || part === "Arm" || part === "ForeArm" || part === "Hand" || part === "HandEnd") return side + "Arm";
	if (part === "Head" || part === "Neck") return "Head";
	// Hips and the Spine chain are the only names left, and they are the torso.
	return "Torso";
}

// 이/가 is fixed by the final syllable of the word it follows — 왼팔이 but
// 왼다리가 — so it cannot be baked into the sentence template.
function koSubjectParticle(word) {
	const syllable = word.charCodeAt(word.length - 1) - 0xac00;
	return syllable >= 0 && syllable < 11172 && syllable % 28 !== 0 ? "이" : "가";
}

/**
 * Pose ONE cast member's rig at an absolute timeline frame: its own clip first,
 * then its own IK correction layer on top. This is the single description of
 * "where is this character at frame N" — the viewport effect, the offscreen
 * recorder and the whole-clip collision pass all go through it, so a body used
 * as a collision blocker stands exactly where the render would draw it.
 *
 * Pure in the sense that matters here: it takes the rig, the clip and the layer
 * state and writes bones. No React, no refs, no knowledge of who is active — a
 * caller that wants the active character's LIVE editing state passes it, and
 * one that wants a stored layer passes that.
 *
 * A missing rig, a member with no clip and a layer with no keys are all
 * no-ops rather than errors: characters without a take keep their pose.
 */
function poseMemberAtFrame(rig, clip, ikState, frame, blendFrames = 0, pose = null) {
	if (!rig) return;
	if (clip) {
		const sampled = sampleAt({ frameCount: clip.frames, motion: clip }, null, frame);
		applyMotionFrame(rig, clip, sampled.motionFrame);
	} else if (pose) {
		applyPose(rig, pose);
		applyHipsOffset(rig, pose.rootY ?? 0);
	}
	if (ikState && ikState.keys.size > 0 && ikState.chains && ikState.rig === rig) {
		ikEvaluate(ikState.chains, ikState, frame, ikState.fkJoints, clip ? blendFrames : 0);
	}
}

/** The longest edge a stored reference picture may have. A character sheet is
 * read as a LOOK, not as texture detail, and the whole thing has to survive
 * inside the project document — 1024 px keeps a face legible at a fraction of
 * the bytes a phone photo would cost. */

/**
 * Read one picked file into the data URL a reference slot stores: FileReader
 * for the bytes (so the result survives save/load exactly like an Upload node's
 * image), then a canvas pass to cap the long side. The source type is kept, so
 * a JPEG photo stays a JPEG instead of being re-encoded into a much larger PNG.
 */

/** An http(s) asset source as the data URL the import path takes. */
async function fetchImportSource(url) {
	const response = await fetch(url);
	if (!response.ok) throw new Error(`HTTP ${response.status}`);
	const blob = await response.blob();
	return new Promise((resolve, reject) => {
		const reader = new FileReader();
		reader.onerror = () => reject(reader.error ?? new Error("could not read the download"));
		reader.onload = () => resolve(String(reader.result));
		reader.readAsDataURL(blob);
	});
}

export default function App() {
	// App retains the lifetime and ownership of these cells; the facade only
	// centralizes access for current and long-lived callbacks.
	const [appContext] = useState(() => createAppContext({
		// These cells initialize later in this render. Readers run only after
		// initialization and follow the same refs across subsequent renders.
		motion: { get current() { return bufferRef.current.motion; } },
		getBus: () => studioBindingRef.current.bus,
		notify: (...args) => setToast(...args),
	}));
	const embedMode = ["scene", "playview"].includes(new URLSearchParams(globalThis.location?.search || "").get("embed"));
	// The landing page's try-it iframe: full studio interaction on a preset
	// scene with the project chrome hidden and saving off (see playground.js).
	const playgroundMode = isPlaygroundEmbed(globalThis.location?.search);
	const [playgroundHint, setPlaygroundHint] = useState(null);
	const playgroundExportRef = useRef(null);
	// The camera tutorial (#206): the landing page's seven steps, run against
	// the real studio instead of the playground iframe. It opens from
	// /app/?tutorial=camera or from Settings ▾, and it is not offered inside an
	// embed.

	// Both doors go through startCameraTutorial (#209), which puts the studio in
	// the state the landing page teaches these steps in — the city-block starter
	// scene with the walk take on its character — so Shot / Rail / Play always
	// have something to frame. That function is declared with the project
	// actions further down; the listeners here reach it through a ref so they
	// always call the current render's closure (the confirm reads projectDirty).
	const [cameraTutorialEntry] = useState(() => {
		const params = new URLSearchParams(globalThis.location?.search || "");
		const query = params.get("tutorial") === "camera";
		let firstRun = false;
		try {
			firstRun = !query && !params.get("scene") && !cameraTutorialSuppressed()
				&& !loadProjectSession()?.name && !globalThis.localStorage?.getItem(SCENES_STORAGE_KEY);
		} catch { firstRun = false; }
		return !embedMode && !playgroundMode && !cameraTutorialSuppressed() && (query ? "query" : firstRun ? "first-run" : null);
	});
	const cameraTutorialQuery = Boolean(cameraTutorialEntry);
	const [cameraTutorial, setCameraTutorial] = useState(false);
	const cameraTutorialAnalytics = useRef(null);
	const [cameraTutorialAttempt, setCameraTutorialAttempt] = useState(0);
	const [cameraTutorialHandoff, setCameraTutorialHandoff] = useState(null);
	const cameraTutorialCompletedRef = useRef(false);
	const exportMenuTriggerRef = useRef(null);
	const exportShotIdRef = useRef(null);
	// The step the tutorial is on, published on the .app root so styles.css can
	// spotlight the one control that step needs (#211).
	const [cameraTutorialStep, setCameraTutorialStep] = useState(null);
	const startCameraTutorialRef = useRef(null);
	const cameraTutorialStarted = useRef(false);
	// A tutorial restart never reloads the starter over the user's edits.
	const tutorialStarterRef = useRef(false);
	const tutorialLoadingRef = useRef(false);
	const tutorialProjectEpochRef = useRef(0);
	const tutorialSeedEpochRef = useRef(null);
	// Armed once the starter is applied, consumed by the seed effect next to the
	// hosted-demo seed as soon as the new character's rig exists.
	const [tutorialSeedPending, setTutorialSeedPending] = useState(false);
	useEffect(() => {
		if (!cameraTutorialQuery || cameraTutorialStarted.current) return;
		cameraTutorialStarted.current = true;
		void startCameraTutorialRef.current?.({ source: cameraTutorialEntry });
	}, [cameraTutorialQuery, cameraTutorialEntry]);
	useEffect(() => {
		const onTutorial = (event) => {
			if (event.detail?.open === false) {
				setCameraTutorial(false);
				cameraTutorialAnalytics.current?.dismiss();
				rememberCameraTutorialTerminal(cameraTutorialCompletedRef.current ? "completed" : "dismissed");
				tutorialProjectEpochRef.current += 1;
				setTutorialSeedPending(false);
				setCameraTutorialHandoff(null);
				return;
			}
			void startCameraTutorialRef.current?.({ source: event.detail?.source ?? "settings" });
		};
		window.addEventListener("cozyclay:camera-tutorial", onTutorial);
		return () => window.removeEventListener("cozyclay:camera-tutorial", onTutorial);
	}, []);
	useEffect(() => {
		if (cameraTutorial) trackFeature("camera_tutorial");
	}, [cameraTutorial]);
	useEffect(() => {
		if (!embedMode) return undefined;
		// The Workflow page's Scene node embeds the studio as its preview, so the
		// embed enters the player through enterPreview(). The states are seeded
		// from embedMode as well, so the first painted frame is already the shot
		// view rather than a flash of editor chrome.
		enterPreview();
		const capture = () => {
			try {
				const live = appContext.live.state;
				const dataUrl = live.captureFramingPng(live.captureCurrentFraming());
				if (!dataUrl) throw new Error("The shot renderer is not ready");
				const output = SHOT_ASPECT_PRESETS[live.stage.shotAspect] ?? SHOT_ASPECT_PRESETS["16:9"];
				const meta = live.captureShotMeta(live.timeline.currentFrame);
				// The identity sheets and the environment reference ride with the
				// frame (#167): the PNG says where the bodies stand, these say who
				// they are and what the location is made of.
				const references = live.captureShotReferences();
				window.parent.postMessage({ type: "cozyclay:capture-framing-result", dataUrl, width: output.width, height: output.height, meta, references }, "*");
			} catch (error) { window.parent.postMessage({ type: "cozyclay:capture-framing-result", error: error.message }, "*"); }
		};
		// The Workflow page's Scene node asks the embed for a whole reference
		// pack (#165). The zip is transferred rather than copied: a pack carries a
		// clip, and structured-cloning tens of megabytes across the frame boundary
		// is the one part of this that would actually be felt.
		const exportPack = async (shotId, ownedByWorkflow) => {
			const attempt = ownedByWorkflow ? null : startExportAttempt({ export_kind: "keyframe_pack", format: "zip", surface: "embed" });
			try {
				const live = appContext.live.state;
				const index = live.shotIndexForPack(shotId ?? null);
				const pack = await live.buildShotKeyframePack(live.shots[index], index);
				const bytes = pack.bytes.buffer.slice(pack.bytes.byteOffset, pack.bytes.byteOffset + pack.bytes.byteLength);
				window.parent.postMessage(
					{ type: "cozyclay:export-keyframe-pack-result", name: pack.name, bytes, entries: pack.entries.map((entry) => entry.name) },
					"*",
					[bytes],
				);
				attempt?.succeed();
			} catch (error) {
				attempt?.fail(error);
				window.parent.postMessage({ type: "cozyclay:export-keyframe-pack-result", error: error?.message || String(error), failure_code: exportFailureCode(error) }, "*");
			}
		};
		const onMessage = (event) => {
			if (event.data?.type === "cozyclay:capture-framing") capture();
			if (event.data?.type === "cozyclay:export-keyframe-pack") {
				const ownedByWorkflow = event.source === window.parent && event.origin === window.location.origin && event.data.surface === "workflow";
				void exportPack(event.data.shotId, ownedByWorkflow);
			}
		};
		window.addEventListener("message", onMessage);
		return () => window.removeEventListener("message", onMessage);
	}, [embedMode]);
	// QA-only render counter (same spirit as window.__cozyclay): headless perf
	// probes read renders/second to find re-render storms. Negligible cost.
	if (typeof window !== "undefined") window.__cozyclayRenders = (window.__cozyclayRenders || 0) + 1;
	const sceneRevisionRef = useRef(0);
	const studioBindingRef = useRef(null);
	const firstEditRef = useRef(null);
	if (!firstEditRef.current) {
		const firstEdit = createFirstEditTracker(track);
		// Observe the existing semantic boundary once, even after its telemetry
		// gate is satisfied. The tutorial/semantic hook itself stays unchanged.
		firstEditRef.current = (surface, domain, before, after) => {
			if (before !== after) sceneRevisionRef.current += 1;
			studioBindingRef.current?.invalidate(domain, before, after);
			studioBindingRef.current?.publishSemantic(domain, after);
			// Every authored edit is counted by its closed kind for the session
			// summary (#466); classification only runs while telemetry is on.
			if (before !== after && analyticsActive()) {
				try {
					const kind = semanticEditKind(domain, before, after);
					if (kind) recordSemanticEdit(kind);
				} catch {
					// Telemetry classification must never affect editing.
				}
			}
			return firstEdit(surface, domain, before, after);
		};
	}
	// One semantic hook for authored UI and programmatic mutations. Passive
	// setters intentionally bypass it (navigation, load, seed, restore, history).
	const markSemanticEdit = (domain, before, after) => {
		tutorialProjectEpochRef.current += 1;
		if (tutorialSeedEpochRef.current !== null) setTutorialSeedPending(false);
		return firstEditRef.current(playgroundMode ? "playground" : "craft", domain, before, after);
	};
	const craftActionTrackedRef = useRef(false);
	const markCraftAction = (actionKind) => {
		if (craftActionTrackedRef.current) return;
		craftActionTrackedRef.current = true;
		// Playground pokes are funnel data for the landing page, not for the
		// install -> first craft funnel the studio reports.
		track(playgroundMode ? "playground:first_action" : "craft:first_action", { action_kind: actionKind });
	};
	useEffect(() => {
		if (!playgroundMode) return undefined;
		track("playground:opened");
		// The landing page keeps a loading veil over the iframe until the
		// studio has actually mounted; a bare `load` fires far too early.
		window.parent?.postMessage({ type: "cozyclay:playground-ready" }, "*");
		// Camera gestures feed the landing page's tutorial checklist, and the
		// checklist points back at one control (the shot look-through) by hint.
		const onNav = (event) => window.parent?.postMessage({ type: "cozyclay:playground-nav", kind: event.detail?.kind, key: event.detail?.key ?? null }, "*");
		const onSignal = (event) => window.parent?.postMessage({ type: "cozyclay:playground-nav", kind: event.detail?.kind }, "*");
		window.addEventListener("cozyclay:playground-signal", onSignal);
		const onHint = (event) => {
			if (event.source !== window.parent || event.origin !== window.location.origin) return;
			if (event.data?.type === "cozyclay:playground-hint") setPlaygroundHint(typeof event.data.kind === "string" ? event.data.kind : null);
			if (event.data?.type === "cozyclay:playground-export") {
				// The visitor keeps what they made: the landing page turns this
				// into a .cclayproject download they can open after npx cozyclay.
				playgroundExportRef.current?.("City Block").then(
					(serialized) => window.parent?.postMessage({ type: "cozyclay:playground-export-result", serialized }, "*"),
					(error) => window.parent?.postMessage({ type: "cozyclay:playground-export-result", error: String(error?.message ?? error) }, "*"),
				);
			}
		};
		window.addEventListener("cozyclay:nav", onNav);
		window.addEventListener("message", onHint);
		return () => { window.removeEventListener("cozyclay:nav", onNav); window.removeEventListener("cozyclay:playground-signal", onSignal); window.removeEventListener("message", onHint); };
		// eslint-disable-next-line react-hooks/exhaustive-deps
	}, []);
	const [startup] = useState(loadSceneStartup);
	const startupScene = startup.document.scenes[activeSceneIndex(startup.document.scenes, startup.document.activeSceneId)];
	const startupStage = createSceneStage(startupScene.stage);
	const startupCreatedScene = startup.startupCreatedScene === true;
	const [workspaceLayout, setWorkspaceLayout] = useState(loadWorkspaceLayout);
	const stageDomain = useStage(appContext.forRender({
		startupStage,
		get stageDomain() { return stageDomain; },
		get actorStageRef() { return actorStageRef; },
		get objects() { return storeRef.current.objects; },
	}));
	const {
		preset, shotAspectKey, environmentImage, cameraPresetId, sensorId, keyLight, changeKeyLight,
		resetKeyLight, changeEnvironmentImage, hasEnvSheet, environment, style, publishStudioStage,
	} = stageDomain;
	const shotsDomain = useShots(appContext.forRender({
		get cameraPreviewEndRef() { return cameraPreviewEndRef; },
		get captureCurrentFraming() { return captureCurrentFraming; },
		get charA() { return charA; },
		get framingSessionOpen() { return framingSessionOpen; },
		get framingSessionRef() { return framingSessionRef; },
		get ikMode() { return ikMode; },
		get look() { return look; },
		get manualCameraOverrideRef() { return manualCameraOverrideRef; },
		get markCraftAction() { return markCraftAction; },
		get markSemanticEdit() { return markSemanticEdit; },
		get motionPos() { return motionPos; },
		get playMode() { return playMode; },
		get promptTextSessionRef() { return promptTextSessionRef; },

		get runStudioAction() { return runStudioAction; },
		get selectWorkflowMode() { return selectWorkflowMode; },
		get setSelectedHierarchyId() { return setSelectedHierarchyId; },
		get setTlPlaying() { return setTlPlaying; },
		get setWorkspaceLayout() { return setWorkspaceLayout; },
		get shotCamRef() { return shotCamRef; },
		get snapshotCast() { return snapshotCast; },
		get startupScene() { return startupScene; },
		get tlPlaying() { return tlPlaying; },
		get waypointMode() { return waypointMode; },
		get workflowMode() { return workflowMode; },
		get activeChar() { return activeChar; },
		get characters() { return characters; },
		get currentRecordFrameCount() { return currentRecordFrameCount; },
		get enterPreview() { return enterPreview; },
		get executeExportRequest() { return executeExportRequest; },
		get exportRequest() { return exportRequest; },
		get motion() { return motion; },
		get multiModelFootage() { return multiModelFootage; },
		get playgroundMode() { return playgroundMode; },
		get promptClips() { return promptClips; },
		get recRef() { return recRef; },
		get runShotExport() { return runShotExport; },
		get setCameraPos() { return setCameraPos; },
		get setNonce() { return setNonce; },
		get shotCameraPosRef() { return shotCameraPosRef; },
		get stageDomain() { return stageDomain; },
	}));
	const {
		fovDeg, setFovDeg, cameraMove, customMove, startupShotState, shots, setShots, editShots, movePlaying,
		setMovePlaying, moveFollow, railDraw, setRailDraw, craneSelectedIndex, setCraneSelectedIndex, tlFrame,
		setTlFrame, tlFrameCount, setTlFrameCount, tlFps, setTlFps, activeShotIdx, activeShot, cameraKeys,
		activeCamera, craneActive, cameraRail, activeShotDuration, hasCameraKeys, changeActiveCamera,
		changeShotTargetModel, addActiveCranePoint, deleteSelectedCranePoint, syncActiveCameraFraming,
		commitManualCameraFraming, beginCameraFramingGesture, beginTimelineEditGesture, setShotCameraRail,
		clearShotCameraRail, changeCameraRail, toggleCameraRailDraw, deleteCameraRail, previewCameraShot,
		addCameraKeyframe, moveCameraKeyframe, removeCameraKeyframe, addTimelineShot, splitTimelineShot,
		selectTimelineShot, duplicateTimelineShot, moveTimelineShot, setTimelineShotRange, removeTimelineShot,
	} = shotsDomain;
	const { publishStudioCamera, applyPreset, exportShotVideo } = shotsDomain;

	const shotOutput = SHOT_ASPECT_PRESETS[shotAspectKey] ?? SHOT_ASPECT_PRESETS["16:9"];

	// Composition guides over the shot frame (Blender's camera display guides).
	// A viewer preference, not scene data: it persists per browser, never in
	// the scene document, and never touches exported pixels.
	const [guideMode, setGuideMode] = useState(() => readStoredGuideMode(globalThis.localStorage));
	useEffect(() => {
		writeStoredGuideMode(globalThis.localStorage, guideMode);
	}, [guideMode]);
	// Blender-style grid viewport: dark void + reference grid instead of the
	// clay deck. A viewer preference like the guides — never scene data.
	const [gridView, setGridView] = useState(() => readStoredGridView(globalThis.localStorage));
	// The stage follows the UI theme (grid-view.js stageBackground).
	const uiTheme = useUiTheme();
	useEffect(() => {
		writeStoredGridView(globalThis.localStorage, gridView);
	}, [gridView]);

	const [camGlide, setCamGlide] = useState(null);
	const filmback = useMemo(
		() => ({ sensorId, aspectRatio: shotOutput.aspect }),
		[sensorId, shotOutput.aspect],
	);
	const [nonce, setNonce] = useState(0);
	// Which `preset:nonce` ShotRig last seeded the shot camera from. Held here
	// rather than inside ShotRig because a suspending cast model remounts the
	// Canvas children, and a remount must not re-seed over a camera move.
	const shotPresetAppliedRef = useRef(null);
	// The shot camera's last position, kept outside the Canvas so a remount can
	// put the camera back where it was. ShotRig's metrics tick keeps it fresh;
	// the live set_camera handler writes it directly because that command can
	// land while the camera is unmounted.
	const shotCameraPosRef = useRef(null);
	// The Top-View is always the inset: the old double-click swap that let the
	// plan own the big pane is gone, so there is no view mode to toggle.
	const planIsMain = false;
	// The framed output only — no editing chrome (gizmo, inset, fly navigation)
	// reaches it. The Scene/PlayView centre tabs are gone (#195): this is an
	// internal player with two entry points (the Workflow embed and the
	// playground rail) and one exit (Esc / the exit pill). The shot PiP's
	// look-through button flies the recording camera instead.
	const [preview, setPreview] = useState(embedMode);
	// The name stays `playMode`: window.__cozyclay QA hooks and the MCP live
	// bridge read this global, and the render path is still PlayView's.
	globalThis.playMode = preview;
	const playMode = preview;
	// #441 moved shot authoring into commands and dropped the Shot and Rail
	// signals the landing checklist waits for. Read them from the authored state,
	// as the studio tutorial does (#586): a shot added here, and a rail drawn.
	// Declared before the play signal: a drawn rail starts playback in the same
	// commit, and the checklist expects Rail before Play.
	const playgroundShotCount = useRef(null);
	useEffect(() => {
		if (!playgroundMode) return;
		if (playgroundShotCount.current !== null && shots.length > playgroundShotCount.current) {
			window.parent?.postMessage({ type: "cozyclay:playground-nav", kind: "shot" }, "*");
		}
		playgroundShotCount.current = shots.length;
	}, [playgroundMode, shots.length]);
	const playgroundRailReady = playgroundMode && shots.some((shot) => Array.isArray(shot.camera?.cameraRail) && shot.camera.cameraRail.length >= 2);
	useEffect(() => {
		if (playgroundRailReady) window.parent?.postMessage({ type: "cozyclay:playground-nav", kind: "rail" }, "*");
	}, [playgroundRailReady]);
	// Preview is the player for the finished motion: entering starts playback,
	// leaving pauses it. The editor view stays the manipulation surface.
	const [tlPlaying, setTlPlaying] = useState(false);
	useEffect(() => {
		if (playgroundMode && tlPlaying) window.parent?.postMessage({ type: "cozyclay:playground-nav", kind: "play" }, "*");
	}, [playgroundMode, tlPlaying]);
	const cameraPreviewEndRef = useRef(null);
	// Once the operator touches the viewport, the physical camera stays in
	// their hands. Follow/Rail only take it back through an explicit Preview or
	// timeline Play, avoiding the snap-back that used to happen on pointer-up.
	const manualCameraOverrideRef = useRef(false);
	// Split cameras: the EDITOR camera is the user's own eye and never
	// records; the shot camera keeps the framing. Look-through hands the fly
	// controls the shot camera itself — the pre-split single-view behaviour —
	// for framing by flying.
	// The Workflow page embeds this Studio as the Scene node's preview; that
	// preview must show what the node captures on Run: the shot camera's view.
	const [lookThroughShot, setLookThroughShot] = useState(embedMode);
	useEffect(() => {
		if (playgroundMode && lookThroughShot) window.parent?.postMessage({ type: "cozyclay:playground-nav", kind: "shot" }, "*");
	}, [playgroundMode, lookThroughShot]);
	useEffect(() => {
		if (!lookThroughShot || embedMode) return undefined;
		const onKey = (event) => {
			if (event.key === "Escape") exitPreview();
		};
		window.addEventListener("keydown", onKey);
		return () => window.removeEventListener("keydown", onKey);
		// eslint-disable-next-line react-hooks/exhaustive-deps
	}, [lookThroughShot, embedMode]);
	/** The chrome-free player. The shot camera takes the whole pane
	 * (DualRender's playMode branch), the piece restarts from frame 0, and
	 * auto-play only exists once there is a motion to play. Look-through rides
	 * along so every site that picks a camera keeps pointing at the shot camera.
	 * Studio look-through does NOT come through here — that is enterShotLook. */
	function enterPreview() {
		setPreview(true);
		setLookThroughShot(true);
		setTlFrame(0);
		if (motion) setTlPlaying(true);
	}
	/** ...and the one way out of both the player and shot-look: editing chrome
	 * back, playback paused, so leaving never leaves the timeline running
	 * underneath it. */
	function exitPreview() {
		setPreview(false);
		setLookThroughShot(false);
		setTlPlaying(false);
	}
	/** Fly the shot camera with the same bindings as the free camera. Preview
	 * stays off so FlyControls stay live and framing commits stick. */
	function enterShotLook() {
		if (embedMode) return;
		setPreview(false);
		setTlPlaying(false);
		setLookThroughShot(true);
		setSelectedHierarchyId("camera");
		setWorkflowMode("camera");
	}
	const stageRef = useRef();
	const mainPaneRef = useRef();
	const insetPaneRef = useRef();
	// The shot preview pane: the recording camera's framed output, rendered
	// like an exported frame (no editing chrome) while the editor camera owns
	// the main pane.
	const shotPreviewRef = useRef();
	// User-dragged inset position (px, stage-relative). null = the CSS default
	// (top-right); double-clicking the tag snaps back to it.
	const [insetPos, setInsetPos] = useState(null);
	// Timestamp of the last fold toggle that came from the tag strip (click or
	// caret). A double-click started on the tag lands its dblclick event on
	// the pane body afterwards — the body listener skips those, or every tag
	// double-click would toggle twice.
	const insetToggledAtRef = useRef(0);
	const planCamRef = useRef();
	const planHostRef = planIsMain ? mainPaneRef : insetPaneRef;

	useEffect(() => {
		// The landing-page playground runs a fixed, throwaway layout: whatever a
		// visitor drags in the iframe must never overwrite the layout they use in
		// the real studio (same origin, same key).
		if (playgroundMode) return;
		// Quota-guarded like persistScenes: a full disk used to throw out of
		// this effect and blank the studio mid-resize (issue #63).
		try {
			localStorage.setItem(WORKSPACE_LAYOUT_KEY, JSON.stringify(workspaceLayout));
		} catch (err) {
			console.warn("[cozyclay] workspace layout not saved:", err?.name ?? err);
		}
	}, [playgroundMode, workspaceLayout]);

	// Wheel over the inset zooms the Top-View plan: scroll up closes in on
	// the pucks (camera lower), scroll down widens out (camera higher) — the
	// ortho extent is divided by planZoom in DualRender. React's onWheel is
	// passive and could never keep the page still, so a real listener.
	useEffect(() => {
		const pane = insetPaneRef.current;
		if (!pane) return;
		const onWheel = (e) => {
			e.preventDefault();
			setWorkspaceLayout((current) => {
				const next = Math.max(0.25, Math.min(4, current.planZoom * Math.pow(1.0015, -e.deltaY)));
				return next === current.planZoom ? current : { ...current, planZoom: Math.round(next * 100) / 100 };
			});
		};
		pane.addEventListener("wheel", onWheel, { passive: false });
		return () => pane.removeEventListener("wheel", onWheel);
	}, []);

	const [preferencesOpen, setPreferencesOpen] = useState(false);
	const [statusText, setStatusText] = useState("");
	const [previewRanges, setPreviewRanges] = useState([]);
	const [flySpeed, setFlySpeed] = useState(1);
	const workspaceStyle = {
		"--shell-right-width": workspaceLayout.shellSidebarWidth && `${workspaceLayout.shellSidebarWidth}px`,
		"--shell-outliner-height": workspaceLayout.shellOutlinerHeight && `${workspaceLayout.shellOutlinerHeight}px`,
		"--shell-dock-height": workspaceLayout.shellDockHeight && `${workspaceLayout.shellDockHeight}px`,
		"--shell-left-width": workspaceLayout.shellLeftWidth && `${workspaceLayout.shellLeftWidth}px`,
		"--shell-agent-height": workspaceLayout.shellAgentHeight && `${workspaceLayout.shellAgentHeight}px`,
		"--shell-camera-width": workspaceLayout.shellCameraWidth && `${workspaceLayout.shellCameraWidth}px`,
		"--shot-aspect": shotOutput.aspect,
		"--hierarchy-width": `${workspaceLayout.hierarchyWidth}px`,
		"--sidebar-width": `${workspaceLayout.sidebarWidth}px`,
		"--timeline-height": `${workspaceLayout.timelineHeight}px`,
		"--inset-width": `${workspaceLayout.insetWidth}px`,
		"--inset-height": `${workspaceLayout.insetHeight}px`,
	};

	function beginWorkspaceResize(kind, e) {
		if (e.button !== 0) return;
		e.preventDefault();
		e.stopPropagation();
		const startX = e.clientX;
		const startY = e.clientY;
		const shell = e.currentTarget.closest(".app");
		const sidebarWidth = shell.querySelector(".studio-right-column").getBoundingClientRect().width;
		const leftWidth = shell.querySelector(".studio-left-column")?.getBoundingClientRect().width ?? 0;
		const hierarchyHeight = shell.querySelector(".hierarchy-left").getBoundingClientRect().height;
		const mainHeight = shell.querySelector(".workspace").getBoundingClientRect().height;
		const dockHeight = shell.querySelector(".bottom-window").getBoundingClientRect().height;
		const agentHeight = shell.querySelector(".studio-agent-inspector")?.getBoundingClientRect().height ?? 0;
		const rightHeight = shell.querySelector(".studio-right-column").getBoundingClientRect().height;
		const cameraWidth = Number.parseFloat(getComputedStyle(shell).getPropertyValue("--shell-camera-width")) || 340;
		const onMove = (ev) => {
			const dx = ev.clientX - startX;
			const dy = ev.clientY - startY;
			setWorkspaceLayout((current) => {
				if (kind === "left") {
					return { ...current, shellLeftWidth: Math.max(200, Math.min(window.innerWidth * 0.3, leftWidth + dx)) };
				}
				if (kind === "agent") {
					return { ...current, shellAgentHeight: Math.max(160, Math.min(rightHeight - 200, agentHeight - dy)) };
				}
				if (kind === "camera") {
					return { ...current, shellCameraWidth: Math.max(240, Math.min(560, cameraWidth - dx)) };
				}
				if (kind === "sidebar") {
					return {
						...current,
						shellSidebarWidth: Math.max(280, Math.min(window.innerWidth * 0.5, sidebarWidth - dx)),
					};
				}
				if (kind === "hierarchy") {
					return {
						...current,
						shellOutlinerHeight: Math.max(120, Math.min(mainHeight - 120, hierarchyHeight + dy)),
					};
				}
				return {
					...current,
					shellDockHeight: Math.max(110, Math.min(window.innerHeight * 0.58, dockHeight - dy)),
				};
			});
		};
		const onUp = () => {
			document.body.classList.remove("is-resizing", `resize-${kind}`);
			window.removeEventListener("pointermove", onMove);
			window.removeEventListener("pointerup", onUp);
			window.removeEventListener("pointercancel", onUp);
		};
		document.body.classList.add("is-resizing", `resize-${kind}`);
		window.addEventListener("pointermove", onMove);
		window.addEventListener("pointerup", onUp);
		window.addEventListener("pointercancel", onUp);
	}

	// Double-clicking the inset body folds it (like a window titlebar). The
	// tag keeps its own double-click (snap back to the corner); the old
	// Scene↔Top-View big-pane swap on double-click is gone — the Top-View is
	// always the inset, folded or not. Pane divs are pointer-events:none off
	// the plan board, so this hit-tests the rect instead of DOM targeting.
	useEffect(() => {
		const onDblClick = (event) => {
			const pane = insetPaneRef.current;
			if (!pane) return;
			if (event.target.closest?.(".vp-inset-tag")) return; // the tag's own gesture
			if (Date.now() - insetToggledAtRef.current < 450) return; // a tag gesture already folded this double-click
			const rect = pane.getBoundingClientRect();
			if (event.clientX < rect.left || event.clientX > rect.right || event.clientY < rect.top || event.clientY > rect.bottom) return;
			setWorkspaceLayout((current) => ({ ...current, insetCollapsed: !current.insetCollapsed }));
		};
		window.addEventListener("dblclick", onDblClick);
		return () => window.removeEventListener("dblclick", onDblClick);
	}, []);

	// Drag the inset pane by its tag chip. Window-level listeners so a fast
	// drag off the chip keeps moving the pane; bounds clamp to the stage.
	function beginInsetDrag(e) {
		if (e.button !== 0) return;
		const stage = stageRef.current;
		const pane = insetPaneRef.current;
		if (!stage || !pane) return;
		e.preventDefault();
		e.stopPropagation();
		const stageRect = stage.getBoundingClientRect();
		const paneRect = pane.getBoundingClientRect();
		const grabX = e.clientX - paneRect.left;
		const grabY = e.clientY - paneRect.top;
		// Dragging the collapsed pill clamps against the EXPANDED size, so a
		// pill parked at an edge can never expand out from under the sidebar.
		const effW = workspaceLayout.insetCollapsed ? workspaceLayout.insetWidth : paneRect.width;
		const effH = workspaceLayout.insetCollapsed ? workspaceLayout.insetHeight : paneRect.height;
		// Foldout semantics on the tag strip: a click without movement folds,
		// a drag past the threshold moves the pane — same gesture family as the
		// inspector's foldout headers.
		let moved = false;
		const onMove = (ev) => {
			if (!moved && Math.abs(ev.clientX - e.clientX) < 4 && Math.abs(ev.clientY - e.clientY) < 4) return;
			moved = true;
			setInsetPos({
				x: Math.max(8, Math.min(ev.clientX - stageRect.left - grabX, stageRect.width - effW - 8)),
				y: Math.max(8, Math.min(ev.clientY - stageRect.top - grabY, stageRect.height - effH - 8)),
			});
		};
		const onUp = (ev) => {
			window.removeEventListener("pointermove", onMove);
			window.removeEventListener("pointerup", onUp);
			window.removeEventListener("pointercancel", onUp);
			// A double-click is one deliberate fold, not two: the second click's
			// pointerup carries detail=2 and is ignored, so rapid clicking never
			// flicker-toggles the inset.
			if (!moved && ev.detail <= 1) {
				insetToggledAtRef.current = Date.now();
				runStudioAction("view.setInset", { collapsed: !workspaceLayout.insetCollapsed });
			}
		};
		window.addEventListener("pointermove", onMove);
		window.addEventListener("pointerup", onUp);
		window.addEventListener("pointercancel", onUp);
	}

	// Expanding reclamps the parked position against the restored size: a
	// pill dragged to the stage edge must expand INTO the stage, not under
	// the inspector sidebar.
	function expandInset() {
		const stage = stageRef.current;
		if (stage) {
			const stageRect = stage.getBoundingClientRect();
			const maxX = Math.max(8, stageRect.width - workspaceLayout.insetWidth - 8);
			const maxY = Math.max(8, stageRect.height - workspaceLayout.insetHeight - 8);
			setInsetPos((pos) => (pos ? { x: Math.min(pos.x, maxX), y: Math.min(pos.y, maxY) } : pos));
		}
		setWorkspaceLayout((current) => ({ ...current, insetCollapsed: false }));
	}
	/** Fold or unfold the Top-View inset: the Top button, the inset's own
	 * toggle, its tag click and run_action view.setInset. */
	function setInsetCollapsed(collapsed) {
		if (collapsed) setWorkspaceLayout((current) => ({ ...current, insetCollapsed: true }));
		else expandInset();
	}
	/** The View menu's part colours: "off", "flat" or "shaded". */
	function choosePartColours(mode) {
		setPartColoursEnabled(mode !== "off");
		if (mode !== "off") setPartColoursMode(mode);
	}

	function beginInsetResize(e) {
		if (e.button !== 0) return;
		const stage = stageRef.current;
		const pane = insetPaneRef.current;
		if (!stage || !pane) return;
		e.preventDefault();
		e.stopPropagation();
		const stageRect = stage.getBoundingClientRect();
		const paneRect = pane.getBoundingClientRect();
		const startX = e.clientX;
		const startY = e.clientY;
		const originX = paneRect.left - stageRect.left;
		const originY = paneRect.top - stageRect.top;
		if (!insetPos) setInsetPos({ x: originX, y: originY });
		const onMove = (ev) => {
			const width = Math.max(190, Math.min(stageRect.width - originX - 8, paneRect.width + ev.clientX - startX));
			const height = Math.max(150, Math.min(stageRect.height - originY - 8, paneRect.height + ev.clientY - startY));
			setWorkspaceLayout((current) => ({ ...current, insetWidth: width, insetHeight: height }));
		};
		const onUp = () => {
			document.body.classList.remove("is-resizing", "resize-inset");
			window.removeEventListener("pointermove", onMove);
			window.removeEventListener("pointerup", onUp);
			window.removeEventListener("pointercancel", onUp);
		};
		document.body.classList.add("is-resizing", "resize-inset");
		window.addEventListener("pointermove", onMove);
		window.addEventListener("pointerup", onUp);
		window.addEventListener("pointercancel", onUp);
	}

	const castDomain = useCast(appContext.forRender({
		get beginGestureUndo() { return beginGestureUndo; },
		get bufferRef() { return bufferRef; },
		get clearMotion() { return clearMotion; },
		get committedIkEdits() { return committedIkEdits; },
		get environment() { return environment; },
		get environmentImage() { return environmentImage; },
		get exitLineEditMode() { return exitLineEditMode; },
		get frameCountRef() { return frameCountRef; },
		get gestureUndoRef() { return gestureUndoRef; },
		get hasEnvSheet() { return hasEnvSheet; },
		get ikStateRef() { return ikStateRef; },
		get ikStatesRef() { return ikStatesRef; },
		get keyLight() { return keyLight; },
		get lineEditMode() { return lineEditMode; },
		get loadedLayerCharRef() { return loadedLayerCharRef; },
		get markSemanticEdit() { return markSemanticEdit; },
		get motion() { return motion; },
		get motionFullRef() { return motionFullRef; },
		get promptTextSessionRef() { return promptTextSessionRef; },
		get publishStudioCharacters() { return publishStudioCharacters; },
		get rigReportersRef() { return rigReportersRef; },
		get rigWaitersRef() { return rigWaitersRef; },
		get runStudioAction() { return runStudioAction; },
		get setArdyDuration() { return setArdyDuration; },
		get setArdyPrompt() { return setArdyPrompt; },
		get setCommittedIkEdits() { return setCommittedIkEdits; },
		get setIkTick() { return setIkTick; },
		get setSelectedHierarchyId() { return setSelectedHierarchyId; },
		get setShots() { return setShots; },
		get setTlFrame() { return setTlFrame; },
		get setTlFrameCount() { return setTlFrameCount; },
		get shots() { return shots; },
		get snapshotIkKeys() { return snapshotIkKeys; },
		get stageDomain() { return stageDomain; },
		get startupShotState() { return startupShotState; },
		get startupStage() { return startupStage; },
		get style() { return style; },
		get tlFps() { return tlFps; },
		get tlFrame() { return tlFrame; },
		get tlFrameCount() { return tlFrameCount; },
		get editShots() { return editShots; },
		get publishStudioCamera() { return publishStudioCamera; },
		get publishStudioDomain() { return publishStudioDomain; },
		get publishStudioStage() { return publishStudioStage; },
		get sceneRevisionRef() { return sceneRevisionRef; },
		get snapshotCast() { return snapshotCast; },
		get snapshotStudioDomain() { return snapshotStudioDomain; },
		get storeRef() { return storeRef; },
		get studioActionGroupRef() { return studioActionGroupRef; },
		get studioHistoryRef() { return studioHistoryRef; },
		get syncStudioLayerBuffer() { return syncStudioLayerBuffer; },
		get ikMode() { return ikMode; },
		get leaveIkMode() { return leaveIkMode; },
		get motionDomain() { return motionDomain; },
		get objectDeleteUndo() { return objectDeleteUndo; },
		get readStudioState() { return readStudioState; },
		get selectedSceneObjectId() { return selectedSceneObjectId; },
		get setObjectDeleteUndo() { return setObjectDeleteUndo; },
		get snapshotExportRig() { return snapshotExportRig; },
		get studioBindingRef() { return studioBindingRef; },
		get objectsDomain() { return objectsDomain; },
		get restoreMotionRefs() { return restoreMotionRefs; },
		get shotsDomain() { return shotsDomain; },
	}));
	const {
		characters, customPoses, posing, setPosing, posingClosing, studioPick, setStudioPick,
		rigs, rigMountEpoch, setRigMountEpoch, setPoseTick, charA, charB, showB, poseA, poseB, subject, subject2,
		updateCharacterAt, setShowB, moveCharacter, removeCharacter, reportRig, spawnCharacter,
		charKeyToHierarchyId, charIdFromHierarchyId, activeCharacterId, setActiveCharacterId, rowIdForCharIndex,
		activeChar, selectActiveCharacterInHierarchy, activeCharIndex, activeRig, waitForRig, ghostLayers,
		snapshotCast, changeInspectorCharacter, hasCharSheet, setHasCharSheet, promptBlocksReveal,
		setPromptBlocksReveal, revealPromptBlocks, waypointMode, setWaypointMode, waypoints, setWaypoints,
		activeWaypointId, setActiveWaypointId, pendingWaypointFrame, setPendingWaypointFrame, promptClips,
		setPromptClips, editPromptClips, selectedPromptId, setSelectedPromptId, photoPoseState, photoPoseError,
		setPhotoPoseError, allPoses, selectablePoses, posingIndex, posingChar, posedRig, setPosed, rootStart,
		queueRootWaypointFrame, castMemberOf, addCharacterWaypoint, moveCharacterWaypoint,
		removeCharacterWaypoint, clearCharacterWaypoints, addFloorWaypoint, moveWaypoint, removeWaypoint,
		toggleWaypointMode, openStudio, closeStudio, saveCurrentPose, savePose, posePhotoFile, removePose,
		addPromptClip, changePromptClip, PROMPT_BLOCK_MAX_FRAMES, resizePromptClip, movePromptClip,
		removePromptClip,
	} = castDomain;
	const { publishStudioCharacters, syncStudioLayerBuffer, undoScene, redoScene, snapshotStudioDomain } = castDomain;
	// The cast as of this render, for async handlers: an extraction that
	// started three renders ago must place its takes against the CURRENT cast,
	// not the one its closure captured.
	appContext.publishCharacters(characters);

	const [i2vMotionEnabled, setI2vMotionEnabled] = useState(false);
	const [i2vMotionMode, setI2vMotionMode] = useState("interpolate");
	const [i2vMotionCameraUnlocked, setI2vMotionCameraUnlocked] = useState(false);

	useEffect(() => {
		let cancelled = false;
		fetch(`${motionApiOrigin()}/v1/motion/me`, { credentials: "include" })
			.then((response) => response.ok ? response.json() : null)
			.then((payload) => {
				if (cancelled || !payload) return;
				setI2vMotionEnabled(payload.enabled === true);
				if (Number.isFinite(payload.dailyRemaining)) motionDomain.updateI2vMotionQuota(payload.dailyRemaining);
			})
			.catch(() => { if (!cancelled) setI2vMotionEnabled(false); });
		return () => { cancelled = true; };
	}, []);

	// Per-character rig report: stable callback identity per character so
	// the Character effect does not re-fire on every App render.
	const rigReportersRef = useRef(new Map());
	const rigWaitersRef = useRef(new Map());

	/* --------------------------- asset dragging ---------------------------- */

	// A grabbed asset card follows the pointer as a DOM ghost; dropping over
	// the shot pane raycasts to the floor and spawns the payload there. The
	// payload is discriminated — {kind:'character'|'object'|'image'|'mesh'} — so one
	// drag seam serves the whole shelf.
	const [assetDrag, setAssetDrag] = useState(null);

	function beginAssetDrag(payload, event) {
		const start = { x: event.clientX, y: event.clientY };
		setAssetDrag({ payload, x: start.x, y: start.y });
		const onMove = (move) => setAssetDrag((drag) => (drag ? { ...drag, x: move.clientX, y: move.clientY } : drag));
		const onUp = (up) => {
			window.removeEventListener("pointermove", onMove);
			window.removeEventListener("pointerup", onUp);
			window.removeEventListener("pointercancel", onUp);
			setAssetDrag(null);
			const host = mainPaneRef.current;
			const cam = (lookThroughShot ? shotCamRef : editorCamRef).current;
			if (!host || !cam) return;
			const rect = host.getBoundingClientRect();
			if (up.clientX < rect.left || up.clientX > rect.right || up.clientY < rect.top || up.clientY > rect.bottom) return;
			const pointer = new THREE.Vector2(
				((up.clientX - rect.left) / rect.width) * 2 - 1,
				-((up.clientY - rect.top) / rect.height) * 2 + 1,
			);
			const raycaster = new THREE.Raycaster();
			raycaster.setFromCamera(pointer, cam);
			const hit = new THREE.Vector3();
			if (!raycaster.ray.intersectPlane(new THREE.Plane(new THREE.Vector3(0, 1, 0), 0), hit)) return;
			// Dispatch on the payload kind: same ray, four spawners. Characters
			// keep their tighter stage clamp (the rig walks, a prop does not);
			// objects, cutouts and meshes take the same ROOM_LIMIT clamp their
			// creators already apply.
			if (payload.kind === "character") {
				spawnCharacter(payload.id,
					THREE.MathUtils.clamp(hit.x, CHARACTER_POSITION_BOUNDS.min.x, CHARACTER_POSITION_BOUNDS.max.x),
					THREE.MathUtils.clamp(hit.z, CHARACTER_POSITION_BOUNDS.min.z, CHARACTER_POSITION_BOUNDS.max.z));
			} else if (payload.kind === "object") {
				addSceneObject(payload.objectKind, { x: hit.x, z: hit.z });
			} else if (payload.kind === "image") {
				spawnCutoutAt(payload.assetId, { x: hit.x, z: hit.z });
			} else if (payload.kind === "mesh") {
				spawnMeshAt(payload.assetId, { x: hit.x, z: hit.z });
			}
		};
		window.addEventListener("pointermove", onMove);
		window.addEventListener("pointerup", onUp);
		window.addEventListener("pointercancel", onUp);
	}

	const motionDomain = useMotion(appContext.forRender({
		get attachFrameRef() { return attachFrameRef; },
		get PROMPT_BLOCK_MAX_FRAMES() { return PROMPT_BLOCK_MAX_FRAMES; },
		get activeChar() { return activeChar; },
		get activeCharIndex() { return activeCharIndex; },
		get activeRig() { return activeRig; },
		get addPromptClip() { return addPromptClip; },
		get ardyAbortRef() { return ardyAbortRef; },
		get autoPhysicsRunRef() { return autoPhysicsRunRef; },
		get bridgeRefreshRef() { return bridgeRefreshRef; },
		get bufferRef() { return bufferRef; },
		get buildLineEditRequest() { return buildLineEditRequest; },
		get cameraPreviewEndRef() { return cameraPreviewEndRef; },
		get cancelLinePreview() { return cancelLinePreview; },
		get castDomain() { return castDomain; },
		get castMemberOf() { return castMemberOf; },
		get charA() { return charA; },
		get characters() { return characters; },
		get clearLineEdit() { return clearLineEdit; },
		get collisionCleanupSupported() { return collisionCleanupSupported; },
		get exitLineEditMode() { return exitLineEditMode; },
		get fovDeg() { return fovDeg; },
		get frameCountRef() { return frameCountRef; },
		get genJobSeq() { return genJobSeq; },
		get genRunningRef() { return genRunningRef; },
		get generationPendingRef() { return generationPendingRef; },
		get ikBodyDragRef() { return ikBodyDragRef; },
		get ikFrames() { return ikFrames; },
		get ikStateRef() { return ikStateRef; },
		get ikStatesRef() { return ikStatesRef; },
		get lineEditMode() { return lineEditMode; },
		get lineEditPayload() { return lineEditPayload; },
		get linePreviewSource() { return linePreviewSource; },
		get linePreviewUrl() { return linePreviewUrl; },
		get lineTrack() { return lineTrack; },
		get loadedLayerCharRef() { return loadedLayerCharRef; },
		get look() { return look; },
		get markSemanticEdit() { return markSemanticEdit; },
		get motionFullRef() { return motionFullRef; },
		get multiModelObjectUrlRef() { return multiModelObjectUrlRef; },
		get multiModelRunRef() { return multiModelRunRef; },
		get physicsJobRef() { return physicsJobRef; },
		get physicsSourceCacheRef() { return physicsSourceCacheRef; },
		get poseMemberAtFrame() { return poseMemberAtFrame; },
		get posedRig() { return posedRig; },
		get poserCamRef() { return poserCamRef; },
		get poserLook() { return poserLook; },
		get posing() { return posing; },
		get posingChar() { return posingChar; },
		get projectMotionsRef() { return projectMotionsRef; },
		get promptClips() { return promptClips; },
		get publishStudioCharacters() { return publishStudioCharacters; },
		get restoreEpochRef() { return restoreEpochRef; },
		get restoreRef() { return restoreRef; },
		get revealPromptBlocks() { return revealPromptBlocks; },
		get rigs() { return rigs; },
		get rowIdForCharIndex() { return rowIdForCharIndex; },
		get runStudioAction() { return runStudioAction; },
		get sceneObjects() { return sceneObjects; },
		get selectActiveCharacterInHierarchy() { return selectActiveCharacterInHierarchy; },
		get setProjectManifest() { return setProjectManifest; },
		get setPromptClips() { return setPromptClips; },
		get setSelectedHierarchyId() { return setSelectedHierarchyId; },
		get setTlFps() { return setTlFps; },
		get setTlFrame() { return setTlFrame; },
		get setTlFrameCount() { return setTlFrameCount; },
		get setTlPlaying() { return setTlPlaying; },
		get shot() { return shot; },
		get shotCamRef() { return shotCamRef; },
		get takeRecipeRef() { return takeRecipeRef; },
		get takeSourceUrl() { return takeSourceUrl; },
		get tlFps() { return tlFps; },
		get tlFrame() { return tlFrame; },
		get tlFrameCount() { return tlFrameCount; },
		get tlFrameRef() { return tlFrameRef; },
		get toggleLineEditMode() { return toggleLineEditMode; },
		get trailBaseMotionRef() { return trailBaseMotionRef; },
		get trailPreviewMotionRef() { return trailPreviewMotionRef; },
		get tutorialProjectEpochRef() { return tutorialProjectEpochRef; },
		get waitForRig() { return waitForRig; },
		get waypointMode() { return waypointMode; },
		get waypoints() { return waypoints; },
		get captureCurrentFraming() { return captureCurrentFraming; },
		get enterShotLook() { return enterShotLook; },
		get i2vMotionEnabled() { return i2vMotionEnabled; },
		get i2vMotionSegmentationReady() { return i2vMotionSegmentationReady; },
		get captureLiveFraming() { return liveQueries.capture_framing_png; },
		get lookThroughShot() { return lookThroughShot; },
		get motionEncodingCacheRef() { return motionEncodingCacheRef; },
		get readStudioState() { return readStudioState; },
		get restoreExportRig() { return restoreExportRig; },
		get setCameraPos() { return setCameraPos; },
		get setI2vMotionCameraUnlocked() { return setI2vMotionCameraUnlocked; },
		get setI2vMotionStudioOpen() { return setI2vMotionStudioOpen; },
		get setFovDeg() { return setFovDeg; },
		get setResult() { return setResult; },
		get setResultOpen() { return setResultOpen; },
		get setWaypoints() { return setWaypoints; },
		get shotCameraPosRef() { return shotCameraPosRef; },
		get snapshotExportRig() { return snapshotExportRig; },
	}));
	const {
		ikMode, ikChains, setIkChains, ikFkJoints, setIkFkJoints, ikFocus, setIkFocus, footSnap, setFootSnap,
		bodyContact, setBodyContact, IK_CORRECTION_BLEND_FRAMES, autoPhysicsRunning, setAutoPhysicsRunning,
		physicsPreview, setPhysicsPreview, physicsShow, physicsProgress, physicsOptions, setPhysicsOptions,
		ikTick, setIkTick, committedIkEdits, setCommittedIkEdits, trailFalloffS, setTrailFalloffS, showTrails,
		setShowTrails, ikEditTool, setIkEditTool, trailEdit, trailTrackFocus, selectTrailTrack, clearTrailTrackFocus, trailFalloffFrames, focusIkHandle, snapshotIkKeys,
		pendingIkEdit, applyPendingIkEdit, cancelPendingIkEdit,
		rangePins, rangePinResiduals, rangePinSelection, setRangePinSelection, rangePinPartPick, setRangePinPartPick, rangePinPreview, previewRangePinDraft, applyRangePinDraft, deleteRangePin,
		setCharacterIkKey, removeCharacterIkKey, clearCharacterIkKeys, bridge, setBridge, bridgeChecking,
		motionSetupReveal, motionSetupKind, setArdyPrompt, setArdyDuration, ardySeed, preserveStrength,
		setPreserveStrength, takeRecipe, takeVersions, replayNotices, sceneMenuOpen, setSceneMenuOpen,
		ardyRunning, ardyStatus, ardyOutcome, lineEditBackend, setLineEditBackend, motion, motionBusy,
		multiModelUrl, setMultiModelUrl, multiModelSource, setMultiModelSource, multiModelStatus,
		multiModelStage, multiModelProgress, multiModelFootage, multiModelError, multiModelTake,
		multiModelExtract, multiModelExtractProgress, multiModelExtractError, advanceFrame, stepFrame,
		leaveIkMode, beginPlaybackOn, chooseMultiModelFile, pasteMultiModelUrl, useMultiModelUrl, ingestFootage,
		extractMultiModelMotion, loadMotion, clearMotion, applyMotionTrim, resetMotionTrim, cutMotionAtPlayhead,
		changeMotionSegmentSpeed, removeMotionSegmentById, poseOtherCastMembers, toggleIkMode, ikSolve,
		ikDragEnd, ikAddKeyframe, externalBlockers, runFixCollisions, runFixCollisionsRange,
		changePhysicsOptions, showPhysicsPreview, cancelPhysicsPreview, applyPhysicsPreview, runAutoPhysics,
		platformFitRunning, platformFitLast, platformFitProgress, platformFitApplied,
		ikDeleteKeyframe, ikApplyPoseAsKey, recheckMotionHealth, changeArdySeed, takeSeed, runLineEdit,
		runAllPromptBlocks, runArdy, onTrailDragStart, onTrailDragPreview, onTrailDragEnd, runTrailRegeneration,
		genQueue, setGenQueue, executeMotionJob, seedLoadedTake, loadTakeVersion, selectedMotionReadiness,
		generationBusy, openMotionSetup, refineDisabledReason, sceneDisabledReason, sceneGenerateDisabledReason,
		sceneAgainDisabledReason, enterRefineMode, runSceneAgain, addSceneBlock, restoreMotionRefs, cancelArdy,
	} = motionDomain;
	const { i2vMotion, captureI2vStill, enterI2vFraming, markI2vPose, clearI2vPose, clearI2vMotion, restoreI2vCamera, framingDistance, showI2vMotionLock, generateI2vMotion, i2vMotionUnavailable, generateI2vMotionFromUi } = motionDomain;
	const [partColoursEnabled, setPartColoursEnabled] = useState(false);
	const [partColoursMode, setPartColoursMode] = useState("shaded");

	const [selectedHierarchyId, setSelectedHierarchyId] = useState("characterA");
	// The studio is easier to read when the operator chooses a department first.
	// Keep the underlying selection model intact, but use this small workflow
	// state to surface only the tools that belong to the current job.
	const [workflowMode, setWorkflowMode] = useState("scene");
	const [poseObjectOpacity, setPoseObjectOpacityState] = useState(readPoseFadeOpacity);
	const setPoseObjectOpacity = (value) => { setPoseObjectOpacityState(value); writePoseFadeOpacity(value); };
	// Pose mode IS IK editing (#521): with no rig to solve there is nothing to
	// pose, so the mode refuses with the reason instead of opening empty.
	// A capsule figure has no rig at all, so it gets its own reason rather than
	// the "load a character" one, which would read as a loading problem.
	const activeCapabilities = characterCapabilities(activeChar);
	const poseRefusal = !activeCapabilities.pose ? kindRefusal("pose", isKo) : ikChains ? null : ko("Load a character to pose it — Pose mode edits its rig with IK", "캐릭터를 불러와야 포즈를 잡을 수 있어요 — 포즈 모드는 IK로 리그를 편집합니다");
	function selectWorkflowMode(next) {
		if (next === "pose" && poseRefusal) {
			setToast(poseRefusal);
			return;
		}
		// A storyboard is stills: there is no Motion department to open.
		if (next === "motion" && storyboardProject) {
			setToast(ko(STORYBOARD_MOTION_REFUSAL.en, STORYBOARD_MOTION_REFUSAL.ko));
			return;
		}
		setWorkflowMode(next);
		// Picking a department leaves the chrome-free player. Shot-look is
		// camera work, so it only yields when the operator leaves Camera.
		if (preview) exitPreview();
		else if (lookThroughShot && next !== "camera") exitPreview();
		if (next === "camera") setSelectedHierarchyId("camera");
		else if (next === "motion") {
			// The active character's ROW, not the group: the placement gizmo only
			// renders for a specific cast member, so selecting the group used to
			// drop the operator into Motion with nothing to drag.
			setSelectedHierarchyId(rowIdForCharIndex(activeCharIndex));
			// Selecting Motion should land on its first useful control rather than
			// leaving the operator to hunt through a long inspector column.
			setPromptBlocksReveal((signal) => signal + 1);
		}
		// Pose lands on the active character's rig: its Rig Control panel holds
		// the IK tools that W/E/R switch between.
		else if (next === "pose") setSelectedHierarchyId(`${rowIdForCharIndex(activeCharIndex)}.rig`);
		else setSelectedHierarchyId("shot");
	}
	// Every door into the mode (tab, 1-4 keys, view.setMode on the bus) moves
	// IK with it through the motion domain's own entry/exit path...
	useEffect(() => {
		if ((workflowMode === "pose") !== ikMode) toggleIkMode();
	}, [workflowMode]);
	// ...and whatever else ends IK (a take starting playback, the rig going
	// away) hands the operator back to Motion instead of a dead Pose mode.
	useEffect(() => {
		if (!ikMode && workflowMode === "pose") setWorkflowMode(storyboardProject ? "scene" : "motion");
	}, [ikMode]);

	const toggleHierarchyHidden = (hierarchyId) => {
		const objectId = sceneObjectIdFromHierarchy(hierarchyId);
		if (objectId) {
			const object = sceneObjects.find((item) => item.id === objectId);
			if (!object) return;
			changeSceneObject(objectId, { hidden: object.hidden !== true });
			return;
		}
		const charId = charIdFromHierarchyId(hierarchyId);
		if (!charId) return;
		castDomain.toggleCharacterHidden(charId);
	};

	useEffect(() => {
		// A rig node id resolves through its row (#76): selecting any bone
		// activates the body it belongs to, so IK and the timeline buffer
		// follow the character the user is pointing at.
		const id = charIdFromHierarchyId(selectedHierarchyId)
			?? charIdFromHierarchyId(parseRigNodeId(selectedHierarchyId)?.rowId);
		if (id && characters.some((entry) => entry.id === id)) setActiveCharacterId(id);
	}, [selectedHierarchyId, characters]);

	// Right-sidebar tab. "inspector" shows the selection's properties; "shot"
	// holds shot-global settings (type presets, prompt); "motion" holds the
	// ARDY workflow in pipeline order. Selecting anything in the scene routes
	// to the inspector tab; the root SHOT row routes to the shot tab.
	const [inspectorActionsOpen, setInspectorActionsOpen] = useState(false);

	const objectsDomain = useObjects(appContext.forRender({
		get animatedSceneObjects() { return animatedSceneObjects; },
		get castMemberOf() { return castMemberOf; },
		get charIdFromHierarchyId() { return charIdFromHierarchyId; },
		get characters() { return characters; },
		get editorCamRef() { return editorCamRef; },
		get editorLook() { return editorLook; },
		get frameWorldTarget() { return frameWorldTarget; },
		get look() { return look; },
		get lookThroughShot() { return lookThroughShot; },
		get markCraftAction() { return markCraftAction; },
		get markSemanticEdit() { return markSemanticEdit; },
		get matteEditorRef() { return matteEditorRef; },
		get propWorldRef() { return propWorldRef; },
		get selectedHierarchyId() { return selectedHierarchyId; },
		get setInspectorActionsOpen() { return setInspectorActionsOpen; },
		get setSelectedHierarchyId() { return setSelectedHierarchyId; },
		get shotCamRef() { return shotCamRef; },
		get startupScene() { return startupScene; },
		get runStudioAction() { return runStudioAction; },
		get studioHistoryRef() { return studioHistoryRef; },
	}));
	const {
		recentObjectColors, objectColorDraft, setObjectColorDraft, rememberSceneObjectColor, objectDeleteUndo,
		setObjectDeleteUndo, sceneObjects, storeRef, store, selectedSceneObjectId, selectedSceneObject,
		beginSceneTransaction, endSceneTransaction, changeSceneObject, deleteSelectedSceneObject,
		deleteSceneObject, dropSelectedSceneObject, matteTolerance, setMatteTolerance, matteBrush, setMatteBrush,
		matteShrink, setMatteShrink, matteFeather, setMatteFeather, matteMode, setMatteMode, matteStats,
		setMatteStats, matteBusy, gizmoMode, setGizmoMode, snapEnabled, setSnapEnabled, addSceneObject,
		importCutout, importCutouts, spawnCutoutAt, persistMeshAsset, importMesh, importMeshes, spawnMeshAt,
		applyMatte, duplicateSelectedSceneObject, frameSelection, renameSceneObject, sceneObjectWorldMatrix,
		attachTargetForRow, attachTargetLabel, attachSceneObject,
	} = objectsDomain;

	// An undo offer is an offer, not a banner: without a window it sits on the
	// screen for the rest of the session. Long enough to notice and reach, then
	// gone — the deletion is still reversible through Undo history afterwards.
	useEffect(() => {
		if (!objectDeleteUndo) return undefined;
		const timer = setTimeout(() => setObjectDeleteUndo(null), OBJECT_DELETE_UNDO_MS);
		return () => clearTimeout(timer);
	}, [objectDeleteUndo]);

	const scenesDomain = useScenes(appContext.forRender({
		get activeSceneIdRef() { return activeSceneIdRef; },
		get actorStageRef() { return actorStageRef; },
		get cameraTutorialQuery() { return cameraTutorialQuery; },
		get customPoses() { return customPoses; },
		get dirtyRef() { return dirtyRef; },
		get exportShotIdRef() { return exportShotIdRef; },
		get ikStateRef() { return ikStateRef; },
		get ikStatesRef() { return ikStatesRef; },
		get loadedLayerCharRef() { return loadedLayerCharRef; },
		get manualCameraOverrideRef() { return manualCameraOverrideRef; },
		get markSemanticEdit() { return markSemanticEdit; },
		get motionEncodingCacheRef() { return motionEncodingCacheRef; },
		get motionFullRef() { return motionFullRef; },
		get playgroundMode() { return playgroundMode; },
		get projectHandleRef() { return projectHandleRef; },
		get projectMotionsRef() { return projectMotionsRef; },
		get projectSnapshotRef() { return projectSnapshotRef; },
		get projectStateRef() { return projectStateRef; },
		get restoreMotionRefs() { return restoreMotionRefs; },
		get runStudioAction() { return runStudioAction; },
		get saveBlockedRef() { return saveBlockedRef; },
		get saveFailureToastRef() { return saveFailureToastRef; },
		get setActiveCharacterId() { return setActiveCharacterId; },
		get setActiveWaypointId() { return setActiveWaypointId; },
		get setCameraTutorial() { return setCameraTutorial; },
		get setCameraTutorialHandoff() { return setCameraTutorialHandoff; },
		get setFirstSuccessGuideOpen() { return setFirstSuccessGuideOpen; },
		get setHasCharSheet() { return setHasCharSheet; },
		get setMovePlaying() { return setMovePlaying; },
		get setPendingWaypointFrame() { return setPendingWaypointFrame; },
		get setPromptClips() { return setPromptClips; },
		get setRailDraw() { return setRailDraw; },
		get setRigMountEpoch() { return setRigMountEpoch; },
		get setSelectedHierarchyId() { return setSelectedHierarchyId; },
		get setSelectedPromptId() { return setSelectedPromptId; },
		get setShots() { return setShots; },
		get setTlFrame() { return setTlFrame; },
		get setTlFrameCount() { return setTlFrameCount; },
		get setTutorialSeedPending() { return setTutorialSeedPending; },
		get setWaypoints() { return setWaypoints; },
		get setWorkspaceLayout() { return setWorkspaceLayout; },
		get shotDocumentRef() { return shotDocumentRef; },
		get shots() { return shots; },
		get stageDomain() { return stageDomain; },
		get startup() { return startup; },
		get storeRef() { return storeRef; },
		get studioDocumentEpochRef() { return studioDocumentEpochRef; },
		get studioHistoryRef() { return studioHistoryRef; },
		get studioSceneEpochRef() { return studioSceneEpochRef; },
		get tutorialProjectEpochRef() { return tutorialProjectEpochRef; },
		get tutorialSeedEpochRef() { return tutorialSeedEpochRef; },
		get tutorialStarterRef() { return tutorialStarterRef; },
		get castDomain() { return castDomain; },
		get objectsDomain() { return objectsDomain; },
	}));
	const {
		scenes, activeSceneId, sceneSaveError, snapshotActiveScene, persistScenes, projectName, previsMode, projectDirty,
		setProjectDirty, projectSaveState, setProjectSaveState, projectMenuOpen, setProjectMenuOpen,
		projectBrowserOpen, setProjectBrowserOpen, projectNameDialog, setProjectNameDialog, projectStartupOpen,
		setProjectStartupOpen, projectManifest, setProjectManifest, saveBlockedReasons, setSaveBlockedReasons,
		workflowRevision, setWorkflowRevision, collectProjectSnapshot, collectProjectSerialized,
		projectProblemsNotice, rehydrateProjectAssets, saveProject, applyProject, openStarterScene, openProject,
		openProjectByHandle, requestNewProject, newProject, restoreOffer, setRestoreOffer, restoreStoredProject,
		flushScenes, openScene, selectSceneDocument, createSceneDocumentFromUi, duplicateSceneDocumentFromUi,
		renameSceneDocumentFromUi, deleteSceneDocumentFromUi, switchSceneDocument, addSceneDocument,
		duplicateSceneDocument, renameSceneDocument, deleteSceneDocument,
	} = scenesDomain;
	// A storyboard project has no Motion department: a project opened while
	// Motion was up lands on Stage instead.
	const storyboardProject = scenesDomain.previsMode === "storyboard";
	useEffect(() => {
		if (storyboardProject && workflowMode === "motion") setWorkflowMode("scene");
	}, [storyboardProject, workflowMode]);

	const saveBlockedRef = useRef(startup.saveBlocked);
	const dirtyRef = useRef(false);
	// One-shot save-failure toast: the persistent line stays for the session,
	// the toast fires once per failure episode (not on every failed tick).
	const saveFailureToastRef = useRef(false);

	const ikBodyDragRef = useRef(false); // true while a body drag is active

	const ikStateRef = useRef(createIkState());
	const autoPhysicsRunRef = useRef(null);

	const physicsJobRef = useRef(0);
	const physicsSourceCacheRef = useRef({ value: null });

	// Sorted full-body key frames for the timeline markers. Derived from the
	// ref state; ikTick re-derives after every key add/remove.
	const ikFrames = useMemo(() => ikKeyframes(ikStateRef.current),
		// eslint-disable-next-line react-hooks/exhaustive-deps
		[ikTick]);

	 // {track, grabFrame, radiusFrames, clipDelta}
	const trailBaseMotionRef = useRef(null);
	const trailPreviewMotionRef = useRef(null);

	function selectHierarchy(id) {
		// A selection switch is the user starting something else: settle any open
		// drag so its applied travel becomes one committed entry first (plan §6.3).
		// This MUST stay inside the handler, never in the render body: a settle
		// during render runs the producer's cancel teardown, and since the first
		// applied tick re-renders, every drag would die after exactly one tick.
		// Resolve the live store at event time: opening a scene replaces the
		// coordinator in storeRef before the next hierarchy click, while a
		// render-captured store can still settle the scene that was left.
		objectsDomain.settleObjects();
		setSelectedHierarchyId(id);
		// Selecting the camera IS the request to frame a shot (#193). The camera
		// bar owns FOV/Recenter/presets and is CSS-gated to Camera mode, so a
		// camera picked from Scene mode would otherwise select a subject whose
		// controls are all hidden. selectWorkflowMode re-selects the camera
		// itself, so this cannot bounce back here.
		if (id === "camera" && workflowMode !== "camera") selectWorkflowMode("camera");
		// Moving the focus anywhere but the camera releases the crane dot too:
		// a press on the floor or the sky must not leave a mark selected.
		if (id !== "camera") setCraneSelectedIndex(null);
		const focus = RIG_HIERARCHY_FOCUS[parseRigNodeId(id)?.token];
		if (focus && ikMode) setIkFocus(focus);
	}

	/** The hidden file inputs behind the Props import buttons. */
	const cutoutInputRef = useRef(null);
	const meshInputRef = useRef(null);
	// One drop zone shared by every surface that accepts a picture: the Props
	// branch of the hierarchy, the Props inspector, and the shot view itself.
	// One per surface, so only the thing under the cursor lights up.
	// Paste is the path to a picture on the web: "Copy image" hands over bytes,
	// while dragging one hands over a cross-origin URL the matte could never read
	// back. Bound to the document because there is no one field to focus first —
	// the gesture is "paste into the studio", not "paste into this box".
	useEffect(() => {
		const onPaste = (event) => {
			const target = event.target;
			// Never steal a paste aimed at somewhere text goes.
			if (target instanceof HTMLElement) {
				if (target.isContentEditable) return;
				if (/^(INPUT|TEXTAREA|SELECT)$/.test(target.tagName)) return;
			}
			const files = imageFilesFromClipboard(event.clipboardData);
			if (!files.length) {
				// A clipboard that carried a file but no supported image (HEIC is
				// the mainline iPhone case) gets a named rejection, not silence.
				const carriedFile = Array.from(event.clipboardData?.items ?? []).some((item) => item.kind === "file");
				if (carriedFile) setToast(ko("That picture format is not supported — use PNG, JPG, WebP or GIF", "지원하지 않는 사진 형식이에요 — PNG, JPG, WebP, GIF만 가능해요"));
				return;
			}
			event.preventDefault();
			importCutouts(files);
		};
		document.addEventListener("paste", onPaste);
		return () => document.removeEventListener("paste", onPaste);
		// eslint-disable-next-line react-hooks/exhaustive-deps
	}, []);

	const rejectUnsupportedDrop = (count) => setToast(ko(
		`${count} file${count > 1 ? "s" : ""} not supported — use PNG, JPG, WebP, GIF or a .glb / .obj / .fbx (iPhone HEIC photos need converting first)`,
		`지원하지 않는 파일 ${count}개 — PNG, JPG, WebP, GIF 또는 .glb / .obj / .fbx만 가능해요 (아이폰 HEIC 사진은 먼저 변환해 주세요)`,
	));
	const stageDrop = {
		onImages: (files) => importCutouts(files),
		onMeshes: (files) => importMeshes(files),
	};
	const propsDrop = useStageFilesDrop({ ...stageDrop, onRejected: rejectUnsupportedDrop });
	const inspectorDrop = useStageFilesDrop({ ...stageDrop, onRejected: rejectUnsupportedDrop });
	const viewportDrop = useStageFilesDrop({ ...stageDrop, onRejected: rejectUnsupportedDrop });

	const matteCanvasRef = useRef(null);
	const matteEditorRef = useRef(null);
	// The editor always works on the photograph, never on the cut picture the
	// set renders — that is what makes a cut re-editable rather than a one-way
	// door. The saved purple comes back with it.
	const matteSourceId = selectedSceneObject?.renderer === CUTOUT_KIND
		? selectedSceneObject.sourceAssetId || selectedSceneObject.assetId
		: null;
	const matteSelectionId = selectedSceneObject?.renderer === CUTOUT_KIND ? selectedSceneObject.matteAssetId || "" : "";

	useEffect(() => {
		const canvas = matteCanvasRef.current;
		if (!canvas || !matteSourceId) return undefined;
		const editor = createMatteEditor(canvas, { onChange: setMatteStats });
		matteEditorRef.current = editor;
		editor.setTolerance(matteTolerance);
		editor.setMode(matteMode);
		let cancelled = false;
		(async () => {
			const asset = await assetRecord(matteSourceId);
			if (!asset || cancelled) return;
			await editor.load(asset);
			if (cancelled || !matteSelectionId) return;
			const stored = await assetRecord(matteSelectionId);
			if (!stored || cancelled) return;
			const { mask, width, height } = await decodeMask(stored);
			if (!cancelled) editor.setMask(mask, width, height);
		})().catch(() => setMatteStats({ painted: 0, coverage: 0, zoom: 1, canUndo: false, canRedo: false }));
		return () => {
			cancelled = true;
			editor.dispose();
			if (matteEditorRef.current === editor) matteEditorRef.current = null;
		};
		// Tolerance and mode are pushed by their own handlers below; re-running
		// this effect for them would throw away the selection.
		// eslint-disable-next-line react-hooks/exhaustive-deps
	}, [matteSourceId, matteSelectionId]);

	// True while the right mouse button is flying the camera. Tool hotkeys stand
	// down during a flythrough, because W/A/S/D belong to the camera then.
	const flyingRef = useRef(false);

	/** Frame the selection: fly the shot camera to a comfortable distance along
	 * the current view direction, the way Unity's F key does. Defaults to the
	 * selection; the hierarchy context menu passes a specific row's id. */
	/** Dolly-and-aim onto a world point. The editor camera glides; the shot
	 * camera (look-through) still cuts, because reframing the RECORDING lens
	 * is a deliberate act, not a tour. */
	function frameWorldTarget(target, reach) {
		const camera = (lookThroughShot ? shotCamRef : editorCamRef).current;
		const paneLook = lookThroughShot ? look : editorLook;
		if (!camera) return;
		const distance = reach * 2.4 + 0.6;
		const back = forwardFrom(paneLook.current.yaw, paneLook.current.pitch).multiplyScalar(-distance);
		const position = {
			x: target.x + back.x,
			y: Math.max(target.y + back.y, 0.3),
			z: target.z + back.z,
		};
		if (!lookThroughShot) {
			setCamGlide({ position, target });
			return;
		}
		camera.position.set(position.x, position.y, position.z);
		const angles = aimAt(camera.position, target);
		paneLook.current.yaw = angles.yaw;
		paneLook.current.pitch = angles.pitch;
		camera.rotation.order = "YXZ";
		camera.rotation.set(angles.pitch, angles.yaw, 0);
	}

	// Prompt-block text (inspector field AND the timeline chip both land in
	// changePromptClip) and viewport/plan camera framing are the two streams
	// that would otherwise push an entry per keystroke / per pointermove.
	const promptTextSessionRef = useRef(null);
	const framingSessionRef = useRef(null);
	// A colour picker streams values for as long as its dialog is open.
	const tintSessionRef = useRef(null);
	/* One Ctrl+Z entry per GESTURE for the surfaces that write cast-snapshot
	 * state without a store transaction of their own: the key light (foldout
	 * sliders, sun puck, move gizmo) and the character Transform rows. Every
	 * tick of a drag or a scrub reopens the same session while its entry is
	 * still the newest one, and the pointer/key release below closes it, so the
	 * next gesture starts a fresh entry instead of extending the last one. */
	const gestureUndoRef = useRef(null);
	function beginGestureUndo(key) {
		// NumberField hands this token back on every tick of a scrub. These edits
		// are not store transactions, so the scrub runs with a null token.
		return null;
	}
	function endGestureUndo() {
		stageDomain.finishGesture();
		gestureUndoRef.current = null;
	}
	useEffect(() => {
		const end = () => endGestureUndo();
		window.addEventListener("pointerup", end, true);
		window.addEventListener("pointercancel", end, true);
		window.addEventListener("keyup", end, true);
		return () => {
			window.removeEventListener("pointerup", end, true);
			window.removeEventListener("pointercancel", end, true);
			window.removeEventListener("keyup", end, true);
		};
	}, []);

	/** True while a framing capture for `shotId` is the newest history entry. */
	function framingSessionOpen(shotId) {
		return Boolean(framingSessionRef.current)
			&& framingSessionRef.current.key === `framing:${shotId}`
			&& appContext.historyEntry() === framingSessionRef.current.historyEntryId;
	}

	function undoObjectDeletion() {
		if (!objectDeleteUndo) return;
		if (store.depths().past !== objectDeleteUndo.pastDepth) {
			setObjectDeleteUndo(null);
			setToast(ko("A newer edit comes after this deletion. Use Undo history instead.", "삭제 이후의 편집이 있어요. 실행 취소 기록을 사용해 주세요."));
			return;
		}
		undoScene();
	}

	useEffect(() => {
		const onKeyDown = (event) => {
			const target = event.target;
			if (
				target instanceof HTMLInputElement ||
				target instanceof HTMLTextAreaElement ||
				target instanceof HTMLSelectElement ||
				target?.isContentEditable
			) return;
			// While the right button is flying the camera, W/A/S/D/Q/E are the
			// camera's; a tool switch mid-flight would be a surprise.
			if (flyingRef.current) return;
			// Undo/redo (plan §6.5). The input guard above keeps Ctrl/Cmd+Z in
			// the Name field or the ARDY prompt as the browser's text undo.
			// Placed before the selection gate: undo works with nothing
			// selected, and mid-drag the store's settle commits then steps.
			if (event.code === "KeyZ" && (event.ctrlKey || event.metaKey)) {
				event.preventDefault();
				if (event.shiftKey) redoScene();
				else undoScene();
				return;
			}
			// 1-4 pick the workflow mode; pose is refused (with its reason) when
			// there is no rig to solve. The embedded player has no modes to pick.
			const modeKey = { Digit1: "scene", Digit2: "pose", Digit3: "camera", Digit4: "motion" }[event.code];
			if (modeKey && !embedMode && !event.ctrlKey && !event.metaKey && !event.altKey) {
				// A storyboard has no key 4: it does nothing, not even a refusal.
				if (modeKey === "motion" && storyboardProject) return;
				event.preventDefault();
				if (modeKey !== workflowMode) selectWorkflowMode(modeKey);
				return;
			}
			// Pose mode's W/E/R are the IK tools, gated like their Rig Control
			// buttons: the trail tool needs visible trails, the range pin a take.
			if (workflowMode === "pose" && GIZMO_HOTKEYS[event.code]) {
				event.preventDefault();
				if (event.code === "KeyW") setIkEditTool("ik");
				else if (event.code === "KeyE" && showTrails) setIkEditTool("trail");
				else if (event.code === "KeyR" && motion) { setIkEditTool("pin"); setRangePinPartPick(null); }
				return;
			}
			// Motion mode's E is Refine: drag the take's path to re-route it.
			if (workflowMode === "motion" && event.code === "KeyE") {
				event.preventDefault();
				enterRefineMode();
				return;
			}
			if (GIZMO_HOTKEYS[event.code]) {
				event.preventDefault();
				setGizmoMode(GIZMO_HOTKEYS[event.code]);
				return;
			}
			if (event.code === "KeyF") {
				// Frame whatever is selected — Unity's F, not just for props: the
				// sun and the cast are selections the eye wants to travel to too.
				if (selectedSceneObjectId) {
					event.preventDefault();
					frameSelection();
					return;
				}
				if (selectedHierarchyId === "light") {
					event.preventDefault();
					frameWorldTarget({ x: keyLight.x, y: keyLight.y, z: keyLight.z }, 0.8);
					return;
				}
				// Rig node ids carry their row (#76), so `characterB.rig.head`
				// frames character B — startsWith on the row prefix covers both
				// the character row and every rig node under it.
				const framedChar = selectedHierarchyId.startsWith("characterB") ? (showB ? charB : null)
					: selectedHierarchyId.startsWith("characterA") ? charA
					: selectedHierarchyId.startsWith("character:") ? (() => {
						const rowId = parseRigNodeId(selectedHierarchyId)?.rowId ?? selectedHierarchyId;
						return characters.find((entry) => `character:${entry.id}` === rowId) ?? null;
					})()
					: null;
				if (framedChar) {
					event.preventDefault();
					frameWorldTarget({ x: framedChar.x, y: 1, z: framedChar.z }, 1.8);
					return;
				}
			}
			if (event.code === "KeyD" && (event.ctrlKey || event.metaKey) && selectedSceneObjectId) {
				event.preventDefault();
				runStudioAction("object.duplicate");
				return;
			}
			if (event.key === "Escape" && selectedSceneObjectId) {
				setSelectedHierarchyId("props");
				return;
			}
			if (event.code === "End" && selectedSceneObjectId) {
				event.preventDefault();
				dropSelectedSceneObject();
				return;
			}
			if (!selectedSceneObjectId) return;
			if (event.key !== "Delete" && event.key !== "Backspace") return;
			// A selected path point owns Delete: the route's handles are the
			// finer target, and deleting the whole prop out from under a point
			// edit is never what the press meant.
			if (pathPointIndex != null) return;
			event.preventDefault();
			deleteSelectedSceneObject();
		};
		window.addEventListener("keydown", onKeyDown);
		return () => window.removeEventListener("keydown", onKeyDown);
	});

	// Deps are identities, not the entry objects: charA/charB are rebuilt as
	// fresh fallback objects on EVERY render when the cast is short (748-749),
	// so depending on the objects fired this on each render and the actions
	// menu closed the instant it opened.
	useEffect(() => {
		setInspectorActionsOpen(false);
	}, [selectedSceneObjectId, selectedHierarchyId, charA.id, charB.id, showB]);
	// A point index belongs to one object's route; carrying it to the next
	// selection would point the gizmo at a stale dot.
	useEffect(() => {
		setPathPointIndex(null);
	}, [selectedSceneObjectId]);

	useEffect(() => {
		if (!inspectorActionsOpen) return undefined;
		const onPointerDown = (event) => {
			if (event.target instanceof Element && event.target.closest(".inspector-actions-wrap")) return;
			setInspectorActionsOpen(false);
		};
		const onKeyDown = (event) => {
			if (event.key === "Escape") setInspectorActionsOpen(false);
		};
		document.addEventListener("pointerdown", onPointerDown);
		window.addEventListener("keydown", onKeyDown);
		return () => {
			document.removeEventListener("pointerdown", onPointerDown);
			window.removeEventListener("keydown", onKeyDown);
		};
	}, [inspectorActionsOpen]);

	const [mode, setMode] = useState("image");
	const [imageModel, setImageModel] = useState("gpt_image_2");

	useEffect(() => {
		if (playgroundMode && movePlaying) window.parent?.postMessage({ type: "cozyclay:playground-nav", kind: "play" }, "*");
		// eslint-disable-next-line react-hooks/exhaustive-deps
	}, [playgroundMode, movePlaying]);

	// Object travel-path drawing: the same Top-View stroke gesture as the rail,
	// aimed at the selected object instead of the shot camera.
	const [pathDraw, setPathDraw] = useState(false);
	// Root-path (waypoint) authoring and Top-View path drawing are motion
	// tooling; a storyboard never leaves either switched on.
	useEffect(() => {
		if (!storyboardProject) return;
		if (waypointMode) setWaypointMode(false);
		if (pathDraw) setPathDraw(false);
	}, [storyboardProject, waypointMode, pathDraw]);
	const [pathPointIndex, setPathPointIndex] = useState(null);
	const pathDragTokenRef = useRef(null);
	const planPathTokenRef = useRef(null);
	const timingTokenRef = useRef(null);
	// The frame props follow. Live playback keeps it at the playhead; the
	// offscreen export drives it per captured frame without re-rendering.
	const propFrameRef = useRef(0);

	const [cameraPos, setCameraPos] = useState(DEFAULT_CAMERA_POSITION);
	const [subjectVisible, setSubjectVisible] = useState(true);
	const mcpCaptureRef = useRef(null);
	const liveControlRef = useRef(null);
	const [liveWorkspaceHandle, setLiveWorkspaceHandle] = useState(null);
	const liveWorkspaceHandleRef = useRef(null);
	// One identity per tab, kept in sessionStorage so a reload reconnects as the
	// same workspace instead of orphaning the hub's retained motion outcomes.
	const liveWorkspaceIdRef = useRef("");
	if (!liveWorkspaceIdRef.current) liveWorkspaceIdRef.current = loadLiveWorkspaceId();
	const [result, setResult] = useState(null);
	const [i2vMotionStudioOpen, setI2vMotionStudioOpen] = useState(false);
	const [resultOpen, setResultOpen] = useState(false);
	const [copied, setCopied] = useState(false);
	const [recordedVideoName, setRecordedVideoName] = useState(null);
	const [toast, showToast] = useState(startup.toast ?? "");
	// While a Studio action runs editor work, the toasts it shows are collected
	// so run_action can give the agent the reason the user was shown.
	const toastSinkRef = useRef(new Set());
	const setToast = useCallback((value, english) => {
		const toast = resolveStudioToast(value, isKo, ko);
		if (english !== undefined) toast.message = english;
		if (typeof toast.uiMessage === "string" && toast.uiMessage) for (const sink of toastSinkRef.current) sink(toast);
		showToast(toast.uiMessage);
	}, []);
	// The PWA's "a newer studio is waiting" registration, once one arrives.
	const [pwaUpdate, setPwaUpdate] = useState(null);
	useEffect(() => {
		const onUpdate = (event) => setPwaUpdate(event.detail ?? null);
		window.addEventListener(PWA_UPDATE_EVENT, onUpdate);
		return () => window.removeEventListener(PWA_UPDATE_EVENT, onUpdate);
	}, []);
	const [glContextLost, setGlContextLost] = useState(false);

	const bridgeRefreshRef = useRef(null);

	const generationPendingRef = useRef(false);

	 // default clip length in seconds; aligned with the recommended 3-5 s block range

	const takeRecipeRef = useRef(null);

	const [bottomTab, setBottomTab] = useState("timeline");
	// The imported-pictures region of the Assets shelf. null = the scan has
	// never resolved (the pane shows skeletons, NEVER the empty message); an
	// array = the SOURCE ids to show, mattes and cut renders already filtered
	// out (asset-shelf.js). Scans run only while the shelf is visible, and
	// re-run when a cutout's lineage changes — not on every transform tick, so
	// a gizmo drag never hammers IndexedDB.
	const [shelfImageIds, setShelfImageIds] = useState(null);
	const [shelfMeshIds, setShelfMeshIds] = useState(null);
	const [manageAssetStorage, setManageAssetStorage] = useState(false);
	// A separate scan preserves the source-only placement shelf while the
	// manager exposes every unreachable stored record, including matte and cut
	// derivatives orphaned with a deleted card.
	const [unusedAssetIds, setUnusedAssetIds] = useState(null);
	const [usedAssetIds, setUsedAssetIds] = useState(null);
	const [usageCounts, setUsageCounts] = useState(new Map());
	const assetShelfScanTokenRef = useRef(0);
	const legacyDerivedIdsRef = useRef(new Set());
	// This is deliberately session-only. Each entry is a complete IndexedDB
	// record, so Undo can put it back byte-for-byte until the page is reloaded.
	const [assetTrash, setAssetTrash] = useState([]);
	// Same rule as the object deletion offer: the toast is a window, not a
	// banner. Only the OFFER expires — the trashed record itself is the restore
	// data, so it is deliberately kept for the session and never timed out.
	const [assetUndoOffered, setAssetUndoOffered] = useState(false);
	useEffect(() => {
		if (!assetUndoOffered) return undefined;
		const timer = setTimeout(() => setAssetUndoOffered(false), ASSET_DELETE_UNDO_MS);
		return () => clearTimeout(timer);
	}, [assetUndoOffered]);
	const [deletingAssetId, setDeletingAssetId] = useState(null);
	const cutoutLineage = useMemo(
		() => JSON.stringify(sceneObjects.flatMap((object) => (object.renderer === CUTOUT_KIND ? [[object.assetId, object.sourceAssetId, object.matteAssetId]] : []))),
		[sceneObjects],
	);
	const meshLineage = useMemo(
		() => JSON.stringify(sceneObjects.flatMap((object) => (object.renderer === MESH_KIND ? [object.assetId] : []))),
		[sceneObjects],
	);
	const projectCutoutLineage = useMemo(() => {
		const allScenes = scenes.map((scene) => (scene.id === activeSceneId ? { ...scene, objects: sceneObjects } : scene));
		return JSON.stringify(
			allScenes.flatMap((scene) =>
				(Array.isArray(scene.objects) ? scene.objects : []).flatMap((object) =>
					object.renderer === CUTOUT_KIND ? [[object.assetId, object.sourceAssetId, object.matteAssetId]] : [],
				),
			),
		);
	}, [scenes, activeSceneId, sceneObjects]);
	const projectAssetGraphSignature = useMemo(() => {
		const allScenes = scenes.map((scene) => (scene.id === activeSceneId ? { ...scene, objects: sceneObjects } : scene));
		return assetGraphSignature(allScenes);
	}, [scenes, activeSceneId, sceneObjects]);
	useEffect(() => {
		const { scenes: latestScenes, activeSceneId: latestActiveSceneId, sceneObjects: latestObjects } = projectStateRef.current;
		const allScenes = latestScenes.map((scene) => (scene.id === latestActiveSceneId ? { ...scene, objects: latestObjects } : scene));
		const ids = derivedAssetIds(allScenes);
		for (const id of ids) legacyDerivedIdsRef.current.add(id);
		if (ids.size === 0) return;
		let db = null;
		async function backfillLegacyAssetRoles() {
			try {
				db = await openAssetDb();
				for (const id of ids) {
					const record = await getAsset(db, id);
					if (!record || record.role === "derived") continue;
					await putAsset(db, { ...record, role: "derived" });
				}
			} catch (error) {
				console.warn("Could not backfill legacy asset roles", error);
			} finally {
				db?.close?.();
			}
		}
		void backfillLegacyAssetRoles();
	}, [projectCutoutLineage]);
	async function refreshAssetShelf(isAlive = () => true) {
		const scanToken = ++assetShelfScanTokenRef.current;
		const current = () => isAlive() && scanToken === assetShelfScanTokenRef.current;
		let db = null;
		try {
			db = await openAssetDb();
			const stored = await listAssetIds(db);
			const records = await Promise.all(stored.map((id) => getAsset(db, id)));
			const derivedIds = new Set([
				...legacyDerivedIdsRef.current,
				...records.filter((record) => record?.role === "derived").map((record) => record.id),
			]);
			// The active scene's live objects override its saved snapshot. That
			// includes an unsaved matte or cutout edit in the reachability closure.
			const { scenes: latestScenes, activeSceneId: latestActiveSceneId, sceneObjects: latestObjects } = projectStateRef.current;
			const allScenes = latestScenes.map((scene) => (scene.id === latestActiveSceneId ? { ...scene, objects: latestObjects } : scene));
			const latestUsageCounts = assetUsageCounts(allScenes);
			const latestUsedAssetIds = stored.filter((id) => latestUsageCounts.has(id));
			if (!current()) return;
			const sourceIds = sourceAssetIds(stored, allScenes, derivedIds);
			setShelfImageIds(sourceIds.filter(isImageAssetId));
			setShelfMeshIds(sourceIds.filter(isMeshAssetId));
			setUnusedAssetIds(unreachableAssetIds(stored, allScenes));
			setUsedAssetIds(latestUsedAssetIds);
			setUsageCounts(latestUsageCounts);
		} catch {
			// No IndexedDB means no imports can exist either; both honest views are
			// empty rather than presenting an unverifiable deletion target.
			if (current()) {
				setShelfImageIds([]);
				setShelfMeshIds([]);
				setUnusedAssetIds([]);
				setUsedAssetIds([]);
				setUsageCounts(new Map());
			}
		} finally {
			db?.close?.();
		}
	}
	useEffect(() => {
		if (bottomTab !== "assets") return undefined;
		let alive = true;
		void refreshAssetShelf(() => alive);
		return () => {
			alive = false;
		};
		// eslint-disable-next-line react-hooks/exhaustive-deps
	}, [bottomTab, scenes, activeSceneId, cutoutLineage, meshLineage]);

	async function deleteUnusedAsset(id, expectedUsageCount, expectedGraphSignature) {
		if (deletingAssetId) return false;
		setDeletingAssetId(id);
		let db = null;
		let deleted = false;
		let graphConflict = false;
		try {
			db = await openAssetDb();
			const stored = await listAssetIds(db);
			const record = await getAsset(db, id);
			if (!record) {
				setToast(ko("That image is no longer in storage", "이 이미지는 이미 저장소에 없습니다"));
				return false;
			}
			// Rebuild this at the destructive boundary rather than trusting the
			// displayed list: a just-created cutout can make its image reachable.
			const { scenes: latestScenes, activeSceneId: latestActiveSceneId, sceneObjects: latestObjects } = projectStateRef.current;
			const allScenes = latestScenes.map((scene) => (scene.id === latestActiveSceneId ? { ...scene, objects: latestObjects } : scene));
			const currentUsageCount = assetUsageCounts(allScenes).get(id) ?? 0;
			const currentGraphSignature = assetGraphSignature(allScenes);
			if (expectedUsageCount !== undefined && (!Number.isInteger(expectedUsageCount) || expectedUsageCount !== currentUsageCount)) {
				setToast(ko("This image's usage changed, so it was not deleted. Please review it again.", "이 이미지의 사용량이 바뀌어서 삭제하지 않았어요. 다시 확인해 주세요."));
				return false;
			}
			if (expectedGraphSignature !== undefined && expectedGraphSignature !== currentGraphSignature) {
				setToast(ko("This image's scene references changed, so it was not deleted. Please review it again.", "이 이미지의 씬 참조가 변경되어 삭제하지 않았어요. 다시 확인해 주세요."));
				return false;
			}
			if (currentUsageCount > 0 && expectedUsageCount === undefined) {
				setToast(ko("That image is used by a scene and was not deleted", "이 이미지는 씬에서 사용 중이어서 삭제하지 않았어요"));
				return false;
			}
			if (currentUsageCount === 0 && !unreachableAssetIds(stored, allScenes).includes(id)) {
				setToast(ko("That image is now used by a scene and was not deleted", "이 이미지는 이제 씬에서 사용 중이어서 삭제하지 않았어요"));
				return false;
			}
			const authorizedGraph = expectedGraphSignature ?? currentGraphSignature;
			const committed = await deleteAssetWithGraphGuard({
				expectedGraphSignature: authorizedGraph,
				deleteRecord: () => deleteAsset(db, id),
				restoreRecord: () => putAsset(db, record),
				readGraphSignature: () => {
					const { scenes: afterScenes, activeSceneId: afterActiveSceneId, sceneObjects: afterObjects } = projectStateRef.current;
					const afterAllScenes = afterScenes.map((scene) => (scene.id === afterActiveSceneId ? { ...scene, objects: afterObjects } : scene));
					return assetGraphSignature(afterAllScenes);
				},
			});
			if (!committed) {
				graphConflict = true;
				setToast(ko("The scene changed while deleting, so the image was kept. Please review storage again.", "삭제하는 동안 씬이 변경되어 이미지를 보존했어요. 저장소를 다시 확인해 주세요."));
				return false;
			}
			evictAssetTexture(id);
			evictMeshScene(id);
			setAssetTrash((current) => [...current.filter((asset) => asset.id !== record.id), record]);
			setAssetUndoOffered(true);
			deleted = true;
			return true;
		} catch (error) {
			setToast(isKo ? `이미지를 삭제하지 못했어요 — ${error.message}` : `Could not delete that image — ${error.message}`);
			return false;
		} finally {
			db?.close?.();
			if (deleted || graphConflict) await refreshAssetShelf();
			setDeletingAssetId(null);
		}
	}

	async function undoDeletedAsset() {
		const record = assetTrash.at(-1);
		if (!record || deletingAssetId) return;
		setDeletingAssetId(record.id);
		let restored = false;
		try {
			if (isMeshAssetId(record.id) || isSupportedMeshType(record.type)) {
				await persistMeshAsset(record);
			} else {
				await rememberAsset(record);
			}
			setAssetTrash((current) => current.filter((asset) => asset.id !== record.id));
			setAssetUndoOffered(false);
			restored = true;
			setToast(isKo ? `${record.name || "이미지"} 복원됨` : `${record.name || "Image"} restored`);
		} catch (error) {
			setToast(isKo ? `이미지를 복원하지 못했어요 — ${error.message}` : `Could not restore that image — ${error.message}`);
		} finally {
			if (restored) await refreshAssetShelf();
			setDeletingAssetId(null);
		}
	}

	const ardyAbortRef = useRef(null);

	const renderActive = useRenderActivity(tlPlaying || movePlaying);
	 // the clip length on the production clock

	// Keep the imperative frame in step with the playhead for live playback;
	// the export overwrites it per captured frame and restores nothing, which
	// is correct — the next render puts it back.
	propFrameRef.current = tlFrame;
	// Routed records and everything grouped under them (object-travel.js).
	const animatedSceneObjects = useMemo(
		() => sceneObjectsAt(sceneObjects, tlFrame, { frameCount: tlFrameCount, fps: tlFps }),
		[sceneObjects, tlFrame, tlFrameCount, tlFps],
	);

	// Auto color: Blender's viewport "Random" mode. A DISPLAY-ONLY marker rides
	// each non-cutout object into the renderers; the authored `color`, the scene
	// document, undo history and the MCP view never change — toggling OFF makes
	// this list the animated list again, byte for byte. Meshes take the same
	// override as a cube: the renderer tints the visible material (file or clay).
	const [autoColor, setAutoColor] = useState(loadAutoColor);
	const displaySceneObjects = useMemo(() => {
		if (!autoColor) return animatedSceneObjects;
		return animatedSceneObjects.map((object) => {
			if (object.renderer === CUTOUT_KIND) return object;
			return { ...object, autoColor: autoColorHex(object.id) };
		});
	}, [animatedSceneObjects, autoColor]);
	const stageSceneObjects = useMemo(
		() => displaySceneObjects.filter((object) => !isEffectivelyHidden(object, sceneObjects, characters)),
		[displaySceneObjects, sceneObjects, characters],
	);

	/* ------------------------ carried props (attachment) ------------------- */
	// A prop attached to a character rides a LIVE frame in the scene graph, so
	// it tracks playback, scrubbing and the offscreen export — none of which
	// re-render React. The renderer resolves the frame through this ref on every
	// rendered frame; the App keeps it pointed at the mounted rigs. A ref, not a
	// prop value, so a fresh rig map never re-renders the set.
	const attachFrameRef = useRef(null);
	attachFrameRef.current = (characterId, bone, out) => attachFrameMatrix(rigs[characterId] ?? null, bone, out);
	// The recorder renders through gl.render() directly, which never runs the
	// r3f frame loop — so it asks the set for one placement pass itself, right
	// after it has written that frame's bones.
	const propSyncRef = useRef(null);
	// Characters grouped under a scene object ride it inside an ObjectCarrier.
	// The carriers read the AUTHORED records by id, and register a placement
	// pass the recorder runs before the props' (a prop carried on a riding
	// character's hand needs the carrier placed first).
	const carrierRegistryRef = useRef(new Set());
	const sceneObjectLookupRef = useRef(null);
	sceneObjectLookupRef.current = useMemo(() => new Map(sceneObjects.map((object) => [object.id, object])), [sceneObjects]);
	const syncCarriers = () => { for (const place of carrierRegistryRef.current) place(); };
	// Where a prop actually IS, read off its live group: the one authority on
	// the transform currently on screen, and so the only honest starting point
	// for a no-jump conversion.
	const propWorldRef = useRef(null);

	/**
	 * Hierarchy row drag policy (the panel holds none). An object row dropped on
	 * another object GROUPS; on a character or one of its bone rows it ATTACHES;
	 * on Props it comes back to the world. A character row dropped on an object
	 * row is GROUPED under it and rides its travel; dropped on the scene root it
	 * stands in the world again. Anything else is not a drop.
	 */
	function characterGroupMove(sourceRowId, targetRowId) {
		const characterId = charIdFromHierarchyId(sourceRowId);
		const entry = characterId ? characters.find((item) => item.id === characterId) : null;
		if (!entry) return null;
		if (targetRowId === "shot") return (entry.parent ?? null) !== null ? { characterId, parent: null } : null;
		const objectId = sceneObjectIdFromHierarchy(String(targetRowId ?? ""));
		const object = objectId ? sceneObjects.find((item) => item.id === objectId) : null;
		if (!object || object.attach || entry.parent === objectId) return null;
		return { characterId, parent: objectId };
	}
	const hierarchyReparent = {
		canDrop: (source, target) => (charIdFromHierarchyId(source)
			? characterGroupMove(source, target) !== null
			: objectsDomain.canReparentSceneObject(source, target)),
		onDrop: (source, target) => {
			if (!charIdFromHierarchyId(source)) return objectsDomain.reparentSceneObject(source, target);
			const move = characterGroupMove(source, target);
			if (move) runStudioAction("character.update", { characterId: move.characterId, patch: { parent: move.parent } });
		},
	};

	useEffect(() => {
		setCraneSelectedIndex(null);
	}, [activeShot?.id, craneActive]);

	const frameCountRef = useRef(DEFAULT_DURATION_S * TIMELINE_FPS);
	frameCountRef.current = tlFrameCount;

	/* ------------------------------ line editing ---------------------------
	 * Contract C6. A modal editing surface exactly like waypointMode above,
	 * but it works in SCREEN space on a 2D overlay canvas rather than raycast
	 * onto the floor — depth is the model's problem, not the UI's.
	 *
	 * TWO GESTURES, ONE CURVE. The primary interaction is TRAJECTORY DRAGGING:
	 * the joint's existing path is projected onto the viewport and the user
	 * grabs a point on it and pulls, with a Gaussian falloff carrying the
	 * neighbours along. A press that lands nowhere near the path instead DRAWS
	 * one freehand (drawStrokeEdit), because a trail can project into a few
	 * screen pixels — a person backing up and falling barely moves the hand
	 * across the image — and with nothing grabbable the whole mode reads as
	 * dead. Drawing is not the old freehand tool coming back, though: that one
	 * popped the take 8x its own frame delta at the range edges because the
	 * joint teleported to wherever the stroke began (gate GP2). A stroke here is
	 * MATCHED BACK ONTO THE TRAIL — its endpoints pick the frames it was drawn
	 * over, and those frames become the edit's range — so it reroutes the stretch
	 * of path it covers, replays it with that stretch's own velocity profile, and
	 * eases out of the original trajectory at both seams. See the block comment
	 * above matchStrokeWindow in line-edit.js for why all three are one decision.
	 * A drag pins its ends instead (its Gaussian already eases), and both
	 * gestures produce the SAME dense frame-indexed curve, so everything
	 * downstream (preview, undo, camera drift, the wire payload) cannot tell them
	 * apart — except that a drawn curve also carries the `frameRange` it chose.
	 *
	 * `lineCurve` is non-null EXACTLY WHEN THERE IS AN EDIT, and that invariant
	 * is the whole camera policy in one sentence. Null means the curve is
	 * re-projected from the LIVE camera on every repaint, so orbiting the view
	 * carries the path along and navigation never fights the mode. Non-null is
	 * `{ camera, original, edited }` — one object, because a pull is a 2D offset
	 * that only means something through the lens it was authored with, so the
	 * camera is frozen beside the points and travels with them onto the wire.
	 * Moving the view therefore does NOT drop the pull; it only stops the line
	 * being drawable here (see lineDrifted just below, and the watcher further
	 * down).
	 *
	 * The four refs never re-render: `lineDragRef` is the in-flight grab and
	 * carries the live deformed curve, `lineDrawRef` is the in-flight freehand
	 * stroke, `lineLiveRef` caches the last projection the painter made so the
	 * hit test does not redo it, and `lineHoverRef` is the marker under the
	 * pointer. A pointermove must repaint the overlay
	 * without re-rendering an 11k-line component 200 times a second, so the
	 * painter reads the refs and only pointerup commits to state. */
	const [lineEditMode, setLineEditMode] = useState(false);
	const [lineTrack, setLineTrack] = useState(LINE_EDIT_DEFAULT_TRACK);
	// null means "the whole clip" — resolved against the loaded take at use
	// time so loading a different clip cannot leave a stale range behind.
	const [lineRange, setLineRange] = useState(null);
	const [lineCurve, setLineCurve] = useState(null);
	/* THE VIEW HAS MOVED, AND THE EDIT IS STILL HERE.
	 *
	 * A committed curve carries its OWN camera (the `{ camera, original, edited }`
	 * above), and buildLineEditRequest sends that snapshot — so a later orbit,
	 * fly or shot switch cannot invalidate the pending edit, its preview or the
	 * confirming run. What it invalidates is only the ALIGNMENT of the painted
	 * overlay: the uv were authored through one lens, there is no depth to
	 * reproject them with, and drawing them over a different view would put the
	 * line somewhere the artist never aimed. So drift is a PRESENTATION state,
	 * not a destruction trigger — the curve is painted detached (ghosted, no
	 * grab handles), the panel says so, and a NEW gesture is refused because it
	 * would mix two cameras into one curve. Come back toward the snapshot and the
	 * line paints normally again.
	 *
	 * The ref is what the pointer handlers and the painter read (a poll is 250 ms
	 * stale and a press must not be); the state is what re-renders the panel. */
	const [lineDrifted, setLineDrifted] = useState(false);
	const lineDriftRef = useRef(false);
	/* ------------------------------ 3D pins --------------------------------
	 * The THIRD gesture: scrub to a moment, grab the joint where it is, put it
	 * where it should be. Entries are `{ frame, position: [x, y, z] }` in the
	 * TAKE's own clip space (worldPointToClip converts on commit), ascending by
	 * frame, capped at LINE_EDIT_PINS_MAX — exactly the C6 `pins3d` payload, so
	 * the panel state and the wire object are the same value.
	 *
	 * ONE EDIT IS ONE GESTURE (v1). A pin clears the curve and a stroke or drag
	 * clears the pins, because a 2D path and a set of 3D points are two answers
	 * to "where does this joint go" and the box would be asked to average them.
	 * Combining them is a real feature (pin the extremes, draw the arc between)
	 * and it needs a story about which one owns a frame they both name — that
	 * story is not written, so the modes are exclusive and say so.
	 *
	 * `linePinMode` is the stage's gesture selector rather than a modifier key:
	 * pressing on the joint's own marker is ALSO how a curve drag starts, so the
	 * two cannot share a press, and a modal toggle beside the joint picker is
	 * discoverable in a way a chord is not. */
	const [linePins, setLinePins] = useState([]);
	const [linePinMode, setLinePinMode] = useState(false);
	// The in-flight pin drag. Same no-re-render discipline as lineDragRef: a
	// pointermove writes the ref and repaints the overlay, only pointerup
	// commits to state.
	const linePinDragRef = useRef(null);
	const [lineRadius, setLineRadius] = useState(DRAG_RADIUS_DEFAULT);
	const lineDragRef = useRef(null);
	// The in-flight freehand STROKE, when the press missed the curve. Same
	// no-re-render discipline as lineDragRef: pointermove appends a uv sample and
	// repaints the overlay, and only pointerup turns the stroke into a curve (via
	// strokeToCurve) and commits it through the drag's own pipeline.
	const lineDrawRef = useRef(null);
	// The range a DRAW just auto-matched into the panel. "Switching the range
	// drops the pull in hand" is the right rule for a range the ARTIST typed —
	// the pull was authored against a trajectory that is no longer on screen —
	// but a drawn stroke authors its range and its curve in the same gesture,
	// and letting that rule fire on the range the draw itself installed would
	// wipe the drawing on commit and cancel its preview. One-shot: the effect
	// consumes it.
	const lineAutoRangeRef = useRef(null);
	const lineLiveRef = useRef(null);
	const lineHoverRef = useRef(null);
	// Undo stack for committed pulls: each entry is the WHOLE lineCurve value
	// that a commit replaced (null = "no edit yet"), so Ctrl/Cmd+Z is a plain
	// pop-and-restore. A camera move no longer touches it: an edit survives the
	// view moving, so the pulls behind it are still meaningful too, and undo is
	// one of the three things (with reset and Generate) that must keep working
	// while the view has drifted away from the line.
	const lineUndoRef = useRef([]);
	const lineOverlayRef = useRef(null);

	/* ------------------ live preview of a pull (contracts C10/C11) ------------
	 * Releasing the drag fires a FULL-QUALITY run of the same edit (same steps
	 * and session seed as Generate, ~2 s on the warm resident, so the draft and
	 * the confirmed take are bit-identical) and swaps the VIEWPORT to it, so
	 * the artist judges the correction by watching it move instead of by
	 * reading a curve. Three rules make that honest:
	 *
	 *   1. A PREVIEW IS A PICTURE, NOT A TAKE. It never pushes a version, never
	 *      touches the recipe and never becomes anyone's sourceMotion. The take
	 *      being edited is `takeSourceUrl` — remembered here the moment a
	 *      preview starts — and `motion.url` is merely what is on screen.
	 *   2. ONE SEED PER EDITING SESSION. A draft rendered with a different seed
	 *      predicts nothing, so the seed is rolled once (first preview or the
	 *      confirming run, whichever comes first), reused by every preview, SENT
	 *      by the full-quality run, and only then re-rolled. A typed seed is
	 *      already constant, so the rule costs nothing there.
	 *   3. SUPERSEDE, NEVER STACK. At most one request is in flight; a drag
	 *      that lands while one is out replaces the pending curve, and the older
	 *      answer is dropped on arrival. Queueing them would make the viewport
	 *      replay a history the artist has already moved past.
	 *
	 * Undo, reset and leaving the mode all revert the viewport to the source take
	 * and discard whatever is in flight. A CAMERA MOVE does not: the draft is a
	 * picture of an edit that survives the view moving, so it stays on screen and
	 * stays confirmable. */
	const [linePreviewSource, setLinePreviewSource] = useState(null);
	const linePreviewSourceRef = useRef(null);
	// The preview motionUrl currently ON SCREEN — null means the source take is.
	const [linePreviewUrl, setLinePreviewUrl] = useState(null);
	const [linePreviewBusy, setLinePreviewBusy] = useState(false);
	const [linePreviewError, setLinePreviewError] = useState("");
	// Round trip of the last preview, in ms. Surfaced because "is this loop
	// actually live?" is the question the number answers in one glance.
	const [linePreviewMs, setLinePreviewMs] = useState(0);
	const linePreviewSeedRef = useRef(null);
	// Monotonic: a result whose token is stale was superseded or cancelled, and
	// is discarded without ever reaching the viewport.
	const linePreviewTokenRef = useRef(0);
	const linePreviewAbortRef = useRef(null);
	const linePreviewPendingRef = useRef(null);
	const linePreviewTimerRef = useRef(0);
	// The draft that actually REACHED the viewport, so a cancel knows whether
	// there is anything to put back.
	const linePreviewShownRef = useRef(null);
	useEffect(castDomain.removeLegacyRootWaypoint, []);

	// Shot trims also trim their local Rail Follow card once. Growing a shot
	// later never resurrects time that the editor already cut away.
	useEffect(shotsDomain.clampShotRailRanges, [tlFrameCount, shots.map((shot) => shot.startFrame).join(":")]);

	/* --------------------------- Scene documents --------------------------- */
	// Refs make a Scene switch synchronous: the outgoing room is sealed with
	// its latest objects and camera department envelope before React opens the
	// destination room.
	const activeSceneIdRef = useRef(activeSceneId);
	const shotDocumentRef = useRef(null);
	const actorStageRef = useRef(null);
	appContext.publishScenes(scenes);
	activeSceneIdRef.current = activeSceneId;
	shotDocumentRef.current = createShotAuthoringDocument({ shots, waypoints, frameCount: tlFrameCount });
	actorStageRef.current = {
		// sessionMotion is stripped: generated clips are session-only and far
		// too heavy for the stage envelope; paths and prompt blocks persist.
		characters: characters.map(({ sessionMotion, ...entry }) => entry),
		hasCharSheet,
		environmentImage,
		shotAspect: shotAspectKey,
		cameraPresetId,
		sensorId,
		keyLight,
		// What this location IS and how it should look. Session state until #345:
		// a reopened scene came back with another room's description.
		environment,
		style,
		hasEnvSheet,
	};

	const [firstSuccessGuideOpen, setFirstSuccessGuideOpen] = useState(false);
	const [useCaseAskOpen, setUseCaseAskOpen] = useState(false);

	// Dismissal mirrors the inspector-actions menu: only listen while open,
	// ignore presses inside the wrap (the trigger's own click keeps toggling),
	// close on any outside pointerdown or Escape, and tear down on close.
	useEffect(() => {
		if (!projectMenuOpen) return undefined;
		const onPointerDown = (event) => {
			if (event.target instanceof Element && event.target.closest(".project-menu-wrap")) return;
			setProjectMenuOpen(false);
		};
		const onKeyDown = (event) => {
			if (event.key === "Escape") setProjectMenuOpen(false);
		};
		document.addEventListener("pointerdown", onPointerDown);
		window.addEventListener("keydown", onKeyDown);
		return () => {
			document.removeEventListener("pointerdown", onPointerDown);
			window.removeEventListener("keydown", onKeyDown);
		};
	}, [projectMenuOpen]);
	// The PlayView reference-export menu (#165) dismisses the same way.
	const [exportMenuOpen, setExportMenuOpen] = useState(false);
	const [exportMenuAnchor, setExportMenuAnchor] = useState({ top: 0, right: 0 });
	useEffect(() => {
		if (!exportMenuOpen) return undefined;
		if (exportShotIdRef.current) document.querySelector('[data-testid="export-video"]')?.focus();
		const onPointerDown = (event) => {
			if (event.target instanceof Element && event.target.closest(".export-menu-wrap")) return;
			exportShotIdRef.current = null;
			setExportMenuOpen(false);
		};
		const onKeyDown = (event) => {
			if (event.key === "Escape") {
				exportShotIdRef.current = null;
				setExportMenuOpen(false);
				exportMenuTriggerRef.current?.focus();
			}
		};
		document.addEventListener("pointerdown", onPointerDown);
		window.addEventListener("keydown", onKeyDown);
		return () => {
			document.removeEventListener("pointerdown", onPointerDown);
			window.removeEventListener("keydown", onKeyDown);
		};
	}, [exportMenuOpen]);
	// `View ▾` on the viewport bar (#194): one home for the display-only
	// toggles that used to be scattered across the topbar, the scene bar and
	// the inspector. Same dismissal as the two menus above, plus focus
	// returning to the trigger on Escape — the bar is a keyboard stop.
	const [viewMenuOpen, setViewMenuOpen] = useState(false);
	const [viewMenuAnchor, setViewMenuAnchor] = useState({ top: 0, right: 0 });
	const viewMenuTriggerRef = useRef(null);
	useEffect(() => {
		if (!viewMenuOpen) return undefined;
		const onPointerDown = (event) => {
			if (event.target instanceof Element && event.target.closest(".view-menu-wrap")) return;
			setViewMenuOpen(false);
		};
		const onKeyDown = (event) => {
			if (event.key !== "Escape") return;
			setViewMenuOpen(false);
			viewMenuTriggerRef.current?.focus();
		};
		document.addEventListener("pointerdown", onPointerDown);
		window.addEventListener("keydown", onKeyDown);
		return () => {
			document.removeEventListener("pointerdown", onPointerDown);
			window.removeEventListener("keydown", onKeyDown);
		};
	}, [viewMenuOpen]);
	// The agent panel keeps owning its own collapsed flag (the rail button and
	// Cmd/Ctrl+B both live inside it); the studio only mirrors the flag so the
	// View ▾ item can render a checkmark. It boots collapsed here: the studio
	// opens on the stage, not on a chat column.
	const [agentCollapsed, setAgentCollapsed] = useState(true);
	// Studio Agent is an Inspector peer, not an additional dock. Keeping this
	// host-owned flag separate from the Workflow dock preserves the latter's
	// session and layout while Cmd/Ctrl+B switches the existing Inspector row.
	const studioAgentMode = !agentCollapsed;
	const setStudioAgentMode = (enabled) => setAgentCollapsed(!enabled);
	const studioDocumentEpochRef = useRef(crypto.randomUUID());
	const studioSceneEpochRef = useRef(crypto.randomUUID());
	// The one Studio action registry, built from the command modules
	// (src/commands), and the one generic port object they register over. Every
	// render refreshes the port members in place, so a run always reaches the
	// latest handlers; the UI controls and run_action share both.
	const studioActionsRef = useRef(null);
	const renderWaitersRef = useRef([]);
	const studioHistoryRef = useRef(new Map());
	const studioActionGroupRef = useRef(null);
	const studioIkStampsRef = useRef(new Map());
	const [studioAgentError, setStudioAgentError] = useState(null);
	// A receipt already names the entities it changed. Showing that only as a
	// card at the bottom of the chat leaves the author hunting for what moved,
	// so the hierarchy rows the receipt names light up where they already are
	// and the first one scrolls into view. The chat card stays: one is the
	// record, the other is the pointer.
	const [agentTouchedRows, setAgentTouchedRows] = useState([]);
	const agentTouchTimerRef = useRef(null);
	useEffect(() => () => clearTimeout(agentTouchTimerRef.current), []);
	const hierarchyRowsForAgentTarget = (targetId) => {
		const castIndex = appContext.live.characters.findIndex((entry) => entry.id === targetId);
		if (castIndex !== -1) return [rowIdForCharIndex(castIndex)];
		if (storeRef.current.objects.some((object) => object.id === targetId)) return [`object:${targetId}`];
		// A stage edit is addressed by the scene itself; the rows it can change
		// are the stage's own.
		if (targetId === activeSceneIdRef.current) return ["light", "environment"];
		return [];
	};
	const highlightAgentTargets = (receipt) => {
		const rows = [...new Set((receipt?.affectedIds ?? []).flatMap(hierarchyRowsForAgentTarget))];
		if (!rows.length) return;
		clearTimeout(agentTouchTimerRef.current);
		setAgentTouchedRows(rows);
		agentTouchTimerRef.current = setTimeout(() => setAgentTouchedRows([]), AGENT_RECEIPT_HIGHLIGHT_MS);
	};
	const buildStudioAgentContext = () => {
		if (!liveWorkspaceHandleRef.current) {
			setStudioAgentError(ko("The live editor is disconnected. Reconnect before sending.", "라이브 편집기가 연결되지 않았어요. 연결 후 보내 주세요."));
			return null;
		}
		try { const value = studioBindingRef.current.context(); setStudioAgentError(null); return value; }
		catch (error) { setStudioAgentError(`${error.code ?? "INVALID_CONTEXT"}: ${error.message}`); return null; }
	};
	useEffect(() => {
		if (embedMode) return;
		const toggle = () => setAgentCollapsed(value => !value);
		const key = event => {
			if ((event.metaKey || event.ctrlKey) && event.code === "KeyB") { event.preventDefault(); toggle(); }
		};
		window.addEventListener("cozyclay:agent-panel-toggle", toggle);
		window.addEventListener("keydown", key);
		return () => { window.removeEventListener("cozyclay:agent-panel-toggle", toggle); window.removeEventListener("keydown", key); };
	}, [embedMode]);
	const projectHandleRef = useRef(null);
	const projectMotionsRef = useRef(new Map());
	// Loaded clips keep the same Uint8Array identity while they remain active.
	// Reuse the expensive encoded record until a new byte buffer is supplied.
	const motionEncodingCacheRef = useRef(new WeakMap());
	const restoreEpochRef = useRef(0);

	const projectSnapshotRef = useRef("");
	const projectStateRef = useRef(null);
	projectStateRef.current = { workspaceLayout, customPoses, scenes, activeSceneId, sceneObjects };

	useEffect(() => {
		const onStorage = (event) => {
			if (event.key === WORKFLOW_STORAGE_KEY) setWorkflowRevision((value) => value + 1);
		};
		const onWorkflowChange = () => setWorkflowRevision((value) => value + 1);
		window.addEventListener("storage", onStorage);
		window.addEventListener("cozyclay:workflow-change", onWorkflowChange);
		return () => {
			window.removeEventListener("storage", onStorage);
			window.removeEventListener("cozyclay:workflow-change", onWorkflowChange);
		};
	}, []);

	const tutorialInitialSnapshotRef = useRef(null);
	if (tutorialInitialSnapshotRef.current === null) tutorialInitialSnapshotRef.current = collectProjectSnapshot("Tutorial");

	playgroundExportRef.current = collectProjectSerialized;

	function closeCameraTutorial(reason = null) {
		const terminal = reason ?? (cameraTutorialCompletedRef.current ? "completed" : "dismissed");
		rememberCameraTutorialTerminal(terminal);
		tutorialProjectEpochRef.current += 1;
		setTutorialSeedPending(false);
		cameraTutorialHandoff?.dismiss();
		setCameraTutorialHandoff(null);
		cameraTutorialAnalytics.current?.dismiss();
		cameraTutorialAnalytics.current = null;
		cameraTutorialCompletedRef.current = false;
		setCameraTutorial(false);
		setCameraTutorialStep(null);
	}

	function openExportMenuForShot(shotId) {
		const target = shots.find((entry) => entry.id === shotId);
		if (!target) return;
		exportShotIdRef.current = target.id;
		const trigger = exportMenuTriggerRef.current;
		if (trigger) {
			const box = trigger.getBoundingClientRect();
			const menuWidth = Math.min(340, window.innerWidth - 16);
			setExportMenuAnchor({
				top: box.bottom + 6,
				right: Math.min(Math.max(8, window.innerWidth - box.right), Math.max(8, window.innerWidth - menuWidth - 8)),
			});
		}
		setExportMenuOpen(true);
		cameraTutorialHandoff?.dismiss();
		setCameraTutorialHandoff(null);
	}

	/** The camera tutorial's single entry (#209), for both /app/?tutorial=camera
	 * and the Settings ▾ item.
	 *
	 * The seven steps teach Shot / Rail / Play, which need a set and somebody
	 * moving through it. On cozyclay.org they get both for free: the landing
	 * playground opens the city-block starter and the hosted-demo seed below
	 * loads the walk take because a statically served build has no motion
	 * bridge. A local session HAS a bridge, so that seed is skipped and the
	 * tutorial used to open on whatever was loaded — usually an empty room.
	 * This puts the studio in the landing page's state explicitly. */
	async function startCameraTutorial({ source = "settings" } = {}) {
		if (embedMode || playgroundMode || tutorialLoadingRef.current) return;
		// QA hook, same spirit as window.__cozyclayRenders: which door the tutorial
		// came in by, so a headless run can prove both of them land here.
		window.__cozyclayTutorialSource = source;
		// Only a pristine, newly created document receives the sample. An
		// existing project (even unnamed), or a restart, keeps all current work.
		const seed = !tutorialStarterRef.current && startupCreatedScene && projectName === null
			&& !projectDirty && !cameraTutorialSuppressed()
			&& tutorialInitialSnapshotRef.current === collectProjectSnapshot("Tutorial");
		if (seed) {
			tutorialLoadingRef.current = true;
			demoSeeded.current = true;
			try {
				const opened = await openStarterScene("city-block", "tutorial");
				if (opened) {
					tutorialStarterRef.current = true;
					tutorialSeedEpochRef.current = tutorialProjectEpochRef.current;
					setTutorialSeedPending(true);
					exitPreview();
					setTlFrame(0);
				}
			} finally {
				tutorialLoadingRef.current = false;
			}
		}
		setProjectStartupOpen(false);
		setFirstSuccessGuideOpen(false);
		setCameraTutorialHandoff(createFirstShotHandoff());
		// Explicit start, including while already open, resets the existing
		// done/walked component state. Passive renders never create an attempt.
		cameraTutorialAnalytics.current = createTutorialAnalytics({ surface: "studio", startSource: source });
		setCameraTutorialAttempt((attempt) => attempt + 1);
		setCameraTutorial(true);
		cameraTutorialCompletedRef.current = false;
	}
	startCameraTutorialRef.current = startCameraTutorial;

	const starterOpened = useRef(false);
	useEffect(() => {
		if (starterOpened.current || playgroundMode) return;
		const requested = new URLSearchParams(globalThis.location?.search || "").get("scene");
		if (!requested) return;
		starterOpened.current = true;
		void openStarterScene(requested, "launch");
		// eslint-disable-next-line react-hooks/exhaustive-deps
	}, []);

	// Re-open the last project on launch when the browser still grants access.
	// A handle Chromium demoted to "prompt" cannot be re-requested here (no
	// user gesture), so it becomes a one-click restore offer instead (#51).
	const projectAutoOpenedRef = useRef(false);

	useEffect(() => {
		if (projectAutoOpenedRef.current) return;
		projectAutoOpenedRef.current = true;
		loadStoredProjectHandle().then(async (record) => {
			if (!record?.handle) return;
			const permission = await queryHandlePermission(record.handle);
			if (permission === "granted") {
				await restoreStoredProject(record);
				return;
			}
			if (permission === "prompt") setRestoreOffer(record);
		});
		// eslint-disable-next-line react-hooks/exhaustive-deps
	}, []);

	// Workflow runs in a separate tab/route. Scene writes therefore arrive as
	// either a same-tab CustomEvent or a cross-tab storage event. Keep the
	// Studio's live editor in sync without writing the event back in a loop:
	// compare against the current snapshot first, then replace only the active
	// scene's objects/cast or open the newly selected scene.
	const externalSceneApplyRef = useRef(null);
	externalSceneApplyRef.current = scenesDomain.applyExternalScene;
	useEffect(() => subscribeToSceneDocuments((document) => externalSceneApplyRef.current?.(document)), []);
	useEffect(() => subscribeToScenePlayback((command) => {
		if (command?.activeSceneId && command.activeSceneId !== activeSceneIdRef.current) return;
		if (Number.isFinite(Number(command?.frame))) {
			setTlFrame((frame) => Math.max(0, Math.min(Math.round(Number(command.frame)), Math.max(0, frameCountRef.current - 1))));
		}
		if (typeof command?.playing === "boolean") {
			cameraPreviewEndRef.current = null;
			manualCameraOverrideRef.current = false;
			setTlPlaying(command.playing);
		}
	}), []);
	// The Workflow Scene node's frame slider used to guess the take length, so
	// its own preview clock ran on past the end of a shorter shot (#218). The
	// embed announces the take it actually holds — on load and whenever the
	// scene or its length changes — and the node follows it.
	useEffect(() => {
		if (!embedMode) return;
		window.parent.postMessage({ type: "cozyclay:scene-timeline", activeSceneId, frameCount: tlFrameCount, fps: tlFps }, "*");
	}, [embedMode, activeSceneId, tlFrameCount, tlFps]);

	// Commands are a sequential transport boundary, while React commits on a
	// later turn. Keep its read model current synchronously so the next frame
	// observes the mutation that the previous frame just acknowledged.
	appContext.publishLive({
		scenes,
		activeSceneId,
		camera: cameraPos,
		fovDeg,
		filmback,
		// keyLight rides the live stage envelope: it is authored, undoable and
		// patchable state, so every reader sees the body the save path writes.
		stage: { shotAspect: shotAspectKey, cameraPresetId, sensorId, hasCharSheet, environmentImage, environment, style, hasEnvSheet, keyLight },
		timeline: { currentFrame: tlFrame, frameCount: tlFrameCount, fps: tlFps },
		activeCharacterId,
		partColours: partColoursEnabled ? PART_COLOURS : null,
		waypoints,
		characters,
		objects: sceneObjects,
		rigs,
		commitManualCameraFraming,
		removeCharacter,
		persistScenes,
		openScene,
		loadMotion,
		// The framing-capture pair the agent commands call. Both are per-render
		// closures (captureFramingPng sizes its canvas off the render's own
		// shotOutput), so the ref must always hold THIS render's instance — a
		// stale one would letterbox a pull taken after the shot aspect changed.
		activeShotId: activeShot?.id ?? null,
		captureCurrentFraming,
		captureFramingPng,
		captureShotMeta,
		// The identity / environment reference pictures a capture carries (#167).
		captureShotReferences,
		// Reference exports (#165): the embed message handler and the QA hooks
		// both go through this render's closures, so a pack always describes the
		// cut as it stands now.
		buildShotKeyframePack,
		shotIndexForPack,
		renderPassDataUrls,
		exportShotVideo,
		generate,
		shots,
	});
	const liveQueries = {
		ping: () => ({ pong: true }),
		describe: () => {
			const live = appContext.live.state;
			return {
				document: {
					version: SCENES_VERSION,
					activeSceneId: activeSceneIdRef.current,
					scenes: snapshotActiveScene(),
				},
				sceneName: live.scenes.find((scene) => scene.id === live.activeSceneId)?.name ?? "",
				camera: {
					...live.camera,
					focalMm: Math.round(fovToFocalMm(
						(live.fovDeg * Math.PI) / 180,
						live.filmback.sensorId,
						live.filmback.aspectRatio,
					) * 100) / 100,
					sensorId: live.filmback.sensorId,
					aspectRatio: live.filmback.aspectRatio,
				},
				stage: live.stage,
				previsMode: scenesDomain.metadata().previsMode,
				timeline: live.timeline,
				activeCharacterId: live.activeCharacterId,
				characters: castDomain.read(),
				objects: objectsDomain.read(),
			};
		},
		capture_frame: async () => {
				const live = appContext.live.state;
				return captureMcpFrame({
					partColours: live.partColours,
					capture: mcpCaptureRef.current,
					camera: shotCamRef.current,
					characters: live.characters,
					activeCharacterId: live.activeCharacterId,
					objects: live.objects,
					rigs: live.rigs,
					readAuthoredState: () => ({
						scenes: appContext.live.state.scenes,
						activeSceneId: appContext.live.state.activeSceneId,
						camera: appContext.live.state.camera,
						fovDeg: appContext.live.state.fovDeg,
						filmback: appContext.live.state.filmback,
						stage: appContext.live.state.stage,
						timeline: appContext.live.state.timeline,
						activeCharacterId: appContext.live.state.activeCharacterId,
						waypoints: appContext.live.state.waypoints,
						characters: appContext.live.state.characters,
						objects: appContext.live.state.objects,
					}),
				});
			},
			// The full-resolution shot-camera pull the editor's own exports use —
		// not capture_frame's 640x360 preview, which stays exactly as it is.
			capture_framing_png: (args = {}) => {
				const live = appContext.live.state;
				const requested = args?.output;
				const output = Number.isFinite(requested?.width) && Number.isFinite(requested?.height)
					? { width: Math.round(requested.width), height: Math.round(requested.height) }
					: SHOT_ASPECT_PRESETS[live.stage.shotAspect] ?? SHOT_ASPECT_PRESETS["16:9"];
				const dataUrl = live.captureFramingPng(live.captureCurrentFraming(), output);
				if (!dataUrl) throw new Error("The shot renderer is not ready");
				return {
					dataUrl,
					width: output.width,
					height: output.height,
					frame: live.timeline.currentFrame,
					shotId: live.activeShotId,
					partColours: live.partColours,
					// The production notes the PNG cannot carry: lens, delivery
					// aspect, cast and the video model this shot is aimed at.
					meta: live.captureShotMeta(live.timeline.currentFrame),
					// Identity sheets per cast member plus the environment reference.
					references: live.captureShotReferences(),
				};
			},
	};

	useEffect(() => {
		const enabled = import.meta.env.DEV || window.__COZYCLAY_LIVE__ === true;
		if (!enabled) return undefined;
		// StrictMode replays effects in development. Delaying the open lets the
		// replay cleanup cancel its first pass, so one tab owns one socket.
		const timer = setTimeout(() => {
			if (!liveControlRef.current) {
				liveControlRef.current = createLiveControl({
					handlers: { ...liveQueries, ...studioBindingRef.current.handlers },
					workspaceId: liveWorkspaceIdRef.current,
					meta: {
						project: projectName ?? "Untitled",
						scene: scenes.find((entry) => entry.id === activeSceneId)?.name ?? "",
						cast: appContext.live.characters.length,
						// The Workflow page embeds this same Studio as a preview. It is a
						// live editor too, so an agent choosing a workspace must be able to
						// tell the preview apart from the tab the user is authoring in.
						...(embedMode ? { embed: true } : {}),
						// Which live commands this editor answers. A stale tab from an
						// older build (or a different app on the same port) answers a
						// different set; the agent picks a workspace that has what it needs.
						commands: [...Object.keys(liveQueries), ...Object.keys(studioBindingRef.current.handlers)],
					},
					// The shared client intentionally has no disconnect UI callback.
					// Observe only this owned socket; a stale handle must never be sent.
					WebSocketImpl: class extends WebSocket {
						constructor(url) {
							super(url);
							this.addEventListener("close", () => {
								liveWorkspaceHandleRef.current = null;
								setLiveWorkspaceHandle(null);
							});
						}
					},
					onWorkspace: (handle) => {
						liveWorkspaceHandleRef.current = handle;
						setLiveWorkspaceHandle(handle);
					},
					// Duplicating a tab copies its sessionStorage, so both tabs claim one
					// id and the hub refuses the second. Take a fresh id for this tab.
					onDuplicate: () => {
						const minted = mintLiveWorkspaceId();
						liveWorkspaceIdRef.current = minted;
						return minted;
					},
					onEvent: (name, payload) => {
						if (name !== "motion_job" || typeof payload.taskId !== "string") return;
						if (["failed", "cancelled", "expired"].includes(payload.status)) {
							setToast(payload.outcome?.message ?? `Motion job ${payload.status}.`);
						}
					},
				});
			}
		}, 0);
		return () => {
			clearTimeout(timer);
			liveControlRef.current?.close();
			liveControlRef.current = null;
			liveWorkspaceHandleRef.current = null;
			setLiveWorkspaceHandle(null);
		};
	}, []);

	// One debounced Scene-document save owns both departments. Switching calls
	// persistScenes directly, so no outgoing edit can be overtaken by a render.
	useEffect(() => {
		dirtyRef.current = true;
		const timer = setTimeout(flushScenes, 400);
		return () => clearTimeout(timer);
	}, [sceneObjects, shots, waypoints, tlFrameCount, charA, charB, showB, poseA, poseB, hasCharSheet, environmentImage, environment, style, hasEnvSheet, subject, subject2, shotAspectKey, sensorId, keyLight, scenes, activeSceneId]);
	useEffect(() => {
		const onPageHide = () => flushScenes();
		const onVisibility = () => {
			if (document.visibilityState === "hidden") flushScenes();
		};
		window.addEventListener("pagehide", onPageHide);
		document.addEventListener("visibilitychange", onVisibility);
		return () => {
			window.removeEventListener("pagehide", onPageHide);
			document.removeEventListener("visibilitychange", onVisibility);
			flushScenes();
		};
	}, []);

	// These hooks are declared after the liveStateRef assignment above runs, so
	// they join the live read model here — same render, no TDZ.
	appContext.patchLive({ promptClips, setPromptClips, editPromptClips, setTlFrameCount });

	// Dirty tracking: any divergence from the last saved file lights the dot.
	useEffect(scenesDomain.refreshProjectDirty, [scenes, activeSceneId, workspaceLayout, customPoses, characters, shots, waypoints, promptClips, projectName, keyLight, sceneObjects, shotAspectKey, environmentImage, environment, style, hasEnvSheet, sensorId, tlFrameCount, workflowRevision]);

	// The untrimmed take per CHARACTER. Trims are non-destructive views of the
	// full take, so re-trimming and "restore full" always cut from the
	// original — and because each cast member owns its own layer, one shared
	// ref would hand Subject 2's take to Subject 1 on the next switch.
	const motionFullRef = useRef(new Map()); // charId -> untrimmed take

	// Which ik tracks a preserve run would name in its editRanges, derived the
	// same way runArdy derives them: the prompt-block schedule, the blocks that
	// contain authored IK keys, the tracks keyed inside those blocks. The blocks
	// TILE 0..clipFrames, so the union over the edited ones is just the union
	// over the whole clip — blocks without keys contribute nothing either way.
	// Empty means the request carries no `tracks` at all and the panel says
	// nothing extra. Regenerating a take is the only clock that matters here, so
	// clipFrames comes from the loaded take exactly as runArdy takes it.
	const preserveEditedTracks = useMemo(() => {
		if (!motion?.url || ikFrames.length === 0) return [];
		const sourcePromptClips = promptClips
			.filter((clip) => clip.text.trim())
			.sort((a, b) => a.startFrame - b.startFrame);
		if (sourcePromptClips.length === 0) return [];
		const clipFrames = (motion.frames / motion.fps) * TIMELINE_FPS;
		// A single block spanning the whole take is not a schedule, and without a
		// schedule there are no edited blocks to attribute (runArdy's own rule).
		if (buildPromptSchedule(sourcePromptClips, clipFrames, sourcePromptClips[0].text).length < 2) return [];
		return ikTracksInRange(ikStateRef.current, ikFrames, 0, clipFrames);
	}, [motion, promptClips, ikFrames]);
	const preserveTracksLine = preserveTracksSummary(preserveEditedTracks);

	const multiModelFileRef = useRef(null);
	const multiModelRunRef = useRef(0);
	const multiModelObjectUrlRef = useRef(null);

	 // idle | running | done | error

	const photoPoseFileRef = useRef(null);

	// Cast render props, memoized with Character itself (React.memo): during
	// playback the playhead ticks 24 times a second, and a character whose
	// props did not change must not re-render its subtree.
	const characterViews = useMemo(() => characters.flatMap((entry, index) => {
		if (entry.hidden) return [];
		const pickId = index === 0 ? "A" : index === 1 ? "B" : entry.id;
		// Each cast member is driven by ITS OWN clip: the active one reads
		// the editing buffer, the others their stored session motion.
		const clip = entry.id === activeChar.id ? motion : entry.sessionMotion;
		const placement = (entry.model === "proxy-figure" || !clip) && typeof resolveCharacterPlacement === "function" ? resolveCharacterPlacement(entry, tlFrame, {
			shotAt: frame => shotAtFrame(shots, frame),
			takeRoot: clip ? sampleAt({ frameCount: clip.frames, motion: clip }, null, tlFrame).subject : null,
		}) : entry;
		return [{
			id: entry.id,
			model: entry.model,
			...(entry.model === "proxy-figure" ? {} : { url: characterModelUrl(entry.model) }),
			position: [placement.x, entry.y ?? 0, placement.z],
			rot: placement.rot,
			tint: entry.tint ?? defaultCharacterTint(entry, index),
			partColoursEnabled,
			partColoursMode,
			pose: clip ? null : (placement.pose ?? DEFAULT_POSE),
			posture: placement.posture,
			// The stature the entry's take was extracted at. It rides with the
			// clip, never separately — see Character for why.
			scale: entry.scale ?? 1,
			...(entry.model === "proxy-figure" ? {} : { onRig: reportRig(entry.id) }),
			pickId,
			parent: entry.parent ?? null,
			...(entry.model === "proxy-figure" ? {
				position: [placement.x, entry.y ?? 0, placement.z],
				rot: placement.rot,
			} : {}),
		}];
	}), [characters, activeChar.id, motion, shots, tlFrame, partColoursEnabled, partColoursMode]);
	// Where the selection gizmo stands: same driving rules as the render,
	// for the active (selected) cast member only. Gated on the HIERARCHY
	// selection, not the sticky active layer — the layer stays on the last
	// character so the motion tab keeps working, but a move gizmo hanging in
	// the viewport while the camera or a prop is selected reads as a stray
	// widget.
	const gizmoView = useMemo(() => {
		if (!charIdFromHierarchyId(selectedHierarchyId)) return null;
		const entry = characters.find((item) => item.id === activeChar.id);
		if (!entry || entry.hidden) return null;
		const hasTake = activeChar.id === activeCharacterId ? Boolean(motion) : Boolean(activeChar.sessionMotion);
		const placement = hasTake ? entry : resolveCharacterPlacement(entry, tlFrame, { shotAt: frame => shotAtFrame(shots, frame) });
		return { position: [placement.x, entry.y ?? 0, placement.z], rot: placement.rot };
	}, [characters, activeChar.id, motion, shots, tlFrame, selectedHierarchyId]);
	// The cast rides the SAME gizmo as scene objects — one movement grammar
	// for everything on stage. The proxy hands ObjectGizmo the object shape
	// it expects; `height` puts the pivot at the hips like a prop's centre.
	const characterGizmoObject = useMemo(() => {
		if (!gizmoView) return null;
		const entry = characters.find((item) => item.id === activeChar.id);
		return {
			id: "__character__",
			x: gizmoView.position[0],
			y: gizmoView.position[1],
			z: gizmoView.position[2],
			height: 1.15,
			footprint: { width: 0.6, depth: 0.6 },
			rotY: gizmoView.rot ?? entry?.rot ?? 0,
			scaleX: entry?.scale ?? 1,
			scaleY: entry?.scale ?? 1,
			scaleZ: entry?.scale ?? 1,
		};
	}, [gizmoView, characters, activeChar.id]);

	/* --------------------- per-character layer buffers ---------------------
	 * waypoints / promptClips / motion above are the EDITING BUFFER of the
	 * active character's animation layer. On a character switch the buffer is
	 * committed back into the previous character's entry and the new one's
	 * layer is loaded, so each cast member keeps its own schedule. The
	 * generated clip is session-only; paths and prompt blocks persist in the
	 * stage envelope via the characters array. */
	const bufferRef = useRef({ waypoints: [], promptClips: [], motion: null, ik: null });
	bufferRef.current = { waypoints, promptClips, motion, ik: ikStateRef.current };
	const loadedLayerCharRef = useRef(activeChar.id);
	const ikStatesRef = useRef(new Map()); // charId -> ikState, one per layer
	useEffect(castDomain.switchActiveCharacterLayer, [activeChar.id]);
	// Pre-playback bone snapshot; restoring it (after Character's pose effect
	// has re-applied poseA) puts the rig back exactly where it was.
	const restoreRef = useRef(null);

	const shotCamRef = useRef(null);
	const captureRef = useRef(null);
	const look = useRef({ yaw: 0, pitch: 0 });
	// The poser camera is the IK-mode working view: orbit/dolly/WASD freely
	// while posing WITHOUT touching the shot camera, which stays frozen on
	// the framing and shows in the inset. Two separate screens by design.
	const poserCamRef = useRef(null);
	const poserLook = useRef({ yaw: 0, pitch: 0 });
	// The editor camera: the free working view the operator flies. Playback,
	// follow, rail and capture never touch it — that is the whole split.
	const editorCamRef = useRef(null);
	const editorLook = useRef({ yaw: 0, pitch: 0 });

	/* The shot camera as a manipulable object in the editor view: the proxy
	 * mirrors the live camera, gizmo patches write straight back to it and
	 * commit manual framing — the same contract as dragging its plan puck. */
	const shotCameraSelected = selectedHierarchyId === "camera";
	const cameraGizmoObject = useMemo(() => {
		if (lookThroughShot || ikMode || !shotCameraSelected) return null;
		return {
			id: "__shotcam__",
			x: cameraPos.x,
			y: Math.max(0, cameraPos.y - 0.12),
			z: cameraPos.z,
			height: 0.24,
			footprint: { width: 0.34, depth: 0.34 },
			rotY: THREE.MathUtils.radToDeg(look.current.yaw),
			scaleX: 1,
			scaleY: 1,
			scaleZ: 1,
		};
		// eslint-disable-next-line react-hooks/exhaustive-deps
	}, [cameraPos, lookThroughShot, ikMode, shotCameraSelected]);
	function changeShotCameraFromGizmo(_id, patch) {
		const cam = shotCamRef.current;
		if (!cam) return;
		if (patch.x !== undefined) cam.position.x = THREE.MathUtils.clamp(patch.x, -30, 30);
		if (patch.y !== undefined) cam.position.y = Math.max(0.12, patch.y + 0.12);
		if (patch.z !== undefined) cam.position.z = THREE.MathUtils.clamp(patch.z, -30, 30);
		if (patch.rotY !== undefined) look.current.yaw = THREE.MathUtils.degToRad(patch.rotY);
		cam.rotation.order = "YXZ";
		cam.rotation.set(look.current.pitch, look.current.yaw, 0);
		commitManualCameraFraming();
	}

	/* The key light as a manipulable object: same proxy contract as the shot
	 * camera — the sun puck mirrors the light, gizmo patches write straight
	 * back to the stage's keyLight. Move only; brightness lives in the
	 * Inspector. */
	const keyLightSelected = selectedHierarchyId === "light";
	const lightGizmoObject = useMemo(() => {
		if (!keyLightSelected || ikMode) return null;
		return {
			id: "__keylight__",
			x: keyLight.x,
			y: keyLight.y - 0.2,
			z: keyLight.z,
			height: 0.4,
			footprint: { width: 0.4, depth: 0.4 },
			rotY: 0,
			scaleX: 1,
			scaleY: 1,
			scaleZ: 1,
		};
	}, [keyLightSelected, ikMode, keyLight]);
	/* Selecting the Light from the hierarchy must SHOW the light: the sun sits
	 * high above the stage and the default view often does not contain it, so
	 * the editor camera glides in place to face it (position untouched). */
	function aimEditorAtKeyLight() {
		if (!editorCamRef.current || lookThroughShot || ikMode) return;
		setCamGlide({ target: { x: keyLight.x, y: keyLight.y, z: keyLight.z } });
	}
	function changeKeyLightFromGizmo(_id, patch) {
		changeKeyLight("gizmo", (current) => ({
			...current,
			x: patch.x !== undefined ? patch.x : current.x,
			y: patch.y !== undefined ? patch.y + 0.2 : current.y,
			z: patch.z !== undefined ? patch.z : current.z,
		}));
	}

	const shot = useMemo(
		() => deriveShot(cameraPos, charA, (fovDeg * Math.PI) / 180, SUBJECT_HEIGHT_M, filmback),
		[cameraPos, charA, fovDeg, filmback],
	);

	// The derived move sequence: what the keyframings geometrically prove
	// segment by segment, not what a dropdown claims. Present from two keys.
	const moveSequence = useMemo(() => {
		if (cameraKeys.length < 2) return null;
		const segs = [];
		for (let i = 0; i < cameraKeys.length - 1; i++) {
			segs.push(
				classifyMove(cameraKeys[i].framing, cameraKeys[i + 1].framing, charA, {
					durationS: (cameraKeys[i + 1].frame - cameraKeys[i].frame) / tlFps,
					...filmback,
				}),
			);
		}
		return {
			segs,
			slate: moveSequenceSlate(segs),
			displaySlate: moveSequenceSlateKo(segs),
			phrase: moveSequencePhrase(segs),
			fromShot: segs[0].from,
			spanS: Math.round(((cameraKeys[cameraKeys.length - 1].frame - cameraKeys[0].frame) / tlFps) * 10) / 10,
		};
	}, [cameraKeys, charA, filmback, tlFps]);
	// With Follow armed, Preview means "watch the shot": it plays the timeline
	// from frame 0 so character motion and the camera move share one clock.
	// Follow off keeps the camera-only preview on its own clock.
	const followPreviewArmed = moveFollow && hasCameraKeys && !ikMode && !waypointMode && !posing;
	const previewActive = movePlaying || (followPreviewArmed && tlPlaying);

	/* --------------------------- shot video export --------------------------- */
	// Record is an offline frame-addressed export. It never starts playback and
	// never samples a wall clock: sampleAt applies one absolute timeline frame,
	// CaptureRig reads the shot camera's WebGLRenderTarget, and WebCodecs receives
	// exactly one VideoFrame for every address in the inclusive export range.
	const [recState, setRecState] = useState("idle"); // "idle" | "recording"
	const recRef = useRef(null);
	const tlFrameRef = useRef(0);
	tlFrameRef.current = tlFrame;
	const [exportStatus, setExportStatus] = useState(null);
	const retryExportRef = useRef(null);
	const frameExportRef = useRef(null);

	// Snapshot authored inputs once, not when Retry is pressed. Runtime render
	// resources are acquired per attempt; they are never part of the snapshot.
	function exportRequest(kind, run, { exportShots = shots, external = false, download = true } = {}) {
		// IK's cached chains contain live Three bones/functions, not cloneable
		// authored data. Retain that binding and copy only the evaluated keys.
		const copyIk = (state) => state ? { ...state, keys: snapshotIkKeys(state), tracked: new Set(state.tracked) } : state;
		const context = kind === "frame" ? null : {
			...structuredClone({ shots: exportShots, playbackScene, characters, activeId: activeChar.id, motion,
				framing: captureCurrentFraming(), output: shotOutput }),
			ikState: copyIk(ikStateRef.current),
			ikStates: new Map([...ikStatesRef.current].map(([id, state]) => [id, copyIk(state)])),
			rigStates: Object.values(rigs).filter(Boolean).map(snapshotExportRig),
		};
		return Object.freeze({ kind, format: kind === "frame" ? "png" : kind === "keyframe_pack" ? "zip" : "mp4",
			context, run, external, download, handedOff: new Set() });
	}

	function exportRecovery(code) {
		switch (code) {
			case "unsupported_codec": return ko("MP4 encoding is unavailable. Use a current browser with H.264 WebCodecs support (such as Chrome or Edge), enable hardware acceleration, then retry.", "MP4 인코딩을 사용할 수 없어요. H.264 WebCodecs를 지원하는 최신 Chrome·Edge 등에서 하드웨어 가속을 켠 뒤 다시 시도하세요.");
			case "encode_failed": return ko("Video encoding failed. Retry the same request. If resources are tight, shorten the shot range or lower output resolution before starting a new export.", "영상 인코딩에 실패했어요. 같은 요청을 다시 시도하세요. 리소스가 부족하면 샷 범위를 줄이거나 출력 해상도를 낮춘 뒤 새로 내보내세요.");
			case "render_failed": return ko("Frame rendering failed. Let the scene finish loading, then retry. If it repeats, shorten the range or reduce output resolution for a new export.", "프레임 렌더링에 실패했어요. 장면 로딩이 끝난 뒤 다시 시도하세요. 반복되면 범위나 출력 해상도를 줄여 새로 내보내세요.");
			case "aborted": return ko("Export cancelled. No further downloads will be requested.", "내보내기를 취소했어요. 추가 다운로드는 요청하지 않아요.");
			default: return ko("Export could not finish. Retry the same request. For memory or resource problems, close other heavy tabs or use a shorter range / lower output resolution in a new export.", "내보내기를 완료하지 못했어요. 같은 요청을 다시 시도하세요. 메모리·리소스 문제라면 무거운 탭을 닫거나 범위·출력 해상도를 줄여 새로 내보내세요.");
		}
	}

	function updateExportStatus(job, phase, details = {}) {
		if (recRef.current !== job) return;
		job.cancellable = details.cancellable ?? false;
		setExportStatus({ kind: job.request.kind, phase, label: job.label, ...details });
	}

	// Yield to input between real work units, not a progress timer. This also
	// lets the preparing state render before synchronous PNG/ZIP work begins.
	function exportBoundary(job) {
		job.controller.signal.throwIfAborted();
		return new Promise((resolve) => {
			const channel = new MessageChannel();
			channel.port1.onmessage = () => { channel.port1.close(); channel.port2.close(); resolve(); };
			channel.port2.postMessage(null);
		}).then(() => job.controller.signal.throwIfAborted());
	}

	async function executeExportRequest(request) {
		// A synchronous ref, shared by ALL four kinds and retry, is authoritative.
		// React's busy state alone cannot guard two calls in the same event turn.
		if (recRef.current) {
			if (request.external) throw new Error(ko("An export is already running", "이미 내보내기 중입니다"));
			return null;
		}
		const job = { request, controller: new AbortController(), capture: null, cancellable: false };
		recRef.current = job;
		retryExportRef.current = request;
		setRecState("recording");
		const attempt = request.external ? null : startExportAttempt({ export_kind: request.kind, format: request.format, surface: embedMode ? "embed" : "studio" });
		updateExportStatus(job, "preparing", { cancellable: request.kind !== "frame" });
		try {
			await exportBoundary(job);
			if (request.context) {
				if (!captureRef.current || !shotCamRef.current) throw Object.assign(new Error("The shot renderer is not ready"), { exportFailureCode: "render_failed" });
				job.capture = captureRef.current.createExportCapture(request.context.output);
			}
			const output = await request.run(job);
			job.controller.signal.throwIfAborted();
			attempt?.succeed();
			updateExportStatus(job, "completed", { message: request.download
				? ko("Export completed. Download requested; check your browser's downloads. The OS save is not confirmed.", "내보내기를 완료하고 다운로드를 요청했어요. 브라우저 다운로드를 확인하세요. OS 저장 완료는 확인할 수 없어요.")
				: ko("Export pipeline completed. The requesting tool handles the file handoff.", "내보내기 처리를 완료했어요. 요청한 도구에서 파일 전달을 처리합니다.") });
			if (!request.external) {
				if (request.kind === "video") { track("export:video_succeeded", { format: "mp4" }); trackFeature("export_video"); }
				if (request.kind === "depth_video") trackFeature("export_depth_video");
				if (request.kind === "keyframe_pack") trackFeature("export_keyframe_pack");
				if (request.kind === "frame") {
					track("export:blocking_frame_succeeded", { format: "png" });
					trackFeature("export_frame"); trackActivation("export");
				}
				// A real deliverable is the moment the use-case question is worth
				// asking; never in embeds, and only while telemetry is on.
				try {
					if (!embedMode && !playgroundMode && ["video", "frame", "depth_video"].includes(request.kind) && shouldAskUseCase()) setUseCaseAskOpen(true);
				} catch {
					// The optional question can never turn a finished export into a failure.
				}
			}
			return output;
		} catch (error) {
			const code = exportFailureCode(error, request.kind === "depth_video" ? "render_failed" : "unknown");
			attempt?.fail(error, code);
			const message = exportRecovery(code);
			updateExportStatus(job, code === "aborted" ? "cancelled" : "failed", {
				code, message, retryable: !request.external, handedOff: request.handedOff.size,
			});
			setToast(message);
			if (request.external) throw error;
			return null;
		} finally {
			try { job.capture?.dispose(); }
			finally { if (recRef.current === job) recRef.current = null; setRecState("idle"); }
		}
	}

	function retryExport() {
		if (recRef.current || !retryExportRef.current || retryExportRef.current.external) return;
		return executeExportRequest(retryExportRef.current);
	}

	function applyExportFrame(frame) {
		// Props on a travel path read this ref inside their own useFrame, so a
		// recorded frame shows the same placement the preview would.
		propFrameRef.current = frame;
		const context = recRef.current?.request.context;
		for (const entry of context?.characters ?? characters) {
			if (isProxyFigure(entry)) continue;
			const activeId = context?.activeId ?? activeChar.id;
			const clip = entry.id === activeId ? (context ? context.motion : motion) : entry.sessionMotion;
			const state = context
				? (entry.id === activeId ? context.ikState : context.ikStates.get(entry.id))
				: (entry.id === activeChar.id ? ikStateRef.current : ikStatesRef.current.get(entry.id));
			const placement = typeof resolveCharacterPlacement === "function" ? resolveCharacterPlacement(entry, frame, {
				shotAt: at => shotAtFrame(context?.shots ?? shots, at),
				takeRoot: clip ? sampleAt({ frameCount: clip.frames, motion: clip }, null, frame).subject : null,
			}) : entry;
			poseMemberAtFrame(rigs[entry.id], clip, state, frame, IK_CORRECTION_BLEND_FRAMES, placement.pose ?? null);
		}
		// The bones for this frame are now written, so a carried prop can take
		// its place on them. gl.render() never runs the r3f frame loop, so this
		// pass is the recorder's stand-in for the useFrame the preview gets.
		// Riding characters move with their object first, then the props.
		syncCarriers();
		propSyncRef.current?.();
		const sampled = sampleAt(context?.playbackScene ?? playbackScene, shotAtFrame(context?.shots ?? shots, frame), frame);
		const framing = sampled.camera ?? context?.framing;
		const cam = shotCamRef.current;
		if (cam && framing) {
			cam.position.set(framing.pos.x, framing.pos.y, framing.pos.z);
			cam.rotation.order = "YXZ";
			cam.rotation.set(framing.pitch, framing.yaw, 0);
			look.current.yaw = framing.yaw;
			look.current.pitch = framing.pitch;
			cam.fov = framing.fovDeg;
			cam.updateProjectionMatrix();
		}
		return (recRef.current?.capture ?? captureRef.current)?.render() ?? null;
	}

	function snapshotExportRig(rig) {
		return { rig, bones: snapshotPlaybackBones(rig), scale: rig.scale.clone(),
			parent: rig.parent ? { node: rig.parent, position: rig.parent.position.clone(), quaternion: rig.parent.quaternion.clone() } : null };
	}

	function restoreExportRig(snapshot) {
		snapshot.rig.scale.copy(snapshot.scale);
		if (snapshot.parent) {
			snapshot.parent.node.position.copy(snapshot.parent.position);
			snapshot.parent.node.quaternion.copy(snapshot.parent.quaternion);
			snapshot.parent.node.updateMatrixWorld(true);
		}
		restorePlaybackBones(snapshot.rig, snapshot.bones);
	}

	// Restore at each synchronous capture boundary, including the depth
	// prepass, rather than holding an export pose across a hash/codec await.
	function withExportFrame(frame, render = null) {
		const cam = shotCamRef.current;
		if (!cam) throw Object.assign(new Error("The shot renderer is not ready"), { exportFailureCode: "render_failed" });
		const cameraSnapshot = { position: cam.position.clone(), quaternion: cam.quaternion.clone(),
			rotationOrder: cam.rotation.order, fov: cam.fov, yaw: look.current.yaw, pitch: look.current.pitch };
		const rigSnapshots = Object.values(rigs).filter(Boolean).map(snapshotExportRig);
		const proxySnapshots = [];
		const context = recRef.current?.request.context;
		const cast = context?.characters ?? characters;
		const scene = (recRef.current?.capture ?? captureRef.current)?.scene;
		const pickIdByCharacter = new Map((typeof characterViews === "undefined" ? [] : characterViews).map(view => [view.id, view.pickId]));
		if (typeof scene?.traverse === "function") scene.traverse(node => {
			const index = cast.findIndex(entry => isProxyFigure(entry) && node.userData.characterPick === pickIdByCharacter.get(entry.id));
			if (index < 0) return;
			proxySnapshots.push({ node, entry: cast[index], position: node.position.clone(), quaternion: node.quaternion.clone() });
		});
		const propFrame = propFrameRef.current;
		try {
			// Character stature lives on the rig and placement/yaw on its parent,
			// not in playback bones. Retry temporarily restores both, plus the
			// original held pose, then puts the CURRENT editor transforms back.
			for (const snapshot of recRef.current?.request.context?.rigStates ?? []) restoreExportRig(snapshot);
			for (const { node, entry } of proxySnapshots) {
				const clip = entry.id === (context?.activeId ?? activeChar.id) ? (context ? context.motion : motion) : entry.sessionMotion;
				const placement = typeof resolveCharacterPlacement === "function" ? resolveCharacterPlacement(entry, frame, {
					shotAt: at => shotAtFrame(context?.shots ?? shots, at),
					takeRoot: clip ? sampleAt({ frameCount: clip.frames, motion: clip }, null, frame).subject : null,
				}) : entry;
				node.position.set(placement.x, entry.y ?? 0, placement.z);
				node.rotation.y = placement.rot * Math.PI / 180 + (placement.posture === "lie" ? Math.PI : 0);
				node.updateMatrixWorld(true);
			}
			const plate = applyExportFrame(frame);
			return render ? render() : plate;
		} catch (error) {
			throw Object.assign(new Error(error?.message || String(error), { cause: error }), { exportFailureCode: exportFailureCode(error, "render_failed") });
		} finally {
			for (const snapshot of rigSnapshots) restoreExportRig(snapshot);
			for (const { node, position, quaternion } of proxySnapshots) {
				node.position.copy(position);
				node.quaternion.copy(quaternion);
				node.updateMatrixWorld(true);
			}
			cam.position.copy(cameraSnapshot.position);
			cam.rotation.order = cameraSnapshot.rotationOrder;
			cam.quaternion.copy(cameraSnapshot.quaternion);
			cam.fov = cameraSnapshot.fov;
			cam.updateProjectionMatrix();
			look.current.yaw = cameraSnapshot.yaw;
			look.current.pitch = cameraSnapshot.pitch;
			propFrameRef.current = propFrame;
			syncCarriers();
			propSyncRef.current?.();
		}
	}

	function currentRecordFrameCount() {
		const contentExtent = timelineContentExtent(
			characters,
			activeChar.id,
			motion,
			promptClips,
			multiModelFootage?.frames,
		);
		// Camera-only scenes still use their authored production duration. Once
		// motion or prompt content exists, content is the authoritative record
		// range even if an older timeline count was left behind.
		return contentExtent > 0 ? contentExtent : tlFrameCount;
	}

	async function runShotExport({ startFrame = 0, endFrame, download = true, passKind = null, depthRange = null, fileName = null } = {}, job = null) {
		const resolvedEndFrame = endFrame ?? Math.max(0, currentRecordFrameCount() - 1);
		// Preserve the download-free browser seam, without a nested lifecycle.
		if (!job) return executeExportRequest(exportRequest(passKind === "depth" ? "depth_video" : "video",
			(ownedJob) => runShotExport({ startFrame, endFrame: resolvedEndFrame, download, passKind, depthRange, fileName }, ownedJob),
			{ external: true, download }));
		job.controller.signal.throwIfAborted();
		const output = job.request.context.output;
		const result = await exportOffscreenVideo({
			startFrame, endFrame: resolvedEndFrame, fps: TIMELINE_FPS,
			width: output.width, height: output.height,
			capture: (frame, kind) => withExportFrame(frame, kind
				? () => renderPass(job.capture, job.capture.scene, shotCamRef.current, kind, null, { depthRange }) : null),
			passKind, signal: job.controller.signal,
			onFrame: ({ index, frameCount }) => updateExportStatus(job, "encoding", {
				completedFrames: index + 1, frameCount, cancellable: true,
			}),
			onPhase: ({ phase, stage, cancellable }) => updateExportStatus(job, phase, { stage, cancellable }),
		});
		job.controller.signal.throwIfAborted();
		if (download) {
			const slate = (moveSequence?.slate ?? "shot").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "") || "shot";
			// Default plate filename: const name = `cozyclay-${slate}.mp4`
			const name = fileName ?? `cozyclay-${slate}.mp4`;
			const url = URL.createObjectURL(result.blob);
			try { saveDownload(url, name); }
			finally { setTimeout(() => URL.revokeObjectURL(url), 10_000); }
			setRecordedVideoName(name);
			setToast((isKo, ko) => isKo ? `${name} 다운로드 요청 · ${result.frameCount}프레임` : `Download requested: ${name} · ${result.frameCount} frames`);
			return { ...result, fileName: name };
		}
		return result;
	}

	function stopShotRecording() {
		const job = recRef.current;
		if (!job?.cancellable) return;
		job.controller.abort();
		updateExportStatus(job, "preparing", { message: ko("Cancelling at the current work boundary…", "현재 작업 경계에서 취소 중…") });
	}

	async function exportDepthVideo(shotId = null) {
		if (recRef.current) return null;
		const atPlayhead = shotIndexAtFrame(shots, tlFrame);
		const target = shotId ? shots.find((entry) => entry.id === shotId) : shots[atPlayhead >= 0 ? atPlayhead : 0] ?? null;
		if (shotId && !target) return null;
		const startFrame = target && (shotId || !motion) ? target.startFrame : 0;
		const endFrame = target && (shotId || !motion) ? target.endFrame : Math.max(0, currentRecordFrameCount() - 1);
		return executeExportRequest(exportRequest("depth_video", async (job) => {
			if (!target) throw Object.assign(new Error("Add a shot before exporting depth video"), { exportFailureCode: "render_failed" });
			let depthRange = null;
			if (endFrame > startFrame) {
				const samples = [];
				for (let frame = startFrame; frame <= endFrame; frame += 1) {
					job.controller.signal.throwIfAborted();
					const depth = withExportFrame(frame, () => renderPass(job.capture, job.capture.scene, shotCamRef.current, "depth"));
					if (!depth) throw Object.assign(new Error("Depth capture failed"), { exportFailureCode: "render_failed" });
					let minGrey = 255;
					let maxGrey = 0;
					for (let index = 0; index < depth.length; index += 256) {
						minGrey = Math.min(minGrey, depth[index]);
						maxGrey = Math.max(maxGrey, depth[index]);
					}
					samples.push({ min: DEPTH_RANGE_M * (1 - maxGrey / 255), max: DEPTH_RANGE_M * (1 - minGrey / 255) });
					updateExportStatus(job, "preparing", { stage: "depth", completedFrames: frame - startFrame + 1,
						frameCount: endFrame - startFrame + 1, cancellable: true });
					await exportBoundary(job);
				}
				depthRange = depthRangeFromFrames(samples, shotCamRef.current.near, DEPTH_RANGE_M);
			}
			return runShotExport({ startFrame, endFrame, passKind: "depth", depthRange, fileName: "blocking-depth.mp4" }, job);
		}));
	}

	function exportPhaseLabel(phase) {
		return ({ preparing: ko("Preparing", "준비 중"), encoding: ko("Encoding", "인코딩 중"),
			finalizing: ko("Finalizing", "마무리 중"), completed: ko("Completed", "완료"),
			failed: ko("Failed", "실패"), cancelled: ko("Cancelled", "취소됨") })[phase] ?? "";
	}

	function exportFeedback() {
		if (!exportStatus) return null;
		const { phase, kind, message, completedFrames, frameCount, stage, cancellable, retryable, handedOff, label } = exportStatus;
		const busy = ["preparing", "encoding", "finalizing"].includes(phase);
		return (
			<section className="export-status" data-testid="export-status" data-phase={phase} data-kind={kind} role="status" aria-live="polite" aria-atomic="true">
				<strong>{exportPhaseLabel(phase)}{label ? ` · ${label}` : ""}</strong>
				{busy && <progress aria-label={exportPhaseLabel(phase)} max={frameCount} value={completedFrames} />}
				{frameCount && <p>{stage === "depth" ? ko("Depth range sampled", "뎁스 범위 샘플링") : ko("Frames submitted to encoder", "인코더에 전달한 프레임")}: {completedFrames} / {frameCount}</p>}
				{message && <p>{message}</p>}
				{busy && !message && <p>{stage === "mux"
					? ko("Finalizing MP4. Progress is indeterminate; this stage cannot be interrupted.", "MP4 마무리 중이에요. 진행률은 알 수 없으며 이 단계는 중단할 수 없어요.")
					: stage === "flush" ? ko("Finishing encoder output. Progress is indeterminate.", "인코더 출력을 마무리하고 있어요. 진행률은 알 수 없어요.")
					: kind === "frame" ? ko("Handing off existing PNGs. Synchronous downloads cannot be cancelled.", "기존 PNG를 전달하고 있어요. 동기 다운로드는 취소할 수 없어요.")
					: stage === "archive" ? ko("Building the ZIP. Cancel takes effect after the current work unit, before download.", "ZIP을 만드는 중이에요. 취소는 현재 작업이 끝난 뒤 다운로드 전에 적용돼요.")
					: stage === "depth" || stage === "frames" ? ko("Cancel stops at the next frame boundary, before download.", "취소하면 다운로드 전 다음 프레임 경계에서 멈춰요.")
					: phase === "preparing" ? ko("Preparing the renderer and checking MP4 support…", "렌더러를 준비하고 MP4 지원을 확인하고 있어요…")
					: ko("Encoding the requested frames, not yet a completed file.", "요청한 프레임을 인코딩 중이에요. 아직 파일이 완성되지 않았어요.")}</p>}
				{retryable && <p>{ko("Retry keeps the original shot, camera, range and settings; it does not change your edits.", "다시 시도하면 원래 샷·카메라·범위·설정을 사용하며 편집 내용은 바꾸지 않아요.")}</p>}
				{handedOff > 0 && <p>{ko(`${handedOff} file(s) already handed off. Retry skips those downloads; check browser downloads because OS saves cannot be confirmed.`, `파일 ${handedOff}개는 이미 전달했어요. 다시 시도할 때 해당 다운로드는 건너뛰어요. OS 저장은 확인할 수 없으니 브라우저 다운로드를 확인하세요.`)}</p>}
				<div className="export-status-actions">
					{busy && cancellable && <button type="button" data-testid="export-cancel" onClick={stopShotRecording}>{ko("Cancel export", "내보내기 취소")}</button>}
					{retryable && <button type="button" data-testid="export-retry" disabled={recState === "recording"} onClick={() => void retryExport()}>{ko("Retry same export", "같은 내보내기 재시도")}</button>}
				</div>
			</section>
		);
	}

	// Observe the existing export UI boundary, independently of telemetry.
	// The first transition covers ordinary menu exports and fast failures too;
	// progress updates do not write storage on every encoded frame.
	const hasExportAttempt = exportStatus !== null;
	useEffect(() => {
		if (!hasExportAttempt) return;
		rememberCameraTutorialTerminal("export_started");
		setCameraTutorialHandoff(null);
	}, [hasExportAttempt]);

	function downloadOtioCutList() {
		if (!shots.length) {
			setToast(ko("Add at least one Shot before exporting OTIO", "OTIO를 내보내려면 샷을 하나 이상 추가하세요"));
			return;
		}
		try {
			const activeScene = scenes.find((scene) => scene.id === activeSceneId);
			const exportScene = {
				...playbackScene,
				name: activeScene?.name,
				activeCharacterId: activeChar.id,
				characters: characters.map((entry) => ({
					...entry,
					sessionMotion: entry.id === activeChar.id ? motion : entry.sessionMotion,
				})),
				objects: sceneObjects,
			};
			const serialized = serializeOtio(exportScene, shots);
			const blob = new Blob([serialized], { type: "application/json" });
			const url = URL.createObjectURL(blob);
			const anchor = document.createElement("a");
			const slug = (activeScene?.name ?? "cut-list")
				.toLowerCase()
				.replace(/[^a-z0-9]+/g, "-")
				.replace(/^-+|-+$/g, "") || "cut-list";
			anchor.href = url;
			anchor.download = `cozyclay-${slug}.otio`;
			anchor.click();
			setTimeout(() => URL.revokeObjectURL(url), 10_000);
			const frameCount = shots.reduce((total, shot) => total + shot.endFrame - shot.startFrame + 1, 0);
			setToast(isKo
				? `OTIO 저장됨 · ${shots.length}샷 · ${frameCount}프레임`
				: `OTIO saved · ${shots.length} shots · ${frameCount} frames`);
		} catch (error) {
			setToast(error?.message || String(error));
		}
	}

	/* ======================= reference-pack exports (#165) =================
	 * Three deliverables a video model actually asks for, all built from the
	 * SAME offscreen capture rig the MP4 export uses, so what ships matches
	 * what the editor previewed:
	 *   - a per-shot keyframe pack (first/last frame, clip, camera, prompt),
	 *   - depth + normal conditioning passes of the current framing,
	 *   - a storyboard contact sheet of the whole cut.
	 */

	function saveDownload(href, name) {
		const anchor = document.createElement("a");
		anchor.href = href;
		anchor.download = name;
		document.body.appendChild(anchor);
		anchor.click();
		anchor.remove();
	}

	function loadImage(dataUrl) {
		return new Promise((resolve, reject) => {
			const image = new Image();
			image.onload = () => resolve(image);
			image.onerror = () => reject(new Error("A captured frame could not be decoded"));
			image.src = dataUrl;
		});
	}

	function dataUrlToBytes(dataUrl) {
		const binary = atob(dataUrl.slice(dataUrl.indexOf(",") + 1));
		const bytes = new Uint8Array(binary.length);
		for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index);
		return bytes;
	}

	// One frame of the shot as the recorder would draw it: applyExportFrame
	// poses every cast member and parks the shot camera for that absolute
	// frame, exactly as the MP4 pass does. Bones and camera are put back
	// afterwards, so a pack built mid-session leaves the viewport untouched.
	function captureShotFramePng(frame) {
		const buffer = withExportFrame(frame);
		try { return buffer ? bufferToPng(buffer) : null; }
		catch (error) {
			throw Object.assign(new Error(error?.message || String(error), { cause: error }), { exportFailureCode: exportFailureCode(error, "render_failed") });
		}
	}

	// The framing the shot camera stands in at a frame, in the same shape the
	// camera keys use — camera.json carries it so a tool can rebuild the pull.
	function shotFramingAtFrame(entry, frame) {
		const context = recRef.current?.request.context;
		const sampled = sampleAt(context?.playbackScene ?? playbackScene, entry, frame).camera ?? context?.framing;
		if (!sampled) return null;
		return { pos: { x: sampled.pos.x, y: sampled.pos.y, z: sampled.pos.z }, yaw: sampled.yaw, pitch: sampled.pitch, fovDeg: sampled.fovDeg };
	}

	function packMetaForShot(entry, shotIndex) {
		return shotCaptureMeta({
			shot: entry,
			shotIndex,
			stage: { keyLight },
			cast: characters,
			fps: tlFps,
			aspectKey: shotAspectKey,
			size: { width: shotOutput.width, height: shotOutput.height },
			frame: entry.startFrame,
			// The shot's camera block stores the MOVE; the lens lives on the
			// stage, so the live focal length fills in when the block has none.
			lens: { focalMm: shot.focalMm, fovDeg },
		});
	}

	// Build one shot's pack: both endpoint frames, the clip between them, the
	// camera state and the prompt. Returns the archive bytes plus the entry
	// names, so the download path, the embed message and QA all share it.
	async function buildShotKeyframePack(entry, index, onProgress = null, job = null) {
		// Embed/Workflow and the public QA API already own their lifecycle. The
		// shared lock still covers their endpoint captures and archive stages.
		if (!job) {
			const snapshot = structuredClone(entry);
			return executeExportRequest(exportRequest("keyframe_pack",
				(ownedJob) => buildShotKeyframePack(snapshot, index, onProgress, ownedJob), { external: true, download: false }));
		}
		updateExportStatus(job, "preparing", { stage: "frames", cancellable: true });
		await exportBoundary(job);
		const packShot = { title: entry.name, index: index + 1, startFrame: entry.startFrame, endFrame: entry.endFrame };
		onProgress?.(ko(`Rendering frames for "${entry.name}"`, `"${entry.name}" 프레임 렌더링 중`));
		const firstUrl = captureShotFramePng(entry.startFrame);
		if (!firstUrl) throw Object.assign(new Error(ko("The shot renderer is not ready", "샷 렌더러가 아직 준비되지 않았어요")), { exportFailureCode: "render_failed" });
		await exportBoundary(job);
		const lastUrl = entry.endFrame > entry.startFrame ? captureShotFramePng(entry.endFrame) : null;
		await exportBoundary(job);
		onProgress?.(ko(`Recording the clip for "${entry.name}"`, `"${entry.name}" 클립 녹화 중`));
		const recorded = await runShotExport({ startFrame: entry.startFrame, endFrame: entry.endFrame, download: false }, job);
		updateExportStatus(job, "finalizing", { stage: "archive", cancellable: true });
		await exportBoundary(job);
		const clipBytes = new Uint8Array(await recorded.blob.arrayBuffer());
		job.controller.signal.throwIfAborted();
		const meta = packMetaForShot(entry, index);
		const entries = keyframePackEntries({
			shot: packShot,
			fps: tlFps,
			firstFramePng: dataUrlToBytes(firstUrl),
			lastFramePng: lastUrl ? dataUrlToBytes(lastUrl) : null,
			clip: { data: clipBytes, ext: recorded.mimeType === "video/webm" ? "webm" : "mp4" },
			camera: {
				...meta,
				framing: {
					start: shotFramingAtFrame(entry, entry.startFrame),
					end: shotFramingAtFrame(entry, entry.endFrame),
				},
			},
			prompt: buildShotPrompt(meta, { target: "video" }),
		});
		const bytes = buildZip(entries);
		// ZIP construction is synchronous: cancellation takes effect after that
		// work unit, before any file is handed off or the next shot is started.
		await exportBoundary(job);
		return { name: keyframePackName(packShot), entries, bytes };
	}

	// The shot a pack is built for: an explicit id, else the one under the
	// playhead, else the first authored shot.
	function shotIndexForPack(shotId = null) {
		if (shotId) {
			const index = shots.findIndex((entry) => entry.id === shotId);
			if (index < 0) throw new Error(`Unknown shots ID: ${shotId}`);
			return index;
		}
		if (!shots.length) throw new Error(ko("Add at least one Shot before exporting a keyframe pack", "키프레임 팩을 내보내려면 샷을 하나 이상 추가하세요"));
		const atPlayhead = shotIndexAtFrame(shots, tlFrame);
		return atPlayhead >= 0 ? atPlayhead : 0;
	}

	/** Download the keyframe pack for one shot, or (Shift) for every shot. */
	async function exportKeyframePacks(everyShot = false, shotId = null) {
		if (recRef.current) return null;
		const atPlayhead = shotIndexAtFrame(shots, tlFrame);
		const current = shotId ? shots.findIndex((entry) => entry.id === shotId) : atPlayhead >= 0 ? atPlayhead : 0;
		if (shotId && current < 0) return null;
		const targets = everyShot ? shots.map((_, index) => index) : [current];
		return executeExportRequest(exportRequest("keyframe_pack", async (job) => {
			if (!job.request.context.shots.length) throw new Error(ko("Add at least one Shot before exporting a keyframe pack", "키프레임 팩을 내보내려면 샷을 하나 이상 추가하세요"));
			for (const [order, index] of targets.entries()) {
				if (job.request.handedOff.has(index)) continue;
				job.label = ko(`Shot ${order + 1} of ${targets.length}`, `샷 ${order + 1} / ${targets.length}`);
				const pack = await buildShotKeyframePack(job.request.context.shots[index], index, null, job);
				job.controller.signal.throwIfAborted();
				const url = URL.createObjectURL(new Blob([pack.bytes], { type: "application/zip" }));
				try { saveDownload(url, pack.name); job.request.handedOff.add(index); }
				finally { setTimeout(() => URL.revokeObjectURL(url), 10_000); }
				setToast(isKo ? `${pack.name} 다운로드 요청 · 파일 ${pack.entries.length}개` : `Download requested: ${pack.name} · ${pack.entries.length} files`);
				await exportBoundary(job);
			}
		}));
	}

	/** Depth and normal conditioning passes of the framing on screen now. */
	function exportRenderPasses() {
		try {
			const dataUrls = renderPassDataUrls();
			for (const kind of ["depth", "normal"]) saveDownload(dataUrls[kind], passFileName(kind));
			setToast(ko("Depth and normal passes downloaded", "뎁스·노멀 패스를 다운로드했어요"));
			trackFeature("export_render_pass");
		} catch (error) {
			setToast(error?.message || String(error));
		}
	}

	// Both passes of the framing the shot camera stands in right now, as PNG
	// data URLs. The rig draws through that same camera for the RGB plate, so
	// the three images register pixel for pixel.
	function renderPassDataUrls(kinds = ["depth", "normal"]) {
		const capture = captureRef.current;
		const cam = shotCamRef.current;
		if (!capture || !cam) throw new Error(ko("The shot renderer is not ready", "샷 렌더러가 아직 준비되지 않았어요"));
		const output = {};
		for (const kind of kinds) {
			const dataUrl = renderPass(capture, capture.scene, cam, kind, bufferToPng);
			if (!dataUrl) throw new Error(ko("The shot renderer is not ready", "샷 렌더러가 아직 준비되지 않았어요"));
			output[kind] = dataUrl;
		}
		return output;
	}

	// One storyboard panel as a picture: the shot's first frame through the
	// offscreen capture rig, as a PNG data URL (null while the renderer has no
	// frame). The contact sheet and the Board dock tab share it.
	function capturePanelThumbnail(entry) {
		return captureShotFramePng(entry.startFrame);
	}

	/** Contact sheet of the whole cut: one thumbnail and prompt per shot. */
	async function exportStoryboard() {
		try {
			if (!shots.length) throw new Error(ko("Add at least one Shot before exporting a storyboard", "스토리보드를 내보내려면 샷을 하나 이상 추가하세요"));
			setToast(ko("Composing the storyboard…", "스토리보드 구성 중…"));
			const cells = [];
			for (const [index, entry] of shots.entries()) {
				const dataUrl = capturePanelThumbnail(entry);
				const meta = packMetaForShot(entry, index);
				cells.push({
					title: storyboardLine(`${index + 1}. ${entry.name}`),
					durationSeconds: Number(((entry.endFrame - entry.startFrame + 1) / tlFps).toFixed(2)),
					// The sheet gives each shot one caption line, and the composer draws
					// it unwrapped: the labelled prompt is folded down to the two lines a
					// board is read for (what the shot is, and on what lens), cut to what
					// fits the cell. The pack's prompt.txt keeps the full block.
					prompt: storyboardCaption(buildShotPrompt(meta, { target: "image" })),
					image: dataUrl ? await loadImage(dataUrl) : null,
				});
			}
			const canvas = composeStoryboard({
				shots: cells,
				columns: Math.min(3, cells.length),
				// 480x300 leaves a 464x164 thumbnail box (16:9 lands at 464x261 before
				// the fit, so the frame is scaled to height) and a caption block wide
				// enough for the 90 characters the composer draws at this size.
				cell: { width: 480, height: 300 },
				createCanvas: (width, height) => {
					const element = document.createElement("canvas");
					element.width = width;
					element.height = height;
					const ctx = element.getContext("2d");
					// The sheet is a deliverable, so it uses the studio's own type
					// stack rather than the canvas default (10px sans-serif).
					ctx.font = STORYBOARD_FONT;
					ctx.textAlign = "left";
					ctx.textBaseline = "top";
					return element;
				},
			});
			saveDownload(canvas.toDataURL("image/png"), "cozyclay-storyboard.png");
			setToast(isKo ? `스토리보드 저장됨 · ${cells.length}샷` : `Storyboard saved · ${cells.length} shots`);
			trackFeature("export_storyboard");
		} catch (error) {
			setToast(error?.message || String(error));
		}
	}

	function captureCurrentFraming() {
		const cam = shotCamRef.current;
		const pos = cam ? cam.position : cameraPos;
		return captureFraming({ pos: { x: pos.x, y: pos.y, z: pos.z }, yaw: look.current.yaw, pitch: look.current.pitch, fovDeg });
	}

	/** The agent panel's Generate motion chip: the motion.generateFromVideo
	 * action. Locked, the action is unavailable and never runs, so the chip shows
	 * the AI motion card's lock line itself, as it always did. */

	// What a framing capture says about the shot it came from: lens, delivery
	// aspect, cast, cut range and the video model the shot is aimed at. Both
	// capture paths (the live command and the embed message) attach this, so a
	// still handed to a generator arrives with its production notes.
	// A frame that falls in a gap between shots describes the first shot — a
	// pull still belongs to the piece even when the playhead sits outside a cut.
	/**
	 * The reference pictures a capture travels with (#167): every visible cast
	 * member's identity sheet, then the set's environment reference. Slots that
	 * are empty simply do not appear — the array is the pictures that EXIST,
	 * never a fixed-length list with holes in it, so a consumer can attach the
	 * whole thing without filtering.
	 */
	function captureShotReferences() {
		const references = characters
			.filter((entry) => !entry.hidden && typeof entry.identityImage === "string" && entry.identityImage)
			.map((entry) => ({ role: "character", name: entry.subject || entry.id, dataUrl: entry.identityImage }));
		if (typeof environmentImage === "string" && environmentImage) {
			references.push({ role: "environment", dataUrl: environmentImage });
		}
		return references;
	}

	function captureShotMeta(frame) {
		const index = shotIndexAtFrame(shots, frame);
		const resolvedIndex = index >= 0 ? index : shots.length ? 0 : null;
		return shotCaptureMeta({
			shot: resolvedIndex == null ? null : shots[resolvedIndex],
			shotIndex: resolvedIndex,
			stage: { keyLight },
			cast: characters,
			fps: tlFps,
			aspectKey: shotAspectKey,
			size: { width: shotOutput.width, height: shotOutput.height },
			frame,
			lens: { focalMm: shot.focalMm, fovDeg },
		});
	}

	// The Inspector is driven by the hierarchy selection alone — there are no
	// sidebar tabs. Every panel belongs to the thing that owns it: the scene
	// owns what gets generated, the camera owns the lens, and a character owns
	// its pose and its motion.
	const isSceneSelection = selectedHierarchyId === "shot";
	const isCameraSelection = selectedHierarchyId === "camera";
	const isCharacterSelection = selectedHierarchyId === "characters"
		|| selectedHierarchyId === "characterA"
		|| selectedHierarchyId === "characterB"
		|| selectedHierarchyId.startsWith("character:");
	// The View menu's three toggles, as the menu reads them: one radio choice
	// for the part colours, and a dot on the trigger whenever the viewport is
	// showing something other than the plain stage.
	const partColoursChoice = partColoursEnabled ? partColoursMode : "off";
	// Shaded part colours keep the stable per-part hues while preserving the
	// surface lighting H3 uses to infer the character's volume and pose.
	const i2vMotionSegmentationReady = partColoursEnabled && partColoursMode === "shaded";
	const i2vMotionHasA = Boolean(i2vMotion.a);
	const i2vMotionHasB = Boolean(i2vMotion.b);
	const i2vMotionCameraMatch = i2vMotionHasA && i2vMotionHasB && framingDistance(i2vMotion.a.framing, i2vMotion.b.framing) <= 0.001;
	const i2vMotionCameraLocked = i2vMotionHasA && !i2vMotionCameraUnlocked;
	const i2vMotionCurrentCameraMatch = !i2vMotionHasA || framingDistance(i2vMotion.a.framing, captureCurrentFraming()) <= 0.001;
	const i2vMotionStep = !i2vMotionSegmentationReady ? 1 : !i2vMotionHasA ? 2 : i2vMotionMode === "interpolate" && !i2vMotionHasB ? 3 : 4;
	// The AI motion workflow is split into a viewport-side capture card and a wide
	// authoring modal (i2v-motion-studio.jsx); both render from this one model
	// and action set so they cannot drift.
	const i2vMotionModel = {
		i2vMotion,
		mode: i2vMotionMode,
		enabled: i2vMotionEnabled,
		segmentationReady: i2vMotionSegmentationReady,
		step: i2vMotionStep,
		hasA: i2vMotionHasA,
		hasB: i2vMotionHasB,
		cameraMatch: i2vMotionCameraMatch,
		cameraUnlocked: i2vMotionCameraUnlocked,
		currentCameraMatch: i2vMotionCurrentCameraMatch,
		framingActive: lookThroughShot && shotAspectKey === I2V_MOTION_SHOT_ASPECT,
	};
	const i2vMotionActions = {
		setI2vMotion: motionDomain.setI2vMotion,
		setMode: setI2vMotionMode,
		enterFraming: enterI2vFraming,
		markPose: markI2vPose,
		clearPose: clearI2vPose,
		clear: clearI2vMotion,
		toggleCameraLock: () => setI2vMotionCameraUnlocked((value) => !value),
		restoreCamera: restoreI2vCamera,
		generate: (kind) => void generateI2vMotion(kind),
		enableShaded: () => runStudioAction("view.setPartColours", { mode: "shaded" }),
	};
	const viewLooksActive = gridView || autoColor || partColoursEnabled;
	const rigSelection = parseRigNodeId(selectedHierarchyId);
	const isRigSelection = rigSelection !== null;
	const inspectorHasContent = isSceneSelection || isCameraSelection || isCharacterSelection || isRigSelection
		|| selectedHierarchyId === "environment" || selectedHierarchyId === "props" || selectedHierarchyId === "light" || Boolean(selectedSceneObject);

	useEffect(() => () => {
		if (multiModelObjectUrlRef.current) URL.revokeObjectURL(multiModelObjectUrlRef.current);
	}, []);

	// Hosted-demo seed. A build served as static files has no ARDY sidecar, so
	// a first-time visitor would otherwise land on a character standing still
	// with no way to see generated motion. The clip below ships with the build
	// and is loaded once, only when the bridge is absent and nothing has been
	// loaded or generated yet. A local session with the bridge running is
	// untouched.
	const motionRefsRestored = useRef(false);
	useEffect(() => {
		if (motionRefsRestored.current) return;
		motionRefsRestored.current = true;
		restoreMotionRefs(startupStage.characters);
		// Parse the thumbnail rigs during startup idle so the first pose-studio
		// open starts rendering immediately instead of paying a 100ms+ FBX parse.
		warmPoseThumbnails();
		if (startupCreatedScene) track("scene:created", { scene_source: "startup" });
		// eslint-disable-next-line react-hooks/exhaustive-deps
	}, []);

	const demoSeeded = useRef(false);
	// Latched on the first healthy probe: a session that has seen the sidecar is
	// not the hosted demo, and a later failed probe is a blip, not "no bridge".
	const bridgeSeenOk = useRef(false);
	useEffect(() => {
		const demoSeed = demoSeedGate(bridge, bridgeSeenOk.current);
		bridgeSeenOk.current = demoSeed.bridgeSeenOk;
		if (demoSeeded.current) return;
		if (!activeRig || motion || motionBusy) return;
		// A hosted-demo result link opens the app with ?motion=<url>. The value
		// is gated by motionUrlFromQuery (same-origin or allowlisted https host
		// only) and, unlike the shipped seed below, loads regardless of bridge
		// state — the visitor followed a link whose whole point is this clip.
		const queryMotion = motionUrlFromQuery(window.location.search, window.location.origin);
		if (queryMotion) {
			demoSeeded.current = true;
			loadMotion(queryMotion, "").catch(() => {
				/* a dead link degrades to the normal empty stage, not an error */
			});
			return;
		}
		// The seed dresses a visitor's first, unnamed stage and the starter set a
		// `?scene=` launch always re-opens ("one character mid-walk"). A named
		// project is the author's document: reloading it must never put the demo
		// walk back on a character they deliberately left without a take.
		if (loadProjectSession()?.name && !new URLSearchParams(window.location.search).get("scene")) { demoSeeded.current = true; return; }
		if (!demoSeed.seed) return;
		demoSeeded.current = true;
		// Loaded, not played: the clip walks the subject out of the default
		// framing, so autoplay would greet a first-time visitor with an empty
		// room. Frame 0 is composed; PLAYBACK is one click away.
		loadMotion(DEMO_MOTION_URL, DEMO_MOTION_PROMPT).catch(() => {
			/* the seed is a nicety, never a failure the visitor must act on */
		});
	}, [bridge, activeRig, motion, motionBusy]);

	// The camera tutorial's seed (#209). The hosted-demo seed above is gated on
	// a missing bridge, which is why the tutorial used to open on an empty room
	// in a local session. startCameraTutorial arms tutorialSeedPending once the
	// starter scene is applied, and the same clip goes on regardless of bridge
	// state as soon as that scene's character has a parsed rig — a state
	// condition, not a timer, exactly like the seed above.
	useEffect(() => {
		if (!tutorialSeedPending || !activeRig || motionBusy) return;
		const seedEpoch = tutorialSeedEpochRef.current;
		if (seedEpoch === null || seedEpoch !== tutorialProjectEpochRef.current) {
			tutorialSeedEpochRef.current = null;
			setTutorialSeedPending(false);
			return;
		}
		tutorialSeedEpochRef.current = null;
		setTutorialSeedPending(false);
		demoSeeded.current = true; // one seeded clip per session, whichever got here first
		loadMotion(DEMO_MOTION_URL, DEMO_MOTION_PROMPT, undefined, null, activeChar.id, null, { tutorialEpoch: seedEpoch }).catch(() => {
			/* the take is the tutorial's set dressing, never an error to act on */
		});
		// eslint-disable-next-line react-hooks/exhaustive-deps
	}, [tutorialSeedPending, activeRig, motionBusy]);

	// Drive every cast member from ITS OWN clip on the shared playhead. The
	// active character's buffer motion and the stored session motions of the
	// others all advance together; characters without a clip keep their pose.
	// Without the inactive pass a focus switch silently reverted everyone else
	// to their uncorrected take.
	useEffect(() => {
		// The ACTIVE member's clip only: its own corrections are applied by the
		// evaluate effect below, after its editing state settles.
		if (activeCapabilities.rig) poseMemberAtFrame(rigs[activeChar.id], motion, null, tlFrame);
		poseOtherCastMembers(tlFrame);
		// eslint-disable-next-line react-hooks/exhaustive-deps
	}, [characters, activeChar.id, motion, rigs, tlFrame, ikTick]);

	// The shared timeline spans the longest CURRENT content on the production
	// clock. Recomputing both directions matters: deleting Subject 2 or
	// shortening its take must pull the end back in instead of leaving the
	// recorder with frozen tail frames (#80).
	useEffect(shotsDomain.syncTimelineExtent, [characters, activeChar.id, motion, promptClips, multiModelFootage?.frames, shots]);

	/* ------------------------------ IK logic ------------------------------ */

	// Resolve the IK rig (chains + FK swing joints) whenever the ACTIVE
	// character's rig (re)loads. A rig missing any bone resolves to null and
	// IK mode stays unavailable.
	useEffect(() => {
		const resolved = activeCapabilities.ik ? resolveIkRig(activeRig) : null;
		const chains = resolved ? resolved.chains : null;
		setIkChains(chains);
		setIkFkJoints(resolved ? resolved.fkJoints : null);
		ikStateRef.current.chains = chains;
		// Cached on the state so this character's corrections stay evaluable
		// after a focus switch (#77) — the playback and export loops read them.
		ikStateRef.current.fkJoints = resolved ? resolved.fkJoints : null;
		ikStateRef.current.rig = chains ? activeRig : null;
		if (!chains) leaveIkMode();
	}, [activeRig, activeCapabilities.ik]);

	// Whether the collision capsules can be built for this rig at all. Bone
	// lookups only — no mesh measurement — so it is cheap enough to hang off
	// the rig identity and read straight in the render. A rig that resolves
	// for IK can still miss the toes/spine the capsule table needs, so this is
	// a SEPARATE question from `ikChains`: the two collision buttons disable
	// on it rather than offering a click whose only possible answer is "not
	// supported".
	const collisionCleanupSupported = useMemo(() => activeCapabilities.physics && supportsCollisionCleanup(activeRig), [activeRig, activeCapabilities.physics]);

	//

	useEffect(() => {
		physicsJobRef.current += 1;
		physicsSourceCacheRef.current.value = null;
		setPhysicsPreview(null);
		setPhysicsOptions({ overrides: [], protectedFrames: [], strength: 1 });
		setAutoPhysicsRunning(false);
		autoPhysicsRunRef.current = null;
		return () => { physicsJobRef.current += 1; };
	}, [activeRig, motion, activeChar.x, activeChar.y, activeChar.z, activeChar.rot, activeChar.scale]);
	useEffect(() => {
		if (physicsPreview && physicsPreview.sourceStamp !== physicsKeyStamp(ikStateRef.current.keys)) {
			setPhysicsPreview(null);
		}
	}, [ikTick, physicsPreview]);

	// Keyed-pose playback: the IK layer's keyed bone rotations apply at the
	// current frame whether or not IK edit mode is on — IK-authored keys are
	// the source of truth (the user designs first/end keys and ARDY in-
	// betweens them), so scrubbing/playing with IK OFF must still show them.
	// With a motion loaded the clip is the base layer: this effect runs
	// AFTER the motion-apply effect above (definition order), so the keys
	// override the generated pose exactly where corrections were authored —
	// and ONLY there: the blend window eases each correction back to the
	// clip outside its keyed range, so keying frame 39 alone no longer
	// stomps every earlier frame. Skipped while the pose studio is open (FK
	// edits there would be stomped). With no keys at all and IK off there is
	// nothing to apply — pure FK posing / pure motion playback stays
	// untouched.
	useEffect(() => {
		if (!ikChains || !activeRig || posing) return;
		// Preview changes may re-run this effect without a playhead change.
		// Always re-establish the motion base before adding a correction.
		if (motion) poseMemberAtFrame(activeRig, motion, null, tlFrame);
		const layer = pendingIkEdit?.characterId === activeChar.id ? pendingIkEdit.candidate
			: physicsPreview && physicsShow ? physicsPreview.candidate : ikStateRef.current;
		if (ikMode || layer.keys.size > 0) {
			ikEvaluate(ikChains, layer, tlFrame, ikFkJoints, motion ? IK_CORRECTION_BLEND_FRAMES : 0);
		}
	}, [ikMode, ikChains, activeRig, motion, posing, tlFrame, ikTick, ikFkJoints, physicsPreview, physicsShow, pendingIkEdit, activeChar.id]);

	// Re-seat the handles on the keyed pose when the FRAME changes with IK
	// on — scrubbing to frame 39 shows that frame's interpolated pose AND
	// places the handles on its effectors, ready to edit into a new key.
	// Deliberately NOT in the evaluate effect above: a gizmo axis drag can
	// leave the target offset from the effector on purpose, and re-seeding
	// after every bake would wipe that relationship mid-workflow.
	const ikPrevFrameRef = useRef(tlFrame);
	useEffect(() => {
		const frameChanged = ikPrevFrameRef.current !== tlFrame;
		ikPrevFrameRef.current = tlFrame;
		if (!ikMode || !ikChains || !activeRig || posing) return;
		if (!frameChanged) return; // pure toggle-on: evaluate already ran
		ikSeedTargets(ikChains, ikStateRef.current);
	}, [ikMode, ikChains, activeRig, motion, posing, tlFrame, ikTick, ikFkJoints]);

	// QA hook: lets headless visual checks read the live rig/motion state
	// (tools/ardy/visual-qa.mjs). Harmless in normal use.
	useEffect(() => {
	window.__cozyclay = {
			runStudioAction,
			runArdy: (options) => appContext.live.state.runArdy(options),
			rigA: activeRig, motion, tlFrame, frameCount: tlFrameCount, playing: tlPlaying, ikMode, ikChains, ikFocus, contactRadii: ikChains?.values().next().value?.contactRadii ?? null, ik: ikStateRef.current,
			rangePins, rangePinResiduals,
			rangePinApplySpec: motionDomain.rangePinApplySpec,
			rangePinEffector: (track) => {
				const chain = ikChains?.get(track), bone = chain?.bones?.[2];
				if (!bone) return null;
				const point = new THREE.Vector3(); bone.getWorldPosition(point);
				return point.toArray();
			},
			committedIkEdits, waypoints,
			// Scene props as the stage sees them, for QA that places a box and
			// waits for its transform to land before fitting to it.
			objects: sceneObjects,
			// the camera the main view renders through (poser in IK mode) — QA
			// projections must use this one, not the frozen shot camera
			activeCam: ikMode ? poserCamRef.current : lookThroughShot ? shotCamRef.current : editorCamRef.current,
			shotCam: shotCamRef.current,
			poserCam: poserCamRef.current,
			planCam: planCamRef.current,
			editorCam: editorCamRef.current,
			// QA-only: swap the active character's body ("x-bot-tpose" / "y-bot-tpose")
			// or stature, so a browser QA run can check every shipped rig.
			setCharacterModel: (id) => updateCharacterAt(activeCharIndex, { model: id }),
			setPartColours: (enabled, mode = "shaded") => {
				setPartColoursEnabled(!!enabled);
				setPartColoursMode(mode === "flat" ? "flat" : "shaded");
			},
			setCharacterScale: (scale) => updateCharacterAt(activeCharIndex, { scale }),
			// QA-only: the production notes a framing capture carries (lens,
			// delivery aspect, cast, cut range, target video model) for the frame
			// the playhead is on — the same object both capture paths attach.
			// Read through liveStateRef, which every render refreshes: this hook's
			// effect does not depend on the shot list, so a closure over it would
			// answer with the cut as it stood when the effect last ran.
			captureMeta: (frame) => appContext.live.state.captureShotMeta(frame ?? appContext.live.state.timeline.currentFrame),
			// QA-only reference slots (#167): set the pictures a headless run cannot
			// reach through a file dialog, then take the capture the live
			// capture_framing_png command returns — references included.
			setCharacterIdentityImage: (index, dataUrl) => {
				updateCharacterAt(index, { identityImage: normalizeReferenceImage(dataUrl) });
				return true;
			},
			setEnvironmentImage: (dataUrl) => {
				runStudioAction("stage.setEnvironment", { environmentImage: normalizeReferenceImage(dataUrl) });
				return true;
			},
			captureWithReferences: () => liveQueries.capture_framing_png({}),
			importAsset: async ({ dataUrl: source, ...args }) => (await appContext.bus.run("asset.import", { source, ...args })).output,
			sceneObject: { place: ({ kind, name, parent, ...placement }) => ({ id: appContext.bus.run("object.add", { kind, ...(name === undefined ? {} : { name }), ...(parent === undefined ? {} : { parent }), placement }).affectedIds[0] }), update: ({ id, scale, ...patch }) => appContext.bus.run("object.update", { id, patch: { ...(scale === undefined ? {} : { scaleX: scale, scaleY: scale, scaleZ: scale }), ...patch } }) },
			// QA-only reference exports (#165): the production builders without the
			// download, so a headless run can unzip a real pack and diff the passes
			// instead of driving a file dialog. Same liveStateRef reasoning as
			// captureMeta — the effect does not depend on the shot list.
			exportKeyframePack: async (shotId) => {
				const attempt = startExportAttempt({ export_kind: "keyframe_pack", format: "zip", surface: embedMode ? "embed" : "studio" });
				try {
					const live = appContext.live.state;
					const index = live.shotIndexForPack(shotId ?? null);
					const pack = await live.buildShotKeyframePack(live.shots[index], index);
					// base64: a pack holds an MP4, and a megabyte-scale JS number array
					// is not something to hand a CDP evaluate.
					let binary = "";
					for (const byte of pack.bytes) binary += String.fromCharCode(byte);
					const result = { name: pack.name, entries: pack.entries.map((entry) => entry.name), byteLength: pack.bytes.byteLength, bytes: btoa(binary) };
					attempt.succeed();
					return result;
				} catch (error) {
					attempt.fail(error);
					throw error;
				}
			},
			renderPass: (kind) => appContext.live.state.renderPassDataUrls([kind])[kind],
			// QA-only video export (#193): the Export menu's Video item without the
			// download, so a headless run can assert that a keyless 40-frame static
			// shot yields 40 frames. Same liveStateRef reasoning as captureMeta.
			exportShotVideo: (options = {}) => appContext.live.state.exportShotVideo(options),
			// Open the production result modal so QA clicks its real download.
			prepareFrameExport: () => { appContext.live.state.generate(); },
			// The RGB plate the passes are compared against — same rig, same
			// framing, no material override.
			capturePlate: () => appContext.live.state.captureFramingPng(appContext.live.state.captureCurrentFraming()),
			captureFraming: (framing, output) => appContext.live.state.captureFramingPng(framing, output),
			characterScale: activeChar?.scale ?? 1,
			characterModel: activeChar?.model ?? null,
			// QA-only framing: FlyControls rewrites the editor camera's rotation
			// from editorLook every frame, so a bare camera.lookAt is overwritten
			// before the next paint. Set both, the way the live frame_shot does.
			frameEditorCam: (position, target) => {
				const camera = editorCamRef.current;
				if (!camera) return false;
				const angles = aimAt(position, target);
				editorLook.current.yaw = angles.yaw;
				editorLook.current.pitch = angles.pitch;
				camera.position.set(position.x, position.y, position.z);
				camera.rotation.order = "YXZ";
				camera.rotation.set(angles.pitch, angles.yaw, 0);
				camera.updateProjectionMatrix();
				return true;
			},
			lookThroughShot,
			setLookThrough: (value) => setLookThroughShot(!!value),
			charA,
			insetPane: insetPaneRef.current,
			mainPane: mainPaneRef.current,
			// the selected prop's route, so QA can aim a gesture at the line
			objectPath: selectedSceneObject?.path ?? null,
			pathPointIndex,
			pathHandlesEnabled: !preview && !lookThroughShot && !ikMode && !posing && !!selectedSceneObject?.path,
			addSceneObject: (kind, placement = {}) => addSceneObject(kind, placement),
			scrub: (frame) => setTlFrame(Math.max(0, Math.min(tlFrameCount - 1, Math.round(frame)))),
			pause: () => setTlPlaying(false),
			// Motion-trail QA surface: read the current trail policy and drive the
			// same drag -> preview -> pending-edit path headless checks cannot reach
			// through synthetic pointers reliably.
			trail: { falloffFrames: trailFalloffFrames, falloffS: trailFalloffS, edit: trailEdit, tool: ikEditTool, visible: showTrails, activeTrackId: trailTrackFocus, visibleTracks: trailTrackFocus ? [trailTrackFocus] : null },
			trailPoints: (jointName = "Hips") => jointTrailPoints(motion, jointName, { baseY: activeChar.y ?? 0, scale: activeChar.scale ?? 1 }),
			trailEditApply: (grabFrame, delta) => {
				onTrailDragStart({ track: "hips", grabFrame });
				onTrailDragPreview({ track: "hips", grabFrame, delta });
				onTrailDragEnd({ track: "hips", grabFrame, delta });
			},
			// QA-only IK drag seam: resolves the same production solve/end path as
			// the viewport manipulator, with a deterministic world-space offset.
			ikPreviewApply: (track = "leftHand", offset = { x: 0.02, y: 0, z: 0 }) => {
				const chain = ikChains?.get(track), bone = chain?.bones?.[2];
				if (!bone) return false;
				const target = bone.getWorldPosition(new THREE.Vector3()).add(new THREE.Vector3(offset.x ?? 0, offset.y ?? 0, offset.z ?? 0));
				ikSolve("chain", track, target);
				ikDragEnd();
				return true;
			},
			trailRegenerate: runTrailRegeneration,
			// Fix-collisions QA surface: live penetration readout for headless
			// checks; the fix itself runs through the buttons / runFixCollisions.
			// null (not []) on an unsupported rig, so a check can tell "the tool
			// cannot describe this skeleton" from "this pose is clean".
			// EXTERNAL blockers ride this readout too, so a headless check can see
			// `leftHand×obj:chair` / `leftHand×char:subject-2:torso` and not just
			// self-collisions. A blocker hit has no `def` on its side of the pair
			// — it is not a capsule of THIS rig — so the label falls back to the
			// blocker's own namespaced id.
			fcDetect: () => {
				const capsules = activeRig ? buildCollisionCapsules(activeRig) : null;
				if (!capsules) return null;
				const label = (side) => side?.def?.id ?? side?.id ?? "?";
				return detectPenetrations(capsules, { blockers: externalBlockers(tlFrame) })
					.map((p) => ({ pair: `${label(p.a)}×${label(p.b)}`, depth: p.depth }));
			},
			// What those `obj:` / `char:` names stand for, as plain numbers: the
			// boxes and capsules the fixer is being asked to keep the body out of.
			fcBlockers: () => blockerSummary(externalBlockers(tlFrame)),
			// AutoPhysics QA surface: the centre of mass of the CURRENT pose, so
			// a headless check can sample the arc before/after the button press.
			apCom: () => {
				const com = activeRig ? computeCenterOfMass(activeRig) : null;
				return com ? { x: com.x, y: com.y, z: com.z } : null;
			},
			apFeet: () => {
				const points = activeRig ? markerPositions(activeRig) : null;
				return points ? Object.fromEntries(Object.entries(points).map(([name, point]) => [name, { x: point.x, y: point.y, z: point.z }])) : null;
			},
			apRun: runAutoPhysics,
			physics: { preview: physicsPreview, show: physicsShow, running: autoPhysicsRunning, options: physicsOptions },
			platformFit: {
				running: platformFitRunning, applied: platformFitApplied, last: platformFitLast,
				run: () => Promise.resolve(motionDomain.run('motion.platformFit.run', { characterId: activeChar?.id })).then(receipt => receipt.output),
				remove: () => Promise.resolve(motionDomain.run('motion.platformFit.remove', { characterId: activeChar?.id })).then(receipt => receipt.output),
			},
			apOptions: changePhysicsOptions,
			preview,
			pathDraw,
		};
		// eslint-disable-next-line react-hooks/exhaustive-deps
		// sceneObjects/rigs/characters ride the deps because fcDetect/fcBlockers
		// close over them: a stale closure would report the set as it was two
		// edits ago — and, after an undo that removes a subject, would keep
		// reporting the ghost's capsules.
	}, [activeRig, motion, tlFrame, tlFrameCount, ikMode, ikChains, ikFocus, ikTick, charA, rangePins, rangePinResiduals, committedIkEdits, waypoints, lookThroughShot, selectedSceneObject, sceneObjects, rigs, characters, pathPointIndex, preview, posing, playMode, pathDraw, trailEdit, trailTrackFocus, pendingIkEdit, trailFalloffFrames, trailFalloffS, ikEditTool, showTrails, physicsPreview, physicsShow, physicsOptions, autoPhysicsRunning, platformFitRunning, platformFitLast, platformFitApplied]);
	// QA hook (plan §6.5): exposes history depth and the present === objects
	// invariant so the browser suite can assert undo entry counts directly.
	// Reads live store state at call time; re-registered after every render.
	useEffect(() => {
		window.__sceneHistory = () => ({ ...store.depths(), settled: store.present() === store.objects });
	});
	// QA-only project-file seam: browser acceptance tests still exercise the
	// production serializer/parser and apply path without depending on native
	// file-picker UI, which headless Chrome does not expose consistently.
	useEffect(() => {
		window.__cozyclayProject = {
			export: (name = "QA Project") => collectProjectSerialized(name),
			open: async (text) => {
				const result = readProjectDocument(text);
				if (!result.ok) return result;
				await rehydrateProjectAssets(result.project, result.warnings);
				applyProject(result.project);
				setToast(`${isKo ? `프로젝트 열림: ${result.project.name}` : `Project opened: ${result.project.name}`}${projectProblemsNotice(result.problems)}`);
				return result;
			},
			manifest: () => projectManifest,
			saveBlocked: () => saveBlockedReasons,
		};
		return () => {
			if (window.__cozyclayProject?.export) delete window.__cozyclayProject;
		};
	});

	// On clear, restore the exact pre-playback bone rotations. This runs in
	// the parent AFTER Character's pose effect (children flush first), so even
	// a pose change made during playback cannot leak into the restored rig.
	useEffect(() => {
		if (motion) return;
		const saved = restoreRef.current;
		if (!saved) return;
		restoreRef.current = null;
		restorePlaybackBones(saved.rig, saved.bones);
	}, [motion]);

	const playbackSceneBase = useMemo(() => ({
		frameCount: tlFrameCount,
		fps: tlFps,
		subject: charA,
		motion,
		cameraAnchor: charA,
		fovDeg,
		filmback,
	}), [tlFrameCount, tlFps, charA, motion, fovDeg, filmback]);
	// The camera's subject grouped under a routed object (#655) stands where
	// that object carries it: its played root through the object's carry,
	// frame by frame — the same carry the renderer gives the body. Null when it
	// rides nothing, so every reader below keeps the plain played root.
	const subjectCarry = useMemo(() => {
		if (!charA.parent) return null;
		const objects = new Map(sceneObjects.map((object) => [object.id, object]));
		const take = { frameCount: tlFrameCount, fps: tlFps };
		return (point, frame) => {
			if (!point) return point;
			const at = carriedPointAt(objects, charA.parent, { x: point.x, y: charA.y ?? 0, z: point.z }, frame, take);
			return { x: at.x, z: at.z };
		};
	}, [charA.parent, charA.y, sceneObjects, tlFrameCount, tlFps]);
	const motionPos = useMemo(() => {
		if (!motion && !subjectCarry) return null;
		const subject = sampleAt(playbackSceneBase, null, tlFrame).subject;
		return subjectCarry ? subjectCarry(subject, tlFrame) : subject;
	}, [motion, subjectCarry, playbackSceneBase, tlFrame]);

	// The subject's full per-frame scene trajectory — what the follow camera
	// is derived from. Without a loaded motion, and riding nothing, the subject
	// stands still and the follow camera simply composes a static frame.
	const subjectTrack = useMemo(() => {
		if (!shots.some((shot) => shot.camera?.mode === "follow" || shot.camera?.mode === "rail")) return null;
		const frames = Math.max(tlFrameCount, 1);
		return Array.from({ length: frames }, (_, frame) => {
			const subject = sampleAt(playbackSceneBase, null, frame).subject;
			return subjectCarry ? subjectCarry(subject, frame) : subject;
		});
	}, [shots, playbackSceneBase, tlFrameCount, subjectCarry]);

	// The dense rail (spline through the drawn control points) — shared by
	// the follow controller and the Top-View display.
	const railCurve = useMemo(() => (cameraRail ? buildRail(cameraRail) : null), [cameraRail]);

	const followTrack = useMemo(() => {
		if (!subjectTrack) return null;
		const yaw = (charA.rot * Math.PI) / 180;
		const combined = new Array(subjectTrack.length).fill(null);
		for (let index = 0; index < shots.length; index += 1) {
			const shot = shots[index];
			const camera = createCameraBlock(shot.camera);
			if (camera.mode === "keys") continue;
			const start = shot.startFrame;
			const end = Math.min(subjectTrack.length, shot.endFrame + 1);
			const subjectSlice = subjectTrack.slice(start, end);
			const params = { ...camera.followCam, craneHeight: camera.craneHeight, dollyTiming: camera.dollyTiming, initialDir: { x: Math.sin(yaw), z: Math.cos(yaw) } };
			const rail = camera.mode === "rail" ? buildRail(camera.cameraRail) : null;
			if (rail) {
				const schedule = resolveRailSchedule({ railFollow: camera.railFollow, cameraRail: camera.cameraRail, frameCount: subjectSlice.length });
				if (schedule.kind !== RAIL_SCHEDULE_RANGE && schedule.kind !== RAIL_SCHEDULE_LEGACY) continue;
				const railSlice = subjectSlice.slice(schedule.startFrame, schedule.endFrame + 1);
				const track = buildRailFollowTrack(railSlice, tlFps, rail, params);
				track.forEach((sample, offset) => { combined[start + schedule.startFrame + offset] = sample; });
			} else {
				const track = buildFollowTrack(subjectSlice, tlFps, params);
				track.forEach((sample, offset) => { combined[start + offset] = sample; });
			}
		}
		return combined;
	}, [shots, subjectTrack, tlFps, charA.rot]);

	const playbackScene = useMemo(() => ({
		...playbackSceneBase,
		subjectTrack,
		cameraTrack: followTrack,
	}), [playbackSceneBase, subjectTrack, followTrack]);

	// Browser acceptance seam: it invokes the exact production exporter but
	// suppresses the download, returning only serializable evidence.
	useEffect(() => {
		const api = async (options = {}) => {
			const { probeMetadata = false, ...range } = options;
			const { blob, ...result } = await runShotExport({ ...range, download: false });
			if (!probeMetadata) return { ...result, blobSize: blob.size };
			const url = URL.createObjectURL(blob);
			const video = document.createElement("video");
			let metadata;
			try {
				metadata = await new Promise((resolve, reject) => {
					const timer = setTimeout(() => reject(new Error("exported MP4 metadata timed out")), 5000);
					video.onloadedmetadata = () => {
						clearTimeout(timer);
						resolve({ duration: video.duration, width: video.videoWidth, height: video.videoHeight });
					};
					video.onerror = () => {
						clearTimeout(timer);
						reject(new Error("browser could not decode exported MP4 metadata"));
					};
					video.preload = "metadata";
					video.src = url;
				});
			} finally {
				video.removeAttribute("src");
				video.load();
				URL.revokeObjectURL(url);
			}
			return { ...result, blobSize: blob.size, metadata };
		};
		window.__exportOffscreen = api;
		return () => {
			if (window.__exportOffscreen === api) delete window.__exportOffscreen;
		};
	});

	// The follow camera owns the shot camera in the same situations key
	// following would: never while an authoring mode holds the viewport.
	const followCamActive =
		activeCamera.mode !== "keys" && !!followTrack?.[tlFrame] && (preview || (!ikMode && !waypointMode && !posing));

	// Implied locomotion speed per authored segment, on the timeline clock
	// (m/s is physical, so the judge always uses tlFps). Shown in the
	// timeline hint so a path that forces a crawl or a sprint is visible
	// before spending a generation on it.
	const pathSpeed = useMemo(() => {
		if (waypoints.length < 1) return null;
		let min = Infinity;
		let max = 0;
		const path = [rootStart(), ...[...waypoints].sort((a, b) => a.frame - b.frame)];
		for (let i = 1; i < path.length; i += 1) {
			const a = path[i - 1];
			const b = path[i];
			const seconds = (b.frame - a.frame) / tlFps;
			if (seconds <= 0) continue;
			const speed = Math.hypot(b.x - a.x, b.z - a.z) / seconds;
			min = Math.min(min, speed);
			max = Math.max(max, speed);
		}
		if (!Number.isFinite(min)) return null;
		return { min, max, warn: min < 0.5 || max > 3 };
	}, [activeChar.x, activeChar.z, tlFps, waypoints]);

	const stateBadge = ardyRunning
		? { label: ko("GENERATING", "생성 중"), kind: "generating" }
		: motion
			? { label: ko("PLAYBACK", "재생"), kind: "playback" }
			: waypointMode
				? { label: ko("ROOT PATH", "루트 경로"), kind: "root" }
				: null;

	function bufferToPng(buffer, output = shotOutput) {
		const canvas = document.createElement("canvas");
		if (output === shotOutput) {
			canvas.width = shotOutput.width;
			canvas.height = shotOutput.height;
		} else {
			canvas.width = output.width;
			canvas.height = output.height;
		}
		const ctx = canvas.getContext("2d");
		const image = ctx.createImageData(output.width, output.height);
		// WebGL reads bottom-up; flip into canvas order.
		for (let row = 0; row < output.height; row += 1) {
			const from = (output.height - 1 - row) * output.width * 4;
			image.data.set(
				buffer.subarray(from, from + output.width * 4),
				row * output.width * 4
			);
		}
		ctx.putImageData(image, 0, 0);
		return canvas.toDataURL("image/png");
	}

	/** Park the shot camera on a framing, read back an offscreen PNG, and put
	    everything back before the next paint — the viewport never sees it. */
	function captureFramingPng(framing, output = shotOutput) {
		const cam = shotCamRef.current;
		if (!cam || !captureRef.current) return null;
		const prev = { x: cam.position.x, y: cam.position.y, z: cam.position.z, yaw: look.current.yaw, pitch: look.current.pitch, fov: cam.fov };
		cam.position.set(framing.pos.x, framing.pos.y, framing.pos.z);
		cam.rotation.order = "YXZ";
		cam.rotation.set(framing.pitch, framing.yaw, 0);
		cam.fov = framing.fovDeg;
		const prevAspect = cam.aspect;
		const offset = framing.viewOffset;
		if (offset) {
			cam.aspect = offset.fullWidth / offset.fullHeight;
			cam.setViewOffset(offset.fullWidth, offset.fullHeight, offset.x, offset.y, offset.width, offset.height);
		}
		cam.updateProjectionMatrix();
		const needsOwnTarget = output.width !== shotOutput.width || output.height !== shotOutput.height;
		const capture = needsOwnTarget && typeof captureRef.current.createExportCapture === "function"
			? captureRef.current.createExportCapture(output)
			: captureRef.current;
		try {
			const buffer = capture.render();
			return buffer ? bufferToPng(buffer, output) : null;
		} finally {
			if (needsOwnTarget) capture.dispose?.();
			cam.position.set(prev.x, prev.y, prev.z);
			cam.rotation.set(prev.pitch, prev.yaw, 0);
			look.current.yaw = prev.yaw;
			look.current.pitch = prev.pitch;
			cam.fov = prev.fov;
			if (offset) {
				cam.clearViewOffset();
				cam.aspect = prevAspect;
			}
			cam.updateProjectionMatrix();
		}
	}

	/** The canvas runs under the floating panels, so "what I see" is only the uncovered middle.
	    Returns the largest centred `aspect` rectangle inside that region as a camera view offset. */
	function visibleViewOffset(aspect) {
		const canvas = document.querySelector(".viewport canvas");
		if (!canvas) return null;
		const box = canvas.getBoundingClientRect();
		const edge = (selector, side) => {
			const rect = document.querySelector(selector)?.getBoundingClientRect();
			return rect && rect.width > 0 && rect.height > 0 ? rect[side] : null;
		};
		const left = Math.max(box.left, edge(".studio-left-column", "right") ?? box.left);
		const right = Math.min(box.right, edge(".studio-right-column", "left") ?? box.right);
		const top = Math.max(box.top, edge(".topbar", "bottom") ?? box.top);
		const bottom = Math.min(box.bottom, edge(".studio-dock-slot", "top") ?? box.bottom);
		if (right - left < 50 || bottom - top < 50) return null;
		const width = Math.min(right - left, (bottom - top) * aspect);
		const height = width / aspect;
		return {
			fullWidth: box.width, fullHeight: box.height,
			x: (left + right) / 2 - width / 2 - box.left, y: (top + bottom) / 2 - height / 2 - box.top,
			width, height,
		};
	}

	/** Pose mode's image generation: the shot camera's view of the pose as it stands, at the
	    delivery size, plus the scene's identity/environment references. The pose-mode object
	    fade is lifted for this draw only (the props' next frame puts it back), and editor
	    overlays such as motion trails are hidden around it. */
	function capturePoseImage(source = "view") {
		const viewCam = source === "view" ? poserCamRef.current : null;
		let framing = captureCurrentFraming();
		if (viewCam) {
			const dir = viewCam.getWorldDirection(new THREE.Vector3());
			const pos = viewCam.getWorldPosition(new THREE.Vector3());
			framing = captureFraming({ pos, yaw: Math.atan2(-dir.x, -dir.z), pitch: Math.asin(THREE.MathUtils.clamp(dir.y, -1, 1)), fovDeg: viewCam.fov });
			framing.viewOffset = visibleViewOffset(shotOutput.width / shotOutput.height);
		}
		const scene = captureRef.current?.scene;
		const overlays = [];
		scene?.traverse((node) => {
			if (node.userData.editorOverlay && node.visible) { node.visible = false; overlays.push(node); }
		});
		suspendPoseFade(true);
		propSyncRef.current?.();
		try {
			const dataUrl = captureFramingPng(framing, shotOutput);
			return dataUrl ? { dataUrl, references: captureShotReferences() } : null;
		} finally {
			suspendPoseFade(false);
			for (const node of overlays) node.visible = true;
		}
	}

	function copyPrompt(prompt) {
		const write = navigator.clipboard?.writeText(prompt);
		if (!write) return;
		write
			.then(() => {
				setCopied(true);
				setToast(ko("Prompt copied to clipboard", "프롬프트를 클립보드에 복사했어요"));
			})
			.catch(() => {});
	}

	function generate() {
		const model = mode === "image" ? IMAGE_MODELS.find((m) => m.id === imageModel) : null;
		// Generation follows the Camera Block owned by the Shot under the playhead.
		// Keys use their authored endpoints; Follow/Rail use the deterministic
		// track already used by playback, so prompt and conditioning describe the
		// same camera department instruction the editor previews.
		const movePlan = mode === "video" && activeCamera.mode === "keys" ? moveSequence : null;
		const trackedFramings = activeShot && activeCamera.mode !== "keys"
			? followTrack
				?.slice(activeShot.startFrame, activeShot.endFrame + 1)
				.filter(Boolean)
				.map((sample) => ({ ...sample, fovDeg })) ?? []
			: [];
		const blockFramings = activeCamera.mode === "keys"
			? cameraKeys.map((key) => key.framing)
			: trackedFramings;
		const framingA = blockFramings[0] ?? null;
		const framingB = blockFramings.length > 1 ? blockFramings[blockFramings.length - 1] : null;
		const promptSubject = activeShot && subjectTrack?.[activeShot.startFrame]
			? { ...charA, ...subjectTrack[activeShot.startFrame] }
			: charA;
		const blockMove = mode === "video" && activeShot && activeCamera.mode !== "keys"
			? activeCamera.mode === "rail"
				? "a continuous rail tracking move following the subject"
				: "a continuous follow-camera move maintaining the authored framing"
			: null;
		const prompt = composePrompt({
			mode,
			model,
			shot: movePlan?.fromShot ?? (framingA
				? deriveShot(framingA.pos, promptSubject, (framingA.fovDeg * Math.PI) / 180, SUBJECT_HEIGHT_M, filmback)
				: shot),
			subject,
			subject2: showB ? subject2 : null,
			posePhrase: poseA?.prompt ?? "",
			pose2Phrase: showB ? (poseB?.prompt ?? "") : "",
			environment,
			style,
			cameraMove: movePlan || blockMove ? CUSTOM_MOVE : cameraMove,
			customMove: movePlan?.phrase ?? blockMove ?? customMove,
			hasCharSheet,
			hasEnvSheet,
		});
		let frame = null;
		let frameB = null;
		if (activeCamera.mode === "keys" && cameraKeys.length) {
			frame = captureFramingPng(cameraKeys[0].framing);
			frameB = cameraKeys.length > 1 ? captureFramingPng(cameraKeys[cameraKeys.length - 1].framing) : null;
		} else if (framingA) {
			frame = captureFramingPng(framingA);
			frameB = framingB ? captureFramingPng(framingB) : null;
		} else {
			const buffer = captureRef.current?.render();
			frame = buffer ? bufferToPng(buffer) : null;
		}
		const nextResult = {
			prompt,
			frame,
			frameB,
			partColours: partColoursEnabled ? PART_COLOURS : null,
			move: movePlan,
			mode,
			modelLabel: model?.label,
			downloaded: false,
			shot: activeShot ? {
				id: activeShot.id,
				name: activeShot.name,
				startFrame: activeShot.startFrame,
				endFrame: activeShot.endFrame,
			} : null,
			fps: tlFps,
			aspectRatio: shotOutput.label,
			camera: activeShot ? {
				mode: activeCamera.mode,
				followCam: activeCamera.followCam,
				cameraRail: activeCamera.cameraRail,
				railFollow: activeCamera.railFollow,
				keys: cameraKeys,
			} : null,
			subjects: characters.filter((entry) => !entry.hidden).map((entry) => entry.subject ?? "a person"),
		};
		setResult(nextResult);
		setResultOpen(true);
		setCopied(false);
		setRecordedVideoName(null);
		copyPrompt(prompt);
		return nextResult;
	}

	function download() {
		if (recRef.current || result?.downloaded) return null;
		if (frameExportRef.current?.source === result) {
			if (frameExportRef.current.done) return null;
			return executeExportRequest(frameExportRef.current.request);
		}
		const snapshot = structuredClone(result);
		const frameJob = { source: result, done: false, request: null };
		frameJob.request = exportRequest("frame", (job) => {
			if (!snapshot?.frame) throw Object.assign(new Error("The captured frame is not ready"), { exportFailureCode: "render_failed" });
			updateExportStatus(job, "finalizing", { stage: "download", cancellable: false });
			const save = (href, name) => {
				if (job.request.handedOff.has(name)) return;
				saveDownload(href, name);
				job.request.handedOff.add(name);
			};
			if (snapshot.partColours && !job.request.handedOff.has("blocking-frame-palette.json")) {
				const blob = new Blob([JSON.stringify({ partColours: snapshot.partColours }, null, 2)], { type: "application/json" });
				const url = URL.createObjectURL(blob);
				try { save(url, "blocking-frame-palette.json"); }
				finally { setTimeout(() => URL.revokeObjectURL(url), 1000); }
			}
			if (snapshot.frameB) {
				save(snapshot.frame, "blocking-frame-A-start.png");
				save(snapshot.frameB, "blocking-frame-B-end.png");
			} else save(snapshot.frame, "blocking-frame.png");
			frameJob.done = true;
			setResult((current) => current === frameJob.source ? { ...current, downloaded: true } : current);
			setToast(ko("Frame download requested. Check your browser's downloads.", "프레임 다운로드를 요청했어요. 브라우저 다운로드를 확인하세요."));
		});
		frameExportRef.current = frameJob;
		return executeExportRequest(frameJob.request);
	}

	// Keep the optional sidecar live instead of freezing its startup state.
	// Developers commonly open the studio first and start `npm run bridge`
	// second; a one-shot failed probe left Generate disabled until reload.
	useEffect(() => {
		let alive = true;
		let inflight = null;
		// The poll answer is almost always identical to the last one; keeping the
		// previous object identity skips a full App re-render per poll. Each of
		// those renders costs ~80ms of main thread on this tree, which read as a
		// periodic hitch while orbiting/flying the camera.
		const refreshBridge = () => {
			if (inflight) return inflight;
			inflight = checkBridge().then((state) => {
				if (!alive) return;
				if (state.ok) trackFeature("mcp_connected");
				setBridge((previous) => JSON.stringify(previous) === JSON.stringify(state) ? previous : state);
				setLineEditBackend(hasLineEditCapability(state));
			}).finally(() => { inflight = null; });
			return inflight;
		};
		bridgeRefreshRef.current = refreshBridge;
		refreshBridge();
		const id = window.setInterval(refreshBridge, BRIDGE_RECHECK_MS);
		window.addEventListener("focus", refreshBridge);
		return () => {
			alive = false;
			window.clearInterval(id);
			window.removeEventListener("focus", refreshBridge);
		};
	}, []);

	// QA/programmatic requests must use the current render's same generation path.
	appContext.patchLive({ runArdy: runArdy });

	/* ======================= line editing (contract C6) =======================
	 * Grab the joint's own motion path on the viewport and pull it; the joint
	 * then follows the pulled path exactly.
	 *
	 * Four invariants hold this together and every function below serves one
	 * of them:
	 *   1. THE CURVE AND THE CAMERA ARE ONE OBJECT. uv only mean something
	 *      through the lens they were projected with, so the camera is captured
	 *      when the curve is built, stored next to it, and the pair is rebuilt
	 *      together when the view moves. Nothing re-reads old uv through a new
	 *      lens.
	 *   2. THE EDIT IS A DEFORMATION OF THE TAKE, NOT A REPLACEMENT OF IT. The
	 *      curve starts as the joint's current trajectory and the falloff pins
	 *      its ends there, so the first and last constrained frames always
	 *      agree with the take. That is the seam fix GP2 measured: 8.0x median
	 *      frame delta for an arbitrary line, 1.09x when the ends sit on the
	 *      joint's own path.
	 *   3. THE OVERLAY NEVER TOUCHES THE SCENE GRAPH. It is a plain 2D canvas
	 *      stacked on the stage, so an edit cannot disturb playback, picking
	 *      or the render loop, and it works identically in every view mode.
	 *   4. THE REQUEST IS ITS OWN RUN. C6 makes lineEdit exclusive with
	 *      preserve/waypoints/segments/motionEdit, so runLineEdit builds a
	 *      dedicated body instead of decorating runArdy's. The WIRE SHAPE is
	 *      untouched by the interaction change: points2d is still a <=64-point
	 *      viewport-normalized polyline. */

	/** The loaded take's length on the TIMELINE clock — C6's frameRange is in
	 * app clip frames and, unlike waypoints or motionEdit, is never converted
	 * to the bridge clock. */
	const lineClipFrames = motion?.frames ?? 0;
	/** THE TAKE, as opposed to what is on screen. While a line-edit preview is
	 * showing, `motion` is the draft and this is still the take the draft was
	 * drafted FROM — so an edit sources the take, the version strip keeps
	 * highlighting the take's own chip, and a preview can never quietly become
	 * the thing everything else is built on. With no preview the two are the
	 * same url, which is why every call site can read this one unconditionally. */
	const takeSourceUrl = linePreviewSource?.url ?? motion?.url ?? null;
	/** The authored range, or the whole clip when the user has not narrowed it.
	 * Re-derived rather than stored so loading a different take cannot leave a
	 * range pointing past the end of the new one. */
	const lineEditRange = useMemo(() => {
		if (!(lineClipFrames > 1)) return null;
		const start = Math.max(0, Math.min(lineRange?.startFrame ?? 0, lineClipFrames - 2));
		const end = Math.max(start + 2, Math.min(lineRange?.endFrame ?? lineClipFrames, lineClipFrames));
		return { startFrame: start, endFrame: end };
	}, [lineRange, lineClipFrames]);

	/* ---------------------------- the pins edit -----------------------------
	 * A pins edit is derived, not stored: the pins ARE the payload and the range
	 * follows from them (pinsFrameRange), so there is no second copy of either
	 * to keep in sync. `lineEditPayload` is what every downstream call site
	 * takes — Generate, the preview, the request builder — and it is the one
	 * place the two gestures meet. */
	const linePinRange = useMemo(
		() => (linePins.length ? pinsFrameRange(linePins, lineClipFrames) : null),
		[linePins, lineClipFrames],
	);
	const linePinEdit = useMemo(
		() => (linePins.length && linePinRange ? { pins: linePins, frameRange: linePinRange } : null),
		[linePins, linePinRange],
	);
	/** The edit in hand, whichever gesture made it. Null means "nothing to
	 * send", which is exactly what the Generate gate asks. */
	const lineEditPayload = lineCurve ?? linePinEdit;

	/** The joint's WORLD position at one frame, from the same trail sampler the
	 * curve is projected from — so a pin and the curve can never disagree about
	 * where the joint is. Null when there is no take, no trail or no such
	 * frame. */
	function lineJointWorldAt(frame) {
		const jointName = TRAIL_EFFECTOR_JOINTS[lineTrack];
		if (!motion || !jointName) return null;
		const trail = jointTrailPoints(motion, jointName, { baseY: activeChar.y ?? 0, scale: activeChar.scale ?? 1 });
		const index = Math.max(0, Math.min(Math.trunc(frame) || 0, motion.frames - 1));
		if (!trail || index * 3 + 2 >= trail.length) return null;
		return [trail[index * 3], trail[index * 3 + 1], trail[index * 3 + 2]];
	}

	/** Every pin as a WORLD point, for the overlay. Pins are stored in clip
	 * space (that is what the wire wants); drawing them means undoing the
	 * conversion, which is jointTrailPoints' own transform applied to one
	 * point. Kept here rather than storing both spellings: two stored copies of
	 * a coordinate is how a pin ends up drawn somewhere it was not placed. */
	function linePinWorld(pin) {
		if (!motion) return null;
		const basis = { baseY: activeChar.y ?? 0, scale: activeChar.scale ?? 1 };
		// Forward transform, mirroring motion-trail's jointTrailPoints.
		const clipToWorld = (p) => {
			const radians = ((Number.isFinite(motion.rotationDeg) ? motion.rotationDeg : 0) * Math.PI) / 180;
			const cos = Math.cos(radians);
			const sin = Math.sin(radians);
			const anchorFrame = Math.max(0, Math.min(motion.anchorFrame || 0, Math.max(0, motion.frames - 1)));
			const rootX = motion.posedJoints?.[anchorFrame * 27 * 3] ?? 0;
			const rootZ = motion.posedJoints?.[anchorFrame * 27 * 3 + 2] ?? 0;
			const anchorX = Number.isFinite(motion.anchorX) ? motion.anchorX : 0;
			const anchorZ = Number.isFinite(motion.anchorZ) ? motion.anchorZ : 0;
			const dx = p[0] - rootX;
			const dz = p[2] - rootZ;
			return [
				anchorX + (dx * cos + dz * sin) * basis.scale,
				basis.baseY + p[1] * basis.scale,
				anchorZ + (-dx * sin + dz * cos) * basis.scale,
			];
		};
		return clipToWorld(pin.position);
	}

	/** Drop the pins, and say so. Called when a stroke or a drag commits — the
	 * two gestures are exclusive, and a silently discarded pin is worse than a
	 * refused one. */
	function clearLinePins({ toast = true } = {}) {
		if (!linePins.length) return;
		setLinePins([]);
		if (toast) {
			setToast(ko(
				"Pins cleared — one edit is one gesture, and this one is now the path",
				"찍은 순간을 지웠어요 — 한 번의 편집은 한 가지 방식이라, 지금은 궤적 편집이에요",
			));
		}
	}

	/** Has the user pulled anything yet? The Generate gate, and the reason the
	 * panel can say "pull first" instead of shipping a no-op edit. It is just
	 * the state's existence: pointerup installs a curve only when the pull
	 * actually moved something and clears it otherwise, so "there is a curve
	 * object" and "there is an edit" are the same fact. */
	const lineCurveDirty = !!lineEditPayload;
	/** Frames of the range whose joint has no image (behind the lens or out of
	 * frame). Those points cannot be grabbed and are dropped from the payload,
	 * so the count is worth showing rather than leaving as a mystery gap. */
	const lineCurveHidden = useMemo(
		() => (lineCurve ? lineCurve.original.reduce((count, point) => count + (isCurvePointOnScreen(point) ? 0 : 1), 0) : 0),
		[lineCurve],
	);
	/** How many points the box will actually receive — the curve is downsampled
	 * to MAX_LINE_POINTS, and seeing the number keeps "64" from being a
	 * surprise buried in the contract. */
	const lineCurvePointCount = useMemo(
		() => (lineCurve ? Math.min(MAX_LINE_POINTS, lineCurve.original.length - lineCurveHidden) : 0),
		[lineCurve, lineCurveHidden],
	);
	/** The frames the edit in hand actually covers. A DRAWN curve carries the
	 * window its stroke matched (which is also what goes on the wire); a dragged
	 * one has always covered the panel's range. Shown rather than left implicit
	 * because auto-ranging means the artist did not choose these numbers and
	 * deserves to see what the stroke was read as. endFrame is exclusive on the
	 * wire and inclusive to a human, hence the -1. */
	const lineEditFrom = lineCurve?.frameRange?.startFrame ?? lineEditRange?.startFrame ?? 0;
	const lineEditTo = (lineCurve?.frameRange?.endFrame ?? lineEditRange?.endFrame ?? 0) - 1;

	/** Change the influence radius. A live drag is re-derived from its snapshot
	 * rather than left showing the old falloff, which is what makes the slider
	 * legible: drag, then widen, and the same pull spreads under the finger. */
	function changeLineRadius(next) {
		const radius = Math.max(DRAG_RADIUS_MIN, Math.min(DRAG_RADIUS_MAX, Math.round(Number(next) || 0)));
		setLineRadius(radius);
		const drag = lineDragRef.current;
		if (!drag) return;
		// The drag carries its own radius so the window-level pointermove (which
		// closed over the value at grab time) keeps agreeing with what is drawn.
		drag.radius = radius;
		drag.live = dragCurve(drag.snapshot, drag.index, drag.du, drag.dv, radius);
	}

	/** Which camera actually draws the MAIN pane right now, and the exact
	 * rectangle it draws into.
	 *
	 * This mirrors DualRender's own branch order on purpose: the pane holds
	 * different cameras in different modes, and the letterboxed shot views draw
	 * into a fitAspect sub-rect rather than the whole pane. Measuring the curve
	 * against the pane instead of the IMAGE would shift every point by the
	 * width of the black bars. Plan and IK views return null — the plan camera
	 * is orthographic (no pinhole intrinsics to send) and IK mode is mutually
	 * exclusive with this one anyway. Rects are in CLIENT coordinates, which is
	 * what pointer events speak. */
	function lineEditPane() {
		const pane = mainPaneRef.current;
		if (!pane) return null;
		const box = pane.getBoundingClientRect();
		if (!(box.width >= 2 && box.height >= 2)) return null;
		const rect = { x: box.left, y: box.top, w: box.width, h: box.height };
		if (planIsMain || ikMode) return null;
		if (playMode || lookThroughShot) {
			const camera = shotCamRef.current;
			return camera ? { camera, rect: fitAspect(rect, shotOutput.aspect) } : null;
		}
		const camera = editorCamRef.current;
		return camera ? { camera, rect } : null;
	}

	/** Freeze the pane's camera into the C6 block. Returns null rather than
	 * throwing when the camera is not a settled perspective camera — a refusal
	 * here means "do not send", never "send something approximate". */
	function captureLineCamera(pane) {
		const camera = pane?.camera;
		if (!camera?.isPerspectiveCamera) return null;
		camera.updateMatrixWorld();
		const inverse = new THREE.Matrix4().copy(camera.matrixWorld).invert();
		try {
			return cameraToC6({
				fovDeg: camera.fov,
				aspect: camera.aspect,
				matrixWorldInverse: [...inverse.elements],
				width: pane.rect.w,
				height: pane.rect.h,
			});
		} catch (err) {
			// The only way here is a pane whose aspect disagrees with the
			// projection matrix, i.e. a frame drawn before DualRender settled.
			// Refusing is correct; the next paint or pointerup retries.
			console.warn("line edit: camera capture refused —", err.message);
			return null;
		}
	}

	/** Has the live view moved out from under a COMMITTED edit?
	 *
	 * The comparison is the same cameraDrifted the old watcher used; what changed
	 * is what a `true` MEANS. It is not "this edit is invalid" — the edit carries
	 * the lens it was authored through and goes on the wire with it, so it stays
	 * exactly as applicable as it was. It is "the painted line can no longer be
	 * drawn where it belongs", because reprojecting the edited uv through the new
	 * camera would need a depth that a 2D edit does not have.
	 *
	 * Called both from the 4 Hz watcher (which owns the panel's state) and
	 * synchronously at pointerdown (which cannot afford to be a quarter second
	 * behind) — one spelling, so the paint, the hint and the refusal can never
	 * disagree about which state the mode is in. */
	function lineCurveDrifted(pane, edit = lineCurve) {
		if (!edit) return false;
		const live = captureLineCamera(pane);
		// An unmeasurable pane is not a moved view — a frame drawn before
		// DualRender settled must not flicker the line out or refuse a press.
		if (!live) return lineDriftRef.current;
		return cameraDrifted(live, edit.camera);
	}

	/** The one sentence the drifted state says — in the panel, and in the toast
	 * that refuses a new gesture. ONE spelling, because a hint that disagreed
	 * with the refusal would read as two different problems. */
	function lineDriftHint() {
		return ko(
			"The view moved — the pending edit still applies; the dashed line is that same edit seen from here. Return toward the original view to grab it again, or Generate/undo from here.",
			"시점이 움직였어요 — 편집한 궤적은 그대로 적용되며, 점선은 같은 궤적을 지금 시점에서 본 모습입니다. 다시 잡으려면 원래 시점 쪽으로 돌아가고, 지금 이 상태에서 생성하거나 되돌려도 됩니다.",
		);
	}

	/** The drifted ghost, RE-ANCHORED: lift the committed edit into world space
	 * with the trail's own per-frame depth and see it through the LIVE lens, so
	 * the dashed line hugs the trajectory instead of floating wherever the old
	 * uv happen to land in the new view. Returns null when the trip cannot be
	 * made (no live lens yet, no motion, a pins-only edit with no curves) — the
	 * caller then paints the authored uv as before, which is at least honest
	 * about being stale. Runs per frame like the rest of the painter; it is the
	 * same few hundred pinhole projections projectLineCurve already pays. */
	function reprojectDriftedEdit(pane, edit) {
		const live = captureLineCamera(pane);
		const jointName = TRAIL_EFFECTOR_JOINTS[lineTrack];
		if (!live || !jointName || !motion) return null;
		const trail = jointTrailPoints(motion, jointName, { baseY: activeChar.y ?? 0, scale: activeChar.scale ?? 1 });
		if (!trail) return null;
		const original = reprojectCurveWorld(edit.original, trail, edit.camera, live);
		const edited = reprojectCurveWorld(edit.edited, trail, edit.camera, live);
		if (!original || !edited) return null;
		return { original, edited };
	}

	/** Project the joint's trail for the current track and range through the
	 * pane's LIVE camera. `{ camera, curve }`, or null when the view cannot
	 * supply a usable lens right now — a refusal means "no curve", never "a
	 * curve through some other camera".
	 *
	 * Deliberately the same sampler and the same arguments the old ghost line
	 * used (jointTrailPoints + TRAIL_EFFECTOR_JOINTS), so the curve the user
	 * grabs is the trajectory they were previously told to trace by hand.
	 *
	 * Cheap ON PURPOSE: while nothing has been pulled this runs once per
	 * animation frame, and that is exactly what lets the path FOLLOW the camera
	 * instead of fighting it. A few hundred pinhole projections is nothing
	 * beside the WebGL frame it is drawn over. */
	function projectLineCurve(pane, { camera: reuseCamera = null, frameRange = null } = {}) {
		if (!pane || !motion) return null;
		const range = frameRange ?? lineEditRange;
		if (!range) return null;
		const camera = reuseCamera ?? captureLineCamera(pane);
		const jointName = TRAIL_EFFECTOR_JOINTS[lineTrack];
		if (!camera || !jointName) return null;
		const trail = jointTrailPoints(motion, jointName, { baseY: activeChar.y ?? 0, scale: activeChar.scale ?? 1 });
		if (!trail) return null;
		const curve = projectTrailCurve({ trail, frameRange: range, camera });
		if (!curve || curve.length < MIN_LINE_POINTS) return null;
		return { camera, curve };
	}

	/** Repaint the whole overlay from scratch: the drawable frame, the joint's
	 * ORIGINAL trajectory as a faint reference once there is something to
	 * compare it against, the EDITED (or live) curve as the hero with its
	 * draggable markers, and — while a grab is live — the span the falloff is
	 * actually moving. Cheap enough to run per pointermove and stateless, so
	 * there is no partial-repaint bug class to have.
	 *
	 * This is also where the "follow the camera" half of the camera policy
	 * lives: with no edit in hand the curve is re-projected from the CURRENT
	 * lens every frame, so orbiting drags the path around with the render. The
	 * projection is cached in lineLiveRef for the hit test, which therefore
	 * never has to re-derive what was just drawn. */
	function paintLineOverlay() {
		const canvas = lineOverlayRef.current;
		const stage = stageRef.current;
		if (!canvas || !stage) return;
		const stageBox = stage.getBoundingClientRect();
		const dpr = Math.min(2, window.devicePixelRatio || 1);
		const width = Math.max(1, Math.round(stageBox.width));
		const height = Math.max(1, Math.round(stageBox.height));
		if (canvas.width !== Math.round(width * dpr) || canvas.height !== Math.round(height * dpr)) {
			canvas.width = Math.round(width * dpr);
			canvas.height = Math.round(height * dpr);
		}
		const ctx = canvas.getContext("2d");
		if (!ctx) return;
		ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
		ctx.clearRect(0, 0, width, height);
		const pane = lineEditPane();
		if (!pane) {
			lineLiveRef.current = null;
			return;
		}
		// Stage-relative, because the canvas is stretched over the stage while
		// the pane rect is measured in client coordinates.
		const ox = pane.rect.x - stageBox.left;
		const oy = pane.rect.y - stageBox.top;

		// The drawable frame: the letterboxed shot views draw into less than the
		// full pane, and a curve point outside this box is outside 0..1 and
		// cannot be sent. Saying so with a border beats clamping silently.
		ctx.save();
		ctx.setLineDash([6, 5]);
		ctx.strokeStyle = "rgba(255, 255, 255, .35)";
		ctx.lineWidth = 1;
		ctx.strokeRect(ox + .5, oy + .5, pane.rect.w - 1, pane.rect.h - 1);
		ctx.restore();

		// Which curve is on screen right now, in priority order: the one under
		// the finger, the committed edit, or a fresh projection through the live
		// camera. The live deformation has to win over the committed one because
		// a pointermove writes only lineDragRef — reading state here would
		// freeze the curve under the finger until pointerup.
		const drag = lineDragRef.current;
		const edit = drag ? { camera: drag.camera, original: drag.snapshot, edited: drag.live } : lineCurve;
		let original = null;
		let edited = null;
		// DETACHED. The committed edit was authored through its own lens; once the
		// live view has left that lens the same uv name different rays, so the
		// line is painted as a ghost — dashed, dim, no halo and no grab handles —
		// rather than drawn confidently in the wrong place or silently reprojected
		// (there is no depth to reproject it with). Nothing is discarded: the edit,
		// its preview and the Generate button all still run off the snapshot.
		// Computed HERE, per frame, rather than read off the 4 Hz watcher's state,
		// so the line detaches the instant the view moves instead of a quarter
		// second later. Never while a gesture is live — a drag paints its own
		// snapshot under the finger and mid-gesture drift is a different rule.
		let ghost = false;
		if (edit) {
			// An edit pins the curve to the lens it was authored through; the
			// cached live projection would disagree with it, so it is dropped
			// rather than left to go stale.
			lineLiveRef.current = null;
			original = edit.original;
			edited = edit.edited;
			ghost = !drag && lineCurveDrifted(pane, edit);
			// A drifted line is still WORLD-anchored through the trail's depth, so
			// draw it where the edit actually sits under the live lens rather than
			// at its stale authored uv. Falls back to the authored uv when the
			// re-anchoring cannot run (see reprojectDriftedEdit).
			if (ghost) {
				const anchored = reprojectDriftedEdit(pane, edit);
				if (anchored) ({ original, edited } = anchored);
			}
		} else {
			const live = projectLineCurve(pane);
			lineLiveRef.current = live;
			if (!live) { delete stage.dataset.lineDrift; return; }
			edited = live.curve;
		}
		// The CDP/e2e-visible handle for "the line is detached from this view".
		// On the stage rather than in React state because it has to be true on
		// the frame it becomes true, and this painter is the only thing that runs
		// on every frame.
		if (ghost) stage.dataset.lineDrift = "true";
		else delete stage.dataset.lineDrift;
		const pointPx = (point) => [ox + point.u * pane.rect.w, oy + point.v * pane.rect.h];
		/** Trace a frame-indexed curve, breaking the path at every null — a
		 * frame whose joint is behind the lens has no image, and joining across
		 * it would draw a straight line through the middle of the screen. */
		const traceCurve = (curve, from = 0, to = curve.length - 1) => {
			ctx.beginPath();
			let started = false;
			for (let index = Math.max(0, from); index <= Math.min(curve.length - 1, to); index += 1) {
				const point = curve[index];
				if (!point) { started = false; continue; }
				const [px, py] = pointPx(point);
				if (started) ctx.lineTo(px, py);
				else ctx.moveTo(px, py);
				started = true;
			}
			ctx.stroke();
		};

		ctx.save();
		ctx.lineJoin = "round";
		ctx.lineCap = "round";
		// Everything from here down to the pins is the CURVE, and the curve is the
		// one thing a moved view makes unplaceable, so the whole block fades
		// together. The pins below deliberately do not: they are world-space and
		// are re-projected through the live lens on every repaint.
		if (ghost) ctx.globalAlpha = .3;

		// (1) The ORIGINAL trajectory, faint, and ONLY while there is an edit to
		// compare it with. It used to be the instruction ("draw something like
		// this"); now it is a reference — how far the pull has taken the joint
		// from where the take put it. Unedited it would sit exactly under the
		// hero and just fatten the line.
		if (original) {
			ctx.setLineDash([7, 6]);
			ctx.strokeStyle = "rgba(0, 20, 40, .45)";
			ctx.lineWidth = 3;
			traceCurve(original);
			ctx.strokeStyle = "rgba(120, 205, 255, .5)";
			ctx.lineWidth = 1.5;
			traceCurve(original);
			ctx.setLineDash([]);
		}

		// (2) The curve in hand — the hero, and literally what gets sent. Two
		// passes: a dark halo so it reads on bright floors and skin tones alike,
		// then the glowing yellow the eye follows. GHOSTED the halo and the glow
		// both go: a detached line must not look like something you can grab, and
		// the dash says "this is where it was, not where it is".
		if (!ghost) {
			ctx.strokeStyle = "rgba(40, 24, 0, .8)";
			ctx.lineWidth = 9;
			traceCurve(edited);
			ctx.shadowColor = "rgba(255, 210, 61, .9)";
			ctx.shadowBlur = 10;
		} else {
			ctx.setLineDash([3, 7]);
		}
		ctx.strokeStyle = "#ffd23d";
		ctx.lineWidth = ghost ? 2 : 4.5;
		traceCurve(edited);
		ctx.shadowBlur = 0;
		ctx.setLineDash([]);

		// (4) The influenced span, while a grab is live: the stretch the falloff
		// is actually moving, drawn thicker and hotter. It is the only honest
		// picture of what the influence slider does, and it walks out with the
		// SAME dragWeight the deformation used rather than a redrawn guess.
		if (drag) {
			let from = drag.index;
			let to = drag.index;
			while (from > 0 && dragWeight(from - 1 - drag.index, drag.radius) > DRAG_WEIGHT_EPSILON) from -= 1;
			while (to < edited.length - 1 && dragWeight(to + 1 - drag.index, drag.radius) > DRAG_WEIGHT_EPSILON) to += 1;
			ctx.strokeStyle = "rgba(255, 245, 200, .95)";
			ctx.lineWidth = 6;
			traceCurve(edited, from, to);
		}

		// (3) The grab handles. Every 4th frame keeps a 200-frame range from
		// turning into a solid bead of dots while still leaving a target within
		// a couple of frames of wherever the pointer lands (the hit test
		// tolerates 14 px anyway, so the dots are an affordance, not the
		// geometry). Pinned ends and offscreen frames are deliberately NOT drawn
		// as handles: nearestCurvePoint refuses them, and a dot that cannot be
		// grabbed is worse than no dot. The hovered one swells, because the
		// scene's own cursor is already `grab` and a cursor alone cannot say
		// "this pointer would pick up the path rather than orbit the view".
		// GHOSTED THERE ARE NO HANDLES AT ALL. A dot is a promise that pressing it
		// picks the path up, and while the view has drifted that press is refused
		// — and would be aiming at a place the point is not, anyway.
		const hovered = ghost ? null : (drag ? drag.index : lineHoverRef.current);
		for (let index = 0; !ghost && index < edited.length; index += 1) {
			const point = edited[index];
			if (!isCurvePointOnScreen(point)) continue;
			if (isCurveEndPinned(index, edited.length)) continue;
			const active = hovered === index;
			if (!active && index % LINE_CURVE_MARKER_STRIDE !== 0) continue;
			const [px, py] = pointPx(point);
			const radius = active ? (drag ? 7 : 5.5) : 3.2;
			ctx.fillStyle = "rgba(40, 24, 0, .85)";
			ctx.beginPath();
			ctx.arc(px, py, radius + 1.6, 0, Math.PI * 2);
			ctx.fill();
			ctx.fillStyle = active ? "#fff6d0" : "#ffe27a";
			ctx.beginPath();
			ctx.arc(px, py, radius, 0, Math.PI * 2);
			ctx.fill();
		}

		// The pinned ends, drawn in the REFERENCE colour rather than the edit
		// colour, because that is exactly what they are: the frames at each edge
		// that stay on the original trajectory no matter how hard the middle is
		// pulled. Seeing them anchored is the whole explanation of why this edit
		// does not pop at the seams.
		for (const index of ghost ? [] : [0, edited.length - 1]) {
			const point = edited[index];
			if (!isCurvePointOnScreen(point)) continue;
			const [px, py] = pointPx(point);
			ctx.fillStyle = "rgba(0, 20, 40, .8)";
			ctx.beginPath();
			ctx.arc(px, py, 5.5, 0, Math.PI * 2);
			ctx.fill();
			ctx.fillStyle = "#78cdff";
			ctx.beginPath();
			ctx.arc(px, py, 3.2, 0, Math.PI * 2);
			ctx.fill();
		}
		// The curve's fade ends here; the pins below are world-space and paint at
		// full strength through the live lens whatever the curve's lens is doing.
		ctx.globalAlpha = 1;

		// (4b) THE PINS, and — in pin mode — the joint's own handle at the
		// playhead. Drawn in the pose-studio's effector green rather than the
		// path's yellow, because a pin is a different KIND of statement: the path
		// says "go this way", a pin says "be exactly here at this instant". Each
		// pin carries a leader line back to where the take put the joint at that
		// frame, which is the only honest picture of what was asked for; without
		// it a pin is just a dot floating in space.
		if (linePinMode || linePins.length) {
			const pinDrag = linePinDragRef.current;
			// ONE capture for the whole block: pins are world-space, so unlike the
			// curve they are re-projected through the LIVE lens on every repaint
			// and an orbit carries them along, at full strength. The curve above
			// can only ghost — that is the camera-policy difference between the two
			// gestures, and it is a difference in what can be DRAWN, not in what
			// survives: both edits outlive the move.
			const pinCam = pinDrag?.camera ?? captureLineCamera(pane);
			const marks = [];
			for (const pin of linePins) {
				const world = pinDrag && pinDrag.frame === pin.frame ? pinDrag.world : linePinWorld(pin);
				if (world) marks.push({ frame: pin.frame, world, placed: true });
			}
			if (pinDrag && !linePins.some((pin) => pin.frame === pinDrag.frame)) {
				marks.push({ frame: pinDrag.frame, world: pinDrag.world, placed: false });
			}
			// The grabbable handle: the joint where the take currently puts it at
			// the playhead. Only in pin mode, and only when that frame is not
			// already pinned — otherwise the pin IS the handle.
			const playhead = Math.max(0, Math.min(Math.trunc(tlFrame) || 0, Math.max(0, lineClipFrames - 1)));
			if (linePinMode && !pinDrag && !linePins.some((pin) => pin.frame === playhead)) {
				const here = lineJointWorldAt(playhead);
				if (here) marks.push({ frame: playhead, world: here, placed: false, handle: true });
			}
			for (const mark of pinCam ? marks : []) {
				const uv = projectPointC6(pinCam, mark.world[0], mark.world[1], mark.world[2]);
				if (!uv) continue;
				const px = ox + uv[0] * pane.rect.w;
				const py = oy + uv[1] * pane.rect.h;
				if (mark.placed) {
					const origin = lineJointWorldAt(mark.frame);
					const originUv = origin ? projectPointC6(pinCam, origin[0], origin[1], origin[2]) : null;
					if (originUv) {
						ctx.save();
						ctx.setLineDash([4, 4]);
						ctx.strokeStyle = "rgba(120, 255, 190, .55)";
						ctx.lineWidth = 1.5;
						ctx.beginPath();
						ctx.moveTo(ox + originUv[0] * pane.rect.w, oy + originUv[1] * pane.rect.h);
						ctx.lineTo(px, py);
						ctx.stroke();
						ctx.restore();
					}
				}
				const radius = mark.handle ? 6 : 7;
				ctx.fillStyle = "rgba(0, 30, 20, .85)";
				ctx.beginPath();
				ctx.arc(px, py, radius + 2, 0, Math.PI * 2);
				ctx.fill();
				ctx.fillStyle = mark.placed ? "#5cffb0" : "rgba(92, 255, 176, .5)";
				ctx.beginPath();
				ctx.arc(px, py, radius, 0, Math.PI * 2);
				ctx.fill();
				if (mark.placed) {
					ctx.fillStyle = "rgba(0, 30, 20, .9)";
					ctx.font = "600 10px system-ui, sans-serif";
					ctx.textAlign = "center";
					ctx.textBaseline = "middle";
					ctx.fillText(String(mark.frame), px, py);
				}
			}
		}

		// (5) The stroke under the finger, while one is being drawn. Same family
		// as the hero curve — dark halo, warm core — but PALE and dashed rather
		// than the solid yellow, because it is not the curve yet: it is a shape
		// that becomes the curve's interior on release, and the two ends it will
		// be pinned to are the blue dots already drawn above. Painted last so it
		// sits over everything, with a dot at the head so a stroke that is only
		// beginning is still visible.
		const draw = lineDrawRef.current;
		if (draw && draw.points.length) {
			ctx.save();
			ctx.lineJoin = "round";
			ctx.lineCap = "round";
			ctx.beginPath();
			draw.points.forEach(([su, sv], index) => {
				const px = ox + su * pane.rect.w;
				const py = oy + sv * pane.rect.h;
				if (index === 0) ctx.moveTo(px, py);
				else ctx.lineTo(px, py);
			});
			ctx.strokeStyle = "rgba(40, 24, 0, .75)";
			ctx.lineWidth = 8;
			ctx.stroke();
			ctx.setLineDash([9, 6]);
			ctx.shadowColor = "rgba(255, 246, 208, .9)";
			ctx.shadowBlur = 10;
			ctx.strokeStyle = "#fff6d0";
			ctx.lineWidth = 3.5;
			ctx.stroke();
			ctx.shadowBlur = 0;
			ctx.setLineDash([]);
			const head = draw.points[draw.points.length - 1];
			const hx = ox + head[0] * pane.rect.w;
			const hy = oy + head[1] * pane.rect.h;
			ctx.fillStyle = "rgba(40, 24, 0, .85)";
			ctx.beginPath();
			ctx.arc(hx, hy, 6, 0, Math.PI * 2);
			ctx.fill();
			ctx.fillStyle = "#fff6d0";
			ctx.beginPath();
			ctx.arc(hx, hy, 4, 0, Math.PI * 2);
			ctx.fill();
			ctx.restore();
		}
		ctx.restore();
	}

	/** Client pointer -> viewport-normalized uv. Unlike the old freehand path
	 * this does NOT reject coordinates outside the image: a pull that leaves the
	 * frame is a real gesture and the deformation it implies is real too. It is
	 * refused later, at curveToPoints2d, with a message that says which problem
	 * it is — the bridge rejects points2d outside 0..1. */
	function lineUvFromPointer(pane, event) {
		return [
			(event.clientX - pane.rect.x) / pane.rect.w,
			(event.clientY - pane.rect.y) / pane.rect.h,
		];
	}

	/** The curve a pointer could grab this instant, WITHOUT side effects — the
	 * committed edit if there is one, otherwise whatever the last repaint
	 * projected. Used by the hover cursor, which must never change state. */
	function lineHoverCurve() {
		// A drifted curve is painted detached and has no handles, so it has no
		// hover targets either — swelling a marker the press would refuse is the
		// cursor telling a lie. The ref (rather than a fresh capture) because
		// hover fires on every pointermove and 250 ms of staleness on a cursor
		// shape is not worth a matrix inversion per move.
		if (lineCurve) return lineDriftRef.current ? null : lineCurve.edited;
		return lineLiveRef.current?.curve ?? null;
	}

	/** Side-effect-free "does this press belong to line editing?" — handed to
	 * ObjectGizmo as `claimPointer` so its WINDOW-capture selection handler
	 * yields the press. Without the yield the gizmo's stopPropagation kills the
	 * event above the stage and the gesture never reaches the stage listener at
	 * all; that swallowing is the entire reason claimPointer exists.
	 *
	 * IT CLAIMS EVERY PLAIN-LEFT PRESS ON THE IMAGE, not only the ones that hit
	 * the curve. It has to: a press on EMPTY space is now a freehand stroke, so
	 * "missed the curve" is no longer "not ours" — it is the other half of the
	 * mode, and a probe that answered false there would let the gizmo eat exactly
	 * the presses drawing depends on. The cost is explicit and deliberate: while
	 * the mode is ON, plain-left no longer picks a cast member on the deck. What
	 * is NOT claimed is anything the camera owns — alt+left orbits, middle pans,
	 * right flies (see controls.jsx), so navigation is untouched — nor a press
	 * outside the drawn image, nor a press on the HUD chrome stacked over the
	 * stage, nor anything at all outside line-edit mode: App only passes this
	 * probe to the gizmos while lineEditMode is true.
	 *
	 * Must never mutate state, and must agree exactly with what
	 * onLineStagePointerDown will do with the same event — the two conditions
	 * below are the same ones that handler opens with. */
	function lineGrabProbe(event) {
		if (event.button !== 0 || event.altKey) return false;
		if (!(event.target instanceof HTMLCanvasElement)) return false;
		const pane = lineEditPane();
		if (!pane) return false;
		// No curve to grab AND nothing to draw onto: without a projected
		// trajectory there is no base curve for a stroke to replace the interior
		// of, so the press is not ours and the gizmo keeps it.
		//
		// A COMMITTED EDIT CLAIMS THE PRESS EVEN WHILE THE VIEW HAS DRIFTED, which
		// is why the test is on lineCurve rather than on lineHoverCurve alone
		// (that one goes null under drift, deliberately — no handles to hover).
		// The stage handler refuses that press with the drift hint; yielding it
		// instead would hand it to the gizmo, which would quietly select a cast
		// member and never say why the gesture did nothing.
		if (!lineCurve && !lineHoverCurve()) return false;
		const [u, v] = lineUvFromPointer(pane, event);
		// Outside the drawable image (the letterbox bars of a shot view) a stroke
		// could only author points the bridge refuses, so it is not a stroke.
		return u >= 0 && u <= 1 && v >= 0 && v <= 1;
	}

	/** What a grab picks up, `{ camera, curve }`, and the ONE place the camera
	 * is snapshotted: the pair returned here is what the drag deforms and what
	 * the eventual C6 request is built against, so the uv and the lens can never
	 * come from different moments.
	 *
	 * A committed edit is handed back with ITS OWN lens, and a drifted one is
	 * never reached at all — onLineStagePointerDown refuses the press above,
	 * synchronously, before this function is called. That refusal (rather than
	 * the old discard) is the whole policy change: a second gesture through a
	 * different lens would mix two cameras into one curve, which is a real
	 * problem; the edit already in hand is not. */
	function lineGrabSource(pane) {
		if (lineCurve) return { camera: lineCurve.camera, curve: lineCurve.edited };
		const cached = lineLiveRef.current;
		if (cached) return cached;
		const fresh = projectLineCurve(pane);
		lineLiveRef.current = fresh;
		return fresh;
	}

	/** The stage's CAPTURE-phase pointerdown: which of the two gestures this is.
	 *
	 * The overlay canvas is `pointer-events: none` and only paints; this listener
	 * sits on the stage container instead, ahead of r3f and the fly controls, and
	 * asks one question: did the pointer land within CURVE_GRAB_RADIUS_PX of a
	 * draggable point?
	 *
	 *   YES -> a PULL. The curve is snapshotted and deformed under the finger.
	 *   NO  -> a DRAW. The press starts a freehand stroke on empty space, which
	 *          on release picks its own frame window and becomes the same kind of
	 *          curve (drawStrokeEdit), committed through the identical pipeline.
	 *          This used to be the
	 *          do-nothing path, and on a take whose trail projects into a few
	 *          pixels that made the mode feel broken: nothing to grab, nothing
	 *          happens, no way in.
	 *
	 * Either way the event is consumed exclusively (preventDefault +
	 * stopPropagation) so one gesture cannot also select or orbit. The presses
	 * this handler deliberately never takes are the camera's — alt+left orbits,
	 * middle pans, right flies — so judging a correction from another angle
	 * still works and the mode never takes the viewport hostage. Plain-left
	 * click-to-select IS given up for as long as the mode is on; that is the
	 * price of an empty-space gesture, and the mode is modal and escapable.
	 *
	 * Capture phase rather than bubble because the decision has to be made before
	 * the controls start an orbit; a bubble listener would arrive after they had
	 * already latched on (FlyControls binds pointerdown on gl.domElement, which
	 * is a descendant of the stage, so stopping here is enough — nothing binds
	 * this gesture at the window). Nothing is re-dispatched. */
	function onLineStagePointerDown(event) {
		// Alt+left is the orbit gesture and belongs to the camera, never to a
		// stroke — the one plain-left press this mode must still let through.
		if (event.button !== 0 || event.altKey) return;
		// Only the render surface itself. The stage also carries HUD chrome — the
		// inset's drag chip, the plan pane, overlay buttons — and a control that
		// happens to sit within 14 px of the curve must keep its own click. The
		// overlay canvas cannot be the target (pointer-events: none), so a canvas
		// target is always the WebGL one.
		if (!(event.target instanceof HTMLCanvasElement)) return;
		const pane = lineEditPane();
		if (!pane) return;
		// THE VIEW HAS DRIFTED AWAY FROM THE EDIT IN HAND — refuse the gesture,
		// keep the edit. A pull, a stroke or a pin started now would be authored
		// through THIS lens and committed onto a curve authored through another
		// one, and there is no honest way to merge two cameras into a single set
		// of uv. So the press is consumed (so it cannot orbit or select behind the
		// refusal) and answered with the same sentence the panel is showing. Undo,
		// reset, Generate and Esc all still work — none of them authors anything.
		//
		// Checked synchronously rather than off the 4 Hz watcher's state: the
		// window between polls is exactly where a fly-then-press lands.
		if (lineCurve && lineCurveDrifted(pane)) {
			event.preventDefault();
			event.stopPropagation();
			setToast(lineDriftHint());
			return;
		}
		// PIN MODE takes the press before the curve does: in this mode the marker
		// under the pointer is the joint AT THE PLAYHEAD, not a point of a path,
		// and the two gestures start on the same pixels.
		if (linePinMode) {
			if (beginLinePinDrag(event, pane)) return;
			// A press that missed the handle in pin mode does nothing rather than
			// falling through to a stroke: the artist asked for pins, and a
			// surprise reroute is exactly the "I did not mean that" the redesign
			// is about.
			return;
		}
		const source = lineGrabSource(pane);
		if (!source) return;
		const [u, v] = lineUvFromPointer(pane, event);
		const hit = nearestCurvePoint(source.curve, u, v, CURVE_GRAB_RADIUS_PX, pane.rect.w, pane.rect.h);
		// MISSED THE CURVE — draw a new path instead of doing nothing.
		if (!hit) {
			if (!(u >= 0 && u <= 1 && v >= 0 && v <= 1)) return;
			beginLineDraw(event, pane, source, u, v);
			return;
		}
		event.preventDefault();
		event.stopPropagation();
		const stage = stageRef.current;
		if (stage) stage.dataset.lineGrab = "drag";
		lineHoverRef.current = null;
		// SNAPSHOT. Every pointermove re-derives the deformation from this exact
		// curve, so one drag is idempotent (return the pointer to the grab point
		// and the curve is restored) and changing the radius mid-drag re-deforms
		// rather than compounding. Successive drags stack because each new grab
		// snapshots what the previous one committed.
		lineDragRef.current = {
			index: hit.index,
			prev: lineCurve,
			u0: u,
			v0: v,
			du: 0,
			dv: 0,
			radius: lineRadius,
			camera: source.camera,
			snapshot: source.curve,
			live: source.curve,
		};
		// Window-level move/up, the same idiom beginInsetDrag uses above: a pull
		// that leaves the stage still tracks, and a pointerup anywhere ends it.
		const onMove = (moveEvent) => {
			const drag = lineDragRef.current;
			const livePane = lineEditPane();
			if (!drag || !livePane) return;
			const [mu, mv] = lineUvFromPointer(livePane, moveEvent);
			if (!Number.isFinite(mu) || !Number.isFinite(mv)) return;
			drag.du = mu - drag.u0;
			drag.dv = mv - drag.v0;
			drag.live = dragCurve(drag.snapshot, drag.index, drag.du, drag.dv, drag.radius);
			paintLineOverlay();
		};
		const onUp = () => {
			window.removeEventListener("pointermove", onMove);
			window.removeEventListener("pointerup", onUp);
			window.removeEventListener("pointercancel", onUp);
			const drag = lineDragRef.current;
			lineDragRef.current = null;
			const endStage = stageRef.current;
			if (endStage) delete endStage.dataset.lineGrab;
			if (!drag) return;
			// A pull that went nowhere changes NOTHING — including an edit that
			// was already there (wiping it on a stray click was a bug). A real
			// pull commits with the lens it was authored through and records
			// what it replaced, which is what Ctrl/Cmd+Z restores.
			const changed = !curvesEqual(drag.live, drag.snapshot);
			// ONE EDIT IS ONE GESTURE: a real pull makes this a path edit, so any
			// pins in hand are dropped (with a toast, never silently).
			if (changed) { clearLinePins(); lineUndoRef.current.push(drag.prev ?? null); }
			// A FRESH PULL EDITS ONLY THE FRAMES THE FALLOFF TOUCHED. Inheriting
			// the panel's whole-clip default meant zero preserve rows on the box,
			// and the sampler re-rolled the entire body of the entire clip — a
			// 25 px nudge measured 4.6 m of drift eight seconds away. A pull that
			// refines an existing edit keeps that edit's window instead: shrinking
			// it would drop the drawn reroute outside the newly touched frames.
			const inherited = drag.prev?.frameRange ?? null;
			const pulledRange = changed && !inherited
				? changedFrameRange(drag.snapshot, drag.live, { clipFrames: lineClipFrames })
				: null;
			const committed = changed
				? {
					camera: drag.camera,
					original: drag.snapshot,
					edited: drag.live,
					frameRange: inherited ?? pulledRange ?? lineEditRange,
				}
				: (drag.prev ?? null);
			// Same panel feedback as a drawn stroke: the numbers the artist never
			// typed show up filled in.
			if (changed && pulledRange && (
				pulledRange.startFrame !== lineEditRange?.startFrame || pulledRange.endFrame !== lineEditRange?.endFrame
			)) {
				lineAutoRangeRef.current = pulledRange;
				setLineRange(pulledRange);
			}
			setLineCurve(committed);
			// RELEASE FIRES A DRAFT. A pull that changed nothing asks for nothing:
			// the viewport already shows what it would show.
			if (changed) scheduleLinePreview(committed);
			paintLineOverlay();
		};
		window.addEventListener("pointermove", onMove);
		window.addEventListener("pointerup", onUp);
		window.addEventListener("pointercancel", onUp);
		paintLineOverlay();
	}

	/** The DRAW half: a press on empty space collects a freehand stroke and, on
	 * release, hands it to drawStrokeEdit, which decides WHICH FRAMES the stroke
	 * was drawn over, replays it with those frames' own timing, and eases it into
	 * the original trajectory at both ends.
	 *
	 * The commit below therefore does one thing the drag's does not: it writes
	 * the matched window back into the panel's range inputs, so "frames 30-66"
	 * appears filled in without anyone having typed a number. That is the entire
	 * fix for the complaint that a short hook became an eight-second crawl — the
	 * range used to default to the whole clip and nobody ever narrowed it.
	 *
	 * Why drawing exists beside dragging at all: the grab is a hit test against
	 * the joint's PROJECTED trail, and on a take where the joint barely moves
	 * across the image — the person who backs up and falls, whose hand travels a
	 * few screen pixels over 192 frames — that trail is a dot. There is nothing
	 * to grab, so the mode did nothing, so the mode was broken. Drawing needs no
	 * target.
	 *
	 * The commit below is deliberately the SAME six lines the drag's pointerup
	 * runs: compare against the snapshot, push the replaced curve on the undo
	 * stack, install `{ camera, original, edited }`, schedule a preview. Every
	 * downstream behaviour — Ctrl/Cmd+Z, the reset button, the detached paint a
	 * moved view puts it in, the wire payload — therefore treats a drawn curve as
	 * an ordinary one, because it IS one. */
	function beginLineDraw(event, pane, source, u, v) {
		event.preventDefault();
		event.stopPropagation();
		const stage = stageRef.current;
		if (stage) stage.dataset.lineGrab = "draw";
		lineHoverRef.current = null;
		lineDrawRef.current = {
			prev: lineCurve,
			camera: source.camera,
			snapshot: source.curve,
			// THE WHOLE CLIP'S trail, through the SAME lens the stroke is being
			// drawn with, captured once at press. This is what the stroke's
			// endpoints are matched against on release (redesign A), and it has to
			// be the ORIGINAL trail rather than whatever is currently edited so
			// that redrawing re-matches against a fixed reference instead of
			// walking away from it one stroke at a time. Capturing at press rather
			// than at release means a camera that drifts mid-stroke cannot leave
			// the match and the stroke measured through different lenses.
			fullCurve: lineClipFrames > 1
				? projectLineCurve(pane, { camera: source.camera, frameRange: { startFrame: 0, endFrame: lineClipFrames } })?.curve ?? null
				: null,
			// Pixel size of the pane the stroke is being drawn on, captured once:
			// the "is this a stroke or a click?" threshold is in CSS pixels, where
			// the hand drew it, and uv distance is anisotropic so it cannot be
			// judged in uv without this pair.
			paneW: pane.rect.w,
			paneH: pane.rect.h,
			points: [[u, v]],
			// Running length in PIXELS, accumulated as the stroke is drawn rather
			// than re-measured at release.
			lengthPx: 0,
		};
		const onMove = (moveEvent) => {
			const draw = lineDrawRef.current;
			const livePane = lineEditPane();
			if (!draw || !livePane) return;
			const [mu, mv] = lineUvFromPointer(livePane, moveEvent);
			if (!Number.isFinite(mu) || !Number.isFinite(mv)) return;
			const last = draw.points[draw.points.length - 1];
			const stepPx = Math.hypot((mu - last[0]) * draw.paneW, (mv - last[1]) * draw.paneH);
			// Sub-pixel jitter carries no shape and only costs arc-length samples.
			if (!(stepPx > 0.5)) return;
			draw.points.push([mu, mv]);
			draw.lengthPx += stepPx;
			paintLineOverlay();
		};
		const onUp = () => {
			window.removeEventListener("pointermove", onMove);
			window.removeEventListener("pointerup", onUp);
			window.removeEventListener("pointercancel", onUp);
			const draw = lineDrawRef.current;
			lineDrawRef.current = null;
			const endStage = stageRef.current;
			if (endStage) delete endStage.dataset.lineGrab;
			if (!draw) return;
			// A CLICK IS NOT A STROKE, and a click must change nothing — including
			// an edit that is already there. Same rule the drag's commit enforces
			// with curvesEqual; here the test is the length of what was drawn.
			const edit = draw.points.length >= DRAW_MIN_STROKE_POINTS && draw.lengthPx >= DRAW_MIN_STROKE_PX
				? drawStrokeEdit(draw.points, {
					fullCurve: draw.fullCurve,
					fallbackCurve: draw.snapshot,
					fallbackRange: lineEditRange,
					paneW: draw.paneW,
					paneH: draw.paneH,
					clipFrames: lineClipFrames,
				})
				: null;
			if (!edit) {
				paintLineOverlay();
				return;
			}
			const drawn = edit.curve;
			const changed = !curvesEqual(drawn, edit.base);
			if (changed) { clearLinePins(); lineUndoRef.current.push(draw.prev ?? null); }
			// The matched window rides ON the committed curve, not only in
			// `lineRange` state. setLineRange is asynchronous and the preview below
			// fires from a timeout that closed over THIS render's lineEditRange, so
			// a request built from state alone would ship the old range with the
			// new curve — the exact mismatch that would splice a re-routed stretch
			// into the wrong frames. buildLineEditRequest reads curve.frameRange.
			const committed = changed
				? { camera: draw.camera, original: edit.base, edited: drawn, frameRange: edit.frameRange ?? lineEditRange }
				: (draw.prev ?? null);
			// PANEL FEEDBACK (redesign D): the numbers the artist never typed show
			// up filled in, so "frames 30-66" is visible confirmation of what the
			// stroke was read as. Only on a real match — a fallback draw is still
			// in whatever range the panel already showed.
			if (changed && edit.matched && edit.frameRange && (
				edit.frameRange.startFrame !== lineEditRange?.startFrame || edit.frameRange.endFrame !== lineEditRange?.endFrame
			)) {
				lineAutoRangeRef.current = edit.frameRange;
				setLineRange(edit.frameRange);
			}
			setLineCurve(committed);
			if (changed) scheduleLinePreview(committed);
			paintLineOverlay();
		};
		window.addEventListener("pointermove", onMove);
		window.addEventListener("pointerup", onUp);
		window.addEventListener("pointercancel", onUp);
		paintLineOverlay();
	}

	/** THE PIN GESTURE (순간 찍기): grab the joint at the playhead and put it
	 * where it should be.
	 *
	 * Returns true when the press was taken. The handle is the joint's own
	 * position at the CURRENT FRAME — the artist scrubbed there, so that is the
	 * moment they are talking about — plus any pin already placed, which can be
	 * re-grabbed to adjust it (grabbing one moves the playhead to its frame, so
	 * the viewport shows the pose being pinned).
	 *
	 * The 2D-to-3D step is unprojectDeltaC6: the joint slides in the image plane
	 * at its own depth, which is the effector-drag mechanic the pose studio's
	 * gizmo uses and the only reading of a screen drag that does not invent a
	 * depth the artist could not see. THE DEVIATION IS DELIBERATE and worth
	 * naming: this is not posestudio's TransformControls gizmo, because that one
	 * requires ikMode, which is mutually exclusive with this mode. What is
	 * reused is the MECHANIC, not the widget.
	 *
	 * On release the world point is converted to the take's own clip space
	 * (worldPointToClip) and stored — pins go on the wire in the space the npz
	 * is written in, which is the only space a "within 2 cm of the target" claim
	 * can be checked in. */
	function beginLinePinDrag(event, pane) {
		const camera = captureLineCamera(pane);
		if (!camera) return false;
		const frame = Math.max(0, Math.min(Math.trunc(tlFrame) || 0, Math.max(0, lineClipFrames - 1)));
		const [u, v] = lineUvFromPointer(pane, event);
		const reach = (candidate) => {
			const uv = projectPointC6(camera, candidate.world[0], candidate.world[1], candidate.world[2]);
			if (!uv) return null;
			const dist = Math.hypot((uv[0] - u) * pane.rect.w, (uv[1] - v) * pane.rect.h);
			return dist > CURVE_GRAB_RADIUS_PX * 2 ? null : { ...candidate, dist };
		};
		// THE PLAYHEAD WINS TIES, and not by accident. The obvious rule — nearest
		// candidate in pixels — was measured wrong on the take this mode exists
		// for: the head's whole trail is ~100 px, so a pin already placed at frame
		// 90 sits within the grab radius of the joint at frame 112, and scrubbing
		// forward to add a second pin instead re-grabbed the first one and dragged
		// the playhead back to it. The artist scrubbed somewhere on purpose; that
		// moment is what the press means. Existing pins are only considered when
		// the playhead's own handle is out of reach.
		const here = lineJointWorldAt(frame);
		let best = here && !linePins.some((pin) => pin.frame === frame)
			? reach({ frame, world: here })
			: null;
		if (!best) {
			for (const pin of linePins) {
				const world = linePinWorld(pin);
				if (!world) continue;
				const hit = reach({ frame: pin.frame, world });
				if (hit && (!best || hit.dist < best.dist)) best = hit;
			}
		}
		// A press on the joint at a frame that is ALREADY pinned re-places that
		// pin, which is the same "the second gesture wins" rule upsertPin applies.
		if (!best && here) best = reach({ frame, world: here });
		if (!best) return false;
		event.preventDefault();
		event.stopPropagation();
		const stage = stageRef.current;
		if (stage) stage.dataset.lineGrab = "pin";
		// Re-grabbing an existing pin moves the playhead to it, so the body on
		// screen is the pose the pin belongs to rather than whatever frame the
		// timeline happened to be parked on.
		if (best.frame !== frame) setTlFrame(best.frame);
		linePinDragRef.current = {
			frame: best.frame,
			camera,
			origin: best.world,
			world: best.world,
			u0: u,
			v0: v,
			moved: false,
		};
		const onMove = (moveEvent) => {
			const drag = linePinDragRef.current;
			const livePane = lineEditPane();
			if (!drag || !livePane) return;
			const [mu, mv] = lineUvFromPointer(livePane, moveEvent);
			if (!Number.isFinite(mu) || !Number.isFinite(mv)) return;
			const delta = unprojectDeltaC6(drag.camera, drag.origin, mu - drag.u0, mv - drag.v0);
			if (!delta) return;
			drag.world = [drag.origin[0] + delta[0], drag.origin[1] + delta[1], drag.origin[2] + delta[2]];
			// Sub-pixel tremor is not a placement, exactly as a few pixels of
			// wobble is not a stroke (DRAW_MIN_STROKE_PX).
			drag.moved = Math.hypot((mu - drag.u0) * livePane.rect.w, (mv - drag.v0) * livePane.rect.h) >= DRAW_MIN_STROKE_PX;
			paintLineOverlay();
		};
		const onUp = () => {
			window.removeEventListener("pointermove", onMove);
			window.removeEventListener("pointerup", onUp);
			window.removeEventListener("pointercancel", onUp);
			const drag = linePinDragRef.current;
			linePinDragRef.current = null;
			const endStage = stageRef.current;
			if (endStage) delete endStage.dataset.lineGrab;
			if (!drag || !drag.moved) { paintLineOverlay(); return; }
			const clip = worldPointToClip(motion, { x: drag.world[0], y: drag.world[1], z: drag.world[2] }, {
				baseY: activeChar.y ?? 0,
				scale: activeChar.scale ?? 1,
			});
			const next = upsertPin(linePins, { frame: drag.frame, position: [clip.x, clip.y, clip.z] });
			if (next === linePins) { paintLineOverlay(); return; }
			// A pin and a curve cannot coexist (see the linePins comment). The
			// curve goes on the undo stack first, so Ctrl/Cmd+Z brings it back.
			if (lineCurve) {
				lineUndoRef.current.push(lineCurve);
				setLineCurve(null);
			}
			const range = pinsFrameRange(next, lineClipFrames);
			if (range) {
				lineAutoRangeRef.current = range;
				setLineRange(range);
			}
			setLinePins(next);
			// Same debounce, same session seed, same supersede rule as a stroke:
			// the preview loop does not care which gesture asked for it.
			if (range) scheduleLinePreview({ pins: next, frameRange: range });
			paintLineOverlay();
		};
		window.addEventListener("pointermove", onMove);
		window.addEventListener("pointerup", onUp);
		window.addEventListener("pointercancel", onUp);
		paintLineOverlay();
		return true;
	}

	/** Bubble-phase hover: the cursor and the swollen marker, nothing else. It
	 * never stops the event and never writes state, so it cannot interfere with
	 * the orbit the same pointermove is probably driving. */
	function onLineStageHover(event) {
		const stage = stageRef.current;
		if (!stage || lineDragRef.current || lineDrawRef.current || linePinDragRef.current) return;
		const pane = event.target instanceof HTMLCanvasElement ? lineEditPane() : null;
		const curve = pane ? lineHoverCurve() : null;
		let hit = null;
		if (curve) {
			const [u, v] = lineUvFromPointer(pane, event);
			hit = nearestCurvePoint(curve, u, v, CURVE_GRAB_RADIUS_PX, pane.rect.w, pane.rect.h);
		}
		lineHoverRef.current = hit ? hit.index : null;
		if (hit) stage.dataset.lineGrab = "hover";
		else delete stage.dataset.lineGrab;
	}

	function onLineStageHoverEnd() {
		const stage = stageRef.current;
		if (lineDragRef.current || lineDrawRef.current || linePinDragRef.current) return;
		lineHoverRef.current = null;
		if (stage) delete stage.dataset.lineGrab;
	}

	/** Back to the take's own trajectory — and, because an unedited curve
	 * follows the live camera, back to a path that tracks the view. */
	function resetLineCurve() {
		lineDragRef.current = null;
		lineDrawRef.current = null;
		linePinDragRef.current = null;
		setLinePins([]);
		// The button is itself undoable: resetting a curve you spent five pulls
		// on should not be a cliff.
		if (lineCurve) lineUndoRef.current.push(lineCurve);
		// The draft on screen was a picture of the pull that is being thrown
		// away, so it goes with it — but the SESSION does not end, and the seed
		// survives, because the artist is still editing the same take.
		cancelLinePreview();
		setLineCurve(null);
	}

	/** Internal clear — mode entry/exit and enqueue. (A camera move used to come
	 * through here too; it no longer clears anything.) Unlike the
	 * reset BUTTON this also empties the undo stack: those transitions change
	 * what the stack's entries were authored against. It is also where a
	 * preview SESSION ends, which is what re-rolls the seed: every one of these
	 * transitions means the next pull is a different piece of work. */
	function clearLineEdit() {
		lineDragRef.current = null;
		lineDrawRef.current = null;
		linePinDragRef.current = null;
		setLinePins([]);
		setLinePinMode(false);
		lineUndoRef.current = [];
		cancelLinePreview();
		linePreviewSeedRef.current = null;
		setLineCurve(null);
	}

	function undoLineCurve() {
		const previous = lineUndoRef.current.pop();
		if (previous === undefined) return false;
		lineDragRef.current = null;
		lineDrawRef.current = null;
		linePinDragRef.current = null;
		// Undo restores a CURVE, so it also un-does whatever pins replaced it —
		// the two are exclusive and the stack only ever stores curves.
		setLinePins([]);
		cancelLinePreview();
		setLineCurve(previous);
		return true;
	}

	/* --------------------- the live preview loop (C10/C11) --------------------
	 * Everything below is the machinery behind "release the drag, watch it move".
	 * It is deliberately kept apart from enqueueMotionJob: that queue exists to
	 * produce TAKES — it delivers to a character layer, commits a recipe and
	 * pushes a version — and a preview must do none of those things. So a
	 * preview is its own bare request, its own AbortController, and one
	 * viewport swap that anything can undo. */

	/** Pin (or release) the take a preview is drafted from. Mirrored into a ref
	 * because the async completion below reads it after several awaits, where a
	 * render-time closure would be pointing at the previous take. */
	function setPreviewSource(next) {
		linePreviewSourceRef.current = next;
		setLinePreviewSource(next);
	}

	/** THE SESSION SEED (rule 2 above). Rolled at most once per editing session
	 * and handed to every preview AND to the confirming full-quality run, so the
	 * draft the artist accepted is the draft they get. Returns null when the
	 * typed seed is invalid — takeSeed has already said so. */
	function lineSessionSeed() {
		if (Number.isInteger(linePreviewSeedRef.current)) return linePreviewSeedRef.current;
		const seed = takeSeed();
		if (seed === null) return null;
		linePreviewSeedRef.current = seed;
		return seed;
	}

	/** The C6 body for a curve — ONE builder for the preview and the confirm, so
	 * the only difference between what the artist watched and what they get is
	 * the step count. Returns `{ ok: false, message }` with copy already
	 * localized, or `{ ok: true, body, lineEdit, seed }`. */
	function buildLineEditRequest(curve, { preview = false } = {}) {
		const refuse = (copy) => ({ ok: false, message: ko(copy[0], copy[1]) });
		const sourceUrl = takeSourceUrl;
		if (!sourceUrl) return refuse(LINE_EDIT_REFUSALS.sourceMotion);
		if (!curve) {
			return refuse(["Pull the path first — grab a dot on it and drag", "커브를 먼저 잡아당겨 주세요"]);
		}
		// PINS take the other branch of C6 entirely: no points2d, no camera. The
		// prompt and the seed rule below are shared, because those belong to the
		// RUN, not to the gesture.
		if (curve.pins) {
			const prompt = ((linePreviewSource?.prompt ?? motion?.prompt) || "").trim() || "A person continues the motion naturally.";
			const lineEdit = {
				sourceMotion: sourceUrl,
				track: lineTrack,
				frameRange: curve.frameRange,
				pins3d: curve.pins.map((pin) => ({ frame: pin.frame, position: [...pin.position] })),
				prompt,
			};
			const refusal = validateLineEdit(lineEdit, { clipFrames: lineClipFrames });
			if (refusal) return refuse(LINE_EDIT_REFUSALS[refusal.code] ?? LINE_EDIT_REFUSALS.shape);
			const body = { prompt, duration: lineClipFrames / TIMELINE_FPS, posePin: false, lineEdit };
			const seed = lineSessionSeed();
			if (seed === null) return { ok: false, message: "" };
			body.seed = seed;
			if (preview) lineEdit.preview = true;
			return { ok: true, body, lineEdit, seed };
		}
		// The wire pairing is positional (driver.py spreads points2d across
		// frameRange by time), so the points sent are exactly the range's own
		// slice of the curve — a whole-clip dragged curve paired with a touched-
		// frames range would compress the full trail into the window.
		const requestRange = curve.frameRange ?? lineEditRange;
		const built = curveToPoints2d(sliceCurveToRange(curve.edited, requestRange));
		if (built.error) return refuse(LINE_CURVE_REFUSALS[built.error] ?? LINE_EDIT_REFUSALS.shape);
		// The take's own prompt is the text condition: a line edit changes WHERE
		// a joint goes, not what the shot is about. The fallback keeps the
		// bridge's non-empty-prompt contract satisfiable for takes imported
		// without one.
		const prompt = ((linePreviewSource?.prompt ?? motion?.prompt) || "").trim() || "A person continues the motion naturally.";
		const lineEdit = {
			sourceMotion: sourceUrl,
			track: lineTrack,
			// THE CURVE'S OWN RANGE FIRST. A drawn stroke picks its window from
			// where it was drawn (drawStrokeEdit) and a fresh pull from the frames
			// its falloff touched; the window is stamped on the committed curve
			// precisely so a request can never pair one gesture's points with
			// another render's range — `lineEditRange` is re-derived from state a
			// just-committed gesture has not landed in yet.
			frameRange: requestRange,
			points2d: built.points2d,
			camera: curve.camera,
			prompt,
		};
		const refusal = validateLineEdit(lineEdit, { clipFrames: lineClipFrames });
		if (refusal) return refuse(LINE_EDIT_REFUSALS[refusal.code] ?? LINE_EDIT_REFUSALS.shape);
		// posePin:false is mandatory, not decorative: the bridge demands a
		// `poses` array whenever posePin is not explicitly false, and a line
		// edit authors no poses at all.
		const body = { prompt, duration: lineClipFrames / TIMELINE_FPS, posePin: false, lineEdit };
		// THE SEED RULE (C9). An edit creates a take, so it may not leave the
		// seed to chance. The seed rides on the BODY, never inside `lineEdit` —
		// C6 validates that object field by field and an unknown key there is a
		// 400. `preview` is the one exception the bridge added for this loop.
		const seed = lineSessionSeed();
		if (seed === null) return { ok: false, message: "" };
		body.seed = seed;
		if (preview) lineEdit.preview = true;
		return { ok: true, body, lineEdit, seed };
	}

	/** Put a draft on screen without letting it become the take. */
	async function showLinePreview(url) {
		const source = linePreviewSourceRef.current;
		if (!source) return;
		try {
			await loadMotion(url, source.prompt, source.rotationDeg, null, source.charId, null, { preview: true });
			linePreviewShownRef.current = url;
			setLinePreviewUrl(url);
		} catch {
			setLinePreviewError(ko("The preview could not be read back", "미리보기를 읽지 못했어요"));
			await revertLinePreview();
		}
	}

	/** Back to the take itself. The source stays pinned until the reload lands,
	 * so there is never an instant where `takeSourceUrl` points at the draft.
	 * Nothing is reloaded when no draft ever reached the viewport — cancelling
	 * an in-flight preview (Esc, undo with an empty stack, a joint switch) must
	 * not cost a re-fetch and re-decode of a take that is already on screen. */
	async function revertLinePreview() {
		const source = linePreviewSourceRef.current;
		const shown = linePreviewShownRef.current;
		linePreviewShownRef.current = null;
		setLinePreviewUrl(null);
		if (!source || !shown) {
			setPreviewSource(null);
			return;
		}
		try {
			await loadMotion(source.url, source.prompt, source.rotationDeg, null, source.charId, null, { preview: true });
		} catch {
			/* loadMotion already surfaced the decode failure in the panel */
		}
		if (linePreviewSourceRef.current === source) setPreviewSource(null);
	}

	/** Stop the loop. Bumping the token is what makes an in-flight answer
	 * harmless: it arrives, finds itself stale, and is dropped without ever
	 * reaching the viewport. `revert:false` is for the callers that are ALREADY
	 * loading a different take (a version chip) and must not race a reload of
	 * the take they are leaving. */
	function cancelLinePreview({ revert = true } = {}) {
		if (linePreviewTimerRef.current) {
			window.clearTimeout(linePreviewTimerRef.current);
			linePreviewTimerRef.current = 0;
		}
		linePreviewPendingRef.current = null;
		linePreviewTokenRef.current += 1;
		const controller = linePreviewAbortRef.current;
		linePreviewAbortRef.current = null;
		if (controller) controller.abort();
		setLinePreviewBusy(false);
		setLinePreviewError("");
		setLinePreviewMs(0);
		if (revert) {
			revertLinePreview();
		} else {
			linePreviewShownRef.current = null;
			setLinePreviewUrl(null);
			setPreviewSource(null);
		}
	}

	/** A released drag asks for a draft — after a beat, so drag-drag-drag costs
	 * one request rather than three. */
	function scheduleLinePreview(curve) {
		if (linePreviewTimerRef.current) window.clearTimeout(linePreviewTimerRef.current);
		linePreviewTimerRef.current = window.setTimeout(() => {
			linePreviewTimerRef.current = 0;
			runLinePreview(curve);
		}, LINE_PREVIEW_DEBOUNCE_MS);
	}

	/** One preview round trip. Never more than one at a time (rule 3): a curve
	 * that arrives while a request is out becomes THE pending curve, replacing
	 * any earlier pending one, and is fired the moment the outstanding answer
	 * lands — whose result is then thrown away, because it describes a pull the
	 * artist has already moved past. */
	async function runLinePreview(curve) {
		if (!lineEditMode || !curve) return;
		// A preview is a courtesy, never a blocker: no bridge, no route, or the
		// box already busy with the real thing means the panel simply keeps the
		// curve and waits for the artist to press 생성.
		if (!bridge?.ok || !lineEditBackend || ardyRunning) return;
		if (linePreviewAbortRef.current) {
			linePreviewPendingRef.current = curve;
			return;
		}
		const source = linePreviewSourceRef.current ?? (motion?.url
			? {
				url: motion.url,
				prompt: motion.prompt ?? "",
				rotationDeg: motion.rotationDeg ?? activeChar.rot,
				charId: activeChar.id,
			}
			: null);
		if (!source) return;
		// Full quality on release, by request: the warm resident makes the 100-step
		// run ~2 s, and since the draft shares the session seed the confirm below
		// reproduces it bit for bit — so what the artist sees IS the final take,
		// and Generate is a commit, not a second opinion.
		const request = buildLineEditRequest(curve);
		if (!request.ok) {
			if (request.message) setLinePreviewError(request.message);
			return;
		}
		const token = ++linePreviewTokenRef.current;
		const controller = new AbortController();
		linePreviewAbortRef.current = controller;
		linePreviewPendingRef.current = null;
		setPreviewSource(source);
		setLinePreviewBusy(true);
		setLinePreviewError("");
		const startedAt = Date.now();
		let result = null;
		let failure = "";
		try {
			// No onEvent work: a preview's status lines belong to nobody. The
			// console stays the full-quality run's log.
			result = await ardyGenerate(request.body, () => {}, { signal: controller.signal });
		} catch (err) {
			// An abort is this loop's own doing and says nothing to the artist.
			failure = err?.name === "AbortError" ? "" : (err?.message || String(err));
		}
		// Stale: superseded by a newer drag or cancelled outright. Whoever bumped
		// the token owns the state now.
		if (linePreviewTokenRef.current !== token) return;
		linePreviewAbortRef.current = null;
		const pending = linePreviewPendingRef.current;
		if (pending) {
			linePreviewPendingRef.current = null;
			runLinePreview(pending);
			return;
		}
		setLinePreviewBusy(false);
		if (failure) {
			// Non-fatal by design: the curve survives, and 생성 still works.
			setLinePreviewError(failure);
			return;
		}
		if (!result?.motionUrl) return;
		setLinePreviewMs(Date.now() - startedAt);
		await showLinePreview(result.motionUrl);
	}

	function exitLineEditMode() {
		clearLineEdit();
		lineHoverRef.current = null;
		lineLiveRef.current = null;
		const stage = stageRef.current;
		if (stage) delete stage.dataset.lineGrab;
		setLineEditMode(false);
	}

	/** Entering is mutually exclusive with every other AUTHORING mode, the same
	 * way waypoint/IK/pose already are with each other: they all claim the same
	 * viewport pointer and the same playhead. Camera navigation is deliberately
	 * NOT in that list — the pointer is shared with it, not taken from it. */
	function toggleLineEditMode() {
		if (lineEditMode) {
			exitLineEditMode();
			setToast(ko("Line editing off", "라인 편집 꺼짐"));
			return;
		}
		if (!motion?.url) {
			setToast(ko("The current take has no bridge source — generate it once before editing a path", "현재 테이크에 브리지 원본이 없어요 — 궤적을 편집하기 전에 한 번 생성하세요"));
			return;
		}
		if (waypointMode) setWaypointMode(false);
		if (ikMode) leaveIkMode();
		if (posing) setPosing(null);
		clearLineEdit();
		setLineEditMode(true);
		setToast(ko(
			"Path editing on — draw along the path to reroute that section, or grab a dot and pull; the view still orbits normally",
			"궤적 편집 켜짐 — 궤적을 따라 그리면 그 구간만 새로 지나가고, 점을 잡아 끌 수도 있어요. 시점은 평소처럼 돌릴 수 있어요",
		));
	}

	/* Switching joint, range, take or character drops any pull in hand: it was
	 * authored against a trajectory that is no longer the one on screen. The
	 * curve itself needs no rebuilding — with no edit it is re-projected every
	 * repaint from the live camera.
	 *
	 * The one thing worth SAYING here is framing. Part of the range may be
	 * behind the lens or out of shot; the visible part stays draggable and the
	 * hit test ignores the rest, but a path that stops halfway looks like a bug,
	 * and hidden frames cannot be constrained. The retry exists because mode
	 * entry and a measurable pane are not the same instant — the overlay mounts
	 * in the commit that turns the mode on and DualRender may not have settled
	 * the pane's aspect yet, so the projection legitimately refuses for a frame
	 * or two. Failing silently after that is deliberate: the plan and IK views
	 * have no pinhole camera at all and are not worth nagging about. */
	useEffect(() => {
		if (!lineEditMode || !motion) return undefined;
		// ...unless the RANGE CHANGED BECAUSE A STROKE SAID SO. A drawn stroke
		// picks its own window (drawStrokeEdit) and commits the curve for that
		// window in the same gesture, so this run is reacting to the draw's own
		// bookkeeping rather than to the artist moving the goalposts. Consumed
		// once, so a later hand-typed range still drops the edit as before.
		const auto = lineAutoRangeRef.current;
		lineAutoRangeRef.current = null;
		if (auto && auto.startFrame === lineEditRange?.startFrame && auto.endFrame === lineEditRange?.endFrame) return undefined;
		// Whatever draft is on screen was drafted for the joint/range/take that
		// just changed, so it goes back to the source take with the pull. Pins go
		// with it for the same reason and one more: a pin names a JOINT, and the
		// joint just changed under it.
		cancelLinePreview();
		setLineCurve(null);
		setLinePins([]);
		let attempts = 0;
		let timer = 0;
		const check = () => {
			const live = projectLineCurve(lineEditPane());
			if (!live) {
				if (attempts >= 12) return;
				attempts += 1;
				timer = window.setTimeout(check, 120);
				return;
			}
			const hidden = live.curve.reduce((count, point) => count + (isCurvePointOnScreen(point) ? 0 : 1), 0);
			if (hidden > 0) {
				setToast(isKo
					? `이 구간의 ${hidden}프레임이 화면 밖이에요 — 구간 전체가 보이도록 시점을 잡아 주세요`
					: `${hidden} frame(s) of this range are outside the frame — orbit until the whole range is in view`);
			}
		};
		check();
		return () => window.clearTimeout(timer);
		// The range is depended on by VALUE: lineEditRange is a fresh object on
		// every render that touches lineRange, and depending on its identity
		// would fire this constantly. activeChar's ground offset and scale are in
		// here because jointTrailPoints places the trail with them — move or
		// resize the character and the path really is somewhere else.
		//
		// THE TAKE is depended on as takeSourceUrl, not as `motion`: a preview
		// swaps `motion` for a draft of the same take several times a minute,
		// and depending on the object would make every landing draft wipe the
		// very curve it is a picture of. takeSourceUrl only moves when the take
		// really does.
		// eslint-disable-next-line react-hooks/exhaustive-deps
	}, [lineEditMode, lineTrack, takeSourceUrl, lineEditRange?.startFrame, lineEditRange?.endFrame, activeChar.y, activeChar.scale]);

	// Repaint on anything that changes what the overlay should show. The window
	// resize listener is separate from React state because the pane rect can
	// change without any of it changing.
	useEffect(() => {
		if (!lineEditMode) return undefined;
		paintLineOverlay();
		const repaint = () => paintLineOverlay();
		window.addEventListener("resize", repaint);
		// A gentle rAF loop while the mode is on, and it earns its keep three
		// times over: the unedited curve is re-projected here so it follows the
		// camera, a pointermove writes only lineDragRef so this is what shows the
		// live pull without re-rendering App, and the render moves underneath
		// regardless (playback, a follow camera). A few hundred 2d-canvas points
		// per frame is noise next to the WebGL scene already animating behind it.
		let raf = requestAnimationFrame(function tick() {
			paintLineOverlay();
			raf = requestAnimationFrame(tick);
		});
		return () => {
			window.removeEventListener("resize", repaint);
			cancelAnimationFrame(raf);
		};
	});

	// Pointer plumbing. The overlay canvas is `pointer-events: none` — it only
	// PAINTS — and the listeners live on the stage container instead, so a
	// pointer that misses the curve reaches the WebGL canvas untouched. See
	// onLineStagePointerDown for why the down listener is in the capture phase
	// and what "untouched" buys. No dependency array on purpose: the handlers
	// close over lineCurve, lineRadius and the live refs, and must always be
	// this render's.
	useEffect(() => {
		if (!lineEditMode) return undefined;
		const stage = stageRef.current;
		if (!stage) return undefined;
		stage.addEventListener("pointerdown", onLineStagePointerDown, true);
		stage.addEventListener("pointermove", onLineStageHover);
		stage.addEventListener("pointerleave", onLineStageHoverEnd);
		return () => {
			stage.removeEventListener("pointerdown", onLineStagePointerDown, true);
			stage.removeEventListener("pointermove", onLineStageHover);
			stage.removeEventListener("pointerleave", onLineStageHoverEnd);
		};
	});

	// ESC leaves the mode, matching the shot look-through and the scene-object
	// selection above.
	useEffect(() => {
		if (!lineEditMode) return undefined;
		const onKey = (event) => {
			if (event.key === "Escape") {
				exitLineEditMode();
				return;
			}
			// Ctrl/Cmd+Z inside the mode undoes the last PULL, not the scene.
			// Capture phase, because the app's scene undo listens on the window
			// bubble: consuming here keeps one keystroke from doing both. An
			// empty stack still swallows the key — falling through to a scene
			// undo the user cannot see happening behind the mode would be worse
			// than a no-op. Text fields keep the browser's own undo. Shift+Z
			// (redo) is left alone: there is no line-redo yet, and silently
			// eating it would just feel broken in a different way.
			if (event.code === "KeyZ" && (event.ctrlKey || event.metaKey) && !event.shiftKey) {
				if (/INPUT|TEXTAREA/.test(document.activeElement?.tagName ?? "")) return;
				event.preventDefault();
				event.stopPropagation();
				undoLineCurve();
			}
		};
		window.addEventListener("keydown", onKey, true);
		return () => window.removeEventListener("keydown", onKey, true);
	}, [lineEditMode, lineCurve]);

	// Camera-drift watcher — and note what it does NOT do, which is now the
	// interesting half: it never blocks navigation, and IT NEVER DESTROYS
	// ANYTHING. It has no job at all while the curve is unedited, because an
	// unedited curve is re-projected every repaint and simply follows the view.
	//
	// Once something has been pulled, that pull is a 2D offset authored through
	// one specific lens — and the committed curve KEEPS that lens beside the
	// points, which is what buildLineEditRequest puts on the wire. So moving the
	// view invalidates the drawing of the line and nothing else: the edit, its
	// preview and the confirming run are all still exactly what the artist
	// authored. This watcher therefore only reports, in both directions — come
	// back toward the snapshot and the line re-attaches, with no state to restore
	// because none was thrown away. (Before this, it called clearLineEdit(): a
	// right-drag fly, the app's own navigation gesture, silently wiped a finished
	// edit. That was the bug.)
	//
	// Polling beats hooking every camera mutation: the cameras are moved from a
	// dozen places (fly controls, shot presets, live control, follow tracks) and
	// none of them reports to React. The painter re-derives the same answer every
	// frame for the ghost, and onLineStagePointerDown re-derives it synchronously
	// to close the 250 ms window between polls; this poll exists to drive the
	// PANEL, which only re-renders on state.
	useEffect(() => {
		if (!lineEditMode || !lineCurve) {
			// No edit, no drift: whatever the last curve's lens was, the live one
			// is now the baseline again and gestures are re-enabled. This is what
			// makes undo/reset back to no-curve hand the mode straight back.
			lineDriftRef.current = false;
			setLineDrifted(false);
			return undefined;
		}
		const poll = () => {
			// Never re-classify under a finger that is holding the curve or drawing
			// a new one: a live gesture owns its own snapshot, and mid-gesture
			// drift is the one case that is still a corruption rather than a
			// misalignment (see the gesture handlers — that path is unchanged).
			if (lineDragRef.current || lineDrawRef.current || linePinDragRef.current) return;
			const drifted = lineCurveDrifted(lineEditPane(), lineCurve);
			if (drifted === lineDriftRef.current) return;
			lineDriftRef.current = drifted;
			setLineDrifted(drifted);
		};
		// Immediately, then at 4 Hz: a view switch or a fly that finishes just as
		// this effect re-runs should not leave the panel a quarter second behind
		// the line it is describing.
		poll();
		const id = window.setInterval(poll, 250);
		return () => window.clearInterval(id);
		// lookThroughShot / preview / ikMode are dependencies even though the
		// body never reads them directly: they are what lineEditPane branches on,
		// so a stale closure would keep measuring the camera the pane used to
		// hold and a view SWITCH — the most obvious way to invalidate a curve —
		// would go undetected. Lens and aspect changes need no dependency: they
		// move fx/fy, which the comparison sees on its own.
	}, [lineEditMode, lineCurve, lookThroughShot, preview, ikMode]);

	// Use the same bounded, coalesced probe as generation. Capabilities can
	// disappear under a live bridge too; every health result refreshes them.
	useEffect(() => {
		if (lineEditMode) bridgeRefreshRef.current();
	}, [lineEditMode]);

	const genRunningRef = useRef(false);
	const genJobSeq = useRef(0);

	useEffect(() => {
		if (genRunningRef.current) return;
		const next = genQueue.find((job) => job.status === "queued");
		if (!next) return;
		genRunningRef.current = true;
		setGenQueue((queue) => queue.map((job) => (job.id === next.id ? { ...job, status: "running" } : job)));
		(async () => {
			try {
				await executeMotionJob(next);
				next.commandCompletion?.resolve();
				setGenQueue((queue) => queue.map((job) => (job.id === next.id ? { ...job, status: "done" } : job)));
			} catch (err) {
				next.commandCompletion?.reject(err);
				const message = err?.name === "AbortError" ? ko("Cancelled", "취소됨") : err?.message || String(err);
				setGenQueue((queue) => queue.map((job) => (job.id === next.id ? { ...job, status: "error", error: message } : job)));
			} finally {
				genRunningRef.current = false;
				generationPendingRef.current = false;
			}
		})();
	}, [genQueue]);

	useEffect(() => {
		// Never for a draft: a preview is not a take and must not mint a chip.
		if (!motion?.url || linePreviewUrl) return;
		// Never for a generated take either — its own job is about to commit a
		// real recipe with a real seed, and this placeholder would beat it to the
		// strip and label it "불러옴".
		if (takeRecipeRef.current || ardyRunning || genQueue.length > 0) return;
		if (takeVersions.some((entry) => entry.motionUrl === motion.url)) return;
		seedLoadedTake(motion.url, motion.prompt, motion.frames);
		// eslint-disable-next-line react-hooks/exhaustive-deps
	}, [motion?.url, motion?.frames, linePreviewUrl, ardyRunning, genQueue.length, takeVersions]);

	const readinessState = selectedMotionReadiness();
	const lineReadinessState = motionReadiness(bridge, { body: { lineEdit: true }, lineEditSupported: lineEditBackend });
	const trailReadinessState = motionReadiness(bridge, { body: { motionEdit: true } });

	// Studio native ports. Kept together so the binding test executes these exact
	// publication/history functions, not a substitute editor or parallel journal.
	function readStudioCamera() {
		const live = appContext.live.state, camera = shotCamRef.current;
		if (!camera) return null;
		const position = { x: camera.position.x, y: camera.position.y, z: camera.position.z };
		const direction = forwardFrom(look.current.yaw, look.current.pitch);
		return { position, lookAt: { x: position.x + direction.x, y: position.y + direction.y, z: position.z + direction.z },
			focalMm: fovToFocalMm(camera.fov * Math.PI / 180, live.filmback.sensorId, live.filmback.aspectRatio),
			sensorId: live.filmback.sensorId, slate: "Shot camera" };
	}
	function readStudioState() {
		const live = appContext.live.state;
		const list = appContext.live.characters.map(c => c.id === loadedLayerCharRef.current ? {
			...c, layer: { ...c.layer, waypoints: bufferRef.current.waypoints, promptClips: bufferRef.current.promptClips }, sessionMotion: bufferRef.current.motion,
		} : c);
		const targets = new Map(list.map(c => [c.id, { rig: live.rigs[c.id], motion: c.sessionMotion ?? null,
			ikState: c.id === loadedLayerCharRef.current ? ikStateRef.current : ikStatesRef.current.get(c.id),
			calibration: c.sessionMotion?.sceneCalibration, protectedFrames: c.id === loadedLayerCharRef.current ? physicsOptions.protectedFrames : [],
			preserveAuthoredMotion: Boolean(c.layer?.waypoints?.length) }]));
		return { host: { workspaceId: liveWorkspaceIdRef.current, documentEpoch: studioDocumentEpochRef.current,
				sceneId: activeSceneIdRef.current, sceneEpoch: studioSceneEpochRef.current }, workspaceHandle: liveWorkspaceHandleRef.current,
			sceneName: live.scenes.find(s => s.id === activeSceneIdRef.current)?.name ?? "Untitled Scene", previsMode: scenesDomain.previsMode, aspect: live.stage.shotAspect, stage: live.stage,
			objects: storeRef.current.objects, characters: list, targets, shots: live.shots, frameCount: live.timeline.frameCount,
			selection: live.studioSelection, activeCharacterId: live.activeCharacterId, selectedShotId: live.studioShotId,
			view: live.studioView, camera: live.studioCamera ?? readStudioCamera(), filmback: live.filmback, manual: manualCameraOverrideRef.current,
			bridgeReady: Boolean(bridge?.ok), busy: storeRef.current.present() !== storeRef.current.objects || Boolean(studioGestureRef.current ||
				ikBodyDragRef.current || lineDragRef.current || lineDrawRef.current || linePinDragRef.current || live.studioPhysicsRunning || recRef.current) };
	}

	/** The authored stage envelope (key light, environment, filmback) published
	 * as one body: the live read model first, so the next synchronous read sees
	 * it, then the React state the foldouts and the save path own. */

	/** All surfaces share the facade's owned sessions and store histories. */
	function beginStudioAction(domain, targetId = null) {
		return appContext.beginAction(domain, targetId);
	}
	function recordStudioAction(domain, run, targetId = null, nested = false) {
		return appContext.recordAction(domain, run, targetId, nested);
	}
	function publishStudioDomain(domain, targetId, state) {
		return appContext.storeDomain(domain).publish(state, targetId);
	}
	function canUndoStudioReceipt(receipt) {
		const owned = appContext.storeDomainForReceipt(receipt);
		return Boolean(owned && appContext.nextStoreHistory(false) === owned && owned.canUndo(receipt.undo.historyEntryId));
	}
	function isStudioHistoryRetained(receipt) {
		return Boolean(appContext.storeDomainForReceipt(receipt));
	}

	function finishStudioHistoryGesture() {
		for (const owner of appContext.storeDomains()) { owner.finishGesture?.(); owner.settle?.(); }
	}
	function stepStudioHistory(redo) {
		const before = storeRef.current.objects;
		const owned = appContext.nextStoreHistory(redo);
		if (!owned?.stepHistory(redo)) return false;
		const restored = storeRef.current.objects;
		if (before !== restored) {
			if (!redo && objectDeleteUndo?.id && restored.some(object => object.id === objectDeleteUndo.id)) {
				setSelectedHierarchyId(`object:${objectDeleteUndo.id}`); setObjectDeleteUndo(null);
			} else if (selectedSceneObjectId && !restored.some(object => object.id === selectedSceneObjectId)) setSelectedHierarchyId("props");
		}
		setToast(redo ? ko("Redone", "다시 실행됨") : ko("Undone", "실행 취소됨"));
		return true;
	}
	function commitStudioDraft(payload) {
		const owned = appContext.storeDomain(payload.domain);
		const session = owned.beginAction();
		try { session.run(() => owned.commitDraft(payload.draft)); return session.commit(); }
		catch (error) { session.cancel(); throw error; }
	}

	function studioBounds({ entity, frame, state }) {
		if (entity.renderer) {
			if (entity.attach) {
				// A carried prop's numbers are local to the frame it rides; measure it
				// where it is drawn, the frame the arrange is evaluated at.
				const world = sceneObjectWorldMatrix(entity);
				if (!world) throw new StudioProtocolError("TARGET_NOT_READY", "Attached bounds require an evaluated attachment frame.");
				const carried = new THREE.Box3(new THREE.Vector3(-entity.footprint.width / 2, 0, -entity.footprint.depth / 2), new THREE.Vector3(entity.footprint.width / 2, entity.height, entity.footprint.depth / 2));
				carried.applyMatrix4(world); return { min: { ...carried.min }, max: { ...carried.max } };
			}
			const at = objectTransformAt(entity, frame, { frameCount: state.frameCount, fps: 24 });
			const object = at ? { ...entity, ...at } : entity;
			const matrix = new THREE.Matrix4().compose(new THREE.Vector3(object.x, object.y ?? 0, object.z),
				new THREE.Quaternion().setFromEuler(new THREE.Euler((object.rotX ?? 0) * Math.PI / 180, (object.rot ?? 0) * Math.PI / 180, (object.rotZ ?? 0) * Math.PI / 180)),
				new THREE.Vector3(object.scaleX, object.scaleY, object.scaleZ));
			const box = new THREE.Box3(new THREE.Vector3(-object.footprint.width / 2, 0, -object.footprint.depth / 2), new THREE.Vector3(object.footprint.width / 2, object.height, object.footprint.depth / 2));
			box.applyMatrix4(matrix); return { min: { ...box.min }, max: { ...box.max } };
		}
		const raw = readStudioState();
		const original = raw.characters.find(c => c.id === entity.id) ?? raw.characters.find(c => c.model === entity.model);
		const target = original && raw.targets.get(original.id);
		if (!target?.rig) throw new StudioProtocolError("TARGET_NOT_READY", "Character bounds require its loaded rig.");
		const rig = cloneSkeleton(target.rig), parent = new THREE.Group();
		const originals = [], copies = [];
		target.rig.traverse(node => originals.push(node)); rig.traverse(node => copies.push(node));
		rig.userData.poseBind = new Map(originals.flatMap((node, index) => {
			const bind = target.rig.userData.poseBind?.get(node);
			return bind ? [[copies[index], structuredClone(bind)]] : [];
		}));
		parent.matrixAutoUpdate = false; parent.matrix.copy(target.rig.parent?.matrixWorld ?? new THREE.Matrix4()); parent.add(rig);
		try {
			if (target.motion) applyMotionFrame(rig, target.motion, sampleAt({ frameCount: target.motion.frames, motion: target.motion }, null, frame).motionFrame);
			// The clone shares the source rig's bind pose, so its contact radii
			// and heights are the same numbers: measure the source once and
			// hand them over instead of re-scanning every vertex per query (#413).
			resolveIkRig(target.rig);
			shareContactMeasurements(target.rig, rig);
			const resolved = resolveIkRig(rig);
			if (resolved && target.ikState?.keys.size) ikEvaluate(resolved.chains, target.ikState, frame, resolved.fkJoints, target.motion ? IK_CORRECTION_BLEND_FRAMES : 0);
			parent.updateMatrixWorld(true);
			const transform = c => new THREE.Matrix4().compose(new THREE.Vector3(c.x, c.y ?? 0, c.z), new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), (c.rot ?? 0) * Math.PI / 180), new THREE.Vector3().setScalar(c.scale ?? 1));
			const delta = transform(entity).multiply(transform(original).invert());
			const box = new THREE.Box3().setFromObject(rig, true).applyMatrix4(delta);
			return { min: { ...box.min }, max: { ...box.max } };
		} finally {
			const skeletons = new Set(); rig.traverse(n => { if (n.isSkinnedMesh) skeletons.add(n.skeleton); });
			for (const skeleton of skeletons) skeleton.dispose(); parent.remove(rig);
		}
	}
	function operateStudio({ selection, view, shotId }) {
		const { frame } = view;
		appContext.patchLive({ studioSelection: selection, studioView: view, studioShotId: shotId });
		appContext.patchTimeline({ currentFrame: frame }); tlFrameRef.current = frame;
		if (selection && ["character", "rig"].includes(selection.kind)) { appContext.patchLive({ activeCharacterId: selection.id }); setActiveCharacterId(selection.id); }
		setSelectedHierarchyId(selection ? selection.kind === "object" ? `object:${selection.id}` : ["character", "rig"].includes(selection.kind) ? `character:${selection.id}` : selection.kind === "camera" ? "camera" : "shot" : "");
		setTlFrame(frame); setWorkflowMode(view.mode); setLookThroughShot(view.lookThrough); setGridView(view.grid); setAutoColor(view.autoColor); setTlPlaying(view.playing);
	}
	const studioGestureRef = useRef(false);
	// The Studio turn authors the scene through its own families and never
	// returns an image, so there is no image action for this host to accept.
	// The Workflow dock keeps its half of that contract.
	useEffect(() => {
		if (embedMode) return;
		const down = event => { if (event.target.closest?.("canvas, .inspector-scroll, .tl-body, .plan-board")) studioGestureRef.current = true; };
		const up = () => { studioGestureRef.current = false; };
		window.addEventListener("pointerdown", down, true); window.addEventListener("pointerup", up, true); window.addEventListener("pointercancel", up, true);
		return () => { window.removeEventListener("pointerdown", down, true); window.removeEventListener("pointerup", up, true); window.removeEventListener("pointercancel", up, true); };
	}, [embedMode]);
	const selectedStudioChar = charIdFromHierarchyId(parseRigNodeId(selectedHierarchyId)?.rowId ?? selectedHierarchyId);
	appContext.patchLive({
		studioSelection: selectedSceneObjectId ? { kind: "object", id: selectedSceneObjectId, hierarchyId: selectedHierarchyId } :
			selectedStudioChar ? { kind: "character", id: selectedStudioChar, hierarchyId: selectedHierarchyId } : selectedHierarchyId === "camera" ? { kind: "camera", id: "camera" } : { kind: "scene", id: activeSceneId },
		studioShotId: activeShot?.id ?? null,
		studioPhysicsRunning: autoPhysicsRunning,
		studioView: { mode: workflowMode, frame: tlFrame, playing: tlPlaying, lookThrough: lookThroughShot, grid: gridView, autoColor },
	});
	appContext.updatePorts({
		read: readStudioState, revision: sceneRevisionRef, bounds: studioBounds, commit: commitStudioDraft,
		operate: operateStudio, undo: () => stepStudioHistory(false), redo: () => stepStudioHistory(true),
		history: redo => appContext.historyEntry(redo), finishHistoryGesture: finishStudioHistoryGesture,
		stepHistory: stepStudioHistory, capture: () => liveQueries.capture_framing_png({}),
		// One shot frame as raw read-back pixels (rows bottom-up), from the export
		// path captureShotFramePng uses; an export in flight renders at its output.
		renderFrameBuffer: frame => {
			const output = recRef.current?.capture ? recRef.current.request.context.output : shotOutput, data = withExportFrame(frame);
			if (!data) throw new Error("The shot renderer is not ready");
			return { data, width: output.width, height: output.height };
		},
		encodePng: (buffer, output) => bufferToPng(buffer, output),
		// The pose library a character.pose patch resolves its id against.
		poses: () => [DEFAULT_POSE, ...customPoses],
		loadArtifact: (artifact, options) => {
			// Keep the server-pinned URL. Stripping the origin would silently fetch
			// from a different bridge after a reconnect. The bridge owner must allow
			// CORS or supply a pinned same-origin artifact proxy; never use load_motion.
			return loadMotionFromUrl(artifact.url, options);
		},
		ikRevision: (id, stamp) => {
			const prior = studioIkStampsRef.current.get(id);
			if (!prior || prior.stamp !== stamp) studioIkStampsRef.current.set(id, { stamp, revision: (prior?.revision ?? 0) + 1 });
			return studioIkStampsRef.current.get(id).revision;
		},
		isRetained: isStudioHistoryRetained,
		canUndo: canUndoStudioReceipt,		actions: () => studioActionsRef.current,
		recordAction: recordStudioAction, beginAction: beginStudioAction,
		captureToasts: listener => { toastSinkRef.current.add(listener); return () => toastSinkRef.current.delete(listener); },
		showRefusal: appContext.notify,
		emitCommandEvent: detail => window.dispatchEvent(new CustomEvent("cozyclay:command", { detail })),
	});
	appContext.updateActionPorts({
		// Shots and objects come from the synchronously published read model, so
		// an action sees its own edit before React renders it.
		state: () => ({
			shots: appContext.live.state.shots, objects: storeRef.current.objects, characters: appContext.live.characters, frame: tlFrame, frameCount: tlFrameCount,
			selectedObjectId: selectedSceneObjectId, activeCharacterId: activeChar?.id ?? null,
			promptBlockCount: promptClips.filter((clip) => clip.text.trim()).length,
			generating: Boolean(generationPendingRef.current || genRunningRef.current || generationBusy),
			motionReady: bridge !== null && !bridgeChecking,
			// The Export menu offers Video (mp4) on exactly these conditions.
			exporting: Boolean(recRef.current), canExportVideo: shots.length > 0 || hasCameraKeys || Boolean(motion),
			// The scene refs move synchronously with every scene handler.
			scenes: appContext.live.scenes.map(({ id, name }) => ({ id, name })), activeSceneId: activeSceneIdRef.current,
			// What a save needs: a name, a file this session, and (to pick or
			// re-grant a file) the user's click still active.
			project: { name: projectName, previsMode, hasFile: Boolean(projectHandleRef.current), fileAccess: hasFileSystemAccess(),
				gesture: globalThis.navigator?.userActivation?.isActive === true },
			// What generate() reads for the Send-to-AI package, as this render has it.
			aiShot: { mode, imageModel },
			// AI-video motion: the account's Fal access, the card's job state and
			// the daily generations left (null until the server says).
			i2vMotion: { enabled: i2vMotionEnabled, status: i2vMotion.status, dailyRemaining: i2vMotion.dailyRemaining ?? null },
		}),
		addTimelineShot, splitTimelineShot, duplicateTimelineShot, removeTimelineShot, setTimelineShotRange, moveTimelineShot,
		runAllPromptBlocks,
		duplicateSelectedSceneObject,
		addCharacterWaypoint, moveCharacterWaypoint, removeCharacterWaypoint, clearCharacterWaypoints, setWaypointMode,
		setCharacterIkKey, removeCharacterIkKey, clearCharacterIkKeys, attachSceneObject, setShotCameraRail, clearShotCameraRail,
		choosePartColours, setGuideMode, setInsetCollapsed, exportShotVideo,
		readView: readStudioState, publishView: operateStudio, canPose: () => !poseRefusal,
		switchSceneDocument, addSceneDocument, duplicateSceneDocument, renameSceneDocument, deleteSceneDocument,
		afterRender: () => new Promise(resolve => renderWaitersRef.current.push(resolve)),
		saveProject, projectFileGranted: async () => (await queryHandlePermission(projectHandleRef.current)) === "granted",
		importAsset: (args, context) => objectsDomain.importAsset(args, context), fetchImportSource,
		setAiShotMode: setMode, setAiImageModel: setImageModel, generate, generateI2vMotion,
	});
	if (!studioActionsRef.current) studioActionsRef.current = createStudioAppActions(appContext.actionPorts);
	/** UI door into the shared registry. Refusal messages are written for the
	 * model, so a person only ever sees the localized `uiMessage` a thrower
	 * attached (studioActionRefusal); any other refusal stays silent, as the
	 * controls always were. */
	function runStudioAction(id, args = {}) {
		const refused = error => {
			if (!(error instanceof StudioProtocolError)) throw error;
			if (error.uiMessage) setToast(error.uiMessage);
			return null;
		};
		try {
			// A long-running action answers with a promise that refuses the same way.
			const result = appContext.bus.run(id, args, { origin: "ui" });
			const answer = receipt => receipt.ok ? receipt : null;
			return typeof result?.then === "function" ? result.then(answer, refused) : answer(result);
		} catch (error) {
			return refused(error);
		}
	}
	if (!studioBindingRef.current) {
		studioBindingRef.current = createStudioAppBinding(appContext.ports);
		studioBindingRef.current.stepHistory = redo => appContext.ports.stepHistory(redo);
		studioBindingRef.current.publishSemantic = (domain, after) => {
			if (domain === "characters" && Array.isArray(after)) { appContext.publishCharacters(after); appContext.patchLive({ characters: after }); }
			if (domain === "shots") appContext.patchLive({ shots: after });
			if (domain === "promptClips") bufferRef.current.promptClips = after;
		};
	}
	useEffect(() => () => studioBindingRef.current?.dispose(), []);
	// Every commit releases the actions waiting for React to render their edit
	// (a scene switch answers once the new room is on stage).
	useEffect(() => { for (const resolve of renderWaitersRef.current.splice(0)) resolve(); });

	const projectStatus = projectSaveState === "saving"
		? ko("Saving…", "저장 중…")
		: projectSaveState === "error"
			? ko("Save failed", "저장 실패")
			: projectName === null
				? ko("Not saved", "저장되지 않음")
				: projectDirty
					? ko("Unsaved changes", "저장되지 않은 변경사항")
					: ko("Saved", "저장됨");

	// The single shell snapshot keeps subsequent region work out of App.
	const shellContext = {
		projectMenuOpen, setProjectMenuOpen, projectDirty, projectName, previsMode, projectStartupOpen,
		requestNewProject, setProjectStartupOpen, setProjectBrowserOpen, runStudioAction, saveProject,
		projectManifest, projectSaveState, recState, exportMenuTriggerRef, exportMenuOpen,
		exportShotIdRef, setExportMenuAnchor, setExportMenuOpen, exportPhaseLabel,
		exportMenuAnchor, resultOpen, exportFeedback, shots, exportKeyframePacks,
		hasCameraKeys, motion, exportRenderPasses, exportDepthVideo, exportStoryboard,
		capturePanelThumbnail, packMetaForShot, previsMode: scenesDomain.previsMode, sceneRevision: sceneRevisionRef.current,
		downloadOtioCutList, projectStatus, liveWorkspaceHandle, selectedHierarchyId, selectHierarchy,
		aimEditorAtKeyLight, characters, showB, ikFrames, ikMode,
		rowIdForCharIndex, activeCharIndex, waypoints, sceneObjects, scenes,
		activeSceneId, selectSceneDocument, createSceneDocumentFromUi, duplicateSceneDocumentFromUi, renameSceneDocumentFromUi,
		deleteSceneDocumentFromUi, addSceneObject, renameSceneObject, deleteSceneObject, frameSelection,
		toggleHierarchyHidden, propsDrop, hierarchyReparent, agentTouchedRows, workflowMode,
		selectWorkflowMode, gizmoMode, setGizmoMode, snapEnabled, setSnapEnabled,
		preset, applyPreset, cameraPresetId, i2vMotionCameraLocked, shotAspectKey,
		fovDeg, shotsDomain, shot, setNonce, workspaceLayout,
		viewMenuTriggerRef, viewMenuOpen, setViewMenuAnchor, setViewMenuOpen, viewLooksActive,
		viewMenuAnchor, gridView, setGridView, autoColor, setAutoColor,
		isCharacterSelection, partColoursChoice, embedMode, agentCollapsed, sceneSaveError,
		studioAgentError, studioAgentMode, setStudioAgentMode, AgentPanel, setAgentCollapsed,
		buildStudioAgentContext, highlightAgentTargets, generateI2vMotionFromUi, selectedSceneObject, rigSelection,
		inspectorActionsOpen, setInspectorActionsOpen, deleteSelectedSceneObject, inspectorHasContent, keyLightSelected,
		keyLight, changeKeyLight, resetKeyLight, isCameraSelection, moveSequence,
		cameraKeys, activeShot, changeShotTargetModel, updateCharacterAt, openStudio,
		posing, removeCharacter, setShowB, activeChar, changeInspectorCharacter,
		i2vMotionModel, i2vMotionActions, setI2vMotionStudioOpen, selectablePoses, ikApplyPoseAsKey,
		setStudioPick, appContext, removePose, setPhotoPoseError, photoPoseFileRef,
		photoPoseState, photoPoseError, activeRig, saveCurrentPose, multiModelStatus,
		multiModelStage, multiModelFileRef, chooseMultiModelFile, multiModelSource, multiModelUrl,
		setMultiModelUrl, useMultiModelUrl, pasteMultiModelUrl, multiModelProgress, multiModelError,
		multiModelFootage, extractMultiModelMotion, multiModelExtract, multiModelTake, multiModelExtractProgress,
		multiModelExtractError, bridge, promptBlocksReveal, promptClips, selectedPromptId,
		setSelectedPromptId, setArdyPrompt, setTlFrame, tlFrameCount, changePromptClip,
		ardySeed, changeArdySeed, lineEditMode, toggleLineEditMode, linePreviewUrl,
		lineCurve, lineDrifted, lineTrack, setLineTrack, linePinMode,
		setLinePinMode, linePins, lineClipFrames, lineEditRange, setLineRange,
		lineRadius, changeLineRadius, lineCurveDirty, lineEditFrom, lineEditTo,
		lineCurvePointCount, lineDriftHint, lineCurveHidden, linePreviewBusy, linePreviewMs,
		linePreviewError, generationBusy, bridgeChecking, lineReadinessState, runLineEdit,
		openMotionSetup, recheckMotionHealth, resetLineCurve, exitLineEditMode, readinessState,
		ardyRunning, cancelArdy, ardyStatus, ardyOutcome, addPromptClip,
		tlFrame, isRigSelection, ikChains, ikFocus, footSnap, poseObjectOpacity, setPoseObjectOpacity, capturePoseImage,
		collisionCleanupSupported, runFixCollisions, runFixCollisionsRange, autoPhysicsRunning, physicsProgress,
		physicsPreview, physicsShow, physicsOptions, platformFitRunning, platformFitProgress,
		platformFitLast, platformFitApplied, changePhysicsOptions, runAutoPhysics, showPhysicsPreview,
		applyPhysicsPreview, cancelPhysicsPreview, ikEditTool, setIkEditTool, showTrails,
		setShowTrails, trailFalloffS, setTrailFalloffS, trailEdit, trailTrackFocus, selectTrailTrack, clearTrailTrackFocus, runTrailRegeneration,
		pendingIkEdit, applyPendingIkEdit, cancelPendingIkEdit,
		trailReadinessState, rangePins, rangePinResiduals, rangePinSelection, rangePinPartPick,
		rangePinPreview, setRangePinSelection, setRangePinPartPick, previewRangePinDraft, applyRangePinDraft,
		deleteRangePin, hasEnvSheet, environment, style, environmentImage,
		inspectorDrop, cutoutInputRef, meshInputRef, importCutout, importMesh,
		changeSceneObject, attachTargetLabel, store, beginSceneTransaction, endSceneTransaction,
		matteCanvasRef, matteStats, matteMode, setMatteMode, matteEditorRef,
		matteTolerance, setMatteTolerance, matteBrush, setMatteBrush, matteShrink,
		setMatteShrink, matteFeather, setMatteFeather, matteBusy, applyMatte,
		recentObjectColors, rememberSceneObjectColor, objectColorDraft, setObjectColorDraft, posePhotoFile,
		posingIndex, posingChar, charA, allPoses, studioPick,
		posingClosing, closeStudio, castDomain, setToast, savePose,
		bottomTab, setBottomTab, beginAssetDrag, shelfImageIds, shelfMeshIds,
		manageAssetStorage, setManageAssetStorage, unusedAssetIds, usedAssetIds, usageCounts,
		projectAssetGraphSignature, assetTrash, deleteUnusedAsset, undoDeletedAsset, deletingAssetId,
		takeSourceUrl, sceneDisabledReason, sceneMenuOpen, setSceneMenuOpen, refineDisabledReason,
		enterRefineMode, sceneGenerateDisabledReason, runArdy, sceneAgainDisabledReason, runSceneAgain,
		addSceneBlock, preserveStrength, setPreserveStrength, waypointMode, preserveTracksLine,
		takeRecipe, takeVersions, loadTakeVersion, replayNotices, craneSelectedIndex,
		addActiveCranePoint, deleteSelectedCranePoint, setCraneSelectedIndex, tlFps, ghostLayers,
		pathSpeed, tlPlaying, pendingWaypointFrame, stateBadge, applyMotionTrim,
		resetMotionTrim, cutMotionAtPlayhead, changeMotionSegmentSpeed, removeMotionSegmentById, bodyContact,
		activeShotIdx, railDraw, pathDraw, setPathDraw, setRailDraw,
		setWorkspaceLayout, timingTokenRef, railCurve, ikAddKeyframe, ikDeleteKeyframe,
		setBodyContact, setFootSnap, advanceFrame, stepFrame, cameraPreviewEndRef,
		manualCameraOverrideRef, setTlPlaying, setWaypointMode, selectActiveCharacterInHierarchy,
		toggleWaypointMode: storyboardProject ? undefined : toggleWaypointMode,
		setActiveWaypointId, setPendingWaypointFrame, removeWaypoint, queueRootWaypointFrame, revealPromptBlocks,
		resizePromptClip, movePromptClip, removePromptClip, setSelectedHierarchyId, addCameraKeyframe,
		moveCameraKeyframe, removeCameraKeyframe, syncActiveCameraFraming, activeCamera, activeShotDuration,
		changeActiveCamera, cameraRail, previewCameraShot, toggleCameraRailDraw, deleteCameraRail,
		selectTimelineShot, clearMotion,
		spawnCharacter, exportShotVideo, stopShotRecording, retryExport, poseRefusal,
		beginWorkspaceResize, motionSetupReveal, motionSetupKind,
		preferencesOpen, setPreferencesOpen, statusText, setStatusText, previewRanges, setPreviewRanges,
		flySpeed, liveHubStatus: liveWorkspaceHandle ? "connected" : "disconnected",
		agentOpen: !agentCollapsed,
		toggleAgent: () => window.dispatchEvent(new CustomEvent("cozyclay:agent-panel-toggle")),
		saveStatus: { state: projectSaveState, text: projectStatus, dirty: projectDirty, name: projectName },
		exportStatus: exportStatus && { ...exportStatus, cancel: stopShotRecording, retry: retryExport },
		subscribeToasts: (listener) => { toastSinkRef.current.add(listener); return () => toastSinkRef.current.delete(listener); },
		enterShotLook,
		lookThroughShot, exitShotLook: exitPreview,
	};

	return (
		<AppContext.Provider value={appContext}>
		<StudioShellContext.Provider value={shellContext}>
		<StudioShell className={"app" + (renderActive ? "" : " render-idle")} style={workspaceStyle} data-workflow-mode={workflowMode} data-previs-mode={scenesDomain.previsMode} data-embed-mode={embedMode ? "playview" : playgroundMode ? "playground" : undefined} data-playground-hint={playgroundMode ? playgroundHint ?? undefined : undefined} data-tutorial-step={cameraTutorial ? cameraTutorialStep ?? undefined : undefined} data-rail-draw={railDraw ? 1 : undefined} data-shot-look={lookThroughShot && !embedMode ? 1 : undefined} data-plan-draw={railDraw || pathDraw || waypointMode ? 1 : undefined}
			viewport={
				<div className="viewport" data-drop={viewportDrop.over ? "over" : undefined} {...viewportDrop.handlers}
					onWheel={(event) => {
						// Read-only UI mirror of FlyControls' persistent wheel multiplier.
						// Its native canvas listener handles navigation before this bubbles.
						if (flyingRef.current && event.target.tagName === "CANVAS") {
							setFlySpeed((speed) => THREE.MathUtils.clamp(speed * (event.deltaY > 0 ? 0.9 : 1.1), 0.15, 6));
						}
					}}>
				<ViewportToolbar />

					{/* Sits under the mode tabs and left of the Top-View inset, over the
					    stage it is teaching. The overlay itself never takes the pointer
					    (styles.css) — every step is completed in the studio underneath. */}
					{cameraTutorial && !embedMode && (
						<CameraTutorial
							key={cameraTutorialAttempt}
							analytics={cameraTutorialAnalytics.current}
							previewing={lookThroughShot}
							shotCount={shots.length}
							railReady={shots.some((shot) => Array.isArray(shot.camera?.cameraRail) && shot.camera.cameraRail.length >= 2)}
							onStepChange={setCameraTutorialStep}
							onComplete={() => { cameraTutorialCompletedRef.current = true; cameraTutorialHandoff?.complete(); }}
							onClose={() => closeCameraTutorial()}
							handoff={cameraTutorialHandoff}
							shotId={activeShot?.id ?? null}
							onOpenExport={openExportMenuForShot}
							onContinue={() => closeCameraTutorial()}
						/>
					)}
					<div className="stage" id="stage" ref={stageRef} data-render-loop={renderActive ? "always" : "demand"}>
						{/* Shadows were off, so every castShadow in props.jsx was inert and
						    nothing on the open stage ever touched the floor. A contact
						    shadow is the cue that says a subject stands ON the deck rather
						    than floats above it — without walls it is the only one left. */}
						{/* "percentage" = THREE.PCFShadowMap. Bare `shadows` asks fiber for
						    PCFSoftShadowMap, which three r185 deprecated — it already falls
						    back to PCFShadowMap at runtime, minus one console.warn per
						    frame burst. Same pixels, silent console. */}
						<Canvas
							shadows="percentage"
							frameloop={renderActive ? "always" : "demand"}
							dpr={[1, 2]}
							// Measure the layout box, not the transformed one: stageIn's scale()
							// at mount used to leave the buffer short of the box in every mode.
							resize={{ offsetSize: true }}
							gl={{ preserveDrawingBuffer: true, antialias: true }}
							onCreated={({ gl }) => {
								gl.domElement.addEventListener("webglcontextlost", (event) => {
									event.preventDefault();
									setToast(ko(
										"The graphics context was lost — restoring the stage. If it stays black, reload the page; your work is autosaved.",
										"그래픽 컨텍스트가 끊겼어요 — 무대를 복구합니다. 검게 남으면 새로고침하세요. 작업은 자동 저장돼 있습니다.",
									));
								});
								gl.domElement.addEventListener("webglcontextrestored", () => {
									setToast(ko("Graphics restored.", "그래픽이 복구됐어요."));
								});
							}}
						>
							<ContextLossGuard onLostChange={setGlContextLost} />
							<RenderLoopController stageRef={stageRef} />
							<ViewportLayoutInvalidator
								insetX={insetPos?.x ?? null}
								insetY={insetPos?.y ?? null}
								insetWidth={workspaceLayout.insetWidth}
								insetHeight={workspaceLayout.insetHeight}
								hierarchyWidth={workspaceLayout.hierarchyWidth}
								sidebarWidth={workspaceLayout.sidebarWidth}
								timelineHeight={workspaceLayout.timelineHeight}
								planZoom={workspaceLayout.planZoom}
							/>
							<color attach="background" args={[gridView ? GRID_BACKGROUND : stageBackground(uiTheme)]} />
							{/* The open stage runs 500 m; without a falloff the whole deck
							    reads at once and the horizon sits a kilometre away. Blender's
							    viewport answer is a clip distance that lets the neutral void
							    show through; the fog below is the seamless version of the
							    same idea — it fades the floor INTO the background colour, so
							    past ~120 m the deck simply ceases to exist with no horizon
							    line, no clip edge and no tone break. */}
							<fog attach="fog" args={gridView ? [GRID_FOG.color, GRID_FOG.near, GRID_FOG.far] : [stageBackground(uiTheme), 18, 54]} />
							<StageLights keyLight={keyLight} neutral={gridView} light={uiTheme === "light"} />
							<KeyLightPuck
								keyLight={keyLight}
								selected={keyLightSelected}
								visible={!preview && !lookThroughShot}
								paneRef={mainPaneRef}
								camRef={editorCamRef}
								onSelect={() => selectHierarchy("light")}
								/* The puck has no drag-start hook: the first move of a drag
								   opens the entry and the drag end closes that gesture. */
								onChange={(patch) => changeKeyLight("puck", patch)}
								onDragEnd={endGestureUndo}
							/>
							{gridView ? <GridFloor layer={GIZMO_LAYER} /> : <Room light={uiTheme === "light"} />}
							<SetProps
								objects={stageSceneObjects}
								authoredObjects={sceneObjects}
								selectedId={selectedSceneObjectId}
								frameRef={propFrameRef}
								take={{ frameCount: tlFrameCount, fps: tlFps }}
								attachFrameRef={attachFrameRef}
								syncRef={propSyncRef}
								worldRef={propWorldRef}
								fadeOpacity={workflowMode === "pose" ? poseObjectOpacity : null}
							/>

							<PerspectiveCamera
								ref={shotCamRef}
								makeDefault={!ikMode && lookThroughShot}
								fov={fovDeg}
								near={0.1}
								far={100}
								position={[0.97, 1.62, 2.39]}
							/>
							{/* the EDITOR camera: the user's working eye. Fixed lens — the
							    shot's focal length belongs to the recording, not to the
							    operator's own view of the set. */}
							<PerspectiveCamera
								ref={editorCamRef}
								makeDefault={!ikMode && !lookThroughShot}
								fov={55}
								near={0.1}
								far={100}
								position={[3.6, 2.7, 5.4]}
							/>
							{/* the poser camera is the default (event/raycast) camera in
							    IK mode so handle hit-testing matches what you see */}
							<PerspectiveCamera
								ref={poserCamRef}
								makeDefault={ikMode}
								fov={fovDeg}
								near={0.1}
								far={100}
								position={[0.97, 1.62, 2.39]}
							/>
							{/* a plan is a plan: orthographic, framed to the working area, so
							    pucks stay the same size wherever they sit */}
							<OrthographicCamera
								ref={planCamRef}
								near={0.1}
								far={80}
								position={[0, 24, 0]}
								rotation={[-Math.PI / 2, 0, 0]}
							/>

							{characterViews.map((view) => (
								// Always wrapped, grouped or not: giving or taking a parent
								// must not remount the rig the playback effects hold.
								<ObjectCarrier
									key={`${view.id}:${rigMountEpoch}`}
									objectId={view.parent}
									objectsRef={sceneObjectLookupRef}
									frameRef={propFrameRef}
									take={{ frameCount: tlFrameCount, fps: tlFps }}
									registryRef={carrierRegistryRef}
								>
									<Character
										url={view.url}
										{...{ model: view.model, posture: view.posture }}
										position={view.position}
										rot={view.rot}
										tint={view.tint}
										partColoursEnabled={view.partColoursEnabled}
										partColoursMode={view.partColoursMode}
										pose={view.pose}
										scale={view.scale}
										onRig={view.onRig}
										pickId={view.pickId}
									/>
								</ObjectCarrier>
							))}

							{/* Selection marker: XYZ tripod + ring on the picked cast
							    member; the X/Z arrows drag it across the deck. */}
							{gizmoView && !playMode && !posing && !ikMode && (
								<ObjectGizmo
									pickOnly
									claimPointer={lineEditMode ? lineGrabProbe : undefined}
									object={characterGizmoObject}
									objects={characterGizmoObject ? [characterGizmoObject] : []}
									mode={gizmoMode}
									snap={snapEnabled}
									enabled={!planIsMain && !posing && !ikMode && !playMode && !!characterGizmoObject}
									paneRef={mainPaneRef}
									camRef={lookThroughShot ? shotCamRef : editorCamRef}
									shotAspect={lookThroughShot ? shotOutput.aspect : null}
									onChange={(id, patch) => moveCharacter(activeChar.id, () => {
										const next = {};
										if (patch.x !== undefined) next.x = THREE.MathUtils.clamp(patch.x, CHARACTER_POSITION_BOUNDS.min.x, CHARACTER_POSITION_BOUNDS.max.x);
										// Lift floors at the deck but has no ceiling — a crane
										// shot may hoist the body as high as the move needs
										// (the inspector's Height scrub agrees).
										if (patch.y !== undefined) next.y = Math.max(CHARACTER_POSITION_BOUNDS.min.y, patch.y);
										if (patch.z !== undefined) next.z = THREE.MathUtils.clamp(patch.z, CHARACTER_POSITION_BOUNDS.min.z, CHARACTER_POSITION_BOUNDS.max.z);
										// a body only yaws — the X/Z rings and the screen ring's
										// other channels have nowhere to go on a character
										if (patch.rotY !== undefined) next.rot = patch.rotY;
										// one stature knob: any scale axis reads as uniform
										const s = patch.scaleX ?? patch.scaleY ?? patch.scaleZ;
										if (s !== undefined) next.scale = THREE.MathUtils.clamp(s, CHARACTER_SCALE_BOUNDS.min, CHARACTER_SCALE_BOUNDS.max);
										return next;
									})}
								/>
							)}

							<ShotRig
								preset={preset}
								nonce={nonce}
								appliedPresetRef={shotPresetAppliedRef}
								lastPosRef={shotCameraPosRef}
								fovDeg={fovDeg}
								charA={charA}
								charB={charB}
								showB={showB}
								probeX={motionPos ? motionPos.x : charA.x}
								probeZ={motionPos ? motionPos.z : charA.z}
								camRef={shotCamRef}
								look={look}
								onMetrics={(p, visible) => {
									shotCameraPosRef.current = { x: p.x, y: p.y, z: p.z };
									setCameraPos((prev) =>
										Math.abs(prev.x - p.x) + Math.abs(prev.y - p.y) + Math.abs(prev.z - p.z) > 1e-4
											? { x: p.x, y: p.y, z: p.z }
											: prev,
									);
									setSubjectVisible((prev) => (prev === visible ? prev : visible));
								}}
							/>
							<MoveRig
								playing={movePlaying}
								// Authoring modes own the viewport: placing or dragging a root
								// waypoint scrubs the playhead as a side effect, and follow
								// must not turn that scrub into a camera lurch. Same for IK
								// and pose studio, where the shot camera is deliberately frozen.
								// Preview is the finished-output player: the move always rides
								// the playhead there. The Follow toggle and authoring-mode gates
								// only protect the editor view's manipulation surfaces.
								// This shot's Camera Block owns the camera while Follow or Rail is active;
								// editorial camera keys resume when the block returns to Keys mode.
								following={!followCamActive && hasCameraKeys && (preview || (moveFollow && !ikMode && !waypointMode && !posing))}
								followFrame={tlFrame}
								fps={tlFps}
								keys={cameraKeys}
								shots={shots}
								scene={playbackScene}
								camRef={shotCamRef}
								look={look}
								isInterrupted={() => (lookThroughShot && flyingRef.current) || manualCameraOverrideRef.current}
								onDone={shotsDomain.finishCameraMove}
							/>
							<FollowCamRig
								enabled={followCamActive && !movePlaying}
								frame={tlFrame}
								scene={playbackScene}
								shot={activeShot}
								camRef={shotCamRef}
								look={look}
								isInterrupted={() => (lookThroughShot && flyingRef.current) || manualCameraOverrideRef.current}
							/>
							{/* Camera stays live in IK mode but drives the POSER camera,
							    never the shot camera: the handle layer only consumes
							    pointerdowns that hit a handle, so empty-space drags orbit
							    and the wheel dollies without wrecking the framing. */}
							<FlyControls
								enabled={!posing && !playMode}
								cameraLocked={lookThroughShot && i2vMotionCameraLocked}
								camRef={ikMode ? poserCamRef : lookThroughShot ? shotCamRef : editorCamRef}
								look={ikMode ? poserLook : lookThroughShot ? look : editorLook}
								getPivot={() => {
									if (!selectedSceneObject) return null;
									const size = objectSize(selectedSceneObject);
									return { x: selectedSceneObject.x, y: (selectedSceneObject.y ?? 0) + size.height / 2, z: selectedSceneObject.z };
								}}
							onFlyStateChange={(flying) => {
								flyingRef.current = flying;
								if (flying) trackFeature("camera_fly");
							}}
								onCameraChange={lookThroughShot && !ikMode ? commitManualCameraFraming : undefined}
							/>
							<PoseHandles
								root={posedRig()}
								enabled={!!posing && !planIsMain && !playMode}
								onChange={(before, after) => {
									markSemanticEdit("pose", before, after);
									setPoseTick((n) => n + 1);
								}}
							/>
							<IkHandles
								chains={ikChains}
								fkJoints={ikFkJoints}
								ikState={ikStateRef.current}
								enabled={ikMode && (ikEditTool === "ik" || ikEditTool === "pin") && !posing && !playMode}
								selectionOnly={ikEditTool === "pin"}
								onPartPick={(track) => { setRangePinPartPick(track); setRangePinSelection(null); }}
								focus={ikFocus}
								onFocus={focusIkHandle}
								onSolve={ikSolve}
								onDragEnd={ikDragEnd}
							/>
							<RangePinMarker
								chains={ikChains}
								track={rangePinPreview?.track}
								target={rangePinPreview?.target}
								enabled={ikMode && ikEditTool === "pin" && Boolean(rangePinPreview?.target)}
							/>
							{/* The tutorial's top view is the landing playground's: camera, cast
							    and the rail only, so the line the Rail step asks for is drawn on
							    a clean floor instead of over 34 footprints. */}
							<PlanBoard
								minimal={playgroundMode || cameraTutorial}
								hostRef={planHostRef}
								planCamRef={planCamRef}
								shotCamRef={shotCamRef}
								look={look}
								fovDeg={fovDeg}
								characters={characters}
								characterPlacements={characterViews}
								onMoveCharacter={moveCharacter}
								onCameraGestureStart={beginCameraFramingGesture}
								pathStart={activeChar}
								waypoints={waypoints}
								activeWaypointId={activeWaypointId}
								onSelectWaypoint={(id) => { const waypoint = waypoints.find((entry) => entry.id === id); if (!waypoint) throw new Error(`Unknown waypoints ID: ${id}`); setActiveWaypointId(id); setTlFrame(Math.min(waypoint.frame, tlFrameCount - 1)); setWaypointMode(true); }}
								onMoveWaypoint={moveWaypoint}
								// Selection switch first, then the producer begins its
								// transaction (plan §6.4): the settle here commits any
								// previously open drag as one entry so the fresh token
								// issued by onObjectMoveStart cannot leak.
								onSelectEntity={(id) => {
									objectsDomain.settleObjects();
									setSelectedHierarchyId(id.startsWith("object:") ? id : id === "cam" ? "camera" : charKeyToHierarchyId(id));
								}}
								sceneObjects={stageSceneObjects}
								selectedSceneObjectId={selectedSceneObjectId}
								onMoveSceneObject={changeSceneObject}
								onObjectMoveStart={beginSceneTransaction}
								onObjectMoveEnd={endSceneTransaction}
								cameraRailPoints={railCurve ? railCurve.points : null}
								railDraw={railDraw}
								pathDraw={pathDraw}
								objectPathPoints={selectedSceneObject?.path?.points ?? null}
								objectPathSelectedIndex={pathPointIndex}
								onObjectPathPointSelect={setPathPointIndex}
								onObjectPathPointMove={(index, floor) => {
									const path = selectedSceneObject?.path;
									if (!path) return;
									// The board edits the floor route only; a point's height is
									// the scene's business, so y rides through untouched.
									const points = path.points.map((point, i) => (i === index ? { ...point, x: floor.x, z: floor.z } : point));
									changeSceneObject(selectedSceneObject.id, { path: { ...path, points } }, planPathTokenRef.current);
								}}
								onObjectPathPointInsert={(index, t) => {
									const path = selectedSceneObject?.path;
									if (!path || path.points.length >= MAX_PATH_POINTS) return;
									const a = path.points[index];
									const b = path.points[index + 1];
									const inserted = {
										x: a.x + (b.x - a.x) * t,
										y: (a.y ?? 0) + ((b.y ?? 0) - (a.y ?? 0)) * t,
										z: a.z + (b.z - a.z) * t,
									};
									const points = [...path.points.slice(0, index + 1), inserted, ...path.points.slice(index + 1)];
									const token = beginSceneTransaction({ owner: "object-path", cancel: () => {} });
									changeSceneObject(selectedSceneObject.id, { path: { ...path, points } }, token);
									endSceneTransaction(token, { commit: true });
									setPathPointIndex(index + 1);
									setToast(ko("Point added — drag it here, or lift it in the scene", "점을 추가했어요 — 여기서 끌거나 씬에서 높이를 올리세요"));
								}}
								onObjectPathGestureStart={() => {
									planPathTokenRef.current = beginSceneTransaction({ owner: "object-path", cancel: () => { planPathTokenRef.current = null; } });
								}}
								onObjectPathGestureEnd={(commit) => {
									if (planPathTokenRef.current != null) endSceneTransaction(planPathTokenRef.current, { commit });
									planPathTokenRef.current = null;
								}}
								subjectTrack={motion ? subjectTrack : null}
								keyLight={keyLight}
								onRailStroke={shotsDomain.drawCameraRail}
								onPathStroke={(stroke) => {
									if (!selectedSceneObject) return;
									// Few points on purpose: the stroke sets the shape, the
									// operator adds the handles they actually want by
									// double-clicking the line. The route starts at the height
									// the object stands at, so a raised body (a chassis on its
									// wheels, a prop on a table) travels where it is instead of
									// dropping to the floor; changing height comes later, from
									// dragging a point in the scene.
									const height = selectedSceneObject.attach ? 0 : selectedSceneObject.y ?? 0;
									const points = strokeToPathPoints(stroke, simplifyStroke).map((point) => ({ ...point, y: height }));
									if (points.length < 2) return;
									const token = beginSceneTransaction({ owner: "object-path", cancel: () => {} });
									changeSceneObject(selectedSceneObject.id, { path: { ...(selectedSceneObject.path ?? {}), points } }, token);
									endSceneTransaction(token, { commit: true });
									setPathDraw(false);
									const metrics = pathMetrics(createObjectPath({ points }));
									setToast(isKo
										? `이동 경로 완성 — ${metrics.length.toFixed(1)} m, 점 ${points.length}개`
										: `Travel path drawn — ${metrics.length.toFixed(1)} m, ${points.length} points`);
								}}
								onCameraChange={commitManualCameraFraming}
							/>
							{/* Object gizmo: the shot pane's direct manipulation. Off while
							    the plan owns the big pane (the pucks are the handles there)
							    and while posing/IK owns the pointer. */}
							<ObjectGizmo
								object={cameraGizmoObject ?? lightGizmoObject ?? (selectedSceneObject && !isEffectivelyHidden(selectedSceneObject, sceneObjects, characters) ? selectedSceneObject : null)}
								objects={sceneObjects}
								mode={lightGizmoObject ? "move" : cameraGizmoObject ? (gizmoMode === "scale" ? "move" : gizmoMode) : gizmoMode}
								snap={snapEnabled}
								enabled={!planIsMain && !posing && !ikMode && !playMode}
								paneRef={mainPaneRef}
								camRef={lookThroughShot ? shotCamRef : editorCamRef}
								shotAspect={lookThroughShot ? shotOutput.aspect : null}
								// The token MUST round-trip: dropping it sends every drag tick
								// through applyAtomic, whose settle cancels the open drag after
								// its first move (the gizmo hands its teardown as the cancel).
								onChange={(id, patch, token) => (id === "__shotcam__" ? changeShotCameraFromGizmo(id, patch) : id === "__keylight__" ? changeKeyLightFromGizmo(id, patch) : changeSceneObject(id, patch, token))}
								onDragStart={(...args) => (cameraGizmoObject || lightGizmoObject ? undefined : beginSceneTransaction(...args))}
								onDragEnd={(...args) => {
									if (lightGizmoObject) endGestureUndo();
									else if (!cameraGizmoObject) endSceneTransaction(...args);
								}}
								onSelect={(id) =>
									selectHierarchy(
										id === "__shotcam__" ? "camera" : id === "__keylight__" ? "light" : id?.startsWith("char:") ? charKeyToHierarchyId(id) : id ? `object:${id}` : "props",
									)
								}
								onGroundClick={waypointMode && !planIsMain ? addFloorWaypoint : undefined}
								claimPointer={lineEditMode ? lineGrabProbe : undefined}
							/>
							{!preview && railCurve && (
								<CameraRailScenePreview
									points={railCurve.points}
									cumLen={railCurve.cumLen}
									length={railCurve.length}
									crane={activeCamera.craneHeight}
								/>
							)}
							<ObjectPathHandles
								path={selectedSceneObject?.path ?? null}
								selectedIndex={pathPointIndex}
								enabled={!preview && !lookThroughShot && !ikMode && !posing && !!selectedSceneObject?.path}
								paneRef={mainPaneRef}
								camRef={editorCamRef}
								onSelect={setPathPointIndex}
								onChangePoints={(points) => {
									if (!selectedSceneObject) return;
									changeSceneObject(selectedSceneObject.id, { path: points === null ? null : { ...selectedSceneObject.path, points } });
								}}
								onDragStart={() => {
									pathDragTokenRef.current = beginSceneTransaction({ owner: "object-path", cancel: () => {} });
								}}
								onDragEnd={() => {
									if (pathDragTokenRef.current) endSceneTransaction(pathDragTokenRef.current, { commit: true });
									pathDragTokenRef.current = null;
								}}
							/>
							<CraneHandles
								rail={railCurve}
								crane={activeCamera.craneHeight}
								controlPoints={activeCamera.cameraRail}
								selectedIndex={craneSelectedIndex}
								enabled={!preview && !lookThroughShot && !ikMode && !posing && !!railCurve && !!activeCamera.craneHeight}
								paneRef={mainPaneRef}
								camRef={editorCamRef}
								onSelect={setCraneSelectedIndex}
								onChangePoints={shotsDomain.changeCranePoints}
								onChangeRail={shotsDomain.changeCraneRail}
							/>
							<EditorCamSeed camRef={editorCamRef} lookRef={editorLook} shotCamRef={shotCamRef} subject={charA} />
							<CameraGlide glide={camGlide} camRef={editorCamRef} lookRef={editorLook} onDone={() => setCamGlide(null)} />
							<ShotLookApplier camRef={shotCamRef} look={look} />
							<ShotCameraGhost
								camRef={shotCamRef}
								fovDeg={fovDeg}
								aspect={shotOutput.aspect}
								visible={!preview && !lookThroughShot && !ikMode && !posing}
								selected={shotCameraSelected}
							/>
							{waypointMode && !preview && (
								<ShotPathPreview waypoints={waypoints} start={charA} activeWaypointId={activeWaypointId} />
							)}
							<CaptureRig
								apiRef={captureRef}
								camRef={shotCamRef}
								width={shotOutput.width}
								height={shotOutput.height}
							/>
							<CaptureRig apiRef={mcpCaptureRef} camRef={shotCamRef} width={MCP_CAPTURE_W} height={MCP_CAPTURE_H} />
							{/* IK-mode motion trails: the root path plus the focused effector's
							    trajectory, grabbable to deform the take with falloff. */}
							{ikMode && motion && (
								<MotionTrails
									motion={motion}
									rig={activeRig}
									baseY={activeChar.y ?? 0}
									charScale={activeChar.scale ?? 1}
									ikFocus={ikFocus}
									activeTrackId={trailTrackFocus}
									falloffFrames={trailFalloffFrames}
									playheadFrame={tlFrame}
									pendingEdit={trailEdit}
									enabled={ikMode && ikEditTool === "trail" && showTrails && !posing && !playMode}
									visible={showTrails}
									onDragStart={onTrailDragStart}
									onDragPreview={onTrailDragPreview}
									onDragEnd={onTrailDragEnd}
								/>
							)}
							<DualRender
								stageRef={stageRef}
								mainRef={mainPaneRef}
								insetRef={insetPaneRef}
								shotPreviewRef={shotPreviewRef}
								shotCamRef={shotCamRef}
								planCamRef={planCamRef}
								poserCamRef={poserCamRef}
								editorCamRef={editorCamRef}
								// The studio and the landing playground hide the facing marks on
								// screen; the Workflow embed shows the scene as exported. Captures
								// render outside this loop and keep them everywhere.
								editorLook={!embedMode}
								ikMode={ikMode}
								planIsMain={planIsMain}
								// Preview IS PlayView's render path: DualRender tests this branch
								// first, so the embed and playground rail land in the letterboxed
								// player. Studio look-through keeps playMode false and flies the
								// shot camera in the editing draw instead.
								playMode={preview}
								lookThrough={lookThroughShot}
								insetCollapsed={workspaceLayout.insetCollapsed || workflowMode === "motion" || workflowMode === "pose"}
								planZoom={workspaceLayout.planZoom}
								shotAspect={shotOutput.aspect}
							/>
						</Canvas>

						{/* Line editing (C6): the path overlay. A plain 2D canvas stacked
						    on the stage — it never enters the three.js scene graph, so an
						    edit cannot disturb picking, playback or the render loop, and it
						    behaves the same in every view mode.
						    It carries NO pointer handlers and is `pointer-events: none`:
						    the mode must not take the viewport hostage, so the listeners
						    live on the stage container (capture phase) and consume a
						    pointer only when it actually grabs the curve. Everything else
						    — orbit, pan, click-to-select — reaches the WebGL canvas
						    untouched while the mode is on. */}
						{lineEditMode && (
							<canvas
								ref={lineOverlayRef}
								className="line-edit-overlay"
								aria-hidden="true"
							/>
						)}

						{!(globalThis.__cozyclayWebGLAvailable ??= (() => {
							if (typeof document === "undefined") return true;
							const canvas = document.createElement("canvas");
							return Boolean(canvas.getContext("webgl") || canvas.getContext("experimental-webgl"));
						})()) && (
							<div className="gl-lost-overlay" role="alert" data-testid="webgl-unavailable">
								<div className="gl-lost-card">
									<strong>{ko("3D graphics (WebGL) is turned off in this browser", "이 브라우저에서 3D 그래픽(WebGL)이 꺼져 있어요")}</strong>
									<p>{ko("Quit the browser completely (Cmd+Q) and reopen it, or turn on \"Use graphics acceleration when available\" in its settings. chrome://gpu shows the WebGL status.", "브라우저를 완전히 종료(Cmd+Q)했다가 다시 열거나, 설정에서 '가능한 경우 그래픽 가속 사용'을 켜세요. chrome://gpu 에서 WebGL 상태를 확인할 수 있어요.")}</p>
								</div>
							</div>
						)}

						{glContextLost && (
							<div className="gl-lost-overlay" role="alert">
								<div className="gl-lost-card">
									<strong>{ko("The 3D view lost its graphics context", "3D 뷰가 그래픽 컨텍스트를 잃었어요")}</strong>
									<p>{ko("Waiting for the browser to restore it. If this stays, reload the studio — scenes autosave.", "브라우저가 복구하기를 기다리는 중이에요. 계속 멈춰 있으면 새로고침하세요 — 장면은 자동 저장됩니다.")}</p>
									<button type="button" onClick={() => window.location.reload()}>{ko("Reload", "새로고침")}</button>
								</div>
							</div>
						)}

						<div ref={mainPaneRef} className={"vp-pane vp-main" + (planIsMain ? " plan" : "")} />
						<div
							ref={insetPaneRef}
							hidden={playMode}
							className={"vp-pane vp-inset" + (planIsMain || ikMode ? " shot" : " plan") + (workspaceLayout.insetCollapsed ? " collapsed" : "")}
							style={{
								"--shot-aspect": shotOutput.aspect,
								...(insetPos ? { left: insetPos.x, top: insetPos.y, right: "auto" } : {}),
							}}
						>
							<span
								className="vp-inset-tag"
								title={workspaceLayout.insetCollapsed ? ko("Click or ▸ to expand · drag to move", "클릭 또는 ▸로 펼치기 · 드래그로 이동") : ko("Click or ▾ to fold · drag to move", "클릭 또는 ▾로 접기 · 드래그로 이동")}
								onPointerDown={beginInsetDrag}
							>
								<span
									className="vp-inset-caret"
									role="button"
									tabIndex={-1}
									aria-expanded={!workspaceLayout.insetCollapsed}
									aria-label={workspaceLayout.insetCollapsed ? ko("Expand inset view", "인셋 보기 펼치기") : ko("Collapse inset view", "인셋 보기 접기")}
									title={workspaceLayout.insetCollapsed ? ko("Expand inset view", "인셋 보기 펼치기") : ko("Collapse inset view", "인셋 보기 접기")}
									onPointerDown={(e) => e.stopPropagation()}
									// Same one-fold-per-gesture rule as the tag: ignore the
									// second click of a double-click (detail=2).
									onClick={(e) => {
										if (e.detail > 1) return;
										insetToggledAtRef.current = Date.now();
										runStudioAction("view.setInset", { collapsed: !workspaceLayout.insetCollapsed });
									}}
								>
									{workspaceLayout.insetCollapsed ? "▸" : "▾"}
								</span>
								{planIsMain || ikMode ? ko("Shot view", "샷 뷰") : ko("Top-View", "탑뷰")}
								{!planIsMain && !ikMode && workspaceLayout.planZoom !== 1 && !workspaceLayout.insetCollapsed && (
									<em className="vp-inset-zoom">{workspaceLayout.planZoom.toFixed(2).replace(/\.?0+$/, "")}×</em>
								)}
							</span>
							{!workspaceLayout.insetCollapsed && (
								<span
									className="vp-inset-resize"
									role="separator"
								aria-label={ko("Resize inset view", "인셋 보기 크기 조절")}
									onPointerDown={beginInsetResize}
								/>
							)}
						</div>

						<div
							ref={shotPreviewRef}
							hidden={playMode || ikMode || lookThroughShot || workflowMode === "motion"}
							className="vp-pane vp-shot-preview"
							style={{ "--shot-aspect": shotOutput.aspect }}
						>
							<ShotGuideOverlay mode={guideMode} aspect={shotOutput.aspect} />
							<span className="vp-inset-tag vp-shot-preview-tag">
								<span className="vp-rec-dot" aria-hidden="true" />
								{ko("Shot", "샷")}
								<button
									type="button"
									className={"vp-guide-cycle" + (guideMode === "off" ? "" : " on")}
									aria-label={ko("Cycle composition guides", "구도 가이드 전환")}
									title={ko(GUIDE_LABELS[guideMode].en, GUIDE_LABELS[guideMode].ko) + ko(" · click to cycle", " · 클릭으로 전환")}
									onClick={() => runStudioAction("view.setGuideMode", { mode: nextGuideMode(guideMode) })}
								>
									<svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden="true">
										<path d="M3 3h18v18H3z" />
										<path d="M9 3v18M15 3v18M3 9h18M3 15h18" />
									</svg>
								</button>
								<button
									type="button"
									className="vp-look-through"
									aria-label={ko("Look through the shot camera", "샷 카메라 시점으로 보기")}
									title={ko("Look through the shot camera — right-drag, WASD and orbit set the recording lens (Esc returns)", "샷 카메라 시점으로 보기 — 오른쪽 드래그, WASD, 궤도로 촬영 렌즈를 맞춥니다 (Esc로 복귀)")}
									onClick={enterShotLook}
								>
									<svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
										<path d="M15 3h6v6" />
										<path d="M21 3l-8 8" />
										<path d="M9 21H3v-6" />
										<path d="M3 21l8-8" />
									</svg>
									{ko("Look through", "샷 시점")}
								</button>
							</span>
						</div>
						{/* The player's only visible affordance: without it Esc would be
						    the sole way back, and the embed has no way back at all — the
						    Workflow node's preview is meant to stay in the shot view. */}
						{lookThroughShot && !ikMode && !embedMode && (
							<button
								type="button"
								className="vp-inset-tag vp-look-through-exit"
								title={ko("Return to the editor view (Esc)", "에디터 시점으로 돌아가기 (Esc)")}
								onClick={exitPreview}
							>
								<span className="vp-rec-dot" aria-hidden="true" />
								{ko("Shot camera", "샷 카메라")}
								<span className="vp-exit-hint">{ko("Esc · exit", "Esc · 나가기")}</span>
							</button>
						)}

						{/* Composition guides are an opt-in viewer preference (default off),
						    so they follow the shot camera into the player rather than being
						    counted as chrome. */}
						{lookThroughShot && !ikMode && (
							<ShotGuideOverlay mode={guideMode} aspect={shotOutput.aspect} className="lookthrough" />
						)}
						<div className="film-frame" hidden={playMode || !lookThroughShot}>
							<span />
							<span />
							<span />
							<span />
						</div>
						<div className={"caption" + (subjectVisible ? "" : " off")} hidden={playMode || !lookThroughShot}>
							{subjectVisible ? slateLineKo(shot) : ko("SUBJECT OUT OF FRAME", "피사체가 프레임 밖에 있어요")}
						</div>

						</div>
					</div>
			}
		>

			{i2vMotionStudioOpen && <I2vMotionModal model={i2vMotionModel} actions={i2vMotionActions} onClose={() => setI2vMotionStudioOpen(false)} />}
			{result && resultOpen && (
				<ResultModal
					result={result}
					copied={copied}
					recordedVideoName={result.mode === "video" ? recordedVideoName : null}
					onClose={() => setResultOpen(false)}
					onCopy={() => copyPrompt(result.prompt)}
					onDownload={download}
					downloadDisabled={recState === "recording" || Boolean(result.downloaded)}
					exportFeedback={exportStatus?.kind === "frame" ? exportFeedback() : null}
				/>
			)}

			{(projectBrowserOpen || projectStartupOpen) && (
				<ProjectBrowser
					startup={projectStartupOpen}
					currentName={projectName}
					onOpen={(entry) => openProjectByHandle(entry.handle)}
					onOpenFile={() => {
						setProjectBrowserOpen(false);
						openProject();
					}}
					starters={STARTER_SCENES}
					onStarter={(id, name) => {
						setProjectBrowserOpen(false);
						void openStarterScene(id, "starter", name);
					}}
					onNew={(name, options) => {
						setProjectBrowserOpen(false);
						requestNewProject(false, options);
					}}
					onClose={() => {
						setProjectBrowserOpen(false);
						setProjectStartupOpen(false);
					}}
				/>
			)}
			<ProjectNameDialog
				open={Boolean(projectNameDialog)}
				initialName={projectNameDialog?.initialName}
				onCancel={() => setProjectNameDialog(null)}
				onSubmit={(name) => {
					const kind = projectNameDialog?.kind;
					if (kind === "save") void saveProject(false, name);
					else newProject(name);
				}}
			/>
			<FirstSuccessGuide open={firstSuccessGuideOpen} onDismiss={() => setFirstSuccessGuideOpen(false)} />
			<UseCaseQuestion
				open={useCaseAskOpen}
				isKo={isKo}
				onAnswer={(useCase, team) => {
					recordUseCase(useCase, team);
					setUseCaseAskOpen(false);
				}}
			/>
			{saveBlockedReasons && <SaveBlockedDialog reasons={saveBlockedReasons} onClose={() => setSaveBlockedReasons(null)} />}
			<Toast message={toast} onDone={() => showToast((current) => current === toast ? "" : current)} />
			{pwaUpdate && (
				<div className="scene-delete-toast" role="status">
					<span>{ko("A new version of CozyClay is ready.", "CozyClay 새 버전이 준비됐어요.")}</span>
					<button
						type="button"
						onClick={() => {
							// The worker is waiting; tell it to take over, which the
							// controllerchange listener turns into one reload.
							pwaUpdate.waiting?.postMessage({ type: "SKIP_WAITING" });
							setPwaUpdate(null);
						}}
					>
						{ko("Reload to update", "새로고침해 업데이트")}
					</button>
					<button type="button" className="ghost" onClick={() => setPwaUpdate(null)}>
						{ko("Later", "나중에")}
					</button>
				</div>
			)}
			{objectDeleteUndo && (
				<div className="scene-delete-toast" role="status">
					<span>{ko("Object deleted.", "오브젝트를 삭제했어요.")}</span>
					<button type="button" aria-label={ko("Undo object deletion", "오브젝트 삭제 실행 취소")} onClick={undoObjectDeletion}>
						{ko("Undo", "실행 취소")}
					</button>
				</div>
			)}
			{restoreOffer && (
				<div className="asset-delete-toast" role="status">
					<span>{isKo ? `마지막 프로젝트 복원${restoreOffer.name ? `: ${restoreOffer.name}` : ""}` : `Restore last project${restoreOffer.name ? `: ${restoreOffer.name}` : ""}`}</span>
					<button
						type="button"
						onClick={async () => {
							const record = restoreOffer;
							setRestoreOffer(null);
							if ((await requestHandlePermission(record.handle)) !== "granted") {
								setToast(ko("Project access was not granted.", "프로젝트 접근이 허용되지 않았어요."));
								return;
							}
							await restoreStoredProject(record);
						}}
					>
						{ko("Restore", "복원")}
					</button>
					<button type="button" onClick={() => setRestoreOffer(null)} aria-label={ko("Dismiss", "닫기")}>✕</button>
				</div>
			)}
			{assetTrash.length > 0 && assetUndoOffered && (
				<div className="asset-delete-toast" role="status">
					<span>{ko("Image deleted. This session can undo it.", "이미지를 삭제했어요. 이 세션에서 실행 취소할 수 있어요.")}</span>
					<button type="button" onClick={undoDeletedAsset} disabled={Boolean(deletingAssetId)}>{ko("Undo", "실행 취소")}</button>
				</div>
			)}
			{assetDrag && (
				<div className="asset-drag-ghost" style={{ left: assetDrag.x, top: assetDrag.y }} aria-hidden="true">
					{assetDrag.payload.kind === "image" && assetDrag.payload.thumb ? (
						<img className="asset-drag-ghost-thumb" src={assetDrag.payload.thumb} alt="" />
					) : (
						<span
							className="asset-card-swatch"
							data-model={assetDrag.payload.kind === "character" ? assetDrag.payload.id : undefined}
							style={assetDrag.payload.kind === "object" ? { background: assetDrag.payload.color } : undefined}
						/>
					)}
					<span>{assetDrag.payload.label}</span>
				</div>
			)}
		</StudioShell>
		</StudioShellContext.Provider>
		</AppContext.Provider>
	);
}

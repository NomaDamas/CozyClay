import {
	memo,
	useEffect,
	useMemo,
	useRef,
	useState,
} from "react";
import { Canvas, useFrame } from "@react-three/fiber";
import { Line, OrthographicCamera, PerspectiveCamera, Text } from "@react-three/drei";
import * as THREE from "three";
import { buildArdyPose } from "./ardy/export.js";
import { checkBridge, generate as ardyGenerate } from "./ardy/client.js";
import { characterScaleFor, loadMotionFromUrl } from "./ardy/npz.js";
import { motionUrlFromQuery } from "./ardy/motion-url.js";
import { retimeMotion } from "./ardy/retime.js";
import { applyAutoFall, applyRootDrop, autoRoofDrop, normalizeRootDrop } from "./ardy/root-drop.js";
import {
	createMotionEdit,
	motionEditLayout,
	remapFrameKeyMap,
	remapTimelineFrame,
	removeMotionSegment,
	renderMotionEdit,
	setMotionSegmentSpeed,
	splitMotionEdit,
	trimMotionEdit,
} from "./ardy/motion-edit.js";
import {
	fetchFootageBlob,
	footageSummary,
	isPlatformPageUrl,
	normalizeSourceUrl,
	probeFootage,
	requestBridgeExtract,
	requestBridgeFootage,
	sourceLabel,
	trajectoryReceipt,
} from "./multimodel-ingest.js";
import {
	bakeExtractedTake,
	bakePoseFrame,
	collectLandmarkTrack,
	createPoseDetector,
	decodeImage,
	detectMirrorAveraged,
	sampleTimes,
	videoFrames,
} from "./pose-extract/index.js";
import { applyMotionFrame, captureArdyRoot, restorePlaybackBones, snapshotPlaybackBones } from "./ardy/playback.js";
import { PIN_BLOCKED, planPosePin } from "./ardy/pose-pin.js";
import {
	TRAIL_EFFECTOR_JOINTS,
	applyTrailFalloffDelta,
	jointTrailPoints,
	trailEditRange,
	worldDeltaToClip,
	worldPointToClip,
} from "./motion-trail.js";
import { movePromptClipFrames } from "./ardy/prompt-clips.js";
import Timeline from "./ardy/timeline.jsx";
import { alignArdyPath, judgeAuthoredPath, judgeNextWaypoint } from "./ardy/waypoints.js";
import { FlyControls, aimAt, forwardFrom } from "./controls.jsx";
import { createLiveControl } from "./live-control.js";
import HierarchyPanel from "./hierarchy-panel.jsx";
import { PlanBoard } from "./planview.jsx";
import { autoColorHex, loadAutoColor, saveAutoColor } from "./auto-color.js";
import { DualRender, fitAspect, GIZMO_LAYER } from "./dualview.jsx";
import { GridFloor } from "./grid-floor.jsx";
import { GRID_BACKGROUND, GRID_FOG, readStoredGridView, writeStoredGridView } from "./grid-view.js";
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
	PINNED_CURVE_ENDS,
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
	isLineEditUnsupported,
	nearestCurvePoint,
	projectTrailCurve,
	projectPointC6,
	reprojectCurveWorld,
	drawStrokeEdit,
	unprojectDeltaC6,
	pinsFrameRange,
	upsertPin,
	LINE_EDIT_PINS_MAX,
	validateLineEdit,
} from "./line-edit.js";
import {
	TAKE_VERSIONS_MAX,
	blocksFromRequest,
	freshRecipe,
	pushTakeVersion,
	replayPayload,
	replayTruncated,
	resolveSeed,
	stripSourceMotion,
	withLineEdit,
} from "./take-recipe.js";
import { Room, StageLights } from "./room.jsx";
import {
	SHOT_AUTHORING_KEY,
	SHOT_AUTHORING_LEGACY_KEY,
	SHOT_AUTHORING_LEGACY_KEYS,
	SHOT_AUTHORING_QUARANTINE_KEY,
	createShotAuthoringDocument,
	readShotAuthoringDocument,
	readShotAuthoring,
} from "./shot-authoring.js";
import {
	buildFollowTrack,
	buildRail,
	buildRailFollowTrack,
	craneHeightAt,
	followFramingFromCamera,
	simplifyStroke,
} from "./camera-follow.js";
import { createCameraBlock, removeCameraRail, updateCameraBlock } from "./camera-block.js";
import {
	RAIL_SCHEDULE_LEGACY,
	RAIL_SCHEDULE_RANGE,
	clampRailRange,
	defaultRailRange,
	railFollowForNewGeometry,
	resolveRailSchedule,
} from "./camera-rail-schedule.js";
import { SetProps } from "./props.jsx";
import {
	CUTOUT_DEFAULT_HEIGHT,
	CUTOUT_KIND,
	OBJECT_COLORS,
	OBJECT_LIBRARY,
	createCutoutObject,
	createSceneObject,
	duplicateCutoutOptions,
	dropToSurfacePatch,
	normalizeObjectColor,
	objectSize,
	placementInFront,
	readStoredObjectColors,
	rememberObjectColor,
	removeSceneObject,
	setSceneObjectAttach,
	setSceneObjectParent,
	sceneObjectIdFromHierarchy,
	updateSceneObject,
	writeStoredObjectColors,
} from "./scene-objects.js";
import { createSceneHistoryStore } from "./scene-history.js";
import {
	ASSET_IMAGE_TYPES,
	assetAspect,
	assetGraphSignature,
	assetIdForBytes,
	assetUsageCounts,
	deleteAsset,
	deleteAssetWithGraphGuard,
	getAsset,
	imageFilesFromClipboard,
	importImageFile,
	listAssetIds,
	openAssetDb,
	putAsset,
	referencedAssetIds,
	unreachableAssetIds,
} from "./scene-assets.js";
import { derivedAssetIds, sourceAssetIds } from "./asset-shelf.js";
import { assetRecord, evictAssetTexture, rememberAsset } from "./scene-asset-cache.js";
import { cutOutBackground, decodeMask, maskAsset } from "./matte.js";
import { createMatteEditor } from "./matte-editor.js";
import {
	SCENES_STORAGE_KEY,
	SCENES_VERSION,
	activeSceneIndex,
	addScene,
	createCharacterEntry,
	createCharacterLayer,
	createKeyLight,
	createSceneStage,
	createSceneDocument,
	CHARACTER_MODEL_IDS,
	duplicateScene,
	migrateStageFrames,
	readSceneDocument,
	removeScene,
	renameScene,
	serializeSceneDocument,
	takeAnchor,
} from "./scenes.js";
import {
	clearStoredProjectHandle,
	createProjectDocument,
	createWorkflowGraph,
	downloadProjectFallback,
	hasFileSystemAccess,
	loadStoredProjectHandle,
	openProjectFallback,
	pickProjectFileForOpen,
	pickProjectFileForSave,
	queryHandlePermission,
	requestHandlePermission,
	readProjectDocument,
	loadWorkflowGraph,
	readProjectFile,
	rememberRecentProject,
	loadProjectSession,
	storeProjectSession,
	writeProjectFile,
	storeWorkflowGraph,
	WORKFLOW_STORAGE_KEY,
	normalizeWorkflowGraph,
	PROJECT_EXTENSION,
} from "./project.js";
import ProjectBrowser, { ProjectNameDialog } from "./project-browser.jsx";
import ObjectGizmo from "./object-gizmo.jsx";
import AssetPane from "./asset-pane.jsx";
import AddObjectMenu from "./object-catalog.jsx";
import ResultModal from "./result-modal.jsx";
import AnalyticsToggle from "./analytics-toggle.jsx";
import { PWA_UPDATE_EVENT } from "./pwa.js";
import {
	createObjectPath,
	objectTransformAt,
	pathMetrics,
	strokeToPathPoints,
	MAX_PATH_POINTS,
} from "./object-path.js";
import LocaleToggle from "./locale-toggle.jsx";
import { bucketMs, track, trackActivation } from "./analytics.js";
import { ko, isKo } from "./locale.js";
import {
	DEFAULT_POSE,
	applyHipsOffset,
	applyPose,
	captureHipsOffset,
	capturePose,
	deleteCustomPose,
	loadCustomPoses,
	restoreBindPositions,
	saveCustomPoses,
} from "./poses.js";
import {
	IkHandles,
	PoseHandles,
	PoseStudioPanel,
	PoseThumbPreview,
	PoseTileGrid,
	warmPoseThumbnails,
} from "./posestudio.jsx";
import { mergeProjectCustomPoses } from "./project-poses.js";
import {
	MID_TRACKS,
	createIkState,
	ikBakeKeyframe,
	ikEvaluate,
	ikKeyframes,
	ikRemoveKeyframe,
	ikSeedTargets,
	ikTouch,
	resolveIkRig,
	solveIk,
	solveMidJoint,
	solveSwingAngle,
	solveEffectorSwing,
	solveHipsTranslate,
	solveHipsTranslateToFloor,
	ikPlantFeet,
	ikSolvePlantedFeet,
	applyBodyContact,
	clampIkTargetToFloor,
} from "./ardy/ik.js";
import { buildCollisionCapsules, detectPenetrations, fixCollisions, fixCollisionsRange, supportsCollisionCleanup } from "./ardy/fix-collisions.js";
import { collisionBlockers, blockerSummary } from "./ardy/collision-blockers.js";
import { computeCenterOfMass, markerPositions } from "./ardy/auto-physics.js";
import { reviewAutoPhysics, copyPhysicsKeys, physicsKeyStamp } from "./ardy/physics-review.js";
import { PhysicsPanel, createPhysicsProgress } from "./ardy/physics-panel.jsx";
import {
	Dropdown,
	Field,
	Slider,
	Toast,
	Vector3Row,
} from "./ui.jsx";
import { useRenderActivity } from "./use-render-activity.js";
import SourceOffer from "./source-offer.jsx";
import {
	CAMERA_MOVES,
	CUSTOM_MOVE,
	DEFAULT_SENSOR_FORMAT,
	IMAGE_MODELS,
	SUBJECT_HEIGHT_M,
	composePrompt,
	deriveShot,
	focalMmToFov,
	fovToFocalMm,
	slateLine,
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
import { serializeOtio } from "./otio.js";
import {
	addShotAtFrame,
	cutAtFrame,
	duplicateShot,
	initialShots,
	removeShot,
	renameShot,
	reorderShot,
	resizeShot,
	moveCameraKey,
	removeCameraKey,
	shotAtFrame,
	shotIndexAtFrame,
} from "./cuts.js";
import { createStableItemId, removeStableItem, updateStableItem } from "./stable-items.js";
import {
	ARDY_DURATION_MAX,
	ARDY_DURATION_MIN,
	ARDY_FPS,
	ARDY_PRESERVE_DEFAULT,
	ARDY_PROMPT_HORIZON_FRAMES,
	ARDY_PROMPT_MAX,
	ARDY_SEED_MAX,
	ASSET_DELETE_UNDO_MS,
	ATTACH_BONE_ROWS,
	BRIDGE_RECHECK_MS,
	CHARACTER_MODEL_LABELS,
	CameraGlide,
	CameraRailScenePreview,
	CaptureRig,
	Character,
	ContextLossGuard,
	CraneHandles,
	DEFAULT_CAMERA_POSITION,
	DEFAULT_DURATION_S,
	DEFAULT_ENVIRONMENT,
	DEFAULT_PLAYBACK_SPEED,
	DEFAULT_PROMPT_CLIPS,
	DEFAULT_SUBJECT,
	DEFAULT_SUBJECT2,
	DEFAULT_WORKSPACE_LAYOUT,
	DEMO_MOTION_PROMPT,
	DEMO_MOTION_URL,
	EditorCamSeed,
	FollowCamRig,
	GIZMO_HOTKEYS,
	HIERARCHY_INSPECTOR_TITLES,
	KeyLightPuck,
	LINE_CAPABILITY_RETRY_MS,
	LINE_CURVE_MARKER_STRIDE,
	LINE_CURVE_REFUSALS,
	LINE_EDIT_DEFAULT_TRACK,
	LINE_EDIT_REFUSALS,
	LINE_EDIT_TRACK_OPTIONS,
	LINE_PREVIEW_DEBOUNCE_MS,
	MAX_WAYPOINTS,
	MCP_CAPTURE_H,
	MCP_CAPTURE_W,
	MIN_CURVE_POINTS,
	MULTIMODEL_REASONS,
	MULTIMODEL_SAMPLE_FPS,
	MotionTrails,
	MoveRig,
	OBJECT_DELETE_UNDO_MS,
	ObjectPathHandles,
	POSE_PLACEMENTS,
	PRESETS,
	RIG_HIERARCHY_FOCUS,
	RenderLoopController,
	SHOT_ASPECT_PRESETS,
	ShotCameraGhost,
	ShotLookApplier,
	ShotPathPreview,
	ShotRig,
	TIMELINE_FPS,
	ViewportLayoutInvalidator,
	REST_BONES,
	WORKSPACE_LAYOUT_KEY,
	attachFrameMatrix,
	attachPlacementPatch,
	attachWorldMatrix,
	buildPromptSchedule,
	cameraMoveLabelKo,
	captureMcpFrame,
	characterModelUrl,
	defaultCharacterTint,
	hierarchyIdForIkFocus,
	ikTracksInRange,
	lineTrackLabel,
	loadSceneStartup,
	loadWorkspaceLayout,
	moveSequenceSlateKo,
	nextCharacterId,
	placeSceneObject,
	poseLabelKo,
	posePlacementFrame,
	preserveTracksSummary,
	sceneObjectMatrix,
	sceneObjectNameDisplayKo,
	sceneRendererLabelKo,
	slateLineKo,
	toArdyFrame,
	toArdyFrameEntries,
	toArdySegments,
	useImageDrop,
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
 * A released bone silently keeps its neutral rotation and a low-confidence fit
 * silently loosens every bone, so a photo pose can come out wrong with nothing
 * on screen saying why. Returns "" when there is nothing to warn about — that
 * is the case where the ordinary success toast must survive untouched.
 */
function photoPoseWarning({ releasedBones, confidence }) {
	const groups = [];
	for (const name of releasedBones ?? []) {
		const group = releasedBoneGroup(name);
		if (!groups.includes(group)) groups.push(group);
	}
	const labels = RELEASED_BONE_LABELS
		.filter(([key]) => groups.includes(key))
		.map(([, en, koText]) => (isKo ? koText : en));
	const unsure = Number.isFinite(confidence) && confidence < PHOTO_POSE_LOW_CONFIDENCE;
	if (labels.length === 0) {
		if (!unsure) return "";
		return ko(
			"The photo is unclear, so the pose may be rough — refine it with the handles",
			"사진이 흐릿해서 자세가 부정확할 수 있어요 — 핸들로 다듬어 보세요"
		);
	}
	if (isKo) {
		const list = labels.join("·");
		const blur = unsure ? " — 사진도 흐릿해서 나머지가 부정확할 수 있어요" : "";
		return `사진에서 ${list}${koSubjectParticle(list)} 안 보여서 기본 자세로 남았어요${blur}`;
	}
	const list = labels.length > 1
		? `${labels.slice(0, -1).join(", ")} and ${labels[labels.length - 1]}`
		: labels[0];
	const blur = unsure ? ", and the photo is unclear so the rest may be rough" : "";
	return labels.length > 1
		? `The ${list} weren't visible in the photo — they stayed in the default pose${blur}`
		: `The ${list} wasn't visible in the photo — it stayed in the default pose${blur}`;
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
function poseMemberAtFrame(rig, clip, ikState, frame, blendFrames = 0) {
	if (!rig) return;
	if (clip) {
		const sampled = sampleAt({ frameCount: clip.frames, motion: clip }, null, frame);
		applyMotionFrame(rig, clip, sampled.motionFrame);
	}
	if (ikState && ikState.keys.size > 0 && ikState.chains && ikState.rig === rig) {
		ikEvaluate(ikState.chains, ikState, frame, ikState.fkJoints, clip ? blendFrames : 0);
	}
}

export default function App() {
	// QA-only render counter (same spirit as window.__cozyclay): headless perf
	// probes read renders/second to find re-render storms. Negligible cost.
	if (typeof window !== "undefined") window.__cozyclayRenders = (window.__cozyclayRenders || 0) + 1;
	const craftActionTrackedRef = useRef(false);
	const markCraftAction = (actionKind) => {
		if (craftActionTrackedRef.current) return;
		craftActionTrackedRef.current = true;
		track("craft:first_action", { action_kind: actionKind });
	};
	const [startup] = useState(loadSceneStartup);
	const startupScene = startup.document.scenes[activeSceneIndex(startup.document.scenes, startup.document.activeSceneId)];
	const startupStage = createSceneStage(startupScene.stage);
	const startupCreatedScene = startup.startupCreatedScene === true;
	const [workspaceLayout, setWorkspaceLayout] = useState(loadWorkspaceLayout);
	const [preset, setPreset] = useState("medium");
	const [fovDeg, setFovDeg] = useState(PRESETS.medium.fov);
	const [shotAspectKey, setShotAspectKey] = useState(startupStage.shotAspect);
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
	useEffect(() => {
		writeStoredGridView(globalThis.localStorage, gridView);
	}, [gridView]);
	const [sensorId, setSensorFormat] = useState(startupStage.sensorId ?? DEFAULT_SENSOR_FORMAT);
	// The stage's key light and the in-flight editor-camera glide. Declared
	// this early because the keyboard effect lists them in its dependency
	// array — a later declaration is a temporal-dead-zone crash at mount.
	const [keyLight, setKeyLight] = useState(startupStage.keyLight);
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
	// Unity Scene/Game tabs: PlayView is the framed output only — no editing
	// chrome (gizmo, inset, fly navigation) reaches it.
	const [centerTab, setCenterTab] = useState("scene");
globalThis.playMode = centerTab === "play";
	// PlayView is the player for the finished motion: entering starts playback,
	// leaving pauses it. Scene stays the manipulation surface.
	const [tlPlaying, setTlPlaying] = useState(false);
	const cameraPreviewEndRef = useRef(null);
	// Once the operator touches the viewport, the physical camera stays in
	// their hands. Follow/Rail only take it back through an explicit Preview or
	// timeline Play, avoiding the snap-back that used to happen on pointer-up.
	const manualCameraOverrideRef = useRef(false);
	// Split cameras: the EDITOR camera is the user's own eye and never
	// records; the shot camera keeps the framing. Look-through hands the fly
	// controls the shot camera itself — the pre-split single-view behaviour —
	// for framing by flying.
	const [lookThroughShot, setLookThroughShot] = useState(false);
	useEffect(() => {
		if (!lookThroughShot) return undefined;
		const onKey = (event) => {
			if (event.key === "Escape") setLookThroughShot(false);
		};
		window.addEventListener("keydown", onKey);
		return () => window.removeEventListener("keydown", onKey);
	}, [lookThroughShot]);
	useEffect(() => {
		// The player always starts the finished piece from frame 0; auto-play
		// only exists once there is a motion to play.
		if (centerTab === "play") setTlFrame(0);
		if (centerTab === "play" && motion) setTlPlaying(true);
		if (centerTab === "scene") setTlPlaying(false);
		// eslint-disable-next-line react-hooks/exhaustive-deps
	}, [centerTab]);
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
		// Quota-guarded like persistScenes: a full disk used to throw out of
		// this effect and blank the studio mid-resize (issue #63).
		try {
			localStorage.setItem(WORKSPACE_LAYOUT_KEY, JSON.stringify(workspaceLayout));
		} catch (err) {
			console.warn("[cozyclay] workspace layout not saved:", err?.name ?? err);
		}
	}, [workspaceLayout]);

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

	const workspaceStyle = {
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
		const start = workspaceLayout;
		const onMove = (ev) => {
			const dx = ev.clientX - startX;
			const dy = ev.clientY - startY;
			setWorkspaceLayout((current) => {
				if (kind === "sidebar") {
					return {
						...current,
						sidebarWidth: Math.max(280, Math.min(window.innerWidth * 0.5, start.sidebarWidth - dx)),
					};
				}
				if (kind === "hierarchy") {
					return {
						...current,
						hierarchyWidth: Math.max(220, Math.min(window.innerWidth * 0.4, start.hierarchyWidth + dx)),
					};
				}
				return {
					...current,
					timelineHeight: Math.max(110, Math.min(window.innerHeight * 0.58, start.timelineHeight - dy)),
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
				if (workspaceLayout.insetCollapsed) expandInset();
				else setWorkspaceLayout((current) => ({ ...current, insetCollapsed: true }));
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
	// The cast is ONE list now: every character (position, rig model, pose,
	// subject line) lives in `characters`, and the legacy A/B view of the
	// world is derived below so the rest of the studio keeps working while
	// spawned extras ride the same rails.
	const [characters, setCharacters] = useState(startupStage.characters);
	// The cast as of this render, for async handlers: an extraction that
	// started three renders ago must place its takes against the CURRENT cast,
	// not the one its closure captured.
	const charactersRef = useRef(characters);
	charactersRef.current = characters;
	// Character undo stack lives next to the cast: the store creation below
	// and the undo handlers further down both read these refs.
	const charHistoryRef = useRef({ past: [], future: [] });
	const opClockRef = useRef(0);
	const lastObjectOpRef = useRef(0);
	const suppressObjectClockRef = useRef(false);
	const [customPoses, setCustomPoses] = useState(() => loadCustomPoses());
	const [posing, setPosing] = useState(null);
	const [posingClosing, setPosingClosing] = useState(false);
	const [studioPick, setStudioPick] = useState(null);
	const [rigs, setRigs] = useState({});
	const [rigMountEpoch, setRigMountEpoch] = useState(0);
	const [poseRevision, setPoseTick] = useState(0);

	/* --------------------- derived cast view + shims ---------------------- */

	// Fallback second slot mirrors the old charB defaults so preset math and
	// the two-subject inspector never see a hole before B exists.
	const charA = characters[0] ?? createCharacterEntry(null, 0);
	const charB = characters[1] ?? { ...createCharacterEntry(null, 1), x: 1.15, z: 0.1, rot: -14 };
	const showB = characters.some((entry, index) => index > 0 && !entry.hidden);
	const poseA = charA.pose ?? DEFAULT_POSE;
	const poseB = charB.pose ?? DEFAULT_POSE;
	const subject = charA.subject ?? DEFAULT_SUBJECT;
	const subject2 = charB.subject ?? DEFAULT_SUBJECT2;
	const rigA = rigs[charA.id] ?? null;
	const rigB = (characters[1] ? rigs[charB.id] : null) ?? null;

	function updateCharacterAt(index, next) {
		setCharacters((list) => list.map((entry, i) => {
			if (i !== index) return entry;
			const resolved = typeof next === "function" ? next(entry) : next;
			return { ...entry, ...resolved };
		}));
	}
	// The shims keep the legacy call sites (inspector sliders, presets, pose
	// studio, prompts) untouched while the list stays the source of truth.
	const setCharA = (next) => updateCharacterAt(0, next);
	const setCharB = (next) => updateCharacterAt(1, next);
	const setPoseA = (pose) => updateCharacterAt(0, (entry) => ({ pose: typeof pose === "function" ? pose(entry.pose ?? DEFAULT_POSE) : pose }));
	const setPoseB = (pose) => updateCharacterAt(1, (entry) => ({ pose: typeof pose === "function" ? pose(entry.pose ?? DEFAULT_POSE) : pose }));
	const setSubject = (value) => updateCharacterAt(0, (entry) => ({ subject: typeof value === "function" ? value(entry.subject) : value }));
	const setSubject2 = (value) => updateCharacterAt(1, (entry) => ({ subject: typeof value === "function" ? value(entry.subject) : value }));
	function setShowB(next) {
		recordCharacterUndo();
		setCharacters((list) => {
			const anyVisibleExtra = list.some((entry, i) => i > 0 && !entry.hidden);
			const on = typeof next === "function" ? next(anyVisibleExtra) : next;
			if (on) {
				if (anyVisibleExtra) return list;
				const hiddenIdx = list.findIndex((entry, i) => i > 0 && entry.hidden);
				if (hiddenIdx > 0) return list.map((entry, i) => (i === hiddenIdx ? { ...entry, hidden: false } : entry));
				return [...list, createCharacterEntry({ id: nextCharacterId(list), x: 1.15, z: 0.1, rot: -14, pose: DEFAULT_POSE, subject: DEFAULT_SUBJECT2 }, list.length)];
			}
			return list.map((entry, i) => (i > 0 && !entry.hidden ? { ...entry, hidden: true } : entry));
		});
	}
	function moveCharacter(charId, next) {
		setCharacters((list) => list.map((entry) => {
			if (entry.id !== charId) return entry;
			const resolved = typeof next === "function" ? next(entry) : next;
			return { ...entry, ...resolved };
		}));
	}
	function removeCharacter(charId) {
		const list = charactersRef.current;
		if (list.length <= 1) return;
		recordCharacterUndo();
		const nextCharacters = list.filter((entry) => entry.id !== charId);
		charactersRef.current = nextCharacters;
		setCharacters(nextCharacters);
		// The deleted layer's untrimmed take goes with it: a recycled id must
		// never inherit a stranger's take, and its stature left with the entry.
		motionFullRef.current.delete(charId);
		setRigs((current) => {
			if (!(charId in current)) return current;
			const next = { ...current };
			delete next[charId];
			return next;
		});
	}
	// Per-character rig report: stable callback identity per character so
	// the Character effect does not re-fire on every App render.
	const rigReportersRef = useRef(new Map());
	const rigWaitersRef = useRef(new Map());
	const reportRig = (charId) => {
		if (!rigReportersRef.current.has(charId)) {
			rigReportersRef.current.set(charId, (rig) => {
				setRigs((current) => (current[charId] === rig ? current : { ...current, [charId]: rig }));
				window.__cozyclayMcpRigReady = [...new Set([...(window.__cozyclayMcpRigReady ?? []), charId])];
				window.dispatchEvent(new CustomEvent("cozyclay:mcp-rig-ready", { detail: charId }));
				const waiter = rigWaitersRef.current.get(charId);
				if (waiter) {
					rigWaitersRef.current.delete(charId);
					waiter(rig);
				}
			});
		}
		return rigReportersRef.current.get(charId);
	};

	/* --------------------------- asset dragging ---------------------------- */

	// A grabbed asset card follows the pointer as a DOM ghost; dropping over
	// the shot pane raycasts to the floor and spawns the payload there. The
	// payload is discriminated — {kind:'character'|'object'|'image'} — so one
	// drag seam serves the whole shelf.
	const [assetDrag, setAssetDrag] = useState(null);
	const spawnCharacter = (model, x, z) => {
		recordCharacterUndo();
		const id = nextCharacterId(characters);
		setCharacters((list) => [...list, createCharacterEntry({ id, model, x, z, pose: DEFAULT_POSE, subject: "a person" }, list.length)]);
		setSelectedHierarchyId(`character:${id}`);
		setToast(ko("Character added to the scene", "인물을 씬에 추가했어요"));
	};
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
			// Dispatch on the payload kind: same ray, three spawners. Characters
			// keep their tighter stage clamp (the rig walks, a prop does not);
			// objects and cutouts take the same ROOM_LIMIT clamp their creators
			// already apply.
			if (payload.kind === "character") {
				spawnCharacter(payload.id, THREE.MathUtils.clamp(hit.x, -4, 4), THREE.MathUtils.clamp(hit.z, -4, 4));
			} else if (payload.kind === "object") {
				addSceneObject(payload.objectKind, { x: hit.x, z: hit.z });
			} else if (payload.kind === "image") {
				spawnCutoutAt(payload.assetId, { x: hit.x, z: hit.z });
			}
		};
		window.addEventListener("pointermove", onMove);
		window.addEventListener("pointerup", onUp);
		window.addEventListener("pointercancel", onUp);
	}
	// Viewport picks tag bodies with "A"/"B"/charId and surfaces route the
	// result to a hierarchy row: the first two keep their legacy row ids.
	const charKeyToHierarchyId = (key) => {
		if (key === "A" || key === "a" || key === "char:A") return "characterA";
		if (key === "B" || key === "b" || key === "char:B") return "characterB";
		return `character:${key.startsWith("char:") ? key.slice(5) : key}`;
	};


	/* ------------------------------ IK layer ------------------------------ */
	// IK posing for Subject 1: dragging a wrist/ankle handle FOCUSES that
	// joint and solves its chain backward (two-bone analytic IK) on top of
	// the current pose; joints never dragged stay purely on the FK pose.
	// Keys land on the Full-Body lane as sparse per-chain world targets and
	// evaluate as the playhead moves. State lives in a ref — it changes
	// every drag tick and must not re-render the scene; ikTick re-renders
	// only the timeline markers.
	const [ikMode, setIkMode] = useState(false);
	const [ikChains, setIkChains] = useState(null);
	const [ikFkJoints, setIkFkJoints] = useState(null);
	const [ikFocus, setIkFocus] = useState(null);
	const [selectedHierarchyId, setSelectedHierarchyId] = useState("characterA");
	// The studio is easier to read when the operator chooses a department first.
	// Keep the underlying selection model intact, but use this small workflow
	// state to surface only the tools that belong to the current job.
	const [workflowMode, setWorkflowMode] = useState("scene");
	const [advancedMode, setAdvancedMode] = useState(() => { try { return globalThis.localStorage?.getItem("cozyclay.advanced") === "true"; } catch { return false; } });
	function toggleAdvancedMode() {
		const next = !advancedMode;
		try { globalThis.localStorage?.setItem("cozyclay.advanced", String(next)); } catch {}
		setAdvancedMode(next);
	}
	function selectWorkflowMode(next) {
		setWorkflowMode(next);
		setCenterTab("scene");
		if (next === "camera") setSelectedHierarchyId("camera");
		else if (next === "motion") {
			setSelectedHierarchyId("characters");
			// Selecting Motion should land on its first useful control rather than
			// leaving the operator to hunt through a long inspector column.
			setPromptBlocksReveal((signal) => signal + 1);
		}
		else setSelectedHierarchyId("shot");
	}

	/* ------------------- active character (motion layer) ------------------- */

	// Every character owns an animation layer (root path, prompt blocks,
	// generated clip, IK keys). The studio's motion machinery edits ONE layer
	// at a time — the ACTIVE character's — and selection decides who that is.
	const charIdFromHierarchyId = (hierarchyId) => {
		if (hierarchyId === "characterA") return characters[0]?.id ?? null;
		if (hierarchyId === "characterB") return characters[1]?.id ?? null;
		if (hierarchyId?.startsWith("character:")) return hierarchyId.slice(10);
		return null;
	};
	// State, not a ref: a ref written inside an effect never re-renders, so
	// with an idle app the active character silently stayed behind the row
	// the user just clicked.
	const [activeCharacterId, setActiveCharacterId] = useState(characters[0]?.id ?? null);
	useEffect(() => {
		// A rig node id resolves through its row (#76): selecting any bone
		// activates the body it belongs to, so IK and the timeline buffer
		// follow the character the user is pointing at.
		const id = charIdFromHierarchyId(selectedHierarchyId)
			?? charIdFromHierarchyId(parseRigNodeId(selectedHierarchyId)?.rowId);
		if (id && characters.some((entry) => entry.id === id)) setActiveCharacterId(id);
	}, [selectedHierarchyId, characters]);
	/** The hierarchy row id a cast LIST index owns — mirror of
	 * hierarchy-model's characterRowId, for building namespaced rig ids. */
	const rowIdForCharIndex = (index) => index === 0 ? "characterA" : index === 1 ? "characterB" : characters[index] ? `character:${characters[index].id}` : "characterA";
	const activeChar = characters.find((entry) => entry.id === activeCharacterId) ?? characters[0] ?? charA;
	// Root paths and prompt blocks are the active character's animation layer.
	// With the Inspector driven by selection, showing those tools means putting
	// that character in the hierarchy selection.
	const selectActiveCharacterInHierarchy = () => {
		const id = activeCharacterId ?? characters[0]?.id;
		if (id) setSelectedHierarchyId(`character:${id}`);
	};
	const activeCharIndex = Math.max(0, characters.findIndex((entry) => entry.id === activeChar.id));
	const activeRig = rigs[activeChar.id] ?? null;
	const waitForRig = (charId, timeoutMs = 10000) => {
		const current = rigs[charId];
		if (current) return Promise.resolve(current);
		return new Promise((resolve, reject) => {
			const timer = setTimeout(() => {
				rigWaitersRef.current.delete(charId);
				reject(new Error(ko("The active character's rig is not loaded", "활성 인물의 리그가 로드되지 않았어요")));
			}, timeoutMs);
			rigWaitersRef.current.set(charId, (rig) => {
				clearTimeout(timer);
				resolve(rig);
			});
		});
	};
	// Read-only previews of the other cast members' layers for the timeline,
	// memoized: a fresh array every render would re-render every lane on
	// every playhead tick.
	const ghostLayers = useMemo(() => characters.flatMap((entry, index) => entry.id === activeChar.id || entry.hidden ? [] : [{
		owner: `S${index + 1}`,
		promptClips: entry.layer?.promptClips ?? [],
		waypointFrames: (entry.layer?.waypoints ?? []).map((waypoint) => waypoint.frame),
	}]), [characters, activeChar.id]);

	// Right-sidebar tab. "inspector" shows the selection's properties; "shot"
	// holds shot-global settings (type presets, prompt); "motion" holds the
	// ARDY workflow in pipeline order. Selecting anything in the scene routes
	// to the inspector tab; the root SHOT row routes to the shot tab.
	const [inspectorActionsOpen, setInspectorActionsOpen] = useState(false);
	// Hand-mixed object tints, newest first. An editor preference like the
	// guides above — it belongs to this browser, never to the scene, so it is
	// kept out of the scene document and written straight back to storage.
	const [recentObjectColors, setRecentObjectColors] = useState(() => readStoredObjectColors(globalThis.localStorage));
	// What is being typed into the hex field right now, or null when nobody is
	// typing. Held apart from the record so a half-written "#ff3" survives on
	// screen without ever repainting the prop, and so the field snaps back to
	// the object's real colour the moment the edit ends.
	const [objectColorDraft, setObjectColorDraft] = useState(null);
	function rememberSceneObjectColor(hex) {
		setRecentObjectColors((previous) => {
			const next = rememberObjectColor(previous, hex);
			// rememberObjectColor returns the same array when nothing changed, so a
			// re-pick of the same tint neither writes storage nor re-renders.
			if (next !== previous) writeStoredObjectColors(globalThis.localStorage, next);
			return next;
		});
	}
	const [objectDeleteUndo, setObjectDeleteUndo] = useState(null);
	// An undo offer is an offer, not a banner: without a window it sits on the
	// screen for the rest of the session. Long enough to notice and reach, then
	// gone — the deletion is still reversible through Undo history afterwards.
	useEffect(() => {
		if (!objectDeleteUndo) return undefined;
		const timer = setTimeout(() => setObjectDeleteUndo(null), OBJECT_DELETE_UNDO_MS);
		return () => clearTimeout(timer);
	}, [objectDeleteUndo]);
	// Scene persistence (plan §8): the startup load runs once in a lazy
	// initializer so the store below can seed from the restored scene; the
	// quarantine write and the save-block decision happen before the first
	// render, and the toast/error they produce ride along as initial UI state.
	const [scenes, setScenes] = useState(startup.document.scenes);
	const [activeSceneId, setActiveSceneId] = useState(startup.document.activeSceneId);
	const [sceneObjects, setSceneObjects] = useState(startupScene.objects);
	const [sceneSaveError, setSceneSaveError] = useState(startup.error);
	const saveBlockedRef = useRef(startup.saveBlocked);
	const dirtyRef = useRef(false);
	// One-shot save-failure toast: the persistent line stays for the session,
	// the toast fires once per failure episode (not on every failed tick).
	const saveFailureToastRef = useRef(false);
	// The single mutation owner (plan §5.3): every scene-object edit — gizmo
	// drags, plan-board drags, inspector scrubs, hierarchy atomics — routes
	// through this store so one interaction is exactly one undo entry and an
	// in-flight drag can be cancelled. setSceneObjects is stable, so the
	// store is constructed once, seeded with the initial scene.
	const storeRef = useRef(null);
	if (!storeRef.current) {
		storeRef.current = createSceneHistoryStore(sceneObjects, {
		onObjects: (objects) => {
			// Object-side ops join the shared undo clock here; undo/redo of the
			// object store bumps the clock explicitly in undoScene/redoScene.
			if (!suppressObjectClockRef.current) lastObjectOpRef.current = ++opClockRef.current;
			setSceneObjects(objects);
		},
	});
	}
	const store = storeRef.current;
	const selectedSceneObjectId = sceneObjectIdFromHierarchy(selectedHierarchyId);
	const selectedSceneObject = sceneObjects.find((object) => object.id === selectedSceneObjectId) ?? null;
	// Foot snap (ground plant): while ON, body (hips) drags keep the feet at
	// the positions captured when the drag started — the knees bend instead
	// of the feet sinking through the floor. Toggleable in the timeline.
	const [footSnap, setFootSnap] = useState(true);
	const [bodyContact, setBodyContact] = useState(true);
	const ikBodyDragRef = useRef(false); // true while a body drag is active
	// How far (in frames) a correction eases back to the underlying motion
	// outside its keyed range. 6 frames @ 24 fps = 0.25 s — long enough to
	// hide the seam, short enough that a mid-clip fix stays visibly local.
	const IK_CORRECTION_BLEND_FRAMES = 6;

	const ikStateRef = useRef(createIkState());
	const autoPhysicsRunRef = useRef(null);
	const [autoPhysicsRunning, setAutoPhysicsRunning] = useState(false);
	const [physicsPreview, setPhysicsPreview] = useState(null);
	const [physicsShow, setPhysicsShow] = useState(true);
	const [physicsProgress] = useState(createPhysicsProgress);
	const setPhysicsProgress = physicsProgress.set;
	const [physicsOptions, setPhysicsOptions] = useState({ overrides: [], protectedFrames: [], strength: 1 });
	const physicsJobRef = useRef(0);
	const physicsSourceCacheRef = useRef({ value: null });
	const [ikTick, setIkTick] = useState(0);
	const [committedIkEdits, setCommittedIkEdits] = useState([]);
	// Sorted full-body key frames for the timeline markers. Derived from the
	// ref state; ikTick re-derives after every key add/remove.
	const ikFrames = useMemo(() => ikKeyframes(ikStateRef.current),
		// eslint-disable-next-line react-hooks/exhaustive-deps
		[ikTick]);

	/* --------------------- IK-mode motion trail editing ---------------------
	 * Grabbing the viewport trajectory line deforms the loaded take with a
	 * smoothstep falloff around the grab frame (pure local preview). The last
	 * finished drag stays pending so "Regenerate from trail edit" can send the
	 * auto-derived window through the existing motionEdit pipeline. */
	const [trailFalloffS, setTrailFalloffS] = useState(0.5);
	const [showTrails, setShowTrails] = useState(true);
	const [ikEditTool, setIkEditTool] = useState("ik");
	const [trailEdit, setTrailEdit] = useState(null); // {track, grabFrame, radiusFrames, clipDelta}
	const trailBaseMotionRef = useRef(null);
	const trailPreviewMotionRef = useRef(null);
	const trailFalloffFrames = Math.max(1, Math.round(trailFalloffS * TIMELINE_FPS));

	function selectHierarchy(id) {
		// A selection switch is the user starting something else: settle any open
		// drag so its applied travel becomes one committed entry first (plan §6.3).
		// This MUST stay inside the handler, never in the render body: a settle
		// during render runs the producer's cancel teardown, and since the first
		// applied tick re-renders, every drag would die after exactly one tick.
		// Resolve the live store at event time: opening a scene replaces the
		// coordinator in storeRef before the next hierarchy click, while a
		// render-captured store can still settle the scene that was left.
		storeRef.current.settle();
		setSelectedHierarchyId(id);
		// Moving the focus anywhere but the camera releases the crane dot too:
		// a press on the floor or the sky must not leave a mark selected.
		if (id !== "camera") setCraneSelectedIndex(null);
		const focus = RIG_HIERARCHY_FOCUS[parseRigNodeId(id)?.token];
		if (focus && ikMode) setIkFocus(focus);
	}
	// Producer drag lifecycle (plan §6.1): begin issues a token the producer
	// presents on every apply and on close; end commits the drag as one
	// history entry, or rolls it back when commit is false (Escape).
	function beginSceneTransaction({ owner, cancel }) {
		return store.begin(owner, cancel);
	}

	function endSceneTransaction(token, { commit }) {
		store.end(token, { commit });
	}

	function focusIkHandle(focus) {
		setIkFocus(focus);
		const hierarchyId = hierarchyIdForIkFocus(focus, rowIdForCharIndex(activeCharIndex));
		if (hierarchyId) {
			setSelectedHierarchyId(hierarchyId);
		}
	}

	// App's single scene-object mutation entry (plan §6.1). A token means a
	// producer drag stream: apply inside the open transaction so the change
	// lands in the live array without its own history entry. No token is an
	// atomic edit — one entry. updateSceneObject returns the same array when
	// nothing changed, so a no-op can never create an entry.
	function changeSceneObject(id, patch, token) {
		const apply = (objects) => updateSceneObject(objects, id, patch);
		if (token != null) store.applyIn(token, apply);
		else store.applyAtomic(apply);
	}

	function deleteSelectedSceneObject() {
		deleteSceneObject(selectedSceneObjectId);
	}

	/** Delete by id — the hierarchy context menu's Delete. Unlike the
	 * selection-based path above, removing a row that is not the selection
	 * must leave the selection alone. */
	function deleteSceneObject(id) {
		if (!id) return;
		const wasSelected = id === selectedSceneObjectId;
		store.applyAtomic((objects) => removeSceneObject(objects, id));
		setObjectDeleteUndo({ id, pastDepth: store.depths().past });
		setInspectorActionsOpen(false);
		if (wasSelected) {
			setSelectedHierarchyId("props");
		}
	}
	/** Drop-to-surface (plan §9.2/§9.3): End, no modifier. Strict drop-down —
	 * the selection falls until its base touches the highest support top at or
	 * below it, or the floor. dropToSurfacePatch is pure and returns null when
	 * already resting, so a redundant press never creates a history entry, and
	 * x/z are never written. One applyAtomic = one undo entry. */
	function dropSelectedSceneObject() {
		const object = sceneObjects.find((item) => item.id === selectedSceneObjectId) ?? null;
		if (!object) return;
		const patch = dropToSurfacePatch(object, sceneObjects.filter((item) => item.id !== object.id));
		if (patch === null) {
			setToast(ko("Nothing to drop", "내려놓을 대상이 없어요"));
			return;
		}
		changeSceneObject(object.id, patch);
		setToast(isKo ? `${sceneObjectNameDisplayKo(object.name)}을 표면 위에 내려놓았어요` : `${object.name} dropped to surface`);
	}

	/** The hidden file input behind "Import image as cutout". */
	const cutoutInputRef = useRef(null);
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

	const rejectImageDrop = (count) => setToast(ko(
		`${count} file${count > 1 ? "s" : ""} not supported — use PNG, JPG, WebP or GIF (iPhone HEIC photos need converting first)`,
		`지원하지 않는 파일 ${count}개 — PNG, JPG, WebP, GIF만 가능해요 (아이폰 HEIC 사진은 먼저 변환해 주세요)`,
	));
	const propsDrop = useImageDrop((files) => importCutouts(files), rejectImageDrop);
	const inspectorDrop = useImageDrop((files) => importCutouts(files), rejectImageDrop);
	const viewportDrop = useImageDrop((files) => importCutouts(files));
	// How much of the wall counts as the wall, and how wide the brush that
	// argues with the answer is.
	const [matteTolerance, setMatteTolerance] = useState(0.18);
	const [matteBrush, setMatteBrush] = useState(18);
	// Edge cleanup for the cut: shrink eats the blended rim, feather softens
	// what is left. Both ride into applyMask; the defaults match applyMask's.
	const [matteShrink, setMatteShrink] = useState(1);
	const [matteFeather, setMatteFeather] = useState(1);
	const [matteMode, setMatteMode] = useState("paint");
	const [matteStats, setMatteStats] = useState({ painted: 0, coverage: 0, zoom: 1, canUndo: false, canRedo: false });
	const [matteBusy, setMatteBusy] = useState(false);
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
	const [gizmoMode, setGizmoMode] = useState("move");
	// Snap is a preference, not a law: with it on the gizmo blocks on the plan
	// board's grid, and Ctrl/Cmd during a drag gives a free one. Off, it is the
	// other way round. (docs/unity-reference.md §9.5)
	const [snapEnabled, setSnapEnabled] = useState(true);
	// True while the right mouse button is flying the camera. Tool hotkeys stand
	// down during a flythrough, because W/A/S/D belong to the camera then.
	const flyingRef = useRef(false);

	/** `at` overrides the floor point: the Assets-shelf drop already knows
	 * where the pointer hit, everyone else gets in-front-of-camera. */
	function addSceneObject(kind, at) {
		const camera = (lookThroughShot ? shotCamRef : editorCamRef).current;
		const paneYaw = (lookThroughShot ? look : editorLook).current.yaw;
		const placement = at ?? (camera
			? placementInFront({ x: camera.position.x, z: camera.position.z }, paneYaw)
			: {});
		const object = createSceneObject(kind, sceneObjects, placement);
		if (!object) return;
		store.applyAtomic((objects) => [...objects, object]);
		markCraftAction("object");
		setSelectedHierarchyId(`object:${object.id}`);
		// Deliberate divergence from Unity's rename-on-create: creating an object
		// here is followed by placing it, and dropping focus into a text field
		// swallows the very next W/E/R. Renaming stays on F2/Return and the row's
		// context menu. (docs/unity-reference.md §9.7)
		setGizmoMode("move");
		setToast(isKo ? `${sceneObjectNameDisplayKo(object.name)} 추가됨 — W 이동, E 회전, R 크기` : `${object.name} added — W move, E rotate, R scale`);
	}

	/** "Sofa 2.png" reads as a set piece; "sofa-2.png" does not. The extension
	 * goes, the rest is the user's own name for the thing. */
	function cutoutNameFromFile(fileName) {
		const base = String(fileName ?? "").replace(/\.[^.]+$/, "").trim();
		return base || ko("Cutout", "컷아웃");
	}

	/**
	 * Import one image and stand it up in the set. The card arrives at the
	 * figure's own height, because a standee whose scale is a guess is worse
	 * than useless in a tool where every camera level is a height in metres —
	 * 1.8 m is at least an honest starting point to correct from.
	 */
	async function importCutout(file) {
		if (!file) return;
		try {
			const asset = await rememberAsset(await importImageFile(file));
			const camera = (lookThroughShot ? shotCamRef : editorCamRef).current;
			const placement = camera
				? placementInFront({ x: camera.position.x, z: camera.position.z }, (lookThroughShot ? look : editorLook).current.yaw)
				: {};
			const object = createCutoutObject(
				{ assetId: asset.id, aspect: assetAspect(asset) ?? 1, height: CUTOUT_DEFAULT_HEIGHT, name: cutoutNameFromFile(asset.name) },
				sceneObjects,
				placement,
			);
			if (!object) return;
			store.applyAtomic((objects) => [...objects, object]);
			setSelectedHierarchyId(`object:${object.id}`);
			setGizmoMode("move");
			setToast(
				isKo
					? `${object.name} 추가됨 — 실제 높이(m)를 입력하면 크기가 맞습니다`
					: `${object.name} added — type its real height in metres to set the scale`,
			);
		} catch (error) {
			setToast(isKo ? `이미지를 가져오지 못했어요 — ${error.message}` : `Could not import that image — ${error.message}`);
		}
	}

	/** A drop can carry several pictures. They go in one at a time so each
	 * lands in its own place and the last one is the one left selected. */
	async function importCutouts(files) {
		for (const file of files) await importCutout(file);
	}

	/**
	 * Stand an ALREADY-STORED picture up as a fresh cutout — the Assets-shelf
	 * drop. The bytes are content-addressed and in the store, so this is
	 * `importCutout` without the import: read the record for its true aspect
	 * and name, mint the card, one atomic history entry.
	 */
	async function spawnCutoutAt(assetId, placement) {
		markCraftAction("cutout");
		const record = await assetRecord(assetId);
		if (!record) {
			setToast(ko("That image is no longer stored", "그 이미지는 더 이상 저장되어 있지 않아요"));
			return;
		}
		const object = createCutoutObject(
			{ assetId: record.id, aspect: assetAspect(record) ?? 1, height: CUTOUT_DEFAULT_HEIGHT, name: cutoutNameFromFile(record.name) },
			sceneObjects,
			placement,
		);
		if (!object) return;
		store.applyAtomic((objects) => [...objects, object]);
		setSelectedHierarchyId(`object:${object.id}`);
		setGizmoMode("move");
		setToast(
			isKo
				? `${object.name} 추가됨 — 실제 높이(m)를 입력하면 크기가 맞습니다`
				: `${object.name} added — type its real height in metres to set the scale`,
		);
	}

	/**
	 * Apply what the background editor is showing.
	 *
	 * Nothing is destroyed. The card keeps three things: the photograph it was
	 * imported from, the purple someone painted on it, and the cut picture the
	 * set actually renders — so the next edit starts from the original with the
	 * selection still on it, however many times it is re-cut.
	 *
	 * Trimming the dead margin changes how much of the frame the subject fills,
	 * so the card's height is scaled with it. The scale is stored rather than
	 * multiplied in, or a second cut would compound one trim onto the last.
	 */
	async function applyMatte(id = selectedSceneObjectId) {
		const object = sceneObjects.find((item) => item.id === id) ?? null;
		const options = matteEditorRef.current?.options();
		// Nothing purple means nothing was asked for. Removing "the background"
		// on a picture nobody has marked would be a guess applied to their set.
		if (!object || object.renderer !== CUTOUT_KIND || !options || matteBusy) return;
		setMatteBusy(true);
		try {
			const sourceId = object.sourceAssetId || object.assetId;
			const source = await assetRecord(sourceId);
			if (!source) throw new Error(ko("its picture is missing from the store", "저장소에 사진이 없습니다"));
			const [cut, matte] = await Promise.all([
				cutOutBackground(source, { mask: options.mask, shrink: matteShrink, feather: matteFeather }),
				maskAsset(options.mask, { width: options.maskWidth, height: options.maskHeight, name: `${source.name || "cutout"} matte` }),
			]);
			await Promise.all([
				rememberAsset({ ...cut.asset, role: "derived" }),
				rememberAsset({ ...matte, role: "derived" }),
			]);
			const fullFrameHeight = object.height / (object.matteScale || 1);
			changeSceneObject(object.id, {
				assetId: cut.asset.id,
				sourceAssetId: source.id,
				matteAssetId: matte.id,
				matteScale: cut.heightScale,
				aspect: cut.asset.width / cut.asset.height,
				height: fullFrameHeight * cut.heightScale,
			});
			setToast(
				isKo
					? `${object.name} 배경 제거 — ${Math.round(cut.removed * 100)}% 지움. 원본과 칠한 영역은 그대로 남습니다`
					: `${object.name} — ${Math.round(cut.removed * 100)}% removed. The original and your selection are kept`,
			);
		} catch (error) {
			setToast(isKo ? `배경을 제거하지 못했어요 — ${error.message}` : `Could not remove the background — ${error.message}`);
		} finally {
			setMatteBusy(false);
		}
	}

	function duplicateSelectedSceneObject(id = selectedSceneObjectId) {
		// Defaults to the selection (Ctrl/Cmd+D); the hierarchy context menu
		// passes a specific row's id. Same result either way: the copy is
		// selected, offset one grid step, and toasted.
		const object = sceneObjects.find((item) => item.id === id) ?? null;
		if (!object) return;
		const placement = { x: object.x, z: object.z, rot: object.rot };
		// A cutout cannot be minted from the catalogue — it needs the picture the
		// original is already wearing — so the copy is created through its own
		// door and shares the asset rather than importing it twice.
		const copy = object.renderer === CUTOUT_KIND
			? createCutoutObject(duplicateCutoutOptions(object), sceneObjects, placement)
			: createSceneObject(object.renderer, sceneObjects, placement);
		if (!copy) return;
		// Unity drops the duplicate exactly on top of the original; for blocking,
		// one grid step to the side means you can see that it worked.
		const placed = { ...object, id: copy.id, name: copy.name, x: object.x + 0.5 };
		store.applyAtomic((objects) => [...objects, placed]);
		setSelectedHierarchyId(`object:${placed.id}`);
		setToast(isKo ? `${sceneObjectNameDisplayKo(placed.name)} 복제됨` : `${placed.name} duplicated`);
	}

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
	function frameSelection(id = selectedSceneObjectId) {
		const object = sceneObjects.find((item) => item.id === id) ?? null;
		if (!object) return;
		const size = objectSize(object);
		frameWorldTarget(
			{ x: object.x, y: (object.y ?? 0) + size.height / 2, z: object.z },
			Math.max(size.width, size.height, size.depth, 0.5),
		);
	}

	/** In-place rename commit from the hierarchy (F2 / Return / rename on
	 * create). The row label lives in the tree; the object name is shared
	 * state, so this is just the inspector's rename through another door. */
	function renameSceneObject(id, name) {
		changeSceneObject(id, { name });
	}
	// Undo/redo (plan §6.5). The store settles any open drag first, so a
	// mid-drag press commits that drag as one entry and then steps past it.
	// After a step the selection can point at a deleted object — drop it to
	/* ---------------------- character undo stack ---------------------------
	 * The scene history store owns scene OBJECTS; the cast lives outside it.
	 * Character gestures (spawn, remove, show/hide, plan-board drags) push a
	 * full-cast snapshot with the editing buffer folded in, and undo/redo
	 * picks the newer of the two stacks so one Ctrl+Z history covers both. */
	const snapshotCast = (includeShots = false) => ({
		// The key light rides the same undo stack as everything else — its
		// absence used to make Ctrl+Z after a light edit undo an unrelated
		// earlier action while the light stayed put (research claim C1).
		keyLight: { ...keyLight },
		characters: charactersRef.current.map((entry) => ({
			...entry,
			layer: entry.id === activeChar.id
				? { waypoints: bufferRef.current.waypoints, promptClips: bufferRef.current.promptClips }
				: entry.layer,
		})),
		bufferMotion: bufferRef.current.motion,
		bufferCharId: loadedLayerCharRef.current,
		// The ACTIVE character's authored IK layer. Only the keys (deep-copied so
		// undo can never hand back live quaternions) and the committed-edit list
		// travel: targets/plants/tracked are transient solver state the next
		// seed/drag rebuilds anyway.
		ikKeys: snapshotIkKeys(ikStateRef.current),
		committedIkEdits,
		// Shot-op entries carry the shot list too; character-op entries leave it
		// out so undoing a character move never rolls back unrecorded shot edits.
		...(includeShots ? { shots } : {}),
	});
	/** Deep copy of an IK state's key map: frame → Map(trackId → {q,p}), with
	 * every quaternion/position cloned so a snapshot never shares references
	 * with the live rig state (a later bake would otherwise rewrite history). */
	function snapshotIkKeys(ikState) {
		return copyPhysicsKeys(ikState?.keys ?? new Map());
	}
	function recordCharacterUndo() {
		charHistoryRef.current.past.push({ tick: ++opClockRef.current, snapshot: snapshotCast() });
		charHistoryRef.current.future = [];
	}
	/** One Ctrl+Z entry for a structural shot edit (delete, split, duplicate,
	 * add, reorder): the same history as the cast, with the shot list aboard. */
	function recordShotUndo() {
		charHistoryRef.current.past.push({ tick: ++opClockRef.current, snapshot: snapshotCast(true) });
		charHistoryRef.current.future = [];
	}
	/** One Ctrl+Z entry per EDITING SESSION rather than per event, for the
	 * streams that fire continuously: per-keystroke text and per-pointermove
	 * camera framing. The session is open while the entry it pushed is still
	 * the newest one on the stack and the key (clip id, gesture name) has not
	 * changed; any other edit, undo or redo in between closes it, so the next
	 * keystroke or drag opens a fresh entry. `sessionRef` is a plain ref of
	 * `{ key, tick }`. */
	function recordSessionUndo(sessionRef, key, record = recordCharacterUndo) {
		const past = charHistoryRef.current.past;
		const open = sessionRef.current
			&& sessionRef.current.key === key
			&& past[past.length - 1]?.tick === sessionRef.current.tick;
		if (open) return;
		record();
		sessionRef.current = { key, tick: past[past.length - 1].tick };
	}
	// Prompt-block text (inspector field AND the timeline chip both land in
	// changePromptClip) and viewport/plan camera framing are the two streams
	// that would otherwise push an entry per keystroke / per pointermove.
	const promptTextSessionRef = useRef(null);
	const framingSessionRef = useRef(null);
	// A colour picker streams values for as long as its dialog is open.
	const tintSessionRef = useRef(null);
	/** True while a framing capture for `shotId` is the newest history entry. */
	function framingSessionOpen(shotId) {
		const past = charHistoryRef.current.past;
		return Boolean(framingSessionRef.current)
			&& framingSessionRef.current.key === `framing:${shotId}`
			&& past[past.length - 1]?.tick === framingSessionRef.current.tick;
	}
	function restoreCast(snapshot) {
		// Captured BEFORE the buffer pointer moves: whose IK state the live ref
		// currently holds.
		const loadedIk = loadedLayerCharRef.current;
		if (snapshot.shots) setShots(snapshot.shots);
		setCharacters(snapshot.characters);
		const bufferChar = snapshot.characters.find((entry) => entry.id === snapshot.bufferCharId) ?? snapshot.characters[0];
		setWaypoints((bufferChar?.layer?.waypoints ?? []).map((waypoint) => ({ ...waypoint })));
		setPromptClips((bufferChar?.layer?.promptClips ?? []).map((clip) => ({ ...clip })));
		setMotion(snapshot.bufferMotion);
		loadedLayerCharRef.current = bufferChar?.id ?? null;
		setActiveCharacterId(bufferChar?.id ?? null);
		// IK keys go back onto the snapshot owner's layer state (again deep-copied,
		// so stepping through the same entry twice cannot alias what the rig is now
		// mutating) and the tick bumps so markers and the keyed pose re-derive.
		if (snapshot.ikKeys) {
			// The keys belong to the snapshot's buffer character. When that
			// character has no stored layer state yet, it gets a fresh one —
			// falling back to the live ref would hand the keys to whoever is
			// active NOW, cross-wiring two characters' corrections (#77).
			let target;
			if (bufferChar?.id === loadedIk) {
				target = ikStateRef.current;
			} else {
				target = ikStatesRef.current.get(bufferChar?.id);
				if (!target) {
					target = createIkState();
					if (bufferChar?.id) ikStatesRef.current.set(bufferChar.id, target);
				}
			}
			target.keys = snapshotIkKeys({ keys: snapshot.ikKeys });
			target.tracked = new Set([...target.keys.values()].flatMap((entry) => [...entry.keys()]));
			setCommittedIkEdits(snapshot.committedIkEdits ?? []);
			setIkTick((value) => value + 1);
		}
		if (snapshot.keyLight) setKeyLight(createKeyLight(snapshot.keyLight));
	}

	// props so the inspector cannot show a ghost.
	function undoScene() {
		const charTop = charHistoryRef.current.past[charHistoryRef.current.past.length - 1];
		if (charTop && charTop.tick > lastObjectOpRef.current) {
			charHistoryRef.current.future.push({ tick: charTop.tick, snapshot: snapshotCast(Boolean(charTop.snapshot.shots)) });
			charHistoryRef.current.past.pop();
			restoreCast(charTop.snapshot);
			setToast(ko("Undone", "실행 취소됨"));
			return;
		}
		suppressObjectClockRef.current = true;
		const restored = store.undo();
		suppressObjectClockRef.current = false;
		if (restored === null) {
			setToast(ko("Nothing to undo", "실행 취소할 작업이 없어요"));
			return;
		}
		lastObjectOpRef.current = ++opClockRef.current;
		if (objectDeleteUndo?.id && restored.some((object) => object.id === objectDeleteUndo.id)) {
			setSelectedHierarchyId(`object:${objectDeleteUndo.id}`);
			setObjectDeleteUndo(null);
		} else if (selectedSceneObjectId && !restored.some((object) => object.id === selectedSceneObjectId)) {
			setSelectedHierarchyId("props");
		}
		setToast(ko("Undone", "실행 취소됨"));
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

	function redoScene() {
		const charTop = charHistoryRef.current.future[charHistoryRef.current.future.length - 1];
		if (charTop && charTop.tick > lastObjectOpRef.current) {
			charHistoryRef.current.past.push({ tick: charTop.tick, snapshot: snapshotCast(Boolean(charTop.snapshot.shots)) });
			charHistoryRef.current.future.pop();
			restoreCast(charTop.snapshot);
			setToast(ko("Redone", "다시 실행됨"));
			return;
		}
		suppressObjectClockRef.current = true;
		const restored = store.redo();
		suppressObjectClockRef.current = false;
		if (restored === null) {
			setToast(ko("Nothing to redo", "다시 실행할 작업이 없어요"));
			return;
		}
		lastObjectOpRef.current = ++opClockRef.current;
		if (selectedSceneObjectId && !restored.some((object) => object.id === selectedSceneObjectId)) {
			setSelectedHierarchyId("props");
		}
		setToast(ko("Redone", "다시 실행됨"));
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
				duplicateSelectedSceneObject();
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
	const [cameraMove, setCameraMove] = useState(CAMERA_MOVES[1]);
	const [customMove, setCustomMove] = useState("");
	// Authored shot state (camera keys, waypoints, clip length) restored from
	// the last session — camera moves must survive a reload like the scene does.
	const [shotStartup] = useState(() => {
		try {
			const currentRaw = localStorage.getItem(SHOT_AUTHORING_KEY);
			let sourceKey = SHOT_AUTHORING_KEY;
			let raw = currentRaw;
			let loaded = readShotAuthoring(raw);
			for (const legacyKey of SHOT_AUTHORING_LEGACY_KEYS ?? [SHOT_AUTHORING_LEGACY_KEY]) {
				if (loaded.status !== "absent") break;
				sourceKey = legacyKey;
				raw = localStorage.getItem(sourceKey);
				loaded = readShotAuthoring(raw);
			}
			if (loaded.status === "corrupt") {
				// Preserve the unreadable roll byte-for-byte before a fresh v3 save.
				localStorage.setItem(SHOT_AUTHORING_QUARANTINE_KEY, raw);
				localStorage.removeItem(sourceKey);
				return { state: null, saveBlocked: false };
			}
			// A future body belongs to a future build. Do not replace it merely
			// because this build cannot project it onto today's controls.
			if (loaded.status === "future") return { state: null, saveBlocked: true };
			return { state: loaded.state, saveBlocked: false };
		} catch {
			return { state: null, saveBlocked: false };
		}
	});
	const nestedShotStartup = readShotAuthoringDocument(startupScene.shotDocument ?? undefined);
	// The nested Scene document wins. The root v3 key remains a migration
	// fallback for users arriving from the single-scene build.
	const startupShotState = nestedShotStartup.state ?? shotStartup.state;
	// Each editorial strip owns its camera keys. The playhead chooses the
	// active strip; there is no shared key list that could blend through a cut.
	const [shots, setShots] = useState(() => startupShotState?.shots ?? initialShots(startupShotState?.frameCount ?? DEFAULT_DURATION_S * TIMELINE_FPS));
	const [movePlaying, setMovePlaying] = useState(false);
	// Follow slaves the move to the timeline playhead so camera and character
	// motion share one time axis; off frees the camera while both stay set.
	const [moveFollow, setMoveFollow] = useState(true);
	const [railDraw, setRailDraw] = useState(false);
	// Object travel-path drawing: the same Top-View stroke gesture as the rail,
	// aimed at the selected object instead of the shot camera.
	const [pathDraw, setPathDraw] = useState(false);
	const [pathPointIndex, setPathPointIndex] = useState(null);
	const pathDragTokenRef = useRef(null);
	const planPathTokenRef = useRef(null);
	const timingTokenRef = useRef(null);
	// The frame props follow. Live playback keeps it at the playhead; the
	// offscreen export drives it per captured frame without re-rendering.
	const propFrameRef = useRef(0);
	/* Objects with a travel path stand where their path puts them at the
	 * playhead. Authoring still edits the RECORD (the path and its start
	 * pose); this derived list is what the scene, the plan board and the
	 * export all draw, so preview and recording can never disagree. */
	// Which crane height mark the scene dots have selected; the timeline's
	// Point height input edits this one. Reset lives after activeCamera below.
	const [craneSelectedIndex, setCraneSelectedIndex] = useState(null);
	const [hasCharSheet, setHasCharSheet] = useState(startupStage.hasCharSheet);
	const [hasEnvSheet, setHasEnvSheet] = useState(false);
	const [environment, setEnvironment] = useState(DEFAULT_ENVIRONMENT);
	const [style, setStyle] = useState("moody cinematic lighting, 35mm film look");

	const [cameraPos, setCameraPos] = useState(DEFAULT_CAMERA_POSITION);
	const [subjectVisible, setSubjectVisible] = useState(true);
	const mcpCaptureRef = useRef(null);
	const liveControlRef = useRef(null);
	const liveStateRef = useRef(null);
	const liveHandlersRef = useRef(null);
	const [liveWorkspaceHandle, setLiveWorkspaceHandle] = useState(null);
	const liveWorkspaceIdRef = useRef(crypto.randomUUID());
	const [result, setResult] = useState(null);
	const [resultOpen, setResultOpen] = useState(false);
	const [copied, setCopied] = useState(false);
	const [recordedVideoName, setRecordedVideoName] = useState(null);
	const [toast, setToast] = useState(startup.toast ?? "");
	// The PWA's "a newer studio is waiting" registration, once one arrives.
	const [pwaUpdate, setPwaUpdate] = useState(null);
	useEffect(() => {
		const onUpdate = (event) => setPwaUpdate(event.detail ?? null);
		window.addEventListener(PWA_UPDATE_EVENT, onUpdate);
		return () => window.removeEventListener(PWA_UPDATE_EVENT, onUpdate);
	}, []);
	const [glContextLost, setGlContextLost] = useState(false);
	const [bridge, setBridge] = useState(null);
	const [ardyPrompt, setArdyPrompt] = useState("");
	const [ardyDuration, setArdyDuration] = useState(4); // default clip length in seconds; aligned with the recommended 3-5 s block range
	// Optional native-ARDY seed: empty string = omit from the request (the
	// box picks a fresh random one each run); otherwise a plain integer in
	// 0..2**31-1 to reproduce a result.
	const [ardySeed, setArdySeed] = useState("");
	// How much of the loaded take a regeneration keeps (scheduled inpainting).
	// 1 = hold the take everywhere the user did not edit, 0 = ignore it and
	// generate fresh. Only ever consulted when the take still has a bridge
	// source to preserve FROM, so the control renders with the take, not with
	// the panel.
	const [preserveStrength, setPreserveStrength] = useState(ARDY_PRESERVE_DEFAULT);
	// Off by default on purpose: pinning runs the box's pose mode, which builds
	// on a fixed reference base, so it is a choice the operator makes when they
	// actually want the pose in the generated clip.
	const [ardyStartFromPose, setArdyStartFromPose] = useState(false);
	// WHERE the pose lands in the clip. "start" leaves from it, "end" arrives at
	// it, "middle" passes through it, "playhead" places it on the frame the
	// operator scrubbed to — the box takes any destination frame.
	const [ardyPosePlacement, setArdyPosePlacement] = useState("start");
	// Bumped when something outside the Inspector needs the Prompt Blocks panel
	// on screen — selecting or adding a block on the timeline.
	const [promptBlocksReveal, setPromptBlocksReveal] = useState(0);
	const revealPromptBlocks = () => setPromptBlocksReveal((n) => n + 1);
	/* ------------------- take recipes and versions (C9/C12) -------------------
	 * The recipe of the take that is loaded RIGHT NOW: seed + prompt blocks +
	 * the line edits pulled on top of it. It is written in exactly one place
	 * (commitTakeRecipe, on a successful run) and read in two: the request
	 * assembly, which attaches it as C10 `replay`, and the version strip, which
	 * stores a copy beside every motionUrl so clicking v1 restores v1's recipe
	 * and not the one the artist has since edited into existence.
	 * The ref shadows the state because the recipe is consulted from inside an
	 * async job completion, where a stale closure would silently record the
	 * previous take's edits against this take's url. */
	const [takeRecipe, setTakeRecipe] = useState(null);
	const takeRecipeRef = useRef(null);
	const [takeVersions, setTakeVersions] = useState([]);
	// Which C10 replay entries came back failed or boundary-warned. Non-blocking
	// by contract: the take generated, one refinement may not have survived it,
	// and that is worth a line next to the take rather than a toast that scrolls
	// away before the artist has looked at the result.
	const [replayNotices, setReplayNotices] = useState([]);
	// Whether the Scene entry's action menu is open. The Refine entry needs no
	// equivalent — it IS its action.
	const [sceneMenuOpen, setSceneMenuOpen] = useState(false);
	const [ardyRunning, setArdyRunning] = useState(false);
	const [ardyStatus, setArdyStatus] = useState("");
	const [bottomTab, setBottomTab] = useState("timeline");
	// The imported-pictures region of the Assets shelf. null = the scan has
	// never resolved (the pane shows skeletons, NEVER the empty message); an
	// array = the SOURCE ids to show, mattes and cut renders already filtered
	// out (asset-shelf.js). Scans run only while the shelf is visible, and
	// re-run when a cutout's lineage changes — not on every transform tick, so
	// a gizmo drag never hammers IndexedDB.
	const [shelfImageIds, setShelfImageIds] = useState(null);
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
			setShelfImageIds(sourceAssetIds(stored, allScenes, derivedIds));
			setUnusedAssetIds(unreachableAssetIds(stored, allScenes));
			setUsedAssetIds(latestUsedAssetIds);
			setUsageCounts(latestUsageCounts);
		} catch {
			// No IndexedDB means no imports can exist either; both honest views are
			// empty rather than presenting an unverifiable deletion target.
			if (current()) {
				setShelfImageIds([]);
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
	}, [bottomTab, scenes, activeSceneId, cutoutLineage]);

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
			await rememberAsset(record);
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
	// Keep the latest ARDY status inline with the Prompt Blocks controls. The
	// former bottom Console history was removed because it duplicated this state
	// and exposed an editor surface that is not part of the production workflow.
	function reportArdyStatus(line) {
		setArdyStatus(line);
	}
	const [ardyReport, setArdyReport] = useState(null);
	const [ardyOutcome, setArdyOutcome] = useState(null);
	const ardyAbortRef = useRef(null);
	// Timeline frames for the configured duration: [0, duration*TIMELINE_FPS-1].
	const maxDst = Math.max(0, Math.round(ardyDuration) * TIMELINE_FPS - 1);

	/* --------------------------- motion workspace --------------------------- */
	// The timeline playhead and the root waypoints are App-owned so the scene
	// (character rig, plan path, ARDY card) reacts to every scrub/play tick.
	const [tlFrame, setTlFrame] = useState(0);

	const renderActive = useRenderActivity(tlPlaying || movePlaying);
	const [tlFrameCount, setTlFrameCount] = useState(startupShotState?.frameCount ?? DEFAULT_DURATION_S * TIMELINE_FPS); // the clip length on the production clock
	const [tlFps, setTlFps] = useState(TIMELINE_FPS);
	// Keep the imperative frame in step with the playhead for live playback;
	// the export overwrites it per captured frame and restores nothing, which
	// is correct — the next render puts it back.
	propFrameRef.current = tlFrame;
	const animatedSceneObjects = useMemo(() => {
		if (!sceneObjects.some((object) => object.path)) return sceneObjects;
		const take = { frameCount: tlFrameCount, fps: tlFps };
		return sceneObjects.map((object) => {
			const at = objectTransformAt(object, tlFrame, take);
			if (!at) return object;
			return { ...object, x: at.x, y: at.y, z: at.z, rot: at.rot ?? object.rot };
		});
	}, [sceneObjects, tlFrame, tlFrameCount, tlFps]);

	// Auto color: Blender's viewport "Random" mode. A DISPLAY-ONLY marker rides
	// each non-cutout object into the renderers; the authored `color`, the scene
	// document, undo history and the MCP view never change — toggling OFF makes
	// this list the animated list again, byte for byte.
	const [autoColor, setAutoColor] = useState(loadAutoColor);
	const displaySceneObjects = useMemo(() => {
		if (!autoColor) return animatedSceneObjects;
		return animatedSceneObjects.map((object) =>
			object.renderer === CUTOUT_KIND ? object : { ...object, autoColor: autoColorHex(object.id) },
		);
	}, [animatedSceneObjects, autoColor]);

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
	// Where a prop actually IS, read off its live group: the one authority on
	// the transform currently on screen, and so the only honest starting point
	// for a no-jump conversion.
	const propWorldRef = useRef(null);

	/** The prop's live world matrix, falling back to its authored numbers while
	 * it is unattached (those ARE world) and the set has not mounted it yet. */
	function sceneObjectWorldMatrix(object) {
		return propWorldRef.current?.(object.id, attachWorldMatrix)
			?? ((object.attach ?? null) ? null : sceneObjectMatrix(object, attachWorldMatrix));
	}

	/** The attachment a hierarchy row offers, or null when the row is not a
	 * frame. A character row means the whole body's animated root; a bone row
	 * means that one frame. Bone rows are namespaced per character (#76), so
	 * the row itself names whose frame it is. */
	function attachTargetForRow(rowId) {
		const charId = charIdFromHierarchyId(rowId);
		if (charId) return characters.some((entry) => entry.id === charId) ? { characterId: charId, bone: null } : null;
		const rig = parseRigNodeId(rowId);
		const owner = rig ? charIdFromHierarchyId(rig.rowId) : null;
		const bone = rig ? ATTACH_BONE_ROWS.get(rig.token) : null;
		if (!bone || !owner || !characters.some((entry) => entry.id === owner)) return null;
		return { characterId: owner, bone };
	}

	/** "Character 1 · Right Hand" — the same words the rows the user dropped on
	 * carry, so the Inspector names the target the way the tree does. */
	function attachTargetLabel(attach) {
		const index = characters.findIndex((entry) => entry.id === attach.characterId);
		const who = index < 0
			? ko("Missing character", "없는 인물")
			: index === 0
				? ko("Character 1", "인물 1")
				: index === 1
					? ko("Character 2", "인물 2")
					: isKo ? `인물 ${index + 1}` : `Character ${index + 1}`;
		const bone = attach.bone
			? HIERARCHY_INSPECTOR_TITLES[`rig.${attach.bone}`] ?? attach.bone
			: ko("Root", "루트");
		return `${who} · ${bone}`;
	}

	/**
	 * Hierarchy row drag policy (the panel holds none). An object row dropped on
	 * another object GROUPS; on a character or one of its bone rows it ATTACHES;
	 * on Props it comes back to the world. Anything else is not a drop.
	 */
	const hierarchyReparent = {
		canDrop(sourceRowId, targetRowId) {
			const id = sceneObjectIdFromHierarchy(String(sourceRowId ?? ""));
			if (!id || sourceRowId === targetRowId) return false;
			const object = sceneObjects.find((entry) => entry.id === id);
			if (!object) return false;
			const targetObjectId = sceneObjectIdFromHierarchy(String(targetRowId ?? ""));
			// Grouping keeps its own rules (self, cycles, unknown ids) — asking the
			// store is the only way to stay honest about them.
			if (targetObjectId) return setSceneObjectParent(sceneObjects, id, targetObjectId) !== sceneObjects;
			if (targetRowId === "props") return (object.attach ?? null) !== null || (object.parent ?? null) !== null;
			const attach = attachTargetForRow(targetRowId);
			if (!attach) return false;
			const current = object.attach ?? null;
			return !current || current.characterId !== attach.characterId || (current.bone ?? null) !== attach.bone;
		},
		onDrop(sourceRowId, targetRowId) {
			if (!hierarchyReparent.canDrop(sourceRowId, targetRowId)) return;
			const id = sceneObjectIdFromHierarchy(String(sourceRowId));
			const targetObjectId = sceneObjectIdFromHierarchy(String(targetRowId));
			// Grouping moves nothing on screen — the set places every prop at its
			// own absolute transform. Taking a parent DOES cancel an attachment
			// (the store's exclusivity rule), so a carried prop dropped into a
			// group comes back to world numbers on the way, exactly as the Props
			// row would put it back.
			if (targetObjectId) {
				const carried = animatedSceneObjects.find((entry) => entry.id === id) ?? null;
				const restored = carried?.attach
					? attachPlacementPatch(sceneObjectWorldMatrix(carried), null, attachFrameRef.current)
					: null;
				store.applyAtomic((objects) => {
					const next = setSceneObjectParent(objects, id, targetObjectId);
					return next === objects ? objects : placeSceneObject(next, id, restored);
				});
				return;
			}
			const attach = targetRowId === "props" ? null : attachTargetForRow(targetRowId);
			// Where the prop is on screen right now, expressed in the frame it is
			// joining (or left as world when it joins none). ONE conversion, whether
			// the prop is coming from the world or from another frame.
			const shown = animatedSceneObjects.find((entry) => entry.id === id) ?? null;
			const placement = shown ? attachPlacementPatch(sceneObjectWorldMatrix(shown), attach, attachFrameRef.current) : null;
			// A placement that could not be computed refuses the DROP, not just the
			// numbers: attaching without converting would silently reinterpret the
			// old frame's numbers in the new frame, which is the jump itself.
			if (!placement) return;
			// ONE atomic: a single undo puts back both the field and the numbers.
			store.applyAtomic((objects) => {
				let next = setSceneObjectAttach(objects, id, attach);
				// Dropping on Props means "world-anchored again", which drops the
				// grouping parent too — attach and parent are the same slot.
				if (attach === null) next = setSceneObjectParent(next, id, null);
				if (next === objects) return objects;
				return placeSceneObject(next, id, placement);
			});
		},
	};

	const activeShotIdx = shotIndexAtFrame(shots, tlFrame);
	const activeShot = shots[activeShotIdx] ?? null;
	const cameraKeys = activeShot?.cameraKeys ?? [];
	const activeCamera = createCameraBlock(activeShot?.camera);
	// A crane/shot switch invalidates the scene-dot selection.
	const craneActive = !!activeCamera.craneHeight;
	useEffect(() => {
		setCraneSelectedIndex(null);
	}, [activeShot?.id, craneActive]);
	const followCam = activeCamera.followCam;
	const cameraRail = activeCamera.cameraRail;
	const activeShotDuration = activeShot ? activeShot.endFrame - activeShot.startFrame + 1 : 0;
	const hasCameraKeys = shots.some((shot) => shot.cameraKeys.length > 0);
	function changeActiveCamera(patch, shotId = activeShot?.id) {
		// Every camera-block commit (mode switch, rail draw, rail delete, lens
		// patch) funnels through here, so this is where the shot snapshot goes.
		// No shot resolved means the setShots below is a no-op — record nothing.
		if (!shots.some((shot) => shot.id === shotId)) return;
		// A framing capture in the same gesture (rail draw toggle, Follow switch
		// re-measure) already snapshotted the pre-gesture shots, so this commit
		// joins that entry instead of pushing a second one for one click.
		if (framingSessionOpen(shotId)) framingSessionRef.current = null;
		else recordShotUndo();
		setShots((current) => updateStableItem(current, shotId, (shot) => ({ ...shot, camera: updateCameraBlock(shot.camera, patch) }), "shots"));
	}
	function addActiveCranePoint(requestedT = null, shotId = activeShot?.id) {
		const shot = shots.find((entry) => entry.id === shotId);
		const camera = createCameraBlock(shot?.camera);
		const points = camera.craneHeight?.points;
		if (!points || points.length >= 8) return;
		let t = Number.isFinite(requestedT) ? Math.max(0.02, Math.min(0.98, requestedT)) : null;
		if (t != null) {
			const nearbyIndex = points.findIndex((point) => Math.abs(point.t - t) < 0.02);
			if (nearbyIndex >= 0) {
				setCraneSelectedIndex(nearbyIndex);
				return;
			}
		}
		let gapIndex = 0;
		if (t == null) {
			for (let i = 1; i < points.length - 1; i += 1) {
				if (points[i + 1].t - points[i].t > points[gapIndex + 1].t - points[gapIndex].t) gapIndex = i;
			}
			t = (points[gapIndex].t + points[gapIndex + 1].t) / 2;
		} else {
			gapIndex = points.findIndex((point, index) => index < points.length - 1 && t > point.t && t < points[index + 1].t);
			if (gapIndex < 0) return;
		}
		const added = [
			...points.slice(0, gapIndex + 1),
			{ t, height: craneHeightAt(camera.craneHeight, t) },
			...points.slice(gapIndex + 1),
		];
		changeActiveCamera({ craneHeight: { points: added } }, shotId);
		setCraneSelectedIndex(gapIndex + 1);
	}
	function deleteSelectedCranePoint() {
		const points = activeCamera.craneHeight?.points;
		if (!points || craneSelectedIndex == null || craneSelectedIndex <= 0 || craneSelectedIndex >= points.length - 1) return;
		changeActiveCamera({ craneHeight: { points: points.filter((_, index) => index !== craneSelectedIndex) } });
		setCraneSelectedIndex(null);
	}
	function syncActiveCameraFraming() {
		const cam = shotCamRef.current;
		if (!cam || !activeShot || ikMode || playMode) return;
		const subjectPosition = motionPos ?? charA;
		const subjectYaw = (charA.rot * Math.PI) / 180;
		const measured = followFramingFromCamera(
			cam.position,
			look.current.pitch,
			subjectPosition,
			followCam.aimHeight,
			{ x: Math.sin(subjectYaw), z: Math.cos(subjectYaw) },
		);
		const unchanged = (previous) =>
			previous.distance === measured.distance &&
			previous.height === measured.height &&
			previous.pitchOffsetDeg === measured.pitchOffsetDeg &&
			previous.orbitOffsetDeg === measured.orbitOffsetDeg;
		// Framing is re-measured on every orbit/drag tick, so the entry is per
		// GESTURE: the first tick that actually moves the framing records, the
		// rest of the drag keeps writing into that same session.
		if (!unchanged(createCameraBlock(activeShot.camera).followCam)) {
			recordSessionUndo(framingSessionRef, `framing:${activeShot.id}`, recordShotUndo);
		}
		setShots((current) => current.map((shot) => {
			if (shot.id !== activeShot?.id) return shot;
			const camera = createCameraBlock(shot.camera);
			const previous = camera.followCam;
			if (unchanged(previous)) return shot;
			return { ...shot, camera: updateCameraBlock(camera, { followCam: { ...previous, ...measured } }) };
		}));
	}
	function commitManualCameraFraming() {
		if (ikMode || playMode) return;
		manualCameraOverrideRef.current = true;
		syncActiveCameraFraming();
	}
	/** Camera-puck / viewport framing gesture start. Opens the SAME framing
	 * session syncActiveCameraFraming writes into, so the whole drag is one
	 * Ctrl+Z entry snapshotted before the first tick moves the lens. */
	function beginCameraFramingGesture() {
		if (ikMode || playMode || !activeShot) return;
		recordSessionUndo(framingSessionRef, `framing:${activeShot.id}`, recordShotUndo);
	}
	/** One Ctrl+Z entry per timeline editing gesture. The timeline fires this
	 * once when a drag (or an arrow nudge, or a text session) begins, before
	 * any mutation lands; the per-tick handlers then write on top of it. */
	function beginTimelineEditGesture(kind, id) {
		if (kind === "camera-key" || kind === "rail" || kind === "shot-boundary") {
			recordShotUndo();
			return;
		}
		if (kind === "prompt-move" || kind === "prompt-resize") {
			recordCharacterUndo();
			return;
		}
		// Typing shares changePromptClip's per-session entry: focusing the chip
		// opens the session so the first keystroke joins it instead of pushing
		// a second entry for one edit.
		if (kind === "prompt-text") recordSessionUndo(promptTextSessionRef, `prompt-text:${id}`);
	}
	function changeCameraRail(points) {
		changeActiveCamera({
			cameraRail: points,
			railFollow: points ? railFollowForNewGeometry(activeCamera.railFollow, activeShotDuration) : null,
			mode: points ? "rail" : activeCamera.mode === "rail" ? "follow" : activeCamera.mode,
		});
	}
	function toggleCameraRailDraw() {
		if (!activeShot || waypointMode) return;
		// The viewport is the framing control. Capture it before Rail takes over
		// the camera so the dolly opens at the distance, height and tilt the
		// operator is actually looking through.
		syncActiveCameraFraming();
		if (activeCamera.mode !== "rail") {
			changeActiveCamera({
				mode: "rail",
				railFollow: activeCamera.railFollow?.mode === "off" ? defaultRailRange(activeShotDuration) : activeCamera.railFollow,
			});
		}
		const next = !railDraw;
		setRailDraw(next);
		if (next) {
			setWorkspaceLayout((current) => ({ ...current, insetCollapsed: false }));
			setToast(ko("Draw the selected Shot's rail in the Top-View", "탑뷰에서 선택한 샷의 레일을 그리세요"));
		}
	}
	function deleteCameraRail() {
		if (!cameraRail) return;
		setRailDraw(false);
		changeActiveCamera(removeCameraRail(activeCamera));
		setToast(ko("Camera rail deleted — Follow keeps the current distance", "카메라 레일 삭제됨 — 팔로우가 현재 거리를 유지합니다"));
	}
	function previewCameraShot(shotId) {
		const selected = shots.find((entry) => entry.id === shotId);
		if (!selected) throw new Error(`Unknown shots ID: ${shotId}`);
		if (waypointMode) return;
		if (tlPlaying && cameraPreviewEndRef.current === selected.endFrame) {
			cameraPreviewEndRef.current = null;
			setTlPlaying(false);
			return;
		}
		setMovePlaying(false);
		manualCameraOverrideRef.current = false;
		cameraPreviewEndRef.current = selected.endFrame;
		setTlFrame(selected.startFrame);
		setTlPlaying(true);
	}
	const frameCountRef = useRef(DEFAULT_DURATION_S * TIMELINE_FPS);
	frameCountRef.current = tlFrameCount;
	// Root waypoints {frame, x, z, heading: null}, kept sorted by frame —
	// the fixed bridge contract rejects out-of-order or duplicate frames.
	const [waypointMode, setWaypointMode] = useState(false);
	const [waypoints, setWaypoints] = useState(startupStage.characters?.[0]?.layer?.waypoints ?? startupShotState?.waypoints ?? []);
	const [activeWaypointId, setActiveWaypointId] = useState(null);
	const [pendingWaypointFrame, setPendingWaypointFrame] = useState(null);

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
	// Wave-2 gate: the bridge only routes lineEdit once M4's routing lands.
	// Until the /ardy/health payload says so, the request is never sent —
	// today's bridge ignores unknown fields, so an ungated POST would quietly
	// return a fresh unrelated take instead of an edit.
	const [lineEditBackend, setLineEditBackend] = useState(false);
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
	useEffect(() => {
		// Subject 1 is the sole frame-zero root start. Drop any legacy seeded
		// waypoint so Top-View never renders two start markers.
		setWaypoints((current) => current.filter((waypoint) => waypoint.frame !== 0));
		setActiveWaypointId(null);
		setPendingWaypointFrame((current) => (current === 0 ? null : current));
	}, []);

	// Shot trims also trim their local Rail Follow card once. Growing a shot
	// later never resurrects time that the editor already cut away.
	useEffect(() => {
		setShots((current) => {
			let changed = false;
			const next = current.map((shot, index) => {
				const railFollow = shot.camera?.railFollow;
				if (railFollow?.mode !== "range") return shot;
				const duration = shot.endFrame - shot.startFrame + 1;
				const clamped = clampRailRange(railFollow, duration);
				if (!clamped || (clamped.startFrame === railFollow.startFrame && clamped.endFrame === railFollow.endFrame)) return shot;
				changed = true;
				return { ...shot, camera: updateCameraBlock(shot.camera, { railFollow: { mode: "range", ...clamped } }) };
			});
			return changed ? next : current;
		});
	}, [tlFrameCount, shots.map((shot) => shot.startFrame).join(":")]);

	/* --------------------------- Scene documents --------------------------- */
	// Refs make a Scene switch synchronous: the outgoing room is sealed with
	// its latest objects and camera department envelope before React opens the
	// destination room.
	const scenesRef = useRef(scenes);
	const activeSceneIdRef = useRef(activeSceneId);
	const shotDocumentRef = useRef(null);
	const actorStageRef = useRef(null);
	scenesRef.current = scenes;
	activeSceneIdRef.current = activeSceneId;
	shotDocumentRef.current = createShotAuthoringDocument({ shots, waypoints, frameCount: tlFrameCount });
	actorStageRef.current = {
		// sessionMotion is stripped: generated clips are session-only and far
		// too heavy for the stage envelope; paths and prompt blocks persist.
		characters: characters.map(({ sessionMotion, ...entry }) => entry),
		hasCharSheet,
		shotAspect: shotAspectKey,
		sensorId,
		keyLight,
	};

	function snapshotActiveScene(sourceScenes = scenesRef.current) {
		return sourceScenes.map((scene) => scene.id === activeSceneIdRef.current
			? { ...scene, objects: storeRef.current.objects, shotDocument: shotDocumentRef.current, stage: actorStageRef.current }
			: scene);
	}

	function persistScenes(nextScenes, nextActiveSceneId) {
		if (saveBlockedRef.current) return false;
		try {
			localStorage.setItem(SCENES_STORAGE_KEY, serializeSceneDocument({
					version: SCENES_VERSION,
				activeSceneId: nextActiveSceneId,
				scenes: nextScenes,
			}));
			dirtyRef.current = false;
			setSceneSaveError(null);
			if (saveFailureToastRef.current) {
				saveFailureToastRef.current = false;
				setToast("");
			}
			return true;
		} catch (err) {
			const message = `Scenes not saved: ${err?.name || "StorageError"}`;
			setSceneSaveError(message);
			if (!saveFailureToastRef.current) {
				saveFailureToastRef.current = true;
				setToast(message);
			}
			return false;
		}
	}

	/* ============================ project files ============================
	 * Game-engine workflow: the authoring state (scenes + cast + layers,
	 * workspace layout, custom poses) round-trips through a real
	 * `.cclayproject` file. localStorage stays as the always-on session
	 * cache; the file is the portable, user-owned document. */
	const [projectName, setProjectName] = useState(() => loadProjectSession()?.name ?? null);
	const [projectDirty, setProjectDirty] = useState(false);
	const [projectMenuOpen, setProjectMenuOpen] = useState(false);
	const [projectBrowserOpen, setProjectBrowserOpen] = useState(false);
	const [projectNameDialog, setProjectNameDialog] = useState(null);
	// A first-run author should choose a document (or explicitly start a named
	// local draft). Keep this as a light startup sheet so the studio remains
	// inspectable while the choice is pending; it never traps the topbar.
	const [projectStartupOpen, setProjectStartupOpen] = useState(() => !loadProjectSession()?.name);

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
	const projectHandleRef = useRef(null);
	const projectSnapshotRef = useRef("");
	const projectStateRef = useRef(null);
	projectStateRef.current = { workspaceLayout, customPoses, scenes, activeSceneId, sceneObjects };
	const [workflowRevision, setWorkflowRevision] = useState(0);
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

	function projectDocumentInput(name) {
		return {
			scenesDocument: {
				version: SCENES_VERSION,
				activeSceneId: activeSceneIdRef.current,
				scenes: snapshotActiveScene(),
			},
			workspaceLayout: projectStateRef.current.workspaceLayout,
			customPoses: projectStateRef.current.customPoses,
			workflow: loadWorkflowGraph(),
			name,
		};
	}

	function collectProjectSnapshot(name) {
		return JSON.stringify(createProjectDocument(projectDocumentInput(name)));
	}

	async function collectProjectSerialized(name) {
		const input = projectDocumentInput(name);
		const db = await openAssetDb();
		try {
			const ids = [...referencedAssetIds(input.scenesDocument.scenes)];
			const assets = await Promise.all(ids.map((id) => getAsset(db, id)));
			// A referenced asset whose record vanished (swept elsewhere, another
			// tab) would drop out of the export in silence — the user would
			// learn on the machine they open it on. Say it here, at save time.
			const missing = ids.filter((id, index) => !assets[index]);
			if (missing.length) {
				setToast(isKo
					? `참조된 사진 ${missing.length}개를 찾지 못해보내기에서 빠졌어요`
					: `${missing.length} referenced image${missing.length > 1 ? "s" : ""} missing — left out of the export`);
			}
			return JSON.stringify(createProjectDocument({ ...input, assets }), null, 2);
		} finally {
			db.close();
		}
	}

	function markProjectClean(name) {
		projectSnapshotRef.current = collectProjectSnapshot(name);
		setProjectDirty(false);
		setProjectName(name);
		storeProjectSession(name);
	}

	async function rehydrateProjectAssets(project, warnings = []) {
		for (const warning of warnings) console.warn(`[cozyclay] ${warning}`);
		if (!project.assets.length) return;
		try {
			const db = await openAssetDb();
			try {
				const referenced = referencedAssetIds(project.scenesDocument.scenes);
				const results = await Promise.allSettled(project.assets.map(async (asset) => {
					if (!referenced.has(asset.id)) {
						console.warn(`[cozyclay] skipped embedded asset outside the project closure: ${asset.id}`);
						return;
					}
					if ((await assetIdForBytes(asset.bytes)) !== asset.id) {
						console.warn(`[cozyclay] skipped embedded asset with mismatched content address: ${asset.id}`);
						return;
					}
					await putAsset(db, asset);
				}));
				for (const result of results) if (result.status === "rejected") console.warn("[cozyclay] could not restore an embedded asset", result.reason);
			} finally {
				db.close();
			}
		} catch (error) {
			console.warn("[cozyclay] could not open the asset store for project restore", error);
		}
	}

	async function saveProject(saveAs = false, explicitName = null) {
		if (projectName === null && explicitName === null) {
			setProjectNameDialog({ kind: "save", initialName: "My Project" });
			return;
		}
		const name = (explicitName ?? projectName ?? "My Project").trim() || "My Project";
		try {
			const serialized = await collectProjectSerialized(name);
			let handle = projectHandleRef.current;
			if (saveAs || !handle || !hasFileSystemAccess()) {
				if (hasFileSystemAccess()) {
					handle = await pickProjectFileForSave(name);
					projectHandleRef.current = handle;
					await writeProjectFile(handle, serialized);
					await rememberRecentProject(handle, name);
				} else {
					downloadProjectFallback(serialized, name);
				}
			} else {
				await writeProjectFile(handle, serialized);
			}
			markProjectClean(name);
			setToast(isKo ? `프로젝트 저장됨: ${name}${PROJECT_EXTENSION}` : `Project saved: ${name}${PROJECT_EXTENSION}`);
		} catch (err) {
			if (err?.name === "AbortError") return; // user closed the picker
			setToast(ko("Could not save the project", "프로젝트를 저장하지 못했어요"));
		}
	}

	function applyProject(project) {
		const source = project.scenesDocument;
		// A project FILE carries its own scene document and never passes the
		// storage reader, so the 20 fps → 24 fps clock migration is applied here
		// too — otherwise an older .cozyclay would open a sixth too fast.
		const doc = Number.isInteger(source.version) && source.version < SCENES_VERSION
			? { ...source, version: SCENES_VERSION, scenes: source.scenes.map((scene) => ({ ...scene, stage: migrateStageFrames(scene.stage) })) }
			: source;
		const mergedCustomPoses = mergeProjectCustomPoses(customPoses, project.customPoses);
		setScenes(doc.scenes);
		setActiveSceneId(doc.activeSceneId);
		if (project.workspaceLayout) setWorkspaceLayout({ ...DEFAULT_WORKSPACE_LAYOUT, ...project.workspaceLayout });
		setCustomPoses(mergedCustomPoses);
		storeWorkflowGraph(normalizeWorkflowGraph(project.workflow));
		saveCustomPoses(mergedCustomPoses);
		persistScenes(doc.scenes, doc.activeSceneId);
		openScene(doc.scenes[activeSceneIndex(doc.scenes, doc.activeSceneId)], doc.scenes);
		projectSnapshotRef.current = collectProjectSnapshot(project.name);
		setProjectDirty(false);
		setProjectName(project.name);
		storeProjectSession(project.name);
		setProjectStartupOpen(false);
	}

	async function openProject() {
		try {
			let file = null;
			let handle = null;
			if (hasFileSystemAccess()) {
				handle = await pickProjectFileForOpen();
				file = await readProjectFile(handle);
			} else {
				file = await openProjectFallback();
			}
			if (!file) return;
			const result = readProjectDocument(file.text);
			if (!result.ok) {
				setToast(isKo ? `프로젝트를 열 수 없어요: ${result.reason}` : `Cannot open project: ${result.reason}`);
				return;
			}
			projectHandleRef.current = handle;
			if (handle) await rememberRecentProject(handle, result.project.name);
			await rehydrateProjectAssets(result.project, result.warnings);
			applyProject(result.project);
			setProjectStartupOpen(false);
			setToast(isKo ? `프로젝트 열림: ${result.project.name}` : `Project opened: ${result.project.name}`);
		} catch (err) {
			if (err?.name === "AbortError") return;
			console.error("openProject failed", err);
			setToast(ko("Could not open the project", "프로젝트를 열지 못했어요"));
		}
	}

	/** Open a project from the browser dialog: a stored handle from the
	 * recents list or a file enumerated in the projects folder. */
	async function openProjectByHandle(handle) {
		try {
			// A stored handle may have been demoted to "prompt" since the last
			// session (#51); this click is the user gesture that can re-grant it.
			if ((await requestHandlePermission(handle)) !== "granted") {
				setToast(ko("Project access was not granted — allow access and try again.", "프로젝트 접근이 허용되지 않았어요. 접근을 허용하고 다시 시도해 주세요."));
				return;
			}
			const file = await readProjectFile(handle);
			const result = readProjectDocument(file.text);
			if (!result.ok) {
				setToast(isKo ? `프로젝트를 열 수 없어요: ${result.reason}` : `Cannot open project: ${result.reason}`);
				return;
			}
			projectHandleRef.current = handle;
			await rememberRecentProject(handle, result.project.name);
			await rehydrateProjectAssets(result.project, result.warnings);
			applyProject(result.project);
		setProjectBrowserOpen(false);
		setProjectStartupOpen(false);
		setToast(isKo ? `프로젝트 열림: ${result.project.name}` : `Project opened: ${result.project.name}`);
		} catch (err) {
			console.error("openProjectByHandle failed", err);
			setToast(ko("Could not open the project", "프로젝트를 열지 못했어요"));
		}
	}

	function requestNewProject() {
		if (projectDirty && !window.confirm(ko("Discard unsaved changes and start a new project?", "저장되지 않은 변경사항을 버리고 새 프로젝트를 시작할까요?"))) return;
		setProjectNameDialog({ kind: "new", initialName: projectName ?? "My Project" });
	}

	function newProject(name) {
		if (typeof name !== "string") return requestNewProject();
		setProjectNameDialog(null);
		const fresh = createSceneDocument(ko("SCENE 01", "씬 01"));
		storeWorkflowGraph(createWorkflowGraph());
		setScenes(fresh.scenes);
		setActiveSceneId(fresh.activeSceneId);
		persistScenes(fresh.scenes, fresh.activeSceneId);
		openScene(fresh.scenes[0], fresh.scenes);
		projectHandleRef.current = null;
		clearStoredProjectHandle();
		projectSnapshotRef.current = JSON.stringify(createProjectDocument({
			scenesDocument: fresh,
			workspaceLayout: projectStateRef.current.workspaceLayout,
			customPoses,
			workflow: createWorkflowGraph(),
			name,
		}));
		setProjectDirty(false);
		setProjectName(name);
		storeProjectSession(name);
		setProjectStartupOpen(false);
		setToast(ko(`New project: ${name}`, `새 프로젝트: ${name}`));
	}

	// Re-open the last project on launch when the browser still grants access.
	// A handle Chromium demoted to "prompt" cannot be re-requested here (no
	// user gesture), so it becomes a one-click restore offer instead (#51).
	const projectAutoOpenedRef = useRef(false);
	const [restoreOffer, setRestoreOffer] = useState(null);
	async function restoreStoredProject(record) {
		try {
			const file = await readProjectFile(record.handle);
			const result = readProjectDocument(file.text);
			if (!result.ok) return;
			projectHandleRef.current = record.handle;
			await rehydrateProjectAssets(result.project, result.warnings);
			applyProject(result.project);
			setToast(isKo ? `프로젝트 복원됨: ${result.project.name}` : `Project restored: ${result.project.name}`);
		} catch {
			/* missing or unreadable file: fall back to the session cache */
		}
	}
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

	function flushScenes() {
		if (!dirtyRef.current) return;
		persistScenes(snapshotActiveScene(), activeSceneIdRef.current);
	}

	function restoredShotState(scene) {
		const restored = readShotAuthoringDocument(scene?.shotDocument ?? undefined);
		if (restored.state) return restored.state;
		const frameCount = DEFAULT_DURATION_S * TIMELINE_FPS;
		return { shots: initialShots(frameCount), waypoints: [], frameCount };
	}

	function openScene(scene, nextScenes) {
		const shotState = restoredShotState(scene);
		const stage = createSceneStage(scene.stage);
		const objects = Array.isArray(scene.objects) ? scene.objects : [];
		storeRef.current = createSceneHistoryStore(objects, {
			onObjects: (next) => {
				if (!suppressObjectClockRef.current) lastObjectOpRef.current = ++opClockRef.current;
				setSceneObjects(next);
			},
		});
		setSceneObjects(objects);
		setShots(shotState.shots);
		setTlFrameCount(shotState.frameCount ?? DEFAULT_DURATION_S * TIMELINE_FPS);
		setCharacters(stage.characters);
		setRigMountEpoch((value) => value + 1);
		setHasCharSheet(stage.hasCharSheet);
		setShotAspectKey(stage.shotAspect);
		setSensorFormat(stage.sensorId);
		setKeyLight(stage.keyLight);
		// The motion-layer buffer reloads from the scene's first character.
		const firstLayer = stage.characters[0]?.layer;
		setWaypoints(firstLayer?.waypoints ?? shotState.waypoints ?? []);
		setPromptClips(firstLayer?.promptClips?.map((clip) => ({ ...clip })) ?? []);
		setMotion(null);
		// Takes belong to the room being left; restoreMotionRefs re-fetches the
		// incoming scene's, and a stale full take must never survive the switch.
		motionFullRef.current.clear();
		setSelectedPromptId(null);
		ikStatesRef.current.clear();
		ikStateRef.current = createIkState();
		loadedLayerCharRef.current = stage.characters[0]?.id ?? null;
		setActiveCharacterId(stage.characters[0]?.id ?? null);
		charHistoryRef.current = { past: [], future: [] };
		restoreMotionRefs(stage.characters);
		setTlFrame(0);
		setMovePlaying(false);
		manualCameraOverrideRef.current = false;
		setRailDraw(false);
		setActiveWaypointId(null);
		setPendingWaypointFrame(null);
		setSelectedHierarchyId("shot");
		scenesRef.current = nextScenes;
		activeSceneIdRef.current = scene.id;
		setScenes(nextScenes);
		setActiveSceneId(scene.id);
		track("scene:loaded", { scene_source: "local" });
	}

	function selectSceneDocument(sceneId) {
		if (sceneId === activeSceneIdRef.current) return;
		const savedScenes = snapshotActiveScene();
		const target = savedScenes.find((scene) => scene.id === sceneId);
		if (!target) return;
		persistScenes(savedScenes, sceneId);
		openScene(target, savedScenes);
	}

	function createSceneDocumentFromUi() {
		const savedScenes = snapshotActiveScene();
		const nextScenes = addScene(savedScenes);
		const target = nextScenes[nextScenes.length - 1];
		persistScenes(nextScenes, target.id);
		openScene(target, nextScenes);
		track("scene:created", { scene_source: "ui" });
	}

	function duplicateSceneDocumentFromUi(sceneId) {
		const savedScenes = snapshotActiveScene();
		const index = savedScenes.findIndex((scene) => scene.id === sceneId);
		if (index < 0) return;
		const nextScenes = duplicateScene(savedScenes, index);
		const target = nextScenes[index + 1];
		persistScenes(nextScenes, target.id);
		openScene(target, nextScenes);
	}

	function renameSceneDocumentFromUi(sceneId, name) {
		const savedScenes = snapshotActiveScene();
		const index = savedScenes.findIndex((scene) => scene.id === sceneId);
		if (index < 0) return;
		const nextScenes = renameScene(savedScenes, index, name);
		scenesRef.current = nextScenes;
		setScenes(nextScenes);
		persistScenes(nextScenes, activeSceneIdRef.current);
	}

	function deleteSceneDocumentFromUi(sceneId) {
		const savedScenes = snapshotActiveScene();
		const index = savedScenes.findIndex((scene) => scene.id === sceneId);
		if (index < 0 || savedScenes.length <= 1) return;
		const nextScenes = removeScene(savedScenes, index);
		if (sceneId !== activeSceneIdRef.current) {
			scenesRef.current = nextScenes;
			setScenes(nextScenes);
			persistScenes(nextScenes, activeSceneIdRef.current);
			return;
		}
		const target = nextScenes[Math.min(index, nextScenes.length - 1)];
		persistScenes(nextScenes, target.id);
		openScene(target, nextScenes);
	}

	// Commands are a sequential transport boundary, while React commits on a
	// later turn. Keep its read model current synchronously so the next frame
	// observes the mutation that the previous frame just acknowledged.
	liveStateRef.current = {
		scenes,
		activeSceneId,
		camera: cameraPos,
		fovDeg,
		filmback,
		stage: { shotAspect: shotAspectKey, sensorId, hasCharSheet },
		timeline: { currentFrame: tlFrame, frameCount: tlFrameCount, fps: tlFps },
		activeCharacterId,
		waypoints,
		characters,
		objects: sceneObjects,
		rigs,
		commitManualCameraFraming,
		recordCharacterUndo,
		removeCharacter,
		persistScenes,
		openScene,
		loadMotion,
	};
	if (!liveHandlersRef.current) {
		const finitePatch = (args, fields) => {
			const patch = {};
			for (const field of fields) {
				if (args[field] === undefined) continue;
				if (!Number.isFinite(args[field])) throw new Error(`Invalid ${field}`);
				patch[field] = args[field];
			}
			return patch;
		};
		const characterForRef = (characters, ref) => {
			if (typeof ref === "number" && Number.isInteger(ref)) return characters[ref - 1] ?? null;
			if (typeof ref !== "string" || !ref) return null;
			if (/^\d+$/.test(ref)) return characters[Number(ref) - 1] ?? null;
			if (ref.toUpperCase() === "A") return characters[0] ?? null;
			if (ref.toUpperCase() === "B") return characters[1] ?? null;
			return characters.find((entry) => entry.id === ref) ?? null;
		};
		const describe = () => {
			const live = liveStateRef.current;
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
				timeline: live.timeline,
				activeCharacterId: live.activeCharacterId,
				// y rides too: a character standing on a roof must survive the
				// same save/open round trip a renamed object just learned to.
				characters: live.characters.map((entry) => {
					const layer = entry.id === live.activeCharacterId
						? { waypoints: live.waypoints ?? [], promptClips: live.promptClips ?? [] }
						: entry.layer ?? { waypoints: [], promptClips: [] };
					return {
						id: entry.id, model: entry.model, subject: entry.subject,
						x: entry.x, y: entry.y ?? 0, z: entry.z, rot: entry.rot, hidden: entry.hidden,
						pose: entry.pose ?? null, tint: entry.tint ?? null, scale: entry.scale ?? 1,
						motionRef: entry.motionRef ?? null, layer,
					};
				}),
				// Scale and the library footprint travel with each object: the server
				// reports real sizes from them, and without them every prop reads as
				// 1x1x1 no matter how it was actually built.
				objects: live.objects.map((object) => ({
					id: object.id, name: object.name,
					// The kind travels with the report: a renamed object ("Building A")
					// can no longer be recognised by its name, and a record that loses
					// its renderer round-trips into something the set cannot draw.
					renderer: object.renderer,
					x: object.x, y: object.y, z: object.z, rot: object.rot,
					rotX: object.rotX ?? 0, rotZ: object.rotZ ?? 0, color: object.color ?? null,
					scaleX: object.scaleX, scaleY: object.scaleY, scaleZ: object.scaleZ,
					parent: object.parent ?? null,
					footprint: object.footprint, height: object.height,
				})),
			};
		};
		const replaceCharacters = (next) => {
			charactersRef.current = next;
			liveStateRef.current.characters = next;
			setCharacters(next);
		};
		const syncObjects = () => {
			liveStateRef.current.objects = storeRef.current.objects;
		};
		let batchToken = null;
		const applyObjectMutation = (mutation) => {
			if (batchToken === null) storeRef.current.applyAtomic(mutation);
			else storeRef.current.applyIn(batchToken, mutation);
			syncObjects();
		};
		liveHandlersRef.current = {
			ping: () => ({ pong: true }),
			describe,
			// Camera moves are not undoable in the UI. This is the free-camera and
			// Top-View path: drive the shot camera, lens state, then manual ownership.
			set_camera: (args) => {
				const live = liveStateRef.current;
				const patch = finitePatch(args, ["x", "y", "z"]);
				let nextFov = live.fovDeg;
				if (args.focalMm !== undefined) {
					if (!Number.isFinite(args.focalMm) || args.focalMm <= 0) throw new Error("Invalid focalMm");
					nextFov = (focalMmToFov(
						args.focalMm,
						live.filmback.sensorId,
						live.filmback.aspectRatio,
					) * 180) / Math.PI;
					if (nextFov < 14 || nextFov > 90) throw new Error("focalMm is outside the editor lens range");
				}
				const next = { ...live.camera, ...patch };
				// Optional aim target (live protocol v1, additive): all three or none.
				// frame_shot always sends it, because a camera that is placed but not
				// aimed keeps whatever the last gesture was pointing at and drops the
				// subject out of frame for every view except `front`. The yaw/pitch go
				// into look.current as well as the camera: that ref is the orientation
				// of record here — FlyControls writes rotation from it, and the framing
				// commit below measures the shot from look.current.pitch, so a bare
				// camera.lookAt would be both overwritten and mismeasured.
				const aim = finitePatch(args, ["lookAtX", "lookAtY", "lookAtZ"]);
				const aimed = Object.keys(aim).length === 3;
				const camera = shotCamRef.current;
				const angles = aimed ? aimAt(next, { x: aim.lookAtX, y: aim.lookAtY, z: aim.lookAtZ }) : null;
				if (angles) {
					look.current.yaw = angles.yaw;
					look.current.pitch = angles.pitch;
				}
				if (camera) {
					camera.position.set(next.x, next.y, next.z);
					camera.fov = nextFov;
					if (angles) {
						camera.rotation.order = "YXZ";
						camera.rotation.set(angles.pitch, angles.yaw, 0);
					}
					camera.updateProjectionMatrix();
				}
				// While a cast model's FBX is still downloading, the Canvas subtree is
				// suspended and the shot camera is unmounted, so `camera` is null and
				// the write above is skipped. The pose still has to survive: ShotRig
				// restores it from this ref (and look.current) when the camera
				// remounts, instead of re-seeding the preset over it (#86 on slow
				// runners — the position and aim were being dropped here).
				shotCameraPosRef.current = { x: next.x, y: next.y, z: next.z };
				live.camera = next;
				live.fovDeg = nextFov;
				setCameraPos(next);
				setFovDeg(nextFov);
				live.commitManualCameraFraming();
				return {
					camera: {
						...next,
						focalMm: Math.round(fovToFocalMm(
							(nextFov * Math.PI) / 180,
							live.filmback.sensorId,
							live.filmback.aspectRatio,
						) * 100) / 100,
					},
				};
			},
			add_character: (args) => {
				if (typeof args.subject !== "string") throw new Error("Invalid subject");
				const live = liveStateRef.current;
				const patch = finitePatch(args, ["x", "z", "rot"]);
				live.recordCharacterUndo();
				const id = nextCharacterId(live.characters);
				replaceCharacters([...live.characters, createCharacterEntry({ id, model: args.model, subject: args.subject, pose: DEFAULT_POSE, ...patch }, live.characters.length)]);
				return { id };
			},
			update_character: (args) => {
				const live = liveStateRef.current;
				const character = characterForRef(live.characters, args.ref);
				if (!character) throw new Error("Character not found");
				const patch = finitePatch(args, ["x", "y", "z", "rot"]);
				if (args.subject !== undefined) {
					if (typeof args.subject !== "string") throw new Error("Invalid subject");
					patch.subject = args.subject;
				}
				if (args.hidden !== undefined) {
					if (typeof args.hidden !== "boolean") throw new Error("Invalid hidden");
					patch.hidden = args.hidden;
				}
				if (!Object.keys(patch).some((key) => patch[key] !== character[key])) return { id: character.id };
				live.recordCharacterUndo();
				replaceCharacters(live.characters.map((entry) => entry.id === character.id ? { ...entry, ...patch } : entry));
				return { id: character.id };
			},
			remove_character: (args) => {
				const live = liveStateRef.current;
				const character = characterForRef(live.characters, args.ref);
				if (!character) throw new Error("Character not found");
				if (live.characters.length <= 1) throw new Error("Cannot remove the final character");
				live.removeCharacter(character.id);
				live.characters = charactersRef.current;
				return { id: character.id };
			},
			place_object: (args) => {
				if (typeof args.kind !== "string") throw new Error("Invalid kind");
				const live = liveStateRef.current;
				// The parent is checked before anything is created: a bad id must
				// not leave a half-made part lying around unattached.
				if (args.parent !== undefined) {
					if (typeof args.parent !== "string" || !live.objects.some((o) => o.id === args.parent)) {
						throw new Error(`Parent object not found: ${args.parent}`);
					}
				}
				if (args.name !== undefined && (typeof args.name !== "string" || !args.name.trim())) {
					throw new Error("Invalid name");
				}
				const placement = finitePatch(args, ["x", "z", "rot"]);
				const object = createSceneObject(args.kind, live.objects, placement);
				if (!object) throw new Error(`Unknown object kind: ${args.kind}`);
				const patch = finitePatch(args, ["y"]);
				if (args.name !== undefined) patch.name = args.name;
				const placed = updateSceneObject([object], object.id, patch)[0];
				// One atomic entry: create, name and attach undo together, as the
				// single "place part" gesture they are to the caller.
				applyObjectMutation((objects) => {
					const next = [...objects, placed];
					return args.parent !== undefined ? setSceneObjectParent(next, placed.id, args.parent) : next;
				});
				return { id: placed.id };
			},
			update_object: (args) => {
				const live = liveStateRef.current;
				if (typeof args.id !== "string" || !live.objects.some((object) => object.id === args.id)) throw new Error("Object not found");
				const patch = finitePatch(args, ["x", "y", "z", "rot", "rotX", "rotZ"]);
				// A uniform `scale` is the common case; per-axis values are what a
				// squashed disc or a stretched column needs, exactly as the
				// inspector's three sliders provide. Per-axis wins when both come.
				if (args.scale !== undefined) {
					if (!Number.isFinite(args.scale)) throw new Error("Invalid scale");
					patch.scaleX = args.scale;
					patch.scaleY = args.scale;
					patch.scaleZ = args.scale;
				}
				Object.assign(patch, finitePatch(args, ["scaleX", "scaleY", "scaleZ"]));
				if (args.color !== undefined) {
					if (typeof args.color !== "string") throw new Error("Invalid color");
					patch.color = args.color;
				}
				if (args.name !== undefined) {
					if (typeof args.name !== "string" || !args.name.trim()) throw new Error("Invalid name");
					patch.name = args.name;
				}
				// A travel path arrives whole (or null to clear it); the object
				// schema repairs or refuses it, so a bad route cannot land.
				if (args.path !== undefined) {
					if (args.path !== null && createObjectPath(args.path) === null) throw new Error("Invalid path: needs two or more distinct points");
					patch.path = args.path;
				}
				applyObjectMutation((objects) => updateSceneObject(objects, args.id, patch));
				return { id: args.id };
			},
			remove_object: (args) => {
				const live = liveStateRef.current;
				if (typeof args.id !== "string" || !live.objects.some((object) => object.id === args.id)) throw new Error("Object not found");
				applyObjectMutation((objects) => removeSceneObject(objects, args.id));
				return { id: args.id };
			},
			// Replacing a document follows the existing project-open path and clears
			// its per-scene histories, so load_scenes is deliberately not undoable.
			load_scenes: (args) => {
				if (!args.document || typeof args.document !== "object" || Array.isArray(args.document)) throw new Error("Invalid scene document");
				const loaded = readSceneDocument(JSON.stringify(args.document));
				if (loaded.status !== "valid" && loaded.status !== "migrated") throw new Error("Invalid scene document");
				const document = loaded.document;
				const target = document.scenes[activeSceneIndex(document.scenes, document.activeSceneId)];
				const live = liveStateRef.current;
				live.persistScenes(document.scenes, document.activeSceneId);
				live.openScene(target, document.scenes);
				live.scenes = document.scenes;
				live.activeSceneId = document.activeSceneId;
				live.objects = storeRef.current.objects;
				live.characters = createSceneStage(target.stage).characters;
				charactersRef.current = live.characters;
				return {
					sceneName: target.name,
					activeSceneId: document.activeSceneId,
					scenes: document.scenes.map((scene) => ({ id: scene.id, name: scene.name })),
				};
			},
			// Loads a bridge-generated take onto the active character — the same
			// path the demo seed and the Motion panel use. Replacing a take is not
			// undoable in the UI either, so this is deliberately not undoable.
			// Grouping is an editing convenience: the parent carries its children
			// when it moves, so a set piece built from primitives is dragged once.
			group_objects: (args) => {
				const live = liveStateRef.current;
				if (typeof args.parent !== "string" || !live.objects.some((o) => o.id === args.parent)) {
					throw new Error("Parent object not found");
				}
				if (!Array.isArray(args.children) || !args.children.length) throw new Error("No children given");
				for (const child of args.children) {
					if (!live.objects.some((o) => o.id === child)) throw new Error(`Object not found: ${child}`);
				}
				applyObjectMutation((objects) =>
					args.children.reduce((acc, child) => setSceneObjectParent(acc, child, args.parent), objects),
				);
				return { parent: args.parent, children: args.children.length };
			},
			ungroup_objects: (args) => {
				const live = liveStateRef.current;
				if (!Array.isArray(args.children) || !args.children.length) throw new Error("No children given");
				for (const child of args.children) {
					if (!live.objects.some((o) => o.id === child)) throw new Error(`Object not found: ${child}`);
				}
				applyObjectMutation((objects) =>
					args.children.reduce((acc, child) => setSceneObjectParent(acc, child, null), objects),
				);
				return { children: args.children.length };
			},
			apply_batch: (args) => {
				if (batchToken !== null) throw new Error("Nested batches are not supported");
				if (!Array.isArray(args.ops)) throw new Error("Invalid batch operations");
				if (args.ops.length > 100) throw new Error("A batch may contain at most 100 operations");
				if (args.atomic !== undefined && typeof args.atomic !== "boolean") throw new Error("Invalid atomic flag");
				if (args.stopOnError !== undefined && typeof args.stopOnError !== "boolean") throw new Error("Invalid stopOnError flag");
				if (args.label !== undefined && (typeof args.label !== "string" || !args.label.trim())) throw new Error("Invalid batch label");
				const objectCommands = new Set(["place_object", "update_object", "remove_object", "group_objects", "ungroup_objects"]);
				for (const operation of args.ops) {
					if (!operation || typeof operation !== "object" || Array.isArray(operation)) throw new Error("Invalid batch operation");
					if (operation.name === "apply_batch") throw new Error("Nested batches are not supported");
					if (!objectCommands.has(operation.name)) {
						throw new Error("Batch v1 supports object mutations only; character mutations are not supported");
					}
					if (!operation.args || typeof operation.args !== "object" || Array.isArray(operation.args)) throw new Error("Invalid batch operation arguments");
				}
				const atomic = args.atomic === true;
				const stopOnError = args.stopOnError !== false;
				const depthBefore = storeRef.current.depths().past;
				const token = storeRef.current.begin(args.label?.trim() || "MCP batch", () => {});
				const priorSuppressObjectClock = suppressObjectClockRef.current;
				suppressObjectClockRef.current = true;
				const applied = [];
				const failed = [];
				batchToken = token;
				let rolledBack = false;
				let commit = false;
				try {
					for (const [index, operation] of args.ops.entries()) {
						try {
							liveHandlersRef.current[operation.name](operation.args);
							applied.push(index + 1);
						} catch (error) {
							failed.push({ index: index + 1, error: error instanceof Error ? error.message : "Command failed" });
							if (stopOnError) break;
						}
					}
					rolledBack = atomic && failed.length > 0;
					commit = !rolledBack;
				} finally {
					batchToken = null;
					suppressObjectClockRef.current = priorSuppressObjectClock;
					storeRef.current.end(token, { commit });
				}
				if (!rolledBack && storeRef.current.depths().past > depthBefore) lastObjectOpRef.current = ++opClockRef.current;
				syncObjects();
				return { label: args.label?.trim() || "MCP batch", applied, failed, rolledBack };
			},
			// Authoring blocks is not generating: a director writes the beats and
			// their ranges first, then generates when the schedule reads right.
			// Frames arrive on the timeline's own 24 fps clock.
			set_prompt_blocks: (args) => {
				if (!Array.isArray(args.blocks)) throw new Error("Invalid blocks");
				const stamp = Date.now();
				const clips = args.blocks.map((block, i) => {
					const startFrame = Math.round(Number(block.startFrame));
					const endFrame = Math.round(Number(block.endFrame));
					if (!Number.isFinite(startFrame) || !Number.isFinite(endFrame) || endFrame <= startFrame) {
						throw new Error(`Invalid frame range on block ${i + 1}`);
					}
					if (typeof block.text !== "string" || !block.text.trim()) throw new Error(`Block ${i + 1} needs text`);
					return { id: `prompt-${stamp}-${i}`, startFrame, endFrame, text: block.text.trim() };
				});
				const live = liveStateRef.current;
				live.recordCharacterUndo();
				live.promptClips = clips;
				live.setPromptClips(clips);
				if (clips.length) {
					live.setTlFrameCount((count) => Math.max(count, clips[clips.length - 1].endFrame));
				}
				return { blocks: clips.length };
			},
			capture_frame: async () => {
				const live = liveStateRef.current;
				return captureMcpFrame({
					capture: mcpCaptureRef.current,
					camera: shotCamRef.current,
					characters: live.characters,
					activeCharacterId: live.activeCharacterId,
					objects: live.objects,
					rigs: live.rigs,
					readAuthoredState: () => ({
						scenes: liveStateRef.current.scenes,
						activeSceneId: liveStateRef.current.activeSceneId,
						camera: liveStateRef.current.camera,
						fovDeg: liveStateRef.current.fovDeg,
						filmback: liveStateRef.current.filmback,
						stage: liveStateRef.current.stage,
						timeline: liveStateRef.current.timeline,
						activeCharacterId: liveStateRef.current.activeCharacterId,
						waypoints: liveStateRef.current.waypoints,
						characters: liveStateRef.current.characters,
						objects: liveStateRef.current.objects,
					}),
				});
			},
			load_motion: async (args) => {
				if (typeof args.url !== "string" || !args.url.startsWith("/ardy/")) throw new Error("Invalid motion url");
				const prompt = typeof args.prompt === "string" ? args.prompt : "";
				if (args.drop != null && !normalizeRootDrop(args.drop)) throw new Error("Invalid drop");
				// Optional per-phase blocks land on the Prompts lane the way hand-authored
				// ones do. The bridge clock is 20 fps for ARDY and 24 fps for Kimodo;
				// convert only when the selected backend's clock differs from the lane.
				let clips = null;
				if (Array.isArray(args.blocks) && args.blocks.length) {
					const toTimeline = (frame) => Math.round((frame * TIMELINE_FPS) / ARDY_FPS);
					const stamp = Date.now();
					clips = args.blocks.map((block, i) => ({
						id: `prompt-${stamp}-${i}`,
						startFrame: toTimeline(block.startFrame),
						endFrame: toTimeline(block.endFrame),
						text: typeof block.prompt === "string" ? block.prompt : "",
					}));
				}
				const targetCharacterId = args.characterId ?? liveStateRef.current.activeCharacterId;
				const targetPromptClips = clips;
				await liveStateRef.current.loadMotion(
					args.url,
					prompt,
					undefined,
					args.drop ?? null,
					targetCharacterId,
					targetPromptClips,
				);
				if (clips) {
					liveStateRef.current.setTlFrameCount((count) => Math.max(count, clips[clips.length - 1].endFrame));
				}
				return { loaded: true, url: args.url, blocks: Array.isArray(args.blocks) ? args.blocks.length : 0 };
			},
		};
	}

	useEffect(() => {
		const enabled = import.meta.env.DEV || window.__COZYCLAY_LIVE__ === true;
		if (!enabled) return undefined;
		// StrictMode replays effects in development. Delaying the open lets the
		// replay cleanup cancel its first pass, so one tab owns one socket.
		const timer = setTimeout(() => {
			if (!liveControlRef.current) {
				liveControlRef.current = createLiveControl({
					handlers: liveHandlersRef.current,
					workspaceId: liveWorkspaceIdRef.current,
					meta: {
						project: projectName ?? "Untitled",
						scene: scenes.find((entry) => entry.id === activeSceneId)?.name ?? "",
						cast: charactersRef.current.length,
					},
					onWorkspace: setLiveWorkspaceHandle,
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
			setLiveWorkspaceHandle(null);
		};
	}, []);

	// One debounced Scene-document save owns both departments. Switching calls
	// persistScenes directly, so no outgoing edit can be overtaken by a render.
	useEffect(() => {
		dirtyRef.current = true;
		const timer = setTimeout(flushScenes, 400);
		return () => clearTimeout(timer);
	}, [sceneObjects, shots, waypoints, tlFrameCount, charA, charB, showB, poseA, poseB, hasCharSheet, subject, subject2, shotAspectKey, sensorId, keyLight, scenes, activeSceneId]);
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
	const [promptClips, setPromptClips] = useState(() => (startupStage.characters?.[0]?.layer?.promptClips ?? DEFAULT_PROMPT_CLIPS).map((clip) => ({ ...clip })));
	// These hooks are declared after the liveStateRef assignment above runs, so
	// they join the live read model here — same render, no TDZ.
	Object.assign(liveStateRef.current, { promptClips, setPromptClips, setTlFrameCount });

	// Dirty tracking: any divergence from the last saved file lights the dot.
	useEffect(() => {
		if (projectName === null) return; // untitled sessions are never "dirty"
		const serialized = collectProjectSnapshot(projectName);
		setProjectDirty(serialized !== projectSnapshotRef.current);
		// eslint-disable-next-line react-hooks/exhaustive-deps
	}, [scenes, activeSceneId, workspaceLayout, customPoses, characters, shots, waypoints, promptClips, projectName, keyLight, sceneObjects, shotAspectKey, sensorId, tlFrameCount, workflowRevision]);
	const [selectedPromptId, setSelectedPromptId] = useState(null);
	// Loaded motion: decoded arrays plus the world anchor captured at load.
	const [motion, setMotion] = useState(null);
	// The untrimmed take per CHARACTER. Trims are non-destructive views of the
	// full take, so re-trimming and "restore full" always cut from the
	// original — and because each cast member owns its own layer, one shared
	// ref would hand Subject 2's take to Subject 1 on the next switch.
	const motionFullRef = useRef(new Map()); // charId -> untrimmed take
	const [motionBusy, setMotionBusy] = useState(false);
	const [motionError, setMotionError] = useState("");
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
	/* ------------------------- video capture (ingest) ---------------------- */
	const [multiModelUrl, setMultiModelUrl] = useState("");
	const [multiModelSource, setMultiModelSource] = useState(null);
	const [multiModelStatus, setMultiModelStatus] = useState("idle");
	// The ingest is a real download + decode, so it owns real progress and a
	// real receipt: the footage numbers below come from the decoded media.
	const [multiModelStage, setMultiModelStage] = useState("idle");
	const [multiModelProgress, setMultiModelProgress] = useState(null);
	const [multiModelFootage, setMultiModelFootage] = useState(null);
	const [multiModelError, setMultiModelError] = useState("");
	const multiModelFileRef = useRef(null);
	const multiModelRunRef = useRef(0);
	const multiModelObjectUrlRef = useRef(null);
	const [multiModelTake, setMultiModelTake] = useState(null);
	const [multiModelExtract, setMultiModelExtract] = useState("idle"); // idle | running | done | error
	const [multiModelExtractProgress, setMultiModelExtractProgress] = useState(null);
	const [multiModelExtractError, setMultiModelExtractError] = useState("");
	const multiModelDetectorRef = useRef(null); // engine survives re-runs; the 15 MB download happens once
	const multiModelRestRef = useRef(null);
	// A still needs its own landmarker: MediaPipe fixes the running mode at
	// creation and refuses detect() on a VIDEO-mode instance. The weights are
	// already cached by then, so the second instance is cheap.
	const photoPoseFileRef = useRef(null);
	const photoPoseDetectorRef = useRef(null);
	const [photoPoseState, setPhotoPoseState] = useState("idle");
	const [photoPoseError, setPhotoPoseError] = useState("");

	// Cast render props, memoized with Character itself (React.memo): during
	// playback the playhead ticks 24 times a second, and a character whose
	// props did not change must not re-render its subtree.
	const characterViews = useMemo(() => characters.flatMap((entry, index) => {
		if (entry.hidden) return [];
		// Each cast member is driven by ITS OWN clip: the active one reads
		// the editing buffer, the others their stored session motion.
		const clip = entry.id === activeChar.id ? motion : entry.sessionMotion;
		return [{
			id: entry.id,
			url: characterModelUrl(entry.model),
			position: clip ? [clip.anchorX, entry.y ?? 0, clip.anchorZ] : [entry.x, entry.y ?? 0, entry.z],
			rot: clip ? clip.rotationDeg : entry.rot,
			tint: entry.tint ?? defaultCharacterTint(entry, index),
			pose: clip ? null : (entry.pose ?? DEFAULT_POSE),
			// The stature the entry's take was extracted at. It rides with the
			// clip, never separately — see Character for why.
			scale: entry.scale ?? 1,
			onRig: reportRig(entry.id),
			pickId: index === 0 ? "A" : index === 1 ? "B" : entry.id,
		}];
	}), [characters, activeChar.id, motion]);
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
		const clip = motion;
		return { position: clip ? [clip.anchorX, entry.y ?? 0, clip.anchorZ] : [entry.x, entry.y ?? 0, entry.z] };
	}, [characters, activeChar.id, motion, selectedHierarchyId]);
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
			rotY: entry?.rot ?? 0,
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
	useEffect(() => {
		const previous = loadedLayerCharRef.current;
		if (previous === activeChar.id) return;
		// Leaving IK on switch: the handles are re-seated per rig, and a
		// half-dragged chain must never leak onto another character.
		if (ikMode) leaveIkMode();
		if (previous) {
			ikStatesRef.current.set(previous, bufferRef.current.ik);
			setCharacters((list) => list.map((entry) => entry.id === previous
				? { ...entry, layer: { waypoints: bufferRef.current.waypoints, promptClips: bufferRef.current.promptClips }, sessionMotion: bufferRef.current.motion }
				: entry));
		}
		const layer = activeChar.layer ?? createCharacterLayer();
		setWaypoints(layer.waypoints.map((waypoint) => ({ ...waypoint })));
		setPromptClips(layer.promptClips.map((clip) => ({ ...clip })));
		// A clip that arrived while this character was inactive (an extra
		// extraction take, a restored motionRef, a queued generation) becomes
		// trimmable the moment it enters the buffer. Seed only when absent: an
		// existing entry is the UNTRIMMED take, and the buffer may be holding a
		// cut view of it.
		if (activeChar.sessionMotion && !motionFullRef.current.has(activeChar.id)) {
			motionFullRef.current.set(activeChar.id, activeChar.sessionMotion);
		}
		setMotion(activeChar.sessionMotion ?? null);
		setSelectedPromptId(null);
		setWaypointMode(false);
		setActiveWaypointId(null);
		setPendingWaypointFrame(null);
		ikStateRef.current = ikStatesRef.current.get(activeChar.id) ?? createIkState();
		loadedLayerCharRef.current = activeChar.id;
	}, [activeChar.id]);
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
		setKeyLight((current) => createKeyLight({
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

	function applyExportFrame(frame) {
		// Props on a travel path read this ref inside their own useFrame, so a
		// recorded frame shows the same placement the preview would.
		propFrameRef.current = frame;
		for (const entry of characters) {
			const clip = entry.id === activeChar.id ? motion : entry.sessionMotion;
			// Every cast member's OWN IK corrections ride its export frames (#77)
			// — the active one from the live state, the rest from their stored
			// layer states, exactly as the viewport applies them.
			const state = entry.id === activeChar.id ? ikStateRef.current : ikStatesRef.current.get(entry.id);
			poseMemberAtFrame(rigs[entry.id], clip, state, frame, IK_CORRECTION_BLEND_FRAMES);
		}
		// The bones for this frame are now written, so a carried prop can take
		// its place on them. gl.render() never runs the r3f frame loop, so this
		// pass is the recorder's stand-in for the useFrame the preview gets.
		propSyncRef.current?.();
		const sampled = sampleAt(playbackScene, shotAtFrame(shots, frame), frame);
		const cam = shotCamRef.current;
		if (cam && sampled.camera) {
			cam.position.set(sampled.camera.pos.x, sampled.camera.pos.y, sampled.camera.pos.z);
			cam.rotation.order = "YXZ";
			cam.rotation.set(sampled.camera.pitch, sampled.camera.yaw, 0);
			look.current.yaw = sampled.camera.yaw;
			look.current.pitch = sampled.camera.pitch;
			cam.fov = sampled.camera.fovDeg;
			cam.updateProjectionMatrix();
		}
		return captureRef.current?.render() ?? null;
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

	async function runShotExport({ startFrame = 0, endFrame, download = true } = {}) {
		if (recRef.current) throw new Error(ko("An export is already running", "이미 내보내기 중입니다"));
		if (!captureRef.current || !shotCamRef.current) throw new Error(ko("The shot renderer is not ready", "샷 렌더러가 아직 준비되지 않았어요"));
		const resolvedEndFrame = endFrame ?? Math.max(0, currentRecordFrameCount() - 1);
		const controller = new AbortController();
		const rec = { controller };
		recRef.current = rec;
		setRecState("recording");
		const cam = shotCamRef.current;
		const cameraSnapshot = {
			position: cam.position.clone(),
			quaternion: cam.quaternion.clone(),
			rotationOrder: cam.rotation.order,
			fov: cam.fov,
			yaw: look.current.yaw,
			pitch: look.current.pitch,
		};
		const rigSnapshots = Object.values(rigs).filter(Boolean).map((rig) => ({ rig, bones: snapshotPlaybackBones(rig) }));
		try {
			const result = await exportOffscreenVideo({
				startFrame,
				endFrame: resolvedEndFrame,
				fps: TIMELINE_FPS,
				width: shotOutput.width,
				height: shotOutput.height,
				capture: applyExportFrame,
				signal: controller.signal,
			});
			if (download) {
				const slate = (moveSequence?.slate ?? "shot").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "") || "shot";
				const name = `cozyclay-${slate}.mp4`;
				const url = URL.createObjectURL(result.blob);
				const anchor = document.createElement("a");
				anchor.href = url;
				anchor.download = name;
				anchor.click();
				setTimeout(() => URL.revokeObjectURL(url), 10_000);
				setRecordedVideoName(name);
				setToast(isKo ? `${name} 저장됨 · ${result.frameCount}프레임` : `Saved ${name} · ${result.frameCount} frames`);
			}
			return result;
		} finally {
			for (const snapshot of rigSnapshots) restorePlaybackBones(snapshot.rig, snapshot.bones);
			cam.position.copy(cameraSnapshot.position);
			cam.rotation.order = cameraSnapshot.rotationOrder;
			cam.quaternion.copy(cameraSnapshot.quaternion);
			cam.fov = cameraSnapshot.fov;
			cam.updateProjectionMatrix();
			look.current.yaw = cameraSnapshot.yaw;
			look.current.pitch = cameraSnapshot.pitch;
			if (recRef.current === rec) recRef.current = null;
			setRecState("idle");
		}
	}

	function stopShotRecording() {
		recRef.current?.controller.abort();
	}

	function toggleShotRecording() {
		if (recRef.current) {
			stopShotRecording();
			return;
		}
		runShotExport().then(() => track("export:video_succeeded", { format: "mp4" })).catch((error) => {
			if (error?.name !== "AbortError") setToast(error?.message || String(error));
		});
	}

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

	function captureCurrentFraming() {
		const cam = shotCamRef.current;
		const pos = cam ? cam.position : cameraPos;
		return captureFraming({ pos: { x: pos.x, y: pos.y, z: pos.z }, yaw: look.current.yaw, pitch: look.current.pitch, fovDeg });
	}

	// Key authoring lives in each unified Shot block's lower key strip: clicking
	// an empty point stores the CURRENT framing there. Re-keying overwrites it.
	function addCameraKeyframe(frame, shotId = activeShot?.id) {
		const framing = captureCurrentFraming();
		const target = Math.max(0, Math.min(Math.round(frame), tlFrameCount - 1));
		// Out-of-range keys are dropped by the updater below; only a key that will
		// actually land gets a Ctrl+Z entry.
		const owner = shots.find((entry) => entry.id === shotId);
		const lands = Boolean(owner) && target >= owner.startFrame && target <= owner.endFrame;
		if (lands) {
			markCraftAction("camera_key");
			recordShotUndo();
			setShots((current) => updateStableItem(current, shotId, (shot) => {
				if (target < shot.startFrame || target > shot.endFrame) return shot;
				const replaced = shot.cameraKeys.filter((key) => key.frame !== target);
				return { ...shot, cameraKeys: [...replaced, { id: createStableItemId("camera-key"), frame: target, framing }].sort((a, b) => a.frame - b.frame) };
			}, "shots"));
		}
		setSelectedHierarchyId("camera");
	}

	// Re-time a key by dragging its dot along the lane. Landing on another
	// key's frame is rejected — keys stay frame-unique.
	function moveCameraKeyframe(shotId, keyId, from, to) {
		const shot = shots.find((entry) => entry.id === shotId);
		if (!shot) throw new Error(`Unknown shots ID: ${shotId}`);
		const target = Math.max(shot.startFrame, Math.min(Math.round(to), shot.endFrame));
		if (target === from) return;
		setShots((current) => updateStableItem(current, shotId, (entry) => ({ ...entry, cameraKeys: moveCameraKey(entry.cameraKeys, keyId, target) }), "shots"));
	}

	function removeCameraKeyframe(shotId, keyId) {
		const owner = shots.find((shot) => shot.id === shotId);
		if (!owner) throw new Error(`Unknown shots ID: ${shotId}`);
		if (!owner.cameraKeys.some((key) => key.id === keyId)) return;
		recordShotUndo();
		setShots((current) => updateStableItem(current, shotId, (shot) => ({ ...shot, cameraKeys: removeCameraKey(shot.cameraKeys, keyId) }), "shots"));
	}

	function clearMove() {
		setMovePlaying(false);
		if (!activeShot || activeShot.cameraKeys.length === 0) return;
		recordShotUndo();
		setShots((current) => updateStableItem(current, activeShot?.id, (shot) => ({ ...shot, cameraKeys: [] }), "shots"));
	}

	function addTimelineShot() {
		setMovePlaying(false);
		const next = addShotAtFrame(shots, tlFrame, tlFrameCount, captureCurrentFraming());
		if (next === shots) return;
		recordShotUndo();
		setShots(next);
	}

	function splitTimelineShot(shotId) {
		setMovePlaying(false);
		const shot = shots.find((entry) => entry.id === shotId);
		if (!shot) throw new Error(`Unknown shots ID: ${shotId}`);
		if (tlFrame <= shot.startFrame || tlFrame > shot.endFrame) return;
		const next = cutAtFrame(shots, shotId, tlFrame, captureCurrentFraming());
		if (next === shots) return;
		recordShotUndo();
		setShots(next);
	}

	function selectTimelineShot(shotId) {
		const selected = shots.find((entry) => entry.id === shotId);
		if (!selected) throw new Error(`Unknown shots ID: ${shotId}`);
		manualCameraOverrideRef.current = false;
		setTlFrame(selected.startFrame);
		setSelectedHierarchyId("camera");
	}

	function duplicateTimelineShot(shotId) {
		const next = duplicateShot(shots, shotId, tlFrameCount);
		if (next !== shots) recordShotUndo();
		setShots(next);
		if (next !== shots) {
			const duplicate = next.find((shot) => shot.id !== shotId && !shots.some((existing) => existing.id === shot.id));
			if (duplicate) setTlFrame(duplicate.startFrame);
		}
	}

	function moveTimelineShot(shotId, targetFrame) {
		const next = reorderShot(shots, shotId, targetFrame, tlFrameCount);
		if (next === shots) return;
		recordShotUndo();
		setShots(next);
	}

	function removeTimelineShot(shotId) {
		const next = removeShot(shots, shotId);
		if (next === shots) return;
		recordShotUndo();
		setShots(next);
	}

	// The library is the user's own material: poses read from photographs and
	// poses saved off the rig, accumulating across sessions and projects. No
	// presets ship in it — DEFAULT_POSE is the character's spawn state, not a
	// library entry.
	const allPoses = customPoses;
	// The dropdowns must be able to show and re-select the pose a character is
	// actually in, and a fresh character is in the default — which is not a
	// library entry. An empty library would otherwise render a blank select.
	const selectablePoses = useMemo(() => [DEFAULT_POSE, ...customPoses], [customPoses]);
	// The pose studio follows the character it was opened for: `posing` is a
	// charId, so every cast member gets the same studio, not just the first two.
	const posingIndex = characters.findIndex((entry) => entry.id === posing);
	const posingChar = posingIndex >= 0 ? characters[posingIndex] : null;
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
	const rigSelection = parseRigNodeId(selectedHierarchyId);
	const isRigSelection = rigSelection !== null;
	const inspectorHasContent = isSceneSelection || isCameraSelection || isCharacterSelection || isRigSelection
		|| selectedHierarchyId === "environment" || selectedHierarchyId === "props" || selectedHierarchyId === "light" || Boolean(selectedSceneObject);

	const posedRig = () => rigs[posing] ?? null;
	const setPosed = (pose) => {
		if (posingIndex >= 0) updateCharacterAt(posingIndex, { pose: typeof pose === "function" ? pose(posingChar?.pose ?? DEFAULT_POSE) : pose });
	};

	/* ------------------------- waypoint workspace --------------------------- */

	// A walking pace turns clicked distance into clip time, so pins land at
	// frames the character can actually reach without ice-skating.
	const WALK_SPEED_MPS = 1.4;
	const ROOT_ROOM_LIMIT = 11;
	const clampRootPosition = (value) => Math.max(-ROOT_ROOM_LIMIT, Math.min(ROOT_ROOM_LIMIT, value));
	// Frame 0 of a root path is the ACTIVE character's spot — each layer's
	// path starts from its own cast member.
	const rootStart = () => ({ frame: 0, x: activeChar.x, z: activeChar.z });

	function validateWaypointAt(ordered, index, candidate) {
		const previous = index > 0 ? ordered[index - 1] : rootStart();
		const beforePrevious = index > 1 ? ordered[index - 2] : null;
		const inbound = judgeNextWaypoint(previous, candidate, tlFps, beforePrevious);
		if (!inbound.ok) return inbound;
		const next = ordered[index + 1];
		if (!next) return inbound;
		const outbound = judgeNextWaypoint(candidate, next, tlFps, previous);
		if (!outbound.ok) return outbound;
		return { ok: true, warnings: [...inbound.warnings, ...outbound.warnings] };
	}

	function queueRootWaypointFrame(frame) {
		const target = Math.max(1, Math.min(Math.round(frame), tlFrameCount - 1));
		const existing = waypoints.find((waypoint) => waypoint.frame === target);
		if (existing) {
			setActiveWaypointId(existing.id);
			setPendingWaypointFrame(null);
			setTlFrame(target);
			setWaypointMode(true);
			selectActiveCharacterInHierarchy();
			setToast(isKo ? `프레임 ${target}의 루트 웨이포인트를 선택했어요. 탑뷰에서 점을 드래그해 위치를 조정하세요.` : `Root waypoint at frame ${target} selected — drag the pin in the Top-View to reposition.`);
			return;
		}
		setPendingWaypointFrame(target);
		setActiveWaypointId(null);
		setTlFrame(target);
		setWaypointMode(true);
		selectActiveCharacterInHierarchy();
		setToast(isKo ? `프레임 ${target}이 예약됐어요. 샷 뷰 바닥을 클릭하면 그 위치에 루트 웨이포인트가 생성됩니다.` : `Frame ${target} is reserved — click the Shot-view floor to drop the root waypoint there.`);
	}
	/** ARDY-demo style authoring: each empty-floor press in the Shot view drops
	    the next waypoint where it was clicked; the frame gap comes from walking
	    distance. The bird's-eye board selects and drags existing waypoints. */
	function addFloorWaypoint(point) {
		const x = clampRootPosition(point.x);
		const z = clampRootPosition(point.z);
		const ordered = [...waypoints].sort((a, b) => a.frame - b.frame);
		const last = ordered[ordered.length - 1] ?? rootStart();
		if (waypoints.length + 1 > MAX_WAYPOINTS) {
			setToast(isKo ? `루트 경로는 웨이포인트 ${MAX_WAYPOINTS}개까지 사용할 수 있어요` : `The root path is capped at ${MAX_WAYPOINTS} waypoints`);
			return;
		}
		const pendingFrame = pendingWaypointFrame == null ? null : Math.max(1, Math.min(Math.round(pendingWaypointFrame), tlFrameCount - 1));
		if (pendingFrame != null && ordered.some((waypoint) => waypoint.frame === pendingFrame)) {
			setToast(isKo ? `프레임 ${pendingFrame}에는 이미 루트 웨이포인트가 있어요. 타임라인에서 빈 프레임을 선택하세요.` : `Frame ${pendingFrame} already has a root waypoint — pick an empty frame on the timeline.`);
			setPendingWaypointFrame(null);
			return;
		}
		// A scrubbed playhead is an explicit statement of time: a click lands on
		// that exact frame. An untouched playhead (it snaps to the last pin
		// after every placement) falls back to walking-distance pacing.
		const playhead = Math.round(tlFrame);
		const pinned = pendingFrame != null || playhead > last.frame;
		const walkGap = Math.max(8, Math.round((Math.hypot(x - last.x, z - last.z) / WALK_SPEED_MPS) * tlFps));
		const frame = pendingFrame ?? (pinned ? Math.min(playhead, tlFrameCount - 1) : last.frame + walkGap);
		if (frame > tlFrameCount - 1) {
			setToast(ko("The path already fills the clip — extend the duration or clear a waypoint", "경로가 이미 클립 길이를 채웠어요. 시간을 늘리거나 웨이포인트를 지워 주세요"));
			return;
		}
		// The generator cannot refuse an impossible pin, so the click is the
		// last moment a human can: block out-of-band legs with the fix named.
		const insertAt = ordered.findIndex((waypoint) => waypoint.frame > frame);
		const index = insertAt === -1 ? ordered.length : insertAt;
		const waypoint = { id: createStableItemId("waypoint"), frame, x, z, heading: null };
		const nextWaypoints = [...ordered.slice(0, index), waypoint, ...ordered.slice(index)];
		const verdict = validateWaypointAt(nextWaypoints, index, waypoint);
		if (!verdict.ok) {
			setToast(isKo ? `배치하지 못했어요 — ${verdict.error}` : `Not placed — ${verdict.error}`);
			return;
		}
		// Past every refusal: the waypoint is going down, so the pre-drop path is
		// worth one Ctrl+Z entry.
		recordCharacterUndo();
		setWaypoints(nextWaypoints);
		setTlFrame(frame);
		setActiveWaypointId(waypoint.id);
		setPendingWaypointFrame(null);
		const placed = isKo
			? `루트 웨이포인트 ${index + 1} 추가: 프레임 ${frame}${pendingFrame != null ? " (타임라인 예약 프레임)" : pinned ? " (재생 헤드 위치)" : ` (~${(frame / tlFps).toFixed(1)}초 걷기 기준)`}`
			: `Waypoint ${ordered.length + 1} — frame ${frame} ${pendingFrame != null ? "(at the reserved frame)" : pinned ? "(at the playhead)" : `(~${(frame / tlFps).toFixed(1)}s at a walk)`}`;
		setToast(verdict.warnings.length ? `${placed} · ⚠ ${verdict.warnings[0]}` : placed);
	}

	function moveWaypoint(id, x, z) {
		const ordered = [...waypoints].sort((a, b) => a.frame - b.frame);
		const index = ordered.findIndex((waypoint) => waypoint.id === id);
		if (index === -1) throw new Error(`Unknown waypoints ID: ${id}`);
		const nextWaypoint = {
			...ordered[index],
			x: clampRootPosition(x),
			z: clampRootPosition(z),
		};
		const nextOrdered = ordered.map((waypoint) => waypoint.id === id ? nextWaypoint : waypoint);
		const verdict = validateWaypointAt(nextOrdered, index, nextWaypoint);
		if (!verdict.ok) {
			setToast(isKo ? `이 위치는 루트 경로에 맞지 않아요: ${verdict.error}` : `This position doesn't fit the root path: ${verdict.error}`);
			return;
		}
		setWaypoints(nextOrdered);
		setActiveWaypointId(id);
		setPendingWaypointFrame((current) => (current === nextWaypoint.frame ? null : current));
		if (verdict.warnings.length) setToast(isKo ? `루트 웨이포인트 이동됨: ${verdict.warnings[0]}` : `Root waypoint moved: ${verdict.warnings[0]}`);
	}

	function removeWaypoint(id) {
		const waypoint = waypoints.find((entry) => entry.id === id);
		if (!waypoint) throw new Error(`Unknown waypoints ID: ${id}`);
		recordCharacterUndo();
		setWaypoints((prev) => removeStableItem(prev, id, "waypoints"));
		setActiveWaypointId((current) => (current === id ? null : current));
		setPendingWaypointFrame((current) => (current === waypoint.frame ? null : current));
	}

	function toggleWaypointMode() {
		const next = !waypointMode;
		// Both modes want the viewport pointer; the last one switched on wins,
		// the other stands down rather than fighting for pointerdown.
		if (next && lineEditMode) exitLineEditMode();
		setWaypointMode(next);
		if (!next) {
			setPendingWaypointFrame(null);
			setToast(ko("2D Root path constraints off", "2D 루트 경로 제약 꺼짐"));
			return;
		}

		setToast(ko("2D Root path on — click the set floor in the Shot view to drop waypoints; Subject 1 is the frame 0 start", "2D 루트 경로 켜짐 — 샷 뷰의 세트 바닥을 클릭해 웨이포인트를 놓으세요. 인물 1이 0프레임 시작점입니다"));
	}

	function advanceFrame(steps = 1) {
		const count = Math.max(1, Math.floor(steps));
		const previewEnd = cameraPreviewEndRef.current;
		if (previewEnd != null && tlFrameRef.current + count >= previewEnd) {
			cameraPreviewEndRef.current = null;
			setTlFrame(previewEnd);
			setTlPlaying(false);
			return;
		}
		setTlFrame((f) => (f + count) % frameCountRef.current);
	}

	function stepFrame(delta) {
		setTlFrame((f) => Math.max(0, Math.min(f + delta, frameCountRef.current - 1)));
	}

	/* --------------------------- motion playback ---------------------------- */

	function leaveIkMode() {
		setIkMode(false);
		setIkFocus(null);
	}

	/** Hand `rig` over to playback. Every path that starts a clip — a loaded
	 *  take, a browser-baked one — does the same two things: drop out of IK
	 *  EDIT mode (playback is the new context; the IK KEYS stay and keep
	 *  correcting the clip layer-style) and swap the pre-playback bone
	 *  baseline, so a re-load never snapshots mid-animation and clearing
	 *  always returns to the blocking pose. */
	function beginPlaybackOn(rig) {
		leaveIkMode();
		const previous = restoreRef.current;
		restoreRef.current = null;
		if (previous) restorePlaybackBones(previous.rig, previous.bones);
		restoreRef.current = { rig, bones: snapshotPlaybackBones(rig) };
	}

	/* ---------------------------- video capture ----------------------------
	 * Footage in, takes out. The ingest downloads and decodes a source so the
	 * timeline is sized by what was actually read; extraction then turns it
	 * into one take per tracked performer. Take 0 belongs to the ACTIVE
	 * character's layer, the rest are landed on their own cast members. */

	// A picked file is already local bytes: no download stage, straight to the
	// probe that produces the timeline numbers.
	function chooseMultiModelFile(event) {
		const file = event.target.files?.[0] ?? null;
		if (!file) return;
		setMultiModelUrl("");
		ingestFootage({ kind: "file", name: file.name, blob: file, bytes: file.size });
	}

	async function pasteMultiModelUrl() {
		try {
			const text = await navigator.clipboard.readText();
			if (!text.trim()) return;
			setMultiModelUrl(text.trim());
			setMultiModelStatus("idle");
		} catch {
			setToast(isKo ? "클립보드를 읽지 못했어요 — 직접 붙여넣어 주세요" : "Clipboard is unavailable — paste into the field directly");
		}
	}

	function useMultiModelUrl() {
		const raw = multiModelUrl.trim();
		// A platform page (YouTube, Vimeo, …) is never browser-fetchable, but
		// the dev bridge can fetch it server-side. With the bridge up the
		// address goes there; without it the named refusal below stands.
		if (isPlatformPageUrl(raw) && bridge?.ok) {
			ingestPlatformFootage(raw);
			return;
		}
		const normalized = normalizeSourceUrl(raw);
		if (!normalized.ok) {
			setMultiModelStatus("error");
			setMultiModelStage("error");
			setMultiModelError(MULTIMODEL_REASONS[normalized.reason]?.[isKo ? 1 : 0] ?? normalized.reason);
			return;
		}
		ingestFootage({ kind: "url", name: sourceLabel(normalized.url), url: normalized.url });
	}

	/** Platform page → bridge download (yt-dlp + normalize) → the local
	 *  /ardy/footage/… address rides the ordinary ingest unchanged. */
	async function ingestPlatformFootage(pageUrl) {
		const run = multiModelRunRef.current + 1;
		multiModelRunRef.current = run;
		const live = () => multiModelRunRef.current === run;
		setMultiModelSource({ kind: "url", name: sourceLabel(pageUrl), url: pageUrl });
		setMultiModelFootage(null);
		setMultiModelError("");
		setMultiModelStatus("busy");
		setMultiModelStage("fetching");
		setMultiModelProgress(null);
		setMultiModelTake(null);
		setMultiModelExtract("idle");
		setMultiModelExtractProgress(null);
		setMultiModelExtractError("");
		try {
			const footage = await requestBridgeFootage(pageUrl, {
				onProgress: ({ ratio }) => {
					if (live()) setMultiModelProgress(Number.isFinite(ratio) ? ratio : null);
				},
			});
			if (!live()) return;
			ingestFootage({ kind: "url", name: footage.title || sourceLabel(pageUrl), url: footage.url, fps: footage.fps, bridgeId: footage.footage ?? null });
		} catch (error) {
			if (!live()) return;
			const code = error?.message ?? String(error);
			setMultiModelStage("error");
			setMultiModelStatus("error");
			setMultiModelProgress(null);
			setMultiModelError(MULTIMODEL_REASONS[code]?.[isKo ? 1 : 0] ?? code);
		}
	}

	/** Download (when remote), decode, measure, then size the timeline from what
	 *  was actually read. Each run carries a token so a slow first source can
	 *  never land its numbers after a second one replaced it. */
	async function ingestFootage(source) {
		const run = multiModelRunRef.current + 1;
		multiModelRunRef.current = run;
		const live = () => multiModelRunRef.current === run;
		setMultiModelSource(source);
		setMultiModelFootage(null);
		setMultiModelError("");
		setMultiModelStatus("busy");
		setMultiModelProgress(null);
		// A take baked from the PREVIOUS clip must not read as this one's
		// result, so the extraction state resets with the source.
		setMultiModelTake(null);
		setMultiModelExtract("idle");
		setMultiModelExtractProgress(null);
		setMultiModelExtractError("");
		try {
			let blob = source.blob ?? null;
			let bytes = source.bytes ?? 0;
			if (!blob) {
				setMultiModelStage("fetching");
				const downloaded = await fetchFootageBlob(source.url, {
					onProgress: ({ ratio }) => {
						if (live()) setMultiModelProgress(ratio);
					},
				});
				if (!live()) return;
				blob = downloaded.blob;
				bytes = downloaded.bytes;
			}
			setMultiModelStage("probing");
			if (multiModelObjectUrlRef.current) URL.revokeObjectURL(multiModelObjectUrlRef.current);
			const objectUrl = URL.createObjectURL(blob);
			multiModelObjectUrlRef.current = objectUrl;
			const probed = await probeFootage(objectUrl, {
				createVideo: () => document.createElement("video"),
				// The bridge normalized the clip and DECLARED its rate; a probe
				// that re-guesses it would overrule a measurement with a guess.
				knownFps: Number.isFinite(source.fps) ? source.fps : null,
			});
			if (!live()) return;
			const footage = { ...probed, bytes, objectUrl, blob, bridgeId: source.bridgeId ?? null };
			setMultiModelFootage(footage);
			setMultiModelStage("ready");
			setMultiModelStatus("ready");
			setMultiModelProgress(1);
			// The timeline is the point: the playhead now spans the footage that
			// was actually decoded, at the rate that was actually measured.
			setTlFps(footage.fps);
			setTlFrameCount(footage.frames);
			setTlFrame(0);
			setTlPlaying(false);
			setToast(isKo
				? `${source.name} 인제스트됨 — ${footage.frames}프레임 @ ${footage.fps} fps`
				: `Ingested ${source.name} — ${footage.frames} frames @ ${footage.fps} fps`);
		} catch (error) {
			if (!live()) return;
			const code = error?.message ?? String(error);
			setMultiModelStage("error");
			setMultiModelStatus("error");
			setMultiModelProgress(null);
			setMultiModelError(MULTIMODEL_REASONS[code]?.[isKo ? 1 : 0] ?? code);
		}
	}

	/** Extract motion from the ingested footage. With the bridge up this goes
	 *  to the GPU box (SAM-3D-Body: whole-clip temporal context, real 3D body
	 *  prior — previs-grade). Without it, the browser MediaPipe path below
	 *  still works offline as the rough-blocking fallback. */
	async function extractMultiModelMotion() {
		if (bridge?.ok) return extractMultiModelMotionGpu();
		return extractMultiModelMotionBrowser();
	}

	async function extractMultiModelMotionGpu() {
		const footage = multiModelFootage;
		if (!footage || multiModelExtract === "running") return;
		const run = multiModelRunRef.current;
		const live = () => multiModelRunRef.current === run;
		setMultiModelExtract("running");
		setMultiModelExtractProgress(null);
		setMultiModelExtractError("");
		setMultiModelTake(null);
		try {
			const done = await requestBridgeExtract(
				footage.bridgeId ? { footage: footage.bridgeId } : footage.blob,
				{
					onProgress: ({ ratio }) => {
						if (live()) setMultiModelExtractProgress(Number.isFinite(ratio) ? ratio : null);
					},
				}
			);
			if (!live()) return;
			// One take per tracked performer. An older bridge sends a single
			// motionUrl and no list; that is the same thing with one entry.
			const takes = Array.isArray(done.takes) && done.takes.length
				? done.takes
				: [{ motionUrl: done.motionUrl, personScale: done.personScale, offsetX: 0, offsetZ: 0 }];
			const label = multiModelSource?.name ?? "extracted take";
			// The cast can change while the GPU works, so the destination is read
			// now, once, and every take is placed against THIS character.
			const active = charactersRef.current.find((entry) => entry.id === activeChar.id) ?? activeChar;
			// Take 0 arrives as an ordinary motion npz; loadMotion decodes,
			// retimes to the 24 fps timeline, snapshots the rig baseline and
			// applies the stature stored in the take itself — the body matches
			// the FILMED person because the file carries the measurement, not
			// because this handler remembered to re-apply it afterwards.
			let personScale = await loadMotion(takes[0].motionUrl ?? done.motionUrl, label, active.rot);
			if (!live()) return;
			// loadMotion reports the stature it applied — 1 for a take that
			// stores none, nothing at all if the load failed. A failed load is
			// not a finished extraction: say so with the named reason instead
			// of a receipt for a take nobody can play.
			if (!Number.isFinite(personScale)) throw new Error("extract-convert-failed");
			// Only a take that stores NO stature gets the fallback for an npz
			// that predates person_scale (or an older bridge): the response
			// still carries the estimate, clamped the same way, because a bad
			// leg estimate must never produce a giant or a gnome.
			const declared = Number.isFinite(takes[0].personScale) ? takes[0].personScale : done.personScale;
			if (personScale === 1 && Number.isFinite(declared)) {
				personScale = characterScaleFor(null, declared);
			}
			// The clip itself is session-only; this reference is what a save
			// keeps and restoreMotionRefs re-fetches on the next session.
			const leadRef = {
				url: takes[0].motionUrl ?? done.motionUrl,
				prompt: label,
				rotationDeg: active.rot,
				anchorX: active.x,
				anchorZ: active.z,
			};
			setCharacters((list) => list.map((entry) => entry.id === active.id
				? { ...entry, scale: personScale, motionRef: leadRef }
				: entry));
			const placed = await deliverExtraTakes(takes.slice(1), active, label);
			if (!live()) return;
			const persons = 1 + placed;
			setMultiModelTake({ frames: done.frames, fps: done.fps, gpu: true, personScale, persons, trajectory: done.performance?.trajectory });
			setMultiModelExtract("done");
			setToast(isKo
				? `GPU 모션 추출됨 — ${done.frames}프레임 @ ${done.fps} fps${persons > 1 ? ` · ${persons}명` : ""} · 인물 스케일 ×${personScale.toFixed(2)}`
				: `GPU motion extracted — ${done.frames} frames @ ${done.fps} fps${persons > 1 ? ` · ${persons} performers` : ""} · person scale ×${personScale.toFixed(2)}`);
		} catch (error) {
			if (!live()) return;
			const code = error?.message ?? String(error);
			setMultiModelExtract("error");
			setMultiModelExtractError(MULTIMODEL_REASONS[code]?.[isKo ? 1 : 0] ?? code);
		}
	}

	/** Land takes 1..N-1 on the rest of the cast. Each extra take is its OWN
	 *  layer: it goes to that entry's sessionMotion, NOT through the editing
	 *  buffer, which holds the active character's clip alone. Returns how many
	 *  performers actually landed. */
	async function deliverExtraTakes(extras, active, label) {
		const decoded = await Promise.all(extras.map(async (take, index) => {
			if (typeof take?.motionUrl !== "string" || !take.motionUrl) return null;
			try {
				// Inbound boundary, exactly like every other clip: decode, then
				// retime onto the production clock before anything counts frames.
				const clip = retimeMotion(await loadMotionFromUrl(take.motionUrl), TIMELINE_FPS);
				const anchor = takeAnchor(active, take.offsetX, take.offsetZ);
				return {
					url: take.motionUrl,
					prompt: `${label} · ${index + 2}`,
					rotationDeg: active.rot,
					anchor,
					// A second performer is a DIFFERENT body: their take carries
					// their own stature, and the response estimate is only the
					// fallback for an npz that stores none.
					scale: characterScaleFor(clip, take.personScale),
					clip,
				};
			} catch {
				return null; // one unreadable take never voids the others
			}
		}));
		const usable = decoded.filter(Boolean);
		if (!usable.length) return 0;
		recordCharacterUndo();
		// Plan against the cast as it stands, so ids are decided once and the
		// full-take map can be seeded with them.
		const list = charactersRef.current;
		const taken = new Set([active.id]);
		let idPool = list;
		const assignments = usable.map((take) => {
			// Reuse a visible cast member with no clip of its own before adding
			// another body to the set.
			const reuse = list.find((entry) => !entry.hidden && !taken.has(entry.id) && !entry.sessionMotion && !entry.motionRef);
			const id = reuse ? reuse.id : nextCharacterId(idPool);
			if (!reuse) idPool = [...idPool, { id }];
			taken.add(id);
			return {
				id,
				spawn: !reuse,
				patch: {
					hidden: false,
					x: take.anchor.x,
					z: take.anchor.z,
					rot: take.rotationDeg,
					scale: take.scale,
					motionRef: {
						url: take.url,
						prompt: take.prompt,
						rotationDeg: take.rotationDeg,
						anchorX: take.anchor.x,
						anchorZ: take.anchor.z,
					},
					sessionMotion: {
						...take.clip,
						url: take.url,
						prompt: take.prompt,
						anchorX: take.anchor.x,
						anchorZ: take.anchor.z,
						anchorFrame: 0,
						rotationDeg: take.rotationDeg,
						editSegments: createMotionEdit(take.clip.frames),
					},
				},
			};
		});
		setCharacters((current) => {
			let next = current;
			for (const { id, spawn, patch } of assignments) {
				next = spawn && !next.some((entry) => entry.id === id)
					? [...next, { ...createCharacterEntry({ id, model: active.model, pose: DEFAULT_POSE, subject: "a person" }, next.length), ...patch }]
					: next.map((entry) => (entry.id === id ? { ...entry, ...patch } : entry));
			}
			return next;
		});
		// Their takes are trimmable the moment they become the active layer.
		for (const { id, patch } of assignments) motionFullRef.current.set(id, patch.sessionMotion);
		return assignments.length;
	}

	async function extractMultiModelMotionBrowser() {
		const footage = multiModelFootage;
		if (!footage || multiModelExtract === "running") return;
		const run = multiModelRunRef.current;
		const live = () => multiModelRunRef.current === run;
		setMultiModelExtract("running");
		setMultiModelExtractProgress(null); // indeterminate while the engine spins up
		setMultiModelExtractError("");
		setMultiModelTake(null);
		try {
			if (!multiModelRestRef.current) {
				const response = await fetch("/ardy/cskel27-rest.json").catch(() => null);
				if (!response?.ok) throw new Error("rest-unavailable");
				multiModelRestRef.current = await response.json().catch(() => {
					throw new Error("rest-unavailable");
				});
			}
			if (!multiModelDetectorRef.current) {
				multiModelDetectorRef.current = await createPoseDetector();
			}
			const detector = multiModelDetectorRef.current;
			const total = sampleTimes(footage.durationS, MULTIMODEL_SAMPLE_FPS).length;
			const samples = await collectLandmarkTrack({
				frames: videoFrames(footage.objectUrl, {
					createVideo: () => document.createElement("video"),
					sampleFps: MULTIMODEL_SAMPLE_FPS,
				}),
				detect: detector.detect,
				onProgress: ({ processed }) => {
					if (live()) setMultiModelExtractProgress(total > 0 ? processed / total : null);
				},
			});
			if (!live()) return;
			if (samples.length === 0) throw new Error("no-person-found");
			const take = bakeExtractedTake({
				samples,
				rest: multiModelRestRef.current,
				fps: MULTIMODEL_SAMPLE_FPS,
				durationS: footage.durationS,
				createdMs: Date.now(),
			});
			if (!live()) return;
			const rig = activeRig;
			if (!rig) throw new Error("rig-not-loaded");
			beginPlaybackOn(rig);
			const loaded = {
				prompt: multiModelSource?.name ?? sourceLabel(footage.objectUrl),
				frames: take.frames,
				fps: take.fps,
				rotMats: take.rotMats,
				rootPos: take.rootPos,
				posedJoints: take.posedJoints,
				anchorX: activeChar.x,
				anchorZ: activeChar.z,
				anchorFrame: 0,
				rotationDeg: activeChar.rot,
				editSegments: createMotionEdit(take.frames),
			};
			// A baked take is trimmable like any other: without this the strip's
			// handles would drag against an empty map and cut nothing at all.
			motionFullRef.current.set(activeChar.id, loaded);
			// The browser fallback estimates no stature, and its root travel is
			// in canonical units — so it must not inherit the scale a previous
			// GPU take left on the character.
			setCharacters((list) => list.map((entry) => entry.id === activeChar.id
				? { ...entry, scale: characterScaleFor(take) }
				: entry));
			setMotion(loaded);
			setTlFrameCount(take.frames);
			setTlFps(take.fps);
			setTlFrame(0);
			setTlPlaying(false);
			setMultiModelTake({ frames: take.frames, fitted: take.fitted, held: take.held, sampled: total, accepted: samples.length });
			setMultiModelExtract("done");
			setToast(isKo
				? `모션 추출됨 — ${take.frames}프레임 테이크 @ ${take.fps} fps (실측 ${take.fitted}, 유지 ${take.held})`
				: `Motion extracted — a ${take.frames}-frame take @ ${take.fps} fps (${take.fitted} measured, ${take.held} held)`);
		} catch (error) {
			if (!live()) return;
			const code = error?.message ?? String(error);
			setMultiModelExtract("error");
			setMultiModelExtractError(MULTIMODEL_REASONS[code]?.[isKo ? 1 : 0] ?? code);
		}
	}

	useEffect(() => () => {
		if (multiModelObjectUrlRef.current) URL.revokeObjectURL(multiModelObjectUrlRef.current);
	}, []);

	// Decoded motion + the world anchor: frame 0 always starts at Subject 1.
	// Authored root destinations are generated by ARDY as sparse constraints,
	// so playback consumes the returned trajectory without coordinate warping.
	async function loadMotion(
		url,
		prompt,
		rotationDeg = charA.rot,
		drop = null,
		targetCharacterId = activeChar.id,
		targetPromptClips = null,
		// `preview: true` means "put this clip on screen, do not treat it as a
		// new take". The line-edit preview loop swaps the viewport several times
		// a minute, and every announcement this function normally makes — the
		// load toast, the auto-drop toast, clearing the IK keys, snapping the
		// playhead back to 0 — is an announcement about a take CHANGING. A
		// preview is the same take seen a second time, so it makes none of them.
		{ preview = false } = {},
	) {
		setMotionBusy(true);
		setMotionError("");
		try {
			// Inbound boundary: an ARDY take (20 fps) or a filmed one (30/60)
			// becomes a production-clock clip here, once, before anything on
			// the timeline counts its frames. Same-rate input rides through.
			// A drop is staging applied to the clip itself, so it happens at
			// the same boundary — trims and IK then see the dropped take.
			const raw = retimeMotion(await loadMotionFromUrl(url), TIMELINE_FPS);
			const targetCharacter = charactersRef.current.find((entry) => entry.id === targetCharacterId);
			if (!targetCharacter) throw new Error(`Motion target ${targetCharacterId} no longer exists.`);
			const rig = rigs[targetCharacter.id] ?? await waitForRig(targetCharacter.id);
			// No explicit drop staged: a character standing on a raised object
			// whose take walks off the edge falls on its own — ARDY motion is
			// flat-ground, so the stage supplies the gravity.
			const staging = drop ?? autoRoofDrop(
				raw,
				{ x: targetCharacter.x, z: targetCharacter.z, y: targetCharacter.y ?? 0, rotationDeg },
				sceneObjects.map((object) => ({
					x: object.x,
					z: object.z,
					rotDeg: object.rot ?? 0,
					topY: (object.y ?? 0) + (object.height ?? 0) * (object.scaleY ?? 1),
					width: (object.footprint?.width ?? 0) * (object.scaleX ?? 1),
					depth: (object.footprint?.depth ?? 0) * (object.scaleZ ?? 1),
				})),
			);
			const decoded = drop ? applyRootDrop(raw, staging) : applyAutoFall(raw, staging);
			if (!drop && staging && !preview) {
				setToast(ko(
					`Auto drop staged: the take leaves its support at ${staging.fromS.toFixed(1)}s and falls ${staging.meters.toFixed(1)}m`,
					`자동 낙하 적용: ${staging.fromS.toFixed(1)}초에 지지면을 벗어나 ${staging.meters.toFixed(1)}m 낙하`,
				));
			}
			const targetStillExists = charactersRef.current.some((entry) => entry.id === targetCharacter.id);
			if (!targetStillExists) throw new Error(`Motion target ${targetCharacterId} no longer exists.`);
			const bufferOwnsTarget = targetCharacter.id === loadedLayerCharRef.current;
			beginPlaybackOn(rig);
			// THE INVARIANT: the take's travel assumes the character is scaled.
			// Extraction divided the root translation by the filmed person's
			// stature, so the clip and that stature have to be applied together
			// or every stride overshoots by the same factor and the feet skate.
			// The scale rides INSIDE the npz, so this one line covers every path
			// that loads a motion; an ARDY-generated take stores none and is
			// canonical, 1.
			const scale = characterScaleFor(decoded);
			const loaded = {
			// Capture the exact prompt this motion was generated from; the
			// timeline keeps showing it even if the input field is edited
			// afterwards.
			prompt: typeof prompt === "string" ? prompt : "",
				...decoded,
				url,
				anchorX: targetCharacter.x,
				anchorZ: targetCharacter.z,
				anchorFrame: 0,
				rotationDeg,
				editSegments: createMotionEdit(decoded.frames),
			};
			setCharacters((list) => {
				const next = list.map((entry) => entry.id === targetCharacter.id
					? {
						...entry,
						scale,
						sessionMotion: loaded,
						layer: targetPromptClips
							? { ...(entry.layer ?? {}), promptClips: targetPromptClips }
							: entry.layer,
					}
					: entry);
				liveStateRef.current.characters = next;
				return next;
			});
			// The take as loaded is what every future trim cuts from.
			motionFullRef.current.set(targetCharacter.id, loaded);
			if (bufferOwnsTarget) {
				setMotion(loaded);
				if (targetPromptClips) setPromptClips(targetPromptClips);
				setTlFrameCount(decoded.frames);
				setTlFps(decoded.fps);
				// A preview keeps the playhead: the artist is watching one beat of
				// the take and wants to see THAT beat change, not to be thrown
				// back to frame 0 every time the box answers.
				if (!preview) {
					setTlFrame(0);
					setTlPlaying(false);
				}
			}
			// IK keys correct SPECIFIC frames of the take they were authored on, so
			// a replacement take leaves them pointing at poses that no longer exist
			// — the same reason a trim clears them. The Full-Body lane would
			// otherwise keep showing corrections that belong to a discarded clip.
			const hadIkKeys = !preview && bufferOwnsTarget && ikStateRef.current.keys.size > 0;
			if (hadIkKeys) {
				ikStateRef.current.keys.clear();
				ikStateRef.current.tracked.clear();
				ikStateRef.current.plants.clear();
				setIkTick((value) => value + 1);
			}
			if (bufferOwnsTarget && !preview) setCommittedIkEdits([]);
			if (!preview) {
				setToast(
					isKo
						? `모션 로드됨: ${decoded.frames}프레임 @ ${decoded.fps} fps${hadIkKeys ? " — 이전 테이크의 IK 키는 초기화됐어요" : ""}`
						: `Motion loaded: ${decoded.frames} frames @ ${decoded.fps} fps${hadIkKeys ? " — IK keys from the previous take were cleared" : ""}`,
				);
			}
			// The applied stature, so a caller does not have to re-derive it
			// (and cannot derive a different one).
			return scale;
		} catch (err) {
			if (targetCharacterId === loadedLayerCharRef.current) setMotion(null);
			setMotionError(err?.message || String(err));
			throw err;
		} finally {
			setMotionBusy(false);
		}
	}

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
	useEffect(() => {
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
		if (!bridge || bridge.ok) return;
		demoSeeded.current = true;
		// Loaded, not played: the clip walks the subject out of the default
		// framing, so autoplay would greet a first-time visitor with an empty
		// room. Frame 0 is composed; PLAYBACK is one click away.
		loadMotion(DEMO_MOTION_URL, DEMO_MOTION_PROMPT).catch(() => {
			/* the seed is a nicety, never a failure the visitor must act on */
		});
	}, [bridge, activeRig, motion, motionBusy]);

	/** Drop the ACTIVE character's take, its IK corrections and the stature the
	 * take imposed. One Ctrl+Z entry brings all three back; nothing to clear
	 * records nothing, so the shortcut never becomes a dead press.
	 *
	 * The pose flows (studio Apply/Reset, pose tiles, photo pose) call this
	 * first and then write the pose: the snapshot taken here predates both, so
	 * one undo restores the take AND the pose it replaced. */
	function clearMotion() {
		if (!motion && ikStateRef.current.keys.size === 0 && (activeChar.scale ?? 1) === 1) return;
		recordCharacterUndo();
		setMotion(null);
		setMotionError("");
		motionFullRef.current.delete(activeChar.id);
		// Corrections belong to the take. With the take gone they would sit on the
		// Full-Body lane describing frames of nothing.
		if (ikStateRef.current.keys.size > 0) {
			ikStateRef.current.keys.clear();
			ikStateRef.current.tracked.clear();
			ikStateRef.current.plants.clear();
			setIkTick((value) => value + 1);
		}
		setCommittedIkEdits([]);
		// A cleared clip leaves the body canonical: the stature belonged to the
		// take, not to the character.
		setCharacters((list) => list.map((entry) => entry.id === activeChar.id ? { ...entry, scale: 1 } : entry));
		// Back to the pre-generation timeline: the current duration on the production clock.
		setTlFrameCount(maxDst + 1);
		setTlFps(TIMELINE_FPS);
		setTlFrame((f) => Math.min(f, maxDst));
		setTlPlaying(false);
	}

	/** Cut the ACTIVE character's take to [start, end] of the CURRENT view.
	 *  Offsets compose, so a second cut still slices the original take; a cut
	 *  take drops its bridge url — its frames no longer match the source npz,
	 *  and IK-edit regeneration must not pretend they do. Per-character layers
	 *  mean the cut lands on this layer only; nobody else's clip moves. */
	function applyMotionTrim(start, end) {
		const full = motionFullRef.current.get(activeChar.id);
		if (!full || !motion) return;
		// One Ctrl+Z entry per edit: the cast snapshot carries the pre-edit clip
		// (snapshotCast → bufferMotion), so undo restores the take as it was.
		recordCharacterUndo();
		const previous = motion.editSegments ?? createMotionEdit(full.frames);
		const segments = trimMotionEdit(previous, start, end);
		const sliced = renderMotionEdit(full, segments);
		// Keys inside the kept range migrate to their new frame numbers (#79);
		// keys on trimmed-away source frames drop out of the mapping naturally.
		// This replaces the old clear-everything fallback.
		migrateTimelinePins(previous, segments, sliced.frames);
		setMotion({ ...sliced, url: null });
		setTlFrameCount(sliced.frames);
		setTlFrame((frame) => Math.min(frame, sliced.frames - 1));
		setTlPlaying(false);
		setToast(isKo
			? `테이크 잘라냄 — ${sliced.frames}프레임`
			: `Take cut to ${sliced.frames} frames`);
	}

	function resetMotionTrim() {
		const full = motionFullRef.current.get(activeChar.id);
		if (!full || !motion || motion.frames === full.frames && motion.editSegments?.length === 1) return;
		recordCharacterUndo();
		// Surviving IK keys ride back to their full-take frame numbers (#79).
		migrateTimelinePins(motion.editSegments ?? createMotionEdit(full.frames), createMotionEdit(full.frames), full.frames);
		setMotion({ ...full, editSegments: createMotionEdit(full.frames) });
		setTlFrameCount(full.frames);
		setTlFrame((frame) => Math.min(frame, full.frames - 1));
		setToast(ko("Full take restored", "테이크 전체 길이 복원"));
	}

	function editMotionSegments(edit) {
		const full = motionFullRef.current.get(activeChar.id);
		if (!full || !motion) return;
		// Covers cut, retime and segment delete alike — every segment edit lands
		// on the same Ctrl+Z history the cast uses (snapshotCast → bufferMotion).
		recordCharacterUndo();
		const rendered = renderMotionEdit(full, edit);
		migrateTimelinePins(motion.editSegments ?? createMotionEdit(full.frames), edit, rendered.frames);
		setMotion({ ...rendered, url: null });
		setTlFrameCount(rendered.frames);
		setTlFrame((frame) => Math.min(frame, rendered.frames - 1));
		setTlPlaying(false);
	}

	/** Everything pinned to TIMELINE frames rides a segment edit's timing
	 * change (#79): a retime moves the poses those frames address, so the IK
	 * correction keys and the prompt clips migrate through the same
	 * old→source→new piecewise mapping the clip itself was resampled with.
	 * Undo needs no special case — recordCharacterUndo() already snapshotted
	 * the keys and clips before this runs. */
	function migrateTimelinePins(previousEdit, nextEdit, newFrameCount) {
		if (ikStateRef.current.keys.size > 0) {
			ikStateRef.current.keys = remapFrameKeyMap(ikStateRef.current.keys, previousEdit, nextEdit);
			setIkTick((value) => value + 1);
		}
		setPromptClips((clips) => clips.map((clip) => {
			const start = remapTimelineFrame(previousEdit, nextEdit, clip.startFrame);
			const end = remapTimelineFrame(previousEdit, nextEdit, clip.endFrame);
			// A clip whose whole source range was deleted drops out; one that
			// partially survives clamps to the new take.
			if (start === null && end === null) return null;
			const clamp = (value, fallback) => Math.max(0, Math.min(value ?? fallback, newFrameCount - 1));
			const nextStart = clamp(start, 0);
			const nextEnd = clamp(end, newFrameCount - 1);
			return nextStart <= nextEnd ? { ...clip, startFrame: nextStart, endFrame: nextEnd } : null;
		}).filter(Boolean));
	}

	function cutMotionAtPlayhead() {
		if (!motion) return;
		const current = motion.editSegments ?? createMotionEdit(motionFullRef.current.get(activeChar.id)?.frames ?? motion.frames);
		const next = splitMotionEdit(current, tlFrame);
		if (next === current) return;
		editMotionSegments(next);
		setToast(ko("Full-Body clip cut at the playhead", "전신 클립을 재생 헤드에서 컷했어요"));
	}

	function changeMotionSegmentSpeed(id, speed) {
		if (!motion) return;
		const current = motion.editSegments ?? createMotionEdit(motionFullRef.current.get(activeChar.id)?.frames ?? motion.frames);
		editMotionSegments(setMotionSegmentSpeed(current, id, speed));
		setToast(ko(`${speed}× speed applied to the selected segment`, `선택한 구간을 ${speed}×로 설정했어요`));
	}

	/** Drop one Full-Body segment from the take. The removal composes like a
	 * trim: the source frames stay untouched, so the trim-reset path (right-click
	 * an outer handle) still restores the whole take. */
	function removeMotionSegmentById(id) {
		if (!motion) return;
		const current = motion.editSegments ?? createMotionEdit(motionFullRef.current.get(activeChar.id)?.frames ?? motion.frames);
		if (current.length <= 1) {
			setToast(ko("The only segment cannot be deleted — use ✕ Motion to clear the take", "마지막 남은 구간은 지울 수 없어요 — ✕ 모션으로 테이크를 비워요"));
			return;
		}
		const next = removeMotionSegment(current, id);
		if (next === current) return;
		editMotionSegments(next);
		setToast(ko("Segment removed — right-click a trim handle to restore the full take", "구간을 지웠어요 — 핸들 우클릭으로 전체 테이크 복원"));
	}

	// Everyone EXCEPT the active character, posed at an absolute frame from
	// their own session clips and their STORED IK corrections (#77). Factored
	// out of the effect below because the whole-clip Fix Collisions pass needs
	// the same thing: the other bodies are static blockers, and a blocker
	// sampled from a rig still standing at the playhead would block the wrong
	// volume on every other frame of the walk.
	const poseOtherCastMembers = (frame) => {
		for (const entry of characters) {
			if (entry.id === activeChar.id) continue;
			poseMemberAtFrame(rigs[entry.id], entry.sessionMotion, ikStatesRef.current.get(entry.id), frame, IK_CORRECTION_BLEND_FRAMES);
		}
	};
	// Drive every cast member from ITS OWN clip on the shared playhead. The
	// active character's buffer motion and the stored session motions of the
	// others all advance together; characters without a clip keep their pose.
	// Without the inactive pass a focus switch silently reverted everyone else
	// to their uncorrected take.
	useEffect(() => {
		// The ACTIVE member's clip only: its own corrections are applied by the
		// evaluate effect below, after its editing state settles.
		poseMemberAtFrame(rigs[activeChar.id], motion, null, tlFrame);
		poseOtherCastMembers(tlFrame);
		// eslint-disable-next-line react-hooks/exhaustive-deps
	}, [characters, activeChar.id, motion, rigs, tlFrame, ikTick]);

	// The shared timeline spans the longest CURRENT content on the production
	// clock. Recomputing both directions matters: deleting Subject 2 or
	// shortening its take must pull the end back in instead of leaving the
	// recorder with frozen tail frames (#80).
	useEffect(() => {
		const extent = timelineContentExtent(
			characters,
			activeChar.id,
			motion,
			promptClips,
			multiModelFootage?.frames,
		);
		if (extent > 0) {
			setTlFrameCount(extent);
			setTlFrame((frame) => Math.min(frame, extent - 1));
		}
	}, [characters, activeChar.id, motion, promptClips, multiModelFootage?.frames]);

	/* ------------------------------ IK logic ------------------------------ */

	// Resolve the IK rig (chains + FK swing joints) whenever the ACTIVE
	// character's rig (re)loads. A rig missing any bone resolves to null and
	// IK mode stays unavailable.
	useEffect(() => {
		const resolved = resolveIkRig(activeRig);
		const chains = resolved ? resolved.chains : null;
		setIkChains(chains);
		setIkFkJoints(resolved ? resolved.fkJoints : null);
		ikStateRef.current.chains = chains;
		// Cached on the state so this character's corrections stay evaluable
		// after a focus switch (#77) — the playback and export loops read them.
		ikStateRef.current.fkJoints = resolved ? resolved.fkJoints : null;
		ikStateRef.current.rig = chains ? activeRig : null;
		if (!chains) leaveIkMode();
	}, [activeRig]);

	// Whether the collision capsules can be built for this rig at all. Bone
	// lookups only — no mesh measurement — so it is cheap enough to hang off
	// the rig identity and read straight in the render. A rig that resolves
	// for IK can still miss the toes/spine the capsule table needs, so this is
	// a SEPARATE question from `ikChains`: the two collision buttons disable
	// on it rather than offering a click whose only possible answer is "not
	// supported".
	const collisionCleanupSupported = useMemo(() => supportsCollisionCleanup(activeRig), [activeRig]);

	function toggleIkMode() {
		const next = !ikMode;
		// Authoring modes are mutually exclusive: IK mode swaps the main pane to
		// the poser camera, which would silently invalidate any pulled path
		// anyway. Leaving the line mode explicitly says so instead.
		if (next && lineEditMode) exitLineEditMode();
		if (next) {
			// Always enter on the safe, detailed IK tool. Trail editing is an
			// explicit second tool and must never leave the regular handles
			// locked when the user re-enters IK mode.
			setIkEditTool("ik");
			// With a motion loaded, IK edits ON TOP of it: the motion is the
			// rough base layer, the IK keys the correction layer. Every frame
			// applies the clip first and the keyed corrections after, so the
			// composite is what gets pinned for re-generation. Pause playback
			// so a running playhead cannot fight the drag.
			setTlPlaying(false);
			// Self-heal the ref after a hot-reload with an older state shape:
			// a missing `tracked` set would throw on the first drag.
			if (!ikStateRef.current.tracked) ikStateRef.current = createIkState();
			ikStateRef.current.chains = ikChains;
			ikStateRef.current.fkJoints = ikFkJoints;
			ikStateRef.current.rig = activeRig;
			// Handles open exactly on the effectors of the CURRENT pose —
			// non-destructive entry. (The evaluate effect applies the keyed
			// pose at this frame right after ikMode flips, so re-seating on
			// frame changes is handled there.)
			if (ikChains) ikSeedTargets(ikChains, ikStateRef.current);
			// The main view switches to the poser camera: start it exactly on
			// the shot camera's pose so nothing jumps, then navigation moves
			// the POSER only — the shot camera (inset) stays frozen.
			const shotCam = shotCamRef.current;
			const poserCam = poserCamRef.current;
			if (shotCam && poserCam) {
				poserCam.position.copy(shotCam.position);
				poserCam.quaternion.copy(shotCam.quaternion);
				poserCam.rotation.order = "YXZ";
				poserLook.current = { yaw: shotCam.rotation.y, pitch: shotCam.rotation.x };
			}
			setIkMode(true);
			setToast(motion
				? ko("IK mode — correct the motion; drag end keys the fix at this frame", "IK 모드 — 모션을 보정합니다. 드래그를 끝내면 이 프레임에 보정 키가 찍혀요")
				: ko("IK mode — drag handles in the main view; the shot camera stays frozen in the inset", "IK 모드 — 메인 뷰에서 핸들을 드래그하세요. 샷 카메라는 인셋에 고정됩니다"));
			return;
		}
		// Exit: the keyed pose stays — the evaluate effect re-applies the
		// current frame's keyed rotations the moment ikMode flips, so nothing
		// the user authored is lost by toggling. Untracked/unkeyed parts keep
		// their current (FK) pose.
		leaveIkMode();
		setToast(ko("IK mode off — keyed poses keep playing", "IK 모드 꺼짐 — 키로 찍은 포즈는 계속 재생됩니다"));
	}

	// Drag solve, routed by handle kind: chain targets solve the two-bone
	// chain toward the target; mid joints reposition the elbow/knee with both
	// ends pinned (the handle snaps to the clamped position); FK joints swing
	// toward the pointer. Keys are baked on drag END — see ikDragEnd.
	function ikSolve(kind, trackId, targetWorld) {
		if (kind === "chain") {
			const chain = ikStateRef.current.chains?.get(trackId);
			if (!chain) return;
			ikTouch(ikStateRef.current, trackId);
			const clampedTarget = bodyContact ? clampIkTargetToFloor(trackId, targetWorld, 0, ikChains?.get(trackId)?.contactHeights ?? ikChains?.values().next().value?.contactHeights) : targetWorld;
			ikStateRef.current.targets.set(trackId, clampedTarget.clone());
			solveIk(chain, clampedTarget);
			return;
		}
		if (kind === "mid") {
			// Mid tracks reference their parent chain through MID_TRACKS.
			const midDef = MID_TRACKS.find((t) => t.id === trackId);
			const chain = midDef ? ikStateRef.current.chains?.get(midDef.chain) : null;
			if (!chain) return;
			ikTouch(ikStateRef.current, chain.track.id);
			solveMidJoint(chain, bodyContact ? clampIkTargetToFloor(trackId, targetWorld, 0, chain.contactHeights) : targetWorld);
			return;
		}
		// Effector swing: the rotation ring on a focused hand/foot. Rotates
		// only the end bone — the solved limb position is untouched — and the
		// bake on drag end now stores b2's quaternion with the chain's.
		if (kind === "swing") {
			const chain = ikStateRef.current.chains?.get(trackId);
			if (!chain || !targetWorld?.axis) return;
			ikTouch(ikStateRef.current, trackId);
			solveEffectorSwing(chain, targetWorld.axis, targetWorld.angle, targetWorld.startQuat, targetWorld.startParentQuat);
			return;
		}
		// Body root (hips): arrow drags translate ({ worldDelta, startLocalPos
		// }), the centre sphere swings ({ axis, angle, startQuat, ... }). With
		// foot snap ON the feet stay at the positions captured when the drag
		// started — the legs re-solve after every hips transform so the knees
		// bend instead of the feet sinking through the floor.
		if (kind === "body") {
			const joint = ikFkJoints?.get(trackId);
			if (!joint) return;
			ikTouch(ikStateRef.current, trackId);
			if (footSnap && !ikBodyDragRef.current && ikChains) {
				// Capture the plant points once, BEFORE the first hips move.
				ikPlantFeet(ikChains, ikStateRef.current);
				ikBodyDragRef.current = true;
			}
			if (targetWorld?.worldDelta && targetWorld?.startLocalPos) {
				if (bodyContact) solveHipsTranslateToFloor(joint, targetWorld.worldDelta, targetWorld.startLocalPos, 0, ikChains?.get("leftHand")?.contactHeights);
				else solveHipsTranslate(joint, targetWorld.worldDelta, targetWorld.startLocalPos);
			} else if (targetWorld?.axis) solveSwingAngle(joint, targetWorld.axis, targetWorld.angle, targetWorld.startQuat, targetWorld.startParentQuat);
			if (footSnap && ikChains) {
				ikSolvePlantedFeet(ikChains, ikStateRef.current);
				// the planted re-solve wrote the leg bones — key them too
				ikTouch(ikStateRef.current, "leftFoot");
				ikTouch(ikStateRef.current, "rightFoot");
			}
			if (bodyContact && ikChains) applyBodyContact(ikChains, ikFkJoints, 0, { skipFeet: footSnap });
			return;
		}
		// FK swing: targetWorld is the trackball payload { axis, angle,
		// startQuat, startParentQuat } from the drag layer.
		const joint = ikFkJoints?.get(trackId);
		if (!joint || !targetWorld?.axis) return;
		ikTouch(ikStateRef.current, trackId);
		solveSwingAngle(joint, targetWorld.axis, targetWorld.angle, targetWorld.startQuat, targetWorld.startParentQuat);
	}

	// Drag end: key the dragged part's local rotations at the playhead, so a
	// scrub away and back restores the dragged pose exactly (slerp).
	function ikDragEnd() {
		ikBodyDragRef.current = false;
		if (ikChains) {
			// One entry per drag: the pointermoves only moved bones, the keys map is
			// untouched until this bake — recording here captures the pre-drag keys.
			if (ikStateRef.current.tracked.size > 0) recordCharacterUndo();
			ikBakeKeyframe(ikChains, ikStateRef.current, tlFrame, ikFkJoints);
		}
		setIkTick((n) => n + 1);
	}

	// Manual key: bake the current tracked rotations at the playhead.
	function ikAddKeyframe() {
		if (!ikChains) return;
		// A bake only writes TRACKED parts: with nothing dragged yet there is no
		// key to undo, so no entry is pushed and Ctrl+Z never goes dead.
		if (ikStateRef.current.tracked.size > 0) recordCharacterUndo();
		ikBakeKeyframe(ikChains, ikStateRef.current, tlFrame, ikFkJoints);
		setIkTick((n) => n + 1);
		setToast(isKo ? `${tlFrame}프레임에 전신 IK 키를 추가했어요` : `Full-body IK key at frame ${tlFrame}`);
	}

	// Self-collision cleanup: push interpenetrating body parts apart with the
	// IK solver, then bake the fix as an ordinary IK correction key so it
	// survives scrubs, undo, and blends back into the clip outside its range.
	//
	// The result has THREE outcomes, not two, and each gets its own sentence.
	// "supported: false" means the rig has no capsule proxies to build at all
	// — a non-Mixamo skeleton — and reporting that as "no collisions" would
	// be a lie the user cannot act on: they would keep clicking a button that
	// silently does nothing. The buttons below are disabled in that case, so
	// this branch is the belt to that suspenders (a rig can be swapped under
	// a stale render).
	/**
	 * Everything OUTSIDE the active character that a limb has to stay out of:
	 * the other cast members' bodies (capsules, built from the rigs AS THEY ARE
	 * POSED at the moment of the call) and every scene object (an upright box
	 * on its footprint). Ids are namespaced `char:<id>:<capsule>` / `obj:<id>`,
	 * so a penetration label names the thing that was hit.
	 *
	 * `frame` re-samples travel paths — a prop walking a route stands somewhere
	 * else on every frame — but the CAST is read live from the scene graph, so
	 * a caller walking a clip must pose the others at that frame first (see
	 * runFixCollisionsRange's blockersAt).
	 */
	const externalBlockers = (frame = tlFrame) => collisionBlockers({
		rigs,
		activeId: activeChar.id,
		// The CAST is the authority on who is on stage, not the rig map: undo can
		// put the cast list back to one subject while the rig mounted for the
		// removed one is still in `rigs`, and a ghost body would go on blocking
		// limbs that pass through empty space.
		characterIds: characters,
		sceneObjects,
		library: OBJECT_LIBRARY,
		frame,
		take: { frameCount: tlFrameCount, fps: tlFps },
	});

	function runFixCollisions() {
		if (!ikChains || !activeRig) return;
		// A rig swap leaves one render where ikChains still describes the old
		// skeleton; solving the new rig with them would push the wrong bones.
		if (ikStateRef.current.rig !== activeRig) return;
		// The set as it stands right now: the other bodies at this frame's pose
		// and the props at this frame's placement.
		const result = fixCollisions(activeRig, ikChains, { ikState: ikStateRef.current, fkJoints: ikFkJoints, blockers: externalBlockers(tlFrame) });
		if (!result.supported) {
			setToast(ko("This rig doesn't support collision cleanup", "이 리그는 신체 관통 정리를 지원하지 않아요"));
			return;
		}
		if (!result.changed) {
			setToast(ko("No body collisions at this frame", "이 프레임에는 신체 관통이 없어요"));
			return;
		}
		if (ikStateRef.current.tracked.size > 0) recordCharacterUndo();
		ikBakeKeyframe(ikChains, ikStateRef.current, tlFrame, ikFkJoints, result.touched, null, result.baseQuats);
		setIkTick((n) => n + 1);
		setToast(result.residual > 1e-4
			? ko(`Collisions reduced (residual ${(result.residual * 100).toFixed(1)} cm)`, `관통을 줄였어요 (잔여 ${(result.residual * 100).toFixed(1)} cm)`)
			: ko(`Collisions fixed at frame ${tlFrame}`, `프레임 ${tlFrame}의 관통을 정리했어요`));
	}

	// Whole-clip variant: walk the motion frame by frame, clean each pose and
	// key ONLY the frames that changed, so a clean clip stays keyless.
	function runFixCollisionsRange() {
		if (!ikChains || !activeRig || !motion) return;
		if (ikStateRef.current.rig !== activeRig) return;
		// Screened before the undo entry: an unsupported rig would record an
		// undo step for a walk that keys nothing, leaving a no-op in history.
		if (!collisionCleanupSupported) {
			setToast(ko("This rig doesn't support collision cleanup", "이 리그는 신체 관통 정리를 지원하지 않아요"));
			return;
		}
		const currentFrame = tlFrame;
		const applyFrame = (frame) => {
			applyMotionFrame(activeRig, motion, frame);
			ikEvaluate(ikChains, ikStateRef.current, frame, ikFkJoints, IK_CORRECTION_BLEND_FRAMES);
		};
		// The other bodies move too. blockersAt runs AFTER applyFrame(frame), so
		// it poses the rest of the cast at that same frame — their own clips and
		// their own stored IK layers, the very pass the viewport renders with —
		// and only then samples their capsules. Without this the blockers would
		// describe everyone frozen at the playhead, which is a wrong obstacle on
		// every frame but one.
		const blockersAt = (frame) => {
			poseOtherCastMembers(frame);
			return externalBlockers(frame);
		};
		// The undo entry is provisional: a clean clip keys nothing, and a
		// snapshot identical to the present state would make Ctrl+Z a no-op
		// press that also discards the redo stack for nothing.
		const savedFuture = charHistoryRef.current.future;
		recordCharacterUndo();
		let keyed = [];
		let unresolved = [];
		try {
			const walked = fixCollisionsRange({
				rig: activeRig,
				chains: ikChains,
				ikState: ikStateRef.current,
				fkJoints: ikFkJoints,
				startFrame: 0,
				endFrame: motion.frames - 1,
				applyFrame,
				blockersAt,
			});
			// The frames the walk keyed. `unresolved` — the frames whose residual
			// survived every pass — is ADDITIVE: read it defensively off either
			// shape so this keeps working before and after the driver grows it.
			keyed = Array.isArray(walked) ? walked : walked?.keyed ?? [];
			unresolved = (Array.isArray(walked) ? walked.unresolved : walked?.unresolved) ?? [];
		} finally {
			// The restore is the pass's CLEANUP, not its epilogue: a throw mid-walk
			// would otherwise leave the active rig and the rest of the cast frozen
			// at whatever frame it died on, which is a wrong-looking set the user
			// cannot scrub out of without touching the playhead.
			applyFrame(currentFrame);
			poseOtherCastMembers(currentFrame);
			setIkTick((n) => n + 1);
		}
		if (!keyed.length) {
			charHistoryRef.current.past.pop();
			charHistoryRef.current.future = savedFuture;
		}
		// Residual is worth saying out loud: a limb pinned between two blockers
		// (another body and a prop, say) can come out of the walk still touching,
		// and silence would read as "all clean".
		const stillPenetrating = unresolved.length
			? ko(` · ${unresolved.length} frame(s) still penetrate`, ` · ${unresolved.length}개 프레임은 남아 있어요`)
			: "";
		// "No body collisions" must never share a sentence with "still
		// penetrate": a converged pass over an unfixable clip has nothing more
		// to do, which is a different statement from the clip being clean.
		setToast((keyed.length
			? ko(`Fixed collisions on ${keyed.length} frame(s)`, `${keyed.length}개 프레임의 관통을 정리했어요`)
			: unresolved.length
				? ko("Nothing more to fix", "더 고칠 수 있는 게 없어요")
				: ko("No body collisions in the clip", "클립에 신체 관통이 없어요")) + stillPenetrating);
	}


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
	function changePhysicsOptions(next) {
		setPhysicsOptions(next); setPhysicsPreview(null); setIkTick((n) => n + 1);
	}
	function showPhysicsPreview(show) { setPhysicsShow(show); setIkTick((n) => n + 1); }
	function cancelPhysicsPreview() { setPhysicsPreview(null); setIkTick((n) => n + 1); }
	function applyPhysicsPreview() {
		if (!physicsPreview || physicsPreview.sourceStamp !== physicsKeyStamp(ikStateRef.current.keys)) return;
		recordCharacterUndo();
		ikStateRef.current.keys = copyPhysicsKeys(physicsPreview.candidate.keys);
		ikStateRef.current.tracked = new Set(physicsPreview.candidate.tracked);
		autoPhysicsRunRef.current = { motion, rig: activeRig, stamp: physicsKeyStamp(ikStateRef.current.keys) };
		setPhysicsPreview(null); setIkTick((n) => n + 1);
		setToast(ko("AutoPhysics applied · Undo restores the original", "오토피직스를 적용했어요 · 실행 취소로 원본 복구"));
	}
	async function runAutoPhysics() {
		if (autoPhysicsRunning || !ikChains || !activeRig || !motion || ikStateRef.current.rig !== activeRig) return null;
		const previous = autoPhysicsRunRef.current;
		if (previous?.motion === motion && previous.rig === activeRig && previous.stamp === physicsKeyStamp(ikStateRef.current.keys)) {
			setToast(ko("Already applied. Undo to review this correction again.", "이미 적용했어요. 실행 취소 후 다시 비교할 수 있어요.")); return null;
		}
		const job = ++physicsJobRef.current, frame = tlFrame;
		const sourceKeys = copyPhysicsKeys(ikStateRef.current.keys), stamp = physicsKeyStamp(sourceKeys);
		let lastYieldAt = Date.now(), yieldWaitMs = 0, yieldCount = 0;
		const restore = () => { poseMemberAtFrame(activeRig, motion, ikStateRef.current, frame, IK_CORRECTION_BLEND_FRAMES); };
		setTlPlaying(false); setAutoPhysicsRunning(true); setPhysicsProgress(0); setPhysicsPreview(null);
		try {
			const result = await reviewAutoPhysics({ rig: activeRig, motion, chains: ikChains, fkJoints: ikFkJoints, sourceKeys,
				applyRaw: (f) => poseMemberAtFrame(activeRig, motion, null, f), ...physicsOptions,
				cache: physicsSourceCacheRef.current,
				onProgress: setPhysicsProgress,
				yieldFrame: async () => {
					if (physicsJobRef.current !== job) throw new Error("Analysis cancelled after changing the character or motion");
					// A batch is a cancellation checkpoint, not necessarily a paint/
					// event-loop boundary. Yield on a time budget, not every 12 frames.
					if (Date.now() - lastYieldAt < 16) return;
					restore();
					const queuedAt = Date.now();
					// Yield CPU work without waiting for a paint. requestAnimationFrame
					// can be throttled/paused in an occluded tab, stretching a seconds-
					// long solve into minutes. MessageChannel also lets input run.
					await new Promise((resolve) => {
						const channel = new MessageChannel();
						channel.port1.onmessage = () => { channel.port1.close(); channel.port2.close(); resolve(); };
						channel.port2.postMessage(0);
					});
					lastYieldAt = Date.now(); yieldWaitMs += lastYieldAt - queuedAt; yieldCount += 1;
					if (physicsJobRef.current !== job) throw new Error("Analysis cancelled after changing the character or motion");
				},
			});
			Object.assign(result.performance, { yieldWaitMs, yieldCount });
			if (physicsJobRef.current !== job || physicsKeyStamp(ikStateRef.current.keys) !== stamp) return null;
			setPhysicsPreview(result); setPhysicsShow(true);
			return { before: result.before, after: result.after, warnings: result.warnings, unresolved: result.unresolved, contacts: result.contacts.spans };
		} catch (error) {
			if (physicsJobRef.current === job) setToast(ko(`AutoPhysics: ${error.message}`, `오토피직스: ${error.message}`));
			return null;
		} finally {
			if (physicsJobRef.current === job) { restore(); setAutoPhysicsRunning(false); setIkTick((n) => n + 1); }
		}
	}

	function ikDeleteKeyframe(frame) {
		if (!ikStateRef.current.keys.has(frame)) return;
		recordCharacterUndo();
		ikRemoveKeyframe(ikStateRef.current, frame);
		setIkTick((n) => n + 1);
	}

	/** With IK mode on over a loaded take, a pose pick is a CORRECTION, not a
	 * replacement: write the saved pose onto the rig and bake every IK part
	 * into a full-body key at the current frame. The take survives, and the
	 * key blends back into the clip outside its window exactly like a dragged
	 * key would. Returns false when there is nothing to key against so the
	 * caller can fall through to the plain pose-apply path. */
	function ikApplyPoseAsKey(pose) {
		if (!ikChains || !activeRig || !motion) return false;
		recordCharacterUndo();
		// The clip's positional skinning left per-bone translations the FK pose
		// math never produced. The bake below stores every FK joint's position
		// (p) as-is, so posing rotations over those clip translations would key
		// a torn-apart body — bind translations first, ALWAYS.
		restoreBindPositions(activeRig);
		// Reset-then-pose, the same shape the Character effect applies: unlisted
		// joints return to rest instead of keeping stale limbs from the clip.
		applyPose(activeRig, { ...REST_BONES, ...pose.bones });
		// The hips' measured height rides into the bake: the hips FK joint keys
		// its local position (p), so a crouched pose keys a crouched body.
		applyHipsOffset(activeRig, pose.rootY ?? 0);
		// The pose authors the whole body, so every part is tracked — an
		// untracked chain would silently keep the clip's limb.
		for (const id of ikChains.keys()) ikTouch(ikStateRef.current, id);
		if (ikFkJoints) for (const id of ikFkJoints.keys()) ikTouch(ikStateRef.current, id);
		ikBakeKeyframe(ikChains, ikStateRef.current, tlFrame, ikFkJoints);
		// Handles re-seat on the posed effectors, ready to drag into a refinement.
		ikSeedTargets(ikChains, ikStateRef.current);
		setIkTick((n) => n + 1);
		setToast(isKo
			? `${tlFrame}프레임에 포즈를 전신 IK 보정 키로 추가했어요 — 모션은 그대로예요`
			: `Pose keyed as a full-body IK correction at frame ${tlFrame} — the take stays`);
		return true;
	}

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
		const layer = physicsPreview && physicsShow ? physicsPreview.candidate : ikStateRef.current;
		if (ikMode || layer.keys.size > 0) {
			ikEvaluate(ikChains, layer, tlFrame, ikFkJoints, motion ? IK_CORRECTION_BLEND_FRAMES : 0);
		}
	}, [ikMode, ikChains, activeRig, motion, posing, tlFrame, ikTick, ikFkJoints, physicsPreview, physicsShow]);

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
			rigA: activeRig, motion, tlFrame, frameCount: tlFrameCount, playing: tlPlaying, ikMode, ikChains, ikFocus, contactRadii: ikChains?.values().next().value?.contactRadii ?? null, ik: ikStateRef.current,
			committedIkEdits, waypoints,
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
			setCharacterScale: (scale) => updateCharacterAt(activeCharIndex, { scale }),
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
			pathHandlesEnabled: centerTab === "scene" && !lookThroughShot && !ikMode && !posing && !playMode && !!selectedSceneObject?.path,
			scrub: (frame) => setTlFrame(Math.max(0, Math.min(tlFrameCount - 1, Math.round(frame)))),
			pause: () => setTlPlaying(false),
			// Motion-trail QA surface: read the current trail policy and drive the
			// same drag -> preview -> pending-edit path headless checks cannot reach
			// through synthetic pointers reliably.
			trail: { falloffFrames: trailFalloffFrames, falloffS: trailFalloffS, edit: trailEdit, tool: ikEditTool, visible: showTrails },
			trailPoints: (jointName = "Hips") => jointTrailPoints(motion, jointName, { baseY: activeChar.y ?? 0, scale: activeChar.scale ?? 1 }),
			trailEditApply: (grabFrame, delta) => {
				onTrailDragStart({ grabFrame });
				onTrailDragPreview({ track: "hips", grabFrame, delta });
				onTrailDragEnd({ track: "hips", grabFrame, delta });
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
			apOptions: changePhysicsOptions,
			centerTab,
			pathDraw,
		};
		// eslint-disable-next-line react-hooks/exhaustive-deps
		// sceneObjects/rigs/characters ride the deps because fcDetect/fcBlockers
		// close over them: a stale closure would report the set as it was two
		// edits ago — and, after an undo that removes a subject, would keep
		// reporting the ghost's capsules.
	}, [activeRig, motion, tlFrame, ikMode, ikChains, ikFocus, ikTick, charA, committedIkEdits, waypoints, lookThroughShot, selectedSceneObject, sceneObjects, rigs, characters, pathPointIndex, centerTab, posing, playMode, pathDraw, trailEdit, trailFalloffFrames, trailFalloffS, ikEditTool, showTrails, physicsPreview, physicsShow, physicsOptions, autoPhysicsRunning]);
	// QA hook (plan §6.5): exposes history depth and the present === objects
	// invariant so the browser suite can assert undo entry counts directly.
	// Reads live store state at call time; re-registered after every render.
	useEffect(() => {
		window.__sceneHistory = () => ({ ...store.depths(), settled: store.present() === store.objects });
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
	const motionPos = useMemo(() => (
		motion ? sampleAt(playbackSceneBase, null, tlFrame).subject : null
	), [motion, playbackSceneBase, tlFrame]);

	// The subject's full per-frame scene trajectory — what the follow camera
	// is derived from. Without a loaded motion the subject stands still and
	// the follow camera simply composes a static frame.
	const subjectTrack = useMemo(() => {
		if (!shots.some((shot) => shot.camera?.mode === "follow" || shot.camera?.mode === "rail")) return null;
		const frames = Math.max(tlFrameCount, 1);
		return Array.from({ length: frames }, (_, frame) =>
			sampleAt(playbackSceneBase, null, frame).subject);
	}, [shots, playbackSceneBase, tlFrameCount]);

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
		activeCamera.mode !== "keys" && !!followTrack?.[tlFrame] && (centerTab === "play" || (!ikMode && !waypointMode && !posing));

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

	function openStudio(charId) {
		setPosing(charId);
		setPosingClosing(false);
		const entry = characters.find((item) => item.id === charId);
		setStudioPick((entry?.pose ?? DEFAULT_POSE)?.id ?? null);
	}

	function closeStudio() {
		// let the panel play its exit animation before it leaves the tree
		setPosingClosing(true);
		window.setTimeout(() => {
			setPosing(null);
			setPosingClosing(false);
		}, 190);
	}

	/** Save the ACTIVE character's rig exactly as it stands — the motion frame
	 * with any IK corrections already composited — into the pose library.
	 * Unlike savePose (the studio's FK author), this never writes back onto the
	 * character: a running take must survive having its best frame bottled. */
	function saveCurrentPose() {
		if (!activeRig) return;
		const pose = {
			id: `custom_${Date.now()}`,
			label: isKo ? `내 포즈 ${customPoses.length + 1}` : `My Pose ${customPoses.length + 1}`,
			prompt: "in the exact body pose shown in the blocking frame",
			bones: capturePose(activeRig),
			// A take frame carries its measured hips height; bottling the frame
			// without it would save every crouch as a float.
			rootY: captureHipsOffset(activeRig),
			custom: true,
		};
		const next = [...customPoses, pose];
		setCustomPoses(next);
		saveCustomPoses(next);
		setStudioPick(pose.id);
		setToast(motion
			? ko(`Saved this frame's pose to the library as “${pose.label}”`, `지금 프레임의 자세를 “${pose.label}”로 라이브러리에 저장했어요`)
			: ko(`Saved the current pose to the library as “${pose.label}”`, `지금 자세를 “${pose.label}”로 라이브러리에 저장했어요`));
	}

	function savePose() {
		const rig = posedRig();
		if (!rig) return;
		const pose = {
			id: `custom_${Date.now()}`,
		label: isKo ? `내 포즈 ${customPoses.length + 1}` : `My Pose ${customPoses.length + 1}`,
			prompt: "in the exact body pose shown in the blocking frame",
			bones: capturePose(rig),
			custom: true,
		};
		const next = [...customPoses, pose];
		setCustomPoses(next);
		saveCustomPoses(next);
		setStudioPick(pose.id);
		// The library is not on the cast history; writing the saved pose onto the
		// posed character is, and setPosed only writes when one is being posed.
		if (posingIndex >= 0) recordCharacterUndo();
		setPosed(pose);
		setToast(ko("Pose saved", "포즈 저장됨"));
	}

	/**
	 * Read a body pose out of one photograph.
	 *
	 * A still is the degenerate footage case, so it walks the same proven path:
	 * landmarks -> one-frame take -> applyMotionFrame -> capturePose. Posing the
	 * rig and reading it back is what makes the result an ordinary editable pose
	 * rather than a motion layer — the IK handles keep working on it, and the
	 * playback bones are restored so nothing about the take survives the read.
	 *
	 * Depth in a single frame is inferred, not measured, so this is a starting
	 * pose to refine, which is why it lands in the studio instead of on the
	 * character directly.
	 */
	async function posePhotoFile(file) {
		if (!file || photoPoseState === "running") return;
		// Reachable from the Inspector as well as the studio panel, and posedRig()
		// only answers while the studio is open — fall back to the character the
		// hierarchy has selected, which is the one the pose will be applied to.
		const rig = posedRig() ?? activeRig;
		let objectUrl = "";
		setPhotoPoseState("running");
		setPhotoPoseError("");
		try {
			if (!rig) throw new Error("rig-not-loaded");
			if (!multiModelRestRef.current) {
				const response = await fetch("/ardy/cskel27-rest.json").catch(() => null);
				if (!response?.ok) throw new Error("rest-unavailable");
				multiModelRestRef.current = await response.json().catch(() => {
					throw new Error("rest-unavailable");
				});
			}
			objectUrl = URL.createObjectURL(file);
			let bones = null;
			let rootY = 0;
			let warning = "";
			// Which measurement produced the pose. The GPU route and the browser
			// landmarker differ by a class in depth accuracy, so a silent fallback
			// left the user judging one while believing they saw the other.
			let route = "gpu";
			// GPU route first: SAM-3D-Body on the box MEASURES the body in 3D,
			// which beats anything a browser landmarker can infer from one frame.
			// The bridge wraps the still into a second of video and runs the exact
			// footage pipeline; the in-browser landmark path below is the fallback
			// for a missing bridge or a failed run, never the first choice.
			try {
				const health = await fetch("/ardy/health", { signal: AbortSignal.timeout(2000) }).catch(() => null);
				if (health?.ok) {
					const done = await requestBridgeExtract(file, {});
					const take = await loadMotionFromUrl(done.motionUrl);
					// The middle frame: the wrap's smoothing passes have settled
					// there, while frame 0 can still carry filter warm-up.
					const frame = Math.floor((take.frames - 1) / 2);
					const snapshot = snapshotPlaybackBones(rig);
					try {
						applyMotionFrame(rig, { ...take, anchorFrame: frame }, frame);
						bones = capturePose(rig);
						// SAM measured the hips' true height — a crouch is a crouch
						// because the hips came DOWN, not just because the knees bent.
						rootY = captureHipsOffset(rig);
					} finally {
						restorePlaybackBones(rig, snapshot);
					}
				}
			} catch (error) {
				console.warn("photo pose: GPU extract failed, falling back to browser landmarks", error);
			}
			if (!bones) {
				route = "browser";
				if (!photoPoseDetectorRef.current) {
					// "heavy", not the "full" the footage path uses: a photograph is one
					// offline frame, so the ~25 MB one-time download and the several-times
					// slower inference are paid once and buy accuracy no later step can
					// recover. This ref only ever holds the photo detector, so caching it
					// without a model key is safe.
					photoPoseDetectorRef.current = await createPoseDetector({ runningMode: "IMAGE", model: "heavy" });
				}
				// One detection of one still is the least evidence this app ever works
				// from, so the still is measured twice — as shot and mirrored — and
				// averaged. Downstream sees one ordinary landmark sample at t=0.
				const image = await decodeImage(objectUrl, { createImage: () => new Image() });
				const landmarks = await detectMirrorAveraged(image, photoPoseDetectorRef.current.detect);
				if (!landmarks) throw new Error("no-person-in-photo");
				const samples = [{ timeS: 0, landmarks }];
				const take = bakePoseFrame({ samples, rest: multiModelRestRef.current, createdMs: Date.now() });
				// Pose the rig, read the pose back, then put the rig exactly as it was:
				// the capture is the product, the posing is only how it is measured.
				const snapshot = snapshotPlaybackBones(rig);
				try {
					applyMotionFrame(rig, { ...take, anchorFrame: 0 }, 0);
					bones = capturePose(rig);
					rootY = captureHipsOffset(rig);
				} finally {
					restorePlaybackBones(rig, snapshot);
				}
				warning = photoPoseWarning(take);
				// Name the fallback in the same slot the fit warning uses: the
				// landmark route is the reduced-accuracy path, and that is worth
				// one sentence more than a partly-occluded limb.
				const fallbackNote = ko(
					"GPU pose extraction failed, so this pose came from the browser landmarker (less accurate in depth).",
					"GPU 자세 추출이 실패해서 브라우저 추정으로 잡았어요 (깊이 정확도가 낮아요)."
				);
				warning = warning ? `${fallbackNote} ${warning}` : fallbackNote;
			}
			console.info(`photo pose: route=${route}`);
			const pose = {
				id: `photo_${Date.now()}`,
				label: isKo ? `사진 포즈 ${customPoses.length + 1}` : `Photo Pose ${customPoses.length + 1}`,
				prompt: "in the exact body pose shown in the reference photograph",
				bones,
				rootY,
				custom: true,
			};
			const next = [...customPoses, pose];
			setCustomPoses(next);
			saveCustomPoses(next);
			setStudioPick(pose.id);
			// The studio poses whichever character it was opened on; the Inspector
			// poses the selected one. Write the pose to whichever that is.
			const poseTargetIndex = posingIndex >= 0 ? posingIndex : activeCharIndex;
			// A running take drives the same bones a pose writes, so the read would
			// land invisibly underneath it. Applying from a photo follows the same
			// rule the Apply button already states: the motion goes first.
			const hadMotion = Boolean(motion);
			// One gesture, one Ctrl+Z entry. clearMotion() already snapshots the
			// pre-gesture cast — pose included — so undoing it brings back the take
			// AND the pose this write replaces. With no take to clear, the pose
			// write is the whole edit and records itself.
			if (hadMotion) clearMotion();
			else recordCharacterUndo();
			updateCharacterAt(poseTargetIndex, { pose });
			setPhotoPoseState("done");
			// The pose is already saved and written by this point, so the warning
			// only changes what the user is told, never whether the read happened.
			// It takes the success slot rather than queueing a second toast: two
			// toasts in a row means the first one is never read. (The GPU route
			// leaves it empty — SAM measures the whole body or fails outright.)
			setToast(warning
				? (hadMotion ? `${ko("Cleared the motion.", "모션을 지웠어요.")} ${warning}` : warning)
				: hadMotion
					? ko("Cleared the motion and posed from the photo — refine it with the handles", "모션을 지우고 사진으로 자세를 잡았어요 — 핸들로 다듬어 보세요")
					: ko("Pose read from the photo — refine it with the handles", "사진에서 자세를 읽었어요 — 핸들로 다듬어 보세요"));
		} catch (error) {
			const code = error?.message ?? String(error);
			// fitLandmarksToPose refuses a sample whose torso is not visible; that is
			// a photograph problem, not an engine problem, so it is named as one.
			const named = code.startsWith("fitLandmarksToPose:") ? "pose-partly-occluded" : code;
			setPhotoPoseState("error");
			setPhotoPoseError(MULTIMODEL_REASONS[named]?.[isKo ? 1 : 0] ?? named);
		} finally {
			if (objectUrl) URL.revokeObjectURL(objectUrl);
		}
	}

	function removePose(id) {
		const next = deleteCustomPose(id, customPoses);
		setCustomPoses(next);
		saveCustomPoses(next);
		// Deleting a pose that is ON a character resets that character to the
		// default — a cast change, so it belongs on Ctrl+Z. Deleting an unused
		// library entry changes no character and records nothing.
		if (poseA?.id === id || poseB?.id === id) recordCharacterUndo();
		if (poseA?.id === id) setPoseA(DEFAULT_POSE);
		if (poseB?.id === id) setPoseB(DEFAULT_POSE);
		if (studioPick === id) setStudioPick(DEFAULT_POSE.id);
	}

	function applyPreset(key) {
		const p = PRESETS[key];
		setPreset(key);
		setFovDeg(p.fov);
		// Camera presets no longer touch the cast: with a free-form cast the
		// old two:false semantics would hide every extra character.
		setNonce((n) => n + 1);
	}

	function bufferToPng(buffer) {
		const canvas = document.createElement("canvas");
		canvas.width = shotOutput.width;
		canvas.height = shotOutput.height;
		const ctx = canvas.getContext("2d");
		const image = ctx.createImageData(shotOutput.width, shotOutput.height);
		// WebGL reads bottom-up; flip into canvas order.
		for (let row = 0; row < shotOutput.height; row += 1) {
			const from = (shotOutput.height - 1 - row) * shotOutput.width * 4;
			image.data.set(
				buffer.subarray(from, from + shotOutput.width * 4),
				row * shotOutput.width * 4
			);
		}
		ctx.putImageData(image, 0, 0);
		return canvas.toDataURL("image/png");
	}

	/** Park the shot camera on a framing, read back a 1920x1080 PNG, and put
	    everything back before the next paint — the viewport never sees it. */
	function captureFramingPng(framing) {
		const cam = shotCamRef.current;
		if (!cam || !captureRef.current) return null;
		const prev = { x: cam.position.x, y: cam.position.y, z: cam.position.z, yaw: look.current.yaw, pitch: look.current.pitch, fov: cam.fov };
		cam.position.set(framing.pos.x, framing.pos.y, framing.pos.z);
		cam.rotation.order = "YXZ";
		cam.rotation.set(framing.pitch, framing.yaw, 0);
		cam.fov = framing.fovDeg;
		cam.updateProjectionMatrix();
		const buffer = captureRef.current.render();
		cam.position.set(prev.x, prev.y, prev.z);
		cam.rotation.set(prev.pitch, prev.yaw, 0);
		look.current.yaw = prev.yaw;
		look.current.pitch = prev.pitch;
		cam.fov = prev.fov;
		cam.updateProjectionMatrix();
		return buffer ? bufferToPng(buffer) : null;
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
	}

	function download() {
		const save = (href, name) => {
			const a = document.createElement("a");
			a.href = href;
			a.download = name;
			document.body.appendChild(a);
			a.click();
			a.remove();
		};
		if (result.frameB) {
			// named for the seat they take in a first/last-frame video request
			save(result.frame, "blocking-frame-A-start.png");
			save(result.frameB, "blocking-frame-B-end.png");
			setToast(ko("Start & end frames downloaded", "시작·끝 프레임 다운로드됨"));
			setResult((current) => current ? { ...current, downloaded: true } : current);
			track("export:blocking_frame_succeeded", { format: "png" });
			trackActivation("export");
			return;
		}
		save(result.frame, "blocking-frame.png");
		setToast(ko("Frame downloaded", "프레임 다운로드됨"));
		setResult((current) => current ? { ...current, downloaded: true } : current);
		track("export:blocking_frame_succeeded", { format: "png" });
		trackActivation("export");
	}
	function downloadArdyPose() {
		const rig = posedRig();
		if (!rig) {
			setToast(ko("Character not loaded yet", "캐릭터가 아직 로드되지 않았어요"));
			return;
		}
		const pose = buildArdyPose({
			rig,
			camRef: shotCamRef,
			look,
			fovDeg,
			slate: slateLine(shot),
			// rigName follows the posed character's actual model below
			rigName: posingChar?.model ?? charA.model,
			root: captureArdyRoot(rig),
		});
		const blob = new Blob([JSON.stringify(pose, null, 2)], { type: "application/json" });
		const url = URL.createObjectURL(blob);
		const a = document.createElement("a");
		a.href = url;
		a.download = "cozyclay-pose.json";
		document.body.appendChild(a);
		a.click();
		a.remove();
		URL.revokeObjectURL(url);
		setToast(ko("ARDY pose exported", "ARDY 포즈 내보내기 완료"));
	}
	// Keep the optional sidecar live instead of freezing its startup state.
	// Developers commonly open the studio first and start `npm run bridge`
	// second; a one-shot failed probe left Generate disabled until reload.
	useEffect(() => {
		let alive = true;
		// The poll answer is almost always identical to the last one; keeping the
		// previous object identity skips a full App re-render per poll. Each of
		// those renders costs ~80ms of main thread on this tree, which read as a
		// periodic hitch while orbiting/flying the camera.
		const refreshBridge = () => checkBridge().then((state) => {
			if (!alive) return;
			setBridge((previous) => (
				previous &&
				previous.ok === state.ok &&
				previous.host === state.host &&
				previous.encoder === state.encoder &&
				previous.device === state.device &&
				previous.reason === state.reason
					? previous
					: state
			));
		});
		refreshBridge();
		const id = window.setInterval(refreshBridge, BRIDGE_RECHECK_MS);
		return () => {
			alive = false;
			window.clearInterval(id);
		};
	}, []);

	function addPromptClip(frame) {
		const snapped = Math.max(0, Math.round(frame / ARDY_PROMPT_HORIZON_FRAMES) * ARDY_PROMPT_HORIZON_FRAMES);
		// Add at the playhead when the spot is free; only fall through to
		// after-the-last-block when the playhead slot is taken. The old
		// unconditional max() made the button's "at frame N" label a lie.
		const blocked = promptClips.some((clip) => snapped < clip.endFrame && snapped + ARDY_PROMPT_HORIZON_FRAMES > clip.startFrame);
		const startFrame = blocked
			? Math.max(snapped, promptClips.reduce((max, clip) => Math.max(max, clip.endFrame), 0))
			: snapped;
		const clip = { id: createStableItemId("prompt-clip"), startFrame, endFrame: startFrame + ARDY_PROMPT_HORIZON_FRAMES, text: "" };
		recordCharacterUndo();
		setPromptClips((prev) => [...prev, clip]);
		setSelectedPromptId(clip.id);
		setTlFrameCount((count) => Math.max(count, clip.endFrame));
		setArdyDuration(Math.max(ARDY_DURATION_MIN, clip.endFrame / TIMELINE_FPS));
	}

	function changePromptClip(id, text) {
		const clip = promptClips.find((entry) => entry.id === id);
		if (!clip) throw new Error(`Unknown promptClips ID: ${id}`);
		if (clip.text === text) return;
		// Typing is one entry per editing session, not per keystroke: the first
		// change on a clip snapshots the text as it stood, and the rest of the
		// session keeps writing into that same entry. Reached from the inspector
		// field and from the timeline chip alike.
		recordSessionUndo(promptTextSessionRef, `prompt-text:${id}`);
		setPromptClips((prev) => updateStableItem(prev, id, (clip) => ({ ...clip, text }), "promptClips"));
		if (id === selectedPromptId) setArdyPrompt(text);
	}

	// Quality policy: one prompt block never spans more than 5 s. Kimodo
	// walk-to-run sweeps (seeds 7/21/99; seam stall ratio, 1.0 = no stall)
	// scored 0.79 for 5 s blocks (best of the sweep), close to a seam-free
	// single take at 0.85; 8 s blocks collapsed to 0.32. <2 s blocks lose
	// about a third of their frames to the transition window, so 3-5 s is the recommended
	// authoring range.
const PROMPT_BLOCK_MAX_FRAMES = 5 * TIMELINE_FPS;

function resizePromptClip(id, edge, rawFrame) {
		setPromptClips((prev) => {
			const candidate = updateStableItem(prev, id, (clip) => {
				const snapped = Math.max(0, Math.round(rawFrame / ARDY_PROMPT_HORIZON_FRAMES) * ARDY_PROMPT_HORIZON_FRAMES);
				return edge === "start"
					? { ...clip, startFrame: Math.min(Math.max(snapped, clip.endFrame - PROMPT_BLOCK_MAX_FRAMES), clip.endFrame - ARDY_PROMPT_HORIZON_FRAMES) }
					: { ...clip, endFrame: Math.min(Math.max(clip.startFrame + ARDY_PROMPT_HORIZON_FRAMES, snapped), clip.startFrame + PROMPT_BLOCK_MAX_FRAMES) };
			}, "promptClips");
			// Same rule the move path enforces: one prompt per frame range.
			// A resize that lands on a neighbour used to slip through and get
			// silently truncated by the generator; reject it at the handle.
			const resized = candidate.find((clip) => clip.id === id);
			if (resized && candidate.some((clip) => clip.id !== id && resized.startFrame < clip.endFrame && resized.endFrame > clip.startFrame)) {
				return prev;
			}
			const end = candidate.reduce((max, clip) => Math.max(max, clip.endFrame), ARDY_PROMPT_HORIZON_FRAMES);
			setTlFrameCount((count) => Math.max(count, end));
			setArdyDuration(end / TIMELINE_FPS);
			return candidate;
		});
	}

	function movePromptClip(id, rawStartFrame) {
		if (!promptClips.some((clip) => clip.id === id)) throw new Error(`Unknown promptClips ID: ${id}`);
		setPromptClips((prev) => {
			const next = movePromptClipFrames(prev, id, rawStartFrame, ARDY_PROMPT_HORIZON_FRAMES);
			if (next === prev) return prev;
			const end = next.reduce((max, clip) => Math.max(max, clip.endFrame), ARDY_PROMPT_HORIZON_FRAMES);
			setTlFrameCount((count) => Math.max(count, end));
			setArdyDuration(end / TIMELINE_FPS);
			return next;
		});
	}

	function removePromptClip(id) {
		if (!promptClips.some((clip) => clip.id === id)) throw new Error(`Unknown promptClips ID: ${id}`);
		recordCharacterUndo();
		setPromptClips((prev) => removeStableItem(prev, id, "promptClips"));
		if (selectedPromptId === id) setSelectedPromptId(null);
	}

	// Optional native-ARDY seed. Empty = request omits seed; the raw string
	// is kept as typed (trimmed only). runArdy validates the bridge contract
	// (integer in 0..2**31-1) right before the request and toasts on a
	// violation, so an invalid seed can never reach the bridge silently.
	function changeArdySeed(value) {
		setArdySeed(value.trim());
	}

	/** THE SEED RULE (contract C9), enforced in ONE place so no take-creating
	 * call site can forget it: an empty field is rolled here, a typed one is
	 * kept exactly as typed, and either way a concrete integer comes back to be
	 * both SENT and RECORDED. A take whose seed was never written down cannot
	 * be rebuilt from its recipe, which is the one promise the whole recipe
	 * model rests on. Returns null after toasting when the typed value violates
	 * the bridge contract — the caller must then abandon the request. */
	function takeSeed() {
		try {
			return resolveSeed(ardySeed, ARDY_SEED_MAX);
		} catch {
			setToast(isKo ? `Seed는 0..${ARDY_SEED_MAX} 범위의 정수여야 해요. 비워 두면 자동으로 선택됩니다` : `Seed must be an integer in 0..${ARDY_SEED_MAX} — clear it to let the box pick one`);
			return null;
		}
	}

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
		// lookThroughShot / centerTab / ikMode are dependencies even though the
		// body never reads them directly: they are what lineEditPane branches on,
		// so a stale closure would keep measuring the camera the pane used to
		// hold and a view SWITCH — the most obvious way to invalidate a curve —
		// would go undetected. Lens and aspect changes need no dependency: they
		// move fx/fy, which the comparison sees on its own.
	}, [lineEditMode, lineCurve, lookThroughShot, centerTab, ikMode]);

	// Wave-2 capability preflight. `checkBridge` reports health only, so the
	// line-edit route is probed here: today's bridge IGNORES unknown request
	// fields, which means an ungated POST would come back as a plausible but
	// completely unrelated fresh take. Absence of the capability is a refusal,
	// never an attempt. Both the object and array spellings are accepted so
	// M4's health payload can choose either.
	//
	// SELF-HEALING, because the answer is allowed to arrive late. The bridge
	// derives the flag from a lazy ssh probe of the ProjFlow box (~3 s cold,
	// cached for 5 s), so ONE fetch at the moment the bridge came up could catch
	// a cold cache, a box still waking or a transient ssh failure and latch
	// `false` for the whole session — the panel then says "not connected yet"
	// forever and no pull ever previews, which is exactly the reported bug. So:
	// while the bridge is up and the capability is still false, ask again every
	// LINE_CAPABILITY_RETRY_MS, and ask IMMEDIATELY when the artist enters the
	// mode (lineEditMode is a dependency for that reason — entering is the one
	// moment the answer is about to matter). A confirmed capability stops the
	// polling: the effect re-runs when the flag flips and returns early.
	//
	// What does NOT change is the gate itself. Retrying is a way to learn the
	// truth sooner, never a reason to proceed without it — nothing here ever
	// sets the flag on anything weaker than a health payload that positively
	// says lineEdit.
	useEffect(() => {
		if (!bridge?.ok) {
			setLineEditBackend(false);
			return undefined;
		}
		// Already confirmed. The capability does not go away under a live bridge,
		// and re-asking would be a request every 4 s for the rest of the session.
		if (lineEditBackend) return undefined;
		let alive = true;
		let timer = 0;
		const again = () => {
			if (!alive) return;
			timer = window.setTimeout(probe, LINE_CAPABILITY_RETRY_MS);
		};
		const probe = () => {
			timer = 0;
			fetch("/ardy/health")
				.then((res) => (res.ok ? res.json() : null))
				.then((payload) => {
					if (!alive) return;
					const caps = payload?.capabilities ?? payload?.features;
					const capable = Array.isArray(caps) ? caps.includes("lineEdit") : caps?.lineEdit === true;
					setLineEditBackend(capable);
					// A `false` is not an answer, it is "not yet" — keep asking.
					if (!capable) again();
				})
				.catch(() => {
					if (!alive) return;
					setLineEditBackend(false);
					again();
				});
		};
		probe();
		return () => {
			alive = false;
			if (timer) window.clearTimeout(timer);
		};
	}, [bridge?.ok, lineEditBackend, lineEditMode]);

	/** CONFIRM the pull: the full-quality run of exactly what the preview has
	 * been showing. Its own run mode — the body carries lineEdit and NOTHING
	 * else authored, because C6 makes it exclusive with preserve, waypoints,
	 * segments, regenerateSegments and motionEdit — and it is the one path that
	 * commits a recipe and a version. Same builder, same SESSION SEED and same
	 * curve as the last preview; only `preview: true` is absent, which is what
	 * buys the full step count. */
	function runLineEdit() {
		if (ardyRunning) return;
		if (!takeSourceUrl) {
			setToast(ko("The current take has no bridge source — generate it once before editing a path", "현재 테이크에 브리지 원본이 없어요 — 궤적을 편집하기 전에 한 번 생성하세요"));
			return;
		}
		// No curve object means no edit — an untouched path is the take's own
		// trajectory, and sending it would ask the box to spend eight seconds
		// reproducing what is already there.
		if (!lineEditPayload) {
			setToast(ko(
				"Draw along the path, pull a dot, or pin a moment first",
				"먼저 궤적을 따라 그리거나, 점을 잡아당기거나, 순간을 찍어 주세요",
			));
			return;
		}
		if (!lineEditBackend) {
			setToast(ko(
				"The line-editing backend is not connected yet",
				"라인 편집 백엔드가 아직 연결 전이에요",
			));
			return;
		}
		const request = buildLineEditRequest(lineEditPayload);
		if (!request.ok) {
			if (request.message) setToast(request.message);
			return;
		}
		const { body, lineEdit, seed } = request;
		// The take being edited, not the draft that may be on screen: a preview
		// is a picture and must never become anyone's lineage.
		const source = linePreviewSource;
		enqueueMotionJob({
			charId: source?.charId ?? activeChar.id,
			charIndex: activeCharIndex,
			prompt: body.prompt,
			body,
			hasBlockEdits: false,
			committedEditKeys: [],
			rootRotationDeg: source?.rotationDeg ?? motion.rotationDeg ?? activeChar.rot,
			anchor: { x: motion.anchorX ?? activeChar.x, z: motion.anchorZ ?? activeChar.z },
			ikState: null,
			recipeIntent: "lineEdit",
			recipeSeed: seed,
			// sourceMotion is dropped on the way into the recipe: replay rebinds
			// it to whatever take it is re-applied to.
			// (stripSourceMotion keeps only C10's replay keys, so `preview` — when
			// the object came back from a draft build — cannot leak into a recipe.)
			recipeLineEdit: stripSourceMotion({ ...lineEdit, sourceMotion: undefined, seed }),
			recipeLabel: isKo ? `다듬기 · ${lineTrackLabel(lineTrack)}` : `Refine · ${lineTrackLabel(lineTrack)}`,
		});
		// The pull has left the building. The curve stays (it is the reference
		// the next edit starts from) but its deformation is released, so the
		// Generate button goes back to needing a fresh pull instead of inviting
		// a second identical run while the first is still queued. The undo
		// stack goes with it: restoring a pull that is already generating would
		// invite the identical run this reset exists to prevent.
		//
		// This also ENDS THE PREVIEW SESSION: the draft comes off the viewport
		// (the real result will land on it in a couple of seconds, and until it
		// does the take on screen should be the take that exists) and the seed
		// is released, so the next pull is a new piece of work with a new roll.
		clearLineEdit();
	}

	function runAllPromptBlocks() {
		const clips = promptClips
			.filter((clip) => clip.text.trim())
			.sort((a, b) => a.startFrame - b.startFrame);
		if (!clips.length) {
			setToast(ko("Add at least one Prompt Block before generating", "생성하기 전에 프롬프트 블록을 하나 이상 추가하세요"));
			return;
		}
		const totalFrames = Math.max(...clips.map((clip) => clip.endFrame));
		const duration = Math.max(ARDY_DURATION_MIN, Math.ceil(totalFrames / TIMELINE_FPS));
		setArdyPrompt(clips[0].text);
		setArdyDuration(duration);
		runArdy({
			promptOverride: clips[0].text,
			durationOverride: duration,
			promptClipsOverride: clips,
		});
	}

	async function runArdy({
		promptOverride = ardyPrompt,
		durationOverride = ardyDuration,
		promptClipsOverride = [],
		// Scene > Start over asks for a take that owes the loaded one nothing:
		// no preserve, no replayed refinements, a clean recipe. Every other
		// entry point (take it again, add a block, the Prompt Blocks button) stays in
		// the current take's lineage and carries both.
		fresh = false,
	} = {}) {
		// A line-edit draft is not a take, and every source this function reads
		// (preserve, motionEdit, the recipe) is about THE take. Refusing here is
		// the last line of defence behind sceneDisabledReason, which already
		// greys the entries with this reason spelled out in place.
		if (linePreviewUrl) {
			setToast(previewBlockingReason());
			return;
		}
		// Motion generation targets the ACTIVE character's layer; the pose
		// studio only lends its rig when it is actually open.
		const rig = posing ? posedRig() : activeRig;
		const rigModel = posing ? (posingChar?.model ?? activeChar.model) : activeChar.model;
		if (!rig) {
			setToast(ko("Character not loaded yet", "캐릭터가 아직 로드되지 않았어요"));
			return;
		}
		// Root guidance sends only authored sparse keys. ARDY owns every
		// in-between frame; no dense interpolation or playback warp is applied.
		// Prompt and duration are bridge-contract inputs too: reject bad
		// values here, before any pose build or network, with a specific toast.
		const prompt = promptOverride.trim();
		if (!prompt) {
			setToast(ko("Motion prompt is required — describe what the subject should do before generating", "모션 프롬프트가 필요해요 — 생성 전에 피사체가 할 동작을 설명하세요"));
			return;
		}
		if (prompt.length > ARDY_PROMPT_MAX) {
			setToast(isKo ? `모션 프롬프트는 ${ARDY_PROMPT_MAX}자까지예요(현재 ${prompt.length}자). 생성 전에 줄여 주세요` : `Motion prompt is capped at ${ARDY_PROMPT_MAX} characters (currently ${prompt.length}) — shorten it before generating`);
			return;
		}
		// Regeneration must keep the loaded clip's exact frame count. The form
		// may still show an older duration after a motion is loaded; using it
		// would ask ARDY for (for example) 120 frames against an 80-frame base.
		const duration = motion && ikFrames.length > 0
			? motion.frames / motion.fps
			: Math.round(Number(durationOverride)) || ARDY_DURATION_MIN;
		if (duration < ARDY_DURATION_MIN || duration > ARDY_DURATION_MAX) {
			setToast(isKo ? `길이는 ${ARDY_DURATION_MIN}초에서 ${ARDY_DURATION_MAX}초 사이여야 해요` : `Duration must be between ${ARDY_DURATION_MIN} and ${ARDY_DURATION_MAX} seconds`);
			return;
		}
		// THE SEED RULE (C9): rolled when the field is empty, kept when it is
		// typed, and concrete either way — this generation creates a take, so
		// its seed is recorded on the take's recipe below.
		const seed = takeSeed();
		if (seed === null) return;
		// Prompt clips are real generation blocks. Gaps inherit the current
		// prompt so the bridge always receives one contiguous 0..N sequence.
		// Built BEFORE the root-path judge: whether the rollout is chained
		// changes which window limit binds the path (per block, not per clip).
		// `duration` is SECONDS — the one frame-rate-free number in the
		// request, and the only one the bridge reads directly. Everything the
		// app counts in frames from here on is on the timeline clock; the
		// bridge's own count is duration * ARDY_FPS, reached via toArdyFrame.
		const clipFrames = duration * TIMELINE_FPS;
		const sourcePromptClips = promptClipsOverride
			.filter((clip) => clip.text.trim())
			.sort((a, b) => a.startFrame - b.startFrame);
		const hasAuthoredBlocks = sourcePromptClips.length > 0;
		const segments = buildPromptSchedule(sourcePromptClips, clipFrames, prompt);
		const hasPromptSchedule = segments.length > 1;
		const rootPath = waypointMode
			? [{ frame: 0, x: activeChar.x, z: activeChar.z, heading: null }, ...waypoints]
			: [];
		if (waypointMode) {
			if (waypoints.length < 1) {
				setToast(ko("Add at least one root destination before generating", "생성하기 전에 루트 목적지를 하나 이상 추가하세요"));
				return;
			}
			if (rootPath.length > MAX_WAYPOINTS) {
				setToast(isKo ? `루트 경로는 드문 웨이포인트 ${MAX_WAYPOINTS}개까지 사용할 수 있어요` : `The root path is capped at ${MAX_WAYPOINTS} sparse waypoints`);
				return;
			}
			if (waypoints.some((waypoint) => waypoint.frame <= 0 || waypoint.frame >= clipFrames)) {
				setToast(isKo ? `루트 웨이포인트 프레임은 1..${clipFrames - 1} 안에 있어야 해요` : `Root waypoint frames must stay inside 1..${clipFrames - 1}`);
				return;
			}
			// Placement-time checks can be invalidated afterwards (removing a
			// middle pin merges two legs; the duration field can grow), so the
			// whole path is re-judged at the door. A prompt schedule chains
			// the rollout block by block, so the trained window binds each
			// block instead of the whole clip.
			// Physical plausibility (m/s, deg/s) — judged against the clock the
			// pins were authored on, which is now the timeline's.
			const pathVerdict = judgeAuthoredPath(rootPath, TIMELINE_FPS, clipFrames, { chained: hasPromptSchedule });
			if (pathVerdict.errors.length > 0) {
				setToast(isKo ? `생성하지 못했어요 — ${pathVerdict.errors[0]}` : `Not generated — ${pathVerdict.errors[0]}`);
				return;
			}
			if (hasAuthoredBlocks) {
				const longBlock = segments.find((segment) => segment.endFrame - segment.startFrame > PROMPT_BLOCK_MAX_FRAMES);
				if (longBlock) {
					setToast(isKo
						? `생성하지 못했어요 — 프롬프트 블록은 ${PROMPT_BLOCK_MAX_FRAMES / TIMELINE_FPS}초 이내여야 해요. ${((longBlock.endFrame - longBlock.startFrame) / TIMELINE_FPS).toFixed(1)}초 블록을 나눠 주세요`
						: `Not generated — prompt blocks are capped at ${PROMPT_BLOCK_MAX_FRAMES / TIMELINE_FPS} s; split the ${((longBlock.endFrame - longBlock.startFrame) / TIMELINE_FPS).toFixed(1)} s block`);
					return;
				}
			}
			if (pathVerdict.warnings.length > 0) setToast(`⚠ ${pathVerdict.warnings[0]}`);
		}
		// Align + densify, never the raw sparse path: the model forces frame-0
		// facing to +Z, so the path is rotated until its first travel tangent
		// is +Z (heading 0) and resampled with path-tangent headings — sparse
		// heading-less pins that fight the forced facing corrupt the whole
		// track (see the sign-convention notes in ardy/waypoints.js).
		// The 5 s block policy binds the schedule path too, not just
		// root-constrained runs: chained blocks are the whole point of the cap.
		if (!waypointMode && hasAuthoredBlocks) {
			const longBlock = segments.find((segment) => segment.endFrame - segment.startFrame > PROMPT_BLOCK_MAX_FRAMES);
			if (longBlock) {
				setToast(isKo
					? `생성하지 못했어요 — 프롬프트 블록은 ${PROMPT_BLOCK_MAX_FRAMES / TIMELINE_FPS}초 이내여야 해요. ${((longBlock.endFrame - longBlock.startFrame) / TIMELINE_FPS).toFixed(1)}초 블록을 나눠 주세요`
					: `Not generated — prompt blocks are capped at ${PROMPT_BLOCK_MAX_FRAMES / TIMELINE_FPS} s; split the ${((longBlock.endFrame - longBlock.startFrame) / TIMELINE_FPS).toFixed(1)} s block`);
				return;
			}
		}
		const alignedRoot = waypointMode ? alignArdyPath(rootPath, activeChar.rot, MAX_WAYPOINTS) : null;
		// Waypoints leave the app here, so their frames drop onto the bridge
		// clock here. Rounding can merge two near-adjacent samples; the first
		// wins — the bridge refuses non-ascending frame lists outright.
		const ardyWaypoints = toArdyFrameEntries(alignedRoot ? alignedRoot.waypoints : []);

		// Capture every block boundary plus every authored IK key. Each sample
		// is the composite base-motion + IK pose at that frame and carries the
		// live ARDY root recovered from positional skinning.
		// A block "edit" is a LOCAL correction of the loaded take, addressed to
		// that take's source npz. Without a bridge source there is nothing to edit
		// against, so such keys must not divert a fresh generation into the edit
		// path — that path sends no segments, and the whole schedule would collapse
		// to the first block's prompt.
		const editedSegments = motion?.url && hasPromptSchedule
			? segments.filter((segment) =>
				ikFrames.some((frame) => frame >= segment.startFrame && frame < segment.endFrame)
			)
			: [];
		const hasBlockEdits = editedSegments.length > 0;
		// Which frames are pinned — and whether an opted-in pose start had to be
		// refused — is decided in one testable place (ardy/pose-pin.js).
		const pinPlan = planPosePin({
			startFromPose: ardyStartFromPose,
			poseFrame: posePlacementFrame(ardyPosePlacement, clipFrames, tlFrame),
			hasPromptSchedule,
			hasBlockEdits,
			waypointMode,
			ikFrames,
			clipFrames,
			segments,
			editedSegments,
		});
		if (pinPlan.blockedBy === PIN_BLOCKED.SCHEDULE) {
			setToast(ko(
				"Prompt blocks and a pose start cannot be combined — generating from the prompt alone.",
				"프롬프트 블록과 포즈 시작은 함께 쓸 수 없어요 — 프롬프트만으로 생성합니다.",
			));
		}
		const shouldPin = pinPlan.pin;
		const constraintFrames = pinPlan.frames;
		const currentFrame = tlFrame;
		const poses = constraintFrames.map((constraintFrame) => {
			if (motion) applyMotionFrame(rig, motion, constraintFrame);
			if (ikChains && ikStateRef.current.keys.size > 0) {
				ikEvaluate(ikChains, ikStateRef.current, constraintFrame, ikFkJoints, motion ? IK_CORRECTION_BLEND_FRAMES : 0);
			}
			return {
				frame: constraintFrame,
				pose: buildArdyPose({
					rig,
					camRef: shotCamRef,
					look,
					fovDeg,
					slate: slateLine(shot),
					rigName: rigModel,
					root: captureArdyRoot(rig),
				}),
			};
		});
		if (motion) applyMotionFrame(rig, motion, currentFrame);
		if (ikChains && ikStateRef.current.keys.size > 0) {
			ikEvaluate(ikChains, ikStateRef.current, currentFrame, ikFkJoints, motion ? IK_CORRECTION_BLEND_FRAMES : 0);
		}
		// ARDY generates in Subject 1's clip-local frame. Frame 0 is therefore
		// always the origin; scene placement and the total scene->clip rotation
		// (actor yaw plus the path-alignment fold) are restored only at
		// playback, without constraining any later generated root frame.
		const rootRotationDeg = alignedRoot ? alignedRoot.rotationDeg : activeChar.rot;
		const body = { prompt, duration, posePin: shouldPin };
		// The bridge sees only wire frames; the timeline frames of the same
		// keys are kept beside the payload so the commit can mark the markers
		// the user actually authored.
		let committedEditKeys = [];
		if (shouldPin && !hasBlockEdits) body.poses = toArdyFrameEntries(poses);
		body.seed = seed;
		if (waypointMode) {
			body.waypoints = ardyWaypoints;
			// A root path and a prompt schedule now travel TOGETHER: the
			// sequence generator threads the Root2D constraint set through
			// its chained calls (the interactive demo's pattern), so
			// neither authored surface is silently dropped any more.
			if (hasPromptSchedule && !hasBlockEdits) body.segments = toArdySegments(segments);
			// Looser pin grip than ARDY's 0.04 default: authored paths are
			// sparse and human-laid, so the postprocess gets 8 cm of room to
			// trade pin exactness for less foot skate.
			body.rootMargin = 0.08;
			// A path asks the model to CHANGE course at authored frames, so a
			// shorter 4 s history reacts faster to the pins than the default
			// full-window lookback (which favors continuing whatever came before).
			// This is deliberate, not arbitrary: upstream's README documents the
			// tradeoff -- a smaller history crop adapts faster to new
			// prompts/constraints, a larger one keeps longer context for complex
			// semantics and smoother transitions. Waypoint mode re-plans on
			// prompt/constraint changes, so faster adaptation wins here. The
			// initial beat is already covered: when no historyFrames arrives,
			// cclay_sequence_generate.py falls back to the trained 10 s window
			// minus the model's generation horizon (~8 s on Core-Horizon40), and
			// chained segments after the first carry only a ~0.6 s transition
			// tail, so the long-context case barely applies mid-chain.
			// A bridge-side frame count, so it is 4 s counted on the WIRE clock.
			body.historyFrames = 4 * ARDY_FPS;
		} else if (hasBlockEdits) {
			if (!motion?.url) {
				setToast(ko("The current motion has no bridge source; generate the prompt blocks once before regenerating IK edits", "현재 모션에 브리지 원본이 없어요. 프롬프트 블록을 한 번 생성한 뒤 IK 보정을 다시 생성하세요"));
				return;
			}
			const startFrame = Math.min(...editedSegments.map((segment) => segment.startFrame));
			const endFrame = Math.max(...editedSegments.map((segment) => segment.endFrame));
			const posesByFrame = new Map(poses.map((entry) => [entry.frame, entry.pose]));
			// Edits address the bridge-side source npz, so their frames drop
			// onto the bridge clock here; the timeline frame rides along only
			// for the app-side committed-keys bookkeeping (timeline markers).
			// contextBefore/contextAfter count frames of that source npz, so
			// they are already wire-clock numbers and do not convert.
			const editEntries = [];
			for (const timelineFrame of constraintFrames) {
				const frame = toArdyFrame(timelineFrame);
				if (editEntries.length && frame <= editEntries[editEntries.length - 1].frame) continue;
				editEntries.push({
					frame,
					timelineFrame,
					tracks: [...(ikStateRef.current.keys.get(timelineFrame)?.keys() || [])],
					pose: posesByFrame.get(timelineFrame),
				});
			}
			committedEditKeys = editEntries.map(({ timelineFrame, tracks }) => ({ frame: timelineFrame, tracks }));
			body.motionEdit = {
				sourceMotion: motion.url,
				startFrame: toArdyFrame(startFrame),
				endFrame: toArdyFrame(endFrame),
				contextBefore: 40,
				contextAfter: 20,
				edits: editEntries.map(({ frame, tracks, pose }) => ({ frame, tracks, pose })),
			};
		} else if (hasPromptSchedule) body.segments = toArdySegments(segments);
		// Scheduled inpainting (contract C3). The run reconstructs the take that
		// is already loaded everywhere the user did NOT edit, so it addresses that
		// take's bridge source npz — without one there is nothing to preserve and
		// the field must not be sent. strength travels RAW; the box maps it to
		// sigma_s/sigma_e (see ARDY_PRESERVE_DEFAULT).
		// A ROOT PATH IS NOW ALLOWED alongside it (contract C3v2, paper 4.4):
		// the bridge builds a mask whose `root` group is 0 for the whole clip, so
		// the drawn waypoints own the trajectory while the body keeps riding the
		// preserved take's style. That pair is the one thing round 1 refused; the
		// slider now says the same thing in words whenever both are on, so the
		// wire and the UI still cannot disagree.
		// regenerateSegments is not authored by this app today; the guard is here
		// so it stays true if it ever is.
		// body.segments too: scheduled inpainting is single-segment only, and the
		// bridge refuses the pair. A chained rollout (2 s + 2 s prompt blocks)
		// must still generate — preserve silently steps aside rather than turning
		// every multi-block generation into a 400.
		// The take being preserved must be the LENGTH of the window being
		// generated: Kimodo's preserve prep refuses a base whose duration is off
		// by more than a frame (there is no principled way to stretch a 8 s walk
		// into 5 s of blend), so a duration change quietly steps aside exactly
		// like a chained rollout does — the alternative is every "make it
		// longer/shorter" regeneration failing outright.
		const preserveDurationFits =
			motion?.frames > 0 && Math.abs(motion.frames / TIMELINE_FPS - duration) <= 1 / ARDY_FPS + 1e-9;
		// Preserve reconstructs the LOADED take wherever nothing was edited — with
		// no edit ranges it reconstructs it nearly verbatim (G1 measured ~5 mm).
		// So it must only ride along when this run asks for the SAME motion the
		// take was generated from: if any prompt block changed, the user is asking
		// for a different motion and preserve would hand them the old take back
		// with the new prompt ignored. The take's recipe is the record of what it
		// was generated from; no recipe (a pre-C9 take) means no way to check, and
		// preserve steps aside rather than guessing. A motionEdit run is exempt —
		// it rewrites a span of the take from poses, not from the prompt.
		const requestBlocks = blocksFromRequest(body, ARDY_FPS);
		const recipeBlocks = takeRecipeRef.current?.blocks ?? null;
		const preservePromptMatches =
			body.motionEdit !== undefined ||
			(!!recipeBlocks &&
				recipeBlocks.length === requestBlocks.length &&
				recipeBlocks.every((block, index) => block.prompt.trim() === requestBlocks[index].prompt.trim()));
		if (!fresh && motion?.url && preserveStrength > 0 && preserveDurationFits && preservePromptMatches && body.regenerateSegments === undefined && body.segments === undefined) {
			body.preserve = {
				sourceMotion: motion.url,
				strength: preserveStrength,
				// Edited spans leave on the BRIDGE clock like every other frame
				// number crossing this boundary (waypoints, motionEdit); the mask
				// builder scales them on to the generation clock itself. Ranges are
				// half-open, so one that collapses under the rounding is dropped —
				// the mask builder refuses an empty range outright, and an empty
				// LIST is the legitimate "nothing was edited" case (all-ones mask,
				// pure reconstruction) rather than an error.
				// Each range also names the ik tracks actually keyed inside IT
				// (contract C3v2), so the mask frees only those tracks' groups
				// there and a wrist correction stops pinning the legs. Attribution
				// is per range, not per clip: two blocks edited on different limbs
				// must not bleed into each other. The key is OMITTED when the union
				// is empty — the bridge REFUSES `tracks: []`, and "no tracks" is
				// spelled by absence, which is exactly the v1 whole-body range.
				editRanges: editedSegments
					.map((segment) => {
						const range = { startFrame: toArdyFrame(segment.startFrame), endFrame: toArdyFrame(segment.endFrame) };
						const tracks = ikTracksInRange(ikStateRef.current, ikFrames, segment.startFrame, segment.endFrame);
						if (tracks.length > 0) range.tracks = tracks;
						return range;
					})
					.filter((range) => range.endFrame > range.startFrame),
			};
		}
		// RECIPE REPLAY (contract C10). Regenerating or extending a take that
		// carries line edits used to throw those edits away — the box built a
		// fresh npz and the refinements lived only in the discarded one. The
		// recipe makes them reconstructible, so they ride along as `replay` and
		// the box re-applies them, in order, on top of the new take.
		// C10 REJECTS replay beside motionEdit (hasBlockEdits) because the base
		// would be ambiguous, so the edit path skips it; `fresh` skips it
		// because starting over means exactly that.
		// A SEEDLESS recipe never replays. An imported take (?motion=) is recorded
		// with `seed: null` because nobody here knows the seed it was made with,
		// and replaying its refinements onto a freshly rolled take would re-apply
		// them to a motion they were never authored against — a worse answer than
		// the honest empty one.
		const replayable = Number.isInteger(takeRecipeRef.current?.seed);
		const replay = fresh || hasBlockEdits || !replayable ? [] : replayPayload(takeRecipeRef.current);
		if (replay.length > 0) {
			body.replay = replay;
			if (replayTruncated(takeRecipeRef.current)) {
				setToast(isKo
					? `다듬기는 한 번에 ${replay.length}개까지만 다시 적용돼요 — 먼저 한 ${replay.length}개만 이어집니다`
					: `Only ${replay.length} refinements can be replayed at once — the first ${replay.length} carry over`);
			}
		}
		// The request is fully packaged HERE, against the active character's
		// live layer — the queue only needs the frozen payload. Results are
		// delivered to THIS character even if the selection moves on while
		// the box is still working.
		enqueueMotionJob({
			charId: activeChar.id,
			charIndex: activeCharIndex,
			prompt,
			body,
			hasBlockEdits,
			committedEditKeys,
			rootRotationDeg,
			anchor: { x: activeChar.x, z: activeChar.z },
			ikState: hasBlockEdits ? ikStateRef.current : null,
			// A block-edit run REWRITES a span of the loaded take rather than
			// generating a new one from the prompt, so it keeps the take's
			// recipe instead of minting a fresh one it could not honestly
			// describe (motionEdit has no recipe expression, by C10's own
			// exclusion). Everything else here creates a take from its blocks.
			recipeIntent: hasBlockEdits ? "carry" : "fresh",
			recipeSeed: seed,
			recipeLabel: hasBlockEdits
				? ko("Block fix", "블록 수정")
				: hasPromptSchedule
					? ko("Blocks", "블록 생성")
					: fresh
						? ko("New", "새로 만들기")
						: motion?.url
							? ko("Again", "다시 뽑기")
							: ko("Generate", "생성"),
		});
	}

	/* --------------------- trail drag -> preview -> regen -------------------- */
	function onTrailDragStart() {
		if (!motion) return;
		// The pre-drag take is both the deformation base (repeated moves re-derive
		// from it, so deltas never accumulate) and the undo snapshot.
		trailBaseMotionRef.current = motion;
		recordCharacterUndo();
	}
	/** World drag delta -> clip delta, shedding the character's stature scale
	 * (the trail is drawn scaled by it). */
	function trailClipDelta(base, delta) {
		const statureScale = activeChar.scale ?? 1;
		return worldDeltaToClip(base, { x: delta.x / statureScale, y: delta.y / statureScale, z: delta.z / statureScale });
	}
	/** Per-rAF drag preview. Deliberately React-free: the deformed take lands in
	 * a ref and on the rig directly, so a drag never re-renders the app. The
	 * trail/highlight lines are rewritten in place by MotionTrails itself. */
	function onTrailDragPreview({ grabFrame, delta }) {
		const base = trailBaseMotionRef.current;
		if (!base) return;
		const deformed = applyTrailFalloffDelta(base, {
			grabFrame,
			radiusFrames: trailFalloffFrames,
			clipDelta: trailClipDelta(base, delta),
		});
		trailPreviewMotionRef.current = deformed;
		const rig = activeRig;
		if (!rig) return;
		applyMotionFrame(rig, deformed, tlFrame);
		if (ikChains && ikStateRef.current.keys.size > 0) {
			ikEvaluate(ikChains, ikStateRef.current, tlFrame, ikFkJoints, IK_CORRECTION_BLEND_FRAMES);
		}
	}
	function onTrailDragEnd({ track, grabFrame, delta }) {
		const base = trailBaseMotionRef.current;
		const deformed = trailPreviewMotionRef.current;
		trailBaseMotionRef.current = null;
		trailPreviewMotionRef.current = null;
		const size = delta ? Math.hypot(delta.x, delta.y, delta.z) : 0;
		if (!base || !deformed || size < 0.01) {
			// A sub-centimetre nudge is a mis-grab, not an authored edit: the
			// motion state never changed, so only the rig pose needs restoring.
			if (base && activeRig) {
				applyMotionFrame(activeRig, base, tlFrame);
				if (ikChains && ikStateRef.current.keys.size > 0) {
					ikEvaluate(ikChains, ikStateRef.current, tlFrame, ikFkJoints, IK_CORRECTION_BLEND_FRAMES);
				}
			}
			setTrailEdit(null);
			return;
		}
		// The one and only React commit of the whole drag.
		setMotion(deformed);
		setTrailEdit({ track, grabFrame, radiusFrames: trailFalloffFrames, clipDelta: trailClipDelta(base, delta) });
	}
	/** Send the pending trail edit through the existing motionEdit pipeline:
	 * the regen window is auto-derived from the grab + falloff, explicit IK
	 * keys inside the window ride as hard constraints (their tracks), and the
	 * deformed line contributes the grab-frame pose as a root guide. */
	function runTrailRegeneration() {
		if (!trailEdit || ardyRunning) return;
		// Same rule as runArdy: motionEdit rewrites a span of THE take, and a
		// draft on the viewport is not it.
		if (linePreviewUrl) {
			setToast(previewBlockingReason());
			return;
		}
		if (!motion?.url) {
			setToast(ko("The current motion has no bridge source; generate the prompt blocks once before regenerating a trail edit", "현재 모션에 브리지 원본이 없어요. 궤적 수정을 재생성하려면 프롬프트 블록을 먼저 한 번 생성하세요"));
			return;
		}
		const rig = activeRig;
		if (!rig) {
			setToast(ko("Character not loaded yet", "캐릭터가 아직 로드되지 않았어요"));
			return;
		}
		const { startFrame, endFrame } = trailEditRange(motion.frames, trailEdit.grabFrame, trailEdit.radiusFrames);
		const frames = [...new Set([
			trailEdit.grabFrame,
			...ikFrames.filter((frame) => frame >= startFrame && frame < endFrame),
		])].sort((a, b) => a - b);
		const currentFrame = tlFrame;
		const entries = [];
		for (const frame of frames) {
			applyMotionFrame(rig, motion, frame);
			if (ikChains && ikStateRef.current.keys.size > 0) {
				ikEvaluate(ikChains, ikStateRef.current, frame, ikFkJoints, IK_CORRECTION_BLEND_FRAMES);
			}
			const pose = buildArdyPose({
				rig,
				camRef: shotCamRef,
				look,
				fovDeg,
				slate: slateLine(shot),
				rigName: activeChar.model,
				root: captureArdyRoot(rig),
			});
			const wireFrame = toArdyFrame(frame);
			if (entries.length && wireFrame <= entries[entries.length - 1].frame) continue;
			const ikTracks = [...(ikStateRef.current.keys.get(frame)?.keys() || [])];
			entries.push({ frame: wireFrame, timelineFrame: frame, tracks: ikTracks.length ? ikTracks : ["hips"], pose });
		}
		applyMotionFrame(rig, motion, currentFrame);
		if (ikChains && ikStateRef.current.keys.size > 0) {
			ikEvaluate(ikChains, ikStateRef.current, currentFrame, ikFkJoints, IK_CORRECTION_BLEND_FRAMES);
		}
		const prompt = (motion.prompt || "").trim() || "A person continues the motion naturally.";
		const body = {
			prompt,
			duration: motion.frames / TIMELINE_FPS,
			posePin: true,
			motionEdit: {
				sourceMotion: motion.url,
				startFrame: toArdyFrame(startFrame),
				endFrame: toArdyFrame(endFrame),
				contextBefore: 40,
				contextAfter: 20,
				edits: entries.map(({ frame, tracks, pose }) => ({ frame, tracks, pose })),
			},
		};
		// THE SEED RULE (C9) — a trail regeneration writes a new take too, so its
		// seed is rolled, sent and recorded like every other take-creating run.
		const seed = takeSeed();
		if (seed === null) return;
		body.seed = seed;
		enqueueMotionJob({
			charId: activeChar.id,
			charIndex: activeCharIndex,
			prompt,
			body,
			hasBlockEdits: true,
			committedEditKeys: entries.map(({ timelineFrame, tracks }) => ({ frame: timelineFrame, tracks })),
			rootRotationDeg: motion.rotationDeg ?? activeChar.rot,
			anchor: { x: motion.anchorX ?? activeChar.x, z: motion.anchorZ ?? activeChar.z },
			ikState: ikStateRef.current,
			// motionEdit rewrites a span of the loaded take; the recipe travels
			// forward unchanged because there is no recipe field that could
			// describe the splice (C10 excludes motionEdit from replay outright).
			recipeIntent: "carry",
			recipeSeed: seed,
			recipeLabel: ko("Trail fix", "궤적 수정"),
		});
		setTrailEdit(null);
	}

	/* ------------------------- motion job queue ---------------------------
	 * One box, one job at a time: Generate never blocks, it enqueues. The
	 * payload is frozen at enqueue time; completion delivers the clip to the
	 * REQUESTING character's layer, not whoever happens to be selected then. */
	const [genQueue, setGenQueue] = useState([]);
	const genRunningRef = useRef(false);
	const genJobSeq = useRef(0);
	function enqueueMotionJob(spec) {
		const id = `gen-${++genJobSeq.current}`;
		setGenQueue((queue) => [...queue, { id, status: "queued", ...spec }]);
		setToast(isKo ? `인물 ${spec.charIndex + 1} 모션 생성을 대기열에 넣었어요` : `Queued motion generation for Subject ${spec.charIndex + 1}`);
	}
	useEffect(() => {
		if (genRunningRef.current) return;
		const next = genQueue.find((job) => job.status === "queued");
		if (!next) return;
		genRunningRef.current = true;
		setGenQueue((queue) => queue.map((job) => (job.id === next.id ? { ...job, status: "running" } : job)));
		(async () => {
			try {
				await executeMotionJob(next);
				setGenQueue((queue) => queue.map((job) => (job.id === next.id ? { ...job, status: "done" } : job)));
			} catch (err) {
				const message = err?.name === "AbortError" ? ko("Cancelled", "취소됨") : err?.message || String(err);
				setGenQueue((queue) => queue.map((job) => (job.id === next.id ? { ...job, status: "error", error: message } : job)));
			} finally {
				genRunningRef.current = false;
			}
		})();
	}, [genQueue]);

	async function executeMotionJob(job) {
		const controller = new AbortController();
		ardyAbortRef.current = controller;
		setArdyRunning(true);
		reportArdyStatus(ko("connecting…", "연결 중…"));
		setArdyReport(null);
		setArdyOutcome(null);
		// Replay notices belong to ONE run; the next run re-earns them.
		setReplayNotices([]);
		const inputMode = job.hasBlockEdits ? "edit" : job.body.posePin ? "pose" : "prompt";
		const startedAt = Date.now();
		track("motion:job_started", { input_mode: inputMode });
		let editCommitReport = null;
		try {
			const done = await ardyGenerate(
				job.body,
				(event) => {
					if (event.event === "status") reportArdyStatus(event.message);
					else if (event.event === "report") {
						setArdyReport(event.report);
						if (job.hasBlockEdits) editCommitReport = event.report;
						// C10's per-entry replay report. Only the entries worth
						// acting on are kept: a refinement that failed outright,
						// or one whose range straddles an internal block
						// boundary (where block N+1 was conditioned on N's
						// PRE-edit tail, so the replay is approximate rather
						// than exact). Both are non-blocking — the take exists.
						if (Array.isArray(event.report.replay)) {
							setReplayNotices(event.report.replay.filter((entry) => entry?.ok === false || entry?.boundaryWarning === true));
						}
					}
				},
				{ signal: controller.signal },
			);
			if (
				job.hasBlockEdits &&
				(
					editCommitReport?.commit_verified !== true ||
					!job.body.motionEdit.edits.every((entry) =>
						editCommitReport.committed_keys?.includes(entry.frame)
					)
				)
			) {
				throw new Error(ko("ARDY returned motion without verified authored IK keys", "ARDY가 검증된 수동 IK 키 없이 모션을 반환했어요"));
			}
			setArdyOutcome({ ok: true, output: done.output, bytes: done.bytes, motionUrl: done.motionUrl, rotationDeg: job.rootRotationDeg });
			track("motion:job_succeeded", { latency_bucket: bucketMs(Date.now() - startedAt), input_mode: inputMode });
			trackActivation("motion");
			// Fetch and decode the real npz right away; decode errors are shown
			// in the card, playback is never faked. The clip lands on the
			// REQUESTING character, not whoever is selected now.
			if (done.motionUrl) {
				await deliverMotion(job, done.motionUrl);
				commitTakeRecipe(job, done.motionUrl);
			}
			if (job.hasBlockEdits && job.ikState) {
				// Timeline frames, not the wire frames in body.motionEdit.edits:
				// these light up the IK markers on the production clock.
				setCommittedIkEdits((current) => [...current, ...job.committedEditKeys]);
				job.ikState.keys.clear();
				job.ikState.tracked.clear();
				job.ikState.plants.clear();
				setIkTick((value) => value + 1);
			}
			setToast(isKo ? `인물 ${job.charIndex + 1} ARDY 모션 생성됨` : `ARDY motion generated for Subject ${job.charIndex + 1}`);
		} catch (err) {
			// Wave-2 gate, second line of defence. The capability preflight
			// normally stops a line edit before it is sent, but a bridge that
			// advertises the route and then 400s on the field (a half-landed
			// wave 2, an older sidecar behind the proxy) must read as "not
			// connected yet", not as a red generation failure the user could
			// act on.
			if (job.body.lineEdit && isLineEditUnsupported(err?.message)) {
				setToast(ko(
					"The line-editing backend is not connected yet",
					"라인 편집 백엔드가 아직 연결 전이에요",
				));
			}
			setArdyOutcome({
				ok: false,
				message: err?.name === "AbortError" ? ko("Cancelled", "취소됨") : err?.message || String(err),
			});
			track("motion:job_failed", {
				latency_bucket: bucketMs(Date.now() - startedAt),
				input_mode: inputMode,
				error_code: err?.name === "AbortError" ? "aborted" : (err?.name || "error"),
			});
			throw err;
		} finally {
			setArdyRunning(false);
			ardyAbortRef.current = null;
		}
	}

	/* ------------------- recipe + version bookkeeping (C9/C12) ----------------
	 * ONE writer for both. Every take that reaches the app came out of a job,
	 * so a job's completion is the only place where "what is this take made of"
	 * can be answered honestly, and the answer is checkpointed next to the
	 * motionUrl in the same breath. Nothing else may write takeRecipeRef except
	 * loadTakeVersion, which restores a checkpoint rather than authoring one. */
	function commitTakeRecipe(job, motionUrl) {
		const base = takeRecipeRef.current;
		let next = base;
		if (job.recipeIntent === "fresh") {
			// A regeneration that carried `replay` produced a take that ALREADY
			// contains those edits, so they stay on the recipe. Resetting
			// lineEdits to [] here would make the second regeneration lose what
			// the first one preserved — the exact failure replay exists to fix.
			next = freshRecipe({
				seed: job.recipeSeed,
				blocks: blocksFromRequest(job.body, ARDY_FPS),
				lineEdits: job.body.replay ?? [],
			});
		} else if (job.recipeIntent === "lineEdit") {
			// A take imported by url (?motion=, a reload) has no recipe of its own.
			// The edit's body carries the take's prompt and length, so a
			// best-effort single block is recorded rather than dropping the
			// refinement on the floor; only the SEED is a guess, and it is the
			// one this edit actually ran with. The seedless placeholder recipe an
			// imported take is given (seedLoadedTake) counts as "no recipe" for
			// the seed specifically: adopting this edit's seed is what turns it
			// into something that can replay at all.
			const seeded = Number.isInteger(base?.seed)
				? base
				: freshRecipe({
					seed: job.recipeSeed,
					blocks: base?.blocks?.length ? base.blocks : blocksFromRequest(job.body, ARDY_FPS),
					lineEdits: base?.lineEdits ?? [],
				});
			next = withLineEdit(seeded, job.recipeLineEdit);
		}
		takeRecipeRef.current = next;
		setTakeRecipe(next);
		setTakeVersions((list) => pushTakeVersion(list, {
			motionUrl,
			recipe: next,
			savedAt: Date.now(),
			label: job.recipeLabel ?? "",
		}, TAKE_VERSIONS_MAX));
	}

	/* A take can also arrive WITHOUT a job behind it — ?motion=<url>, the shipped
	 * demo clip, a scene reload that re-fetches a stored motionRef. Those takes
	 * used to leave the version strip empty, so the first refinement had nothing
	 * to walk back to and the artist's only checkpoint was the thing they had
	 * just overwritten. They get a v1 like everything else.
	 *
	 * WHAT IS HONESTLY KNOWN is the take's url, its prompt and its length —
	 * NOT its seed, which was rolled on the box in a session nobody here
	 * witnessed. So the placeholder recipe carries `seed: null` and every reader
	 * treats that as "this take cannot be rebuilt": no request may attach it as
	 * C10 `replay` (a replay whose base is a different random take re-applies
	 * refinements to a stranger), and the first real edit adopts its own seed in
	 * commitTakeRecipe. A checkpoint you can return to beats a recipe you can
	 * replay, and this gets the first without pretending to the second. */
	function seedLoadedTake(url, prompt, frames) {
		if (!url || takeRecipeRef.current) return;
		const recipe = Object.freeze({
			seed: null,
			blocks: Object.freeze([Object.freeze({
				prompt: typeof prompt === "string" ? prompt : "",
				duration: frames > 0 ? frames / TIMELINE_FPS : 0,
			})]),
			lineEdits: Object.freeze([]),
		});
		takeRecipeRef.current = recipe;
		setTakeRecipe(recipe);
		setTakeVersions((list) => pushTakeVersion(list, {
			motionUrl: url,
			recipe,
			savedAt: Date.now(),
			label: ko("Loaded", "불러옴"),
		}, TAKE_VERSIONS_MAX));
	}
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

	/** Click a chip: that motionUrl becomes the active take through the SAME
	 * delivery path a fresh generation result travels, and the recipe saved
	 * beside it becomes the current one. Nothing is truncated — editing from an
	 * old version pushes a NEW version on top, so no click can destroy work. */
	async function loadTakeVersion(entry) {
		if (!entry?.motionUrl || motionBusy) return;
		if (entry.motionUrl === takeSourceUrl) return;
		// A pull in hand was authored against the take that is leaving. The
		// preview is dropped WITHOUT reverting: this call is already loading a
		// different take, and a revert would race it with a reload of the one
		// being left behind.
		cancelLinePreview({ revert: false });
		if (lineEditMode) clearLineEdit();
		setReplayNotices([]);
		takeRecipeRef.current = entry.recipe ?? null;
		setTakeRecipe(entry.recipe ?? null);
		try {
			await deliverMotion({
				charId: activeChar.id,
				prompt: entry.recipe?.blocks?.[0]?.prompt ?? motion?.prompt ?? "",
				rootRotationDeg: motion?.rotationDeg ?? activeChar.rot,
				anchor: { x: motion?.anchorX ?? activeChar.x, z: motion?.anchorZ ?? activeChar.z },
			}, entry.motionUrl);
		} catch {
			/* loadMotion already surfaced the decode failure in the panel */
		}
	}

	/* ---------------------- the two edit entries (C12) ------------------------
	 * Scene blocks the shot with Kimodo; Refine pulls one joint's path with
	 * ProjFlow. Everything else the pipeline can do is one of those two said
	 * more precisely, and both are reachable from the take itself instead of
	 * from a foldout the artist has to remember to open.
	 *
	 * WHY THE REASONS ARE FUNCTIONS, not toasts. An action the artist cannot
	 * take must say so BEFORE the click, in place, next to the button. A toast
	 * fired after the click teaches nothing: it arrives once, scrolls away, and
	 * leaves the button looking identical to the ones that work. Each reason
	 * below is rendered as a line under its entry AND as data-disabled-reason,
	 * which is also what the CDP surface gate reads. */
	function refineDisabledReason() {
		if (!motion) return ko("No take yet — block a scene first", "아직 테이크가 없어요 — 먼저 장면을 만들어 주세요");
		if (!motion.url) return ko("This take has no bridge source — generate it once before refining", "이 테이크에는 브리지 원본이 없어요 — 한 번 생성해야 다듬을 수 있어요");
		return "";
	}
	function sceneDisabledReason() {
		if (bridge === null) return ko("Checking for the ARDY bridge…", "ARDY 브리지를 확인하는 중…");
		if (!bridge.ok) return ko("The ARDY bridge is not connected — it reconnects on its own", "ARDY 브리지가 연결되지 않았어요 — 자동으로 다시 연결됩니다");
		if (ardyRunning) return ko("A generation is already running", "이미 생성이 돌고 있어요");
		// NOT a line-edit preview, deliberately. Every other reason here is a
		// standing capability the entry should be greyed for; a draft on the
		// viewport lasts a second and a half, and a reason line appearing and
		// vanishing under the Scene button RESIZES THE TAKE BAR — which shortens
		// the stage, which changes the camera aspect, which the drift watcher
		// reads as "the view moved".
		//
		// THE TEETH ARE OUT OF THAT TRAP: drift no longer discards anything, so a
		// take-bar resize now costs at most a flicker of the ghosted paint and the
		// hint while the aspect settles — it used to kill the pull ~400 ms after
		// every draft landed. The refusal still lives in runArdy /
		// runTrailRegeneration rather than here, because a reason line that
		// appears and vanishes under the pointer is its own small nuisance and
		// nothing is gained by moving it back.
		return "";
	}
	/** The one sentence every take-consuming action says while a draft is up. */
	function previewBlockingReason() {
		return ko(
			"A line-edit preview is on the viewport — press Generate to keep it, or undo (Ctrl/Cmd+Z) to drop it",
			"라인 편집 미리보기가 떠 있어요 — 생성으로 확정하거나 Ctrl/Cmd+Z로 되돌린 뒤에 쓰세요",
		);
	}
	function sceneGenerateDisabledReason() {
		return sceneDisabledReason()
			|| (ardyPrompt.trim() || promptClips.some((clip) => clip.text.trim())
				? ""
				: ko("Describe the motion first", "먼저 어떤 동작인지 적어 주세요"));
	}
	/** Taking it AGAIN needs no fresh wording: the loaded take already knows what
	 * it was asked for, so its own prompt is the fallback (the same fallback
	 * runLineEdit uses). What it does need is a take to re-take. */
	function sceneAgainPrompt() {
		return ardyPrompt.trim() || (motion?.prompt ?? "").trim();
	}
	function sceneAgainDisabledReason() {
		return sceneDisabledReason()
			|| (motion?.url ? "" : ko("Nothing to redo yet — make a take first", "다시 뽑을 테이크가 없어요 — 먼저 한 번 만들어 주세요"))
			|| (sceneAgainPrompt() || promptClips.some((clip) => clip.text.trim())
				? ""
				: ko("This take carries no prompt — add a block and describe it", "이 테이크에는 프롬프트가 없어요 — 블록을 추가하고 동작을 적어 주세요"));
	}

	/** ONE CLICK from a loaded take into drag mode. The pull itself is authored
	 * on the viewport, but its controls live under the character's Inspector, so
	 * selecting that character and revealing the panel happen HERE rather than
	 * being three clicks the artist has to find first. */
	function enterRefineMode() {
		const reason = refineDisabledReason();
		if (reason) {
			setToast(reason);
			return;
		}
		setSceneMenuOpen(false);
		selectActiveCharacterInHierarchy();
		revealPromptBlocks();
		toggleLineEditMode();
	}
	/** Take it again — same blocks, same lineage, refinements replayed. Authored
	 * blocks go through the batch path so the schedule survives; a single-prompt
	 * take goes straight through runArdy. */
	function runSceneAgain() {
		if (promptClips.some((clip) => clip.text.trim())) runAllPromptBlocks();
		else runArdy({ promptOverride: sceneAgainPrompt() });
	}
	/** Add a block — the timeline's own add-block gesture, said as a button. */
	function addSceneBlock() {
		addPromptClip(tlFrame);
		selectActiveCharacterInHierarchy();
		revealPromptBlocks();
	}

	/** Hand a finished clip to the layer that asked for it: the buffer when
	 * the requester is still active, its stored session motion otherwise. A
	 * lightweight motionRef is persisted with the entry either way, so the
	 * clip can be re-fetched after a reload. */
	async function deliverMotion(job, motionUrl) {
		const motionRef = {
			url: motionUrl,
			prompt: job.prompt,
			rotationDeg: job.rootRotationDeg,
			anchorX: job.anchor.x,
			anchorZ: job.anchor.z,
		};
		setCharacters((list) => list.map((entry) => entry.id === job.charId ? { ...entry, motionRef } : entry));
		if (job.charId === loadedLayerCharRef.current) {
			await loadMotion(motionUrl, job.prompt, job.rootRotationDeg);
			return;
		}
		// Inbound boundary for a clip delivered to a non-active layer.
		const decoded = retimeMotion(await loadMotionFromUrl(motionUrl), TIMELINE_FPS);
		const clip = {
			...decoded,
			url: motionUrl,
			prompt: job.prompt,
			anchorX: job.anchor.x,
			anchorZ: job.anchor.z,
			anchorFrame: 0,
			rotationDeg: job.rootRotationDeg,
			editSegments: createMotionEdit(decoded.frames),
		};
		// Same stature rule as loadMotion, on the layer that asked for the clip.
		const scale = characterScaleFor(decoded);
		motionFullRef.current.set(job.charId, clip);
		setCharacters((list) => list.map((entry) => entry.id === job.charId
			? { ...entry, scale, sessionMotion: clip }
			: entry));
	}

	/** After a scene (re)load, re-fetch every persisted clip reference and
	 * rebuild the session motions. The bridge may be gone — failures just
	 * leave the character posed, never an error the user must act on. */
	function restoreMotionRefs(list) {
		for (const entry of list) {
			if (!entry.motionRef?.url) continue;
			// Inbound boundary: a re-fetched clip is retimed exactly like a
			// freshly generated one, so a reload cannot resurrect 20 fps frames.
			loadMotionFromUrl(entry.motionRef.url).then((raw) => {
				const decoded = retimeMotion(raw, TIMELINE_FPS);
				const clip = {
					...decoded,
					url: entry.motionRef.url,
					prompt: entry.motionRef.prompt,
					anchorX: entry.motionRef.anchorX,
					anchorZ: entry.motionRef.anchorZ,
					anchorFrame: 0,
					rotationDeg: entry.motionRef.rotationDeg,
					editSegments: createMotionEdit(decoded.frames),
				};
				motionFullRef.current.set(entry.id, clip);
				setCharacters((current) => current.map((item) => item.id === entry.id
					// The stature rides inside the npz, so a restored take
					// re-applies it; the saved entry scale is only the fallback
					// for a take whose npz never stored one.
					? { ...item, scale: characterScaleFor(decoded, item.scale ?? 1), sessionMotion: clip }
					: item));
				// The buffer character's clip goes straight into the editing
				// buffer too, so its motion survives the reload seamlessly.
				if (entry.id === loadedLayerCharRef.current) {
					setMotion(clip);
					setTlFrameCount((count) => Math.max(count, decoded.frames));
					setTlFps(decoded.fps);
				}
			}).catch(() => {
				// A saved take that fails to refetch used to vanish silently — the
				// user would find a merely posed character and assume their motion
				// was lost. Name it and offer the reload path.
				const subject = entry.subject || entry.id;
				setToast(isKo
					? `저장된 모션을 다시 불러오지 못했어요 (${subject}) — 새로고침하거나 모션을 다시 생성해 주세요`
					: `Saved motion could not be restored for ${subject} — reload or generate it again`);
			});
		}
	}

	function cancelArdy() {
		ardyAbortRef.current?.abort();
	}

	return (
		<div className={"app" + (renderActive ? "" : " render-idle")} data-workflow-mode={workflowMode}>
			<header className="topbar">
				<div className="logo">
					<span className="wordmark">
						Cozy <span>Clay</span>
					</span>
				</div>
				<div className="project-menu-wrap">
					<button
						type="button"
						className="project-menu-trigger"
						aria-expanded={projectMenuOpen}
						onClick={() => setProjectMenuOpen((open) => !open)}
					>
						{projectDirty && <i className="project-dirty-dot" aria-label={ko("Unsaved changes", "저장되지 않은 변경사항")} />}
						{projectName ?? (projectStartupOpen ? ko("Choose Project", "프로젝트 선택") : ko("Untitled Project", "제목 없는 프로젝트"))}
						<span className="caret">▾</span>
					</button>
					{projectMenuOpen && (
						<div className="project-menu" role="menu" onClick={() => setProjectMenuOpen(false)}>
							<button type="button" role="menuitem" onClick={requestNewProject}>{ko("New Project", "새 프로젝트")}</button>
							<button type="button" role="menuitem" onClick={() => { setProjectStartupOpen(false); setProjectBrowserOpen(true); }}>{ko("Open Project…", "프로젝트 열기…")}</button>
							<button type="button" role="menuitem" onClick={() => saveProject(false)}>{ko("Save Project", "프로젝트 저장")}</button>
							<button type="button" role="menuitem" onClick={() => saveProject(true)}>{ko("Save Project As…", "다른 이름으로 저장…")}</button>
						</div>
					)}
				</div>
				<div className="topbar-actions">
					<button
						type="button"
						className="auto-color-toggle"
						aria-pressed={autoColor}
						title={ko(
							"Distinct display colors per object — captures include them while on",
							"오브젝트별 구분 색 — 켜둔 동안 캡처에도 포함됩니다",
						)}
						onClick={() => {
							setAutoColor((on) => {
								saveAutoColor(!on);
								return !on;
							});
						}}
					>
						{ko("Auto Color", "자동 색")}
					</button>
					{liveWorkspaceHandle && (
						<span className="live-workspace-handle" data-live-workspace={liveWorkspaceHandle} title={liveWorkspaceHandle}>
							Live workspace {liveWorkspaceHandle}
						</span>
					)}
					<LocaleToggle />
					<button type="button" className="auto-color-toggle advanced-toggle" aria-pressed={advancedMode} onClick={toggleAdvancedMode}>{ko("Advanced", "고급")}</button>
					<AnalyticsToggle />
				</div>
			</header>

			<div className="main" style={workspaceStyle}>
			<div className="workspace">
				<aside className="panel hierarchy-left" aria-label={ko("Hierarchy", "계층")}>
				{/* Project > Scene: the project is the document root, scenes live
				    inside it — the picker sits at the top of the hierarchy column. */}
				<div className="hierarchy-project" data-dirty={projectDirty || undefined}>
					<span className="hierarchy-project-label">{ko("Project", "프로젝트")}</span>
					<strong>{projectName ?? (projectStartupOpen ? ko("Choose Project", "프로젝트 선택") : ko("Untitled", "제목 없음"))}</strong>
					{projectDirty && <i className="project-dirty-dot" aria-label={ko("Unsaved changes", "저장되지 않은 변경사항")} />}
					<button type="button" onClick={() => { setProjectStartupOpen(false); setProjectBrowserOpen(true); }}>{ko("Projects…", "프로젝트…")}</button>
				</div>
				<HierarchyPanel
					selectedId={selectedHierarchyId}
					onSelect={(id) => {
						selectHierarchy(id);
						if (id === "light") aimEditorAtKeyLight();
					}}
					characters={characters}
					showB={showB}
					motionFrames={motion?.frames ?? 0}
					ikFrames={ikFrames.length}
					ikMode={ikMode}
					ikRowId={rowIdForCharIndex(activeCharIndex)}
					waypointCount={waypoints.length}
					sceneObjects={sceneObjects}
					scenes={scenes}
					activeSceneId={activeSceneId}
					onSceneSelect={selectSceneDocument}
					onSceneCreate={createSceneDocumentFromUi}
					onSceneDuplicate={duplicateSceneDocumentFromUi}
					onSceneRename={renameSceneDocumentFromUi}
					onSceneDelete={deleteSceneDocumentFromUi}
					onAddObject={addSceneObject}
					onRenameObject={renameSceneObject}
					onDuplicateObject={duplicateSelectedSceneObject}
					onDeleteObject={deleteSceneObject}
					onFrameObject={frameSelection}
					propsDrop={propsDrop}
					reparent={hierarchyReparent}
				/>
				</aside>
				<div
					className="workspace-splitter workspace-splitter-vertical"
					role="separator"
					aria-label={ko("Resize hierarchy panel", "계층 패널 크기 조절")}
					onPointerDown={(event) => beginWorkspaceResize("hierarchy", event)}
				/>
				<div className="viewport" data-drop={viewportDrop.over ? "over" : undefined} {...viewportDrop.handlers}>
				<div className="viewport-titlebar">
				<div className="workflow-mode-switch" role="tablist" aria-label={ko("Workflow", "작업 모드")}>
					{[
						["scene", ko("Scene", "장면"), ko("Place subjects and props", "인물과 소품 배치")],
						["camera", ko("Camera", "카메라"), ko("Frame the shot", "샷 구도 설정")],
						["motion", ko("Motion", "모션"), ko("Edit timing and movement", "타이밍과 움직임 편집")],
					].map(([id, label, hint]) => (
						<button
							type="button"
							role="tab"
							key={id}
							className={workflowMode === id ? "active" : ""}
							aria-selected={workflowMode === id}
							title={hint}
							onClick={() => selectWorkflowMode(id)}
						>
							{label}
						</button>
					))}
				</div>
				<div className="pane-tabs" role="tablist" aria-label={ko("Center view", "가운데 보기")}>
					<button
						type="button"
						role="tab"
						aria-selected={centerTab === "scene"}
						className={centerTab === "scene" ? "active" : ""}
						onClick={() => setCenterTab("scene")}
					>
						{ko("Scene", "장면")}
					</button>
					<button
						type="button"
						role="tab"
						aria-selected={centerTab === "play"}
						className={centerTab === "play" ? "active" : ""}
						onClick={() => setCenterTab("play")}
					>
						{ko("PlayView", "재생 보기")}
					</button>
				</div>
				{centerTab === "scene" ? (
				<div className="editor-toolbar scene-tools" aria-label={ko("Scene tools", "장면 도구")}>
					{workflowMode === "motion" && (
						<span className="workflow-toolbar-hint" role="status">
							{ko("Motion mode · edit the timeline below", "모션 모드 · 아래 타임라인에서 편집하세요")}
						</span>
					)}
						<div className="tool-switch workflow-scene-context" role="group" aria-label={ko("Gizmo tool", "기즈모 도구")}>
							<button
								type="button"
								className={gizmoMode === "move" ? "active" : ""}
								title={ko("Move tool (W)", "이동 도구 (W)")}
								aria-pressed={gizmoMode === "move"}
								onClick={() => setGizmoMode("move")}
							>
								<svg viewBox="0 0 16 16" aria-hidden="true" className="tool-icon"><path d="M8 1v14M1 8h14" stroke="currentColor" strokeWidth="1.4"/><path d="M8 1 6 3h4L8 1zM8 15l-2-2h4l-2 2zM1 8l2-2v4L1 8zM15 8l-2-2v4l2-2z" fill="currentColor"/></svg>
								{ko("Move", "이동")}
							</button>
							<button
								type="button"
								className={gizmoMode === "rotate" ? "active" : ""}
								title={ko("Rotate tool (E)", "회전 도구 (E)")}
								aria-pressed={gizmoMode === "rotate"}
								onClick={() => setGizmoMode("rotate")}
							>
								<svg viewBox="0 0 16 16" aria-hidden="true" className="tool-icon"><circle cx="8" cy="8" r="5.4" fill="none" stroke="currentColor" strokeWidth="1.4"/><path d="M13.4 8l2-2v4l-2 2z" fill="currentColor" transform="rotate(45 13.4 8)"/></svg>
								{ko("Rotate", "회전")}
							</button>
							<button
								type="button"
								className={gizmoMode === "scale" ? "active" : ""}
								title={ko("Scale tool (R)", "크기 도구 (R)")}
								aria-pressed={gizmoMode === "scale"}
								onClick={() => setGizmoMode("scale")}
							>
								<svg viewBox="0 0 16 16" aria-hidden="true" className="tool-icon"><rect x="3" y="3" width="7" height="7" fill="none" stroke="currentColor" strokeWidth="1.4"/><path d="M13 13h-4M13 13V9M13 13l-3.5-3.5" stroke="currentColor" strokeWidth="1.4" fill="none"/></svg>
								{ko("Scale", "크기")}
							</button>
						</div>
						<button
							type="button"
							className={"snap-switch workflow-scene-context" + (snapEnabled ? " active" : "")}
							title={ko("Grid snapping — hold Ctrl during a drag to invert", "그리드 스냅 — 드래그 중 Ctrl을 누르면 반대로 작동")}
							aria-pressed={snapEnabled}
							onClick={() => setSnapEnabled((v) => !v)}
						>
							{ko("Snap", "스냅")}
						</button>
						<button
							type="button"
							className={"snap-switch grid-view-switch workflow-scene-context" + (gridView ? " active" : "")}
							title={ko("Blender-style viewport — dark void with a reference grid instead of the deck", "Blender식 뷰포트 — 데크 대신 어두운 배경과 기준 그리드")}
							aria-pressed={gridView}
							onClick={() => setGridView((v) => !v)}
						>
							{ko("Grid", "그리드")}
						</button>
						<span className="viewport-toolbar-separator settings-separator workflow-camera-context" aria-hidden="true" />
						<label className="viewport-toolbar-field shot-field workflow-camera-context">
							<span>{ko("Shot", "샷")}</span>
							<select
								aria-label={ko("Shot preset", "샷 프리셋")}
								value={preset}
								onChange={(event) => applyPreset(event.target.value)}
							>
								{Object.entries(PRESETS).map(([key, value]) => (
									<option key={key} value={key}>{value.label}</option>
								))}
							</select>
						</label>
						<label className="viewport-toolbar-field ratio-field workflow-camera-context">
							<span>{ko("Ratio", "비율")}</span>
							<select
								aria-label={ko("Output aspect ratio", "출력 화면 비율")}
								value={shotAspectKey}
								onChange={(event) => setShotAspectKey(event.target.value)}
							>
								{Object.values(SHOT_ASPECT_PRESETS).map((value) => (
									<option key={value.label} value={value.label}>{value.label}</option>
								))}
							</select>
						</label>
						<label className="viewport-fov-control workflow-camera-context">
							<span>FOV</span>
							<input
								type="range"
								min="14"
								max="90"
								step="1"
								value={fovDeg}
								onChange={(event) => setFovDeg(Number(event.target.value))}
							/>
							<output>{Math.round(fovDeg)}°</output>
							<small>{shot.focalMm}mm</small>
						</label>
						<span className="viewport-toolbar-spacer workflow-camera-context" />
						<button
							type="button"
							title={ko("Recenter on subject", "피사체 다시 맞추기")}
							aria-label={ko("Recenter on subject", "피사체 다시 맞추기")}
							className="workflow-camera-context"
							onClick={() => setNonce((n) => n + 1)}
						>
							◎
						</button>
						<button
							type="button"
							aria-pressed={!workspaceLayout.insetCollapsed}
							className="workflow-scene-context workflow-camera-context"
							onClick={() => {
								if (workspaceLayout.insetCollapsed) expandInset();
								else setWorkspaceLayout((current) => ({ ...current, insetCollapsed: true }));
							}}
						>
							{ko("Top", "탑")} {workspaceLayout.insetCollapsed ? "▸" : "▾"}
						</button>
					</div>
				) : (
					<div className="editor-toolbar play-tools" aria-label={ko("PlayView tools", "재생 보기 도구")}>
						<span className="viewport-readout">{shotOutput.label}</span>
						<span className="viewport-readout">FOV {Math.round(fovDeg)}° · {shot.focalMm}mm</span>
						<span className="viewport-toolbar-spacer" />
						<button type="button" onClick={() => stepFrame(-1)} aria-label={ko("Previous frame", "이전 프레임")}>◀</button>
						<button type="button" onClick={() => setTlPlaying((value) => !value)}>
							{tlPlaying ? "Ⅱ" : "▶"}
						</button>
						<button type="button" onClick={() => stepFrame(1)} aria-label={ko("Next frame", "다음 프레임")}>▶│</button>
						<span className="viewport-readout">1.00×</span>
						<span className="viewport-toolbar-separator" aria-hidden="true" />
						<button type="button" disabled={!shots.length} onClick={downloadOtioCutList}>
							OTIO
						</button>
						<button
							type="button"
							className={recState === "recording" ? "recording" : ""}
							disabled={recState !== "recording" && !hasCameraKeys && !motion}
							onClick={toggleShotRecording}
						>
							{recState === "recording" ? ko("■ Stop", "■ 정지") : ko("● Record", "● 녹화")}
						</button>
					</div>
				)}
				</div>

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
							<color attach="background" args={[gridView ? GRID_BACKGROUND : "#eef4f3"]} />
							{/* The open stage runs 500 m; without a falloff the whole deck
							    reads at once and the horizon sits a kilometre away. Blender's
							    viewport answer is a clip distance that lets the neutral void
							    show through; the fog below is the seamless version of the
							    same idea — it fades the floor INTO the background colour, so
							    past ~120 m the deck simply ceases to exist with no horizon
							    line, no clip edge and no tone break. */}
							<fog attach="fog" args={gridView ? [GRID_FOG.color, GRID_FOG.near, GRID_FOG.far] : ["#eef4f3", 18, 54]} />
							<StageLights keyLight={keyLight} neutral={gridView} />
							<KeyLightPuck
								keyLight={keyLight}
								selected={keyLightSelected}
								visible={centerTab === "scene" && !lookThroughShot && !playMode}
								paneRef={mainPaneRef}
								camRef={editorCamRef}
								onSelect={() => selectHierarchy("light")}
								onChange={(patch) => setKeyLight((current) => createKeyLight({ ...current, ...patch }))}
							/>
							{gridView ? <GridFloor layer={GIZMO_LAYER} /> : <Room />}
							<SetProps
								objects={displaySceneObjects}
								selectedId={selectedSceneObjectId}
								frameRef={propFrameRef}
								take={{ frameCount: tlFrameCount, fps: tlFps }}
								attachFrameRef={attachFrameRef}
								syncRef={propSyncRef}
								worldRef={propWorldRef}
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
								<Character
									key={`${view.id}:${rigMountEpoch}`}
									url={view.url}
									position={view.position}
									rot={view.rot}
									tint={view.tint}
									pose={view.pose}
									scale={view.scale}
									onRig={view.onRig}
									pickId={view.pickId}
								/>
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
										if (patch.x !== undefined) next.x = THREE.MathUtils.clamp(patch.x, -4, 4);
										// Lift floors at the deck but has no ceiling — a crane
										// shot may hoist the body as high as the move needs
										// (the inspector's Height scrub agrees).
										if (patch.y !== undefined) next.y = Math.max(0, patch.y);
										if (patch.z !== undefined) next.z = THREE.MathUtils.clamp(patch.z, -4, 4);
										// a body only yaws — the X/Z rings and the screen ring's
										// other channels have nowhere to go on a character
										if (patch.rotY !== undefined) next.rot = patch.rotY;
										// one stature knob: any scale axis reads as uniform
										const s = patch.scaleX ?? patch.scaleY ?? patch.scaleZ;
										if (s !== undefined) next.scale = THREE.MathUtils.clamp(s, 0.2, 3);
										return next;
									})}
									onDragStart={recordCharacterUndo}
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
								// PlayView is the finished-output player: the move always rides
								// the playhead there. The Follow toggle and authoring-mode gates
								// only protect the Scene tab's manipulation surfaces.
								// This shot's Camera Block owns the camera while Follow or Rail is active;
								// editorial camera keys resume when the block returns to Keys mode.
								following={!followCamActive && hasCameraKeys && (centerTab === "play" || (moveFollow && !ikMode && !waypointMode && !posing))}
								followFrame={tlFrame}
								fps={tlFps}
								keys={cameraKeys}
								shots={shots}
								scene={playbackScene}
								camRef={shotCamRef}
								look={look}
								isInterrupted={() => (lookThroughShot && flyingRef.current) || manualCameraOverrideRef.current}
								onDone={(finalFov) => {
									setMovePlaying(false);
									setFovDeg(Math.round(finalFov * 10) / 10);
								}}
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
								camRef={ikMode ? poserCamRef : lookThroughShot ? shotCamRef : editorCamRef}
								look={ikMode ? poserLook : lookThroughShot ? look : editorLook}
								getPivot={() => {
									if (!selectedSceneObject) return null;
									const size = objectSize(selectedSceneObject);
									return { x: selectedSceneObject.x, y: (selectedSceneObject.y ?? 0) + size.height / 2, z: selectedSceneObject.z };
								}}
								onFlyStateChange={(flying) => {
									flyingRef.current = flying;
								}}
								onCameraChange={lookThroughShot && !ikMode ? commitManualCameraFraming : undefined}
							/>
							<PoseHandles
								root={posedRig()}
								enabled={!!posing && !planIsMain && !playMode}
								onChange={() => setPoseTick((n) => n + 1)}
							/>
							<IkHandles
								chains={ikChains}
								fkJoints={ikFkJoints}
								ikState={ikStateRef.current}
								enabled={ikMode && ikEditTool === "ik" && !posing && !playMode}
								focus={ikFocus}
								onFocus={focusIkHandle}
								onSolve={ikSolve}
								onDragEnd={ikDragEnd}
							/>
							<PlanBoard
								hostRef={planHostRef}
								planCamRef={planCamRef}
								shotCamRef={shotCamRef}
								look={look}
								fovDeg={fovDeg}
								characters={characters}
								onMoveCharacter={moveCharacter}
								onCharacterGestureStart={recordCharacterUndo}
								onWaypointGestureStart={recordCharacterUndo}
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
									store.settle();
									setSelectedHierarchyId(id.startsWith("object:") ? id : id === "cam" ? "camera" : charKeyToHierarchyId(id));
								}}
								sceneObjects={displaySceneObjects}
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
								onRailStroke={(stroke) => {
									const simplified = simplifyStroke(stroke, 0.12);
									if (simplified.length < 2) return;
									changeCameraRail(simplified);
									setRailDraw(false);
									const curve = buildRail(simplified);
									setToast(isKo ? `카메라 레일 완성 — ${curve ? curve.length.toFixed(1) : "?"} m, 제어점 ${simplified.length}개` : `Camera rail drawn — ${curve ? curve.length.toFixed(1) : "?"} m, ${simplified.length} control points`);
								}}
								onPathStroke={(stroke) => {
									if (!selectedSceneObject) return;
									// Few points on purpose: the stroke sets the shape, the
									// operator adds the handles they actually want by
									// double-clicking the line. Height comes later, from
									// dragging a point in the scene.
									const points = strokeToPathPoints(stroke, simplifyStroke);
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
								object={cameraGizmoObject ?? lightGizmoObject ?? selectedSceneObject}
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
									if (!cameraGizmoObject && !lightGizmoObject) endSceneTransaction(...args);
								}}
								onSelect={(id) =>
									selectHierarchy(
										id === "__shotcam__" ? "camera" : id === "__keylight__" ? "light" : id?.startsWith("char:") ? charKeyToHierarchyId(id) : id ? `object:${id}` : "props",
									)
								}
								onGroundClick={waypointMode && !planIsMain ? addFloorWaypoint : undefined}
								claimPointer={lineEditMode ? lineGrabProbe : undefined}
							/>
							{centerTab === "scene" && railCurve && (
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
								enabled={centerTab === "scene" && !lookThroughShot && !ikMode && !posing && !playMode && !!selectedSceneObject?.path}
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
								enabled={centerTab === "scene" && !lookThroughShot && !ikMode && !posing && !playMode && !!railCurve && !!activeCamera.craneHeight}
								paneRef={mainPaneRef}
								camRef={editorCamRef}
								onSelect={setCraneSelectedIndex}
								onChangePoints={(points, options) => {
									if (!options?.dragging) {
										changeActiveCamera({ craneHeight: { points } });
										return;
									}
									setShots((current) =>
										updateStableItem(
											current,
											activeShot.id,
											(shot) => ({ ...shot, camera: updateCameraBlock(shot.camera, { craneHeight: { points } }) }),
											"shots",
										),
									);
								}}
								onChangeRail={(points, options) => {
									if (!options?.dragging) {
										changeActiveCamera({ cameraRail: points });
										return;
									}
									setShots((current) =>
										updateStableItem(
											current,
											activeShot.id,
											(shot) => ({ ...shot, camera: updateCameraBlock(shot.camera, { cameraRail: points }) }),
											"shots",
										),
									);
								}}
								onDragStart={recordShotUndo}
							/>
							<EditorCamSeed camRef={editorCamRef} lookRef={editorLook} shotCamRef={shotCamRef} subject={charA} />
							<CameraGlide glide={camGlide} camRef={editorCamRef} lookRef={editorLook} onDone={() => setCamGlide(null)} />
							<ShotLookApplier camRef={shotCamRef} look={look} />
							<ShotCameraGhost
								camRef={shotCamRef}
								fovDeg={fovDeg}
								aspect={shotOutput.aspect}
								visible={centerTab === "scene" && !lookThroughShot && !ikMode && !posing}
								selected={shotCameraSelected}
							/>
							{waypointMode && centerTab === "scene" && (
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
									baseY={activeChar.y ?? 0}
									charScale={activeChar.scale ?? 1}
									ikFocus={ikFocus}
									falloffFrames={trailFalloffFrames}
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
								ikMode={ikMode}
								planIsMain={planIsMain}
								playMode={playMode}
								lookThrough={lookThroughShot}
								insetCollapsed={workspaceLayout.insetCollapsed || workflowMode === "motion"}
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
										if (workspaceLayout.insetCollapsed) expandInset();
										else setWorkspaceLayout((current) => ({ ...current, insetCollapsed: true }));
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
									onClick={() => setGuideMode((mode) => nextGuideMode(mode))}
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
									title={ko("Fly the shot camera itself (Esc returns)", "샷 카메라를 직접 조종 (Esc로 복귀)")}
									onClick={() => setLookThroughShot(true)}
								>
									<svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
										<path d="M15 3h6v6" />
										<path d="M21 3l-8 8" />
										<path d="M9 21H3v-6" />
										<path d="M3 21l8-8" />
									</svg>
								</button>
							</span>
						</div>
						{lookThroughShot && !playMode && !ikMode && (
							<button
								type="button"
								className="vp-inset-tag vp-look-through-exit"
								title={ko("Return to the editor view (Esc)", "에디터 시점으로 돌아가기 (Esc)")}
								onClick={() => setLookThroughShot(false)}
							>
								<span className="vp-rec-dot" aria-hidden="true" />
								{ko("Shot camera", "샷 카메라")}
								<span className="vp-exit-hint">{ko("Esc · exit", "Esc · 나가기")}</span>
							</button>
						)}

						{lookThroughShot && !playMode && !ikMode && (
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

						{playMode && !motion && (
							<div className="playview-empty" role="status">
								<strong>{ko("No motion yet", "아직 모션이 없어요")}</strong>
								{bridge?.ok ? (
									<span>{ko("Generate motion in the Scene tab — PlayView plays the finished result.", "장면 탭에서 모션을 생성하세요. 재생 보기는 완성 결과를 보여줍니다.")}</span>
								) : (
									<>
										<span>{ko("This hosted demo loads a sample walk cycle for you — switch to the Scene tab and press play.", "이 데모는 샘플 걷기 모션을 불러왔어요 — 장면 탭에서 재생을 눌러보세요.")}</span>
										<button type="button" className="btn ghost" onClick={() => { setCenterTab("scene"); track("sample:played", { from: "playview_empty" }); }}>
											{ko("▶ Watch the sample", "▶ 샘플 구경하기")}
										</button>
									</>
								)}
							</div>
						)}

						</div>
					</div>

				<div
					className="workspace-splitter workspace-splitter-vertical"
					role="separator"
					aria-label={ko("Resize hierarchy and inspector panel", "계층 및 속성 패널 크기 조절")}
					onPointerDown={(event) => beginWorkspaceResize("sidebar", event)}
				/>
				<aside className="panel hierarchy-sidebar inspector-sidebar" data-inspector={selectedHierarchyId}>
					{/* Save failures live above the tab content, not inside the Props
					    card: that card is hidden whenever any hierarchy node is
					    selected, and saves fire exactly while objects are being
					    edited — the one case where a failure line inside it is
					    invisible. As a sibling of the tab panes this line stays
					    on screen for every selection and every tab until the
					    next successful write clears it (plan §8.4); the one-shot
					    toast still announces each failure episode. */}
					{sceneSaveError && (
						<p className="scene-save-error" role="status">
							{sceneSaveError}
						</p>
					)}
					<section className="inspector-pane">
					<div className="inspector-heading">
						<strong>{ko("Inspector", "속성")}</strong>
						<span className="inspector-heading-selection">{selectedSceneObject ? sceneObjectNameDisplayKo(selectedSceneObject.name) : HIERARCHY_INSPECTOR_TITLES[rigSelection?.token ?? selectedHierarchyId] ?? ko("Selection", "선택 항목")}</span>
						{selectedSceneObject && (
							<div className="inspector-actions-wrap">
								<button
									type="button"
									className="inspector-actions-trigger"
									aria-label={ko("Object actions", "오브젝트 작업")}
									aria-expanded={inspectorActionsOpen}
									onClick={() => setInspectorActionsOpen((open) => !open)}
								>
									⋮
								</button>
								{inspectorActionsOpen && (
									<div className="inspector-actions-menu" role="menu">
										<button type="button" role="menuitem" onClick={() => { duplicateSelectedSceneObject(); setInspectorActionsOpen(false); }}>
											{ko("Duplicate", "복제")}
										</button>
										<button type="button" role="menuitem" onClick={() => { deleteSelectedSceneObject(); setInspectorActionsOpen(false); }}>
											{ko("Delete", "삭제")}
										</button>
									</div>
								)}
							</div>
						)}
					</div>
					<div className="inspector-scroll">
				{/* Nothing is selected that owns settings — say so rather than
				    showing an empty column the user has to interpret. */}
				{!inspectorHasContent && (
					<p className="inspector-empty" data-inspector-empty role="status">
						{ko(
							"Select something in the hierarchy — the scene, the camera, a character, the environment or a prop — and its settings appear here.",
							"계층에서 항목을 고르면 — 씨, 카메라, 캐릭터, 환경, 소품 — 그 설정이 여기 나타납니다.",
						)}
					</p>
				)}
				{/* Shot TYPE presets live in the viewport toolbar dropdown — not
					    duplicated here. */}

					{/* Camera animation is authored against the same playhead as motion,
					    so keep its controls beside the Motion tools as well as Shot setup. */}
					<Foldout hidden={!keyLightSelected} title={ko("Light", "조명")}>
						<p className="hint">{ko("Drag the sun in the scene to move the light. Shadows and warmth follow it.", "씬의 해를 드래그해 조명을 옮깁니다. 그림자와 빛의 방향이 따라옵니다.")}</p>
						<Slider label={ko("Brightness", "밝기")} min={0} max={4} step={0.05} value={keyLight.intensity} onChange={(value) => setKeyLight((current) => createKeyLight({ ...current, intensity: value }))} />
						<Slider label={ko("Warm ↔ Cool", "따뜻함 ↔ 차가움")} min={0} max={1} step={0.05} value={keyLight.warmth ?? 0.5} onChange={(value) => setKeyLight((current) => createKeyLight({ ...current, warmth: value }))} />
						<div className="readout">
							<span title={ko("light position", "조명 위치")}>{`x ${keyLight.x.toFixed(1)}  y ${keyLight.y.toFixed(1)}  z ${keyLight.z.toFixed(1)}`}</span>
						</div>
						<button className="btn ghost" onClick={() => setKeyLight(createKeyLight(null))}>
							{ko("Reset light", "조명 초기화")}
						</button>
					</Foldout>
					<Foldout hidden={!isCameraSelection} title={ko("Camera", "카메라")}>
					<Slider label={ko("Lens (FOV)", "렌즈 (FOV)")} min={14} max={90} step={1} value={fovDeg} unit="°" onChange={setFovDeg} />
						<div className="readout">
						<span title={ko("camera to subject", "카메라와 피사체 거리")}>{shot.distance.toFixed(2)} m</span>
						<span title={ko("nearest prime on the cropped filmback", "크롭된 필름백 기준 가장 가까운 단렌즈")}>{shot.focalMm} mm</span>
						<span title={ko("angle relative to the subject's eyes", "피사체 눈높이 기준 각도")}>{shot.elevationDeg.toFixed(0)}°</span>
						</div>
						<button className="btn ghost" onClick={() => setNonce((n) => n + 1)}>
							{ko("Recenter on subject", "피사체 다시 맞추기")}
						</button>

						<h3 className="move-head">{ko("Move keys", "움직임 키")}</h3>
						<div className="move-ab">
							<button
								type="button"
								className={"btn ghost" + (recState === "recording" ? " rec-live" : "")}
								disabled={!hasCameraKeys && !motion}
								title={ko("Play the piece in PlayView and save it as a video file — camera move and character motion, no editor chrome", "재생 보기에서 장면을 재생하고 영상 파일로 저장합니다. 카메라 움직임과 캐릭터 모션만 담고 편집 UI는 제외됩니다")}
								onClick={toggleShotRecording}
							>
								{recState === "recording" ? ko("■ Stop rec", "■ 녹화 정지") : ko("● Record", "● 녹화")}
							</button>
						</div>
						{moveSequence ? (
							<div className="move-slate" title={ko("derived from the keyframings, not chosen from a list", "목록에서 고른 값이 아니라 키프레임에서 계산된 움직임입니다")}>
								{moveSequence.displaySlate} · {moveSequence.spanS}{ko("s", "초")}
							</div>
						) : (
							<div className="move-slate">
								{cameraKeys.length === 1
									? (isKo ? `프레임 ${cameraKeys[0].frame}부터 고정 샷 — 샷 블록 아래 빈 줄을 클릭해 움직임을 추가하세요` : `locked-off hold from frame ${cameraKeys[0].frame} — click the empty lower strip in a Shot block to add a move`)
									: ko("click a Shot block's lower strip to key the current framing at that frame", "샷 블록 아래 빈 줄을 클릭하면 해당 프레임에 현재 프레이밍을 저장합니다")}
							</div>
						)}

						<h3 className="move-head">{ko("Follow cam", "팔로우 카메라")}</h3>
						<p className="camera-editor-pointer">
							{activeShot
								? ko(`Editing ${activeShot.name} in the timeline camera bar below.`, `아래 타임라인 카메라 바에서 ${activeShot.name}을 편집합니다.`)
								: ko("Select a Shot block below to edit its camera.", "아래에서 샷 블록을 선택하면 카메라를 편집할 수 있습니다.")}
						</p>
					</Foldout>

				<Foldout hidden={!isCharacterSelection} title={showB ? ko("Subjects", "인물들") : ko("Subject", "인물")}>
						<div className={"subjects-row" + (showB ? "" : " single")}>
							{characters.map((entry, index) => entry.hidden ? null : (
								<SubjectBox
									key={entry.id}
									label={ko(`Subject ${index + 1}`, `인물 ${index + 1}`)}
									value={entry}
									onChange={(next) => updateCharacterAt(index, next)}
									onPose={() => openStudio(entry.id)}
									posing={posing === entry.id}
									onRemove={index > 0 ? () => removeCharacter(entry.id) : undefined}
									color={entry.tint ?? defaultCharacterTint(entry, index)}
									/* A colour picker streams values while it is open, so the
									   whole picking session is one Ctrl+Z entry. */
									onColorEditStart={() => recordSessionUndo(tintSessionRef, `tint:${entry.id}`)}
									onColorChange={(tint) => updateCharacterAt(index, { tint })}
								/>
							))}
						</div>
						{!showB && (
							<button type="button" className="add-subject" onClick={() => setShowB(true)}>
								<span className="as-plus">＋</span>
								<span>{ko("Add second subject", "두 번째 인물 추가")}</span>
							</button>
						)}
					</Foldout>

				{/* Rig and Pose are chosen once when a character is cast and then left
				    alone, so they open on demand — Subject and Prompt are the panels
				    you actually work in. */}
				<Foldout hidden={!advancedMode || !isCharacterSelection} defaultOpen={false} title={ko("Rig", "리그")}>
					{/* The rig is a property of the character, and swapping it is a
					    look decision made while blocking — so it belongs beside the
					    subject, not buried in the project file. */}
					<div className="rig-picker" role="radiogroup" aria-label={ko("Character rig", "캐릭터 리그")}>
						{CHARACTER_MODEL_IDS.map((id) => (
							<button
								type="button"
								key={id}
								role="radio"
								aria-checked={activeChar.model === id}
								className={"rig-option" + (activeChar.model === id ? " active" : "")}
								data-rig-id={id}
								onClick={() => {
									if (activeChar.model === id) return;
									recordCharacterUndo();
									updateCharacterAt(activeCharIndex, { model: id });
								}}
							>
								<PoseThumbPreview model={id} pose={activeChar.pose ?? DEFAULT_POSE} alt={CHARACTER_MODEL_LABELS[id]} />
								<span>{CHARACTER_MODEL_LABELS[id]}</span>
							</button>
						))}
					</div>
				</Foldout>

				<Foldout hidden={!advancedMode || !isCharacterSelection} defaultOpen={false} title={ko("Pose", "포즈")}>
					{/* Tiles, not a dropdown: a pose read out of a photograph has no
					    name worth reading — it is recognisable only as a shape. This
					    is the same grid the studio shows, applied to whichever
					    character the hierarchy has selected. */}
					<p className="inspector-hint">
						{isKo ? `인물 ${activeCharIndex + 1}의 자세입니다.` : `The pose on Subject ${activeCharIndex + 1}.`}
					</p>
					<PoseTileGrid
						poses={selectablePoses}
						model={activeChar.model}
						selectedId={(activeChar.pose ?? DEFAULT_POSE)?.id}
						onSelect={(id) => {
							const pose = selectablePoses.find((entry) => entry.id === id);
							if (!pose) return;
							// IK mode over a take: the pick is a mid-clip correction, so it
							// keys onto the Full-Body lane instead of erasing the motion.
							if (ikMode && ikApplyPoseAsKey(pose)) return;
							// A running take drives the same bones a pose writes, so the
							// pick would otherwise land invisibly underneath it.
							const hadMotion = Boolean(motion);
							// One pick, one Ctrl+Z entry: clearMotion()'s snapshot already
							// carries the pose this write replaces.
							if (hadMotion) clearMotion();
							else recordCharacterUndo();
							updateCharacterAt(activeCharIndex, { pose });
							setStudioPick(pose.id);
							setToast(hadMotion
								? ko("Cleared the current motion and applied the pose", "현재 모션을 지우고 포즈를 적용했어요")
								: ko("Pose applied", "포즈를 적용했어요"));
						}}
						onDelete={removePose}
						onPhoto={() => {
							setPhotoPoseError("");
							photoPoseFileRef.current?.click();
						}}
						photoState={photoPoseState}
						labelOf={poseLabelKo}
					/>
					{photoPoseError && <p className="studio-hint error" data-pose-photo-error role="status">{photoPoseError}</p>}
					{/* Bottles whatever the viewport shows right now — a take frame,
					    IK corrections included — without touching the character, so a
					    good mid-clip moment becomes a reusable library pose. */}
					<button
						type="button"
						className="btn full"
						data-save-current-pose
						disabled={!activeRig}
						title={ko(
							"Save the pose the character is in right now — with a motion loaded, that is the current frame plus IK corrections",
							"캐릭터의 지금 자세를 저장해요 — 모션이 실려 있으면 현재 프레임에 IK 보정까지 합친 자세예요",
						)}
						onClick={saveCurrentPose}
					>
						{ko("Save current pose", "지금 자세 저장")}
					</button>
				</Foldout>

				<Foldout hidden={!advancedMode || !isCharacterSelection} defaultOpen={false} title={ko("Video capture", "영상 모캡")}>
					<div className="multimodel-card">
						<div className="multimodel-card-head">
							<div>
								<strong>{ko("Footage → motion", "영상 → 모션")}</strong>
								<span>{ko("Prepare a source inside the Motion workspace.", "모션 작업공간에서 입력 영상을 준비하세요.")}</span>
							</div>
							<span className={"multimodel-status " + multiModelStatus}>
								{multiModelStatus === "ready"
									? ko("READY", "준비됨")
									: multiModelStatus === "error"
										? ko("CHECK", "확인 필요")
										: multiModelStatus === "busy"
											? (multiModelStage === "fetching" ? ko("FETCHING", "받는 중") : ko("PROBING", "분석 중"))
											: ko("IDLE", "대기")}
							</span>
						</div>
						<div className="multimodel-input-block">
							<div className="multimodel-input-label">
								<strong>{ko("Local video file", "로컬 비디오 파일")}</strong>
								<span>{ko("Upload from this computer", "이 컴퓨터에서 업로드")}</span>
							</div>
							<div className="multimodel-source-row">
								<button type="button" className="btn ghost" onClick={() => multiModelFileRef.current?.click()}>
									{ko("Choose video", "영상 선택")}
								</button>
								<input ref={multiModelFileRef} className="multimodel-file-input" type="file" accept="video/*" onChange={chooseMultiModelFile} />
								<span className="multimodel-file-name">{multiModelSource?.kind === "file" ? multiModelSource.name : ko("No file selected", "파일이 선택되지 않음")}</span>
							</div>
						</div>
						<div className="multimodel-input-block">
							<div className="multimodel-input-label">
								<strong>{ko("Video URL", "비디오 URL")}</strong>
								<span>{ko("Use a hosted or local route", "호스팅 또는 로컬 경로 사용")}</span>
							</div>
							<input
								className="multimodel-url-input"
								type="text"
								value={multiModelUrl}
								onChange={(event) => setMultiModelUrl(event.target.value)}
								onKeyDown={(event) => { if (event.key === "Enter") useMultiModelUrl(); }}
								placeholder={ko("https://…/boxing.mp4", "https://…/boxing.mp4")}
								aria-label={ko("Multi-Model video URL", "멀티 모델 영상 URL")}
								spellCheck={false}
							/>
							<div className="multimodel-url-actions">
								<button type="button" className="btn ghost" onClick={pasteMultiModelUrl}>
									{ko("Paste", "붙여넣기")}
								</button>
								<button type="button" className="btn ghost" onClick={() => setMultiModelUrl("")} disabled={!multiModelUrl}>
									{ko("Clear", "지우기")}
								</button>
								<button type="button" className="btn primary" onClick={useMultiModelUrl} disabled={!multiModelUrl.trim()}>
									{ko("Use URL", "URL 사용")}
								</button>
							</div>
						</div>
						{multiModelStatus === "busy" && (
							<div className="multimodel-progress">
								<div className="multimodel-progress-track">
									<div
										className={"multimodel-progress-bar" + (multiModelProgress === null ? " indeterminate" : "")}
										style={multiModelProgress === null ? undefined : { width: `${Math.round(multiModelProgress * 100)}%` }}
									/>
								</div>
								<span>
									{multiModelStage === "fetching"
										? (multiModelProgress === null
											? ko("Downloading…", "다운로드 중…")
											: `${Math.round(multiModelProgress * 100)}%`)
										: ko("Decoding…", "디코딩 중…")}
								</span>
							</div>
						)}
						{multiModelError && <p className="multimodel-error">{multiModelError}</p>}
						{multiModelFootage && (
							<div className="multimodel-receipt">
								<video className="multimodel-preview" src={multiModelFootage.objectUrl} muted playsInline preload="metadata" />
								<div className="multimodel-receipt-body">
									<strong>{multiModelSource?.name}</strong>
									<span>{footageSummary(multiModelFootage)}</span>
									<span className="multimodel-receipt-timeline">
										{isKo
											? `타임라인 0–${multiModelFootage.frames - 1} 프레임으로 맞춤`
											: `Timeline sized to frames 0–${multiModelFootage.frames - 1}`}
									</span>
								</div>
							</div>
						)}
						{multiModelFootage && (
							<div className="multimodel-extract">
								<button
									type="button"
									className="btn primary"
									onClick={extractMultiModelMotion}
									disabled={multiModelExtract === "running"}
								>
									{multiModelExtract === "running"
										? ko("Extracting…", "추출 중…")
										: multiModelTake
											? ko("Extract again", "다시 추출")
											: ko("Extract motion", "모션 추출")}
								</button>
								{multiModelExtract === "running" && (
									<div className="multimodel-progress">
										<div className="multimodel-progress-track">
											<div
												className={"multimodel-progress-bar" + (multiModelExtractProgress === null ? " indeterminate" : "")}
												style={multiModelExtractProgress === null ? undefined : { width: `${Math.round(multiModelExtractProgress * 100)}%` }}
											/>
										</div>
										<span>
											{multiModelExtractProgress === null
												? ko("Engine…", "엔진 준비…")
												: `${Math.round(multiModelExtractProgress * 100)}%`}
										</span>
									</div>
								)}
								{multiModelExtract === "error" && <p className="multimodel-error">{multiModelExtractError}</p>}
								{multiModelTake && (
									<p className="multimodel-extract-receipt">
										{multiModelTake.gpu
											? (isKo
												? `GPU 테이크 ${multiModelTake.frames}프레임 추출됨 — 타임라인에서 재생하세요`
												: `GPU take extracted, ${multiModelTake.frames} frames — press play on the timeline`)
											: (isKo
												? `${multiModelTake.frames}프레임 테이크 구움 (실측 ${multiModelTake.fitted} · 유지 ${multiModelTake.held}) — 타임라인에서 재생하세요`
												: `Baked a ${multiModelTake.frames}-frame take (${multiModelTake.fitted} measured · ${multiModelTake.held} held) — press play on the timeline`)}
									</p>
								)}
								{multiModelTake?.trajectory && <p className="multimodel-note" data-testid="trajectory-receipt">{trajectoryReceipt(multiModelTake.trajectory, isKo)}</p>}
								{multiModelTake?.gpu && Math.abs(activeChar.y ?? 0) > .001 && <p className="multimodel-note" data-testid="trajectory-stage-offset">{isKo ? `씬 높이 ${(activeChar.y * 100).toFixed(1)}cm가 모션에 추가돼요 (Subject → Y)` : `Scene height ${(activeChar.y * 100).toFixed(1)}cm is added to the motion (Subject → Y)`}</p>}
								{multiModelTake?.persons > 1 && (
									<p className="multimodel-extract-receipt">
										{isKo
											? `${multiModelTake.persons}명의 테이크를 각 인물 레이어에 배치했어요`
											: `${multiModelTake.persons} performers landed on their own subject layers`}
									</p>
								)}
								{multiModelExtract === "idle" && !multiModelTake && (
									<p className="multimodel-note">
										{bridge === null
											? ko("Checking for the dev bridge…", "개발 브리지를 확인하는 중…")
											: bridge.ok
												? ko(
													"Extraction runs on the GPU box (about a minute per 15 s of footage).",
													"추출은 GPU 박스에서 돌아갑니다(영상 15초당 약 1분)."
												)
												: ko(
													"No bridge: extraction runs in this browser (rougher). First run downloads the pose engine (~15 MB).",
													"브리지 없음: 이 브라우저에서 추출합니다(품질 낮음). 첫 실행은 포즈 엔진(~15 MB)을 내려받습니다."
												)}
									</p>
								)}
							</div>
						)}
						<p className="multimodel-note">
							{ko("Locked-off footage with both performers in frame is best.", "두 사람이 함께 보이는 고정 카메라 영상이 가장 적합합니다.")}
						</p>
					</div>
				</Foldout>
				{/* Motion generation is authored from Prompt Blocks. The legacy ARDY
				    status/control card remains available to the generation pipeline but
				    is intentionally not mounted in the inspector. Keeping this boundary
				    avoids changing bridge behavior while removing an unused UI surface. */}
				{false && <Foldout hidden={!isCharacterSelection} defaultOpen={false} title={ko("Motion generation (legacy)", "레거시 모션 생성")}>
					{/* One compact status line: which layer is being edited and on
					    which box — the long hint texts lived here before. */}
					<p className="ardy-meta">
						{isKo ? `인물 ${activeCharIndex + 1} 레이어` : `Subject ${activeCharIndex + 1} layer`}
						{bridge?.ok ? ` · ${bridge.host ?? ko("box", "로컬")}` : ""}
					</p>
					{/* Per-character layer status: every cast member's clip and
					    queue position at a glance. */}
					{characters.length > 0 && (
						<ul className="gen-layers">
							{characters.map((entry, index) => {
								const job = genQueue.find((item) => item.charId === entry.id && (item.status === "queued" || item.status === "running" || item.status === "error"));
								const clip = entry.id === activeChar.id ? motion : entry.sessionMotion;
								const state = job?.status === "running"
									? ko("generating…", "생성 중…")
									: job?.status === "queued"
										? ko("queued", "대기 중")
										: job?.status === "error"
											? ko("failed", "실패")
											: clip
												? (isKo ? `${clip.frames}프레임 로드됨` : `${clip.frames} frames loaded`)
												: ko("no motion", "모션 없음");
								return (
									<li key={entry.id} className={entry.id === activeChar.id ? "active" : ""}>
										<span className="gen-layers-name">S{index + 1}</span>
										<span className={`gen-layers-state ${job?.status ?? (clip ? "loaded" : "")}`}>{state}</span>
										{job?.status === "queued" && (
											<button type="button" title={ko("Remove from queue", "대기열에서 제거")} onClick={() => setGenQueue((queue) => queue.filter((item) => item.id !== job.id))}>✕</button>
										)}
									</li>
								);
							})}
						</ul>
					)}
					{bridge === null ? (
						<p className="ardy-hint">{ko("Checking for the dev bridge…", "개발 브리지를 확인하는 중…")}</p>
					) : bridge.ok ? (
						<>
							{/* Generation is authored in Prompt Blocks below: a block owns
							    both its wording and its frame range, so the range decides the
							    duration and a separate prompt/duration pair here could only
							    disagree with it. This box reports the run instead of starting
							    one. */}
							{/* Continue out of the blocking pose. The bridge refuses poses
							    alongside a prompt schedule, so the choice is disabled rather
							    than accepted and dropped at the door. */}
							<label className="check ardy-pose-start">
								<input
									type="checkbox"
									data-ardy-start-from-pose
									checked={ardyStartFromPose && promptClips.length < 2}
									disabled={promptClips.length >= 2}
									onChange={(event) => setArdyStartFromPose(event.target.checked)}
								/>
								<span>{ko("Pin the current pose", "현재 포즈 고정")}</span>
							</label>
							{ardyStartFromPose && promptClips.length < 2 && (
								<>
									{/* The box takes any destination frame, so the pose can open
									    the clip, close it, or be passed through in the middle. */}
									<div className="segmented ardy-pose-placement" data-active={ardyPosePlacement}>
										{POSE_PLACEMENTS.map((placement) => (
											<button
												type="button"
												key={placement}
												data-pose-placement={placement}
												className={ardyPosePlacement === placement ? "active" : ""}
												onClick={() => setArdyPosePlacement(placement)}
											>
												{placement === "start"
													? ko("First", "첫 프레임")
													: placement === "middle"
														? ko("Middle", "중간")
														: placement === "end"
															? ko("Last", "마지막")
															: ko("Playhead", "재생헤드")}
											</button>
										))}
									</div>
									<p className="ardy-hint" data-pose-placement-frame>
										{isKo
											? `프레임 ${posePlacementFrame(ardyPosePlacement, Math.round(ardyDuration) * TIMELINE_FPS, tlFrame)}에 이 자세를 고정하고 나머지를 생성합니다.`
											: `The pose is held at frame ${posePlacementFrame(ardyPosePlacement, Math.round(ardyDuration) * TIMELINE_FPS, tlFrame)} and the rest is generated around it.`}
									</p>
								</>
							)}
							{/* The schedule rule counts only blocks that actually carry a
							    prompt — an empty block cannot combine and must not lock
							    the pose checkbox (it used to gate on raw length). */}
							{promptClips.filter((clip) => clip.text.trim()).length >= 2 && (
								<p className="ardy-hint">
									{ko("Prompt blocks generate from history, so they cannot also pin a pose.", "프롬프트 블록은 이전 프레임을 이어서 생성하므로 포즈 고정과 함께 쓸 수 없어요.")}
								</p>
							)}
							{ardyRunning && (
								<button type="button" className="btn ghost full" onClick={cancelArdy}>
									{ko("Cancel run", "실행 취소")}
								</button>
							)}
							{ardyStatus && <p className="ardy-status">{ardyStatus}</p>}
							{ardyReport && (
								<div className="ardy-report">
									<div className="ardy-report-grid">
									<span>{ko("shape mean error", "형태 평균 오차")}</span>
										<b>{fmtMeters(ardyReport.shape_mean_error_m)}</b>
									<span>{ko("shape max error", "형태 최대 오차")}</span>
										<b>{fmtMeters(ardyReport.shape_max_error_m)}</b>
									<span>{ko("max jump", "최대 점프")}</span>
										<b>{fmtMeters(ardyReport.continuity?.max_jump_m)}</b>
									</div>
									<p className="ardy-caveat">
										{ko("Shape error proves joint-center placement only —", "형태 오차는 관절 중심 배치만 검증합니다 —")}{" "}
										{ardyReport.surface_contact_verified
											? ko("contact verified", "접촉 검증됨")
											: ko("foot-to-floor contact NOT verified", "발과 바닥의 접촉은 검증되지 않음")}{" "}
										· {ko("target_space", "대상 좌표계")} {ardyReport.target_space ?? ko("unknown", "알 수 없음")}
									</p>
								</div>
							)}
							{ardyOutcome?.ok && (
								<>
									<p className="ardy-outcome done">
									{ko("Output", "출력")} <code>{ardyOutcome.output}</code> ({ardyOutcome.bytes}{ko(" bytes", "바이트")})
										{ardyOutcome.motionUrl && (
											<>
												{" "}
											· {ko("motion", "모션")} <code>{ardyOutcome.motionUrl}</code>
											</>
										)}
									</p>
									{motionBusy ? (
								<p className="ardy-hint">{ko("Decoding motion…", "모션 디코딩 중…")}</p>
									) : motion ? (
										<p className="ardy-outcome done">
									{isKo ? `모션 로드됨 — ${motion.frames}프레임 @ ${motion.fps} fps, 인물 ${activeCharIndex + 1}에 재생 중` : `Motion loaded — ${motion.frames} frames @ ${motion.fps} fps, playing on Subject ${activeCharIndex + 1}`}
										</p>
									) : motionError ? (
										<>
								<p className="ardy-outcome error">{ko("Motion decode failed:", "모션 디코딩 실패:")} {motionError}</p>
											{ardyOutcome.motionUrl && (
												<button
													type="button"
													className="btn ghost full"
													onClick={() => loadMotion(ardyOutcome.motionUrl, undefined, ardyOutcome.rotationDeg ?? charA.rot)}
												>
										{ko("Retry load", "다시 로드")}
												</button>
											)}
										</>
									) : null}
								</>
							)}
							{ardyOutcome && !ardyOutcome.ok && (
								<p className="ardy-outcome error">{ardyOutcome.message}</p>
							)}
						</>
					) : (
						<>
							<p className="ardy-hint">
								{isKo ? (
									<>
										모션 생성은 사용자의 컴퓨터에서 실행되므로 여기서는 꺼져 있어요. 타임라인의 클립은 미리 생성된 샘플입니다.
										스테이징, 경로, 카메라, 재생은 브리지 없이도 작동합니다. 직접 생성하려면 저장소를 클론하고
										<code>node tools/ardy/bridge.mjs</code>로 브리지를 시작하세요.
									</>
								) : (
									<>
										Motion generation runs on your own machine, so it is off here. The clip
										on the timeline was generated ahead of time; staging, paths, cameras and
										playback all work without it. To generate your own, clone the repo and
										start the bridge with <code>node tools/ardy/bridge.mjs</code>.
									</>
								)}
							</p>
							{bridge.reason && <p className="ardy-hint">{bridge.reason}</p>}
						</>
					)}
				</Foldout>}
				<Foldout hidden={!advancedMode || !isCharacterSelection} defaultOpen={false} openSignal={promptBlocksReveal} title={ko("Prompt Blocks", "프롬프트 블록")}>
					<p className="inspector-hint">{ko("Blocks define what ARDY generates over each frame range. Selecting one also moves editing context to that prompt.", "블록은 각 프레임 범위에서 ARDY가 생성할 내용을 정합니다. 블록을 선택하면 편집 기준도 해당 프롬프트로 이동합니다.")}</p>
						<div className="inspector-list">
							{promptClips.map((clip) => (
								<button
									type="button"
									key={clip.id}
									className={selectedPromptId === clip.id ? "active" : ""}
									onClick={() => {
										setSelectedPromptId(clip.id);
										setArdyPrompt(clip.text);
										setTlFrame(Math.min(clip.startFrame, tlFrameCount - 1));
									}}
								>
								<span>{clip.text || ko("Untitled motion", "이름 없는 모션")}</span>
									<small>{clip.startFrame}–{clip.endFrame}f</small>
								</button>
							))}
						</div>
						{selectedPromptId && (
						<Field label={ko("Selected block prompt", "선택한 블록 프롬프트")}>
								<input
									type="text"
									value={promptClips.find((clip) => clip.id === selectedPromptId)?.text ?? ""}
									onChange={(event) => {
										changePromptClip(selectedPromptId, event.target.value);
										setArdyPrompt(event.target.value);
									}}
								placeholder={ko("describe this motion block", "이 모션 블록을 설명하세요")}
								/>
							</Field>
						)}
						{/* The seed belongs with the button that consumes it. Duration does
						    not appear at all: the blocks' own frame ranges are the length. */}
						<Field label={ko("Seed", "시드")}>
							<input
								type="text"
								inputMode="numeric"
								value={ardySeed}
								onChange={(e) => changeArdySeed(e.target.value)}
								placeholder={ko("empty = random", "비우면 랜덤")}
							/>
						</Field>
						{/* Scheduled inpainting used to live here, beside the batch button.
						    It now folds into Scene > Advanced above the timeline (contract
						    C12): it is a dial on a regeneration, so it belongs with the
						    regeneration entry rather than with the block list. */}
						{/* Line editing (contract C6). It sits beside the preserve slider
						    because it answers the same question from the other side —
						    preserve says how much of the take to KEEP, a line says exactly
						    where one joint must GO — and because both need a take with a
						    bridge source, so the whole section is absent until there is one
						    rather than present and inert. */}
						{motion?.url && (
							<Field label={ko("Line editing", "라인 편집")}>
								<button
									type="button"
									className={"btn full" + (lineEditMode ? " primary" : "")}
									title={ko(
										"The joint's own path is drawn on the viewport — grab a point on it and pull, or draw a new path on empty space; the joint then follows it exactly. The view still orbits normally (Alt+drag).",
										"관절이 지나가는 궤적이 뷰포트에 그려집니다 — 궤적 위의 점을 잡아 끌거나, 빈 곳에 새 궤적을 그리면 관절이 그 경로를 정확히 따라갑니다. 시점은 평소처럼 돌릴 수 있어요 (Alt+드래그).",
									)}
									onClick={toggleLineEditMode}
								>
									{lineEditMode ? ko("Path editing on", "궤적 편집 켜짐") : ko("Drag the path", "궤적을 잡아 끌기")}
								</button>
								{lineEditMode && (
									<div
										className="line-edit-panel"
										data-line-preview={linePreviewUrl ? "true" : undefined}
										// "The line is detached from this view" — the panel's own copy of
										// what the stage already carries, so a test (or a screenshot) can
										// read the state from whichever of the two it is looking at.
										data-line-drift={lineCurve && lineDrifted ? "true" : undefined}
									>
										<Field label={ko("Joint", "관절")}>
											<Dropdown
												value={lineTrack}
												options={LINE_EDIT_TRACK_OPTIONS}
												onChange={setLineTrack}
												ariaLabel={ko("Joint whose path is edited", "궤적을 편집할 관절")}
											/>
										</Field>
										{/* THE GESTURE SELECTOR. Pressing on the joint is how BOTH a
										    curve drag and a pin start, so the two cannot share a
										    press and a modal toggle is the honest way to say which
										    one the next press means. Named for what it does at the
										    moment it does it, not for the wire field. */}
										<button
											type="button"
											className={"btn full" + (linePinMode ? " primary" : "")}
											data-line-pin-mode={linePinMode ? "true" : "false"}
											onClick={() => setLinePinMode((on) => !on)}
										>
											{linePinMode
												? ko("Pinning moments", "순간 찍는 중")
												: ko("Pin a moment", "순간 찍기")}
										</button>
										{linePinMode && (
											<p className="inspector-hint">
												{linePins.length
													? (isKo
														? `${linePins.length}개(최대 ${LINE_EDIT_PINS_MAX}개)를 찍었어요 — 프레임 ${linePins.map((pin) => pin.frame).join(", ")}. 사이 동작은 모델이 채웁니다`
														: `${linePins.length} pinned (max ${LINE_EDIT_PINS_MAX}) — frames ${linePins.map((pin) => pin.frame).join(", ")}. The model fills the movement between them`)
													: ko(
														"Scrub to a moment, then drag the green handle to where the joint should be. The take keeps its own timing; only that instant is pinned.",
														"원하는 순간으로 재생 위치를 옮긴 뒤, 초록 손잡이를 관절이 있어야 할 자리로 끌어 주세요. 그 순간만 고정되고 나머지 타이밍은 그대로예요.",
													)}
											</p>
										)}
										{/* No range picker exists elsewhere in the app that a line
										    edit could borrow, so the whole clip is the default and
										    these two numbers only ever NARROW it. endFrame is
										    exclusive, like every other half-open range on this wire. */}
										<Field label={ko("Frame range", "프레임 구간")}>
											<div className="line-edit-range-row">
												<input
													type="number"
													min={0}
													max={Math.max(0, lineClipFrames - 2)}
													value={lineEditRange?.startFrame ?? 0}
													onChange={(event) => setLineRange((current) => ({
														startFrame: Math.round(Number(event.target.value)) || 0,
														endFrame: current?.endFrame ?? lineClipFrames,
													}))}
												/>
												<span aria-hidden="true">–</span>
												<input
													type="number"
													min={2}
													max={lineClipFrames}
													value={lineEditRange?.endFrame ?? lineClipFrames}
													onChange={(event) => setLineRange((current) => ({
														startFrame: current?.startFrame ?? 0,
														endFrame: Math.round(Number(event.target.value)) || 0,
													}))}
												/>
											</div>
										</Field>
										{/* How far a pull carries along the path, in FRAMES — the
										    sigma of the Gaussian falloff, said in the unit the user
										    is looking at. Narrow is a beat, wide is a whole gesture. */}
										<Field label={ko("Influence", "영향 범위")}>
											<div className="line-edit-radius-row">
												<input
													type="range"
													min={DRAG_RADIUS_MIN}
													max={DRAG_RADIUS_MAX}
													step={1}
													value={lineRadius}
													aria-label={ko("How many frames a pull carries along the path", "잡아당길 때 궤적을 따라 함께 움직이는 프레임 수")}
													onChange={(event) => changeLineRadius(event.target.value)}
												/>
												<span className="line-edit-radius-value">
													{isKo ? `${lineRadius}프레임` : `${lineRadius} frames`}
												</span>
											</div>
										</Field>
										<p className="inspector-hint">
											{lineCurveDirty
												? (isKo
													? `${lineEditFrom}–${lineEditTo} 프레임을 편집했어요 — ${lineCurvePointCount}개 점(최대 ${MAX_LINE_POINTS}개)을 보내고, 양 끝은 원래 궤적에서 부드럽게 이어져 이음매가 튀지 않아요. 다시 끌거나 다시 그려서 다듬을 수 있어요`
													: `Frames ${lineEditFrom}–${lineEditTo} edited — ${lineCurvePointCount} points (max ${MAX_LINE_POINTS}); both ends ease out of the original path, so the seams do not pop. Pull it again, or draw over it, to refine`)
												: ko(
													"Draw along the path to reroute that section — the frames you drew over become the range, and the take's own timing is kept. Or grab a yellow dot and pull.",
													"궤적을 따라 그리면 그 구간만 새로 지나갑니다 — 그린 만큼이 편집 구간이 되고, 원래 속도감은 그대로 유지돼요. 노란 점을 잡아 끌어도 됩니다.",
												)}
										</p>
										{/* The one thing users assume a modal viewport tool takes away.
										    Said out loud, because "can I still orbit?" is the first
										    question and the answer decides whether the mode is usable. */}
										{/* THE DETACHED STATE. Said inline, next to the edit it is about,
										    and in the same words the refused gesture answers with. It is
										    a status, not a warning: nothing was lost and nothing needs
										    doing — the only thing that changed is that the line cannot be
										    drawn in a view it was not aimed through. */}
										{lineCurve && lineDrifted && (
											<p className="inspector-hint line-edit-drift" aria-live="polite">
												{lineDriftHint()}
											</p>
										)}
										<p className="inspector-hint">
											{lineCurveDirty
												? ko(
													"You can still orbit (Alt+drag), pan and fly freely — the edit survives it. It was aimed through one lens, so while the view is elsewhere the line is drawn ghosted and a new pull waits; Generate, undo and Reset work from anywhere.",
													"시점은 자유롭게 돌리고(Alt+드래그) 옮길 수 있어요 — 편집은 그대로 남습니다. 다만 이 궤적은 처음 시점 기준이라, 시점을 옮기면 흐리게만 보이고 새로 끌기는 잠시 멈춰요. 생성·되돌리기·원래대로는 언제든 됩니다.",
												)
												: ko(
													"You can still orbit (Alt+drag), pan and fly freely; the path follows the view until you pull or draw it.",
													"시점은 평소처럼 자유롭게 돌리고(Alt+드래그) 옮길 수 있어요. 끌거나 그리기 전까지 궤적은 시점을 따라갑니다.",
												)}
										</p>
										{lineEditRange && lineEditRange.endFrame - lineEditRange.startFrame < MIN_CURVE_POINTS && (
											<p className="inspector-hint">
												{isKo
													? `구간이 너무 짧아요 — 양 끝 ${PINNED_CURVE_ENDS}프레임씩이 고정이라 ${MIN_CURVE_POINTS}프레임 이상이어야 잡을 점이 생겨요`
													: `This range is too short — with ${PINNED_CURVE_ENDS} pinned frames at each end it needs at least ${MIN_CURVE_POINTS} frames before anything can be grabbed`}
											</p>
										)}
										{lineCurveHidden > 0 && (
											<p className="inspector-hint">
												{isKo
													? `${lineCurveHidden}프레임이 화면 밖이라 잡을 수 없어요 — 구간 전체가 보이도록 카메라를 잡아 주세요`
													: `${lineCurveHidden} frame(s) are outside the frame and cannot be grabbed — frame the whole range in view`}
											</p>
										)}
										{/* ------------------------- the preview line -------------------
										    One quiet row that says which of three things is true: a
										    draft is being made, a draft is on screen (and how long it
										    took), or the last one failed and the curve is still here.
										    Deliberately not a spinner over the viewport — the artist
										    is LOOKING at the viewport, and the answer arrives there. */}
										{linePreviewBusy && (
											<p className="inspector-hint line-preview-busy" aria-live="polite">
												{ko("Previewing the pull…", "당긴 결과 미리보는 중…")}
											</p>
										)}
										{!linePreviewBusy && linePreviewUrl && (
											<p className="inspector-hint line-preview-live">
												{ko(
													"The viewport is showing this edit at full quality — press Generate to keep it as the take.",
													"뷰포트가 지금 이 편집의 최종 품질 결과예요 — 아래 생성을 누르면 테이크로 확정됩니다.",
												)}
												{linePreviewMs > 0 && (
													<span className="line-preview-time">
														{isKo ? ` 미리보기 ${(linePreviewMs / 1000).toFixed(1)}s` : ` preview ${(linePreviewMs / 1000).toFixed(1)}s`}
													</span>
												)}
											</p>
										)}
										{/* A failed draft is not a failed edit: the pull survives it and
										    the button below still runs the real thing. */}
										{linePreviewError && (
											<p className="inspector-hint line-preview-error">
												{isKo ? `미리보기 실패 — ${linePreviewError} (생성은 그대로 됩니다)` : `Preview failed — ${linePreviewError} (Generate still works)`}
											</p>
										)}
										<button
											type="button"
											className="btn primary full generate"
											disabled={!bridge?.ok || !lineCurveDirty || ardyRunning}
											title={!bridge?.ok
												? ko("Waiting for the ARDY bridge — it reconnects automatically", "ARDY 브리지를 기다리는 중 — 자동으로 다시 연결됩니다")
												: !lineCurveDirty
													? ko("Pull the path on the viewport first", "먼저 뷰포트에서 궤적을 잡아당겨 주세요")
													: ""}
											onClick={runLineEdit}
										>
											{ko("Generate the line edit", "라인 편집 생성")}
										</button>
										<button type="button" className="btn ghost full" disabled={!lineCurveDirty} onClick={resetLineCurve}>
											{ko("Reset the curve", "원래대로")}
										</button>
										<button type="button" className="btn ghost full" onClick={exitLineEditMode}>
											{ko("Exit line editing (Esc)", "라인 편집 끝내기 (Esc)")}
										</button>
										{!lineEditBackend && (
											<p className="inspector-hint line-edit-pending">
												{ko(
													"The line-editing backend is not connected yet — pulling and drawing work, and this keeps retrying until it answers.",
													"라인 편집 백엔드가 아직 연결 전이에요 — 끌기와 그리기는 되고, 연결될 때까지 계속 다시 확인합니다.",
												)}
											</p>
										)}
									</div>
								)}
							</Field>
						)}
						<button
							type="button"
							className="btn primary full generate prompt-block-generate"
							disabled={!bridge?.ok || !promptClips.some((clip) => clip.text.trim())}
							title={!bridge?.ok
								? ko("Waiting for the ARDY bridge — it reconnects automatically", "ARDY 브리지를 기다리는 중 — 자동으로 다시 연결됩니다")
								: !promptClips.some((clip) => clip.text.trim())
									? ko("Add a prompt block and describe its motion first", "프롬프트 블록을 추가하고 동작을 먼저 적어 주세요")
									: ""}
							onClick={runAllPromptBlocks}
						>
							{ardyRunning || genQueue.some((job) => job.status === "queued")
								? ko("Queue block generation", "블록 생성 대기열에 추가")
								: isKo
									? `${promptClips.length}개 블록 모두 생성`
									: `Generate all ${promptClips.length} blocks`}
						</button>
						{ardyRunning && (
							<button type="button" className="btn ghost full" onClick={cancelArdy}>
								{ko("Cancel run", "실행 취소")}
							</button>
						)}
					{!bridge?.ok && <p className="ardy-hint">{ko("Start the ARDY bridge to enable generation.", "생성을 사용하려면 ARDY 브리지를 시작하세요.")}</p>}
						{ardyStatus && <p className="ardy-status">{ardyStatus}</p>}
						<button type="button" className="btn ghost full" onClick={() => addPromptClip(tlFrame)}>
						{isKo ? `프레임 ${tlFrame}에 블록 추가` : `Add block at frame ${tlFrame}`}
						</button>
					</Foldout>

				<Foldout hidden={!isRigSelection} title={ko("Rig Control", "리그 제어")}>
						<p className="inspector-hint">
							{rigSelection && rigSelection.token !== "rig"
							? (isKo ? `${HIERARCHY_INSPECTOR_TITLES[rigSelection.token]}이 활성 제어 그룹입니다.` : `${HIERARCHY_INSPECTOR_TITLES[rigSelection.token]} is the active control group.`)
							: ko("Choose a body group in the hierarchy, then manipulate its handle in the main view.", "계층에서 몸 그룹을 고른 뒤 메인 뷰의 핸들을 조작하세요.")}
						</p>
						<div className="inspector-status-grid">
						<span>{ko("Rig", "리그")}</span><b>{ikChains ? ko("Ready", "준비됨") : ko("Unavailable", "사용 불가")}</b>
						<span>{ko("Focus", "초점")}</span><b>{ikFocus ?? ko("None", "없음")}</b>
						<span>{ko("Foot lock", "발 고정")}</span><b>{footSnap ? ko("ON", "켜짐") : ko("OFF", "꺼짐")}</b>
						</div>
						<button type="button" className={"btn full" + (ikMode ? " primary" : "")} onClick={toggleIkMode} disabled={!ikChains}>
						{ikMode ? ko("Finish rig editing", "리그 편집 끝내기") : ko("Edit rig with IK", "IK로 리그 편집")}
						</button>
						{/* Self-collision cleanup. Hidden outright on a rig whose capsule
						    proxies cannot be built: a button whose only answer is "not
						    supported" is worse than no button, and the hint below would
						    be describing something that cannot happen. */}
						{collisionCleanupSupported && (
							<>
								<button type="button" className="btn full" onClick={runFixCollisions} disabled={!ikChains}>
								{ko("Fix body collisions (this frame)", "콜리전 수정 (이 프레임)")}
								</button>
								<button type="button" className="btn full" onClick={runFixCollisionsRange} disabled={!ikChains || !motion}>
								{ko("Fix body collisions (whole clip)", "콜리전 수정 (클립 전체)")}
								</button>
								<p className="inspector-hint">
								{ko("Pushes interpenetrating body parts apart with IK and keys the fix. Whole clip walks the loaded motion and keys only the frames that changed.", "콜리전 수정은 겹쳐 들어간 신체 파츠를 IK로 밀어내고 그 결과를 키로 남깁니다. 클립 전체는 로드된 모션을 훑으며 실제로 고쳐진 프레임만 키를 찍습니다.")}
								</p>
							</>
						)}
						{/* AutoPhysics needs the hips FK joint and the mass-model bones,
						    NOT the collision capsules — a rig without toe bases still
						    qualifies, so this button is deliberately outside the
						    collisionCleanupSupported gate. Unsupported rigs get an
						    explanatory toast from the handler. */}
						<PhysicsPanel ko={ko} disabled={!ikChains || !motion} running={autoPhysicsRunning} progress={physicsProgress}
							preview={physicsPreview} show={physicsShow} options={physicsOptions} frame={tlFrame} frames={motion?.frames ?? 1}
							onOptions={changePhysicsOptions} onRun={runAutoPhysics} onShow={showPhysicsPreview}
							onApply={applyPhysicsPreview} onCancel={cancelPhysicsPreview} onFrame={setTlFrame} />
						{/* Motion trail editing: falloff radius + confirm-to-regenerate.
						    Only meaningful with IK mode on and a loaded take. */}
						{ikMode && motion && (
							<>
								<div className="segmented ik-edit-tools" data-active={ikEditTool}>
									<button
										type="button"
										className={ikEditTool === "ik" ? "active" : ""}
										aria-pressed={ikEditTool === "ik"}
										onClick={() => setIkEditTool("ik")}
									>
										{ko("IK 파츠 편집", "IK parts")}
									</button>
									<button
										type="button"
										className={ikEditTool === "trail" ? "active" : ""}
										aria-pressed={ikEditTool === "trail"}
										disabled={!showTrails}
										onClick={() => setIkEditTool("trail")}
									>
										{ko("궤적선 편집", "Motion trail")}
									</button>
								</div>
								<p className="inspector-hint">
									{ikEditTool === "ik"
										? ko("파츠를 직접 잡아 손·발·팔꿈치·무릎을 세밀하게 수정합니다. 궤적선은 안내선으로만 표시됩니다.", "Grab a body part for detailed IK editing. Trails are guides only.")
										: ko("궤적선을 잡아 여러 프레임의 이동을 함께 수정합니다. 파츠 핸들은 잠시 잠겨 겹침을 막습니다.", "Grab a trail to edit a range of frames. IK handles are locked to avoid overlapping picks.")}
								</p>
								<button
									type="button"
									className={"btn full" + (!showTrails ? " muted" : "")}
									aria-pressed={showTrails}
									onClick={() => {
										setShowTrails((value) => !value);
										setIkEditTool("ik");
									}}
								>
									{ko(`궤적선 ${showTrails ? "표시" : "숨김"}`, `Trails ${showTrails ? "on" : "off"}`)}
								</button>
								<Field label={ko("Trail falloff", "궤적 영향 범위")}>
									<div className="trail-falloff-row">
										<input
											type="range"
											min={0.1}
											max={2}
											step={0.1}
											value={trailFalloffS}
											onChange={(event) => setTrailFalloffS(Number(event.target.value))}
										/>
										<span className="trail-falloff-value">{trailFalloffS.toFixed(1)}s</span>
									</div>
								</Field>
								<button
									type="button"
									className="btn primary full trail-regenerate"
									disabled={!trailEdit || !motion?.url || !bridge?.ok || ardyRunning}
									title={!trailEdit
										? ko("Drag the trajectory line in the viewport first", "먼저 뷰포트에서 궤적선을 끌어 수정하세요")
										: !motion?.url
											? ko("The take has no bridge source to regenerate from", "재생성할 브리지 원본이 없는 테이크예요")
											: ""}
									onClick={runTrailRegeneration}
								>
									{ko("Regenerate from trail edit", "궤적 수정으로 재생성")}
								</button>
								<p className="inspector-hint">
									{ko(
										"Grab any point of the trajectory line to bend the motion; nearby frames follow within the falloff range. Confirm to regenerate that span with Kimodo — explicit IK keys stay pinned exactly.",
										"궤적선의 아무 지점이나 잡아 끌면 영향 범위 안의 주변 프레임이 함께 따라와요. 재생성을 누르면 그 구간을 Kimodo가 다시 생성하고, 명시적으로 잡은 IK 키는 정확히 고정됩니다.",
									)}
								</p>
							</>
						)}
					</Foldout>

				<Foldout hidden={selectedHierarchyId !== "environment"} title={ko("Environment", "환경")}>
						<label className="check">
							<input type="checkbox" checked={hasEnvSheet} onChange={(event) => setHasEnvSheet(event.target.checked)} />
						<span>{ko("I have an environment sheet", "환경 시트가 있어요")}</span>
						</label>
						{!hasEnvSheet && (
						<Field label={ko("Environment description", "환경 설명")}>
								<input type="text" value={environment} onChange={(event) => setEnvironment(event.target.value)} />
							</Field>
						)}
					<Field label={ko("Look / style", "룩 / 스타일")}>
							<input type="text" value={style} onChange={(event) => setStyle(event.target.value)} />
						</Field>
					</Foldout>

				<Foldout hidden={selectedHierarchyId !== "props"} title={ko("Props", "소품")}>
					<div className="props-drop" data-drop={inspectorDrop.over ? "over" : "target"} {...inspectorDrop.handlers}>
					<p className="inspector-hint">{ko("Everything you add to the set lives here. Pick one to edit it, or click it in the shot view. Drop a picture anywhere here — or on the shot view — to stand it up as a cutout.", "세트에 추가한 모든 소품이 여기에 모입니다. 편집하려면 하나를 고르거나 샷 뷰에서 클릭하세요. 사진을 이 영역이나 샷 뷰에 끌어다 놓으면 컷아웃으로 세워집니다.")}</p>
					<AddObjectMenu onAdd={addSceneObject} label={ko("Add object to the set", "세트에 오브젝트 추가")} />
					<button
						type="button"
						className="btn ghost full"
						onClick={() => cutoutInputRef.current?.click()}
						title={ko("A photo of the real thing, standing in the set as a card", "실제 사진을 판때기로 세워 세트에 배치합니다")}
					>
						{ko("Import image as cutout", "이미지를 컷아웃으로 가져오기")}
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

				<Foldout hidden={!selectedSceneObject} title={ko("Object Transform", "오브젝트 변환")}>
						{selectedSceneObject && (
							<>
								<p className="inspector-hint">
								{ko("Type a value and press Enter, or drag a number sideways to scrub (Shift for fine).", "값을 입력하고 Enter를 누르거나 숫자를 좌우로 끌어 조절하세요(Shift는 미세 조정).")}
								</p>
								<label className="check snap-toggle">
									<input type="checkbox" checked={snapEnabled} onChange={(event) => setSnapEnabled(event.target.checked)} />
								<span>
									{isKo ? (
										<>
											그리드 스냅 — <kbd>Ctrl</kbd>을 누르면 반대로 작동
										</>
									) : (
										<>
											Snap to grid — hold <kbd>Ctrl</kbd> to invert
										</>
									)}
								</span>
								</label>
						<Field label={ko("Name", "이름")}>
									<input
										type="text"
								value={sceneObjectNameDisplayKo(selectedSceneObject.name)}
										onChange={(event) => changeSceneObject(selectedSceneObject.id, { name: event.target.value })}
									/>
								</Field>
								{/* A carried prop has no grouping parent to pick — the character
								    IS its parent — so the dropdown gives way to what it is
								    riding and the way off it. Detaching here is the Props drop,
								    numbers and all. */}
								{selectedSceneObject.attach ? (
									<Field label={ko("Attached to", "부착 대상")}>
										<div className="attach-target">
											<span>{attachTargetLabel(selectedSceneObject.attach)}</span>
											<button
												type="button"
												className="btn ghost"
												onClick={() => hierarchyReparent.onDrop(`object:${selectedSceneObject.id}`, "props")}
												title={ko("Put it back in the set, where it is now", "지금 있는 자리에 그대로 세트로 되돌립니다")}
											>
												{ko("Detach", "분리")}
											</button>
										</div>
									</Field>
								) : (
								<Field label={ko("Parent", "상위 그룹")}>
									<select
										value={selectedSceneObject.parent ?? ""}
										onChange={(event) => {
											const parent = event.target.value || null;
											const next = setSceneObjectParent(sceneObjects, selectedSceneObject.id, parent);
											if (next !== sceneObjects) {
												const token = beginSceneTransaction({ owner: "reparent", cancel: () => {} });
												setSceneObjects(next);
												endSceneTransaction(token, { commit: true });
											}
										}}
									>
										<option value="">{ko("(none)", "(없음)")}</option>
										{sceneObjects
											.filter((object) => object.id !== selectedSceneObject.id)
											.map((object) => (
												<option key={object.id} value={object.id}>{sceneObjectNameDisplayKo(object.name)}</option>
											))}
									</select>
								</Field>
								)}
								<Vector3Row
							label={ko("Position", "위치")}
									fields={[
										{ axis: "X", value: selectedSceneObject.x, step: 0.05, precision: 2, scrubRange: 5, onChange: (x, token) => changeSceneObject(selectedSceneObject.id, { x }, token), onScrubStart: beginSceneTransaction, onScrubEnd: endSceneTransaction },
										{ axis: "Y", value: selectedSceneObject.y ?? 0, step: 0.05, precision: 2, scrubRange: 5, onChange: (y, token) => changeSceneObject(selectedSceneObject.id, { y }, token), onScrubStart: beginSceneTransaction, onScrubEnd: endSceneTransaction },
										{ axis: "Z", value: selectedSceneObject.z, step: 0.05, precision: 2, scrubRange: 5, onChange: (z, token) => changeSceneObject(selectedSceneObject.id, { z }, token), onScrubStart: beginSceneTransaction, onScrubEnd: endSceneTransaction },
									]}
								/>
								<Vector3Row
							label={ko("Rotation", "회전")}
									fields={[
										{ axis: "X", value: selectedSceneObject.rotX ?? 0, step: 1, precision: 1, scrubRange: 180, onChange: (rotX, token) => changeSceneObject(selectedSceneObject.id, { rotX }, token), onScrubStart: beginSceneTransaction, onScrubEnd: endSceneTransaction },
										{ axis: "Y", value: selectedSceneObject.rot, step: 1, precision: 1, scrubRange: 180, onChange: (rot, token) => changeSceneObject(selectedSceneObject.id, { rot }, token), onScrubStart: beginSceneTransaction, onScrubEnd: endSceneTransaction },
										{ axis: "Z", value: selectedSceneObject.rotZ ?? 0, step: 1, precision: 1, scrubRange: 180, onChange: (rotZ, token) => changeSceneObject(selectedSceneObject.id, { rotZ }, token), onScrubStart: beginSceneTransaction, onScrubEnd: endSceneTransaction },
									]}
								/>
								<Vector3Row
							label={ko("Scale", "크기")}
									fields={[
										{ axis: "X", value: selectedSceneObject.scaleX ?? 1, step: 0.05, precision: 2, scrubRange: 4, onChange: (scaleX, token) => changeSceneObject(selectedSceneObject.id, { scaleX }, token), onScrubStart: beginSceneTransaction, onScrubEnd: endSceneTransaction },
										{ axis: "Y", value: selectedSceneObject.scaleY ?? 1, step: 0.05, precision: 2, scrubRange: 4, onChange: (scaleY, token) => changeSceneObject(selectedSceneObject.id, { scaleY }, token), onScrubStart: beginSceneTransaction, onScrubEnd: endSceneTransaction },
										{ axis: "Z", value: selectedSceneObject.scaleZ ?? 1, step: 0.05, precision: 2, scrubRange: 4, onChange: (scaleZ, token) => changeSceneObject(selectedSceneObject.id, { scaleZ }, token), onScrubStart: beginSceneTransaction, onScrubEnd: endSceneTransaction },
									]}
								/>
								{selectedSceneObject.renderer === CUTOUT_KIND && (
									<>
										<Field label={ko("Card height (m)", "판 높이 (m)")}>
											<input
												type="number"
												data-field="cutout-height"
												min="0.05"
												step="0.05"
												value={selectedSceneObject.height ?? CUTOUT_DEFAULT_HEIGHT}
												onChange={(event) => changeSceneObject(selectedSceneObject.id, { height: Number(event.target.value) })}
											/>
										</Field>
										<Field label={ko("Card width (m)", "판 너비 (m)")}>
											<input
												type="number"
												data-field="cutout-width"
												min="0.05"
												step="0.05"
												value={Number((selectedSceneObject.footprint?.width ?? 0).toFixed(2))}
												onChange={(event) => changeSceneObject(selectedSceneObject.id, { width: Number(event.target.value) })}
											/>
										</Field>
										<p className="inspector-hint">
											{isKo
												? `높이를 바꾸면 너비는 사진 비율(${(selectedSceneObject.aspect ?? 1).toFixed(2)})을 따라갑니다. 너비만 따로 정하거나 기즈모의 가로축을 끌면 사진이 늘어납니다. 사진 속에서 크기를 알 수 있는 것(문 2 m, 사람 1.8 m)에 맞추세요.`
												: `Width follows the picture's aspect (${(selectedSceneObject.aspect ?? 1).toFixed(2)}) as you change the height. Set it on its own — or drag the gizmo's X axis — to stretch the picture. Measure against something you know: a door is 2 m, a person 1.8 m.`}
										</p>
										{Math.abs((selectedSceneObject.stretch ?? 1) - 1) > 0.005 && (
											<p className="inspector-hint">
												<button
													type="button"
													className="ghost"
													data-field="cutout-unstretch"
													onClick={() => changeSceneObject(selectedSceneObject.id, { stretch: 1 })}
												>
													{isKo
														? `사진 비율로 되돌리기 (지금 ${((selectedSceneObject.stretch ?? 1) * 100).toFixed(0)}%)`
														: `Back to the picture's proportions (now ${((selectedSceneObject.stretch ?? 1) * 100).toFixed(0)}%)`}
												</button>
											</p>
										)}
										<div className="matte-editor">
											{!!selectedSceneObject.matteAssetId && (
												<p className="inspector-hint matte-state">
													{ko(
														"This card's background is removed. You are editing the original photograph — apply again to change what goes.",
														"이 카드는 배경이 지워진 상태입니다. 지금 보이는 것은 원본 사진이며, 다시 적용하면 지워지는 범위가 바뀝니다.",
													)}
												</p>
											)}
											<canvas
												ref={matteCanvasRef}
												className="matte-canvas"
												// Focusable for the space-drag pan, not for a shortcut: undo
												// belongs to the buttons here. Ctrl+Z is the scene's, and one
												// key meaning two different undos in two different panels is
												// worse than a key that means one thing everywhere.
												tabIndex={0}
												aria-label={ko("Background editor — drag over the background to cut it out", "배경 편집기 — 배경 위를 드래그하면 그 영역이 잘려 나갑니다")}
											/>
											<p className="inspector-hint">
												{matteStats.painted
													? isKo
														? `사진의 ${Math.round(matteStats.coverage * 100)}%가 선택됨 — 보라색이 지워집니다.`
														: `${Math.round(matteStats.coverage * 100)}% of the picture marked — purple is what goes.`
													: ko(
															"Drag over the background — the cut grows out from wherever the brush touches.",
															"배경 위를 드래그하세요 — 브러시가 닿은 곳에서 같은 배경으로 번져 나가며 잘립니다.",
														)}
											</p>
										</div>
										{/* Two hands: what the brush does on the left, what to do
										    about what it did on the right. Clear sits under Undo and
										    Redo because it is the same kind of act — taking work
										    back — only all of it. */}
										<div className="matte-tools">
											<div className="presets matte-modes">
												<button
													type="button"
													className={matteMode === "paint" ? "active" : ""}
													onClick={() => {
														setMatteMode("paint");
														matteEditorRef.current?.setMode("paint");
													}}
												>
													{ko("Cut out", "누끼 따기")}
												</button>
												<button
													type="button"
													className={matteMode === "erase" ? "active" : ""}
													onClick={() => {
														setMatteMode("erase");
														matteEditorRef.current?.setMode("erase");
													}}
												>
													{ko("Bring back", "되살리기")}
												</button>
											</div>
											{/* Icons, not words: undo, redo and clear are the same three
											    acts in every tool anyone has used, and spelling them out
											    took more width than the two that actually name what this
											    brush does. The label lives in the tooltip and in the
											    accessible name. */}
											<div className="matte-history">
												<div className="presets matte-modes matte-icons">
													<button
														type="button"
														disabled={!matteStats.canUndo}
														title={ko("Undo", "실행 취소")}
														aria-label={ko("Undo", "실행 취소")}
														onClick={() => matteEditorRef.current?.undo()}
													>
														<span aria-hidden="true">↩️</span>
													</button>
													<button
														type="button"
														disabled={!matteStats.canRedo}
														title={ko("Redo", "다시 실행")}
														aria-label={ko("Redo", "다시 실행")}
														onClick={() => matteEditorRef.current?.redo()}
													>
														<span aria-hidden="true">↪️</span>
													</button>
												</div>
												<div className="presets matte-modes matte-icons matte-clear">
													<button
														type="button"
														title={ko("Clear the selection", "선택 모두 지우기")}
														aria-label={ko("Clear the selection", "선택 모두 지우기")}
														onClick={() => matteEditorRef.current?.clear()}
													>
														<span aria-hidden="true">🗑️</span>
													</button>
												</div>
											</div>
										</div>
										<div className="matte-slider">
											<label htmlFor="matte-tolerance">{ko("Tolerance", "허용치")}</label>
											<input
												id="matte-tolerance"
												type="range"
												min="0.02"
												max="0.6"
												step="0.01"
												value={matteTolerance}
												onChange={(event) => {
													const value = Number(event.target.value);
													setMatteTolerance(value);
													matteEditorRef.current?.setTolerance(value);
												}}
											/>
											<input
												type="number"
												data-field="matte-tolerance"
												min="0.02"
												max="0.6"
												step="0.01"
												value={matteTolerance}
												aria-label={ko("Tolerance", "허용치")}
												onChange={(event) => {
													const value = Number(event.target.value);
													if (!Number.isFinite(value)) return;
													setMatteTolerance(value);
													matteEditorRef.current?.setTolerance(value);
												}}
											/>
										<div className="matte-slider">
											<label htmlFor="matte-brush">{ko("Brush", "붓 크기")}</label>
											<input
												id="matte-brush"
												type="range"
												min="2"
												max="200"
												step="1"
												value={matteBrush}
												onChange={(event) => {
													const value = Number(event.target.value);
													setMatteBrush(value);
													matteEditorRef.current?.setBrush(value);
												}}
											/>
											<input
												type="number"
												data-field="matte-brush"
												min="2"
												max="200"
												step="1"
												value={matteBrush}
												aria-label={ko("Brush size", "붓 크기")}
												onChange={(event) => {
													const value = Number(event.target.value);
													if (!Number.isFinite(value)) return;
													setMatteBrush(value);
													matteEditorRef.current?.setBrush(value);
												}}
											/>
										</div>
										<div className="matte-slider">
											<label htmlFor="matte-shrink">{ko("Edge shrink", "가장자리 먹기")}</label>
											<input
												id="matte-shrink"
												type="range"
												min="0"
												max="3"
												step="0.5"
												value={matteShrink}
												onChange={(event) => setMatteShrink(Number(event.target.value))}
											/>
											<input
												type="number"
												data-field="matte-shrink"
												min="0"
												max="3"
												step="0.5"
												value={matteShrink}
												aria-label={ko("Edge shrink", "가장자리 먹기")}
												onChange={(event) => {
													const value = Number(event.target.value);
													if (Number.isFinite(value)) setMatteShrink(value);
												}}
											/>
										</div>
										<div className="matte-slider">
											<label htmlFor="matte-feather">{ko("Edge feather", "가장자리 부드럽게")}</label>
											<input
												id="matte-feather"
												type="range"
												min="0"
												max="3"
												step="0.5"
												value={matteFeather}
												onChange={(event) => setMatteFeather(Number(event.target.value))}
											/>
											<input
												type="number"
												data-field="matte-feather"
												min="0"
												max="3"
												step="0.5"
												value={matteFeather}
												aria-label={ko("Edge feather", "가장자리 부드럽게")}
												onChange={(event) => {
													const value = Number(event.target.value);
													if (Number.isFinite(value)) setMatteFeather(value);
												}}
											/>
										</div>
										</div>
										<p className="inspector-hint">
											{ko(
												"Tolerance is how far a drag spreads: low keeps to one flat colour, high walks across a shaded wall. It applies to the next drag and to Auto-detect, not to what is already purple.",
												"허용치는 드래그가 얼마나 번질지입니다. 낮으면 한 가지 색에 머무르고, 높으면 명암이 변하는 벽까지 따라갑니다. 이미 칠한 보라가 아니라 다음 드래그와 자동 인식에 적용됩니다.",
											)}
										</p>
										<button
											type="button"
											className="btn ghost full"
											onClick={() => {
												const added = matteEditorRef.current?.autoDetect(matteTolerance) ?? 0;
												if (!added) {
													setToast(
														isKo
															? "자동 인식이 더 칠할 곳을 찾지 못했어요 — 허용치를 높이거나 직접 칠하세요"
															: "Auto-detect found nothing new to paint — raise the tolerance, or paint it by hand",
													);
												}
											}}
										>
											{ko("Auto-detect background", "배경 자동 인식")}
										</button>
										<button
											type="button"
											className="btn primary full matte-apply"
											disabled={matteBusy || !matteStats.painted}
											onClick={() => applyMatte(selectedSceneObject.id)}
										>
											{matteBusy
												? ko("Removing…", "지우는 중…")
												: matteStats.painted
													? isKo
														? `보라색 부분 지우기 — 사진의 ${Math.round(matteStats.coverage * 100)}%`
														: `Remove what is purple — ${Math.round(matteStats.coverage * 100)}% of the picture`
													: ko("Nothing is marked yet", "아직 선택된 부분이 없습니다")}
										</button>
										<p className="inspector-hint">
											{ko(
												"Cut out grows the selection from wherever you drag; Bring back is the same growth fenced to what is already selected, so one drag returns a wrongly-cut region whole. Applying removes exactly what is purple and trims the empty margin — the card keeps the original photograph and this selection, so you can come back and change your mind.",
												"누끼 따기는 드래그한 자리에서 선택 영역을 키우고, 되살리기는 그 성장을 이미 선택된 범위 안으로 가둔 것이라 잘못 잘린 부분이 드래그 한 번에 통째로 돌아옵니다. 적용하면 보라색 부분만 지우고 여백을 잘라냅니다 — 원본 사진과 지금 선택한 영역은 카드에 남아 있어 언제든 다시 열어 고칠 수 있습니다.",
											)}
										</p>
									</>
								)}
								{selectedSceneObject.renderer !== CUTOUT_KIND && (
									// One swatch shows the colour; the row opens only when you want
									// to change it, instead of six chips sitting there all day.
									<details className="object-colors-pop">
										<summary
										className="object-color current"
										style={{ background: selectedSceneObject.color }}
										aria-label={ko("Object colour", "오브젝트 색상")}
										title={ko("Object colour", "오브젝트 색상")}
									/>
									{/* The displayed color while auto-color mode is on — the "hex"
									    made visible. Computed inline off the RAW object; the swatch
									    above keeps showing the authored color it returns to. */}
									{autoColor && (
										<span className="auto-color-hex">{ko("auto ", "자동 ")}{autoColorHex(selectedSceneObject.id)}</span>
									)}
									<div className="object-colors" role="group" aria-label={ko("Object colour", "오브젝트 색상")}>
										{OBJECT_COLORS.map((color) => (
											<button
												type="button"
												key={color}
												className={"object-color" + (selectedSceneObject.color === color ? " active" : "")}
												style={{ background: color }}
												aria-label={isKo ? `색상 ${color}` : `Colour ${color}`}
												aria-pressed={selectedSceneObject.color === color}
												onClick={(event) => {
													changeSceneObject(selectedSceneObject.id, { color });
													event.currentTarget.closest("details")?.removeAttribute("open");
												}}
											/>
										))}
										{/* Recently mixed tints, fenced off from the presets by a
										    rule: they are this browser's memory, not the palette,
										    and MCP's update_object can put any hex on a prop — an
										    author has to be able to reach the same colour back. */}
										{recentObjectColors.length > 0 && <span className="object-colors-split" aria-hidden="true" />}
										{recentObjectColors.map((color) => (
											<button
												type="button"
												key={color}
												className={"object-color" + (selectedSceneObject.color === color ? " active" : "")}
												style={{ background: color }}
												aria-label={isKo ? `최근 색상 ${color}` : `Recent colour ${color}`}
												aria-pressed={selectedSceneObject.color === color}
												onClick={(event) => {
													changeSceneObject(selectedSceneObject.id, { color });
													rememberSceneObjectColor(color);
													event.currentTarget.closest("details")?.removeAttribute("open");
												}}
											/>
										))}
										{/* The free colour: the native picker for choosing one, the
										    hex field for typing or reading back an exact value. Neither
										    closes the popover the way a preset does — a picker drag and
										    a half-typed hex both fire change after change, and a row
										    that vanished mid-edit would be unusable. */}
										<input
											type="color"
											className="object-color object-color-free"
											value={normalizeObjectColor(selectedSceneObject.color) ?? "#ffffff"}
											title={ko("Custom colour", "직접 고른 색상")}
											aria-label={ko("Custom colour", "직접 고른 색상")}
											onChange={(event) => {
												const color = normalizeObjectColor(event.target.value);
												if (!color) return;
												changeSceneObject(selectedSceneObject.id, { color });
												rememberSceneObjectColor(color);
											}}
										/>
										<input
											type="text"
											className="object-color-hex"
											// Idle, the field IS the object's colour — including one an
											// agent set through MCP's update_object, which the palette
											// alone could never show. Mid-edit the draft takes over.
											value={objectColorDraft ?? selectedSceneObject.color}
											spellCheck={false}
											maxLength={7}
											placeholder="#rrggbb"
											title={ko("Colour hex", "색상 hex")}
											aria-label={ko("Colour hex", "색상 hex")}
											onChange={(event) => {
												setObjectColorDraft(event.target.value);
												const color = normalizeObjectColor(event.target.value);
												if (!color) return; // a typo is a keystroke, not a repaint
												changeSceneObject(selectedSceneObject.id, { color });
												rememberSceneObjectColor(color);
											}}
											onBlur={() => setObjectColorDraft(null)}
										/>
										</div>
									</details>
								)}
							</>
						)}
					</Foldout>
					</div>
					{selectedSceneObject && (
						<div className="inspector-footer">
							<span>{ko("Delete or Backspace to remove", "Delete 또는 Backspace로 삭제")}</span>
						</div>
					)}
					</section>
					{/* The reference-photo picker sits outside the panel so re-mounting
					    the studio cannot cancel an in-flight read. */}
					<input
						ref={photoPoseFileRef}
						className="multimodel-file-input"
						type="file"
						accept={ASSET_IMAGE_TYPES.join(",")}
						data-pose-photo-input
						onChange={(event) => {
							const file = event.target.files?.[0];
							event.target.value = ""; // the same photo must be re-pickable after an error
							if (file) posePhotoFile(file);
						}}
					/>
					{/* Pose Studio docks under the inspector instead of floating over
					    the shot: the viewport keeps the posed character unobstructed. */}
					{posing && (
						<PoseStudioPanel
							docked
							subject={posingIndex >= 0 ? posingIndex + 1 : 1}
							model={posingChar?.model ?? charA.model}
							poses={allPoses}
							selectedId={studioPick}
							closing={posingClosing}
							motionActive={Boolean(motion)}
							ikCorrection={ikMode && Boolean(motion) && posingChar?.id === activeChar.id}
							onSelect={setStudioPick}
							onApply={(selectedPoseId) => {
								const pose = selectablePoses.find((p) => p.id === selectedPoseId);
								if (pose) {
									// IK mode over a take, on the active character: key the
									// pose as a correction instead of erasing the motion.
									if (ikMode && posingChar?.id === activeChar.id && ikApplyPoseAsKey(pose)) {
										closeStudio();
										return;
									}
									const hadMotion = Boolean(motion);
									// Apply is one gesture: the clear's snapshot covers the pose
									// write that follows it.
									if (hadMotion) clearMotion();
									else if (posingIndex >= 0) recordCharacterUndo();
									setPosed(pose);
									closeStudio();
									setToast(hadMotion ? ko("Cleared the current motion and applied the pose", "현재 모션을 지우고 포즈를 적용했어요") : ko("Pose applied", "포즈를 적용했어요"));
								} else {
									setToast(ko("Couldn't find the selected pose — pick again", "선택한 포즈를 찾지 못했어요. 다시 골라 주세요"));
								}
							}}
							onReset={() => {
								if (motion) clearMotion();
								else if (posingIndex >= 0) recordCharacterUndo();
								setStudioPick(DEFAULT_POSE.id);
								setPosed(DEFAULT_POSE);
								setToast(ko("Back to the default pose", "기본 포즈로 돌아왔어요"));
							}}
							onSave={savePose}
							onPhoto={() => {
								setPhotoPoseError("");
								photoPoseFileRef.current?.click();
							}}
							photoState={photoPoseState}
							photoError={photoPoseError}
							onDelete={removePose}
							onClose={closeStudio}
						/>
					)}
				</aside>
			</div>

			<div
				className="workspace-splitter timeline-splitter"
				role="separator"
				aria-label={ko("Resize frame monitor", "프레임 모니터 크기 조절")}
				onPointerDown={(event) => beginWorkspaceResize("timeline", event)}
			/>
			<div className="bottom-window">
				<nav className="bottom-window-tabs" aria-label={ko("Bottom window", "하단 창")}>
					<button
						type="button"
						className={bottomTab === "timeline" ? "active" : ""}
						aria-pressed={bottomTab === "timeline"}
						onClick={() => setBottomTab("timeline")}
					>
						{ko("Animation", "애니메이션")}
					</button>
					<button
						type="button"
						className={bottomTab === "assets" ? "active" : ""}
						aria-pressed={bottomTab === "assets"}
						onClick={() => setBottomTab("assets")}
					>
						{ko("Assets", "에셋")}
					</button>
				</nav>
				<div className="assets-pane" hidden={bottomTab !== "assets"}>
					<AssetPane
						onAssetGrab={beginAssetDrag}
						imageAssetIds={shelfImageIds}
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
					/>
				</div>
				<div className="bottom-timeline" hidden={bottomTab !== "timeline"}>
				{/* ==================== the take bar (contract C12) ====================
				    Two primary edit entries, the take's version strip, and whatever the
				    last replay had to say — all directly above the take they act on,
				    because a feature the artist has to go hunting for in a collapsed
				    foldout is a feature they do not have. */}
				{/* The preview flag lives here TOO, on a node that exists whether or not
			    the Inspector is scrolled to the line-edit panel — it is the stable
			    handle for "the viewport is showing a draft, not the take". */}
			<div
				className="take-bar"
				data-line-preview={linePreviewUrl ? "true" : undefined}
				// The draft's url beside the take's own, so "the viewport swapped
				// but the take did not" is one comparison rather than an inference.
				data-line-preview-url={linePreviewUrl || undefined}
				data-take-source={takeSourceUrl || undefined}
			>
					<div className="take-modes" role="group" aria-label={ko("Take editing", "테이크 편집")}>
						{[
							{
								id: "scene",
								label: ko("Scene", "장면"),
								hint: ko("Kimodo — block it, redo it, extend it", "Kimodo — 새로 만들고, 다시 뽑고, 블록을 잇습니다"),
								reason: sceneDisabledReason(),
								active: sceneMenuOpen,
								onClick: () => setSceneMenuOpen((open) => !open),
							},
							{
								id: "refine",
								label: ko("Refine", "다듬기"),
								hint: ko("ProjFlow — grab the joint's path and pull", "ProjFlow — 관절 궤적을 잡아 끌어 다듬습니다"),
								reason: refineDisabledReason(),
								active: lineEditMode,
								onClick: enterRefineMode,
							},
						].map((entry) => (
							<div className="take-mode" key={entry.id}>
								<button
									type="button"
									className={"take-mode-btn" + (entry.active ? " active" : "") + (entry.reason ? " disabled" : "")}
									data-take-mode={entry.id}
									data-disabled-reason={entry.reason || undefined}
									aria-disabled={entry.reason ? "true" : undefined}
									aria-expanded={entry.id === "scene" ? sceneMenuOpen : undefined}
									title={entry.reason || entry.hint}
									onClick={entry.onClick}
								>
									{entry.label}
								</button>
								{/* The refusal is SAID, in place, before the click — never
								    only as a toast that arrives too late to teach anything. */}
								{entry.reason
									? <span className="take-mode-reason">{entry.reason}</span>
									: <span className="take-mode-hint">{entry.hint}</span>}
							</div>
						))}
					</div>
					{sceneMenuOpen && (
						<div className="take-scene-menu">
							{[
								{ id: "new", label: ko("Start over", "새로 만들기"), reason: sceneGenerateDisabledReason(), onClick: () => runArdy({ fresh: true }) },
								{ id: "again", label: ko("Take it again", "다시 뽑기"), reason: sceneAgainDisabledReason(), onClick: runSceneAgain },
								{ id: "block", label: isKo ? `프레임 ${tlFrame}에 블록 추가` : `Add a block at frame ${tlFrame}`, reason: "", onClick: addSceneBlock },
							].map((action) => (
								<div className="take-scene-action" key={action.id}>
									<button
										type="button"
										className={"btn" + (action.reason ? " disabled" : "")}
										data-scene-action={action.id}
										data-disabled-reason={action.reason || undefined}
										aria-disabled={action.reason ? "true" : undefined}
										onClick={() => (action.reason ? setToast(action.reason) : action.onClick())}
									>
										{action.label}
									</button>
									{action.reason && <span className="take-mode-reason">{action.reason}</span>}
								</div>
							))}
							{/* Advanced: the two dials that decide how much of the loaded take a
							    regeneration keeps. Folded away because the default (half
							    preserved, whole body free) is the right answer almost
							    always, and a slider that is right by default should not be
							    the first thing on screen. */}
							{motion?.url && (
								<details className="take-scene-advanced">
									<summary>{ko("Advanced", "고급")}</summary>
									<Field label={ko("Keep the current take", "현재 테이크 유지")}>
										<div className="preserve-strength-row">
											<input
												type="range"
												data-preserve-strength
												min={0}
												max={1}
												step={0.05}
												value={preserveStrength}
												title={ko(
													"How hard the regeneration holds the loaded take outside the frames you edited.",
													"수정하지 않은 프레임에서 로드된 테이크를 얼마나 강하게 유지할지 정합니다.",
												)}
												onChange={(event) => setPreserveStrength(Number(event.target.value))}
											/>
											<span className="preserve-strength-value">{Math.round(preserveStrength * 100)}%</span>
										</div>
										{/* The two poles sit at the ends they actually mean: the
										    slider value IS the preserve strength, so 0 (left) is a
										    fresh take and 1 (right) holds the original hardest. */}
										<p className="inspector-hint preserve-strength-scale">
											<span>{ko("generate fresh", "새로 생성")}</span>
											<span>{ko("keep original", "원본 유지")}</span>
										</p>
										{/* Round 2 allows the pair the round-1 slider refused (contract
										    C3v2, paper 4.4), so this line no longer explains a disabled
										    control — it says which half of the take each authored surface
										    now owns. Only worth saying when preserving is actually on. */}
										{waypointMode && preserveStrength > 0 && (
											<p className="inspector-hint">
												{ko(
													"the drawn path replaces the root; the body keeps the take's style",
													"경로는 새로 그려지고, 동작 스타일은 원본을 유지해요",
												)}
											</p>
										)}
										{/* What the grouped mask will actually free. Empty whenever the
										    request would carry no `tracks`, and then nothing is said: the
										    whole-take wording above is already the truth. */}
										{preserveStrength > 0 && preserveTracksLine && (
											<p className="inspector-hint preserve-tracks-summary">{preserveTracksLine}</p>
										)}
									</Field>
									{takeRecipe && (
										<p className="inspector-hint take-recipe-summary">
											{/* A seedless recipe is an IMPORTED take: it checkpoints and reloads,
											    but it cannot be rebuilt or replayed, so the line says so rather
											    than printing "seed null". */}
											{isKo
												? `레시피 — 시드 ${Number.isInteger(takeRecipe.seed) ? takeRecipe.seed : "알 수 없음(불러온 테이크)"} · 블록 ${takeRecipe.blocks.length}개 · 다듬기 ${takeRecipe.lineEdits.length}개`
												: `Recipe — seed ${Number.isInteger(takeRecipe.seed) ? takeRecipe.seed : "unknown (imported take)"} · ${takeRecipe.blocks.length} block(s) · ${takeRecipe.lineEdits.length} refinement(s)`}
										</p>
									)}
								</details>
							)}
						</div>
					)}
					{/* Every successful run leaves a checkpoint here. Clicking one loads
					    that take back AND restores the recipe it was saved with; nothing
					    is ever dropped from the strip by loading, so an experiment can
					    always be walked back. */}
					{takeVersions.length > 0 && (
						<div className="take-version-strip" role="group" aria-label={ko("Take versions", "테이크 버전")}>
							{takeVersions.map((entry, index) => (
								<button
									type="button"
									key={entry.motionUrl}
									className={"take-version-chip" + (entry.motionUrl === takeSourceUrl ? " current" : "")}
									data-version-url={entry.motionUrl}
									data-version-current={entry.motionUrl === takeSourceUrl ? "true" : undefined}
									aria-pressed={entry.motionUrl === takeSourceUrl}
									title={`${entry.label} · ${new Date(entry.savedAt).toLocaleTimeString()}`}
									onClick={() => loadTakeVersion(entry)}
								>
									<b>v{index + 1}</b>
									<small>{entry.label}</small>
								</button>
							))}
						</div>
					)}
					{/* C10's per-entry replay verdict. Non-blocking on purpose: the take
					    exists and is loaded, one refinement just did not survive the trip
					    onto it, and the artist decides whether that matters. */}
					{replayNotices.map((entry) => (
						<p className="replay-notice" key={`${entry.index}-${entry.track}`} data-replay-index={entry.index} data-replay-track={entry.track}>
							{entry.ok === false
								? (isKo
									? `다듬기 ${entry.index + 1}(${lineTrackLabel(entry.track)})은 다시 적용되지 않았어요 — 나머지는 그대로 이어졌습니다${entry.error ? ` (${entry.error})` : ""}`
									: `Refinement ${entry.index + 1} (${lineTrackLabel(entry.track)}) was not re-applied — the rest carried over${entry.error ? ` (${entry.error})` : ""}`)
								: (isKo
									? `다듬기 ${entry.index + 1}(${lineTrackLabel(entry.track)})은 블록 경계에 걸쳐 있어요 — 결과가 이전과 조금 다를 수 있습니다`
									: `Refinement ${entry.index + 1} (${lineTrackLabel(entry.track)}) straddles a block boundary — the result may differ slightly from before`)}
						</p>
					))}
				</div>
				<Timeline
					frame={tlFrame}
					craneSelectedIndex={craneSelectedIndex}
					cameraSelected={isCameraSelection}
					onCranePointAdd={addActiveCranePoint}
					onCranePointDelete={deleteSelectedCranePoint}
					onCranePointSelect={setCraneSelectedIndex}
					frameCount={tlFrameCount}
					fps={tlFps}
					playbackSpeed={DEFAULT_PLAYBACK_SPEED}
					advancedMode={advancedMode}
				trackOwner={characters.length > 1 ? `S${activeCharIndex + 1}` : null}
				ghostLayers={ghostLayers}
				pathSpeed={pathSpeed}
				playing={tlPlaying}
				waypointMode={waypointMode}
				waypoints={waypoints}
				pathSpeed={pathSpeed}
				pendingWaypointFrame={pendingWaypointFrame}
				promptClips={promptClips}
				selectedPromptId={selectedPromptId}
				badge={stateBadge}
				ikMode={ikMode}
				ikDisabled={!ikChains}
				motion={motion ? {
					frames: motion.frames,
					label: motion.prompt || ko("Loaded take", "불러온 테이크"),
					segments: motionEditLayout(motion.editSegments ?? createMotionEdit(motion.frames)),
				} : null}
				onMotionTrim={applyMotionTrim}
				onMotionTrimReset={resetMotionTrim}
				onMotionCut={cutMotionAtPlayhead}
				onMotionSpeedChange={changeMotionSegmentSpeed}
				onMotionSegmentRemove={removeMotionSegmentById}
				ikFrames={ikFrames}
				footSnap={footSnap}
				bodyContact={bodyContact}
					shots={shots}
					activeShotIdx={activeShotIdx}
					railDraw={railDraw}
					pathDraw={pathDraw}
					pathObject={selectedSceneObject ? { id: selectedSceneObject.id, name: sceneObjectNameDisplayKo(selectedSceneObject.name), path: selectedSceneObject.path } : null}
					onObjectPathDrawToggle={() => {
						setPathDraw((current) => !current);
						if (!pathDraw) setRailDraw(false);
						setWorkspaceLayout((current) => ({ ...current, insetCollapsed: false }));
					}}
					onObjectPathChange={(path) => {
						if (selectedSceneObject) changeSceneObject(selectedSceneObject.id, { path }, timingTokenRef.current ?? undefined);
					}}
					onObjectPathClear={() => {
						if (!selectedSceneObject) return;
						const token = beginSceneTransaction({ owner: "object-path", cancel: () => {} });
						changeSceneObject(selectedSceneObject.id, { path: null }, token);
						endSceneTransaction(token, { commit: true });
					}}
					onObjectTimingGestureStart={() => {
						timingTokenRef.current = beginSceneTransaction({ owner: "object-timing", cancel: () => { timingTokenRef.current = null; } });
					}}
					onObjectTimingGestureEnd={() => {
						if (timingTokenRef.current != null) endSceneTransaction(timingTokenRef.current, { commit: true });
						timingTokenRef.current = null;
					}}
					cameraRailLength={railCurve?.length ?? null}
				shotCutDisabled={!!posing || ikMode || waypointMode}
				onIkToggle={toggleIkMode}
				onIkKeyframeAdd={ikAddKeyframe}
				onIkKeyframeRemove={ikDeleteKeyframe}
				onBodyContactToggle={() => {
					setBodyContact((v) => {
						setToast(v ? ko("Body contact off — floor constraints are disabled", "바닥 접촉 꺼짐 — 바닥 제약이 비활성화됩니다") : ko("Body contact on — body markers stay above the floor", "바닥 접촉 켜짐 — 신체 접촉점이 바닥 아래로 내려가지 않습니다"));
						return !v;
					});
				}}
				onFootSnapToggle={() => {
					setFootSnap((v) => {
				setToast(v ? ko("Foot snap off — the feet follow the body", "발 스냅 꺼짐 — 발이 몸을 따라갑니다") : ko("Foot snap on — the feet stay planted while the body moves", "발 스냅 켜짐 — 몸이 움직여도 발은 바닥에 고정됩니다"));
						return !v;
					});
				}}
				onScrub={setTlFrame}
				onAdvance={advanceFrame}
				onStep={stepFrame}
				onPlayToggle={() => {
					cameraPreviewEndRef.current = null;
					manualCameraOverrideRef.current = false;
					setTlPlaying((v) => !v);
				}}
				onWaypointToggle={toggleWaypointMode}
				onMarkerSelect={(id) => {
					const waypoint = waypoints.find((entry) => entry.id === id);
					if (!waypoint) throw new Error(`Unknown waypoints ID: ${id}`);
					setTlFrame(Math.min(waypoint.frame, tlFrameCount - 1));
					setWaypointMode(true);
					selectActiveCharacterInHierarchy();
					setActiveWaypointId(id);
					setPendingWaypointFrame(null);
				}}
				onMarkerRemove={removeWaypoint}
				onRootKeyframeAdd={queueRootWaypointFrame}
				onPromptAdd={(frame) => {
					addPromptClip(frame);
					selectActiveCharacterInHierarchy();
					revealPromptBlocks();
				}}
				onPromptSelect={(id) => {
					setSelectedPromptId(id);
					setArdyPrompt(promptClips.find((clip) => clip.id === id)?.text ?? "");
					selectActiveCharacterInHierarchy();
					revealPromptBlocks();
				}}
				onPromptChange={changePromptClip}
				onPromptResize={resizePromptClip}
				onPromptMove={movePromptClip}
				onPromptRemove={removePromptClip}
				onCameraMoveSelect={() => {
					setSelectedHierarchyId("camera");
				}}
				onCameraKeyframeAdd={addCameraKeyframe}
				onCameraKeyframeMove={moveCameraKeyframe}
					onCameraKeyframeRemove={removeCameraKeyframe}
					onCameraBlockSelect={(shotId) => {
						const selected = shots.find((entry) => entry.id === shotId);
						if (!selected) throw new Error(`Unknown shots ID: ${shotId}`);
						setTlFrame(selected.startFrame);
						setSelectedHierarchyId("camera");
					}}
					onCameraBlockChange={(patch, shotId) => {
						if (patch.mode === "follow") syncActiveCameraFraming();
						const nextPatch = patch.mode === "rail" && activeCamera.railFollow?.mode === "off"
							? { ...patch, railFollow: defaultRailRange(activeShotDuration) }
							: patch;
						// The embedded dolly graph edits the shot it sits in; the
						// camera bar above edits the selected one.
						changeActiveCamera(nextPatch, shotId);
						if (patch.mode === "follow" && !motion) {
							setToast(ko(
								"Follow rides the subject's motion — without a loaded motion the camera composes a static frame",
								"팔로우 카메라는 인물 모션을 따라 움직입니다 — 모션이 없으면 카메라는 정지 구도를 유지합니다",
							));
						}
						if (patch.mode === "rail" && !cameraRail) {
							setRailDraw(true);
							setWorkspaceLayout((current) => ({ ...current, insetCollapsed: false }));
							setToast(ko("Draw this Camera Block's rail in the Top-View", "탑뷰에서 이 카메라 블록의 레일을 그리세요"));
						}
					}}
					onCameraPreview={previewCameraShot}
					onCameraRailDrawToggle={toggleCameraRailDraw}
					onCameraRailDelete={deleteCameraRail}
				onShotSelect={selectTimelineShot}
				onShotBoundaryMove={(shotId, edge, frame) => setShots((current) => resizeShot(current, shotId, edge, frame, tlFrameCount))}
				onShotRename={(shotId, name) => {
					const shot = shots.find((entry) => entry.id === shotId);
					if (!shot) throw new Error(`Unknown shots ID: ${shotId}`);
					// The rename dialog commits once on accept. renameShot ignores a
					// blank name and stores the trimmed one, so an unchanged or empty
					// name is no edit at all: it neither writes nor records.
					if (typeof name !== "string" || !name.trim() || shot.name === name.trim()) return;
					recordShotUndo();
					setShots((current) => renameShot(current, shotId, name));
				}}
				onShotRemove={removeTimelineShot}
				onShotDuplicate={duplicateTimelineShot}
				onShotCut={addTimelineShot}
				onShotSplit={splitTimelineShot}
				onShotMove={moveTimelineShot}
				onEditGestureStart={beginTimelineEditGesture}
				onClearMotion={motion ? clearMotion : null}
			/>
				</div>
			</div>
		</div>

			<footer className="brandbar">
				<span className="wordmark">
					Cozy <span>Clay</span>
				</span>
				<SourceOffer />
			</footer>

			{result && resultOpen && (
				<ResultModal
					result={result}
					copied={copied}
					recordedVideoName={result.mode === "video" ? recordedVideoName : null}
					onClose={() => setResultOpen(false)}
					onCopy={() => copyPrompt(result.prompt)}
					onDownload={download}
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
					onNew={() => {
						setProjectBrowserOpen(false);
						requestNewProject();
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
			<Toast message={toast} onDone={() => setToast("")} />
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
		</div>
	);
}
/** ARDY report meters: missing/failed values render as an em dash, never NaN. */
function fmtMeters(value) {
	return typeof value === "number" && Number.isFinite(value) ? `${value.toFixed(4)} m` : "—";
}

/** Mid-clip frame of a base motion, the sensible default for the destination. */

/** Unity Inspector-style foldout: a titled section the user can collapse.
 * Cards default to open; the fold state is per-title session state. */
function Foldout({ title, hidden, defaultOpen = true, openSignal = 0, children }) {
	const [open, setOpen] = useState(defaultOpen);
	const cardRef = useRef(null);
	// A collapsed panel must still be reachable from elsewhere: selecting a
	// prompt block on the timeline has to reveal the panel that edits it, or
	// the click looks like it did nothing. Opening alone is not enough — the
	// panel can sit below the fold of a long Inspector — so it is scrolled into
	// view as well. The signal only ever opens; it never closes a panel.
	useEffect(() => {
		if (openSignal <= 0) return undefined;
		setOpen(true);
		// One frame later: the body has to exist before it can be scrolled to.
		const raf = requestAnimationFrame(() => {
			cardRef.current?.scrollIntoView({ block: "nearest" });
		});
		return () => cancelAnimationFrame(raf);
	}, [openSignal]);
	return (
		<section ref={cardRef} className={"card foldout" + (open ? " open" : "")} hidden={hidden}>
			<h3>
				<button type="button" className="foldout-head" aria-expanded={open} onClick={() => setOpen((v) => !v)}>
					<span className="foldout-arrow" aria-hidden="true">{open ? "\u25BE" : "\u25B8"}</span>
					<span className="foldout-title">{title}</span>
				</button>
			</h3>
			{open && <div className="foldout-body">{children}</div>}
		</section>
	);
}

function SubjectBox({ label, value, onChange, onRemove, onPose, posing, color, onColorChange, onColorEditStart }) {
	const set = (key) => (v) => onChange((prev) => ({ ...prev, [key]: v }));
	return (
		<div className="subject-box">
			<div className="subject-box-head">
				<span className="sb-name">{label}</span>
				<div className="sb-actions">
					{onColorChange && (
						<input
							type="color"
							className="sb-color"
							title={ko("Character color", "인물 색상")}
							aria-label={ko("Character color", "인물 색상")}
							value={color}
							/* Focus opens the session for keyboard/eyedropper use; the
							   native swatch dialog can drive onChange without focus, so the
							   first change of a session opens it too (the handler is
							   session-idempotent). */
							onFocus={onColorEditStart}
							onChange={(e) => {
								onColorEditStart?.();
								onColorChange(e.target.value);
							}}
						/>
					)}
					{onPose && (
						<button
							type="button"
							className={"cam-toggle" + (posing ? " active" : "")}
							title={isKo ? `${label} 포즈` : `Pose ${label}`}
							onClick={onPose}
						>
							⌘
						</button>
					)}
					{onRemove && (
						<button type="button" className="sb-remove" title={ko("Remove subject", "인물 제거")} onClick={onRemove}>
							✕
						</button>
					)}
				</div>
			</div>
			<Vector3Row
				label={ko("Position", "위치")}
				fields={[
					{ axis: "X", value: value.x, step: 0.05, precision: 2, onChange: (x) => set("x")(x) },
					{ axis: "Y", value: value.y ?? 0, step: 0.05, precision: 2, onChange: (y) => set("y")(Math.max(0, y)) },
					{ axis: "Z", value: value.z, step: 0.05, precision: 2, onChange: (z) => set("z")(z) },
				]}
			/>
			<Slider compact label={ko("Rotate", "회전")} min={-180} max={180} step={1} value={value.rot} unit="°" onChange={set("rot")} />
		</div>
	);
}

import { memo, useEffect, useMemo, useRef, useState } from "react";
import { Canvas, useFrame, useThree } from "@react-three/fiber";
import { OrthographicCamera, PerspectiveCamera, Text, useFBX } from "@react-three/drei";
import * as THREE from "three";
import { SkeletonUtils } from "three/examples/jsm/Addons.js";
import { buildArdyPose } from "./ardy/export.js";
import { checkBridge, generate as ardyGenerate } from "./ardy/client.js";
import { characterScaleFor, loadMotionFromUrl } from "./ardy/npz.js";
import { retimeMotion } from "./ardy/retime.js";
import { applyAutoFall, applyRootDrop, autoRoofDrop, normalizeRootDrop } from "./ardy/root-drop.js";
import {
	createMotionEdit,
	motionEditLayout,
	removeMotionSegment,
	renderMotionEdit,
	setMotionSegmentSpeed,
	splitMotionEdit,
	trimMotionEdit,
} from "./ardy/motion-edit.js";
import { fetchFootageBlob, footageSummary, isPlatformPageUrl, normalizeSourceUrl, probeFootage, requestBridgeExtract, requestBridgeFootage, sourceLabel } from "./multimodel-ingest.js";
import { bakeExtractedTake, bakePoseFrame, collectLandmarkTrack, createPoseDetector, imageFrames, sampleTimes, videoFrames } from "./pose-extract/index.js";
import { applyMotionFrame, captureArdyRoot, restorePlaybackBones, snapshotPlaybackBones } from "./ardy/playback.js";
import { PIN_BLOCKED, planPosePin } from "./ardy/pose-pin.js";
import { movePromptClipFrames } from "./ardy/prompt-clips.js";
import Timeline from "./ardy/timeline.jsx";
import { alignArdyPath, judgeAuthoredPath, judgeNextWaypoint, toSceneRootOffset, PATH_LIMITS } from "./ardy/waypoints.js";
import { FlyControls, aimAt, forwardFrom } from "./controls.jsx";
import { createLiveControl } from "./live-control.js";
import HierarchyPanel from "./hierarchy-panel.jsx";
import { PlanBoard } from "./planview.jsx";
import { DualRender, GIZMO_LAYER } from "./dualview.jsx";
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
import { buildFollowTrack, buildRail, buildRailFollowTrack, craneHeightAt, followFramingFromCamera, railPoint, simplifyStroke } from "./camera-follow.js";
import { createCameraBlock, removeCameraRail, updateCameraBlock } from "./camera-block.js";
import {
	RAIL_SCHEDULE_LEGACY,
	RAIL_SCHEDULE_RANGE,
	clampRailRange,
	defaultRailRange,
	moveRailRange,
	railFollowForNewGeometry,
	resizeRailRange,
	resolveRailSchedule,
} from "./camera-rail-schedule.js";
import { SetProps } from "./props.jsx";
import {
	CUTOUT_DEFAULT_HEIGHT,
	CUTOUT_KIND,
	DEFAULT_SCENE_OBJECTS,
	OBJECT_COLORS,
	createCutoutObject,
	createSceneObject,
	duplicateCutoutOptions,
	dropToSurfacePatch,
	objectSize,
	placementInFront,
	removeSceneObject,
	setSceneObjectParent,
	sceneObjectIdFromHierarchy,
	updateSceneObject,
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
	imageFilesFrom,
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
	SCENES_QUARANTINE_KEY,
	SCENES_STORAGE_KEY,
	SCENES_VERSION,
	activeSceneIndex,
	addScene,
	createCharacterEntry,
	createCharacterLayer,
	createSceneStage,
	createSceneDocument,
	CHARACTER_MODEL_IDS,
	DEFAULT_CHARACTER_MODEL,
	DEFAULT_SUBJECT_ONE,
	DEFAULT_SUBJECT_TWO,
	duplicateScene,
	loadSceneDocumentFromStorage,
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
	downloadProjectFallback,
	hasFileSystemAccess,
	loadStoredProjectHandle,
	openProjectFallback,
	pickProjectFileForOpen,
	pickProjectFileForSave,
	queryHandlePermission,
	requestHandlePermission,
	readProjectDocument,
	readProjectFile,
	storeProjectHandle,
	rememberRecentProject,
	writeProjectFile,
	PROJECT_EXTENSION,
} from "./project.js";
import ProjectBrowser from "./project-browser.jsx";
import ObjectGizmo from "./object-gizmo.jsx";
import AssetPane from "./asset-pane.jsx";
import AddObjectMenu from "./object-catalog.jsx";
import ResultModal from "./result-modal.jsx";
import AnalyticsToggle from "./analytics-toggle.jsx";
import LocaleToggle from "./locale-toggle.jsx";
import { bucketMs, track, trackActivation } from "./analytics.js";
import { ko, isKo } from "./locale.js";
import {
	DEFAULT_POSE,
	POSE_BONES,
	applyPose,
	primeBindPose,
	capturePose,
	deleteCustomPose,
	loadCustomPoses,
	saveCustomPoses,
} from "./poses.js";
import { IkHandles, PoseHandles, PoseStudioPanel, PoseThumbPreview, PoseTileGrid, warmPoseThumbnails } from "./posestudio.jsx";
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
	ikPlantFeet,
	ikSolvePlantedFeet,
} from "./ardy/ik.js";
import { Dropdown, Field, Slider, Toast, Vector3Row } from "./ui.jsx";
import { RENDER_ACTIVITY_EVENT, useRenderActivity } from "./use-render-activity.js";
import SourceOffer from "./source-offer.jsx";
import { useGeneration } from "./generation/use-generation.js";
import {
	CAMERA_MOVES,
	CUSTOM_MOVE,
	DEFAULT_SENSOR_FORMAT,
	IMAGE_MODELS,
	SHOT_ASPECT_RATIOS,
	SUBJECT_HEIGHT_M,
	VIDEO_MODELS,
	composePrompt,
	deriveShot,
	focalMmToFov,
	fovToFocalMm,
	slateLine,
} from "./shot.js";
import { captureFraming, classifyMove, moveSequenceSlate, moveSequencePhrase } from "./camera-move.js";
import { sampleAt } from "./sample-at.js";
import { exportOffscreenVideo } from "./offscreen-export.js";
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

// Stated the way a crew states a setup: how far back, which side, how high the
// lens rides, and what glass is on it. Order matters — Medium is the setup a
// director reaches for first, so it leads.
const PRESETS = {
	medium: { label: ko("Medium", "미디엄"), distance: 2.6, azimuth: 22, elevation: 6, fov: 45, targetY: 1.35, two: false },
	wide: { label: ko("Wide", "와이드"), distance: 7, azimuth: 25, elevation: 4, fov: 38, targetY: 1.2, two: false },
	closeup: { label: ko("Close-Up", "클로즈업"), distance: 1.3, azimuth: 16, elevation: 2, fov: 45, targetY: 1.55, two: false },
	low: { label: ko("Low Angle", "로우 앵글"), distance: 3.5, azimuth: 20, elevation: -14, fov: 50, targetY: 1.1, two: false },
	high: { label: ko("High Angle", "하이 앵글"), distance: 4.5, azimuth: 20, elevation: 16, fov: 45, targetY: 1.1, two: false },
};

const RIG_HIERARCHY_FOCUS = {
	"rig.torso": "spine",
	"rig.hips": "hips",
	"rig.spine": "spine",
	"rig.chest": "chest",
	"rig.neck": "neck",
	"rig.head": "head",
	"rig.leftArm": "leftHand",
	"rig.leftShoulder": "leftShoulder",
	"rig.leftElbow": "leftElbow",
	"rig.leftHand": "leftHand",
	"rig.rightArm": "rightHand",
	"rig.rightShoulder": "rightShoulder",
	"rig.rightElbow": "rightElbow",
	"rig.rightHand": "rightHand",
	"rig.leftLeg": "leftFoot",
	"rig.leftKnee": "leftKnee",
	"rig.leftFoot": "leftFoot",
	"rig.rightLeg": "rightFoot",
	"rig.rightKnee": "rightKnee",
	"rig.rightFoot": "rightFoot",
};

const HIERARCHY_INSPECTOR_TITLES = {
	shot: ko("Shot settings", "샷 설정"),
	camera: ko("Camera", "카메라"),
	characters: ko("Characters", "인물"),
	characterA: ko("Character 1", "인물 1"),
	"characterA.rig": ko("Rig", "리그"),
	characterB: ko("Character 2", "인물 2"),
	environment: ko("Environment", "환경"),
	props: ko("Props", "소품"),
	"rig.torso": ko("Torso", "몸통"),
	"rig.hips": ko("Root / Hips", "루트 / 엉덩이"),
	"rig.spine": ko("Spine", "척추"),
	"rig.chest": ko("Chest", "가슴"),
	"rig.neck": ko("Neck", "목"),
	"rig.head": ko("Head", "머리"),
	"rig.leftArm": ko("Left Arm", "왼팔"),
	"rig.leftShoulder": ko("Left Shoulder", "왼쪽 어깨"),
	"rig.leftElbow": ko("Left Elbow", "왼쪽 팔꿈치"),
	"rig.leftHand": ko("Left Hand", "왼손"),
	"rig.rightArm": ko("Right Arm", "오른팔"),
	"rig.rightShoulder": ko("Right Shoulder", "오른쪽 어깨"),
	"rig.rightElbow": ko("Right Elbow", "오른쪽 팔꿈치"),
	"rig.rightHand": ko("Right Hand", "오른손"),
	"rig.leftLeg": ko("Left Leg", "왼다리"),
	"rig.leftKnee": ko("Left Knee", "왼쪽 무릎"),
	"rig.leftFoot": ko("Left Foot", "왼발"),
	"rig.rightLeg": ko("Right Leg", "오른다리"),
	"rig.rightKnee": ko("Right Knee", "오른쪽 무릎"),
	"rig.rightFoot": ko("Right Foot", "오른발"),
};

const CAMERA_MOVE_LABELS_KO = new Map([
	["Static / locked-off", ko("Static / locked-off", "고정 샷")],
	["Zoom in", ko("Zoom in", "줌 인")],
	["Zoom out", ko("Zoom out", "줌 아웃")],
	["Push-in (dolly in)", ko("Push-in (dolly in)", "푸시인(돌리 인)")],
	["Pull-out (dolly out)", ko("Pull-out (dolly out)", "풀아웃(돌리 아웃)")],
	["Pan left", ko("Pan left", "왼쪽 팬")],
	["Pan right", ko("Pan right", "오른쪽 팬")],
	["Tilt up", ko("Tilt up", "틸트 업")],
	["Tilt down", ko("Tilt down", "틸트 다운")],
	["Tracking / follow", ko("Tracking / follow", "트래킹 / 팔로우")],
	["Orbit / arc", ko("Orbit / arc", "오빗 / 아크")],
	["Crane up", ko("Crane up", "크레인 업")],
	["Crane down", ko("Crane down", "크레인 다운")],
	["Handheld", ko("Handheld", "핸드헬드")],
	["Crash zoom in", ko("Crash zoom in", "크래시 줌 인")],
	["Dolly-zoom (vertigo)", ko("Dolly-zoom (vertigo)", "돌리 줌(버티고)")],
	["Whip pan", ko("Whip pan", "휩 팬")],
	["Aerial / drone", ko("Aerial / drone", "공중 / 드론")],
	[CUSTOM_MOVE, ko(CUSTOM_MOVE, "직접 입력…")],
]);

const POSE_LABELS_KO = new Map([
	["T-pose", ko("T-pose", "T 포즈")],
	["Relaxed", ko("Relaxed", "편안한 자세")],
	["Contrapposto", ko("Contrapposto", "콘트라포스토")],
	["Walking", ko("Walking", "걷는 자세")],
	["Seated", ko("Seated", "앉은 자세")],
	["Arms crossed", ko("Arms crossed", "팔짱")],
	["Pointing", ko("Pointing", "가리키기")],
	["Hands on hips", ko("Hands on hips", "허리에 손")],
	["Looking back", ko("Looking back", "뒤돌아보기")],
	["Hands up", ko("Hands up", "손 올리기")],
]);

const SHOT_SIZE_LABELS_KO = new Map([
	["extreme close-up", ko("extreme close-up", "익스트림 클로즈업")],
	["close-up", ko("close-up", "클로즈업")],
	["medium close-up", ko("medium close-up", "미디엄 클로즈업")],
	["medium shot", ko("medium shot", "미디엄 샷")],
	["medium-wide shot", ko("medium-wide shot", "미디엄 와이드 샷")],
	["wide shot", ko("wide shot", "와이드 샷")],
	["extreme wide shot", ko("extreme wide shot", "익스트림 와이드 샷")],
]);

const SHOT_LEVEL_LABELS_KO = new Map([
	["overhead", ko("overhead", "오버헤드")],
	["high angle", ko("high angle", "하이 앵글")],
	["eye level", ko("eye level", "아이 레벨")],
	["chest level", ko("chest level", "가슴 높이")],
	["hip level", ko("hip level", "엉덩이 높이")],
	["knee level", ko("knee level", "무릎 높이")],
	["ground level", ko("ground level", "바닥 높이")],
]);

const SCENE_RENDERER_LABELS_KO = new Map([
	["cube", ko("cube", "큐브")],
	["sphere", ko("sphere", "구")],
	["capsule", ko("capsule", "캡슐")],
	["cylinder", ko("cylinder", "원기둥")],
	["cone", ko("cone", "원뿔")],
	["plane", ko("plane", "평면")],
	["chair", ko("chair", "의자")],
	["car", ko("car", "자동차")],
	["aircraft", ko("aircraft", "비행기")],
	[CUTOUT_KIND, ko("cutout", "컷아웃")],
]);

const SCENE_OBJECT_NAME_LABELS_KO = new Map([
	["Cube", ko("Cube", "큐브")],
	["Sphere", ko("Sphere", "구")],
	["Capsule", ko("Capsule", "캡슐")],
	["Cylinder", ko("Cylinder", "원기둥")],
	["Cone", ko("Cone", "원뿔")],
	["Plane", ko("Plane", "평면")],
	["Chair", ko("Chair", "의자")],
	["Car", ko("Car", "자동차")],
	["Plane (aircraft)", ko("Plane (aircraft)", "비행기")],
]);

function poseLabelKo(pose) {
	return pose?.custom ? pose.label : POSE_LABELS_KO.get(pose?.label) ?? pose?.label ?? "";
}

function cameraMoveLabelKo(move) {
	return CAMERA_MOVE_LABELS_KO.get(move) ?? move;
}

function sceneRendererLabelKo(renderer) {
	return SCENE_RENDERER_LABELS_KO.get(renderer) ?? renderer;
}

function sceneObjectNameDisplayKo(name) {
	const match = /^(.+?)(?: ([2-9]\d*))?$/.exec(name ?? "");
	if (!match) return name;
	const [, base, suffix] = match;
	const label = SCENE_OBJECT_NAME_LABELS_KO.get(base);
	return label ? `${label}${suffix ? ` ${suffix}` : ""}` : name;
}

function viewShortKo(viewShort) {
	if (viewShort === "front") return ko("front", "정면");
	if (viewShort === "back") return ko("back", "후면");
	if (viewShort?.includes("profile")) return viewShort.startsWith("left") ? ko("left profile", "왼쪽 측면") : ko("right profile", "오른쪽 측면");
	if (viewShort?.startsWith("front ¾")) return / L$/.test(viewShort) ? ko("front ¾ L", "정면 ¾ 왼쪽") : ko("front ¾ R", "정면 ¾ 오른쪽");
	if (viewShort?.startsWith("rear ¾")) return / L$/.test(viewShort) ? ko("rear ¾ L", "후면 ¾ 왼쪽") : ko("rear ¾ R", "후면 ¾ 오른쪽");
	return viewShort;
}

function slateLineKo(shot) {
	return [
		SHOT_SIZE_LABELS_KO.get(shot.sizeLabel) ?? shot.sizeLabel,
		viewShortKo(shot.viewShort),
		SHOT_LEVEL_LABELS_KO.get(shot.levelLabel) ?? shot.levelLabel,
		`${shot.focalMm}mm`,
	].filter(Boolean).join(" · ");
}

function moveSequenceSlateKo(segments) {
	if (!segments.length) return "";
	if (segments.length === 1) {
		const seg = segments[0];
		return `${slateLineKo(seg.from)} → ${slateLineKo(seg.to)} · ${cameraMoveLabelKo(seg.label)}`;
	}
	const parts = [slateLineKo(segments[0].from)];
	for (const seg of segments) parts.push(`${cameraMoveLabelKo(seg.label)} → ${slateLineKo(seg.to)}`);
	return parts.join(" · ");
}

function hierarchyIdForIkFocus(focus) {
	if (!focus) return null;
	const exact = Object.entries(RIG_HIERARCHY_FOCUS)
		.find(([id, mappedFocus]) =>
			!["rig.torso", "rig.leftArm", "rig.rightArm", "rig.leftLeg", "rig.rightLeg"].includes(id) &&
			mappedFocus === focus
		);
	return exact?.[0] ?? "characterA.rig";
}

const CAPTURE_W = 1920;
const CAPTURE_H = 1080;
const MCP_CAPTURE_W = 640;
const MCP_CAPTURE_H = 360;
const MCP_CAPTURE_SAMPLE_STEP = 32;
const SHOT_ASPECT_PRESETS = Object.freeze({
	"16:9": Object.freeze({ label: "16:9", aspect: SHOT_ASPECT_RATIOS["16:9"], width: 1920, height: 1080 }),
	"2.39:1": Object.freeze({ label: "2.39:1", aspect: SHOT_ASPECT_RATIOS["2.39:1"], width: 2390, height: 1000 }),
	"9:16": Object.freeze({ label: "9:16", aspect: SHOT_ASPECT_RATIOS["9:16"], width: 1080, height: 1920 }),
	"1:1": Object.freeze({ label: "1:1", aspect: SHOT_ASPECT_RATIOS["1:1"], width: 1080, height: 1080 }),
	"4:3": Object.freeze({ label: "4:3", aspect: SHOT_ASPECT_RATIOS["4:3"], width: 1440, height: 1080 }),
});
// Pre-generated clip shipped with the build so a bridge-less session (a hosted
// static demo, or `npm run dev:ui`) still shows real generated motion.
// Root-absolute on purpose: the studio is served from "/app/" while these
// public files stay at the site root, so a page-relative path would resolve
// to "/app/models/..." and 404. Vite's base is "/" (own apex domain), so a
// leading slash is now the correct — and only — form that works from both
// the dev server and the built site.
// Per-character rig model: the stage entry's `model` is the FBX file stem in
// public/models AND the wire rig name sent to ARDY, so mesh and export can
// never drift apart.
const characterModelUrl = (model) => `/models/${model}.fbx`;

/** Shipped rig names as the operator says them, not as the files spell them. */
const CHARACTER_MODEL_LABELS = { "y-bot-tpose": "Y Bot", "x-bot-tpose": "X Bot" };

/** Sequential ids for spawned characters, collision-free against the cast. */
function nextCharacterId(list) {
	const ids = new Set(list.map((entry) => entry.id));
	let n = list.length + 1;
	let id = `char-${n}`;
	while (ids.has(id)) {
		n += 1;
		id = `char-${n}`;
	}
	return id;
}
const DEMO_MOTION_URL = "/demo/walk-then-stop.npz";
const DEMO_MOTION_PROMPT = "A person walks forward.";
// How long a deletion keeps offering its one-press Undo. Both toasts use the
// same window so the two deletion paths feel like one rule.
const OBJECT_DELETE_UNDO_MS = 7000;
const ASSET_DELETE_UNDO_MS = 7000;
const CLAY = "#f2eee6";
const CLAY_B = "#ddd6ca";
// X Bot's shell is smooth (no raised exoskeleton like Y Bot's), so it gets a
// brighter, whiter clay to keep it readable against the set.
const CLAY_X = "#faf8f2";
// Model/role default for a cast member; a user-picked entry.tint always wins
// over this at render time.
const defaultCharacterTint = (entry, index) => (entry.model === "x-bot-tpose" ? CLAY_X : index === 0 ? CLAY : CLAY_B);

const DEFAULT_SUBJECT = DEFAULT_SUBJECT_ONE;
const DEFAULT_SUBJECT2 = DEFAULT_SUBJECT_TWO;
const DEFAULT_ENVIRONMENT = "a sunlit modern living room";
const DEFAULT_CAMERA_POSITION = { x: 0.97, y: 1.62, z: 2.39 };
const REST_BONES = Object.fromEntries(POSE_BONES.map((b) => [b.id, [0, 0, 0]]));
// Two clocks, one boundary. The app timeline runs the production 24 fps —
// the rate the reference footage and the recorded export are counted in.
// ARDY Core generates on its trained 20 fps clock and that cannot move, so
// takes are RETIMED inbound (bridge → app, retimeMotion) and frame numbers
// are CONVERTED outbound (app → bridge, toArdyFrame). Nothing between the
// boundaries may mix the clocks.
const TIMELINE_FPS = 24;
const ARDY_FPS = 20;
const toArdyFrame = (frame) => Math.round((frame * ARDY_FPS) / TIMELINE_FPS);

// Outbound converters: timeline-frame entries → strictly-ascending bridge
// frames. Rounding can land two timeline frames on one bridge frame; the
// first wins — the bridge refuses non-ascending lists outright.
/** Where a placed pose lands, in TIMELINE frames, for a clip of `clipFrames`. */
const POSE_PLACEMENTS = ["start", "middle", "end", "playhead"];
function posePlacementFrame(placement, clipFrames, playheadFrame) {
	const last = Math.max(0, clipFrames - 1);
	if (placement === "end") return last;
	if (placement === "middle") return Math.round(last / 2);
	if (placement === "playhead") return Math.max(0, Math.min(last, playheadFrame));
	return 0;
}

function toArdyFrameEntries(entries) {
	const out = [];
	for (const entry of entries) {
		const frame = toArdyFrame(entry.frame);
		if (out.length && frame <= out[out.length - 1].frame) continue;
		out.push({ ...entry, frame });
	}
	return out;
}

function toArdySegments(segments) {
	const out = [];
	for (const segment of segments) {
		const startFrame = toArdyFrame(segment.startFrame);
		const endFrame = toArdyFrame(segment.endFrame);
		if (endFrame <= startFrame) continue; // a zero-length rounding remnant covers nothing
		out.push({ ...segment, startFrame, endFrame });
	}
	return out;
}

const DEFAULT_DURATION_S = 15; // pre-motion timeline duration; shown as duration × TIMELINE_FPS frames
const DEFAULT_PLAYBACK_SPEED = 1;
const BRIDGE_RECHECK_MS = 3000;
const ARDY_PROMPT_HORIZON_FRAMES = 2 * TIMELINE_FPS; // core model horizon: 2 seconds, counted on the timeline clock
const MAX_WAYPOINTS = 32; // ARDY bridge contract: a root path holds 2..32 distinct waypoint frames
const ARDY_PROMPT_MAX = 500; // bridge contract: prompt must be non-empty, capped at 500 chars
const ARDY_DURATION_MIN = 1; // the UI works in whole seconds; the bridge floor is 0.15 s
const ARDY_DURATION_MAX = 1200; // bridge contract: duration capped at 1200 s
const ARDY_SEED_MAX = 2 ** 31 - 1; // bridge contract: optional seed, integer in 0..2**31-1
const DEFAULT_PROMPT_CLIPS = [];

// Named ingest failures, in both locales. A reason the user cannot act on is
// not a message: each line says what was wrong with THIS source.
const MULTIMODEL_REASONS = {
	"url-empty": ["Enter a video URL first", "영상 URL을 먼저 입력하세요"],
	"url-protocol-relative": ["Use a full https:// address", "https:// 로 시작하는 전체 주소를 쓰세요"],
	"url-scheme-unsupported": ["Only http(s) or a local /path is accepted", "http(s) 또는 로컬 /경로만 사용할 수 있어요"],
	"url-platform-page": [
		"YouTube/Vimeo pages are players, not video files, and block browser downloads. Start the dev bridge to use the URL directly, or download the clip and use Choose video.",
		"유튜브·비메오 주소는 영상 파일이 아니라 플레이어 페이지이고 브라우저 다운로드를 막습니다. 개발 브리지를 켜면 URL을 그대로 쓸 수 있고, 아니면 영상을 내려받아 '영상 선택'을 쓰세요.",
	],
	"url-malformed": ["That address could not be parsed", "주소를 해석할 수 없어요"],
	"fetch-failed": ["The host refused a browser download (CORS or offline)", "호스트가 브라우저 다운로드를 거부했어요(CORS 또는 오프라인)"],
	"not-a-video": ["That address did not return a video (check the path)", "그 주소는 영상을 반환하지 않았어요(경로를 확인하세요)"],
	"decode-failed": ["This browser cannot decode that video", "이 브라우저가 디코딩할 수 없는 영상이에요"],
	"duration-unreadable": ["The clip length could not be read", "클립 길이를 읽지 못했어요"],
	"dimensions-unreadable": ["The frame size could not be read", "프레임 크기를 읽지 못했어요"],
	"probe-timeout": ["The video never reported metadata", "영상이 메타데이터를 보내지 않았어요"],
	"fetch-unavailable": ["This browser cannot download files", "이 브라우저는 파일을 내려받을 수 없어요"],
	"footage-load-timeout": ["The clip never became seekable", "클립이 탐색 가능한 상태가 되지 않았어요"],
	"seek-timeout": ["Seeking inside the clip stalled", "클립 내부 탐색이 멈췄어요"],
	"pose-runtime-unavailable": ["The pose engine is missing from this build", "이 빌드에 포즈 엔진이 없어요"],
	"pose-model-download-failed": ["The pose model could not be downloaded (offline?)", "포즈 모델을 내려받지 못했어요(오프라인인가요?)"],
	"pose-engine-download-failed": ["The pose engine could not be downloaded (offline?)", "포즈 엔진을 내려받지 못했어요(오프라인인가요?)"],
	"pose-engine-init-failed": ["The pose engine failed to start on this device", "이 기기에서 포즈 엔진을 시작하지 못했어요"],
	"rest-unavailable": ["The rig rest data (/ardy/cskel27-rest.json) could not be loaded", "리그 레스트 데이터(/ardy/cskel27-rest.json)를 불러오지 못했어요"],
	"no-person-found": ["No person was detected in the footage", "영상에서 사람을 감지하지 못했어요"],
	"no-person-in-photo": ["No person was detected in that photograph", "사진에서 사람을 감지하지 못했어요"],
	"image-load-timeout": ["The photograph never finished decoding", "사진 디코딩이 끝나지 않았어요"],
	"pose-partly-occluded": ["Shoulders and hips must both be visible in the photograph", "사진에 어깨와 골반이 모두 보여야 해요"],
	"no-usable-pose": ["A person was seen, but no stable pose could be fitted", "사람은 보였지만 안정적인 포즈를 만들지 못했어요"],
	"rig-not-loaded": ["Subject 1's rig is not loaded yet", "인물 1 리그가 아직 로드되지 않았어요"],
	"bridge-unreachable": ["The dev bridge did not answer", "개발 브리지가 응답하지 않아요"],
	"bridge-footage-incomplete": ["The bridge stream ended without footage", "브리지 전송이 영상 없이 끝났어요"],
	"footage-url-invalid": ["That address could not be used for a bridge download", "이 주소는 브리지 다운로드에 쓸 수 없어요"],
	"footage-probe-failed": ["The bridge could not read that page's video info", "브리지가 그 페이지의 영상 정보를 읽지 못했어요"],
	"footage-live-unsupported": ["Live streams have no fixed length and cannot be ingested", "라이브 스트림은 길이가 없어 인제스트할 수 없어요"],
	"footage-too-long": ["That video is over 15 minutes — trim or pick a shorter one", "15분이 넘는 영상이에요 — 잘라내거나 더 짧은 걸 골라 주세요"],
	"footage-download-failed": ["The bridge could not download that video", "브리지가 영상을 내려받지 못했어요"],
	"footage-normalize-failed": ["The bridge could not convert that video for extraction", "브리지가 영상을 추출용으로 변환하지 못했어요"],
	"footage-timeout": ["The bridge download took too long and was stopped", "브리지 다운로드가 너무 오래 걸려 중단됐어요"],
	"bridge-extract-incomplete": ["The bridge stream ended without a take", "브리지 전송이 테이크 없이 끝났어요"],
	"extract-host-missing": ["The bridge has no GPU box configured (CCLAY_ARDY_HOST)", "브리지에 GPU 박스가 설정돼 있지 않아요(CCLAY_ARDY_HOST)"],
	"extract-upload-failed": ["The footage could not be copied to the GPU box", "영상을 GPU 박스로 복사하지 못했어요"],
	"extract-upload-too-large": ["That clip is too large to upload for extraction (300 MB cap)", "추출 업로드 한도(300MB)를 넘는 영상이에요"],
	"extract-upload-empty": ["No video bytes arrived at the bridge", "브리지에 영상 데이터가 도착하지 않았어요"],
	"extract-footage-unknown": ["The bridge no longer holds that download — re-ingest the URL", "브리지에 그 다운로드가 더 이상 없어요 — URL을 다시 넣어 주세요"],
	"extract-run-failed": ["SAM-3D-Body failed on the GPU box (see the bridge log)", "GPU 박스에서 SAM-3D-Body 실행이 실패했어요(브리지 로그 확인)"],
	"extract-no-person": ["The GPU box tracked no person in that footage", "GPU 박스가 영상에서 사람을 추적하지 못했어요"],
	"extract-convert-failed": ["The extracted take could not be converted for the timeline", "추출된 테이크를 타임라인용으로 변환하지 못했어요"],
	"extract-timeout": ["GPU extraction took too long and was stopped", "GPU 추출이 너무 오래 걸려 중단됐어요"],
};

// Extraction samples and bakes straight onto the production clock — an
// extracted take never touches ARDY, so it never needs retiming either.
const MULTIMODEL_SAMPLE_FPS = TIMELINE_FPS;

/* ------------------------------------------------------------------ 3D --- */

// Memoized: unchanged cast members skip re-rendering on every playhead tick.
/**
 * Give the head a front.
 *
 * Both shipped rigs are smooth helmets with no facial geometry and no texture
 * of any kind — the FBX materials carry a flat colour and nothing else — and
 * the app then replaces every material with one clay tone. The result reads as
 * an ovoid with no direction, which matters most in an exported blocking
 * frame: the prompt claims a three-quarter front view and the picture has to
 * back it up.
 *
 * Two marks, because they fail in different conditions. The visor is a value
 * cue and disappears in silhouette or backlight; the brow ridge is a shape cue
 * and survives both. Both hang off the head bone, so posing, playback and
 * pose extraction are untouched — nothing here is skinned or animated.
 *
 * Sizes are in the head bone's own units. The rig is authored in Mixamo
 * centimetres and the whole clone is scaled by 0.01 afterwards, so a child of
 * the bone is written in centimetres too: the skull reaches ~6 cm forward of
 * the bone, which is 6 units here. Deliberately small — the maquette should
 * keep reading as a mannequin rather than a robot.
 */
function addFacingMarks(clone, markTint) {
	let head = null;
	clone.traverse((node) => {
		if (!head && node.isBone && /head$/i.test(node.name)) head = node;
	});
	if (!head) return;
	const material = new THREE.MeshStandardMaterial({ color: markTint, roughness: 0.7, metalness: 0 });
	const mark = (geometry, position, rotation) => {
		const mesh = new THREE.Mesh(geometry, material);
		mesh.position.set(...position);
		if (rotation) mesh.rotation.set(...rotation);
		mesh.castShadow = true;
		mesh.frustumCulled = false;
		// The head bone's local +Z is the face direction on both rigs.
		head.add(mesh);
		return mesh;
	};
	// The skull surface sits ~6 units forward of the bone, so both marks are
	// placed to break that plane rather than rest on it — flush is invisible.
	// Visor: a wide, shallow band across the eyeline.
	mark(new THREE.BoxGeometry(8.5, 2.4, 1.8), [0, 5.5, 6.6], [-0.2, 0, 0]);
	// Brow ridge: a short wedge that breaks the skull's outline from the side,
	// so facing survives silhouette and backlight where the visor does not.
	mark(new THREE.ConeGeometry(1.7, 3.6, 4), [0, 2.8, 6.4], [Math.PI / 2, Math.PI / 4, 0]);
}

const Character = memo(function Character({ url, position, rot, tint, pose, scale = 1, onRig, pickId }) {
	const fbx = useFBX(url);
	const model = useMemo(() => {
		const clone = SkeletonUtils.clone(fbx);
		// Mixamo exports centimetres; `scale` is the FILMED person's stature.
		// THE INVARIANT: extraction divided this take's root travel by that
		// stature, so the clip and the scale must travel together — apply one
		// without the other and every stride overshoots by the same factor and
		// the feet skate. It belongs HERE, on the world transform, and never
		// inside rig space: playback.js derives prep.scale from the bind pose,
		// so a scaled bone hierarchy would be measured as a different rig.
		clone.scale.setScalar(0.01 * scale);
		// The joint shells (Alpha_Joints / Beta_Joints — elbows, knees, the
		// exoskeleton bands) render in a darkened shade of the body tint so
		// the segments read as separate pieces.
		const jointTint = new THREE.Color(tint).multiplyScalar(0.45);
		clone.traverse((child) => {
			if (child.isMesh) {
				// warm clay reads as a maquette; cold grey reads as a broken render
				child.material = new THREE.MeshStandardMaterial({
					color: /_Joints$/i.test(child.name) ? jointTint : tint,
					roughness: 0.82,
					metalness: 0,
				});
				child.frustumCulled = false;
				// The subject's own shadow is what plants it on the deck; a blocking
				// frame without one leaves the figure floating over flat colour.
				child.castShadow = true;
			}
		});
		addFacingMarks(clone, jointTint);
		// Stamp the bind pose while the rig is still untouched: the pose effect
		// below runs immediately after and would otherwise be baked into "rest".
		primeBindPose(clone);
		return clone;
	}, [fbx, tint]);

	// A new stature (a fresh extraction on this character) must not rebuild the
	// clone — that would drop the rig the playback effects hold. Only the world
	// transform moves; the same invariant as above applies.
	useEffect(() => {
		model.scale.setScalar(0.01 * scale);
	}, [model, scale]);

	useEffect(() => {
		// During playback the pose prop is null and the motion drives the rig;
		// this effect can flush AFTER the playback effect in a later commit
		// (measured: playback at t, pose reset at t+1.8ms), and resetting to
		// REST then would clobber the animation back to the bind pose. So a
		// null pose means "playback owns the rig" — do not touch it.
		if (!pose) return;
		// every joint is reset first, otherwise switching presets leaves stale limbs
		applyPose(model, { ...REST_BONES, ...pose.bones });
	}, [model, pose]);

	const onRigRef = useRef(onRig);
	onRigRef.current = onRig;
	// Report on MODEL change only — a per-render callback identity change
	// must not re-run this effect.
	useEffect(() => {
		onRigRef.current?.(model);
	}, [model]);

	return (
		// characterPick makes the body a first-class click target: the Scene
		// picker walks up from any hit mesh, finds the tag, and routes the
		// selection to the hierarchy so the Inspector owns the controls.
		<group position={position} rotation={[0, (rot * Math.PI) / 180, 0]} userData={pickId ? { characterPick: pickId } : undefined}>
			<primitive object={model} />
		</group>
	);
});

/** Selection marker for the picked cast member: a Unity-style XYZ tripod
 * plus a ground ring at the feet. X/Z arrows also drag the character on the
 * floor (Y is display-only — characters stand on the deck). */
function ShotRig({ preset, nonce, fovDeg, charA, charB, showB, probeX, probeZ, camRef, look, onMetrics }) {
	useEffect(() => {
		const cam = camRef.current;
		if (!cam) return;
		const p = PRESETS[preset];
		const az = (p.azimuth * Math.PI) / 180;
		const el = (p.elevation * Math.PI) / 180;
		const aim =
			p.aimMid && showB ? { x: (charA.x + charB.x) / 2, z: (charA.z + charB.z) / 2 } : { x: charA.x, z: charA.z };
		const horizontal = p.distance * Math.cos(el);
		cam.position.set(
			aim.x + horizontal * Math.sin(az),
			Math.max(p.targetY + p.distance * Math.sin(el), 0.15),
			aim.z + horizontal * Math.cos(az),
		);
		const angles = aimAt(cam.position, { x: aim.x, y: p.targetY, z: aim.z });
		look.current.yaw = angles.yaw;
		look.current.pitch = angles.pitch;
		// eslint-disable-next-line react-hooks/exhaustive-deps
	}, [preset, nonce]);


	useEffect(() => {
		const cam = camRef.current;
		if (!cam) return;
		cam.fov = fovDeg;
		cam.updateProjectionMatrix();
	}, [fovDeg, camRef]);

	// A blocking tool must not claim a framing it is not holding, so the subject's
	// feet and eyes are projected into the frame every tick.
	const probe = useRef(new THREE.Vector3());
	const lastMetrics = useRef({ x: NaN, y: NaN, z: NaN, visible: null });
	useFrame(() => {
		const cam = camRef.current;
		if (!cam) return;
		let visible = false;
		for (const y of [0.1, SUBJECT_HEIGHT_M * 0.94]) {
			// During motion playback the probe follows the played root, so the
			// "subject out of frame" caption stays honest.
			probe.current.set(probeX ?? charA.x, y, probeZ ?? charA.z).project(cam);
			if (probe.current.z < 1 && Math.abs(probe.current.x) <= 1 && Math.abs(probe.current.y) <= 1) visible = true;
		}
		const previous = lastMetrics.current;
		if (
			Math.abs(previous.x - cam.position.x) +
				Math.abs(previous.y - cam.position.y) +
				Math.abs(previous.z - cam.position.z) >
				1e-4 ||
			previous.visible !== visible
		) {
			lastMetrics.current = {
				x: cam.position.x,
				y: cam.position.y,
				z: cam.position.z,
				visible,
			};
			onMetrics(cam.position, visible);
		}
	});

	return null;
}

/** Plays an authored A→B camera move by driving the shot camera exactly the
    way a fly-drag does — position on the camera, orientation through the look
    ref — so ShotRig's metrics, the slate, and the inset all stay honest for
    free. A right-drag interrupts the dolly: the user always outranks it.

    Two frame sources can drive the move. Standalone preview advances authored
    frames at production cadence; follow mode reads the timeline playhead, so the camera and
    the character motion are two views of the same time axis — playing or
    scrubbing frame 72 at 24 fps puts the camera exactly 3 s into its move. */
function MoveRig({ playing, following, followFrame, fps, keys, shots, scene, camRef, look, isInterrupted, onDone }) {
	const invalidate = useThree((state) => state.invalidate);
	const preview = useRef({ frame: 0, finished: false, notified: false });
	const handlers = useRef({ isInterrupted, onDone });
	handlers.current = { isInterrupted, onDone };
	// The follow branch only re-applies when its time changes; in demand mode
	// each apply needs one more frame so ShotRig's metrics see the new pose.
	const appliedFrame = useRef(null);
	useEffect(() => {
		// Arming or reshaping the move must schedule a frame by hand: this
		// component owns no three objects, so in demand mode nothing else will.
		appliedFrame.current = null;
		if (following) invalidate();
	}, [keys, shots, scene, fps, following, invalidate]);
	useEffect(() => {
		// A paused scrub changes the playhead without starting the render loop.
		if (following && !playing) invalidate();
	}, [followFrame, following, playing, invalidate]);
	useEffect(() => {
		if (!playing || keys.length < 1) return undefined;
		const firstFrame = keys[0].frame;
		const lastFrame = keys[keys.length - 1].frame;
		const spanFrames = Math.max(lastFrame - firstFrame, 1);
		const spanSeconds = Math.max(spanFrames / Math.max(fps, 1), 0.1);
		const tickMs = (spanSeconds * 1000) / spanFrames;
		let tick = 0;
		preview.current = { frame: firstFrame, finished: false, notified: false };
		invalidate();
		const timer = window.setInterval(() => {
			if (preview.current.finished) return;
			if (handlers.current.isInterrupted?.()) {
				preview.current.finished = true;
				invalidate();
				return;
			}
			tick += 1;
			preview.current = {
				frame: firstFrame + (lastFrame - firstFrame) * Math.min(tick / spanFrames, 1),
				finished: tick >= spanFrames,
				notified: false,
			};
			invalidate();
		}, tickMs);
		return () => window.clearInterval(timer);
	}, [playing, keys, fps, invalidate]);
	useFrame(() => {
		if ((playing && keys.length < 1) || (!playing && following && !shots.some((shot) => shot.cameraKeys.length))) return;
		const cam = camRef.current;
		if (!cam) return;
		const apply = (frame) => {
			// Timeline/PlayView sampling follows the editorial strips. Standalone
			// preview stays scoped to the selected strip's keys. Entering a Shot
			// applies its authored camera immediately (a hard cut). Leaving into a
			// gap returns null and deliberately applies nothing: the last physical
			// camera pose stays put and FlyControls regain ownership, so we do not
			// invent a second cut to an arbitrary "free camera" preset.
			const timelineShot = following ? shotAtFrame(shots, frame) : null;
			const sampledShot = timelineShot
				? { ...timelineShot, camera: { mode: "keys" } }
				: following ? null : { camera: { mode: "keys" }, cameraKeys: keys };
			const f = sampleAt(scene, sampledShot, frame).camera;
			if (!f) return null;
			cam.position.set(f.pos.x, f.pos.y, f.pos.z);
			look.current.yaw = f.yaw;
			look.current.pitch = f.pitch;
			if (Math.abs(cam.fov - f.fovDeg) > 1e-3) {
				cam.fov = f.fovDeg;
				cam.updateProjectionMatrix();
			}
			return f;
		};
		if (playing) {
			const f = apply(preview.current.frame);
			if (preview.current.finished && !preview.current.notified) {
				preview.current.notified = true;
				handlers.current.onDone(f ? f.fovDeg : cam.fov);
			}
			return;
		}
		if (!following) return;
		if (isInterrupted?.()) return; // manual viewport framing owns the paused camera
		if (appliedFrame.current === followFrame) return;
		appliedFrame.current = followFrame;
		apply(followFrame);
		invalidate();
	});
	return null;
}

/**
 * Applies the precomputed follow-camera track to the shot camera. The track
 * is derived offline from the subject trajectory (camera-follow.js), so this
 * rig only samples it at the playhead — scrub, play, PlayView and Record all
 * replay the identical deterministic move. Null-rendering, so every apply
 * must invalidate() by hand in demand mode, like MoveRig.
 */
function FollowCamRig({ enabled, frame, scene, shot, camRef, look, isInterrupted }) {
	const invalidate = useThree((state) => state.invalidate);
	const applied = useRef(null);
	useEffect(() => {
		applied.current = null;
		if (enabled) invalidate();
	}, [scene, shot, enabled, invalidate]);
	useEffect(() => {
		if (enabled) invalidate();
	}, [frame, enabled, invalidate]);
	useFrame(() => {
		if (!enabled) return;
		if (isInterrupted?.()) return; // the user is flying; yield until released
		const cam = camRef.current;
		if (!cam) return;
		const sample = sampleAt(scene, shot, frame).camera;
		if (!sample || applied.current === frame) return;
		applied.current = frame;
		cam.position.set(sample.pos.x, sample.pos.y, sample.pos.z);
		look.current.yaw = sample.yaw;
		look.current.pitch = sample.pitch;
		invalidate();
	});
	return null;
}

/**
 * Applies the shot camera's yaw/pitch from its look ref every frame. Before
 * the camera split, FlyControls owned the shot camera and performed this
 * apply as a side effect of flying; with the fly controls bound to the
 * editor camera, the recording camera still needs its aim (ShotRig, follow,
 * frame-selection) reflected in its actual rotation — the preview and the
 * capture read the camera object, not the ref.
 */
function ShotLookApplier({ camRef, look }) {
	useFrame(() => {
		const cam = camRef.current;
		if (!cam) return;
		if (cam.rotation.order !== "YXZ") cam.rotation.order = "YXZ";
		if (cam.rotation.x !== look.current.pitch || cam.rotation.y !== look.current.yaw || cam.rotation.z !== 0) {
			cam.rotation.set(look.current.pitch, look.current.yaw, 0);
		}
	});
	return null;
}

/**
 * Seeds the editor camera once, inside the Canvas root — App-level effects
 * run before R3F mounts its children, so the ref is still null there. The
 * seed frames both the subject and the shot camera: the first editor frame
 * must read as "the set with the camera in it".
 */
function EditorCamSeed({ camRef, lookRef, shotCamRef, subject }) {
	const seeded = useRef(false);
	const invalidate = useThree((state) => state.invalidate);
	useEffect(() => {
		if (seeded.current) return;
		const cam = camRef.current;
		if (!cam) return;
		seeded.current = true;
		const shot = shotCamRef.current;
		const target = {
			x: ((subject?.x ?? 0) + (shot?.position.x ?? 1)) / 2,
			y: 1.1,
			z: ((subject?.z ?? 0) + (shot?.position.z ?? 2.4)) / 2,
		};
		cam.position.set(target.x + 3.2, 2.9, target.z + 4.2);
		const angles = aimAt(cam.position, target);
		lookRef.current = { yaw: angles.yaw, pitch: angles.pitch };
		cam.rotation.order = "YXZ";
		cam.rotation.set(angles.pitch, angles.yaw, 0);
		invalidate();
	});
	return null;
}

/**
 * The shot camera drawn as an object in the editor view: a body and a short
 * frustum wireframe on GIZMO_LAYER, synced from the live camera every frame.
 * Preview, capture and PlayView draws all drop GIZMO_LAYER, so the ghost can
 * never reach a recorded frame.
 */
function ShotCameraGhost({ camRef, fovDeg, aspect, visible, selected }) {
	const groupRef = useRef(null);
	const invalidate = useThree((state) => state.invalidate);
	const frustum = useMemo(() => {
		const depth = 0.62;
		const h = Math.tan(THREE.MathUtils.degToRad(fovDeg) / 2) * depth;
		const w = h * aspect;
		const corners = [[-w, h], [w, h], [w, -h], [-w, -h]];
		const points = [];
		for (const [x, y] of corners) points.push(0, 0, 0, x, y, -depth);
		for (let i = 0; i < 4; i++) {
			const [ax, ay] = corners[i];
			const [bx, by] = corners[(i + 1) % 4];
			points.push(ax, ay, -depth, bx, by, -depth);
		}
		return new Float32Array(points);
	}, [fovDeg, aspect]);
	useEffect(() => {
		groupRef.current?.traverse((node) => node.layers?.set(GIZMO_LAYER));
		invalidate();
	}, [visible, frustum, selected, invalidate]);
	useFrame(() => {
		const cam = camRef.current;
		const group = groupRef.current;
		if (!cam || !group) return;
		group.position.copy(cam.position);
		group.quaternion.copy(cam.quaternion);
	});
	if (!visible) return null;
	return (
		<group ref={groupRef}>
			<mesh userData={{ shotCameraPick: true }} position={[0, 0, 0.06]}>
				<boxGeometry args={[0.15, 0.11, 0.2]} />
				<meshBasicMaterial color={selected ? "#ffb454" : "#3b6ea5"} />
			</mesh>
			{/* the lens: a short cone opening toward the view direction */}
			<mesh userData={{ shotCameraPick: true }} rotation={[-Math.PI / 2, 0, 0]} position={[0, 0, -0.075]}>
				<coneGeometry args={[0.052, 0.09, 20, 1, true]} />
				<meshBasicMaterial color={selected ? "#e09a3e" : "#2f5a8a"} side={THREE.DoubleSide} />
			</mesh>
			<lineSegments key={`${fovDeg}:${aspect}`}>
				<bufferGeometry>
					<bufferAttribute attach="attributes-position" array={frustum} count={frustum.length / 3} itemSize={3} />
				</bufferGeometry>
				<lineBasicMaterial color={selected ? "#ffb454" : "#6f9cc9"} transparent opacity={0.85} />
			</lineSegments>
		</group>
	);
}

function RenderLoopController({ stageRef }) {
	const frameloop = useThree((state) => state.frameloop);
	const setFrameloop = useThree((state) => state.setFrameloop);
	const invalidate = useThree((state) => state.invalidate);
	useEffect(() => {
		const apply = (next) => {
			setFrameloop(next ? "always" : "demand");
			if (next) invalidate();
		};
		const onActivity = (event) => apply(event.detail);
		window.addEventListener(RENDER_ACTIVITY_EVENT, onActivity);
		return () => window.removeEventListener(RENDER_ACTIVITY_EVENT, onActivity);
	}, [invalidate, setFrameloop]);
	useEffect(() => {
		if (stageRef.current) stageRef.current.dataset.actualRenderLoop = frameloop;
	}, [frameloop, stageRef]);
	return null;
}

function ViewportLayoutInvalidator({ insetX, insetY, insetWidth, insetHeight, hierarchyWidth, sidebarWidth, timelineHeight, planZoom }) {
	const invalidate = useThree((state) => state.invalidate);
	useEffect(() => {
		// The pane frame is regular DOM while its picture is a scissored WebGL
		// viewport. In demand mode a drag can commit its final DOM position just
		// after the continuous loop stops, leaving the picture at the previous
		// coordinates. Redraw now and once more after layout has settled.
		invalidate();
		const frame = requestAnimationFrame(invalidate);
		return () => cancelAnimationFrame(frame);
	}, [invalidate, insetX, insetY, insetWidth, insetHeight, hierarchyWidth, sidebarWidth, timelineHeight, planZoom]);
	return null;
}

/** The authored root path on the set floor while path editing is on: numbered
    pins connected in walk order. Lives on the gizmo layer, so the shot camera
    shows it but exports never do (the bird's-eye board draws its own copy). */
/**
 * The drawn camera rail in the 3D Scene view: editor furniture on the gizmo
 * layer, so PlayView, the ink prepass and exports never see it.
 */
function CameraRailScenePreview({ points, cumLen, length, crane }) {
	const rootRef = useRef(null);
	const lines = useMemo(() => {
		if (!points || points.length < 2) return null;
		const floor = new Float32Array(points.length * 3);
		points.forEach((point, i) => {
			floor[i * 3] = point.x;
			floor[i * 3 + 1] = 0.03;
			floor[i * 3 + 2] = point.z;
		});
		const floorGeometry = new THREE.BufferGeometry();
		floorGeometry.setAttribute("position", new THREE.BufferAttribute(floor, 3));
		// A craned rail shows WHERE THE LENS RIDES: the same path lifted along
		// the crane's start→end heights by arc progress, with the floor line
		// kept as the track's ground projection.
		let liftedGeometry = null;
		if (crane && cumLen && length > 1e-9) {
			const lifted = new Float32Array(points.length * 3);
			points.forEach((point, i) => {
				lifted[i * 3] = point.x;
				lifted[i * 3 + 1] = craneHeightAt(crane, cumLen[i] / length);
				lifted[i * 3 + 2] = point.z;
			});
			liftedGeometry = new THREE.BufferGeometry();
			liftedGeometry.setAttribute("position", new THREE.BufferAttribute(lifted, 3));
		}
		return { floorGeometry, liftedGeometry };
	}, [points, cumLen, length, crane]);
	useEffect(() => () => {
		lines?.floorGeometry.dispose();
		lines?.liftedGeometry?.dispose();
	}, [lines]);
	useEffect(() => {
		rootRef.current?.traverse((node) => node.layers.set(GIZMO_LAYER));
	});
	if (!lines) return null;
	return (
		<group ref={rootRef}>
			<line geometry={lines.floorGeometry}>
				<lineBasicMaterial color="#a78bfa" transparent opacity={lines.liftedGeometry ? 0.35 : 0.8} depthWrite={false} />
			</line>
			{lines.liftedGeometry && (
				<line geometry={lines.liftedGeometry}>
					<lineBasicMaterial color="#a78bfa" transparent opacity={0.9} depthWrite={false} />
				</line>
			)}
		</group>
	);
}


/**
 * The crane's height marks as grabbable dots on the lifted curve. Click a
 * dot to select it, drag to set its height (the drag rides a camera-facing
 * vertical plane through the dot's rail point), Shift-drag to slide an
 * interior mark along the arc, double-click the curve to add a mark and
 * Delete to remove a non-endpoint. Dots live on GIZMO_LAYER, so the
 * recording never sees them.
 */
function CraneHandles({ rail, crane, selectedIndex, enabled, paneRef, camRef, onSelect, onChangePoints, onDragStart, onDragEnd }) {
	const { gl } = useThree();
	const invalidate = useThree((state) => state.invalidate);
	const groupRef = useRef(null);
	const dragRef = useRef(null);
	const stateRef = useRef(null);
	stateRef.current = { rail, crane, selectedIndex, enabled, onSelect, onChangePoints, onDragStart, onDragEnd };
	useEffect(() => {
		groupRef.current?.traverse((node) => node.layers?.set(GIZMO_LAYER));
	});
	useEffect(() => {
		if (!enabled) return undefined;
		const raycaster = new THREE.Raycaster();
		raycaster.layers.set(GIZMO_LAYER);
		const rayFrom = (event) => {
			const pane = paneRef.current;
			const camera = camRef.current;
			if (!pane || !camera) return null;
			const bounds = pane.getBoundingClientRect();
			if (bounds.width < 2 || bounds.height < 2) return null;
			const ndc = new THREE.Vector2(
				((event.clientX - bounds.left) / bounds.width) * 2 - 1,
				-((event.clientY - bounds.top) / bounds.height) * 2 + 1,
			);
			if (Math.abs(ndc.x) > 1 || Math.abs(ndc.y) > 1) return null;
			camera.updateMatrixWorld();
			raycaster.setFromCamera(ndc, camera);
			return raycaster;
		};
		const paneScreen = (world) => {
			const pane = paneRef.current.getBoundingClientRect();
			const projected = world.project(camRef.current);
			return projected.z > 1 ? null : {
				x: pane.left + ((projected.x + 1) / 2) * pane.width,
				y: pane.top + ((1 - projected.y) / 2) * pane.height,
			};
		};
		const onDown = (event) => {
			const s = stateRef.current;
			if (!s.enabled || !s.crane || event.button !== 0) return;
			if (!groupRef.current || !rayFrom(event)) return;
			const hits = raycaster.intersectObjects(groupRef.current.children, true);
			const hit = hits.find((entry) => entry.object.userData?.craneIndex !== undefined);
			if (!hit) return;
			event.stopImmediatePropagation();
			event.preventDefault();
			const index = hit.object.userData.craneIndex;
			s.onSelect(index);
			dragRef.current = { index, slide: event.shiftKey, recorded: false };
			invalidate();
		};
		const onMove = (event) => {
			const s = stateRef.current;
			const drag = dragRef.current;
			if (!drag || !s.enabled || !s.crane || !s.rail) return;
			if (!rayFrom(event)) return;
			const points = s.crane.points;
			const point = points[drag.index];
			if (!point) return;
			if (!drag.recorded) {
				s.onDragStart?.();
				drag.recorded = true;
			}
			if (drag.slide && drag.index > 0 && drag.index < points.length - 1) {
				// slide along the arc: ray onto the horizontal plane at the mark
				const plane = new THREE.Plane(new THREE.Vector3(0, 1, 0), -point.height);
				const world = new THREE.Vector3();
				if (!raycaster.ray.intersectPlane(plane, world)) return;
				let bestI = 0;
				let bestD = Infinity;
				for (let i = 0; i < s.rail.points.length; i += 1) {
					const d = Math.hypot(s.rail.points[i].x - world.x, s.rail.points[i].z - world.z);
					if (d < bestD) {
						bestD = d;
						bestI = i;
					}
				}
				const t = Math.max(
					points[drag.index - 1].t + 0.02,
					Math.min(points[drag.index + 1].t - 0.02, s.rail.cumLen[bestI] / s.rail.length),
				);
				s.onChangePoints(points.map((entry, i) => (i === drag.index ? { ...entry, t } : entry)), { dragging: true });
			} else {
				// height: ray onto the camera-facing vertical plane at the base
				const base = railPoint(s.rail, point.t * s.rail.length);
				const camera = camRef.current;
				const facing = new THREE.Vector3();
				camera.getWorldDirection(facing);
				facing.y = 0;
				if (facing.lengthSq() < 1e-6) return; // looking straight down: height is unreadable
				facing.normalize();
				const plane = new THREE.Plane().setFromNormalAndCoplanarPoint(facing, new THREE.Vector3(base.x, 0, base.z));
				const world = new THREE.Vector3();
				if (!raycaster.ray.intersectPlane(plane, world)) return;
				const height = Math.max(0.1, Math.min(12, world.y));
				s.onChangePoints(points.map((entry, i) => (i === drag.index ? { ...entry, height } : entry)), { dragging: true });
			}
			invalidate();
		};
		const onUp = () => {
			if (dragRef.current?.recorded) stateRef.current.onDragEnd?.();
			dragRef.current = null;
		};
		const onDouble = (event) => {
			const s = stateRef.current;
			if (!s.enabled || !s.crane || !s.rail || !camRef.current) return;
			camRef.current.updateMatrixWorld();
			let best = null;
			for (let i = 0; i < s.rail.points.length; i += 1) {
				const t = s.rail.cumLen[i] / s.rail.length;
				const screen = paneScreen(new THREE.Vector3(s.rail.points[i].x, craneHeightAt(s.crane, t), s.rail.points[i].z));
				if (!screen) continue;
				const d = Math.hypot(screen.x - event.clientX, screen.y - event.clientY);
				if (!best || d < best.d) best = { d, t };
			}
			if (!best || best.d > 14) return;
			if (s.crane.points.length >= 8) return;
			if (s.crane.points.some((entry) => Math.abs(entry.t - best.t) < 0.03)) return;
			event.stopImmediatePropagation();
			event.preventDefault();
			const added = [...s.crane.points, { t: best.t, height: craneHeightAt(s.crane, best.t) }].sort((a, b) => a.t - b.t);
			s.onChangePoints(added);
			s.onSelect(added.findIndex((entry) => entry.t === best.t));
			invalidate();
		};
		const onKey = (event) => {
			const s = stateRef.current;
			if (!s.enabled || !s.crane) return;
			if (event.key !== "Delete" && event.key !== "Backspace") return;
			if (document.activeElement && /INPUT|TEXTAREA/.test(document.activeElement.tagName)) return;
			const index = s.selectedIndex;
			if (index == null || index <= 0 || index >= s.crane.points.length - 1) return;
			event.preventDefault();
			s.onChangePoints(s.crane.points.filter((_, i) => i !== index));
			s.onSelect(null);
			invalidate();
		};
		const el = gl.domElement;
		el.addEventListener("pointerdown", onDown, true);
		window.addEventListener("pointermove", onMove, true);
		window.addEventListener("pointerup", onUp, true);
		el.addEventListener("dblclick", onDouble, true);
		window.addEventListener("keydown", onKey);
		return () => {
			el.removeEventListener("pointerdown", onDown, true);
			window.removeEventListener("pointermove", onMove, true);
			window.removeEventListener("pointerup", onUp, true);
			el.removeEventListener("dblclick", onDouble, true);
			window.removeEventListener("keydown", onKey);
		};
		// paneRef/camRef are stable refs; handlers read live state through stateRef
		// eslint-disable-next-line react-hooks/exhaustive-deps
	}, [enabled, gl, invalidate]);
	if (!enabled || !crane || !rail) return null;
	return (
		<group ref={groupRef}>
			{crane.points.map((point, index) => {
				const base = railPoint(rail, point.t * rail.length);
				return (
					<mesh
						key={`${index}:${crane.points.length}`}
						position={[base.x, point.height, base.z]}
						userData={{ craneIndex: index }}
						renderOrder={998}
					>
						<sphereGeometry args={[0.085, 16, 12]} />
						<meshBasicMaterial color={index === selectedIndex ? "#ffb454" : "#a78bfa"} depthTest={false} transparent opacity={0.95} />
					</mesh>
				);
			})}
		</group>
	);
}

function ShotPathPreview({ waypoints, start, activeWaypointId }) {
	const rootRef = useRef(null);
	const line = useMemo(() => {
		if (!waypoints.length) return null;
		const points = [{ x: start.x, z: start.z }, ...waypoints];
		const positions = new Float32Array(points.length * 3);
		points.forEach((point, i) => {
			positions[i * 3] = point.x;
			positions[i * 3 + 1] = 0.03;
			positions[i * 3 + 2] = point.z;
		});
		const geometry = new THREE.BufferGeometry();
		geometry.setAttribute("position", new THREE.BufferAttribute(positions, 3));
		return geometry;
	}, [start.x, start.z, waypoints]);
	useEffect(() => {
		// Every render: drei's Text meshes appear asynchronously, and each new
		// node must land on the gizmo layer before the next capture.
		rootRef.current?.traverse((node) => node.layers.set(GIZMO_LAYER));
	});
	if (!waypoints.length) return null;
	return (
		<group ref={rootRef}>
			{line && (
				<line geometry={line}>
					<lineBasicMaterial color="#4e9fb3" transparent opacity={0.8} depthWrite={false} />
				</line>
			)}
			{waypoints.map((waypoint, i) => {
				const active = waypoint.id === activeWaypointId;
				const color = active ? "#ffd76c" : "#4e9fb3";
				return (
					<group key={waypoint.id} position={[waypoint.x, 0.03, waypoint.z]}>
						<mesh rotation={[-Math.PI / 2, 0, 0]}>
							<ringGeometry args={[0.13, 0.19, 28]} />
							<meshBasicMaterial color={color} depthWrite={false} />
						</mesh>
						<Text
							position={[0, 0.02, 0.34]}
							rotation={[-Math.PI / 2, 0, 0]}
							fontSize={0.24}
							color={color}
							anchorX="center"
							anchorY="middle"
							outlineWidth={0.03}
							outlineColor="#1c1a17"
							outlineOpacity={0.85}
						>
							{String(i + 1)}
						</Text>
					</group>
				);
			})}
		</group>
	);
}

// How far the deck runs in an EXPORTED frame. The viewport fades it out at
// 18..54 m to keep the working view clean; a blocking frame needs the far edge
// to survive, so the falloff starts later and ends further away, letting the
// floor resolve into a horizon instead of dissolving into the background.
//
// Both values must stay inside the shot camera's far plane (100 m) — geometry
// past it is clipped outright, so a fog range that ended beyond it would cut
// the deck off mid-fade and take the horizon with it.
const CAPTURE_FOG_NEAR = 55;
const CAPTURE_FOG_FAR = 95;

/** Offscreen aspect-aware read-back, always from the shot camera. */
function CaptureRig({ apiRef, camRef, width = CAPTURE_W, height = CAPTURE_H }) {
	const { gl, scene } = useThree();
	useEffect(() => {
		const target = new THREE.WebGLRenderTarget(width, height, {
			colorSpace: THREE.SRGBColorSpace,
			samples: 4,
		});
		const buffer = new Uint8Array(width * height * 4);
		const api = {
			scene,
			render() {
				const source = camRef.current;
				if (!source) return null;
				const cam = source.clone();
				// the transform gizmo is UI: it never reaches an exported frame
				cam.layers.disable(GIZMO_LAYER);
				// QA hook: the layer mask the export camera actually renders
				// with — the browser suite asserts GIZMO_LAYER (the gizmo AND
				// the selection cage) is never in it.
				window.__captureCameraMask = cam.layers.mask;
				cam.aspect = width / height;
				cam.updateProjectionMatrix();
				const previous = gl.getRenderTarget();
				// The viewport's fog dissolves the deck into the background by ~54 m
				// so the working view has no horizon to distract from blocking. An
				// exported frame wants the opposite: the horizon IS the vanishing
				// point, and without it the floor has no far edge to read depth
				// against. Push the falloff back for this draw only, then restore
				// it so the viewport is untouched.
				const fog = scene.fog;
				const fogNear = fog?.near;
				const fogFar = fog?.far;
				if (fog) {
					fog.near = CAPTURE_FOG_NEAR;
					fog.far = CAPTURE_FOG_FAR;
				}
				try {
					gl.setRenderTarget(target);
					gl.render(scene, cam);
					gl.readRenderTargetPixels(target, 0, 0, width, height, buffer);
				} finally {
					gl.setRenderTarget(previous);
					if (fog) {
						fog.near = fogNear;
						fog.far = fogFar;
					}
				}
				return buffer;
			},
		};
		apiRef.current = api;
		if (width === MCP_CAPTURE_W && height === MCP_CAPTURE_H) {
			window.__cozyclayMcpCaptureReady = true;
			window.dispatchEvent(new Event("cozyclay:mcp-capture-ready"));
		}
		// QA hook: run one real export render and report what the capture
		// camera saw — the layer mask plus an amber scan of the output
		// frame (the selection cage's warm tone). Lets the suite prove the
		// deliverable frame stays free of editor furniture without driving
		// the whole generation form.
		window.__captureFrame = () => {
			const buffer = apiRef.current?.render() ?? null;
			if (!buffer) return null;
			let amber = 0;
			for (let i = 0; i < buffer.length; i += 4) {
				const r = buffer[i];
				const g = buffer[i + 1];
				const b = buffer[i + 2];
				if (r >= 180 && g >= 165 && g - b >= 35) amber++;
			}
			return { layersMask: window.__captureCameraMask ?? 0, amber, pixels: buffer.length / 4 };
		};
		return () => {
			if (apiRef.current === api) apiRef.current = null;
			if (width === MCP_CAPTURE_W && height === MCP_CAPTURE_H) window.__cozyclayMcpCaptureReady = false;
			target.dispose();
		};
	}, [gl, scene, camRef, apiRef, width, height]);
	return null;
}

async function captureMcpFrame({ capture, camera, characters, activeCharacterId, objects, rigs, readAuthoredState }) {
	if (!capture || !camera) throw new Error("No renderable shot camera is available for capture_frame.");
	const authoredStateBefore = JSON.stringify(readAuthoredState());
	const buffer = capture.render();
	if (!buffer) throw new Error("No renderable shot camera is available for capture_frame.");
	let nonBlackPixels = 0;
	for (let offset = 0; offset < buffer.length; offset += 4) {
		if (buffer[offset] > 5 || buffer[offset + 1] > 5 || buffer[offset + 2] > 5) nonBlackPixels += 1;
	}
	if (nonBlackPixels === 0) throw new Error("capture_frame rejected a black rendered frame.");
	camera.updateMatrixWorld();
	const raycaster = new THREE.Raycaster();
	const roots = [];
	capture.scene.traverse((node) => {
		const id = node.userData?.sceneObjectId;
		if (typeof id === "string" && objects.some((object) => object.id === id)) roots.push({ id, root: node });
	});
	const assertions = characters.map((character) => {
		const rig = rigs[character.id];
		if (!rig || character.hidden) return { id: character.id, renderable: false, behindCameraPlane: null, fartherAlongCameraForward: null, distanceToFloor: null, occludedBy: null, visiblePixelCount: 0 };
		rig.updateWorldMatrix(true, true);
		const bounds = new THREE.Box3().setFromObject(rig);
		const center = bounds.getCenter(new THREE.Vector3());
		const cameraSpace = camera.worldToLocal(center.clone());
		const behindCameraPlane = cameraSpace.z >= 0;
		const distanceToFloor = Math.max(0, bounds.min.y);
		if (behindCameraPlane || bounds.isEmpty()) {
			return { id: character.id, renderable: true, behindCameraPlane, fartherAlongCameraForward: -cameraSpace.z, distanceToFloor, occludedBy: null, visiblePixelCount: 0 };
		}
		const corners = [
			new THREE.Vector3(bounds.min.x, bounds.min.y, bounds.min.z), new THREE.Vector3(bounds.min.x, bounds.min.y, bounds.max.z),
			new THREE.Vector3(bounds.min.x, bounds.max.y, bounds.min.z), new THREE.Vector3(bounds.min.x, bounds.max.y, bounds.max.z),
			new THREE.Vector3(bounds.max.x, bounds.min.y, bounds.min.z), new THREE.Vector3(bounds.max.x, bounds.min.y, bounds.max.z),
			new THREE.Vector3(bounds.max.x, bounds.max.y, bounds.min.z), new THREE.Vector3(bounds.max.x, bounds.max.y, bounds.max.z),
		].map((corner) => corner.project(camera));
		const minX = Math.max(0, Math.floor(((Math.min(...corners.map((corner) => corner.x)) + 1) * 0.5) * MCP_CAPTURE_W));
		const maxX = Math.min(MCP_CAPTURE_W - 1, Math.ceil(((Math.max(...corners.map((corner) => corner.x)) + 1) * 0.5) * MCP_CAPTURE_W));
		const minY = Math.max(0, Math.floor(((1 - Math.max(...corners.map((corner) => corner.y))) * 0.5) * MCP_CAPTURE_H));
		const maxY = Math.min(MCP_CAPTURE_H - 1, Math.ceil(((1 - Math.min(...corners.map((corner) => corner.y))) * 0.5) * MCP_CAPTURE_H));
		const occluders = new Map();
		let visiblePixelCount = 0;
		for (let y = minY; y <= maxY; y += MCP_CAPTURE_SAMPLE_STEP) {
			for (let x = minX; x <= maxX; x += MCP_CAPTURE_SAMPLE_STEP) {
				raycaster.setFromCamera({ x: (x / MCP_CAPTURE_W) * 2 - 1, y: 1 - (y / MCP_CAPTURE_H) * 2 }, camera);
				const characterHit = raycaster.intersectObject(rig, true)[0];
				if (!characterHit) continue;
				const objectHit = raycaster.intersectObjects(roots.map((entry) => entry.root), true)[0];
				const pixels = MCP_CAPTURE_SAMPLE_STEP * MCP_CAPTURE_SAMPLE_STEP;
				if (!objectHit || objectHit.distance >= characterHit.distance - 1e-4) {
					visiblePixelCount += pixels;
					continue;
				}
				const occluder = roots.find((entry) => {
					let node = objectHit.object;
					while (node) {
						if (node === entry.root) return true;
						node = node.parent;
					}
					return false;
				});
				if (occluder) occluders.set(occluder.id, (occluders.get(occluder.id) ?? 0) + pixels);
			}
		}
		const occludedBy = [...occluders.entries()].sort((left, right) => right[1] - left[1])[0]?.[0] ?? null;
		return { id: character.id, renderable: true, behindCameraPlane, fartherAlongCameraForward: -cameraSpace.z, distanceToFloor, occludedBy, visiblePixelCount };
	});
	const active = assertions.find((entry) => entry.id === activeCharacterId) ?? assertions[0];
	const authoredStateAfter = JSON.stringify(readAuthoredState());
	const canvas = document.createElement("canvas");
	canvas.width = MCP_CAPTURE_W;
	canvas.height = MCP_CAPTURE_H;
	const context = canvas.getContext("2d");
	if (!context) throw new Error("capture_frame could not encode the rendered image.");
	const image = context.createImageData(MCP_CAPTURE_W, MCP_CAPTURE_H);
	for (let row = 0; row < MCP_CAPTURE_H; row += 1) {
		image.data.set(buffer.subarray((MCP_CAPTURE_H - 1 - row) * MCP_CAPTURE_W * 4, (MCP_CAPTURE_H - row) * MCP_CAPTURE_W * 4), row * MCP_CAPTURE_W * 4);
	}
	context.putImageData(image, 0, 0);
	const blob = await new Promise((resolve) => canvas.toBlob(resolve, "image/png"));
	if (!blob) throw new Error("capture_frame could not compress the rendered image.");
	const bytes = new Uint8Array(await blob.arrayBuffer());
	let binary = "";
	for (const byte of bytes) binary += String.fromCharCode(byte);
	return {
		width: MCP_CAPTURE_W,
		height: MCP_CAPTURE_H,
		mimeType: "image/png",
		encoding: "base64",
		byteSize: bytes.length,
		data: btoa(binary),
		authoredStateBefore,
		authoredStateAfter,
		assertions: {
			renderable: true,
			blackFrame: false,
			nonBlackPixels,
			behindCameraPlane: active?.behindCameraPlane ?? null,
			fartherAlongCameraForward: active?.fartherAlongCameraForward ?? null,
			distanceToFloor: active?.distanceToFloor ?? null,
			occludedBy: active?.occludedBy ?? null,
			visiblePixelCount: active?.visiblePixelCount ?? 0,
			characters: assertions,
		},
	};
}

/**
 * Anything that accepts a dropped picture. Returns the handlers to spread onto
 * an element and whether a drag is currently over it, so the target can say so
 * — a drop zone that gives no sign it is armed reads as a dead area, and the
 * file gets dropped on the desktop instead.
 *
 * `dragover` must preventDefault, or the browser navigates away to the file.
 */
function useImageDrop(onFiles) {
	const [over, setOver] = useState(false);
	const depth = useRef(0);
	const carriesFiles = (event) => !!event.dataTransfer?.types?.includes?.("Files");
	return {
		over,
		handlers: {
			onDragEnter: (event) => {
				if (!carriesFiles(event)) return;
				event.preventDefault();
				depth.current += 1;
				setOver(true);
			},
			onDragOver: (event) => {
				if (!carriesFiles(event)) return;
				event.preventDefault();
				event.dataTransfer.dropEffect = "copy";
			},
			// dragleave fires for every child the pointer crosses, so the
			// highlight is refcounted rather than toggled.
			onDragLeave: () => {
				depth.current = Math.max(0, depth.current - 1);
				if (!depth.current) setOver(false);
			},
			onDrop: (event) => {
				const files = imageFilesFrom(event.dataTransfer);
				depth.current = 0;
				setOver(false);
				if (!files.length) return;
				event.preventDefault();
				event.stopPropagation();
				onFiles(files);
			},
		},
	};
}

/* ----------------------------------------------------------------- app --- */

// Unity's tool keys. They are free because camera movement now lives behind a
// held right button. (docs/unity-reference.md §9.2)
const GIZMO_HOTKEYS = { KeyW: "move", KeyE: "rotate", KeyR: "scale" };

const WORKSPACE_LAYOUT_KEY = "cozyclay.workspace-layout.v1";
const DEFAULT_WORKSPACE_LAYOUT = Object.freeze({
	hierarchyWidth: 300,
	sidebarWidth: 380,
	timelineHeight: 224,
	insetWidth: 310,
	insetHeight: 310,
	insetCollapsed: false,
	planZoom: 1,
});

function loadWorkspaceLayout() {
	try {
		const saved = JSON.parse(localStorage.getItem(WORKSPACE_LAYOUT_KEY) || "null");
		return saved ? { ...DEFAULT_WORKSPACE_LAYOUT, ...saved } : { ...DEFAULT_WORKSPACE_LAYOUT };
	} catch {
		return { ...DEFAULT_WORKSPACE_LAYOUT };
	}
}

/** Load the Scene envelope once. Legacy single-scene objects are migrated by
 * scenes.js; App only supplies the familiar starter set for a truly new room. */
function loadSceneStartup() {
	const defaults = () => DEFAULT_SCENE_OBJECTS.map((object) => ({ ...object, footprint: { ...object.footprint } }));
	try {
		const result = loadSceneDocumentFromStorage(localStorage);
		if (result.status === "future") {
			const document = createSceneDocument();
			document.scenes[0].objects = defaults();
			return {
				document,
				saveBlocked: true,
				error: null,
				toast: ko("Saved scenes were written by a newer CozyClay — they have been left untouched and this session will not save", "저장된 장면은 더 최신 CozyClay에서 만들어졌어요. 이 세션에서는 건드리지 않고 저장도 하지 않습니다."),
			};
		}
		const document = result.document;
		if ((result.status === "absent" || result.status === "corrupt") && document.scenes[0].objects.length === 0) {
			document.scenes[0].objects = defaults();
		}
		return {
			document,
			saveBlocked: false,
			error: null,
			toast: result.status === "corrupt"
				? ko(`Saved scenes were unreadable — starting fresh; the old data is kept under ${SCENES_QUARANTINE_KEY}`, `저장된 장면을 읽을 수 없어 새로 시작합니다. 기존 데이터는 ${SCENES_QUARANTINE_KEY}에 보관했어요.`)
				: result.dropped > 0
					? (isKo ? `저장된 장면 ${result.dropped}개를 복원하지 못했어요` : `${result.dropped} saved scene(s) could not be restored`)
					: null,
		};
	} catch {
		const document = createSceneDocument();
		document.scenes[0].objects = defaults();
		return { document, saveBlocked: false, error: null, toast: null };
	}
}

export default function App() {
	const craftActionTrackedRef = useRef(false);
	const markCraftAction = (actionKind) => {
		if (craftActionTrackedRef.current) return;
		craftActionTrackedRef.current = true;
		track("craft:first_action", { action_kind: actionKind });
	};
	const [startup] = useState(loadSceneStartup);
	const startupScene = startup.document.scenes[activeSceneIndex(startup.document.scenes, startup.document.activeSceneId)];
	const startupStage = createSceneStage(startupScene.stage);
	const [workspaceLayout, setWorkspaceLayout] = useState(loadWorkspaceLayout);
	const [preset, setPreset] = useState("medium");
	const [fovDeg, setFovDeg] = useState(PRESETS.medium.fov);
	const [shotAspectKey, setShotAspectKey] = useState(startupStage.shotAspect);
	const shotOutput = SHOT_ASPECT_PRESETS[shotAspectKey] ?? SHOT_ASPECT_PRESETS["16:9"];
	const [sensorId, setSensorFormat] = useState(startupStage.sensorId ?? DEFAULT_SENSOR_FORMAT);
	const filmback = useMemo(
		() => ({ sensorId, aspectRatio: shotOutput.aspect }),
		[sensorId, shotOutput.aspect],
	);
	const [nonce, setNonce] = useState(0);
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
		localStorage.setItem(WORKSPACE_LAYOUT_KEY, JSON.stringify(workspaceLayout));
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
		const id = charIdFromHierarchyId(selectedHierarchyId);
		if (id && characters.some((entry) => entry.id === id)) setActiveCharacterId(id);
	}, [selectedHierarchyId, characters]);
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
	const ikBodyDragRef = useRef(false); // true while a body drag is active
	// How far (in frames) a correction eases back to the underlying motion
	// outside its keyed range. 6 frames @ 24 fps = 0.25 s — long enough to
	// hide the seam, short enough that a mid-clip fix stays visibly local.
	const IK_CORRECTION_BLEND_FRAMES = 6;

	const ikStateRef = useRef(createIkState());
	const [ikTick, setIkTick] = useState(0);
	const [committedIkEdits, setCommittedIkEdits] = useState([]);
	// Sorted full-body key frames for the timeline markers. Derived from the
	// ref state; ikTick re-derives after every key add/remove.
	const ikFrames = useMemo(() => ikKeyframes(ikStateRef.current),
		// eslint-disable-next-line react-hooks/exhaustive-deps
		[ikTick]);

	function selectHierarchy(id) {
		// A selection switch is the user starting something else: settle any open
		// drag so its applied travel becomes one committed entry first (plan §6.3).
		// This MUST stay inside the handler, never in the render body: a settle
		// during render runs the producer's cancel teardown, and since the first
		// applied tick re-renders, every drag would die after exactly one tick.
		store.settle();
		setSelectedHierarchyId(id);
		const focus = RIG_HIERARCHY_FOCUS[id];
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
		const hierarchyId = hierarchyIdForIkFocus(focus);
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
			if (!files.length) return;
			event.preventDefault();
			importCutouts(files);
		};
		document.addEventListener("paste", onPaste);
		return () => document.removeEventListener("paste", onPaste);
		// eslint-disable-next-line react-hooks/exhaustive-deps
	}, []);

	const propsDrop = useImageDrop((files) => importCutouts(files));
	const inspectorDrop = useImageDrop((files) => importCutouts(files));
	const viewportDrop = useImageDrop((files) => importCutouts(files));
	// How much of the wall counts as the wall, and how wide the brush that
	// argues with the answer is.
	const [matteTolerance, setMatteTolerance] = useState(0.18);
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
				cutOutBackground(source, { mask: options.mask }),
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
	function frameSelection(id = selectedSceneObjectId) {
		const camera = (lookThroughShot ? shotCamRef : editorCamRef).current;
		const paneLook = lookThroughShot ? look : editorLook;
		const object = sceneObjects.find((item) => item.id === id) ?? null;
		if (!camera || !object) return;
		const size = objectSize(object);
		const target = {
			x: object.x,
			y: (object.y ?? 0) + size.height / 2,
			z: object.z,
		};
		const reach = Math.max(size.width, size.height, size.depth, 0.5);
		const distance = reach * 2.4 + 0.6;
		const back = forwardFrom(paneLook.current.yaw, paneLook.current.pitch).multiplyScalar(-distance);
		camera.position.set(target.x + back.x, Math.max(target.y + back.y, 0.3), target.z + back.z);
		const angles = aimAt(camera.position, target);
		paneLook.current.yaw = angles.yaw;
		paneLook.current.pitch = angles.pitch;
		camera.rotation.order = "YXZ";
		camera.rotation.set(angles.pitch, angles.yaw, 0);
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
		const out = new Map();
		for (const [frame, entry] of ikState?.keys ?? []) {
			const copy = new Map();
			for (const [trackId, value] of entry) {
				copy.set(trackId, {
					q: value.q ? value.q.map((quat) => quat.clone()) : null,
					p: value.p ? value.p.clone() : null,
				});
			}
			out.set(frame, copy);
		}
		return out;
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
			const target = bufferChar?.id === loadedIk
				? ikStateRef.current
				: ikStatesRef.current.get(bufferChar?.id) ?? ikStateRef.current;
			target.keys = snapshotIkKeys({ keys: snapshot.ikKeys });
			setCommittedIkEdits(snapshot.committedIkEdits ?? []);
			setIkTick((value) => value + 1);
		}
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
			if (event.code === "KeyF" && selectedSceneObjectId) {
				event.preventDefault();
				frameSelection();
				return;
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
			event.preventDefault();
			deleteSelectedSceneObject();
		};
		window.addEventListener("keydown", onKeyDown);
		return () => window.removeEventListener("keydown", onKeyDown);
	});

	useEffect(() => {
		setInspectorActionsOpen(false);
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
	const [videoModel, setVideoModel] = useState("seedance_2");
	const generation = useGeneration();
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
	const [bridge, setBridge] = useState(null);
	const [ardyPrompt, setArdyPrompt] = useState("");
	const [ardyDuration, setArdyDuration] = useState(4); // matches the 4 s generation cap
	// Optional native-ARDY seed: empty string = omit from the request (the
	// box picks a fresh random one each run); otherwise a plain integer in
	// 0..2**31-1 to reproduce a result.
	const [ardySeed, setArdySeed] = useState("");
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
	const [ardyRunning, setArdyRunning] = useState(false);
	const [ardyStatus, setArdyStatus] = useState("");
	const [consoleLines, setConsoleLines] = useState([]);
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
	// ARDY status doubles as a Unity-style console line: the inspector keeps
	// the current line, the bottom Console tab keeps the session history.
	function reportArdyStatus(line) {
		setArdyStatus(line);
		setConsoleLines((current) => [...current.slice(-99), { time: new Date(), line }]);
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
	function editRailSchedule(shotId, edit) {
		setShots((current) => updateStableItem(current, shotId, (shot) => {
			const camera = createCameraBlock(shot.camera);
			const duration = shot.endFrame - shot.startFrame + 1;
			const resolved = resolveRailSchedule({ railFollow: camera.railFollow, cameraRail: camera.cameraRail, frameCount: duration });
			const base = resolved.kind === RAIL_SCHEDULE_RANGE || resolved.kind === RAIL_SCHEDULE_LEGACY
				? { startFrame: resolved.startFrame, endFrame: resolved.endFrame }
				: defaultRailRange(duration);
			const railFollow = base ? edit(base, duration) : null;
			return railFollow ? { ...shot, camera: updateCameraBlock(camera, { railFollow: { mode: "range", ...railFollow } }) } : shot;
		}, "shots"));
	}
	const frameCountRef = useRef(DEFAULT_DURATION_S * TIMELINE_FPS);
	frameCountRef.current = tlFrameCount;
	// Root waypoints {frame, x, z, heading: null}, kept sorted by frame —
	// the fixed bridge contract rejects out-of-order or duplicate frames.
	const [waypointMode, setWaypointMode] = useState(false);
	const [waypoints, setWaypoints] = useState(startupStage.characters?.[0]?.layer?.waypoints ?? startupShotState?.waypoints ?? []);
	const [activeWaypointId, setActiveWaypointId] = useState(null);
	const [pendingWaypointFrame, setPendingWaypointFrame] = useState(null);
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
	const [projectName, setProjectName] = useState(null); // null = untitled session
	const [projectDirty, setProjectDirty] = useState(false);
	const [projectMenuOpen, setProjectMenuOpen] = useState(false);
	const [projectBrowserOpen, setProjectBrowserOpen] = useState(false);

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

	function projectDocumentInput(name) {
		return {
			scenesDocument: {
				version: SCENES_VERSION,
				activeSceneId: activeSceneIdRef.current,
				scenes: snapshotActiveScene(),
			},
			workspaceLayout: projectStateRef.current.workspaceLayout,
			customPoses: projectStateRef.current.customPoses,
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
			const assets = await Promise.all([...referencedAssetIds(input.scenesDocument.scenes)].map((id) => getAsset(db, id)));
			return JSON.stringify(createProjectDocument({ ...input, assets }), null, 2);
		} finally {
			db.close();
		}
	}

	function markProjectClean(name) {
		projectSnapshotRef.current = collectProjectSnapshot(name);
		setProjectDirty(false);
		setProjectName(name);
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

	async function saveProject(saveAs = false) {
		const name = projectName ?? "Untitled";
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
		saveCustomPoses(mergedCustomPoses);
		persistScenes(doc.scenes, doc.activeSceneId);
		openScene(doc.scenes[activeSceneIndex(doc.scenes, doc.activeSceneId)], doc.scenes);
		projectSnapshotRef.current = collectProjectSnapshot(project.name);
		setProjectDirty(false);
		setProjectName(project.name);
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
			setToast(isKo ? `프로젝트 열림: ${result.project.name}` : `Project opened: ${result.project.name}`);
		} catch (err) {
			console.error("openProjectByHandle failed", err);
			setToast(ko("Could not open the project", "프로젝트를 열지 못했어요"));
		}
	}

	function newProject() {
		if (projectDirty && !window.confirm(ko("Discard unsaved changes and start a new project?", "저장되지 않은 변경사항을 버리고 새 프로젝트를 시작할까요?"))) return;
		const fresh = createSceneDocument(ko("SCENE 01", "씬 01"));
		setScenes(fresh.scenes);
		setActiveSceneId(fresh.activeSceneId);
		persistScenes(fresh.scenes, fresh.activeSceneId);
		openScene(fresh.scenes[0], fresh.scenes);
		projectHandleRef.current = null;
		clearStoredProjectHandle();
		projectSnapshotRef.current = "";
		setProjectDirty(false);
		setProjectName(null);
		setToast(ko("New project", "새 프로젝트"));
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
				const camera = shotCamRef.current;
				if (camera) {
					camera.position.set(next.x, next.y, next.z);
					camera.fov = nextFov;
					camera.updateProjectionMatrix();
				}
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
				// ones do. They arrive on ARDY's 20 fps clock; the lane runs on the 24 fps
				// production clock, so each boundary is converted, not copied.
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
	}, [sceneObjects, shots, waypoints, tlFrameCount, charA, charB, showB, poseA, poseB, hasCharSheet, subject, subject2, shotAspectKey, sensorId, scenes, activeSceneId]);
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
	}, [scenes, activeSceneId, workspaceLayout, customPoses, characters, shots, waypoints, promptClips, projectName]);
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
		for (const entry of characters) {
			const clip = entry.id === activeChar.id ? motion : entry.sessionMotion;
			const rig = rigs[entry.id];
			if (!clip || !rig) continue;
			const sampled = sampleAt({ frameCount: clip.frames, motion: clip }, null, frame);
			applyMotionFrame(rig, clip, sampled.motionFrame);
		}
		if (activeRig && ikChains && ikStateRef.current.keys.size > 0) {
			ikEvaluate(ikChains, ikStateRef.current, frame, ikFkJoints, motion ? IK_CORRECTION_BLEND_FRAMES : 0);
		}
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

	async function runShotExport({ startFrame = 0, endFrame = tlFrameCount - 1, download = true } = {}) {
		if (recRef.current) throw new Error(ko("An export is already running", "이미 내보내기 중입니다"));
		if (!captureRef.current || !shotCamRef.current) throw new Error(ko("The shot renderer is not ready", "샷 렌더러가 아직 준비되지 않았어요"));
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
				endFrame,
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
		runShotExport().catch((error) => {
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
	const isRigSelection = selectedHierarchyId === "characterA.rig" || selectedHierarchyId.startsWith("rig.");
	const inspectorHasContent = isSceneSelection || isCameraSelection || isCharacterSelection || isRigSelection
		|| selectedHierarchyId === "environment" || selectedHierarchyId === "props" || Boolean(selectedSceneObject);

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
		setWaypointMode(next);
		if (!next) {
			setPendingWaypointFrame(null);
			setToast(ko("2D Root path constraints off", "2D 루트 경로 제약 꺼짐"));
			return;
		}

		setToast(ko("2D Root path on — click the set floor in the Shot view to drop waypoints; Subject 1 is the frame 0 start", "2D 루트 경로 켜짐 — 샷 뷰의 세트 바닥을 클릭해 웨이포인트를 놓으세요. 인물 1이 0프레임 시작점입니다"));
	}

	function advanceFrame() {
		const previewEnd = cameraPreviewEndRef.current;
		if (previewEnd != null && tlFrameRef.current >= previewEnd - 1) {
			cameraPreviewEndRef.current = null;
			setTlFrame(previewEnd);
			setTlPlaying(false);
			return;
		}
		setTlFrame((f) => (f >= frameCountRef.current - 1 ? 0 : f + 1));
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
			setMultiModelTake({ frames: done.frames, fps: done.fps, gpu: true, personScale, persons });
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
			if (!drop && staging) {
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
				setTlFrame(0);
				setTlPlaying(false);
			}
			// IK keys correct SPECIFIC frames of the take they were authored on, so
			// a replacement take leaves them pointing at poses that no longer exist
			// — the same reason a trim clears them. The Full-Body lane would
			// otherwise keep showing corrections that belong to a discarded clip.
			const hadIkKeys = bufferOwnsTarget && ikStateRef.current.keys.size > 0;
			if (hadIkKeys) {
				ikStateRef.current.keys.clear();
				ikStateRef.current.tracked.clear();
				ikStateRef.current.plants.clear();
				setIkTick((value) => value + 1);
			}
			if (bufferOwnsTarget) setCommittedIkEdits([]);
			setToast(
				isKo
					? `모션 로드됨: ${decoded.frames}프레임 @ ${decoded.fps} fps${hadIkKeys ? " — 이전 테이크의 IK 키는 초기화됐어요" : ""}`
					: `Motion loaded: ${decoded.frames} frames @ ${decoded.fps} fps${hadIkKeys ? " — IK keys from the previous take were cleared" : ""}`,
			);
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
		// eslint-disable-next-line react-hooks/exhaustive-deps
	}, []);

	const demoSeeded = useRef(false);
	useEffect(() => {
		if (demoSeeded.current) return;
		if (!bridge || bridge.ok) return;
		if (!activeRig || motion || motionBusy) return;
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
		const segments = trimMotionEdit(motion.editSegments ?? createMotionEdit(full.frames), start, end);
		const sliced = renderMotionEdit(full, segments);
		setMotion({ ...sliced, url: null });
		setTlFrameCount(sliced.frames);
		setTlFrame((frame) => Math.min(frame, sliced.frames - 1));
		setTlPlaying(false);
		if (ikStateRef.current.keys.size > 0) {
			// IK keys were authored on the pre-cut frame numbers.
			ikStateRef.current.keys.clear();
			ikStateRef.current.tracked.clear();
			ikStateRef.current.plants.clear();
			setIkTick((value) => value + 1);
			setToast(isKo
				? `테이크 잘라냄 — ${sliced.frames}프레임. 기존 프레임의 IK 키는 초기화됐어요`
				: `Take cut to ${sliced.frames} frames; IK keys keyed to the old frames were cleared`);
		} else {
			setToast(isKo
				? `테이크 잘라냄 — ${sliced.frames}프레임`
				: `Take cut to ${sliced.frames} frames`);
		}
	}

	function resetMotionTrim() {
		const full = motionFullRef.current.get(activeChar.id);
		if (!full || !motion || motion.frames === full.frames && motion.editSegments?.length === 1) return;
		recordCharacterUndo();
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
		setMotion({ ...rendered, url: null });
		setTlFrameCount(rendered.frames);
		setTlFrame((frame) => Math.min(frame, rendered.frames - 1));
		setTlPlaying(false);
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

	// Drive every cast member from ITS OWN clip on the shared playhead. The
	// active character's buffer motion and the stored session motions of the
	// others all advance together; characters without a clip keep their pose.
	useEffect(() => {
		for (const entry of characters) {
			const clip = entry.id === activeChar.id ? motion : entry.sessionMotion;
			const rig = rigs[entry.id];
			if (clip && rig) {
				const sampled = sampleAt({ frameCount: clip.frames, motion: clip }, null, tlFrame);
				applyMotionFrame(rig, clip, sampled.motionFrame);
			}
		}
	}, [characters, activeChar.id, motion, rigs, tlFrame]);

	// The shared timeline spans the LONGEST clip in the cast — a 300-frame
	// clip on Subject 2 must not clamp just because Subject 1's is 40.
	// Expansion only: shrinking stays owned by clearMotion and duration edits.
	useEffect(() => {
		const longest = characters.reduce((max, entry) => {
			const clip = entry.id === activeChar.id ? motion : entry.sessionMotion;
			return Math.max(max, clip?.frames ?? 0);
		}, 0);
		if (longest > 0) setTlFrameCount((count) => Math.max(count, longest));
	}, [characters, activeChar.id, motion]);

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
		if (!chains) leaveIkMode();
	}, [activeRig]);

	function toggleIkMode() {
		const next = !ikMode;
		if (next) {
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
			ikStateRef.current.targets.set(trackId, targetWorld.clone());
			solveIk(chain, targetWorld);
			return;
		}
		if (kind === "mid") {
			// Mid tracks reference their parent chain through MID_TRACKS.
			const midDef = MID_TRACKS.find((t) => t.id === trackId);
			const chain = midDef ? ikStateRef.current.chains?.get(midDef.chain) : null;
			if (!chain) return;
			ikTouch(ikStateRef.current, chain.track.id);
			solveMidJoint(chain, targetWorld);
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
			if (targetWorld?.worldDelta && targetWorld?.startLocalPos) solveHipsTranslate(joint, targetWorld.worldDelta, targetWorld.startLocalPos);
			else if (targetWorld?.axis) solveSwingAngle(joint, targetWorld.axis, targetWorld.angle, targetWorld.startQuat, targetWorld.startParentQuat);
			if (footSnap && ikChains) {
				ikSolvePlantedFeet(ikChains, ikStateRef.current);
				// the planted re-solve wrote the leg bones — key them too
				ikTouch(ikStateRef.current, "leftFoot");
				ikTouch(ikStateRef.current, "rightFoot");
			}
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

	function ikDeleteKeyframe(frame) {
		if (!ikStateRef.current.keys.has(frame)) return;
		recordCharacterUndo();
		ikRemoveKeyframe(ikStateRef.current, frame);
		setIkTick((n) => n + 1);
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
		if (!ikMode && ikStateRef.current.keys.size === 0) return;
		ikEvaluate(ikChains, ikStateRef.current, tlFrame, ikFkJoints, motion ? IK_CORRECTION_BLEND_FRAMES : 0);
	}, [ikMode, ikChains, activeRig, motion, posing, tlFrame, ikTick, ikFkJoints]);

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
			rigA: activeRig, motion, tlFrame, ikMode, ikChains, ikFocus, ik: ikStateRef.current,
			committedIkEdits, waypoints,
			// the camera the main view renders through (poser in IK mode) — QA
			// projections must use this one, not the frozen shot camera
			activeCam: ikMode ? poserCamRef.current : lookThroughShot ? shotCamRef.current : editorCamRef.current,
			shotCam: shotCamRef.current,
			poserCam: poserCamRef.current,
			planCam: planCamRef.current,
			editorCam: editorCamRef.current,
			lookThroughShot,
			setLookThrough: (value) => setLookThroughShot(!!value),
			charA,
			insetPane: insetPaneRef.current,
		};
	}, [activeRig, motion, tlFrame, ikMode, ikChains, ikFocus, ikTick, charA, committedIkEdits, waypoints, lookThroughShot]);
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
			const params = { ...camera.followCam, craneHeight: camera.craneHeight, initialDir: { x: Math.sin(yaw), z: Math.cos(yaw) } };
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
			if (!photoPoseDetectorRef.current) {
				photoPoseDetectorRef.current = await createPoseDetector({ runningMode: "IMAGE" });
			}
			objectUrl = URL.createObjectURL(file);
			const samples = await collectLandmarkTrack({
				frames: imageFrames(objectUrl, { createImage: () => new Image() }),
				detect: photoPoseDetectorRef.current.detect,
			});
			if (samples.length === 0) throw new Error("no-person-in-photo");
			const take = bakePoseFrame({ samples, rest: multiModelRestRef.current, createdMs: Date.now() });
			// Pose the rig, read the pose back, then put the rig exactly as it was:
			// the capture is the product, the posing is only how it is measured.
			const snapshot = snapshotPlaybackBones(rig);
			let bones;
			try {
				applyMotionFrame(rig, { ...take, anchorFrame: 0 }, 0);
				bones = capturePose(rig);
			} finally {
				restorePlaybackBones(rig, snapshot);
			}
			const pose = {
				id: `photo_${Date.now()}`,
				label: isKo ? `사진 포즈 ${customPoses.length + 1}` : `Photo Pose ${customPoses.length + 1}`,
				prompt: "in the exact body pose shown in the reference photograph",
				bones,
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
			setToast(hadMotion
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

	async function generate() {
		generation.reset();
		const models = mode === "video" && generation.models.length ? generation.models : mode === "video" ? VIDEO_MODELS : IMAGE_MODELS;
		const model = models.find((m) => m.id === (mode === "video" ? videoModel : imageModel));
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
		if (mode === "video" && generation.models.some((candidate) => candidate.id === model?.id && candidate.provider === model?.provider)) {
			try {
				await generation.startResult(nextResult, model);
			} catch (error) {
				setToast(error?.message || String(error));
			}
		}
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
		const refreshBridge = () => checkBridge().then((state) => {
			if (alive) setBridge(state);
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
		const startFrame = Math.max(snapped, promptClips.reduce((max, clip) => Math.max(max, clip.endFrame), 0));
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

	// Quality policy: one prompt block never spans more than 4 s. ARDY's
// trained window is 10 s, but long single blocks drift — chained 4 s
// blocks keep each call inside the model's sweet spot.
const PROMPT_BLOCK_MAX_FRAMES = 4 * TIMELINE_FPS;

function resizePromptClip(id, edge, rawFrame) {
		setPromptClips((prev) => {
			const next = updateStableItem(prev, id, (clip) => {
				const snapped = Math.max(0, Math.round(rawFrame / ARDY_PROMPT_HORIZON_FRAMES) * ARDY_PROMPT_HORIZON_FRAMES);
				return edge === "start"
					? { ...clip, startFrame: Math.min(Math.max(snapped, clip.endFrame - PROMPT_BLOCK_MAX_FRAMES), clip.endFrame - ARDY_PROMPT_HORIZON_FRAMES) }
					: { ...clip, endFrame: Math.min(Math.max(clip.startFrame + ARDY_PROMPT_HORIZON_FRAMES, snapped), clip.startFrame + PROMPT_BLOCK_MAX_FRAMES) };
			}, "promptClips");
			const end = next.reduce((max, clip) => Math.max(max, clip.endFrame), ARDY_PROMPT_HORIZON_FRAMES);
			setTlFrameCount((count) => Math.max(count, end));
			setArdyDuration(end / TIMELINE_FPS);
			return next;
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
	} = {}) {
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
		const seed = ardySeed === "" ? null : Number(ardySeed);
		if (seed !== null && (!Number.isInteger(seed) || seed < 0 || seed > ARDY_SEED_MAX)) {
			setToast(isKo ? `Seed는 0..${ARDY_SEED_MAX} 범위의 정수여야 해요. 비워 두면 자동으로 선택됩니다` : `Seed must be an integer in 0..${ARDY_SEED_MAX} — clear it to let the box pick one`);
			return;
		}
		// Prompt clips are real generation blocks. Gaps inherit the current
		// prompt so the bridge always receives one contiguous 0..N sequence.
		// Built BEFORE the root-path judge: whether the rollout is chained
		// changes which window limit binds the path (per block, not per clip).
		// `duration` is SECONDS — the one frame-rate-free number in the
		// request, and the only one the bridge reads directly. Everything the
		// app counts in frames from here on is on the timeline clock; the
		// bridge's own count is duration * ARDY_FPS, reached via toArdyFrame.
		const clipFrames = duration * TIMELINE_FPS;
		const segments = [];
		let cursor = 0;
		const sourcePromptClips = promptClipsOverride
			.filter((clip) => clip.text.trim())
			.sort((a, b) => a.startFrame - b.startFrame);
		for (const clip of sourcePromptClips) {
			const startFrame = Math.max(cursor, Math.min(clipFrames, clip.startFrame));
			const endFrame = Math.max(startFrame, Math.min(clipFrames, clip.endFrame));
			if (startFrame > cursor) segments.push({ startFrame: cursor, endFrame: startFrame, prompt });
			if (endFrame - startFrame >= 3) segments.push({ startFrame, endFrame, prompt: clip.text.trim() || prompt });
			cursor = Math.max(cursor, endFrame);
			if (cursor >= clipFrames) break;
		}
		if (cursor < clipFrames) segments.push({ startFrame: cursor, endFrame: clipFrames, prompt });
		if (segments.length === 0) segments.push({ startFrame: 0, endFrame: clipFrames, prompt });
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
			if (hasPromptSchedule) {
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
		// The 4 s block policy binds the schedule path too, not just
		// root-constrained runs: chained blocks are the whole point of the cap.
		if (!waypointMode && hasPromptSchedule) {
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
		if (ardySeed !== "") body.seed = Number(ardySeed);
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
		});
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
			if (done.motionUrl) await deliverMotion(job, done.motionUrl);
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
			}).catch(() => {});
		}
	}

	function cancelArdy() {
		ardyAbortRef.current?.abort();
	}

	const models = mode === "video" && generation.models.length ? generation.models : mode === "video" ? VIDEO_MODELS : IMAGE_MODELS;
	useEffect(() => {
		if (mode === "video" && generation.models.length && !generation.models.some((model) => model.id === videoModel)) {
			setVideoModel(generation.models[0].id);
		}
	}, [mode, videoModel, generation.models]);

	return (
		<div className={"app" + (renderActive ? "" : " render-idle")}>
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
						{projectName ?? ko("Untitled Project", "제목 없는 프로젝트")}
						<span className="caret">▾</span>
					</button>
					{projectMenuOpen && (
						<div className="project-menu" role="menu" onClick={() => setProjectMenuOpen(false)}>
							<button type="button" role="menuitem" onClick={newProject}>{ko("New Project", "새 프로젝트")}</button>
							<button type="button" role="menuitem" onClick={() => setProjectBrowserOpen(true)}>{ko("Open Project…", "프로젝트 열기…")}</button>
							<button type="button" role="menuitem" onClick={() => saveProject(false)}>{ko("Save Project", "프로젝트 저장")}</button>
							<button type="button" role="menuitem" onClick={() => saveProject(true)}>{ko("Save Project As…", "다른 이름으로 저장…")}</button>
						</div>
					)}
				</div>
				<div className="topbar-actions">
					{liveWorkspaceHandle && (
						<span className="live-workspace-handle" data-live-workspace={liveWorkspaceHandle} title={liveWorkspaceHandle}>
							Live workspace {liveWorkspaceHandle}
						</span>
					)}
					<LocaleToggle />
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
					<strong>{projectName ?? ko("Untitled", "제목 없음")}</strong>
					{projectDirty && <i className="project-dirty-dot" aria-label={ko("Unsaved changes", "저장되지 않은 변경사항")} />}
					<button type="button" onClick={() => setProjectBrowserOpen(true)}>{ko("Projects…", "프로젝트…")}</button>
				</div>
				<HierarchyPanel
					selectedId={selectedHierarchyId}
					onSelect={selectHierarchy}
					characters={characters}
					showB={showB}
					motionFrames={motion?.frames ?? 0}
					ikFrames={ikFrames.length}
					ikMode={ikMode}
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
						<div className="tool-switch" role="group" aria-label={ko("Gizmo tool", "기즈모 도구")}>
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
							className={"snap-switch" + (snapEnabled ? " active" : "")}
							title={ko("Grid snapping — hold Ctrl during a drag to invert", "그리드 스냅 — 드래그 중 Ctrl을 누르면 반대로 작동")}
							aria-pressed={snapEnabled}
							onClick={() => setSnapEnabled((v) => !v)}
						>
							{ko("Snap", "스냅")}
						</button>
						<span className="viewport-toolbar-separator settings-separator" aria-hidden="true" />
						<label className="viewport-toolbar-field shot-field">
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
						<label className="viewport-toolbar-field ratio-field">
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
						<label className="viewport-fov-control">
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
						<span className="viewport-toolbar-spacer" />
						<button
							type="button"
							title={ko("Recenter on subject", "피사체 다시 맞추기")}
							aria-label={ko("Recenter on subject", "피사체 다시 맞추기")}
							onClick={() => setNonce((n) => n + 1)}
						>
							◎
						</button>
						<button
							type="button"
							aria-pressed={!workspaceLayout.insetCollapsed}
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
						<Canvas shadows frameloop={renderActive ? "always" : "demand"} dpr={[1, 2]} gl={{ preserveDrawingBuffer: true, antialias: true }}>
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
							<color attach="background" args={["#eef4f3"]} />
							{/* The open stage runs 500 m; without a falloff the whole deck
							    reads at once and the horizon sits a kilometre away. Blender's
							    viewport answer is a clip distance that lets the neutral void
							    show through; the fog below is the seamless version of the
							    same idea — it fades the floor INTO the background colour, so
							    past ~120 m the deck simply ceases to exist with no horizon
							    line, no clip edge and no tone break. */}
							<fog attach="fog" args={["#eef4f3", 18, 54]} />
							<StageLights />
							<Room />
							<SetProps objects={sceneObjects} selectedId={selectedSceneObjectId} />

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
								fovDeg={fovDeg}
								charA={charA}
								charB={charB}
								showB={showB}
								probeX={motionPos ? motionPos.x : charA.x}
								probeZ={motionPos ? motionPos.z : charA.z}
								camRef={shotCamRef}
								look={look}
								onMetrics={(p, visible) => {
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
								enabled={ikMode && !posing && !playMode}
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
								sceneObjects={sceneObjects}
								selectedSceneObjectId={selectedSceneObjectId}
								onMoveSceneObject={changeSceneObject}
								onObjectMoveStart={beginSceneTransaction}
								onObjectMoveEnd={endSceneTransaction}
								cameraRailPoints={railCurve ? railCurve.points : null}
								railDraw={railDraw}
								subjectTrack={motion ? subjectTrack : null}
								onRailStroke={(stroke) => {
									const simplified = simplifyStroke(stroke, 0.12);
									if (simplified.length < 2) return;
									changeCameraRail(simplified);
									setRailDraw(false);
									const curve = buildRail(simplified);
									setToast(isKo ? `카메라 레일 완성 — ${curve ? curve.length.toFixed(1) : "?"} m, 제어점 ${simplified.length}개` : `Camera rail drawn — ${curve ? curve.length.toFixed(1) : "?"} m, ${simplified.length} control points`);
								}}
								onCameraChange={commitManualCameraFraming}
							/>
							{/* Object gizmo: the shot pane's direct manipulation. Off while
							    the plan owns the big pane (the pucks are the handles there)
							    and while posing/IK owns the pointer. */}
							<ObjectGizmo
								object={cameraGizmoObject ?? selectedSceneObject}
								objects={sceneObjects}
								mode={cameraGizmoObject ? (gizmoMode === "scale" ? "move" : gizmoMode) : gizmoMode}
								snap={snapEnabled}
								enabled={!planIsMain && !posing && !ikMode && !playMode}
								paneRef={mainPaneRef}
								camRef={lookThroughShot ? shotCamRef : editorCamRef}
								shotAspect={lookThroughShot ? shotOutput.aspect : null}
								// The token MUST round-trip: dropping it sends every drag tick
								// through applyAtomic, whose settle cancels the open drag after
								// its first move (the gizmo hands its teardown as the cancel).
								onChange={(id, patch, token) => (id === "__shotcam__" ? changeShotCameraFromGizmo(id, patch) : changeSceneObject(id, patch, token))}
								onDragStart={(...args) => (cameraGizmoObject ? undefined : beginSceneTransaction(...args))}
								onDragEnd={(...args) => {
									if (!cameraGizmoObject) endSceneTransaction(...args);
								}}
								onSelect={(id) =>
									selectHierarchy(
										id === "__shotcam__" ? "camera" : id?.startsWith("char:") ? charKeyToHierarchyId(id) : id ? `object:${id}` : "props",
									)
								}
								onGroundClick={waypointMode && !planIsMain ? addFloorWaypoint : undefined}
							/>
							{centerTab === "scene" && railCurve && (
								<CameraRailScenePreview
									points={railCurve.points}
									cumLen={railCurve.cumLen}
									length={railCurve.length}
									crane={activeCamera.craneHeight}
								/>
							)}
							<CraneHandles
								rail={railCurve}
								crane={activeCamera.craneHeight}
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
								onDragStart={recordShotUndo}
							/>
							<EditorCamSeed camRef={editorCamRef} lookRef={editorLook} shotCamRef={shotCamRef} subject={charA} />
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
								insetCollapsed={workspaceLayout.insetCollapsed}
								planZoom={workspaceLayout.planZoom}
								shotAspect={shotOutput.aspect}
							/>
						</Canvas>

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
							hidden={playMode || ikMode || lookThroughShot}
							className="vp-pane vp-shot-preview"
							style={{ "--shot-aspect": shotOutput.aspect }}
						>
							<span className="vp-inset-tag vp-shot-preview-tag">
								<span className="vp-rec-dot" aria-hidden="true" />
								{ko("Shot", "샷")}
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
								<span>{ko("Generate motion in the Scene tab — PlayView plays the finished result.", "장면 탭에서 모션을 생성하세요. 재생 보기는 완성 결과를 보여줍니다.")}</span>
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
						<span className="inspector-heading-selection">{selectedSceneObject ? sceneObjectNameDisplayKo(selectedSceneObject.name) : HIERARCHY_INSPECTOR_TITLES[selectedHierarchyId] ?? ko("Selection", "선택 항목")}</span>
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
								className="btn ghost"
								title={ko("Key the current framing at the playhead frame", "현재 프레이밍을 재생 헤드 프레임에 키로 저장")}
								onClick={() => addCameraKeyframe(tlFrame)}
							>
								{ko("+ Key here", "+ 여기 키 찍기")}
							</button>
							<button
								type="button"
								className="btn ghost"
								disabled={!hasCameraKeys}
								title={ko("Play the move. With Follow on it plays the timeline too, so character motion rides along; right-drag interrupts", "카메라 움직임을 재생합니다. 따라가기가 켜져 있으면 타임라인도 함께 재생되어 캐릭터 모션이 따라옵니다. 오른쪽 드래그로 중단됩니다")}
								onClick={() => {
									if (followPreviewArmed) {
										if (tlPlaying) {
											setTlPlaying(false);
											return;
										}
										setTlFrame(0);
										setTlPlaying(true);
										return;
									}
									setMovePlaying((playing) => !playing);
								}}
							>
								{previewActive ? ko("Stop", "정지") : ko("Preview", "미리보기")}
							</button>
							<button type="button" className="btn ghost" disabled={cameraKeys.length < 1} onClick={clearMove}>
								{ko("Clear", "지우기")}
							</button>
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

				<Foldout hidden={!isCharacterSelection} title={ko("Rig", "리그")}>
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

				<Foldout hidden={!isCharacterSelection} title={ko("Pose", "포즈")}>
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
				</Foldout>

				{/* Generating is the point of the whole panel, and the operator spends
				    their time on a character — making them reselect the scene just to
				    press Generate was friction for no gain. The scene still owns the
				    prompt (it describes the whole render, not one performer), it is
				    simply also reachable from the subject being staged. */}
				<Foldout hidden={!(isSceneSelection || isCharacterSelection)} title={ko("Prompt", "프롬프트")}>
						<div className="segmented" data-active={mode}>
							<button className={mode === "image" ? "active" : ""} onClick={() => setMode("image")}>
							{ko("Image", "이미지")}
							</button>
							<button className={mode === "video" ? "active" : ""} onClick={() => setMode("video")}>
							{ko("Video", "영상")}
							</button>
						</div>
					<Field label={ko("Model", "모델")}>
							<Dropdown
							ariaLabel={ko("Model", "모델")}
								value={mode === "video" ? videoModel : imageModel}
								options={models.map((m) => ({ value: m.id, label: m.label }))}
								onChange={mode === "video" ? setVideoModel : setImageModel}
							/>
						</Field>

						<div className="sheet-checks">
							<label className="check">
								<input type="checkbox" checked={hasCharSheet} onChange={(e) => setHasCharSheet(e.target.checked)} />
								<span>{ko("I have a character sheet", "캐릭터 시트가 있어요")}</span>
							</label>
							<label className="check">
								<input type="checkbox" checked={hasEnvSheet} onChange={(e) => setHasEnvSheet(e.target.checked)} />
								<span>{ko("I have an environment sheet", "환경 시트가 있어요")}</span>
							</label>
						</div>

						{!hasCharSheet && characters.map((entry, index) => entry.hidden ? null : (
							<Field key={entry.id} label={characters.filter((c) => !c.hidden).length > 1 ? ko(`Subject ${index + 1}`, `인물 ${index + 1}`) : ko("Subject", "인물")}>
								<input
									type="text"
									value={entry.subject ?? ""}
									/* One entry per editing session, not per keystroke: the
									   snapshot is taken when the field takes focus. */
									onFocus={recordCharacterUndo}
									onChange={(e) => updateCharacterAt(index, { subject: e.target.value })}
								/>
							</Field>
						))}
						{!hasEnvSheet && (
						<Field label={ko("Environment", "환경")}>
								<input type="text" value={environment} onChange={(e) => setEnvironment(e.target.value)} />
							</Field>
						)}
						{mode === "video" && !moveSequence && (
						<Field label={ko("Camera move", "카메라 움직임")}>
								<Dropdown
								ariaLabel={ko("Camera move", "카메라 움직임")}
									value={cameraMove}
								options={CAMERA_MOVES.map((m) => ({ value: m, label: cameraMoveLabelKo(m) }))}
									onChange={setCameraMove}
								/>
							</Field>
						)}
						{mode === "video" && !moveSequence && cameraMove === CUSTOM_MOVE && (
						<Field label={ko("Custom camera move", "직접 쓴 카메라 움직임")}>
								<input
									type="text"
									value={customMove}
									onChange={(e) => setCustomMove(e.target.value)}
								placeholder={ko("describe the camera move", "카메라 움직임을 설명하세요")}
								/>
							</Field>
						)}
						{mode === "video" && moveSequence && (
						<Field label={ko("Camera move", "카메라 움직임")}>
								<div
									className="move-slate inline"
								title={ko("authored from the timeline keyframings — select Camera in the hierarchy to edit", "타임라인 키프레임으로 만든 움직임입니다. 편집하려면 계층에서 카메라를 선택하세요")}
								>
								{moveSequence.displaySlate} · {moveSequence.spanS}{ko("s", "초")}
								</div>
							</Field>
						)}
					<Field label={ko("Look / style", "룩 / 스타일")}>
							<input type="text" value={style} onChange={(e) => setStyle(e.target.value)} />
						</Field>

						<button className="btn primary full generate" onClick={generate}>
							{mode === "video" ? ko("Generate video", "영상 만들기") : ko("Generate image", "이미지 만들기")}
						</button>
					</Foldout>
				<Foldout hidden={!isCharacterSelection} defaultOpen={false} title={ko("Video capture", "영상 모캡")}>
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
				<Foldout hidden={!isCharacterSelection} defaultOpen={false} title={ko("ARDY motion", "ARDY 모션")}>
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
							{promptClips.length >= 2 && (
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
				</Foldout>
				<Foldout hidden={!isCharacterSelection} defaultOpen={false} openSignal={promptBlocksReveal} title={ko("Prompt Blocks", "프롬프트 블록")}>
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
							{selectedHierarchyId.startsWith("rig.")
							? (isKo ? `${HIERARCHY_INSPECTOR_TITLES[selectedHierarchyId]}이 활성 제어 그룹입니다.` : `${HIERARCHY_INSPECTOR_TITLES[selectedHierarchyId]} is the active control group.`)
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
								{ko("Type a value and press Enter, or drag an axis letter to scrub.", "값을 입력하고 Enter를 누르거나 축 글자를 드래그해 조절하세요.")}
								</p>
								<div className="presets gizmo-modes">
									<button type="button" className={gizmoMode === "move" ? "active" : ""} onClick={() => setGizmoMode("move")}>
									{ko("Move", "이동")} <kbd>W</kbd>
									</button>
									<button type="button" className={gizmoMode === "rotate" ? "active" : ""} onClick={() => setGizmoMode("rotate")}>
									{ko("Rotate", "회전")} <kbd>E</kbd>
									</button>
									<button type="button" className={gizmoMode === "scale" ? "active" : ""} onClick={() => setGizmoMode("scale")}>
									{ko("Scale", "크기")} <kbd>R</kbd>
									</button>
								</div>
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
								<Vector3Row
							label={ko("Position", "위치")}
									fields={[
										{ axis: "X", value: selectedSceneObject.x, step: 0.05, precision: 2, onChange: (x) => changeSceneObject(selectedSceneObject.id, { x }), onScrubStart: beginSceneTransaction, onScrubEnd: endSceneTransaction },
										{ axis: "Y", value: selectedSceneObject.y ?? 0, step: 0.05, precision: 2, onChange: (y) => changeSceneObject(selectedSceneObject.id, { y }), onScrubStart: beginSceneTransaction, onScrubEnd: endSceneTransaction },
										{ axis: "Z", value: selectedSceneObject.z, step: 0.05, precision: 2, onChange: (z) => changeSceneObject(selectedSceneObject.id, { z }), onScrubStart: beginSceneTransaction, onScrubEnd: endSceneTransaction },
									]}
								/>
								<Vector3Row
							label={ko("Rotation", "회전")}
									fields={[
										{ axis: "X", value: selectedSceneObject.rotX ?? 0, step: 1, precision: 1, onChange: (rotX) => changeSceneObject(selectedSceneObject.id, { rotX }), onScrubStart: beginSceneTransaction, onScrubEnd: endSceneTransaction },
										{ axis: "Y", value: selectedSceneObject.rot, step: 1, precision: 1, onChange: (rot) => changeSceneObject(selectedSceneObject.id, { rot }), onScrubStart: beginSceneTransaction, onScrubEnd: endSceneTransaction },
										{ axis: "Z", value: selectedSceneObject.rotZ ?? 0, step: 1, precision: 1, onChange: (rotZ) => changeSceneObject(selectedSceneObject.id, { rotZ }), onScrubStart: beginSceneTransaction, onScrubEnd: endSceneTransaction },
									]}
								/>
								<Vector3Row
							label={ko("Scale", "크기")}
									fields={[
										{ axis: "X", value: selectedSceneObject.scaleX ?? 1, step: 0.05, precision: 2, onChange: (scaleX) => changeSceneObject(selectedSceneObject.id, { scaleX }), onScrubStart: beginSceneTransaction, onScrubEnd: endSceneTransaction },
										{ axis: "Y", value: selectedSceneObject.scaleY ?? 1, step: 0.05, precision: 2, onChange: (scaleY) => changeSceneObject(selectedSceneObject.id, { scaleY }), onScrubStart: beginSceneTransaction, onScrubEnd: endSceneTransaction },
										{ axis: "Z", value: selectedSceneObject.scaleZ ?? 1, step: 0.05, precision: 2, onChange: (scaleZ) => changeSceneObject(selectedSceneObject.id, { scaleZ }), onScrubStart: beginSceneTransaction, onScrubEnd: endSceneTransaction },
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
						<div className="object-colors" role="group" aria-label={ko("Object colour", "오브젝트 색상")}>
									{OBJECT_COLORS.map((color) => (
										<button
											type="button"
											key={color}
											className={"object-color" + (selectedSceneObject.color === color ? " active" : "")}
											style={{ background: color }}
									aria-label={isKo ? `색상 ${color}` : `Colour ${color}`}
											aria-pressed={selectedSceneObject.color === color}
											onClick={() => changeSceneObject(selectedSceneObject.id, { color })}
										/>
									))}
								</div>
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
							onSelect={setStudioPick}
							onApply={(selectedPoseId) => {
								const pose = selectablePoses.find((p) => p.id === selectedPoseId);
								if (pose) {
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
						className={bottomTab === "console" ? "active" : ""}
						aria-pressed={bottomTab === "console"}
						onClick={() => setBottomTab("console")}
					>
						{ko("Console", "콘솔")}
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
				<div className="console-pane" hidden={bottomTab !== "console"}>
					{consoleLines.length === 0 ? (
						<p className="console-empty">{ko("No messages yet — ARDY status lines appear here.", "아직 메시지가 없어요 — ARDY 상태 줄이 여기에 표시됩니다.")}</p>
					) : (
						consoleLines.map((entry, index) => (
							<p className="console-line" key={index}>
								<time>{entry.time.toLocaleTimeString()}</time>
								<span>{entry.line}</span>
							</p>
						))
					)}
				</div>
				<div className="bottom-timeline" hidden={bottomTab !== "timeline"}>
				<Timeline
					frame={tlFrame}
					craneSelectedIndex={craneSelectedIndex}
					onCranePointAdd={addActiveCranePoint}
					onCranePointDelete={deleteSelectedCranePoint}
					onCranePointSelect={setCraneSelectedIndex}
					frameCount={tlFrameCount}
					fps={tlFps}
					playbackSpeed={DEFAULT_PLAYBACK_SPEED}
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
					shots={shots}
					activeShotIdx={activeShotIdx}
					railDraw={railDraw}
					cameraRailLength={railCurve?.length ?? null}
				shotCutDisabled={!!posing || ikMode || waypointMode}
				onIkToggle={toggleIkMode}
				onIkKeyframeAdd={ikAddKeyframe}
				onIkKeyframeRemove={ikDeleteKeyframe}
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
					onCameraBlockChange={(patch) => {
						if (patch.mode === "follow") syncActiveCameraFraming();
						const nextPatch = patch.mode === "rail" && activeCamera.railFollow?.mode === "off"
							? { ...patch, railFollow: defaultRailRange(activeShotDuration) }
							: patch;
						changeActiveCamera(nextPatch);
						if (patch.mode === "rail" && !cameraRail) {
							setRailDraw(true);
							setWorkspaceLayout((current) => ({ ...current, insetCollapsed: false }));
							setToast(ko("Draw this Camera Block's rail in the Top-View", "탑뷰에서 이 카메라 블록의 레일을 그리세요"));
						}
					}}
					onCameraPreview={previewCameraShot}
					onCameraRailDrawToggle={toggleCameraRailDraw}
					onCameraRailDelete={deleteCameraRail}
					onRailSelect={(shotId) => {
						selectTimelineShot(shotId);
						setSelectedHierarchyId("camera");
					}}
					onRailMove={(shotId, startFrame) => editRailSchedule(shotId, (base, duration) => moveRailRange(base, startFrame - base.startFrame, duration))}
					onRailRangeChange={(shotId, edge, frame) => editRailSchedule(shotId, (base, duration) => resizeRailRange(base, edge, frame, duration))}
					onRailRemove={(shotId) => {
						if (!shots.some((shot) => shot.id === shotId)) throw new Error(`Unknown shots ID: ${shotId}`);
						recordShotUndo();
						setShots((current) => updateStableItem(current, shotId, (shot) => ({ ...shot, camera: updateCameraBlock(shot.camera, { railFollow: { mode: "off" } }) }), "shots"));
					}}
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
					generation={generation.state}
					copied={copied}
					recordedVideoName={result.mode === "video" ? recordedVideoName : null}
					onClose={() => setResultOpen(false)}
					onCopy={() => copyPrompt(result.prompt)}
					onDownload={download}
					onCancelGeneration={generation.cancel}
				/>
			)}

			{projectBrowserOpen && (
				<ProjectBrowser
					currentName={projectName}
					onOpen={(entry) => openProjectByHandle(entry.handle)}
					onOpenFile={() => {
						setProjectBrowserOpen(false);
						openProject();
					}}
					onNew={() => {
						setProjectBrowserOpen(false);
						newProject();
					}}
					onClose={() => setProjectBrowserOpen(false)}
				/>
			)}
			<Toast message={toast} onDone={() => setToast("")} />
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

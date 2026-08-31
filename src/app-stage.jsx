// Module-level constants, pure helpers, and standalone R3F stage components
// extracted verbatim from App.jsx. Nothing here reads App() state directly —
// everything arrives through props or module imports, which is what made the
// extraction safe. Behavior-identical by construction; verified by the build
// and the browser QA suites.
import {
	memo,
	useEffect,
	useMemo,
	useRef,
	useState,
} from "react";
import { Canvas, useFrame, useThree } from "@react-three/fiber";
import { Line, Text, useFBX } from "@react-three/drei";
import * as THREE from "three";
import { SkeletonUtils } from "three/examples/jsm/Addons.js";
import { retimeMotion } from "./ardy/retime.js";
import {
	TRAIL_EFFECTOR_JOINTS,
	TRAIL_TRACKS,
	falloffWeight,
	jointTrailPoints,
	nearestFrameToRay,
	trailEditRange,
} from "./motion-trail.js";
import Timeline from "./ardy/timeline.jsx";
import { FlyControls, aimAt } from "./controls.jsx";
import { GIZMO_LAYER } from "./dualview.jsx";
import {
	CURVE_GRAB_RADIUS_PX,
	LINE_EDIT_TRACK_IDS,
	PINNED_CURVE_ENDS,
	curveToPoints2d,
	validateLineEdit,
} from "./line-edit.js";
import { craneHeightAt, railPoint } from "./camera-follow.js";
import { CUTOUT_KIND, DEFAULT_SCENE_OBJECTS, SCENE_ATTACH_BONES, updateSceneObject } from "./scene-objects.js";
import { imageFilesFrom } from "./scene-assets.js";
import {
	SCENES_QUARANTINE_KEY,
	createSceneDocument,
	DEFAULT_SUBJECT_ONE,
	DEFAULT_SUBJECT_TWO,
	loadSceneDocumentFromStorage,
} from "./scenes.js";
import ObjectGizmo from "./object-gizmo.jsx";
import { MAX_PATH_POINTS } from "./object-path.js";
import { track } from "./analytics.js";
import { ko, isKo } from "./locale.js";
import { POSE_BONES, applyPose, primeBindPose, normalizeBoneName } from "./poses.js";
import { FK_TRACKS, IK_TRACKS, MID_TRACKS } from "./ardy/ik.js";
import { RENDER_ACTIVITY_EVENT } from "./use-render-activity.js";
import { CUSTOM_MOVE, SHOT_ASPECT_RATIOS, SUBJECT_HEIGHT_M } from "./shot.js";
import { sampleAt } from "./sample-at.js";
import { shotAtFrame } from "./cuts.js";

// Stated the way a crew states a setup: how far back, which side, how high the
// lens rides, and what glass is on it. Order matters — Medium is the setup a
// director reaches for first, so it leads.
export const PRESETS = {
	medium: { label: ko("Medium", "미디엄"), distance: 2.6, azimuth: 22, elevation: 6, fov: 45, targetY: 1.35, two: false },
	wide: { label: ko("Wide", "와이드"), distance: 7, azimuth: 25, elevation: 4, fov: 38, targetY: 1.2, two: false },
	closeup: { label: ko("Close-Up", "클로즈업"), distance: 1.3, azimuth: 16, elevation: 2, fov: 45, targetY: 1.55, two: false },
	low: { label: ko("Low Angle", "로우 앵글"), distance: 3.5, azimuth: 20, elevation: -14, fov: 50, targetY: 1.1, two: false },
	high: { label: ko("High Angle", "하이 앵글"), distance: 4.5, azimuth: 20, elevation: 16, fov: 45, targetY: 1.1, two: false },
};

export const RIG_HIERARCHY_FOCUS = {
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

export const HIERARCHY_INSPECTOR_TITLES = {
	shot: ko("Shot settings", "샷 설정"),
	camera: ko("Camera", "카메라"),
	light: ko("Light", "조명"),
	characters: ko("Characters", "인물"),
	characterA: ko("Character 1", "인물 1"),
	rig: ko("Rig", "리그"),
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

/* ----------------------------------------- carried props (attachment) --- */

/** The rig rows that ARE an attach frame: `rig.<track id>`, the same camel
 * spellings SCENE_ATTACH_BONES uses. The group rows above them (rig.torso,
 * rig.leftArm …) name a limb, not a frame, so they are deliberately absent. */
export const ATTACH_BONE_ROWS = new Map(SCENE_ATTACH_BONES.map((bone) => [`rig.${bone}`, bone]));

/** Attach track id -> the Mixamo bone carrying that frame on the shipped rigs.
 * TRAIL_EFFECTOR_JOINTS names the cskel27 joint, and cskel27 and Mixamo agree
 * everywhere except the spine, which sits one bone up the Mixamo chain (the
 * same shift ardy/playback.js SKINNING_MAP makes). */
export const ATTACH_BONE_NAMES = Object.fromEntries(SCENE_ATTACH_BONES.map((bone) => {
	const joint = TRAIL_EFFECTOR_JOINTS[bone];
	return [bone, joint === "Spine1" ? "Spine" : joint === "Spine2" ? "Spine1" : joint];
}));

// One scratch set for the whole module: resolving a frame runs per attached
// prop per frame and must never allocate.
export const attachPos = new THREE.Vector3();
export const attachQuat = new THREE.Quaternion();
export const attachScale = new THREE.Vector3();
export const attachRootPos = new THREE.Vector3();
export const attachRootQuat = new THREE.Quaternion();
export const ATTACH_UNIT_SCALE = new THREE.Vector3(1, 1, 1);
export const attachWorldMatrix = new THREE.Matrix4();
export const attachLocalMatrix = new THREE.Matrix4();
export const attachToMatrix = new THREE.Matrix4();
export const attachInverseMatrix = new THREE.Matrix4();
export const placePos = new THREE.Vector3();
export const placeQuat = new THREE.Quaternion();
export const placeScale = new THREE.Vector3();
export const placeEuler = new THREE.Euler();

/** The bone a rig offers under `mixamoName`, by the project's matching rule
 * (normalised names equal, or one a suffix of the other; first depth-first
 * match wins — poses.js and ardy/playback.js agree). Cached per rig: this is
 * asked once per attached prop per rendered frame. */
export const attachBoneCache = new WeakMap();
export function attachBoneOf(rig, mixamoName) {
	let byName = attachBoneCache.get(rig);
	if (!byName) attachBoneCache.set(rig, (byName = new Map()));
	if (byName.has(mixamoName)) return byName.get(mixamoName);
	const target = normalizeBoneName(mixamoName);
	let found = null;
	rig.traverse((node) => {
		if (found || !node.isBone) return;
		const norm = normalizeBoneName(node.name);
		if (norm === target || norm.endsWith(target)) found = node;
	});
	byName.set(mixamoName, found);
	return found;
}

/**
 * The LIVE world frame an attachment rides, or null when the rig (or that bone)
 * is not there — a dangling attachment then renders where its numbers say,
 * which is exactly what a detached prop does.
 *
 * The frame is deliberately UNSCALED. The shipped rigs are Mixamo centimetres
 * scaled by 0.01 on the model, so a raw bone matrix would push a hundredfold
 * into every carried prop's local numbers and leave the Inspector unreadable.
 * A carried prop takes the bone's place and facing; its size stays its own.
 *
 * `bone === null` is the character's animated ROOT: the hips' travel (during
 * playback the whole root trajectory lives in the bones — see
 * ardy/playback.js) carried at the character's own yaw, so a prop dropped on
 * the character walks with the body instead of rolling with the hips.
 */
export function attachFrameMatrix(rig, bone, out = new THREE.Matrix4()) {
	if (!rig) return null;
	const name = ATTACH_BONE_NAMES[bone ?? "hips"];
	if (!name) return null;
	const node = attachBoneOf(rig, name);
	if (!node) return null;
	// Ancestors included: the bones are written imperatively by playback and by
	// the export, either of which can land before the renderer's own pass.
	node.updateWorldMatrix(true, false);
	node.matrixWorld.decompose(attachPos, attachQuat, attachScale);
	if (bone != null) return out.compose(attachPos, attachQuat, ATTACH_UNIT_SCALE);
	// The Character group carries the scene placement and the clip-to-scene yaw;
	// the rig model hangs off it, so its parent IS that group.
	const group = rig.parent ?? rig;
	group.updateWorldMatrix(true, false);
	group.matrixWorld.decompose(attachRootPos, attachRootQuat, attachScale);
	return out.compose(attachPos, attachRootQuat, ATTACH_UNIT_SCALE);
}

/** A prop's placement as a matrix — the same compose props.jsx renders from
 * (position, XYZ euler in degrees, per-axis scale). */
export function sceneObjectMatrix(object, out = new THREE.Matrix4()) {
	return out.compose(
		placePos.set(object.x ?? 0, object.y ?? 0, object.z ?? 0),
		placeQuat.setFromEuler(placeEuler.set(
			(object.rotX ?? 0) * THREE.MathUtils.DEG2RAD,
			(object.rot ?? 0) * THREE.MathUtils.DEG2RAD,
			(object.rotZ ?? 0) * THREE.MathUtils.DEG2RAD,
		)),
		placeScale.set(object.scaleX ?? 1, object.scaleY ?? 1, object.scaleZ ?? 1),
	);
}

/** …and back out into the nine authored channels, or null if the matrix could
 * not be read as a placement at all (a singular frame inverts to zeros, and a
 * zero matrix decomposes to NaN). Rounded, because a matrix round trip
 * otherwise turns a typed 1.5 into 1.4999999999999998 in the Inspector the
 * moment a prop is picked up and put down again. */
export function sceneObjectPlacement(matrix) {
	matrix.decompose(placePos, placeQuat, placeScale);
	placeEuler.setFromQuaternion(placeQuat);
	const round = (value) => Math.round(value * 1e6) / 1e6;
	const placement = {
		x: round(placePos.x), y: round(placePos.y), z: round(placePos.z),
		rotX: round(placeEuler.x * THREE.MathUtils.RAD2DEG),
		rot: round(placeEuler.y * THREE.MathUtils.RAD2DEG),
		rotZ: round(placeEuler.z * THREE.MathUtils.RAD2DEG),
		scaleX: round(placeScale.x), scaleY: round(placeScale.y), scaleZ: round(placeScale.z),
	};
	return Object.values(placement).every((value) => Number.isFinite(value)) ? placement : null;
}

/**
 * The nine channels rewritten so a prop does not MOVE when it changes frames.
 *
 * `world` is where the prop actually IS — read off the live group in the scene
 * graph, NOT recomputed from its numbers. That distinction is the whole point:
 * an attach->attach drop would otherwise have to reconstruct the world
 * transform through the frame the prop is leaving, and any disagreement
 * between that reconstruction and what the renderer last drew (a rig posed a
 * beat later than the last drawn frame, a frame that no longer resolves) lands
 * on screen as a jump. Reading the group makes every drop the same one-frame
 * conversion the world->attach and attach->world cases already were.
 *
 * Returns null when the frame it needs is missing — converting against a rig
 * that is not on stage would be precisely the jump this exists to prevent —
 * and the caller then refuses the whole drop rather than re-labelling numbers
 * it could not convert.
 */
export function attachPlacementPatch(world, attach, frameOf) {
	if (!world) return null;
	if (!attach) return sceneObjectPlacement(attachLocalMatrix.copy(world));
	const frame = frameOf(attach.characterId, attach.bone ?? null, attachToMatrix);
	if (!frame) return null;
	return sceneObjectPlacement(attachLocalMatrix.copy(world).premultiply(attachInverseMatrix.copy(frame).invert()));
}

/**
 * Write a computed placement straight onto the record, around
 * updateSceneObject. Deliberate, and the only call site allowed to: those
 * limits are WORLD limits (y floors at the deck, x/z stay inside the room),
 * and while a prop is attached its numbers are a LOCAL transform in a bone
 * frame — a hand rides 1.3 m above the deck, so a carried prop's local y is
 * routinely negative and clamping it to the floor IS the visual jump the
 * conversion exists to prevent. Every value here comes out of a decomposed
 * matrix, so the record shape is sound by construction.
 */
export function placeSceneObject(objects, id, placement) {
	if (!placement) return objects;
	let changed = false;
	const next = objects.map((object) => {
		if (object.id !== id) return object;
		if (Object.entries(placement).every(([key, value]) => object[key] === value)) return object;
		changed = true;
		return { ...object, ...placement };
	});
	return changed ? next : objects;
}

export const CAMERA_MOVE_LABELS_KO = new Map([
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

export const POSE_LABELS_KO = new Map([
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

export const SHOT_SIZE_LABELS_KO = new Map([
	["extreme close-up", ko("extreme close-up", "익스트림 클로즈업")],
	["close-up", ko("close-up", "클로즈업")],
	["medium close-up", ko("medium close-up", "미디엄 클로즈업")],
	["medium shot", ko("medium shot", "미디엄 샷")],
	["medium-wide shot", ko("medium-wide shot", "미디엄 와이드 샷")],
	["wide shot", ko("wide shot", "와이드 샷")],
	["extreme wide shot", ko("extreme wide shot", "익스트림 와이드 샷")],
]);

export const SHOT_LEVEL_LABELS_KO = new Map([
	["overhead", ko("overhead", "오버헤드")],
	["high angle", ko("high angle", "하이 앵글")],
	["eye level", ko("eye level", "아이 레벨")],
	["chest level", ko("chest level", "가슴 높이")],
	["hip level", ko("hip level", "엉덩이 높이")],
	["knee level", ko("knee level", "무릎 높이")],
	["ground level", ko("ground level", "바닥 높이")],
]);

export const SCENE_RENDERER_LABELS_KO = new Map([
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

export const SCENE_OBJECT_NAME_LABELS_KO = new Map([
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

export function poseLabelKo(pose) {
	return pose?.custom ? pose.label : POSE_LABELS_KO.get(pose?.label) ?? pose?.label ?? "";
}

export function cameraMoveLabelKo(move) {
	return CAMERA_MOVE_LABELS_KO.get(move) ?? move;
}

export function sceneRendererLabelKo(renderer) {
	return SCENE_RENDERER_LABELS_KO.get(renderer) ?? renderer;
}

export function sceneObjectNameDisplayKo(name) {
	const match = /^(.+?)(?: ([2-9]\d*))?$/.exec(name ?? "");
	if (!match) return name;
	const [, base, suffix] = match;
	const label = SCENE_OBJECT_NAME_LABELS_KO.get(base);
	return label ? `${label}${suffix ? ` ${suffix}` : ""}` : name;
}

export function viewShortKo(viewShort) {
	if (viewShort === "front") return ko("front", "정면");
	if (viewShort === "back") return ko("back", "후면");
	if (viewShort?.includes("profile")) return viewShort.startsWith("left") ? ko("left profile", "왼쪽 측면") : ko("right profile", "오른쪽 측면");
	if (viewShort?.startsWith("front ¾")) return / L$/.test(viewShort) ? ko("front ¾ L", "정면 ¾ 왼쪽") : ko("front ¾ R", "정면 ¾ 오른쪽");
	if (viewShort?.startsWith("rear ¾")) return / L$/.test(viewShort) ? ko("rear ¾ L", "후면 ¾ 왼쪽") : ko("rear ¾ R", "후면 ¾ 오른쪽");
	return viewShort;
}

export function slateLineKo(shot) {
	return [
		SHOT_SIZE_LABELS_KO.get(shot.sizeLabel) ?? shot.sizeLabel,
		viewShortKo(shot.viewShort),
		SHOT_LEVEL_LABELS_KO.get(shot.levelLabel) ?? shot.levelLabel,
		`${shot.focalMm}mm`,
	].filter(Boolean).join(" · ");
}

export function moveSequenceSlateKo(segments) {
	if (!segments.length) return "";
	if (segments.length === 1) {
		const seg = segments[0];
		return `${slateLineKo(seg.from)} → ${slateLineKo(seg.to)} · ${cameraMoveLabelKo(seg.label)}`;
	}
	const parts = [slateLineKo(segments[0].from)];
	for (const seg of segments) parts.push(`${cameraMoveLabelKo(seg.label)} → ${slateLineKo(seg.to)}`);
	return parts.join(" · ");
}

/** The hierarchy node id an IK focus lights up. Focus maps stay keyed by the
 * BONE TOKEN; the row id namespaces the result so each cast member's tree
 * highlights its own bone (#76). */
export function hierarchyIdForIkFocus(focus, rowId = "characterA") {
	if (!focus) return null;
	const exact = Object.entries(RIG_HIERARCHY_FOCUS)
		.find(([id, mappedFocus]) =>
			!["rig.torso", "rig.leftArm", "rig.rightArm", "rig.leftLeg", "rig.rightLeg"].includes(id) &&
			mappedFocus === focus
		);
	return `${rowId}.${exact?.[0] ?? "rig"}`;
}

export const CAPTURE_W = 1920;
export const CAPTURE_H = 1080;
export const MCP_CAPTURE_W = 640;
export const MCP_CAPTURE_H = 360;
export const MCP_CAPTURE_SAMPLE_STEP = 32;
export const SHOT_ASPECT_PRESETS = Object.freeze({
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
export const characterModelUrl = (model) => `/models/${model}.fbx`;

/** Shipped rig names as the operator says them, not as the files spell them. */
export const CHARACTER_MODEL_LABELS = { "y-bot-tpose": "Y Bot", "x-bot-tpose": "X Bot" };

/** Sequential ids for spawned characters, collision-free against the cast. */
export function nextCharacterId(list) {
	const ids = new Set(list.map((entry) => entry.id));
	let n = list.length + 1;
	let id = `char-${n}`;
	while (ids.has(id)) {
		n += 1;
		id = `char-${n}`;
	}
	return id;
}
export const DEMO_MOTION_URL = "/demo/walk-then-stop.npz";
export const DEMO_MOTION_PROMPT = "A person walks forward.";
// How long a deletion keeps offering its one-press Undo. Both toasts use the
// same window so the two deletion paths feel like one rule.
export const OBJECT_DELETE_UNDO_MS = 7000;
export const ASSET_DELETE_UNDO_MS = 7000;
export const CLAY = "#f2eee6";
export const CLAY_B = "#ddd6ca";
// X Bot's shell is smooth (no raised exoskeleton like Y Bot's), so it gets a
// brighter, whiter clay to keep it readable against the set.
export const CLAY_X = "#faf8f2";
// Model/role default for a cast member; a user-picked entry.tint always wins
// over this at render time.
export const defaultCharacterTint = (entry, index) => (entry.model === "x-bot-tpose" ? CLAY_X : index === 0 ? CLAY : CLAY_B);

export const DEFAULT_SUBJECT = DEFAULT_SUBJECT_ONE;
export const DEFAULT_SUBJECT2 = DEFAULT_SUBJECT_TWO;
export const DEFAULT_ENVIRONMENT = "a sunlit modern living room";
export const DEFAULT_CAMERA_POSITION = { x: 0.97, y: 1.62, z: 2.39 };
export const REST_BONES = Object.fromEntries(POSE_BONES.map((b) => [b.id, [0, 0, 0]]));
// Two clocks, one boundary. The app timeline runs the production 24 fps —
// the rate the reference footage and the recorded export are counted in.
// ARDY Core generates on its trained 20 fps clock and that cannot move, so
// takes are RETIMED inbound (bridge → app, retimeMotion) and frame numbers
// are CONVERTED outbound (app → bridge, toArdyFrame). Nothing between the
// boundaries may mix the clocks.
export const TIMELINE_FPS = 24;
// The motion bridge uses the Studio's fixed 24 fps production clock.
export const ARDY_FPS = 24;
export const toArdyFrame = (frame) => Math.round((frame * ARDY_FPS) / TIMELINE_FPS);

// Outbound converters: timeline-frame entries → strictly-ascending bridge
// frames. Rounding can land two timeline frames on one bridge frame; the
// first wins — the bridge refuses non-ascending lists outright.
/** Where a placed pose lands, in TIMELINE frames, for a clip of `clipFrames`. */
export const POSE_PLACEMENTS = ["start", "middle", "end", "playhead"];
export function posePlacementFrame(placement, clipFrames, playheadFrame) {
	const last = Math.max(0, clipFrames - 1);
	if (placement === "end") return last;
	if (placement === "middle") return Math.round(last / 2);
	if (placement === "playhead") return Math.max(0, Math.min(last, playheadFrame));
	return 0;
}

export function toArdyFrameEntries(entries) {
	const out = [];
	for (const entry of entries) {
		const frame = toArdyFrame(entry.frame);
		if (out.length && frame <= out[out.length - 1].frame) continue;
		out.push({ ...entry, frame });
	}
	return out;
}

export function toArdySegments(segments) {
	const out = [];
	for (const segment of segments) {
		const startFrame = toArdyFrame(segment.startFrame);
		const endFrame = toArdyFrame(segment.endFrame);
		if (endFrame <= startFrame) continue; // a zero-length rounding remnant covers nothing
		out.push({ ...segment, startFrame, endFrame });
	}
	return out;
}

export const DEFAULT_DURATION_S = 15; // pre-motion timeline duration; shown as duration × TIMELINE_FPS frames
export const DEFAULT_PLAYBACK_SPEED = 1;
export const BRIDGE_RECHECK_MS = 3000;
export const ARDY_PROMPT_HORIZON_FRAMES = 2 * TIMELINE_FPS; // core model horizon: 2 seconds, counted on the timeline clock
export const MAX_WAYPOINTS = 32; // ARDY bridge contract: a root path holds 2..32 distinct waypoint frames
export const ARDY_PROMPT_MAX = 500; // bridge contract: prompt must be non-empty, capped at 500 chars
export const ARDY_DURATION_MIN = 1; // the UI works in whole seconds; the bridge floor is 0.15 s
export const ARDY_DURATION_MAX = 1200; // bridge contract: duration capped at 1200 s
export const ARDY_SEED_MAX = 2 ** 31 - 1; // bridge contract: optional seed, integer in 0..2**31-1
// Scheduled inpainting (contract C3): how hard a regeneration holds onto the
// take that is already loaded. 0 turns preserving OFF entirely; 0.5 is the
// paper's recommended setting. The app ships this RAW number and nothing else:
// the strength -> denoising-schedule mapping (sigma_s = round(1000 * strength),
// sigma_e = min(50, sigma_s), diffusion time 0..1000) lives on the box side, and
// duplicating it here is exactly how the two would silently drift apart.
export const ARDY_PRESERVE_DEFAULT = 0.5;
export const DEFAULT_PROMPT_CLIPS = [];

/** The prompt-block schedule: every authored block in frame order, with the gaps
 * between them filled by the base prompt so the bridge always receives one
 * contiguous 0..clipFrames sequence. Blocks shorter than 3 frames are dropped —
 * they cannot carry a generation.
 * Pure and shared on purpose: the request assembly decides which blocks count as
 * "edited", and the preserve panel has to name the SAME blocks. Re-deriving them
 * approximately beside the slider is how the UI starts promising a locality the
 * wire does not carry. */
export function buildPromptSchedule(sourcePromptClips, clipFrames, prompt) {
	const segments = [];
	let cursor = 0;
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
	return segments;
}

/** The DISTINCT ik track ids keyed inside the half-open timeline span
 * [startFrame, endFrame). `ikState.keys` is Map(frame -> Map(trackId -> pose)),
 * so a frame with several dragged effectors contributes all of them. */
export function ikTracksInRange(ikState, ikFrames, startFrame, endFrame) {
	const tracks = new Set();
	for (const frame of ikFrames) {
		if (frame < startFrame || frame >= endFrame) continue;
		for (const trackId of ikState?.keys?.get(frame)?.keys() ?? []) tracks.add(trackId);
	}
	return [...tracks];
}

/* Which limb a keyed IK track frees once the preserve mask is grouped
   (contract C3v2). The single source of truth for track -> mask group is
   TRACK_GROUPS in tools/kimodo/preserve-mask.mjs; nothing under tools/ may be
   imported into src/, so the rule is transcribed here — as USER-FACING LABELS
   only, never as a second copy of the mapping the wire depends on:
     leftHand,  leftElbow  -> leftArm     rightHand, rightElbow -> rightArm
     leftFoot,  leftKnee   -> leftLeg     rightFoot, rightKnee  -> rightLeg
     head,      neck       -> head        spine, chest, leftShoulder,
     hips                  -> torso AND root      rightShoulder -> torso
   The track ids are the same namespace on both sides (src/ardy/ik.js owns
   them), so the app ships whatever ids it has and the mask builder maps them.
   Torso and pelvis tracks are worded as the whole body: the pelvis carries the
   global transform as well as a bone, and naming a limb beside it would promise
   a locality the mask does not have. */
export const PRESERVE_TRACK_LIMBS = {
	leftHand: "leftArm",
	leftElbow: "leftArm",
	rightHand: "rightArm",
	rightElbow: "rightArm",
	leftFoot: "leftLeg",
	leftKnee: "leftLeg",
	rightFoot: "rightLeg",
	rightKnee: "rightLeg",
	head: "head",
	neck: "head",
	spine: "body",
	chest: "body",
	leftShoulder: "body",
	rightShoulder: "body",
	hips: "body",
};
// A fixed reading order, so the same edit always reads back the same way.
export const PRESERVE_LIMB_ORDER = ["head", "leftArm", "rightArm", "leftLeg", "rightLeg"];
export const preserveLimbLabel = (limb) => ({
	head: ko("head", "머리"),
	leftArm: ko("left arm", "왼팔"),
	rightArm: ko("right arm", "오른팔"),
	leftLeg: ko("left leg", "왼발"),
	rightLeg: ko("right leg", "오른발"),
}[limb]);

/** One muted line naming what a grouped preserve run will regenerate, or "" when
 * no track can be attributed — then the request carries no `tracks` either and
 * the panel's existing whole-take wording is already the truth. */
export function preserveTracksSummary(tracks) {
	const limbs = new Set();
	for (const trackId of tracks) {
		const limb = PRESERVE_TRACK_LIMBS[trackId];
		if (limb) limbs.add(limb);
	}
	if (limbs.size === 0) return "";
	if (limbs.has("body")) return ko("regenerates the whole body", "몸 전체를 다시 생성");
	const names = PRESERVE_LIMB_ORDER.filter((limb) => limbs.has(limb)).map(preserveLimbLabel);
	return isKo ? `${names.join("·")}만 다시 생성` : `regenerates ${names.join(" · ")} only`;
}

/* --------------------------- line editing (C6) ---------------------------
 * "Grab the joint's motion path and pull it; the joint follows the pulled path
 * exactly" (ProjFlow). The arithmetic lives in ./line-edit.js; what stays here
 * is the panel's own vocabulary and the one thing App owns that the pure module
 * cannot — the mapping from a track id to a HUMAN LABEL, which is read straight
 * out of ik.js's three tables so the picker can never drift from the pose
 * studio's own naming. An id in LINE_EDIT_TRACK_IDS with no entry in those
 * tables is a bug, and falling back to the raw id makes it visible instead of
 * silent. */
export const LINE_EDIT_TRACK_OPTIONS = LINE_EDIT_TRACK_IDS.map((id) => ({
	value: id,
	label: [...IK_TRACKS, ...MID_TRACKS, ...FK_TRACKS].find((track) => track.id === id)?.label ?? id,
}));
/** The same human label, by id — what a version-strip chip says a refinement
 * touched ("Refine · Left Hand"). */
export const lineTrackLabel = (id) => LINE_EDIT_TRACK_OPTIONS.find((option) => option.value === id)?.label ?? id;
/** The default edited track: a wrist is the joint the paper's own demo draws
 * with, and the one whose screen trajectory a user can actually see. */
export const LINE_EDIT_DEFAULT_TRACK = "leftHand";
/** Draw a grab handle every Nth frame. Fewer would leave the curve looking
 * un-grabbable in the gaps; more turns a 200-frame range into a solid bead of
 * dots. The hit test tolerates CURVE_GRAB_RADIUS_PX regardless, so the handles
 * are an affordance rather than the actual geometry. */
export const LINE_CURVE_MARKER_STRIDE = 4;
/** The shortest curve with anything draggable in it: both ends are hard-pinned
 * to the original trajectory, so a range needs more than 2 x PINNED_CURVE_ENDS
 * frames before the middle can move at all. */
export const MIN_CURVE_POINTS = PINNED_CURVE_ENDS * 2 + 1;
/** How long a released drag has to sit still before it costs a preview. Long
 * enough that pull-pull-pull is one request instead of three, short enough that
 * the loop still feels like it answers the gesture — a preview round trip is
 * ~1 s on the warm service, so 150 ms is noise against it. */
export const LINE_PREVIEW_DEBOUNCE_MS = 150;
/** How often the line-edit capability is re-probed while the bridge is up and
 * the answer is still no.
 *
 * The bridge answers `capabilities.lineEdit` from a LAZY ssh probe of the
 * ProjFlow box behind a 5 s cache, so the very first /ardy/health of a session
 * can land on a cold cache and come back false — a box that is perfectly fine
 * two seconds later. Asking once per bridge-up transition therefore made the
 * whole mode dead until a reload (first boot broken, second boot fine, which is
 * exactly how it was reported). A capability is an ADVERTISEMENT, so it is
 * allowed to arrive late; what is not allowed is to assume it. 4 s sits just
 * under the bridge's own 5 s TTL, so a retry can actually see a new answer
 * rather than re-reading the same cached false. */
export const LINE_CAPABILITY_RETRY_MS = 4000;
/** Why a validateLineEdit code refused, said once, in the user's language.
 * Keyed by the pure module's stable codes so the copy and the check can never
 * disagree about which field was wrong. */
export const LINE_EDIT_REFUSALS = {
	sourceMotion: ["The current take has no bridge source — generate it once before editing a path", "현재 테이크에 브리지 원본이 없어요 — 궤적을 편집하기 전에 한 번 생성하세요"],
	track: ["Pick a joint to edit first", "먼저 편집할 관절을 고르세요"],
	frameRange: ["The frame range must sit inside the clip and span at least 2 frames", "프레임 구간은 클립 안에 있어야 하고 최소 2프레임이어야 해요"],
	points: ["Pull a longer stretch of the path — a single point is not a path", "궤적을 좀 더 길게 잡아당겨 주세요 — 점 하나는 경로가 아니에요"],
	camera: ["The camera could not be captured — nudge the view and try again", "카메라를 캡처하지 못했어요 — 뷰를 조금 움직인 뒤 다시 시도하세요"],
	prompt: ["The motion prompt is not usable for a line edit", "모션 프롬프트를 라인 편집에 쓸 수 없어요"],
	pins: ["The pinned moments could not be sent — try clearing them and pinning again", "찍은 순간을 보낼 수 없어요 — 지우고 다시 찍어 보세요"],
	shape: ["The line edit could not be assembled", "라인 편집을 구성하지 못했어요"],
};
/** Why curveToPoints2d refused. Same shape, different stage: these are about
 * the CURVE, before there is a payload to validate. */
export const LINE_CURVE_REFUSALS = {
	empty: ["This joint is not visible over the chosen frames — frame it in view first", "선택한 구간에서 이 관절이 보이지 않아요 — 먼저 화면 안에 들어오도록 잡아 주세요"],
	offscreen: ["The pulled path leaves the frame — keep it inside the dashed border", "잡아당긴 궤적이 화면을 벗어났어요 — 점선 테두리 안에 두세요"],
};

// Named ingest failures, in both locales. A reason the user cannot act on is
// not a message: each line says what was wrong with THIS source.
export const MULTIMODEL_REASONS = {
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
	"extract-host-missing": ["The bridge has no GPU box configured (CCLAY_EXTRACT_HOST)", "브리지에 GPU 박스가 설정돼 있지 않아요(CCLAY_EXTRACT_HOST)"],
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
export const MULTIMODEL_SAMPLE_FPS = TIMELINE_FPS;

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
export function addFacingMarks(clone, markTint) {
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

export const Character = memo(function Character({ url, position, rot, tint, pose, scale = 1, onRig, pickId }) {
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
export function ShotRig({ preset, nonce, fovDeg, charA, charB, showB, probeX, probeZ, camRef, look, onMetrics }) {
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
export function MoveRig({ playing, following, followFrame, fps, keys, shots, scene, camRef, look, isInterrupted, onDone }) {
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
export function FollowCamRig({ enabled, frame, scene, shot, camRef, look, isInterrupted }) {
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
export function ShotLookApplier({ camRef, look }) {
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
/**
 * A short editor-camera glide: 260 ms ease toward a target orientation (and
 * optionally a position), instead of the teleport that made "look at the
 * light" and F-framing feel like a cut. Any user press cancels it — the
 * operator always outranks the tour guide.
 */
export function CameraGlide({ glide, camRef, lookRef, onDone }) {
	const { gl } = useThree();
	const invalidate = useThree((state) => state.invalidate);
	const animRef = useRef(null);
	useEffect(() => {
		if (!glide) {
			animRef.current = null;
			return undefined;
		}
		const cam = camRef.current;
		if (!cam) return undefined;
		const fromPos = cam.position.clone();
		const toPos = glide.position ? new THREE.Vector3(glide.position.x, glide.position.y, glide.position.z) : fromPos.clone();
		const angles = aimAt(toPos, glide.target);
		const from = { yaw: lookRef.current.yaw, pitch: lookRef.current.pitch };
		let dYaw = angles.yaw - from.yaw;
		while (dYaw > Math.PI) dYaw -= 2 * Math.PI;
		while (dYaw < -Math.PI) dYaw += 2 * Math.PI;
		// elapsed accumulates render-loop deltas: the glide needs no wall clock
		animRef.current = { fromPos, toPos, from, dYaw, dPitch: angles.pitch - from.pitch, elapsed: 0 };
		const cancel = () => {
			animRef.current = null;
			onDone?.();
		};
		gl.domElement.addEventListener("pointerdown", cancel, true);
		invalidate();
		return () => gl.domElement.removeEventListener("pointerdown", cancel, true);
		// camRef/lookRef are stable refs; onDone identity is per-glide noise
		// eslint-disable-next-line react-hooks/exhaustive-deps
	}, [glide, gl, invalidate]);
	useFrame((_, delta) => {
		const anim = animRef.current;
		const cam = camRef.current;
		if (!anim || !cam) return;
		anim.elapsed += Math.min(delta, 0.1) * 1000;
		const t = Math.min(1, anim.elapsed / 260);
		const eased = 1 - (1 - t) ** 3;
		cam.position.lerpVectors(anim.fromPos, anim.toPos, eased);
		const yaw = anim.from.yaw + anim.dYaw * eased;
		const pitch = anim.from.pitch + anim.dPitch * eased;
		lookRef.current = { yaw, pitch };
		cam.rotation.order = "YXZ";
		cam.rotation.set(pitch, yaw, 0);
		if (t >= 1) {
			animRef.current = null;
			onDone?.();
		} else {
			invalidate();
		}
	});
	return null;
}

export function EditorCamSeed({ camRef, lookRef, shotCamRef, subject }) {
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
 * The key light drawn as a grabbable sun in the editor view: a warm core with
 * rays, on GIZMO_LAYER so preview, capture and PlayView never see it. A line
 * drops to the floor so its height reads against the stage, like the crane's.
 * The sun's own body is the drag surface — a grab moves it freely on the
 * camera-facing plane (the cursor and the sun stay glued), and the gizmo's
 * arrows (via ObjectGizmo) stay available for single-axis precision. Its
 * colour follows the dial, and while selected a ray points at the stage so
 * the light's direction reads at a glance.
 */
export function KeyLightPuck({ keyLight, selected, visible, paneRef, camRef, onSelect, onChange, onDragEnd }) {
	const { gl } = useThree();
	const groupRef = useRef(null);
	const dragRef = useRef(null);
	const stateRef = useRef(null);
	const [dragKind, setDragKind] = useState(null);
	const invalidate = useThree((state) => state.invalidate);
	stateRef.current = { keyLight, visible, onSelect, onChange, onDragEnd };
	useEffect(() => {
		groupRef.current?.traverse((node) => node.layers?.set(GIZMO_LAYER));
		invalidate();
	}, [visible, selected, keyLight, dragKind, invalidate]);
	useEffect(() => {
		if (!visible) return undefined;
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
		const onDown = (event) => {
			const s = stateRef.current;
			if (event.button !== 0 || event.altKey) return;
			if (!groupRef.current || !rayFrom(event)) return;
			const hit = raycaster.intersectObjects(groupRef.current.children, true)
				.find((entry) => {
					for (let node = entry.object; node; node = node.parent) if (node.userData?.keyLightPick) return true;
					return false;
				});
			if (!hit) return;
			event.stopImmediatePropagation();
			event.preventDefault();
			s.onSelect?.();
			const start = { ...s.keyLight };
			const origin = new THREE.Vector3(start.x, start.y, start.z);
			// free move on the camera-facing plane through the sun: the cursor
			// and the sun stay glued from any viewing angle — no degenerate
			// floor-plane geometry when the sun is viewed from below
			const facing = new THREE.Vector3();
			camRef.current.getWorldDirection(facing);
			const plane = new THREE.Plane().setFromNormalAndCoplanarPoint(facing, origin);
			const hitStart = new THREE.Vector3();
			if (!raycaster.ray.intersectPlane(plane, hitStart)) return;
			dragRef.current = { start, plane, hitStart, moved: false };
			setDragKind("move");
			invalidate();
		};
		const onMove = (event) => {
			const drag = dragRef.current;
			if (!drag || !rayFrom(event)) return;
			const world = new THREE.Vector3();
			if (!raycaster.ray.intersectPlane(drag.plane, world)) return;
			drag.moved = true;
			stateRef.current.onChange?.({
				x: drag.start.x + (world.x - drag.hitStart.x),
				y: drag.start.y + (world.y - drag.hitStart.y),
				z: drag.start.z + (world.z - drag.hitStart.z),
			}, { dragging: true });
			invalidate();
		};
		const onUp = () => {
			const drag = dragRef.current;
			if (!drag) return;
			dragRef.current = null;
			setDragKind(null);
			if (drag.moved) stateRef.current.onDragEnd?.();
			invalidate();
		};
		const el = gl.domElement;
		el.addEventListener("pointerdown", onDown);
		window.addEventListener("pointermove", onMove, true);
		window.addEventListener("pointerup", onUp, true);
		return () => {
			el.removeEventListener("pointerdown", onDown);
			window.removeEventListener("pointermove", onMove, true);
			window.removeEventListener("pointerup", onUp, true);
		};
		// paneRef/camRef are stable refs; handlers read live state through stateRef
		// eslint-disable-next-line react-hooks/exhaustive-deps
	}, [visible, gl, invalidate]);
	const drop = useMemo(() => new Float32Array([0, 0, 0, 0, -keyLight.y, 0]), [keyLight.y]);
	// the sun dims with its own dial, so the stage's mood reads off the puck
	const glow = Math.max(0.18, Math.min(1, keyLight.intensity / 1.12));
	const sunColor = useMemo(
		() => new THREE.Color("#5c5040").lerp(new THREE.Color(selected ? "#ffcf5e" : "#f2b544"), glow).getStyle(),
		[selected, glow],
	);
	if (!visible) return null;
	return (
		<group ref={groupRef} position={[keyLight.x, keyLight.y, keyLight.z]}>
			<mesh userData={{ keyLightPick: true }}>
				<sphereGeometry args={[0.16, 20, 16]} />
				<meshBasicMaterial color={sunColor} toneMapped={false} />
			</mesh>
			{/* rays: eight short spokes so it reads as a sun, not a ball */}
			{Array.from({ length: 8 }, (_, i) => {
				const angle = (i / 8) * Math.PI * 2;
				return (
					<mesh key={i} userData={{ keyLightPick: true }} position={[Math.cos(angle) * 0.27, Math.sin(angle) * 0.27, 0]} rotation={[0, 0, angle + Math.PI / 2]}>
						<cylinderGeometry args={[0.014, 0.014, 0.1, 6]} />
						<meshBasicMaterial color={sunColor} toneMapped={false} />
					</mesh>
				);
			})}
			{/* the real grab surface: generous, invisible, around the whole sun */}
			<mesh userData={{ keyLightPick: true }}>
				<sphereGeometry args={[0.42, 12, 10]} />
				<meshBasicMaterial visible={false} />
			</mesh>
			<lineSegments>
				<bufferGeometry>
					<bufferAttribute attach="attributes-position" array={drop} count={2} itemSize={3} />
				</bufferGeometry>
				<lineBasicMaterial color="#f2b544" transparent opacity={selected ? 0.6 : 0.25} />
			</lineSegments>
			{/* where the light points: a dashed ray toward the stage centre */}
			{selected && (
				<Line
					points={[[0, 0, 0], [-keyLight.x * 0.86, -keyLight.y * 0.86, -keyLight.z * 0.86]]}
					color="#ffb454"
					lineWidth={1.6}
					dashed
					dashSize={0.32}
					gapSize={0.22}
					transparent
					opacity={0.45}
				/>
			)}
			{/* live readout while the sun is being dragged */}
			{dragKind && (
				<GizmoLabel
					position={[0, 0.5, 0]}
					text={`x ${keyLight.x.toFixed(1)}  y ${keyLight.y.toFixed(1)}  z ${keyLight.z.toFixed(1)}`}
					camRef={camRef}
				/>
			)}
		</group>
	);
}

/**
 * The shot camera drawn as an object in the editor view: a body and a short
 * frustum wireframe on GIZMO_LAYER, synced from the live camera every frame.
 * Preview, capture and PlayView draws all drop GIZMO_LAYER, so the ghost can
 * never reach a recorded frame.
 */
export function ShotCameraGhost({ camRef, fovDeg, aspect, visible, selected }) {
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

export function RenderLoopController({ stageRef }) {
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

/** GPU resets — sleep/wake, a driver restart, VRAM pressure from an export —
 * kill the WebGL context, and without listeners the stage goes black and
 * stays black with no message. preventDefault on webglcontextlost is the
 * documented opt-in for browser-driven restoration; on restore, kick the
 * demand loop so the first frame actually paints. */
export function ContextLossGuard({ onLostChange }) {
	const gl = useThree((state) => state.gl);
	const invalidate = useThree((state) => state.invalidate);
	useEffect(() => {
		const canvas = gl.domElement;
		const onLost = (event) => {
			event.preventDefault();
			onLostChange(true);
		};
		const onRestored = () => {
			onLostChange(false);
			invalidate();
		};
		canvas.addEventListener("webglcontextlost", onLost);
		canvas.addEventListener("webglcontextrestored", onRestored);
		return () => {
			canvas.removeEventListener("webglcontextlost", onLost);
			canvas.removeEventListener("webglcontextrestored", onRestored);
		};
	}, [gl, invalidate, onLostChange]);
	return null;
}

export function ViewportLayoutInvalidator({ insetX, insetY, insetWidth, insetHeight, hierarchyWidth, sidebarWidth, timelineHeight, planZoom }) {
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
export function CameraRailScenePreview({ points, cumLen, length, crane }) {
	const rootRef = useRef(null);
	const lines = useMemo(() => {
		if (!points || points.length < 2) return null;
		const floor = points.map((point) => [point.x, 0.03, point.z]);
		// A craned rail shows WHERE THE LENS RIDES: the same path lifted along
		// the crane's start→end heights by arc progress, with the floor line
		// kept as the track's ground projection.
		const lifted = crane && cumLen && length > 1e-9
			? points.map((point, i) => [point.x, craneHeightAt(crane, cumLen[i] / length), point.z])
			: null;
		return { floor, lifted };
	}, [points, cumLen, length, crane]);
	useEffect(() => {
		rootRef.current?.traverse((node) => node.layers.set(GIZMO_LAYER));
	});
	if (!lines) return null;
	// drei's Line renders screen-space fat lines: a WebGL <line> is always
	// 1px, which reads as a hairline on dense displays.
	return (
		<group ref={rootRef}>
			<Line points={lines.floor} color="#a78bfa" lineWidth={2} transparent opacity={lines.lifted ? 0.35 : 0.8} depthWrite={false} />
			{lines.lifted && (
				<Line points={lines.lifted} color="#a78bfa" lineWidth={2.5} transparent opacity={0.9} depthWrite={false} />
			)}
		</group>
	);
}


/**
 * The crane's height marks as grabbable dots on the lifted curve. Click a
 * dot to select it; the selected dot grows a 3-axis gizmo — Y sets the
 * mark's height, X/Z bend the camera path itself by moving the drawn rail
 * control point nearest the mark. A free drag on the dot rides a
 * camera-facing vertical plane (height, plus arc slide for interior marks),
 * Shift-drag slides along the arc at a fixed height, double-click the curve
 * adds a mark and Delete removes a non-endpoint. Dots live on GIZMO_LAYER, so the
 * recording never sees them.
 */
export const CRANE_AXES = [
	{ axis: "x", dir: new THREE.Vector3(1, 0, 0), color: "#ff5340" },
	{ axis: "y", dir: new THREE.Vector3(0, 1, 0), color: "#54e05c" },
	{ axis: "z", dir: new THREE.Vector3(0, 0, 1), color: "#3d8bff" },
];
export const CRANE_ARROW_LEN = 0.5;
export const CRANE_GIZMO_SCALE = 0.16; // metres of gizmo per metre of camera distance

/**
 * Prepare an x/z rail bend for one crane mark: a copy of the drawn control
 * points (with one inserted at the mark's base when none is close enough to
 * anchor the bend) plus a per-point weight — a cosine bump centred on the
 * anchor that fades to zero by the neighbouring crane marks, so dragging one
 * mark can never tow the marks beside it. For an interior mark both rail
 * ends are pinned outright.
 */
export function prepareRailBend(controlPoints, base, marks, markIndex) {
	const controls = (controlPoints ?? []).map((entry) => ({ ...entry }));
	if (controls.length < 2) return null;
	// nearest control point / segment to the mark's base
	let nearestIdx = 0;
	let nearestD = Infinity;
	for (let i = 0; i < controls.length; i += 1) {
		const d = Math.hypot(controls[i].x - base.x, controls[i].z - base.z);
		if (d < nearestD) {
			nearestD = d;
			nearestIdx = i;
		}
	}
	const interior = markIndex > 0 && markIndex < marks.length - 1;
	let anchorIdx = nearestIdx;
	if (interior && nearestD > 0.25) {
		// no control point near the mark: bend needs a vertex to pull, so one
		// is seeded at the base, on the segment the base projects onto
		let segmentIdx = 0;
		let segmentD = Infinity;
		for (let i = 0; i < controls.length - 1; i += 1) {
			const ax = controls[i].x;
			const az = controls[i].z;
			const bx = controls[i + 1].x;
			const bz = controls[i + 1].z;
			const lenSq = Math.max((bx - ax) ** 2 + (bz - az) ** 2, 1e-9);
			const u = Math.max(0, Math.min(1, ((base.x - ax) * (bx - ax) + (base.z - az) * (bz - az)) / lenSq));
			const d = Math.hypot(ax + (bx - ax) * u - base.x, az + (bz - az) * u - base.z);
			if (d < segmentD) {
				segmentD = d;
				segmentIdx = i;
			}
		}
		controls.splice(segmentIdx + 1, 0, { x: base.x, z: base.z });
		anchorIdx = segmentIdx + 1;
	}
	// normalized arc parameter of each control point along the control polygon
	const ts = [0];
	for (let i = 1; i < controls.length; i += 1) {
		ts.push(ts[i - 1] + Math.hypot(controls[i].x - controls[i - 1].x, controls[i].z - controls[i - 1].z));
	}
	const total = Math.max(ts[ts.length - 1], 1e-9);
	for (let i = 0; i < ts.length; i += 1) ts[i] /= total;
	// the bump reaches exactly to the neighbouring crane marks
	const t0 = ts[anchorIdx];
	const previous = markIndex > 0 ? marks[markIndex - 1].t : null;
	const next = markIndex < marks.length - 1 ? marks[markIndex + 1].t : null;
	const radius = Math.max(0.15, Math.min(previous != null ? t0 - previous : 1, next != null ? next - t0 : 1));
	const weights = ts.map((t, i) => {
		if (interior && (i === 0 || i === ts.length - 1)) return 0;
		const d = Math.abs(t - t0);
		return d >= radius ? 0 : 0.5 * (1 + Math.cos((Math.PI * d) / radius));
	});
	return { startControls: controls, weights, t0, radius };
}

/**
 * A floating readout beside a drag — billboarded, sized to the screen, on
 * GIZMO_LAYER so it is editor furniture the recording never sees.
 */
export function GizmoLabel({ position, text, camRef }) {
	const ref = useRef(null);
	useFrame(() => {
		const cam = camRef?.current;
		const node = ref.current;
		if (!cam || !node) return;
		node.quaternion.copy(cam.getWorldQuaternion(new THREE.Quaternion()));
		const world = node.getWorldPosition(new THREE.Vector3());
		node.scale.setScalar(Math.max(0.4, cam.getWorldPosition(new THREE.Vector3()).distanceTo(world) * 0.11));
		node.traverse((child) => child.layers?.set(GIZMO_LAYER));
	});
	return (
		<Text
			ref={ref}
			position={position}
			fontSize={0.19}
			color="#ffd27a"
			outlineWidth={0.014}
			outlineColor="#241a05"
			anchorX="center"
			anchorY="bottom"
			renderOrder={1000}
			material-depthTest={false}
			material-transparent
		>
			{text}
		</Text>
	);
}

/**
 * A scene object's travel path in the 3D view: the route as a line, its points
 * as grabbable dots, and a 3-axis gizmo on the selected dot. The grammar is
 * the crane's on purpose — Top-View draws the floor route, the scene lifts and
 * nudges the individual points, so a plane can climb along its own path.
 */
export function ObjectPathHandles({ path, selectedIndex, enabled, paneRef, camRef, onSelect, onChangePoints, onDragStart, onDragEnd }) {
	const { gl } = useThree();
	const invalidate = useThree((state) => state.invalidate);
	const groupRef = useRef(null);
	const gizmoRef = useRef(null);
	const dragRef = useRef(null);
	const stateRef = useRef(null);
	const [dragging, setDragging] = useState(false);
	stateRef.current = { path, selectedIndex, enabled, onSelect, onChangePoints, onDragStart, onDragEnd };
	useFrame(() => {
		const gizmo = gizmoRef.current;
		const camera = camRef.current;
		if (!gizmo || !camera) return;
		const world = gizmo.getWorldPosition(new THREE.Vector3());
		gizmo.scale.setScalar(Math.max(0.35, camera.getWorldPosition(new THREE.Vector3()).distanceTo(world) * CRANE_GIZMO_SCALE));
	});
	useEffect(() => {
		groupRef.current?.traverse((node) => node.layers?.set(GIZMO_LAYER));
		invalidate();
	}, [path, selectedIndex, enabled, dragging, invalidate]);
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
		const onDown = (event) => {
			const s = stateRef.current;
			if (!s.enabled || !s.path || event.button !== 0) return;
			if (!groupRef.current || !rayFrom(event)) return;
			const hits = raycaster.intersectObjects(groupRef.current.children, true);
			// The axis gizmo outranks the dots, exactly like the crane's.
			const axisHit = hits.find((entry) => entry.object.userData?.pathAxis);
			if (axisHit && s.selectedIndex != null && s.path.points[s.selectedIndex]) {
				const axis = axisHit.object.userData.pathAxis;
				const point = s.path.points[s.selectedIndex];
				const origin = new THREE.Vector3(point.x, point.y, point.z);
				const dir = CRANE_AXES.find((entry) => entry.axis === axis).dir;
				const eye = new THREE.Vector3();
				camRef.current.getWorldDirection(eye);
				const normal = dir.clone().cross(eye).cross(dir);
				if (normal.lengthSq() < 1e-6) return;
				normal.normalize();
				const plane = new THREE.Plane().setFromNormalAndCoplanarPoint(normal, origin);
				const hitStart = new THREE.Vector3();
				if (!raycaster.ray.intersectPlane(plane, hitStart)) return;
				event.stopImmediatePropagation();
				event.preventDefault();
				dragRef.current = { axis, index: s.selectedIndex, dir: dir.clone(), plane, hitStart, start: { ...point }, recorded: false };
				setDragging(true);
				invalidate();
				return;
			}
			const hit = hits.find((entry) => entry.object.userData?.pathIndex !== undefined);
			if (!hit) return;
			event.stopImmediatePropagation();
			event.preventDefault();
			const index = hit.object.userData.pathIndex;
			s.onSelect(index);
			// A press on the dot itself moves it freely on the camera plane —
			// the sun puck's grammar, so a point can be nudged without aiming.
			const point = s.path.points[index];
			const origin = new THREE.Vector3(point.x, point.y, point.z);
			const facing = new THREE.Vector3();
			camRef.current.getWorldDirection(facing);
			const plane = new THREE.Plane().setFromNormalAndCoplanarPoint(facing, origin);
			const hitStart = new THREE.Vector3();
			if (!raycaster.ray.intersectPlane(plane, hitStart)) return;
			dragRef.current = { axis: null, index, plane, hitStart, start: { ...point }, recorded: false };
			setDragging(true);
			invalidate();
		};
		const onMove = (event) => {
			const s = stateRef.current;
			const drag = dragRef.current;
			if (!drag || !s.enabled || !s.path) return;
			if (!rayFrom(event)) return;
			const world = new THREE.Vector3();
			if (!raycaster.ray.intersectPlane(drag.plane, world)) return;
			if (!drag.recorded) {
				s.onDragStart?.();
				drag.recorded = true;
			}
			const points = s.path.points.map((entry) => ({ ...entry }));
			if (drag.axis) {
				const travel = world.clone().sub(drag.hitStart).dot(drag.dir);
				const axis = drag.axis;
				points[drag.index][axis] = drag.start[axis] + travel;
			} else {
				points[drag.index] = {
					x: drag.start.x + (world.x - drag.hitStart.x),
					y: drag.start.y + (world.y - drag.hitStart.y),
					z: drag.start.z + (world.z - drag.hitStart.z),
				};
			}
			if (points[drag.index].y < 0) points[drag.index].y = 0;
			s.onChangePoints(points, { dragging: true });
			invalidate();
		};
		const onUp = () => {
			const drag = dragRef.current;
			dragRef.current = null;
			setDragging(false);
			if (drag?.recorded) stateRef.current.onDragEnd?.();
			invalidate();
		};
		const paneScreen = (world) => {
			const pane = paneRef.current?.getBoundingClientRect();
			if (!pane) return null;
			const projected = world.project(camRef.current);
			return projected.z > 1 ? null : {
				x: pane.left + ((projected.x + 1) / 2) * pane.width,
				y: pane.top + ((1 - projected.y) / 2) * pane.height,
			};
		};
		// Double-click the route to drop a point mid-path — the crane curve's
		// gesture, so one habit covers both. The new point lands ON the line,
		// so adding it never changes where the object goes; it only gives the
		// next drag something to grab in the middle.
		const onDouble = (event) => {
			const s = stateRef.current;
			if (!s.enabled || !s.path || !camRef.current) return;
			const points = s.path.points;
			if (points.length >= MAX_PATH_POINTS) return;
			camRef.current.updateMatrixWorld();
			let best = null;
			for (let i = 0; i < points.length - 1; i += 1) {
				const a = paneScreen(new THREE.Vector3(points[i].x, points[i].y ?? 0, points[i].z));
				const b = paneScreen(new THREE.Vector3(points[i + 1].x, points[i + 1].y ?? 0, points[i + 1].z));
				if (!a || !b) continue;
				const dx = b.x - a.x;
				const dy = b.y - a.y;
				const lenSq = dx * dx + dy * dy;
				const t = lenSq < 1e-6 ? 0 : Math.min(1, Math.max(0, ((event.clientX - a.x) * dx + (event.clientY - a.y) * dy) / lenSq));
				const d = Math.hypot(a.x + dx * t - event.clientX, a.y + dy * t - event.clientY);
				if (!best || d < best.d) best = { d, index: i, t };
			}
			if (!best || best.d > 14) return;
			// Refuse a point that would sit on top of a neighbour: a zero-length
			// segment is not a handle, it is a duplicate the schema would drop.
			if (best.t < 0.02 || best.t > 0.98) return;
			event.stopImmediatePropagation();
			event.preventDefault();
			const a = points[best.index];
			const b = points[best.index + 1];
			const inserted = {
				x: a.x + (b.x - a.x) * best.t,
				y: (a.y ?? 0) + ((b.y ?? 0) - (a.y ?? 0)) * best.t,
				z: a.z + (b.z - a.z) * best.t,
			};
			const next = [...points.slice(0, best.index + 1), inserted, ...points.slice(best.index + 1)];
			s.onDragStart?.();
			s.onChangePoints(next);
			s.onDragEnd?.();
			s.onSelect(best.index + 1);
			invalidate();
		};
		// Delete removes the selected point, never the object: while a point is
		// selected this handler owns the key, and the scene-object delete
		// handler stands down (it checks the same selection).
		const onKey = (event) => {
			const s = stateRef.current;
			if (!s.enabled || !s.path || s.selectedIndex == null) return;
			if (event.key !== "Delete" && event.key !== "Backspace") return;
			if (document.activeElement && /INPUT|TEXTAREA|SELECT/.test(document.activeElement.tagName)) return;
			event.preventDefault();
			event.stopImmediatePropagation();
			const remaining = s.path.points.filter((_, index) => index !== s.selectedIndex);
			// Two points are the least a route can be; the last removal clears
			// the whole path instead of leaving a stub that cannot be walked.
			s.onDragStart?.();
			s.onChangePoints(remaining.length >= 2 ? remaining : null);
			s.onDragEnd?.();
			s.onSelect(null);
			invalidate();
		};
		const el = gl.domElement;
		el.addEventListener("pointerdown", onDown);
		window.addEventListener("pointermove", onMove, true);
		window.addEventListener("pointerup", onUp, true);
		el.addEventListener("dblclick", onDouble, true);
		window.addEventListener("keydown", onKey, true);
		return () => {
			el.removeEventListener("pointerdown", onDown);
			window.removeEventListener("pointermove", onMove, true);
			window.removeEventListener("pointerup", onUp, true);
			el.removeEventListener("dblclick", onDouble, true);
			window.removeEventListener("keydown", onKey, true);
		};
		// paneRef/camRef are stable; handlers read live state through stateRef
		// eslint-disable-next-line react-hooks/exhaustive-deps
	}, [enabled, gl, invalidate]);
	const linePoints = useMemo(
		() => (path?.points ?? []).map((point) => [point.x, point.y + 0.02, point.z]),
		[path],
	);
	if (!enabled || !path || linePoints.length < 2) return null;
	const selected = selectedIndex != null ? path.points[selectedIndex] : null;
	return (
		<group ref={groupRef}>
			<Line points={linePoints} color="#6fcf97" lineWidth={2.5} transparent opacity={0.9} />
			{selected && (
				<group ref={gizmoRef} position={[selected.x, selected.y, selected.z]} renderOrder={999}>
					{CRANE_AXES.map(({ axis, dir, color }) => {
						const quat = new THREE.Quaternion().setFromUnitVectors(new THREE.Vector3(0, 1, 0), dir);
						return (
							<group key={axis} quaternion={quat}>
								<mesh position={[0, CRANE_ARROW_LEN / 2 + 0.08, 0]} renderOrder={999}>
									<cylinderGeometry args={[0.016, 0.016, CRANE_ARROW_LEN, 8]} />
									<meshStandardMaterial color="#000000" emissive={color} emissiveIntensity={2.2} toneMapped={false} depthTest={false} depthWrite={false} transparent opacity={0.95} />
								</mesh>
								<mesh position={[0, CRANE_ARROW_LEN + 0.08 + 0.07, 0]} renderOrder={999}>
									<coneGeometry args={[0.05, 0.14, 14]} />
									<meshStandardMaterial color="#000000" emissive={color} emissiveIntensity={2.2} toneMapped={false} depthTest={false} depthWrite={false} transparent opacity={0.95} />
								</mesh>
								<mesh position={[0, (CRANE_ARROW_LEN + 0.14) / 2 + 0.08, 0]} userData={{ pathAxis: axis }}>
									<cylinderGeometry args={[0.09, 0.09, CRANE_ARROW_LEN + 0.14, 8]} />
									<meshBasicMaterial visible={false} />
								</mesh>
							</group>
						);
					})}
				</group>
			)}
			{path.points.map((point, index) => (
				<group key={`${index}:${path.points.length}`} position={[point.x, point.y, point.z]}>
					<mesh userData={{ pathIndex: index }} renderOrder={998}>
						<sphereGeometry args={[0.075, 14, 10]} />
						<meshBasicMaterial color={index === selectedIndex ? "#ffb454" : "#6fcf97"} depthTest={false} transparent opacity={0.95} />
					</mesh>
					<mesh userData={{ pathIndex: index }}>
						<sphereGeometry args={[0.22, 10, 8]} />
						<meshBasicMaterial visible={false} />
					</mesh>
				</group>
			))}
			{dragging && selected && (
				<GizmoLabel
					position={[selected.x, selected.y + 0.42, selected.z]}
					text={`x ${selected.x.toFixed(1)}  y ${selected.y.toFixed(1)}  z ${selected.z.toFixed(1)}`}
					camRef={camRef}
				/>
			)}
		</group>
	);
}

export function CraneHandles({ rail, crane, controlPoints, selectedIndex, enabled, paneRef, camRef, onSelect, onChangePoints, onChangeRail, onDragStart, onDragEnd }) {
	const { gl } = useThree();
	const invalidate = useThree((state) => state.invalidate);
	const groupRef = useRef(null);
	const gizmoRef = useRef(null);
	const dragRef = useRef(null);
	const stateRef = useRef(null);
	// What the pointer is doing right now, for the in-scene feedback layer:
	// height-ish drags float a metre readout, a bend drag lights up the arc
	// span the bump will actually deform.
	const [dragInfo, setDragInfo] = useState(null);
	stateRef.current = { rail, crane, controlPoints, selectedIndex, enabled, onSelect, onChangePoints, onChangeRail, onDragStart, onDragEnd };
	// Constant on-screen size for the axis gizmo: it is UI, not set dressing.
	useFrame(() => {
		const gizmo = gizmoRef.current;
		const camera = camRef.current;
		if (!gizmo || !camera) return;
		const world = gizmo.getWorldPosition(new THREE.Vector3());
		gizmo.scale.setScalar(Math.max(0.35, camera.getWorldPosition(new THREE.Vector3()).distanceTo(world) * CRANE_GIZMO_SCALE));
	});
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
			// The axis gizmo outranks the dots: its arrows sit on the selected
			// dot, and a press on an arrow is a directed move, not a reselect.
			const axisHit = hits.find((entry) => entry.object.userData?.craneAxis);
			if (axisHit && s.selectedIndex != null && s.crane.points[s.selectedIndex]) {
				const axis = axisHit.object.userData.craneAxis;
				const point = s.crane.points[s.selectedIndex];
				const base = railPoint(s.rail, point.t * s.rail.length);
				const origin = new THREE.Vector3(base.x, point.height, base.z);
				const dir = CRANE_AXES.find((entry) => entry.axis === axis).dir;
				const eye = new THREE.Vector3();
				camRef.current.getWorldDirection(eye);
				// slide plane: contains the axis and faces the camera as squarely
				// as it can — the same construction the object gizmo uses
				const normal = dir.clone().cross(eye).cross(dir);
				if (normal.lengthSq() < 1e-6) return;
				normal.normalize();
				const plane = new THREE.Plane().setFromNormalAndCoplanarPoint(normal, origin);
				const hitStart = new THREE.Vector3();
				if (!raycaster.ray.intersectPlane(plane, hitStart)) return;
				// x/z bend the rail: a weighted bump around the mark's base, so
				// the path deforms locally and the marks beside it stay put.
				const bend = axis === "y" ? null : prepareRailBend(s.controlPoints, base, s.crane.points, s.selectedIndex);
				if (axis !== "y" && !bend) return;
				event.stopImmediatePropagation();
				event.preventDefault();
				dragRef.current = {
					axis,
					index: s.selectedIndex,
					dir: dir.clone(),
					plane,
					hitStart,
					startHeight: point.height,
					startControls: bend?.startControls ?? null,
					bendWeights: bend?.weights ?? null,
					recorded: false,
				};
				setDragInfo(axis === "y" ? { kind: "height" } : { kind: "bend", t0: bend.t0, radius: bend.radius });
				invalidate();
				return;
			}
			const hit = hits.find((entry) => entry.object.userData?.craneIndex !== undefined);
			if (!hit) return;
			event.stopImmediatePropagation();
			event.preventDefault();
			const index = hit.object.userData.craneIndex;
			s.onSelect(index);
			dragRef.current = { index, slide: event.shiftKey, recorded: false };
			setDragInfo({ kind: event.shiftKey ? "slide" : "free" });
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
			if (drag.axis) {
				const world = new THREE.Vector3();
				if (!raycaster.ray.intersectPlane(drag.plane, world)) return;
				const travel = world.sub(drag.hitStart).dot(drag.dir);
				if (drag.axis === "y") {
					const height = Math.max(0.1, Math.min(12, drag.startHeight + travel));
					s.onChangePoints(points.map((entry, i) => (i === drag.index ? { ...entry, height } : entry)), { dragging: true });
				} else if (drag.startControls && drag.bendWeights && s.onChangeRail) {
					const dx = drag.axis === "x" ? travel : 0;
					const dz = drag.axis === "z" ? travel : 0;
					const moved = drag.startControls.map((entry, i) => (drag.bendWeights[i] > 0
						? { ...entry, x: entry.x + dx * drag.bendWeights[i], z: entry.z + dz * drag.bendWeights[i] }
						: entry));
					s.onChangeRail(moved, { dragging: true });
				}
				invalidate();
				return;
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
				// free move: ray onto the camera-facing vertical plane at the base.
				// Its y sets the height; its x/z re-projects an interior mark onto
				// the nearest rail arc position, so one drag steers both axes — the
				// rail is the only x/z a crane mark can occupy.
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
				let t = point.t;
				if (drag.index > 0 && drag.index < points.length - 1) {
					let bestI = 0;
					let bestD = Infinity;
					for (let i = 0; i < s.rail.points.length; i += 1) {
						const d = Math.hypot(s.rail.points[i].x - world.x, s.rail.points[i].z - world.z);
						if (d < bestD) {
							bestD = d;
							bestI = i;
						}
					}
					t = Math.max(
						points[drag.index - 1].t + 0.02,
						Math.min(points[drag.index + 1].t - 0.02, s.rail.cumLen[bestI] / s.rail.length),
					);
				}
				s.onChangePoints(points.map((entry, i) => (i === drag.index ? { ...entry, t, height } : entry)), { dragging: true });
			}
			invalidate();
		};
		const onUp = () => {
			if (dragRef.current?.recorded) stateRef.current.onDragEnd?.();
			dragRef.current = null;
			setDragInfo(null);
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
	const selectedPoint = selectedIndex != null ? crane.points[selectedIndex] : null;
	const selectedBase = selectedPoint ? railPoint(rail, selectedPoint.t * rail.length) : null;
	return (
		<group ref={groupRef}>
			{selectedPoint && (
				<group ref={gizmoRef} position={[selectedBase.x, selectedPoint.height, selectedBase.z]} renderOrder={999}>
					{CRANE_AXES.map(({ axis, dir, color }) => {
						const quat = new THREE.Quaternion().setFromUnitVectors(new THREE.Vector3(0, 1, 0), dir);
						return (
							<group key={axis} quaternion={quat}>
								<mesh position={[0, CRANE_ARROW_LEN / 2 + 0.08, 0]} renderOrder={999}>
									<cylinderGeometry args={[0.016, 0.016, CRANE_ARROW_LEN, 8]} />
									<meshStandardMaterial color="#000000" emissive={color} emissiveIntensity={2.2} toneMapped={false} depthTest={false} depthWrite={false} transparent opacity={0.95} />
								</mesh>
								<mesh position={[0, CRANE_ARROW_LEN + 0.08 + 0.07, 0]} renderOrder={999}>
									<coneGeometry args={[0.05, 0.14, 14]} />
									<meshStandardMaterial color="#000000" emissive={color} emissiveIntensity={2.2} toneMapped={false} depthTest={false} depthWrite={false} transparent opacity={0.95} />
								</mesh>
								<mesh position={[0, (CRANE_ARROW_LEN + 0.14) / 2 + 0.08, 0]} userData={{ craneAxis: axis }}>
									<cylinderGeometry args={[0.09, 0.09, CRANE_ARROW_LEN + 0.14, 8]} />
									<meshBasicMaterial visible={false} />
								</mesh>
							</group>
						);
					})}
				</group>
			)}
			{crane.points.map((point, index) => {
				const base = railPoint(rail, point.t * rail.length);
				return (
					<group key={`${index}:${crane.points.length}`} position={[base.x, point.height, base.z]}>
						<mesh userData={{ craneIndex: index }} renderOrder={998}>
							<sphereGeometry args={[0.085, 16, 12]} />
							<meshBasicMaterial color={index === selectedIndex ? "#ffb454" : "#a78bfa"} depthTest={false} transparent opacity={0.95} />
						</mesh>
						{/* the real click target: a dot is a dozen pixels from a few
						    metres back, so an invisible halo carries the press */}
						<mesh userData={{ craneIndex: index }}>
							<sphereGeometry args={[0.24, 10, 8]} />
							<meshBasicMaterial visible={false} />
						</mesh>
					</group>
				);
			})}
			{/* live readout while a drag changes the mark's height */}
			{dragInfo && dragInfo.kind !== "bend" && selectedPoint && (
				<GizmoLabel
					position={[selectedBase.x, selectedPoint.height + 0.28, selectedBase.z]}
					text={dragInfo.kind === "slide" ? `${Math.round(selectedPoint.t * 100)}%` : `${selectedPoint.height.toFixed(1)} m`}
					camRef={camRef}
				/>
			)}
			{/* the span a bend drag will actually deform, lit on the floor path */}
			{dragInfo?.kind === "bend" && (() => {
				const span = [];
				for (let i = 0; i < rail.points.length; i += 1) {
					const t = rail.cumLen[i] / rail.length;
					if (t >= dragInfo.t0 - dragInfo.radius && t <= dragInfo.t0 + dragInfo.radius) {
						span.push([rail.points[i].x, 0.035, rail.points[i].z]);
					}
				}
				if (span.length < 2) return null;
				return <Line points={span} color="#ffb454" lineWidth={4} transparent opacity={0.9} />;
			})()}
		</group>
	);
}

export function ShotPathPreview({ waypoints, start, activeWaypointId }) {
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
export const CAPTURE_FOG_NEAR = 55;
export const CAPTURE_FOG_FAR = 95;

/** Offscreen aspect-aware read-back, always from the shot camera. */
export function CaptureRig({ apiRef, camRef, width = CAPTURE_W, height = CAPTURE_H }) {
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

export async function captureMcpFrame({ capture, camera, characters, activeCharacterId, objects, rigs, readAuthoredState }) {
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
export function useImageDrop(onFiles, onRejected) {
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
				// Dropped files that are not supported images (HEIC from an iPhone
				// is the mainline case) used to die here with zero feedback — the
				// user concluded drag-and-drop was broken. Name the rejection.
				if (!files.length) {
					const dropped = event.dataTransfer?.files?.length ?? 0;
					if (dropped > 0) onRejected?.(dropped);
					return;
				}
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
export const GIZMO_HOTKEYS = { KeyW: "move", KeyE: "rotate", KeyR: "scale" };

export const WORKSPACE_LAYOUT_KEY = "cozyclay.workspace-layout.v1";
export const DEFAULT_WORKSPACE_LAYOUT = Object.freeze({
	hierarchyWidth: 300,
	sidebarWidth: 380,
	timelineHeight: 224,
	insetWidth: 310,
	insetHeight: 310,
	insetCollapsed: false,
	planZoom: 1,
});

export function loadWorkspaceLayout() {
	try {
		const saved = JSON.parse(localStorage.getItem(WORKSPACE_LAYOUT_KEY) || "null");
		return saved ? { ...DEFAULT_WORKSPACE_LAYOUT, ...saved } : { ...DEFAULT_WORKSPACE_LAYOUT };
	} catch {
		return { ...DEFAULT_WORKSPACE_LAYOUT };
	}
}

/** Load the Scene envelope once. Legacy single-scene objects are migrated by
 * scenes.js; App only supplies the familiar starter set for a truly new room. */
export function loadSceneStartup() {
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
			// The startup scene is authored silently; without this flag the
			// funnel's "scene created" step never fires for a brand-new room.
			startupCreatedScene: result.status === "absent" || result.status === "corrupt",
			toast: result.status === "corrupt"
				? ko(`Saved scenes were unreadable — starting fresh; the old data is kept under ${SCENES_QUARANTINE_KEY}`, `저장된 장면을 읽을 수 없어 새로 시작합니다. 기존 데이터는 ${SCENES_QUARANTINE_KEY}에 보관했어요.`)
				: result.dropped > 0
					? (isKo ? `저장된 장면 ${result.dropped}개를 복원하지 못했어요` : `${result.dropped} saved scene(s) could not be restored`)
					: null,
		};
	} catch {
		const document = createSceneDocument();
		document.scenes[0].objects = defaults();
		return { document, saveBlocked: false, error: null, startupCreatedScene: true, toast: null };
	}
}

/* ------------------------- IK-mode motion trails --------------------------
 * World-space trajectory polylines of the loaded take: the root (hips) path
 * always, plus the focused IK effector's end-point trail. The whole clip is
 * drawn as a faint line; while a grab is active the falloff window is
 * re-drawn on top as a bright highlight. Grabbing any point of a line starts
 * a drag on a camera-facing plane through the grab point; the caller deforms
 * the take (motion-trail.js falloff math) so the preview updates live. */
export const MotionTrails = memo(function MotionTrails({ motion, baseY, charScale, ikFocus, falloffFrames, pendingEdit, enabled, visible = true, onDragStart, onDragPreview, onDragEnd }) {
	const { camera, gl, invalidate } = useThree();
	const [drag, setDrag] = useState(null);
	const callbacksRef = useRef({ onDragStart, onDragPreview, onDragEnd });
	callbacksRef.current = { onDragStart, onDragPreview, onDragEnd };
	const toTriples = (flat) => {
		if (!flat) return null;
		const out = [];
		for (let index = 0; index + 2 < flat.length; index += 3) out.push([flat[index], flat[index + 1], flat[index + 2]]);
		return out;
	};
	// Every trail track (root + IK endpoints + head) in its handle colour.
	const tracks = useMemo(
		() => TRAIL_TRACKS.map((track) => {
			const flat = jointTrailPoints(motion, track.joint, { baseY, scale: charScale });
			return flat ? { ...track, flat, points: toTriples(flat) } : null;
		}).filter(Boolean),
		// eslint-disable-next-line react-hooks/exhaustive-deps
		[motion, baseY, charScale],
	);
	const trackById = (id) => tracks.find((track) => track.id === id) ?? null;
	// The falloff window rides whichever line is being (or was last) grabbed.
	const highlight = drag ?? pendingEdit;
	const highlightPoints = useMemo(() => {
		if (!highlight || !motion?.frames) return null;
		const flat = trackById(highlight.track)?.flat ?? trackById("hips")?.flat;
		if (!flat) return null;
		const { startFrame, endFrame } = trailEditRange(motion.frames, highlight.grabFrame, falloffFrames);
		const out = [];
		for (let frame = startFrame; frame < endFrame; frame += 1) {
			out.push([flat[frame * 3], flat[frame * 3 + 1], flat[frame * 3 + 2]]);
		}
		return out.length > 1 ? out : null;
		// eslint-disable-next-line react-hooks/exhaustive-deps
	}, [highlight, motion, tracks, falloffFrames]);

	// Manual capture-phase picking instead of r3f pointer handlers: handlers on
	// a drei Line make react-three-fiber raycast the fat-line shader geometry on
	// EVERY pointermove for hover bookkeeping, which is exactly the IK-mode lag.
	// A single pointerdown listener that measures point-to-ray distance against
	// the cached trail arrays costs nothing while the mouse merely moves.
	const pickRef = useRef(null);
	pickRef.current = { tracks, enabled, falloffFrames };
	// Line2 instances for in-place geometry rewrites during a drag.
	const lineRefs = useRef({});
	const highlightRef = useRef(null);
	useEffect(() => {
		const dom = gl.domElement;
		const raycaster = new THREE.Raycaster();
		const hit = new THREE.Vector3();
		const down = (event) => {
			const pick = pickRef.current;
			if (!pick?.enabled || event.button !== 0) return;
			const rect = dom.getBoundingClientRect();
			const ndc = new THREE.Vector2(
				((event.clientX - rect.left) / rect.width) * 2 - 1,
				-((event.clientY - rect.top) / rect.height) * 2 + 1,
			);
			raycaster.setFromCamera(ndc, camera);
			const { origin, direction } = raycaster.ray;
			// TRAIL_TRACKS order is limbs-first, hips last: an overlapping grab
			// prefers the finer limb target, and among candidates within the
			// threshold the closest line wins.
			let track = null;
			let grabFrame = 0;
			let bestDistance = Infinity;
			for (const candidate of pick.tracks) {
				const near = nearestFrameToRay(candidate.flat, origin, direction, 0.2);
				if (near && near.distance < bestDistance) {
					track = candidate.id;
					grabFrame = near.frame;
					bestDistance = near.distance;
				}
			}
			if (!track) return;
			// The grab wins over the camera controls listening in the bubble phase.
			event.stopPropagation();
			event.preventDefault();
			const flat = pick.tracks.find((candidate) => candidate.id === track)?.flat;
			if (!flat) return;
			const start = new THREE.Vector3(flat[grabFrame * 3], flat[grabFrame * 3 + 1], flat[grabFrame * 3 + 2]);
			const normal = camera.getWorldDirection(new THREE.Vector3()).negate();
			const plane = new THREE.Plane().setFromNormalAndCoplanarPoint(normal, start);
			setDrag({ track, grabFrame });
			callbacksRef.current.onDragStart?.({ track, grabFrame });
			// The drag never touches React state: per rAF the grabbed line and the
			// falloff highlight are rewritten in place on their Line2 geometries,
			// and onDragPreview poses the rig imperatively. Re-rendering the whole
			// app per pointermove is exactly the drag lag this avoids; the real
			// commit (setMotion + pending edit) happens once, on pointerup.
			const frames = flat.length / 3;
			const { startFrame, endFrame } = trailEditRange(frames, grabFrame, pickRef.current.falloffFrames);
			const deformedFlat = new Float32Array(flat);
			const windowFlat = new Float32Array((endFrame - startFrame) * 3);
			let lastDelta = null;
			let queued = null;
			let rafId = 0;
			const applyPreview = (delta) => {
				for (let frame = startFrame; frame < endFrame; frame += 1) {
					const weight = falloffWeight(frame - grabFrame, pickRef.current.falloffFrames);
					deformedFlat[frame * 3] = flat[frame * 3] + delta.x * weight;
					deformedFlat[frame * 3 + 1] = flat[frame * 3 + 1] + delta.y * weight;
					deformedFlat[frame * 3 + 2] = flat[frame * 3 + 2] + delta.z * weight;
				}
				windowFlat.set(deformedFlat.subarray(startFrame * 3, endFrame * 3));
				lineRefs.current[track]?.geometry?.setPositions(deformedFlat);
				highlightRef.current?.geometry?.setPositions(windowFlat);
				callbacksRef.current.onDragPreview?.({ track, grabFrame, delta });
				invalidate();
			};
			const flush = () => {
				rafId = 0;
				if (queued) applyPreview(queued);
				queued = null;
			};
			const move = (pointerEvent) => {
				const moveRect = dom.getBoundingClientRect();
				const moveNdc = new THREE.Vector2(
					((pointerEvent.clientX - moveRect.left) / moveRect.width) * 2 - 1,
					-((pointerEvent.clientY - moveRect.top) / moveRect.height) * 2 + 1,
				);
				raycaster.setFromCamera(moveNdc, camera);
				if (!raycaster.ray.intersectPlane(plane, hit)) return;
				lastDelta = { x: hit.x - start.x, y: hit.y - start.y, z: hit.z - start.z };
				queued = lastDelta;
				if (!rafId) rafId = requestAnimationFrame(flush);
			};
			const up = () => {
				window.removeEventListener("pointermove", move);
				window.removeEventListener("pointerup", up);
				if (rafId) cancelAnimationFrame(rafId);
				if (queued) applyPreview(queued);
				setDrag(null);
				callbacksRef.current.onDragEnd?.({ track, grabFrame, delta: lastDelta });
			};
			window.addEventListener("pointermove", move);
			window.addEventListener("pointerup", up);
		};
		dom.addEventListener("pointerdown", down, true);
		return () => dom.removeEventListener("pointerdown", down, true);
		// eslint-disable-next-line react-hooks/exhaustive-deps
	}, [gl, camera]);

	if (!tracks.length) return null;
	const focusTrack = TRAIL_EFFECTOR_JOINTS[ikFocus] ? tracks.find((track) => track.joint === TRAIL_EFFECTOR_JOINTS[ikFocus])?.id : null;
	// depthTest off + high renderOrder: the trails read through the character
	// and the floor instead of vanishing into them. Every part rides its own
	// IK-handle colour; the focused part draws thicker.
	return (
		<group
			visible={visible}
			renderOrder={900}
			ref={(group) => {
				// QA-only escape hatch (same spirit as window.__cozyclay): lets
				// headless perf probes toggle the trails without a rebuild.
				if (typeof window !== "undefined") window.__cozyclayTrails = group;
			}}
		>
			{tracks.map((track) => track.points.length > 1 && (
				<Line
					key={track.id}
					ref={(line) => {
						if (line) lineRefs.current[track.id] = line;
						else delete lineRefs.current[track.id];
					}}
					points={track.points}
					color={track.color}
					lineWidth={track.id === focusTrack ? 4 : 2.5}
					depthTest={false}
					transparent
					opacity={track.id === focusTrack ? 1 : 0.85}
				/>
			))}
			{highlightPoints && (
				<Line ref={highlightRef} points={highlightPoints} color={drag ? "#3dff7a" : "#ff8c42"} lineWidth={5} depthTest={false} />
			)}
		</group>
	);
}, (previous, next) => (
	previous.motion === next.motion &&
	previous.baseY === next.baseY &&
	previous.charScale === next.charScale &&
	previous.ikFocus === next.ikFocus &&
	previous.falloffFrames === next.falloffFrames &&
	previous.pendingEdit === next.pendingEdit &&
	previous.enabled === next.enabled &&
	previous.visible === next.visible
));


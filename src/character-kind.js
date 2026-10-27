// What a cast member can do depends on its kind. A rigged character has a
// skeleton every motion, IK and physics tool writes to; a capsule figure
// (PROXY_FIGURE_MODEL) is a placement-only stand-in with no bones at all, so
// those tools refuse it by name instead of failing on a missing rig.
import { isProxyFigure } from "./scenes.js";
import { isKo, isZh } from "./locale.js";
import { StudioProtocolError } from "./studio-agent-protocol.js";
import {
	PROXY_BODY_HEIGHT, PROXY_BODY_RADIUS, PROXY_HEAD_LIFT, PROXY_HEAD_RADIUS, PROXY_SIT_LEG_REACH, PROXY_SIT_TORSO_HEIGHT,
} from "./proxy-figure-shape.js";

export const CHARACTER_CAPABILITIES = Object.freeze(["rig", "ik", "pose", "motion"]);

/** Return a capsule figure's rendered world-space bounds without a rig. */
export function proxyFigureBounds(character, placement = character) {
	const posture = character?.posture === "sit" || character?.posture === "lie" ? character.posture : "stand";
	const bodyHeight = posture === "sit" ? PROXY_SIT_TORSO_HEIGHT : PROXY_BODY_HEIGHT;
	const top = bodyHeight + (PROXY_HEAD_LIFT + PROXY_HEAD_RADIUS);
	const stature = Number.isFinite(placement?.scale) ? placement.scale : Number.isFinite(character?.scale) ? character.scale : 1;
	const x = Number.isFinite(placement?.x) ? placement.x : character?.x ?? 0;
	const y = Number.isFinite(placement?.y) ? placement.y : character?.y ?? 0;
	const z = Number.isFinite(placement?.z) ? placement.z : character?.z ?? 0;
	const yaw = ((Number.isFinite(placement?.rot) ? placement.rot : character?.rot ?? 0) + (posture === "lie" ? 180 : 0)) * Math.PI / 180;
	const [minCorner, maxCorner] = posture === "lie"
		? [[-PROXY_BODY_RADIUS, PROXY_BODY_RADIUS - PROXY_HEAD_RADIUS, -top],
			[PROXY_BODY_RADIUS, PROXY_BODY_RADIUS + PROXY_HEAD_RADIUS, 0]]
		// Sit reaches forward (local +z, the facing direction) with its legs.
		: [[-PROXY_BODY_RADIUS, 0, -PROXY_BODY_RADIUS], [PROXY_BODY_RADIUS, top, posture === "sit" ? PROXY_SIT_LEG_REACH : PROXY_BODY_RADIUS]];
	const min = { x: Infinity, y: Infinity, z: Infinity }, max = { x: -Infinity, y: -Infinity, z: -Infinity };
	for (const lx of [minCorner[0], maxCorner[0]]) for (const ly of [minCorner[1], maxCorner[1]]) for (const lz of [minCorner[2], maxCorner[2]]) {
		const sx = lx * stature, sy = ly * stature, sz = lz * stature;
		const wx = x + sx * Math.cos(yaw) + sz * Math.sin(yaw);
		const wz = z - sx * Math.sin(yaw) + sz * Math.cos(yaw);
		min.x = Math.min(min.x, wx); max.x = Math.max(max.x, wx);
		min.y = Math.min(min.y, y + sy); max.y = Math.max(max.y, y + sy);
		min.z = Math.min(min.z, wz); max.z = Math.max(max.z, wz);
	}
	return { min, max };
}

/** `{ rig, ik, pose, motion }` - all false
 * for a capsule figure, all true for a rigged character. */
export function characterCapabilities(character) {
	const rigged = !isProxyFigure(character);
	return Object.freeze(Object.fromEntries(CHARACTER_CAPABILITIES.map((name) => [name, rigged])));
}

// The noun each refusal names. A feature id not listed here is used verbatim.
const FEATURE_LABELS = {
	rig: ["the rig", "리그", "骨骼"],
	ik: ["IK", "IK", "IK"],
	pose: ["Pose mode", "포즈 모드", "姿势模式"],
	motion: ["Compiled motion", "모션 컴파일", "编译动作"],
	take: ["Loading a take", "테이크 불러오기", "加载动作片段"],
};

// A character's kind (rig or capsule figure) is fixed at creation; character.update refuses a kind change.
export const KIND_FIXED_REFUSAL = Object.freeze({
	en: "A character's kind is chosen when it is created; add a new character instead.",
	ko: "캐릭터 종류는 만들 때 정합니다. 새 캐릭터를 추가하세요.",
	zh: "角色的类型在创建时确定；请改为添加新角色。",
});

export function kindRefusal(feature, ko = false, zh = false) {
	const label = FEATURE_LABELS[feature]?.[ko ? 1 : zh ? 2 : 0] ?? feature;
	if (ko) return `캡슐 인물은 리그가 없어요 - ${label}는 리그 캐릭터에서만 됩니다.`;
	if (zh) return `胶囊人物没有骨骼 — ${label}仅适用于带骨骼的角色。`;
	return `Capsule figures have no rig - ${label} works on rigged characters only.`;
}

/** Throw TARGET_NOT_READY when `character` is a capsule figure. The protocol
 * message is English (the agent reads it); `uiMessage` is the locale's. */
export function refuseRigOnly(character, feature) {
	if (!isProxyFigure(character)) return;
	throw Object.assign(new StudioProtocolError("TARGET_NOT_READY", kindRefusal(feature, false)), { uiMessage: kindRefusal(feature, isKo, isZh) });
}

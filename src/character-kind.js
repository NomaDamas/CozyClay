// What a cast member can do depends on its kind. A rigged character has a
// skeleton every motion, IK and physics tool writes to; a capsule figure
// (PROXY_FIGURE_MODEL) is a placement-only stand-in with no bones at all, so
// those tools refuse it by name instead of failing on a missing rig.
import { isProxyFigure } from "./scenes.js";
import { isKo } from "./locale.js";
import { StudioProtocolError } from "./studio-agent-protocol.js";

export const CHARACTER_CAPABILITIES = Object.freeze(["rig", "ik", "pose", "motion", "mocap", "physics", "trails", "lineEdit"]);

/** `{ rig, ik, pose, motion, mocap, physics, trails, lineEdit }` - all false
 * for a capsule figure, all true for a rigged character. */
export function characterCapabilities(character) {
	const rigged = !isProxyFigure(character);
	return Object.freeze(Object.fromEntries(CHARACTER_CAPABILITIES.map((name) => [name, rigged])));
}

// The noun each refusal names. A feature id not listed here is used verbatim.
const FEATURE_LABELS = {
	rig: ["the rig", "리그"],
	ik: ["IK", "IK"],
	pose: ["Pose mode", "포즈 모드"],
	motion: ["Motion generation", "모션 생성"],
	mocap: ["Motion capture", "모션 캡처"],
	photoPose: ["Photo pose", "사진 포즈"],
	physics: ["Physics", "물리 보정"],
	collision: ["Collision cleanup", "충돌 정리"],
	trails: ["Motion trails", "궤적선"],
	lineEdit: ["Line edit", "라인 편집"],
	take: ["Loading a take", "테이크 불러오기"],
};

// A character's kind (rig or capsule figure) is fixed at creation; character.update refuses a kind change.
export const KIND_FIXED_REFUSAL = Object.freeze({
	en: "A character's kind is chosen when it is created; add a new character instead.",
	ko: "캐릭터 종류는 만들 때 정합니다. 새 캐릭터를 추가하세요.",
});

export function kindRefusal(feature, ko = false) {
	const label = FEATURE_LABELS[feature]?.[ko ? 1 : 0] ?? feature;
	return ko
		? `캡슐 인물은 리그가 없어요 - ${label}는 리그 캐릭터에서만 됩니다.`
		: `Capsule figures have no rig - ${label} works on rigged characters only.`;
}

/** Throw TARGET_NOT_READY when `character` is a capsule figure. The protocol
 * message is English (the agent reads it); `uiMessage` is the locale's. */
export function refuseRigOnly(character, feature) {
	if (!isProxyFigure(character)) return;
	throw Object.assign(new StudioProtocolError("TARGET_NOT_READY", kindRefusal(feature, false)), { uiMessage: kindRefusal(feature, isKo) });
}

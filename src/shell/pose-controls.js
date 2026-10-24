import { ko } from "../locale.js";
import { DEFAULT_POSE } from "../poses.js";
import { FINGER_PRESETS } from "../motion/fingers.js";

// The Pose panel's reset and the focused hand's finger controls, read off the studio shell.
export function posePanelControls(shell) {
	const { motion, characters, runStudioAction, castDomain, setStudioPick, setToast, cancelPendingIkEdit } = shell;
	// Over a take the default is the take itself: drop the IK edits and keep the motion.
	// Without one, back to the default pose; clearMotion also drops the IK keys (one undo step).
	const resetPose = (characterId) => {
		cancelPendingIkEdit?.();
		const current = characters.find((entry) => entry.id === characterId)?.pose;
		// Already on the default pose: only the IK edits go. A pose write would re-apply the
		// bare pose on Undo over the restored IK keys.
		if (motion || !current || current.id === DEFAULT_POSE.id) {
			runStudioAction("character.clearIkKeys", { characterId });
			if (motion) {
				setToast(ko("Pose edits cleared — the motion stays", "포즈 수정을 지웠어요 — 모션은 그대로예요"));
				return;
			}
		} else castDomain.run('character.setPose', { characterId, pose: DEFAULT_POSE.id, clearMotion: true });
		setStudioPick(DEFAULT_POSE.id);
		setToast(ko("Back to the default pose", "기본 포즈로 돌아왔어요"));
	};
	const { handFingers: fingers, ikTick, ikSolve, ikDragEnd, fingerEditing, setFingerEdit } = shell;
	const fingerPanel = {
		fingers, tick: ikTick, editing: fingerEditing, onToggleEdit: () => setFingerEdit(!fingerEditing),
		onCurl: (id, curl) => ikSolve("finger", id, { curl }), onCommit: ikDragEnd,
		onPreset: (name) => { for (const finger of fingers) ikSolve("finger", finger.id, { curl: FINGER_PRESETS[name][finger.name] }); ikDragEnd(); },
	};
	return { resetPose, fingerPanel };
}

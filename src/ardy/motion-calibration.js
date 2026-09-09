// Pure scene-space calibration for decoded GVHMR motion.  Extraction owns a
// camera-independent coordinate system; this pass applies the optional rigid
// transform recorded by the scene (uniform scale, Y rotation and translation).
// It deliberately leaves local joint rotations untouched.

export const MOTION_CALIBRATION_LIMITS = Object.freeze({
	minScale: 0.1,
	maxScale: 10,
	maxOffset: 100,
});

const finite = (value, fallback) => {
	const number = Number(value);
	return Number.isFinite(number) ? number : fallback;
};

function wrapDegrees(value) {
	const wrapped = ((value + 180) % 360 + 360) % 360 - 180;
	// Keep the canonical positive half-open interval stable for exact 180.
	return Object.is(wrapped, -0) ? 0 : wrapped;
}

/**
 * Return a safe, JSON-friendly calibration envelope.  Missing values are the
 * identity transform; finite values outside the scene envelope are clamped so
 * persisted metadata cannot throw a take metres away or produce NaNs.
 */
export function normalizeMotionCalibration(value, limits = MOTION_CALIBRATION_LIMITS) {
	const source = value && typeof value === "object" && !Array.isArray(value) ? value : {};
	const minScale = Math.max(Number.EPSILON, finite(limits?.minScale, MOTION_CALIBRATION_LIMITS.minScale));
	const maxScale = Math.max(minScale, finite(limits?.maxScale, MOTION_CALIBRATION_LIMITS.maxScale));
	const maxOffset = Math.max(0, finite(limits?.maxOffset, MOTION_CALIBRATION_LIMITS.maxOffset));
	const rawScale = finite(source.scale, 1);
	const rawYaw = finite(source.yawDeg ?? source.yaw, 0);
	const clampOffset = (entry) => Math.max(-maxOffset, Math.min(maxOffset, finite(entry, 0)));
	return {
		scale: Math.max(minScale, Math.min(maxScale, rawScale > 0 ? rawScale : 1)),
		yawDeg: wrapDegrees(rawYaw),
		offsetX: clampOffset(source.offsetX ?? source.offset_x),
		offsetY: clampOffset(source.offsetY ?? source.offset_y),
		offsetZ: clampOffset(source.offsetZ ?? source.offset_z),
	};
}

function copyArray(values) {
	if (values == null) return values;
	if (typeof values.slice === "function") return values.slice();
	return Array.from(values);
}

function validArray(values, length) {
	return values != null && typeof values.length === "number" && values.length >= length;
}

/**
 * Apply a rigid scene calibration to root and posed-joint positions.
 *
 * The input take is never mutated.  The result follows the same
 * `{ motion, diagnostics }` contract as the other ARDY correction passes.
 * `rotMats` are local joint rotations, so a world-space yaw does not change
 * them and the original array is intentionally retained by reference.
 */
export function applyMotionCalibration(motion, metadata = motion?.sceneCalibration, options = {}) {
	const identity = normalizeMotionCalibration(null, options.limits);
	const baseDiagnostics = {
		status: "not-needed",
		applied: false,
		changedFrames: 0,
		maxDisplacement: 0,
		maxRootDisplacement: 0,
		maxJointDisplacement: 0,
		calibration: identity,
	};
	if (!motion || typeof motion !== "object") return { motion, diagnostics: { ...baseDiagnostics, status: "invalid-motion" } };
	const calibration = normalizeMotionCalibration(metadata, options.limits);
	const frames = Number(motion.frames);
	const hasRoot = Number.isInteger(frames) && frames >= 0 && validArray(motion.rootPos, frames * 3);
	const hasJoints = Number.isInteger(frames) && frames >= 0 && validArray(motion.posedJoints, 0) && motion.posedJoints.length % (frames * 3 || 1) === 0;
	if (!hasRoot && !hasJoints) return { motion, diagnostics: { ...baseDiagnostics, status: "invalid-motion", calibration } };
	const isIdentity = calibration.scale === 1 && calibration.yawDeg === 0 && calibration.offsetX === 0 && calibration.offsetY === 0 && calibration.offsetZ === 0;
	if (isIdentity) return { motion, diagnostics: { ...baseDiagnostics, calibration } };

	const radians = calibration.yawDeg * Math.PI / 180;
	const cos = Math.cos(radians), sin = Math.sin(radians), transform = (x, y, z) => {
		const sx = calibration.scale * x, sy = calibration.scale * y, sz = calibration.scale * z;
		return [cos * sx + sin * sz + calibration.offsetX, sy + calibration.offsetY, -sin * sx + cos * sz + calibration.offsetZ];
	};
	const rootPos = hasRoot ? copyArray(motion.rootPos) : motion.rootPos;
	const posedJoints = hasJoints ? copyArray(motion.posedJoints) : motion.posedJoints;
	let maxRootDisplacement = 0, maxJointDisplacement = 0, changedFrames = 0;
	const displacement = (before, after) => {
		if (![...before, ...after].every(Number.isFinite)) return 0;
		return Math.hypot(after[0] - before[0], after[1] - before[1], after[2] - before[2]);
	};
	for (let frame = 0; frame < frames; frame += 1) {
		let frameChanged = false;
		if (hasRoot) {
			const offset = frame * 3, before = [motion.rootPos[offset], motion.rootPos[offset + 1], motion.rootPos[offset + 2]], after = transform(...before);
			rootPos[offset] = after[0]; rootPos[offset + 1] = after[1]; rootPos[offset + 2] = after[2];
			maxRootDisplacement = Math.max(maxRootDisplacement, displacement(before, after)); frameChanged ||= displacement(before, after) > 1e-9;
		}
		if (hasJoints) {
			const jointCount = motion.posedJoints.length / (frames * 3);
			for (let joint = 0; joint < jointCount; joint += 1) {
				const offset = (frame * jointCount + joint) * 3, before = [motion.posedJoints[offset], motion.posedJoints[offset + 1], motion.posedJoints[offset + 2]], after = transform(...before);
				posedJoints[offset] = after[0]; posedJoints[offset + 1] = after[1]; posedJoints[offset + 2] = after[2];
				maxJointDisplacement = Math.max(maxJointDisplacement, displacement(before, after)); frameChanged ||= displacement(before, after) > 1e-9;
			}
		}
		if (frameChanged) changedFrames += 1;
	}
	const diagnostics = {
		status: "calibrated", applied: true, changedFrames,
		maxDisplacement: Math.max(maxRootDisplacement, maxJointDisplacement),
		maxRootDisplacement, maxJointDisplacement, calibration,
	};
	return { motion: { ...motion, rootPos, posedJoints }, diagnostics };
}

// Descriptive aliases for callers that use the scene-calibration terminology.
export const applySceneCalibration = applyMotionCalibration;
export const calibrateMotion = applyMotionCalibration;

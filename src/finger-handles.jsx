import { useEffect, useRef, useState } from "react";
import { useFrame, useThree } from "@react-three/fiber";
import * as THREE from "three";
import { POSER_LAYER } from "./dualview.jsx";
import { fingerTip, fingersOf } from "./motion/fingers.js";
import { claimFingertip } from "./motion/fingertip-pick.js";
import { handleColor } from "./pose-gizmo.js";

// A fingertip handle is a real sphere in the scene, a little wider than the finger, so it sits on the tip,
// shades with the lights and hides behind the body by depth like the mesh does.
const TIP_R = 0.009;
// The tip bone sits inside the fingertip; the sphere rides this far further along the last bone so most of
// it shows past the skin.
const TIP_PUSH = 0.008;
// Picking reaches a few pixels past the sphere's projected edge, nearest tip first.
const PICK_SLACK_PX = 6;
// A tip may sit this far under the first body surface and still be grabbed: the IK controls' exposure rule
// (ikControlIsExposed) with their default allowance, twice the handle radius (#913).
const TIP_VISIBILITY_DEPTH = TIP_R * 2;

/** The focused hand's fingers, and fingertip editing: a mode of the focused hand, on only while a hand is focused. */
export function useFingerEdit(ikFocus, fkJoints) {
	const [fingerEdit, setFingerEdit] = useState(false);
	// IkHandles fills this with its exposure probe; the fingertip pick asks it before taking a press.
	const exposureProbeRef = useRef(null);
	const side = ikFocus === "leftHand" ? "Left" : ikFocus === "rightHand" ? "Right" : null;
	const handFingers = side ? [...(fingersOf(fkJoints)?.values() ?? [])].filter((finger) => finger.side === side) : [];
	return { handFingers, fingerEditing: fingerEdit && handFingers.length > 0, setFingerEdit, exposureProbeRef };
}

/**
 * Fingertip handles for the focused hand. Dragging a tip solves that finger toward the pointer on a
 * camera-facing plane (onSolve("finger", fingerId, point)); release bakes like any IK drag (onDragEnd).
 * A tip the body hides cannot be grabbed (exposureProbeRef, the IK controls' rule); that press goes to IkHandles.
 * The press is claimed in the window capture phase, ahead of IkHandles, so it never reads as an empty
 * click that would drop the hand's focus.
 */
export function FingerHandles({ fingers: handFingers, enabled, onSolve, onDragEnd, exposureProbeRef }) {
	const { camera, gl } = useThree();
	const meshes = useRef(new Map());
	const solveRef = useRef(onSolve), endRef = useRef(onDragEnd);
	useEffect(() => { solveRef.current = onSolve; endRef.current = onDragEnd; });
	const fingers = enabled ? handFingers : [];

	useFrame(() => {
		const along = new THREE.Vector3();
		for (const finger of fingers) {
			const mesh = meshes.current.get(finger.id);
			if (!mesh) continue;
			fingerTip(finger, mesh.position);
			finger.bones[2].getWorldPosition(along);
			mesh.userData.push = along.subVectors(mesh.position, along).normalize().multiplyScalar(TIP_PUSH).clone();
			mesh.position.add(mesh.userData.push);
		}
	});

	const active = fingers.length > 0;
	useEffect(() => {
		if (!active) return undefined;
		const el = gl.domElement, ndc = new THREE.Vector2(), hit = new THREE.Vector3(), ray = new THREE.Raycaster();
		let drag = null;
		const toNdc = (ev) => {
			const rect = el.getBoundingClientRect();
			return ndc.set(((ev.clientX - rect.left) / rect.width) * 2 - 1, -((ev.clientY - rect.top) / rect.height) * 2 + 1);
		};
		const onMove = (ev) => {
			if (!drag) return;
			ray.setFromCamera(toNdc(ev), camera);
			if (!ray.ray.intersectPlane(drag.plane, hit)) return;
			drag.moved = true;
			solveRef.current?.("finger", drag.id, hit.clone().sub(drag.push));
		};
		const release = () => {
			window.removeEventListener("pointermove", onMove, true);
			window.removeEventListener("pointerup", onUp, true);
			window.removeEventListener("pointercancel", onUp, true);
		};
		const onUp = () => {
			const moved = drag?.moved;
			drag = null;
			release();
			if (moved) endRef.current?.();
		};
		const onDown = (ev) => {
			if (ev.button !== 0 || ev.target !== el) return;
			const rect = el.getBoundingClientRect(), centre = new THREE.Vector3(), edge = new THREE.Vector3();
			const right = new THREE.Vector3().setFromMatrixColumn(camera.matrixWorld, 0);
			const toScreen = (point) => { point.project(camera); return [rect.left + ((point.x + 1) / 2) * rect.width, rect.top + ((1 - point.y) / 2) * rect.height]; };
			const candidates = [...meshes.current].filter(([, mesh]) => mesh).map(([id, mesh]) => {
				const [cx, cy] = toScreen(centre.copy(mesh.position));
				const [ex] = toScreen(edge.copy(mesh.position).addScaledVector(right, TIP_R));
				return { id, mesh, gap: Math.hypot(cx - ev.clientX, cy - ev.clientY), reach: Math.abs(ex - cx) + PICK_SLACK_PX };
			});
			const exposed = exposureProbeRef?.current;
			const picked = claimFingertip(ev, candidates, ({ mesh }) => !exposed || exposed(mesh.position, TIP_VISIBILITY_DEPTH));
			if (!picked) return;
			const normal = camera.getWorldDirection(new THREE.Vector3());
			drag = { id: picked.id, moved: false, push: picked.mesh.userData.push?.clone() ?? new THREE.Vector3(), plane: new THREE.Plane().setFromNormalAndCoplanarPoint(normal, picked.mesh.position) };
			window.addEventListener("pointermove", onMove, true);
			window.addEventListener("pointerup", onUp, true);
			window.addEventListener("pointercancel", onUp, true);
		};
		window.addEventListener("pointerdown", onDown, true);
		return () => {
			window.removeEventListener("pointerdown", onDown, true);
			release();
		};
	}, [active, camera, gl, exposureProbeRef]);

	if (!active) return null;
	return (
		<group>
			{fingers.map((finger) => (
				<mesh
					key={finger.id}
					raycast={() => {}}
					ref={(mesh) => {
						if (mesh) { mesh.layers.set(POSER_LAYER); meshes.current.set(finger.id, mesh); }
						else meshes.current.delete(finger.id);
					}}
				>
					<sphereGeometry args={[TIP_R, 20, 14]} />
					<meshStandardMaterial color={handleColor(finger.trackIds[0])} roughness={0.45} metalness={0} />
				</mesh>
			))}
		</group>
	);
}

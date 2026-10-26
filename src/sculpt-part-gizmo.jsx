// The selected sculpt part's gizmo on the turntable (#740 S8). three.js
// TransformControls drives a proxy that sits in the part's PARENT frame, so
// its position, rotation and scale read straight back as the recipe's values
// (sculpt-part-edit.js). While a drag runs, the meshes follow a preview (no
// geometry rebuild); the drag's end writes one object.sculpt edit, one undo.
// A refused edit puts the meshes back and the reason shows under the tree.
// The gizmo lives on SCULPT_LAYER alone: the shot preview and exports never
// see it, and its picks use the main pane's rect, as part picking does.
import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { useFrame, useThree } from "@react-three/fiber";
import * as THREE from "three";
import { TransformControls } from "three/examples/jsm/controls/TransformControls.js";
import { SCULPT_LAYER } from "./sculpt-mode.js";
import { partLocalOf, partParentWorld, previewSculptParts, sculptPartEdit, sculptPartFrame, uniformScale } from "./sculpt-part-edit.js";

const MODES = { move: "translate", rotate: "rotate", scale: "scale" };
const DEG = Math.PI / 180;

function partMeshes(nodes) {
	const meshes = [];
	for (const node of nodes) node.traverse((child) => { if (child.isMesh && child.userData?.sculptPart) meshes.push(child); });
	return meshes;
}

export function SculptPartGizmo({ camera, orbitRef, nodesRef, gizmoRef, recipe, parts }) {
	const { gl, scene, invalidate } = useThree();
	const selected = parts?.selected ?? null;
	const frame = useMemo(() => sculptPartFrame(recipe, selected), [recipe, selected]);
	const [rig] = useState(() => {
		const base = new THREE.Object3D();
		base.matrixAutoUpdate = false;
		const proxy = new THREE.Object3D();
		base.add(proxy);
		return { base, proxy };
	});
	const live = useRef(null);
	useLayoutEffect(() => { live.current = { recipe, selected, commit: parts?.commit }; });
	// { meshes: [[mesh, position, quaternion, scale]] } while a drag runs; { held } after a write until its recipe lands.
	const dragRef = useRef(null);

	useEffect(() => {
		if (!camera) return undefined;
		const made = new TransformControls(camera, gl.domElement);
		const canvas = gl.domElement, orbit = orbitRef;
		// The sculpt camera spans the main pane, not the whole canvas.
		made._getPointer = (event) => {
			const pane = (document.querySelector(".vp-pane.vp-main") ?? canvas).getBoundingClientRect();
			return { x: ((event.clientX - pane.left) / pane.width) * 2 - 1, y: -((event.clientY - pane.top) / pane.height) * 2 + 1, button: event.button };
		};
		const ray = made.getRaycaster();
		const mask = ray.layers.mask;
		ray.layers.set(SCULPT_LAYER);
		const helper = made.getHelper();
		helper.traverse((node) => node.layers.set(SCULPT_LAYER));
		scene.add(rig.base, helper);
		let shift = false;
		const restore = () => {
			for (const [mesh, position, quaternion, scale] of dragRef.current?.meshes ?? []) {
				mesh.position.copy(position);
				mesh.quaternion.copy(quaternion);
				mesh.scale.copy(scale);
			}
			dragRef.current = null;
			invalidate();
		};
		const editNow = () => {
			const { recipe: current, selected: part } = live.current;
			if (made.mode === "scale" && shift) rig.proxy.scale.fromArray(uniformScale(rig.proxy.scale.toArray()));
			return sculptPartEdit(current, part, partLocalOf(rig.proxy));
		};
		const onDown = () => {
			dragRef.current = { meshes: partMeshes(nodesRef.current).map((mesh) => [mesh, mesh.position.clone(), mesh.quaternion.clone(), mesh.scale.clone()]) };
		};
		const onChange = () => {
			if (!dragRef.current?.meshes) return;
			const preview = previewSculptParts(live.current.recipe, editNow());
			const matrix = new THREE.Matrix4();
			for (const [mesh] of dragRef.current.meshes) {
				const entry = preview.get(mesh.userData.sculptPart);
				if (!entry) continue;
				matrix.fromArray(entry.matrix).decompose(mesh.position, mesh.quaternion, mesh.scale);
				mesh.scale.fromArray(entry.ratio);
			}
			invalidate();
		};
		const onUp = () => {
			if (!dragRef.current?.meshes) return;
			const edit = editNow();
			if (edit && live.current.commit?.(edit)) dragRef.current = { held: true };
			else restore();
		};
		const onDragging = (event) => {
			if (orbitRef.current) orbitRef.current.enabled = !event.value;
			invalidate();
		};
		// A press on a handle must not also start an orbit: the orbit is off before its own listener runs.
		const onPress = () => { if (made.axis !== null && orbitRef.current) orbitRef.current.enabled = false; };
		const onRelease = () => { if (!made.dragging && orbitRef.current) orbitRef.current.enabled = true; };
		const onShift = (event) => { shift = event.shiftKey; };
		made.addEventListener("mouseDown", onDown);
		made.addEventListener("objectChange", onChange);
		made.addEventListener("mouseUp", onUp);
		made.addEventListener("dragging-changed", onDragging);
		made.addEventListener("change", invalidate);
		canvas.addEventListener("pointerdown", onPress, true);
		window.addEventListener("pointerup", onRelease);
		window.addEventListener("pointermove", onShift, true);
		window.addEventListener("keydown", onShift, true);
		window.addEventListener("keyup", onShift, true);
		gizmoRef.current = made;
		return () => {
			if (dragRef.current?.meshes) restore();
			canvas.removeEventListener("pointerdown", onPress, true);
			window.removeEventListener("pointerup", onRelease);
			window.removeEventListener("pointermove", onShift, true);
			window.removeEventListener("keydown", onShift, true);
			window.removeEventListener("keyup", onShift, true);
			if (orbit.current) orbit.current.enabled = true;
			gizmoRef.current = null;
			made.detach();
			made.dispose();
			scene.remove(rig.base, helper);
			ray.layers.mask = mask;
		};
	}, [camera, gl, scene, rig, nodesRef, orbitRef, gizmoRef, invalidate]);

	// Declared after the controls' own effect, so they exist when these run.
	useEffect(() => { gizmoRef.current?.setMode(MODES[parts?.tool] ?? "translate"); invalidate(); }, [camera, gizmoRef, parts?.tool, invalidate]);
	// A new recipe (the write landed, or any other edit) or selection ends the hold.
	useEffect(() => {
		const controls = gizmoRef.current;
		if (!controls) return;
		if (dragRef.current?.held) dragRef.current = null;
		if (frame) controls.attach(rig.proxy);
		else controls.detach();
		invalidate();
	}, [camera, gizmoRef, frame, rig, invalidate]);

	// Between drags the proxy follows the part where it is drawn now.
	useFrame(() => {
		const controls = gizmoRef.current;
		if (!controls || !frame || controls.dragging || dragRef.current) return;
		const mesh = partMeshes(nodesRef.current).find((node) => node.userData.sculptPart === frame.meshId);
		if (!mesh?.parent) return;
		mesh.parent.updateWorldMatrix(true, false);
		rig.base.matrix.copy(partParentWorld(mesh.parent.matrixWorld, frame));
		rig.base.updateMatrixWorld(true);
		rig.proxy.position.fromArray(frame.position);
		rig.proxy.rotation.set(frame.rotation[0] * DEG, frame.rotation[1] * DEG, frame.rotation[2] * DEG, "XYZ");
		rig.proxy.scale.set(1, 1, 1);
		rig.proxy.updateMatrixWorld(true);
	});
	return null;
}

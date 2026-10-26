// The selected sculpt part's highlight on the turntable (#740 S7): per part
// mesh, an inverted hull pushed out along the normals and drawn back-faces
// only (a rim of the selection colour), and a thin see-through tint over its
// visible surface, which still reads where the part sinks into another. The
// shells live on SCULPT_LAYER alone: the sculpt camera sees them, the shot
// preview and every export never do.
import { useEffect, useState } from "react";
import { useFrame, useThree } from "@react-three/fiber";
import * as THREE from "three";
import { SCULPT_LAYER } from "./sculpt-mode.js";
import { sculptPartMeshIds } from "./sculpt-pick.js";

// The panel's selection colour (--select), so the part and its tree row match;
// the dark theme's value stands in until the stylesheet is read.
const OUTLINE_COLOR = "#e8a33d";
const HEX_COLOR = /^#[0-9a-f]{6}$/i;
const RIM_WIDTH = 0.02;
const TINT_WIDTH = 0.002;

function inflated(width, options) {
	const material = new THREE.MeshBasicMaterial({ color: OUTLINE_COLOR, ...options });
	material.onBeforeCompile = (shader) => {
		shader.vertexShader = shader.vertexShader.replace("#include <begin_vertex>", `#include <begin_vertex>\n\ttransformed += normal * ${width};`);
	};
	return material;
}

function highlightMaterials() {
	return [
		inflated(RIM_WIDTH, { side: THREE.BackSide }),
		inflated(TINT_WIDTH, { transparent: true, opacity: 0.3, depthWrite: false }),
	];
}

function shellFor(source, material) {
	const shell = source.isInstancedMesh ? new THREE.InstancedMesh(source.geometry, material, source.count) : new THREE.Mesh(source.geometry, material);
	if (source.isInstancedMesh) shell.instanceMatrix = source.instanceMatrix;
	shell.userData = { source, noInk: true };
	shell.matrixAutoUpdate = false;
	shell.frustumCulled = false;
	// Never a pick target: a click goes through the rim to the part.
	shell.raycast = () => {};
	shell.layers.set(SCULPT_LAYER);
	return shell;
}

export function SculptPartOutline({ nodesRef, selected }) {
	const invalidate = useThree((state) => state.invalidate);
	const [group] = useState(() => new THREE.Group());
	const [materials] = useState(highlightMaterials);
	useEffect(() => () => { for (const material of materials) material.dispose(); }, [materials]);
	const ids = sculptPartMeshIds(selected);
	const key = ids.join(" ");
	useEffect(() => {
		const css = getComputedStyle(document.documentElement).getPropertyValue("--select").trim();
		for (const material of materials) material.color.set(HEX_COLOR.test(css) ? css : OUTLINE_COLOR);
		invalidate();
	}, [key, materials, invalidate]);
	// The sculpt rebuilds its meshes when the recipe changes, so the shells
	// follow whichever meshes carry the selected ids this frame.
	useFrame(() => {
		const sources = [];
		for (const node of nodesRef.current) node.traverse((child) => { if (child.isMesh && ids.includes(child.userData?.sculptPart)) sources.push(child); });
		const shells = group.children;
		if (shells.length !== sources.length * materials.length || shells.some((shell, index) => shell.userData.source !== sources[Math.floor(index / materials.length)])) {
			group.clear();
			for (const source of sources) for (const material of materials) group.add(shellFor(source, material));
		}
		for (const shell of group.children) shell.matrix.copy(shell.userData.source.matrixWorld);
	});
	return <primitive object={group} />;
}

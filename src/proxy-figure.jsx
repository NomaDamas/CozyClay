import { memo, useEffect, useMemo } from "react";
import * as THREE from "three";
import { proxyFacingMark } from "./facing-marks.js";
import { defaultCharacterTint } from "./app-stage.jsx";

const BODY_RADIUS = 0.22;
const BODY_HEIGHT = 1.45;
const HEAD_RADIUS = 0.12;

export const ProxyFigure = memo(function ProxyFigure({
	position,
	rot,
	tint,
	scale = 1,
	posture = "stand",
	pickId,
	selected,
}) {
	const bodyHeight = posture === "sit" ? BODY_HEIGHT * 0.6 : BODY_HEIGHT;
	const headY = bodyHeight + 0.13;
	const model = useMemo(() => {
		const bodyMaterial = new THREE.MeshStandardMaterial({
			color: tint ?? defaultCharacterTint({ model: "proxy-figure" }, 0),
			roughness: 0.66,
			metalness: 0,
			envMapIntensity: 0.35,
		});
		const markMaterial = new THREE.MeshStandardMaterial({ color: "#1C1C1C", roughness: 0.7, metalness: 0 });
		const group = new THREE.Group();
		const body = new THREE.Mesh(new THREE.CapsuleGeometry(BODY_RADIUS, bodyHeight - BODY_RADIUS * 2, 12, 20), bodyMaterial);
		body.position.y = bodyHeight / 2;
		body.castShadow = true;
		body.receiveShadow = true;
		body.frustumCulled = false;
		group.add(body);
		const head = new THREE.Mesh(new THREE.SphereGeometry(HEAD_RADIUS, 16, 12), bodyMaterial);
		head.position.y = headY;
		head.castShadow = true;
		head.receiveShadow = true;
		head.frustumCulled = false;
		const mark = proxyFacingMark(markMaterial);
		mark.position.y += headY;
		group.add(mark);
		group.add(head);
		return group;
	}, [bodyHeight, headY, tint]);
	useEffect(() => () => {
		const materials = new Set();
		model.traverse(node => {
			if (!node.isMesh) return;
			node.geometry.dispose();
			materials.add(node.material);
		});
		for (const material of materials) material.dispose();
	}, [model]);

	return (
		<group
			position={position}
			rotation={[0, (rot * Math.PI) / 180 + (posture === "lie" ? Math.PI : 0), 0]}
			scale={scale}
			userData={pickId ? { characterPick: pickId, selected: !!selected } : undefined}
		>
			<group position={posture === "lie" ? [0, BODY_RADIUS, 0] : [0, 0, 0]} rotation={posture === "lie" ? [-Math.PI / 2, 0, 0] : [0, 0, 0]}>
				<primitive object={model} />
			</group>
		</group>
	);
});


// Sculpt mode (#739): the isolated turntable the main viewport shows, and the
// inspector host the Sculpt panel mounts into.
import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { useFrame, useThree } from "@react-three/fiber";
import { OrbitControls, PerspectiveCamera } from "@react-three/drei";
import * as THREE from "three";
import { SCULPT_LAYER, isolatedObjectIds, sculptFraming } from "./sculpt-mode.js";
import { pickSculptPart } from "./sculpt-pick.js";
import { SculptPartOutline } from "./sculpt-part-outline.jsx";

const SCULPT_FOV = 35;
// Where a new sculpt lands (object.sculpt without placement): the origin.
const EMPTY_TARGET = { x: 0, y: 0, z: 0, rot: 0 };
const EMPTY_SIZE = { width: 1, height: 1.2, depth: 1 };
// The turntable is set furniture inside the WebGL scene, so its tones are
// three.js colours chosen against the stage background (grid-view.js).
const TURNTABLE_TONES = {
	dark: { floor: "#2c2e34", ring: "#4a4d56" },
	light: { floor: "#d6d8de", ring: "#b4b7c0" },
};

function findObjectNodes(scene, ids) {
	const found = [];
	if (ids.length) scene.traverse((node) => { if (ids.includes(node.userData?.sceneObjectId)) found.push(node); });
	return found;
}

/**
 * The glass shell's dock floats over the bottom of the main pane, so the
 * turntable is framed for the part above it: a lens shift (a view offset whose
 * principal point is the visible region's centre) with the lens widened so
 * that region spans SCULPT_FOV. DualRender sets aspect = pane w/h every frame,
 * so the full frame keeps that pixel aspect.
 */
function fitVisiblePane(camera) {
	const pane = document.querySelector(".vp-pane.vp-main")?.getBoundingClientRect();
	if (!pane || pane.height < 2 || pane.width < 2) return;
	const dock = document.querySelector(".bottom-window")?.getBoundingClientRect();
	const covered = dock && dock.left < pane.right && dock.right > pane.left && dock.top < pane.bottom
		? Math.max(0, pane.bottom - dock.top) : 0;
	const height = pane.height, width = pane.width;
	const visible = Math.max(height * 0.4, height - covered);
	if (visible >= height - 1) {
		if (camera.view?.enabled) camera.clearViewOffset();
		camera.fov = SCULPT_FOV;
		return;
	}
	const fullHeight = 2 * height - visible;
	const fullWidth = (width * fullHeight) / height;
	camera.fov = (2 * Math.atan(Math.tan(((SCULPT_FOV / 2) * Math.PI) / 180) * (fullHeight / visible)) * 180) / Math.PI;
	camera.setViewOffset(fullWidth, fullHeight, (fullWidth - width) / 2, height - visible, width, height);
}

function attached(node, scene) {
	for (let current = node; current; current = current.parent) if (current === scene) return true;
	return false;
}

/**
 * The sculpt camera, its orbit and the turntable. Rendering is isolated by
 * layer, never by record: each frame the target's own meshes join
 * SCULPT_LAYER and the sculpt camera sees that layer alone, so every other
 * object, the cast and the set drop out of the main pane while the shot
 * preview (shot camera, layer 0) still draws the scene with the sculpt in it.
 * Unmounting (leaving the mode by any route) takes the layer back off.
 */
/**
 * A lump of clay that kneads itself on the turntable while a run has no sculpt
 * yet: squash and stretch, a slow turn. It says "working" in the viewport.
 */
function ClayLump({ at }) {
	const ref = useRef(null);
	useFrame(({ clock }) => {
		const mesh = ref.current;
		if (!mesh) return;
		const t = clock.getElapsedTime();
		const squash = Math.sin(t * 3.2) * 0.12;
		mesh.scale.set(1 + squash, 1 - squash, 1 + squash * 0.6);
		mesh.rotation.y = t * 0.8;
		mesh.position.y = at[1] + 0.32 * (1 - squash);
	});
	return (
		<mesh ref={ref} position={[at[0], at[1] + 0.32, at[2]]} castShadow>
			<icosahedronGeometry args={[0.32, 5]} />
			<meshStandardMaterial color="#c99a6e" roughness={0.9} metalness={0} />
		</mesh>
	);
}

// How long a changed part glows after an edit lands.
const FLASH_MS = 1400;
// A press that travels further than this is an orbit, not a click.
const CLICK_SLOP_PX = 4;

export function SculptTurntable({ camRef, objects, target, size, view, light = false, busy = false, changedParts = null, parts = null }) {
	const { scene, raycaster, invalidate, gl } = useThree();
	const [camera, setCamera] = useState(null);
	// The key light aims at the sculpt; its target must sit in the scene graph.
	const [lightTarget] = useState(() => new THREE.Object3D());
	const controlsRef = useRef(null);
	const furnitureRef = useRef(null);
	const nodesRef = useRef([]);
	const isolated = isolatedObjectIds(objects, target?.id);
	const taggedRef = useRef(new Set());
	const framing = sculptFraming(target ?? EMPTY_TARGET, target ? size : EMPTY_SIZE, view.view, SCULPT_FOV);
	const floorRadius = Math.max(0.9, framing.radius * 1.1);
	const tones = light ? TURNTABLE_TONES.light : TURNTABLE_TONES.dark;
	// Refit on a new target, a view button, or a sculpt that grew or shrank by
	// a step while a run lands; an orbit in between is the operator's own.
	const sizeStep = Math.round((size?.height ?? 0) * 4);
	// While a run works the turntable turns slowly; the operator's first grab stops it for that run.
	const [grabbed, setGrabbed] = useState(false);
	useEffect(() => { if (busy) setGrabbed(false); }, [busy]);
	const spinning = busy && !grabbed;
	// The canvas draws on demand; a spinning turntable and a kneading lump need frames.
	useEffect(() => {
		if (!spinning && !(busy && !target)) return undefined;
		let frame = requestAnimationFrame(function tick() { invalidate(); frame = requestAnimationFrame(tick); });
		return () => cancelAnimationFrame(frame);
	}, [spinning, busy, target, invalidate]);
	const flashRef = useRef({ nonce: null, startedAt: 0, ids: null });
	useEffect(() => {
		if (!changedParts?.nonce || changedParts.nonce === flashRef.current.nonce) return undefined;
		flashRef.current = { nonce: changedParts.nonce, startedAt: performance.now(), ids: changedParts.ids };
		let frame = requestAnimationFrame(function tick() {
			invalidate();
			if (performance.now() - flashRef.current.startedAt < FLASH_MS + 100) frame = requestAnimationFrame(tick);
		});
		return () => cancelAnimationFrame(frame);
	}, [changedParts?.nonce, invalidate]);

	useLayoutEffect(() => {
		furnitureRef.current?.traverse((node) => node.layers.set(SCULPT_LAYER));
	});

	useEffect(() => {
		const controls = controlsRef.current;
		if (!camera || !controls) return;
		camera.position.set(...framing.position);
		controls.target.set(...framing.target);
		controls.update();
		invalidate();
		// eslint-disable-next-line react-hooks/exhaustive-deps
	}, [camera, target?.id, view.nonce, sizeStep]);

	// Picks follow the picture: nothing hidden can be clicked through.
	useEffect(() => {
		const mask = raycaster.layers.mask;
		raycaster.layers.set(SCULPT_LAYER);
		return () => { raycaster.layers.mask = mask; };
	}, [raycaster]);

	// Part picking (#740 S7): a left click (not an orbit drag) on the sculpt
	// selects the part under it, on empty space clears. The pointer maps into
	// the main pane, the rect the sculpt camera's projection spans.
	const partsRef = useRef(parts);
	partsRef.current = parts;
	const [pickRay] = useState(() => { const ray = new THREE.Raycaster(); ray.layers.set(SCULPT_LAYER); return ray; });
	useEffect(() => {
		if (!camera) return undefined;
		const canvas = gl.domElement;
		let down = null;
		const onDown = (event) => { down = event.button === 0 && event.target === canvas ? [event.clientX, event.clientY] : null; };
		const onUp = (event) => {
			const start = down;
			down = null;
			if (!start || !partsRef.current?.onSelect || Math.hypot(event.clientX - start[0], event.clientY - start[1]) > CLICK_SLOP_PX) return;
			const pane = (document.querySelector(".vp-pane.vp-main") ?? canvas).getBoundingClientRect();
			if (pane.width < 2 || pane.height < 2) return;
			camera.updateMatrixWorld();
			pickRay.setFromCamera(new THREE.Vector2(((event.clientX - pane.left) / pane.width) * 2 - 1, -((event.clientY - pane.top) / pane.height) * 2 + 1), camera);
			partsRef.current.onSelect(pickSculptPart(pickRay, nodesRef.current));
		};
		canvas.addEventListener("pointerdown", onDown);
		window.addEventListener("pointerup", onUp);
		return () => { canvas.removeEventListener("pointerdown", onDown); window.removeEventListener("pointerup", onUp); };
	}, [camera, gl, pickRay]);

	useEffect(() => () => {
		for (const node of taggedRef.current) node.layers.disable(SCULPT_LAYER);
		taggedRef.current = new Set();
		invalidate();
	}, [invalidate]);

	// Priority 0 runs before DualRender (priority 1) draws the frame.
	useFrame(() => {
		if (camera) {
			camera.layers.set(SCULPT_LAYER);
			fitVisiblePane(camera);
		}
		let nodes = nodesRef.current;
		const stale = nodes.length !== isolated.length
			|| nodes.some((node) => !isolated.includes(node.userData?.sceneObjectId) || !attached(node, scene));
		if (stale) nodes = findObjectNodes(scene, isolated);
		nodesRef.current = nodes;
		const tagged = new Set();
		for (const node of nodes) node.traverse((child) => {
			// Editor chrome under the object (its selection cage) is not on layer 0.
			if (!child.layers.isEnabled(0)) return;
			child.layers.enable(SCULPT_LAYER);
			tagged.add(child);
		});
		for (const old of taggedRef.current) if (!tagged.has(old)) old.layers.disable(SCULPT_LAYER);
		taggedRef.current = tagged;
		// The parts an edit just touched glow warm and fade (each part owns its material).
		const flash = flashRef.current;
		if (flash.nonce !== null) {
			const age = performance.now() - flash.startedAt;
			const glow = age < FLASH_MS ? Math.sin(Math.min(1, age / FLASH_MS) * Math.PI) * 0.55 : 0;
			for (const node of nodes) node.traverse((child) => {
				const part = child.userData?.sculptPart;
				if (!part || !child.material?.emissive) return;
				const hit = flash.ids === "all" || flash.ids?.includes(part);
				child.material.emissive.setRGB(hit ? glow : 0, hit ? glow * 0.62 : 0, hit ? glow * 0.25 : 0);
			});
			if (age >= FLASH_MS) flash.nonce = null;
		}
	});

	return (
		<>
			<PerspectiveCamera ref={(node) => { camRef.current = node; setCamera(node); }} makeDefault fov={SCULPT_FOV} near={0.05} far={100} />
			{camera && <OrbitControls ref={controlsRef} camera={camera} enableDamping={false} minDistance={0.3} maxDistance={40} autoRotate={spinning} autoRotateSpeed={1.4}
				onStart={() => setGrabbed(true)} onChange={() => invalidate()} />}
			<SculptPartOutline nodesRef={nodesRef} selected={parts?.selected ?? null} />
			<group ref={furnitureRef}>
				<hemisphereLight args={["#ffffff", "#3a3c42", 0.9]} />
				<primitive object={lightTarget} position={framing.target} />
				<directionalLight
					target={lightTarget}
					position={[framing.target[0] + 2.5, framing.floorY + 5, framing.target[2] + 3.5]}
					intensity={1.6}
					castShadow
					shadow-mapSize={[1024, 1024]}
					shadow-camera-left={-floorRadius}
					shadow-camera-right={floorRadius}
					shadow-camera-top={floorRadius}
					shadow-camera-bottom={-floorRadius}
				/>
				{busy && !target && <ClayLump at={[framing.target[0], framing.floorY, framing.target[2]]} />}
				<mesh rotation-x={-Math.PI / 2} position={[framing.target[0], framing.floorY + 0.001, framing.target[2]]} receiveShadow userData={{ noInk: true }}>
					<circleGeometry args={[floorRadius, 96]} />
					<meshStandardMaterial color={tones.floor} roughness={0.95} metalness={0} />
				</mesh>
				<mesh rotation-x={-Math.PI / 2} position={[framing.target[0], framing.floorY + 0.002, framing.target[2]]} userData={{ noInk: true }}>
					<ringGeometry args={[floorRadius * 0.985, floorRadius, 96]} />
					<meshBasicMaterial color={tones.ring} />
				</mesh>
			</group>
		</>
	);
}

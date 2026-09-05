/**
 * Set props: low-poly clay maquettes to block against.
 *
 * The set is a bare room and a figure; a shot that needs "something in the
 * world" (a car to lean on, to walk past, to frame behind glass) has nothing
 * to work with. These props are built from primitives in the same clay style
 * as the Room and the character tint, so the whole frame stays one
 * consistent maquette. Dimensions are metres against real vehicle sizes so
 * the 1.8 m figure keeps honest scale.
 */

import { useEffect, useMemo, useRef, useState } from "react";
import { useFrame } from "@react-three/fiber";
import { objectTransformAt } from "./object-path.js";
import * as THREE from "three";
import { GIZMO_LAYER } from "./dualview.jsx";
import { CUTOUT_KIND } from "./scene-objects.js";
import { subscribeToAssetTexture } from "./scene-asset-cache.js";

const CLAY_CAR = "#d98770";
const CLAY_CAR_TOP = "#e49a84";
const CLAY_TIRE = "#41484c";
const CLAY_RIM = "#7c8588";
const CLAY_GLASS = "#55697a";
const CLAY_PLANE = "#7896a4";
const CLAY_PLANE_TRIM = "#e1a849";
const CLAY_CHAIR = "#b9855d";
const CLAY_CHAIR_LIGHT = "#cf9d72";

function Wheel({ position }) {
	return (
		<group position={position}>
			<mesh rotation={[0, 0, Math.PI / 2]}>
				<cylinderGeometry args={[0.33, 0.33, 0.24, 20]} />
				<meshStandardMaterial color={CLAY_TIRE} roughness={0.95} />
			</mesh>
			<mesh rotation={[0, 0, Math.PI / 2]}>
				<cylinderGeometry args={[0.17, 0.17, 0.26, 16]} />
				<meshStandardMaterial color={CLAY_RIM} roughness={0.5} metalness={0.35} />
			</mesh>
		</group>
	);
}
/**
 * A generic 5-door-ish sedan silhouette, ~4.5 m long. Origin at the centre
 * of the footprint, +Z forward.
 */
export function Car({ position = [0, 0, 0], rotY = 0, color = CLAY_CAR, topColor = CLAY_CAR_TOP }) {
	return (
		<group position={position} rotation={[0, rotY, 0]}>
			{/* lower body */}
			<mesh position={[0, 0.62, 0]}>
				<boxGeometry args={[1.78, 0.62, 4.45]} />
				<meshStandardMaterial color={color} roughness={0.55} metalness={0.25} />
			</mesh>
			{/* cabin: centred over the wheelbase, not stacked on the tail */}
			<mesh position={[0, 1.12, -0.15]}>
				<boxGeometry args={[1.58, 0.5, 2.2]} />
				<meshStandardMaterial color={topColor} roughness={0.5} metalness={0.2} />
			</mesh>
			{/* greenhouse glass band */}
			<mesh position={[0, 1.14, -0.15]}>
				<boxGeometry args={[1.62, 0.3, 1.9]} />
				<meshStandardMaterial color={CLAY_GLASS} roughness={0.15} metalness={0.6} />
			</mesh>
			{/* windshield slope */}
			<mesh position={[0, 1.05, 0.95]} rotation={[0.5, 0, 0]}>
				<boxGeometry args={[1.56, 0.42, 0.08]} />
				<meshStandardMaterial color={CLAY_GLASS} roughness={0.15} metalness={0.6} />
			</mesh>
			{/* rear glass slope */}
			<mesh position={[0, 1.05, -1.25]} rotation={[-0.55, 0, 0]}>
				<boxGeometry args={[1.56, 0.42, 0.08]} />
				<meshStandardMaterial color={CLAY_GLASS} roughness={0.15} metalness={0.6} />
			</mesh>
			<Wheel position={[0.82, 0.33, 1.45]} />
			<Wheel position={[-0.82, 0.33, 1.45]} />
			<Wheel position={[0.82, 0.33, -1.45]} />
			<Wheel position={[-0.82, 0.33, -1.45]} />
		</group>
	);
}

/** Compact single-engine propeller plane, ~3.4 m wingspan and +Z forward. */
export function SmallPlane({ position = [0, 0, 0], rotY = 0 }) {
	return (
		<group position={position} rotation={[0, rotY, 0]}>
			{/* fuselage and tapered nose */}
			<mesh position={[0, 0.76, 0]} rotation={[Math.PI / 2, 0, 0]}>
				<cylinderGeometry args={[0.23, 0.31, 2.75, 16]} />
				<meshStandardMaterial color={CLAY_PLANE} roughness={0.58} metalness={0.18} />
			</mesh>
			<mesh position={[0, 0.76, 1.55]} rotation={[Math.PI / 2, 0, 0]}>
				<coneGeometry args={[0.23, 0.55, 16]} />
				<meshStandardMaterial color={CLAY_PLANE_TRIM} roughness={0.52} metalness={0.2} />
			</mesh>

			{/* main wing and tail plane */}
			<mesh position={[0, 0.73, 0.15]}>
				<boxGeometry args={[3.4, 0.09, 0.58]} />
				<meshStandardMaterial color={CLAY_PLANE} roughness={0.62} metalness={0.14} />
			</mesh>
			<mesh position={[0, 0.84, -1.18]}>
				<boxGeometry args={[1.45, 0.07, 0.38]} />
				<meshStandardMaterial color={CLAY_PLANE_TRIM} roughness={0.62} metalness={0.12} />
			</mesh>
			<mesh position={[0, 1.08, -1.2]} rotation={[0.22, 0, 0]}>
				<boxGeometry args={[0.08, 0.62, 0.48]} />
				<meshStandardMaterial color={CLAY_PLANE} roughness={0.62} metalness={0.12} />
			</mesh>

			{/* cockpit canopy */}
			<mesh position={[0, 1.02, 0.42]} scale={[0.62, 0.46, 0.9]}>
				<sphereGeometry args={[0.42, 16, 10, 0, Math.PI * 2, 0, Math.PI / 2]} />
				<meshStandardMaterial color={CLAY_GLASS} roughness={0.16} metalness={0.55} />
			</mesh>

			{/* propeller hub and blades */}
			<group position={[0, 0.76, 1.86]}>
				<mesh rotation={[Math.PI / 2, 0, 0]}>
					<cylinderGeometry args={[0.11, 0.11, 0.2, 12]} />
					<meshStandardMaterial color={CLAY_RIM} roughness={0.45} metalness={0.4} />
				</mesh>
				<mesh position={[0, 0, 0.12]} rotation={[0, 0, 0.28]}>
					<boxGeometry args={[1.25, 0.08, 0.06]} />
					<meshStandardMaterial color={CLAY_TIRE} roughness={0.8} />
				</mesh>
			</group>

			{/* simple landing gear */}
			{[-0.55, 0.55].map((x) => (
				<group key={x} position={[x, 0.2, 0.15]}>
					<mesh position={[0, 0.24, 0]} rotation={[0, 0, x < 0 ? -0.35 : 0.35]}>
						<boxGeometry args={[0.045, 0.55, 0.045]} />
						<meshStandardMaterial color={CLAY_RIM} roughness={0.65} metalness={0.3} />
					</mesh>
					<mesh rotation={[0, 0, Math.PI / 2]}>
						<cylinderGeometry args={[0.16, 0.16, 0.09, 14]} />
						<meshStandardMaterial color={CLAY_TIRE} roughness={0.95} />
					</mesh>
				</group>
			))}
		</group>
	);
}

export function Chair({ position = [0, 0, 0], rotY = 0 }) {
	const legPositions = [
		[-0.24, 0.23, -0.22],
		[0.24, 0.23, -0.22],
		[-0.24, 0.23, 0.22],
		[0.24, 0.23, 0.22],
	];
	return (
		<group position={position} rotation={[0, rotY, 0]} scale={0.9}>
			<mesh position={[0, 0.49, 0]} castShadow receiveShadow>
				<boxGeometry args={[0.6, 0.12, 0.58]} />
				<meshStandardMaterial color={CLAY_CHAIR_LIGHT} roughness={0.86} />
			</mesh>
			{legPositions.map((leg, index) => (
				<mesh key={index} position={leg} castShadow receiveShadow>
					<boxGeometry args={[0.09, 0.46, 0.09]} />
					<meshStandardMaterial color={CLAY_CHAIR} roughness={0.9} />
				</mesh>
			))}
			<mesh position={[-0.24, 0.92, -0.245]} castShadow receiveShadow>
				<boxGeometry args={[0.09, 0.86, 0.09]} />
				<meshStandardMaterial color={CLAY_CHAIR} roughness={0.9} />
			</mesh>
			<mesh position={[0.24, 0.92, -0.245]} castShadow receiveShadow>
				<boxGeometry args={[0.09, 0.86, 0.09]} />
				<meshStandardMaterial color={CLAY_CHAIR} roughness={0.9} />
			</mesh>
			<mesh position={[0, 1.08, -0.245]} castShadow receiveShadow>
				<boxGeometry args={[0.52, 0.38, 0.1]} />
				<meshStandardMaterial color={CLAY_CHAIR_LIGHT} roughness={0.86} />
			</mesh>
		</group>
	);
}

/**
 * The creatable primitives, Unity's 3D Object menu in clay. Each one is built
 * with its base on the local floor (y = 0), so an object's `y` reads as height
 * above the deck rather than "half of me is underground".
 */
function Primitive({ kind, color }) {
	const material = <meshStandardMaterial color={color} roughness={0.82} side={kind === "plane" ? THREE.DoubleSide : THREE.FrontSide} />;
	if (kind === "sphere") {
		return (
			<mesh position={[0, 0.5, 0]} castShadow receiveShadow>
				<sphereGeometry args={[0.5, 28, 18]} />
				{material}
			</mesh>
		);
	}
	if (kind === "capsule") {
		return (
			<mesh position={[0, 0.7, 0]} castShadow receiveShadow>
				<capsuleGeometry args={[0.35, 0.7, 6, 18]} />
				{material}
			</mesh>
		);
	}
	if (kind === "cylinder") {
		return (
			<mesh position={[0, 0.5, 0]} castShadow receiveShadow>
				<cylinderGeometry args={[0.5, 0.5, 1, 26]} />
				{material}
			</mesh>
		);
	}
	if (kind === "cone") {
		return (
			<mesh position={[0, 0.5, 0]} castShadow receiveShadow>
				<coneGeometry args={[0.5, 1, 26]} />
				{material}
			</mesh>
		);
	}
	if (kind === "plane") {
		return (
			<mesh position={[0, 0.004, 0]} rotation={[-Math.PI / 2, 0, 0]} receiveShadow>
				<planeGeometry args={[2, 2]} />
				{material}
			</mesh>
		);
	}
	return (
		<mesh position={[0, 0.5, 0]} castShadow receiveShadow>
			<boxGeometry args={[1, 1, 1]} />
			{material}
		</mesh>
	);
}

/** The texture behind an `assetId`, or null while it loads (or forever, if the
 * picture is gone). Subscribing rather than loading here means the same
 * picture on two cards is one decode. */
function useAssetTexture(assetId) {
	const [texture, setTexture] = useState(null);
	useEffect(() => {
		setTexture(null);
		if (!assetId) return undefined;
		return subscribeToAssetTexture(assetId, setTexture);
	}, [assetId]);
	return texture;
}

/** The placeholder tint for a card whose picture has not arrived (or has gone
 * missing): blockout grey, because that is exactly what it is again. */
const MISSING_CUTOUT = "#c2c6c8";

/**
 * A cutout: an imported picture standing on a card, the standee a blockout
 * gets instead of a modelled prop.
 *
 * The card is built base-on-the-floor like every primitive, and sized in
 * metres by the record — `footprint.width` is already derived from the
 * measured height and the picture's aspect, so the geometry never has to do
 * that arithmetic again.
 *
 * Alpha-CUT, not blended: `alphaTest` keeps the card writing depth, which is
 * what lets the ink pass, the shadows and the grey boxes all agree about what
 * is in front of what. A blended card would sort by object and swim through
 * the set.
 *
 * But a bare alpha test is a decision per pixel, so the silhouette comes out
 * as a staircase — and the matte's own soft edge is thrown away at the
 * threshold. `alphaToCoverage` spends the MSAA samples the canvas already has
 * on that edge instead: partial alpha becomes partial coverage, so the outline
 * is resolved by the same antialiasing that smooths every other edge in the
 * frame, and depth is still written. The test then only has to reject what is
 * genuinely nothing (0.15), rather than choosing a side for every half-lit
 * pixel — which is also what keeps a thin structure alive as the card recedes
 * and its alpha is averaged down by the mip chain.
 */
function Cutout({ object }) {
	const texture = useAssetTexture(object.assetId);
	const width = object.footprint?.width ?? 1;
	const height = object.height ?? 1;
	return (
		<mesh position={[0, height / 2, 0]} castShadow receiveShadow userData={{ cutoutTexture: texture ?? null }}>
			<planeGeometry args={[width, height]} />
			<meshStandardMaterial
				map={texture ?? null}
				color={texture ? object.color : MISSING_CUTOUT}
				// A card seen edge-on is a card, not a hole: both faces draw.
				side={THREE.DoubleSide}
				alphaTest={texture ? 0.15 : 0}
				alphaToCoverage={!!texture}
				roughness={0.92}
				metalness={0}
			/>
		</mesh>
	);
}

const PRIMITIVE_KINDS = new Set(["cube", "sphere", "capsule", "cylinder", "cone", "plane"]);

function SceneObjectContent({ object }) {
	const { renderer, color } = object;
	if (renderer === CUTOUT_KIND) return <Cutout object={object} />;
	if (renderer === "car") return <Car color={color} />;
	if (renderer === "small-plane") return <SmallPlane />;
	if (renderer === "chair") return <Chair />;
	if (PRIMITIVE_KINDS.has(renderer)) return <Primitive kind={renderer} color={color} />;
	return null;
}

/**
 * Selection cage: the object's bounding box drawn as EDGES only. A wireframe
 * box draws every triangle diagonal too, which reads as a scribble over the
 * object instead of a selection.
 */
function SelectionBox({ object }) {
	const height = Math.max(object.height ?? 1, 0.08);
	const width = object.footprint?.width ?? 1;
	const depth = object.footprint?.depth ?? 1;
	const edges = useMemo(
		() => new THREE.EdgesGeometry(new THREE.BoxGeometry(width * 1.04, height * 1.04, depth * 1.04)),
		[width, height, depth],
	);
	useEffect(() => () => edges.dispose(), [edges]);
	return (
		<lineSegments
			// The cage is editor furniture, exactly like the transform gizmo, so
			// it lives on GIZMO_LAYER — the layer PlayView, the ink prepass and
			// CaptureRig already strip. Set on the mesh itself (via the ref):
			// three.js layer membership is per object, and the camera mask
			// checks the object that actually renders.
			ref={(mesh) => {
				if (mesh) mesh.layers.set(GIZMO_LAYER);
			}}
			geometry={edges}
			position={[0, height / 2, 0]}
			renderOrder={998}
		>
			<lineBasicMaterial color="#e7b557" transparent opacity={0.95} depthTest={false} depthWrite={false} />
		</lineSegments>
	);
}

const DEG = Math.PI / 180;

// One scratch set for the whole module: placement runs per prop per frame.
const placePos = new THREE.Vector3();
const placeQuat = new THREE.Quaternion();
const placeScale = new THREE.Vector3();
const placeEuler = new THREE.Euler();
const placeLocal = new THREE.Matrix4();
const placeWorld = new THREE.Matrix4();
const placeFrame = new THREE.Matrix4();

function SceneObject({ object, selected, frameRef = null, take = null, attachFrameRef = null, registryRef = null }) {
	const groupRef = useRef(null);
	const attach = object.attach ?? null;
	// An object on a travel path — or one CARRIED by a character — is placed
	// imperatively from the frame ref, not from React state: the offscreen
	// export advances frames without a re-render, and a prop that only moved on
	// re-render would freeze in the recording while the preview animated. A
	// carried prop is the same problem one level up: the bone it rides is
	// written straight into the scene graph by the playback code, never through
	// React, so nothing re-renders when the character moves.
	const place = () => {
		const group = groupRef.current;
		if (!group) return;
		const frame = frameRef?.current ?? 0;
		if (attach || object.path) {
			// The authored numbers first. While attached they are the prop's LOCAL
			// transform in the attach frame; otherwise they are already world.
			placePos.set(object.x, object.y ?? 0, object.z);
			placeEuler.set((object.rotX ?? 0) * DEG, object.rot * DEG, (object.rotZ ?? 0) * DEG);
			placeScale.set(object.scaleX ?? 1, object.scaleY ?? 1, object.scaleZ ?? 1);
			if (frameRef && object.path) {
				const at = objectTransformAt(object, frame, take ?? {});
				if (at) {
					placePos.set(at.x, at.y, at.z);
					if (at.rot !== null) placeEuler.y = at.rot * DEG;
				}
			}
			// A missing rig (the character left the cast, or its model has not
			// mounted yet) leaves a dangling attachment: place the numbers as plain
			// world, exactly like a detached prop, rather than freeze the prop at
			// whatever pose it last held.
			const rigFrame = attach ? attachFrameRef?.current?.(attach.characterId, attach.bone ?? null, placeFrame) ?? null : null;
			if (rigFrame) {
				placeLocal.compose(placePos, placeQuat.setFromEuler(placeEuler), placeScale);
				placeWorld.multiplyMatrices(rigFrame, placeLocal).decompose(placePos, placeQuat, placeScale);
				group.position.copy(placePos);
				group.quaternion.copy(placeQuat);
				group.scale.copy(placeScale);
			} else {
				group.position.copy(placePos);
				group.rotation.copy(placeEuler);
				group.scale.copy(placeScale);
			}
		}
		// QA hook: headless checks read the ANIMATED, WORLD position here, because
		// the store only knows the authored one — and while attached the authored
		// one is not even in world space. Harmless in normal use.
		if (typeof window !== "undefined") {
			(window.__cclayPropWorld ??= {})[object.id] = { x: group.position.x, y: group.position.y, z: group.position.z, frame };
		}
	};
	useFrame(place);
	// Two things the App needs to reach imperatively, registered per prop: a
	// placement pass for the recorder (which renders through gl.render() and so
	// never runs the frame loop — see SetProps' syncRef), and the prop's live
	// world matrix, which is what a hierarchy drop converts FROM. The ref
	// indirection keeps the registered callbacks reading the CURRENT object.
	const placeRef = useRef(place);
	placeRef.current = place;
	const entryRef = useRef(null);
	if (!entryRef.current) {
		entryRef.current = {
			place: () => placeRef.current(),
			// Rebuilt from the transform place() last wrote, so it is exactly what
			// is on screen — including while paused, when no frame has run since.
			world: (out) => {
				const group = groupRef.current;
				if (!group) return null;
				group.updateWorldMatrix(true, false);
				return out ? out.copy(group.matrixWorld) : group.matrixWorld;
			},
		};
	}
	useEffect(() => {
		if (!registryRef) return undefined;
		const registry = registryRef.current;
		registry.set(object.id, entryRef.current);
		return () => { registry.delete(object.id); };
	}, [registryRef, object.id]);
	return (
		<group
			ref={groupRef}
			position={[object.x, object.y ?? 0, object.z]}
			rotation={[(object.rotX ?? 0) * DEG, object.rot * DEG, (object.rotZ ?? 0) * DEG]}
			scale={[object.scaleX ?? 1, object.scaleY ?? 1, object.scaleZ ?? 1]}
			// the viewport picker walks up from a hit mesh to find this id
			userData={{ sceneObjectId: object.id }}
		>
			<SceneObjectContent object={object} />
			{selected && <SelectionBox object={object} />}
		</group>
	);
}

/** User-added scene objects, all driven by the shared object registry.
 *
 * `attachFrameRef.current(characterId, bone, out)` resolves the live world
 * frame a carried prop rides, or null. `syncRef` is filled with a "place every
 * prop now" callback for the offscreen export, which renders outside the frame
 * loop and would otherwise record props one frame stale; `worldRef` with a
 * "where is this prop" lookup, so a reparent converts from the transform on
 * screen instead of from a second computation of it. */
export function SetProps({ objects = [], selectedId = null, frameRef = null, take = null, attachFrameRef = null, syncRef = null, worldRef = null }) {
	const registryRef = useRef(null);
	if (!registryRef.current) registryRef.current = new Map();
	if (syncRef) syncRef.current = () => { for (const entry of registryRef.current.values()) entry.place(); };
	if (worldRef) worldRef.current = (id, out) => registryRef.current.get(id)?.world(out) ?? null;
	return (
		<group>
			{objects.map((object) => (
				<SceneObject
					key={object.id}
					object={object}
					selected={object.id === selectedId}
					frameRef={frameRef}
					take={take}
					attachFrameRef={attachFrameRef}
					registryRef={registryRef}
				/>
			))}
		</group>
	);
}

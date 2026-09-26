import * as THREE from "three";
import { findBone } from "./ik.js";

// Extra measured patches are not IK handles. They let a seated/lying body
// support itself without pretending its feet are planted.
export const BODY_SUPPORT_SITES = [
	["pelvis", "Hips", /Hips$/], ["abdomen", "Spine", /Spine$/],
	["chest", "Spine1", /Spine[12]$/], ["head", "Head", /Head/],
	["neck", "Neck", /Neck$/], ["leftShoulder", "LeftShoulder", /LeftShoulder$/], ["rightShoulder", "RightShoulder", /RightShoulder$/],
	["leftThigh", "LeftUpLeg", /LeftUpLeg$/], ["rightThigh", "RightUpLeg", /RightUpLeg$/],
	["leftShin", "LeftLeg", /LeftLeg$/], ["rightShin", "RightLeg", /RightLeg$/],
	["leftElbow", "LeftForeArm", /Left(Arm|ForeArm)$/], ["rightElbow", "RightForeArm", /Right(Arm|ForeArm)$/],
].map(([id, bone, match]) => ({ id, bone, match, kind: "body" }));

/** Exact linear skinning with a double-precision matrix palette. A matrix is
 * built once per bone/pose, not once per influence/vertex. Coincident vertices
 * with identical skin inputs can share the result (normals/UVs do not matter).
 * Morphing meshes use THREE's reference vertex path. No sampled sole proxy. */
export function createSurfaceSampler(rig, sites) {
	const measured = [...sites, ...BODY_SUPPORT_SITES];
	const bones = new Map(measured.map((s) => [s.id, findBone(rig, `mixamorig${s.bone}`)]));
	const groups = [];
	let inputVertices = 0, uniqueVertices = 0;
	rig.traverse((mesh) => {
		const geometry = mesh.geometry, index = geometry?.attributes?.skinIndex, weight = geometry?.attributes?.skinWeight, position = geometry?.attributes?.position;
		if (!mesh.isSkinnedMesh || !index || !weight || !position) return;
		const morph = !!geometry.morphAttributes?.position?.length;
		const vertices = [], byKey = new Map(), lists = Object.fromEntries(measured.map((s) => [s.id, []]));
		for (let v = 0; v < index.count; v += 1) {
			const ids = [0, 1, 2, 3].map((j) => index.getComponent(v, j)), weights = [0, 1, 2, 3].map((j) => weight.getComponent(v, j));
			const memberships = measured.filter((s) => ids.reduce((sum, id, j) => sum + (s.match.test(mesh.skeleton.bones[id]?.name ?? "") ? weights[j] : 0), 0) >= .5);
			if (!memberships.length) continue;
			inputVertices += 1;
			const p = [position.getX(v), position.getY(v), position.getZ(v)];
			const key = morph ? v : [...p, ...ids, ...weights].join(",");
			let vertex = byKey.get(key);
			if (!vertex) {
				vertex = { index: v, p, ids, weights, weightSum: weights.reduce((a, b) => a + b, 0), world: new THREE.Vector3(), copies: 0 };
				vertices.push(vertex); byKey.set(key, vertex);
			}
			vertex.copies += 1;
			// Count duplicates without evaluating them repeatedly.
			for (const site of memberships) {
				const list = lists[site.id];
				if (vertex.copies === 1) list.push(vertex);
			}
		}
		uniqueVertices += vertices.length;
		groups.push({ mesh, vertices, lists, morph, palette: mesh.skeleton.bones.map(() => new THREE.Matrix4()) });
	});
	const bounds = (item, p) => {
		if (p.y < item.floor) { item.floor = p.y; item.point.copy(p); }
	};
	const sample = () => {
		rig.updateMatrixWorld(true);
		const out = {};
		for (const site of measured) {
			const bone = bones.get(site.id); if (!bone) continue;
			out[site.id] = { position: new THREE.Vector3().setFromMatrixPosition(bone.matrixWorld), rotation: bone.getWorldQuaternion(new THREE.Quaternion()), floor: Infinity, vertices: 0, point: new THREE.Vector3(), patch: [] };
		}
		for (const { mesh, vertices, lists, morph, palette } of groups) {
			const post = new THREE.Matrix4().multiplyMatrices(mesh.matrixWorld, mesh.bindMatrixInverse);
			if (!morph) {
				for (let b = 0; b < palette.length; b += 1) palette[b].multiplyMatrices(post, mesh.skeleton.bones[b].matrixWorld).multiply(mesh.skeleton.boneInverses[b]).multiply(mesh.bindMatrix);
			}
			for (const vertex of vertices) {
				const { p, ids, weights, world } = vertex;
				if (morph) { mesh.getVertexPosition(vertex.index, world); world.applyMatrix4(mesh.matrixWorld); }
				else {
					let x = 0, y = 0, z = 0;
					for (let j = 0; j < 4; j += 1) {
						const w = weights[j]; if (!w) continue;
						const e = palette[ids[j]].elements;
						x += w * (e[0] * p[0] + e[4] * p[1] + e[8] * p[2] + e[12]);
						y += w * (e[1] * p[0] + e[5] * p[1] + e[9] * p[2] + e[13]);
						z += w * (e[2] * p[0] + e[6] * p[1] + e[10] * p[2] + e[14]);
					}
					// THREE's final Vector3 transform uses homogeneous w=1 even
					// when float32 skin weights do not sum to exactly one.
					const remainder = 1 - vertex.weightSum, pe = post.elements;
					world.set(x + remainder * pe[12], y + remainder * pe[13], z + remainder * pe[14]);
				}
			}
			for (const site of measured) {
				const item = out[site.id]; if (!item) continue;
				for (const v of lists[site.id]) {
					if (site.kind === "knee" && v.world.distanceTo(item.position) > .14) continue;
					bounds(item, v.world); item.vertices += v.copies;
				}
			}
		}
		// Finite support area from actual near-lowest surface vertices, not a
		// freely chosen torque at one point. Eight directions bound each patch.
		for (const site of measured) {
			const item = out[site.id]; if (!item) continue;
			if (!Number.isFinite(item.floor)) {
				item.floor = item.position.y - (site.kind === "foot" ? .05 : .035);
				item.point.copy(item.position); item.point.y = item.floor;
				continue;
			}
			const extrema = new Array(8).fill(null), scores = new Array(8).fill(-Infinity);
			for (const { lists } of groups) for (const v of lists[site.id]) {
				const p = v.world;
				if (p.y > item.floor + .012 || (site.kind === "knee" && p.distanceTo(item.position) > .14)) continue;
				for (let k = 0; k < 8; k += 1) {
					const angle = k * Math.PI / 4, score = p.x * Math.cos(angle) + p.z * Math.sin(angle);
					if (score > scores[k]) { scores[k] = score; extrema[k] = p; }
				}
			}
			item.patch = [...new Set(extrema.filter(Boolean))].map((p) => p.clone());
		}
		return out;
	};
	sample.stats = { inputVertices, uniqueVertices };
	return sample;
}

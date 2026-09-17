/**
 * Clone a cached mesh graph for one instance on the set.
 *
 * `Object3D.clone(true)` shares a SkinnedMesh's skeleton with the cache, so
 * a Mixamo-as-statue (or any skinned GLB) can bind to the wrong bones. Graphs
 * that actually contain a SkinnedMesh go through SkeletonUtils; everything
 * else keeps the cheap deep clone.
 */
import { clone as cloneSkeleton } from "three/examples/jsm/utils/SkeletonUtils.js";

export function graphHasSkinnedMesh(root) {
	let found = false;
	root?.traverse?.((node) => {
		if (node?.isSkinnedMesh) found = true;
	});
	return found;
}

export function cloneMeshGraph(source) {
	if (!source) return source;
	if (graphHasSkinnedMesh(source)) return cloneSkeleton(source);
	return source.clone(true);
}

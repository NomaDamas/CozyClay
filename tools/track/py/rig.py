"""Differentiable Studio rig for the known-character tracker (plan mocap-rearch todo 6).

Two deliberately separate layers:

1. `cskel27_fk(state, bone_scale, rig)` -> posedJoints. cskel27 forward kinematics
   over the canonical neutral skeleton grown by `bone_scale` - exactly the
   quantity a motion NPZ stores as `posed_joints` (tools/ardy/smpl-cskel27.mjs,
   tools/bench/fit/motion.mjs regenerateJoints) and the scorers read. Keypoint and
   contact terms use these joints.
2. `studio_skin(globals, posed_joints, rig, ...)` -> bone world transforms ->
   vertices. A torch port of Studio playback's positional skinning
   (src/ardy/playback.js applyMotionFrame, prepOf, scaledOffsets, boneStretch)
   followed by linear-blend skinning of the exported rig mesh. Silhouette and box
   terms use these vertices.

State convention (NPZ `local_rot_mats` convention): per frame
    transl  (T, 3)      root/pelvis world position = posed_joints[:, 0]
    root6d  (T, 6)      a_t, the root rotation = local_rot_mats[:, 0]
    local6d (T, 26, 6)  u_t,j for cskel27 joints 1..26 (local to the parent)
Zero pose = identity locals = the neutral T-pose, so 6D vectors are the rotations
themselves (no rest delta). `rot6d_to_matrix` follows the ultrabrain design
section 1: the 6D vector is the first two COLUMNS of the matrix, Gram-Schmidt.

Rig input: the npz written by tools/track/export-rig.mjs (layout and units in
tools/track/rig-dump.mjs). `load_rig` validates it (`RigError.code`:
`bad-rig`, `bad-skin-weights`) and decimates the merged mesh to <= 8,000 faces,
carrying skin weights from the nearest original vertex (renormalised).

World frame: Studio world, metres, +Y up. `studio_skin` returns the rig as Studio
places it under a Character group at the origin with no clip-to-scene yaw:
    rig-space bone = s * (posed - anchor_xz) + R_global @ offset
with s = prep scale (rig leg height / canonical leg height, rig units) and the
0.01 rig root scale taking rig units to metres. Pass `anchor_xz=None` for the
tracker (no anchoring: vertices live in the posedJoints frame, scaled by the
rig's leg ratio about the XZ origin exactly as Studio scales them about the
anchor), or the anchor frame's root XZ to reproduce Studio playback bit-for-bit.
Nothing here optimises bone lengths, shape or camera.
"""
from __future__ import annotations

import json
from dataclasses import dataclass
from pathlib import Path

import numpy as np
import torch

J = 27
INFLUENCES = 4
WEIGHT_TOLERANCE = 1e-5  # same as tools/track/rig-dump.mjs
MAX_FACES = 8000
EPS = 1e-8

REQUIRED_MEMBERS = (
    "meta_json", "rig_root_scale", "vertices", "faces", "skin_index", "skin_weight",
    "bone_parent", "bone_rest_local", "bone_bind_inverse",
    "prep_bone", "prep_scale", "prep_offsets", "prep_bind_pos", "prep_bind_quat",
    "prep_bind_scale", "prep_bind_local_pos", "prep_parent_bind_world",
    "prep_chain_parent", "prep_chain_rel", "prep_canonical_bone_length",
    "prep_rig_bone_length", "prep_stretched_leaves", "prep_stretched_leaf_local_pos",
    "prep_stretched_leaf_local_quat", "hierarchy_preserved", "girdle_joints",
    "ardy_neutral_min_y", "cskel27_parents", "cskel27_neutral",
)


class RigError(ValueError):
    """Malformed rig input. `code` is the machine-readable reason."""

    def __init__(self, code: str, detail: str):
        super().__init__(f"{code}: {detail}")
        self.code = code


# --- rotations -----------------------------------------------------------------

def rot6d_to_matrix(a: torch.Tensor) -> torch.Tensor:
    """(..., 6) -> (..., 3, 3). a = [a1, a2]; columns b1, b2, b3 (Gram-Schmidt)."""
    # Clamp (not add) the epsilon: columns stay exactly unit length unless degenerate.
    a1, a2 = a[..., 0:3], a[..., 3:6]
    b1 = a1 / a1.norm(dim=-1, keepdim=True).clamp_min(EPS)
    a2 = a2 - b1 * (b1 * a2).sum(dim=-1, keepdim=True)
    b2 = a2 / a2.norm(dim=-1, keepdim=True).clamp_min(EPS)
    b3 = torch.cross(b1, b2, dim=-1)
    return torch.stack((b1, b2, b3), dim=-1)


def matrix_to_rot6d(R: torch.Tensor) -> torch.Tensor:
    """(..., 3, 3) -> (..., 6): the first two columns."""
    return torch.cat((R[..., :, 0], R[..., :, 1]), dim=-1)


def quat_to_matrix(q: torch.Tensor) -> torch.Tensor:
    """(..., 4) three.js [x, y, z, w] (normalised here) -> (..., 3, 3)."""
    q = q / q.norm(dim=-1, keepdim=True)
    x, y, z, w = q.unbind(-1)
    return torch.stack((
        1 - 2 * (y * y + z * z), 2 * (x * y - w * z), 2 * (x * z + w * y),
        2 * (x * y + w * z), 1 - 2 * (x * x + z * z), 2 * (y * z - w * x),
        2 * (x * z - w * y), 2 * (y * z + w * x), 1 - 2 * (x * x + y * y),
    ), dim=-1).reshape(q.shape[:-1] + (3, 3))


def _affine(R: torch.Tensor, t: torch.Tensor) -> torch.Tensor:
    """(..., 3, 3), (..., 3) -> (..., 4, 4)."""
    top = torch.cat((R, t.unsqueeze(-1)), dim=-1)
    bottom = torch.zeros(top.shape[:-2] + (1, 4), dtype=top.dtype, device=top.device)
    bottom[..., 0, 3] = 1
    return torch.cat((top, bottom), dim=-2)


def _apply(M: torch.Tensor, p: torch.Tensor) -> torch.Tensor:
    """Affine (..., 4, 4) applied to points (..., 3)."""
    return (M[..., :3, :3] @ p.unsqueeze(-1)).squeeze(-1) + M[..., :3, 3]


# --- rig -----------------------------------------------------------------------

@dataclass
class Rig:
    """Exported Studio rig as torch tensors (float, on `device`)."""

    meta: dict
    parents: list  # cskel27 parent per joint, -1 for the root
    neutral: torch.Tensor  # (27, 3) canonical neutral, hips at the origin
    min_y: float  # ARDY_NEUTRAL_MIN_Y
    root_scale: float  # rig units -> metres (0.01)
    bone_names: list
    bone_parent: list  # per exported bone, -1 for bones under the (static) rig root
    bone_rest_local: torch.Tensor  # (B, 4, 4) rig units
    bone_rest_scale: torch.Tensor  # (B, 3)
    bind_inverse: torch.Tensor  # (B, 4, 4) metres
    # prepOf
    prep_bone: list  # cskel27 -> bone index or -1
    prep_scale: float
    prep_offsets: torch.Tensor  # (27, 3)
    prep_bind_pos: torch.Tensor  # (27, 3)
    prep_bind_rot: torch.Tensor  # (27, 3, 3)
    prep_bind_scale: torch.Tensor  # (27, 3)
    prep_bind_local_pos: torch.Tensor  # (27, 3)
    prep_parent_bind_world: torch.Tensor  # (27, 4, 4)
    prep_chain_parent: list
    prep_chain_rel: torch.Tensor  # (27, 4, 4)
    canonical_bone_length: np.ndarray  # (27,)
    rig_bone_length: np.ndarray  # (27,)
    leaves: list  # [(bone, joint, local_pos (3,), local_rot (3, 3))]
    hierarchy_preserved: np.ndarray  # (27,) bool
    girdle: np.ndarray  # (27,) bool
    # full-resolution merged mesh (rest pose, metres)
    vertices: torch.Tensor  # (V, 3)
    skin_index: torch.Tensor  # (V, 4) long
    skin_weight: torch.Tensor  # (V, 4)
    # decimated mesh used by the tracker's silhouette/box terms
    dec_vertices: torch.Tensor  # (Vd, 3)
    dec_faces: torch.Tensor  # (Fd, 3) long
    dec_skin_index: torch.Tensor  # (Vd, 4) long
    dec_skin_weight: torch.Tensor  # (Vd, 4)
    dec_weights: torch.Tensor  # (Vd, B) dense blend weights
    dec_source: np.ndarray  # (Vd,) nearest original vertex


def _require(z, name, shape=None, dtype_kind=None):
    if name not in z:
        raise RigError("bad-rig", f"missing member {name}")
    value = np.asarray(z[name])
    if shape is not None and (value.ndim != len(shape) or any(s is not None and s != d for s, d in zip(shape, value.shape))):
        raise RigError("bad-rig", f"{name} has shape {value.shape}, expected {shape}")
    if dtype_kind == "f" and not np.all(np.isfinite(value)):
        raise RigError("bad-rig", f"{name} has non-finite values")
    return value


def validate_skin_weights(skin_weight: np.ndarray, tol: float = WEIGHT_TOLERANCE) -> None:
    """Raise `bad-skin-weights` unless every row is non-negative and sums to 1."""
    w = np.asarray(skin_weight, dtype=np.float64)
    if not np.all(np.isfinite(w)):
        raise RigError("bad-skin-weights", "non-finite skin weight")
    if (w < 0).any():
        v = int(np.argwhere(w < 0)[0, 0])
        raise RigError("bad-skin-weights", f"vertex {v} has a negative weight")
    err = np.abs(w.sum(axis=1) - 1)
    if (err > tol).any():
        v = int(err.argmax())
        raise RigError("bad-skin-weights", f"vertex {v} weights sum to {w[v].sum():.7f}")


def decimate(vertices: np.ndarray, faces: np.ndarray, skin_index: np.ndarray, skin_weight: np.ndarray,
             max_faces: int = MAX_FACES):
    """Weld, simplify to <= max_faces, transfer skin weights from the nearest original vertex.

    Returns (vertices (Vd,3), faces (Fd,3), skin_index (Vd,4), skin_weight (Vd,4), source (Vd,)).
    The export is unindexed per triangle, so identical positions are welded first
    (fast_simplification needs shared vertices to collapse edges).
    """
    import fast_simplification
    from scipy.spatial import cKDTree

    welded, first, inverse = np.unique(vertices, axis=0, return_index=True, return_inverse=True)
    inverse = inverse.reshape(-1)
    wf = inverse[faces]
    keep = (wf[:, 0] != wf[:, 1]) & (wf[:, 1] != wf[:, 2]) & (wf[:, 0] != wf[:, 2])
    wf = wf[keep]
    reduction = 1.0 - max_faces / len(wf) if len(wf) > max_faces else 0.0
    for _ in range(20):
        if reduction <= 0:
            points, out_faces = welded, wf
        else:
            points, out_faces = fast_simplification.simplify(
                welded.astype(np.float32), wf.astype(np.int32), target_reduction=min(reduction, 0.999))
        if len(out_faces) <= max_faces:
            break
        reduction += (1 - reduction) * 0.05
    else:
        raise RigError("bad-rig", f"could not decimate below {max_faces} faces")
    points = np.asarray(points, dtype=np.float32)
    out_faces = np.asarray(out_faces, dtype=np.int64)
    used = np.unique(out_faces)  # drop vertices no face references
    remap = np.full(len(points), -1, dtype=np.int64)
    remap[used] = np.arange(len(used))
    points, out_faces = points[used], remap[out_faces]
    _, nearest = cKDTree(vertices).query(points, k=1)
    source = np.asarray(nearest, dtype=np.int64)
    w = skin_weight[source].astype(np.float64)
    w = w / w.sum(axis=1, keepdims=True)
    return points, out_faces, skin_index[source].astype(np.int64), w.astype(np.float32), source


def load_rig(path, device="cpu", dtype=torch.float32, max_faces: int = MAX_FACES) -> Rig:
    path = Path(path)
    if not path.is_file():
        raise RigError("bad-rig", f"rig npz not found: {path}")
    with np.load(path) as z:
        missing = [name for name in REQUIRED_MEMBERS if name not in z]
        if missing:
            raise RigError("bad-rig", f"missing members: {', '.join(missing)}")
        meta = json.loads(bytes(z["meta_json"].astype(np.uint8)))
        vertices = _require(z, "vertices", (None, 3), "f").astype(np.float32)
        V = len(vertices)
        faces = _require(z, "faces", (None, 3)).astype(np.int64)
        skin_index = _require(z, "skin_index", (V, INFLUENCES)).astype(np.int64)
        skin_weight = _require(z, "skin_weight", (V, INFLUENCES), "f").astype(np.float32)
        bone_parent = _require(z, "bone_parent", (None,)).astype(np.int64)
        B = len(bone_parent)
        arrays = {name: _require(z, name, shape, "f") for name, shape in (
            ("bone_rest_local", (B, 4, 4)), ("bone_bind_inverse", (B, 4, 4)),
            ("prep_offsets", (J, 3)), ("prep_bind_pos", (J, 3)), ("prep_bind_quat", (J, 4)),
            ("prep_bind_scale", (J, 3)), ("prep_bind_local_pos", (J, 3)),
            ("prep_parent_bind_world", (J, 4, 4)), ("prep_chain_rel", (J, 4, 4)),
            ("prep_canonical_bone_length", (J,)), ("prep_rig_bone_length", (J,)),
            ("cskel27_neutral", (J, 3)), ("rig_root_scale", (1,)), ("prep_scale", (1,)),
            ("ardy_neutral_min_y", (1,)),
        )}
        prep_bone = _require(z, "prep_bone", (J,)).astype(np.int64)
        chain_parent = _require(z, "prep_chain_parent", (J,)).astype(np.int64)
        parents = _require(z, "cskel27_parents", (J,)).astype(np.int64)
        leaves_idx = _require(z, "prep_stretched_leaves", (None, 2)).astype(np.int64)
        leaf_pos = _require(z, "prep_stretched_leaf_local_pos", (len(leaves_idx), 3), "f")
        leaf_quat = _require(z, "prep_stretched_leaf_local_quat", (len(leaves_idx), 4), "f")
        preserved = _require(z, "hierarchy_preserved", (J,)).astype(bool)
        girdle = _require(z, "girdle_joints", (J,)).astype(bool)

    if len(meta.get("boneNames", [])) != B:
        raise RigError("bad-rig", f"meta boneNames has {len(meta.get('boneNames', []))} names for {B} bones")
    if faces.size and (faces.min() < 0 or faces.max() >= V):
        raise RigError("bad-rig", "face index out of range")
    if skin_index.min() < 0 or skin_index.max() >= B:
        raise RigError("bad-rig", "skin index out of range")
    for i, p in enumerate(bone_parent):
        if not -1 <= p < i:
            raise RigError("bad-rig", f"bone {i} parent {p} does not precede it")
    for j, p in enumerate(parents):
        if not (p == -1 if j == 0 else 0 <= p < j):
            raise RigError("bad-rig", f"cskel27 parent {p} of joint {j} is not topological")
    for j in range(J):
        if not -1 <= prep_bone[j] < B:
            raise RigError("bad-rig", f"prep_bone[{j}] out of range")
        cp = chain_parent[j]
        if cp >= 0 and (cp >= j or prep_bone[cp] < 0 or prep_bone[j] < 0):
            raise RigError("bad-rig", f"prep_chain_parent[{j}]={cp} must be an earlier mapped joint")
    validate_skin_weights(skin_weight)

    dv, df, dsi, dsw, source = decimate(vertices, faces, skin_index, skin_weight, max_faces)
    dense = np.zeros((len(dv), B), dtype=np.float32)
    np.add.at(dense, (np.repeat(np.arange(len(dv)), INFLUENCES), dsi.reshape(-1)), dsw.reshape(-1))

    t = lambda a: torch.as_tensor(np.asarray(a, dtype=np.float32), device=device).to(dtype)  # noqa: E731
    rest_local = arrays["bone_rest_local"]
    return Rig(
        meta=meta,
        parents=[int(p) for p in parents],
        neutral=t(arrays["cskel27_neutral"]),
        min_y=float(arrays["ardy_neutral_min_y"][0]),
        root_scale=float(arrays["rig_root_scale"][0]),
        bone_names=list(meta["boneNames"]),
        bone_parent=[int(p) for p in bone_parent],
        bone_rest_local=t(rest_local),
        bone_rest_scale=t(np.linalg.norm(rest_local[:, :3, :3], axis=1)),
        bind_inverse=t(arrays["bone_bind_inverse"]),
        prep_bone=[int(b) for b in prep_bone],
        prep_scale=float(arrays["prep_scale"][0]),
        prep_offsets=t(arrays["prep_offsets"]),
        prep_bind_pos=t(arrays["prep_bind_pos"]),
        prep_bind_rot=quat_to_matrix(t(arrays["prep_bind_quat"])),
        prep_bind_scale=t(arrays["prep_bind_scale"]),
        prep_bind_local_pos=t(arrays["prep_bind_local_pos"]),
        prep_parent_bind_world=t(arrays["prep_parent_bind_world"]),
        prep_chain_parent=[int(c) for c in chain_parent],
        prep_chain_rel=t(arrays["prep_chain_rel"]),
        canonical_bone_length=np.asarray(arrays["prep_canonical_bone_length"], dtype=np.float64),
        rig_bone_length=np.asarray(arrays["prep_rig_bone_length"], dtype=np.float64),
        leaves=[(int(b), int(j), t(p), quat_to_matrix(t(q))) for (b, j), p, q in zip(leaves_idx, leaf_pos, leaf_quat)],
        hierarchy_preserved=preserved,
        girdle=girdle,
        vertices=t(vertices),
        skin_index=torch.as_tensor(skin_index, device=device),
        skin_weight=t(skin_weight),
        dec_vertices=t(dv),
        dec_faces=torch.as_tensor(df, device=device),
        dec_skin_index=torch.as_tensor(dsi, device=device),
        dec_skin_weight=t(dsw),
        dec_weights=t(dense),
        dec_source=source,
    )


# --- layer 1: cskel27 FK ---------------------------------------------------------

@dataclass
class State:
    """Optimisable per-frame pose (see module docstring for the convention)."""

    transl: torch.Tensor  # (T, 3)
    root6d: torch.Tensor  # (T, 6)
    local6d: torch.Tensor  # (T, 26, 6), joints 1..26

    @staticmethod
    def from_motion(local_rot_mats, root_positions, device="cpu", dtype=torch.float32) -> "State":
        R = torch.as_tensor(np.asarray(local_rot_mats), device=device).to(dtype)
        x = torch.as_tensor(np.asarray(root_positions), device=device).to(dtype)
        if R.ndim != 4 or R.shape[1:] != (J, 3, 3) or x.shape != (R.shape[0], 3):
            raise RigError("bad-motion", f"expected local_rot_mats (T,27,3,3) and root (T,3), got {tuple(R.shape)} {tuple(x.shape)}")
        return State(x.clone(), matrix_to_rot6d(R[:, 0]), matrix_to_rot6d(R[:, 1:]))

    @staticmethod
    def identity(frames: int, root=(0.0, 0.0, 0.0), device="cpu", dtype=torch.float32) -> "State":
        eye6 = torch.tensor([1.0, 0, 0, 0, 1, 0], device=device, dtype=dtype)
        return State(torch.tensor(root, device=device, dtype=dtype).expand(frames, 3).clone(),
                     eye6.expand(frames, 6).clone(), eye6.expand(frames, J - 1, 6).clone())

    def local_rot_mats(self) -> torch.Tensor:
        """(T, 27, 3, 3) in the NPZ local_rot_mats convention."""
        return torch.cat((rot6d_to_matrix(self.root6d).unsqueeze(1), rot6d_to_matrix(self.local6d)), dim=1)


def global_rotations(local: torch.Tensor, parents) -> torch.Tensor:
    """(T, 27, 3, 3) local -> global rotations down the cskel27 tree."""
    out = [None] * J
    for j in range(J):
        p = parents[j]
        out[j] = local[:, j] if p < 0 else out[p] @ local[:, j]
    return torch.stack(out, dim=1)


def cskel27_offsets(rig: Rig, bone_scale=None) -> torch.Tensor:
    """(27, 3) bone offsets in the parent frame: boneScale[j] * (neutral[j] - neutral[parent])."""
    n = rig.neutral
    parents = torch.tensor([max(p, 0) for p in rig.parents], device=n.device)
    offsets = n - n[parents]  # the root row is n[0] - n[0] = 0
    if bone_scale is not None:
        offsets = offsets * _bone_scale(bone_scale, n).unsqueeze(-1)
    return offsets


def _bone_scale(bone_scale, like: torch.Tensor) -> torch.Tensor:
    bs = torch.as_tensor(np.asarray(bone_scale) if not torch.is_tensor(bone_scale) else bone_scale, device=like.device).to(like.dtype)
    if bs.shape != (J,) or not torch.isfinite(bs).all() or (bs <= 0).any():
        raise RigError("bad-bone-scale", "bone_scale must be 27 positive finite factors")
    return bs


def cskel27_fk(state: State, bone_scale, rig: Rig):
    """Layer 1. Returns (posed_joints (T, 27, 3), globals (T, 27, 3, 3)).

    posed_joints is the motion NPZ `posed_joints`: FK over the neutral skeleton
    grown by `bone_scale` (None == all ones) with the root at `state.transl`.
    """
    globals_ = global_rotations(state.local_rot_mats(), rig.parents)
    offsets = cskel27_offsets(rig, bone_scale)
    pos = [None] * J
    for j in range(J):
        p = rig.parents[j]
        pos[j] = state.transl if p < 0 else pos[p] + (globals_[:, p] @ offsets[j].unsqueeze(-1)).squeeze(-1)
    return torch.stack(pos, dim=1), globals_


# --- layer 2: Studio positional skinning + LBS ------------------------------------

def _studio_offsets(rig: Rig, bone_scale) -> torch.Tensor:
    """playback.js prep.offsets, or scaledOffsets(prep, boneScale) for a take with boneScale."""
    if bone_scale is None:
        return rig.prep_offsets
    grown = cskel27_offsets(rig, bone_scale)
    g = [None] * J
    for j in range(J):
        p = rig.parents[j]
        g[j] = rig.neutral[j] if p < 0 else g[p] + grown[j]
    g = torch.stack(g)
    shift = torch.tensor([0.0, rig.min_y, 0.0], dtype=g.dtype, device=g.device)
    return rig.prep_bind_pos - rig.prep_scale * (g - shift)


def _stretch(rig: Rig, bone_scale, j: int):
    """playback.js boneStretch: 1 without boneScale; girdle joints take the raw factor."""
    if bone_scale is None:
        return 1.0
    if rig.girdle[j]:
        return bone_scale[j]
    canonical, rig_bind = rig.canonical_bone_length[j], rig.rig_bone_length[j]
    if not (canonical > 1e-6) or not (rig_bind > 1e-6):
        return bone_scale[j]
    return bone_scale[j] * float(canonical / rig_bind)


def studio_bone_worlds(globals_: torch.Tensor, posed_joints: torch.Tensor, rig: Rig,
                       bone_scale=None, anchor_xz=None) -> torch.Tensor:
    """Every exported bone's world matrix (T, B, 4, 4) in metres under Studio playback.

    globals_: (T, 27, 3, 3) cskel27 global rotations; posed_joints: (T, 27, 3).
    bone_scale: None reproduces a take without bone_scale (no arm stretch); a
    27-vector reproduces a mocap take (grown offsets, stretched arm chain/hands).
    anchor_xz: None (no anchoring) or (2,)/(T, 2) root XZ subtracted like the
    anchor frame's root in applyMotionFrame.
    """
    T = globals_.shape[0]
    dtype, device = globals_.dtype, globals_.device
    bs = None if bone_scale is None else _bone_scale(bone_scale, globals_)
    offsets = _studio_offsets(rig, bs)
    s = rig.prep_scale
    posed = posed_joints
    if anchor_xz is not None:
        a = torch.as_tensor(anchor_xz, dtype=dtype, device=device).reshape(-1, 2)
        zero = torch.zeros_like(a[:, :1])
        posed = posed - torch.cat((a[:, :1], zero, a[:, 1:]), dim=-1).unsqueeze(1)

    desired = [None] * J
    assumed_parent = {}
    for j in range(J):
        b = rig.prep_bone[j]
        if b < 0:
            continue
        R = globals_[:, j]
        pos = s * posed[:, j] + (R @ offsets[j].unsqueeze(-1)).squeeze(-1)
        cp = rig.prep_chain_parent[j]
        parent = desired[cp] @ rig.prep_chain_rel[j] if cp >= 0 else rig.prep_parent_bind_world[j].expand(T, 4, 4)
        if rig.hierarchy_preserved[j]:
            pos = _apply(parent, (rig.prep_bind_local_pos[j] * _stretch(rig, bs, j)).expand(T, 3))
        rot = R @ rig.prep_bind_rot[j] * rig.prep_bind_scale[j]  # compose(pos, quat, scale)
        desired[j] = _affine(rot, pos)
        assumed_parent[b] = (parent, j)

    leaves = {b: (joint, p, Rq) for b, joint, p, Rq in rig.leaves}
    worlds = []
    for b, parent_index in enumerate(rig.bone_parent):
        if b in assumed_parent:
            parent, j = assumed_parent[b]
            local = torch.linalg.inv(parent) @ desired[j]
        elif b in leaves:
            joint, p, Rq = leaves[b]
            local = _affine(Rq * rig.bone_rest_scale[b], p * _stretch(rig, bs, joint)).expand(T, 4, 4)
        else:
            local = rig.bone_rest_local[b].expand(T, 4, 4)
        worlds.append(local if parent_index < 0 else worlds[parent_index] @ local)
    W = torch.stack(worlds, dim=1)
    root = torch.diag(torch.tensor([rig.root_scale] * 3 + [1.0], dtype=dtype, device=device))
    return root @ W


def lbs(bone_worlds: torch.Tensor, rig: Rig, rest: torch.Tensor, weights: torch.Tensor) -> torch.Tensor:
    """Linear-blend skinning: v = sum_b w_vb * (W_b @ bindInverse_b) @ v_rest.

    bone_worlds (T, B, 4, 4) metres; rest (V, 3); weights dense (V, B). -> (T, V, 3).
    """
    skin = bone_worlds @ rig.bind_inverse  # (T, B, 4, 4)
    blended = torch.einsum("vb,tbij->tvij", weights, skin[:, :, :3, :])  # (T, V, 3, 4)
    return (blended[..., :3] @ rest.unsqueeze(-1)).squeeze(-1) + blended[..., 3]


def dense_weights(rig: Rig, indices=None) -> tuple:
    """(rest (V, 3), dense weights (V, B)) of full-resolution vertices `indices` (all when None)."""
    idx = slice(None) if indices is None else torch.as_tensor(indices, device=rig.vertices.device, dtype=torch.long)
    si, sw = rig.skin_index[idx], rig.skin_weight[idx]
    dense = torch.zeros(si.shape[0], len(rig.bone_names), dtype=sw.dtype, device=sw.device)
    dense.scatter_add_(1, si, sw)
    return rig.vertices[idx], dense


def studio_skin(globals_: torch.Tensor, posed_joints: torch.Tensor, rig: Rig, bone_scale=None,
                anchor_xz=None, vertex_indices=None):
    """Layer 2. Returns (bone_worlds (T, B, 4, 4), vertices (T, V, 3)), metres.

    Vertices are the decimated tracker mesh by default, or the full-resolution
    export vertices `vertex_indices` (parity checks against Studio).
    """
    W = studio_bone_worlds(globals_, posed_joints, rig, bone_scale, anchor_xz)
    if vertex_indices is None:
        rest, weights = rig.dec_vertices, rig.dec_weights
    else:
        rest, weights = dense_weights(rig, vertex_indices)
    return W, lbs(W, rig, rest, weights)

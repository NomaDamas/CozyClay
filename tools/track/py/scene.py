"""Scene terms for the known-character tracker: boxes, floor, stance, occlusion.

World frame: Studio / three.js, metres, +Y up, floor plane y = floor_y (0).
Boxes are oriented about +Y only (props stay upright, `src/ardy/collision-blockers.js`):
a box point is `center + Ry(yaw) @ local` with `Ry` the three.js rotation
(`tools/gt-render/scene-box.mjs` boxCorners), `|local| <= halfExtents`.

Accepted box records (`parse_scene`):
  - today's bench scene.json: `{min, max}` (plus optional `centre`, `halfExtents`, `yawDeg`)
  - shot context: `{center|centre, halfExtents, yaw (radians) | yawDeg, perFrame?}` where
    `perFrame` is a list of per-frame centres `[x, y, z]` or `{center|centre, yaw|yawDeg}`
    for props that travel or turn.
  - a list of such records, or `{boxes: [...]}`.

Everything that feeds a loss takes plain torch tensors (vertices or joints) and is
differentiable; the HMM and ray tests are discrete and run without gradients.
"""
from __future__ import annotations

import json
import math
from pathlib import Path
from typing import NamedTuple

import numpy as np
import torch

# cskel27 indices: LeftFoot, LeftToeBase / RightFoot, RightToeBase (src/ardy/cskel27.js).
FOOT_NAMES = ("left", "right")
FOOT_JOINTS = ((25, 26), (21, 22))


class SceneError(ValueError):
    """Malformed scene input. `code` is the machine-readable reason."""

    def __init__(self, code: str, detail: str):
        super().__init__(f"{code}: {detail}")
        self.code = code


class Box(NamedTuple):
    center: np.ndarray  # (3,)
    half_extents: np.ndarray  # (3,)
    yaw: float  # radians about +Y
    per_frame_center: np.ndarray | None  # (T, 3)
    per_frame_yaw: np.ndarray | None  # (T,)


class SceneBoxes(NamedTuple):
    centers: torch.Tensor  # (B, T, 3)
    half: torch.Tensor  # (B, 3)
    yaw: torch.Tensor  # (B, T)


def _vec3(value, what: str) -> np.ndarray:
    try:
        out = np.asarray(value, dtype=np.float64)
    except (TypeError, ValueError):
        raise SceneError("bad-box", f"{what} must be 3 numbers, got {value!r}") from None
    if out.shape != (3,) or not np.all(np.isfinite(out)):
        raise SceneError("bad-box", f"{what} must be 3 finite numbers, got {value!r}")
    return out


def _yaw(record: dict, default: float, what: str) -> float:
    if "yaw" in record:
        value = record["yaw"]
    elif "yawDeg" in record:
        value = record["yawDeg"] * math.pi / 180 if isinstance(record["yawDeg"], (int, float)) else record["yawDeg"]
    else:
        return default
    if not isinstance(value, (int, float)) or not math.isfinite(value):
        raise SceneError("bad-box", f"{what} yaw must be a finite number, got {value!r}")
    return float(value)


def parse_box(record, index: int = 0) -> Box:
    what = f"box {index}"
    if not isinstance(record, dict):
        raise SceneError("bad-box", f"{what} must be an object, got {type(record).__name__}")
    center = record.get("center", record.get("centre"))
    if center is not None or "halfExtents" in record:
        if center is None or "halfExtents" not in record:
            raise SceneError("bad-box", f"{what} needs both center and halfExtents")
        center, half = _vec3(center, f"{what} center"), _vec3(record["halfExtents"], f"{what} halfExtents")
    elif "min" in record and "max" in record:
        lo, hi = _vec3(record["min"], f"{what} min"), _vec3(record["max"], f"{what} max")
        center, half = (lo + hi) / 2, (hi - lo) / 2
    else:
        raise SceneError("bad-box", f"{what} needs {{center, halfExtents}} or {{min, max}}")
    if not np.all(half > 0):
        raise SceneError("degenerate-box", f"{what} has non-positive size {(2 * half).tolist()}")
    yaw = _yaw(record, 0.0, what)
    per_center = per_yaw = None
    frames = record.get("perFrame")
    if frames is not None:
        if not isinstance(frames, list) or not frames:
            raise SceneError("bad-box", f"{what} perFrame must be a non-empty list")
        per_center, per_yaw = np.empty((len(frames), 3)), np.empty(len(frames))
        for t, entry in enumerate(frames):
            if isinstance(entry, dict):
                per_center[t] = _vec3(entry.get("center", entry.get("centre")), f"{what} perFrame[{t}] center")
                per_yaw[t] = _yaw(entry, yaw, f"{what} perFrame[{t}]")
            else:
                per_center[t], per_yaw[t] = _vec3(entry, f"{what} perFrame[{t}]"), yaw
    return Box(center, half, yaw, per_center, per_yaw)


def parse_scene(scene) -> list[Box]:
    """Boxes from a scene.json / shot-context value (None -> no boxes)."""
    if scene is None:
        return []
    if isinstance(scene, dict) and "boxes" in scene:
        scene = scene["boxes"]
    records = scene if isinstance(scene, list) else [scene]
    return [parse_box(record, i) for i, record in enumerate(records)]


def load_scene(path) -> list[Box]:
    return parse_scene(json.loads(Path(path).read_text()))


def box_tensors(boxes: list[Box], frames: int, *, device=None, dtype=torch.float32) -> SceneBoxes:
    """Per-frame box tensors; static boxes are repeated over `frames`."""
    centers, yaws = [], []
    for i, box in enumerate(boxes):
        if box.per_frame_center is not None:
            if len(box.per_frame_center) != frames:
                raise SceneError("box-frames-mismatch", f"box {i} has {len(box.per_frame_center)} perFrame entries for {frames} frames")
            centers.append(box.per_frame_center)
            yaws.append(box.per_frame_yaw)
        else:
            centers.append(np.broadcast_to(box.center, (frames, 3)))
            yaws.append(np.full(frames, box.yaw))
    as_t = lambda a, shape: torch.as_tensor(np.asarray(a, dtype=np.float64).reshape(shape), dtype=dtype, device=device)
    b = len(boxes)
    return SceneBoxes(
        centers=as_t(centers, (b, frames, 3)),
        half=as_t([box.half_extents for box in boxes], (b, 3)),
        yaw=as_t(yaws, (b, frames)),
    )


def _boxes_like(boxes: SceneBoxes, points: torch.Tensor) -> SceneBoxes:
    """Boxes on the points' device and dtype (differentiable; a no-op when they already match)."""
    return SceneBoxes(*(v.to(device=points.device, dtype=points.dtype) for v in boxes))


def _cpu64(value) -> torch.Tensor:
    """Detached float64 CPU tensor from a tensor on any device, an array or a list."""
    if isinstance(value, torch.Tensor):
        return value.detach().to(device="cpu", dtype=torch.float64)
    return torch.as_tensor(np.asarray(value, dtype=np.float64))


def to_box_local(points: torch.Tensor, boxes: SceneBoxes) -> torch.Tensor:
    """points (T, N, 3) -> box-local coordinates (T, N, B, 3), on the points' device."""
    boxes = _boxes_like(boxes, points)
    d = points[:, :, None, :] - boxes.centers.transpose(0, 1)[:, None, :, :]
    c, s = torch.cos(boxes.yaw).T[:, None, :], torch.sin(boxes.yaw).T[:, None, :]
    dx, dy, dz = d.unbind(-1)
    return torch.stack((c * dx - s * dz, dy, s * dx + c * dz), dim=-1)


def box_sdf(points: torch.Tensor, boxes: SceneBoxes) -> torch.Tensor:
    """Signed distance (T, N, B) of points (T, N, 3) to each box; positive outside."""
    q = to_box_local(points, boxes).abs() - boxes.half[None, None].to(device=points.device, dtype=points.dtype)
    sq = torch.relu(q).square().sum(-1)
    # sqrt has an infinite derivative at 0: route inside points through a constant.
    outside = torch.where(sq > 0, torch.sqrt(torch.where(sq > 0, sq, torch.ones_like(sq))), torch.zeros_like(sq))
    return outside + torch.clamp(q.max(-1).values, max=0)


def floor_sdf(points: torch.Tensor, floor_y: float = 0.0) -> torch.Tensor:
    return points[..., 1] - floor_y


def penetration_loss(points: torch.Tensor, boxes: SceneBoxes, *, floor_y: float = 0.0, margin: float = 0.0) -> dict[str, torch.Tensor]:
    """{"box", "floor"}: sum relu(margin - sd)^2 over points (T, N, 3) and every box / the floor."""
    return {
        "box": torch.relu(margin - box_sdf(points, boxes)).square().sum(),
        "floor": torch.relu(margin - floor_sdf(points, floor_y)).square().sum(),
    }


@torch.no_grad()
def penetration_stats(points: torch.Tensor, boxes: SceneBoxes, *, floor_y: float = 0.0) -> dict:
    """Diagnostics: deepest box / floor penetration in cm and the frames with any penetration."""
    box_depth = torch.relu(-box_sdf(points, boxes)).amax(dim=(1, 2)) if boxes.half.shape[0] else points.new_zeros(points.shape[0])
    floor_depth = torch.relu(-floor_sdf(points, floor_y)).amax(dim=1)
    worst = torch.maximum(box_depth, floor_depth)
    return {
        "maxBoxCm": float(box_depth.max()) * 100 if box_depth.numel() else 0.0,
        "maxFloorCm": float(floor_depth.max()) * 100 if floor_depth.numel() else 0.0,
        "frames": [int(t) for t in torch.nonzero(worst > 0).flatten()],
    }


@torch.no_grad()
def support_height(points: torch.Tensor, boxes: SceneBoxes, *, floor_y: float = 0.0, step_tol: float = 0.1) -> torch.Tensor:
    """(T, N) height of the surface under each point: the floor or the top of a box whose
    footprint contains the point and whose top is at most `step_tol` above it."""
    support = torch.full(points.shape[:2], float(floor_y), dtype=points.dtype, device=points.device)
    if not boxes.half.shape[0]:
        return support
    boxes = _boxes_like(boxes, points)
    local = to_box_local(points, boxes)
    half = boxes.half[None, None]
    over = (local[..., 0].abs() <= half[..., 0]) & (local[..., 2].abs() <= half[..., 2])
    top = (boxes.centers[..., 1] + boxes.half[:, 1:2]).T[:, None, :]  # (T, 1, B)
    eligible = over & (top <= points[..., 1:2] + step_tol)
    tops = torch.where(eligible, top.expand_as(eligible), torch.full_like(eligible, -math.inf, dtype=points.dtype))
    return torch.maximum(support, tops.amax(-1))


def foot_points(joints: torch.Tensor) -> torch.Tensor:
    """cskel27 joints (T, 27, 3) -> (T, 2, 2, 3): feet (left, right) x (ankle, toe)."""
    return joints[:, torch.as_tensor(FOOT_JOINTS, device=joints.device)]


@torch.no_grad()
def stance_hmm(
    feet,
    fps: float,
    boxes: SceneBoxes | None = None,
    *,
    floor_y: float = 0.0,
    contact_height=None,
    stay: float = 0.95,
    height_scale: float = 0.05,
    speed_scale: float = 0.3,
    sharpness: float = 4.0,
    step_tol: float = 0.1,
) -> np.ndarray:
    """Per-foot 2-state (swing/contact) Viterbi. Returns bool (T, F), True = contact.

    feet: (T, F, 3) or (T, F, K, 3) world positions of the current estimate (K contact
    joints per foot, e.g. `foot_points`). Per joint, h = height above its support minus
    its planted height (`contact_height`, broadcastable to (F, K); default: the joint's
    5th-percentile height over the clip), v = horizontal speed. Normalised evidence
    z = min_k sqrt((max(h, 0) / height_scale)^2 + (v / speed_scale)^2) (any planted joint
    means contact); p(contact) = sigmoid(sharpness * (1 - z)); stay probability `stay`.
    """
    # Discrete pass: everything (feet, boxes, contact_height) crosses to float64 CPU here.
    x = _cpu64(feet)
    if x.ndim == 3:
        x = x[:, :, None, :]
    if x.ndim != 4 or x.shape[-1] != 3:
        raise SceneError("bad-feet", f"feet must be (T, F, 3) or (T, F, K, 3), got {tuple(x.shape)}")
    if not torch.isfinite(x).all():
        raise SceneError("non-finite", "foot positions contain NaN or inf")
    t_len, f_len, k_len, _ = x.shape
    flat = x.reshape(t_len, f_len * k_len, 3)
    if boxes is None:
        support = torch.full(flat.shape[:2], float(floor_y), dtype=torch.float64)
    else:
        support = support_height(flat, SceneBoxes(*(_cpu64(v) for v in boxes)), floor_y=floor_y, step_tol=step_tol)
    height = (flat[..., 1] - support).reshape(t_len, f_len, k_len).numpy()
    if contact_height is None:
        ref = np.percentile(height, 5, axis=0)
    else:
        ref = np.broadcast_to(_cpu64(contact_height).numpy(), (f_len, k_len))
    xz = x[..., [0, 2]].numpy()
    speed = np.linalg.norm(np.gradient(xz, axis=0), axis=-1) * fps if t_len > 1 else np.zeros((t_len, f_len, k_len))
    z = np.sqrt((np.maximum(height - ref, 0) / height_scale) ** 2 + (speed / speed_scale) ** 2).min(-1)  # (T, F)
    logit = sharpness * (1 - z)
    # -log sigmoid(l) = softplus(-l); cost[..., 0] swing, cost[..., 1] contact.
    cost = np.stack((np.logaddexp(0, logit), np.logaddexp(0, -logit)), axis=-1)
    switch = -math.log(1 - stay) + math.log(stay)
    out = np.zeros((t_len, f_len), dtype=bool)
    for f in range(f_len):
        acc, back = cost[0, f].copy(), np.zeros((t_len, 2), dtype=np.int64)
        for t in range(1, t_len):
            nxt = np.empty(2)
            for s in range(2):
                via = acc + np.where(np.arange(2) == s, 0.0, switch)
                back[t, s] = int(np.argmin(via))
                nxt[s] = via[back[t, s]] + cost[t, f, s]
            acc = nxt
        state = int(np.argmin(acc))
        for t in range(t_len - 1, -1, -1):
            out[t, f] = state == 1
            state = back[t, state]
    return out


def skate_loss(feet: torch.Tensor, stance, fps: float) -> torch.Tensor:
    """Sum of squared horizontal velocity (m/s) of foot joints between consecutive
    frames that are both stance. feet (T, F, 3) or (T, F, K, 3), stance bool (T, F)."""
    if feet.ndim == 3:
        feet = feet[:, :, None, :]
    stance = torch.as_tensor(stance, dtype=torch.bool, device=feet.device)
    both = (stance[1:] & stance[:-1])[..., None]  # (T-1, F, 1)
    vel = (feet[1:, ..., [0, 2]] - feet[:-1, ..., [0, 2]]) * fps
    return (vel.square().sum(-1) * both).sum()


def camera_center(camera) -> np.ndarray:
    """World camera position from camera.json (`worldToCamera`, OpenCV 4x4) or a 4x4 array."""
    matrix = _cpu64(camera["worldToCamera"] if isinstance(camera, dict) else camera).numpy()
    if matrix.shape != (4, 4) or not np.all(np.isfinite(matrix)):
        raise SceneError("bad-camera", "worldToCamera must be a finite 4x4 matrix")
    return -matrix[:3, :3].T @ matrix[:3, 3]


@torch.no_grad()
def ray_occlusion(points: torch.Tensor, camera_pos, boxes: SceneBoxes, *, eps: float = 1e-6) -> torch.Tensor:
    """bool (T, N): the segment camera -> point passes through a box interior (the point is
    hidden behind a box, or inside one). A point on a box's camera-facing face is visible."""
    t_len, n = points.shape[:2]
    if not boxes.half.shape[0]:
        return torch.zeros((t_len, n), dtype=torch.bool, device=points.device)
    boxes = _boxes_like(boxes, points)
    cam = _cpu64(camera_pos).to(device=points.device, dtype=points.dtype)
    origin = to_box_local(cam.expand(t_len, 1, 3), boxes)  # (T, 1, B, 3)
    d = to_box_local(points, boxes) - origin  # (T, N, B, 3)
    half = boxes.half[None, None].to(points.dtype)
    flat = d.abs() < 1e-12
    safe = torch.where(flat, torch.ones_like(d), d)
    t0, t1 = (-half - origin) / safe, (half - origin) / safe
    inside_slab = origin.abs() < half
    lo = torch.where(flat, torch.where(inside_slab, -math.inf, math.inf), torch.minimum(t0, t1))
    hi = torch.where(flat, torch.where(inside_slab, math.inf, -math.inf), torch.maximum(t0, t1))
    near = torch.clamp(lo.amax(-1), min=0)
    far = torch.clamp(hi.amin(-1), max=1)
    return (far - near > eps).any(-1)

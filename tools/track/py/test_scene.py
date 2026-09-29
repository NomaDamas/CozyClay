import math

import numpy as np
import pytest
import torch

import scene
from scene import SceneError

SCENE_JSON = {  # evidence/exp3/gt/bump/scene.json as written by tools/gt-render/scene-box.mjs
    "kind": "cube",
    "placement": {"x": -0.46474942564964294, "z": 4.095341396331787, "rot": 0, "sx": 1.5, "sy": 1.5, "sz": 0.4},
    "centre": [-0.46474942564964294, 0.75, 4.095341396331787],
    "halfExtents": [0.75, 0.75, 0.2],
    "yawDeg": 0,
    "min": [-1.214749425649643, 0, 3.895341396331787],
    "max": [0.28525057435035706, 1.5, 4.2953413963317875],
}


def boxes_of(records, frames=1, dtype=torch.float64):
    return scene.box_tensors(scene.parse_scene(records), frames, dtype=dtype)


def pts(*xyz):
    return torch.tensor(np.array([xyz], dtype=np.float64))  # (T=1, N, 3)


def ry(yaw):  # three.js rotation about +Y (tools/gt-render/scene-box.mjs boxCorners)
    c, s = math.cos(yaw), math.sin(yaw)
    return np.array([[c, 0, s], [0, 1, 0], [-s, 0, c]])


def reference_sdf(p, center, half, yaw):
    local = ry(yaw).T @ (np.asarray(p) - center)
    q = np.abs(local) - half
    if np.all(q <= 0):
        return float(q.max())
    return float(np.linalg.norm(local - np.clip(local, -half, half)))


# --- parsing ---------------------------------------------------------------

def test_parses_bench_scene_json_min_max():
    [box] = scene.parse_scene({"min": [0, 0, 0], "max": [2, 1, 4]})
    np.testing.assert_allclose(box.center, [1, 0.5, 2])
    np.testing.assert_allclose(box.half_extents, [1, 0.5, 2])
    assert box.yaw == 0 and box.per_frame_center is None


def test_parses_real_scene_json_and_boxes_list():
    [box] = scene.parse_scene(SCENE_JSON)
    np.testing.assert_allclose(box.center, SCENE_JSON["centre"])
    np.testing.assert_allclose(box.half_extents, SCENE_JSON["halfExtents"])
    two = scene.parse_scene({"boxes": [{"min": SCENE_JSON["min"], "max": SCENE_JSON["max"]}, {"center": [0, 1, 0], "halfExtents": [1, 1, 1], "yawDeg": 90}]})
    assert len(two) == 2 and two[1].yaw == pytest.approx(math.pi / 2)
    assert scene.parse_scene(None) == []


def test_parses_shot_context_obb_with_per_frame():
    [box] = scene.parse_scene([{"center": [0, 0.5, 0], "halfExtents": [0.5, 0.5, 0.5], "yaw": 0.3,
                                 "perFrame": [[0, 0.5, 0], {"center": [1, 0.5, 0], "yaw": 0.6}, {"centre": [2, 0.5, 0]}]}])
    t = scene.box_tensors([box], 3, dtype=torch.float64)
    np.testing.assert_allclose(t.centers[0, :, 0].numpy(), [0, 1, 2])
    np.testing.assert_allclose(t.yaw[0].numpy(), [0.3, 0.6, 0.3])
    with pytest.raises(SceneError) as err:
        scene.box_tensors([box], 4)
    assert err.value.code == "box-frames-mismatch"


@pytest.mark.parametrize("record", [
    {"min": [0, 0, 0], "max": [0, 0, 0]},
    {"min": [0, 0, 0], "max": [1, 0, 1]},
    {"min": [1, 0, 0], "max": [0, 1, 1]},
    {"center": [0, 0, 0], "halfExtents": [0.5, 0, 0.5]},
])
def test_zero_or_negative_size_is_degenerate_box(record):
    with pytest.raises(SceneError) as err:
        scene.parse_scene(record)
    assert err.value.code == "degenerate-box"
    assert str(err.value).startswith("degenerate-box")


@pytest.mark.parametrize("record", [
    {"min": [0, float("nan"), 0], "max": [1, 1, 1]},
    {"center": [0, 0, 0], "halfExtents": [0.5, float("inf"), 0.5]},
    {"center": [0, 0, 0], "halfExtents": [0.5, 0.5, 0.5], "yaw": float("nan")},
    {"center": [0, 0, 0], "halfExtents": [0.5, 0.5, 0.5], "perFrame": [[0, float("nan"), 0]]},
    {"center": [0, 0, 0]},
    {"min": [0, 0], "max": [1, 1]},
    "box",
])
def test_malformed_box_is_rejected(record):
    with pytest.raises(SceneError) as err:
        scene.parse_scene(record)
    assert err.value.code == "bad-box"


# --- signed distance ---------------------------------------------------------

def test_sdf_unit_box_sign_and_magnitude():
    boxes = boxes_of({"min": [-0.5, -0.5, -0.5], "max": [0.5, 0.5, 0.5]})
    sd = scene.box_sdf(pts([0, 0, 0], [0.4, 0, 0], [0.5, 0, 0], [1, 0, 0], [1, 1, 0], [1, 1, 1], [0, -2, 0]), boxes)[0, :, 0]
    expected = [-0.5, -0.1, 0.0, 0.5, math.sqrt(0.5), math.sqrt(0.75), 1.5]
    np.testing.assert_allclose(sd.numpy(), expected, atol=1e-12)


def test_sdf_rotated_and_translated_box():
    center, half, yaw = np.array([2.0, 0.75, -3.0]), np.array([1.0, 0.75, 0.2]), math.radians(90)
    boxes = boxes_of({"center": center.tolist(), "halfExtents": half.tolist(), "yawDeg": 90})
    # Rotated 90 deg the long (x) side lies along world z: 0.9 m along z is inside, 0.5 m along x is outside.
    sd = scene.box_sdf(pts(center + [0, 0, 0.9], center + [0.5, 0, 0], center), boxes)[0, :, 0].numpy()
    np.testing.assert_allclose(sd, [-0.1, 0.3, -0.2], atol=1e-12)
    corners = [center + ry(yaw) @ (half * [sx, sy, sz]) for sx in (-1, 1) for sy in (-1, 1) for sz in (-1, 1)]
    np.testing.assert_allclose(scene.box_sdf(pts(*corners), boxes)[0, :, 0].numpy(), 0, atol=1e-12)


def test_sdf_matches_reference_on_random_points():
    rng = np.random.default_rng(8)
    center, half, yaw = np.array([-0.46, 0.75, 4.1]), np.array([0.75, 0.75, 0.2]), 0.7
    boxes = boxes_of({"center": center.tolist(), "halfExtents": half.tolist(), "yaw": yaw})
    points = center + rng.uniform(-1.5, 1.5, size=(500, 3))
    sd = scene.box_sdf(torch.tensor(points[None]), boxes)[0, :, 0].numpy()
    ref = np.array([reference_sdf(p, center, half, yaw) for p in points])
    np.testing.assert_allclose(sd, ref, atol=1e-10)
    assert (sd < 0).any() and (sd > 0).any()


def test_sdf_follows_per_frame_box():
    boxes = boxes_of({"center": [0, 0.5, 0], "halfExtents": [0.5, 0.5, 0.5], "perFrame": [[0, 0.5, 0], [3, 0.5, 0]]}, frames=2)
    sd = scene.box_sdf(torch.tensor([[[0, 0.5, 0]], [[0, 0.5, 0]]], dtype=torch.float64), boxes)[:, 0, 0]
    np.testing.assert_allclose(sd.numpy(), [-0.5, 2.5])


def test_penetration_loss_values_and_finite_gradients():
    boxes = boxes_of({"min": [-0.5, 0, -0.5], "max": [0.5, 1, 0.5]})
    # inside, on a face, on an edge, on a corner, at the box centre, outside, below the floor
    points = pts([0.4, 0.5, 0], [0.5, 0.5, 0], [0.5, 1, 0], [0.5, 1, 0.5], [0, 0.5, 0], [2, 0.5, 0], [3, -0.02, 0]).requires_grad_(True)
    loss = scene.penetration_loss(points, boxes)
    assert loss["box"].item() == pytest.approx(0.1 ** 2 + 0.5 ** 2)
    assert loss["floor"].item() == pytest.approx(0.02 ** 2)
    (loss["box"] + loss["floor"]).backward()
    grad = points.grad[0]
    assert torch.isfinite(grad).all()
    assert grad[0, 0] < 0  # descending pushes the penetrating point out through the +x face
    assert grad[6, 1] < 0  # and the sunken point up through the floor
    assert torch.all(grad[5] == 0)
    sd_points = pts([0.5, 1, 0.5], [2, 3, 4]).requires_grad_(True)
    scene.box_sdf(sd_points, boxes).sum().backward()
    assert torch.isfinite(sd_points.grad).all()


def test_penetration_stats_and_empty_scene():
    boxes = boxes_of({"min": [-0.5, 0, -0.5], "max": [0.5, 1, 0.5]}, frames=3)
    points = torch.tensor([[[2, 0.5, 0]], [[0.45, 0.5, 0]], [[2, -0.01, 0]]], dtype=torch.float64)
    stats = scene.penetration_stats(points, boxes)
    assert stats["maxBoxCm"] == pytest.approx(5.0)
    assert stats["maxFloorCm"] == pytest.approx(1.0)
    assert stats["frames"] == [1, 2]
    empty = scene.box_tensors([], 3, dtype=torch.float64)
    assert scene.penetration_loss(points, empty)["box"].item() == 0
    assert scene.penetration_stats(points, empty)["maxBoxCm"] == 0
    assert not scene.ray_occlusion(points, [0, 1, 5], empty).any()


# --- stance HMM and skate ------------------------------------------------------

def synthetic_walk(frames=150, fps=30.0, period=1.0, duty=0.6, stride=1.2, seed=0, ground=None):
    """Ankle+toe of two feet, (T, 2, 2, 3), and the true stance (T, 2)."""
    rng = np.random.default_rng(seed)
    feet, stance = np.zeros((frames, 2, 2, 3)), np.zeros((frames, 2), dtype=bool)
    for f, (phase, x_side) in enumerate(((0.0, 0.1), (0.5, -0.1))):
        for t in range(frames):
            cycle = t / fps / period + phase
            k, u = math.floor(cycle), cycle - math.floor(cycle)
            if u < duty:
                s, lift = 0.0, 0.0
                stance[t, f] = True
            else:
                w = (u - duty) / (1 - duty)
                s, lift = (1 - math.cos(math.pi * w)) / 2, math.sin(math.pi * w)
            z = (k + s) * stride + phase * stride
            base = 0.0 if ground is None else ground(z)
            feet[t, f, 0] = [x_side, base + 0.08 + 0.12 * lift, z]
            feet[t, f, 1] = [x_side, base + 0.02 + 0.10 * lift, z + 0.15]
    return feet + rng.normal(0, 0.004, feet.shape), stance, fps


def test_stance_hmm_recovers_walk():
    feet, truth, fps = synthetic_walk()
    got = scene.stance_hmm(torch.tensor(feet), fps)
    assert got.shape == truth.shape
    agreement = (got == truth).mean(axis=0)
    assert np.all(agreement >= 0.9), agreement
    # every true stance run is found and no spurious one-frame toggles appear
    for f in range(2):
        runs = np.flatnonzero(np.diff(got[:, f].astype(int)) != 0)
        assert len(runs) <= len(np.flatnonzero(np.diff(truth[:, f].astype(int)) != 0)) + 1
    explicit = scene.stance_hmm(feet, fps, contact_height=[[0.08, 0.02], [0.08, 0.02]])
    assert np.all((explicit == truth).mean(axis=0) >= 0.9)


def test_stance_hmm_uses_box_top_as_support():
    top = 0.4
    boxes = boxes_of({"min": [-1, 0, 2.0], "max": [1, top, 20]})
    feet, truth, fps = synthetic_walk(ground=lambda z: top if z >= 2.0 else 0.0)
    ref = [[0.08, 0.02], [0.08, 0.02]]
    with_box = scene.stance_hmm(feet, fps, boxes, contact_height=ref)
    assert np.all((with_box == truth).mean(axis=0) >= 0.9)
    on_box = feet[:, :, 0, 2] > 2.2
    floor_only = scene.stance_hmm(feet, fps, contact_height=ref)
    assert not floor_only[on_box & truth].any()  # without the box a planted foot on it looks airborne


def test_support_height_floor_box_top_and_step_tolerance():
    boxes = boxes_of({"center": [0, 0.2, 0], "halfExtents": [0.5, 0.2, 0.5], "yawDeg": 45})
    # beside the box, on its top, 5 cm sunk into its top, deep inside it, inside the unrotated
    # footprint's corner but outside the 45-degree footprint
    points = pts([2, 0.1, 0], [0, 0.45, 0], [0.1, 0.35, 0], [0, 0.1, 0], [0.45, 0.45, 0.45])
    np.testing.assert_allclose(scene.support_height(points, boxes)[0].numpy(), [0, 0.4, 0.4, 0, 0])


def test_stance_hmm_rejects_nan():
    feet, _, fps = synthetic_walk(frames=10)
    feet[4, 0, 0, 1] = np.nan
    with pytest.raises(SceneError) as err:
        scene.stance_hmm(feet, fps)
    assert err.value.code == "non-finite"


def test_skate_loss_only_on_stance_frames_and_differentiable():
    fps = 30.0
    joints = torch.zeros(4, 27, 3, dtype=torch.float64)
    joints[:, 25, 0] = torch.tensor([0.0, 0.01, 0.02, 0.5])  # left ankle slides 1 cm/frame, then jumps
    joints[:, 21, 1] = torch.tensor([0.0, 0.5, 1.0, 1.5])  # right ankle moves vertically only
    joints.requires_grad_(True)
    stance = np.array([[1, 1], [1, 1], [1, 1], [0, 1]], dtype=bool)
    loss = scene.skate_loss(scene.foot_points(joints), stance, fps)
    assert loss.item() == pytest.approx(2 * (0.01 * fps) ** 2)
    loss.backward()
    assert torch.isfinite(joints.grad).all()
    assert joints.grad[3, 25, 0] == 0
    assert scene.skate_loss(scene.foot_points(joints), np.zeros((4, 2), dtype=bool), fps).item() == 0


# --- occlusion -------------------------------------------------------------------

def test_camera_center_from_world_to_camera():
    yaw = 0.5235987755982988
    r = ry(yaw).T * np.array([[1], [-1], [-1]])  # OpenCV y down, z forward from a three.js camera
    position = np.array([1.72, 1.13, 7.13])
    w2c = np.eye(4)
    w2c[:3, :3], w2c[:3, 3] = r, -r @ position
    np.testing.assert_allclose(scene.camera_center({"worldToCamera": w2c.tolist()}), position, atol=1e-12)
    with pytest.raises(SceneError):
        scene.camera_center(np.full((4, 4), np.nan))


def test_ray_occlusion_behind_vs_in_front():
    cam = [0, 1, 5]
    boxes = boxes_of({"min": [-0.5, 0.5, -0.5], "max": [0.5, 1.5, 0.5]})
    points = pts([0, 1, -2], [0, 1, 2], [2, 1, -2], [0, 1, 0], [0, 1, 0.5], [0, 2, -2])
    np.testing.assert_array_equal(scene.ray_occlusion(points, cam, boxes)[0].numpy(), [True, False, False, True, False, False])
    # a box behind the camera hides nothing in front of it
    behind_camera = boxes_of({"min": [-0.5, 0.5, 7], "max": [0.5, 1.5, 8]})
    assert not scene.ray_occlusion(points, cam, behind_camera).any()


def test_ray_occlusion_rotated_and_moving_box():
    cam = [0, 1, 5]
    # thin wall rotated 90 deg: its long side spans world z, so it only blocks lines of sight near x=0
    wall = {"center": [0, 1, 0], "halfExtents": [1.0, 0.5, 0.05], "yawDeg": 90}
    points = pts([0, 1, -2], [0.3, 1, -2])
    np.testing.assert_array_equal(scene.ray_occlusion(points, cam, boxes_of(wall))[0].numpy(), [True, False])
    np.testing.assert_array_equal(scene.ray_occlusion(points, cam, boxes_of({**wall, "yawDeg": 0}))[0].numpy(), [True, True])
    moving = boxes_of({"center": [0, 1, 0], "halfExtents": [0.5, 0.5, 0.5], "perFrame": [[0, 1, 0], [3, 1, 0]]}, frames=2)
    behind = torch.tensor([[[0, 1, -2]], [[0, 1, -2]]], dtype=torch.float64)
    np.testing.assert_array_equal(scene.ray_occlusion(behind, cam, moving)[:, 0].numpy(), [True, False])


# --- device / dtype boundaries ----------------------------------------------------

def test_float32_points_with_float64_boxes():
    boxes = boxes_of({"min": [-0.5, 0, -0.5], "max": [0.5, 1, 0.5]})  # float64
    points = pts([0.4, 0.5, 0], [0, 0.5, -2]).float().requires_grad_(True)
    sd = scene.box_sdf(points, boxes)
    assert sd.dtype == torch.float32
    scene.penetration_loss(points, boxes)["box"].backward()
    assert torch.isfinite(points.grad).all()
    assert scene.support_height(points, boxes).dtype == torch.float32
    np.testing.assert_array_equal(scene.ray_occlusion(points, torch.tensor([0.0, 0.5, 5]), boxes)[0].numpy(), [True, True])


needs_cuda = pytest.mark.skipif(not torch.cuda.is_available(), reason="CUDA-origin inputs need a CUDA device")


def cuda_boxes(boxes):
    return scene.SceneBoxes(*(v.cuda() for v in boxes))


@needs_cuda
def test_cuda_stance_hmm_matches_cpu_with_and_without_boxes():
    feet, truth, fps = synthetic_walk(seed=0)
    cpu = scene.stance_hmm(feet, fps)
    gpu_feet = torch.tensor(feet, device="cuda")
    np.testing.assert_array_equal(scene.stance_hmm(gpu_feet, fps), cpu)
    np.testing.assert_array_equal(scene.stance_hmm(gpu_feet.float(), fps), scene.stance_hmm(torch.tensor(feet).float(), fps))
    top = 0.4
    boxes = boxes_of({"min": [-1, 0, 2.0], "max": [1, top, 20]})
    step, step_truth, _ = synthetic_walk(ground=lambda z: top if z >= 2.0 else 0.0)
    ref = [[0.08, 0.02], [0.08, 0.02]]
    cpu_box = scene.stance_hmm(step, fps, boxes, contact_height=ref)
    gpu_step = torch.tensor(step, device="cuda")
    for support in (boxes, cuda_boxes(boxes)):
        for height in (ref, torch.tensor(ref, device="cuda")):
            got = scene.stance_hmm(gpu_step, fps, support, contact_height=height)
            np.testing.assert_array_equal(got, cpu_box)
    assert np.all((cpu_box == step_truth).mean(axis=0) >= 0.9)


@needs_cuda
def test_cuda_points_with_cpu_or_cuda_boxes():
    cam = [0, 1, 5]
    boxes = boxes_of({"center": [0, 1, 0], "halfExtents": [0.5, 0.5, 0.5], "yawDeg": 30, "perFrame": [[0, 1, 0], [3, 1, 0]]}, frames=2)
    cpu_points = torch.tensor([[[0, 1, -2], [0.3, 1, 0.2], [2, -0.01, 0]], [[0, 1, -2], [0.3, 1, 0.2], [2, 0.5, 0]]], dtype=torch.float64)
    cpu_sd = scene.box_sdf(cpu_points, boxes)
    cpu_occ = scene.ray_occlusion(cpu_points, cam, boxes)
    cpu_support = scene.support_height(cpu_points, boxes)
    cpu_stats = scene.penetration_stats(cpu_points, boxes)
    for support in (boxes, cuda_boxes(boxes)):
        points = cpu_points.cuda().requires_grad_(True)
        sd = scene.box_sdf(points, support)
        assert sd.device.type == "cuda"
        torch.testing.assert_close(sd.cpu(), cpu_sd)
        loss = scene.penetration_loss(points, support)
        (loss["box"] + loss["floor"]).backward()
        assert points.grad.device.type == "cuda" and torch.isfinite(points.grad).all() and points.grad.abs().sum() > 0
        for camera in (cam, torch.tensor(cam, dtype=torch.float64, device="cuda")):
            occ = scene.ray_occlusion(points.detach(), camera, support)
            assert occ.device.type == "cuda"
            torch.testing.assert_close(occ.cpu(), cpu_occ)
        height = scene.support_height(points.detach(), support)
        assert height.device.type == "cuda"
        torch.testing.assert_close(height.cpu(), cpu_support)
        stats = scene.penetration_stats(points.detach(), support)
        assert stats["frames"] == cpu_stats["frames"] == [0]
        assert stats["maxBoxCm"] == pytest.approx(cpu_stats["maxBoxCm"]) and cpu_stats["maxBoxCm"] > 0
        assert stats["maxFloorCm"] == pytest.approx(cpu_stats["maxFloorCm"]) == pytest.approx(1.0)
    joints = torch.zeros(3, 27, 3, device="cuda", requires_grad=True)
    scene.skate_loss(scene.foot_points(joints), np.ones((3, 2), dtype=bool), 30.0).backward()
    assert joints.grad.device.type == "cuda"
    w2c = torch.eye(4, dtype=torch.float64, device="cuda")
    w2c[:3, 3] = torch.tensor([1.0, 2, 3])
    np.testing.assert_allclose(scene.camera_center(w2c), [-1, -2, -3])

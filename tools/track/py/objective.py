"""Image and physical terms for the deterministic cskel27 clip fit.

No image renderer is needed: exterior signed-DT samples prevent spill, and a
foreground-to-surface Chamfer prevents shrinkage. Nearest-neighbour selection
is discrete; its selected squared distance retains the exact local gradient.
"""
from __future__ import annotations

import numpy as np
import torch
from scipy.ndimage import distance_transform_edt

from rig import cskel27_fk, studio_skin
from scene import (SceneBoxes, camera_center, foot_points, penetration_loss,
                   ray_occlusion, skate_loss)

# Face landmarks have no cskel27 counterpart and receive zero data weight.
COCO_JOINTS = [5, 5, 5, 5, 5, 14, 9, 15, 10, 16, 11, 23, 19, 24, 20, 25, 21]

# --track-ablate levels. Each level adds one component to the previous one;
# keypoints and priors (acceleration, limits, endpoints, nuisance) are always
# on, and weights/schedule are identical at every level. 'occlusion' is the
# ray/box visibility of keypoints and surface samples in the fit.
ABLATIONS = {
    'kp-only': frozenset(),
    'silhouette': frozenset({'silhouette'}),
    'viterbi': frozenset({'silhouette', 'viterbi'}),
    'contacts': frozenset({'silhouette', 'viterbi', 'contacts'}),
    'full': frozenset({'silhouette', 'viterbi', 'contacts', 'occlusion'}),
}


def huber(x, delta=1.0):
    return torch.where(x <= delta, 0.5 * x.square(), delta * (x - 0.5 * delta))


def project(points, camera, nuisance):
    """OpenCV projection; nuisance = scale offset, yaw/pitch degrees, focal %."""
    xyz = points @ camera[0].T + camera[1]
    yaw, pitch = nuisance[1:3] * (np.pi / 180)
    cy, sy, cp, sp = yaw.cos(), yaw.sin(), pitch.cos(), pitch.sin()
    x, y, z = xyz.unbind(-1)
    x, z = cy * x + sy * z, -sy * x + cy * z
    y, z = cp * y - sp * z, sp * y + cp * z
    xy = torch.stack((x, y), -1) / z.clamp_min(1e-3).unsqueeze(-1)
    K = camera[2]
    return xy * torch.stack((K[0, 0], K[1, 1])) * (1 + nuisance[3] / 100) + K[:2, 2], z


def camera_tensors(camera, device):
    w = torch.tensor(camera['worldToCamera'], dtype=torch.float32, device=device)
    return w[:3, :3], w[:3, 3], torch.tensor(camera['K'], dtype=torch.float32, device=device)


def slice_boxes(boxes, start, end):
    return SceneBoxes(boxes.centers[:, start:end], boxes.half, boxes.yaw[:, start:end])


class MaskEvidence:
    def __init__(self, prob, width, height, count=1000):
        self.binary = np.asarray(prob) >= 0.5
        self.ratio = np.array([prob.shape[2] / width, prob.shape[1] / height], np.float32)
        rng = np.random.default_rng(0)
        distances, targets, valid = [], [], []
        for mask in self.binary:
            distances.append(distance_transform_edt(~mask) - distance_transform_edt(mask))
            y, x = np.nonzero(mask)
            if len(x):
                # Stratification avoids over-representing a dense image region.
                idx = np.minimum(((np.arange(count) + rng.random(count)) * len(x) / count).astype(int), len(x) - 1)
                targets.append(np.stack((x[idx] + 0.5, y[idx] + 0.5), -1))
                valid.append(True)
            else:
                targets.append(np.zeros((count, 2)))
                valid.append(False)
        self.dt = np.asarray(distances, np.float32)
        self.targets = np.asarray(targets, np.float32)
        self.valid = np.asarray(valid)

    def window(self, start, end, device):
        return tuple(torch.as_tensor(x, device=device) for x in
                     (self.dt[start:end], self.targets[start:end], self.valid[start:end], self.ratio))


def bilinear_dt(dt, uv):
    """Pixel centres are at n+0.5. Include off-image distance (no border escape)."""
    h, w = dt.shape[-2:]
    q = uv - 0.5
    x, y = q[..., 0].clamp(0, w - 1.001), q[..., 1].clamp(0, h - 1.001)
    ix, iy = x.long(), y.long()
    fx, fy = x - ix, y - iy
    flat = dt.flatten(1)
    at = lambda dx, dy: flat.gather(1, (iy + dy) * w + ix + dx)
    d = (1 - fy) * ((1 - fx) * at(0, 0) + fx * at(1, 0)) + fy * ((1 - fx) * at(0, 1) + fx * at(1, 1))
    return d + (q - torch.stack((x, y), -1)).norm(dim=-1)


def coverage_loss(uv, visible, target, frame_valid, delta):
    # Query tiles bound scratch to 240*64*2000 floats (<118 MiB), with no
    # T*foreground*surface autograd graph. All 1000 queries still participate.
    indices = []
    with torch.no_grad():
        detached = uv.detach()
        vv = detached.square().sum(-1)[:, None]
        for chunk in target.split(64, dim=1):
            distance = chunk.square().sum(-1, keepdim=True) + vv - 2 * (chunk @ detached.transpose(1, 2))
            distance.masked_fill_(~visible[:, None], float('inf'))
            indices.append(distance.argmin(-1))
    idx = torch.cat(indices, 1)
    nearest = uv.gather(1, idx[..., None].expand(-1, -1, 2))
    active = (visible.any(-1) & frame_valid).float()
    loss = huber((nearest - target).norm(dim=-1) / delta).mean(-1)
    return (loss * active).sum() / active.sum().clamp_min(1)


def surface_samples(rig, count=2000):
    """Fixed area-stratified face samples, reused across frames and all runs."""
    v = rig.dec_vertices.detach().cpu().numpy()
    f = rig.dec_faces.cpu().numpy()
    area = np.linalg.norm(np.cross(v[f[:, 1]] - v[f[:, 0]], v[f[:, 2]] - v[f[:, 0]]), axis=-1)
    rng = np.random.default_rng(0)
    cdf = np.cumsum(area) / area.sum()
    selected = np.searchsorted(cdf, (np.arange(count) + rng.random(count)) / count)
    a, b = np.sqrt(rng.random(count)), rng.random(count)
    bary = np.stack((1 - a, a * (1 - b), a * b), -1)
    return (torch.as_tensor(f[selected], device=rig.dec_vertices.device),
            torch.tensor(bary, dtype=rig.dec_vertices.dtype, device=rig.dec_vertices.device))


class ClipObjective:
    def __init__(self, rig, bone_scale, camera, boxes, masks, kp, fps, delta_px, endpoints, components=ABLATIONS['full']):
        self.rig, self.bone_scale = rig, bone_scale
        self.components = components
        self.camera = camera_tensors(camera, rig.neutral.device)
        self.camera_pos = camera_center(camera)
        self.boxes, self.masks, self.kp = boxes, masks, kp
        self.fps, self.delta = fps, delta_px
        self.endpoints = endpoints
        self.faces, self.bary = surface_samples(rig)
        # Generous rest-relative caps preserve stylised motion. Root is free.
        self.caps = torch.tensor([180, 65, 65, 65, 90, 90, 180, 180, 90,
                                  175, 175, 110, 150, 90, 175, 175, 110, 150,
                                  180, 160, 175, 100, 80, 160, 175, 100, 80],
                                 device=rig.neutral.device) * (np.pi / 180)

    def geometry(self, state, nuisance):
        joints, globals_ = cskel27_fk(state, self.bone_scale, self.rig)
        _, verts = studio_skin(globals_, joints, self.rig, bone_scale=self.bone_scale)
        root = state.transl[:, None]
        joints = root + (joints - root) * (1 + nuisance[0])
        verts = root + (verts - root) * (1 + nuisance[0])
        return joints, verts

    def __call__(self, state, nuisance, start, end, assigned, stance, penetration_weight):
        joints, vertices = self.geometry(state, nuisance)
        boxes = slice_boxes(self.boxes, start, end)
        occlusion = 'occlusion' in self.components
        projected, depth = project(joints[:, COCO_JOINTS], self.camera, nuisance)
        seen = depth > 0
        if occlusion:
            seen = ~ray_occlusion(joints[:, COCO_JOINTS], self.camera_pos, boxes) & seen
        weights = assigned[..., 2] * seen.float()
        residual = (projected - assigned[..., :2]).norm(dim=-1) / self.delta
        kp_loss = (huber(residual) * weights).sum() / weights.sum().clamp_min(1)
        zero = kp_loss * 0
        silhouette = zero
        if 'silhouette' in self.components:
            samples = (vertices[:, self.faces] * self.bary[None, :, :, None]).sum(-2)
            uv, sz = project(samples, self.camera, nuisance)
            visible = sz > 0
            if occlusion:
                visible = ~ray_occlusion(samples, self.camera_pos, boxes) & visible
            dt, target, valid, ratio = self.masks
            uv = uv * ratio
            d = bilinear_dt(dt, uv).relu() / (self.delta * ratio.mean())
            active = visible & valid[:, None]
            boundary = (huber(d) * active).sum() / active.sum().clamp_min(1)
            coverage = coverage_loss(uv, visible, target, valid, self.delta * ratio.mean())
            silhouette = (boundary + coverage) / 2
        # Second differences at the clip's sampling rate, robust above 3 m/s^2;
        # no velocity damping of freely moving limbs.
        if len(joints) > 2:
            acc = (joints[2:] - 2 * joints[1:-1] + joints[:-2]) * self.fps ** 2
            acceleration = huber(acc.norm(dim=-1) / 3).mean()
        else:
            acceleration = kp_loss * 0
        rotations = state.local_rot_mats()
        cos = ((rotations.diagonal(dim1=-2, dim2=-1).sum(-1) - 1) / 2).clamp(-1 + 1e-6, 1 - 1e-6)
        limits = (cos.acos() - self.caps).relu().square().mean()
        skate = penetration = zero
        if 'contacts' in self.components:
            feet = foot_points(joints)
            skate = skate_loss(feet, stance, self.fps) / max(1, (end - start - 1) * 4)
            pen = penetration_loss(vertices, boxes)
            # Metres -> a 1 cm residual; normalise by points rather than active
            # collisions, so there is no discontinuity when a vertex exits a solid.
            penetration = (pen['box'] + pen['floor']) / (vertices.shape[0] * vertices.shape[1] * 0.01 ** 2)
        endpoint = zero
        for frame, pose in self.endpoints.items():
            if start <= frame < end:
                i = frame - start
                endpoint = endpoint + ((state.transl[i] - pose[0]) / 0.05).square().mean() + (rotations[i] - pose[1]).square().mean()
        nuisance_prior = ((nuisance / nuisance.new_tensor([0.01, 0.3, 0.3, 0.3])) ** 2).sum()
        terms = dict(keypoints=kp_loss, silhouette=silhouette, acceleration=acceleration,
                     limits=limits, skate=skate, penetration=penetration,
                     endpoints=endpoint, nuisance=nuisance_prior)
        # Disabled terms are not evaluated, so they are not reported as zeros.
        if 'silhouette' not in self.components:
            del terms['silhouette']
        if 'contacts' not in self.components:
            del terms['skate'], terms['penetration']
        # Silhouette depth is the only strong root-Z cue when the pelvis keypoint is absent.
        total = kp_loss + 6.0 * silhouette + 0.05 * acceleration + 0.1 * limits + skate + penetration_weight * penetration + 0.2 * endpoint + nuisance_prior
        return total, terms

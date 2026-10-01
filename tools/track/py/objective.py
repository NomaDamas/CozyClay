"""Image and physical terms for the deterministic cskel27 clip fit.

No image renderer is needed: exterior signed-DT samples prevent spill, and a
foreground-to-surface Chamfer prevents shrinkage. Nearest-neighbour selection
is discrete; its selected squared distance retains the exact local gradient.
"""
from __future__ import annotations

import numpy as np
import torch
from scipy.ndimage import distance_transform_edt

from rig import State, cskel27_fk, studio_skin
from scene import (FOOT_JOINTS, SceneBoxes, camera_center, foot_points, penetration_loss,
                   ray_occlusion, skate_loss, support_height)

# Face landmarks have no cskel27 counterpart and receive zero data weight.
COCO_JOINTS = [5, 5, 5, 5, 5, 14, 8, 15, 9, 16, 10, 23, 19, 24, 20, 25, 21]
# Bilateral Shoulder, Arm, ForeArm, Hand; exclude HandEnd/Thumb on both sides.
ARM_TRUST_JOINTS = [7, 8, 9, 10, 13, 14, 15, 16]
JOINT_CAPS_DEG = [180, 65, 65, 65, 90, 90, 180,
                  90, 175, 175, 110, 150, 180,
                  90, 175, 175, 110, 150, 180,
                  160, 175, 100, 80, 160, 175, 100, 80]

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


def trust_region_loss(root, rotations, initial_root, initial_rotations):
    """Bounded G5 tether: retain trajectory shape, not its placement error.

    A 25 cm centred path deviation or 30 degree rotation has unit squared
    residual. Saturation lets persistent image evidence escape a bad G5 basin.
    """
    shift = root - initial_root
    path_squared = ((shift - shift.mean(0)) / 0.25).square().sum(-1)
    angle_squared = (rotations - initial_rotations).square().sum((-1, -2)) / (8 * np.sin(np.pi / 12) ** 2)
    weights = rotations.new_ones(27)
    weights[0] = 2
    weights[ARM_TRUST_JOINTS] = 4
    return (2 * (path_squared / (1 + path_squared)).mean()
            + (weights * angle_squared / (1 + angle_squared)).mean())


@torch.no_grad()
def articulation_reliability(projected, assigned, seen, delta):
    """G5 shape disagreement, excluding common image translation and L/R swaps.

    Residuals within detector noise are fully trusted. Beyond that band use
    Geman-McClure influence weights; confidence/visibility can only reduce them.
    These labels are frozen per block, not learned by fitting the bad keypoint.
    """
    offset = projected - assigned[..., :2]
    valid = seen & (assigned[..., 2] >= 0.5)
    body = offset[:, 5:].masked_fill(~valid[:, 5:, None], float('inf'))
    # Same lower median as nanmedian, without its nondeterministic CUDA
    # indices kernel. No-evidence frames use zero common translation.
    ordered = body.sort(dim=1, stable=True).values
    count = valid[:, 5:].sum(-1)
    middle = ((count - 1) // 2).clamp_min(0)
    center = ordered.gather(1, middle[:, None, None].expand(-1, 1, 2)).squeeze(1)
    center = torch.where(count[:, None] > 0, center, torch.zeros_like(center))
    excess = ((offset - center[:, None]).norm(dim=-1) / delta - 1).relu() / 2
    return assigned[..., 2] * seen / (1 + excess.square()).square()


def articulation_trust_loss(rotations, initial_rotations, uncertainty):
    """Local rotations only; 15-degree Huber scale, no root/placement tether."""
    chord = (rotations[:, 1:] - initial_rotations[:, 1:]).norm(dim=(-1, -2))
    return (huber(chord / np.sqrt(8 * np.sin(np.pi / 24) ** 2)) * uncertainty).mean()


def heading_rate_loss(root_rotations, fps):
    """World-Y twist increments, circularly unwrapped rather than Euler-smoothed.

    Ordinary turns below 3 rad/s are free; excess rate is Huber-robust at
    3 rad/s. Near a 180-degree tilt yaw is undefined, so omit only those pairs.
    No absolute heading is prescribed, and L/R assignment remains independent.
    """
    cs = torch.stack((root_rotations[:, 0, 0] + root_rotations[:, 2, 2],
                      root_rotations[:, 0, 2] - root_rotations[:, 2, 0]), -1)
    defined = cs.square().sum(-1) > 1e-4
    cs = torch.where(defined[:, None], cs, cs.new_tensor([1, 0]))
    cosine = (cs[1:] * cs[:-1]).sum(-1)
    sine = cs[1:, 1] * cs[:-1, 0] - cs[1:, 0] * cs[:-1, 1]
    rate = torch.atan2(sine, cosine).abs() * fps
    active = defined[1:] & defined[:-1]
    return (huber((rate - 3).relu() / 3) * active).sum() / active.sum().clamp_min(1)


class ClipObjective:
    def __init__(self, rig, bone_scale, camera, boxes, masks, kp, fps, delta_px, endpoints, initializer, components=ABLATIONS['full']):
        self.rig, self.bone_scale = rig, bone_scale
        self.components = components
        self.camera = camera_tensors(camera, rig.neutral.device)
        self.camera_pos = camera_center(camera)
        self.boxes, self.masks, self.kp = boxes, masks, kp
        self.fps, self.delta = fps, delta_px
        self.endpoints = endpoints
        self.initial_root = initializer.transl.detach().clone()
        self.initial_rotations = initializer.local_rot_mats().detach().clone()
        self.initial_local6d = initializer.local6d.detach().clone()
        # An observed joint constrains the local chain leading to it. Leaves
        # without their own keypoint inherit their parent's evidence, not root.
        influence = np.zeros((27, 17), np.float32)
        for coco, joint in enumerate(COCO_JOINTS[5:], start=5):
            while joint > 0:
                influence[joint, coco] = 1
                joint = rig.parents[joint]
        for joint in range(1, 27):
            if not influence[joint].any():
                influence[joint] = influence[rig.parents[joint]]
        influence = influence[1:] / np.maximum(1, influence[1:].sum(-1, keepdims=True))
        self.articulation_influence = torch.as_tensor(influence, device=rig.neutral.device)
        self.faces, self.bary = surface_samples(rig)
        self.foot_vertices = [torch.nonzero(
            rig.dec_weights[:, [rig.prep_bone[j] for j in foot]].sum(-1) > 0.5).flatten()
            for foot in FOOT_JOINTS]
        # Generous rest-relative caps preserve stylised motion. Root is free.
        self.caps = torch.tensor(JOINT_CAPS_DEG, device=rig.neutral.device) * (np.pi / 180)

    def geometry(self, state, nuisance):
        joints, globals_ = cskel27_fk(state, self.bone_scale, self.rig)
        _, verts = studio_skin(globals_, joints, self.rig, bone_scale=self.bone_scale)
        root = state.transl[:, None]
        joints = root + (joints - root) * (1 + nuisance[0])
        verts = root + (verts - root) * (1 + nuisance[0])
        return joints, verts

    @torch.no_grad()
    def articulation_observation(self, state, nuisance, assigned):
        # Keep G5 articulation but let the fitted root and global orientation
        # explain camera placement. Never tether the global pose to this prior.
        reference = State(state.transl, state.root6d, self.initial_local6d)
        joints, _ = cskel27_fk(reference, self.bone_scale, self.rig)
        joints = state.transl[:, None] + (joints - state.transl[:, None]) * (1 + nuisance[0])
        projected, depth = project(joints[:, COCO_JOINTS], self.camera, nuisance)
        seen = depth > 0
        if 'occlusion' in self.components:
            seen &= ~ray_occlusion(joints[:, COCO_JOINTS], self.camera_pos, self.boxes)
        reliable = articulation_reliability(projected, assigned, seen, self.delta)
        uncertainty = (1 - reliable).square() @ self.articulation_influence.T
        # Retain a weak escape route from a wrong G5 pose; do not renormalize
        # these attenuated data weights back to a full observation's strength.
        return 0.1 + 0.9 * reliable, uncertainty

    def sole_points(self, vertices):
        """Lowest four skinned foot vertices, not an ankle-as-sole offset."""
        soles = []
        for indices in self.foot_vertices:
            foot = vertices[:, indices]
            lowest = foot[..., 1].topk(4, dim=1, largest=False).indices
            soles.append(foot.gather(1, lowest[..., None].expand(-1, -1, 3)))
        return torch.stack(soles, 1)

    @torch.no_grad()
    def support_observation(self, state, nuisance, assigned, stance, hidden):
        """Freeze reliable stance/support labels between blocks; no ankle ray pin.

        The HMM is relative to a clip percentile and alone can label hovering
        or a jump apex as stance. Require absolute proximity, two quiet motion
        intervals and a consistent confident ankle observation as well.
        """
        joints, vertices = self.geometry(state, nuisance)
        sole = self.sole_points(vertices)
        height = support_height(sole.flatten(1, 2), self.boxes).reshape(sole.shape[:-1])
        support = height.mean(-1)
        clearance = sole[..., 1].mean(-1) - support
        uv, depth = project(joints[:, [25, 21]], self.camera, nuisance)
        ankle = assigned[:, [15, 16]]
        active = (stance & (depth > 0) & (ankle[..., 2] >= 0.5)
                  & ((uv - ankle[..., :2]).norm(dim=-1) <= 2 * self.delta)
                  & (clearance >= -0.03) & (clearance <= 0.10)
                  & (height.amax(-1) - height.amin(-1) <= 0.02))
        if 'occlusion' in self.components:
            active &= ~hidden[:, [25, 21]]
        # Stable ankle OR toe across both adjacent intervals. A moving foot
        # is not evidence of ground contact, even if the HMM calls it stance.
        velocity = (foot_points(joints)[1:] - foot_points(joints)[:-1]) * self.fps
        quiet = ((velocity[..., [0, 2]].norm(dim=-1) <= 0.10)
                 & (velocity[..., 1].abs() <= 0.15)).any(-1)
        stable = torch.zeros_like(active)
        stable[1:-1] = (active[:-2] & active[1:-1] & active[2:]
                        & quiet[:-1] & quiet[1:])
        return support, stable

    def __call__(self, state, nuisance, start, end, assigned, stance, penetration_weight,
                 trust_weight, support=None, articulation=None):
        joints, vertices = self.geometry(state, nuisance)
        boxes = slice_boxes(self.boxes, start, end)
        occlusion = 'occlusion' in self.components
        projected, depth = project(joints[:, COCO_JOINTS], self.camera, nuisance)
        seen = depth > 0
        if occlusion:
            seen = ~ray_occlusion(joints[:, COCO_JOINTS], self.camera_pos, boxes) & seen
        weights = assigned[..., 2] * seen.float()
        residual = (projected - assigned[..., :2]).norm(dim=-1) / self.delta
        kp_terms = huber(residual) * weights
        if articulation is not None:
            kp_terms = kp_terms * articulation[0]
        kp_loss = kp_terms.sum() / weights.sum().clamp_min(1)
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
            acceleration = zero
        rotations = state.local_rot_mats()
        heading = heading_rate_loss(rotations[:, 0], self.fps)
        articulation_trust = zero if articulation is None else articulation_trust_loss(
            rotations, self.initial_rotations[start:end], articulation[1])
        trust = trust_region_loss(state.transl, rotations, self.initial_root[start:end],
                                  self.initial_rotations[start:end]) if trust_weight else zero
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
        support_loss = zero
        if support is not None:
            target_height, reliable = support
            sole_height = self.sole_points(vertices)[..., 1].mean(-1)
            support_loss = (huber((sole_height - target_height).abs() / 0.03)
                            * reliable).sum() / reliable.sum().clamp_min(1)
        endpoint = zero
        for frame, pose in self.endpoints.items():
            if start <= frame < end:
                i = frame - start
                endpoint = endpoint + ((state.transl[i] - pose[0]) / 0.05).square().mean() + (rotations[i] - pose[1]).square().mean()
        nuisance_prior = ((nuisance / nuisance.new_tensor([0.01, 0.3, 0.3, 0.3])) ** 2).sum()
        terms = dict(keypoints=kp_loss, silhouette=silhouette, acceleration=acceleration,
                     trust=trust, headingRate=heading,
                     limits=limits, skate=skate, penetration=penetration,
                     endpoints=endpoint, nuisance=nuisance_prior)
        if articulation is not None:
            terms['articulationTrust'] = articulation_trust
            terms['articulationUncertainty'] = articulation[1].mean()
            terms['keypointReliabilityWeight'] = articulation[0][:, 5:].mean()
        if support is not None:
            terms['supportHeight'] = support_loss
            terms['supportFootFrames'] = support[1].sum()
        # Disabled terms are not evaluated, so they are not reported as zeros.
        if 'silhouette' not in self.components:
            del terms['silhouette']
        if 'contacts' not in self.components:
            del terms['skate'], terms['penetration']
        # Keep the silhouette depth support; bounded G5 trust discourages
        # unsupported articulation/path excursions without pinning placement.
        total = (kp_loss + 6.0 * silhouette + 0.05 * acceleration
                 + trust_weight * trust + articulation_trust + 0.2 * heading
                 + 0.3 * support_loss
                 + 0.1 * limits + skate + penetration_weight * penetration
                 + 0.2 * endpoint + nuisance_prior)
        return total, terms

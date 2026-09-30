#!/usr/bin/env python3
"""Known-character whole-clip fit in the initializer's Studio world frame.

Calibration travels with camera.json as tracker.{deltaPx,cameraFixed,endpoints}.
Endpoints, when supplied, are {a:{rotMats,rootPos}, b:{rotMats,rootPos}} in that
same frame. No re-anchoring or endpoint fabrication occurs at this boundary.
Exit 0: motion and diagnostics; exit 3: failed fit, diagnostics only;
exit 2: malformed input, diagnostics only. --iterations 0 is an exact NPZ
round-trip for coordinate-contract QA, not an optimized-fit acceptance test.
"""
from __future__ import annotations

import os
os.environ.setdefault('CUBLAS_WORKSPACE_CONFIG', ':4096:8')

import argparse
import json
from pathlib import Path
import random
import sys
import time

import cv2
import numpy as np
import torch

from lr_viterbi import STATE_NAMES, solve_lr_viterbi
from objective import (ABLATIONS, COCO_JOINTS, ClipObjective, MaskEvidence,
                       project, slice_boxes)
from rig import RigError, State, cskel27_fk, load_rig
from scene import (SceneError, box_tensors, foot_points, load_scene,
                   penetration_stats, ray_occlusion, stance_hmm)

SCHEDULE = (('root', 150, 1e-2, 10), ('pose', 300, 5e-3, 10), ('refine', 200, 2e-3, 30))
MAX_RESERVED_MIB = 5632


class TrackError(ValueError):
    def __init__(self, code, detail):
        super().__init__(f'{code}: {detail}')
        self.code = code


def finite_array(value, shape, label):
    a = np.asarray(value, dtype=np.float32)
    if a.shape != shape or not np.isfinite(a).all():
        raise TrackError('bad-input', f'{label}: expected finite {shape}, got {a.shape}')
    return a


def read_inputs(args):
    with np.load(args.obs, allow_pickle=False) as z:
        kp = np.asarray(z['kp2d'], dtype=np.float32)
        if kp.ndim != 3 or kp.shape[1:] != (17, 3) or len(kp) < 1:
            raise TrackError('bad-input', 'kp2d must be nonempty T x 17 x 3')
        frames = len(kp)
        finite_array(kp[..., :2], (frames, 17, 2), 'kp2d coordinates')
        # ViTPose confidence is the raw (flip-averaged) heatmap peak, a Gaussian
        # regression target of height 1, not a probability: it can overshoot 1.
        # Only the weight is repaired; coordinates stay strictly validated.
        conf = kp[..., 2]
        finite = np.isfinite(conf)
        sanitized = {'input.confidenceNonFinite': int((~finite).sum()),
                     'input.confidenceAboveOne': int((finite & (conf > 1)).sum()),
                     'input.confidenceBelowZero': int((finite & (conf < 0)).sum())}
        kp[..., 2] = np.clip(np.where(finite, conf, 0), 0, 1)
        fps = float(np.asarray(z['fps']).item())
        if not np.isfinite(fps) or fps <= 0 or not fps.is_integer():
            raise TrackError('bad-input', 'fps must be a positive integer')
        finite_array(z['K'], (3, 3), 'obs.K')
        bbx = finite_array(z['bbx_xys'], (frames, 3), 'bbx_xys')
        if (bbx[:, 2] <= 0).any():
            raise TrackError('bad-input', 'bbx size must be positive')
    with np.load(args.init, allow_pickle=False) as z:
        motion = {k: z[k].copy() for k in z.files}
    finite_array(motion['local_rot_mats'], (frames, 27, 3, 3), 'local_rot_mats')
    finite_array(motion['root_positions'], (frames, 3), 'root_positions')
    finite_array(motion['posed_joints'], (frames, 27, 3), 'posed_joints')
    rot = motion['local_rot_mats']
    if not np.allclose(rot.swapaxes(-1, -2) @ rot, np.eye(3), atol=1e-3) or (np.linalg.det(rot) < 0.99).any():
        raise TrackError('bad-input', 'local_rot_mats must lie on SO(3)')
    bone_scale = motion.get('bone_scale')
    if bone_scale is not None:
        finite_array(bone_scale, (27,), 'bone_scale')
        if (bone_scale <= 0).any():
            raise TrackError('bad-input', 'bone_scale must be positive')
    camera = json.loads(Path(args.camera).read_text())
    K = finite_array(camera['K'], (3, 3), 'camera.K')
    w = finite_array(camera['worldToCamera'], (4, 4), 'worldToCamera')
    if not np.allclose(w[3], [0, 0, 0, 1]) or not np.allclose(w[:3, :3].T @ w[:3, :3], np.eye(3), atol=1e-5):
        raise TrackError('bad-input', 'camera extrinsics must be rigid')
    if K[0, 0] <= 0 or K[1, 1] <= 0:
        raise TrackError('bad-input', 'camera focal length must be positive')
    width, height = camera['width'], camera['height']
    if not isinstance(width, int) or not isinstance(height, int) or min(width, height) < 4:
        raise TrackError('bad-input', 'camera dimensions must be positive integers >=4')
    config = camera.get('tracker', {})
    delta = args.delta_px if args.delta_px is not None else config.get('deltaPx', 5.708)
    if not isinstance(delta, (int, float)) or not np.isfinite(delta) or delta <= 0:
        raise TrackError('bad-input', 'deltaPx must be finite and positive')
    fixed = config.get('cameraFixed', True)
    if not isinstance(fixed, bool):
        raise TrackError('bad-input', 'cameraFixed must be boolean')
    with np.load(args.masks, allow_pickle=False) as z:
        prob = finite_array(z['prob'], (frames, height // 2, width // 2), 'prob')
    if ((prob < 0) | (prob > 1)).any():
        raise TrackError('bad-input', 'mask probabilities must lie in [0,1]')
    if not Path(args.video).is_file():
        raise TrackError('bad-input', 'video file does not exist')
    endpoints = {}
    ep = config.get('endpoints', {})
    if not isinstance(ep, dict):
        raise TrackError('bad-input', 'endpoints must be an object with a and/or b')
    for name, frame in [('a', 0), ('b', frames - 1)]:
        if name in ep:
            e = ep[name]
            endpoints[frame] = (finite_array(e['rootPos'], (3,), f'{name}.rootPos'),
                                finite_array(np.asarray(e['rotMats']).reshape(27, 3, 3), (27, 3, 3), f'{name}.rotMats'))
    kp[:, :5, 2] = 0
    return kp, fps, motion, bone_scale, camera, prob, delta, fixed, endpoints, sanitized


def blank_diagnostics(frames=1, fps=24):
    return dict(version=1, frames=frames, fps=fps,
                occluded=[[False] * 27 for _ in range(frames)],
                lrState=['identity'] * frames, lrMargin=[0.0] * frames,
                ambiguous=[True] * frames,
                stance=dict(left=[False] * frames, right=[False] * frames),
                penetration=dict(maxBoxCm=0.0, maxFloorCm=0.0, frames=[]),
                nuisance=dict(scale=1.0, cameraDeltaDeg=[0.0, 0.0], fovDeltaPct=0.0),
                stageLosses={}, runtime=dict(trackerSeconds=0.0, peakReservedMiB=0.0), failure=None)


def windows(frames):
    if frames <= 240:
        return [(0, frames)]
    out, start = [], 0
    while start < frames:
        end = min(start + 120, frames)
        out.append((start, end))
        if end == frames:
            break
        start = end - 16
    return out


def schedule(iterations):
    if iterations is None:
        return SCHEDULE
    counts = [iterations * 150 // 650, iterations * 450 // 650]
    lengths = [counts[0], counts[1] - counts[0], iterations - counts[1]]
    return tuple((name, n, lr, pen) for (name, _, lr, pen), n in zip(SCHEDULE, lengths))


def identity_labels(frames):
    """The detector's own left/right labelling, used when Viterbi is ablated."""
    return dict(path=np.full(frames, STATE_NAMES.index('identity')),
                assignments=np.tile(np.arange(17), (frames, 1)),
                margins=np.zeros(frames), ambiguous=np.zeros(frames, dtype=bool))


@torch.no_grad()
def labels(objective, state, nuisance, kp, start, end):
    joints, _ = cskel27_fk(state, objective.bone_scale, objective.rig)
    joints = state.transl[:, None] + (joints - state.transl[:, None]) * (1 + nuisance[0])
    uv, depth = project(joints[:, COCO_JOINTS], objective.camera, nuisance)
    # Geometric box occlusion is always reported; the fit uses it only when
    # the 'occlusion' component is enabled.
    hidden = ray_occlusion(joints, objective.camera_pos, slice_boxes(objective.boxes, start, end))
    visible = depth > 0
    if 'occlusion' in objective.components:
        visible = ~hidden[:, COCO_JOINTS] & visible
    if 'viterbi' in objective.components:
        result = solve_lr_viterbi(kp, uv.cpu().numpy(), visibility=visible.cpu().numpy(), deltaPx=objective.delta)
    else:
        result = identity_labels(end - start)
    assigned = kp[np.arange(end - start)[:, None], result['assignments']]
    stance = stance_hmm(foot_points(joints).cpu(), objective.fps, slice_boxes(objective.boxes, start, end))
    return (torch.as_tensor(assigned, device=joints.device),
            torch.as_tensor(stance, device=joints.device), result, hidden)


def optimize(objective, state, nuisance, kp, masks, fixed, iterations, diagnostics, started):
    frames = len(kp)
    for stage, steps, lr, pen in schedule(iterations):
        if not steps:
            continue
        # One shared per-clip nuisance tensor, even when trajectories use windows.
        # A complete stage visits all windows before the next discrete update.
        chunks = windows(frames)
        total_steps = steps * len(chunks)
        print(f'[track] stage {stage} 0/{total_steps}', flush=True)
        assigned_all, stance_all, _, _ = labels(objective, state, nuisance, kp, 0, frames)
        for window_index, (start, end) in enumerate(chunks):
            local = State(*(getattr(state, name)[start:end].detach().clone().requires_grad_(True)
                            for name in ('transl', 'root6d', 'local6d')))
            local.local6d.requires_grad_(stage != 'root')
            objective.masks = masks.window(start, end, state.transl.device)
            assigned, stance = assigned_all[start:end], stance_all[start:end]
            params = [local.transl, local.root6d]
            if stage != 'root':
                params.append(local.local6d)
            if not fixed:
                params.append(nuisance)
            optimizer = torch.optim.Adam(params, lr=lr)
            for iteration in range(steps):
                optimizer.zero_grad(set_to_none=True)
                loss, terms = objective(local, nuisance, start, end, assigned, stance, pen)
                if not torch.isfinite(loss):
                    raise TrackError('non-finite', 'objective is not finite')
                loss.backward()
                if not all(p.grad is not None and torch.isfinite(p.grad).all() for p in params):
                    raise TrackError('non-finite', 'gradient is not finite')
                optimizer.step()
                with torch.no_grad():
                    nuisance.clamp_(nuisance.new_tensor([-0.1, -2, -2, -2]), nuisance.new_tensor([0.1, 2, 2, 2]))
                done = window_index * steps + iteration + 1
                if done % 50 == 0 or iteration == steps - 1:
                    print(f'[track] stage {stage} {done}/{total_steps}', flush=True)
                    if time.monotonic() - started > max(300, 1.5 * frames + 120):
                        raise TrackError('runtime-budget', 'tracker time budget exhausted')
                    if state.transl.is_cuda and torch.cuda.max_memory_reserved() > MAX_RESERVED_MIB * 1024 ** 2:
                        raise TrackError('memory-budget', 'reserved memory exceeded 5632 MiB')
            diagnostics['stageLosses'].update({f'{stage}.{k}': float(v.detach()) for k, v in terms.items()})
            with torch.no_grad():
                for name in ('transl', 'root6d', 'local6d'):
                    destination, source = getattr(state, name), getattr(local, name)
                    if window_index:
                        ramp = torch.arange(1, 17, device=source.device, dtype=source.dtype) / 17
                        ramp = ramp.reshape((16,) + (1,) * (source.ndim - 1))
                        destination[start:start + 16].lerp_(source[:16], ramp)
                        destination[start + 16:end].copy_(source[16:])
                    else:
                        destination[start:end].copy_(source)
            print(f'[track] {end} / {frames}', flush=True)


def sample_iou(uv, visible, mask):
    """Non-rendering occupancy estimate for rejection only, not a fitted loss.

    Dense surface point splats with a one-pixel footprint approximate the
    half-resolution occupied region; this statistic is explicitly named in
    stageLosses and is not the independent benchmark silhouette score.
    """
    h, w = mask.shape
    image = np.zeros((h, w), np.uint8)
    xy = np.floor(uv[visible]).astype(np.int64)
    inside = (xy[:, 0] >= 0) & (xy[:, 0] < w) & (xy[:, 1] >= 0) & (xy[:, 1] < h)
    xy = xy[inside]
    image[xy[:, 1], xy[:, 0]] = 1
    image = cv2.dilate(image, np.ones((3, 3), np.uint8)).astype(bool)
    union = (image | mask).sum()
    return float((image & mask).sum() / union) if union else 0.0


@torch.no_grad()
def finish(objective, state, nuisance, kp, masks, diagnostics):
    joints_out, errors, ious, max_box, max_floor, pen_frames = [], [], [], 0.0, 0.0, []
    assigned_all, stance, lr, hidden_all = labels(objective, state, nuisance, kp, 0, len(kp))
    diagnostics['occluded'] = hidden_all.cpu().tolist()
    diagnostics['lrState'] = [STATE_NAMES[i] for i in lr['path']]
    diagnostics['lrMargin'] = lr['margins'].tolist()
    diagnostics['ambiguous'] = lr['ambiguous'].tolist()
    diagnostics['stance']['left'] = stance[:, 0].cpu().tolist()
    diagnostics['stance']['right'] = stance[:, 1].cpu().tolist()
    for start, end in windows(len(kp)):
        local = State(*(getattr(state, name)[start:end] for name in ('transl', 'root6d', 'local6d')))
        joints, verts = objective.geometry(local, nuisance)
        assigned, hidden = assigned_all[start:end], hidden_all[start:end]
        uv, depth = project(joints[:, COCO_JOINTS], objective.camera, nuisance)
        active = (~hidden[:, COCO_JOINTS] & (depth > 0) & (assigned[..., 2] > 0)).cpu().numpy()
        errors.extend((uv - assigned[..., :2]).norm(dim=-1).cpu().numpy()[active].tolist())
        samples = (verts[:, objective.faces] * objective.bary[None, :, :, None]).sum(-2)
        pixels, depth = project(samples, objective.camera, nuisance)
        visible = (~ray_occlusion(samples, objective.camera_pos, slice_boxes(objective.boxes, start, end)) & (depth > 0)).cpu().numpy()
        pixels = pixels.cpu().numpy() * masks.ratio
        offset = 0 if start == 0 else 16
        ious.extend(sample_iou(pixels[t], visible[t], masks.binary[start + t]) for t in range(offset, end - start))
        joints_out.append(joints[offset:].cpu().numpy())
        stats = penetration_stats(verts, slice_boxes(objective.boxes, start, end))
        max_box, max_floor = max(max_box, stats['maxBoxCm']), max(max_floor, stats['maxFloorCm'])
        pen_frames.extend(start + i for i in stats['frames'])
    diagnostics['penetration'] = dict(maxBoxCm=max_box, maxFloorCm=max_floor, frames=sorted(set(pen_frames)))
    diagnostics['stageLosses']['visibleKeypointMedianPx'] = float(np.median(errors)) if errors else 0.0
    diagnostics['stageLosses']['sampleMaskIoUMean'] = float(np.mean(ious))
    diagnostics['nuisance'] = dict(scale=1 + float(nuisance[0]), cameraDeltaDeg=nuisance[1:3].cpu().tolist(), fovDeltaPct=float(nuisance[3]))
    if not errors:
        diagnostics['failure'] = 'no-evidence'
    elif np.median(errors) > 3 * objective.delta:
        diagnostics['failure'] = 'keypoint-residual'
    elif np.mean(ious) < 0.5:
        diagnostics['failure'] = 'mask-mismatch'
    return np.concatenate(joints_out)


def run(args):
    started = time.monotonic()
    out = Path(args.out)
    out.mkdir(parents=True, exist_ok=True)
    # A failed request cannot leave a previous successful motion behind.
    (out / 'motion.npz').unlink(missing_ok=True)
    diagnostics = blank_diagnostics()
    ablation = {f'ablation.{args.track_ablate}': 1.0}
    diagnostics['stageLosses'].update(ablation)
    code = 0
    try:
        random.seed(0)
        np.random.seed(0)
        torch.manual_seed(0)
        torch.use_deterministic_algorithms(True, warn_only=True)
        torch.set_num_threads(4)
        torch.backends.cuda.matmul.allow_tf32 = False
        torch.backends.cudnn.allow_tf32 = False
        torch.backends.cudnn.benchmark = False
        kp, fps, motion, bone_scale, camera, prob, delta, fixed, endpoints, sanitized = read_inputs(args)
        diagnostics = blank_diagnostics(len(kp), fps)
        diagnostics['stageLosses'].update(ablation, **sanitized)
        if any(sanitized.values()):
            print('[track] sanitized keypoint confidences ' + json.dumps(sanitized), flush=True)
        if not (kp[..., 2] > 0).any():
            raise TrackError('no-evidence', 'no confident body observations')
        device = 'cuda' if torch.cuda.is_available() and args.device != 'cpu' else 'cpu'
        if args.device == 'cuda' and device != 'cuda':
            raise TrackError('device-unavailable', 'CUDA requested but unavailable')
        if device == 'cuda':
            torch.cuda.empty_cache()
            torch.cuda.reset_peak_memory_stats()
            torch.cuda.set_per_process_memory_fraction(MAX_RESERVED_MIB * 1024 ** 2 / torch.cuda.get_device_properties(0).total_memory)
        rig = load_rig(args.rig, device=device)
        state = State.from_motion(motion['local_rot_mats'], motion['root_positions'], device=device)
        boxes = box_tensors(load_scene(args.scene), len(kp), device=device)
        masks = MaskEvidence(prob, camera['width'], camera['height'])
        endpoints = {t: tuple(torch.as_tensor(p, device=device) for p in pose) for t, pose in endpoints.items()}
        nuisance = torch.zeros(4, device=device, requires_grad=not fixed)
        objective = ClipObjective(rig, bone_scale, camera, boxes, None, kp, fps, delta, endpoints,
                                  components=ABLATIONS[args.track_ablate])
        optimize(objective, state, nuisance, kp, masks, fixed, args.iterations, diagnostics, started)
        posed = finish(objective, state, nuisance, kp, masks, diagnostics)
        if args.iterations == 0:
            diagnostics['failure'] = None
        elif not diagnostics['failure']:
            motion['local_rot_mats'] = state.local_rot_mats().detach().cpu().numpy().astype(np.float32)
            motion['root_positions'] = state.transl.cpu().numpy().astype(np.float32)
            motion['posed_joints'] = posed.astype(np.float32)
            if float(nuisance[0]) != 0:
                motion['bone_scale'] = np.asarray(bone_scale if bone_scale is not None else np.ones(27), np.float32) * (1 + float(nuisance[0]))
        motion['fps'] = np.asarray(int(fps), dtype=np.int32)
        if not diagnostics['failure']:
            np.savez(out / 'motion.npz', **motion)
        else:
            code = 3
    except (TrackError, RigError, SceneError) as error:
        diagnostics['failure'] = error.code
        code = 3 if error.code in ('no-evidence', 'non-finite', 'runtime-budget', 'memory-budget', 'device-unavailable') else 2
        print(f'[track] {error}', file=sys.stderr, flush=True)
    except (OSError, ValueError, KeyError, TypeError) as error:
        diagnostics['failure'] = 'bad-input'
        code = 2
        print(f'[track] bad-input: {error}', file=sys.stderr, flush=True)
    except torch.cuda.OutOfMemoryError as error:
        diagnostics['failure'] = 'memory-budget'
        code = 3
        print(f'[track] memory-budget: {error}', file=sys.stderr, flush=True)
    except Exception:
        # Preserve a failed transaction even for an unexpected dependency bug;
        # the traceback is surfaced, never converted into a successful report.
        import traceback
        diagnostics['failure'] = 'internal-error'
        code = 3
        traceback.print_exc()
    finally:
        if code:
            (out / 'motion.npz').unlink(missing_ok=True)
        if torch.cuda.is_initialized():
            torch.cuda.synchronize()
            diagnostics['runtime']['peakReservedMiB'] = torch.cuda.max_memory_reserved() / 1024 ** 2
        diagnostics['runtime']['trackerSeconds'] = time.monotonic() - started
        (out / 'diagnostics.json').write_text(json.dumps(diagnostics, allow_nan=False, indent=2) + '\n')
        print('[track] result ' + json.dumps(dict(failure=diagnostics['failure'], **diagnostics['runtime'])), flush=True)
    return code


def parse_args(argv=None):
    parser = argparse.ArgumentParser(description=__doc__)
    for name in ('video', 'obs', 'masks', 'init', 'camera', 'scene', 'rig', 'out'):
        parser.add_argument('--' + name, required=True)
    parser.add_argument('--iterations', type=int, default=None)
    parser.add_argument('--delta-px', type=float)
    parser.add_argument('--device', choices=('auto', 'cpu', 'cuda'), default='auto')
    parser.add_argument('--track-ablate', choices=tuple(ABLATIONS), default='full',
                        help='fit components: kp-only < silhouette < viterbi < contacts < full')
    args = parser.parse_args(argv)
    if args.iterations is not None and args.iterations < 0:
        parser.error('--iterations must be nonnegative')
    return args


if __name__ == '__main__':
    raise SystemExit(run(parse_args()))

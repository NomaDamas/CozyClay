"""Observation-anchored recovery of delayed vertical descents from GVHMR.

This is NOT a ground-every-frame filter or a general dynamics solver. A
stationary-camera take must contain a large, confident image-space descent
and an observed landing plateau. A delayed world endpoint may be recovered
from that observation when it never settles. Frames, rotations and XZ
are never changed. Ambiguous events retain the original output.
"""
import contextlib
import json
import time
from pathlib import Path

import numpy as np


def smooth(values, sigma):
    radius = max(1, int(np.ceil(3 * sigma)))
    x = np.arange(-radius, radius + 1)
    weights = np.exp(-0.5 * (x / max(sigma, 0.25)) ** 2)
    weights /= weights.sum()
    return np.convolve(np.pad(values, (radius, radius), mode="edge"), weights, mode="valid")


def center_of_mass(joints):
    """Approximate segment-mass COM; normalized weights, not a pelvis proxy."""
    segments = [(0, 12, .497), (12, 15, .081),
                (1, 4, .100), (2, 5, .100), (4, 7, .0465), (5, 8, .0465),
                (7, 10, .0145), (8, 11, .0145),
                (16, 18, .028), (17, 19, .028), (18, 20, .016), (19, 21, .016),
                (20, 20, .006), (21, 21, .006)]
    return sum((joints[:, a] + joints[:, b]) * (weight * .5)
               for a, b, weight in segments) / sum(s[2] for s in segments)


def recover_vertical(root, joints, camera_joints, keypoints, intrinsics, camera_up, fps):
    """Pure NumPy kernel. Returns Y corrections and inspectable diagnostics.

    Units are meters and seconds. COCO hips 11/12 provide translation
    observations; the ballistic proposal uses whole-body COM. FPS is always
    the actual source FPS, never inferred from number of frames.
    """
    root = np.asarray(root, dtype=np.float64)
    n = len(root)
    delta = np.zeros(n, dtype=np.float64)
    report = {"version": 2, "status": "unchanged", "events": [], "rejected": [],
              "frames": n, "fps": float(fps), "changedFrames": 0}
    arrays = [root, joints, camera_joints, keypoints, intrinsics, camera_up]
    if not np.isfinite(fps) or not 5 <= fps <= 240 or n < 12 or any(not np.isfinite(a).all() for a in arrays):
        report["reason"] = "invalid-input"
        return delta, report
    joints, camera_joints = np.asarray(joints), np.asarray(camera_joints)
    keypoints, intrinsics = np.asarray(keypoints), np.asarray(intrinsics)
    if root.shape != (n, 3) or joints.shape != (n, 22, 3) or camera_joints.shape != (n, 22, 3) or keypoints.shape != (n, 17, 3):
        report["reason"] = "unsupported-shape"
        return delta, report
    k = intrinsics[0] if intrinsics.ndim == 3 else intrinsics
    up = np.asarray(camera_up)
    projected_up = np.array([k[0, 0] * up[0], k[1, 1] * up[1]])
    norm = np.linalg.norm(projected_up)
    depth = camera_joints[:, 0, 2]
    if norm < .45 * min(k[0, 0], k[1, 1]) or np.median(depth) <= 0:
        report["reason"] = "gravity-axis-not-observable"
        return delta, report
    if intrinsics.ndim == 3 and np.max(np.abs(intrinsics - k)) > .01 * np.max(k):
        report["reason"] = "variable-intrinsics"
        return delta, report
    hip_conf = np.minimum(keypoints[:, 11, 2], keypoints[:, 12, 2])
    hips = keypoints[:, [11, 12], :2].mean(axis=1)
    # Fixed metric scale over the take avoids bbox/depth breathing as the
    # person curls up. Only timing is recovered: endpoint world heights are
    # retained, so this does not pretend to solve monocular absolute scale.
    scale = np.median(depth) / norm
    observed = smooth(hips @ (projected_up / norm) * scale, max(.6, fps * .04))
    height = float(np.median(np.linalg.norm(joints[:, 12] - joints[:, 0], axis=1) +
                             np.linalg.norm(joints[:, 0] - joints[:, 4], axis=1) +
                             np.linalg.norm(joints[:, 4] - joints[:, 7], axis=1)) * 1.35)
    height = max(.8, height)
    velocity = np.gradient(observed) * fps
    base = root[:, 1]
    base_smooth = smooth(base, max(.6, fps * .04))
    base_velocity = np.gradient(base_smooth) * fps
    settle = max(4, round(.25 * fps))
    com_offset = center_of_mass(joints)[:, 1] - base
    i = 1
    while i < n - settle:
        if velocity[i] >= -.65 * height:
            i += 1
            continue
        fast_start = i
        while i < n - 1 and velocity[i] < -.3 * height:
            i += 1
        end_fast = i
        start = fast_start
        while start > 0 and velocity[start - 1] < -.1 * height and fast_start - start < .4 * fps:
            start -= 1
        # Landing evidence is a stable observed pelvis, not a local minimum
        # of the already incorrect GVHMR root or a hard-coded pose category.
        landing = None
        for t in range(end_fast, min(n - settle, end_fast + round(.6 * fps)) + 1):
            if np.max(observed[t:t + settle]) - np.min(observed[t:t + settle]) < .025 * height:
                landing = t
                break
        if landing is None:
            report["rejected"].append({"start": start, "reason": "no-observed-landing"})
            continue
        drop = observed[start] - np.median(observed[landing:landing + settle])
        if drop < .35 * height or not .12 <= (landing - start) / fps <= 2.0:
            continue
        if np.quantile(hip_conf[start:landing + settle], .1) < .55:
            report["rejected"].append({"start": start, "landing": landing, "reason": "uncertain-keypoints"})
            continue
        if np.ptp(depth[start:landing + settle]) > .35 * np.median(depth[start:landing + settle]):
            report["rejected"].append({"start": start, "landing": landing, "reason": "uncertain-depth"})
            continue
        anchor = None
        for t in range(landing, min(n - settle, landing + round(3 * fps)) + 1):
            if np.max(np.abs(base_velocity[t:t + settle])) < .08 * height:
                anchor = t + settle - 1
                break
        endpoint_source = "settled-world"
        if anchor is None:
            # A lagging prediction often keeps descending past the end of a
            # short clip. Requiring that same prediction to settle prevented
            # recovery exactly when it was needed. Use a persistent observed
            # plateau and metric camera scale, NOT the erroneous last height.
            anchor = n - 1
            if anchor - landing < round(.4 * fps):
                report["rejected"].append({"start": start, "landing": landing, "reason": "landing-observation-too-short"})
                continue
            endpoint_source = "observed-plateau"
        # The image must remain on its plateau while the world catches up.
        # This rejects another jump, stairs and camera motion during the tail.
        if np.ptp(observed[landing:anchor + 1]) > .07 * height:
            report["rejected"].append({"start": start, "landing": landing, "reason": "moving-landing"})
            continue
        tail_drift = base[landing] - base[anchor]
        total_drop = base[start] - base[anchor]
        if tail_drift < .12 * height or total_drop < .35 * height:
            i = landing + settle
            continue
        stop_observed = float(np.median(observed[landing:anchor + 1]))
        endpoint_y = base[anchor] if endpoint_source == "settled-world" else base[start] - (observed[start] - stop_observed)
        progress = np.clip((observed[start] - observed[start:anchor + 1]) /
                           max(observed[start] - stop_observed, 1e-8), 0, 1)
        target = base[start] + progress * (endpoint_y - base[start])
        # Keep the original endpoint exactly, with a short smooth residual
        # bridge inside the observed plateau (no tail offset after the event).
        end_blend = min(settle, len(target))
        blend = np.linspace(0, 1, end_blend)
        blend = blend * blend * (3 - 2 * blend)
        target[-end_blend:] += (endpoint_y - target[-1]) * blend
        airborne = landing - start + 1
        observed_com = target[:airborne] + com_offset[start:landing + 1]
        # The stable landing window includes a few post-impact frames.
        # Do not force those frames to keep accelerating under gravity.
        # Locate an impact endpoint near the plateau, after >=90% descent
        # (the short image denoising kernel blurs the impact discontinuity).
        ballistic_error, ballistic, gravity_end = float("inf"), None, None
        for stop in range(max(4, airborne - round(.15 * fps)), airborne + 1):
            if progress[stop - 1] < .9:
                continue
            times = np.arange(stop) / fps
            duration = times[-1]
            initial_velocity = (observed_com[stop - 1] - observed_com[0] + .5 * 9.81 * duration ** 2) / duration
            proposal = observed_com[0] + initial_velocity * times - .5 * 9.81 * times ** 2
            error = float(np.sqrt(np.mean((proposal - observed_com[:stop]) ** 2)))
            if error < ballistic_error:
                ballistic_error, ballistic, gravity_end = error, proposal, stop
        gravity_applied = ballistic_error < .025 * height
        if gravity_applied:
            target[:gravity_end] = ballistic - com_offset[start:start + gravity_end]
        change = target - base[start:anchor + 1]
        if np.max(np.abs(change)) > 2.5 * height:
            report["rejected"].append({"start": start, "reason": "excessive-correction"})
            continue
        delta[start:anchor + 1] = change
        report["events"].append({"start": start, "landing": landing, "anchor": anchor,
                                 "endpointSource": endpoint_source,
                                 "sourceDropM": float(drop), "worldDropM": float(total_drop),
                                 "tailDriftBeforeM": float(tail_drift),
                                 "tailDriftAfterM": float(target[airborne - 1] - target[-1]),
                                 "maxCorrectionM": float(np.max(np.abs(change))),
                                 "gravityApplied": bool(gravity_applied),
                                 "gravityFitRmseM": ballistic_error if np.isfinite(ballistic_error) else None,
                                 "gravityIntervalEnd": start + gravity_end - 1 if gravity_applied else None,
                                 "mode": "ballistic-com" if gravity_applied else "observed-timing",
                                 "gravityReason": None if gravity_applied else "ballistic-curve-disagrees-with-video"})
        i = anchor + 1
    report["changedFrames"] = int(np.count_nonzero(np.abs(delta) > 1e-6))
    report["status"] = "corrected" if report["events"] else "unchanged"
    if not report["events"]:
        report["reason"] = "no-confident-delayed-descent"
    return delta, report


@contextlib.contextmanager
def trajectory_job(runner, video, output_root, *, enabled=True):
    """Scoped post-inference hook; upstream files and original runner stay intact."""
    stats = {"version": 1, "status": "disabled", "changedFrames": 0}
    if not enabled:
        yield stats
        return
    import torch
    from pytorch3d.transforms import axis_angle_to_matrix
    original = runner.DemoPL.predict
    # The legacy NPZ exporter rounds FPS to an integer. Keep fractional
    # source rates here so the physical proposal uses seconds, not that label.
    fps = float(runner.iio.immeta(str(video), plugin="pyav").get("fps") or runner.video_fps(str(video)))

    def predict(model, data, static_cam=False):
        result = original(model, data, static_cam=static_cam)
        began = time.perf_counter()
        if not static_cam:
            stats.update(status="unchanged", reason="moving-camera-not-supported")
            return result
        with torch.no_grad():
            endecoder = model.pipeline.endecoder
            gp, cp = result["smpl_params_global"], result["smpl_params_incam"]
            w = endecoder.fk_v2(**{k: v[None] for k, v in gp.items()})[0]
            c = endecoder.fk_v2(**{k: v[None] for k, v in cp.items()})[0]
            r_c2w = axis_angle_to_matrix(gp["global_orient"][0]) @ axis_angle_to_matrix(cp["global_orient"][0]).T
            cpu = lambda a: a.detach().cpu().numpy()
            delta, report = recover_vertical(cpu(gp["transl"]), cpu(w), cpu(c), cpu(data["kp2d"]),
                                             cpu(data["K_fullimg"]), cpu(r_c2w.T[:, 1]), fps)
            if report["events"]:
                corrected = gp["transl"].clone()
                corrected[:, 1] += torch.as_tensor(delta, device=corrected.device, dtype=corrected.dtype)
                gp["transl"] = corrected
                result["net_outputs"]["pred_smpl_params_global"]["transl"] = corrected[None]
            stats.update(report)
            stats["seconds"] = time.perf_counter() - began
            Path(output_root, "trajectory.json").write_text(json.dumps(stats, indent=2))
        return result

    runner.DemoPL.predict = predict
    try:
        yield stats
    finally:
        runner.DemoPL.predict = original

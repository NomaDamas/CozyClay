#!/usr/bin/env python3
"""Temporal left/right assignment for COCO-17 observations.

The detector's left/right labels are latent.  This module intentionally knows
only geometry, confidence, and time; it has no appearance or colour inputs.
"""
from __future__ import annotations

from typing import Any, Iterable

import numpy as np

COCO_NAMES = (
    "nose", "leftEye", "rightEye", "leftEar", "rightEar",
    "leftShoulder", "rightShoulder", "leftElbow", "rightElbow",
    "leftWrist", "rightWrist", "leftHip", "rightHip", "leftKnee",
    "rightKnee", "leftAnkle", "rightAnkle",
)

# Pairs are COCO indices.  Face pairs are changed only by the full-swap state.
ARM_PAIRS = ((5, 6), (7, 8), (9, 10))
LEG_PAIRS = ((11, 12), (13, 14), (15, 16))
FACE_PAIRS = ((1, 2), (3, 4))
BILATERAL_PAIRS = ARM_PAIRS + LEG_PAIRS
BODY_INDICES = tuple(i for pair in BILATERAL_PAIRS for i in pair)

STATE_NAMES = ("identity", "full_swap", "arms_swap", "legs_swap")
# The third bit is face-only.  It is tied to both body swaps for full_swap.
STATE_BITS = {
    "identity": (0, 0, 0),
    "full_swap": (1, 1, 1),
    "arms_swap": (1, 0, 0),
    "legs_swap": (0, 1, 0),
}


def state_permutation(state: str | int) -> np.ndarray:
    """Return anatomical -> detector COCO indices for one permitted state."""
    if isinstance(state, (int, np.integer)):
        state = STATE_NAMES[int(state)]
    if state not in STATE_BITS:
        raise ValueError(f"unknown L/R state: {state!r}")
    arm, leg, face = STATE_BITS[state]
    out = np.arange(17, dtype=np.int64)
    if arm:
        for left, right in ARM_PAIRS:
            out[left], out[right] = right, left
    if leg:
        for left, right in LEG_PAIRS:
            out[left], out[right] = right, left
    if face:
        for left, right in FACE_PAIRS:
            out[left], out[right] = right, left
    return out


PERMUTATIONS = np.stack([state_permutation(name) for name in STATE_NAMES])


def huber(value: float | np.ndarray, delta: float) -> float | np.ndarray:
    """Huber rho, applied to a non-negative residual magnitude."""
    if not np.isfinite(delta) or delta <= 0:
        raise ValueError("deltaPx must be a finite positive number")
    value = np.asarray(value, dtype=np.float64)
    result = np.where(value <= delta, 0.5 * value * value, delta * (value - 0.5 * delta))
    return float(result) if result.ndim == 0 else result


def _observations(kp2d: Any, projected: Any, visibility: Any | None) -> tuple[np.ndarray, np.ndarray, np.ndarray, np.ndarray]:
    kp = np.asarray(kp2d, dtype=np.float64)
    pred = np.asarray(projected, dtype=np.float64)
    if kp.size == 0:
        if pred.size == 0:
            kp = np.empty((0, 17, 3), dtype=np.float64)
        else:
            pred = pred.reshape((-1, 17, 2))
            kp = np.full((pred.shape[0], 17, 3), np.nan, dtype=np.float64)
    elif kp.ndim == 2 and kp.shape == (17, 3):
        kp = kp[None, ...]
    elif kp.ndim == 1 and kp.size % (17 * 3) == 0:
        kp = kp.reshape((-1, 17, 3))
    if kp.ndim != 3 or kp.shape[1] != 17 or kp.shape[2] < 2:
        raise ValueError("kp2d must have shape [frames, 17, 2+] (or be empty)")

    if pred.size == 0 and kp.shape[0] == 0:
        pred = np.empty((0, 17, 2), dtype=np.float64)
    elif pred.ndim == 2 and pred.shape == (17, 2):
        pred = pred[None, ...]
    elif pred.ndim == 1 and pred.size % (17 * 2) == 0:
        pred = pred.reshape((-1, 17, 2))
    if pred.ndim != 3 or pred.shape[1:] != (17, 2):
        raise ValueError("projected must have shape [frames, 17, 2]")
    if kp.shape[0] != pred.shape[0]:
        raise ValueError(f"kp2d/projected frame mismatch: {kp.shape[0]} vs {pred.shape[0]}")

    conf = kp[..., 2] if kp.shape[2] >= 3 else np.ones(kp.shape[:2], dtype=np.float64)
    conf = np.where(np.isfinite(conf), np.clip(conf, 0.0, 1.0), 0.0)
    detector_weight = np.where(np.isfinite(kp[..., :2]).all(axis=-1), conf, 0.0)
    anatomical_weight = np.isfinite(pred).all(axis=-1).astype(np.float64)
    if visibility is not None:
        vis = np.asarray(visibility, dtype=bool)
        if vis.shape != anatomical_weight.shape:
            raise ValueError(f"visibility must have shape {anatomical_weight.shape}, got {vis.shape}")
        anatomical_weight *= vis
    # Visibility belongs to the rendered anatomical joint i.  Detector-side
    # confidence/validity remains indexed by h(i) and is permuted later.
    return kp, pred, detector_weight, anatomical_weight


def _frame_scales(t: int, torso_scale: Any | None) -> np.ndarray:
    if torso_scale is None:
        return np.ones(t, dtype=np.float64)
    scale = np.asarray(torso_scale, dtype=np.float64)
    if scale.ndim == 0:
        scale = np.full(t, float(scale), dtype=np.float64)
    elif scale.ndim == 1 and scale.shape == (t,):
        scale = scale.copy()
    else:
        raise ValueError("torso_scale must be a scalar or one value per frame")
    if not np.isfinite(scale).all() or (scale <= 0).any():
        raise ValueError("torso_scale must contain finite positive values")
    return scale


def _emissions(kp: np.ndarray, pred: np.ndarray, detector_weight: np.ndarray, anatomical_weight: np.ndarray, scales: np.ndarray, delta: float, complexity_weight: float) -> tuple[np.ndarray, np.ndarray]:
    t = kp.shape[0]
    emissions = np.zeros((t, len(STATE_NAMES)), dtype=np.float64)
    identity_terms: list[np.ndarray] = []
    for state_index, permutation in enumerate(PERMUTATIONS):
        observed = kp[:, permutation, :2]
        residual = np.linalg.norm(pred - observed, axis=2) / scales[:, None]
        residual = np.nan_to_num(residual, nan=0.0, posinf=0.0, neginf=0.0)
        robust = np.asarray(huber(residual, delta))
        joint_weight = anatomical_weight * detector_weight[:, permutation]
        weighted = robust * joint_weight
        emissions[:, state_index] = weighted.sum(axis=1) + complexity_weight * sum(STATE_BITS[STATE_NAMES[state_index]])
        if state_index == 0:
            identity_terms.append(robust[joint_weight > 0])
    return emissions, np.concatenate(identity_terms) if identity_terms else np.empty(0, dtype=np.float64)


def _transitions(kp: np.ndarray, pred: np.ndarray, detector_weight: np.ndarray, anatomical_weight: np.ndarray, scales: np.ndarray, delta: float, switch_penalty: float, lambda_cont: float) -> np.ndarray:
    """Return [frame-1, previous_state, current_state] transition costs."""
    t = kp.shape[0]
    out = np.zeros((max(0, t - 1), len(STATE_NAMES), len(STATE_NAMES)), dtype=np.float64)
    predicted_delta = pred[1:] - pred[:-1]
    for previous, prev_perm in enumerate(PERMUTATIONS):
        for current, current_perm in enumerate(PERMUTATIONS):
            observed_delta = kp[1:, current_perm, :2] - kp[:-1, prev_perm, :2]
            residual = np.linalg.norm(observed_delta - predicted_delta, axis=2) / scales[1:, None]
            residual = np.nan_to_num(residual, nan=0.0, posinf=0.0, neginf=0.0)
            robust = np.asarray(huber(residual, delta))
            detector_pair_weights = np.minimum(detector_weight[1:, current_perm], detector_weight[:-1, prev_perm])
            anatomical_pair_weights = np.minimum(anatomical_weight[1:], anatomical_weight[:-1])
            continuous = (robust * detector_pair_weights * anatomical_pair_weights).sum(axis=1)
            changed = sum(a != b for a, b in zip(STATE_BITS[STATE_NAMES[previous]], STATE_BITS[STATE_NAMES[current]]))
            out[:, previous, current] = switch_penalty * changed + lambda_cont * continuous
    return out


def solve_lr_viterbi(
    kp2d: Any,
    projected: Any,
    *,
    visibility: Any | None = None,
    torso_scale: Any | None = None,
    deltaPx: float = 1.0,
    switch_penalty: float | None = None,
    lambda_cont: float = 1.0,
    hysteresis: float = 0.1,
    complexity_weight: float | None = None,
) -> dict[str, Any]:
    """Solve the permitted COCO left/right assignment states over a clip.

    ``path[t]`` is an integer in ``STATE_NAMES`` order.  ``assignment[t, i]``
    is the detector index to use for anatomical joint ``i``.  Invalid/NaN
    observations simply have zero weight; this makes an all-zero-confidence
    clip deterministic (identity, all ambiguous) rather than exceptional.
    """
    if not np.isfinite(deltaPx) or deltaPx <= 0:
        raise ValueError("deltaPx must be a finite positive number")
    if lambda_cont < 0 or hysteresis < 0:
        raise ValueError("lambda_cont and hysteresis must be non-negative")
    kp, pred, detector_weight, anatomical_weight = _observations(kp2d, projected, visibility)
    t = kp.shape[0]
    if t == 0:
        return {
            "path": np.empty(0, dtype=np.int64), "state_names": STATE_NAMES,
            "assignments": np.empty((0, 17), dtype=np.int64),
            "margins": np.empty(0, dtype=np.float64), "ambiguous": np.empty(0, dtype=bool),
            "emission": np.empty((0, 4), dtype=np.float64), "switch_penalty": 0.0,
            "state_counts": {name: 0 for name in STATE_NAMES}, "switches": 0,
        }

    scales = _frame_scales(t, torso_scale)
    # The plan's switch penalty is four times the median visible emission.  Use
    # the robust per-joint identity terms, not an aggregate frame cost, so a
    # short swap run cannot inflate its own penalty.
    _, identity_terms = _emissions(kp, pred, detector_weight, anatomical_weight, scales, float(deltaPx), 0.0)
    median_emission = float(np.median(identity_terms)) if identity_terms.size else 0.0
    penalty = float(4.0 * median_emission if switch_penalty is None else switch_penalty)
    if not np.isfinite(penalty) or penalty < 0:
        raise ValueError("switch_penalty must be finite and non-negative")
    if complexity_weight is None:
        complexity_weight = 0.01 * median_emission
    emissions, _ = _emissions(kp, pred, detector_weight, anatomical_weight, scales, float(deltaPx), float(complexity_weight))
    transitions = _transitions(kp, pred, detector_weight, anatomical_weight, scales, float(deltaPx), penalty, float(lambda_cont))

    states = len(STATE_NAMES)
    forward = np.full((t, states), np.inf, dtype=np.float64)
    backpointer = np.zeros((t, states), dtype=np.int64)
    forward[0] = emissions[0]
    for frame in range(1, t):
        for current in range(states):
            values = forward[frame - 1] + transitions[frame - 1, :, current]
            previous = int(np.argmin(values))
            backpointer[frame, current] = previous
            forward[frame, current] = emissions[frame, current] + values[previous]
    raw_path = np.empty(t, dtype=np.int64)
    raw_path[-1] = int(np.argmin(forward[-1]))
    for frame in range(t - 1, 0, -1):
        raw_path[frame - 1] = backpointer[frame, raw_path[frame]]

    backward = np.zeros((t, states), dtype=np.float64)
    for frame in range(t - 2, -1, -1):
        for previous in range(states):
            backward[frame, previous] = np.min(transitions[frame, previous] + emissions[frame + 1] + backward[frame + 1])
    conditioned = forward + backward - np.min(forward[-1])

    def assignment_margin(frame: int, chosen: int) -> float:
        """Margin against the best state that changes an active assignment."""
        chosen_perm = PERMUTATIONS[chosen]
        anatomical_active = anatomical_weight[frame] > 0
        best = np.inf
        for alternative, alternative_perm in enumerate(PERMUTATIONS):
            if alternative == chosen:
                continue
            affected = anatomical_active & (alternative_perm != chosen_perm)
            if not np.any(affected):
                # Ties in inactive groups are not assignment alternatives.
                continue
            detector_active = (detector_weight[frame, chosen_perm] > 0) | (detector_weight[frame, alternative_perm] > 0)
            affected &= detector_active
            count = int(np.count_nonzero(affected))
            if not count:
                continue
            best = min(best, float((conditioned[frame, alternative] - conditioned[frame, chosen]) / count))
        return max(0.0, best) if np.isfinite(best) else 0.0

    # Hysteresis compares the proposed assignment with the assignment it would
    # retain, not with an unrelated state that ties on inactive groups.
    path = raw_path.copy()
    for frame in range(1, t):
        proposed, retained = int(raw_path[frame]), int(path[frame - 1])
        if proposed == retained:
            continue
        proposed_perm, retained_perm = PERMUTATIONS[proposed], PERMUTATIONS[retained]
        active = anatomical_weight[frame] > 0
        active &= (detector_weight[frame, proposed_perm] > 0) | (detector_weight[frame, retained_perm] > 0)
        affected = active & (proposed_perm != retained_perm)
        count = int(np.count_nonzero(affected))
        if not count:
            path[frame] = retained
            continue
        improvement_per_joint = float((conditioned[frame, retained] - conditioned[frame, proposed]) / count)
        if improvement_per_joint < hysteresis:
            path[frame] = retained

    margins = np.asarray([assignment_margin(frame, int(path[frame])) for frame in range(t)], dtype=np.float64)
    ambiguous = margins < 0.05
    assignments = PERMUTATIONS[path]
    counts = {name: int(np.count_nonzero(path == index)) for index, name in enumerate(STATE_NAMES)}
    return {
        "path": path,
        "raw_path": raw_path,
        "state_names": STATE_NAMES,
        "assignments": assignments,
        "margins": margins,
        "ambiguous": ambiguous,
        "emission": emissions,
        "switch_penalty": penalty,
        "median_visible_emission": median_emission,
        "state_counts": counts,
        "switches": int(np.count_nonzero(path[1:] != path[:-1])),
    }


# Short aliases make the pure function convenient for callers and tests.
viterbi_lr = solve_lr_viterbi
solve_viterbi = solve_lr_viterbi


if __name__ == "__main__":
    raise SystemExit("lr_viterbi.py is a library; use eval_lr.py for file evaluation")

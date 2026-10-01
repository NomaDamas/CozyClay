from __future__ import annotations

import json
import sys
from pathlib import Path

import numpy as np

from eval_lr import evaluate_item, main as eval_main, truth_reference_error
from lr_viterbi import (
    ARM_PAIRS,
    BODY_INDICES,
    LEG_PAIRS,
    STATE_NAMES,
    solve_lr_viterbi,
    state_permutation,
)


def synthetic_clip(frames: int = 64, seed: int = 17):
    rng = np.random.default_rng(seed)
    base = np.zeros((frames, 17, 2), dtype=np.float64)
    # A moving torso plus distinct, smooth limbs.  The labels are deliberately
    # geometric only; no colour or appearance signal is present.
    for t in range(frames):
        phase = 0.13 * t
        base[t, 0] = [120 + 1.5 * t, 70]
        base[t, 1:5] = [[119, 63], [121, 63], [117, 66], [123, 66]]
        base[t, 5] = [100 + 2 * np.sin(phase), 120 + 0.3 * t]
        base[t, 6] = [140 - 2 * np.sin(phase), 120 + 0.3 * t]
        base[t, 7] = [82 + 3 * np.sin(phase), 155 + 2 * np.cos(phase)]
        base[t, 8] = [158 - 3 * np.sin(phase), 155 + 2 * np.cos(phase)]
        base[t, 9] = [70 + 4 * np.sin(phase), 190 + 2 * np.cos(phase)]
        base[t, 10] = [170 - 4 * np.sin(phase), 190 + 2 * np.cos(phase)]
        base[t, 11] = [108 + 1.5 * np.sin(phase), 220 + 0.4 * t]
        base[t, 12] = [132 - 1.5 * np.sin(phase), 220 + 0.4 * t]
        base[t, 13] = [102 + 2 * np.sin(phase), 270 + 1.5 * np.cos(phase)]
        base[t, 14] = [138 - 2 * np.sin(phase), 270 + 1.5 * np.cos(phase)]
        base[t, 15] = [96 + 2 * np.sin(phase), 320 + 1.2 * np.cos(phase)]
        base[t, 16] = [144 - 2 * np.sin(phase), 320 + 1.2 * np.cos(phase)]
    kp = np.concatenate([base, np.ones((frames, 17, 1), dtype=np.float64)], axis=2)
    kp[..., :2] += rng.normal(0, 0.15, kp[..., :2].shape)
    return base, kp


def swap_observations(kp, groups, start, end):
    out = kp.copy()
    for t in range(start, end + 1):
        for left, right in groups:
            out[t, [left, right]] = out[t, [right, left]]
    return out


def assert_corrected(result, projected, observed, start, end, groups):
    assignments = result["assignments"]
    for t in range(projected.shape[0]):
        for left, right in groups:
            expected = right if start <= t <= end else left
            assert assignments[t, left] == expected
            expected = left if start <= t <= end else right
            assert assignments[t, right] == expected
    corrected = np.take_along_axis(observed[..., :2], assignments[:, :, None], axis=1)
    raw_error = np.linalg.norm(observed[..., :2] - projected, axis=2)[:, list(BODY_INDICES)].mean()
    corrected_error = np.linalg.norm(corrected - projected, axis=2)[:, list(BODY_INDICES)].mean()
    # The detector noise remains after assignment correction; the swap error
    # should nevertheless be removed rather than requiring a denoiser here.
    assert corrected_error < raw_error * 0.4


def test_one_three_seven_frame_swap_runs_are_recovered():
    projected, clean = synthetic_clip()
    # Use separate clips so each expected state is unambiguous.
    for length, state_groups in ((1, ARM_PAIRS), (3, LEG_PAIRS), (7, ARM_PAIRS)):
        start = 20
        observed = swap_observations(clean, state_groups, start, start + length - 1)
        result = solve_lr_viterbi(observed, projected, deltaPx=2.0)
        assert_corrected(result, projected, observed, start, start + length - 1, state_groups)
        expected_name = "arms_swap" if state_groups is ARM_PAIRS else "legs_swap"
        assert all(result["state_names"][s] == expected_name for s in result["path"][start : start + length])


def test_iid_noise_has_no_switches():
    projected, clean = synthetic_clip(seed=21)
    rng = np.random.default_rng(99)
    noisy = clean.copy()
    noisy[..., :2] += rng.normal(0, 1.0, noisy[..., :2].shape)
    result = solve_lr_viterbi(noisy, projected, deltaPx=3.0)
    assert result["switches"] == 0
    assert np.all(result["path"] == STATE_NAMES.index("identity"))


def test_slow_180_degree_turn_is_not_a_swap():
    projected, _ = synthetic_clip(frames=80)
    fixture = next((parent / "test/fixtures/heading-orient.json" for parent in Path(__file__).resolve().parents if (parent / "test/fixtures/heading-orient.json").exists()), None)
    if fixture is not None:
        raw = json.loads(fixture.read_text())["items"]["gt/turn"]
        angles = []
        for x, y, z in raw:
            theta = np.linalg.norm([x, y, z])
            qw = np.cos(theta / 2)
            qy = (y / theta) * np.sin(theta / 2) if theta > 1e-12 else y / 2
            angles.append(2 * np.arctan2(qy, qw))
        angles = np.unwrap(np.asarray(angles))
        projected = np.resize(projected, (len(angles), 17, 2))
    else:
        # The box runner receives only tools/track/py, so retain a deterministic
        # equivalent when the repository fixture is not uploaded.
        angles = np.linspace(0, np.pi, projected.shape[0])
    turned = projected.copy()
    for t, angle in enumerate(angles):
        c, s = np.cos(angle), np.sin(angle)
        xy = projected[t] - [125, 210]
        turned[t] = xy @ np.array([[c, s], [-s, c]]) + [125, 210]
    kp = np.concatenate([turned, np.ones((turned.shape[0], 17, 1))], axis=2)
    kp[..., :2] += np.random.default_rng(123).normal(0, 0.2, kp[..., :2].shape)
    result = solve_lr_viterbi(kp, turned, deltaPx=2.0)
    assert result["switches"] == 0
    assert np.all(result["path"] == STATE_NAMES.index("identity"))


def test_malformed_and_no_evidence_inputs_are_safe():
    projected = np.zeros((4, 17, 2), dtype=np.float64)
    kp = np.zeros((4, 17, 3), dtype=np.float64)
    result = solve_lr_viterbi(kp, projected, deltaPx=2.0)
    assert np.all(result["path"] == 0)
    assert np.all(result["ambiguous"])
    assert np.all(result["margins"] == 0)

    nan_kp = kp.copy()
    nan_kp[..., :2] = np.nan
    nan_result = solve_lr_viterbi(nan_kp, projected, deltaPx=2.0)
    assert np.all(nan_result["path"] == 0)
    empty = solve_lr_viterbi(np.empty((0, 17, 3)), np.empty((0, 17, 2)), deltaPx=2.0)
    assert empty["path"].size == 0


def test_permutations_are_restricted_and_deterministic():
    assert np.array_equal(state_permutation("identity"), np.arange(17))
    assert state_permutation("arms_swap")[11] == 11
    assert state_permutation("legs_swap")[5] == 5
    assert state_permutation("full_swap")[1] == 2
    assert len(set(tuple(state_permutation(name)) for name in STATE_NAMES)) == 4


def test_visibility_is_anatomical_not_permuted_with_detector_labels():
    projected = np.zeros((1, 17, 2), dtype=np.float64)
    observed = np.zeros((1, 17, 3), dtype=np.float64)
    visibility = np.zeros((1, 17), dtype=bool)
    # Only anatomical left shoulder is visible. Detector left is wrong by 100px;
    # detector right is exactly at the visible anatomical projection.
    projected[0, 5] = [0, 0]
    observed[0, 5] = [100, 0, 1]
    observed[0, 6] = [0, 0, 1]
    visibility[0, 5] = True
    paths = []
    for hidden_right_x in (0, 10000):
        projected[0, 6] = [hidden_right_x, 0]
        result = solve_lr_viterbi(observed, projected, visibility=visibility, deltaPx=2.0)
        paths.append(int(result["path"][0]))
        assert int(np.argmin(result["emission"][0])) == STATE_NAMES.index("arms_swap")
    assert paths == [STATE_NAMES.index("arms_swap")] * 2


def test_hysteresis_keeps_clear_swap_when_unrelated_states_tie():
    projected = np.zeros((5, 17, 2), dtype=np.float64)
    observed = np.zeros((5, 17, 3), dtype=np.float64)
    for left, right in ARM_PAIRS:
        projected[:, right, 0] = 100
        observed[:, left, 2] = observed[:, right, 2] = 1
    observed[:, :, :2] = projected
    for left, right in ARM_PAIRS:
        observed[2, [left, right]] = observed[2, [right, left]]
    result = solve_lr_viterbi(observed, projected, deltaPx=2.0, hysteresis=0.1)
    assert result["raw_path"][2] in (STATE_NAMES.index("full_swap"), STATE_NAMES.index("arms_swap"))
    assert result["assignments"][2, 5] == 6
    assert result["assignments"][2, 6] == 5
    assert result["margins"][2] > 0.1


def test_eval_rejects_missing_truth_assignment_reference(tmp_path, monkeypatch):
    item = {"set": "gt", "name": "walk", "variant": "shaded", "dir": str(tmp_path), "source": "none"}
    assert truth_reference_error({}, "gt/walk") is not None
    row = evaluate_item(item, {}, tmp_path, 2.0)
    assert row["status"] == "missing-truth-reference"

    summary = tmp_path / "summary.json"
    approved = tmp_path / "approved.json"
    out = tmp_path / "result.json"
    summary.write_text(json.dumps({"deltaPx": 2.0}))
    approved.write_text(json.dumps({"items": [item]}))
    monkeypatch.setattr(sys, "argv", ["eval_lr.py", "--summary", str(summary), "--approved", str(approved), "--obs-root", str(tmp_path), "--out", str(out)])
    assert eval_main() == 1
    result = json.loads(out.read_text())
    assert result["pass"] is False
    assert result["items"][0]["status"] == "missing-truth-reference"

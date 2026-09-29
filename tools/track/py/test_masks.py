from __future__ import annotations

import contextlib
import os

import numpy as np
import pytest

from masks import (
    NoPersonPrompt,
    box_from_xys,
    choose_anchor,
    main,
    plan_chunks,
    prompt_boxes,
    prompt_points,
    reprompt_frames,
    segment,
    should_reprompt,
    track_clip,
)


def test_reprompt_rule_on_synthetic_area_sequence():
    areas = [1000, 1100, 1200, 600, 620, 1000, 1000, 0, 0, 500, 700]
    # 1200->600 (-50 %), 620->1000 (+61 %), 1000->0 (-100 %); 0->500 is a recovery, 500->700 is +40 % (not > 40 %).
    assert reprompt_frames(areas) == [3, 5, 7]
    assert reprompt_frames(areas, eligible=[True] * 5 + [False] * 6) == [3]
    assert not should_reprompt(1000, 1400)
    assert should_reprompt(1000, 1401)
    assert not should_reprompt(0, 5000)


def test_box_conversion_clips_and_rejects():
    assert box_from_xys([100, 50, 40], 832, 480).tolist() == [80, 30, 120, 70]
    assert box_from_xys([441.5, 49.0, 249.4], 832, 480)[1] == 0.0  # clipped at the top edge
    assert box_from_xys([10, 10, 0], 832, 480) is None
    assert box_from_xys([np.nan, 10, 50], 832, 480) is None
    assert box_from_xys([-500, 10, 50], 832, 480) is None  # entirely outside the image


def test_empty_bbx_raises_no_person_prompt():
    for bbx in (None, np.zeros((0, 3), np.float32), np.zeros((5, 3), np.float32)):
        with pytest.raises(NoPersonPrompt, match="no-person-prompt"):
            prompt_boxes(bbx, 832, 480)


def test_cli_empty_bbx_exits_3_without_output(tmp_path, capsys):
    obs = tmp_path / "obs.npz"
    np.savez(obs, bbx_xys=np.zeros((0, 3), np.float32), kp2d=np.zeros((0, 17, 3), np.float32))
    out = tmp_path / "out"
    assert main(["--video", str(tmp_path / "missing.mp4"), "--obs", str(obs), "--out", str(out)]) == 3
    assert "no-person-prompt" in capsys.readouterr().err
    assert not out.exists()


def test_prompt_points_use_confident_joints_inside_the_box():
    box = np.array([100, 100, 300, 400], np.float32)
    kp = np.zeros((17, 3))
    kp[:, :2] = 200
    kp[:, 2] = 0.9
    kp[5, :2], kp[6, :2] = (180, 150), (220, 150)  # shoulders -> midpoint (200, 150)
    kp[0, :2], kp[0, 2] = (200, 120), 0.9  # nose
    kp[9, 2] = 0.1  # unconfident wrist is dropped
    kp[16, :2] = (500, 390)  # ankle outside the box is dropped
    points = prompt_points("joints", box, kp)
    assert [tuple(p) for p in points.tolist()] == [(200, 150), (200, 200), (200, 120), (200, 200), (200, 200)]
    kp[15, 2] = 0.6  # an ankle needs ANKLE_TRUST (hidden feet behind props score 0.46-0.71)
    assert len(prompt_points("joints", box, kp)) == 4
    kp[9, 2] = 0.6  # a wrist at the same confidence is kept
    assert len(prompt_points("joints", box, kp)) == 5
    assert prompt_points("box", box, kp) is None
    assert prompt_points("centre", box, kp).tolist() == [[200, 250]]
    assert prompt_points("joints", box, np.zeros((17, 3))) is None  # nothing confident: box only
    assert prompt_points("joints", None, kp) is None
    with pytest.raises(ValueError):
        prompt_points("palm", box, kp)


def test_anchor_skips_untrusted_leading_frames():
    boxes = [np.array([0, 0, 10, 10], np.float32)] * 6
    assert choose_anchor(boxes, [0.02, 0.1, 0.6, 0.9, 0.9, 0.9]) == 2
    assert choose_anchor(boxes, [0.02, 0.3, 0.1, 0.2, 0.4, 0.1]) == 4  # nothing trusted: most confident
    assert choose_anchor([None, None] + boxes[:4], [0.9] * 6) == 2


def test_chunk_plan_covers_every_frame_with_shared_boundaries():
    assert plan_chunks(124, 0, 180) == [(1, 0, 123)]
    assert plan_chunks(362, 0, 180) == [(1, 0, 179), (1, 179, 358), (1, 358, 361)]
    assert plan_chunks(20, 5, 8) == [(1, 5, 12), (1, 12, 19), (-1, 0, 5)]
    for frames, anchor, size in ((362, 0, 180), (20, 5, 8), (20, 19, 4), (1, 0, 2)):
        chunks = plan_chunks(frames, anchor, size)
        covered = set()
        for _, start, end in chunks:
            assert end - start + 1 <= size
            covered.update(range(start, end + 1))
        assert covered == set(range(frames))


class FakePredictor:
    """SAM2 video-predictor stand-in: frame t tracks to TRUE area, except in the
    drift window where tracking alone shrinks the mask to 30 % until a box prompt
    is placed inside the window. Mask seeds reproduce their own area."""

    def __init__(self, count, drift, hw=(20, 50)):
        self.count, self.drift, self.hw = count, drift, hw
        self.true = 600
        self.box_prompts = []
        self.recomputed = []

    def open_chunk(self, start, end):
        @contextlib.contextmanager
        def chunk():
            yield {"start": start, "n": end - start + 1, "prompts": {},
                   "output_dict_per_obj": {0: {"non_cond_frame_outputs": {}}}, "frames_tracked_per_obj": {0: {}}}
        return chunk()

    def logits(self, area):
        import torch

        flat = torch.full((self.hw[0] * self.hw[1],), -10.0)
        flat[:area] = 10.0
        return flat.reshape(1, 1, *self.hw)

    def add_new_points_or_box(self, state, frame_idx, obj_id, box=None, points=None, labels=None):
        assert frame_idx not in state["frames_tracked_per_obj"][0], "re-prompt must be a fresh conditioning frame"
        state["prompts"][frame_idx] = ("box", self.true)
        self.box_prompts.append(state["start"] + frame_idx)

    def add_new_mask(self, state, frame_idx, obj_id, mask):
        state["prompts"][frame_idx] = ("mask", int(mask.sum()))

    def propagate_in_video(self, state, start_frame_idx, reverse=False):
        order = range(start_frame_idx, -1, -1) if reverse else range(start_frame_idx, state["n"])
        for local in order:
            t = state["start"] + local
            if local in state["prompts"]:
                area = state["prompts"][local][1]
            elif t in self.drift and not any(p in self.drift and (p <= t if not reverse else p >= t) for p in self.box_prompts):
                area = int(self.true * 0.3)
            else:
                area = self.true
            if local in state["output_dict_per_obj"][0]["non_cond_frame_outputs"]:
                self.recomputed.append(t)
            state["output_dict_per_obj"][0]["non_cond_frame_outputs"][local] = area
            state["frames_tracked_per_obj"][0][local] = {"reverse": reverse}
            yield local, [1], self.logits(area)


def run_fake(count, anchor, size, drift, trusted):
    fake = FakePredictor(count, set(drift))
    boxes = [np.array([0, 0, 10, 10], np.float32)] * count
    prob, area, reprompted = track_clip(fake, fake.open_chunk, count, (10, 25), boxes, np.array(trusted),
                                        anchor, plan_chunks(count, anchor, size))
    return fake, prob, area, reprompted


def test_track_clip_reprompts_drift_once_and_resumes():
    fake, prob, area, reprompted = run_fake(20, 5, 8, range(14, 18), [False] * 5 + [True] * 15)
    assert reprompted == [14]
    assert fake.box_prompts == [5, 14]
    assert area.tolist() == [600] * 20
    assert prob.dtype == np.float16 and prob.shape == (20, 10, 25)
    assert float(prob.min()) >= 0.0 and float(prob.max()) <= 1.0
    assert fake.recomputed == []  # no frame is tracked twice: the restart starts at the re-prompted frame


def test_track_clip_never_reprompts_untrusted_frames():
    fake, _, area, reprompted = run_fake(20, 5, 8, range(1, 3), [False] * 5 + [True] * 15)
    assert reprompted == []
    assert fake.box_prompts == [5]
    assert area[1:3].tolist() == [180, 180] and area[0] == 600


def draw_person(frame, cx, cy, scale):
    import cv2

    mask = np.zeros(frame.shape[:2], np.uint8)
    cv2.circle(mask, (cx, cy - int(70 * scale)), int(14 * scale), 255, -1)
    cv2.ellipse(mask, (cx, cy - int(25 * scale)), (int(18 * scale), int(34 * scale)), 0, 0, 360, 255, -1)
    for dx in (-10, 10):
        cv2.line(mask, (cx + dx, cy), (cx + dx * 2, cy + int(60 * scale)), 255, int(10 * scale))
        cv2.line(mask, (cx + dx * 2, cy - int(50 * scale)), (cx + dx * 4, cy - int(10 * scale)), 255, int(8 * scale))
    frame[mask > 0] = (60, 90, 200)
    return mask > 0


def test_sam2_synthetic_clip_backward_and_forward(tmp_path):
    cv2 = pytest.importorskip("cv2")
    count, width, height = 20, 832, 480
    rng = np.random.default_rng(3)
    background = np.full((height, width, 3), (200, 205, 210), np.uint8)
    background[height // 2:] = (170, 180, 185)
    for x in range(0, width, 64):
        cv2.line(background, (x, height // 2), (x - 200, height), (150, 150, 150), 2)
    background = np.clip(background.astype(int) + rng.integers(-4, 5, background.shape), 0, 255).astype(np.uint8)
    video = str(tmp_path / "clip.avi")
    writer = cv2.VideoWriter(video, cv2.VideoWriter_fourcc(*"MJPG"), 24, (width, height))
    truth, bbx = [], []
    for t in range(count):
        frame = background.copy()
        cx, cy = 250 + 12 * t, 300
        mask = draw_person(frame, cx, cy, 1.4)
        truth.append(mask)
        ys, xs = np.nonzero(mask)
        size = 1.2 * max(np.ptp(xs), np.ptp(ys))
        bbx.append([(xs.min() + xs.max()) / 2, (ys.min() + ys.max()) / 2, size])
        writer.write(frame)
    writer.release()
    bbx = np.array(bbx, np.float32)
    bbx[:5] = [441.5, 49.0, 249.4]  # garbage leading boxes, as GVHMR emits before its first detection
    kp2d = np.zeros((count, 17, 3), np.float32)
    kp2d[:, :, 2] = 0.9
    kp2d[:5, :, 2] = 0.02
    obs = str(tmp_path / "obs.npz")
    np.savez(obs, bbx_xys=bbx, kp2d=kp2d)

    arrays, summary = segment(video, obs, chunk_frames=8)
    assert summary["anchor"] == 5
    assert summary["chunks"] == [[1, 5, 12], [1, 12, 19], [-1, 0, 5]]
    assert arrays["prob"].shape == (count, height // 2, width // 2) and arrays["prob"].dtype == np.float16
    assert summary["peakReservedMiB"] <= 5632
    ious = []
    for t in range(count):
        prob = cv2.resize(arrays["prob"][t].astype(np.float32), (width, height), interpolation=cv2.INTER_LINEAR)
        pred = prob > 0.5
        ious.append((pred & truth[t]).sum() / max(1, (pred | truth[t]).sum()))
    assert min(ious) >= 0.8, [round(v, 3) for v in ious]
    assert int(np.median(ious) * 100) >= 90, [round(v, 3) for v in ious]

#!/usr/bin/env python3
"""SAM2 video masks of the one person in a bench clip (tracker silhouette evidence).

Inputs are what a real user has: the video and GVHMR's obs NPZ (``bbx_xys`` =
centre x, centre y, square size in image pixels; ``kp2d`` ViTPose confidences).
No plate, truth mask or colour cue is read here.

Prompting:
* anchor = first frame whose obs box is valid and trusted (mean ViTPose
  confidence >= TRUST_CONF; frame 0 on every clean clip). If no frame is
  trusted the most confident valid frame is used; no valid box at all raises
  ``no-person-prompt``. The anchor gets the obs box plus positive points at the
  confident ViTPose shoulder/hip midpoints, nose, wrists and (at >= ANKLE_TRUST)
  ankles inside the box (``--prompt joints``); frames before it are tracked
  backwards from it. Measured on the 11 shaded truth clips (median of per-item
  median IoU): box + centre point 0.000 (the centre of GVHMR's loose square box
  lands on the floor between the legs), box only 0.000, torso midpoints 0.889,
  joints 0.930, all 17 joints 0.899; without ankles (``upper``) the grey skin
  set falls to 0.886. The part-coloured mannequin needs points on the head and
  limbs or SAM2 returns a sub-part.
* re-prompt: when the mask area changes by more than REPROMPT_CHANGE relative to
  the previous frame in tracking order, that frame is re-prompted from its own
  obs box (if trusted), at most once per frame, and tracking resumes from it.
* chunked propagation: at most ``--chunk-frames`` frames are loaded per SAM2
  state (frames offloaded to CPU); the next chunk is seeded with the previous
  chunk's boundary mask. This bounds GPU memory for 15 s (362 frame) clips.

Output ``<out>/masks.npz``: ``prob`` float16 T x H/2 x W/2 (sigmoid of the SAM2
logits, area-downsampled), ``reprompted`` int32 frame list, ``area`` int32 full
resolution foreground pixels per frame, ``anchor`` int32, ``chunks`` int32
(direction, start, end) rows with direction 1 forward / -1 backward. A summary
is written to ``<out>/masks.json``.
"""
from __future__ import annotations

import argparse
import contextlib
import json
import os
import sys
import tempfile
import time

import numpy as np

REPROMPT_CHANGE = 0.4
TRUST_CONF = 0.5
DEFAULT_CHUNK_FRAMES = 180
DEFAULT_MAX_RESERVED_MIB = 5632
CONFIG = "configs/sam2.1/sam2.1_hiera_s.yaml"
CHECKPOINT = os.path.expanduser("~/cclay-ingest/cozyfit/checkpoints/sam2.1_hiera_small.pt")
OBJ_ID = 1


class NoPersonPrompt(RuntimeError):
    """The obs carries no usable person box to prompt SAM2 with."""

    def __init__(self, detail: str):
        super().__init__(f"no-person-prompt: {detail}")


def box_from_xys(xys, width: int, height: int):
    """obs ``bbx_xys`` row (centre x, centre y, size) -> clipped xyxy box, or None."""
    xys = np.asarray(xys, dtype=np.float64)
    if xys.shape != (3,) or not np.all(np.isfinite(xys)) or xys[2] <= 1.0:
        return None
    cx, cy, size = xys
    half = size / 2.0
    x0, x1 = np.clip([cx - half, cx + half], 0.0, width - 1.0)
    y0, y1 = np.clip([cy - half, cy + half], 0.0, height - 1.0)
    if x1 - x0 < 2.0 or y1 - y0 < 2.0:
        return None
    return np.array([x0, y0, x1, y1], dtype=np.float32)


def box_centre(box) -> np.ndarray:
    return np.array([[(box[0] + box[2]) / 2.0, (box[1] + box[3]) / 2.0]], dtype=np.float32)


PROMPT_MODES = ("centre", "box", "torso", "upper", "joints", "all")
DEFAULT_PROMPT = "joints"
TORSO_PAIRS = ((5, 6), (11, 12))  # COCO shoulders, hips
EXTREMITIES = (0, 9, 10, 15, 16)  # COCO nose, wrists, ankles
UPPER = (0, 9, 10)  # COCO nose, wrists
ANKLES = (15, 16)
# Floor-standing props hide the feet first; a hidden ankle still scores 0.46-0.71
# (fal stepup/handon) against >= 0.76 when visible, and a click on the prop pulls
# the prop into the person mask.
ANKLE_TRUST = 0.75


def prompt_points(mode: str, box, kp=None, trust: float = TRUST_CONF):
    """Positive points accompanying the box prompt of one frame (None = box only).

    centre: the box centre; torso: shoulder and hip midpoints whose two ViTPose
    joints are both confident and inside the box.
    """
    if mode not in PROMPT_MODES:
        raise ValueError(f"unknown prompt mode {mode}")
    if box is None or mode == "box":
        return None
    if mode == "centre":
        return box_centre(box)
    if kp is None:
        return None
    kp = np.asarray(kp, dtype=np.float64)
    candidates = []
    for a, b in TORSO_PAIRS:
        if kp[a, 2] >= trust and kp[b, 2] >= trust:
            candidates.append((kp[a, :2] + kp[b, :2]) / 2.0)
    extra = {"upper": UPPER, "joints": EXTREMITIES, "all": range(len(kp))}.get(mode, ())
    candidates += [kp[j, :2] for j in extra if kp[j, 2] >= (max(trust, ANKLE_TRUST) if j in ANKLES else trust)]
    points = [(x, y) for x, y in candidates if box[0] <= x <= box[2] and box[1] <= y <= box[3]]
    return np.array(points, dtype=np.float32) if points else None


def frame_confidence(kp2d, frames: int) -> np.ndarray:
    """Mean ViTPose confidence per frame; all ones when the obs has no kp2d."""
    if kp2d is None:
        return np.ones(frames, dtype=np.float64)
    kp2d = np.asarray(kp2d, dtype=np.float64)
    if kp2d.ndim != 3 or kp2d.shape[0] != frames or kp2d.shape[2] < 3:
        raise ValueError(f"bad-obs: kp2d shape {kp2d.shape} for {frames} frames")
    conf = kp2d[:, :, 2].mean(axis=1)
    return np.where(np.isfinite(conf), conf, 0.0)


def prompt_boxes(bbx_xys, width: int, height: int):
    """Validated per-frame prompt boxes; raises no-person-prompt when none exists."""
    if bbx_xys is None:
        raise NoPersonPrompt("obs has no bbx_xys")
    bbx = np.asarray(bbx_xys, dtype=np.float64)
    if bbx.ndim != 2 or bbx.shape[0] == 0 or bbx.shape[1] != 3:
        raise NoPersonPrompt(f"obs bbx_xys is empty or malformed (shape {bbx.shape})")
    boxes = [box_from_xys(row, width, height) for row in bbx]
    if all(box is None for box in boxes):
        raise NoPersonPrompt(f"none of {len(boxes)} obs boxes is a valid person box")
    return boxes


def choose_anchor(boxes, conf, trust: float = TRUST_CONF) -> int:
    valid = np.array([box is not None for box in boxes])
    if not valid.any():
        raise NoPersonPrompt("no valid obs box")
    trusted = np.flatnonzero(valid & (np.asarray(conf) >= trust))
    if trusted.size:
        return int(trusted[0])
    return int(np.flatnonzero(valid)[np.argmax(np.asarray(conf)[valid])])


def should_reprompt(prev_area: int, area: int, threshold: float = REPROMPT_CHANGE) -> bool:
    """Re-prompt when the mask area jumps by more than ``threshold`` of the previous frame's."""
    return prev_area > 0 and abs(area - prev_area) > threshold * prev_area


def reprompt_frames(areas, eligible=None, threshold: float = REPROMPT_CHANGE):
    """Frames the rule fires on for a fixed area sequence (tracking order = index order)."""
    areas = [int(a) for a in areas]
    eligible = [True] * len(areas) if eligible is None else list(eligible)
    return [t for t in range(1, len(areas)) if eligible[t] and should_reprompt(areas[t - 1], areas[t], threshold)]


def plan_chunks(frames: int, anchor: int, chunk_frames: int):
    """(direction, start, end) inclusive ranges in processing order.

    Forward chunks walk anchor..T-1, backward chunks anchor..0; neighbouring
    chunks share their boundary frame, which seeds the later chunk.
    """
    if chunk_frames < 2:
        raise ValueError("chunk-frames must be >= 2")
    if not 0 <= anchor < frames:
        raise ValueError(f"anchor {anchor} outside 0..{frames - 1}")
    chunks = []
    start = anchor
    while True:
        end = min(start + chunk_frames - 1, frames - 1)
        chunks.append((1, start, end))
        if end == frames - 1:
            break
        start = end
    end = anchor
    while end > 0:
        start = max(end - chunk_frames + 1, 0)
        chunks.append((-1, start, end))
        end = start
    return chunks


def read_video(path: str):
    import cv2

    capture = cv2.VideoCapture(path)
    if not capture.isOpened():
        raise RuntimeError(f"cannot open video {path}")
    frames = []
    while True:
        ok, frame = capture.read()
        if not ok:
            break
        frames.append(frame)
    capture.release()
    if not frames:
        raise RuntimeError(f"no frames decoded from {path}")
    return frames


def log(message: str) -> None:
    print(f"[masks] {message}", flush=True)


def track_clip(predictor, open_chunk, count: int, prob_hw, boxes, trusted, anchor: int, chunks,
               threshold: float = REPROMPT_CHANGE, points=None):
    """Propagate one object over ``chunks`` with the online re-prompt rule.

    ``predictor`` follows the SAM2 video predictor API; ``open_chunk(start, end)``
    is a context manager yielding an inference state over frames start..end.
    Returns (prob float16 T x h x w, area int64 T, reprompted frame list).
    """
    import torch
    import torch.nn.functional as F

    ph, pw = prob_hw
    prob = np.zeros((count, ph, pw), dtype=np.float16)
    area = np.full(count, -1, dtype=np.int64)
    reprompted: list[int] = []
    boundary: dict = {}  # full-res bool masks: chunk boundary frames and the anchor
    done = 0

    def record(t: int, logits) -> int:
        nonlocal done
        mask = logits[0, 0] > 0
        small = F.interpolate(torch.sigmoid(logits.float()), size=(ph, pw), mode="area")[0, 0]
        prob[t] = small.float().cpu().numpy().astype(np.float16)
        if area[t] < 0:
            done += 1
            if done % 20 == 0 or done == count:
                log(f"{done} / {count}")
        area[t] = int(mask.sum().item())
        boundary[t] = mask.cpu()
        return int(area[t])

    def prompt_box(state, local: int, t: int):
        positive = None if points is None else points[t]
        if positive is None:
            predictor.add_new_points_or_box(state, frame_idx=local, obj_id=OBJ_ID, box=boxes[t])
        else:
            predictor.add_new_points_or_box(state, frame_idx=local, obj_id=OBJ_ID, box=boxes[t], points=positive,
                                            labels=np.ones(len(positive), dtype=np.int32))

    for index, (direction, start, end) in enumerate(chunks):
        reverse = direction < 0
        seed = end if reverse else start
        log(f"chunk {index + 1}/{len(chunks)} {'backward' if reverse else 'forward'} {start}-{end} seed={seed}")
        with open_chunk(start, end) as state:
            seed_local = seed - start
            if seed in boundary and bool(boundary[seed].any()):
                predictor.add_new_mask(state, frame_idx=seed_local, obj_id=OBJ_ID, mask=boundary[seed])
            elif boxes[seed] is not None:
                if seed != anchor:
                    reprompted.append(seed)
                    log(f"reprompt f{seed}: empty seed mask")
                prompt_box(state, seed_local, seed)
            else:
                predictor.add_new_mask(state, frame_idx=seed_local, obj_id=OBJ_ID, mask=boundary[seed])
            resume = seed_local
            while True:
                restart = None
                for local, _, logits in predictor.propagate_in_video(state, start_frame_idx=resume, reverse=reverse):
                    t = start + local
                    if t == seed and area[t] >= 0:
                        continue  # boundary frame already recorded by the previous chunk
                    new_area = record(t, logits)
                    prev = t + 1 if reverse else t - 1
                    if (t != seed and 0 <= prev < count and area[prev] >= 0 and t not in reprompted
                            and trusted[t] and boxes[t] is not None
                            and should_reprompt(int(area[prev]), new_area, threshold)):
                        log(f"reprompt f{t}: area {int(area[prev])} -> {new_area}")
                        reprompted.append(t)
                        restart = local
                        break
                if restart is None:
                    break
                # Forget the tracked output so the obs box is an initial conditioning
                # prompt (fresh segmentation), not a correction of the drifted mask.
                state["output_dict_per_obj"][0]["non_cond_frame_outputs"].pop(restart, None)
                state["frames_tracked_per_obj"][0].pop(restart, None)
                area[start + restart] = -1
                done -= 1
                prompt_box(state, restart, start + restart)
                resume = restart
        for t in list(boundary):
            if t not in (start, end, anchor):
                del boundary[t]
    if (area < 0).any():
        raise RuntimeError(f"frames without a mask: {np.flatnonzero(area < 0).tolist()[:10]}")
    return prob, area, sorted(reprompted)


def segment(video: str, obs: str, chunk_frames: int = DEFAULT_CHUNK_FRAMES, checkpoint: str = CHECKPOINT,
            max_reserved_mib: int = DEFAULT_MAX_RESERVED_MIB, threshold: float = REPROMPT_CHANGE,
            prompt: str = DEFAULT_PROMPT):
    """Run SAM2 over the clip; returns (arrays, summary)."""
    if prompt not in PROMPT_MODES:
        raise ValueError(f"unknown prompt mode {prompt}")
    data = np.load(obs)
    bbx = data["bbx_xys"] if "bbx_xys" in data.files else None
    kp2d = data["kp2d"] if "kp2d" in data.files else None
    # Validate the prompt before decoding video or touching the GPU.
    if bbx is None or np.asarray(bbx).ndim != 2 or np.asarray(bbx).shape[0] == 0:
        prompt_boxes(bbx, 1, 1)
    started = time.time()
    frames = read_video(video)
    count = len(frames)
    height, width = frames[0].shape[:2]
    if len(bbx) != count:
        raise ValueError(f"frame-count-mismatch: video {count} frames, obs {len(bbx)}")
    boxes = prompt_boxes(bbx, width, height)
    conf = frame_confidence(kp2d, count)
    anchor = choose_anchor(boxes, conf)
    chunks = plan_chunks(count, anchor, chunk_frames)
    points = [prompt_points(prompt, boxes[t], None if kp2d is None else kp2d[t]) for t in range(count)]
    anchor_points = None if points[anchor] is None else points[anchor].round(1).tolist()
    log(f"video {width}x{height} frames={count} anchor={anchor} conf={conf[anchor]:.2f} box={boxes[anchor].round(1).tolist()} "
        f"prompt={prompt} points={anchor_points} chunks={len(chunks)}")

    import cv2
    import torch
    from sam2.build_sam import build_sam2_video_predictor

    if not torch.cuda.is_available():
        raise RuntimeError("CUDA is unavailable")
    total_mib = torch.cuda.get_device_properties(0).total_memory / 2**20
    # Hard cap: an allocation past the budget raises OOM instead of silently exceeding it.
    torch.cuda.set_per_process_memory_fraction(min(1.0, max_reserved_mib / total_mib), 0)
    torch.cuda.reset_peak_memory_stats()
    torch.backends.cuda.matmul.allow_tf32 = True
    torch.backends.cudnn.allow_tf32 = True
    predictor = build_sam2_video_predictor(CONFIG, checkpoint, device="cuda")
    load_s = time.time() - started

    @contextlib.contextmanager
    def jpeg_chunk(start: int, end: int):
        with tempfile.TemporaryDirectory(prefix="cozyfit-masks-") as tmp:
            for local, t in enumerate(range(start, end + 1)):
                cv2.imwrite(os.path.join(tmp, f"{local:05d}.jpg"), frames[t], [cv2.IMWRITE_JPEG_QUALITY, 95])
            state = predictor.init_state(tmp, offload_video_to_cpu=True)
            try:
                yield state
            finally:
                del state
                torch.cuda.empty_cache()

    with torch.inference_mode(), torch.autocast("cuda", dtype=torch.bfloat16):
        prob, area, reprompted = track_clip(predictor, jpeg_chunk, count, (height // 2, width // 2),
                                            boxes, conf >= TRUST_CONF, anchor, chunks, threshold, points)
    ph, pw = prob.shape[1:]
    torch.cuda.synchronize()
    peak = torch.cuda.max_memory_reserved() / 2**20
    seconds = time.time() - started
    arrays = {
        "prob": prob,
        "reprompted": np.array(sorted(reprompted), dtype=np.int32),
        "area": area.astype(np.int32),
        "anchor": np.array(anchor, dtype=np.int32),
        "chunks": np.array(chunks, dtype=np.int32).reshape(-1, 3),
    }
    summary = {
        "frames": count, "width": width, "height": height, "probShape": [count, ph, pw],
        "anchor": anchor, "anchorConfidence": float(conf[anchor]), "chunks": [list(c) for c in chunks],
        "chunkFrames": chunk_frames, "reprompted": sorted(reprompted), "repromptChange": threshold,
        "trustConfidence": TRUST_CONF, "prompt": prompt, "emptyFrames": int((area == 0).sum()),
        "seconds": round(seconds, 3), "modelLoadSeconds": round(load_s, 3), "peakReservedMiB": round(peak, 1),
        "maxReservedMiB": max_reserved_mib, "config": CONFIG, "checkpoint": os.path.basename(checkpoint),
        "torch": torch.__version__,
    }
    return arrays, summary


def main(argv=None) -> int:
    parser = argparse.ArgumentParser(description=__doc__.split("\n")[0])
    parser.add_argument("--video", required=True)
    parser.add_argument("--obs", required=True)
    parser.add_argument("--out", required=True)
    parser.add_argument("--chunk-frames", type=int, default=DEFAULT_CHUNK_FRAMES)
    parser.add_argument("--checkpoint", default=CHECKPOINT)
    parser.add_argument("--max-reserved-mib", type=int, default=DEFAULT_MAX_RESERVED_MIB)
    parser.add_argument("--prompt", choices=PROMPT_MODES, default=DEFAULT_PROMPT)
    args = parser.parse_args(argv)
    try:
        arrays, summary = segment(args.video, args.obs, args.chunk_frames, args.checkpoint, args.max_reserved_mib,
                                  prompt=args.prompt)
    except NoPersonPrompt as error:
        print(str(error), file=sys.stderr, flush=True)
        return 3
    os.makedirs(args.out, exist_ok=True)
    np.savez_compressed(os.path.join(args.out, "masks.npz"), **arrays)
    with open(os.path.join(args.out, "masks.json"), "w") as handle:
        json.dump(summary, handle, indent=1)
    log(f"done frames={summary['frames']} seconds={summary['seconds']} peakReservedMiB={summary['peakReservedMiB']} "
        f"reprompted={len(summary['reprompted'])} emptyFrames={summary['emptyFrames']}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())

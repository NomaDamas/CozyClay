#!/usr/bin/env python3
"""One bridge-owned, serial GVHMR worker over SSH stdin/stdout.

The existing cclay_gvhmr_extract.py remains the sole motion implementation.
Use --reference to exercise it with no preparation optimizations. EOF/SSH
disconnect terminates even an active GPU job; idle models live only on CPU.
No network listener, precision changes, or source/checkpoint rewrites.
"""
import argparse
import contextlib
import hashlib
import importlib.util
import json
import os
from pathlib import Path
import queue
import signal
import sys
import threading
import time
import traceback



DETECTORS = ("palette",)
KEYPOINTS = ("vitpose", "palette", "auto")


def install_palette_metrics(runner):
    """Instrument the fixed palette detector without changing its decisions.

    The upstream runner owns the HSV thresholds and component selection.  We
    only observe the mask it already produced, then turn the observations into
    a compact per-take report.  Keeping this wrapper here means the report
    survives upstream runner updates and does not require shipping detector
    implementation details through the browser protocol.
    """
    original_mask = getattr(runner, "palette_mask", None)
    original_bbx = getattr(runner, "palette_bbx", None)
    if not callable(original_mask) or not callable(original_bbx):
        return (lambda: {"detector": "palette", "available": False,
                         "reason": "segmentation-hooks-unavailable"}), lambda: None, lambda: None
    state = {"collect": False, "samples": [], "hits": [], "seen": 0}

    def mask(frame, *args, **kwargs):
        result = original_mask(frame, *args, **kwargs)
        if state["collect"]:
            mask_value, per_hue = result
            total = max(1, int(mask_value.size))
            coloured = int(sum(int(one.sum()) for one in per_hue))
            pixels = int(mask_value.sum())
            # HSV hue is measured against the same palette centres the runner
            # uses.  This is a drift diagnostic, not a second segmentation
            # decision: pixels outside the selected mask are never included.
            hue_error = []
            cv2 = runner.cv2
            np = runner.np
            hsv = cv2.cvtColor(frame, cv2.COLOR_BGR2HSV).astype(np.int32)
            hue = hsv[:, :, 0] * 2
            palette = np.asarray(getattr(runner, "PALETTE_HUES", ()), dtype=np.float32)
            if palette.size and coloured:
                for index, one in enumerate(per_hue):
                    if index >= palette.size:
                        break
                    centre = palette[index]
                    ys, xs = np.nonzero(one)
                    if len(xs):
                        observed = hue[ys, xs].astype(np.float32)
                        delta = np.abs((observed - centre + 180) % 360 - 180)
                        hue_error.extend(delta.tolist())
            state["samples"].append({"frame": len(state["samples"]), "coverage": pixels / total,
                                     "colouredCoverage": coloured / total,
                                     "parts": sum(int(one.sum() > 0) for one in per_hue),
                                     "hueErrorDeg": hue_error})
        return result

    def bbx(video_path, length):
        state["collect"] = True
        try:
            boxes, frame_ids, seen = original_bbx(video_path, length)
        finally:
            state["collect"] = False
        state["hits"] = [int(value) for value in frame_ids]
        state["seen"] = int(seen)
        return boxes, frame_ids, seen

    runner.palette_mask = mask
    runner.palette_bbx = bbx

    def report():
        np = runner.np
        samples = state["samples"]
        coverage = [float(item["coverage"]) for item in samples]
        coloured = [float(item["colouredCoverage"]) for item in samples]
        parts = [float(item["parts"]) for item in samples]
        hue = [float(value) for item in samples for value in item["hueErrorDeg"]]
        seen = state["seen"]
        hits = state["hits"]
        hit_set = set(hits)
        gaps = []
        current = 0
        for frame in range(seen):
            if frame in hit_set:
                if current:
                    gaps.append(current)
                current = 0
            else:
                current += 1
        if current:
            gaps.append(current)
        def quantile(values, q):
            if not values:
                return None
            return float(np.quantile(np.asarray(values, dtype=np.float64), q))
        return {
            "detector": "palette",
            "frames": seen,
            "detectedFrames": len(hits),
            "detectionRate": len(hits) / seen if seen else 0.0,
            "missingFrames": max(0, seen - len(hits)),
            "sampledFrames": len(samples),
            "gapCount": len(gaps),
            "longestGapFrames": max(gaps, default=0),
            "coverage": {"mean": quantile(coverage, .5), "min": min(coverage, default=None),
                         "p10": quantile(coverage, .1), "p90": quantile(coverage, .9),
                         "colouredMean": quantile(coloured, .5)},
            "parts": {"mean": quantile(parts, .5), "min": min(parts, default=None),
                      "p10": quantile(parts, .1), "p90": quantile(parts, .9)},
            "hueErrorDeg": {"mean": quantile(hue, .5), "p95": quantile(hue, .95),
                            "max": max(hue, default=None)},
            "perFrame": [{"frame": item["frame"], "coverage": item["coverage"],
                          "colouredCoverage": item["colouredCoverage"],
                          "hueErrorDeg": {"mean": quantile(item["hueErrorDeg"], .5),
                                          "max": max(item["hueErrorDeg"], default=None)}}
                         for item in samples],
        }

    def reset():
        state["collect"] = False
        state["samples"].clear()
        state["hits"] = []
        state["seen"] = 0

    def restore():
        runner.palette_mask = original_mask
        runner.palette_bbx = original_bbx
    return report, reset, restore


def runner_argv(request, runner_path):
    """argv for cclay_gvhmr_extract.py built from one worker request. Kept pure
    so the flag plumbing is testable. The detector is a fixed palette contract
    on the persistent-worker path, matching the one-shot ssh command."""
    argv = [str(runner_path), str(request["video"]), str(request["output"]), "--out-root", str(request["outRoot"])]
    if request.get("staticCam", True):
        argv.append("--static-cam")
    if request.get("fMm") is not None:
        argv.extend(["--f-mm", str(int(request["fMm"]))])
    # The coloured-mannequin pipeline is palette-only. Always pass the flag so
    # the remote runner's default (`auto`) cannot silently change the route.
    argv.extend(["--detector", "palette"])
    keypoints = request.get("keypoints")
    if keypoints in KEYPOINTS:
        argv.extend(["--keypoints", keypoints])
    return argv

def emit(value):
    print(json.dumps(value), flush=True)


def main():
    started = time.perf_counter()
    parser = argparse.ArgumentParser()
    parser.add_argument("--runner", default="cclay_gvhmr_extract.py")
    parser.add_argument("--reference", action="store_true")
    args = parser.parse_args()
    runner_path = Path(args.runner).resolve()
    sys.path.insert(0, str(runner_path.parent))
    requests = queue.Queue(maxsize=8)

    def receive():
        for line in sys.stdin:
            try:
                if len(line) > 65536:
                    raise ValueError("request-too-large")
                requests.put(json.loads(line), timeout=1)
            except Exception as exc:
                emit({"event": "error", "id": None, "message": str(exc)})
        # The SSH client owns this process. Do not finish queued/active GPU
        # work after its stdin disappeared (including the dequeue/busy race).
        os.kill(os.getpid(), signal.SIGTERM)

    threading.Thread(target=receive, daemon=True).start()
    # Imports and third-party logging must not corrupt the JSON protocol.
    with contextlib.redirect_stdout(sys.stderr):
        import torch
        from gvhmr_fastpath import FastRuntime
        from gvhmr_trajectory import trajectory_job
        spec = importlib.util.spec_from_file_location("cozyclay_gvhmr_reference", runner_path)
        runner = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(runner)
    palette_report, palette_reset, palette_restore = install_palette_metrics(runner)
    runtime = FastRuntime(runner, enabled=not args.reference)
    emit({"event": "ready", "protocol": 1, "pid": os.getpid(), "startupSeconds": time.perf_counter() - started,
          "runnerSha256": hashlib.sha256(runner_path.read_bytes()).hexdigest()})
    jobs = 0
    while True:
        request = requests.get()
        job_id = request.get("id")
        if request.get("mode") == "ping":
            emit({"event": "done", "id": job_id, "pid": os.getpid()})
            continue
        argv = sys.argv
        metrics = None
        began = time.perf_counter()
        try:
            palette_reset()
            video, output, root = (Path(request[key]).resolve() for key in ("video", "output", "outRoot"))
            if not video.is_file():
                raise ValueError("extract-video-missing")
            root.mkdir(parents=True, exist_ok=True)
            sys.argv = runner_argv({**request, "video": str(video), "output": str(output), "outRoot": str(root)}, runner_path)
            torch.cuda.reset_peak_memory_stats()
            with contextlib.redirect_stdout(sys.stderr), runtime.job(root if request.get("evidence") else None) as metrics:
                with trajectory_job(runner, video, root,
                                    enabled=request.get("trajectory", True) and not args.reference) as trajectory:
                    runner.main()
                metrics["trajectory"] = trajectory
            metrics["segmentation"] = palette_report()
            jobs += 1
            metrics.update({"seconds": time.perf_counter() - began, "jobsInProcess": jobs, "pid": os.getpid(),
                            "peakAllocatedMiB": torch.cuda.max_memory_allocated() / 2**20,
                            "peakReservedMiB": torch.cuda.max_memory_reserved() / 2**20,
                            "idleAllocatedMiB": torch.cuda.memory_allocated() / 2**20,
                            "cachedHostModelMiB": sum(t.numel() * t.element_size()
                                for item, attribute in runtime.cache.values()
                                for t in list(getattr(item, attribute).parameters()) + list(getattr(item, attribute).buffers())) / 2**20})
            emit({"event": "done", "id": job_id, "performance": metrics})
        except (Exception, SystemExit) as exc:
            with contextlib.redirect_stdout(sys.stderr):
                traceback.print_exc()
                runtime.cache.clear()
                runtime.release_gpu()
            emit({"event": "error", "id": job_id, "message": str(exc), "performance": metrics})
        finally:
            palette_reset()
            sys.argv = argv


if __name__ == "__main__":
    main()

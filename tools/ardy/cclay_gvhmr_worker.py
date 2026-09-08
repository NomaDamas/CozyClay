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



DETECTORS = ("yolo", "palette", "auto")
KEYPOINTS = ("vitpose", "palette", "auto")


def runner_argv(request, runner_path):
    """argv for cclay_gvhmr_extract.py built from one worker request. Kept pure
    so the flag plumbing is testable; the detector rides the request the same
    way staticCam/fMm do, so CCLAY_EXTRACT_DETECTOR is honoured on the
    persistent-worker path too, not only the one-shot ssh command."""
    argv = [str(runner_path), str(request["video"]), str(request["output"]), "--out-root", str(request["outRoot"])]
    if request.get("staticCam", True):
        argv.append("--static-cam")
    if request.get("fMm") is not None:
        argv.extend(["--f-mm", str(int(request["fMm"]))])
    detector = request.get("detector")
    if detector in DETECTORS:
        argv.extend(["--detector", detector])
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
            sys.argv = argv


if __name__ == "__main__":
    main()

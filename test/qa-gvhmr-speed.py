"""Run on the GPU box: original/reference/fast output parity and cold/warm times.

No settings/weights/dtypes are modified. Writes only to the supplied QA folder.
Example: python qa-gvhmr-speed.py --worker /tmp/code/cclay_gvhmr_worker.py
  --output /tmp/qa-run --videos /tmp/clip18.mp4 /tmp/walk2.mp4
"""
import argparse
import json
import os
from pathlib import Path
import subprocess
import sys
import time

import numpy as np
import torch


def compare_arrays(a_path, b_path):
    with np.load(a_path) as a, np.load(b_path) as b:
        assert set(a.files) == set(b.files), "NPZ fields changed"
        fields = {}
        for key in a.files:
            assert a[key].shape == b[key].shape and a[key].dtype == b[key].dtype, key
            assert np.isfinite(a[key]).all() and np.isfinite(b[key]).all(), key
            fields[key] = {"equal": bool(np.array_equal(a[key], b[key])),
                           "maxAbs": float(np.abs(a[key].astype(float) - b[key].astype(float)).max())}
        return {"equal": all(v["equal"] for v in fields.values()), "fields": fields}


def compare_preprocess(a_path, b_path):
    a, b = torch.load(a_path, map_location="cpu"), torch.load(b_path, map_location="cpu")
    assert a.keys() == b.keys()
    return {k: {"equal": torch.equal(a[k], b[k]), "maxAbs": float((a[k].float() - b[k].float()).abs().max())} for k in a}


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--worker", required=True)
    ap.add_argument("--output", required=True)
    ap.add_argument("--videos", nargs="+", required=True)
    ap.add_argument("--bare", action="store_true")
    args = ap.parse_args()
    out = Path(args.output).resolve()
    out.mkdir(parents=True, exist_ok=True)
    rows, files, comparisons = [], {}, []

    if args.bare:
        folder = out / "bare"
        folder.mkdir(exist_ok=True)
        began = time.perf_counter()
        with (folder / "run.log").open("w") as log:
            subprocess.run([sys.executable, "cclay_gvhmr_extract.py", args.videos[0], str(folder / "motion.npz"),
                            "--static-cam", "--out-root", str(folder)], stdout=log, stderr=log, check=True)
        rows.append({"case": "bare", "wallSeconds": time.perf_counter() - began})

    for mode in ("reference", "fast"):
        log = (out / f"{mode}.log").open("w")
        begin = time.perf_counter()
        proc = subprocess.Popen([sys.executable, "-u", args.worker] + (["--reference"] if mode == "reference" else []),
                                stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=log, text=True, bufsize=1)
        try:
            ready = json.loads(proc.stdout.readline())
            assert ready["event"] == "ready", ready
            startup = time.perf_counter() - begin
            videos = args.videos if mode == "reference" else [*args.videos, args.videos[0]]
            for index, video in enumerate(videos):
                folder = out / f"{mode}-{index}"
                folder.mkdir(exist_ok=True)
                output = folder / "motion.npz"
                job = {"id": f"{mode}-{index}", "video": video, "output": str(output), "outRoot": str(folder),
                       "staticCam": True, "evidence": True, "trajectory": False}
                began = time.perf_counter()
                proc.stdin.write(json.dumps(job) + "\n")
                proc.stdin.flush()
                line = proc.stdout.readline()
                if not line:
                    raise RuntimeError(f"worker exited: {proc.poll()}, see {mode}.log")
                response = json.loads(line)
                assert response["event"] == "done", response
                row = {"case": job["id"], "video": video, "startupSeconds": startup if index == 0 else 0,
                       "wallSeconds": time.perf_counter() - began, **response["performance"]}
                rows.append(row)
                print(json.dumps(row), flush=True)
                if mode == "reference":
                    files[video] = folder
                else:
                    comparison = {"case": job["id"], "npz": compare_arrays(files[video] / "motion.npz", output),
                                  "preprocess": compare_preprocess(files[video] / "preprocess.pt", folder / "preprocess.pt")}
                    comparisons.append(comparison)
                    print(json.dumps(comparison), flush=True)
                (out / "metrics.json").write_text(json.dumps({"runs": rows, "comparisons": comparisons}, indent=2))
        finally:
            proc.stdin.close()
            try:
                proc.wait(timeout=10)
            except subprocess.TimeoutExpired:
                proc.kill()
                proc.wait()
            log.close()
    if args.bare:
        comparisons.append({"case": "bare-vs-reference", "npz": compare_arrays(out / "bare/motion.npz", files[args.videos[0]] / "motion.npz")})
    (out / "metrics.json").write_text(json.dumps({"runs": rows, "comparisons": comparisons}, indent=2))
    assert all(c["npz"]["equal"] and all(v["equal"] for v in c.get("preprocess", {}).values()) for c in comparisons), "output parity failed"
    print("PASS exact original/reference/fast parity", flush=True)


if __name__ == "__main__":
    main()

#!/usr/bin/env python3
"""Small, real CUDA/SAM2 smoke test for the CozyFit box environment."""
from __future__ import annotations

import importlib
import importlib.metadata
import os
import sys


def version(module_name: str, distribution: str) -> str:
    importlib.import_module(module_name)
    return importlib.metadata.version(distribution)


def main() -> int:
    import numpy as np
    import torch

    print(f"python {sys.version.split()[0]}")
    print(f"torch {version('torch', 'torch')}")
    print(f"torchvision {version('torchvision', 'torchvision')}")
    print(f"numpy {version('numpy', 'numpy')}")
    print(f"scipy {version('scipy', 'scipy')}")
    print(f"opencv {version('cv2', 'opencv-python-headless')}")
    print(f"sam2 {version('sam2', 'SAM-2')}")
    print(f"fast-simplification {version('fast_simplification', 'fast-simplification')}")
    print(f"pytest {version('pytest', 'pytest')}")
    cuda = bool(torch.cuda.is_available())
    print(f"torch.cuda.is_available() {cuda}")
    if not cuda:
        raise RuntimeError("CUDA is unavailable")

    from sam2.build_sam import build_sam2
    from sam2.sam2_image_predictor import SAM2ImagePredictor

    root = os.path.expanduser("~/cclay-ingest/cozyfit")
    checkpoint = os.path.join(root, "checkpoints", "sam2.1_hiera_small.pt")
    config = "configs/sam2.1/sam2.1_hiera_s.yaml"
    torch.cuda.reset_peak_memory_stats()
    model = build_sam2(config, checkpoint, device="cuda")
    predictor = SAM2ImagePredictor(model)
    frame = np.zeros((480, 832, 3), dtype=np.uint8)
    predictor.set_image(frame)
    predictor.predict(
        point_coords=np.array([[416.0, 240.0]], dtype=np.float32),
        point_labels=np.array([1], dtype=np.int32),
        box=np.array([208.0, 120.0, 624.0, 360.0], dtype=np.float32),
        multimask_output=False,
    )
    torch.cuda.synchronize()
    peak_mb = torch.cuda.max_memory_reserved() / (1024 * 1024)
    print(f"SAM2 peak VRAM {peak_mb:.1f} MB")
    if peak_mb >= 3000:
        raise RuntimeError(f"SAM2 peak VRAM too high: {peak_mb:.1f} MB")
    print("sam2 ok")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())

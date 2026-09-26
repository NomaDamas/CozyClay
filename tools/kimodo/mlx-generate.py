#!/usr/bin/env python3
"""Expose MLX's decoded arrays without changing the installed upstream package.

Run with ~/.cozyclay/kimodo-mlx-venv/bin/python mlx-generate.py --prompt ...
--motion ... --text ... --frames ... --steps ... --seed ... --output-dir ... .
Only upstream's installed dependencies are needed; argument parsing and binary
serialization deliberately use the standard library, like the upstream CLI.

Verified against NomaDamas/kimodo-mlx at
bbb592aa2046361be541ab4f5e2b0e9ba4869b21:
- kimodo_mlx/cli.py:20-49: arguments and JSON summary (no saved arrays).
- kimodo_mlx/runtime.py:88-114: generate API and returned decoded arrays.
- kimodo_mlx/motion.py:21-23,128-145: SOMA30 parents, float32 [T,30,4]
  local XYZW quaternions and float32 [T,3] root translations.
- kimodo_mlx/motion_io.py:17-20: native checkpoint is SOMA30 at 30 fps.

The two output files contain little-endian float32 in frame-major C order.
These are SOMA30 arrays, NOT SOMA77 or an NPZ. Skeleton expansion and FK belong
in the shared JS converter. No fps is invented for arbitrary GGUF checkpoints;
the upstream Generation object does not expose its model's fps metadata.
"""

from __future__ import annotations

import argparse
import hashlib
import json
import math
import sys
from array import array
from dataclasses import dataclass
from pathlib import Path


@dataclass(frozen=True, slots=True)
class OutputContractError(ValueError):
    """A decoded runtime array cannot satisfy the verified output contract."""

    array_name: str
    reason: str

    def __str__(self) -> str:
        return f"{self.array_name}: {self.reason}"


def main(argv: list[str] | None = None) -> int:
    """Run upstream inference and save validated little-endian SOMA30 arrays."""
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--prompt", required=True)
    parser.add_argument("--motion", type=Path, required=True)
    parser.add_argument("--text", type=Path)
    parser.add_argument("--seed", type=int, default=42)
    parser.add_argument("--steps", type=int, default=100)
    parser.add_argument("--frames", type=int, default=30)
    parser.add_argument("--backend", default="auto")
    parser.add_argument("--output-dir", type=Path, required=True)
    args = parser.parse_args(argv)
    try:
        # Delay MLX imports so --help and argument errors work without MLX.
        from kimodo_mlx.runtime import AssetManifest, RuntimeConfig, generate

        result = generate(
            prompt=args.prompt,
            manifest=AssetManifest(motion=args.motion, text=args.text),
            config=RuntimeConfig(
                seed=args.seed, steps=args.steps, backend=args.backend, frames=args.frames,
            ),
        )
        buffers: dict[str, bytes] = {}
        for name, values, expected_shape in (
            ("root_positions", result.root_positions, (args.frames, 3)),
            ("local_rotations_xyzw", result.local_rotations_xyzw, (args.frames, 30, 4)),
        ):
            with memoryview(values) as view:
                if view.shape != expected_shape:
                    raise OutputContractError(
                        name, f"expected SOMA30 shape {expected_shape}, got {view.shape}",
                    )
                if view.format != "f" or view.itemsize != 4:
                    raise OutputContractError(name, "expected native float32 runtime array")
                # NumPy arrays implement the buffer protocol. C-order extraction
                # also handles strided arrays without depending on NumPy here.
                floats = array("f")
                floats.frombytes(view.tobytes(order="C"))
            if not all(math.isfinite(value) for value in floats):
                raise OutputContractError(name, "runtime array contains non-finite values")
            if sys.byteorder != "little":
                floats.byteswap()
            buffers[name] = floats.tobytes()

        # Validate both arrays before creating output: never publish a valid root
        # file beside rotations that were rejected by the adapter.
        args.output_dir.mkdir(parents=True, exist_ok=True)
        for name, data in buffers.items():
            (args.output_dir / f"{name}.f32").write_bytes(data)
        print(json.dumps({
            "backend": result.backend,
            "elapsed_ms": result.elapsed_ms,
            "frames": args.frames,
            "joints": 30,
            "neural_engine_used": False,
            "output_sha256": hashlib.sha256(result.output).hexdigest(),
        }, sort_keys=True))
        return 0
    except (ImportError, OSError, RuntimeError, ValueError) as error:
        print(f"kimodo-mlx-output: {error}", file=sys.stderr)
        return 2


if __name__ == "__main__":
    raise SystemExit(main())

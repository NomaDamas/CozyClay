#!/usr/bin/env bash
set -euo pipefail

ROOT="$HOME/cclay-ingest/cozyfit"
VENV="$ROOT/.venv"
PYTHON="$VENV/bin/python"
GVHMR_PY="$HOME/cclay-ingest/GVHMR/.venv/bin/python"

if [[ ! -x "$GVHMR_PY" ]]; then
  echo "missing GVHMR interpreter: $GVHMR_PY" >&2
  exit 1
fi
read -r PY_MAJOR PY_MINOR < <("$GVHMR_PY" -c 'import sys; print(sys.version_info.major, sys.version_info.minor)')
PY_BIN="python${PY_MAJOR}.${PY_MINOR}"
if ! command -v "$PY_BIN" >/dev/null 2>&1; then
  echo "missing matching Python minor: $PY_BIN" >&2
  exit 1
fi

mkdir -p "$ROOT/checkpoints"
if [[ ! -x "$PYTHON" ]]; then
  "$PY_BIN" -m venv "$VENV"
fi

# Keep all installs in CozyFit's venv. In particular, never invoke or modify
# the existing GVHMR environment after reading its Python minor above.
pip_install() {
  "$PYTHON" - "$@" <<'PY'
import subprocess
import sys
subprocess.run([sys.executable, "-m", "pip", "install", *sys.argv[1:]], check=True, timeout=1200)
PY
}
pip_install --upgrade pip setuptools wheel
pip_install \
  --index-url https://download.pytorch.org/whl/cu121 \
  --extra-index-url https://pypi.org/simple \
  'torch==2.5.1+cu121' 'torchvision==0.20.1+cu121'
pip_install \
  'git+https://github.com/facebookresearch/sam2.git' \
  fast-simplification numpy scipy opencv-python-headless pytest

CHECKPOINT="$ROOT/checkpoints/sam2.1_hiera_small.pt"
if [[ ! -s "$CHECKPOINT" ]]; then
  tmp="$CHECKPOINT.tmp.$$"
  trap 'rm -f "$tmp"' EXIT
  curl --fail --location --retry 3 --connect-timeout 15 --max-time 900 \
    -o "$tmp" \
    https://dl.fbaipublicfiles.com/segment_anything_2/092824/sam2.1_hiera_small.pt
  mv "$tmp" "$CHECKPOINT"
  trap - EXIT
fi

"$PYTHON" - <<'PY'
import torch
assert torch.__version__.startswith("2.5.1+cu121"), torch.__version__
import sam2
print("cozyfit environment ready", torch.__version__, sam2.__file__)
PY

#!/usr/bin/env bash
# Run the cached MorphGS tennis→Ninja demo and require motion render outputs.
set -euo pipefail
MORPHGS_ROOT="${MORPHGS_ROOT:-/data2/${USER:?USER must be set}/MorphGS}"
DEMO_ID="${MORPHGS_DEMO_ID:-1oMkA02aJYhoBSNPZX9tMPknvVvX50i-z}"
LOG_DIR="${MORPHGS_LOG_DIR:-$MORPHGS_ROOT/logs}"
mkdir -p "$LOG_DIR"
cd "$MORPHGS_ROOT"

if [[ "${MORPHGS_SKIP_DOWNLOAD:-0}" != 1 ]]; then
  uv run --with gdown python -m gdown "$DEMO_ID" 2>&1 | tee "$LOG_DIR/demo-download.log"
fi
VENV_DIR="${MORPHGS_VENV:-.venv}"
[[ -x "$VENV_DIR/bin/python" ]] || VENV_DIR="venv"
source "$VENV_DIR/bin/activate"
python src/main.py --config demo/tennis_to_Ninja.yaml 2>&1 | tee "$LOG_DIR/demo-main.log"
python src/render.py --config demo/tennis_to_Ninja.yaml 2>&1 | tee "$LOG_DIR/demo-render.log"

OUTPUT_ROOT="${MORPHGS_OUTPUT_ROOT:-$MORPHGS_ROOT/output}"
for artifact in "$OUTPUT_ROOT/rot_params.npy" "$OUTPUT_ROOT/pred_joints.npy"; do
  [[ -s "$artifact" ]] || { echo "missing demo artifact: $artifact" >&2; exit 1; }
done
printf 'PASS MorphGS demo gate: %s\n' "$OUTPUT_ROOT"

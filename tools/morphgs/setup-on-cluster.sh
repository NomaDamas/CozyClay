#!/usr/bin/env bash
# Reproduce the verified MorphGS Blackwell environment on the shared cluster.
# Allocate first (sbatch is unavailable on the full login filesystem):
#   srun --gres=gpu:1 --cpus-per-task=8 --mem=40G --time=02:00:00 --pty bash
set -euo pipefail

usage() {
  cat <<'USAGE'
Usage: setup-on-cluster.sh [--dry-run]

Run inside an srun allocation on mkseoul2. The default root is
/data2/$USER/MorphGS; override MORPHGS_ROOT, DATA_ROOT, or CUDA_HOME when needed.
Set CUDA_RUNFILE to an existing CUDA 12.8.1 runfile (or CUDA_RUNFILE_URL to
fetch it). --dry-run prints every command without changing the cluster.
USAGE
}

DRY_RUN=0
for arg in "$@"; do
  case "$arg" in
    --dry-run) DRY_RUN=1 ;;
    -h|--help) usage; exit 0 ;;
    *) echo "unknown argument: $arg" >&2; usage >&2; exit 2 ;;
  esac
done

DATA_ROOT="${DATA_ROOT:-/data2/${USER:?USER must be set}}"
MORPHGS_ROOT="${MORPHGS_ROOT:-$DATA_ROOT/MorphGS}"
CUDA_HOME="${CUDA_HOME:-$DATA_ROOT/cuda-12.8}"
CUDA_RUNFILE="${CUDA_RUNFILE:-$DATA_ROOT/cuda_12.8.1_*.run}"
CUDA_RUNFILE_URL="${CUDA_RUNFILE_URL:-https://developer.download.nvidia.com/compute/cuda/12.8.1/local_installers/cuda_12.8.1_570.124.06_linux.run}"
GEO_ROOT="${GEO_ROOT:-$DATA_ROOT/GeoAware-SC}"
GEO_VENV="${GEO_VENV:-$DATA_ROOT/venv-geo}"

run() {
  if (( DRY_RUN )); then
    printf '+ '
    printf '%q ' "$@"
    printf '\n'
  else
    "$@"
  fi
}

mkdir_p() { run mkdir -p "$1"; }
mkdir_p "$DATA_ROOT"

if [[ ! -d "$MORPHGS_ROOT/.git" ]]; then
  run git clone https://github.com/xodus777/MorphGS "$MORPHGS_ROOT"
fi
run git -C "$MORPHGS_ROOT" submodule update --init

# GCC 13 needs these standard headers in the two CUDA extensions. Keep the
# edits idempotent so rerunning setup never adds duplicate includes.
if (( DRY_RUN )); then
  echo '+ add #include <cstdint> to src/extlibs/latent-gaussian-rasterization/cuda_rasterizer/rasterizer_impl.h'
  echo '+ add #include <cfloat> to src/extlibs/simple-knn/simple_knn.cu'
else
  grep -q '^#include <cstdint>$' "$MORPHGS_ROOT/src/extlibs/latent-gaussian-rasterization/cuda_rasterizer/rasterizer_impl.h" || \
    sed -i '1i #include <cstdint>' "$MORPHGS_ROOT/src/extlibs/latent-gaussian-rasterization/cuda_rasterizer/rasterizer_impl.h"
  grep -q '^#include <cfloat>$' "$MORPHGS_ROOT/src/extlibs/simple-knn/simple_knn.cu" || \
    sed -i '1i #include <cfloat>' "$MORPHGS_ROOT/src/extlibs/simple-knn/simple_knn.cu"
fi

# CUDA 12.8 is required for sm_120. The pip nvcc package only supplies ptxas.
if (( DRY_RUN )); then
  echo "+ install CUDA runfile at $CUDA_HOME (CUDA_RUNFILE or CUDA_RUNFILE_URL)"
else
  shopt -s nullglob
  runfiles=( $CUDA_RUNFILE )
  shopt -u nullglob
  if (( ${#runfiles[@]} == 0 )); then
    CUDA_RUNFILE="$DATA_ROOT/cuda_12.8.1_linux.run"
    run curl -L --fail --retry 3 -o "$CUDA_RUNFILE" "$CUDA_RUNFILE_URL"
  else
    CUDA_RUNFILE="${runfiles[0]}"
  fi
  if [[ ! -x "$CUDA_HOME/bin/nvcc" ]]; then
    run sh "$CUDA_RUNFILE" --silent --toolkit --installpath="$CUDA_HOME"
  fi
fi
export CUDA_HOME
export PATH="$CUDA_HOME/bin:$PATH"

run uv venv "$MORPHGS_ROOT/.venv" --python 3.10
run uv pip install --python "$MORPHGS_ROOT/.venv/bin/python" torch==2.11.0 --index-url https://download.pytorch.org/whl/cu128
run uv pip install --python "$MORPHGS_ROOT/.venv/bin/python" 'pytorch3d==0.7.9+pt2110cu128' --extra-index-url https://ImageMindAnalytics.github.io/pytorch3d-wheels/simple/

REQ_TMP="${TMPDIR:-/tmp}/morphgs-requirements-${USER}.txt"
if (( DRY_RUN )); then
  echo "+ grep -v scikit-sparse $MORPHGS_ROOT/requirements.txt > $REQ_TMP"
else
  grep -v '^scikit-sparse' "$MORPHGS_ROOT/requirements.txt" > "$REQ_TMP"
fi
run uv pip install --python "$MORPHGS_ROOT/.venv/bin/python" -r "$REQ_TMP"

export TORCH_CUDA_ARCH_LIST=12.0
run uv pip install --python "$MORPHGS_ROOT/.venv/bin/python" --no-build-isolation -e "$MORPHGS_ROOT/src/extlibs/latent-gaussian-rasterization"
run uv pip install --python "$MORPHGS_ROOT/.venv/bin/python" --no-build-isolation "$MORPHGS_ROOT/src/extlibs/simple-knn"

# GeoAware's numpy 1.23 / Pillow 9.5 stack is intentionally isolated from the
# training venv (numpy 2.2). Its MSDeformAttn patch targets torch 2.11 APIs.
run uv venv "$GEO_VENV" --python 3.10
run uv pip install --python "$GEO_VENV/bin/python" torch==2.11.0 --index-url https://download.pytorch.org/whl/cu128
if [[ ! -d "$GEO_ROOT/.git" ]]; then run git clone https://github.com/Junyi42/GeoAware-SC "$GEO_ROOT"; fi
run git -C "$GEO_ROOT" checkout b20fab9
if (( DRY_RUN )); then
  echo '+ patch GeoAware MSDeformAttn value.type() and .type().is_cuda()'
else
  grep -rl 'value.type()' --include='ms_deform_attn*' "$GEO_ROOT/third_party" | xargs -r sed -i \
    -e 's/\.type()\.is_cuda()/\.is_cuda()/g' -e 's/value\.type()/value.scalar_type()/g'
fi
OVERRIDE="${TMPDIR:-/tmp}/geo-override-${USER}.txt"
if (( DRY_RUN )); then echo "+ printf 'faiss-cpu>=1.7.1\\n' > $OVERRIDE"; else printf 'faiss-cpu>=1.7.1\n' > "$OVERRIDE"; fi
run uv pip install --python "$GEO_VENV/bin/python" 'numpy==1.23.5' 'pillow==9.5.0'
run uv pip install --python "$GEO_VENV/bin/python" --override "$OVERRIDE" --no-build-isolation -e "$GEO_ROOT"
if (( DRY_RUN )); then
  echo "+ ln -s $GEO_ROOT $MORPHGS_ROOT/src/extlibs/GeoAware"
else
  ln -sfn "$GEO_ROOT" "$MORPHGS_ROOT/src/extlibs/GeoAware"
fi

echo "MorphGS cluster setup complete: $MORPHGS_ROOT"

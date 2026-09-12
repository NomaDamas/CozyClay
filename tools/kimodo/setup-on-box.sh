#!/usr/bin/env bash
# Provision the best-supported Kimodo runtime for the host this script runs on.
# Run directly on the host, or through setup-local.mjs (which pipes it over ssh).
#
# The installer is a router: it detects OS / architecture / RAM / CUDA and
# installs one of four backends, best first:
#
#   kimodo-mlx        macOS arm64 with > 32 GB RAM — MLX/Metal port with the
#                     15 GB LLM2Vec encoder resident in unified memory
#                     (measured 0.93 s warm E2E vs 37 s kimodo.cpp Metal on an
#                     M4 Max 64 GB; see NomaDamas/kimodo-mlx README benchmarks).
#   kimodo.cpp-metal  macOS arm64 with <= 32 GB RAM — GGML build streaming
#                     transformer layers from disk; residency is the wrong
#                     trade when the encoder cannot stay in memory.
#   nvidia-cuda       Linux with a working NVIDIA GPU — the upstream PyTorch
#                     Kimodo stack (nv-tlabs/kimodo), fully CUDA accelerated.
#   kimodo.cpp-cpu    any other Unix — GGML CPU build, Vulkan when available.
#
# Detection can be overridden for tests and dry-runs:
#   CCLAY_KIMODO_DETECT_OS, CCLAY_KIMODO_DETECT_ARCH,
#   CCLAY_KIMODO_DETECT_RAM_GB, CCLAY_KIMODO_DETECT_CUDA (0|1)
# The route itself is overridden with --backend or CCLAY_KIMODO_BACKEND.
set -euo pipefail

KIMODO_DIR="${CCLAY_KIMODO_REMOTE_DIR:-$HOME/.cozyclay/kimodo}"
VENV_DIR="${CCLAY_KIMODO_VENV_DIR:-$HOME/.cozyclay/kimodo-venv}"
MLX_DIR="${CCLAY_KIMODO_MLX_DIR:-$HOME/.cozyclay/kimodo-mlx}"
MLX_VENV_DIR="${CCLAY_KIMODO_MLX_VENV_DIR:-$HOME/.cozyclay/kimodo-mlx-venv}"
CPP_DIR="${CCLAY_KIMODO_CPP_DIR:-$HOME/.cozyclay/kimodo.cpp}"
CPP_VENV_DIR="${CCLAY_KIMODO_CPP_VENV_DIR:-$HOME/.cozyclay/kimodo-cpp-venv}"
# kimodo.cpp ref the Metal patch in NomaDamas/kimodo-mlx is known to apply to.
CPP_METAL_REF="${CCLAY_KIMODO_CPP_METAL_REF:-568b0253}"
MLX_MIN_RAM_GB="${CCLAY_KIMODO_MLX_MIN_RAM_GB:-32}"
CPP_VULKAN="${CCLAY_KIMODO_CPP_VULKAN:-auto}"
MODEL="${CCLAY_KIMODO_MODEL:-Kimodo-SOMA-RP-v1.1}"
BACKEND="${CCLAY_KIMODO_BACKEND:-auto}"
DRY_RUN=0

usage() {
  cat <<'EOF'
Usage: setup-on-box.sh [--backend NAME] [--kimodo-dir DIR] [--venv DIR]
                       [--model NAME] [--dry-run]

Detects the host and installs the best-supported Kimodo backend:
kimodo-mlx, kimodo.cpp-metal, nvidia-cuda, or kimodo.cpp-cpu.
--backend (or CCLAY_KIMODO_BACKEND) forces a route; --dry-run prints the
detected route and every command without changing the host.
HF_TOKEN may be present in the environment for Hugging Face access; it is never
printed by this script.
EOF
}
log() { printf 'setup-kimodo: %s\n' "$*"; }
die() { printf 'setup-kimodo: error: %s\n' "$*" >&2; exit 1; }
run() {
  if [ "$DRY_RUN" -eq 1 ]; then printf '+ '; printf '%q ' "$@"; printf '\n'; return 0; fi
  "$@"
}

while [ "$#" -gt 0 ]; do
  case "$1" in
    --backend) [ "$#" -ge 2 ] || die "--backend needs a value"; BACKEND="$2"; shift 2 ;;
    --kimodo-dir) [ "$#" -ge 2 ] || die "--kimodo-dir needs a value"; KIMODO_DIR="$2"; shift 2 ;;
    --venv) [ "$#" -ge 2 ] || die "--venv needs a value"; VENV_DIR="$2"; shift 2 ;;
    --model) [ "$#" -ge 2 ] || die "--model needs a value"; MODEL="$2"; shift 2 ;;
    --dry-run) DRY_RUN=1; shift ;;
    --help|-h) usage; exit 0 ;;
    *) die "unknown option: $1" ;;
  esac
done

# --- host detection -------------------------------------------------------

detect_os() {
  if [ -n "${CCLAY_KIMODO_DETECT_OS:-}" ]; then printf '%s' "$CCLAY_KIMODO_DETECT_OS"; else uname -s; fi
}
detect_arch() {
  if [ -n "${CCLAY_KIMODO_DETECT_ARCH:-}" ]; then printf '%s' "$CCLAY_KIMODO_DETECT_ARCH"; else uname -m; fi
}
detect_ram_gb() {
  if [ -n "${CCLAY_KIMODO_DETECT_RAM_GB:-}" ]; then printf '%s' "$CCLAY_KIMODO_DETECT_RAM_GB"; return; fi
  local bytes=""
  case "$(detect_os)" in
    Darwin) bytes=$(sysctl -n hw.memsize 2>/dev/null || true) ;;
    Linux) bytes=$(awk '/^MemTotal:/ {print $2 * 1024}' /proc/meminfo 2>/dev/null || true) ;;
  esac
  [ -n "$bytes" ] || { printf '0'; return; }
  printf '%s' $(( bytes / 1073741824 ))
}
detect_cuda() {
  if [ -n "${CCLAY_KIMODO_DETECT_CUDA:-}" ]; then printf '%s' "$CCLAY_KIMODO_DETECT_CUDA"; return; fi
  if command -v nvidia-smi >/dev/null 2>&1 && nvidia-smi >/dev/null 2>&1; then printf '1'; else printf '0'; fi
}

route_backend() {
  case "$BACKEND" in
    auto) ;;
    kimodo-mlx|kimodo.cpp-metal|nvidia-cuda|kimodo.cpp-cpu) printf '%s' "$BACKEND"; return ;;
    *) die "unknown backend: $BACKEND (expected kimodo-mlx, kimodo.cpp-metal, nvidia-cuda, kimodo.cpp-cpu, or auto)" ;;
  esac
  local os arch ram cuda
  os=$(detect_os); arch=$(detect_arch); ram=$(detect_ram_gb); cuda=$(detect_cuda)
  case "$os" in
    Darwin)
      case "$arch" in
        arm64)
          # > 32 GB keeps the 15 GB encoder resident; at or below it, stream.
          if [ "$ram" -gt "$MLX_MIN_RAM_GB" ]; then printf 'kimodo-mlx'; else printf 'kimodo.cpp-metal'; fi
          ;;
        *) printf 'kimodo.cpp-cpu' ;;
      esac
      ;;
    Linux)
      if [ "$cuda" = "1" ]; then printf 'nvidia-cuda'; else printf 'kimodo.cpp-cpu'; fi
      ;;
    *) die "unsupported OS: $os (use --backend to force a route, or run inside WSL on Windows)" ;;
  esac
}

OS=$(detect_os); ARCH=$(detect_arch); RAM_GB=$(detect_ram_gb); CUDA=$(detect_cuda)
BACKEND=$(route_backend)

if [ "$DRY_RUN" -eq 1 ]; then
  log "dry run; no files, packages, or models will be changed"
fi
log "detected: os=$OS arch=$ARCH ram=${RAM_GB}GB cuda=$CUDA"
log "backend=$BACKEND"

# --- backends ---------------------------------------------------------------

install_nvidia_cuda() {
  if [ "$DRY_RUN" -ne 1 ]; then
    command -v git >/dev/null 2>&1 || die "git is required"
    command -v python3 >/dev/null 2>&1 || die "python3 is required"
    command -v nvidia-smi >/dev/null 2>&1 || die "an NVIDIA CUDA host is required (nvidia-smi not found)"
    nvidia-smi >/dev/null 2>&1 || die "nvidia-smi cannot access the GPU"
  fi

  if [ ! -e "$KIMODO_DIR/.git" ]; then
    mkdir -p "$(dirname "$KIMODO_DIR")"
    run git clone --depth 1 https://github.com/nv-tlabs/kimodo.git "$KIMODO_DIR"
  else
    log "Kimodo checkout already exists at $KIMODO_DIR"
  fi

  if [ ! -x "$VENV_DIR/bin/python" ]; then
    run python3 -m venv "$VENV_DIR"
  else
    log "Python environment already exists at $VENV_DIR"
  fi

  PY="$VENV_DIR/bin/python"
  run "$PY" -m pip install --upgrade pip
  run "$PY" -m pip install torch
  run "$PY" -m pip install -e "$KIMODO_DIR" llm2vec

  if [ "$DRY_RUN" -eq 1 ]; then
    log "would prefetch model $MODEL and LLM2Vec encoder assets"
  else
    "$PY" - "$MODEL" <<'PY'
import sys
from huggingface_hub import snapshot_download
model = sys.argv[1]
snapshot_download(repo_id=f"nvidia/{model}")
snapshot_download(repo_id="meta-llama/Meta-Llama-3-8B-Instruct")
snapshot_download(repo_id="McGill-NLP/LLM2Vec-Meta-Llama-3-8B-Instruct-mntp")
snapshot_download(repo_id="McGill-NLP/LLM2Vec-Meta-Llama-3-8B-Instruct-mntp-supervised")
print("model and encoder assets ready")
PY
  fi

  log "export CCLAY_MOTION_BACKEND=kimodo"
  log "export CCLAY_KIMODO_HOST=<this host>"
  log "Kimodo model: $MODEL"
}

install_kimodo_mlx() {
  if [ "$DRY_RUN" -ne 1 ]; then
    command -v git >/dev/null 2>&1 || die "git is required"
    command -v python3 >/dev/null 2>&1 || die "python3 is required"
  fi

  if [ ! -e "$MLX_DIR/.git" ]; then
    mkdir -p "$(dirname "$MLX_DIR")"
    run git clone --depth 1 https://github.com/NomaDamas/kimodo-mlx.git "$MLX_DIR"
  else
    log "kimodo-mlx checkout already exists at $MLX_DIR"
  fi

  if [ ! -x "$MLX_VENV_DIR/bin/python" ]; then
    if command -v uv >/dev/null 2>&1; then
      run uv venv --python 3.12 "$MLX_VENV_DIR"
    else
      run python3 -m venv "$MLX_VENV_DIR"
    fi
  else
    log "Python environment already exists at $MLX_VENV_DIR"
  fi

  PY="$MLX_VENV_DIR/bin/python"
  HF="$MLX_VENV_DIR/bin/hf"
  run "$PY" -m pip install --upgrade pip
  run "$PY" -m pip install -e "$MLX_DIR" huggingface_hub

  run "$HF" download "nvidia/$MODEL" --local-dir "$MLX_DIR/models/$(printf '%s' "$MODEL" | sed 's/^Kimodo-/nvidia-/' | tr 'A-Z' 'a-z')"
  run "$HF" download LocalAI-io/Llama-3-Kimodo-GGML --local-dir "$MLX_DIR/models/llm2vec-text-bundle"

  if [ "$DRY_RUN" -eq 1 ]; then
    log "would run: $PY -m kimodo_mlx diagnose (expect mlx-metal)"
  else
    "$PY" -m kimodo_mlx diagnose || die "kimodo-mlx diagnose failed; see $MLX_DIR/README.md"
  fi

  log "kimodo-mlx ready: $PY -m kimodo_mlx generate --prompt \"walk forward\" --frames 30 --steps 10"
}

install_kimodo_cpp() {
  local accel="$1" # metal | cpu
  if [ "$DRY_RUN" -ne 1 ]; then
    command -v git >/dev/null 2>&1 || die "git is required"
    command -v cmake >/dev/null 2>&1 || die "cmake is required (CMake 3.25+)"
    command -v python3 >/dev/null 2>&1 || die "python3 is required"
  fi

  if [ ! -e "$CPP_DIR/.git" ]; then
    mkdir -p "$(dirname "$CPP_DIR")"
    run git clone --depth 1 https://github.com/localai-org/kimodo.cpp.git "$CPP_DIR"
  else
    log "kimodo.cpp checkout already exists at $CPP_DIR"
  fi
  run git -C "$CPP_DIR" submodule update --init --recursive

  local build_dir="$CPP_DIR/build-$accel"
  if [ "$accel" = "metal" ]; then
    # The GGML Metal wiring lives in a patch maintained with the kimodo-mlx
    # port; apply it onto the ref it was written against.
    if [ ! -e "$MLX_DIR/.git" ]; then
      mkdir -p "$(dirname "$MLX_DIR")"
      run git clone --depth 1 https://github.com/NomaDamas/kimodo-mlx.git "$MLX_DIR"
    fi
    run git -C "$CPP_DIR" fetch --depth 1 origin "$CPP_METAL_REF"
    run git -C "$CPP_DIR" checkout FETCH_HEAD
    if [ "$DRY_RUN" -eq 1 ]; then
      printf '+ '; printf '%q ' git -C "$CPP_DIR" apply "$MLX_DIR/patches/0001-kimodo-ggml-metal.patch"; printf '\n'
    else
      if git -C "$CPP_DIR" apply --check "$MLX_DIR/patches/0001-kimodo-ggml-metal.patch" 2>/dev/null; then
        git -C "$CPP_DIR" apply "$MLX_DIR/patches/0001-kimodo-ggml-metal.patch"
      else
        log "Metal patch already applied (or checkout dirty); continuing"
      fi
    fi
    run cmake -S "$CPP_DIR" -B "$build_dir" \
      -DKIMODO_ENABLE_VULKAN=OFF -DKIMODO_ENABLE_METAL=ON -DKIMODO_BUILD_TESTS=OFF
  else
    local vulkan="$CPP_VULKAN"
    if [ "$vulkan" = "auto" ]; then
      if pkg-config --exists vulkan 2>/dev/null || [ -f /usr/include/vulkan/vulkan.h ]; then
        vulkan=ON
      else
        vulkan=OFF
      fi
    fi
    log "kimodo.cpp CPU build: vulkan=$vulkan"
    run cmake -S "$CPP_DIR" -B "$build_dir" \
      -DKIMODO_ENABLE_VULKAN="$vulkan" -DKIMODO_BUILD_TESTS=OFF
  fi
  run cmake --build "$build_dir" --parallel

  # GGUF weights come from the LocalAI-io org through the upstream script,
  # which needs the hf CLI; keep it in a small dedicated venv.
  if [ ! -x "$CPP_VENV_DIR/bin/hf" ]; then
    run python3 -m venv "$CPP_VENV_DIR"
    run "$CPP_VENV_DIR/bin/python" -m pip install --upgrade pip huggingface_hub
  fi
  local cpp_model
  cpp_model=$(printf '%s' "$MODEL" | sed 's/^Kimodo-//' | tr 'A-Z' 'a-z')
  run env "PATH=$CPP_VENV_DIR/bin:$PATH" bash "$CPP_DIR/scripts/download_gguf_weights.sh" \
    --output "$CPP_DIR" --model "$cpp_model"

  log "kimodo.cpp ($accel) ready: build at $build_dir, GGUF weights under $CPP_DIR"
}

case "$BACKEND" in
  nvidia-cuda) install_nvidia_cuda ;;
  kimodo-mlx) install_kimodo_mlx ;;
  kimodo.cpp-metal) install_kimodo_cpp metal ;;
  kimodo.cpp-cpu) install_kimodo_cpp cpu ;;
esac

log "ready"

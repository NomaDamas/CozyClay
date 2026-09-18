# Kimodo setup

Motion generation in the Studio runs on [Kimodo](https://github.com/nv-tlabs/kimodo). The Studio ships seeded with a pre-generated clip, so scrubbing, cameras and rails work without any of this; you need Kimodo only to generate *new* motion from Prompt Blocks, and the same GPU box runs [GVHMR](https://github.com/zju3dv/GVHMR) for video and photo mocap (`CCLAY_EXTRACT_BACKEND=gvhmr` is the default; there is no browser fallback).

## Point the Studio at a host

```bash
CCLAY_KIMODO_HOST=user@your-gpu-box npx cozyclay
```

From a source checkout, `npm run dev` starts the Studio together with its local Kimodo bridge once `CCLAY_KIMODO_HOST` is set; without it the Studio starts alone and says so, and Block Generation stays unavailable. The bridge listens on loopback only.

## Install the worker

Once, on whichever machine should generate motion:

```bash
CCLAY_KIMODO_HOST=user@your-gpu-box npm run kimodo:setup
# or directly on the machine itself:
bash tools/kimodo/setup-on-box.sh
```

The installer is a router — it detects OS, architecture, RAM and CUDA, and installs the best-supported Kimodo variant for that host:

| Host | Backend installed | Why |
| --- | --- | --- |
| macOS Apple Silicon, RAM > 32 GB | [kimodo-mlx](https://github.com/NomaDamas/kimodo-mlx) (MLX/Metal) | The 15 GB text encoder stays resident in unified memory: ~0.9 s warm generation vs ~37 s streaming on an M4 Max 64 GB |
| macOS Apple Silicon, RAM ≤ 32 GB | [kimodo.cpp](https://github.com/localai-org/kimodo.cpp) + Metal (GGML) | Residency doesn't fit; streaming transformer layers from disk is the right trade |
| Linux + working NVIDIA CUDA | [NVIDIA Kimodo](https://github.com/nv-tlabs/kimodo) (PyTorch) | Full CUDA acceleration with the upstream stack |
| Other Unix, no CUDA | kimodo.cpp CPU (Vulkan when available) | Local GGML execution without a GPU |

Inspect the route without changing anything — and override it when you know better:

```bash
bash tools/kimodo/setup-on-box.sh --dry-run
bash tools/kimodo/setup-on-box.sh --backend kimodo.cpp-metal   # or CCLAY_KIMODO_BACKEND=...
```

The RAM threshold between the two macOS routes defaults to 32 GB (`CCLAY_KIMODO_MLX_MIN_RAM_GB`). Every install path and detection override is documented at the top of [`tools/kimodo/setup-on-box.sh`](../tools/kimodo/setup-on-box.sh).

## CUDA over SSH

The classic target. The installer places the checkout at `$HOME/.cozyclay/kimodo` and its virtual environment at `$HOME/.cozyclay/kimodo-venv`, then links the venv at `$CCLAY_KIMODO_REPO/.venv` where the Studio runner expects it. This is the only route that supports the full feature set: sequencing, waypoints, pinned poses, and preserve.

## Local generation (MLX, Metal, CPU)

Set `CCLAY_KIMODO_BACKEND` to `kimodo-mlx`, `kimodo.cpp-metal`, or `kimodo.cpp-cpu` and leave `CCLAY_KIMODO_HOST` unset. Single unconstrained SOMA30 prompts at 30 fps convert to the Studio NPZ format. The MLX wrapper retains runtime arrays that the upstream CLI's JSON omits; both local routes expand the 30-joint output using NVIDIA's canonical SOMA77 hierarchy and relaxed-hand rest pose, then run forward kinematics before retargeting to cskel27.

Sequencing, waypoints, pinned poses, and preserve still require CUDA/SSH and are explicitly refused locally. Local conversion is tested with synthetic outputs; model inference requires the installed runtime and weights. The local integration originated in [#239](https://github.com/NomaDamas/CozyClay/issues/239).

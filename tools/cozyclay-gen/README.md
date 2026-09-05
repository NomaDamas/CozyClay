# cozyclay-gen

Headless MiniMax-H3 video generation for CozyClay. Uses ComfyUI **as a Python library**
(its model loaders, int8 convrot kernels, SLA sparse attention, H3 VAE) with no ComfyUI server,
no node graph, no UI. One HTTP endpoint, models stay resident, one job at a time.

First deployed 2026-09-05 on a single RTX PRO 6000 (96 GB) Slurm node.

## Layout

| file | role |
|---|---|
| `h3_gen.py` | boots ComfyUI headless (same pre-torch order as `main.py`: args, `cuda_malloc`, `comfy_aimdo`), loads UNET / CLIP / VAEs once, `H3.generate(...)` runs the 05 ref2va / 04 i2v-fl2v / 01 t2v graph in code, writes mp4 |
| `server.py` | aiohttp service: `GET /health`, `POST /generate`, `GET /video/<id>.mp4`, `GET /prompt-template?mode=ref` |
| `h3_prompts.py` | mocap prompt builders (official IR contract, fixed camera, 3/4 angle, timed beats, end hold) |
| `client.mjs` | fetch client for CozyClay |
| `cozyclay-gen.sbatch` | Slurm launcher (self-resubmits at the 12 h partition limit, purges clips > 60 min) |

## Run

Requirements: a ComfyUI checkout with its venv (MiniMax-H3 native support, `comfy_kitchen`, the PlagueKind SLA node pack), the H3 models under
`$COMFY_DATA/models`, and one 96 GB-class GPU. `Scene to Mocap Prompt (AI)` additionally loads `Qwen/Qwen3-8B` (bf16, ~16 GB).

```bash
export COMFY_ROOT=/path/to/ComfyUI COMFY_DATA=/path/to/comfy-data COZYCLAY_GEN_DIR=$PWD
source $COMFY_ROOT/.venv/bin/activate
python server.py --port 8288                # ~70 s until models are loaded
# or on Slurm:
sbatch cozyclay-gen.sbatch                  # self-resubmits at the partition time limit, purges clips > 60 min
```

Then open `http://<host>:8288/` (node canvas) or `/form` (plain form).

## API

```bash
curl -F "prompt=<prompt.txt" -F seconds=5 -F megapixels=0.4 -F aspect=16:9 -F seed=42 -F steps=4 \
     -F ref=@pose_ref.png http://localhost:8288/generate
# {"job":"dcb159a1df","mp4":"/video/dcb159a1df.mp4","wall_seconds":14.5,...}
curl -o out.mp4 http://localhost:8288/video/dcb159a1df.mp4
```

Fields: `prompt` (required, official H3 contract), `seconds`, `megapixels`, `aspect` (`16:9 9:16 4:3 3:4 1:1 3:2 2:3 21:9`),
`seed`, `steps` (4 or 8), `audio` (0/1, default 0 for mocap), `mode` (`auto|ref|i2v`).
Files: `ref` (repeatable, Ref2VA) or `first` / `last` (I2V / FL2V).

## Measured (5 s, 832x480, 4 steps, SLA on, no audio)

| | wall |
|---|---|
| first call after boot (text encode + weights fault-in) | 18.3 s |
| warm call | **14.5 s** (sample 9.1 s + decode/save 5.3 s) |

Same speed as the ComfyUI server graph it replaces; mp4 carries no prompt/workflow metadata.

## Gotchas that cost time

- **`torch.inference_mode()` is mandatory** around every node call. ComfyUI's executor does it; without it the output latent
  keeps the whole DiT autograd graph alive (~60 GB) and the VAE decode OOMs. Fixed in `call()`.
- Boot order matters: `import cuda_malloc` and `import comfy_aimdo.control` must run before `torch` (as in `main.py`),
  otherwise weights load eagerly and dynamic VRAM is off.
- `h3_gen` chdirs into the ComfyUI root; CLI paths are resolved against the original cwd (`_abs`).
- Do not share the card with a `--highvram` ComfyUI server; H3 decode needs headroom. The service assumes the whole GPU.
- Slurm partitions with a time limit: the sbatch queues its successor with `--dependency=afterany` (via `COZYCLAY_GEN_SUBMIT_HOST` if compute nodes lack `sbatch`).

## Canvas (default UI at `/`)

LiteGraph node canvas, same interaction model as ComfyUI. Node types come from `GET /nodes` (defined in `graph_nodes.py`),
the graph is posted to `POST /run`, progress polled at `GET /run/<id>`. Per-node output cache (12 entries) so changing
only the seed re-runs sampling, not conditioning.

Preset (`presets/mocap_ref2va.graph.json`, loaded on first open / "Mocap preset" button):
`Load Image (presets/preset_female_gray_34.png)` -> `Scene to Mocap Prompt (AI)` -> `H3 Ref2VA Conditioning (15 s, 0.4 MP, 16:9)` -> `H3 Sample (seed 42, 4 steps, SLA)` -> `H3 Decode (no audio)` -> `Save Video`.

`Scene to Mocap Prompt (AI)`: type the scene in plain Korean/English; a local **Qwen3-8B** (bf16, ~16 GB, loaded next to H3)
applies the `h3-mocap-prompting` skill (embedded as its system prompt in `rewriter.py`) and writes the full Ref2VA contract:
fixed 3/4 camera, one person, timed beats tiling the clip, explicit end hold, props declared, no repeats. ~20-25 s per prompt.
`POST /rewrite {"scene": "...", "seconds": 15}` exposes the same thing. Set `COZYCLAY_LLM=openai` + `OPENAI_API_KEY` to use an API model instead.

Adding a node = one Python function with `@node(...)` in `graph_nodes.py`; `g.call("<any ComfyUI node>", ...)` is available inside.

## Not done yet

- GVHMR / SAM 3D Body lift is not wired in (`/generate` returns mp4 only). Next: `lift/` step on the same box -> BVH -> cskel27.
- No auth on the port; it is only reachable inside the cluster / via the ssh tunnel.
- MiniMax-H3 weights are under the MiniMax Community License (territorial exclusions apply); this service does not ship weights. Point it at your own ComfyUI/models or use an API provider.

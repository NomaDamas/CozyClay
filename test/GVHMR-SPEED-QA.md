# GVHMR exact-output acceleration QA — 2026-09-05

## Result

Implementation and QA were recorded on `feat/gvhmr-mocap` above `18ac437`.
Raw video, image and motion evidence stays local and is not included in Git.
Existing AutoPhysics, SMPL retargeting, upstream runner and checkpoints were
not changed. Local development uses app 5180 / bridge 5181.

Three preparation changes: shared identical ViTPose/HMR2 video crops;
memory-mapped checkpoint loading with audited skip-initialization; one serial
worker retaining those two models on CPU, never both resident on GPU.

Analogy: same ingredients and recipe, without rebuilding the kitchen for
every order. This does not accelerate the underlying neural-network math.

## Measured on the actual RTX 3070 8 GB host

GPU host: `yun@ubuntu-baremetal`, PyTorch 2.3.0+cu121.
Upstream checkout: `6ec3ca39336c50492c0fae65fba2fb831fc7d866`.
Existing runner SHA256:
`28dd1bd612216f5e50198d01ef9e8a8f42cfe658847b9814d88f1f920c87ccc9`.
FP32, original flip test, original batch sizes, static camera, no frame drop.

| Test and timing boundary | Original | Fast first use | Fast reused worker |
| --- | ---: | ---: | ---: |
| 124-frame / 24-fps walk, HTTP upload through served retargeted NPZ | 29.86 s | 22.98 s (−23.0%) | 17.73 s (−40.6%) |
| 362-frame / 24-fps bow, extraction inside an imported worker | 48.90 s | 42.33 s (−13.4%) | 39.92 s (−18.4%) |
| 124-frame walk, extraction inside an imported worker | 22.47 s | — | 16.92 s (−24.7%) |

Bare original bow process including imports/exit: 51.85 s. Fast cold bow
worker imports: 2.51 s in addition to its 42.33 s job. Timings above are
individual measured runs, not a broad benchmark or a guaranteed speedup.
The OS disk cache was not flushed. Cold means a new process/models, not cold
disk. No motion-result cache was used. Warm walk followed a different bow
clip, then bow ran again, testing cross-video state isolation as well as reuse.

## Quality and memory gates

- All **9 raw NPZ fields**, shapes and dtypes match the reference exactly,
  maximum absolute difference **0**. All **6 preprocessing tensors** also
  match exactly, for both clips and repeated bow extraction.
- Bare original bow and instrumented reference are exactly equal too.
- Through HTTP, all served **CSKEL27 NPZ fields** match exactly for original,
  cold and warm execution. This covers upload, GPU runner, download,
  retargeting and archive serving, not just model inference.
- After restarting the real development server, extraction at port **5181**
  completed in **22.96 s**, returning **124 frames at 24 fps**. Its downloaded
  final NPZ also exactly matched the original-path integration reference.
  App port 5180 returned HTTP 200; bridge health reported `ok:true`, CUDA.
- GPU tensor peak unchanged: bow 3098.66 MiB, walk 2920.66 MiB;
  PyTorch reserved peak 3412 MiB, idle allocated 32 MiB in both paths.
  These are PyTorch metrics, not total device usage including other processes.
- CPU cached model tensors: 4988.36 MiB (~4.87 GiB), excluding other host
  allocations. Ten minutes idle, cancellation or bridge shutdown releases
  the worker. After integration bridge shutdown its remote PID was absent
  and total GPU usage returned to the pre-test 1146 MiB.
- `npm test`: build and **114 Node verification files passed**.
- `node --test test/smpl-cskel27.test.mjs`: **5/5 passed** including the real
  walk and torso/neck bind-shape regression.
- Python guard tests: exact checkpoint weights, reject uncovered/partial
  loads, restore all scoped patches, mmap and legacy checkpoint fallback.
- Worker tests: process reuse, per-job identity, concurrent rejection,
  process crash, malformed protocol, cancellation, deployment cancellation,
  timeout, restart and idle shutdown.

Exact equality was established on these clips/settings, not all possible
videos or future upstream changes. Moving-camera footage was not benchmarked;
its VO/camera math is untouched. This is numerical regression QA plus a local
UI restore/smoke check, not a new full visual-quality evaluation of GVHMR.

## Reproduction / evidence

`test/qa-gvhmr-speed.py` runs on the GPU box with its venv; provide the worker,
an output directory and videos. `--bare` adds a completely unwrapped baseline.
`test/qa-gvhmr-bridge.mjs <video> <evidence-directory>` runs private local
bridges and compares the complete HTTP path. Neither replaces the existing
remote runner. `test/verify-gvhmr-fastload.py` needs the same torch environment.

Local machine-readable evidence:
`../.omo/evidence/gvhmr-speed-20260905/raw-metrics.json`,
`../.omo/evidence/gvhmr-speed-20260905/bridge/metrics.json`, original/fast NPZs,
and bridge logs. The existing Studio scene was retained across restart;
its unapplied AutoPhysics preview was recomputed, with original IK keys still
empty. UI-only smoke screenshot: `../.omo/evidence/gvhmr-speed-20260905/studio-restored.png`.
This screenshot is not an acceleration before/after comparison. Remote raw/preprocessing evidence:
`/tmp/cozyclay-gvhmr-qa.cXUuhc/results/`.

Rollback: `CCLAY_GVHMR_WORKER=0` and restart the bridge. This restores its
unchanged one-shot execution path. No fork replacement, quantization,
mixed precision, model reduction or C++ reimplementation was included.

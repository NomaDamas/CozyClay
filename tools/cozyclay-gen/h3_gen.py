"""
cozyclay-gen / h3_gen.py
Headless MiniMax-H3 generation using ComfyUI as a Python library (no server, no UI).

Reproduces the MATLOWAI 05_ref2va / 04_i2v_fl2v / 01 t2v graphs in ~code,
keeps every model resident between calls, and writes an mp4.

Usage (library):
    from h3_gen import H3
    h3 = H3()                       # loads models once (~40 GB VRAM)
    mp4 = h3.generate(prompt, refs=["a.png"], seconds=15, megapixels=0.4)

Usage (cli smoke test):
    python h3_gen.py --prompt-file p.txt --ref a.png --seconds 5 --out /tmp/x.mp4
"""
import os, sys, math, time, argparse, logging

COMFY_ROOT = os.environ.get("COMFY_ROOT", os.path.expanduser("~/ComfyUI"))
COMFY_DATA = os.environ.get("COMFY_DATA", os.path.expanduser("~/comfy-data"))

# ---- ComfyUI bootstrap ------------------------------------------------------
# ComfyUI reads CLI flags at import time, so set argv before importing anything.
_START_CWD = os.getcwd()  # h3_gen chdirs into ComfyUI; resolve user paths against the original cwd


def _abs(p):
    return None if p is None else (p if os.path.isabs(p) else os.path.join(_START_CWD, p))


_saved_argv = sys.argv
sys.argv = [
    "comfy-headless",
    "--disable-metadata",
] + (["--highvram"] if os.environ.get("COMFY_HIGHVRAM") == "1" else []) + [
    "--output-directory", os.path.join(COMFY_DATA, "output"),
    "--input-directory", os.path.join(COMFY_DATA, "input"),
    "--user-directory", os.path.join(COMFY_DATA, "user"),
]
sys.path.insert(0, COMFY_ROOT)
os.chdir(COMFY_ROOT)

import comfy.options
comfy.options.enable_args_parsing()
from comfy.cli_args import args  # noqa: E402
from comfy.cli_args import get_console_log_level, get_file_log_outputs  # noqa: E402
from app.logger import setup_logger  # noqa: E402
setup_logger(log_level=get_console_log_level(args.verbose), file_outputs=get_file_log_outputs(args.verbose), use_stdout=True)

# Same pre-torch boot as main.py: cudaMallocAsync allocator + dynamic-VRAM (aimdo/VBAR) control.
# Skipping these makes every weight load eagerly (~2x VRAM) and breaks int8 convrot staging.
import cuda_malloc  # noqa: E402,F401
import comfy_aimdo.control  # noqa: E402,F401
sys.argv = _saved_argv

import asyncio  # noqa: E402
import torch  # noqa: E402
import numpy as np  # noqa: E402
from PIL import Image, ImageOps  # noqa: E402

import folder_paths  # noqa: E402
import nodes  # noqa: E402
import server  # noqa: E402
import comfy.model_management as mm  # noqa: E402

log = logging.getLogger("cozyclay-gen")


def _boot_nodes():
    """Load comfy_extras + custom_nodes (SLA etc.) exactly like main.py does, minus the web server."""
    loop = asyncio.new_event_loop()
    asyncio.set_event_loop(loop)
    # Some custom nodes touch PromptServer.instance at import; give them one (not started).
    if getattr(server.PromptServer, "instance", None) is None:
        server.PromptServer(loop)
    res = nodes.init_extra_nodes(init_custom_nodes=True, init_api_nodes=False)
    if asyncio.iscoroutine(res):
        loop.run_until_complete(res)
    return loop


_LOOP = _boot_nodes()
N = nodes.NODE_CLASS_MAPPINGS


def call(cls_name, **kw):
    """Run a node class headless. Handles V1 (FUNCTION) and V3 (execute) nodes. Returns a tuple."""
    cls = N[cls_name]
    # ComfyUI's executor runs every node under inference_mode; without it autograd keeps every DiT
    # activation alive through the output tensor (~60 GB at 0.4 MP / 5 s) and the VAE decode OOMs.
    with torch.inference_mode():
        if hasattr(cls, "FUNCTION"):
            out = getattr(cls(), cls.FUNCTION)(**kw)
        else:
            out = cls.execute(**kw)
    if hasattr(out, "args"):
        out = out.args
    if isinstance(out, dict) and "result" in out:
        out = out["result"]
    return tuple(out) if isinstance(out, (list, tuple)) else (out,)


def load_image(path):
    img = Image.open(path)
    img = ImageOps.exif_transpose(img).convert("RGB")
    arr = np.asarray(img).astype(np.float32) / 255.0
    return torch.from_numpy(arr)[None, ...]  # [1,H,W,3]


def frames_for_seconds(sec):
    f = max(5, round(sec * 24))
    return f + (5 - (f % 17)) % 17


ASPECTS = {
    "16:9": 16 / 9, "9:16": 9 / 16, "4:3": 4 / 3, "3:4": 3 / 4,
    "1:1": 1.0, "3:2": 3 / 2, "2:3": 2 / 3, "21:9": 21 / 9,
}


def resolution(aspect, megapixels, multiple=32):
    ar = ASPECTS[aspect] if isinstance(aspect, str) else float(aspect)
    area = megapixels * 1_000_000
    w = round(math.sqrt(area * ar) / multiple) * multiple
    h = round(math.sqrt(area / ar) / multiple) * multiple
    return int(w), int(h)


class H3:
    def __init__(
        self,
        unet="minimax_h3_fused_refdelta_r1024_turbo8_mystic07_int8_convrot.safetensors",
        clip="qwen3vl_32b_minimax_h3_nvfp4_awq.safetensors",
        video_vae="minimax_h3_video_vae_int8_convrot.safetensors",
        audio_vae="minimax_h3_audio_vae_fp32.safetensors",
        sla=True, sla_sparsity=0.9, sla_block=64, sla_min_seq=0, sla_dense_last=0,
        shift_video=12.0, shift_audio=3.0,
    ):
        t0 = time.time()
        (self.model,) = call("UNETLoader", unet_name=unet, weight_dtype="default")
        (self.clip,) = call("CLIPLoader", clip_name=clip, type="minimax", device="default")
        (self.vae,) = call("VAELoader", vae_name=video_vae)
        (self.audio_vae,) = call("VAELoader", vae_name=audio_vae)
        m = self.model
        if sla and "H3SLAAttention" in N:
            (m,) = call("H3SLAAttention", model=m, sparsity_ratio=sla_sparsity, block_size=sla_block,
                        min_seq_len=sla_min_seq, dense_last_steps=sla_dense_last,
                        protect_audio=True, enabled=True)
        (m,) = call("MiniMaxH3SigmaShift", model=m, shift_video=shift_video, shift_audio=shift_audio)
        self.model_patched = m
        log.info("models ready in %.1fs", time.time() - t0)

    # ------------------------------------------------------------------
    def generate(
        self, prompt, refs=None, first_frame=None, last_frame=None,
        seconds=5.0, megapixels=0.4, aspect="16:9", seed=42, steps=4,
        sampler="res_multistep", scheduler="simple", audio=False,
        out_path=None, ref_image_size="match",
    ):
        """
        mode is inferred:
          refs (list of image paths)       -> Ref2VA  (05)
          first_frame [+ last_frame]       -> I2V / FL2V (04)
          neither                          -> T2V (01)
        Returns the mp4 path.
        """
        t0 = time.time()
        width, height = resolution(aspect, megapixels)
        length = frames_for_seconds(seconds)
        log.info("gen %dx%d x%d frames, steps=%d, seed=%d | vram alloc %.1f GB", width, height, length, steps, seed,
                 torch.cuda.memory_allocated() / 1e9)

        if refs:
            ref_images = {f"ref_image_{i}": load_image(p) for i, p in enumerate(refs)}
            cond, latent = call(
                "MiniMaxH3ReferenceToVideo",
                clip=self.clip, vae=self.vae, audio_vae=self.audio_vae, prompt=prompt,
                width=width, height=height, length=length, ref_image_size=ref_image_size,
                ref_images=ref_images,
            )
        else:
            kw = dict(clip=self.clip, vae=self.vae, prompt=prompt, width=width, height=height, length=length)
            if first_frame:
                kw["first_frame"] = load_image(first_frame)
            if last_frame:
                kw["last_frame"] = load_image(last_frame)
            cond, latent = call("MiniMaxH3ImageToVideo", **kw)

        (noise,) = call("RandomNoise", noise_seed=int(seed))
        (samp,) = call("KSamplerSelect", sampler_name=sampler)
        (sigmas,) = call("BasicScheduler", model=self.model_patched, scheduler=scheduler, steps=int(steps), denoise=1.0)
        (guider,) = call("BasicGuider", model=self.model_patched, conditioning=cond)
        out_latent, _ = call("SamplerCustomAdvanced", noise=noise, guider=guider, sampler=samp, sigmas=sigmas, latent_image=latent)
        t_sample = time.time()
        # drop sampling-time references so the DiT activations can be reclaimed before the VAE runs
        del noise, samp, sigmas, guider, cond, latent
        mm.soft_empty_cache(True)
        log.info("sampled in %.1fs | vram alloc %.1f GB", t_sample - t0, torch.cuda.memory_allocated() / 1e9)
        # H3 video VAE decode needs ~35 GB of activations at 0.4 MP / 5 s. Make room; on a dedicated 96 GB
        # card nothing gets unloaded, on a shared card this evicts the DiT/TE (reloaded lazily next call).
        dev = mm.get_torch_device()
        # with inference_mode the H3 VAE streams temporal chunks; a few GB is enough. Keep a margin so a
        # shared GPU still evicts, but on a dedicated 96 GB card nothing gets unloaded between calls.
        need = max(int(8e9), int(20e9 * (width * height * length) / (832 * 480 * 124)))
        free = mm.get_free_memory(dev)
        if free < need:
            log.info("decode needs ~%.0f GB, %.0f GB free -> partial unload", need / 1e9, free / 1e9)
            mm.free_memory(need, dev)  # dynamic-VRAM friendly: pages weights out, keeps them staged
            free = mm.get_free_memory(dev)
        if free < need:
            log.info("still %.0f GB free -> evicting all models (shared GPU?)", free / 1e9)
            mm.unload_all_models()
            torch.cuda.empty_cache()
        mm.soft_empty_cache(True)

        (images,) = call("VAEDecode", samples=out_latent, vae=self.vae)
        aud = None
        if audio:
            (aud,) = call("VAEDecodeAudio", samples=out_latent, vae=self.audio_vae)
        (video,) = call("CreateVideo", images=images, fps=24.0, audio=aud)

        if out_path is None:
            os.makedirs(os.path.join(COMFY_DATA, "output", "cozyclay"), exist_ok=True)
            out_path = os.path.join(COMFY_DATA, "output", "cozyclay", f"h3_{int(time.time())}_{seed}.mp4")
        os.makedirs(os.path.dirname(out_path), exist_ok=True)
        try:
            from comfy_api.latest import VideoContainer, VideoCodec
            video.save_to(out_path, format=VideoContainer.MP4, codec=VideoCodec.H264, metadata=None)
        except Exception:
            video.save_to(out_path)
        log.info("done: sample %.1fs, decode+save %.1fs, total %.1fs -> %s",
                 t_sample - t0, time.time() - t_sample, time.time() - t0, out_path)
        return out_path


if __name__ == "__main__":
    logging.basicConfig(level=logging.INFO, format="%(asctime)s %(name)s %(message)s")
    ap = argparse.ArgumentParser()
    ap.add_argument("--prompt", default=None)
    ap.add_argument("--prompt-file", default=None)
    ap.add_argument("--ref", action="append", default=[])
    ap.add_argument("--first", default=None)
    ap.add_argument("--last", default=None)
    ap.add_argument("--seconds", type=float, default=5)
    ap.add_argument("--mp", type=float, default=0.4)
    ap.add_argument("--aspect", default="16:9")
    ap.add_argument("--seed", type=int, default=42)
    ap.add_argument("--steps", type=int, default=4)
    ap.add_argument("--audio", action="store_true")
    ap.add_argument("--out", default=None)
    a = ap.parse_args()
    prompt = a.prompt or open(_abs(a.prompt_file)).read()
    h3 = H3()
    p = h3.generate(prompt, refs=[_abs(r) for r in a.ref] or None, first_frame=_abs(a.first), last_frame=_abs(a.last),
                    seconds=a.seconds, megapixels=a.mp, aspect=a.aspect, seed=a.seed,
                    steps=a.steps, audio=a.audio, out_path=_abs(a.out))
    print(p)

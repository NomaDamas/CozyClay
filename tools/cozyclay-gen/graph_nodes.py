"""
cozyclay-gen / graph_nodes.py
Node registry for the cozyclay-gen canvas. A node is a Python function with a typed signature.

Adding a node:
    @node("My Node", category="h3", inputs=[inp("latent", "LATENT"), inp("gain", "FLOAT", default=1.0, min=0, max=2)],
          outputs=[("latent", "LATENT")])
    def my_node(ctx, latent, gain): ...
        return (latent,)

Types: IMAGE (tensor [1,H,W,3]), STRING, INT, FLOAT, BOOL, COMBO, COND, LATENT, VIDEO.
Primitive types become widgets on the node and can also be wired from another node.
"""
import os, math, time, hashlib

NODES = {}


def inp(name, type_, default=None, **opts):
    d = {"name": name, "type": type_}
    if default is not None:
        d["default"] = default
    d.update(opts)
    return d


def node(name, category="h3", inputs=(), outputs=(), description=""):
    def deco(fn):
        NODES[name] = {
            "name": name, "category": category, "description": description,
            "inputs": list(inputs), "outputs": [{"name": n, "type": t} for n, t in outputs],
            "fn": fn,
        }
        return fn
    return deco


def registry_json():
    return [{k: v for k, v in d.items() if k != "fn"} for d in NODES.values()]


# ---------------------------------------------------------------------------
# helpers that touch h3_gen lazily (so this module imports without the GPU)

def _g():
    import h3_gen
    return h3_gen


ASPECTS = ["16:9", "9:16", "4:3", "3:4", "1:1", "3:2", "2:3", "21:9"]


# ---------------------------------------------------------------------------
# input / text nodes

@node("Load Image", category="advanced",
      inputs=[inp("image", "IMAGEFILE", default="preset_female_gray_34.png", multiline=False)],
      outputs=[("image", "IMAGE")],
      description="Upload / pick an image. Output is a [1,H,W,3] tensor.")
def load_image(ctx, image):
    path = ctx.input_path(image)
    return (_g().load_image(path),)


@node("Prompt", category="advanced",
      inputs=[inp("text", "STRING", default="", multiline=True)],
      outputs=[("text", "STRING")])
def prompt_text(ctx, text):
    return (text,)


@node("Mocap Prompt (Ref2VA)", category="advanced",
      inputs=[
          inp("summary_action", "STRING", default="taking a few steps across the frame, stopping, performing one single deep formal bow toward the camera, rising", multiline=True),
          inp("beats", "STRING", multiline=True, default=(
              "0-3: <Subject 1> starts standing as in <Picture 1> and walks three calm steps across the frame, then stops and turns to face the camera.\n"
              "3-5: <Subject 1> stands facing the camera, brings both hands together in front of the body, and pauses.\n"
              "5-7.5: <Subject 1> slowly kneels down, places both hands flat on the floor, and lowers the forehead toward the hands with a flat back.\n"
              "7.5-9: <Subject 1> holds the lowest point of the bow completely still.\n"
              "9-11: <Subject 1> rises in one smooth motion: head and torso lift, sits back on the heels, then stands up straight.")),
          inp("seconds", "FLOAT", default=15.0, min=2, max=15, step=1),
          inp("human", "BOOL", default=False),
      ],
      outputs=[("text", "STRING")],
      description="Builds the official H3 reference contract with mocap constraints (fixed camera, 3/4 angle, timed beats, end hold). beats: one per line 'start-end: sentence'.")
def mocap_prompt(ctx, summary_action, beats, seconds, human):
    import h3_prompts
    parsed = []
    for line in beats.splitlines():
        line = line.strip()
        if not line or ":" not in line:
            continue
        rng, sent = line.split(":", 1)
        a, b = rng.replace("~", "-").split("-", 1)
        parsed.append((float(a), float(b), sent.strip()))
    return (h3_prompts.ref2va(summary_action, parsed, float(seconds), human=bool(human)),)


@node("Scene to Mocap Prompt (AI)", category="advanced",
      inputs=[
          inp("scene", "STRING", default="A person walks in and bows deeply toward the camera", multiline=True,
              placeholder="Describe the scene in plain words (Korean or English). The AI writes the H3 contract from this."),
          inp("seconds", "FLOAT", default=15.0, min=2, max=15, step=1),
          inp("manual_prompt", "STRING", default="", multiline=True,
              placeholder="Optional. Write or paste the full H3 prompt here to bypass the AI. Leave empty to use 'scene'."),
          inp("base_url", "STRING", default="", placeholder="OpenAI-compatible base URL (optional; env fallback)"),
          inp("api_key", "STRING", default="", placeholder="API key (optional; env fallback)"),
          inp("model", "STRING", default="", placeholder="Model name (optional; env fallback)"),
      ],
      outputs=[("text", "STRING"), ("seconds", "FLOAT")],
      description="Describe the scene in plain words (Korean or English). An OpenAI-compatible BYOK model applies the h3-mocap-prompting skill and writes the full H3 contract.")
def scene_to_prompt(ctx, scene, seconds, manual_prompt="", base_url="", api_key="", model=""):
    if manual_prompt and manual_prompt.strip():
        text = manual_prompt.strip()
    else:
        text = ctx.rewriter.rewrite(scene, float(seconds), base_url or None, api_key or None, model or None)
    ctx.ui(text=text)
    return (text, float(seconds))


# ---------------------------------------------------------------------------
# conditioning nodes

def _res(aspect, megapixels):
    return _g().resolution(aspect, float(megapixels))


@node("H3 Ref2VA Conditioning", category="advanced",
      inputs=[
          inp("prompt", "STRING", default="", multiline=True),
          inp("ref_image_1", "IMAGE", optional=True),
          inp("ref_image_2", "IMAGE", optional=True),
          inp("ref_image_3", "IMAGE", optional=True),
          inp("seconds", "FLOAT", default=5.0, min=2, max=15, step=1),
          inp("megapixels", "FLOAT", default=0.4, min=0.2, max=1.4, step=0.1),
          inp("aspect", "COMBO", default="16:9", options=ASPECTS),
          inp("ref_image_size", "COMBO", default="match", options=["match", "max"]),
      ],
      outputs=[("conditioning", "COND"), ("latent", "LATENT")],
      description="Reference mode (05): pictures are <Picture N> references, appearance can be rewritten by the prompt.")
def h3_ref2va(ctx, prompt, seconds, megapixels, aspect, ref_image_size, ref_image_1=None, ref_image_2=None, ref_image_3=None):
    g = _g()
    w, h = _res(aspect, megapixels)
    length = g.frames_for_seconds(float(seconds))
    refs = {f"ref_image_{i}": im for i, im in enumerate([ref_image_1, ref_image_2, ref_image_3]) if im is not None}
    h3 = ctx.h3
    cond, latent = g.call("MiniMaxH3ReferenceToVideo", clip=h3.clip, vae=h3.vae, audio_vae=h3.audio_vae, prompt=prompt,
                          width=w, height=h, length=length, ref_image_size=ref_image_size, ref_images=refs or None)
    return (cond, latent)


@node("H3 I2V / FL2V Conditioning", category="advanced",
      inputs=[
          inp("prompt", "STRING", default="", multiline=True),
          inp("first_frame", "IMAGE", optional=True),
          inp("last_frame", "IMAGE", optional=True),
          inp("seconds", "FLOAT", default=5.0, min=2, max=15, step=1),
          inp("megapixels", "FLOAT", default=0.4, min=0.2, max=1.4, step=0.1),
          inp("aspect", "COMBO", default="16:9", options=ASPECTS),
      ],
      outputs=[("conditioning", "COND"), ("latent", "LATENT")],
      description="Image-to-video (04): first/last frames are pixel-locked. No images = text-to-video (01).")
def h3_i2v(ctx, prompt, seconds, megapixels, aspect, first_frame=None, last_frame=None):
    g = _g()
    w, h = _res(aspect, megapixels)
    length = g.frames_for_seconds(float(seconds))
    kw = dict(clip=ctx.h3.clip, vae=ctx.h3.vae, prompt=prompt, width=w, height=h, length=length)
    if first_frame is not None:
        kw["first_frame"] = first_frame
    if last_frame is not None:
        kw["last_frame"] = last_frame
    cond, latent = g.call("MiniMaxH3ImageToVideo", **kw)
    return (cond, latent)


# ---------------------------------------------------------------------------
# sampling / decode / output

@node("H3 Sample", category="advanced",
      inputs=[
          inp("conditioning", "COND"),
          inp("latent", "LATENT"),
          inp("seed", "INT", default=42, min=0, max=2**32 - 1),
          inp("steps", "INT", default=4, min=1, max=25),
          inp("sampler", "COMBO", default="res_multistep", options=["res_multistep", "euler", "heun", "euler_ancestral"]),
          inp("scheduler", "COMBO", default="simple", options=["simple", "sgm_uniform", "beta", "normal"]),
          inp("sla", "BOOL", default=True),
          inp("sla_sparsity", "FLOAT", default=0.9, min=0.5, max=0.98, step=0.01),
          inp("shift_video", "FLOAT", default=12.0, min=1, max=20, step=0.5),
      ],
      outputs=[("latent", "LATENT")],
      description="Runs the fused turbo DiT. 4 steps is the model's design point; 8 sharpens slightly.")
def h3_sample(ctx, conditioning, latent, seed, steps, sampler, scheduler, sla, sla_sparsity, shift_video):
    g = _g()
    m = ctx.h3.model
    if sla and "H3SLAAttention" in g.N:
        (m,) = g.call("H3SLAAttention", model=m, sparsity_ratio=float(sla_sparsity), block_size=64,
                      min_seq_len=0, dense_last_steps=0, protect_audio=True, enabled=True)
    (m,) = g.call("MiniMaxH3SigmaShift", model=m, shift_video=float(shift_video), shift_audio=3.0)
    (noise,) = g.call("RandomNoise", noise_seed=int(seed))
    (samp,) = g.call("KSamplerSelect", sampler_name=sampler)
    (sigmas,) = g.call("BasicScheduler", model=m, scheduler=scheduler, steps=int(steps), denoise=1.0)
    (guider,) = g.call("BasicGuider", model=m, conditioning=conditioning)
    out, _ = g.call("SamplerCustomAdvanced", noise=noise, guider=guider, sampler=samp, sigmas=sigmas, latent_image=latent)
    del noise, samp, sigmas, guider
    g.mm.soft_empty_cache(True)
    return (out,)


@node("H3 Decode", category="advanced",
      inputs=[inp("latent", "LATENT"), inp("audio", "BOOL", default=False)],
      outputs=[("video", "VIDEO")],
      description="Video VAE (+ optional audio VAE) -> 24 fps video object.")
def h3_decode(ctx, latent, audio):
    g = _g()
    (images,) = g.call("VAEDecode", samples=latent, vae=ctx.h3.vae)
    aud = None
    if audio:
        (aud,) = g.call("VAEDecodeAudio", samples=latent, vae=ctx.h3.audio_vae)
    (video,) = g.call("CreateVideo", images=images, fps=24.0, audio=aud)
    return (video,)


@node("Save Video", category="advanced",
      inputs=[inp("video", "VIDEO"), inp("name", "STRING", default="clip")],
      outputs=[],
      description="Writes an mp4 (no prompt metadata) and shows it on the node.")
def save_video(ctx, video, name):
    g = _g()
    safe = "".join(c for c in name if c.isalnum() or c in "-_") or "clip"
    fname = f"{safe}_{int(time.time())}_{ctx.run_id[:6]}.mp4"
    path = os.path.join(ctx.out_dir, fname)
    try:
        from comfy_api.latest import VideoContainer, VideoCodec
        video.save_to(path, format=VideoContainer.MP4, codec=VideoCodec.H264, metadata=None)
    except Exception:
        video.save_to(path)
    ctx.ui(node_output={"video": f"/video/{fname}"})
    return ()

# CozyClay first-run composite surface. Low-level nodes remain available for power users.
@node("Reference Image", category="input", inputs=[inp("image", "IMAGEFILE", default="preset_female_gray_34.png")], outputs=[("image", "IMAGE")])
def reference_image(ctx, image):
    return (_g().load_image(ctx.input_path(image)),)

@node("Scene", category="prompt", inputs=[inp("scene", "STRING", default="A person walks in and bows deeply toward the camera", multiline=True), inp("seconds", "FLOAT", default=5.0, min=2, max=15, step=1), inp("manual_prompt", "STRING", default="", multiline=True)], outputs=[("prompt", "STRING"), ("seconds", "FLOAT")])
def scene(ctx, scene, seconds, manual_prompt=""):
    text = manual_prompt.strip() if manual_prompt and manual_prompt.strip() else ctx.rewriter.rewrite(scene, float(seconds), None, None, None)
    ctx.ui(text=text)
    return text, float(seconds)

@node("Generate Video", category="generate", inputs=[inp("ref_image", "IMAGE", optional=True), inp("prompt", "STRING", multiline=True), inp("seconds", "FLOAT", default=5.0, min=2, max=15, step=1), inp("aspect", "COMBO", default="16:9", options=ASPECTS), inp("seed", "INT", default=42, min=0, max=2**32-1), inp("steps", "INT", default=4, min=1, max=25), inp("sla", "BOOL", default=True), inp("megapixels", "FLOAT", default=0.4, min=0.2, max=1.4, step=0.1), inp("audio", "BOOL", default=False)], outputs=[("video", "VIDEO")])
def generate_video(ctx, ref_image=None, prompt="", seconds=5.0, aspect="16:9", seed=42, steps=4, sla=True, megapixels=0.4, audio=False):
    cond, latent = h3_ref2va(ctx, prompt, seconds, megapixels, aspect, "match", ref_image_1=ref_image)
    (sampled,) = h3_sample(ctx, cond, latent, seed, steps, "res_multistep", "simple", sla, 0.9, 12.0)
    (video,) = h3_decode(ctx, sampled, audio)
    return (video,)

@node("Result", category="output", inputs=[inp("video", "VIDEO")], outputs=[])
def result(ctx, video):
    return save_video(ctx, video, "cozyclay")

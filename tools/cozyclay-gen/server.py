"""
cozyclay-gen / server.py
Tiny HTTP service around h3_gen.H3 (aiohttp, which ComfyUI already ships).

  GET  /health                      -> {"ok": true, "busy": false}
  POST /generate  (multipart/form)  -> {"job": id, "mp4": "/video/<name>", "seconds": ...}
        fields: prompt (str), seconds (float), megapixels (float), aspect (str),
                seed (int), steps (int), audio (0/1), mode (auto|ref|i2v)
        files:  ref (repeatable) | first, last
  GET  /video/<name>                -> mp4 bytes
  GET  /prompt-template?mode=ref    -> mocap prompt skeleton (from h3_prompts.py)

One generation at a time (asyncio.Lock); models stay resident.
Run:  python server.py --port 8288
"""
import os, sys, time, uuid, asyncio, argparse, logging, tempfile
from aiohttp import web

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import h3_gen  # noqa: E402  (boots ComfyUI headless)
import h3_prompts  # noqa: E402
import graph_nodes  # noqa: E402
import graph_exec  # noqa: E402
import rewriter as rewriter_mod  # noqa: E402

log = logging.getLogger("cozyclay-gen")
OUT_DIR = os.path.join(h3_gen.COMFY_DATA, "output", "cozyclay")
IN_DIR = os.path.join(h3_gen.COMFY_DATA, "input", "cozyclay")
os.makedirs(OUT_DIR, exist_ok=True)
os.makedirs(IN_DIR, exist_ok=True)
HERE = os.path.dirname(os.path.abspath(__file__))

_lock = asyncio.Lock()
_h3 = None
_exec = None
_rw = None
_runs = {}  # run_id -> {status, node, i, total, ui, error}


async def index(request):
    return web.FileResponse(os.path.join(HERE, "canvas.html"))


async def form_ui(request):
    return web.FileResponse(os.path.join(HERE, "ui.html"))


async def graph_ui(request):
    return web.FileResponse(os.path.join(HERE, "canvas.html"))


async def nodes(request):
    defs = graph_nodes.registry_json()
    if request.query.get("mode") != "advanced":
        defs = [d for d in defs if d["name"] in ("inputs", "scene", "result")]
    return web.json_response(defs)


async def upload(request):
    reader = await request.multipart()
    saved = []
    async for part in reader:
        if not part.filename:
            continue
        name = os.path.basename(part.filename).replace(" ", "_")
        path = os.path.join(IN_DIR, name)
        with open(path, "wb") as f:
            while True:
                chunk = await part.read_chunk()
                if not chunk:
                    break
                f.write(chunk)
        saved.append(name)
    return web.json_response({"files": saved})


async def input_file(request):
    name = os.path.basename(request.match_info["name"])
    for path in (os.path.join(IN_DIR, name), os.path.join(HERE, "presets", name)):
        if os.path.exists(path):
            return web.FileResponse(path)
    return web.json_response({"error": "not found"}, status=404)


async def preset_graph(request):
    return web.FileResponse(os.path.join(HERE, "presets", "mocap_ref2va.graph.json"))


async def list_inputs(request):
    files = sorted(f for f in os.listdir(IN_DIR) if not f.startswith("."))
    return web.json_response({"files": files})


async def run_graph(request):
    body = await request.json()
    graph = body.get("graph") or body
    run_id = uuid.uuid4().hex[:10]
    st = _runs[run_id] = {"status": "queued", "node": None, "i": 0, "total": len(graph), "ui": {}, "error": None, "t0": time.time()}

    def progress(nid, i, total, typ):
        st.update(status="running", node=nid, i=i, total=total, node_type=typ)

    def work():
        try:
            ui = _exec.run(graph, run_id, progress, None)
            st.update(status="done", ui=ui, wall=round(time.time() - st["t0"], 1))
        except Exception as e:
            log.exception("run %s failed", run_id)
            st.update(status="error", error=str(e), wall=round(time.time() - st["t0"], 1))

    asyncio.get_event_loop().run_in_executor(None, work)
    return web.json_response({"run": run_id})


async def rewrite(request):
    body = await request.json()
    scene = (body.get("scene") or "").strip()
    seconds = float(body.get("seconds", 15))
    if not scene:
        return web.json_response({"error": "scene required"}, status=400)
    llm = body.get("llm") or {}
    base_url = llm.get("base_url") or os.environ.get("COZYCLAY_LLM_BASE_URL")
    api_key = llm.get("api_key") or os.environ.get("COZYCLAY_LLM_API_KEY")
    model = llm.get("model") or os.environ.get("COZYCLAY_LLM_MODEL")
    if not (base_url and api_key and model):
        return web.json_response({"error": "프롬프트 변환 모델이 설정되지 않았습니다. 고급 설정에서 API 키와 모델을 넣거나 프롬프트를 직접 쓰세요"}, status=400)
    loop = asyncio.get_event_loop()
    t0 = time.time()
    try:
        text = await loop.run_in_executor(None, lambda: _rw.rewrite(scene, seconds, base_url, api_key, model))
    except Exception as e:
        log.exception("rewrite failed")
        return web.json_response({"error": str(e)}, status=500)
    return web.json_response({"prompt": text, "wall_seconds": round(time.time() - t0, 1)})


async def run_status(request):
    st = _runs.get(request.match_info["id"])
    if not st:
        return web.json_response({"error": "unknown run"}, status=404)
    return web.json_response({k: v for k, v in st.items() if k != "t0"})


async def health(request):
    return web.json_response({"ok": True, "busy": _lock.locked(), "models_loaded": _h3 is not None})


async def prompt_template(request):
    mode = request.query.get("mode", "ref")
    return web.Response(text=h3_prompts.template(mode), content_type="text/plain", charset="utf-8")


async def generate(request):
    reader = await request.multipart()
    fields, refs, first, last = {}, [], None, None
    tmpdir = tempfile.mkdtemp(prefix="ccgen_")
    async for part in reader:
        if part.filename:
            path = os.path.join(tmpdir, f"{part.name}_{len(refs)}_{part.filename}")
            with open(path, "wb") as f:
                while True:
                    chunk = await part.read_chunk()
                    if not chunk:
                        break
                    f.write(chunk)
            if part.name == "ref":
                refs.append(path)
            elif part.name == "first":
                first = path
            elif part.name == "last":
                last = path
        else:
            fields[part.name] = (await part.text())

    prompt = fields.get("prompt", "").strip()
    if not prompt:
        return web.json_response({"error": "prompt required"}, status=400)
    seconds = float(fields.get("seconds", 5))
    mp = float(fields.get("megapixels", 0.4))
    aspect = fields.get("aspect", "16:9")
    seed = int(fields.get("seed", 42))
    steps = int(fields.get("steps", 4))
    audio = fields.get("audio", "0") in ("1", "true", "yes")
    mode = fields.get("mode", "auto")
    if mode == "i2v":
        refs = []

    job = uuid.uuid4().hex[:10]
    out = os.path.join(OUT_DIR, f"{job}.mp4")
    async with _lock:
        t0 = time.time()
        loop = asyncio.get_event_loop()
        try:
            await loop.run_in_executor(None, lambda: _h3.generate(
                prompt, refs=refs or None, first_frame=first, last_frame=last,
                seconds=seconds, megapixels=mp, aspect=aspect, seed=seed, steps=steps,
                audio=audio, out_path=out))
        except Exception as e:
            log.exception("generate failed")
            return web.json_response({"error": str(e), "job": job}, status=500)
        wall = time.time() - t0
    return web.json_response({"job": job, "mp4": f"/video/{job}.mp4", "wall_seconds": round(wall, 1),
                              "seconds": seconds, "megapixels": mp, "aspect": aspect, "seed": seed, "steps": steps})


async def video(request):
    name = os.path.basename(request.match_info["name"])
    path = os.path.join(OUT_DIR, name)
    if not os.path.exists(path):
        return web.json_response({"error": "not found"}, status=404)
    return web.FileResponse(path)


def main():
    global _h3
    logging.basicConfig(level=logging.INFO, format="%(asctime)s %(name)s %(message)s")
    ap = argparse.ArgumentParser()
    ap.add_argument("--host", default="0.0.0.0")
    ap.add_argument("--port", type=int, default=8288)
    a = ap.parse_args()
    _h3 = h3_gen.H3()
    global _exec, _rw
    _rw = rewriter_mod.Rewriter()
    _exec = graph_exec.Executor(_h3, IN_DIR, OUT_DIR, rewriter=_rw)
    app = web.Application(client_max_size=256 * 1024 * 1024)
    app.add_routes([
        web.get("/", index),
        web.get("/form", form_ui),
        web.get("/graph", graph_ui),
        web.get("/nodes", nodes),
        web.post("/upload", upload),
        web.get("/inputs", list_inputs),
        web.get("/input/{name}", input_file),
        web.get("/preset", preset_graph),
        web.post("/run", run_graph),
        web.post("/rewrite", rewrite),
        web.get("/run/{id}", run_status),
        web.get("/health", health),
        web.get("/prompt-template", prompt_template),
        web.post("/generate", generate),
        web.get("/video/{name}", video),
    ])
    log.info("cozyclay-gen listening on %s:%d", a.host, a.port)
    web.run_app(app, host=a.host, port=a.port, print=None)


if __name__ == "__main__":
    main()

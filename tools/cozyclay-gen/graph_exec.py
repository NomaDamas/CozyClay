"""
cozyclay-gen / graph_exec.py
Executes a node graph (Comfy-style API JSON) against graph_nodes.NODES with per-node output caching.

Graph format:
    {"<id>": {"type": "H3 Sample", "inputs": {"seed": 42, "latent": ["<other id>", 1], ...}}, ...}
A list value [node_id, slot] is a link; anything else is a literal widget value.
"""
import os, json, time, hashlib, logging, threading, collections

import graph_nodes

log = logging.getLogger("cozyclay-gen.exec")


class Ctx:
    def __init__(self, h3, run_id, input_dir, out_dir, on_ui, rewriter=None):
        self.h3 = h3
        self.rewriter = rewriter
        self.run_id = run_id
        self.input_dir = input_dir
        self.out_dir = out_dir
        self._on_ui = on_ui
        self.node_id = None

    def input_path(self, name):
        base = os.path.basename(name)
        candidates = [name] if os.path.isabs(name) else [
            os.path.join(self.input_dir, base),
            os.path.join(os.path.dirname(os.path.abspath(__file__)), "presets", base),
        ]
        for p in candidates:
            if os.path.exists(p):
                return p
        raise FileNotFoundError(f"input image not found: {name}")

    def ui(self, **kw):
        self._on_ui(self.node_id, kw)


class Executor:
    def __init__(self, h3, input_dir, out_dir, cache_size=12, rewriter=None):
        self.h3 = h3
        self.rewriter = rewriter
        self.input_dir = input_dir
        self.out_dir = out_dir
        self.cache = collections.OrderedDict()
        self.cache_size = cache_size
        self.lock = threading.Lock()

    # -- cache key: node type + literal inputs + upstream keys (+ file mtime for images)
    def _key(self, graph, nid, keys):
        n = graph[nid]
        parts = [n["type"]]
        for name, v in sorted(n["inputs"].items()):
            if isinstance(v, list) and len(v) == 2 and str(v[0]) in graph:
                parts.append(f"{name}=<{keys[str(v[0])]}:{v[1]}>")
            else:
                s = json.dumps(v, sort_keys=True, default=str)
                if n["type"] == "Load Image" and name == "image":
                    try:
                        p = os.path.join(self.input_dir, os.path.basename(str(v)))
                        s += f"@{os.path.getmtime(p):.0f}"
                    except OSError:
                        pass
                parts.append(f"{name}={s}")
        return hashlib.sha1("|".join(parts).encode()).hexdigest()

    def _order(self, graph):
        seen, order = set(), []

        def visit(nid, stack=()):
            if nid in seen:
                return
            if nid in stack:
                raise ValueError(f"cycle at node {nid}")
            for v in graph[nid]["inputs"].values():
                if isinstance(v, list) and len(v) == 2 and str(v[0]) in graph:
                    visit(str(v[0]), stack + (nid,))
            seen.add(nid)
            order.append(nid)

        for nid in graph:
            visit(nid)
        return order

    def run(self, graph, run_id, progress, on_ui):
        graph = {str(k): {"type": v["type"], "inputs": dict(v.get("inputs", {}))} for k, v in graph.items()}
        for nid, n in graph.items():
            if n["type"] not in graph_nodes.NODES:
                raise ValueError(f"unknown node type {n['type']!r} (node {nid})")
        order = self._order(graph)
        outputs, keys, ui = {}, {}, {}
        ctx = Ctx(self.h3, run_id, self.input_dir, self.out_dir, lambda nid, kw: ui.setdefault(nid, {}).update(kw), rewriter=self.rewriter)
        total = len(order)
        with self.lock:
            for i, nid in enumerate(order):
                n = graph[nid]
                spec = graph_nodes.NODES[n["type"]]
                key = self._key(graph, nid, keys)
                keys[nid] = key
                is_output = len(spec["outputs"]) == 0
                progress(nid, i, total, n["type"])
                if key in self.cache and not is_output:
                    outputs[nid], cached_ui = self.cache[key]
                    if cached_ui:
                        ui[nid] = dict(cached_ui)
                    self.cache.move_to_end(key)
                    continue
                kw = {}
                for name, v in n["inputs"].items():
                    if isinstance(v, list) and len(v) == 2 and str(v[0]) in graph:
                        src, slot = str(v[0]), int(v[1])
                        kw[name] = outputs[src][slot]
                    else:
                        kw[name] = v
                # fill defaults for missing widgets
                for d in spec["inputs"]:
                    if d["name"] not in kw and "default" in d:
                        kw[d["name"]] = d["default"]
                ctx.node_id = nid
                t0 = time.time()
                res = spec["fn"](ctx, **kw)
                res = tuple(res) if isinstance(res, (list, tuple)) else (res,)
                log.info("node %s [%s] %.1fs", nid, n["type"], time.time() - t0)
                outputs[nid] = res
                if not is_output:
                    self.cache[key] = (res, dict(ui.get(nid, {})))
                    while len(self.cache) > self.cache_size:
                        self.cache.popitem(last=False)
        return ui

"""Quality-preserving preparation around the existing box-side GVHMR runner.

No model, dtype, batch size, flip test, tracker, camera or motion math changes.
Only two strictly checkpoint-loaded preprocessing models are cached on CPU.
The upstream/checkpoint files remain untouched; all patches are scoped.
"""
import contextlib
import gc
import importlib
import sys
import time
import weakref
from pathlib import Path

import torch


@contextlib.contextmanager
def checked_fast_load():
    """Skip only random initialization that a complete checkpoint overwrites.

    Audit live skipped tensors against tensors covered by load_state_dict.
    Constants/zeros and non-persistent buffers are not skipped. An incomplete
    checkpoint cannot leave uninitialized parameters silently in production.
    """
    saved = []
    skipped = []
    covered = []
    loads = []
    original_load = torch.load
    original_state_load = torch.nn.Module.load_state_dict

    def patch(owner, name, value):
        saved.append((owner, name, getattr(owner, name)))
        setattr(owner, name, value)

    def skip(tensor, *args, **kwargs):
        skipped.append(weakref.ref(tensor))
        return tensor

    def mmap_load(*args, **kwargs):
        if "mmap" in kwargs:
            return original_load(*args, **kwargs)
        try:
            return original_load(*args, **kwargs, mmap=True)
        except (RuntimeError, ValueError) as exc:
            # Old torch checkpoint serialization cannot be memory-mapped.
            if "mmap" not in str(exc).lower():
                raise
            return original_load(*args, **kwargs)

    def state_load(module, state, *args, **kwargs):
        result = original_state_load(module, state, *args, **kwargs)
        if result.missing_keys or result.unexpected_keys:
            raise RuntimeError("gvhmr-fast-load-incomplete-checkpoint")
        loads.append(module)
        covered.extend(weakref.ref(v) for v in module.state_dict(keep_vars=True).values())
        return result

    try:
        for name in ("uniform_", "normal_", "trunc_normal_", "kaiming_uniform_", "kaiming_normal_",
                     "xavier_uniform_", "xavier_normal_", "orthogonal_", "sparse_"):
            patch(torch.nn.init, name, skip)
        # timm's imported trunc_normal_ delegates to this module-global helper.
        for name in ("timm.layers.weight_init", "timm.models.layers.weight_init"):
            module = sys.modules.get(name)
            if module is not None and hasattr(module, "_trunc_normal_"):
                patch(module, "_trunc_normal_", skip)
        patch(torch, "load", mmap_load)
        patch(torch.nn.Module, "load_state_dict", state_load)
        yield
        live = [ref() for ref in skipped if ref() is not None]
        covered_storage = {ref().untyped_storage().data_ptr() for ref in covered if ref() is not None}
        if not loads or any(t.untyped_storage().data_ptr() not in covered_storage for t in live):
            raise RuntimeError("gvhmr-fast-load-uncovered-initialization")
    finally:
        for owner, name, value in reversed(saved):
            setattr(owner, name, value)


class FastRuntime:
    def __init__(self, runner, enabled=True):
        self.runner = runner
        self.enabled = enabled
        self.cache = {}
        self.signature = None
        self.stats = {}

    def invalidate_changed_weights(self):
        paths = [Path(self.runner.__file__), Path(".git/HEAD"),
                 Path("inputs/checkpoints/vitpose/vitpose-h-multi-coco.pth"),
                 Path("inputs/checkpoints/hmr2/epoch=10-step=25000.ckpt")]
        signature = tuple((str(p.resolve()), p.stat().st_size, p.stat().st_mtime_ns) for p in paths if p.exists())
        if self.signature is not None and signature != self.signature:
            self.cache.clear()
            gc.collect()
        self.signature = signature

    def release_gpu(self):
        for item, attribute in self.cache.values():
            getattr(item, attribute).cpu()
        gc.collect()
        torch.cuda.empty_cache()

    def acquire(self, name, factory, attribute):
        started = time.perf_counter()
        if name in self.cache:
            item = self.cache[name][0]
            getattr(item, attribute).cuda().eval()
            self.stats["modelCacheHits"].append(name)
        else:
            with checked_fast_load():
                item = factory()
            self.cache[name] = (item, attribute)
        self.stats["modelLoadSeconds"][name] = time.perf_counter() - started
        return item

    @contextlib.contextmanager
    def job(self, evidence=None):
        self.invalidate_changed_weights()
        self.stats = {"modelCacheHits": [], "modelLoadSeconds": {}, "decodeCropCalls": 0,
                      "sharedCropHits": 0, "decodeCropSeconds": 0, "mode": "exact-fast" if self.enabled else "reference"}
        runner = self.runner
        vp = importlib.import_module("hmr4d.utils.preproc.vitpose")
        vf = importlib.import_module("hmr4d.utils.preproc.vitfeat_extractor")
        original_crop, original_vp_crop = vf.get_batch, vp.get_batch
        original_preprocess, original_release = runner.preprocess, runner._release_gpu
        original_vit, original_hmr = runner.VitPoseExtractor, runner.Extractor
        crops = []

        def shared_crop(path, boxes, *args, **kwargs):
            for prior_path, prior_boxes, prior_args, prior_kwargs, output in crops:
                if str(path) == prior_path and args == prior_args and kwargs == prior_kwargs and torch.equal(boxes, prior_boxes):
                    self.stats["sharedCropHits"] += 1
                    # Both consumers read their input. Cloning prevents a future
                    # in-place consumer from contaminating the other model.
                    return tuple(v.clone() for v in output)
            started = time.perf_counter()
            output = original_crop(path, boxes, *args, **kwargs)
            self.stats["decodeCropCalls"] += 1
            self.stats["decodeCropSeconds"] += time.perf_counter() - started
            if self.enabled:
                crops.append((str(path), boxes.clone(), args, dict(kwargs), tuple(v.clone() for v in output)))
            return output

        def preprocess(*args, **kwargs):
            started = time.perf_counter()
            data = original_preprocess(*args, **kwargs)
            self.stats["preprocessSeconds"] = time.perf_counter() - started
            if evidence:
                torch.save(data, Path(evidence) / "preprocess.pt")
            crops.clear()
            return data

        try:
            vf.get_batch = vp.get_batch = shared_crop
            runner.preprocess = preprocess
            if self.enabled:
                runner.VitPoseExtractor = lambda: self.acquire("vitpose", original_vit, "pose")
                runner.Extractor = lambda: self.acquire("hmr2", original_hmr, "extractor")
                runner._release_gpu = self.release_gpu
            yield self.stats
        finally:
            runner.preprocess, runner._release_gpu = original_preprocess, original_release
            runner.VitPoseExtractor, runner.Extractor = original_vit, original_hmr
            vf.get_batch, vp.get_batch = original_crop, original_vp_crop
            crops.clear()
            self.release_gpu()

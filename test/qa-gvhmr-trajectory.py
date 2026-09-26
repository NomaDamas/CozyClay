"""GPU QA: cache an unchanged GVHMR prediction for trajectory A/B iteration.

Runs only when explicitly invoked, never as part of CPU CI. Inputs are an
existing preprocessing archive and its source video; no checkpoints change.
"""
import argparse
import json
import sys
from pathlib import Path

import hydra
import numpy as np
import torch

sys.path.insert(0, "/home/yun/cclay-ingest/GVHMR")
import cclay_gvhmr_extract as runner
from hmr4d.model.gvhmr.gvhmr_pl_demo import normalize_kp2d
from hmr4d.model.gvhmr.utils.postprocess import pp_static_joint_cam
from pytorch3d.transforms import axis_angle_to_matrix


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--preprocess", required=True)
    ap.add_argument("--video", required=True)
    ap.add_argument("--output", required=True)
    ap.add_argument("--export", action="store_true", help="Run the real exporter with the trajectory hook")
    args = ap.parse_args()
    out = Path(args.output)
    out.mkdir(parents=True, exist_ok=True)
    data = torch.load(args.preprocess, map_location="cpu")
    if args.export:
        from gvhmr_trajectory import trajectory_job
        runner.preprocess = lambda *a, **kw: data
        sys.argv = ["cclay_gvhmr_extract.py", args.video, str(out / "motion.npz"),
                    "--static-cam", "--out-root", str(out)]
        with trajectory_job(runner, args.video, out) as report:
            runner.main()
        print(json.dumps(report, indent=2))
        return
    cfg = runner.build_cfg(Path(args.video), True, None, out)
    model = hydra.utils.instantiate(cfg.model, _recursive_=False)
    model.load_pretrained_model(cfg.ckpt_path)
    model = model.eval().cuda()
    batch = {"length": data["length"][None],
             "obs": normalize_kp2d(data["kp2d"], data["bbx_xys"])[None],
             **{key: data[key][None] for key in ("bbx_xys", "K_fullimg", "cam_angvel", "f_imgseq")}}
    batch = {key: value.cuda() for key, value in batch.items()}
    with torch.no_grad():
        raw = model.pipeline.forward(batch, train=False, postproc=False, static_cam=True)
        baseline = pp_static_joint_cam(raw, model.pipeline.endecoder)
        world = model.pipeline.endecoder.fk_v2(**raw["pred_smpl_params_global"])
        camera = model.pipeline.endecoder.fk_v2(**raw["pred_smpl_params_incam"])
        rg = axis_angle_to_matrix(raw["pred_smpl_params_global"]["global_orient"][:, 0])
        rc = axis_angle_to_matrix(raw["pred_smpl_params_incam"]["global_orient"][:, 0])
        rotation = rg @ rc.mT
        camera_world = torch.einsum("bij,blkj->blki", rotation, camera)
        camera_world += (world[:, 0, 0] - camera_world[:, 0, 0])[:, None, None]
    raw_cpu = runner.detach_to_cpu(raw)
    torch.save({"raw": raw_cpu, "data": data, "baseline": baseline.cpu(),
                "world": world.cpu(), "camera_world": camera_world.cpu(),
                "fps": runner.video_fps(args.video)}, out / "cached.pt")
    arrays = {"world": world[0].cpu().tolist(), "cameraWorld": camera_world[0].cpu().tolist(),
              "baseline": baseline[0].cpu().tolist(), "kp2d": data["kp2d"].tolist(),
              "rawTransl": raw_cpu["pred_smpl_params_global"]["transl"][0].tolist(),
              "fps": runner.video_fps(args.video)}
    (out / "tracks.json").write_text(json.dumps(arrays))
    print(json.dumps({"frames": int(data["length"]), "fps": arrays["fps"], "output": str(out)}))


if __name__ == "__main__":
    main()

# Ground truth from MorphGS's own Animation.step: writes rot_params.npy + pred_joints.npy exactly like src/render.py:606-618.
# usage: python gen_truth.py <MorphGS-root> <mesh.obj> <rig.txt> <outdir>
import sys, os
morphgs_root, mesh_path, rig_path, out = sys.argv[1:5]
sys.path.insert(0, os.path.join(morphgs_root, "src"))
import numpy as np, torch, trimesh
from model.RigModel import Rig
from model.AnimationField import Animation, get_embedder

os.makedirs(out, exist_ok=True)
mesh = trimesh.load_mesh(mesh_path, process=False, maintain_order=True)
rig = Rig(mesh, rig_path, smooth_w=0, device="cpu", skinning_method="lbs")
N = rig.joints_name; J = len(N); ix = N.index
# Emulate MorphGS morphology (ParametricModel.get_joints_pos): legs +8%, arms -5%, same bone directions.
scale = {n: 1.08 for n in N if "Leg" in n or "Foot" in n or "Toe" in n}
scale.update({n: 0.95 for n in N if "Arm" in n or "Hand" in n})
joints = rig.joints_pos.clone()
for p, c in rig.bones:  # bones are BFS-ordered from the root, parents first
    joints[c] = joints[p] + (rig.joints_pos[c] - rig.joints_pos[p]) * scale.get(N[c], 1.0)
# Animation.__init__ hard-codes a CUDA deform net (AnimationField.py:83); step() with explicit rot_params never uses it.
anim = Animation.__new__(Animation)
anim.skinning_method, anim.embed_time_fn, anim.joint_num = "lbs", get_embedder(6, 1)[0], J
fixed = rig.fixed_joint_indices
torch.manual_seed(0)
frames = []
f1 = torch.zeros(J, 3)  # the lead's spec
f1[ix("LeftForeArm")] = torch.tensor([0, 0, np.pi / 2]); f1[ix("RightLeg")] = torch.tensor([np.pi / 3, 0, 0])
f1[ix("Hips")] = torch.tensor([0, np.pi / 6, 0])
frames += [(torch.zeros(J, 3), torch.zeros(3)), (f1, torch.tensor([0.3, 0.0, 0.2]))]
for _ in range(4):  # random full-body poses, every joint (fixed ones included -- step() must zero them)
    frames.append((torch.randn(J, 3) * 0.5, torch.randn(3) * 0.3))
rps, pj = [], []
for i, (rp, gt) in enumerate(frames):
    d = anim.step(rig.vertices, joints, rig.skinning_weights, rig, torch.tensor([i / len(frames)]),
                  rot_params=rp.clone(), global_translation=gt, fixed_joints=fixed)
    rps.append(d["rot_params"].numpy()); pj.append(d["joints_warped"].numpy())
np.save(f"{out}/rot_params.npy", np.stack(rps).astype(np.float32))
np.save(f"{out}/pred_joints.npy", np.stack(pj).astype(np.float32))
print(f"frames={len(frames)} J={J} fixed={[N[i] for i in fixed]} -> {out}")

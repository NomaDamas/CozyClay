# GVHMR extraction npz contract (box runner → CozyClay)

Written by `cclay_gvhmr_extract.py` (lives in the GVHMR checkout on the GPU
box, `~/cclay-ingest/GVHMR`), read by `tools/ardy/extract.mjs` when
`CCLAY_EXTRACT_BACKEND=gvhmr`.

All arrays float32 unless noted. World frame: metres, Y-up, gravity-aligned;
pelvis XZ of frame 0 at the origin, the clip's lowest body vertex at Y=0,
the body facing +Z at frame 0 (GVHMR's own "ayfz" normalisation).

| member              | shape        | meaning |
|---------------------|--------------|---------|
| `fps`               | int32 scalar | source video rate |
| `positions`         | [T, 22, 3]   | SMPL body joints 0..21 in the world frame (legacy; the positions lift reads this) |
| `contact`           | [T, 6]       | GVHMR static-contact logits (order as the model emits) |
| `smpl_joints`       | [T, 24, 3]   | SMPL joints 0..23 (22 body + L/R hand) in the world frame, from the neutral SMPL J-regressor |
| `smpl_global_orient`| [T, 3]       | axis-angle (rad) of the pelvis in the world frame |
| `smpl_body_pose`    | [T, 23, 3]   | axis-angle (rad) LOCAL rotation of SMPL joints 1..23 relative to their SMPL parent, standard SMPL kinematic tree |
| `smpl_transl`       | [T, 3]       | pelvis position in the world frame, i.e. equal to `smpl_joints[:, 0]` |
| `smpl_betas`        | [10]         | mean shape over the clip |
| `smpl_rest_joints`  | [24, 3]      | SMPL joints of the ZERO pose for `smpl_betas` (pelvis at origin): the source rest skeleton the rotations are relative to |

SMPL joint order (parents in brackets):
```
 0 pelvis(-)   1 L_hip(0)     2 R_hip(0)     3 spine1(0)
 4 L_knee(1)   5 R_knee(2)    6 spine2(3)    7 L_ankle(4)
 8 R_ankle(5)  9 spine3(6)   10 L_foot(7)   11 R_foot(8)
12 neck(9)    13 L_collar(9) 14 R_collar(9) 15 head(12)
16 L_shoulder(13) 17 R_shoulder(14) 18 L_elbow(16) 19 R_elbow(17)
20 L_wrist(18) 21 R_wrist(19) 22 L_hand(20) 23 R_hand(21)
```

Rotation convention: SMPL global rotation of joint j is
`G_j = G_parent(j) · R(body_pose[j-1])`, with `G_0 = R(global_orient)`, and
joint positions are `P_j = P_parent + G_parent · (rest_j - rest_parent)`.
The world frame's normalisation (heading, floor) has ALREADY been folded into
`global_orient`/`transl`, so FK from these arrays reproduces `smpl_joints`
exactly (up to float32). The SMPL zero pose is NOT a T-pose: the upper arm
rests ~11° below horizontal and the collar points ~58° up. Retarget visible
limb rest-pose differences, but keep the target rig's pelvis/spine/neck/head
bind shape. SMPL's J-regressor joints form an internal torso S-curve and put
the head joint forward inside the skull; aiming the target bones at those
positions visibly hunches an otherwise upright character.

## Repeatable QA loop

Convert the raw runner archive, gate the retarget math, then capture the same
sampled frames from the front and side on both shipped bodies:

```bash
node tools/ardy/gvhmr-to-cskel27.mjs /path/to/gvhmr.npz public/demo/qa-gvhmr.npz
# For takes extracted from CozyClay-rendered clips, use --bone-scale 1.
node --test test/smpl-cskel27.test.mjs

# Keep `npm run dev:ui -- --host 127.0.0.1 --port 5180` running separately.
for model in x-bot-tpose y-bot-tpose; do
  for view in front side; do
    QA_URL='http://127.0.0.1:5180/app/?motion=/demo/qa-gvhmr.npz' \
      MODEL="$model" VIEW="$view" FRAMES=0,60,120,180,240,300 \
      OUT="/tmp/gvhmr-qa/$model" npm run qa:browser -- node test/qa-screenshot-browser.mjs
  done
done
```

Review the captures against video frames at the same timestamps. Do not accept
a take unless the test passes, upright samples retain the character's bind
torso/neck silhouette, performed bends remain present, and neither body shows
detached joints. Remove the temporary `public/demo/qa-gvhmr.npz` afterwards.

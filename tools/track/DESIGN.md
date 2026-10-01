# Model-based monocular tracker for cskel27

## Implemented v1 contract (takes precedence over the historical proposal below)

The mocap-rearch execution plan intentionally supersedes the proposal's renderer,
learned prior, optical flow, mask re-prompting, and LBFGS suggestions. V1 uses
only robust joint reprojection, exterior signed-DT surface sampling plus a
foreground coverage Chamfer, ray/OBB visibility, acceleration, rest-relative
angle caps, stance skate, and mesh/floor/box non-penetration. It never loads
reference motion or reference image assets. The original proposal is preserved
below for provenance, not as authorization for its deferred features.

`track.py` consumes the seven files declared by `remote.mjs`. Calibration and
optional endpoint poses travel inside `camera.json` as
`tracker: {deltaPx, cameraFixed, endpoints: {a?, b?}}`. Each endpoint contains
`rotMats` (27x3x3 or 243 flat local rotation values) and `rootPos` (3 floats),
already in the initializer's coordinate frame. Defaults are the measured Gate-0
5.708 px and fixed camera. When fixed, **all** nuisance values are frozen
(scale 1, yaw/pitch/focal deltas zero). Otherwise their bounds and Gaussian
priors are those in todo 10. No root anchoring is added or removed.

Gate-2 round 1 keeps 150 root-only Adam steps at 0.01 and 300 full steps at
0.005, then uses 200 full steps at 0.001 with triple penetration weight.
Silhouette weight remains 6.0 and keypoint weight 1. Reducing pose/refine
silhouette to 1.25 failed seed-102 synthetic acceptance even without the added
temporal term (21.65 mm root error), while the controlled 6.0 candidate
recovered 17.40 mm. The round therefore retains depth support and uses the
bounded initializer prior below to discourage unsupported articulation.

A bounded G5 trust-region prior is off during root initialization, weighted
0.1 during pose, and linearly annealed from 0.1 to zero during refine. The
squared root-path deviation is centred within each optimization window (free
rigid placement correction), normalized by 25 cm, and bounded as d2/(1+d2).
Rotation uses squared chord distance normalized to a 30-degree rotation, with
the same bound. Root-path weight is 2; root-rotation weight is 2; shoulder,
upper-arm, forearm and hand rotation weights are 4; other joints are 1.
Only the supplied initializer is used, never truth or a learned prior.

The existing 0.05 whole-body acceleration term remains unchanged. An added
0.075 proximal acceleration term was rejected after a controlled synthetic
comparison isolated a depth bias: removing only that term reduced seed-102
root error from 21.34 to 17.40 mm; removing trust or restoring the old learning
rate did not fix it. Interim silhouette increases and translation-only polish
were also discarded. No acceptance threshold was changed.
Assignments and stance are re-estimated at block boundaries. Clips through 240
frames are whole batches; longer clips use 120-frame windows with 16-frame
linear overlaps. Each coverage query participates; 64-query nearest-neighbour
tiles bound memory instead of dropping a loss. Surface samples are fixed
area-stratified barycentric samples of the decimated Studio mesh.

Signed DT values are clamped at zero for *interior* samples: pushing every
surface sample to a silhouette boundary would hollow out the body. The reverse
foreground Chamfer supplies coverage. Rejection IoU is a named half-resolution
point-splat occupancy estimate (`sampleMaskIoUMean`), not a rasterizer or the
independent benchmark score. Benchmark scoring remains the quality authority.

Keypoint confidence is sanitized at the input boundary, not rejected: ViTPose
confidence is the raw flip-averaged heatmap peak of a height-1 Gaussian
regression (GVHMR `VitPoseExtractor` -> mmpose `keypoints_from_heatmaps`
`maxvals`), not a probability, and overshoots 1 (up to 1.0385 on the Gate-2 r0
obs cache). Non-finite confidence becomes 0, then values are clipped to [0,1].
The counts are reported as `stageLosses` entries `input.confidenceNonFinite`,
`input.confidenceAboveOne` and `input.confidenceBelowZero`. Keypoint
coordinates, the kp2d shape and every other input remain strictly validated
(exit 2).

`--track-ablate` selects cumulative fit components for the Gate-2 ablation
table; weights and schedule are identical at every level, and keypoints plus
priors (acceleration, limits, endpoints, nuisance) are always on:

| level | adds |
|---|---|
| `kp-only` | keypoint reprojection with detector left/right labels as given |
| `silhouette` | signed-DT boundary + coverage Chamfer |
| `viterbi` | latent L/R Viterbi assignment |
| `contacts` | stance skate + floor/box penetration |
| `full` (default) | ray/box occlusion of keypoints and surface samples in the fit |

Disabled terms are not evaluated and are absent from `stageLosses`; the level
is recorded as `stageLosses["ablation.<level>"] = 1`. Diagnostics (occlusion
flags, stance, penetration, sample IoU, visible keypoint residual) and the
rejection rules are computed identically at every level, so an ablated fit is
rejected by the same policy as the full one. Without Viterbi, `lrState` is
`identity` with zero margin and not ambiguous. obs-bench forwards
`--track-ablate <level>` through `runTracker({ablate})`.

Exit 3 returns diagnostics and no motion for no evidence, non-finite fits,
resource exhaustion, excessive visible reprojection error or mask mismatch.
Exit 2 is malformed input. A zero-iteration request preserves every initializer
motion member exactly (fps comes from obs) and bypasses fitted-residual rejection;
it exists to test the coordinate/output contract, not claim a successful fit.

---

## Design decision

Use the current GVHMR result only as an initializer and proposal for image evidence. Fit a single physically constrained trajectory for the known cskel27 character over the entire clip, using the known camera, mesh, floor, and boxes in the objective. The optimizer should be implemented in PyTorch/CUDA with a differentiable rasterizer and should alternate continuous optimization with two small discrete dynamic programs:

1. a Viterbi pass for latent left/right keypoint assignments; and
2. a stance/contact pass for each foot.

This directly addresses the observed failures: ViTPose left/right swaps causing 97-178 degree yaw flips, box-occluded legs producing wrong depth, and root-only corrections causing foot skate (`context.md`, lines 16-17). It does not use palette or color cues; the palette approach is explicitly abandoned (`context.md`, lines 19-21).

The fit should retain per-frame uncertainty and a failure flag. It must not turn an unobserved body part behind a box into a high-confidence measurement.

## 1. State and parametrization

Let frames be `t = 0..T-1`, with image size `W x H`, known camera intrinsics `K`, and fixed world-to-camera extrinsics `(R_cw, t_cw)`. Use the Studio/world coordinate system for all scene constraints.

For every frame optimize

```
q_t = (x_t, a_t, u_{t,0}, ..., u_{t,J-1})
```

where:

- `x_t in R^3` is the root/pelvis translation in world coordinates;
- `a_t in R^6` is the root rotation's continuous 6D representation;
- `u_{t,j} in R^6` is the local rotation representation for joint `j`.

For a 6D vector `a = [a1,a2]`, convert to a rotation matrix by

```
b1 = normalize(a1)
b2 = normalize(a2 - b1 * dot(b1,a2))
b3 = cross(b1,b2)
R6D(a) = [b1 b2 b3]
```

with columns `b1,b2,b3`. In code, normalize with a small fixed epsilon only for numerical stability; do not use a second, unconstrained rotation representation in the state.

Use root rotation `R_t = R6D(a_t)`. For each joint, either optimize a local delta from the rig rest pose,

```
R_{t,j}^{local} = R^{rest}_j R6D(u_{t,j}),
```

or, if the existing cskel27 convention already defines zero as the rest pose, use `R6D(u_{t,j})` directly. Pick one convention and test it on a rest-pose identity case. The preferred interface is a local delta because joint-limit ranges are then stable across clips.

Forward kinematics gives every joint and bone transform:

```
G_{t,root} = [R_t, x_t]
G_{t,j}    = G_{t,parent(j)} [R_{t,j}^{local}, l_j]
X_{t,j}    = translation(G_{t,j}),
```

where `l_j` is the known rest offset. The skinned mesh is

```
V_t(v) = sum_k w_{v,k} (G_{t,k} G^{-1}_{rest,k}) V_rest(v),
```

using the existing known weights and mesh. Do not infer scale. The known body size and camera remove the scale ambiguity that currently remains in a generic regressor (`context.md`, lines 3-5 and 9).

The optimizer's primary variables can be packed as `[x, a, u]` in float32. Use a separate float32 latent velocity/contact state only if needed; do not optimize camera, bone lengths, or mesh shape.

### Projection and visibility interface

For any world point `X`,

```
Xc = R_cw X + t_cw
pi(X) = (K Xc)_{xy} / (K Xc)_z.
```

Reject points with `Xc.z <= 0`. The renderer receives `V_t`, the known box meshes, the floor, `K`, and extrinsics, and returns:

- soft character silhouette `S_t^q(u) in [0,1]`;
- character depth `Z_t^q(u)`;
- scene-occluded character silhouette `S_t^{q,visible}`;
- per-vertex/per-joint visibility `v_{t,i}`;
- optionally a differentiable triangle ID or barycentric map.

The scene-aware visibility output is important: a leg behind a known box should be excluded from image evidence, not forced to the front of the box.

## 2. Data terms

### 2.1 Keypoint reprojection

Let the 2D detector provide candidates `y_{t,k} in R^2`, confidence `c_{t,k} in [0,1]`, and detector covariance `Sigma_{t,k}` where available. Do not assume the detector's L/R labels are correct. For anatomical joint `i`, let `p_{t,i}(q) = pi(X_{t,i}(q))`.

For a fixed assignment `h_t` of detector labels to anatomical labels, use a confidence-weighted robust Mahalanobis residual:

```
r^kp_{t,i}(q,h_t) =
  sqrt(c_{t,h_t(i)} * v_{t,i}) *
  rho_delta( || L_{t,h_t(i)} (p_{t,i}(q)-y_{t,h_t(i)}) ||_2 ),
```

where `L L^T = Sigma^{-1}`; use an isotropic detector scale when covariance is unavailable. `rho_delta` is Huber or Geman-McClure. Huber is easier to optimize:

```
rho_delta(r) = 0.5 r^2                         if r <= delta
               delta*(r - 0.5*delta)            otherwise.
```

Set `v_{t,i}` to zero or a small floor when the renderer says the joint is behind a box. A detector confidence alone must not revive an occluded observation.

Include a pelvis/root observation only if its detector confidence is valid. The known camera and mesh mean that a stable silhouette and known bone lengths can constrain depth even when a particular 2D joint is absent.

### 2.2 Latent L/R assignment without color

Use a small permitted permutation set `H`. At minimum it contains identity and a global L/R exchange. For robustness to independent arm/leg swaps, use the product of pairwise swaps for the bilateral groups `{shoulder, elbow, wrist}`, `{hip, knee, ankle}`, and any available foot/toe groups, yielding at most `2^B` states. Do not allow arbitrary permutations: they would explain detector noise by anatomically nonsensical relabeling.

At the current continuous trajectory `q`, define the emission cost for state `h`:

```
D_t(h) = sum_i c_{t,h(i)} v_{t,i}
         rho_delta( ||p_{t,i}(q)-y_{t,h(i)}|| / s_i )
       + lambda_h * complexity(h).
```

Here `s_i` is a pixel scale proportional to torso height, making the cost resolution-independent. Define an assignment-aware transition cost using expected image motion and a switch penalty:

```
T_t(h',h) = lambda_switch * Hamming(h',h)
  + lambda_cont * sum_i w_i rho_delta(
      || (y_{t,h(i)} - y_{t-1,h'(i)})
       - (p_{t,i}(q)-p_{t-1,i}(q)) || / s_i ).
```

The Viterbi recurrence is

```
C_0(h) = D_0(h)
C_t(h) = D_t(h) + min_{h'} [C_{t-1}(h') + T_t(h',h)].
```

Store backpointers and recover `h_0:T-1`. Run this after each few continuous optimization epochs, not once permanently at initialization. Freeze the selected path for the next continuous block. Add hysteresis: only change a frame's assignment if the new Viterbi path improves the normalized cost by a margin, for example `0.1` robust residual units per active bilateral joint. This prevents assignment chatter.

This is a temporal inference problem, not a color-classification problem. The transition term makes a one-frame swap expensive while still allowing a sustained true relabeling. Report the Viterbi margin between the best and second-best path as an ambiguity diagnostic.

### 2.3 Silhouette/mask term

Use SAM2's video predictor as the primary segmenter, initialized in the first frame with a person box/positive points from the projected GVHMR mesh and negative points outside it. Propagate the mask through the clip, then optionally correct selected frames with the current rendered silhouette as a new prompt. SAM2 is preferable to independent per-frame segmentation because the camera is fixed and temporal consistency matters; it also avoids relying on the mannequin's gray color.

Store the SAM2 mask probability/logit, not just a hard binary mask. Remove obvious background/box pixels using the known scene render where possible. Let `M_t(u) in [0,1]` be the observed character mask probability and `S_t^{q,visible}(u)` the differentiably rendered visible character mask.

Use both a region and boundary term:

```
E_mask(t) = lambda_bce * mean_u BCE(S_t^{q,visible}(u), M_t(u))
          + lambda_dtm * mean_{u in band(M_t)}
              rho_delta( |DT(M_t)(u) - DT(S_t^{q,visible})(u)| / tau )
          + lambda_area * rho_delta(area(S_t^{q,visible})/area(M_t)-1).
```

In practice, calculate signed distance transforms from detached masks for the boundary term, or use a soft rasterizer plus a narrow-band Chamfer loss. Downweight pixels that the known boxes hide and pixels with low SAM2 confidence. Use an image pyramid so coarse silhouette alignment moves the root/depth before fine boundary optimization.

A single global mask term is not enough to recover articulation, but it is especially valuable for the current box-occlusion cases where keypoints disappear.

### 2.4 Optional dense motion term

Add dense optical flow only when its confidence and forward/backward consistency are good. Use RAFT or GMFlow on consecutive frames. For a visible mesh sample `v` at time `t`, with projected coordinate `u_{t,v}`, define

```
E_flow = sum_{t,v} w_flow(t,v) rho_delta(
    || [u_{t+1,v}(q)-u_{t,v}(q)] - F_t(u_{t,v}(q)) || / s_flow
).
```

Reject samples near occlusion boundaries, with invalid depth ordering, or with inconsistent forward/backward flow. Compare the rendered point only to flow in the foreground region. The weight should be substantially lower than keypoints and silhouette because generated video can violate brightness constancy and a textureless clay mesh offers weak correspondences. A feature correspondence variant can use DINOv2/LoFTR descriptors, but it must be optional: on a faceless, nearly uniform mannequin, learned feature matches can be less reliable than the silhouette.

The complete data term is

```
E_data = E_kp + E_mask + E_flow.
```

Normalize each term by the number of valid observations so a long visible torso does not overwhelm all joints.

## 3. Prior terms

### 3.1 Temporal acceleration

For root translation use second differences in world space:

```
E_acc_root = sum_{t=1}^{T-2} rho(||x_{t+1} - 2*x_t + x_{t-1}|| / s_x).
```

For each joint use the Lie-algebra relative rotation

```
omega_{t,j} = log( R_{t,j}^{local} ) in R^3
```

and penalize angular acceleration using relative increments rather than subtracting matrices:

```
delta_{t,j} = log( R_{t,j}^{local}(t-1)^T R_{t,j}^{local}(t) )
E_acc_rot = sum_{t,j} rho(||delta_{t+1,j}-delta_{t,j}|| / s_theta).
```

Also add a lower-weight first-difference term only for detector dropout or severe ambiguity. A first-difference penalty everywhere would reproduce the current over-smoothed result; the current bench already reports limb acceleration below truth (`context.md`, lines 13-15). Robust acceleration is preferable to a large quadratic smoothness weight so a genuine bump is retained.

### 3.2 Learned motion prior

Use a weak prior trained or selected on retargeted cskel27/AMASS-like motion, not a prior that changes the rig geometry. Two viable interfaces:

- **VAE/VPoser-like:** `z_t` is a latent pose code, `theta_t = D(z_t)`, with `E_latent = sum ||z_t||^2` and a temporal latent acceleration term. The decoder must output the local joint rotations used by FK.
- **Sequence prior:** a causal/bidirectional transformer or diffusion score supplies `-log p(theta_{0:T-1})`, evaluated on windows and summed with overlap.

The first is simpler and deterministic for an optimizer. Use the prior as a soft preference, not a hard decoder constraint, because the video may contain generated or unusual motion. Gate it down when the mask/keypoint residual is high; otherwise the prior can hallucinate a plausible action that is not the observed one.

### 3.3 Joint limits

For each joint define limits in the local rest-relative frame. For a hinge, penalize angle outside `[lo, hi]`; for a ball joint, use a swing cone and twist interval. A differentiable soft barrier is

```
B(z; lo,hi) = softplus((lo-z)/tau)^2 + softplus((z-hi)/tau)^2.
```

For a swing-twist decomposition `R = R_swing R_twist`, use a cone barrier on swing angle and `B(twist; lo,hi)`. Apply a large final barrier or projection in the last optimization stage. Joint limits are a guardrail, not a substitute for data; over-tight limits are a likely source of failure for stylized motion.

## 4. Scene terms

### 4.1 Floor and stance detection

Represent the known floor as `n^T X + d = 0`, with `n` pointing upward. Define a sole contact point or a small set of sole vertices `F_{t,k}` for each foot. Do not use the ankle location as the contact point; use the skinned mesh's bottom sole geometry.

First compute a contact likelihood from the current trajectory:

```
score_{t,f} = sigmoid(a0
  - a1 * height(F_{t,f})
  - a2 * ||F_{t,f}-F_{t-1,f}||
  - a3 * image-foot-speed
  + a4 * visible-foot-confidence).
```

Then run a two-state HMM/Viterbi pass per foot with states `contact` and `swing`, transition penalties that discourage one-frame toggles, and a minimum stance duration. This is more stable than thresholding each frame independently. The contact state remains latent and can be updated every outer iteration.

For contact frames, maintain an anchor `A_{s,f}` per contiguous stance segment and use

```
E_floor_contact = sum_{t,f} c_{t,f} ||F_{t,f}-A_{seg(t,f),f}||^2 / s_F^2
              + lambda_height * c_{t,f} (n^T F_{t,f}+d)^2 / s_h^2.
```

For every sole vertex, prevent floor penetration:

```
E_floor_pen = sum_{t,v in sole} softplus(-(n^T V_t(v)+d-margin)/tau)^2.
```

Use contact anchoring to correct the root and leg chain together. Root-only translation correction is exactly the mechanism that leaves foot skate in the current pipeline (`context.md`, lines 16-17).

### 4.2 Box non-penetration and occlusion

For every body vertex `V_t(v)` and every solid box `b`, compute signed distance `sdf_b(V_t(v))`, positive outside the box. With a safety margin `m`, use

```
E_box_pen = sum_{t,v,b} softplus((m - sdf_b(V_t(v)))/tau)^2.
```

Sample all vertices for a low-resolution pass and collision-prone vertices/bone capsules for a high-resolution pass. If the solver supports constrained Gauss-Newton, impose `sdf_b(V_t(v)) >= m` as an inequality and solve with an augmented Lagrangian. Otherwise use the barrier above plus a final projection/repair pass. A box surface may be a valid hand or foot contact; non-penetration does not prohibit contact, it only prohibits the body entering the solid volume.

Render the boxes with depth before the character. For a character surface behind a box, use the visible render in `E_mask`, set corresponding keypoint visibility low, and rely on the motion prior, bone lengths, other visible joints, and contact constraints. Do not pull an occluded knee through the box merely to match an unreliable 2D detector.

An optional soft scene-contact term can attract a hand/foot to a box face only when image evidence supports it:

```
E_box_contact = c_{t,hand} * robust(sdf_box(hand_point), 0)
```

with a tangential velocity anchor during sustained contact. It must never reward penetration.

### 4.3 Foot skate metric and penalty

For each inferred stance segment, penalize both translational and yaw/tangential sole motion. The position anchor above is the main term; additionally use

```
E_skate = sum_{t,f} c_{t,f} ||P_t F_{t,f} - P_{t-1} F_{t-1,f}||^2,
```

where `P_t` projects to the floor tangent plane. Use a robust penalty and turn it down at contact transitions. Keep a small image-data floor so a truly sliding foot is not frozen.

The complete prior/scene term is

```
E_prior = E_acc_root + E_acc_rot + E_motion_prior + E_limits
        + E_floor_contact + E_floor_pen + E_box_pen + E_skate.
```

## 5. Full objective and occlusion policy

For fixed assignment path `h` and contact states `c`, optimize

```
E(q;h,c) = E_data(q;h)
         + E_prior(q;c)
         + E_init(q)
         + E_boundary(q).
```

`E_init` is a robust, decaying tether to GVHMR for the first optimization block only:

```
E_init = alpha_init * sum_t ||x_t-x_t^gv||_rho^2
       + alpha_init * sum_{t,j} d_SO3(R_{t,j},R^gv_{t,j})_rho^2.
```

Decay `alpha_init` to zero; otherwise a bad GVHMR yaw/depth solution remains locked in. `E_boundary` is a weak prior on the first/last frame or known endpoint pose where the benchmark supplies one; do not use it on clips without endpoint evidence.

Occlusion policy is explicit:

1. derive visibility by depth-buffering the known scene and current character;
2. multiply keypoint and dense terms by visibility/confidence;
3. compare silhouettes only in visible regions or with the scene-occluded render;
4. increase temporal/prior/contact weight for hidden joints; and
5. expose uncertainty/low-confidence flags for hidden segments.

A box-hidden leg is therefore inferred from the articulated state and constraints, not falsely observed from a keypoint behind the box.

## 6. Solver and expected runtime

Use block-coordinate optimization over the whole clip:

1. Run GVHMR and obtain `q^gv`, 2D keypoints, and initial confidence.
2. Run SAM2 video segmentation and cache masks/confidences.
3. Initialize depth/root with the known camera and bone scale; use the current GVHMR pose only as a starting point.
4. Render visibility, estimate contacts, and run Viterbi for L/R assignments.
5. Optimize all `q_0:T-1` jointly with Adam for 100-300 iterations, using coarse-to-fine masks and gradually increasing collision/contact weights.
6. Run Viterbi assignment and contact HMM again.
7. Refine with LBFGS (or damped Gauss-Newton/Levenberg-Marquardt) for 20-80 iterations with fixed assignments/contacts, then do one or two outer reassignment passes.
8. Run a final collision/contact projection and calculate diagnostics.

Adam is forgiving when masks and assignments are changing. LBFGS or Gauss-Newton is better for the final coupled reprojection/contact fit. A pure per-frame optimizer is not acceptable: it cannot resolve a swap or an occluded leg using future and past frames.

Use temporal windows only for memory if necessary, with 10-20 frame overlap and state/velocity continuity constraints at boundaries. The preferred benchmark implementation is a full 120-240-frame batch because that is the requested behavior and because the clip is short enough for a 27-joint state.

Engineering estimate on a modern CUDA GPU, with 27 joints, a 10k-30k-vertex mesh, 512-ish mask resolution, and cached observations:

- 120 frames: roughly 30-120 seconds for keypoints + silhouette + collision, or 1-3 minutes if dense flow and high-resolution mesh rendering are enabled;
- 240 frames: roughly 1-4 minutes, or 3-8 minutes with dense flow/high-resolution collision.

These are planning estimates, not measured facts in the supplied context; benchmark them with a fixed seed and report wall-clock, GPU memory, and iteration count before adopting a production SLA. If differentiable full-mesh rendering is too slow, use a decimated mesh for optimization and the full mesh for the final collision/IoU pass.

## 7. Automatic failure detection

Emit per-frame and per-clip diagnostics rather than a single score.

- **L/R ambiguity:** Viterbi best-vs-second-best margin small, frequent assignment switches, or two paths with similar data cost. Flag the affected bilateral groups and retain both candidate trajectories if the margin is below threshold.
- **Yaw flip / temporal discontinuity:** `angle(log(R_root(t-1)^T R_root(t)))` or pelvis image velocity exceeds calibrated limits; robust acceleration residual is an outlier. A high reprojection residual plus a large root jump indicates a bad local minimum rather than real motion.
- **Occlusion uncertainty:** low scene visibility, low SAM2 confidence, or a keypoint behind a box. Report low confidence and ensure the hidden-joint solution is prior/contact dominated.
- **Mask failure:** rendered-vs-observed area ratio outside a wide range, low boundary agreement, mask components not connected to the projected character, or sudden mask area/centroid jumps. Re-run SAM2 prompting on flagged frames or reduce mask weight; do not force the pose to fit a bad mask.
- **Box collision:** maximum and mean negative SDF, number of penetrating vertices, and penetration duration. Any persistent penetration above the benchmark tolerance is a hard failure even if IoU is good.
- **Floor/contact failure:** sole below floor, contact height residual, contact anchor residual, or foot tangent speed while in stance. Distinguish a bad contact label from a bad pose by re-running the contact HMM with collision fixed.
- **Foot skate:** stance-segment tangent speed and total drift in centimeters. Flag only sustained drift, not a contact transition.
- **Model mismatch:** structured residuals along the silhouette, high mask IoU failure despite low keypoint residual, or persistent joint-specific reprojection residual after assignment optimization. This means the known mesh/rig or segmentation is wrong, not that more smoothing is needed.
- **Over-smoothing:** acceleration energy far below the ground-truth distribution on the truth bench while data residual is not improving. The current run already shows limb acceleration below truth (`context.md`, lines 13-15), so this must be a tracked regression.
- **Global drift:** root trajectory changes substantially while image residual remains flat. Compare known floor/box relationships and the fixed-camera projection; on truth clips use root ATE as the definitive detector.

A clip is `accepted` only if collision, floor, assignment ambiguity, and mask/data residual thresholds pass. Otherwise export the best trajectory plus a machine-readable failure report and confidence intervals/flags.

## 8. Measurement on the existing bench

Run the same 35 approved items and preserve the existing G0-G5/Gbest baselines (`context.md`, lines 9-11). Add the tracker as a new rung, not as a replacement that obscures regressions.

### Ground-truth clips (8 gt renders plus known cube cases)

For each frame and the 17-joint comparison subset:

1. **PA-MPJPE:** compute per-frame rigid Procrustes-aligned MPJPE in millimeters. This measures articulation independent of global translation/orientation.
2. **Root ATE:** compare world root/pelvis positions with only the permitted initial alignment (not per-frame Procrustes); report RMSE, median, and 95th percentile in centimeters. Do not hide global drift with per-frame alignment.
3. **Root rotation error:** geodesic SO(3) angle, median and 95th percentile.
4. **2D reprojection error:** pixel RMSE/robust percentile on visible joints, with and without the latent assignment correction.
5. **Silhouette IoU:** render the visible character with the known boxes and compare to the ground-truth character mask; report per-frame median, mean, and the fraction below the acceptance threshold.
6. **Foot slide:** tangent-plane centimeters/second during ground-truth stance frames; use the truth contact labels for the primary metric and inferred contacts for the deployable metric.
7. **Penetration:** maximum and mean body/box and sole/floor penetration in centimeters, plus violating-frame fraction.
8. **Dynamics:** root/limb acceleration error and jerk, because the current baseline is over-smoothed.
9. **Endpoint error:** pelvis and end-effector errors at the benchmark's A/B endpoints.
10. **Runtime and memory:** wall-clock per 120/240 frames and peak GPU memory.

The primary go/no-go table should include PA-MPJPE, root ATE, IoU, foot slide, and penetration, exactly matching the requested bench. The latest reference values are roughly 64 mm PA-MPJPE, 29 cm root ATE, 0.585 gt IoU, and 3.6 cm/s foot slide for Gbest; the new method must beat these on a held-out aggregate without trading them for unacceptable penetration or over-smoothing (`context.md`, lines 13-15).

### Fal-generated clips without truth

Use the existing proxy measures: 2D mask IoU, contact gap, penetration, and endpoint error A/B. Add assignment ambiguity, visibility-aware residuals, root jump count, and failure flags. The current fal reference is IoU 0.307, mean penetration 1.4 cm, pelvis jumps over 20 degrees/frame in 10 frames, and endpoint B 12 cm (`context.md`, lines 14-17). Do not call proxy improvement proof of 3D truth improvement; use the gt renders for that claim.

Use paired per-clip comparisons with fixed observations and report bootstrap confidence intervals across clips. Ablate at least:

- GVHMR only;
- + known camera/scale;
- + silhouette;
- + latent L/R Viterbi;
- + floor/contact;
- + box occlusion/collision;
- + learned prior;
- full model.

This identifies whether the claimed improvement comes from the structurally important terms rather than arbitrary smoothing. Also report the fraction of frames rejected by automatic diagnostics.

## Honest comparison with a stronger regressor

This approach should beat a stronger regressor when the available facts are reliable and unusual: fixed calibrated camera, known body shape/lengths, known floor/boxes, long temporal context, and explicit contact/collision. It can resolve metric depth/scale, maintain one side assignment over time, keep a foot planted, and place an occluded limb on the physically valid side of a box. Those are precisely the information sources a generic framewise regressor does not enforce.

It will not automatically beat a stronger regressor on every frame. A modern video regressor may have a better learned image prior, better segmentation/features, and better hallucination of a fully hidden pose. Optimization can settle in a wrong local minimum if the mask is bad, the known camera/mesh is wrong, or the motion lies outside its prior. Dense flow is also weak on a uniform gray mannequin. The model-based fit cannot recover information that is absent and unconstrained; it only prevents physically impossible explanations.

Recommendation: do not replace GVHMR with a new regressor first. Keep it as initialization, implement the model-based batch refinement and diagnostics, and compare against any stronger video regressor under the same known-camera/scene benchmark. If the full fit still fails on visible gt clips, inspect residuals before buying a larger model: persistent structured residuals indicate mesh/camera/segmenter mismatch, while low-data/high-prior failures indicate that the learned motion prior or initializer needs improvement. Retraining a body-pose network remains an explicit later option, not a prerequisite for this design (`context.md`, lines 19-21).

## Open assumptions to settle by measurement

1. Whether SAM2's masks are stable enough on this specific faceless gray render; settle with mask precision/recall on the 8 gt renders and box clips.
2. Whether global or pairwise L/R states are needed; settle by Viterbi margin and assignment accuracy against gt, with pairwise states capped to avoid overfitting.
3. Whether the chosen cskel27 motion prior covers the user's generated actions; settle with held-out truth residuals and an ablation with the prior disabled.
4. Actual runtime on the deployment GPU; settle with the fixed 120/240-frame benchmark described above.
5. Exact collision tolerance and contact thresholds; calibrate from the known-truth cube/floor geometry, not visual preference.

The decision-complete first implementation is therefore: PyTorch/CUDA full-clip optimization, GVHMR initialization, SAM2 video masks, differentiable scene-aware rendering, robust keypoints, Viterbi L/R assignments, HMM stance contacts, temporal acceleration, weak learned prior, joint limits, floor/box constraints, and the existing bench as the acceptance gate.

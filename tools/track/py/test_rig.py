"""Parity tests for rig.py (plan mocap-rearch todo 6, tests (a)-(e) + malformed input).

Data (resolved in this order; a missing file FAILS, never skips):
  - parity fixture: <repo>/test/fixtures/track-fk-parity.json
    (node tools/track/fk-parity-fixture.mjs)
  - rig npz: $COZYFIT_RIG, <repo>/node_modules/.cache/cozyfit/rig-y-bot-tpose.npz
    (node tools/track/export-rig.mjs --model y-bot-tpose)
  - truth motion: $COZYFIT_WALK, <repo>/../../evidence/prep/gt-motions/walk.npz
On the box (tools/track/run-box-tests.mjs uploads only tools/track/py/*.py) the three
files are read from ~/cclay-ingest/cozyfit/testdata/ - stage them with
  scp test/fixtures/track-fk-parity.json node_modules/.cache/cozyfit/rig-y-bot-tpose.npz \
      <evidence>/prep/gt-motions/walk.npz ubuntu-baremetal:cclay-ingest/cozyfit/testdata/

Measured errors are printed as one `[rig-parity] {json}` line when pytest exits, so a
passing log carries the numbers, not just dots.
"""
import atexit
import json
import os
from pathlib import Path

import numpy as np
import pytest
import torch

import rig as rigmod
from rig import RigError, State

HERE = Path(__file__).resolve().parent
# <repo>/tools/track/py locally; a flat /tmp/cozyfit-* upload dir on the box (no repo around it)
REPO = HERE.parents[2] if len(HERE.parents) > 2 else HERE
EVIDENCE = REPO.parents[1] / "evidence" if len(REPO.parents) > 1 else REPO / "evidence"
BOX_DATA = Path.home() / "cclay-ingest" / "cozyfit" / "testdata"
PARITY: dict = {}


@atexit.register
def _report():
    if PARITY:
        print("[rig-parity] " + json.dumps(PARITY, sort_keys=True))


def _find(label, env, *candidates):
    paths = ([Path(os.environ[env])] if env and os.environ.get(env) else []) + [Path(c) for c in candidates]
    for p in paths:
        if p.is_file():
            return p
    pytest.fail(f"missing {label}; looked in {[str(p) for p in paths]} (see test_rig.py docstring for staging)")


@pytest.fixture(scope="module")
def fixture():
    path = _find("fk parity fixture", None, REPO / "test/fixtures/track-fk-parity.json", BOX_DATA / "track-fk-parity.json")
    return json.loads(path.read_text())


@pytest.fixture(scope="module")
def rig_path():
    return _find("rig npz", "COZYFIT_RIG", REPO / "node_modules/.cache/cozyfit/rig-y-bot-tpose.npz", BOX_DATA / "rig-y-bot-tpose.npz")


@pytest.fixture(scope="module")
def rig(rig_path, fixture):
    torch.manual_seed(0)
    r = rigmod.load_rig(rig_path)
    source = (r.meta.get("source") or {}).get("sha256")
    assert source == fixture["fbxSha256"], "rig npz and parity fixture come from different FBX files; regenerate one"
    assert r.bone_names == fixture["bones"], "rig npz bone order differs from the fixture"
    return r


def _err(a, b):
    return float(torch.linalg.norm(torch.as_tensor(a, dtype=torch.float64) - torch.as_tensor(b, dtype=torch.float64), dim=-1).max())


# (a) ---------------------------------------------------------------------------------

def test_a_identity_reproduces_neutral(rig, fixture):
    canonical = torch.tensor(fixture["canonicalPosedJoints"])  # JS canonicalCskel27Reference().posed_joints
    state = State.identity(1, root=(0.0, -rig.min_y, 0.0))
    joints, globals_ = rigmod.cskel27_fk(state, None, rig)
    err = _err(joints[0], canonical)
    ones, _ = rigmod.cskel27_fk(state, np.ones(27, dtype=np.float32), rig)
    PARITY["a_identity_max_m"] = err
    assert err < 1e-5, f"identity pose vs neutral posedJoints: {err:.3e} m"
    assert _err(ones, joints) < 1e-7
    assert torch.allclose(globals_, torch.eye(3).expand_as(globals_))


# (b) ---------------------------------------------------------------------------------

def test_b_layer1_matches_truth_posed_joints(rig):
    path = _find("truth motion walk.npz", "COZYFIT_WALK", EVIDENCE / "prep/gt-motions/walk.npz", BOX_DATA / "walk.npz")
    with np.load(path) as z:
        rot, root, posed = z["local_rot_mats"], z["root_positions"], z["posed_joints"]
        bone_scale = z["bone_scale"] if "bone_scale" in z else None
    state = State.from_motion(rot, root)
    joints, _ = rigmod.cskel27_fk(state, bone_scale, rig)
    per_frame = torch.linalg.norm(joints.double() - torch.as_tensor(posed, dtype=torch.float64), dim=-1).amax(dim=1)
    PARITY["b_walk_frames"] = int(len(per_frame))
    PARITY["b_walk_max_m"] = float(per_frame.max())
    PARITY["b_walk_bone_scale"] = "npz" if bone_scale is not None else "none (canonical)"
    assert len(per_frame) == len(posed) > 100
    assert float(per_frame.max()) < 1e-4, f"worst frame {int(per_frame.argmax())}: {float(per_frame.max()):.3e} m"


def test_b_layer1_matches_js_fk_with_bone_scale(rig, fixture):
    worst = 0.0
    for case in fixture["cases"]:
        rot = np.asarray(case["rotMats"], dtype=np.float32).reshape(-1, 27, 3, 3)
        root = np.asarray(case["rootPos"], dtype=np.float32).reshape(-1, 3)
        posed = np.asarray(case["posedJoints"], dtype=np.float32).reshape(-1, 27, 3)
        joints, _ = rigmod.cskel27_fk(State.from_motion(rot, root), case["boneScale"], rig)
        worst = max(worst, _err(joints, posed))
    PARITY["b_js_fk_max_m"] = worst
    assert worst < 1e-4


# (c) ---------------------------------------------------------------------------------

def test_c_rot6d_round_trip():
    g = torch.Generator().manual_seed(6)
    q = torch.randn(4096, 4, generator=g)
    R = rigmod.quat_to_matrix(q)
    back = rigmod.rot6d_to_matrix(rigmod.matrix_to_rot6d(R))
    err = float((back - R).abs().max())
    # arbitrary (non-orthonormal) 6D vectors land on SO(3) and are a fixed point after one pass.
    # The property is checked in float64; float32 Gram-Schmidt on near-parallel random column
    # pairs loses ~1e-5 to cancellation (measured 1.02e-5 on the box), so its bound is looser.
    a = torch.randn(4096, 6, generator=g, dtype=torch.float64)
    Ra = rigmod.rot6d_to_matrix(a)
    ortho = float((Ra.transpose(-1, -2) @ Ra - torch.eye(3, dtype=torch.float64)).abs().max())
    det = float((torch.linalg.det(Ra) - 1).abs().max())
    fixed = float((rigmod.rot6d_to_matrix(rigmod.matrix_to_rot6d(Ra)) - Ra).abs().max())
    Ra32 = rigmod.rot6d_to_matrix(a.float())
    ortho32 = float((Ra32.transpose(-1, -2) @ Ra32 - torch.eye(3)).abs().max())
    PARITY["c_rot6d_round_trip_max"] = err
    PARITY["c_rot6d_orthonormal_f64_max"] = ortho
    PARITY["c_rot6d_orthonormal_f32_max"] = ortho32
    assert err < 1e-5, f"6D round trip {err:.3e}"
    assert ortho < 1e-12 and det < 1e-12 and fixed < 1e-12, (ortho, det, fixed)
    assert ortho32 < 1e-4, f"float32 orthonormality {ortho32:.3e}"
    eye = rigmod.rot6d_to_matrix(torch.tensor([1.0, 0, 0, 0, 1, 0]))
    assert torch.equal(eye, torch.eye(3))


# (d) ---------------------------------------------------------------------------------

def test_d_gradients_finite(rig, fixture):
    case = fixture["cases"][0]
    rot = np.asarray(case["rotMats"], dtype=np.float32).reshape(-1, 27, 3, 3)
    root = np.asarray(case["rootPos"], dtype=np.float32).reshape(-1, 3)
    state = State.from_motion(rot, root)
    g = torch.Generator().manual_seed(7)
    for name in ("transl", "root6d", "local6d"):
        t = getattr(state, name)
        setattr(state, name, (t + 0.01 * torch.randn(t.shape, generator=g)).requires_grad_(True))
    joints, globals_ = rigmod.cskel27_fk(state, case["boneScale"], rig)
    _, verts = rigmod.studio_skin(globals_, joints, rig, bone_scale=case["boneScale"])
    loss = joints.square().sum() + verts.square().mean()
    loss.backward()
    norms = {name: float(getattr(state, name).grad.norm()) for name in ("transl", "root6d", "local6d")}
    PARITY["d_grad_norms"] = norms
    for name in norms:
        grad = getattr(state, name).grad
        assert torch.isfinite(grad).all(), name
        assert norms[name] > 0, name
    # every limb rotation reaches the skinned surface (no detached joint)
    driven = [j for j in range(1, 27) if rig.prep_bone[j] >= 0]
    assert (state.local6d.grad[:, [j - 1 for j in driven]].abs().sum(dim=(0, 2)) > 0).all()


# (e) ---------------------------------------------------------------------------------

def test_e_layer2_matches_studio_playback(rig, fixture):
    idx = fixture["vertexIndices"]
    bone_err, rot_err, vert_err = 0.0, 0.0, 0.0
    for case in fixture["cases"]:
        rot = torch.tensor(case["rotMats"]).reshape(-1, 27, 3, 3)
        posed = torch.tensor(case["posedJoints"]).reshape(-1, 27, 3)
        f, a = case["frame"], case["anchorFrame"]
        globals_ = rigmod.global_rotations(rot[f:f + 1], rig.parents)
        anchor = posed[a, 0, [0, 2]]
        W, verts = rigmod.studio_skin(globals_, posed[f:f + 1], rig, bone_scale=case["boneScale"],
                                      anchor_xz=anchor, vertex_indices=idx)
        ref_W = torch.tensor(case["boneWorld"]).reshape(-1, 4, 4)
        ref_v = torch.tensor(case["vertices"]).reshape(-1, 3)
        bone_err = max(bone_err, _err(W[0, :, :3, 3], ref_W[:, :3, 3]))
        # linear part carries the 0.01 rig root scale; compare the rotation itself
        rot_err = max(rot_err, float((W[0, :, :3, :3] - ref_W[:, :3, :3]).abs().max()) / rig.root_scale)
        vert_err = max(vert_err, _err(verts[0], ref_v))
    PARITY.update(e_cases=len(fixture["cases"]), e_bones=len(fixture["bones"]), e_vertices=len(idx),
                  e_bone_pos_max_m=bone_err, e_bone_mat_max=rot_err, e_vertex_max_m=vert_err)
    assert bone_err < 1e-4, f"bone world position {bone_err:.3e} m"
    assert rot_err < 1e-4, f"bone world rotation entries {rot_err:.3e}"
    assert vert_err < 1e-4, f"skinned vertex {vert_err:.3e} m"


def test_e_parity_detects_a_wrong_mode(rig, fixture):
    """Guard against a vacuous parity: dropping boneScale must move the arms by > 1 mm."""
    case = fixture["cases"][0]
    rot = torch.tensor(case["rotMats"]).reshape(-1, 27, 3, 3)
    posed = torch.tensor(case["posedJoints"]).reshape(-1, 27, 3)
    globals_ = rigmod.global_rotations(rot[1:2], rig.parents)
    _, verts = rigmod.studio_skin(globals_, posed[1:2], rig, bone_scale=None, anchor_xz=posed[0, 0, [0, 2]],
                                  vertex_indices=fixture["vertexIndices"])
    wrong = _err(verts[0], torch.tensor(case["vertices"]).reshape(-1, 3))
    PARITY["e_wrong_mode_vertex_max_m"] = wrong
    assert wrong > 1e-3


# decimated tracker mesh ----------------------------------------------------------------

def test_decimated_mesh(rig):
    faces, verts = rig.dec_faces, rig.dec_vertices
    w = rig.dec_skin_weight.double()
    PARITY.update(dec_faces=int(faces.shape[0]), dec_vertices=int(verts.shape[0]),
                  full_vertices=int(rig.vertices.shape[0]))
    assert 1000 < faces.shape[0] <= rigmod.MAX_FACES
    assert int(faces.max()) < verts.shape[0] and int(faces.min()) >= 0
    assert (w >= 0).all() and float((w.sum(dim=1) - 1).abs().max()) < 1e-6
    assert torch.allclose(rig.dec_weights.sum(dim=1), torch.ones(len(verts)), atol=1e-6)
    # weights come from the nearest original vertex: that vertex is close by
    gap = torch.linalg.norm(verts - rig.vertices[torch.as_tensor(rig.dec_source)], dim=-1)
    PARITY["dec_source_gap_max_m"] = float(gap.max())
    assert float(gap.max()) < 0.05
    # rest pose: identity-ish skinning leaves the rest mesh where it is
    B = len(rig.bone_names)
    rest_worlds = torch.linalg.inv(rig.bind_inverse).unsqueeze(0)
    moved = rigmod.lbs(rest_worlds, rig, verts, rig.dec_weights)
    assert rest_worlds.shape == (1, B, 4, 4)
    assert float((moved[0] - verts).abs().max()) < 1e-4


# malformed input -------------------------------------------------------------------------

def _rewrite(rig_path, tmp_path, **changes):
    with np.load(rig_path) as z:
        members = {k: z[k] for k in z.files}
    for key, value in changes.items():
        if value is None:
            members.pop(key)
        else:
            members[key] = value
    out = tmp_path / "rig.npz"
    np.savez(out, **members)
    return out


def test_bad_skin_weights_rejected(rig_path, tmp_path):
    with np.load(rig_path) as z:
        w = z["skin_weight"].copy()
    w[123] *= 0.9
    with pytest.raises(RigError) as err:
        rigmod.load_rig(_rewrite(rig_path, tmp_path, skin_weight=w))
    assert err.value.code == "bad-skin-weights" and "vertex 123" in str(err.value)
    w = np.load(rig_path)["skin_weight"].copy()
    w[7, 0], w[7, 1] = -0.25, w[7, 1] + 0.25 + w[7, 0]
    with pytest.raises(RigError) as err:
        rigmod.load_rig(_rewrite(rig_path, tmp_path, skin_weight=w))
    assert err.value.code == "bad-skin-weights"


def test_missing_and_malformed_members_rejected(rig_path, tmp_path):
    with pytest.raises(RigError) as err:
        rigmod.load_rig(_rewrite(rig_path, tmp_path, prep_chain_rel=None))
    assert err.value.code == "bad-rig" and "prep_chain_rel" in str(err.value)
    with pytest.raises(RigError) as err:
        rigmod.load_rig(_rewrite(rig_path, tmp_path, prep_offsets=np.zeros((26, 3), np.float32)))
    assert err.value.code == "bad-rig" and "prep_offsets" in str(err.value)
    with pytest.raises(RigError) as err:
        rigmod.load_rig(tmp_path / "no-such-rig.npz")
    assert err.value.code == "bad-rig"


def test_bad_bone_scale_and_motion_rejected(rig):
    state = State.identity(2)
    with pytest.raises(RigError) as err:
        rigmod.cskel27_fk(state, np.ones(26), rig)
    assert err.value.code == "bad-bone-scale"
    bad = np.ones(27)
    bad[3] = 0
    with pytest.raises(RigError) as err:
        rigmod.cskel27_fk(state, bad, rig)
    assert err.value.code == "bad-bone-scale"
    with pytest.raises(RigError) as err:
        State.from_motion(np.zeros((4, 26, 3, 3)), np.zeros((4, 3)))
    assert err.value.code == "bad-motion"

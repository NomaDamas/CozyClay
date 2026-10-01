"""Box acceptance for the real track.py entry point, not a mocked optimizer.

Synthetic images are independently filled mesh triangles, not the objective's
point samples. A known, smoothly articulated cskel27 clip is perturbed in 3-D;
noisy 2-D joints contain independent 1/3/7-frame assignment errors. Acceptance
numbers are printed at process exit so `run-box-tests.mjs` retains them.
"""
import atexit
import json
from pathlib import Path
import subprocess
import sys

import cv2
import numpy as np
import pytest
import torch
from scipy.spatial.transform import Rotation

from lr_viterbi import state_permutation
from objective import COCO_JOINTS, bilinear_dt, camera_tensors, project, trust_region_loss
from rig import State, cskel27_fk, load_rig, studio_skin
from track import windows

HERE = Path(__file__).resolve().parent
DATA = Path.home() / 'cclay-ingest/cozyfit/testdata'
MEASUREMENTS = {}


@atexit.register
def report():
    if MEASUREMENTS:
        print('[track-acceptance] ' + json.dumps(MEASUREMENTS, sort_keys=True))


def synthetic(directory, frames, fixed=False, seed=100):
    directory.mkdir(parents=True, exist_ok=True)
    torch.set_num_threads(4)
    rig_path = DATA / 'rig-y-bot-tpose.npz'
    rig = load_rig(rig_path)
    fps = 30
    t = np.arange(frames, dtype=np.float32) / fps
    phase = t * 2 * np.pi / 3
    aa = np.zeros((frames, 27, 3), np.float32)
    aa[:, 0, 1] = 0.1 * np.sin(phase)
    aa[:, 9, 2] = 0.7 + 0.18 * np.sin(phase)
    aa[:, 14, 2] = -0.7 + 0.18 * np.cos(phase)
    aa[:, 10, 1] = 0.4 + 0.15 * np.sin(phase)
    aa[:, 15, 1] = -0.4 - 0.15 * np.cos(phase)
    # Bounded periodic translation, no long-clip field-of-view difference.
    root = np.stack((0.45 * np.sin(t * 1.4), 1.05 + 0.015 * np.sin(phase), 0.1 * np.cos(t * 1.4)), -1)
    rotations = Rotation.from_rotvec(aa.reshape(-1, 3)).as_matrix().reshape(frames, 27, 3, 3).astype(np.float32)
    state = State.from_motion(rotations, root)
    with torch.no_grad():
        joints, globals_ = cskel27_fk(state, None, rig)
        _, vertices = studio_skin(globals_, joints, rig)
    width, height = 832, 480
    eye = np.array([2.8, 1.6, 6.0])
    forward = (np.array([0, 1, 0]) - eye)
    forward /= np.linalg.norm(forward)
    right = np.cross(forward, [0, 1, 0]); right /= np.linalg.norm(right)
    down = np.cross(forward, right)
    R = np.stack((right, down, forward))
    w = np.eye(4); w[:3, :3] = R; w[:3, 3] = -R @ eye
    camera = dict(width=width, height=height, K=[[700, 0, width / 2], [0, 700, height / 2], [0, 0, 1]], worldToCamera=w.tolist(), tracker=dict(deltaPx=3.0, cameraFixed=fixed))
    cam = camera_tensors(camera, 'cpu')
    zero = torch.zeros(4)
    uv, _ = project(joints[:, COCO_JOINTS], cam, zero)
    pixel, _ = project(vertices, cam, zero)
    pixel = pixel.numpy() / 2
    faces = rig.dec_faces.numpy()
    masks = np.zeros((frames, height // 2, width // 2), np.float16)
    for i in range(frames):
        mask = np.zeros((height // 2, width // 2), np.uint8)
        # CPU triangle fill is only a fixture generator, never imported by track.
        for triangle in np.rint(pixel[i][faces]).astype(np.int32):
            cv2.fillConvexPoly(mask, triangle, 1)
        masks[i] = mask
    rng = np.random.default_rng(seed)
    kp = np.concatenate((uv.numpy() + rng.normal(0, 0.25, uv.shape), np.ones((frames, 17, 1))), -1).astype(np.float32)
    kp[:, :5, 2] = 0
    expected = np.array(['identity'] * frames, dtype=object)
    for start, size, name in [(18, 1, 'full_swap'), (36, 3, 'arms_swap'), (65, 7, 'legs_swap')]:
        if start + size <= frames:
            kp[start:start + size] = kp[start:start + size, state_permutation(name)]
            expected[start:start + size] = name
    initial_root = root + np.array([0.045, 0.025, 0.07], np.float32)
    initial_aa = aa + rng.normal(0, 0.018, aa.shape).astype(np.float32)
    initial_rot = Rotation.from_rotvec(initial_aa.reshape(-1, 3)).as_matrix().reshape(frames, 27, 3, 3).astype(np.float32)
    initial_joints, _ = cskel27_fk(State.from_motion(initial_rot, initial_root), None, rig)
    initial_mpjpe = float(torch.linalg.norm(initial_joints - joints, dim=-1).mean())
    assert initial_mpjpe > 0.05, initial_mpjpe
    np.savez(directory / 'init.npz', local_rot_mats=initial_rot, root_positions=initial_root, posed_joints=initial_joints.numpy(), fps=np.array(fps, np.int32))
    np.savez(directory / 'obs.npz', kp2d=kp, K=np.array(camera['K']), fps=np.array(fps), bbx_xys=np.tile([width / 2, height / 2, height * 0.8], (frames, 1)))
    np.savez_compressed(directory / 'masks.npz', prob=masks, reprompted=np.array([], dtype=np.int32))
    (directory / 'camera.json').write_text(json.dumps(camera))
    (directory / 'scene.json').write_text('{"boxes": []}')
    # A genuine video input keeps the command boundary realistic; fitting reads
    # only its cached observations and masks, not the encoded image samples.
    writer = cv2.VideoWriter(str(directory / 'video.mp4'), cv2.VideoWriter_fourcc(*'mp4v'), fps, (width, height))
    assert writer.isOpened()
    for mask in masks:
        frame = cv2.resize(mask.astype(np.uint8) * 180, (width, height))
        writer.write(np.repeat(frame[..., None], 3, axis=2))
    writer.release()
    return dict(directory=directory, joints=joints.numpy(), root=root, expected=expected, initialMPJPE=initial_mpjpe, rig=rig_path)


def assert_schema(value, schema):
    """Validate the vocabulary used by the shipped dependency-free schema."""
    kinds = dict(object=dict, array=list, integer=int, number=(int, float), string=str, boolean=bool, null=type(None))
    names = schema.get('type', [])
    names = names if isinstance(names, list) else [names]
    assert not names or any(isinstance(value, kinds[name]) and (name not in ('integer', 'number') or not isinstance(value, bool)) for name in names)
    if 'const' in schema:
        assert value == schema['const']
    if isinstance(value, (int, float)) and not isinstance(value, bool):
        assert np.isfinite(value)
        if 'minimum' in schema:
            assert value >= schema['minimum']
        if 'exclusiveMinimum' in schema:
            assert value > schema['exclusiveMinimum']
    if isinstance(value, dict):
        assert set(schema.get('required', [])) <= value.keys()
        properties = schema.get('properties', {})
        extra = schema.get('additionalProperties', True)
        for key, child in value.items():
            assert key in properties or extra is not False
            rule = properties.get(key, extra)
            if isinstance(rule, dict):
                assert_schema(child, rule)
    if isinstance(value, list):
        assert len(value) >= schema.get('minItems', 0)
        assert len(value) <= schema.get('maxItems', float('inf'))
        prefix = schema.get('prefixItems', [])
        if schema.get('items') is False:
            assert len(value) <= len(prefix)
        for i, child in enumerate(value):
            rule = prefix[i] if i < len(prefix) else schema.get('items', {})
            if isinstance(rule, dict):
                assert_schema(child, rule)


def invoke(case, out, *extra, timeout=220, expected_code=0):
    d = case['directory']
    command = [sys.executable, str(HERE / 'track.py')]
    for key, file in [('video', 'video.mp4'), ('obs', 'obs.npz'), ('masks', 'masks.npz'), ('init', 'init.npz'), ('camera', 'camera.json'), ('scene', 'scene.json')]:
        command.extend(['--' + key, str(d / file)])
    command.extend(['--rig', str(case['rig']), '--out', str(out), *extra])
    result = subprocess.run(command, text=True, capture_output=True, timeout=timeout)
    assert result.returncode == expected_code, result.stdout + '\n' + result.stderr
    diagnostics = json.loads((out / 'diagnostics.json').read_text())
    # The authoritative schema is staged beside the rig for box tests.
    assert_schema(diagnostics, json.loads((DATA / 'diagnostics.schema.json').read_text()))
    for key in ['occluded', 'lrState', 'lrMargin', 'ambiguous']:
        assert len(diagnostics[key]) == diagnostics['frames']
    assert diagnostics['runtime']['peakReservedMiB'] <= 5632
    if expected_code:
        assert not (out / 'motion.npz').exists()
        return diagnostics, None, result
    assert '[track] ' in result.stdout
    with np.load(out / 'motion.npz') as z:
        motion = {k: z[k].copy() for k in z.files}
    return diagnostics, motion, result


@pytest.fixture(scope='module')
def small_case(tmp_path_factory):
    return synthetic(tmp_path_factory.mktemp('synthetic124'), 124)


def test_synthetic_recovery_determinism_and_runtime(small_case, tmp_path):
    first, motion, result = invoke(small_case, tmp_path / 'first')
    second, repeat, _ = invoke(small_case, tmp_path / 'second')
    mpjpe = float(np.linalg.norm(motion['posed_joints'] - small_case['joints'], axis=-1).mean())
    root = float(np.sqrt(np.mean(np.sum((motion['root_positions'] - small_case['root']) ** 2, axis=-1))))
    difference = float(np.max(np.abs(motion['posed_joints'] - repeat['posed_joints'])))
    MEASUREMENTS['124'] = dict(mpjpeM=mpjpe, rootRmseM=root, scale=first['nuisance']['scale'], determinismMaxM=difference,
                               initialMPJPE=small_case['initialMPJPE'], runtime=first['runtime'], repeatRuntime=second['runtime'],
                               maskIoU=first['stageLosses']['sampleMaskIoUMean'], lrStates=first['lrState'])
    assert first['failure'] is None
    assert first['stageLosses']['ablation.full'] == 1.0
    assert first['stageLosses']['input.confidenceAboveOne'] == 0
    assert mpjpe <= 0.020 and root <= 0.020, MEASUREMENTS['124']
    assert abs(first['nuisance']['scale'] - 1) < 0.005
    assert difference <= 1e-4
    assert first['runtime']['trackerSeconds'] <= 180 and second['runtime']['trackerSeconds'] <= 180
    assert first['lrState'] == small_case['expected'].tolist()
    for stage, steps in [('root', 150), ('pose', 300), ('refine', 200)]:
        assert f'[track] stage {stage} {steps}/{steps}' in result.stdout

    seed_results = {}
    for seed in (101, 102):
        seeded = synthetic(tmp_path / f'seed-{seed}', 124, seed=seed)
        seeded_diag, seeded_motion, _ = invoke(seeded, tmp_path / f'seed-{seed}-out')
        seeded_mpjpe = float(np.linalg.norm(seeded_motion['posed_joints'] - seeded['joints'], axis=-1).mean())
        seeded_root = float(np.sqrt(np.mean(np.sum((seeded_motion['root_positions'] - seeded['root']) ** 2, axis=-1))))
        seed_results[str(seed)] = dict(mpjpeM=seeded_mpjpe, rootRmseM=seeded_root,
                                       scale=seeded_diag['nuisance']['scale'], runtime=seeded_diag['runtime'])
        MEASUREMENTS['seedRecovery'] = seed_results
        assert seeded_diag['failure'] is None
        assert seeded_mpjpe <= 0.020 and seeded_root <= 0.020, seed_results
        assert abs(seeded_diag['nuisance']['scale'] - 1) < 0.005
        assert seeded_diag['runtime']['trackerSeconds'] <= 180
        assert seeded_diag['lrState'] == seeded['expected'].tolist()


def test_362_frame_windows_runtime(tmp_path):
    case = synthetic(tmp_path / 'input', 362, fixed=True)
    diag, motion, _ = invoke(case, tmp_path / 'output', timeout=570)
    mpjpe = float(np.linalg.norm(motion['posed_joints'] - case['joints'], axis=-1).mean())
    root = float(np.sqrt(np.mean(np.sum((motion['root_positions'] - case['root']) ** 2, axis=-1))))
    MEASUREMENTS['362'] = dict(runtime=diag['runtime'], scale=diag['nuisance']['scale'],
                               mpjpeM=mpjpe, rootRmseM=root)
    assert diag['failure'] is None
    assert mpjpe <= 0.020 and root <= 0.020, MEASUREMENTS['362']
    assert diag['runtime']['trackerSeconds'] <= 540
    assert diag['nuisance'] == dict(scale=1.0, cameraDeltaDeg=[0.0, 0.0], fovDeltaPct=0.0)
    assert motion['posed_joints'].shape == (362, 27, 3)
    assert np.max(np.linalg.norm(np.diff(motion['root_positions'], axis=0), axis=-1)) < 0.1


def test_zero_iterations_exact_init(small_case, tmp_path):
    diag, motion, _ = invoke(small_case, tmp_path, '--iterations', '0', timeout=60)
    with np.load(small_case['directory'] / 'init.npz') as initial:
        assert set(motion) == set(initial.files)
        maximum = max(float(np.max(np.abs(motion[k] - initial[k]))) for k in motion)
    MEASUREMENTS['zeroIterationMaxDiff'] = maximum
    assert maximum < 1e-5 and diag['failure'] is None


def own_obs(small_case, tmp_path):
    """Inputs identical to small_case except for a writable obs.npz."""
    source = small_case['directory']
    d = tmp_path / 'inputs'; d.mkdir()
    for name in ['init.npz', 'camera.json', 'scene.json', 'masks.npz', 'video.mp4']:
        (d / name).symlink_to(source / name)
    with np.load(source / 'obs.npz') as z:
        obs = {k: z[k].copy() for k in z.files}
    return d, obs


def test_confidence_sanitized_and_counted(small_case, tmp_path):
    d, obs = own_obs(small_case, tmp_path)
    # Real ViTPose heatmap peaks reach 1.0385 on the Gate-2 items.
    obs['kp2d'][3, 6, 2] = 1.3
    obs['kp2d'][4, 7, 2] = np.nan
    obs['kp2d'][5, 8, 2] = np.inf
    obs['kp2d'][6, 9, 2] = -0.2
    np.savez(d / 'obs.npz', **obs)
    diag, motion, result = invoke(dict(small_case, directory=d), tmp_path / 'out', '--iterations', '0', timeout=60)
    counts = {k: v for k, v in diag['stageLosses'].items() if k.startswith('input.')}
    MEASUREMENTS['confidenceSanitized'] = counts
    assert counts == {'input.confidenceNonFinite': 2, 'input.confidenceAboveOne': 1, 'input.confidenceBelowZero': 1}
    assert diag['failure'] is None and motion is not None
    assert '[track] sanitized keypoint confidences' in result.stdout


def test_ablation_switch(small_case, tmp_path):
    diag, _, _ = invoke(small_case, tmp_path / 'kp-only', '--track-ablate', 'kp-only', '--iterations', '13', timeout=120)
    losses = diag['stageLosses']
    MEASUREMENTS['ablationKpOnly'] = dict(failure=diag['failure'], stageLosses=losses)
    assert losses['ablation.kp-only'] == 1.0 and 'ablation.full' not in losses
    assert 'refine.keypoints' in losses and 'refine.acceleration' in losses
    assert not any(k.split('.')[-1] in ('silhouette', 'skate', 'penetration') for k in losses)
    # Without Viterbi the detector labels are used as given, despite injected swaps.
    assert set(diag['lrState']) == {'identity'} and not any(diag['ambiguous'])
    command = [sys.executable, str(HERE / 'track.py'), '--track-ablate', 'everything']
    for key in ('video', 'obs', 'masks', 'init', 'camera', 'scene', 'rig', 'out'):
        command.extend(['--' + key, str(tmp_path)])
    assert subprocess.run(command, capture_output=True, timeout=60).returncode == 2


def test_no_evidence_and_malformed_input(small_case, tmp_path):
    d, obs = own_obs(small_case, tmp_path)
    obs['kp2d'][..., 2] = 0
    np.savez(d / 'obs.npz', **obs)
    case = dict(small_case, directory=d)
    out = tmp_path / 'no-evidence'; out.mkdir()
    (out / 'motion.npz').write_bytes(b'stale output')
    diag, _, result = invoke(case, out, expected_code=3, timeout=30)
    assert diag['failure'] == 'no-evidence' and result.returncode == 3
    obs['kp2d'][0, 5, 0] = np.nan
    np.savez(d / 'obs.npz', **obs)
    diag, _, _ = invoke(case, tmp_path / 'malformed', expected_code=2, timeout=30)
    assert diag['failure'] == 'bad-input'
    obs['kp2d'] = obs['kp2d'][..., :2]
    np.savez(d / 'obs.npz', **obs)
    diag, _, _ = invoke(case, tmp_path / 'bad-shape', expected_code=2, timeout=30)
    assert diag['failure'] == 'bad-input'
    MEASUREMENTS['failureCodes'] = {'no-evidence': 3, 'bad-input': 2}


def test_trust_region_invariance_weighting_and_gradients():
    initial = State.identity(5)
    rotations = initial.local_rot_mats()
    assert trust_region_loss(initial.transl, rotations, initial.transl, rotations).item() == 0
    # Placement correction is free; a bent mid-clip trajectory is not.
    shifted = initial.transl + torch.tensor([0.5, 0.0, -0.75])
    assert trust_region_loss(shifted, rotations, initial.transl, rotations).item() == 0
    shifted[2, 0] += 0.25
    shifted.requires_grad_()
    path = trust_region_loss(shifted, rotations, initial.transl, rotations)
    assert 0 < path.item() < 2
    path.backward()
    assert torch.isfinite(shifted.grad).all() and shifted.grad[2, 0] > 0
    turn = torch.tensor(Rotation.from_rotvec([0, 0.5, 0]).as_matrix(), dtype=torch.float32)
    arm, leg = rotations.clone(), rotations.clone()
    arm[:, 9], leg[:, 19] = turn, turn
    arm.requires_grad_()
    arm_loss = trust_region_loss(initial.transl, arm, initial.transl, rotations)
    leg_loss = trust_region_loss(initial.transl, leg, initial.transl, rotations)
    assert arm_loss.item() == pytest.approx(4 * leg_loss.item())
    arm_loss.backward()
    assert torch.isfinite(arm.grad).all() and arm.grad.abs().max() > 0
    far = initial.transl.clone(); far[2] = 1e6
    assert trust_region_loss(far, arm.detach(), initial.transl, rotations).item() < 4


def test_windows_and_dt_gradients():
    assert windows(240) == [(0, 240)]
    assert windows(362) == [(0, 120), (104, 224), (208, 328), (312, 362)]
    dt = torch.arange(20, dtype=torch.float32).reshape(1, 4, 5)
    uv = torch.tensor([[[2.25, 1.75], [-2., 2.]]], requires_grad=True)
    value = bilinear_dt(dt, uv)
    assert value[0, 0].item() == pytest.approx(8.0)
    value.sum().backward()
    assert torch.isfinite(uv.grad).all() and uv.grad[0, 1, 0] < 0

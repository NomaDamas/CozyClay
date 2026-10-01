"""Independent name contracts for cskel27 versus COCO index spaces.

The synthetic recovery fixture imports the objective's map, so it cannot by
itself catch a shared off-by-one. These assertions use exported rig names and
an independent anatomical correspondence instead of regenerating that map.
"""
import json
from pathlib import Path
import warnings

import numpy as np
import pytest
import torch

from lr_viterbi import ARM_PAIRS, COCO_NAMES, FACE_PAIRS, LEG_PAIRS, state_permutation
from masks import ANKLES, EXTREMITIES, TORSO_PAIRS, UPPER
from objective import (ARM_TRUST_JOINTS, COCO_JOINTS, JOINT_CAPS_DEG,
                       articulation_reliability, trust_region_loss)
from rig import State
from scene import FOOT_JOINTS, FOOT_NAMES, foot_points


@pytest.fixture(scope='module')
def joint_names():
    path = Path.home() / 'cclay-ingest/cozyfit/testdata/rig-y-bot-tpose.npz'
    with np.load(path, allow_pickle=False) as rig:
        meta = json.loads(bytes(rig['meta_json'].astype(np.uint8)))
    names = meta['cskel27Joints']
    assert len(names) == 27 and names[0] == 'Hips'
    return names


def test_coco_correspondence_and_visibility_indices_by_name(joint_names):
    expected = ['LeftArm', 'RightArm', 'LeftForeArm', 'RightForeArm', 'LeftHand', 'RightHand',
                'LeftUpLeg', 'RightUpLeg', 'LeftLeg', 'RightLeg', 'LeftFoot', 'RightFoot']
    assert [joint_names[j] for j in COCO_JOINTS[5:]] == expected
    # Visibility is anatomical: selecting it by this map must hide the matching
    # detector-side body landmark, not the next joint along the right arm.
    for coco, name in enumerate(expected, start=5):
        hidden = torch.zeros(1, 27, dtype=torch.bool)
        hidden[0, joint_names.index(name)] = True
        assert hidden[:, COCO_JOINTS][0, 5:].nonzero().flatten().tolist() == [coco - 5]


def test_trust_weighting_by_exported_bilateral_joint_names(joint_names):
    strong = {side + part for side in ('Left', 'Right') for part in ('Shoulder', 'Arm', 'ForeArm', 'Hand')}
    assert {joint_names[j] for j in ARM_TRUST_JOINTS} == strong
    state = State.identity(1)
    initial = state.local_rot_mats()
    angle = 0.4
    c, s = np.cos(angle), np.sin(angle)
    turn = torch.tensor([[c, 0, s], [0, 1, 0], [-s, 0, c]], dtype=torch.float32)
    leg = initial.clone(); leg[:, joint_names.index('RightUpLeg')] = turn
    unit = trust_region_loss(state.transl, leg, state.transl, initial).item()
    assert unit > 0
    for joint, name in enumerate(joint_names):
        rotations = initial.clone(); rotations[:, joint] = turn
        actual = trust_region_loss(state.transl, rotations, state.transl, initial).item()
        multiplier = 2 if name == 'Hips' else 4 if name in strong else 1
        assert actual == pytest.approx(multiplier * unit), name


def test_joint_limit_caps_are_anatomically_symmetric(joint_names):
    assert len(JOINT_CAPS_DEG) == len(joint_names)
    caps = dict(zip(joint_names, JOINT_CAPS_DEG))
    expected = {'Shoulder': 90, 'Arm': 175, 'ForeArm': 175, 'Hand': 110,
                'HandEnd': 150, 'HandThumb1': 180, 'UpLeg': 160, 'Leg': 175, 'Foot': 100, 'ToeBase': 80}
    for part, degrees in expected.items():
        assert caps['Left' + part] == caps['Right' + part] == degrees


def test_foot_and_lr_selections_use_their_own_index_spaces(joint_names):
    assert FOOT_NAMES == ('left', 'right')
    expected_feet = [['LeftFoot', 'LeftToeBase'], ['RightFoot', 'RightToeBase']]
    assert [[joint_names[j] for j in foot] for foot in FOOT_JOINTS] == expected_feet
    tagged = torch.arange(27)[None, :, None].expand(1, -1, 3)
    selected = foot_points(tagged)[0, :, :, 0].tolist()
    assert [[joint_names[j] for j in foot] for foot in selected] == expected_feet
    for pairs, parts in [(ARM_PAIRS, ['Shoulder', 'Elbow', 'Wrist']),
                         (LEG_PAIRS, ['Hip', 'Knee', 'Ankle']), (FACE_PAIRS, ['Eye', 'Ear'])]:
        assert [(COCO_NAMES[a], COCO_NAMES[b]) for a, b in pairs] == [('left' + p, 'right' + p) for p in parts]
    full = state_permutation('full_swap')
    assert all(full[a] == b and full[b] == a for a, b in ARM_PAIRS + LEG_PAIRS + FACE_PAIRS)


def test_mask_prompt_indices_by_coco_name():
    assert [[COCO_NAMES[j] for j in pair] for pair in TORSO_PAIRS] == [
        ['leftShoulder', 'rightShoulder'], ['leftHip', 'rightHip']]
    assert [COCO_NAMES[j] for j in EXTREMITIES] == ['nose', 'leftWrist', 'rightWrist', 'leftAnkle', 'rightAnkle']
    assert [COCO_NAMES[j] for j in UPPER] == ['nose', 'leftWrist', 'rightWrist']
    assert [COCO_NAMES[j] for j in ANKLES] == ['leftAnkle', 'rightAnkle']


def test_reliability_lower_median_strict_cuda_determinism():
    assert torch.cuda.is_available(), 'Box acceptance requires CUDA'
    projected = np.arange(4 * 17 * 2, dtype=np.float32).reshape(4, 17, 2) / 3
    assigned = np.zeros((4, 17, 3), np.float32)
    assigned[..., 2] = 1
    assigned[:, :5, 2] = 0
    assigned[1, 6::2, 2] = 0.2
    assigned[2, 10:, 2] = 0
    assigned[3, :, 2] = 0
    seen = np.ones((4, 17), bool)
    seen[2, 5] = False
    expected = []
    for uv, obs, visible in zip(projected, assigned, seen):
        valid = visible[5:] & (obs[5:, 2] >= 0.5)
        body = (uv - obs[:, :2])[5:][valid]
        center = np.sort(body, axis=0)[(len(body) - 1) // 2] if len(body) else np.zeros(2)
        excess = np.maximum(np.linalg.norm(uv - obs[:, :2] - center, axis=-1) / 3 - 1, 0) / 2
        expected.append(obs[:, 2] * visible / (1 + excess ** 2) ** 2)
    enabled = torch.are_deterministic_algorithms_enabled()
    warn_only = torch.is_deterministic_algorithms_warn_only_enabled()
    try:
        torch.use_deterministic_algorithms(True)
        with warnings.catch_warnings():
            warnings.simplefilter('error', UserWarning)
            actual = articulation_reliability(torch.tensor(projected, device='cuda'),
                                              torch.tensor(assigned, device='cuda'),
                                              torch.tensor(seen, device='cuda'), 3)
        np.testing.assert_allclose(actual.cpu().numpy(), np.asarray(expected), atol=1e-6, rtol=1e-5)
    finally:
        torch.use_deterministic_algorithms(enabled, warn_only=warn_only)

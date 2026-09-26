"""CPU numerical regression tests (NumPy only) for vertical trajectory recovery."""
import sys
import unittest
from pathlib import Path

import numpy as np

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "tools/ardy"))
from gvhmr_trajectory import center_of_mass, recover_vertical, trajectory_job


def fixture(fps=30, delayed=True):
    t = np.arange(round(6 * fps)) / fps
    flight_time = np.sqrt(2 * 1.8 / 9.81)
    observed = 2.6 - .5 * 9.81 * np.clip(t - 1.5, 0, flight_time) ** 2
    baseline = 2.6 - 1.8 * np.clip((t - 1.5) / (2.3 if delayed else .6), 0, 1)
    if not delayed:
        baseline = observed.copy()
    n = len(t)
    root = np.zeros((n, 3)); root[:, 1] = baseline
    joints = np.repeat(root[:, None], 22, axis=1)
    joints[:, 12, 1] += .5
    joints[:, 15, 1] += .7
    joints[:, [4, 5], 1] -= .4
    joints[:, [7, 8, 10, 11], 1] -= .8
    camera = joints.copy(); camera[:, :, 2] = 5
    kp = np.ones((n, 17, 3)); kp[:, :, 0] = 320
    kp[:, :, 1] = (480 - 100 * observed)[:, None]
    k = np.repeat(np.array([[500., 0, 320], [0, 500, 240], [0, 0, 1]])[None], n, axis=0)
    return root, joints, camera, kp, k, np.array([0., -1, 0]), fps


class TrajectoryTests(unittest.TestCase):
    def test_delayed_descent_uses_observed_timing(self):
        args = fixture()
        copies = [a.copy() for a in args[:-1]]
        delta, report = recover_vertical(*args)
        self.assertEqual(report["status"], "corrected")
        event = report["events"][0]
        self.assertLess(event["tailDriftAfterM"], .1)
        self.assertGreater(event["tailDriftBeforeM"], .8)
        self.assertTrue(event["gravityApplied"], "physically matching airborne COM should use actual gravity")
        self.assertEqual(delta[0], 0)
        self.assertEqual(delta[-1], 0)
        for before, after in zip(copies, args):
            np.testing.assert_array_equal(before, after)

    def test_already_correct_motion_is_bit_exact(self):
        delta, report = recover_vertical(*fixture(delayed=False))
        self.assertFalse(np.any(delta))
        self.assertEqual(report["status"], "unchanged")

    def test_short_take_does_not_require_wrong_world_endpoint_to_settle(self):
        args = list(fixture())
        n = round(3.3 * args[-1])
        for i in range(5):
            args[i] = args[i][:n]
        delta, report = recover_vertical(*args)
        self.assertEqual(report["status"], "corrected")
        event = report["events"][0]
        self.assertEqual(event["endpointSource"], "observed-plateau")
        self.assertLess(abs(args[0][-1, 1] + delta[-1] - .8), .02)
        self.assertLess(delta[-1], -.2, "must not snap back to a floating endpoint")
        self.assertLess(abs(event["tailDriftAfterM"]), .1)

    def test_short_landing_observation_is_not_silently_guessed(self):
        args = list(fixture())
        n = round(2.4 * args[-1])
        for i in range(5):
            args[i] = args[i][:n]
        delta, report = recover_vertical(*args)
        self.assertFalse(np.any(delta))

    def test_no_vertical_descent_is_bit_exact(self):
        args = list(fixture())
        args[3][:, :, 1] = 300
        self.assertFalse(np.any(recover_vertical(*args)[0]))

    def test_nonballistic_source_is_not_forced_into_gravity(self):
        args = list(fixture())
        t = np.arange(len(args[0])) / args[-1]
        y = 2.6 - 1.8 * np.clip((t - 1.5) / .6, 0, 1)
        args[3][:, :, 1] = (480 - 100 * y)[:, None]
        _, report = recover_vertical(*args)
        self.assertEqual(report["status"], "corrected")
        self.assertFalse(report["events"][0]["gravityApplied"])

    def test_disabled_hook_never_reads_runner_or_video(self):
        with trajectory_job(object(), "/missing", "/missing", enabled=False) as report:
            self.assertEqual(report["status"], "disabled")

    def test_low_confidence_rejects(self):
        args = list(fixture())
        args[3][:, :, 2] = .2
        delta, report = recover_vertical(*args)
        self.assertFalse(np.any(delta))
        self.assertIn("uncertain-keypoints", [r["reason"] for r in report["rejected"]])

    def test_camera_pan_without_world_descent_rejects(self):
        args = list(fixture())
        shift = 2.6 - args[0][:, 1].copy()
        args[0][:, 1] = 2.6
        args[1][:, :, 1] += shift[:, None]
        self.assertFalse(np.any(recover_vertical(*args)[0]))

    def test_variable_focal_length_rejects(self):
        args = list(fixture())
        args[4][-1, 0, 0] *= 1.4
        self.assertEqual(recover_vertical(*args)[1]["reason"], "variable-intrinsics")

    def test_large_depth_change_rejects(self):
        args = list(fixture())
        args[2][50:65, 0, 2] = 10
        self.assertFalse(np.any(recover_vertical(*args)[0]))

    def test_actual_fps_controls_event_times(self):
        for fps in (24, 30, 60):
            delta, report = recover_vertical(*fixture(fps=fps))
            event = report["events"][0]
            self.assertLess(abs(event["landing"] / fps - 2.1), .12)
            self.assertLess(event["tailDriftAfterM"], .1)

    def test_com_is_translation_equivariant_and_not_pelvis(self):
        joints = fixture()[1]
        shift = np.array([2, 3, 4])
        np.testing.assert_allclose(center_of_mass(joints + shift), center_of_mass(joints) + shift)
        changed = joints.copy(); changed[:, [20, 21], 1] += 2
        self.assertTrue(np.all(center_of_mass(changed)[:, 1] > center_of_mass(joints)[:, 1]))

    def test_bad_fps_and_nonfinite_are_named_rejections(self):
        args = list(fixture()); args[-1] = 0
        self.assertEqual(recover_vertical(*args)[1]["reason"], "invalid-input")
        args = list(fixture()); args[3][0, 0, 0] = np.nan
        self.assertEqual(recover_vertical(*args)[1]["reason"], "invalid-input")


if __name__ == "__main__":
    unittest.main()

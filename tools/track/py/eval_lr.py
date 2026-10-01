#!/usr/bin/env python3
"""Evaluate Viterbi assignments against the Gate-0 truth-projected labels."""
from __future__ import annotations

import argparse
import json
from pathlib import Path
from typing import Any

import numpy as np

from lr_viterbi import ARM_PAIRS, LEG_PAIRS, solve_lr_viterbi, state_permutation

COCO_TO_RIG = {
    5: "LeftArm", 6: "RightArm", 7: "LeftForeArm", 8: "RightForeArm",
    9: "LeftHand", 10: "RightHand", 11: "LeftUpLeg", 12: "RightUpLeg",
    13: "LeftLeg", 14: "RightLeg", 15: "LeftFoot", 16: "RightFoot",
}
BODY = tuple(COCO_TO_RIG)


def read_npz(path: Path) -> np.ndarray:
    with np.load(path, allow_pickle=False) as data:
        if "kp2d" not in data:
            raise ValueError(f"{path}: missing kp2d")
        return np.asarray(data["kp2d"], dtype=np.float64)


def _box(scene: dict[str, Any]) -> tuple[np.ndarray, np.ndarray, float]:
    centre = np.asarray(scene.get("centre", scene.get("center")), dtype=np.float64)
    half = np.asarray(scene.get("halfExtents"), dtype=np.float64)
    if centre.shape != (3,) or half.shape != (3,):
        if "min" not in scene or "max" not in scene:
            raise ValueError("scene box needs centre/halfExtents or min/max")
        lo, hi = np.asarray(scene["min"], dtype=np.float64), np.asarray(scene["max"], dtype=np.float64)
        centre, half = (lo + hi) / 2, (hi - lo) / 2
    yaw = float(scene.get("yawDeg", 0.0)) * np.pi / 180.0
    if not np.isfinite(centre).all() or not np.isfinite(half).all() or (half <= 0).any():
        raise ValueError("scene box has invalid dimensions")
    return centre, half, yaw


def segment_hits_box(origin: np.ndarray, point: np.ndarray, scene: dict[str, Any]) -> bool:
    centre, half, yaw = _box(scene)
    c, s = np.cos(yaw), np.sin(yaw)

    def local(p: np.ndarray) -> np.ndarray:
        q = p - centre
        return np.array([c * q[0] - s * q[2], q[1], s * q[0] + c * q[2]])

    o, q = local(origin), local(point)
    enter, exit = -np.inf, np.inf
    for axis in range(3):
        d = q[axis] - o[axis]
        if abs(d) < 1e-12:
            if abs(o[axis]) > half[axis]:
                return False
            continue
        a, b = (-half[axis] - o[axis]) / d, (half[axis] - o[axis]) / d
        enter, exit = max(enter, min(a, b)), min(exit, max(a, b))
    return enter <= exit and exit > 1e-9 and enter < 1 - 1e-9


def truth_reference_error(study_item: Any, label: str) -> str | None:
    """Require todo-4's explicit truth-preferred arm/leg labels."""
    if not isinstance(study_item, dict):
        return f"{label}: missing study-2d item"
    if study_item.get("status") != "ok":
        return f"{label}: study-2d status is {study_item.get('status')!r}"
    swaps = study_item.get("swaps")
    frames = swaps.get("frames") if isinstance(swaps, dict) else None
    if not isinstance(frames, dict) or not isinstance(frames.get("arms"), list) or not isinstance(frames.get("legs"), list):
        return f"{label}: missing explicit swaps.frames.arms/legs truth labels"
    if any(not isinstance(frame, int) or frame < 0 for group in ("arms", "legs") for frame in frames[group]):
        return f"{label}: malformed truth swap frame labels"
    return None


def expected_assignments(study_item: dict[str, Any], frames: int) -> np.ndarray:
    """Convert todo-4's per-group truth-preferred swap frames to permutations."""
    arms = set(study_item.get("swaps", {}).get("frames", {}).get("arms", []))
    legs = set(study_item.get("swaps", {}).get("frames", {}).get("legs", []))
    out = np.empty((frames, 17), dtype=np.int64)
    identity = state_permutation("identity")
    arm_perm = state_permutation("arms_swap")
    leg_perm = state_permutation("legs_swap")
    full_perm = state_permutation("full_swap")
    for t in range(frames):
        if t in arms and t in legs:
            out[t] = full_perm
        elif t in arms:
            out[t] = arm_perm
        elif t in legs:
            out[t] = leg_perm
        else:
            out[t] = identity
    return out


def truth_visibility(item: dict[str, Any], frames: int, joints: dict[str, Any]) -> np.ndarray:
    visible = np.ones((frames, 17), dtype=bool)
    if not item.get("scene"):
        return visible
    scene = json.loads(Path(item["scene"]).read_text())
    origin = np.asarray(joints.get("cameraPosition", [0, 0, 0]), dtype=np.float64)
    if not np.isfinite(origin).all() or np.linalg.norm(origin) == 0:
        camera_path = Path(item["dir"]) / item["variant"] / "camera.json"
        camera = json.loads(camera_path.read_text())
        pos = camera.get("position")
        if isinstance(pos, dict):
            origin = np.array([pos["x"], pos["y"], pos["z"]], dtype=np.float64)
        else:
            origin = np.asarray(pos, dtype=np.float64)
    names = [joint["name"] if isinstance(joint, dict) else joint for joint in joints["joints"]]
    index = {name: i for i, name in enumerate(names)}
    world = np.asarray(joints["world"], dtype=np.float64)
    for coco, rig_name in COCO_TO_RIG.items():
        points = world[:frames, index[rig_name], :]
        for t, point in enumerate(points):
            visible[t, coco] = not segment_hits_box(origin, point, scene)
    return visible


def evaluate_item(item: dict[str, Any], study_by_item: dict[str, Any], obs_root: Path, delta_px: float) -> dict[str, Any]:
    label = f"{item['set']}/{item['name']}"
    reference = study_by_item.get(label)
    reference_error = truth_reference_error(reference, label)
    if reference_error:
        return {"item": label, "status": "missing-truth-reference", "error": reference_error}
    obs_path = obs_root / item["set"] / item["name"] / "g5" / "obs.npz"
    if not obs_path.exists():
        return {"item": label, "status": "missing-obs", "obsPath": str(obs_path)}
    variant_dir = Path(item["dir"]) / item["variant"]
    joints = json.loads((variant_dir / "joints.json").read_text())
    obs = read_npz(obs_path)
    if obs.ndim != 3 or obs.shape[1] != 17 or obs.shape[2] < 2:
        raise ValueError(f"{label}: kp2d has invalid shape {obs.shape}")
    names = [joint["name"] if isinstance(joint, dict) else joint for joint in joints["joints"]]
    index = {name: i for i, name in enumerate(names)}
    uv = np.full((len(joints["world"]), 17, 2), np.nan, dtype=np.float64)
    for coco, rig_name in COCO_TO_RIG.items():
        uv[:, coco] = np.asarray(joints["uv"], dtype=np.float64)[: uv.shape[0], index[rig_name], :2]
    frames = min(obs.shape[0], uv.shape[0])
    obs, projected = obs[:frames], uv[:frames]
    visible = truth_visibility(item, frames, joints)
    result = solve_lr_viterbi(obs, projected, visibility=visible, deltaPx=delta_px)
    expected = expected_assignments(reference, frames)
    valid = np.isfinite(obs[..., :2]).all(axis=2) & (obs[..., 2] > 0 if obs.shape[2] >= 3 else True)
    correct = raw_correct = total = 0
    # Agreement is deliberately measured only on visible bilateral observations,
    # never on box-occluded joints or absent detector points.
    for t in range(frames):
        for left, right in ARM_PAIRS + LEG_PAIRS:
            if not (visible[t, left] and visible[t, right]):
                continue
            if not (valid[t, left] and valid[t, right]):
                continue
            for joint in (left, right):
                total += 1
                correct += int(result["assignments"][t, joint] == expected[t, joint])
                raw_correct += int(joint == expected[t, joint])
    return {
        "item": label,
        "status": "ok",
        "frames": frames,
        "deltaPx": delta_px,
        "agreement": correct / total if total else None,
        "correct": correct,
        "rawAgreement": raw_correct / total if total else None,
        "rawCorrect": raw_correct,
        "visibleBilateralPairs": total // 2,
        "visibleBilateralJointLabels": total,
        "switches": result["switches"],
        "stateCounts": result["state_counts"],
        "ambiguousFrames": int(np.count_nonzero(result["ambiguous"])),
        "medianMargin": float(np.median(result["margins"])) if frames else None,
    }


def parse_args() -> argparse.Namespace:
    here = Path(__file__).resolve()
    root = next((parent for parent in here.parents if (parent / "evidence/obs/approved.json").exists()), Path.cwd())
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--summary", type=Path, default=root / "evidence/obs/study-2d/summary.json")
    parser.add_argument("--approved", type=Path, default=root / "evidence/obs/approved.json")
    parser.add_argument("--obs-root", type=Path, default=root / "evidence/obs/cache")
    parser.add_argument("--delta-px", type=float, default=None)
    parser.add_argument("--out", type=Path, default=None)
    return parser.parse_args()


def main() -> int:
    args = parse_args()
    summary = json.loads(args.summary.read_text())
    delta_px = args.delta_px if args.delta_px is not None else summary.get("deltaPx")
    if not isinstance(delta_px, (int, float)) or not np.isfinite(delta_px) or delta_px <= 0:
        raise SystemExit("eval_lr: summary must provide a finite positive deltaPx (or pass --delta-px)")
    approved = json.loads(args.approved.read_text())
    study_items = (summary.get("study2d") or {}).get("items", [])
    study_by_item = {row.get("item"): row for row in study_items if isinstance(row, dict)}
    truth_items = [item for item in approved["items"] if item.get("set") in {"gt", "cube"}]
    results = [evaluate_item(item, study_by_item, args.obs_root, float(delta_px)) for item in truth_items]
    valid = [row for row in results if row["status"] == "ok" and row["agreement"] is not None]
    total = sum(row["visibleBilateralJointLabels"] for row in valid)
    correct = sum(row["correct"] for row in valid)
    raw_correct = sum(row["rawCorrect"] for row in valid)
    output = {
        "tool": "tools/track/py/eval_lr.py",
        "summary": str(args.summary),
        "deltaPx": float(delta_px),
        "items": results,
        "agreement": correct / total if total else None,
        "correct": correct,
        "rawAgreement": raw_correct / total if total else None,
        "rawCorrect": raw_correct,
        "visibleBilateralJointLabels": total,
        "itemsOk": len(valid),
        "itemsTotal": len(results),
        "pass": bool(len(valid) == len(results) and total and correct / total >= 0.95),
    }
    out = args.out or args.summary.with_name("eval-lr.json")
    out.parent.mkdir(parents=True, exist_ok=True)
    out.write_text(json.dumps(output, indent=2) + "\n")
    print(json.dumps(output, indent=2))
    return 0 if output["pass"] else 1


if __name__ == "__main__":
    raise SystemExit(main())

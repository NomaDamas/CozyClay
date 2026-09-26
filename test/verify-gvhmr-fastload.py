"""Run with the GPU host's torch environment; no GPU or real weights needed."""
import sys
import tempfile
from pathlib import Path

import torch

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "tools/ardy"))
from gvhmr_fastpath import checked_fast_load


original_init, original_load = torch.nn.init.normal_, torch.load
reference = torch.nn.Linear(3, 2)
state = reference.state_dict()
with checked_fast_load():
    actual = torch.nn.Linear(3, 2)
    actual.load_state_dict(state)
assert all(torch.equal(v, actual.state_dict()[k]) for k, v in state.items())
assert torch.nn.init.normal_ is original_init and torch.load is original_load

try:
    with checked_fast_load():
        uncovered = torch.nn.Linear(3, 2)
        actual = torch.nn.Linear(3, 2)
        actual.load_state_dict(state)
except RuntimeError as exc:
    assert "uncovered" in str(exc)
else:
    raise AssertionError("unloaded parameters were accepted")

try:
    with checked_fast_load():
        actual = torch.nn.Linear(3, 2)
        actual.load_state_dict({"weight": state["weight"]}, strict=False)
except RuntimeError as exc:
    assert "incomplete-checkpoint" in str(exc)
else:
    raise AssertionError("partial checkpoint was accepted")
assert torch.nn.init.normal_ is original_init and torch.load is original_load

with tempfile.TemporaryDirectory(prefix="gvhmr-fastload-test-") as directory:
    for legacy in (False, True):
        checkpoint = Path(directory) / f"{legacy}.pth"
        torch.save(state, checkpoint, _use_new_zipfile_serialization=not legacy)
        with checked_fast_load():
            actual = torch.nn.Linear(3, 2)
            actual.load_state_dict(torch.load(checkpoint, map_location="cpu"))
        assert all(torch.equal(v, actual.state_dict()[k]) for k, v in state.items())
print("PASS full checkpoint parity, uncovered/partial rejection, patch restoration, mmap and legacy fallback")

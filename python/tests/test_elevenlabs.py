import copy
import json
import sys
from decimal import Decimal
from pathlib import Path

import pytest

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from llm_info import LlmInfo, MemoryStore
from llm_info._engine import calculate

ROOT = Path(__file__).resolve().parents[2]
DATA = json.loads((ROOT / "tests/fixtures/llm-info-snapshot.json").read_text())
CASES = json.loads((ROOT / "tests/fixtures/elevenlabs-calc.json").read_text())


@pytest.mark.parametrize("case", CASES, ids=lambda c: c["name"])
def test_elevenlabs_calculations(case):
    data = copy.deepcopy(DATA)
    for model in data["models"]:
        if model["provider"] == "elevenlabs" and model["id"] == case["model"]:
            model.update(case.get("overrides", {}))
    info = LlmInfo(store=MemoryStore(), fetch=lambda u, e: (200, None, data))
    info.load()
    result = info.calc(
        "elevenlabs",
        case["model"],
        case["usage"],
        mode=case.get("mode", "standard"),
        region=case.get("region", "global"),
    )
    if case["expected"] is None:
        assert result is None
    else:
        assert abs(result["total_usd"] - Decimal(str(case["expected"]))) < Decimal(
            "1e-10"
        )
        assert result["extra_usd"] == result["total_usd"]
        assert result["warnings"] == case["warnings"]


@pytest.mark.parametrize("value", [float("nan"), float("inf"), float("-inf")])
@pytest.mark.parametrize(
    "field,price",
    [
        ("characters", "per_character"),
        ("input_audio_seconds", "per_input_audio_second"),
        ("output_audio_seconds", "per_output_audio_second"),
    ],
)
def test_invalid_unit_usage(field, price, value):
    result = calculate(
        {"provider": "elevenlabs", "id": "synthetic", "prices": {price: 0.002}},
        {field: value},
    )
    assert result["total_usd"] == 0
    assert result["warnings"] == ["invalid_usage:" + field]

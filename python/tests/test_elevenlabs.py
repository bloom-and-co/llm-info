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
        assert abs(result["total_credits"] - Decimal(str(case["expected"]))) < Decimal(
            "1e-10"
        )
        assert result["extra_credits"] == result["total_credits"]
        assert result["price_unit"] == "credit"
        for key in ("total_usd", "input_usd", "output_usd", "extra_usd"):
            assert result[key] is None
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
        {
            "provider": "elevenlabs",
            "id": "synthetic",
            "price_unit": "credit",
            "prices": {price: 0.002},
        },
        {field: value},
    )
    assert result["total_usd"] is None
    assert result["total_credits"] == 0
    assert result["warnings"] == ["invalid_usage:" + field]


@pytest.mark.parametrize("provider", ["openai", "anthropic", "google", "x-ai"])
def test_original_usd_output_shape(provider):
    info = LlmInfo(store=MemoryStore(), fetch=lambda u, e: (200, None, DATA))
    info.load()
    model = next(
        m for m in DATA["models"] if m["provider"] == provider and m["mode"] == "chat"
    )
    result = info.calc(
        provider, model["id"], {"input_tokens": 1000, "output_tokens": 100}
    )
    assert set(result) == {
        "total_usd",
        "input_usd",
        "output_usd",
        "extra_usd",
        "warnings",
        "provider",
        "model",
        "requested_model",
        "usage",
        "data_version",
    }
    assert isinstance(result["total_usd"], Decimal)
    assert all("price_unit" not in m for m in info.models(provider))
    assert "price_unit" not in info.capabilities(provider, model["id"])
    assert all(m["price_unit"] == "credit" for m in info.models("elevenlabs"))
    assert info.capabilities("elevenlabs", "scribe_v2")["price_unit"] == "credit"


def test_legacy_usd_cache_requires_refresh():
    old = copy.deepcopy(DATA)
    row = next(
        m
        for m in old["models"]
        if m["provider"] == "elevenlabs" and m["id"] == "eleven_v3"
    )
    del row["price_unit"]
    row["prices"] = {"per_character": 0.00018}
    source = old
    info = LlmInfo(store=MemoryStore(), fetch=lambda u, e: (200, None, source))
    info.load()
    assert info.calc("elevenlabs", "eleven_v3", {"characters": 1000}) is None
    source = DATA
    info.refresh(force=True)
    result = info.calc("elevenlabs", "eleven_v3", {"characters": 1000})
    assert result["total_credits"] == 1000
    assert result["total_usd"] is None
    assert result["price_unit"] == "credit"


def test_realtime_catalog_mode():
    info = LlmInfo(store=MemoryStore(), fetch=lambda u, e: (200, None, DATA))
    info.load()
    model = next(m for m in info.models("elevenlabs") if m["id"] == "scribe_v2_realtime")
    assert model["mode"] == "realtime"
    assert model["price_unit"] == "credit"
    capabilities = info.capabilities("elevenlabs", "scribe_v2_realtime")
    assert capabilities["mode"] == "realtime"
    assert capabilities["price_unit"] == "credit"
    assert capabilities["input_modalities"] == ["audio"]
    assert capabilities["output_modalities"] == ["text"]
    assert capabilities["endpoints"] == ["/v1/speech-to-text/realtime"]
    assert info.capabilities("elevenlabs", "scribe_v2")["mode"] == "audio_transcription"

import json
import sys
import time
from decimal import Decimal
from pathlib import Path

import pytest

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from llm_info import FileStore, LlmInfo, MemoryStore, PricesNotLoadedError

DATA = json.loads(
    (Path(__file__).resolve().parents[2] / "data/llm-info.json").read_text()
)


def make(fetch=None, store=None, **kwargs):
    return LlmInfo(
        store=store or MemoryStore(),
        fetch=fetch or (lambda u, e: (200, "tag", DATA)),
        **kwargs,
    )


def test_schema_and_own_engine():
    assert DATA["schema"] == 2
    assert len({m["provider"] for m in DATA["models"]}) == 4
    p = make()
    p.load()
    assert p.calc("openai", "gpt-6-luna", {"input_tokens": 1000})[
        "total_usd"
    ] == Decimal("0.0001")


def test_not_loaded():
    with pytest.raises(PricesNotLoadedError):
        make().calc("openai", "gpt-6-luna", {"input_tokens": 1})


def test_missing_modality_breakdowns_use_expensive_plausible_prices():
    from llm_info._engine import calculate

    image = {
        "provider": "openai",
        "id": "image",
        "mode": "image_generation",
        "prices": {
            "input": 5,
            "input_image": 8,
            "cache_read": 1.25,
            "cache_image_read": 2,
            "output": 10,
            "output_image": 32,
        },
        "capabilities": {
            "input_modalities": ["image", "text"],
            "output_modalities": ["image", "text"],
        },
    }
    missing = calculate(
        image, {"input_tokens": 50, "cache_read_tokens": 20, "output_tokens": 4160}
    )
    assert missing["input_usd"] == Decimal("0.00028")
    assert missing["output_usd"] == Decimal("0.13312")
    assert {
        "output_breakdown_missing",
        "input_breakdown_missing",
        "cache_breakdown_missing",
    } <= set(missing["warnings"])
    exact = calculate(
        image,
        {
            "input_tokens": 50,
            "input_breakdown_present": 1,
            "input_image_tokens": 10,
            "cache_read_tokens": 20,
            "cache_breakdown_present": 1,
            "cache_image_read_tokens": 5,
            "output_tokens": 100,
            "output_breakdown_present": 1,
            "output_image_tokens": 40,
        },
    )
    assert exact["output_usd"] == Decimal("0.00188")
    assert "output_breakdown_missing" not in exact["warnings"]
    audio = {
        **image,
        "mode": "audio_transcription",
        "prices": {"input": 1, "input_audio": 10, "output": 2},
        "capabilities": {
            "input_modalities": ["audio", "text"],
            "output_modalities": ["text"],
        },
    }
    assert calculate(audio, {"input_tokens": 100})["input_usd"] == Decimal("0.001")


def test_image_response_without_output_details():
    p = make()
    p.load()
    result = p.from_response(
        "openai",
        {
            "model": "gpt-image-1.5",
            "usage": {"input_tokens": 50, "output_tokens": 4160},
            "data": [{}],
        },
        api_flavor="openai-images",
    )
    assert result["total_usd"] == Decimal("0.13352")
    assert "output_breakdown_missing" in result["warnings"]


def test_gemini_partial_and_complete_output_details():
    p = make()
    p.load()

    def response(tokens):
        return {
            "modelVersion": "gemini-3.1-flash-image",
            "usageMetadata": {
                "promptTokenCount": 0,
                "candidatesTokenCount": 100,
                "candidatesTokensDetails": [{"modality": "TEXT", "tokenCount": tokens}],
            },
        }

    partial = p.from_response("google", response(50))
    assert partial["output_usd"] == Decimal("0.00315")
    assert "output_breakdown_missing" in partial["warnings"]
    complete = p.from_response("google", response(100))
    assert complete["output_usd"] == Decimal("0.0003")
    assert "output_breakdown_missing" not in complete["warnings"]


def test_one_hour_cache_write_price_fallback():
    from llm_info._engine import calculate

    model = {
        "provider": "anthropic",
        "id": "unit",
        "prices": {"input": 4, "output": 20, "cache_write": 5},
    }
    cost = calculate(
        model, {"input_tokens": 1_000_000, "cache_write_1h_tokens": 1_000_000}
    )
    assert cost["total_usd"] == Decimal(8)
    assert "fallback_price:cache_write_1h" in cost["warnings"]
    model["prices"]["cache_write"] = 12
    assert calculate(
        model, {"input_tokens": 1_000_000, "cache_write_1h_tokens": 1_000_000}
    )["total_usd"] == Decimal(12)
    model["prices"] = {
        "input": 4,
        "cache_write_1h": 8,
        "tiers": [
            {
                "above_input_tokens": 200_000,
                "prices": {"input": 8, "cache_write_1h": 16},
            }
        ],
    }
    model["modes"] = {"fast": {"prices": {"input": 8}}}
    mode = calculate(
        model,
        {"input_tokens": 1_000_000, "cache_write_1h_tokens": 1_000_000},
        mode="fast",
    )
    assert mode["total_usd"] == Decimal(32)


def test_load_and_four_providers():
    p = make()
    p.load()
    for provider, model, expected in [
        ("openai", "gpt-6-luna", "0.0006"),
        ("anthropic", "claude-opus-5-5", "0.024"),
        ("google", "gemini-3.8-flash", "0.00450"),
        ("x-ai", "grok-4.7", "0.008"),
    ]:
        assert p.calc(provider, model, {"input_tokens": 1000, "output_tokens": 1000})[
            "total_usd"
        ] == Decimal(expected)
    assert (
        p.calc("openai", "gpt-6-luna-2026-09-22", {"input_tokens": 1})["model"]
        == "gpt-6-luna"
    )
    assert p.calc("openai", "unknown", {"input_tokens": 1}) is None
    assert p.calc("openai", "text-davinci-003", {"input_tokens": 1}) is None


def test_capabilities_modes_and_region():
    p = make()
    p.load()
    assert p.capabilities("openai", "gpt-6-luna-2026-09-22")["reasoning_efforts"] == [
        "none",
        "low",
        "medium",
        "high",
        "xhigh",
        "max",
    ]
    assert p.capabilities("google", "gemini-3.8-flash")["reasoning_efforts"] == [
        "low",
        "medium",
        "high",
    ]
    assert p.capabilities("x-ai", "grok-4.7")["web_search"] is True
    assert p.capabilities("anthropic", "claude-opus-5-5")["temperature"] is False
    assert any(row["id"] == "gpt-6-luna" for row in p.models("openai"))
    assert (
        next(row for row in p.models("openai") if row["id"] == "gpt-6-luna")["mode"]
        == "chat"
    )
    assert p.capabilities("anthropic", "claude-mythos-5")["mode"] == "chat"
    assert p.capabilities("openai", "unknown") is None
    usage = {"input_tokens": 1000, "output_tokens": 1000}
    assert p.calc("anthropic", "claude-opus-5-5", usage, mode="fast")[
        "total_usd"
    ] == Decimal("0.048")
    assert p.from_response(
        "openai", {"model": "gpt-6-luna", "service_tier": "priority", "usage": usage}
    )["total_usd"] == Decimal("0.0012")
    assert p.calc("openai", "gpt-6-luna", usage, region="us")["total_usd"] == Decimal(
        "0.00066"
    )
    missing = p.calc("x-ai", "grok-4.7", usage, mode="fast")
    assert "missing_price:mode:fast" in missing["warnings"]
    assert missing["total_usd"] >= Decimal("0.008")


def test_fallback_304_and_failure():
    calls = []

    def fetch(url, etag):
        calls.append(url)
        if len(calls) == 1:
            raise RuntimeError("network")
        if len(calls) == 2:
            return 200, "tag", DATA
        return 304, "tag", None

    p = make(fetch, fallback_urls=["fallback"])
    p.load()
    assert calls == [p.url, "fallback"]
    assert p.refresh(force=True)["status"] == "not_modified"
    p.fetch = lambda u, e: (_ for _ in ()).throw(RuntimeError("offline"))
    assert p.refresh(force=True)["status"] == "error"
    assert p.info()["last_error"] == "offline"


def test_rejections():
    current = [DATA]
    p = make(
        lambda u, e: (200, None, current[0]),
        accept=lambda n, p: n["version"] != "veto",
        fallback_urls=[],
    )
    p.load()
    current[0] = {}
    assert p.refresh(force=True)["reason"] == "invalid_shape"
    current[0] = {**DATA, "generated_at": "2000-01-01T00:00:00Z"}
    assert p.refresh(force=True)["reason"] == "older_data"
    current[0] = {**DATA, "version": "veto"}
    assert p.refresh(force=True)["reason"] == "accept_false"


def test_stale_background_refresh():
    old = {
        "cache_schema": 1,
        "source_url": "x",
        "fetched_at": "2000-01-01T00:00:00Z",
        "etag": None,
        "last_attempt_at": "x",
        "last_error": None,
        "data": DATA,
    }
    p = make(store=MemoryStore(old))
    assert p.load()["stale"]
    assert p.calc("openai", "gpt-6-luna", {"input_tokens": 1})
    for _ in range(100):
        if not p.info()["stale"]:
            break
        time.sleep(0.01)
    assert not p.info()["stale"]


def test_stores(tmp_path):
    d = {"cache_schema": 1, "data": DATA}
    s = FileStore(tmp_path / "llm-info.json")
    s.write(d)
    s.write({**d, "data": {**DATA, "generated_at": "2000-01-01T00:00:00Z"}})
    assert s.read()["data"]["version"] == DATA["version"]
    assert [x.name for x in tmp_path.iterdir()] == ["llm-info.json"]
    m = MemoryStore(d)
    m.write({**d, "data": {**DATA, "generated_at": "2000-01-01T00:00:00Z"}})
    assert m.read()["data"]["version"] == DATA["version"]


def test_response_totals():
    p = make()
    p.load()
    chat = p.from_response(
        "openai",
        {
            "model": "gpt-6-luna",
            "usage": {"prompt_tokens": 1000, "completion_tokens": 100},
        },
        api_flavor="chat",
    )
    assert chat["total_usd"] == Decimal(".00015")
    ant = p.from_response(
        "anthropic",
        {
            "model": "claude-opus-5-5",
            "usage": {
                "input_tokens": 1000,
                "output_tokens": 200,
                "cache_creation_input_tokens": 100,
                "cache_read_input_tokens": 50,
            },
        },
    )
    assert ant["total_usd"] == Decimal(".00851")
    for usage, expected, five_minute, one_hour in [
        (
            {
                "input_tokens": 0,
                "cache_creation_input_tokens": 1_000_000,
                "cache_creation": {
                    "ephemeral_5m_input_tokens": 0,
                    "ephemeral_1h_input_tokens": 1_000_000,
                },
            },
            "8",
            0,
            1_000_000,
        ),
        (
            {
                "input_tokens": 0,
                "cache_creation_input_tokens": 1_000_000,
                "cache_creation": {
                    "ephemeral_5m_input_tokens": 500_000,
                    "ephemeral_1h_input_tokens": 500_000,
                },
            },
            "6.5",
            500_000,
            500_000,
        ),
        (
            {"input_tokens": 0, "cache_creation_input_tokens": 1_000_000},
            "5",
            1_000_000,
            0,
        ),
    ]:
        cost = p.from_response(
            "anthropic", {"model": "claude-opus-5-5", "usage": usage}
        )
        assert cost["total_usd"] == Decimal(expected)
        assert cost["usage"].get("cache_write_tokens", 0) == five_minute
        assert cost["usage"].get("cache_write_1h_tokens", 0) == one_hour
    gem = p.from_response(
        "google",
        {
            "modelVersion": "gemini-3.8-flash",
            "usageMetadata": {"promptTokenCount": 1000, "candidatesTokenCount": 100},
        },
    )
    assert gem["total_usd"] == Decimal(".001125")
    x = p.from_response(
        "x-ai",
        {
            "model": "grok-4.7",
            "usage": {"prompt_tokens": 1000, "completion_tokens": 100},
        },
    )
    assert x["total_usd"] == Decimal(".0026")


def test_image_video_and_warnings():
    p = make()
    p.load()
    assert p.from_response(
        "google",
        {"generatedImages": [{}, {}]},
        request={"model": "imagen-3.0-fast-generate-001"},
    )["extra_usd"] == Decimal(".04")
    assert p.from_response(
        "google", {}, request={"model": "veo-3.1-generate-001", "duration": 5}
    )["extra_usd"] == Decimal("2.0")
    assert (
        "missing_price:per_image"
        in p.calc("openai", "gpt-6-luna", {"output_images": 1})["warnings"]
    )


def test_all_response_fixtures():
    p = make()
    p.load()
    fixtures = json.loads(
        (
            Path(__file__).resolve().parents[2] / "tests/fixtures/responses.json"
        ).read_text()
    )
    for f in fixtures:
        cost = p.from_response(
            f["provider"],
            f["response"],
            f.get("request"),
            f.get("apiFlavor"),
            model=f.get("model"),
        )
        assert abs(cost["total_usd"] - Decimal(str(f["expected"]))) < Decimal(
            "0.000000001"
        ), f["name"]
        for key, value in f.get("expectedUsage", {}).items():
            assert cost["usage"].get(key) == value, f["name"]
        for warning in f.get("expectedWarnings", []):
            assert warning in cost["warnings"], f["name"]


def test_response_flavor_validation_and_unextracted_usage():
    p = make()
    p.load()
    with pytest.raises(ValueError, match="Unknown apiFlavor"):
        p.from_response(
            "google", {"model": "gemini-3.8-flash"}, api_flavor="unsupported"
        )
    cost = p.from_response(
        "google",
        {"model": "gemini-3.8-flash", "usage": {"prompt_tokens": 10}},
        api_flavor="gemini-generate-content",
    )
    assert "usage_not_extracted" in cost["warnings"]


def test_size_resolution_prices():
    p = make()
    p.load()
    image = p.calc(
        "openai",
        "gpt-image-1",
        {"output_images": 1},
        options={"size": "1024x1024", "quality": "high"},
    )
    assert abs(image["extra_usd"] - Decimal(".167")) < Decimal(".000001")
    video = p.calc(
        "google",
        "veo-3.1-lite-generate-preview",
        {"output_video_seconds": 2},
        options={"resolution": "1080p"},
    )
    assert video["extra_usd"] == Decimal(".16")


def test_google_image_extractor_once():
    p = make()
    p.load()
    fixture = {
        "modelVersion": "gemini-3.1-flash-image",
        "usageMetadata": {
            "promptTokenCount": 100,
            "candidatesTokenCount": 100,
            "candidatesTokensDetails": [{"modality": "IMAGE", "tokenCount": 50}],
        },
    }
    assert p.extract_usage("google", fixture)["usage"]["output_image_tokens"] == 50


def test_gemini_text_and_image_output_have_separate_rates():
    p = make()
    p.load()
    cost = p.from_response(
        "google",
        {
            "modelVersion": "gemini-3.1-flash-image",
            "usageMetadata": {
                "promptTokenCount": 100,
                "candidatesTokenCount": 100,
                "candidatesTokensDetails": [{"modality": "IMAGE", "tokenCount": 50}],
            },
        },
    )
    # 100 input × $0.50/M + 50 text output × $3/M + 50 image output × $60/M.
    assert cost["input_usd"] == Decimal("0.00005")
    assert cost["output_usd"] == Decimal("0.00315")
    assert cost["total_usd"] == Decimal("0.0032")


def test_dated_image_audio_video_null_and_tools():
    p = make()
    p.load()
    assert p.calc("openai", "gpt-4o-2024-05-13", {"input_tokens": 1_000_000})[
        "input_usd"
    ] == Decimal(5)
    assert p.from_response(
        "openai",
        {"usage": {"output_tokens": 1_000_000}, "data": [{}]},
        {"model": "gpt-image-2"},
        "images",
    )["output_usd"] == Decimal(30)
    u = p.extract_usage(
        "google",
        {
            "modelVersion": "gemini-3.8-flash",
            "usageMetadata": {
                "promptTokenCount": 100,
                "toolUsePromptTokenCount": 20,
                "cachedContentTokenCount": 10,
                "candidatesTokenCount": 10,
                "promptTokensDetails": [{"modality": "AUDIO", "tokenCount": 30}],
                "cacheTokensDetails": [{"modality": "AUDIO", "tokenCount": 5}],
                "candidatesTokensDetails": [{"modality": "AUDIO", "tokenCount": 4}],
                "toolUsePromptTokensDetails": [{"modality": "AUDIO", "tokenCount": 3}],
            },
        },
    )["usage"]
    assert (
        u["input_tokens"] == 120
        and u["input_audio_tokens"] == 33
        and u["cache_audio_read_tokens"] == 5
        and u["output_audio_tokens"] == 4
    )
    assert p.from_response(
        "google",
        {
            "modelVersion": "gemini-2.5-flash-image",
            "usageMetadata": {
                "promptTokenCount": 100,
                "candidatesTokenCount": 50,
                "thoughtsTokenCount": 10,
                "candidatesTokensDetails": [{"modality": "IMAGE", "tokenCount": 50}],
            },
        },
    )["output_usd"] > Decimal(".0015")
    assert p.from_response(
        "google",
        {"generatedVideos": [{}, {}]},
        {"model": "veo-3.1-generate-001", "parameters": {"durationSeconds": "5"}},
    )["extra_usd"] == Decimal(4)
    assert (
        p.from_response("openai", {"seconds": "5"}, {"model": "sora-2"})["extra_usd"]
        > 0
    )
    assert p.from_response("openai", {}, {"model": "sora-2"})["extra_usd"] > 0
    assert (
        "missing_param:duration"
        in p.from_response("openai", {}, {"model": "sora-2"})["warnings"]
    )
    p.from_response(
        "openai",
        {
            "model": "gpt-4o",
            "usage": {
                "prompt_tokens": 10,
                "completion_tokens": 1,
                "prompt_tokens_details": None,
            },
        },
    )
    p.from_response(
        "google",
        {
            "modelVersion": "gemini-3.8-flash",
            "usageMetadata": {"promptTokenCount": 10, "thoughtsTokenCount": None},
        },
    )
    assert p.from_response(
        "google", {"predictions": [{}, {}]}, {"model": "imagen-3.0-fast-generate-001"}
    )["extra_usd"] == Decimal(".04")
    assert p.from_response(
        "x-ai",
        {
            "model": "grok-4.7",
            "usage": {
                "prompt_tokens": 100,
                "completion_tokens": 10,
                "completion_tokens_details": {"reasoning_tokens": 20},
            },
        },
    )["output_usd"] == Decimal(".00018")
    a = p.from_response(
        "anthropic",
        {
            "model": "claude-opus-5-5",
            "usage": {
                "input_tokens": 1,
                "output_tokens": 1,
                "server_tool_use": {"web_search_requests": 2},
            },
        },
    )
    assert a["usage"]["web_searches"] == 2
    assert a["extra_usd"] == Decimal("0.02")


def test_unpriced_web_search_warning():
    p = make()
    p.load()
    cost = p.calc("openai", "chat-latest", {"input_tokens": 1, "web_searches": 1})
    assert "missing_price:web_search" in cost["warnings"]


def test_xai_image_default_without_size():
    p = make()
    p.load()
    cost = p.from_response(
        "x-ai", {"data": [{}]}, {"model": "grok-imagine-image-2.0"}, "images"
    )
    assert cost["extra_usd"] == Decimal(".06")
    assert "missing_param:size" not in cost["warnings"]


def test_xai_responses_reasoning_is_in_output_total():
    p = make()
    p.load()
    cost = p.from_response(
        "x-ai",
        {
            "object": "response",
            "model": "grok-4.7",
            "usage": {
                "input_tokens": 100,
                "output_tokens": 30,
                "output_tokens_details": {"reasoning_tokens": 20},
            },
        },
        api_flavor="responses",
    )
    assert cost["output_usd"] == Decimal("0.00018")


def test_openai_compatible_output_recovers_total_gap():
    p = make()
    p.load()
    cases = [
        (
            "google",
            "openai-chat",
            "gemini-3.5-flash",
            {"prompt_tokens": 2000, "completion_tokens": 600, "total_tokens": 3000},
            1000,
            True,
        ),
        (
            "x-ai",
            "xai-chat",
            "grok-4.7",
            {
                "prompt_tokens": 100,
                "completion_tokens": 10,
                "total_tokens": 150,
                "completion_tokens_details": {"reasoning_tokens": 20},
            },
            50,
            True,
        ),
        (
            "x-ai",
            "xai-chat",
            "grok-4.7",
            {
                "prompt_tokens": 100,
                "completion_tokens": 10,
                "total_tokens": 130,
                "completion_tokens_details": {"reasoning_tokens": 20},
            },
            30,
            False,
        ),
        (
            "openai",
            "openai-chat",
            "gpt-6-luna",
            {
                "prompt_tokens": 100,
                "completion_tokens": 30,
                "total_tokens": 130,
                "completion_tokens_details": {"reasoning_tokens": 20},
            },
            30,
            False,
        ),
        (
            "google",
            "openai-responses",
            "gemini-3.5-flash",
            {"input_tokens": 2000, "output_tokens": 600, "total_tokens": 3000},
            1000,
            True,
        ),
        (
            "x-ai",
            "xai-responses",
            "grok-4.7",
            {
                "input_tokens": 100,
                "output_tokens": 30,
                "total_tokens": 150,
                "output_tokens_details": {"reasoning_tokens": 20},
            },
            50,
            True,
        ),
    ]
    for provider, flavor, model, usage, output, warned in cases:
        response = {"model": model, "usage": usage}
        assert (
            p.extract_usage(provider, response, api_flavor=flavor)["usage"][
                "output_tokens"
            ]
            == output
        )
        cost = p.from_response(provider, response, api_flavor=flavor)
        assert cost["usage"]["output_tokens"] == output
        assert ("output_from_total" in cost["warnings"]) == warned


def test_requested_model_override_controls_reasoning_and_pricing():
    p = make()
    p.load()
    for model, output_price, reasoning_price in [
        ("gemini-robotics-er-2-preview", 5, 10),
        ("gemini-omni-flash-preview", 17.5, 9),
    ]:
        for model_version in [None, "unknown-response-model"]:
            response = {
                "modelVersion": model_version,
                "usageMetadata": {
                    "promptTokenCount": 100,
                    "candidatesTokenCount": 10,
                    "thoughtsTokenCount": 20,
                },
            }
            extracted = p.extract_usage("google", response, model=model)
            assert extracted["model"] == model
            assert extracted["usage"]["output_reasoning_tokens"] == 20
            cost = p.from_response("google", response, model=model)
            assert cost["requested_model"] == model
            assert cost["output_usd"] == Decimal(
                str((10 * output_price + 20 * reasoning_price) / 1e6)
            )


def test_conservative_cache_overlap_and_fallback():
    from llm_info._engine import calculate

    model = {
        "prices": {
            "input": 1,
            "input_audio": 10,
            "cache_read": 0.1,
            "cache_audio_read": 2,
            "output": 3,
        },
        "capabilities": {},
    }
    usage = {
        "input_tokens": 1_000_000,
        "input_audio_tokens": 600_000,
        "cache_read_tokens": 500_000,
    }
    result = calculate(model, usage)
    assert result["input_usd"] == Decimal("5.24")
    assert "inconsistent_usage" not in result["warnings"]
    del model["prices"]["cache_audio_read"]
    fallback = calculate(model, usage)
    assert fallback["input_usd"] == Decimal("6.4")
    assert "fallback_price:cache_audio_read" in fallback["warnings"]


def test_veo_sdk_vertex_rest_and_operation_counts():
    p = make()
    p.load()
    request = {
        "model": "veo-3.1-generate-001",
        "config": {"durationSeconds": 5, "numberOfVideos": 2},
    }
    for response, expected in [
        ({}, 4),
        ({"videos": [{}, {}, {}]}, 6),
        ({"generateVideoResponse": {"generatedSamples": [{}, {}]}}, 4),
        (
            {
                "operation": {
                    "response": {
                        "generateVideoResponse": {"generatedSamples": [{}, {}]}
                    }
                }
            },
            4,
        ),
    ]:
        assert p.from_response("google", response, request)["extra_usd"] == Decimal(
            expected
        )


def test_included_reasoning_uses_disjoint_output_bucket():
    from llm_info._engine import calculate

    result = calculate(
        {"prices": {"output": 3, "reasoning": 5}},
        {"output_tokens": 100, "output_reasoning_tokens": 20},
    )
    assert result["output_usd"] == Decimal("0.00034")


def test_task6_long_context_invalid_usage_and_matching():
    from llm_info._engine import calculate, find_model

    data = json.loads(Path("data/llm-info.json").read_text())
    rows = data["models"]

    def model(provider, name):
        return next(m for m in rows if m["provider"] == provider and m["id"] == name)

    usage = {"input_tokens": 400000, "output_tokens": 10000}
    assert calculate(model("openai", "gpt-5.4"), usage, mode="priority")[
        "total_usd"
    ] == Decimal("4.45")
    assert calculate(model("openai", "gpt-6-luna"), usage, mode="fast")[
        "total_usd"
    ] == Decimal("0.175")
    assert calculate(model("google", "gemini-2.5-pro"), usage, mode="batch")[
        "total_usd"
    ] == Decimal("0.575")
    m = model("openai", "gpt-4o")
    assert calculate(m, {"input_tokens": "1000000"})["input_usd"] > 0
    bad = calculate(m, {"input_tokens": True, "output_tokens": "oops"}, region="JP")
    assert {
        "invalid_usage:input_tokens",
        "invalid_usage:output_tokens",
        "unknown_region:JP",
    } <= set(bad["warnings"])
    assert find_model(rows, "GOOGLE", "gemini-2.5-pro-001")["id"] == "gemini-2.5-pro"
    assert (
        find_model(rows, "anthropic", "anthropic.claude-opus-5-5")["id"]
        == "claude-opus-5-5"
    )

import json, sys, time
from pathlib import Path
from decimal import Decimal
import pytest

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from llm_prices import LlmPrices, MemoryStore, FileStore, PricesNotLoadedError
from llm_prices._sdk import snapshot_from_data

DATA = json.loads(
    (Path(__file__).resolve().parents[2] / "data/prices.json").read_text()
)


def make(fetch=None, store=None, **kwargs):
    return LlmPrices(
        store=store or MemoryStore(),
        fetch=fetch or (lambda u, e: (200, "tag", DATA)),
        **kwargs,
    )


def test_private_adapter():
    assert len(snapshot_from_data(DATA).providers) == 4
    assert snapshot_from_data(DATA).calc(
        __import__("genai_prices").types.Usage(input_tokens=1000),
        "gpt-6-luna",
        "openai",
        None,
        None,
    ).total_price == Decimal("0.0001")


def test_not_loaded():
    with pytest.raises(PricesNotLoadedError):
        make().calc("openai", "gpt-6-luna", {"input_tokens": 1})


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
    s = FileStore(tmp_path / "prices.json")
    s.write(d)
    s.write({**d, "data": {**DATA, "generated_at": "2000-01-01T00:00:00Z"}})
    assert s.read()["data"]["version"] == DATA["version"]
    assert [x.name for x in tmp_path.iterdir()] == ["prices.json"]
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
            f["provider"], f["response"], f.get("request"), f.get("apiFlavor")
        )
        assert abs(cost["total_usd"] - Decimal(str(f["expected"]))) < Decimal(
            "0.000000001"
        ), f["name"]


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


def test_sdk_google_image_extractor_once():
    fixture = {
        "modelVersion": "gemini-3.1-flash-image",
        "usageMetadata": {
            "promptTokenCount": 100,
            "candidatesTokenCount": 100,
            "candidatesTokensDetails": [{"modality": "IMAGE", "tokenCount": 50}],
        },
    }
    extracted = snapshot_from_data(DATA).extract_usage(fixture, provider_id="google")
    assert extracted.usage.output_image_tokens == 50


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

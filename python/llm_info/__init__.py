"""Cached LLM price estimates."""

from __future__ import annotations

import json
import os
import tempfile
import threading
import time
from datetime import datetime, timezone
from decimal import Decimal, InvalidOperation
from pathlib import Path
from typing import Protocol
from urllib.error import HTTPError
from urllib.request import Request, urlopen

from ._engine import calculate, find_model

DEFAULT_URL = (
    "https://raw.githubusercontent.com/bloom-and-co/llm-info/main/data/llm-info.json"
)
FALLBACK_URL = (
    "https://cdn.jsdelivr.net/gh/bloom-and-co/llm-info@main/data/llm-info.json"
)


class PricesNotLoadedError(RuntimeError):
    pass


class PriceStore(Protocol):
    def read(self) -> dict | None: ...
    def write(self, doc: dict) -> None: ...


def _date(s):
    return datetime.fromisoformat(s.replace("Z", "+00:00"))


def _now():
    return datetime.now(timezone.utc).isoformat().replace("+00:00", "Z")


def _valid(d):
    try:
        return bool(
            isinstance(d, dict)
            and d.get("schema") == 2
            and isinstance(d.get("version"), str)
            and isinstance(d.get("models"), list)
            and all(
                m.get("provider") and m.get("id") and m.get("prices")
                for m in d["models"]
            )
            and _date(d["generated_at"])
        )
    except (TypeError, ValueError, KeyError):
        return False


class MemoryStore:
    def __init__(self, initial=None):
        self.doc = initial

    def read(self):
        return self.doc

    def write(self, doc):
        if not self.doc or _date(doc["data"]["generated_at"]) >= _date(
            self.doc["data"]["generated_at"]
        ):
            self.doc = doc


class FileStore:
    def __init__(self, path=None):
        self.path = Path(
            path
            or os.environ.get("LLM_INFO_CACHE")
            or Path(os.environ.get("XDG_CACHE_HOME", Path.home() / ".cache"))
            / "llm-info"
            / "llm-info.json"
        )

    def read(self):
        try:
            return json.loads(self.path.read_text())
        except FileNotFoundError:
            return None

    def write(self, doc):
        self.path.parent.mkdir(parents=True, exist_ok=True)
        previous = self.read()
        if previous and _date(previous["data"]["generated_at"]) > _date(
            doc["data"]["generated_at"]
        ):
            return
        fd, tmp = tempfile.mkstemp(dir=self.path.parent, prefix=".prices-")
        try:
            with os.fdopen(fd, "w") as f:
                json.dump(doc, f)
            os.replace(tmp, self.path)
        finally:
            if os.path.exists(tmp):
                os.unlink(tmp)


def _fetch(url, etag):
    req = Request(url, headers={"If-None-Match": etag} if etag else {})
    try:
        with urlopen(req, timeout=15) as r:
            return r.status, r.headers.get("ETag"), json.load(r)
    except HTTPError as e:
        if e.code == 304:
            return 304, etag, None
        raise


def _usage_number(value):
    if value is None:
        return Decimal(0)
    if isinstance(value, bool):
        return Decimal("NaN")
    try:
        number = Decimal(str(value))
        return number if number.is_finite() and number >= 0 else Decimal("NaN")
    except (InvalidOperation, ValueError, TypeError):
        return Decimal("NaN")


def _video_seconds(response, request, model):
    response = (
        (response.get("operation") or {}).get("response")
        or response.get("response")
        or response
    )
    raw = next(
        (
            v
            for v in [
                response.get("seconds"),
                response.get("duration"),
                request.get("duration"),
                request.get("durationSeconds"),
                (request.get("config") or {}).get("durationSeconds"),
                (request.get("parameters") or {}).get("durationSeconds"),
            ]
            if v is not None
        ),
        None,
    )
    try:
        duration = float(raw) if raw is not None else None
    except (ValueError, TypeError):
        duration = None
    # https://ai.google.dev/gemini-api/docs/veo: Veo 3.1 defaults to 8 seconds.
    if duration is None and model and model.startswith("veo-"):
        duration = 8
    # https://platform.openai.com/docs/api-reference/videos: Sora default is four seconds.
    if duration is None and model and model.startswith("sora-"):
        duration = 4
    if duration is None:
        return None
    videos = (
        response.get("generatedVideos")
        or response.get("generated_videos")
        or response.get("videos")
        or (response.get("generateVideoResponse") or {}).get("generatedSamples")
    )
    count = (
        len(videos)
        if isinstance(videos, list)
        else (request.get("parameters") or {}).get(
            "sampleCount",
            (request.get("config") or {}).get(
                "numberOfVideos", request.get("sampleCount", 1)
            ),
        )
    )
    return Decimal(str(duration)) * _usage_number(count)


class LlmInfo:
    def __init__(
        self,
        url=DEFAULT_URL,
        fallback_urls=None,
        store=None,
        ttl=21600,
        auto_refresh=True,
        fetch=None,
        accept=None,
        on_event=None,
    ):
        self.url = url
        self.urls = [url] + (
            fallback_urls if fallback_urls is not None else [FALLBACK_URL]
        )
        self.store = store or FileStore()
        self.ttl = ttl
        self.auto_refresh = auto_refresh
        self.fetch = fetch or _fetch
        self.accept = accept
        self.on_event = on_event
        self.doc = None
        self._lock = threading.RLock()

    def _emit(self, event, detail=None):
        if self.on_event:
            self.on_event(event, detail)

    def _activate(self, doc):
        self.doc = doc

    def _persist(self, doc):
        old = self.store.read()
        if old and _date(old["data"]["generated_at"]) > _date(
            doc["data"]["generated_at"]
        ):
            doc = old
        else:
            self.store.write(doc)
        self._activate(doc)

    def info(self):
        d = self.doc
        return {
            "version": d["data"]["version"] if d else None,
            "generated_at": d["data"]["generated_at"] if d else None,
            "fetched_at": d["fetched_at"] if d else None,
            "stale": not d
            or time.time() - _date(d["fetched_at"]).timestamp() > self.ttl,
            "last_error": d["last_error"] if d else None,
        }

    def load(self):
        with self._lock:
            if self.doc is None:
                old = self.store.read()
                if old and _valid(old.get("data")):
                    self._activate(old)
            if self.doc is None:
                self.refresh(force=True)
            elif self.info()["stale"] and self.auto_refresh:
                threading.Thread(target=self.refresh, daemon=True).start()
            return self.info()

    def refresh(self, force=False):
        with self._lock:
            if self.doc and not force and not self.info()["stale"]:
                return {"status": "fresh", "info": self.info()}
            attempted = _now()
            error = ""
            for url in self.urls:
                try:
                    status, etag, data = self.fetch(
                        url, self.doc["etag"] if self.doc else None
                    )
                    if status == 304 and self.doc:
                        self._persist(
                            {
                                **self.doc,
                                "fetched_at": _now(),
                                "last_attempt_at": attempted,
                                "last_error": None,
                            }
                        )
                        self._emit("not_modified")
                        return {"status": "not_modified", "info": self.info()}
                    if status < 200 or status >= 300:
                        raise RuntimeError(f"HTTP {status}")
                    if not _valid(data):
                        self._emit("rejected", "invalid_shape")
                        return {
                            "status": "rejected",
                            "reason": "invalid_shape",
                            "info": self.info(),
                        }
                    if self.doc and _date(data["generated_at"]) < _date(
                        self.doc["data"]["generated_at"]
                    ):
                        self._emit("rejected", "older_data")
                        return {
                            "status": "rejected",
                            "reason": "older_data",
                            "info": self.info(),
                        }
                    nextdoc = {
                        "cache_schema": 1,
                        "source_url": url,
                        "fetched_at": _now(),
                        "etag": etag,
                        "last_attempt_at": attempted,
                        "last_error": None,
                        "data": data,
                    }
                    if self.accept and not self.accept(
                        data, self.doc["data"] if self.doc else None
                    ):
                        self._emit("rejected", "accept_false")
                        return {
                            "status": "rejected",
                            "reason": "accept_false",
                            "info": self.info(),
                        }
                    self._persist(nextdoc)
                    self._emit("updated")
                    return {"status": "updated", "info": self.info()}
                except Exception as e:  # noqa: BLE001 - custom fetch hooks can raise arbitrary errors.
                    error = str(e)
            if self.doc:
                self._persist(
                    {**self.doc, "last_attempt_at": attempted, "last_error": error}
                )
                self._emit("error", error)
                return {"status": "error", "info": self.info()}
            raise RuntimeError("Unable to load prices: " + error)

    def capabilities(self, provider, model):
        if not self.doc:
            raise PricesNotLoadedError("Prices are not loaded; call load() first")
        m = find_model(self.doc["data"]["models"], provider, model)
        return m.get("capabilities") if m else None

    def models(self, provider=None):
        if not self.doc:
            raise PricesNotLoadedError("Prices are not loaded; call load() first")
        return [
            {
                "provider": m["provider"],
                "id": m["id"],
                "capabilities": m.get("capabilities"),
            }
            for m in self.doc["data"]["models"]
            if provider is None or m["provider"] == provider
        ]

    def calc(
        self, provider, model, usage, at=None, options=None, mode=None, region=None
    ):
        if not self.doc:
            raise PricesNotLoadedError("Prices are not loaded; call load() first")
        m = find_model(self.doc["data"]["models"], provider, model)
        if not m:
            return None
        provider_mode_multiplier = 0
        for row in self.doc["data"]["models"]:
            if row["provider"] != m["provider"]:
                continue
            for entry in row.get("modes", {}).values():
                provider_mode_multiplier = max(
                    provider_mode_multiplier, entry.get("multiplier", 1)
                )
                for key, value in entry.get("prices", {}).items():
                    raw = row["prices"].get(key)
                    if (
                        isinstance(value, (int, float))
                        and isinstance(raw, (int, float))
                        and raw > 0
                    ):
                        provider_mode_multiplier = max(
                            provider_mode_multiplier, value / raw
                        )
        result = calculate(
            m,
            usage,
            {**(options or {}), "providerModeMultiplier": provider_mode_multiplier},
            mode or (options or {}).get("mode") or "standard",
            region or "global",
        )
        if self.info()["stale"]:
            result["warnings"].append("stale_data")
        return {
            **result,
            "provider": provider,
            "model": m["id"],
            "requested_model": model,
            "usage": usage,
            "data_version": self.doc["data"]["version"],
        }

    def extract_usage(self, provider, response, request=None, api_flavor=None):
        if not self.doc:
            raise PricesNotLoadedError("Prices are not loaded; call load() first")
        request = request or {}
        provider = provider.lower()
        u = response.get("usage") or response.get("usageMetadata") or {}
        model = (
            response.get("model")
            or response.get("modelVersion")
            or request.get("model")
        )
        out = {}

        def set_(key, val):
            if val is not None:
                out[key] = val

        if provider == "anthropic":
            # https://platform.claude.com/docs/en/build-with-claude/prompt-caching: cache_creation splits writes by TTL.
            # The same fields are accepted from Vertex/Bedrock Anthropic responses.
            creation = u.get("cache_creation") or {}
            one_hour = _usage_number(creation.get("ephemeral_1h_input_tokens"))
            five_minute = creation.get("ephemeral_5m_input_tokens")
            if five_minute is None:
                difference = (
                    _usage_number(u.get("cache_creation_input_tokens")) - one_hour
                )
                five_minute = (
                    max(0, difference) if difference.is_finite() else difference
                )
            else:
                five_minute = _usage_number(five_minute)
            set_(
                "input_tokens",
                _usage_number(u.get("input_tokens"))
                + five_minute
                + one_hour
                + _usage_number(u.get("cache_read_input_tokens")),
            )
            set_("output_tokens", u.get("output_tokens"))
            set_("cache_read_tokens", u.get("cache_read_input_tokens"))
            set_("cache_write_tokens", five_minute)
            set_("cache_write_1h_tokens", one_hour)
            set_(
                "web_searches",
                (u.get("server_tool_use") or {}).get("web_search_requests"),
            )
        elif provider == "google":
            set_(
                "input_tokens",
                _usage_number(u.get("promptTokenCount"))
                + _usage_number(u.get("toolUsePromptTokenCount")),
            )
            set_(
                "output_tokens",
                _usage_number(u.get("candidatesTokenCount"))
                + _usage_number(u.get("thoughtsTokenCount")),
            )
            set_("cache_read_tokens", u.get("cachedContentTokenCount"))
            m = (
                find_model(self.doc["data"]["models"], provider, model)
                if model
                else None
            )
            if m and m["prices"].get("reasoning"):
                set_("output_reasoning_tokens", u.get("thoughtsTokenCount"))
            for source, dest, modality in [
                ("promptTokensDetails", "input_image_tokens", "IMAGE"),
                ("candidatesTokensDetails", "output_image_tokens", "IMAGE"),
                ("promptTokensDetails", "input_audio_tokens", "AUDIO"),
                ("toolUsePromptTokensDetails", "input_audio_tokens", "AUDIO"),
                ("cacheTokensDetails", "cache_audio_read_tokens", "AUDIO"),
                ("candidatesTokensDetails", "output_audio_tokens", "AUDIO"),
            ]:
                if isinstance(u.get(source), list):
                    out[dest] = _usage_number(out.get(dest)) + sum(
                        _usage_number(x.get("tokenCount"))
                        for x in u[source]
                        if x.get("modality") == modality
                    )
            images = response.get("generatedImages") or response.get("predictions")
            if isinstance(images, list):
                set_("output_images", len(images))
            else:
                set_(
                    "output_images",
                    (request.get("parameters") or {}).get(
                        "sampleCount",
                        (request.get("config") or {}).get("numberOfImages"),
                    ),
                )
            set_(
                "output_video_seconds",
                _video_seconds(response, request, model),
            )
        else:
            set_("input_tokens", u.get("prompt_tokens", u.get("input_tokens")))
            set_("output_tokens", u.get("completion_tokens", u.get("output_tokens")))
            set_(
                "cache_read_tokens",
                (
                    u.get("prompt_tokens_details")
                    or u.get("input_tokens_details")
                    or {}
                ).get("cached_tokens"),
            )
            set_(
                "input_image_tokens",
                (u.get("input_tokens_details") or {}).get("image_tokens"),
            )
            set_(
                "output_image_tokens",
                (u.get("output_tokens_details") or {}).get("image_tokens"),
            )
            m = (
                find_model(self.doc["data"]["models"], provider, model)
                if model
                else None
            )
            if m and m["prices"].get("reasoning"):
                set_(
                    "output_reasoning_tokens",
                    (
                        u.get("completion_tokens_details")
                        or u.get("output_tokens_details")
                        or {}
                    ).get("reasoning_tokens"),
                )
            set_(
                "input_audio_tokens",
                (
                    u.get("prompt_tokens_details")
                    or u.get("input_tokens_details")
                    or {}
                ).get("audio_tokens"),
            )
            set_(
                "output_audio_tokens",
                (
                    u.get("completion_tokens_details")
                    or u.get("output_tokens_details")
                    or {}
                ).get("audio_tokens"),
            )
            if (
                provider == "x-ai"
                and api_flavor != "responses"
                and response.get("object") != "response"
            ):
                # https://docs.x.ai/developers/tools/tool-usage-details: completion is final text, reasoning separate.
                reasoning = (
                    u.get("completion_tokens_details")
                    or u.get("output_tokens_details")
                    or {}
                ).get("reasoning_tokens")
                if reasoning is not None:
                    out["output_tokens"] = _usage_number(
                        out.get("output_tokens")
                    ) + _usage_number(reasoning)
            if api_flavor == "images" or "data" in response:
                set_(
                    "output_images",
                    len(response["data"])
                    if "data" in response
                    else request.get("n", 1),
                )
            set_(
                "output_video_seconds",
                _video_seconds(response, request, model),
            )
        return {"model": model, "usage": out}

    def from_response(
        self,
        provider,
        response,
        request=None,
        api_flavor=None,
        at=None,
        mode=None,
        region=None,
    ):
        extracted = self.extract_usage(provider, response, request, api_flavor)
        if not extracted["model"]:
            return None
        # https://platform.openai.com/docs/api-reference/responses: service_tier is the actual tier.
        # https://platform.claude.com/docs/en/build-with-claude/fast-mode: usage.speed marks fast processing.
        inferred_mode = (
            response.get("service_tier")
            if response.get("service_tier") in ("priority", "flex")
            else (
                "fast"
                if response.get("speed") == "fast"
                or (response.get("usage") or {}).get("speed") == "fast"
                else None
            )
        )
        result = self.calc(
            provider,
            extracted["model"],
            extracted["usage"],
            at,
            {
                **(request or {}),
                **response,
                "service_tier": response.get("service_tier"),
            },
            mode=mode or inferred_mode,
            region=region,
        )
        if (
            result
            and extracted["model"].startswith("sora-")
            and response.get("seconds") is None
            and response.get("duration") is None
            and (request or {}).get("duration") is None
            and (request or {}).get("durationSeconds") is None
        ):
            result["warnings"].append("missing_param:duration")
        return result

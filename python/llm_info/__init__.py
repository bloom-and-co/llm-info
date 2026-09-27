"""Cached, source-attributed LLM price estimates."""

from __future__ import annotations
import json, os, tempfile, threading, time
from datetime import datetime, timezone
from decimal import Decimal
from pathlib import Path
from typing import Protocol
from urllib.request import Request, urlopen
from urllib.error import HTTPError
from ._sdk import snapshot_from_data, Usage

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
            and d.get("schema") == 1
            and isinstance(d.get("version"), str)
            and len(d.get("providers", [])) == 4
            and all(isinstance(p.get("models"), list) for p in d["providers"])
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


def _match(provider, model):
    from re import fullmatch, escape

    for m in provider["models"]:
        if m["id"].lower() == model.lower():
            return m
    for m in sorted(provider["models"], key=lambda m: -len(m["id"])):
        if fullmatch(
            escape(m["id"]) + r"-(?:20\d{6}|20\d{2}-\d{2}-\d{2})", model, flags=2
        ):
            return m
    return None


def _video_seconds(response, request, model):
    raw = next(
        (
            v
            for v in [
                response.get("seconds"),
                response.get("duration"),
                request.get("duration"),
                request.get("durationSeconds"),
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
    if duration is None:
        return None
    videos = response.get("generatedVideos") or response.get("generated_videos")
    count = (
        len(videos)
        if isinstance(videos, list)
        else (request.get("parameters") or {}).get(
            "sampleCount", request.get("sampleCount", 1)
        )
    )
    return duration * count


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
        self.snapshot = None
        self._lock = threading.RLock()

    def _emit(self, event, detail=None):
        if self.on_event:
            self.on_event(event, detail)

    def _activate(self, doc):
        snapshot = snapshot_from_data(doc["data"])
        for p in doc["data"]["providers"]:
            if not p["models"]:
                raise ValueError("empty provider")
            for m in p["models"]:
                snapshot.calc(
                    Usage(input_tokens=1, output_tokens=1), m["id"], p["id"], None, None
                )
        self.snapshot = snapshot
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
                    try:
                        check = snapshot_from_data(data)
                        for provider in data["providers"]:
                            if not provider["models"]:
                                raise ValueError("empty provider")
                            for model in provider["models"]:
                                check.calc(
                                    Usage(input_tokens=1),
                                    model["id"],
                                    provider["id"],
                                    None,
                                    None,
                                )
                    except Exception:
                        self._emit("rejected", "invalid_sdk_data")
                        return {
                            "status": "rejected",
                            "reason": "invalid_sdk_data",
                            "info": self.info(),
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
                except Exception as e:
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
        p = next(
            (p for p in self.doc["data"]["providers"] if p["id"] == provider), None
        )
        m = _match(p, model) if p else None
        return m.get("x_capabilities") if m else None

    def models(self, provider=None):
        if not self.doc:
            raise PricesNotLoadedError("Prices are not loaded; call load() first")
        return [
            {"provider": p["id"], "id": m["id"], "capabilities": m["x_capabilities"]}
            for p in self.doc["data"]["providers"]
            if provider is None or p["id"] == provider
            for m in p["models"]
            if "x_capabilities" in m
        ]

    def calc(
        self, provider, model, usage, at=None, options=None, mode=None, region=None
    ):
        if not self.doc:
            raise PricesNotLoadedError("Prices are not loaded; call load() first")
        p = next(
            (p for p in self.doc["data"]["providers"] if p["id"] == provider), None
        )
        m = _match(p, model) if p else None
        if not m:
            return None
        options = options or {}
        selected_mode = mode or options.get("mode") or "standard"
        modes = m.get("x_modes", {})
        prices = dict(m["prices"])
        warnings = []
        if selected_mode != "standard":
            selected = modes.get(selected_mode, {}).get("prices", {})
            if selected:
                prices.update(selected)
            else:
                warnings.append("missing_price:mode:" + selected_mode)

                def base(price):
                    return (
                        price
                        if isinstance(price, (int, float))
                        else max(
                            [price["base"]] + [tier["price"] for tier in price["tiers"]]
                        )
                    )

                for entry in modes.values():
                    for key, value in entry.get("prices", {}).items():
                        prices[key] = (
                            max(base(value), base(prices[key]))
                            if key in prices
                            else base(value)
                        )
        clean = {
            k: v
            for k, v in usage.items()
            if k not in ("output_images", "output_video_seconds")
        }
        clean.pop("web_searches", None)
        try:
            # Restrict SDK matching to the selected row; alias regexes can precede dated IDs.
            selected = snapshot_from_data(
                {
                    "providers": [
                        {
                            **p,
                            "models": [
                                {**m, "prices": prices, "match": {"equals": m["id"]}}
                            ],
                        }
                    ]
                }
            )
            for _ in range(16):
                try:
                    result = selected.calc(Usage(**clean), m["id"], provider, None, at)
                    break
                except ValueError as error:
                    import re

                    match = re.search(r"Missing usage for ([a-z_]+_tokens)", str(error))
                    if not match or match.group(1) in clean:
                        raise
                    clean[match.group(1)] = (
                        0  # Unknown overlap: conservative billable split.
                    )
        except LookupError:
            return None
        d = Decimal
        extra = d(0)
        x = m.get("x_extra_prices", {})
        if self.info()["stale"]:
            warnings.append("stale_data")
        for field, tag in [
            ("output_images", "per_image"),
            ("output_video_seconds", "per_video_second"),
        ]:
            if not usage.get(field) or (
                field == "output_images" and usage.get("output_image_tokens")
            ):
                continue
            rate = x.get(tag)
            if isinstance(rate, dict):
                if (
                    tag == "per_image"
                    and "default" not in rate
                    and not options.get("size")
                ):
                    warnings.append("missing_param:size")
                    continue
                if (
                    tag == "per_image"
                    and "default" not in rate
                    and not options.get("quality")
                ):
                    warnings.append("missing_param:quality")
                    continue
                if tag == "per_image":
                    key = (
                        f"{options['size']}/{options['quality']}"
                        if options.get("size") and options.get("quality")
                        else None
                    )
                else:
                    key = options.get("resolution")
                if not key and "default" not in rate:
                    warnings.append("missing_param:resolution")
                    continue
                rate = rate.get(key, rate.get("default"))
            if rate is None:
                warnings.append("missing_price:" + tag)
                continue
            extra += d(str(rate)) * d(str(usage[field]))
        if usage.get("web_searches"):
            if x.get("web_search") is not None:
                extra += d(str(x["web_search"])) * d(str(usage["web_searches"]))
            else:
                warnings.append("missing_price:web_search")
        if x.get("per_video_second") is not None and not usage.get(
            "output_video_seconds"
        ):
            warnings.append("missing_param:duration")
        uplift = (
            m.get("x_region_uplift", {}).get(region, 1)
            if region not in (None, "global")
            else 1
        )
        multiplier = d(str(uplift))
        return {
            "total_usd": (result.total_price + extra) * multiplier,
            "input_usd": result.input_price * multiplier,
            "output_usd": result.output_price * multiplier,
            "extra_usd": extra * multiplier,
            "provider": provider,
            "model": m["id"],
            "requested_model": model,
            "usage": usage,
            "data_version": self.doc["data"]["version"],
            "source": m.get("x_source", "unknown"),
            "warnings": warnings,
        }

    def extract_usage(self, provider, response, request=None, api_flavor=None):
        if not self.doc:
            raise PricesNotLoadedError("Prices are not loaded; call load() first")
        request = request or {}
        u = response.get("usage") or response.get("usageMetadata") or {}
        model = (
            response.get("model")
            or response.get("modelVersion")
            or request.get("model")
        )
        out = {}

        def set_(key, val):
            if isinstance(val, (int, float)):
                out[key] = val

        if provider == "anthropic":
            set_(
                "input_tokens",
                u.get("input_tokens", 0)
                + u.get("cache_creation_input_tokens", 0)
                + u.get("cache_read_input_tokens", 0),
            )
            set_("output_tokens", u.get("output_tokens"))
            set_("cache_read_tokens", u.get("cache_read_input_tokens"))
            set_("cache_write_tokens", u.get("cache_creation_input_tokens"))
            set_(
                "web_searches",
                (u.get("server_tool_use") or {}).get("web_search_requests"),
            )
        elif provider == "google":
            set_(
                "input_tokens",
                (u.get("promptTokenCount") or 0)
                + (u.get("toolUsePromptTokenCount") or 0),
            )
            set_(
                "output_tokens",
                (u.get("candidatesTokenCount") or 0)
                + (u.get("thoughtsTokenCount") or 0),
            )
            set_("cache_read_tokens", u.get("cachedContentTokenCount"))
            p = next(
                (p for p in self.doc["data"]["providers"] if p["id"] == provider), None
            )
            m = _match(p, model) if p and model else None
            if m and m["prices"].get("output_reasoning_mtok"):
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
                    out[dest] = out.get(dest, 0) + sum(
                        x.get("tokenCount", 0)
                        for x in u[source]
                        if x.get("modality") == modality
                    )
            images = response.get("generatedImages") or response.get("predictions")
            if isinstance(images, list):
                set_("output_images", len(images))
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
            p = next(
                (p for p in self.doc["data"]["providers"] if p["id"] == provider), None
            )
            m = _match(p, model) if p and model else None
            if m and m["prices"].get("output_reasoning_mtok"):
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
            if provider == "x-ai":
                # https://docs.x.ai/developers/tools/tool-usage-details: completion is final text, reasoning separate.
                reasoning = (
                    u.get("completion_tokens_details")
                    or u.get("output_tokens_details")
                    or {}
                ).get("reasoning_tokens")
                if isinstance(reasoning, (int, float)):
                    out["output_tokens"] = out.get("output_tokens", 0) + reasoning
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
        return self.calc(
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

"""Independent Decimal cost engine for schema 2 model rows."""

import re
from decimal import Decimal


def find_model(models, provider, name):
    name = re.sub(
        r"^(openai|anthropic|gemini|models|google|xai|x-ai)/",
        "",
        name,
        flags=re.IGNORECASE,
    ).lower()
    rows = [m for m in models if m["provider"].lower() == provider.lower()]
    direct = next((m for m in rows if m["id"].lower() == name), None)
    if direct:
        return direct
    bedrock = provider.lower() == "anthropic" and name.startswith("anthropic.")
    if bedrock:
        name = name[len("anthropic.") :]
        matches = [
            m
            for m in rows
            if m["id"].lower() == name
            or name in [a.lower() for a in m.get("aliases", [])]
        ]
        if len(matches) != 1:
            return None
    for m in rows:
        if m["id"].lower() == name:
            return m
    for m in rows:
        if name in [
            a.lower()
            for a in m.get("aliases", []) + m.get("match", {}).get("exact", [])
        ]:
            return m
    if re.search(r"(?:-(?:20\d{6}|20\d{2}-\d{2}-\d{2})|@20\d{6}|-00[12])$", name):
        matches = [
            m
            for m in rows
            if m.get("match", {}).get("dated_suffix")
            and (name.startswith((m["id"].lower() + "-", m["id"].lower() + "@")))
        ]
        return max(matches, key=lambda m: len(m["id"])) if matches else None
    return None


def D(x):
    return Decimal(str(x))


def calculate(model, usage, options=None, mode="standard", region="global"):
    options = options or {}
    warnings = []

    def count(key):
        value = usage.get(key) if isinstance(usage, dict) else None
        if value is None:
            return D(0)
        if isinstance(value, bool):
            warnings.append("invalid_usage:" + key)
            return D(0)
        try:
            parsed = D(value)
            if parsed.is_finite() and parsed >= 0:
                return parsed
        except (ValueError, TypeError, ArithmeticError):
            pass
        warnings.append("invalid_usage:" + key)
        return D(0)

    def tiered(source):
        active = dict(source)
        for tier in source.get("tiers", []):
            if count("input_tokens") > D(tier["above_input_tokens"]):
                active.update(tier["prices"])
        active.pop("tiers", None)
        return active

    prices = tiered(model["prices"])
    multiplier = D(1)
    modes = model.get("modes", {})
    if mode != "standard":
        selected = modes.get(mode)
        if selected:
            mode_prices = selected.get("prices", {})
            prices.update(tiered(mode_prices))
            own_tiers = {
                key
                for tier in mode_prices.get("tiers", [])
                if count("input_tokens") > D(tier["above_input_tokens"])
                for key in tier["prices"]
            }
            active_base = tiered(model["prices"])
            for key, value in mode_prices.items():
                raw = model["prices"].get(key)
                if (
                    key != "tiers"
                    and key not in own_tiers
                    and isinstance(value, (int, float, Decimal))
                    and isinstance(raw, (int, float, Decimal))
                    and raw > 0
                    and isinstance(active_base.get(key), (int, float, Decimal))
                ):
                    prices[key] = D(value) * D(active_base[key]) / D(raw)
            if (
                "cache_write_1h" not in mode_prices
                and "cache_write_1h" not in own_tiers
                and isinstance(prices.get("cache_write_1h"), (int, float, Decimal))
                and isinstance(prices.get("input"), (int, float, Decimal))
                and isinstance(active_base.get("input"), (int, float, Decimal))
                and D(active_base["input"]) > 0
            ):
                prices["cache_write_1h"] = (
                    D(prices["cache_write_1h"])
                    * D(prices["input"])
                    / D(active_base["input"])
                )
            multiplier = D(selected.get("multiplier", 1))
        else:
            warnings.append("missing_price:mode:" + mode)
            if mode in ("priority", "fast"):
                own = D(0)
                for entry in modes.values():
                    own = max(own, D(entry.get("multiplier", 1)))
                    for key, value in entry.get("prices", {}).items():
                        raw = model["prices"].get(key)
                        if (
                            isinstance(value, (int, float, Decimal))
                            and isinstance(raw, (int, float, Decimal))
                            and raw > 0
                        ):
                            own = max(own, D(value) / D(raw))
                multiplier = D(options.get("providerModeMultiplier", 0)) or own or D(2)

    highest = max(
        [
            D(v)
            for k, v in prices.items()
            if k != "tiers"
            and not k.startswith("per_")
            and isinstance(v, (int, float, Decimal))
        ]
        or [D(0)]
    )

    def rate(key, fallbacks=(), warn=True):
        if isinstance(prices.get(key), (int, float, Decimal)):
            return D(prices[key])
        if key == "cache_write_1h":
            if warn:
                warnings.append("fallback_price:cache_write_1h")
            # https://platform.claude.com/docs/en/about-claude/pricing: 1h writes cost 2x standard input.
            write_5m = prices.get("cache_write")
            return max(
                rate("input", (), False) * 2,
                D(write_5m) if isinstance(write_5m, (int, float, Decimal)) else D(0),
            )
        candidates = [
            D(prices[k])
            for k in fallbacks
            if isinstance(prices.get(k), (int, float, Decimal))
        ]
        if warn:
            warnings.append(
                ("fallback_price:" if candidates else "missing_price:") + key
            )
        return max(candidates) if candidates else highest

    raw_total = count("input_tokens")
    raw_mods = [
        max(
            count("input_" + k + "_tokens"),
            count("cache_" + k + "_read_tokens")
            + count("cache_" + k + "_write_tokens"),
        )
        for k in ("audio", "image", "video")
    ]
    read, write = count("cache_read_tokens"), count("cache_write_tokens")
    write_1h = count("cache_write_1h_tokens")
    total = max(raw_total, read + write + write_1h, *raw_mods)
    input_modalities = model.get("capabilities", {}).get("input_modalities") or []
    input_candidate = (
        1
        if model.get("mode") == "image_generation" or input_modalities == ["image"]
        else 0
        if model.get("mode") in ("audio_transcription", "realtime")
        else -1
    )
    if (
        total
        and input_candidate >= 0
        and not usage.get("input_breakdown_present")
        and not any(raw_mods)
        and rate("input_" + ("audio", "image")[input_candidate], ("input",), False)
        > rate("input", (), False)
    ):
        raw_mods[input_candidate] = max(D(0), total - count("input_text_tokens"))
        if raw_mods[input_candidate]:
            warnings.append("input_breakdown_missing")
    if (
        read
        and input_candidate >= 0
        and not usage.get("cache_breakdown_present")
        and not count("cache_audio_read_tokens")
        and not count("cache_image_read_tokens")
        and rate(
            "cache_" + ("audio", "image")[input_candidate] + "_read",
            ("cache_read", "input"),
            False,
        )
        > rate("cache_read", ("input",), False)
    ):
        warnings.append("cache_breakdown_missing")
    out_total = max(
        count("output_tokens"),
        count("output_audio_tokens"),
        count("output_image_tokens"),
    )
    if (
        total != raw_total
        or out_total != count("output_tokens")
        or sum(raw_mods) > total
        or read + write + write_1h > total
        or count("cache_audio_read_tokens") + count("cache_image_read_tokens") > read
        or count("cache_audio_write_tokens") + count("cache_image_write_tokens") > write
    ):
        warnings.append("inconsistent_usage")
    mods = [min(total, v) for v in raw_mods]
    keys = ["input", "input_audio", "input_image", "input_video"]
    modal_rates = [
        rate(keys[i + 1], ("input",), False) if mods[i] else D(0) for i in range(3)
    ]
    overflow = max(D(0), sum(mods) - total)
    for i in sorted(range(3), key=lambda i: modal_rates[i]):
        cut = min(overflow, mods[i])
        mods[i] -= cut
        overflow -= cut
    capacity = [total - sum(mods)] + mods
    base = [rate("input") if capacity[0] else D(0)] + modal_rates
    for i in range(3):
        if capacity[i + 1]:
            rate(keys[i + 1], ("input",))
    input_cost = sum(capacity[i] * base[i] for i in range(4))
    remaining = capacity[:]

    def cache_key(prefix, i):
        if prefix == "cache_write_1h":
            return prefix
        return (
            "cache_"
            + ("audio", "image", "video")[i - 1]
            + ("_read" if prefix == "cache_read" else "_write")
        )

    def allocate(amount, prefix, explicit):
        nonlocal input_cost
        left = min(amount, total)
        for i in range(1, 4):
            fixed = min(left, remaining[i], explicit[i - 1])
            if fixed:
                r = rate(
                    cache_key(prefix, i),
                    ("input_" + ("audio", "image", "video")[i - 1], prefix, "input"),
                )
                input_cost += fixed * (r - base[i])
                remaining[i] -= fixed
                left -= fixed
        choices = []
        for i in range(4):
            if left and remaining[i]:
                key = prefix if i == 0 else cache_key(prefix, i)
                fallback = (
                    ("input",)
                    if i == 0
                    else (
                        "input_" + ("audio", "image", "video")[i - 1],
                        prefix,
                        "input",
                    )
                )
                r = rate(key, fallback, False)
                choices.append((r - base[i], i, r, key, fallback))
        for _, i, r, key, fallback in sorted(
            choices, key=lambda item: (-item[0], item[1])
        ):
            take = min(left, remaining[i])
            if not take:
                continue
            rate(key, fallback)
            input_cost += take * (r - base[i])
            remaining[i] -= take
            left -= take
        if left:
            warnings.append("inconsistent_usage")

    if read:
        allocate(
            read,
            "cache_read",
            [count("cache_audio_read_tokens"), count("cache_image_read_tokens"), D(0)],
        )
    if write:
        allocate(write, "cache_write", [count("cache_audio_write_tokens"), D(0), D(0)])
    if write_1h:
        allocate(write_1h, "cache_write_1h", [D(0), D(0), D(0)])
    out_mod = [count("output_audio_tokens"), count("output_image_tokens")]
    if sum(out_mod) > out_total:
        warnings.append("inconsistent_usage")
    included_reasoning = min(out_total, count("output_reasoning_tokens"))
    left = out_total - included_reasoning
    output_cost = (
        included_reasoning * rate("reasoning", ("output",))
        if included_reasoning
        else D(0)
    )
    output_modal = sorted(
        [
            (
                k,
                out_mod[i],
                rate("output_" + k, ("output",), False) if out_mod[i] else D(0),
            )
            for i, k in enumerate(("audio", "image"))
        ],
        key=lambda item: item[2],
        reverse=True,
    )
    for kind, amount, modal_rate in output_modal:
        take = min(left, amount)
        if take:
            rate("output_" + kind, ("output",))
        output_cost += take * modal_rate
        left -= take
    exact_text = min(left, count("output_text_tokens"))
    if exact_text:
        output_cost += exact_text * rate("output")
    left -= exact_text
    output_modalities = model.get("capabilities", {}).get("output_modalities") or []
    image_only = output_modalities == ["image"]
    output_breakdown_missing = (
        left
        and (model.get("mode") == "image_generation" or "image" in output_modalities)
        and not usage.get("output_breakdown_present")
        and not out_mod[1]
    )
    if output_breakdown_missing:
        warnings.append("output_breakdown_missing")
    if left:
        output_cost += left * (
            max(rate("output_image", ("output",)), rate("output", (), False))
            if output_breakdown_missing or image_only
            else rate("output")
        )
    reasoning = count("reasoning_tokens")
    if reasoning:
        output_cost += reasoning * rate("reasoning", ("output",))
    input_cost *= multiplier / D(1000000)
    output_cost *= multiplier / D(1000000)

    def table(key):
        value = prices.get(key)
        if isinstance(value, (int, float, Decimal)):
            return D(value)
        if not isinstance(value, dict):
            warnings.append("missing_price:" + key)
            return highest / D(1000000)
        variant = (
            (options.get("size", "") + "/" + options.get("quality", ""))
            if key == "per_image"
            else options.get("resolution")
        )
        if variant in value:
            return D(value[variant])
        if "default" in value:
            return D(value["default"])
        warnings.append(
            "missing_param:" + ("size" if not options.get("size") else "quality")
            if key == "per_image"
            else "missing_param:resolution"
        )
        return max(map(D, value.values()))

    extra = D(0)
    images = count("output_images")
    if (
        not images
        and "per_image" in prices
        and not out_total
        and not count("output_image_tokens")
    ):
        images = D(1)
        warnings.append("missing_param:image_count")
    if (
        images
        and not count("output_image_tokens")
        and not output_breakdown_missing
        and not (out_total and image_only)
    ):
        extra += images * table("per_image")
    if count("output_video_seconds"):
        extra += count("output_video_seconds") * table("per_video_second")
    elif "per_video_second" in prices:
        warnings.append("missing_param:duration")
    if count("web_searches"):
        if "per_web_search" in prices:
            extra += count("web_searches") * D(prices["per_web_search"])
        else:
            warnings.append("missing_price:web_search")
    normalized_region = str(region).lower()
    if normalized_region not in ("global", "us", "eu"):
        warnings.append("unknown_region:" + str(region))
    elif normalized_region != "global" and normalized_region not in model.get(
        "region_uplift", {}
    ):
        warnings.append("missing_region_uplift")
    uplift = (
        D(model.get("region_uplift", {}).get(normalized_region, 1))
        if normalized_region != "global"
        else D(1)
    )
    return {
        "input_usd": input_cost * uplift,
        "output_usd": output_cost * uplift,
        "extra_usd": extra * uplift,
        "total_usd": (input_cost + output_cost + extra) * uplift,
        "warnings": list(dict.fromkeys(warnings)),
    }

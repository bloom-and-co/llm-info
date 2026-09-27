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
    rows = [m for m in models if m["provider"] == provider]
    for m in rows:
        if m["id"].lower() == name:
            return m
    for m in rows:
        if name in [
            a.lower()
            for a in m.get("aliases", []) + m.get("match", {}).get("exact", [])
        ]:
            return m
    if re.search(r"-(?:20\d{6}|20\d{2}-\d{2}-\d{2})$", name):
        matches = [
            m
            for m in rows
            if m.get("match", {}).get("dated_suffix")
            and name.startswith(m["id"].lower() + "-")
        ]
        return max(matches, key=lambda m: len(m["id"])) if matches else None
    return None


def D(x):
    return Decimal(str(x))


def calculate(model, usage, options=None, mode="standard", region="global"):
    options = options or {}
    warnings = []

    def count(key):
        value = usage.get(key)
        return max(D(0), D(value)) if isinstance(value, (int, float)) else D(0)

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
            prices.update(tiered(selected.get("prices", {})))
            multiplier = D(selected.get("multiplier", 1))
        else:
            warnings.append("missing_price:mode:" + mode)
            for entry in modes.values():
                for key, value in tiered(entry.get("prices", {})).items():
                    if isinstance(value, (int, float)):
                        prices[key] = max(prices.get(key, 0), value)

    highest = max(
        [
            D(v)
            for k, v in prices.items()
            if k != "tiers" and not k.startswith("per_") and isinstance(v, (int, float))
        ]
        or [D(0)]
    )

    def rate(key, fallbacks=()):
        if isinstance(prices.get(key), (int, float)):
            return D(prices[key])
        candidates = [
            D(prices[k]) for k in fallbacks if isinstance(prices.get(k), (int, float))
        ]
        warnings.append(("fallback_price:" if candidates else "missing_price:") + key)
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
    total = max(raw_total, read, write, *raw_mods)
    out_total = max(
        count("output_tokens"),
        count("output_audio_tokens"),
        count("output_image_tokens"),
    )
    if (
        total != raw_total
        or out_total != count("output_tokens")
        or sum(raw_mods) + read + write > raw_total
    ):
        warnings.append("inconsistent_usage")
    mods = [min(total, v) for v in raw_mods]
    keys = ["input", "input_audio", "input_image", "input_video"]
    modal_rates = [rate(keys[i + 1], ("input",)) if mods[i] else D(0) for i in range(3)]
    overflow = max(D(0), sum(mods) - total)
    for i in sorted(range(3), key=lambda i: modal_rates[i]):
        cut = min(overflow, mods[i])
        mods[i] -= cut
        overflow -= cut
    capacity = [total - sum(mods)] + mods
    base = [rate("input") if capacity[0] else D(0)] + modal_rates
    input_cost = sum(capacity[i] * base[i] for i in range(4))
    remaining = capacity[:]

    def allocate(amount, prefix, explicit):
        nonlocal input_cost
        left = min(amount, total)
        for i in range(1, 4):
            fixed = min(left, remaining[i], explicit[i - 1])
            if fixed:
                r = rate(
                    "cache_"
                    + ("audio", "image", "video")[i - 1]
                    + ("_read" if prefix == "cache_read" else "_write"),
                    ("input_" + ("audio", "image", "video")[i - 1], prefix, "input"),
                )
                input_cost += fixed * (r - base[i])
                remaining[i] -= fixed
                left -= fixed
        choices = []
        for i in range(4):
            if remaining[i]:
                key = (
                    prefix
                    if i == 0
                    else "cache_"
                    + ("audio", "image", "video")[i - 1]
                    + ("_read" if prefix == "cache_read" else "_write")
                )
                fallback = (
                    ("input",)
                    if i == 0
                    else (
                        "input_" + ("audio", "image", "video")[i - 1],
                        prefix,
                        "input",
                    )
                )
                choices.append((rate(key, fallback) - base[i], i, rate(key, fallback)))
        for _, i, r in sorted(choices, reverse=True):
            take = min(left, remaining[i])
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
            (out_mod[i], rate("output_" + k, ("output",)) if out_mod[i] else D(0))
            for i, k in enumerate(("audio", "image"))
        ],
        key=lambda item: item[1],
        reverse=True,
    )
    for amount, modal_rate in output_modal:
        take = min(left, amount)
        output_cost += take * modal_rate
        left -= take
    image_only = model.get("capabilities", {}).get("output_modalities") == ["image"]
    if left:
        output_cost += left * rate(
            "output_image" if image_only else "output",
            ("output",) if image_only else (),
        )
    reasoning = count("reasoning_tokens")
    if reasoning:
        output_cost += reasoning * rate("reasoning", ("output",))
    input_cost *= multiplier / D(1000000)
    output_cost *= multiplier / D(1000000)

    def table(key):
        value = prices.get(key)
        if isinstance(value, (int, float)):
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
    if (
        count("output_images")
        and not count("output_image_tokens")
        and not (out_total and image_only)
    ):
        extra += count("output_images") * table("per_image")
    if count("output_video_seconds"):
        extra += count("output_video_seconds") * table("per_video_second")
    elif "per_video_second" in prices:
        warnings.append("missing_param:duration")
    if count("web_searches"):
        if "per_web_search" in prices:
            extra += count("web_searches") * D(prices["per_web_search"])
        else:
            warnings.append("missing_price:web_search")
    uplift = (
        D(model.get("region_uplift", {}).get(region, 1)) if region != "global" else D(1)
    )
    return {
        "input_usd": input_cost * uplift,
        "output_usd": output_cost * uplift,
        "extra_usd": extra * uplift,
        "total_usd": (input_cost + output_cost + extra) * uplift,
        "warnings": list(dict.fromkeys(warnings)),
    }

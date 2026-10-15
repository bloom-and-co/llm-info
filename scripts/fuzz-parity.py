import json
import sys
from pathlib import Path

sys.path.insert(0, "python")
from llm_info._engine import calculate

data = json.loads(Path("data/llm-info.json").read_text())
models = {(m["provider"], m["id"]): m for m in data["models"]}
cases = json.loads(Path(sys.argv[1]).read_text())
bad = 0
warning_diffs = 0
for case in cases:
    result = calculate(
        case["model"] if "model" in case else models[(case["p"], case["id"])],
        case["u"],
        case["opt"],
        case["mode"],
        case["region"],
    )
    unit = result.get("price_unit", "usd")
    mismatch = unit != case["unit"]
    for suffix, expected in [("usd", case["usd"]), ("credits", case["credits"])]:
        actual = [
            result.get(f"{bucket}_{suffix}")
            for bucket in ("input", "output", "extra", "total")
        ]
        if expected is None:
            mismatch |= any(value is not None for value in actual)
            continue
        for value, want in zip(actual, expected):
            if value is None or want is None:
                mismatch |= (value is None) != (want is None)
            else:
                mismatch |= abs(float(value) - want) > 1e-9 * max(1, abs(want))
    if mismatch:
        bad += 1
        if bad < 8:
            print("DIFF", case["id"], case["u"], case["unit"], unit, result)
    if sorted(result["warnings"]) != sorted(case["w"]):
        warning_diffs += 1
        if warning_diffs < 6:
            print("WDIFF", case["id"], case["u"], case["w"], result["warnings"])
print("total diffs", bad, "warning diffs", warning_diffs, "of", len(cases))
if bad or warning_diffs:
    sys.exit(1)

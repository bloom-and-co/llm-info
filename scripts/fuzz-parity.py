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
    if abs(float(result["total_usd"]) - case["t"]) > 1e-9 * max(1, case["t"]):
        bad += 1
        if bad < 8:
            print("DIFF", case["id"], case["u"], case["t"], result["total_usd"])
    if sorted(result["warnings"]) != sorted(case["w"]):
        warning_diffs += 1
        if warning_diffs < 6:
            print("WDIFF", case["id"], case["u"], case["w"], result["warnings"])
print("total diffs", bad, "warning diffs", warning_diffs, "of", len(cases))
if bad or warning_diffs:
    sys.exit(1)

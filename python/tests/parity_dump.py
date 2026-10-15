import copy
import json
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from llm_info import LlmInfo, MemoryStore

root = Path(__file__).resolve().parents[2]
data = json.loads((root / "tests/fixtures/llm-info-snapshot.json").read_text())
if "--elevenlabs" in sys.argv:
    out = []
    for case in json.loads((root / "tests/fixtures/elevenlabs-calc.json").read_text()):
        doc = copy.deepcopy(data)
        for model in doc["models"]:
            if model["provider"] == "elevenlabs" and model["id"] == case["model"]:
                model.update(case.get("overrides", {}))
        info = LlmInfo(store=MemoryStore(), fetch=lambda u, e: (200, None, doc))
        info.load()
        result = info.calc(
            "elevenlabs",
            case["model"],
            case["usage"],
            mode=case.get("mode", "standard"),
            region=case.get("region", "global"),
        )
        out.append(
            None
            if result is None
            else {
                "total": str(result["total_usd"]),
                "warnings": result["warnings"],
            }
        )
    print(json.dumps(out))
    sys.exit(0)
fixtures = json.loads((root / "tests/fixtures/responses.json").read_text())
fixtures += [
    {
        "name": "null_openai",
        "provider": "openai",
        "response": {
            "model": "gpt-4o",
            "usage": {
                "prompt_tokens": 10,
                "completion_tokens": 1,
                "prompt_tokens_details": None,
            },
        },
    },
    {
        "name": "null_google",
        "provider": "google",
        "response": {
            "modelVersion": "gemini-3.8-flash",
            "usageMetadata": {"promptTokenCount": 10, "thoughtsTokenCount": None},
        },
    },
    {
        "name": "vertex_predictions",
        "provider": "google",
        "response": {"predictions": [{}, {}]},
        "request": {"model": "imagen-3.0-fast-generate-001"},
    },
]
p = LlmInfo(store=MemoryStore(), fetch=lambda u, e: (200, None, data))
p.load()
out = []
for f in fixtures:
    cost = p.from_response(
        f["provider"],
        f["response"],
        f.get("request"),
        f.get("apiFlavor"),
        model=f.get("model"),
    )
    out.append(
        {
            "name": f["name"],
            "total": str(cost["total_usd"]),
            "warnings": cost["warnings"],
        }
    )
print(json.dumps(out))

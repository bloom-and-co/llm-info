import json
import sys
from decimal import Decimal
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from llm_prices import LlmPrices, MemoryStore

root = Path(__file__).resolve().parents[2]
data = json.loads((root / "data/prices.json").read_text())
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
p = LlmPrices(store=MemoryStore(), fetch=lambda u, e: (200, None, data))
p.load()
out = []
for f in fixtures:
    cost = p.from_response(
        f["provider"], f["response"], f.get("request"), f.get("apiFlavor")
    )
    out.append(
        {
            "name": f["name"],
            "total": str(cost["total_usd"]),
            "warnings": cost["warnings"],
        }
    )
print(json.dumps(out))

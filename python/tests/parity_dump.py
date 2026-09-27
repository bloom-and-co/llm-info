import json
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from llm_info import LlmInfo, MemoryStore

root = Path(__file__).resolve().parents[2]
data = json.loads((root / "data/llm-info.json").read_text())
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

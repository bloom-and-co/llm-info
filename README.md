# llm-info

A cached LLM price table and independent cost calculators for OpenAI, Anthropic, Google, and xAI. The builder merges [LiteLLM](https://github.com/BerriAI/litellm) and [models.dev](https://github.com/sst/models.dev) data. Conflicting prices use the higher value; the builder prints conflict counts in its log.

Reviewed supplements in [`builder/rules.mjs`](builder/rules.mjs) add officially documented facts missing from the feeds. Each rule records its provider, exact model IDs, effect, source URLs, and check date. Rules only add missing region multipliers or take the higher value, and each change is logged as `provider_rule`. The Anthropic rule adds `region_uplift.us = 1.1` for verified Claude 4.6 and later IDs, reflecting [`inference_geo: "us"`](https://platform.claude.com/docs/en/build-with-claude/data-residency). Use `region: 'us'` in JS or `region="us"` in Python; it stacks with fast mode and cache pricing. Unverified IDs (including Mythos Preview and dated Opus 4.6/4.7 variants) are excluded from the supplement. New IDs require review before being added; excluded models retain source prices and warn `missing_region_uplift` when no source supplies an uplift.

## Install

```sh
npm install github:bloom-and-co/llm-info
pip install "git+https://github.com/bloom-and-co/llm-info#subdirectory=python"
```

## JavaScript

```js
import { createLlmInfo } from '@bloom-and-co/llm-info';
import { fileStore } from '@bloom-and-co/llm-info/file';
const info = createLlmInfo({ store: fileStore() });
await info.load();
const cost = info.fromResponse({ provider: 'openai', apiFlavor: 'responses', response });
const direct = info.calc({ provider: 'openai', model: 'gpt-6-luna', usage: { input_tokens: 1000, output_tokens: 500 } });
const capabilities = info.capabilities({ provider: 'openai', model: 'gpt-6-luna' });
const models = info.models({ provider: 'openai' });
```

`fromResponse` (Python: `from_response`) uses `provider` to look up the model and its prices, and `apiFlavor` (Python: `api_flavor`) to select the response shape. They are independent: for Google AI Studio's OpenAI-compatible chat endpoint, pass `{ provider: 'google', apiFlavor: 'openai-chat', response }`; [Anthropic's OpenAI-compatible chat endpoint](https://platform.claude.com/docs/en/cli-sdks-libraries/libraries/openai-sdk) uses `{ provider: 'anthropic', apiFlavor: 'openai-chat', response }`. Supported flavors are `openai-chat` (`chat`), `openai-responses` (`responses`), `openai-embeddings` (`embeddings`), `openai-images` (`images`), `anthropic-messages`, `gemini-generate-content`, `gemini-embed-content`, `gemini-predict` (Imagen/Veo), `xai-chat`, `xai-responses`, and `xai-images`. If omitted, the provider's native shape is used; OpenAI and xAI also infer Responses and image responses from the body. An unknown flavor throws an error. A nonempty usage object that yields zero input and output tokens adds `usage_not_extracted` to the warnings. OpenAI-style `cache_write_tokens` is a subcount of prompt/input tokens, separate from cached/read tokens.

Pass the requested model as `model` to `extractUsage` or `fromResponse` (Python: `extract_usage(..., model=...)` or `from_response(..., model=...)`). It takes precedence over the response model and `request.model` for model matching, pricing, reasoning buckets, and modality rules. This is useful when the response reports an alias, an unknown version, or no model. For OpenAI-compatible Chat and Responses usage, output is the greater of the reported completion/output count (plus separately reported xAI Chat reasoning) and `total_tokens` minus prompt/input tokens. If the total increases output, `fromResponse` adds `output_from_total` to its warnings.

`load()` fetches into an empty cache. Stale data remains usable while a background refresh runs. Call `refresh({ force: true })` to wait for a refresh. Multiple instances can use separate stores. A store implements `read(): CacheDoc | null` and `write(doc): void`, synchronously or asynchronously. The main entry works in browsers and Workers; the `/file` entry uses Node.

A D1 store for Cloudflare Workers:

```js
// CREATE TABLE prices (id INTEGER PRIMARY KEY, doc TEXT NOT NULL);
const store = {
  async read() {
    const row = await env.DB.prepare('SELECT doc FROM prices WHERE id=1').first();
    return row ? JSON.parse(row.doc) : null;
  },
  async write(doc) {
    await env.DB.prepare('INSERT INTO prices(id,doc) VALUES(1,?) ON CONFLICT(id) DO UPDATE SET doc=excluded.doc')
      .bind(JSON.stringify(doc)).run();
  },
};
const info = createLlmInfo({ store });
await info.load();
```

## Python

```python
from llm_info import LlmInfo
info = LlmInfo()
info.load()
cost = info.from_response(provider='anthropic', response=response)
capabilities = info.capabilities(provider='anthropic', model='claude-opus-5-5')
models = info.models(provider='anthropic')
```

Python money fields are `Decimal`. Its API is synchronous; `auto_refresh` starts a daemon thread for stale cached data. The default cache path is `~/.cache/llm-info/llm-info.json` or `$XDG_CACHE_HOME/llm-info/llm-info.json`; `LLM_INFO_CACHE` overrides it. Both libraries support memory and file stores, fallback URLs, an acceptance hook, and events. The default data URL is `https://raw.githubusercontent.com/bloom-and-co/llm-info/main/data/llm-info.json`, with a jsDelivr fallback.

## Published data and calculation

`data/llm-info.json` has `schema: 2`, a version and timestamp, source fetch metadata with `latest_new_model_at`, a flat `models` array, and `skipped` rows with short reasons. Each model gives `provider`, `id`, `name`, `aliases`, deterministic `match` rules, `mode`, `prices`, `modes`, `region_uplift`, and `capabilities`. `mode` is the primary API kind: `chat`, `embedding`, `image_generation`, `video_generation`, `audio_speech`, `audio_transcription`, `realtime`, `moderation`, `rerank`, or `other`. LiteLLM's mode takes precedence over the kind inferred from models.dev output modalities; disagreements are logged during the build. Both JS and Python include `mode` in `models()` rows and `capabilities()` results. `modes` is separate and holds optional pricing tiers such as `fast` and `priority`.

Prices for token buckets are USD per million tokens. `per_image`, `per_video_second`, and `per_web_search` are USD per unit. A tier `{ "above_input_tokens": 272000, "prices": {...} }` applies only when total input is **greater** than 272,000. Exact dated model rows win over aliases and suffix matching. Known provider prefixes are stripped case insensitively. A `null` result means an unknown model; callers must not treat it as free.

Usage totals include their modality and cache subcounts. The engine makes disjoint input and output buckets, and never charges the same reported token twice. When cache and modality counts overlap without a detailed split, it chooses the allocation with the **highest plausible cost**. For example, 1 million input tokens with 600,000 audio and 500,000 cached tokens require at least 100,000 cached audio tokens; the remaining cache allocation follows the most expensive feasible split. Counts that exceed a total are clamped and add `inconsistent_usage`.

For image generation output with no modality breakdown, unattributed tokens use the image output rate and add `output_breakdown_missing`. The same conservative rule applies to image generation input and cache reads, and to audio input for transcription and realtime models, with `input_breakdown_missing` and `cache_breakdown_missing`. Explicit text and modality counts retain their reported rates. Direct `calc()` usage can provide `input_breakdown_present`, `output_breakdown_present`, or `cache_breakdown_present` as `1` when a complete external breakdown establishes that unspecified tokens are text.

A missing bucket price uses the most expensive applicable fallback and adds `fallback_price:<key>`; when no applicable price exists, it uses the model's highest token price and adds `missing_price:<key>`. Other warnings include `missing_price:mode:<mode>`, `missing_param:image_count`, `missing_param:duration`, `invalid_usage:<field>`, `unknown_region:<region>`, `missing_region_uplift`, and `stale_data`. Warnings describe estimates; they do not stop calculation. Image count charges apply only if output image tokens were not reported. For image-only models, reported output tokens also suppress the per-image charge. If a per-image count is unavailable, the calculator bills one image and warns.

`mode` accepts `standard`, `fast`, `priority`, `flex`, and `batch`. Mode prices override base prices. Where a mode has no tier price, the calculator applies the base tier ratio to its mode price. A mode multiplier applies to token cost. Missing `flex` or `batch` prices use standard prices and warn. Missing `priority` or `fast` prices use the provider's highest known mode multiplier, then a multiplier from the model's known modes, then 2× standard, and warn. `region` accepts `global`, `us`, and `eu` case insensitively; its uplift multiplies the total, including image and video charges. An OpenAI `service_tier` or Anthropic `usage.speed` may select a mode from a response. The builder merges capability fields from both sources and lists records it cannot publish in `skipped`.

## Known limitations

For Sora responses without a duration, the calculator uses the [Videos API's documented four-second default](https://platform.openai.com/docs/api-reference/videos) and warns.

xAI Chat Completions reports reasoning outside `completion_tokens`, so the wrapper adds it. The xAI Responses sample reports reasoning within `output_tokens`, so the wrapper does not add it again. See [Chat Completions](https://docs.x.ai/developers/rest-api-reference/inference/chat-completions) and [Responses](https://docs.x.ai/developers/rest-api-reference/inference/responses).

MIT licensed. See [NOTICE](NOTICE) for attribution.

## Development

Run `npm ci --ignore-scripts`, `npm test`, and `uv run --with pytest pytest -q python/tests` before a change. `npm run build:data` refreshes the checked-in price table from LiteLLM and models.dev. The parity fuzz harness lives in `scripts/`; it writes generated cases to a temporary file and leaves source files untouched.

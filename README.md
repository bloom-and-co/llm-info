# llm-info

A cached price table and thin cost calculators for OpenAI, Anthropic, Google, and xAI. Prices are built every six hours from [LiteLLM](https://github.com/BerriAI/litellm) and [models.dev](https://github.com/sst/models.dev), then validated with [genai-prices](https://github.com/pydantic/genai-prices). Conflicting fields use the higher price and appear in `data/llm-info.json`.

## Install

```sh
npm install github:bloom-and-co/llm-info
pip install "git+https://github.com/bloom-and-co/llm-info#subdirectory=python"
```

## JavaScript

```js
import { createLlmInfo } from '@bloom-and-co/llm-info';
import { fileStore } from '@bloom-and-co/llm-info/file';
const prices = createLlmInfo({ store: fileStore() });
await prices.load();
const cost = prices.fromResponse({ provider: 'openai', apiFlavor: 'responses', response });
// Or: prices.calc({ provider: 'openai', model: 'gpt-6-luna', usage: { input_tokens: 1000, output_tokens: 500 } });
const capabilities = prices.capabilities({ provider: 'openai', model: 'gpt-6-luna' });
const available = prices.models({ provider: 'openai' });
```

`load()` fetches on an empty cache. A stale cache is immediately usable while a background refresh runs. Call `refresh({force:true})` to wait for a refresh. The JS main entry works in Workers and browsers when given a `PriceStore`; the Node file store is available at `@bloom-and-co/llm-info/file`.

```js
import { createLlmInfo } from '@bloom-and-co/llm-info';
// D1 table: CREATE TABLE prices (id INTEGER PRIMARY KEY, doc TEXT NOT NULL)
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
const prices = createLlmInfo({ store });
```

A KV or Redis store has the same interface:

```js
const store = {
  read: async () => JSON.parse((await kv.get('llm-info')) || 'null'),
  write: async doc => { await kv.put('llm-info', JSON.stringify(doc)); },
};
```

## Python

```python
from llm_info import LlmInfo
prices = LlmInfo()
prices.load()
cost = prices.from_response(provider='anthropic', response=response)
capabilities = prices.capabilities(provider='anthropic', model='claude-opus-5-5')
available = prices.models(provider='anthropic')
# Money fields are Decimal.
```

Python uses a synchronous API. `auto_refresh` starts a daemon thread for stale cached data. Both libraries support memory and file stores, fallback URLs, an acceptance hook, and events. Default cache path is `~/.cache/llm-info/llm-info.json` or `$XDG_CACHE_HOME/llm-info/llm-info.json`; set `LLM_INFO_CACHE` to override it. The JSON data default URL is `https://raw.githubusercontent.com/bloom-and-co/llm-info/main/data/llm-info.json` with jsDelivr fallback.

`calc` and `fromResponse` (Python: `from_response`) accept `mode` (`standard`, `fast`, `priority`, `flex`, `batch`) and `region` (`global`, `us`, `eu`). The response's OpenAI `service_tier` or Anthropic `usage.speed` selects a mode when no explicit mode is given. A mode without a published price uses the highest known rate for that model and adds `missing_price:mode:<mode>`. Regional uplift applies to the whole computed amount, including image and video charges; the source does not split its multiplier by charge type. The builder takes the smaller limit when sources disagree and records disagreements in `capability_conflicts`.

For reasoning efforts, models.dev's effort list takes precedence. Otherwise the builder uses LiteLLM's `reasoning_effort_levels`, then only effort levels explicitly marked `supports_<level>_reasoning_effort: true`. It leaves the list `null` when no level is declared; it does not infer low, medium, or high from `supports_reasoning` alone.

MIT licensed. See [NOTICE](NOTICE) for upstream attribution.

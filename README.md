# llm-prices

A cached price table and thin cost calculators for OpenAI, Anthropic, Google, and xAI. Prices are built every six hours from [LiteLLM](https://github.com/BerriAI/litellm) and [models.dev](https://github.com/sst/models.dev), then validated with [genai-prices](https://github.com/pydantic/genai-prices). Conflicting fields use the higher price and appear in `data/prices.json`.

## Install

```sh
npm install github:bloom-and-co/llm-prices
pip install "git+https://github.com/bloom-and-co/llm-prices#subdirectory=python"
```

## JavaScript

```js
import { createLlmPrices } from '@bloom-and-co/llm-prices';
const prices = createLlmPrices();
await prices.load();
const cost = prices.fromResponse({ provider: 'openai', apiFlavor: 'responses', response });
// Or: prices.calc({ provider: 'openai', model: 'gpt-6-luna', usage: { input_tokens: 1000, output_tokens: 500 } });
```

`load()` fetches on an empty cache. A stale cache is immediately usable while a background refresh runs. Call `refresh({force:true})` to wait for a refresh. The JS main entry works in Workers and browsers when given a `PriceStore`; the default Node store is available at `@bloom-and-co/llm-prices/file`.

```js
import { createLlmPrices } from '@bloom-and-co/llm-prices';
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
const prices = createLlmPrices({ store });
```

A KV or Redis store has the same interface:

```js
const store = {
  read: async () => JSON.parse((await kv.get('llm-prices')) || 'null'),
  write: async doc => { await kv.put('llm-prices', JSON.stringify(doc)); },
};
```

## Python

```python
from llm_prices import LlmPrices
prices = LlmPrices()
prices.load()
cost = prices.from_response(provider='anthropic', response=response)
# Money fields are Decimal.
```

Python uses a synchronous API. `auto_refresh` starts a daemon thread for stale cached data. Both libraries support memory and file stores, fallback URLs, an acceptance hook, and events. Default cache path is `~/.cache/llm-prices/prices.json` or `$XDG_CACHE_HOME/llm-prices/prices.json`; set `LLM_PRICES_CACHE` to override it. The JSON data default URL is `https://raw.githubusercontent.com/bloom-and-co/llm-prices/main/data/prices.json` with jsDelivr fallback. Cost estimates exclude discounts and service tiers; a non-default tier produces a warning.

MIT licensed. See [NOTICE](NOTICE) for upstream attribution.

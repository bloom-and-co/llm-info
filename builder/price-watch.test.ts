import { expect, it, vi } from 'vitest';
import { mergeSources, finalize } from './core.mjs';
import { providerRules } from './rules.mjs';
import {
  optionalPriceWatch,
  priceWatchMetadata,
  validatePriceWatch,
  PRICE_WATCH_URL,
} from './price-watch.mjs';

const verified_at = '2026-10-16T00:00:00.000Z';
const model = (id = 'eleven_v3', prices = { per_character: 1.5 }) => ({
  provider: 'elevenlabs',
  id,
  feature: 'Text to Speech',
  price_unit: 'credit',
  prices,
  verified_at,
});
const feed = (models = [model()]) => ({
  schema: 1,
  verified_at: models.length ? verified_at : null,
  source_url: 'https://elevenlabs.io/pricing',
  models,
});

it('merges credit feed increases with reviewed rules and never lowers a reviewed price', () => {
  const input = feed([model(), model('eleven_flash_v2', { per_character: 0.1 })]);
  const before = structuredClone(input);
  const merged = mergeSources(
    {
      'elevenlabs/eleven_v3': { litellm_provider: 'elevenlabs', input_cost_per_character: 999 },
      'gpt-6-luna': {
        litellm_provider: 'openai',
        input_cost_per_token: 1e-6,
        output_cost_per_token: 2e-6,
      },
    },
    {},
    input,
  );
  expect(merged.models.find((row) => row.id === 'eleven_v3')).toMatchObject({
    price_unit: 'credit',
    prices: { per_character: 1.5 },
  });
  expect(merged.models.find((row) => row.id === 'eleven_flash_v2').prices.per_character).toBe(0.5);
  expect(merged.models.find((row) => row.id === 'gpt-6-luna').prices).toEqual({
    input: 1,
    output: 2,
  });
  expect(merged.models.filter((row) => row.provider === 'elevenlabs')).toHaveLength(12);
  expect(merged.conflicts).toContainEqual(
    expect.objectContaining({
      source_a: 'reviewed_rule',
      source_b: 'price_watch',
      prior: 1,
      candidate: 1.5,
      adopted: 1.5,
    }),
  );
  expect(input).toEqual(before);
});

it('accepts all reviewed exact IDs and compatible credit keys, including partial rows', () => {
  const rows = providerRules
    .filter((rule) => rule.provider === 'elevenlabs')
    .flatMap((rule) =>
      rule.model_selector.ids.map((id) => model(id, rule.effect.supplement.prices)),
    );
  expect(validatePriceWatch(feed(rows))).toHaveProperty('models', rows);
  expect(validatePriceWatch(feed([])).verified_at).toBeNull();
  expect(
    validatePriceWatch(feed([model('scribe_v2', { per_input_audio_second: 330 / 60 })])).models,
  ).toHaveLength(1);
});

it.each([
  [
    'wrong schema',
    (d) => {
      d.schema = 2;
    },
  ],
  [
    'wrong source',
    (d) => {
      d.source_url += '/api';
    },
  ],
  [
    'USD',
    (d) => {
      d.models[0].price_unit = 'usd';
    },
  ],
  [
    'wrong provider',
    (d) => {
      d.models[0].provider = 'openai';
    },
  ],
  [
    'unreviewed ID',
    (d) => {
      d.models[0].id += '-latest';
    },
  ],
  [
    'wrong unit',
    (d) => {
      d.models[0].prices = { per_output_audio_second: 20 };
    },
  ],
  [
    'negative',
    (d) => {
      d.models[0].prices.per_character = -1;
    },
  ],
  [
    'nonfinite',
    (d) => {
      d.models[0].prices.per_character = Infinity;
    },
  ],
  [
    'string number',
    (d) => {
      d.models[0].prices.per_character = '1';
    },
  ],
  [
    'missing feature',
    (d) => {
      delete d.models[0].feature;
    },
  ],
  [
    'empty prices',
    (d) => {
      d.models[0].prices = {};
    },
  ],
  [
    'duplicate ID',
    (d) => {
      d.models.push(d.models[0]);
    },
  ],
  [
    'missing verification',
    (d) => {
      d.models[0].verified_at = null;
    },
  ],
  [
    'misleading top verification',
    (d) => {
      d.verified_at = '2026-10-17T00:00:00.000Z';
    },
  ],
  [
    'empty with verification',
    (d) => {
      d.models = [];
    },
  ],
])('rejects the entire feed for %s', (_name, change) => {
  const data: any = feed();
  change(data);
  expect(() => validatePriceWatch(data)).toThrow();
});

it.each(['http', 'json', 'shape', 'network'])(
  'skips only the optional source on %s failure',
  async (kind) => {
    const fetcher = vi.fn(async () => {
      if (kind === 'network') throw Error('network unavailable');
      if (kind === 'http') return new Response('', { status: 503 });
      return new Response(kind === 'json' ? 'not JSON' : '{"schema":99}');
    });
    const warn = vi.fn();
    const result = await optionalPriceWatch('https://custom.example/prices.json', fetcher, warn);
    expect(result).toBeNull();
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('skipped price_watch:'));
    const output = mergeSources({}, {}, result?.data);
    expect(output.models).toHaveLength(12);
    expect(output.models.find((row) => row.id === 'eleven_v3').prices.per_character).toBe(1);
  },
);

it('fetches the configurable URL and preserves source provenance even for unchanged prices', async () => {
  const fetcher = vi.fn(
    async () =>
      new Response(JSON.stringify(feed([model('eleven_v3', { per_character: 1 })])), {
        headers: { etag: 'feed-etag' },
      }),
  );
  const result = await optionalPriceWatch('https://custom.example/prices.json', fetcher);
  expect(fetcher.mock.calls[0][0]).toBe('https://custom.example/prices.json');
  const metadata = priceWatchMetadata(result, null, new Set());
  expect(metadata).toMatchObject({
    url: 'https://custom.example/prices.json',
    etag: 'feed-etag',
    source_url: 'https://elevenlabs.io/pricing',
    verified_at,
    models: [{ id: 'eleven_v3', feature: 'Text to Speech', verified_at }],
  });
  const previous = { models: mergeSources({}, {}).models, skipped: [], sources: {} };
  const next = { ...previous, sources: { price_watch: metadata } };
  const published = finalize(next, previous, verified_at);
  expect(published).not.toBe(previous);
  expect(published.sources.price_watch).toEqual(metadata);
  expect(
    finalize(
      { ...published, sources: { price_watch: { ...metadata, fetched_at: 'later', etag: 'new' } } },
      published,
    ),
  ).toBe(published);
  expect(PRICE_WATCH_URL).toBe('https://llm-price-watch.hangar.fctry.jp/prices.json');
});

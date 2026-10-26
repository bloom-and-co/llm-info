import { expect, it, vi } from 'vitest';
import { mergeSources, finalize } from './core.mjs';
import { providerRules } from './rules.mjs';
import {
  feedFromMetadata,
  previousRows,
  priceWatchMetadata,
  resolvePriceWatch,
  validatePriceWatch,
  verifyPriceWatch,
  PRICE_WATCH_URL,
  PRICE_WATCH_MAX_BYTES,
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
  expect(merged.models.filter((row) => row.provider === 'elevenlabs')).toHaveLength(14);
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
      rule.model_selector.ids.map((id) =>
        model(
          id,
          Object.fromEntries(
            Object.entries(rule.effect.supplement.prices).filter(([, value]) => value > 0),
          ),
        ),
      ),
    );
  expect(rows).toHaveLength(14);
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
    'zero',
    (d) => {
      d.models[0].prices.per_character = 0;
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

const stored = () => ({
  url: 'https://old.example/verify',
  source_url: 'https://elevenlabs.io/pricing',
  fetched_at: verified_at,
  verified_at,
  latest_new_model_at: verified_at,
  models: [
    { id: 'eleven_v3', feature: 'Text to Speech', prices: { per_character: 1.5 }, verified_at },
  ],
});
const TOKEN = 'test-only-price-watch-token-0123456789abcdef';

it('reads the stored feed back from git metadata and sends it as previous rows', () => {
  const data = feedFromMetadata(stored());
  expect(data).toEqual(feed());
  expect(previousRows(data)).toEqual([
    {
      model_id: 'eleven_v3',
      feature: 'Text to Speech',
      price_key: 'per_character',
      credit_price: 1.5,
      verified_at,
    },
  ]);
  expect(feedFromMetadata(undefined)).toBeNull();
  const legacy: any = stored();
  delete legacy.models[0].prices;
  expect(() => feedFromMetadata(legacy)).toThrow('invalid price-watch model: eleven_v3');
});

it('uses the stored feed without calling Hangar outside verify runs', async () => {
  const fetcher = vi.fn();
  const result = await resolvePriceWatch({ previous: stored(), verify: false, fetcher });
  expect(fetcher).not.toHaveBeenCalled();
  expect(result).toEqual({
    feed: { data: feed(), url: 'https://old.example/verify', fetched_at: verified_at },
    events: [],
  });
});

it('posts previous rows with the bearer token and returns the verified feed and events', async () => {
  const later = '2026-10-17T00:00:00.000Z';
  const events = [{ type: 'verification_failure', feature_key: 'tts', reason: 'missing_rate' }];
  const fetcher = vi.fn(async () =>
    Response.json({ ok: false, feed: { ...feed(), verified_at }, events }),
  );
  const result = await resolvePriceWatch({
    previous: stored(),
    verify: true,
    url: 'https://custom.example/verify',
    token: TOKEN,
    fetcher,
  });
  const [url, init] = fetcher.mock.calls[0] as any;
  expect(url).toBe('https://custom.example/verify');
  expect(init.method).toBe('POST');
  expect(init.headers.authorization).toBe('Bearer ' + TOKEN);
  expect(JSON.parse(init.body)).toEqual({ previous: previousRows(feed()) });
  expect(result.events).toEqual(events);
  expect(result.feed).toMatchObject({ data: feed(), url: 'https://custom.example/verify' });
  expect(result.feed.fetched_at > later).toBe(true);
  expect(PRICE_WATCH_URL).toBe('https://llm-price-watch.hangar.fctry.jp/verify');
});

it.each(['token', 'http', 'json', 'events', 'feed', 'network'])(
  'keeps the stored feed and reports a request failure on %s',
  async (kind) => {
    const fetcher = vi.fn(async () => {
      if (kind === 'network') throw Error('network unavailable');
      if (kind === 'http') return new Response('{"ok":false}', { status: 401 });
      if (kind === 'json') return new Response('not JSON');
      if (kind === 'events') return Response.json({ feed: feed(), events: [{}] });
      return Response.json({ feed: { schema: 99 }, events: [] });
    });
    const warn = vi.fn();
    const result = await resolvePriceWatch({
      previous: stored(),
      verify: true,
      token: kind === 'token' ? undefined : TOKEN,
      fetcher,
      warn,
    });
    expect(fetcher).toHaveBeenCalledTimes(kind === 'token' ? 0 : 1);
    expect(result.feed?.data).toEqual(feed());
    expect(result.events).toEqual([{ type: 'request_failure', reason: expect.any(String) }]);
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('verification failed:'));
  },
);

it('stores prices and drops the old etag in the published metadata', () => {
  const metadata = priceWatchMetadata(
    { data: feed(), url: 'https://custom.example/verify', fetched_at: verified_at },
    null,
    new Set(),
  );
  expect(metadata).toEqual({ ...stored(), url: 'https://custom.example/verify' });
  const previous = { models: mergeSources({}, {}).models, skipped: [], sources: {} };
  const next = { ...previous, sources: { price_watch: metadata } };
  const published = finalize(next, previous, verified_at);
  expect(published).not.toBe(previous);
  expect(published.sources.price_watch).toEqual(metadata);
  expect(
    finalize(
      { ...published, sources: { price_watch: { ...metadata, fetched_at: 'later' } } },
      published,
    ),
  ).toBe(published);
});

it.each(['declared', 'chunked', 'lying-header'])(
  'bounds %s response bytes and cancels the body',
  async (kind) => {
    const cancel = vi.fn();
    const stream = new ReadableStream({
      start(controller) {
        controller.enqueue(new Uint8Array(PRICE_WATCH_MAX_BYTES + 1));
      },
      cancel,
    });
    const headers =
      kind === 'declared'
        ? { 'content-length': String(PRICE_WATCH_MAX_BYTES + 1) }
        : kind === 'lying-header'
          ? { 'content-length': '1' }
          : {};
    await expect(
      verifyPriceWatch(PRICE_WATCH_URL, TOKEN, [], async () => new Response(stream, { headers })),
    ).rejects.toThrow(`exceeds ${PRICE_WATCH_MAX_BYTES} bytes`);
    expect(cancel).toHaveBeenCalledOnce();
  },
);
it('does not publish data for verification-only changes but retains price and source changes', () => {
  const previous = {
    models: mergeSources({}, {}).models,
    skipped: [],
    sources: {
      price_watch: {
        url: PRICE_WATCH_URL,
        source_url: 'https://elevenlabs.io/pricing',
        verified_at,
        models: [{ id: 'eleven_v3', feature: 'Text to Speech', verified_at }],
      },
    },
  };
  const next = structuredClone(previous);
  next.sources.price_watch.verified_at = '2026-10-17T00:00:00.000Z';
  next.sources.price_watch.models[0].verified_at = '2026-10-17T00:00:00.000Z';
  expect(finalize(next, previous)).toBe(previous);
  const changed = structuredClone(next);
  changed.models.find((row) => row.id === 'eleven_v3').prices.per_character = 1.1;
  expect(finalize(changed, previous)).not.toBe(previous);
  next.sources.price_watch.models[0].feature = 'Updated source name';
  expect(finalize(next, previous)).not.toBe(previous);
});

it.each([0.5, 1, 1.5])(
  'merges realtime input-audio credits at %s times the reviewed rate',
  (ratio) => {
    const rate = (4 / 9) * (0.39 / 0.22);
    const input = feed([model('scribe_v2_realtime', { per_input_audio_second: rate * ratio })]);
    expect(validatePriceWatch(input)).toBe(input);
    const merged = mergeSources({}, {}, input);
    expect(merged.models.find((row) => row.id === 'scribe_v2_realtime')).toMatchObject({
      mode: 'realtime',
      price_unit: 'credit',
      prices: { per_input_audio_second: rate * Math.max(1, ratio) },
      capabilities: { endpoints: ['/v1/speech-to-text/realtime'] },
    });
  },
);
it.each([
  ['scribe_v2_realtime-latest', { per_input_audio_second: 1 }],
  ['scribe_v2_realtime', { per_output_audio_second: 1 }],
  ['scribe_v2_realtime', { per_character: 1 }],
])('rejects unreviewed realtime aliases or dimensions: %s %j', (id, prices) => {
  expect(() => validatePriceWatch(feed([model(id, prices)]))).toThrow('invalid price-watch model:');
});

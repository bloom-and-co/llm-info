import { beforeEach, describe, it, expect, vi } from 'vitest';
import { extractUsage as sdkExtract } from '@pydantic/genai-prices';
import { readFile, mkdtemp, rm, readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
const data = JSON.parse(await readFile('data/prices.json', 'utf8'));
let api: any;
beforeEach(async () => {
  vi.resetModules();
  api = await import('../src/index.ts');
});
const response = (body: any = data, status = 200, etag = 'x') =>
  new Response(status === 304 ? null : JSON.stringify(body), { status, headers: { etag } });
const client = (fetcher: any = async () => response(), store?: any, extra: any = {}) =>
  api.createLlmPrices({ store: store ?? api.memoryStore(), fetch: fetcher, ...extra });
it('requires load and enforces singleton', () => {
  const p = client();
  expect(() =>
    p.calc({ provider: 'openai', model: 'gpt-6-luna', usage: { input_tokens: 1 } }),
  ).toThrow('not loaded');
  expect(() => client()).toThrow('Only one');
});
it('loads empty store and calculates all four providers', async () => {
  const p = client();
  await p.load();
  for (const [provider, model, expected] of [
    ['openai', 'gpt-6-luna', 0.0006],
    ['anthropic', 'claude-opus-5-5', 0.024],
    ['google', 'gemini-3.8-flash', 0.0045],
    ['x-ai', 'grok-4.7', 0.008],
  ] as const)
    expect(
      p.calc({ provider, model, usage: { input_tokens: 1000, output_tokens: 1000 } })?.totalUsd,
    ).toBeCloseTo(expected, 8);
});
it('matches dated snapshots and separates gpt-6 from luna', async () => {
  const p = client();
  await p.load();
  expect(
    p.calc({ provider: 'openai', model: 'gpt-6-luna-2026-09-22', usage: { input_tokens: 1000 } })
      ?.model,
  ).toBe('gpt-6-luna');
  expect(
    p.calc({ provider: 'openai', model: 'gpt-6-luna-2026-09-22', usage: { input_tokens: 1000 } })
      ?.model,
  ).not.toBe('gpt-6');
  expect(
    p.calc({ provider: 'openai', model: 'definitely-unknown', usage: { input_tokens: 1 } }),
  ).toBeNull();
  expect(
    p.calc({ provider: 'openai', model: 'text-davinci-003', usage: { input_tokens: 1 } }),
  ).toBeNull();
});
it('uses fallback and 304', async () => {
  let calls = 0;
  const p = client(
    async () => {
      calls++;
      return calls === 1 ? response({}, 503) : calls === 2 ? response() : response(null, 304);
    },
    undefined,
    { fallbackUrls: ['fallback'] },
  );
  await p.load();
  expect(calls).toBe(2);
  expect((await p.refresh({ force: true })).status).toBe('not_modified');
});
it('keeps cached data on network errors and rejects old, invalid, and vetoed data', async () => {
  let next: any = response();
  const p = client(async () => next, undefined, {
    fallbackUrls: [],
    accept: (n: any) => n.version !== 'veto',
  });
  await p.load();
  next = response({}, 503);
  expect((await p.refresh({ force: true })).status).toBe('error');
  expect(p.info().lastError).toContain('503');
  next = response({});
  expect((await p.refresh({ force: true })).reason).toBe('invalid_shape');
  next = response({ ...data, generated_at: '2000-01-01T00:00:00Z' });
  expect((await p.refresh({ force: true })).reason).toBe('older_data');
  next = response({ ...data, version: 'veto' });
  expect((await p.refresh({ force: true })).reason).toBe('accept_false');
});
it('stale cache is usable while refresh runs', async () => {
  const old = {
    cache_schema: 1,
    source_url: 'x',
    fetched_at: '2000-01-01T00:00:00Z',
    etag: null,
    last_attempt_at: 'x',
    last_error: null,
    data,
  };
  let resolve: any;
  const p = client(() => new Promise((r) => (resolve = r)), api.memoryStore(old));
  const info = await p.load();
  expect(info.stale).toBe(true);
  expect(
    p.calc({ provider: 'openai', model: 'gpt-6-luna', usage: { input_tokens: 1 } }),
  ).not.toBeNull();
  resolve(response());
  await vi.waitFor(() => expect(p.info().stale).toBe(false));
});
it('file and memory stores preserve newer data', async () => {
  const { fileStore } = await import('../src/file.ts');
  const dir = await mkdtemp(join(tmpdir(), 'prices-'));
  try {
    const s = fileStore(join(dir, 'cache.json'));
    const newer = {
      cache_schema: 1,
      data,
      ...{ source_url: 'x', fetched_at: 'x', etag: null, last_attempt_at: 'x', last_error: null },
    };
    await s.write(newer);
    await s.write({ ...newer, data: { ...data, generated_at: '2000-01-01T00:00:00Z' } });
    expect((await s.read())?.data.version).toBe(data.version);
    expect(await readdir(dir)).toEqual(['cache.json']);
    const mem = api.memoryStore(newer);
    await mem.write({ ...newer, data: { ...data, generated_at: '2000-01-01T00:00:00Z' } });
    expect((await mem.read()).data.version).toBe(data.version);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
it('extracts realistic response flavors and hand-calculated totals', async () => {
  const p = client();
  await p.load();
  const chat = p.fromResponse({
    provider: 'openai',
    apiFlavor: 'chat',
    response: { model: 'gpt-6-luna', usage: { prompt_tokens: 1000, completion_tokens: 100 } },
  });
  expect(chat.totalUsd).toBeCloseTo(0.00015, 8);
  const ant = p.fromResponse({
    provider: 'anthropic',
    response: {
      model: 'claude-opus-5-5',
      usage: {
        input_tokens: 1000,
        output_tokens: 200,
        cache_creation_input_tokens: 100,
        cache_read_input_tokens: 50,
      },
    },
  });
  expect(ant.totalUsd).toBeCloseTo(0.00851, 8);
  const gem = p.fromResponse({
    provider: 'google',
    response: {
      modelVersion: 'gemini-3.8-flash',
      usageMetadata: { promptTokenCount: 1000, candidatesTokenCount: 100 },
    },
  });
  expect(gem.totalUsd).toBeCloseTo(0.001125, 8);
  const x = p.fromResponse({
    provider: 'x-ai',
    response: { model: 'grok-4.7', usage: { prompt_tokens: 1000, completion_tokens: 100 } },
  });
  expect(x.totalUsd).toBeCloseTo(0.0026, 8);
});
it('charges images, video, and warns on missing price', async () => {
  const p = client();
  await p.load();
  const image = p.fromResponse({
    provider: 'google',
    response: { generatedImages: [{}, {}] },
    request: { model: 'imagen-3.0-fast-generate-001' },
  });
  expect(image.extraUsd).toBeCloseTo(0.04);
  const video = p.fromResponse({
    provider: 'google',
    response: {},
    request: { model: 'veo-3.1-generate-001', duration: 5 },
  });
  expect(video.extraUsd).toBeCloseTo(2);
  const missing = p.calc({ provider: 'openai', model: 'gpt-6-luna', usage: { output_images: 1 } });
  expect(missing.warnings).toContain('missing_price:per_image');
});

it('prices every response fixture', async () => {
  const p = client();
  await p.load();
  const fixtures = JSON.parse(await readFile('tests/fixtures/responses.json', 'utf8'));
  for (const f of fixtures) expect(p.fromResponse(f)?.totalUsd, f.name).toBeCloseTo(f.expected, 8);
});

it('uses size and resolution variants', async () => {
  const p = client();
  await p.load();
  const image = p.calc({
    provider: 'openai',
    model: 'gpt-image-1',
    usage: { output_images: 1 },
    options: { size: '1024x1024', quality: 'high' },
  });
  expect(image.extraUsd).toBeCloseTo(0.167, 3);
  const video = p.calc({
    provider: 'google',
    model: 'veo-3.1-lite-generate-preview',
    usage: { output_video_seconds: 2 },
    options: { resolution: '1080p' },
  });
  expect(video.extraUsd).toBeCloseTo(0.16, 8);
});

it('SDK extractor counts Google image tokens once', () => {
  const provider = data.providers.find((p: any) => p.id === 'google');
  const fixture = {
    modelVersion: 'gemini-3.1-flash-image',
    usageMetadata: {
      promptTokenCount: 100,
      candidatesTokenCount: 100,
      candidatesTokensDetails: [{ modality: 'IMAGE', tokenCount: 50 }],
    },
  };
  expect(sdkExtract(provider, fixture).usage.output_image_tokens).toBe(50);
});

it('prices Gemini text and image output tokens at separate rates', async () => {
  const p = client();
  await p.load();
  const cost = p.fromResponse({
    provider: 'google',
    response: {
      modelVersion: 'gemini-3.1-flash-image',
      usageMetadata: {
        promptTokenCount: 100,
        candidatesTokenCount: 100,
        candidatesTokensDetails: [{ modality: 'IMAGE', tokenCount: 50 }],
      },
    },
  });
  // 100 input × $0.50/M + 50 text output × $3/M + 50 image output × $60/M.
  expect(cost.inputUsd).toBeCloseTo(0.00005, 8);
  expect(cost.outputUsd).toBeCloseTo(0.00315, 8);
  expect(cost.totalUsd).toBeCloseTo(0.0032, 8);
});

it('charges exact dated rows and image-only output tokens', async () => {
  const p = client();
  await p.load();
  expect(
    p.calc({ provider: 'openai', model: 'gpt-4o-2024-05-13', usage: { input_tokens: 1_000_000 } })
      ?.inputUsd,
  ).toBe(5);
  expect(
    p.fromResponse({
      provider: 'openai',
      apiFlavor: 'images',
      response: { usage: { output_tokens: 1_000_000 }, data: [{}] },
      request: { model: 'gpt-image-2' },
    })?.outputUsd,
  ).toBe(30);
});

it('accounts for Gemini audio, tool input, and image reasoning', async () => {
  const p = client();
  await p.load();
  const usage = p.extractUsage({
    provider: 'google',
    response: {
      modelVersion: 'gemini-3.8-flash',
      usageMetadata: {
        promptTokenCount: 100,
        toolUsePromptTokenCount: 20,
        cachedContentTokenCount: 10,
        candidatesTokenCount: 10,
        promptTokensDetails: [{ modality: 'AUDIO', tokenCount: 30 }],
        cacheTokensDetails: [{ modality: 'AUDIO', tokenCount: 5 }],
        candidatesTokensDetails: [{ modality: 'AUDIO', tokenCount: 4 }],
        toolUsePromptTokensDetails: [{ modality: 'AUDIO', tokenCount: 3 }],
      },
    },
  }).usage;
  expect(usage).toMatchObject({
    input_tokens: 120,
    input_audio_tokens: 33,
    cache_audio_read_tokens: 5,
    output_audio_tokens: 4,
  });
  const cost = p.fromResponse({
    provider: 'google',
    response: {
      modelVersion: 'gemini-2.5-flash-image',
      usageMetadata: {
        promptTokenCount: 100,
        candidatesTokenCount: 50,
        thoughtsTokenCount: 10,
        candidatesTokensDetails: [{ modality: 'IMAGE', tokenCount: 50 }],
      },
    },
  });
  expect(cost.outputUsd).toBeGreaterThan(0.0015);
});

it('charges video counts and warns when duration is unknown', async () => {
  const p = client();
  await p.load();
  expect(
    p.fromResponse({
      provider: 'google',
      response: { generatedVideos: [{}, {}] },
      request: { model: 'veo-3.1-generate-001', parameters: { durationSeconds: '5' } },
    })?.extraUsd,
  ).toBe(4);
  expect(
    p.fromResponse({ provider: 'openai', response: { seconds: '5' }, request: { model: 'sora-2' } })
      ?.extraUsd,
  ).toBeGreaterThan(0);
  expect(
    p.fromResponse({ provider: 'openai', response: {}, request: { model: 'sora-2' } })?.warnings,
  ).toContain('missing_param:duration');
});

it('survives null usage fields and counts Vertex predictions', async () => {
  const p = client();
  await p.load();
  expect(() =>
    p.fromResponse({
      provider: 'openai',
      response: {
        model: 'gpt-4o',
        usage: { prompt_tokens: 10, completion_tokens: 1, prompt_tokens_details: null },
      },
    }),
  ).not.toThrow();
  expect(() =>
    p.fromResponse({
      provider: 'google',
      response: {
        modelVersion: 'gemini-3.8-flash',
        usageMetadata: { promptTokenCount: 10, thoughtsTokenCount: null },
      },
    }),
  ).not.toThrow();
  expect(
    p.fromResponse({
      provider: 'google',
      response: { predictions: [{}, {}] },
      request: { model: 'imagen-3.0-fast-generate-001' },
    })?.extraUsd,
  ).toBe(0.04);
});

it('charges xAI reasoning and Anthropic web searches', async () => {
  const p = client();
  await p.load();
  const x = p.fromResponse({
    provider: 'x-ai',
    response: {
      model: 'grok-4.7',
      usage: {
        prompt_tokens: 100,
        completion_tokens: 10,
        completion_tokens_details: { reasoning_tokens: 20 },
      },
    },
  });
  expect(x.outputUsd).toBeCloseTo((30 * 6) / 1e6, 9);
  const a = p.fromResponse({
    provider: 'anthropic',
    response: {
      model: 'claude-opus-5-5',
      usage: { input_tokens: 1, output_tokens: 1, server_tool_use: { web_search_requests: 2 } },
    },
  });
  expect(a.usage.web_searches).toBe(2);
  expect(a.extraUsd).toBeCloseTo(0.02, 9);
});

it('warns on unpriced web searches', async () => {
  const p = client();
  await p.load();
  const cost = p.calc({
    provider: 'openai',
    model: 'chat-latest',
    usage: { input_tokens: 1, web_searches: 1 },
  });
  expect(cost.warnings).toContain('missing_price:web_search');
});

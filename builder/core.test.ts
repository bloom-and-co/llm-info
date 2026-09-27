import { it, expect } from 'vitest';
import { readFile } from 'node:fs/promises';
import { mergeSources, validate, finalize, normalizeId } from './core.mjs';
const gp = JSON.parse(await readFile('.work/gp.json', 'utf8'));
it('normalizes provider prefixes', () => {
  expect(normalizeId('gemini/gemini-3.8-flash', 'google')).toBe('gemini-3.8-flash');
  expect(normalizeId('xai/grok-4.7', 'x-ai')).toBe('grok-4.7');
});
it('adopts higher price and records conflicts', () => {
  const lite = {
    'gpt-6-luna': {
      litellm_provider: 'openai',
      input_cost_per_token: 2e-6,
      output_cost_per_token: 1e-6,
    },
  };
  const models = { openai: { models: { 'gpt-6-luna': { cost: { input: 1, output: 3 } } } } };
  const d = mergeSources(lite, models, gp);
  const m = d.providers[0].models[0];
  expect(m.prices.input_mtok).toBe(2);
  expect(m.prices.output_mtok).toBe(3);
  expect(d.conflicts).toHaveLength(2);
});
it('maps context tiers with greater-than boundary', () => {
  const d = mergeSources(
    {},
    {
      openai: {
        models: {
          'gpt-6-luna': {
            cost: {
              input: 1,
              output: 2,
              tiers: [{ input: 3, tier: { type: 'context', size: 272000 } }],
            },
          },
        },
      },
    },
    gp,
  );
  expect((d.providers[0].models[0].prices.input_mtok as any).tiers[0].start).toBe(271999);
});
it('output version remains stable and validation catches bad prices and drops', async () => {
  const d = JSON.parse(await readFile('data/prices.json', 'utf8'));
  expect(finalize(d, d)).toBe(d);
  const bad = structuredClone(d);
  bad.providers[0].models[0].prices.input_mtok = -1;
  expect(() => validate(bad)).toThrow('invalid price');
  const drop = structuredClone(d);
  drop.providers[0].models = drop.providers[0].models.slice(0, 2);
  expect(() => validate(drop, d)).toThrow('model count dropped');
});
it('maps per-pixel image variants and resolution video rates', () => {
  const lite = {
    'high/100-x-200/gpt-image-test': {
      litellm_provider: 'openai',
      mode: 'image_generation',
      input_cost_per_pixel: 0.000001,
    },
    'gemini/veo-test': {
      litellm_provider: 'gemini',
      mode: 'video_generation',
      output_cost_per_second: 0.05,
      output_cost_per_second_1080p: 0.08,
    },
  };
  const d = mergeSources(lite, {}, gp);
  expect(
    d.providers.find((p) => p.id === 'openai')!.models.find((m) => m.id === 'gpt-image-test')!
      .x_extra_prices.per_image['100x200/high'],
  ).toBeCloseTo(0.02);
  expect(
    d.providers.find((p) => p.id === 'google')!.models.find((m) => m.id === 'veo-test')!
      .x_extra_prices.per_video_second['1080p'],
  ).toBe(0.08);
});

it('does not duplicate existing image extractor mappings', () => {
  const d = mergeSources({}, {}, gp);
  const google = d.providers.find((p) => p.id === 'google')!;
  const ex = google.extractors!.find((e) => e.api_flavor === 'default')!;
  expect(ex.mappings.filter((m) => m.dest === 'output_image_tokens')).toHaveLength(1);
  expect(
    d.providers
      .find((p) => p.id === 'openai')!
      .extractors!.filter((e) => e.api_flavor === 'images'),
  ).toHaveLength(1);
});

it('does not publish one-hour cache write fields or extractors', () => {
  const d = mergeSources(
    {
      'claude-test': {
        litellm_provider: 'anthropic',
        input_cost_per_token: 1e-6,
        cache_creation_input_token_cost_above_1hr: 1e-6,
        cache_creation_input_token_cost: 2e-6,
      },
    },
    {},
    gp,
  );
  const anthropic = d.providers.find((p) => p.id === 'anthropic')!;
  expect(anthropic.models[0].x_extra_prices?.cache_write_1h_mtok).toBeUndefined();
  expect(JSON.stringify(d.providers.map((p) => p.extractors))).not.toContain(
    'ephemeral_1h_input_tokens',
  );
});

it('keeps text and image output prices separate for image models', () => {
  const lite = {
    'gpt-image-2': {
      litellm_provider: 'openai',
      mode: 'image_generation',
      output_cost_per_token: 10e-6,
      output_cost_per_image_token: 25e-6,
    },
    'gemini/gemini-3.1-flash-image': {
      litellm_provider: 'gemini',
      mode: 'image_generation',
      output_cost_per_token: 3e-6,
      output_cost_per_image_token: 50e-6,
    },
  };
  const models = {
    openai: {
      models: { 'gpt-image-2': { modalities: { output: ['image'] }, cost: { output: 30 } } },
    },
    google: {
      models: {
        'gemini-3.1-flash-image': {
          modalities: { output: ['text', 'image'] },
          cost: { output: 60 },
        },
      },
    },
  };
  const d = mergeSources(lite, models, gp);
  for (const [provider, id, text, image, prior] of [
    ['openai', 'gpt-image-2', 10, 30, 25],
    ['google', 'gemini-3.1-flash-image', 3, 60, 50],
  ] as const) {
    const m = d.providers.find((p) => p.id === provider)!.models.find((m) => m.id === id)!;
    expect(m.prices.output_mtok).toBe(text);
    expect(m.prices.output_image_mtok).toBe(image);
    expect(d.conflicts).toContainEqual({
      provider,
      model: id,
      field: 'output_image_mtok',
      litellm: prior,
      models_dev: image,
      adopted: image,
    });
    expect(
      d.conflicts.find(
        (c) => c.provider === provider && c.model === id && c.field === 'output_mtok',
      ),
    ).toBeUndefined();
  }
});

it('records every differing field merged from two sources', () => {
  const lite = {
    'gpt-image-2': {
      litellm_provider: 'openai',
      mode: 'image_generation',
      input_cost_per_token: 2e-6,
      output_cost_per_token: 10e-6,
      output_cost_per_image_token: 25e-6,
    },
  };
  const models = {
    openai: {
      models: {
        'gpt-image-2': { modalities: { output: ['image'] }, cost: { input: 3, output: 30 } },
      },
    },
  };
  const d = mergeSources(lite, models, gp);
  expect(
    d.conflicts
      .filter((c) => c.model === 'gpt-image-2')
      .map((c) => c.field)
      .sort(),
  ).toEqual(['input_mtok', 'output_image_mtok']);
});

it('sets image-only output parent price and keeps dated matches unique', () => {
  const d = mergeSources(
    {},
    {
      openai: {
        models: {
          'gpt-image-only': { modalities: { output: ['image'] }, cost: { output: 30 } },
          'gpt-4o': { cost: { input: 2.5, output: 10 } },
          'gpt-4o-2024-05-13': { cost: { input: 5, output: 15 } },
        },
      },
    },
    gp,
  );
  const ms = d.providers.find((p) => p.id === 'openai')!.models;
  expect(ms.find((m) => m.id === 'gpt-image-only')!.prices.output_mtok).toBe(30);
  const id = 'gpt-4o-2024-05-13';
  expect(
    ms.filter((m) =>
      m.match.or.some(
        (rule) => rule.equals === id || (rule.regex && new RegExp(rule.regex).test(id)),
      ),
    ),
  ).toHaveLength(1);
});

it('merges duplicate LiteLLM ids by higher price independent of order', () => {
  const entries = [
    ['gemini/gemini-a', { litellm_provider: 'gemini', input_cost_per_token: 1e-6 }],
    ['vertex_ai/gemini-a', { litellm_provider: 'vertex_ai', input_cost_per_token: 2e-6 }],
  ] as const;
  const a = mergeSources(Object.fromEntries(entries), {}, gp);
  const b = mergeSources(Object.fromEntries([...entries].reverse()), {}, gp);
  expect(a.providers.find((p) => p.id === 'google')!.models).toEqual(
    b.providers.find((p) => p.id === 'google')!.models,
  );
  expect(a.conflicts).toEqual(b.conflicts);
  expect(a.conflicts.length).toBe(1);
});

it('skips one malformed model and includes flat image prices', () => {
  const d = mergeSources(
    {
      'gpt-bad': { litellm_provider: 'openai', cache_read_input_token_cost: 1e-6 },
      'grok-imagine-image': {
        litellm_provider: 'xai',
        mode: 'image_generation',
        output_cost_per_image: 0.02,
      },
    },
    {},
    gp,
  );
  expect(d.skipped).toEqual([expect.objectContaining({ model: 'gpt-bad' })]);
  expect(
    d.providers.find((p) => p.id === 'x-ai')!.models.find((m) => m.id === 'grok-imagine-image')
      ?.x_extra_prices?.per_image,
  ).toBe(0.02);
});

it('takes the higher duplicate per-image price and records its source', () => {
  const d = mergeSources(
    {
      'xai/grok-imagine-image': {
        litellm_provider: 'xai',
        mode: 'image_generation',
        output_cost_per_image: 0.02,
      },
      'grok-imagine-image': {
        litellm_provider: 'xai',
        mode: 'image_generation',
        output_cost_per_image: 0.03,
      },
    },
    {},
    gp,
  );
  const m = d.providers
    .find((p) => p.id === 'x-ai')!
    .models.find((m) => m.id === 'grok-imagine-image')!;
  expect(m.x_extra_prices.per_image).toBe(0.03);
  expect(d.conflicts).toContainEqual(
    expect.objectContaining({ field: 'x_extra_prices.per_image', adopted: 0.03 }),
  );
});

it('never matches a published request ID to differently priced rows', async () => {
  const d = JSON.parse(await readFile('data/prices.json', 'utf8'));
  for (const p of d.providers) {
    const ids = p.models.flatMap((m) => [m.id, `${m.id}-20260927`]);
    for (const id of ids) {
      const matches = p.models.filter((m) =>
        m.match.or.some(
          (rule) => rule.equals === id || (rule.regex && new RegExp(rule.regex).test(id)),
        ),
      );
      expect(matches.length, `${p.id}/${id}: ${matches.map((m) => m.id)}`).toBeLessThanOrEqual(1);
    }
  }
});

it('fills image reasoning and audio cache from their own modalities', () => {
  const d = mergeSources(
    {},
    {
      google: {
        models: {
          'gemini-image-test': {
            modalities: { output: ['text', 'image'] },
            cost: { input: 1, input_audio: 5, cache_read: 0.1, output: 30, reasoning: 3 },
          },
        },
      },
    },
    gp,
  );
  const m = d.providers
    .find((p) => p.id === 'google')!
    .models.find((m) => m.id === 'gemini-image-test')!;
  expect(m.prices.output_image_reasoning_mtok).toBe(30);
  expect(m.prices.cache_audio_read_mtok).toBe(5);
});

it('interprets xAI image-only flat prices as generated-image charges', () => {
  const d = mergeSources(
    {
      'xai/grok-imagine-image': {
        litellm_provider: 'xai',
        mode: 'image_generation',
        input_cost_per_image: 0.02,
      },
    },
    {},
    gp,
  );
  const m = d.providers
    .find((p) => p.id === 'x-ai')!
    .models.find((m) => m.id === 'grok-imagine-image')!;
  expect(m.x_extra_prices.per_image).toBe(0.02);
  expect(m.x_extra_prices.input_per_image).toBeUndefined();
});

it('records duplicate LiteLLM tier conflicts with source IDs', () => {
  const d = mergeSources(
    {
      'gemini/gemini-tier': {
        litellm_provider: 'gemini',
        input_cost_per_token: 1e-6,
        input_cost_per_token_above_128k_tokens: 2e-6,
      },
      'gemini-tier': {
        litellm_provider: 'gemini',
        input_cost_per_token: 1e-6,
        input_cost_per_token_above_128k_tokens: 3e-6,
      },
    },
    {},
    gp,
  );
  expect(d.conflicts).toContainEqual(
    expect.objectContaining({
      field: 'input_mtok@128000',
      adopted: 3,
      source_a: 'litellm:gemini-tier',
      source_b: 'litellm:gemini/gemini-tier',
    }),
  );
});

it('preserves a default xAI image charge when a size variant exists', () => {
  const d = mergeSources(
    {
      'xai/grok-imagine-image-2.0': {
        litellm_provider: 'xai',
        mode: 'image_generation',
        input_cost_per_image: 0.06,
      },
      'low/1024-x-1024/grok-imagine-image-2.0': {
        litellm_provider: 'xai',
        mode: 'image_generation',
        input_cost_per_image: 0.04,
      },
    },
    {},
    gp,
  );
  const table = d.providers
    .find((p) => p.id === 'x-ai')!
    .models.find((m) => m.id === 'grok-imagine-image-2.0')!.x_extra_prices.per_image;
  expect(table).toMatchObject({ default: 0.06, '1024x1024/low': 0.04 });
});

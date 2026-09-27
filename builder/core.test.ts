import { it, expect } from 'vitest';
import { readFile } from 'node:fs/promises';
import { mergeSources, validate, finalize, normalizeId } from './core.mjs';
const row = (d: any, provider: string, id: string) =>
  d.models.find((m: any) => m.provider === provider && m.id === id);
it('normalizes provider prefixes', () => {
  expect(normalizeId('gemini/gemini-3.8-flash', 'google')).toBe('gemini-3.8-flash');
  expect(normalizeId('xai/grok-4.7', 'x-ai')).toBe('grok-4.7');
});
it('adopts higher prices, capabilities, modes and uplift', () => {
  const d = mergeSources(
    {
      'gpt-6-luna': {
        litellm_provider: 'openai',
        input_cost_per_token: 2e-6,
        output_cost_per_token: 1e-6,
        input_cost_per_token_priority: 4e-6,
        regional_processing_uplift_multiplier_us: 1.1,
        supports_web_search: true,
        max_input_tokens: 900000,
      },
    },
    {
      openai: {
        models: { 'gpt-6-luna': { cost: { input: 1, output: 3 }, limit: { input: 922000 } } },
      },
    },
  );
  const m = row(d, 'openai', 'gpt-6-luna');
  expect(m.prices.input).toBe(2);
  expect(m.prices.output).toBe(3);
  expect(m.modes.priority.prices.input).toBe(4);
  expect(m.region_uplift.us).toBe(1.1);
  expect(m.capabilities.web_search).toBe(true);
  expect(m.capabilities.max_input_tokens).toBe(900000);
  expect(d.conflicts).toHaveLength(2);
  expect(d.capability_conflicts.some((x: any) => x.field === 'max_input_tokens')).toBe(true);
});
it('maps context tiers with strict greater-than boundary', () => {
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
  );
  expect(row(d, 'openai', 'gpt-6-luna').prices.tiers[0]).toEqual({
    above_input_tokens: 272000,
    prices: { input: 3 },
  });
});
it('validates prices, tiers, flagship presence and model count', async () => {
  const d = JSON.parse(await readFile('data/llm-info.json', 'utf8'));
  expect(finalize(d, d)).toBe(d);
  const bad = structuredClone(d);
  bad.models[0].prices.input = -1;
  expect(() => validate(bad)).toThrow('invalid price');
  const tier = structuredClone(d);
  tier.models[0].prices.tiers = [
    { above_input_tokens: 10, prices: { input: 1 } },
    { above_input_tokens: 5, prices: { input: 2 } },
  ];
  expect(() => validate(tier)).toThrow('tier thresholds');
  const mode = structuredClone(d);
  mode.models[0].modes ??= {};
  mode.models[0].modes.bad = { prices: { input: -1 } };
  expect(() => validate(mode)).toThrow('invalid price');
  const drop = structuredClone(d);
  drop.models = drop.models
    .filter((m: any) => m.provider !== 'openai')
    .concat(drop.models.filter((m: any) => m.provider === 'openai').slice(0, 2));
  expect(() => validate(drop, d)).toThrow('model count dropped');
});
it('maps image variants and video resolution rates', () => {
  const d = mergeSources(
    {
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
    },
    {},
  );
  expect(row(d, 'openai', 'gpt-image-test').prices.per_image['100x200/high']).toBeCloseTo(0.02);
  expect(row(d, 'google', 'veo-test').prices.per_video_second['1080p']).toBe(0.08);
});
it('keeps text and image output prices separate', () => {
  const d = mergeSources(
    {
      'gpt-image-2': {
        litellm_provider: 'openai',
        mode: 'image_generation',
        output_cost_per_token: 10e-6,
        output_cost_per_image_token: 25e-6,
      },
    },
    {
      openai: {
        models: { 'gpt-image-2': { modalities: { output: ['image'] }, cost: { output: 30 } } },
      },
    },
  );
  const m = row(d, 'openai', 'gpt-image-2');
  expect(m.prices.output).toBe(10);
  expect(m.prices.output_image).toBe(30);
  expect(d.conflicts).toContainEqual(
    expect.objectContaining({ field: 'output_image_mtok', adopted: 30 }),
  );
});
it('merges duplicate LiteLLM ids independently of input order', () => {
  const entries = [
    ['gemini/gemini-a', { litellm_provider: 'gemini', input_cost_per_token: 1e-6 }],
    ['vertex_ai/gemini-a', { litellm_provider: 'vertex_ai', input_cost_per_token: 2e-6 }],
  ] as const;
  const a = mergeSources(Object.fromEntries(entries), {}),
    b = mergeSources(Object.fromEntries([...entries].reverse()), {});
  expect(a.models).toEqual(b.models);
  expect(a.conflicts).toEqual(b.conflicts);
  expect(row(a, 'google', 'gemini-a').prices.input).toBe(2);
});
it('retains flat and sized xAI image charges', () => {
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
  );
  expect(row(d, 'x-ai', 'grok-imagine-image-2.0').prices.per_image).toMatchObject({
    default: 0.06,
    '1024x1024/low': 0.04,
  });
});
it('publishes exact rows before dated suffix matches', async () => {
  const d = JSON.parse(await readFile('data/llm-info.json', 'utf8'));
  const base = row(d, 'openai', 'gpt-4o'),
    dated = row(d, 'openai', 'gpt-4o-2024-05-13');
  expect(base.match.dated_suffix).toBe(true);
  expect(dated.prices.input).toBe(5);
  expect(base.prices.input).not.toBe(5);
});

import { it, expect } from 'vitest';
import { readFile } from 'node:fs/promises';
import { mergeSources, validate, finalize, normalizeId } from './core.mjs';
const row = (d: any, provider: string, id: string) =>
  d.models.find((m: any) => m.provider === provider && m.id === id);
const residencyIds = [
  'claude-fable-5',
  'claude-fable-5-1',
  'claude-mythos-5',
  'claude-mythos-5-1',
  'claude-opus-4-6',
  'claude-opus-4-7',
  'claude-opus-4-8',
  'claude-opus-5',
  'claude-opus-5-5',
  'claude-sonnet-4-6',
  'claude-sonnet-5',
];
it.each(['litellm', 'models_dev'])('adds reviewed US residency facts to %s models', (source) => {
  const excluded = [
    'claude-haiku-4-5',
    'claude-opus-4-5',
    'claude-sonnet-4-5',
    'claude-opus-4-6-20260205',
    'claude-opus-4-7-20260416',
    'claude-mythos-preview',
    'claude-opus-99',
    'claude-opus-5-custom',
  ];
  const ids = [...residencyIds, ...excluded];
  const lite = Object.fromEntries(
    ids.map((id) => [
      'anthropic/' + id,
      {
        litellm_provider: 'anthropic',
        input_cost_per_token: 4e-6,
        output_cost_per_token: 20e-6,
      },
    ]),
  );
  const models = {
    anthropic: {
      models: Object.fromEntries(ids.map((id) => [id, { cost: { input: 4, output: 20 } }])),
    },
  };
  const before = JSON.stringify({ lite, models });
  const merged = mergeSources(
    source === 'litellm' ? lite : {},
    source === 'models_dev' ? models : {},
  );
  for (const id of residencyIds)
    expect(row(merged, 'anthropic', id).region_uplift).toEqual({ us: 1.1 });
  for (const id of excluded) expect(row(merged, 'anthropic', id).region_uplift).toEqual({});
  expect(merged.applied_rules).toHaveLength(residencyIds.length);
  expect(merged.applied_rules[0]).toMatchObject({
    rule: 'anthropic-us-inference',
    provider: 'anthropic',
    field: 'region_uplift.us',
    previous: null,
    adopted: 1.1,
    source_url: 'https://platform.claude.com/docs/en/build-with-claude/data-residency',
    checked_at: '2026-09-28',
  });
  expect(JSON.stringify({ lite, models })).toBe(before);
});
it.each([0, 1.05, 1.1, 1.25])('provider rules never lower existing uplift %s', (factor) => {
  const merged = mergeSources(
    {
      'claude-opus-5': {
        litellm_provider: 'anthropic',
        input_cost_per_token: 10e-6,
        output_cost_per_token: 50e-6,
        regional_processing_uplift_multiplier_us: factor,
        regional_processing_uplift_multiplier_eu: 1.3,
      },
      'openai/claude-opus-5': {
        litellm_provider: 'openai',
        input_cost_per_token: 1e-6,
        output_cost_per_token: 2e-6,
      },
    },
    {},
  );
  expect(row(merged, 'anthropic', 'claude-opus-5')).toMatchObject({
    prices: { input: 10, output: 50 },
    region_uplift: { us: Math.max(factor, 1.1), eu: 1.3 },
  });
  expect(row(merged, 'openai', 'claude-opus-5').region_uplift).toEqual({});
  expect(merged.applied_rules).toHaveLength(factor < 1.1 ? 1 : 0);
});
it('normalizes provider prefixes', () => {
  expect(normalizeId('gemini/gemini-3.8-flash', 'google')).toBe('gemini-3.8-flash');
  expect(normalizeId('xai/grok-4.7', 'x-ai')).toBe('grok-4.7');
});
it('publishes API kinds and keeps capabilities from either source', () => {
  const d = mergeSources(
    {
      'claude-mythos-5': {
        litellm_provider: 'anthropic',
        mode: 'responses',
        input_cost_per_token: 1e-6,
        output_cost_per_token: 2e-6,
        supports_reasoning: true,
      },
      'xai/grok-4.20': {
        litellm_provider: 'xai',
        mode: 'completion',
        input_cost_per_token: 1e-6,
        output_cost_per_token: 2e-6,
        supports_function_calling: true,
      },
      voice: {
        litellm_provider: 'gemini',
        mode: 'realtime',
        input_cost_per_token: 1e-6,
        output_cost_per_token: 2e-6,
      },
    },
    {
      anthropic: {
        models: {
          'claude-mythos-5': {
            cost: { input: 1, output: 2 },
            modalities: { output: ['image'] },
            tool_call: true,
          },
        },
      },
      google: {
        models: {
          speech: { cost: { input: 1, output: 2 }, modalities: { output: ['audio'] } },
          embed: { cost: { input: 1 }, family: 'embedding', modalities: { output: ['embedding'] } },
        },
      },
    },
  );
  expect(row(d, 'anthropic', 'claude-mythos-5')).toMatchObject({
    mode: 'chat',
    capabilities: { reasoning: true, tool_call: true, output_modalities: ['image'] },
  });
  expect(row(d, 'x-ai', 'grok-4.20')).toMatchObject({
    mode: 'chat',
    capabilities: { tool_call: true, output_modalities: ['text'] },
  });
  expect(row(d, 'google', 'voice').mode).toBe('realtime');
  expect(row(d, 'google', 'speech').mode).toBe('audio_speech');
  expect(row(d, 'google', 'embed').mode).toBe('embedding');
  expect(d.mode_conflicts).toContainEqual(
    expect.objectContaining({
      model: 'claude-mythos-5',
      litellm: 'chat',
      models_dev: 'image_generation',
    }),
  );
});
it('rejects a published table with too many empty capabilities', async () => {
  const d = JSON.parse(await readFile('data/llm-info.json', 'utf8'));
  for (const m of d.models.slice(0, Math.floor(d.models.length * 0.1) + 1)) m.capabilities = {};
  expect(() => validate(d)).toThrow('empty capabilities');
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
it('maps one-hour cache writes with higher source price and tier/mode rates', () => {
  const d = mergeSources(
    {
      opus: {
        litellm_provider: 'anthropic',
        input_cost_per_token: 4e-6,
        output_cost_per_token: 20e-6,
        cache_creation_input_token_cost_above_1hr: 7e-6,
        cache_creation_input_token_cost_above_1hr_above_200k_tokens: 9e-6,
        cache_creation_input_token_cost_above_1hr_priority: 10e-6,
      },
    },
    { anthropic: { models: { opus: { cost: { input: 4, output: 20, cache_write_1h: 8 } } } } },
  );
  const m = row(d, 'anthropic', 'opus');
  expect(m.prices.cache_write_1h).toBe(8);
  expect(m.prices.tiers[0].prices.cache_write_1h).toBe(9);
  expect(m.modes.priority.prices.cache_write_1h).toBe(10);
  expect(d.conflicts).toContainEqual(
    expect.objectContaining({ field: 'cache_write_1h_mtok', adopted: 8 }),
  );
});
it('keeps timestamps and version stable when only fetch metadata changes', async () => {
  const previous = JSON.parse(await readFile('data/llm-info.json', 'utf8'));
  const next = structuredClone(previous);
  next.sources.litellm.fetched_at = '2099-01-01T00:00:00Z';
  next.sources.litellm.ref = 'new-etag';
  next.sources.models_dev.etag = 'other-etag';
  expect(finalize(next, previous, '2099-01-01T00:00:00Z')).toBe(previous);
  const first = finalize(previous, null, '2026-01-01T00:00:00Z');
  const second = finalize(next, first, '2026-01-02T00:00:00Z');
  expect(JSON.stringify(second, null, 2) + '\n').toBe(JSON.stringify(first, null, 2) + '\n');
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
    [
      'gemini/gemini-a',
      { litellm_provider: 'gemini', input_cost_per_token: 1e-6, output_cost_per_token: 1e-6 },
    ],
    [
      'vertex_ai/gemini-a',
      { litellm_provider: 'vertex_ai', input_cost_per_token: 2e-6, output_cost_per_token: 1e-6 },
    ],
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
it('keeps the highest duplicate image, tier, and region prices', () => {
  const d = mergeSources(
    {
      'gemini/gemini-gx': {
        litellm_provider: 'gemini',
        input_cost_per_token: 1e-6,
        output_cost_per_token: 1e-6,
        input_cost_per_token_above_200k_tokens: 3e-6,
        regional_processing_uplift_multiplier_us: 1.1,
      },
      'vertex_ai/gemini-gx': {
        litellm_provider: 'vertex_ai',
        input_cost_per_token: 2e-6,
        output_cost_per_token: 2e-6,
        input_cost_per_token_above_200k_tokens: 4e-6,
        regional_processing_uplift_multiplier_us: 1.3,
      },
      'xai/grok-image': {
        litellm_provider: 'xai',
        mode: 'image_generation',
        input_cost_per_image: 0.06,
      },
      'grok-image': {
        litellm_provider: 'xai',
        mode: 'image_generation',
        input_cost_per_image: 0.08,
      },
    },
    {},
  );
  const gx = row(d, 'google', 'gemini-gx');
  expect(gx.prices.tiers[0].prices.input).toBe(4);
  expect(gx.region_uplift.us).toBe(1.3);
  expect(row(d, 'x-ai', 'grok-image').prices.per_image).toBe(0.08);
  expect(d.conflicts.some((x: any) => x.field === 'input_mtok@200000')).toBe(true);
});
it('merges capability booleans and prefers models.dev efforts', () => {
  const d = mergeSources(
    {
      gx: {
        litellm_provider: 'openai',
        input_cost_per_token: 1e-6,
        output_cost_per_token: 1e-6,
        supports_web_search: false,
        reasoning_effort_levels: ['low'],
        max_tokens: 10000,
        max_input_tokens: 8000,
      },
    },
    {
      openai: {
        models: {
          gx: {
            cost: { input: 1, output: 1 },
            web_search: true,
            reasoning_options: [{ type: 'effort', values: ['high'] }],
          },
        },
      },
    },
  );
  const cap = row(d, 'openai', 'gx').capabilities;
  expect(cap.web_search).toBe(true);
  expect(cap.reasoning_efforts).toEqual(['high']);
  expect(cap.context_window).toBe(null);
  expect(cap.max_input_tokens).toBe(8000);
});
it('uses explicit context limits and prefers models.dev over LiteLLM', () => {
  const lite = {
    gx: {
      litellm_provider: 'openai',
      input_cost_per_token: 1e-6,
      output_cost_per_token: 1e-6,
      max_tokens: 10000,
      max_context_tokens: 128000,
      max_input_tokens: 8000,
      max_output_tokens: 16000,
    },
  };
  const models = {
    openai: { models: { gx: { cost: { input: 1, output: 1 }, limit: { context: 200000 } } } },
  };
  expect(row(mergeSources(lite, {}), 'openai', 'gx').capabilities.context_window).toBe(128000);
  expect(row(mergeSources(lite, models), 'openai', 'gx').capabilities.context_window).toBe(200000);
});
it('keeps audio models when a non-text output limit contradicts context', () => {
  const d = mergeSources(
    {},
    {
      google: {
        models: {
          voice: {
            cost: { input: 1, output: 2 },
            modalities: { input: ['text'], output: ['audio'] },
            limit: { context: 8192, output: 16384 },
          },
        },
      },
    },
  );
  expect(row(d, 'google', 'voice').capabilities).toMatchObject({
    context_window: 8192,
    max_output_tokens: null,
  });
});
it('rejects a dataset where over 5% of comparable context limits are below output limits', async () => {
  const d = JSON.parse(await readFile('data/llm-info.json', 'utf8'));
  for (const m of d.models) {
    m.capabilities.context_window = 1000;
    m.capabilities.max_output_tokens = 100;
  }
  for (const m of d.models.slice(0, Math.floor(d.models.length * 0.05) + 1))
    m.capabilities.context_window = 10;
  expect(() => validate(d)).toThrow('context_window below max_output_tokens');
});
it('validates missing, NaN, and flagship prices', async () => {
  const d = JSON.parse(await readFile('data/llm-info.json', 'utf8'));
  const noPrice = structuredClone(d);
  noPrice.models[0].prices = {};
  expect(() => validate(noPrice)).toThrow('model without price');
  const nan = structuredClone(d);
  nan.models[0].prices.input = NaN;
  expect(() => validate(nan)).toThrow('invalid price');
  const noFlagship = structuredClone(d);
  noFlagship.models = noFlagship.models.filter((m: any) => m.id !== 'gpt-6-luna');
  expect(() => validate(noFlagship)).toThrow('missing flagship');
});
it('scales fast prices and preserves explicit mode tiers', () => {
  const d = mergeSources(
    {
      gx: {
        litellm_provider: 'openai',
        input_cost_per_token: 1e-6,
        output_cost_per_token: 2e-6,
        provider_specific_entry: { fast: 2 },
        input_cost_per_token_priority: 3e-6,
        input_cost_per_token_above_200k_tokens_priority: 5e-6,
      },
    },
    {},
  );
  const m = row(d, 'openai', 'gx');
  expect(m.modes.fast.prices.input).toBe(2);
  expect(m.modes.priority.prices.tiers[0].prices.input).toBe(5);
});
it('keeps a default video price beside resolution prices', () => {
  const d = mergeSources(
    {
      video: {
        litellm_provider: 'openai',
        mode: 'video_generation',
        output_cost_per_second: 0.1,
        output_cost_per_second_1080p: 0.2,
      },
    },
    {},
  );
  expect(row(d, 'openai', 'video').prices.per_video_second).toEqual({ default: 0.1, '1080p': 0.2 });
});
it('logs mode price conflicts and sorts the log deterministically', () => {
  const d = mergeSources(
    {
      gx: {
        litellm_provider: 'openai',
        input_cost_per_token: 1e-6,
        output_cost_per_token: 2e-6,
        input_cost_per_token_priority: 3e-6,
      },
    },
    {
      openai: {
        models: {
          gx: {
            cost: { input: 2, output: 4 },
            experimental: { modes: { priority: { cost: { input: 4, output: 6 } } } },
          },
        },
      },
    },
  );
  expect(d.conflicts.some((c: any) => c.field === 'x_modes.priority.input_mtok')).toBe(true);
  expect(d.conflicts.map(JSON.stringify)).toEqual(
    [...d.conflicts.map(JSON.stringify)].sort((a, b) => a.localeCompare(b, 'en')),
  );
});
it('sorts conflicts across providers independently of discovery order', () => {
  const d = mergeSources(
    {
      'xai/grok-z': {
        litellm_provider: 'xai',
        input_cost_per_token: 1e-6,
        output_cost_per_token: 1e-6,
      },
      'grok-z': {
        litellm_provider: 'xai',
        input_cost_per_token: 2e-6,
        output_cost_per_token: 2e-6,
      },
      'openai/gpt-a': {
        litellm_provider: 'openai',
        input_cost_per_token: 1e-6,
        output_cost_per_token: 1e-6,
      },
    },
    { openai: { models: { 'gpt-a': { cost: { input: 2, output: 2 } } } } },
  );
  const serialized = d.conflicts.map(JSON.stringify);
  expect(serialized.length).toBeGreaterThan(2);
  expect(serialized).toEqual([...serialized].sort((a, b) => a.localeCompare(b, 'en')));
});

const xaiPriorityIds = [
  'grok-4.7',
  'grok-4.6',
  'grok-4.5',
  'grok-4.3',
  'grok-build-0.1',
  'grok-4.20-multi-agent-0309',
  'grok-4.20-0309-reasoning',
  'grok-4.20-0309-non-reasoning',
];
it.each(['litellm', 'models_dev'])('adds reviewed xAI priority token prices from %s', (source) => {
  const excluded = [
    'grok-4.7-latest',
    'grok-4.3-latest',
    'grok-4.20',
    'grok-4.20-beta-0309',
    'grok-code-fast-1',
    'grok-imagine-image',
    'grok-future',
  ];
  const ids = [...xaiPriorityIds, ...excluded];
  const lite = Object.fromEntries(
    ids.map((id) => [
      id,
      {
        litellm_provider: 'xai',
        input_cost_per_token: 2e-6,
        output_cost_per_token: 6e-6,
        cache_read_input_token_cost: 0.5e-6,
        output_cost_per_reasoning_token: 6e-6,
        input_cost_per_token_above_200k_tokens: 4e-6,
        output_cost_per_token_above_200k_tokens: 12e-6,
        input_cost_per_token_batches: 1e-6,
      },
    ]),
  );
  const models = {
    xai: {
      models: Object.fromEntries(
        ids.map((id) => [id, { cost: { input: 2, output: 6, cache_read: 0.5, reasoning: 6 } }]),
      ),
    },
  };
  const before = JSON.stringify({ lite, models });
  const merged = mergeSources(
    source === 'litellm' ? lite : {},
    source === 'models_dev' ? models : {},
  );
  for (const id of xaiPriorityIds) {
    const m = row(merged, 'x-ai', id);
    const scaled = Object.fromEntries(
      Object.entries(m.prices).map(([key, value]: any) => [
        key,
        key === 'tiers'
          ? value.map((t: any) => ({
              ...t,
              prices: Object.fromEntries(Object.entries(t.prices).map(([k, v]: any) => [k, v * 2])),
            }))
          : value * 2,
      ]),
    );
    expect(m.modes.priority).toEqual({ prices: scaled });
    if (source === 'litellm') expect(m.modes.batch.prices.input).toBe(1);
  }
  for (const id of excluded) expect(row(merged, 'x-ai', id).modes.priority).toBeUndefined();
  expect(merged.applied_rules).toHaveLength(xaiPriorityIds.length);
  expect(merged.applied_rules[0]).toMatchObject({
    rule: 'xai-priority-processing',
    provider: 'x-ai',
    field: 'modes.priority',
    source_url: 'https://docs.x.ai/developers/pricing#priority-processing-pricing',
    checked_at: '2026-09-28',
  });
  expect(JSON.stringify({ lite, models })).toBe(before);
});
it('applies the official token multiplier without multiplying tool fees or applying it twice', () => {
  const merged = mergeSources(
    {
      'grok-4.7': {
        litellm_provider: 'xai',
        input_cost_per_token: 2e-6,
        output_cost_per_token: 6e-6,
        input_cost_per_token_priority: 4e-6,
        search_context_cost_per_query: { search_context_size_low: 0.005 },
      },
      'openai/grok-4.7': {
        litellm_provider: 'openai',
        input_cost_per_token: 2e-6,
        output_cost_per_token: 6e-6,
      },
    },
    {},
  );
  const m = row(merged, 'x-ai', 'grok-4.7');
  expect(m.modes.priority.prices.input).toBe(4);
  expect(m.modes.priority.prices.output).toBe(12);
  expect(m.modes.priority.prices.per_web_search).toBeUndefined();
  expect(row(merged, 'openai', 'grok-4.7').modes.priority).toBeUndefined();
});

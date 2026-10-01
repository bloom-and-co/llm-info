import { expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { calculate, findModel } from '../src/engine.ts';
import { mergeSources } from '../builder/core.mjs';
import { createLlmInfo, memoryStore } from '../src/index.ts';

const base: any = {
  provider: 'openai',
  id: 'unit',
  prices: {
    input: 2,
    output: 4,
    tiers: [{ above_input_tokens: 200000, prices: { input: 4, output: 8 } }],
  },
  modes: { priority: { prices: { input: 3, output: 6 } } },
};
it('applies base tier ratios to modes without their own tiers', () => {
  expect(
    calculate(base, { input_tokens: 400000, output_tokens: 10000 }, {}, 'priority').totalUsd,
  ).toBeCloseTo(2.52, 9);
});
it('charges long-context production modes at hand-computed rates', () => {
  const data = JSON.parse(readFileSync('tests/fixtures/llm-info-snapshot.json', 'utf8'));
  const get = (provider: string, id: string) =>
    data.models.find((m: any) => m.provider === provider && m.id === id);
  const usage = { input_tokens: 400000, output_tokens: 10000 };
  expect(calculate(get('openai', 'gpt-5.4'), usage, {}, 'priority').totalUsd).toBeCloseTo(4.45, 9);
  expect(calculate(get('openai', 'gpt-6-luna'), usage, {}, 'fast').totalUsd).toBeCloseTo(0.175, 9);
  expect(calculate(get('openai', 'gpt-6-luna'), usage, {}, 'priority').totalUsd).toBeCloseTo(
    0.175,
    9,
  );
  expect(calculate(get('openai', 'gpt-5.4'), usage, {}, 'flex').totalUsd).toBeCloseTo(1.1125, 9);
  expect(calculate(get('google', 'gemini-2.5-pro'), usage, {}, 'batch').totalUsd).toBeCloseTo(
    0.575,
    9,
  );
});
it('skips malformed and incomplete rows with reasons', () => {
  const d = mergeSources(
    {
      bad: {
        litellm_provider: 'openai',
        input_cost_per_token: 'oops',
        output_cost_per_token: 1e-6,
      },
      partial: { litellm_provider: 'openai', cache_read_input_token_cost: 1e-6 },
      good: { litellm_provider: 'openai', input_cost_per_token: 1e-6, output_cost_per_token: 2e-6 },
    },
    {},
  );
  expect(d.models.map((m: any) => m.id)).toEqual(['good']);
  expect(d.skipped).toEqual(
    expect.arrayContaining([
      expect.objectContaining({ model: 'bad' }),
      expect.objectContaining({ model: 'partial' }),
    ]),
  );
});
it('clamps merged tier rates to the merged base', () => {
  const d = mergeSources(
    {
      gx: {
        litellm_provider: 'openai',
        input_cost_per_token: 1e-6,
        output_cost_per_token: 1e-6,
        input_cost_per_token_above_200k_tokens: 2e-6,
      },
    },
    { openai: { models: { gx: { cost: { input: 3, output: 2 } } } } },
  );
  const m = d.models[0];
  expect(m.prices.tiers[0].prices.input).toBe(3);
});
it('does not publish per-model provenance or conflicts', () => {
  const d = mergeSources(
    {
      good: { litellm_provider: 'openai', input_cost_per_token: 1e-6, output_cost_per_token: 2e-6 },
    },
    {},
  );
  expect(d.models[0]).not.toHaveProperty('source');
  expect(d.models[0].capabilities).not.toHaveProperty('sources');
});
it('keeps the published document limited to prices and source fetch metadata', () => {
  const raw = readFileSync('data/llm-info.json', 'utf8');
  const data = JSON.parse(raw);
  expect(data).not.toHaveProperty('conflicts');
  expect(data).not.toHaveProperty('capability_conflicts');
  expect(data.models.every((m: any) => !('source' in m) && !('sources' in m.capabilities))).toBe(
    true,
  );
  expect(raw).toMatch(/"litellm": \{[^\n]+\}/);
  expect(raw).toMatch(/"models_dev": \{[^\n]+\}/);
  expect(data.sources.litellm.latest_new_model_at).toBeTruthy();
});
it('CI uses the current dependency set and paths', () => {
  for (const name of ['ci.yml', 'update-prices.yml']) {
    const yaml = readFileSync(`.github/workflows/${name}`, 'utf8');
    expect(yaml).not.toMatch(
      new RegExp([['gen', 'ai'].join(''), 'prices'].join('-') + '|builder/validate[.]py'),
    );
  }
});
it('warns and charges conservatively for missing modes and invalid usage', () => {
  const model = {
    provider: 'openai',
    id: 'unit',
    prices: { input: 2, output: 4 },
    modes: {},
  } as any;
  expect(calculate(model, { input_tokens: '1000000' } as any, {}, 'flex').totalUsd).toBe(2);
  expect(calculate(model, { input_tokens: 1_000_000 }, {}, 'priority').totalUsd).toBe(4);
  const bad = calculate(
    model,
    { input_tokens: -1, output_tokens: true } as any,
    {},
    'standard',
    'JP',
  );
  expect(bad.warnings).toEqual(
    expect.arrayContaining([
      'invalid_usage:input_tokens',
      'invalid_usage:output_tokens',
      'unknown_region:JP',
    ]),
  );
});
it('keeps region lookup case insensitive and warns when an uplift is unknown', () => {
  const model = {
    provider: 'openai',
    id: 'unit',
    prices: { input: 2, output: 4 },
    region_uplift: { us: 1.5 },
  } as any;
  expect(calculate(model, { input_tokens: 1_000_000 }, {}, 'standard', 'US').totalUsd).toBe(3);
  expect(calculate(model, { input_tokens: 1_000_000 }, {}, 'standard', 'eu').warnings).toContain(
    'missing_region_uplift',
  );
});
it('matches Vertex and Bedrock model forms', () => {
  const rows = [
    { provider: 'google', id: 'gemini-test', match: { dated_suffix: true } },
    { provider: 'anthropic', id: 'claude-test', match: { dated_suffix: true } },
  ];
  expect(findModel(rows, 'GOOGLE', 'gemini-test-001')).toBe(rows[0]);
  expect(findModel(rows, 'anthropic', 'claude-test@20260927')).toBe(rows[1]);
  expect(findModel(rows, 'anthropic', 'anthropic.claude-test')).toBe(rows[1]);
});
it('publishes only positive tier overrides', () => {
  const d = mergeSources(
    {},
    {
      google: {
        models: {
          'gemini-exp-1206': {
            cost: {
              input: 1,
              output: 1,
              tiers: [{ tier: { type: 'context', size: 200000 }, input: 0, output: 0 }],
            },
          },
        },
      },
    },
  );
  expect(d.models[0].prices.tiers).toBeUndefined();
});
it('counts Imagen request counts and assumes one image when absent', async () => {
  const data = JSON.parse(readFileSync('tests/fixtures/llm-info-snapshot.json', 'utf8'));
  const info = createLlmInfo({
    store: memoryStore(),
    fetch: async () => new Response(JSON.stringify(data)),
  });
  await info.load();
  const model = 'imagen-3.0-generate-001';
  const four = info.fromResponse({
    provider: 'google',
    response: {},
    request: { model, parameters: { sampleCount: 4 } },
  });
  const other = info.fromResponse({
    provider: 'google',
    response: {},
    request: { model, config: { numberOfImages: 4 } },
  });
  const one = info.fromResponse({ provider: 'google', response: {}, request: { model } });
  expect(four?.extraUsd).toBeGreaterThan(0);
  expect(other?.extraUsd).toBe(four?.extraUsd);
  expect(one?.extraUsd).toBeCloseTo((four?.extraUsd ?? 0) / 4, 9);
  expect(one?.warnings).toContain('missing_param:image_count');
});

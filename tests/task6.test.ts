import { expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { calculate } from '../src/engine.ts';
import { mergeSources } from '../builder/core.mjs';

const base: any = { provider: 'openai', id: 'unit', prices: { input: 2, output: 4, tiers: [{ above_input_tokens: 200000, prices: { input: 4, output: 8 } }] }, modes: { priority: { prices: { input: 3, output: 6 } } } };
it('applies base tier ratios to modes without their own tiers', () => {
  expect(calculate(base, { input_tokens: 400000, output_tokens: 10000 }, {}, 'priority').totalUsd).toBeCloseTo(2.46, 9);
});
it('skips malformed and incomplete rows with reasons', () => {
  const d = mergeSources({
    bad: { litellm_provider: 'openai', input_cost_per_token: 'oops', output_cost_per_token: 1e-6 },
    partial: { litellm_provider: 'openai', cache_read_input_token_cost: 1e-6 },
    good: { litellm_provider: 'openai', input_cost_per_token: 1e-6, output_cost_per_token: 2e-6 },
  }, {});
  expect(d.models.map((m: any) => m.id)).toEqual(['good']);
  expect(d.skipped).toEqual(expect.arrayContaining([expect.objectContaining({ model: 'bad' }), expect.objectContaining({ model: 'partial' })]));
});
it('clamps merged tier rates to the merged base', () => {
  const d = mergeSources({ gx: { litellm_provider: 'openai', input_cost_per_token: 1e-6, output_cost_per_token: 1e-6, input_cost_per_token_above_200k_tokens: 2e-6 } }, { openai: { models: { gx: { cost: { input: 3, output: 2 } } } } });
  const m = d.models[0];
  expect(m.prices.tiers[0].prices.input).toBe(3);
});
it('does not publish per-model provenance or conflicts', () => {
  const d = mergeSources({ good: { litellm_provider: 'openai', input_cost_per_token: 1e-6, output_cost_per_token: 2e-6 } }, {});
  expect(d.models[0]).not.toHaveProperty('source');
  expect(d.models[0].capabilities).not.toHaveProperty('sources');
  expect(d).not.toHaveProperty('capability_conflicts');
});
it('CI uses the current dependency set and paths', () => {
  for (const name of ['ci.yml', 'update-prices.yml']) {
    const yaml = readFileSync(`.github/workflows/${name}`, 'utf8');
    expect(yaml).not.toMatch(/genai-prices|builder\/validate\.py/);
  }
});

import { it, expect } from 'vitest';
import { calculate, findModel } from '../src/engine.ts';
const model: any = {
  provider: 'google',
  id: 'model',
  aliases: ['model-latest'],
  match: { dated_suffix: true },
  prices: { input: 1, input_audio: 10, cache_read: 0.1, cache_audio_read: 2, output: 3 },
  capabilities: { output_modalities: ['text'] },
};
it('charges one-hour cache writes separately and derives a missing price from input', () => {
  const opus = {
    provider: 'anthropic',
    id: 'opus',
    prices: { input: 4, output: 20, cache_write: 5, cache_write_1h: 8 },
  } as any;
  expect(
    calculate(opus, { input_tokens: 1_000_000, cache_write_1h_tokens: 1_000_000 }).totalUsd,
  ).toBe(8);
  expect(
    calculate(opus, {
      input_tokens: 1_000_000,
      cache_write_tokens: 500_000,
      cache_write_1h_tokens: 500_000,
    }).totalUsd,
  ).toBe(6.5);
  delete opus.prices.cache_write_1h;
  const fallback = calculate(opus, { input_tokens: 1_000_000, cache_write_1h_tokens: 1_000_000 });
  expect(fallback.totalUsd).toBe(8);
  expect(fallback.warnings).toContain('fallback_price:cache_write_1h');
  expect(fallback.warnings).not.toContain('inconsistent_usage');
  opus.prices.cache_write = 12;
  expect(
    calculate(opus, { input_tokens: 1_000_000, cache_write_1h_tokens: 1_000_000 }).totalUsd,
  ).toBe(12);
});
it('applies one-hour cache write tiers to mode prices', () => {
  const opus = {
    provider: 'anthropic',
    id: 'opus',
    prices: {
      input: 4,
      cache_write_1h: 8,
      tiers: [{ above_input_tokens: 200_000, prices: { input: 8, cache_write_1h: 16 } }],
    },
    modes: { fast: { prices: { input: 8, cache_write_1h: 16 } } },
  } as any;
  expect(
    calculate(opus, { input_tokens: 1_000_000, cache_write_1h_tokens: 1_000_000 }, {}, 'fast')
      .totalUsd,
  ).toBe(32);
  delete opus.modes.fast.prices.cache_write_1h;
  expect(
    calculate(opus, { input_tokens: 1_000_000, cache_write_1h_tokens: 1_000_000 }, {}, 'fast')
      .totalUsd,
  ).toBe(32);
});
it('allocates ambiguous cache overlap at maximum plausible cost', () => {
  const result = calculate(model, {
    input_tokens: 1_000_000,
    input_audio_tokens: 600_000,
    cache_read_tokens: 500_000,
  });
  expect(result.inputUsd).toBeCloseTo(5.24, 9);
  expect(result.warnings).not.toContain('inconsistent_usage');
});
it('uses modality price when cache modality price is missing', () => {
  const copy = structuredClone(model);
  delete copy.prices.cache_audio_read;
  const result = calculate(copy, {
    input_tokens: 1_000_000,
    input_audio_tokens: 600_000,
    cache_read_tokens: 500_000,
  });
  expect(result.inputUsd).toBeCloseTo(6.4, 9);
  expect(result.warnings).toContain('fallback_price:cache_audio_read');
});
it('applies a tier only above its threshold and matches exact rows first', () => {
  const copy = structuredClone(model);
  copy.prices.tiers = [{ above_input_tokens: 272000, prices: { input: 2 } }];
  expect(calculate(copy, { input_tokens: 272000 }).inputUsd).toBeCloseTo(0.272, 9);
  expect(calculate(copy, { input_tokens: 272001 }).inputUsd).toBeCloseTo(0.544002, 9);
  const dated = { ...copy, id: 'model-2026-09-22', prices: { input: 4 } };
  expect(findModel([copy, dated], 'google', 'GEMINI/MODEL-2026-09-22')).toBe(dated);
  expect(findModel([copy, dated], 'google', 'models/model-latest')).toBe(copy);
});
it('bills included reasoning as a disjoint output bucket', () => {
  const copy = structuredClone(model);
  copy.prices.reasoning = 5;
  const result = calculate(copy, { output_tokens: 100, output_reasoning_tokens: 20 });
  expect(result.outputUsd).toBeCloseTo((80 * 3 + 20 * 5) / 1e6, 10);
});
it('charges missing token rates using the highest available rate', () => {
  const copy = { ...model, prices: { output: 4 } };
  const result = calculate(copy, { input_tokens: 1_000_000 });
  expect(result.inputUsd).toBe(4);
  expect(result.warnings).toContain('missing_price:input');
});
it('keeps the expensive modality when details exceed input totals', () => {
  const copy = { ...model, prices: { input: 1, input_audio: 10, input_image: 2, output: 1 } };
  expect(
    calculate(copy, { input_tokens: 100, input_audio_tokens: 100, input_image_tokens: 100 })
      .inputUsd,
  ).toBeCloseTo(0.001, 10);
});
it('applies mode multipliers and separately billed reasoning', () => {
  const copy = {
    ...model,
    modes: { fast: { multiplier: 3, prices: {} } },
    prices: { input: 1, output: 2, reasoning: 5 },
  };
  expect(
    calculate(copy, { input_tokens: 1_000_000, reasoning_tokens: 100_000 }, {}, 'fast').totalUsd,
  ).toBeCloseTo(4.5, 9);
});
it('allocates output modalities to the higher price and avoids image double charges', () => {
  const copy = {
    ...model,
    prices: { input: 1, output: 1, output_audio: 10, output_image: 2, per_image: 0.5 },
  };
  expect(
    calculate(copy, { output_tokens: 100, output_audio_tokens: 100, output_image_tokens: 100 })
      .outputUsd,
  ).toBeCloseTo(0.001, 10);
  expect(calculate(copy, { output_image_tokens: 100, output_images: 1 }).extraUsd).toBe(0);
});
it('honors explicit cache modality and clamps missing input totals', () => {
  const copy = {
    ...model,
    prices: { input: 1, input_audio: 10, cache_read: 0.1, cache_audio_read: 2, output: 1 },
  };
  const usage = {
    input_tokens: 100,
    input_audio_tokens: 50,
    cache_read_tokens: 50,
    cache_audio_read_tokens: 50,
  };
  expect(calculate(copy, usage).inputUsd).toBeCloseTo((50 + 100) / 1e6, 10);
  expect(calculate(copy, { input_tokens: 0, cache_read_tokens: 100 }).inputUsd).toBeGreaterThan(0);
});
it('matches aliases regardless of case', () => {
  const copy = { ...model, aliases: ['Model-Latest'] };
  expect(findModel([copy], 'GOOGLE', 'model-latest')).toBe(copy);
});

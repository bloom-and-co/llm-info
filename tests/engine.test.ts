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
it('allocates ambiguous cache overlap at maximum plausible cost', () => {
  const result = calculate(model, {
    input_tokens: 1_000_000,
    input_audio_tokens: 600_000,
    cache_read_tokens: 500_000,
  });
  expect(result.inputUsd).toBeCloseTo(5.24, 9);
  expect(result.warnings).toContain('inconsistent_usage');
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

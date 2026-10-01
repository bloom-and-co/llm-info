import { readFileSync } from 'node:fs';
import { it, expect } from 'vitest';
import { calculate } from '../src/engine.ts';

const data = JSON.parse(
  readFileSync(new URL('./fixtures/llm-info-snapshot.json', import.meta.url), 'utf8'),
);
const model = (id: string) =>
  data.models.find((m: any) => m.provider === 'anthropic' && m.id === id);

it.each([
  ['claude-opus-5', 'fast', 0.066],
  ['claude-opus-5-5', 'standard', 0.0264],
])('charges %s %s with US residency', (id, mode, expected) => {
  const result = calculate(model(id), { input_tokens: 1000, output_tokens: 1000 }, {}, mode, 'us');
  expect(result.totalUsd).toBe(expected);
  expect(result.warnings).toEqual([]);
});

it.each([
  ['input_tokens', 0.011],
  ['output_tokens', 0.055],
  ['cache_write_tokens', 0.01375],
  ['cache_write_1h_tokens', 0.022],
  ['cache_read_tokens', 0.0011],
])('stacks US residency and fast pricing for %s', (category, expected) => {
  const usage = category.startsWith('cache_')
    ? { input_tokens: 1000, [category]: 1000 }
    : { [category]: 1000 };
  const result = calculate(model('claude-opus-5'), usage, {}, 'fast', 'us');
  expect(result.totalUsd).toBe(expected);
  expect(result.warnings).toEqual([]);
});

it('keeps pre-4.6 models at standard prices with a missing uplift warning', () => {
  const result = calculate(
    model('claude-sonnet-4-5'),
    { input_tokens: 1000, output_tokens: 1000 },
    {},
    'standard',
    'us',
  );
  expect(result.totalUsd).toBe(0.018);
  expect(result.warnings).toEqual(['missing_region_uplift']);
});

import { it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { createLlmInfo, memoryStore } from '../src/index.ts';
import { calculate } from '../src/engine.ts';
const data = JSON.parse(readFileSync('data/llm-info.json', 'utf8'));
async function client(models = data.models) {
  const info = createLlmInfo({
    store: memoryStore(),
    autoRefresh: false,
    fallbackUrls: [],
    fetch: async () => new Response(JSON.stringify({ ...data, models })),
  });
  await info.load();
  return info;
}
const usage = { input_tokens: 1000, output_tokens: 1000 };
const batchOnly = {
  provider: 'x-ai',
  id: 'grok-test',
  prices: { input: 2, output: 6 },
  modes: { batch: { prices: { input: 1, output: 3 } } },
};
it.each(['priority', 'fast'] as const)('never uses discount data for missing %s', async (mode) => {
  const info = await client([batchOnly]);
  for (const result of [
    calculate(batchOnly, usage, {}, mode),
    info.calc({ provider: 'x-ai', model: 'grok-test', usage, mode })!,
  ]) {
    expect(result.totalUsd).toBeCloseTo(0.016, 12);
    expect(result.warnings).toContain(`missing_price:mode:${mode}`);
  }
});
it('uses only surcharge ratios greater than one from the same provider', async () => {
  const info = await client([
    batchOnly,
    { ...batchOnly, id: 'discount', modes: { flex: { multiplier: 9, prices: {} } } },
    { ...batchOnly, id: 'surcharge', modes: { fast: { prices: { input: 6 } } } },
    { ...batchOnly, id: 'other', provider: 'openai', modes: { priority: { multiplier: 20 } } },
  ]);
  expect(
    info.calc({ provider: 'x-ai', model: 'grok-test', usage, mode: 'priority' })!.totalUsd,
  ).toBeCloseTo(0.024, 12);
  expect(
    info.calc({ provider: 'x-ai', model: 'grok-test', usage, mode: 'flex' })!.totalUsd,
  ).toBeCloseTo(0.008, 12);
  for (const multiplier of [0.5, 1]) {
    const model = { ...batchOnly, modes: { fast: { multiplier } } };
    expect(
      calculate(model, usage, { providerModeMultiplier: multiplier }, 'priority').totalUsd,
    ).toBeCloseTo(0.016, 12);
  }
});
it.each([
  ['grok-4.7', 0.016],
  ['grok-4.3', 0.0075],
] as const)('publishes and bills xAI priority for %s', async (model, expected) => {
  const info = await client();
  expect(data.models.find((m: any) => m.id === model).modes.priority).toBeDefined();
  const result = info.calc({ provider: 'x-ai', model, usage, mode: 'priority' })!;
  expect(result.totalUsd).toBeCloseTo(expected, 12);
  expect(result.warnings).not.toContain('missing_price:mode:priority');
});
it.each(['xai-chat', 'xai-responses'])(
  'bills only the returned xAI tier for %s',
  async (apiFlavor) => {
    const model = { ...batchOnly, modes: { priority: { prices: { input: 4, output: 12 } } } };
    const info = await client([model]);
    for (const [tier, expected] of [
      ['priority', 0.016],
      ['default', 0.008],
      [undefined, 0.008],
    ] as const) {
      const response = {
        model: model.id,
        service_tier: tier,
        usage: apiFlavor === 'xai-chat' ? { prompt_tokens: 1000, completion_tokens: 1000 } : usage,
      };
      expect(
        info.fromResponse({
          provider: 'x-ai',
          apiFlavor,
          response,
          request: { service_tier: 'priority' },
        })!.totalUsd,
      ).toBeCloseTo(expected, 12);
    }
  },
);
it('infers the Gemini returned usage tier without applying the requested tier', async () => {
  const info = await client();
  for (const [tier, expected] of [
    ['priority', 0.0081],
    ['flex', 0.00225],
    ['standard', 0.0045],
    [undefined, 0.0045],
  ] as const) {
    expect(
      info.fromResponse({
        provider: 'google',
        request: { service_tier: 'priority' },
        response: {
          modelVersion: 'gemini-3.8-flash',
          usageMetadata: { promptTokenCount: 1000, candidatesTokenCount: 1000, serviceTier: tier },
        },
      })!.totalUsd,
    ).toBeCloseTo(expected, 12);
  }
});
it('doubles xAI cache, reasoning and long-context token costs', () => {
  const model = data.models.find((m: any) => m.provider === 'x-ai' && m.id === 'grok-4.7');
  for (const input of [1000, 200001]) {
    const tokens = {
      input_tokens: input,
      output_tokens: 1000,
      cache_read_tokens: 500,
      reasoning_tokens: 200,
    };
    const standard = calculate(model, tokens);
    const priority = calculate(model, tokens, {}, 'priority');
    expect(priority.totalUsd).toBeCloseTo(standard.totalUsd * 2, 12);
    expect(priority.warnings).not.toContain('missing_price:mode:priority');
  }
});

import { it, expect } from 'vitest';
import { readFile } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import { createLlmInfo, memoryStore } from '../src/index.ts';
import { calculate } from '../src/engine.ts';

const data = JSON.parse(await readFile('tests/fixtures/llm-info-snapshot.json', 'utf8'));
const cases = JSON.parse(await readFile('tests/fixtures/elevenlabs-calc.json', 'utf8'));
it('bills shared ElevenLabs cases through the public JS API and matches Python', async () => {
  const py = JSON.parse(
    execFileSync(
      'uv',
      ['run', '--project', 'python', 'python', 'python/tests/parity_dump.py', '--elevenlabs'],
      { encoding: 'utf8' },
    ),
  );
  for (const [i, c] of cases.entries()) {
    const doc = structuredClone(data);
    const model = doc.models.find((m: any) => m.provider === 'elevenlabs' && m.id === c.model);
    if (model && c.overrides) Object.assign(model, c.overrides);
    const info = createLlmInfo({
      store: memoryStore(),
      fetch: async () => new Response(JSON.stringify(doc)),
    });
    await info.load();
    const result = info.calc({
      provider: 'elevenlabs',
      model: c.model,
      usage: c.usage,
      mode: c.mode,
      region: c.region,
    });
    if (c.expected === null) {
      expect(result, c.name).toBeNull();
      expect(py[i], c.name).toBeNull();
    } else {
      expect(result!.priceUnit, c.name).toBe('credit');
      expect(py[i].price_unit, c.name).toBe('credit');
      for (const key of ['totalUsd', 'inputUsd', 'outputUsd', 'extraUsd'] as const)
        expect(result![key], c.name).toBeNull();
      for (const key of ['total_usd', 'input_usd', 'output_usd', 'extra_usd'])
        expect(py[i][key], c.name).toBeNull();
      expect(result!.totalCredits, c.name).toBeCloseTo(c.expected, 10);
      expect(result!.extraCredits, c.name).toBeCloseTo(c.expected, 10);
      expect(result!.warnings, c.name).toEqual(c.warnings);
      expect(result!.totalCredits, c.name).toBeCloseTo(Number(py[i].total_credits), 10);
      expect(result!.warnings, c.name).toEqual(py[i].warnings);
    }
  }
});
it('keeps invalid non-finite audio/character usage finite and warns', () => {
  for (const [field, price] of [
    ['characters', 'per_character'],
    ['input_audio_seconds', 'per_input_audio_second'],
    ['output_audio_seconds', 'per_output_audio_second'],
  ]) {
    for (const value of [NaN, Infinity, -Infinity]) {
      const result = calculate(
        {
          provider: 'elevenlabs',
          id: 'synthetic',
          price_unit: 'credit',
          prices: { [price]: 0.002 },
        },
        { [field]: value },
      );
      expect(result.totalUsd).toBeNull();
      expect(result.totalCredits).toBe(0);
      expect(result.warnings).toEqual([`invalid_usage:${field}`]);
    }
  }
});
it('preserves USD output shapes for the original four providers', async () => {
  const info = createLlmInfo({
    store: memoryStore(),
    fetch: async () => new Response(JSON.stringify(data)),
  });
  await info.load();
  for (const provider of ['openai', 'anthropic', 'google', 'x-ai']) {
    const model = data.models.find((m: any) => m.provider === provider && m.mode === 'chat');
    const result = info.calc({
      provider,
      model: model.id,
      usage: { input_tokens: 1000, output_tokens: 100 },
    });
    expect(Object.keys(result!).sort()).toEqual(
      [
        'totalUsd',
        'inputUsd',
        'outputUsd',
        'extraUsd',
        'warnings',
        'provider',
        'model',
        'requestedModel',
        'usage',
        'dataVersion',
      ].sort(),
    );
    expect(typeof result!.totalUsd).toBe('number');
    expect(info.models({ provider }).every((m) => !('price_unit' in m))).toBe(true);
    expect(info.capabilities({ provider, model: model.id })).not.toHaveProperty('price_unit');
  }
  expect(info.models({ provider: 'elevenlabs' }).every((m) => m.price_unit === 'credit')).toBe(
    true,
  );
  expect(info.capabilities({ provider: 'elevenlabs', model: 'scribe_v2' })).toHaveProperty(
    'price_unit',
    'credit',
  );
});
it('refuses legacy ElevenLabs USD caches until refreshed', async () => {
  const old = structuredClone(data);
  const row = old.models.find((m: any) => m.provider === 'elevenlabs' && m.id === 'eleven_v3');
  delete row.price_unit;
  row.prices = { per_character: 0.00018 };
  let source = old;
  const info = createLlmInfo({
    store: memoryStore(),
    fetch: async () => new Response(JSON.stringify(source)),
  });
  await info.load();
  const args = { provider: 'elevenlabs', model: 'eleven_v3', usage: { characters: 1000 } };
  expect(info.calc(args)).toBeNull();
  source = data;
  await info.refresh({ force: true });
  expect(info.calc(args)).toMatchObject({
    totalCredits: 1000,
    totalUsd: null,
    priceUnit: 'credit',
  });
});

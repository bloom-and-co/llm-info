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
      expect(result!.totalUsd, c.name).toBeCloseTo(c.expected, 10);
      expect(result!.extraUsd, c.name).toBeCloseTo(c.expected, 10);
      expect(result!.warnings, c.name).toEqual(c.warnings);
      expect(result!.totalUsd, c.name).toBeCloseTo(Number(py[i].total), 10);
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
        { provider: 'elevenlabs', id: 'synthetic', prices: { [price]: 0.002 } },
        { [field]: value },
      );
      expect(result.totalUsd).toBe(0);
      expect(result.warnings).toEqual([`invalid_usage:${field}`]);
    }
  }
});

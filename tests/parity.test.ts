import { it, expect, vi } from 'vitest';
import { readFile } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import { createLlmInfo, memoryStore } from '../src/index.ts';

it('matches Python totals and warnings for every fixture', async () => {
  vi.resetModules();
  const data = JSON.parse(await readFile('data/llm-info.json', 'utf8'));
  const fixtures = JSON.parse(await readFile('tests/fixtures/responses.json', 'utf8'));
  fixtures.push(
    {
      name: 'null_openai',
      provider: 'openai',
      response: {
        model: 'gpt-4o',
        usage: { prompt_tokens: 10, completion_tokens: 1, prompt_tokens_details: null },
      },
    },
    {
      name: 'null_google',
      provider: 'google',
      response: {
        modelVersion: 'gemini-3.8-flash',
        usageMetadata: { promptTokenCount: 10, thoughtsTokenCount: null },
      },
    },
    {
      name: 'vertex_predictions',
      provider: 'google',
      response: { predictions: [{}, {}] },
      request: { model: 'imagen-3.0-fast-generate-001' },
    },
  );
  const p = createLlmInfo({
    store: memoryStore(),
    fetch: async () => new Response(JSON.stringify(data)),
  });
  await p.load();
  const py = JSON.parse(
    execFileSync(
      'uv',
      ['run', '--with', 'genai-prices==0.1.9', 'python', 'python/tests/parity_dump.py'],
      { encoding: 'utf8' },
    ),
  );
  for (const [i, f] of fixtures.entries()) {
    const cost = p.fromResponse(f);
    expect(cost.totalUsd, f.name).toBeCloseTo(Number(py[i].total), 9);
    expect(cost.warnings, f.name).toEqual(py[i].warnings);
  }
});

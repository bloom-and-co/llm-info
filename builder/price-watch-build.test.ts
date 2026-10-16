import { expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdir, mkdtemp, readFile, rm } from 'node:fs/promises';
import { join } from 'node:path';

it.each(['valid', 'http', 'malformed'])(
  'builder publishes remaining sources when optional feed is %s',
  async (kind) => {
    await mkdir('.work', { recursive: true });
    const cwd = await mkdtemp(join(process.cwd(), '.work/price-watch-build-'));
    try {
      await mkdir(join(cwd, 'data'));
      const lite = Object.fromEntries(
        [
          ['gpt-6-luna', 'openai'],
          ['claude-opus-5-5', 'anthropic'],
          ['gemini-3.8-flash', 'gemini'],
          ['grok-4.7', 'xai'],
        ].map(([id, provider]) => [
          id,
          {
            litellm_provider: provider,
            mode: 'chat',
            input_cost_per_token: 1e-6,
            output_cost_per_token: 2e-6,
            max_input_tokens: 1000,
            max_output_tokens: 100,
          },
        ]),
      );
      const verified_at = '2026-10-16T00:00:00.000Z';
      const data = {
        schema: 1,
        source_url: 'https://elevenlabs.io/pricing',
        verified_at,
        models: [
          {
            provider: 'elevenlabs',
            id: 'eleven_v3',
            feature: 'Text to Speech',
            price_unit: 'credit',
            prices: { per_character: 1.5 },
            verified_at,
          },
        ],
      };
      const bootstrap = `globalThis.fetch = async (url) => {
      if (url.includes('litellm')) return Response.json(${JSON.stringify(lite)});
      if (url === 'https://models.dev/api.json') return Response.json({});
      if (url !== 'https://configured.example/prices.json') throw Error('unexpected URL ' + url);
      return new Response(${JSON.stringify(JSON.stringify(kind === 'malformed' ? { schema: 99 } : data))}, { status: ${kind === 'http' ? 503 : 200} });
    };`;
      execFileSync(
        process.execPath,
        [
          '--import',
          'data:text/javascript;base64,' + Buffer.from(bootstrap).toString('base64'),
          join(process.cwd(), 'builder/build.mjs'),
        ],
        {
          cwd,
          env: { ...process.env, LLM_PRICE_WATCH_URL: 'https://configured.example/prices.json' },
          stdio: 'pipe',
        },
      );
      const out = JSON.parse(await readFile(join(cwd, 'data/llm-info.json'), 'utf8'));
      expect(out.models).toHaveLength(17);
      expect(out.sources.litellm).toHaveProperty('fetched_at');
      expect(out.sources.models_dev).toHaveProperty('fetched_at');
      const eleven = out.models.find((row) => row.id === 'eleven_v3');
      expect(eleven.price_unit).toBe('credit');
      expect(eleven.prices.per_character).toBe(kind === 'valid' ? 1.5 : 1);
      if (kind === 'valid')
        expect(out.sources.price_watch).toMatchObject({
          url: 'https://configured.example/prices.json',
          source_url: data.source_url,
          verified_at,
          models: [{ id: 'eleven_v3', feature: 'Text to Speech', verified_at }],
        });
      else expect(out.sources).not.toHaveProperty('price_watch');
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  },
);

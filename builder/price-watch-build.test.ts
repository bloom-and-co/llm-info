import { expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdir, mkdtemp, readFile, rm } from 'node:fs/promises';
import { join } from 'node:path';

const URL = 'https://configured.example/verify';
const TOKEN = 'test-only-price-watch-token-0123456789abcdef';
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
const feed = (verified_at: string) => ({
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
    {
      provider: 'elevenlabs',
      id: 'scribe_v2_realtime',
      feature: 'Scribe v2 Realtime',
      price_unit: 'credit',
      prices: { per_input_audio_second: 1 },
      verified_at,
    },
  ],
});

async function build(cwd: string, verify: { status: number; body?: unknown } | null) {
  const bootstrap = `globalThis.fetch = async (url, init) => {
    if (url.includes('litellm')) return Response.json(${JSON.stringify(lite)});
    if (url === 'https://models.dev/api.json') return Response.json({});
    if (url !== ${JSON.stringify(URL)} || init?.method !== 'POST') throw Error('unexpected URL ' + url);
    if (init.headers.authorization !== ${JSON.stringify('Bearer ' + TOKEN)}) throw Error('missing token');
    globalThis.process.stdout.write('previous=' + init.body + '\\n');
    return new Response(${JSON.stringify(JSON.stringify(verify?.body ?? { ok: false }))}, { status: ${verify?.status ?? 500} });
  };`;
  const events = join(cwd, 'events.json');
  const stdout = execFileSync(
    process.execPath,
    [
      '--import',
      'data:text/javascript;base64,' + Buffer.from(bootstrap).toString('base64'),
      join(process.cwd(), 'builder/build.mjs'),
    ],
    {
      cwd,
      encoding: 'utf8',
      env: {
        ...process.env,
        LLM_PRICE_WATCH_URL: URL,
        LLM_PRICE_WATCH_TOKEN: TOKEN,
        LLM_PRICE_WATCH_VERIFY: verify ? '1' : '',
        LLM_PRICE_WATCH_EVENTS: events,
      },
      stdio: 'pipe',
    },
  );
  return {
    stdout,
    out: JSON.parse(await readFile(join(cwd, 'data/llm-info.json'), 'utf8')),
    events: JSON.parse(await readFile(events, 'utf8')),
  };
}

it('stores verified prices in git, reuses them between verify runs and keeps them on failure', async () => {
  await mkdir('.work', { recursive: true });
  const cwd = await mkdtemp(join(process.cwd(), '.work/price-watch-build-'));
  try {
    await mkdir(join(cwd, 'data'));
    const first = await build(cwd, {
      status: 200,
      body: { ok: true, feed: feed('2026-10-16T00:00:00.000Z'), events: [] },
    });
    expect(first.stdout).toContain('previous={"previous":[]}');
    expect(first.out.models).toHaveLength(18);
    expect(first.out.models.find((row: any) => row.id === 'eleven_v3').prices.per_character).toBe(
      1.5,
    );
    expect(first.out.models.find((row: any) => row.id === 'scribe_v2_realtime')).toMatchObject({
      mode: 'realtime',
      price_unit: 'credit',
      prices: { per_input_audio_second: 1 },
    });
    expect(first.out.sources.price_watch).toMatchObject({
      url: URL,
      verified_at: '2026-10-16T00:00:00.000Z',
      models: [
        { id: 'eleven_v3', prices: { per_character: 1.5 } },
        { id: 'scribe_v2_realtime', prices: { per_input_audio_second: 1 } },
      ],
    });

    const stored = await build(cwd, null);
    expect(stored.out).toEqual(first.out);
    expect(stored.events).toEqual([]);

    const later = await build(cwd, {
      status: 200,
      body: { ok: true, feed: feed('2026-10-17T00:00:00.000Z'), events: [] },
    });
    expect(later.stdout).toContain(
      '"model_id":"eleven_v3","feature":"Text to Speech","price_key":"per_character","credit_price":1.5,"verified_at":"2026-10-16T00:00:00.000Z"',
    );
    expect(later.stdout).toContain('builder: verified;');
    expect(later.out.version).toBe(first.out.version);
    expect(later.out.sources.price_watch.verified_at).toBe('2026-10-17T00:00:00.000Z');

    const failed = await build(cwd, { status: 502 });
    expect(failed.out).toEqual(later.out);
    expect(failed.events).toEqual([{ type: 'request_failure', reason: `${URL}: HTTP 502` }]);
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
});

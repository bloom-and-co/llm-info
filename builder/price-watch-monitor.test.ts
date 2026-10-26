import { expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { checkPriceWatchFreshness } from './price-watch.mjs';

const now = Date.parse('2026-10-16T12:00:00.000Z');
const hours = 3_600_000;
function feed(ageMs: number) {
  const verified_at = new Date(now - ageMs).toISOString();
  return {
    schema: 1,
    verified_at,
    source_url: 'https://elevenlabs.io/pricing',
    models: [
      {
        provider: 'elevenlabs',
        id: 'eleven_v3',
        feature: 'Text to Speech',
        price_unit: 'credit',
        prices: { per_character: 1 },
        verified_at,
      },
    ],
  };
}

it.each([0, 71 * hours, 72 * hours])('accepts a verification age of %s milliseconds', (age) => {
  expect(checkPriceWatchFreshness(feed(age), now)).toBe(age);
});
it.each([72 * hours + 1, 73 * hours, -1])('fails stale or future verification age %s', (age) => {
  expect(() => checkPriceWatchFreshness(feed(age), now)).toThrow('outside');
});
it('fails an empty feed and does not use llm-info generation time as a health check', () => {
  expect(() =>
    checkPriceWatchFreshness({ ...feed(0), verified_at: null, models: [] }, now),
  ).toThrow('no verified prices');
  expect(() =>
    checkPriceWatchFreshness(
      { ...feed(73 * hours), generated_at: new Date(now).toISOString() },
      now,
    ),
  ).toThrow('outside');
});
it.each([
  ['fresh', []],
  ['fresh', [{ type: 'published_change', model_id: 'eleven_v3' }]],
  ['fresh', [{ type: 'verification_failure', feature_key: 'stt_realtime' }]],
  ['fresh', [{ type: 'request_failure', reason: 'HTTP 502' }]],
  ['stale', null],
  ['missing', null],
  ['legacy', null],
])('monitor process checks the %s stored feed and events %j', async (kind, events) => {
  await mkdir('.work', { recursive: true });
  const cwd = await mkdtemp(join(process.cwd(), '.work/price-watch-monitor-'));
  try {
    const { models, ...rest } = feed(kind === 'stale' ? 73 * hours : 0);
    const meta = {
      ...rest,
      url: 'https://configured.example/verify',
      models: models.map(({ id, feature, prices, verified_at }) =>
        kind === 'legacy' ? { id, feature, verified_at } : { id, feature, prices, verified_at },
      ),
    };
    await writeFile(
      join(cwd, 'llm-info.json'),
      JSON.stringify({ sources: kind === 'missing' ? {} : { price_watch: meta } }),
    );
    const args = [join(cwd, 'llm-info.json')];
    if (events) {
      await writeFile(join(cwd, 'events.json'), JSON.stringify(events));
      args.push(join(cwd, 'events.json'));
    }
    const bootstrap = `Date.now = () => ${now}; globalThis.fetch = () => { throw Error('no network'); };`;
    const run = () =>
      execFileSync(
        process.execPath,
        [
          '--import',
          'data:text/javascript;base64,' + Buffer.from(bootstrap).toString('base64'),
          'scripts/check-price-watch.mjs',
          ...args,
        ],
        { encoding: 'utf8', stdio: 'pipe' },
      );
    if (kind === 'fresh' && events!.every((event) => event.type === 'published_change'))
      expect(run()).toContain('age_hours=0.00');
    else expect(run).toThrow();
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
});

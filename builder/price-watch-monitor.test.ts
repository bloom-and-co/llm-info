import { expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
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
it.each(['fresh', 'stale', 'unavailable', 'malformed'])(
  'monitor process exits correctly for %s source',
  (kind) => {
    const data = feed(kind === 'stale' ? 73 * hours : 0);
    const bootstrap = `Date.now = () => ${now}; globalThis.fetch = async (url) => {
    if (url !== 'https://configured.example/prices.json') throw Error('wrong URL');
    return new Response(${JSON.stringify(JSON.stringify(kind === 'malformed' ? {} : data))}, { status: ${kind === 'unavailable' ? 503 : 200} });
  };`;
    const run = () =>
      execFileSync(
        process.execPath,
        [
          '--import',
          'data:text/javascript;base64,' + Buffer.from(bootstrap).toString('base64'),
          'scripts/check-price-watch.mjs',
        ],
        {
          encoding: 'utf8',
          env: { ...process.env, LLM_PRICE_WATCH_URL: 'https://configured.example/prices.json' },
          stdio: 'pipe',
        },
      );
    if (kind === 'fresh') expect(run()).toContain('age_hours=0.00');
    else expect(run).toThrow();
  },
);

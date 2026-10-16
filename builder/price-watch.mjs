import { providerRules } from './rules.mjs';

export const PRICE_WATCH_URL = 'https://llm-price-watch.hangar.fctry.jp/prices.json';
export const PRICE_WATCH_MAX_BYTES = 64 * 1024;
const reviewed = new Map(
  providerRules
    .filter((rule) => rule.provider === 'elevenlabs' && rule.effect.supplement)
    .flatMap((rule) => rule.model_selector.ids.map((id) => [id, rule.effect.supplement])),
);
const object = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);
const timestamp = (value) =>
  typeof value === 'string' &&
  /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d{3})?Z$/.test(value) &&
  Number.isFinite(Date.parse(value));

// This feed is credit-only. Never infer model IDs, accept USD, or add unreviewed units.
export function validatePriceWatch(data) {
  if (
    !object(data) ||
    data.schema !== 1 ||
    data.source_url !== 'https://elevenlabs.io/pricing' ||
    !Array.isArray(data.models) ||
    data.models.length > reviewed.size ||
    !(data.verified_at === null || timestamp(data.verified_at))
  )
    throw Error('invalid price-watch document');
  const seen = new Set();
  for (const row of data.models) {
    const rule = reviewed.get(row?.id);
    if (
      !object(row) ||
      row.provider !== 'elevenlabs' ||
      row.price_unit !== 'credit' ||
      !rule ||
      seen.has(row.id) ||
      typeof row.feature !== 'string' ||
      !row.feature.trim() ||
      !timestamp(row.verified_at) ||
      !object(row.prices) ||
      !Object.keys(row.prices).length ||
      Object.entries(row.prices).some(
        ([key, value]) =>
          !Object.hasOwn(rule.prices, key) ||
          typeof value !== 'number' ||
          !Number.isFinite(value) ||
          value <= 0,
      )
    )
      throw Error('invalid price-watch model: ' + String(row?.id));
    seen.add(row.id);
  }
  const oldest = data.models.length
    ? Math.min(...data.models.map((row) => Date.parse(row.verified_at)))
    : null;
  if (oldest === null ? data.verified_at !== null : Date.parse(data.verified_at) !== oldest)
    throw Error('price-watch verified_at must be the oldest model verification');
  return data;
}

export async function fetchPriceWatch(url = PRICE_WATCH_URL, fetcher = fetch) {
  const response = await fetcher(url, { signal: AbortSignal.timeout(30_000) });
  if (!response.ok) {
    await response.body?.cancel();
    throw Error(`${url}: HTTP ${response.status}`);
  }
  const declared = Number(response.headers.get('content-length'));
  if (declared > PRICE_WATCH_MAX_BYTES) {
    await response.body?.cancel();
    throw Error(`price-watch body ${declared} bytes exceeds ${PRICE_WATCH_MAX_BYTES} bytes`);
  }
  if (!response.body) throw Error('price-watch body is empty');
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let size = 0;
  let text = '';
  try {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > PRICE_WATCH_MAX_BYTES)
        throw Error(`price-watch body ${size} bytes exceeds ${PRICE_WATCH_MAX_BYTES} bytes`);
      text += decoder.decode(value, { stream: true });
    }
    text += decoder.decode();
  } finally {
    await reader.cancel().catch(() => undefined);
    reader.releaseLock();
  }
  return {
    data: validatePriceWatch(JSON.parse(text)),
    url,
    fetched_at: new Date().toISOString(),
    etag: response.headers.get('etag') ?? 'unknown',
  };
}

export async function optionalPriceWatch(
  url = PRICE_WATCH_URL,
  fetcher = fetch,
  warn = console.warn,
) {
  try {
    return await fetchPriceWatch(url, fetcher);
  } catch (error) {
    warn(`builder: skipped price_watch: ${error.message}`);
    return null;
  }
}

export function priceWatchMetadata(feed, previous, previousIds) {
  const { data, url, fetched_at, etag } = feed;
  const hasNew = data.models.some((row) => !previousIds.has(`${row.provider}\0${row.id}`));
  return {
    url,
    source_url: data.source_url,
    fetched_at,
    etag,
    verified_at: data.verified_at,
    latest_new_model_at:
      hasNew || !previous?.latest_new_model_at ? fetched_at : previous.latest_new_model_at,
    models: data.models.map(({ id, feature, verified_at }) => ({ id, feature, verified_at })),
  };
}

export function checkPriceWatchFreshness(data, now = Date.now()) {
  validatePriceWatch(data);
  if (data.verified_at === null) throw Error('price-watch has no verified prices');
  const ageMs = now - Date.parse(data.verified_at);
  const maxAgeMs = 72 * 60 * 60 * 1000;
  if (ageMs < 0 || ageMs > maxAgeMs)
    throw Error(`price-watch verification age ${ageMs}ms is outside 0..${maxAgeMs}ms`);
  return ageMs;
}

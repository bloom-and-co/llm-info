import { providerRules } from './rules.mjs';

export const PRICE_WATCH_URL = 'https://llm-price-watch.hangar.fctry.jp/verify';
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

async function readLimited(response) {
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
  return text;
}

// The Hangar app holds no state: llm-info's git is the only copy of the adopted prices.
export async function verifyPriceWatch(url, token, previous, fetcher = fetch) {
  const response = await fetcher(url, {
    method: 'POST',
    headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
    body: JSON.stringify({ previous }),
    signal: AbortSignal.timeout(180_000),
  });
  if (!response.ok) {
    await response.body?.cancel();
    throw Error(`${url}: HTTP ${response.status}`);
  }
  const body = JSON.parse(await readLimited(response));
  if (
    !object(body) ||
    !Array.isArray(body.events) ||
    body.events.some((event) => !object(event) || typeof event.type !== 'string')
  )
    throw Error('invalid price-watch response');
  return {
    data: validatePriceWatch(body.feed),
    events: body.events,
    url,
    fetched_at: new Date().toISOString(),
  };
}

export function feedFromMetadata(meta) {
  if (!object(meta) || !Array.isArray(meta.models)) return null;
  return validatePriceWatch({
    schema: 1,
    verified_at: meta.verified_at,
    source_url: meta.source_url,
    models: meta.models.map(({ id, feature, prices, verified_at }) => ({
      provider: 'elevenlabs',
      id,
      feature,
      price_unit: 'credit',
      prices,
      verified_at,
    })),
  });
}

export function previousRows(data) {
  return (data?.models ?? []).map(({ id, feature, prices, verified_at }) => {
    const [[price_key, credit_price]] = Object.entries(prices);
    return { model_id: id, feature, price_key, credit_price, verified_at };
  });
}

// Verify runs ask Hangar; every other run, and a failed verify, keeps the feed stored in git.
export async function resolvePriceWatch({
  previous,
  verify,
  url = PRICE_WATCH_URL,
  token,
  fetcher = fetch,
  warn = console.warn,
}) {
  let stored = null;
  try {
    const data = feedFromMetadata(previous);
    if (data) stored = { data, url: previous.url, fetched_at: previous.fetched_at };
  } catch (error) {
    warn(`builder: ignored stored price_watch: ${error.message}`);
  }
  if (!verify) return { feed: stored, events: [] };
  try {
    if (!token) throw Error('LLM_PRICE_WATCH_TOKEN is not set');
    const feed = await verifyPriceWatch(url, token, previousRows(stored?.data), fetcher);
    return { feed, events: feed.events };
  } catch (error) {
    warn(`builder: price_watch verification failed: ${error.message}`);
    return { feed: stored, events: [{ type: 'request_failure', reason: error.message }] };
  }
}

export function priceWatchMetadata(feed, previous, previousIds) {
  const { data, url, fetched_at } = feed;
  const hasNew = data.models.some((row) => !previousIds.has(`${row.provider}\0${row.id}`));
  return {
    url,
    source_url: data.source_url,
    fetched_at,
    verified_at: data.verified_at,
    latest_new_model_at:
      hasNew || !previous?.latest_new_model_at ? fetched_at : previous.latest_new_model_at,
    models: data.models.map(({ id, feature, prices, verified_at }) => ({
      id,
      feature,
      prices,
      verified_at,
    })),
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

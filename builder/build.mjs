import fs from 'node:fs/promises';
import { IDS, finalize, mergeSources, normalizeId, providerOf, validate } from './core.mjs';
import { optionalPriceWatch, priceWatchMetadata } from './price-watch.mjs';
const URLs = {
  litellm:
    'https://raw.githubusercontent.com/BerriAI/litellm/main/model_prices_and_context_window.json',
  models_dev: 'https://models.dev/api.json',
};
async function get(url) {
  const r = await fetch(url);
  if (!r.ok) throw Error(`${url}: HTTP ${r.status}`);
  return {
    data: await r.json(),
    etag: r.headers.get('etag'),
    fetched_at: new Date().toISOString(),
  };
}
const [l, m, watch] = await Promise.all([
  get(URLs.litellm),
  get(URLs.models_dev),
  optionalPriceWatch(process.env.LLM_PRICE_WATCH_URL),
]);
console.log(`builder: checked litellm=${l.fetched_at} models_dev=${m.fetched_at}`);
const previous = await fs
  .readFile('data/llm-info.json', 'utf8')
  .then(JSON.parse)
  .catch(() => null);
const previousIds = new Set(
  (previous?.models ?? []).map((model) => `${model.provider}\0${model.id}`),
);
const merged = mergeSources(l.data, m.data, watch?.data);
for (const applied of merged.applied_rules)
  console.log('provider_rule: ' + JSON.stringify(applied));
const publishedIds = new Set(merged.models.map((model) => `${model.provider}\0${model.id}`));
const latest = (source, hasNew) =>
  hasNew || !previous?.sources?.[source]?.latest_new_model_at
    ? source === 'litellm'
      ? l.fetched_at
      : m.fetched_at
    : previous.sources[source].latest_new_model_at;
const newLite = Object.entries(l.data).some(([id, value]) => {
  if (!value || typeof value !== 'object') return false;
  const provider = providerOf(value, id);
  if (!provider) return false;
  const key = `${provider}\0${normalizeId(id, provider)}`;
  return publishedIds.has(key) && !previousIds.has(key);
});
const newModels = Object.entries(m.data).some(([source, entry]) => {
  const p = source === 'xai' ? 'x-ai' : source;
  return (
    IDS.includes(p) &&
    Object.keys(entry.models ?? {}).some(
      (id) =>
        publishedIds.has(`${p}\0${normalizeId(id, p)}`) &&
        !previousIds.has(`${p}\0${normalizeId(id, p)}`),
    )
  );
});
const doc = {
  schema: 2,
  sources: {
    litellm: {
      fetched_at: l.fetched_at,
      ref: l.etag ?? 'unknown',
      latest_new_model_at: latest('litellm', newLite),
    },
    models_dev: {
      fetched_at: m.fetched_at,
      etag: m.etag ?? 'unknown',
      latest_new_model_at: latest('models_dev', newModels),
    },
    ...(watch
      ? { price_watch: priceWatchMetadata(watch, previous?.sources?.price_watch, previousIds) }
      : {}),
  },
  models: merged.models,
  skipped: merged.skipped,
};
validate(doc, previous);
const out = finalize(doc, previous);
if (out !== previous) {
  const oneLineSources = `  "sources": {\n${Object.entries(out.sources)
    .map(([name, source]) => `    ${JSON.stringify(name)}: ${JSON.stringify(source)}`)
    .join(',\n')}\n  },\n  "models":`;
  const json = JSON.stringify(out, null, 2).replace(
    /  "sources": \{[\s\S]*?\n  \},\n  "models":/,
    oneLineSources,
  );
  await fs.writeFile('data/llm-info.json', json + '\n');
}
for (const conflict of [
  ...merged.conflicts,
  ...merged.capability_conflicts,
  ...merged.mode_conflicts,
])
  console.log('conflict: ' + JSON.stringify(conflict));
console.log(
  `builder: ${out === previous ? 'unchanged' : 'updated'}; models ${IDS.map((p) => p + '=' + doc.models.filter((m) => m.provider === p).length).join(' ')}; conflicts=${merged.conflicts.length + merged.capability_conflicts.length + merged.mode_conflicts.length}; skipped=${doc.skipped.length}`,
);

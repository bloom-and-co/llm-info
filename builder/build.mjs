import fs from 'node:fs/promises';
import { finalize, mergeSources, normalizeId, providerOf, validate } from './core.mjs';
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
const [l, m] = await Promise.all(Object.values(URLs).map(get));
const previous = await fs
  .readFile('data/llm-info.json', 'utf8')
  .then(JSON.parse)
  .catch(() => null);
const previousIds = new Set(
  (previous?.models ?? []).map((model) => `${model.provider}\0${model.id}`),
);
const merged = mergeSources(l.data, m.data);
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
    ['openai', 'anthropic', 'google', 'x-ai'].includes(p) &&
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
  },
  models: merged.models,
  skipped: merged.skipped,
};
validate(doc, previous);
const out = finalize(doc, previous);
if (out !== previous) {
  const oneLineSources = `  "sources": {\n    "litellm": ${JSON.stringify(out.sources.litellm)},\n    "models_dev": ${JSON.stringify(out.sources.models_dev)}\n  },\n  "models":`;
  const json = JSON.stringify(out, null, 2).replace(
    /  "sources": \{[\s\S]*?\n  \},\n  "models":/,
    oneLineSources,
  );
  await fs.writeFile('data/llm-info.json', json + '\n');
}
for (const conflict of [...merged.conflicts, ...merged.capability_conflicts])
  console.log('conflict: ' + JSON.stringify(conflict));
console.log(
  `builder: ${out === previous ? 'unchanged' : 'updated'}; models ${['openai', 'anthropic', 'google', 'x-ai'].map((p) => p + '=' + doc.models.filter((m) => m.provider === p).length).join(' ')}; conflicts=${merged.conflicts.length + merged.capability_conflicts.length}; skipped=${doc.skipped.length}`,
);

import fs from 'node:fs/promises';
import { finalize, mergeSources, validate } from './core.mjs';
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
const doc = {
  schema: 2,
  sources: {
    litellm: { ref: l.etag ?? 'unknown', fetched_at: l.fetched_at },
    models_dev: { etag: m.etag ?? 'unknown', fetched_at: m.fetched_at },
  },
  ...mergeSources(l.data, m.data),
};
validate(doc, previous);
const out = finalize(doc, previous);
if (out !== previous) await fs.writeFile('data/llm-info.json', JSON.stringify(out, null, 2) + '\n');
console.log(
  `builder: ${out === previous ? 'unchanged' : 'updated'}; models ${['openai', 'anthropic', 'google', 'x-ai'].map((p) => p + '=' + doc.models.filter((m) => m.provider === p).length).join(' ')}; conflicts=${doc.conflicts.length}; skipped=${doc.skipped.length}`,
);

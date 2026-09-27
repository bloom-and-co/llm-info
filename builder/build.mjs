import fs from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import { calcPrice } from '@pydantic/genai-prices';
import { finalize, mergeSources, validate } from './core.mjs';
const URLs = {
  litellm:
    'https://raw.githubusercontent.com/BerriAI/litellm/main/model_prices_and_context_window.json',
  models_dev: 'https://models.dev/api.json',
  gp: 'https://raw.githubusercontent.com/pydantic/genai-prices/main/prices/new_data/v2/data.json',
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
const [l, m, g] = await Promise.all(Object.values(URLs).map(get));
const previous = await fs
  .readFile('data/prices.json', 'utf8')
  .then(JSON.parse)
  .catch(() => null);
const doc = {
  schema: 1,
  sources: {
    litellm: { ref: l.etag ?? 'unknown', fetched_at: l.fetched_at },
    models_dev: { etag: m.etag ?? 'unknown', fetched_at: m.fetched_at },
  },
  ...mergeSources(l.data, m.data, g.data),
};
validate(doc, previous);
for (const p of doc.providers) {
  const model = p.models.find((x) => x.prices.input_mtok && x.prices.output_mtok);
  if (!model || !calcPrice({ input_tokens: 1000, output_tokens: 1000 }, model.id, { provider: p }))
    throw Error('JS SDK activation failed: ' + p.id);
}
const tmp = 'data/.validation.json';
await fs.writeFile(tmp, JSON.stringify(doc));
try {
  execFileSync(
    'uv',
    ['run', '--with', 'genai-prices==0.1.9', 'python', 'builder/validate.py', tmp],
    { stdio: 'inherit' },
  );
} finally {
  await fs.unlink(tmp);
}
const out = finalize(doc, previous);
if (out !== previous) await fs.writeFile('data/prices.json', JSON.stringify(out, null, 2) + '\n');
console.log(
  `builder: ${out === previous ? 'unchanged' : 'updated'}; models ${doc.providers.map((p) => p.id + '=' + p.models.length).join(' ')}; conflicts=${doc.conflicts.length}`,
);

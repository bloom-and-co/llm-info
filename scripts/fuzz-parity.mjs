import fs from 'node:fs';
import { calculate } from '../src/engine.ts';
const d = JSON.parse(fs.readFileSync('data/llm-info.json', 'utf8'));
let s = 7;
const rnd = () => {
  s |= 0;
  s = (s + 0x6d2b79f5) | 0;
  let t = Math.imul(s ^ (s >>> 15), 1 | s);
  t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
};
const pick = (a) => a[Math.floor(rnd() * a.length)];
const keys = [
  'input_tokens',
  'cache_read_tokens',
  'cache_write_tokens',
  'cache_write_1h_tokens',
  'input_audio_tokens',
  'input_image_tokens',
  'input_text_tokens',
  'input_breakdown_present',
  'cache_breakdown_present',
  'input_video_tokens',
  'cache_audio_read_tokens',
  'cache_image_read_tokens',
  'cache_audio_write_tokens',
  'output_tokens',
  'output_audio_tokens',
  'output_image_tokens',
  'output_text_tokens',
  'output_breakdown_present',
  'output_reasoning_tokens',
  'reasoning_tokens',
  'output_images',
  'output_video_seconds',
  'web_searches',
];
const cases = [];
for (let i = 0; i < 20000; i++) {
  const m = pick(d.models);
  const u = {};
  for (const k of keys)
    if (rnd() < 0.35) {
      const value = k.endsWith('_breakdown_present')
        ? 1
        : Math.floor(rnd() * pick([10, 1000, 300000, 1e6]));
      u[k] = rnd() < 0.2 ? String(value) : value;
    }
  const mode = pick(['standard', 'standard', 'fast', 'priority', 'flex', 'batch']);
  const region = pick(['global', 'us', 'eu']);
  const opt =
    rnd() < 0.5
      ? { size: '1024x1024', quality: pick(['high', 'low']), resolution: pick(['4k', '720p']) }
      : {};
  const r = calculate(m, u, opt, mode, region);
  cases.push({ p: m.provider, id: m.id, u, mode, region, opt, t: r.totalUsd, w: r.warnings });
  if (r.totalUsd < 0 || !Number.isFinite(r.totalUsd)) console.log('BAD', m.id, u, r);
}
for (const id of ['gpt-image-1.5', 'chatgpt-image-latest', 'gemini-3.1-flash-image']) {
  const m = d.models.find((row) => row.id === id);
  for (const u of [
    { input_tokens: 50, cache_read_tokens: 20, output_tokens: 4160, output_images: 1 },
    { input_tokens: 50, input_text_tokens: 20, output_tokens: 100, output_text_tokens: 50 },
    {
      input_tokens: 50,
      input_breakdown_present: 1,
      output_tokens: 100,
      output_breakdown_present: 1,
      output_image_tokens: 40,
    },
  ]) {
    const r = calculate(m, u);
    cases.push({
      p: m.provider,
      id: m.id,
      u,
      mode: 'standard',
      region: 'global',
      opt: {},
      t: r.totalUsd,
      w: r.warnings,
    });
  }
}
// Guarantee US coverage for every Anthropic model, including excluded/legacy IDs,
// and exercise caching together with each mode (random cases above also use us).
for (const m of d.models.filter((model) => model.provider === 'anthropic')) {
  for (const mode of ['standard', 'fast', 'batch']) {
    const u = {
      input_tokens: 4000,
      output_tokens: 1000,
      cache_read_tokens: 1000,
      cache_write_tokens: 1000,
      cache_write_1h_tokens: 1000,
    };
    const r = calculate(m, u, {}, mode, 'us');
    cases.push({
      p: m.provider,
      id: m.id,
      u,
      mode,
      region: 'us',
      opt: {},
      t: r.totalUsd,
      w: r.warnings,
    });
  }
}
fs.writeFileSync(process.argv[2], JSON.stringify(cases));
console.log('cases', cases.length);

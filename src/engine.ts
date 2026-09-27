export type Model = {
  provider: string;
  id: string;
  mode?: string;
  name?: string;
  aliases?: string[];
  match?: { exact?: string[]; dated_suffix?: boolean };
  prices: Record<string, any>;
  modes?: Record<string, any>;
  region_uplift?: Record<string, number>;
  capabilities?: Record<string, any>;
};
const dated = /(?:-(?:20\d{6}|20\d{2}-\d{2}-\d{2})|@20\d{6}|-00[12])$/i;
export function findModel(models: Model[], provider: string, name: string): Model | undefined {
  const raw = name
    .replace(/^(?:openai|anthropic|gemini|models|google|xai|x-ai)\//i, '')
    .toLowerCase();
  const rows = models.filter((m) => m.provider.toLowerCase() === provider.toLowerCase());
  const direct = rows.find((m) => m.id.toLowerCase() === raw);
  if (direct) return direct;
  const bedrock = provider.toLowerCase() === 'anthropic' && raw.startsWith('anthropic.');
  const id = bedrock ? raw.slice('anthropic.'.length) : raw;
  if (
    bedrock &&
    rows.filter((m) => m.id.toLowerCase() === id || m.aliases?.some((a) => a.toLowerCase() === id))
      .length !== 1
  )
    return undefined;
  return (
    rows.find((m) => m.id.toLowerCase() === id) ??
    rows.find(
      (m) =>
        m.aliases?.some((a) => a.toLowerCase() === id) ||
        m.match?.exact?.some((a) => a.toLowerCase() === id),
    ) ??
    (dated.test(id)
      ? rows
          .filter(
            (m) =>
              m.match?.dated_suffix &&
              (id.startsWith(m.id.toLowerCase() + '-') || id.startsWith(m.id.toLowerCase() + '@')),
          )
          .sort((a, b) => b.id.length - a.id.length)[0]
      : undefined)
  );
}
const maxRate = (p: Record<string, any>) =>
  Math.max(
    0,
    ...Object.entries(p)
      .filter(([k, v]) => !k.startsWith('per_') && k !== 'tiers' && typeof v === 'number')
      .map(([, v]) => v),
  );
function tableRate(table: any, opt: any, key: string, warnings: string[], highest: number) {
  if (typeof table === 'number') return table;
  if (!table) {
    warnings.push('missing_price:' + key);
    return highest;
  }
  const variant =
    key === 'per_image'
      ? opt.size && opt.quality
        ? `${opt.size}/${opt.quality}`
        : null
      : opt.resolution;
  if (variant && table[variant] !== undefined) return table[variant];
  if (table.default !== undefined) return table.default;
  warnings.push(
    'missing_param:' + (key === 'per_image' ? (!opt.size ? 'size' : 'quality') : 'resolution'),
  );
  return Math.max(...Object.values(table).filter((v): v is number => typeof v === 'number'));
}
export function calculate(
  model: Model,
  usage: Record<string, number>,
  options: any = {},
  mode = 'standard',
  region = 'global',
) {
  const warnings: string[] = [];
  const count = (key: string) => {
    const value: any = usage?.[key];
    if (value === undefined || value === null) return 0;
    const parsed = typeof value === 'string' && value.trim() ? Number(value) : value;
    if (typeof parsed !== 'number' || !Number.isFinite(parsed) || parsed < 0) {
      warnings.push(`invalid_usage:${key}`);
      return 0;
    }
    return parsed;
  };
  const inputCount = count('input_tokens');
  const tiered = (p: Record<string, any>) => {
    const active = { ...p };
    for (const tier of p.tiers ?? [])
      if (inputCount > tier.above_input_tokens) Object.assign(active, tier.prices);
    delete active.tiers;
    return active;
  };
  const prices = tiered(model.prices);
  let multiplier = 1;
  if (mode !== 'standard') {
    const selected = model.modes?.[mode];
    if (selected) {
      const modePrices = selected.prices ?? {};
      Object.assign(prices, tiered(modePrices));
      const ownTierKeys = new Set(
        (modePrices.tiers ?? [])
          .filter((t: any) => inputCount > t.above_input_tokens)
          .flatMap((t: any) => Object.keys(t.prices)),
      );
      for (const [key, value] of Object.entries(modePrices)) {
        if (key === 'tiers' || ownTierKeys.has(key) || typeof value !== 'number') continue;
        const raw = model.prices[key];
        const active = tiered(model.prices)[key];
        if (typeof raw === 'number' && raw > 0 && typeof active === 'number')
          prices[key] = (value * active) / raw;
      }
      if (
        modePrices.cache_write_1h === undefined &&
        !ownTierKeys.has('cache_write_1h') &&
        typeof prices.cache_write_1h === 'number' &&
        typeof prices.input === 'number' &&
        typeof tiered(model.prices).input === 'number' &&
        tiered(model.prices).input > 0
      )
        prices.cache_write_1h *= prices.input / tiered(model.prices).input;
      multiplier = selected.multiplier ?? 1;
    } else {
      warnings.push(`missing_price:mode:${mode}`);
      if (mode === 'priority' || mode === 'fast') {
        const own = Object.values(model.modes ?? {}).reduce((max: number, entry: any) => {
          for (const [key, value] of Object.entries(entry.prices ?? {}))
            if (
              typeof value === 'number' &&
              typeof model.prices[key] === 'number' &&
              model.prices[key] > 0
            )
              max = Math.max(max, value / model.prices[key]);
          return Math.max(max, entry.multiplier ?? 1);
        }, 0);
        multiplier = options.providerModeMultiplier || own || 2;
      }
    }
  }
  const highest = maxRate(prices);
  const rate = (key: string, fallbacks: string[], warn = true): number => {
    if (typeof prices[key] === 'number') return prices[key];
    if (key === 'cache_write_1h') {
      if (warn) warnings.push('fallback_price:cache_write_1h');
      // https://platform.claude.com/docs/en/about-claude/pricing: 1h writes cost 2x standard input.
      return Math.max(rate('input', [], false) * 2, prices.cache_write ?? 0);
    }
    const candidates = fallbacks
      .map((k) => prices[k])
      .filter((v): v is number => typeof v === 'number');
    if (warn) warnings.push((candidates.length ? 'fallback_price:' : 'missing_price:') + key);
    return candidates.length ? Math.max(...candidates) : highest;
  };
  const rawInput = count('input_tokens');
  const buckets = ['audio', 'image', 'video'];
  const inputMod = buckets.map((k) =>
    Math.max(
      count(`input_${k}_tokens`),
      count(`cache_${k}_read_tokens`) + count(`cache_${k}_write_tokens`),
    ),
  );
  const cacheRead = count('cache_read_tokens'),
    cacheWrite = count('cache_write_tokens'),
    cacheWrite1h = count('cache_write_1h_tokens');
  const input = Math.max(rawInput, cacheRead + cacheWrite + cacheWrite1h, ...inputMod);
  const output = Math.max(
    count('output_tokens'),
    count('output_audio_tokens'),
    count('output_image_tokens'),
  );
  if (
    input !== rawInput ||
    output !== count('output_tokens') ||
    inputMod.reduce((a, b) => a + b, 0) > input ||
    cacheRead + cacheWrite + cacheWrite1h > input ||
    count('cache_audio_read_tokens') + count('cache_image_read_tokens') > cacheRead ||
    count('cache_audio_write_tokens') + count('cache_image_write_tokens') > cacheWrite
  )
    warnings.push('inconsistent_usage');
  // Allocate unknown cache overlap to the modality with the greatest resulting charge.
  // For 1M input, 600k audio, 500k cached, at least 100k audio is cached;
  // the remaining 400k goes to whichever modality yields the higher total.
  const mod = inputMod.map((v) => Math.min(v, input));
  const baseKeys = ['input', 'input_audio', 'input_image', 'input_video'];
  const modalRates = mod.map((v, i) => (v ? rate(baseKeys[i + 1], ['input'], false) : 0));
  let sum = mod.reduce((a, b) => a + b, 0);
  if (sum > input) {
    for (const i of [0, 1, 2].sort((a, b) => modalRates[a] - modalRates[b])) {
      const cut = Math.min(mod[i], sum - input);
      mod[i] -= cut;
      sum -= cut;
    }
  }
  const capacity = [Math.max(0, input - sum), ...mod];
  const baseRates = [capacity[0] ? rate('input', []) : 0, ...modalRates];
  for (let i = 0; i < mod.length; i++) if (capacity[i + 1]) rate(baseKeys[i + 1], ['input']);
  let inputCost = capacity.reduce((a, c, i) => a + c * baseRates[i], 0);
  let remaining = capacity.slice();
  const cacheKey = (prefix: string, i: number) =>
    prefix === 'cache_write_1h'
      ? prefix
      : `cache_${buckets[i - 1]}_${prefix === 'cache_read' ? 'read' : 'write'}`;
  const allocate = (total: number, prefix: string, explicit: number[]) => {
    let left = Math.min(total, input);
    for (let i = 1; i < remaining.length; i++) {
      const fixed = Math.min(left, remaining[i], explicit[i - 1] ?? 0);
      if (fixed) {
        const r = rate(cacheKey(prefix, i), [`input_${buckets[i - 1]}`, prefix, 'input']);
        inputCost += fixed * (r - baseRates[i]);
        remaining[i] -= fixed;
        left -= fixed;
      }
    }
    const choices = remaining.map((cap, i) => ({
      i,
      cap,
      r:
        !left || !cap
          ? baseRates[i]
          : i === 0
            ? rate(prefix, ['input'], false)
            : rate(cacheKey(prefix, i), [`input_${buckets[i - 1]}`, prefix, 'input'], false),
    }));
    choices.sort((a, b) => b.r - baseRates[b.i] - (a.r - baseRates[a.i]) || a.i - b.i);
    for (const c of choices) {
      const take = Math.min(left, remaining[c.i]);
      if (!take) continue;
      if (c.i === 0) rate(prefix, ['input']);
      else rate(cacheKey(prefix, c.i), [`input_${buckets[c.i - 1]}`, prefix, 'input']);
      inputCost += take * (c.r - baseRates[c.i]);
      remaining[c.i] -= take;
      left -= take;
    }
    if (left) warnings.push('inconsistent_usage');
  };
  if (cacheRead)
    allocate(cacheRead, 'cache_read', [
      count('cache_audio_read_tokens'),
      count('cache_image_read_tokens'),
      0,
    ]);
  if (cacheWrite) allocate(cacheWrite, 'cache_write', [count('cache_audio_write_tokens'), 0, 0]);
  if (cacheWrite1h) allocate(cacheWrite1h, 'cache_write_1h', [0, 0, 0]);
  const outMod = ['audio', 'image'].map((k) => count(`output_${k}_tokens`));
  if (outMod[0] + outMod[1] > output) warnings.push('inconsistent_usage');
  const includedReasoning = Math.min(output, count('output_reasoning_tokens'));
  let left = output - includedReasoning,
    outputCost = includedReasoning ? includedReasoning * rate('reasoning', ['output']) : 0;
  const outputModal = ['audio', 'image']
    .map((kind, i) => ({
      kind,
      count: outMod[i],
      rate: outMod[i] ? rate(`output_${kind}`, ['output'], false) : 0,
    }))
    .sort((a, b) => b.rate - a.rate);
  for (const entry of outputModal) {
    const c = Math.min(left, entry.count);
    if (c) rate(`output_${entry.kind}`, ['output']);
    outputCost += c * entry.rate;
    left -= c;
  }
  if (
    left &&
    model.capabilities?.output_modalities?.length === 1 &&
    model.capabilities.output_modalities[0] === 'image'
  )
    outputCost += left * rate('output_image', ['output']);
  else if (left) outputCost += left * rate('output', []);
  const reasoning = count('reasoning_tokens');
  if (reasoning) outputCost += reasoning * rate('reasoning', ['output']);
  inputCost = (inputCost * multiplier) / 1e6;
  outputCost = (outputCost * multiplier) / 1e6;
  let extra = 0;
  const images =
    count('output_images') ||
    (prices.per_image !== undefined && !output && !count('output_image_tokens')
      ? (warnings.push('missing_param:image_count'), 1)
      : 0);
  if (
    images &&
    !count('output_image_tokens') &&
    !(
      output &&
      model.capabilities?.output_modalities?.length === 1 &&
      model.capabilities.output_modalities[0] === 'image'
    )
  )
    extra += images * tableRate(prices.per_image, options, 'per_image', warnings, highest / 1e6);
  if (count('output_video_seconds'))
    extra +=
      count('output_video_seconds') *
      tableRate(prices.per_video_second, options, 'per_video_second', warnings, highest / 1e6);
  else if (prices.per_video_second !== undefined) warnings.push('missing_param:duration');
  if (count('web_searches')) {
    if (prices.per_web_search !== undefined) extra += count('web_searches') * prices.per_web_search;
    else warnings.push('missing_price:web_search');
  }
  const normalizedRegion = String(region).toLowerCase();
  if (!['global', 'us', 'eu'].includes(normalizedRegion)) warnings.push(`unknown_region:${region}`);
  else if (normalizedRegion !== 'global' && model.region_uplift?.[normalizedRegion] === undefined)
    warnings.push('missing_region_uplift');
  const uplift = normalizedRegion === 'global' ? 1 : (model.region_uplift?.[normalizedRegion] ?? 1);
  const money = (value: number) => Math.round(value * 1e10) / 1e10;
  return {
    inputUsd: money(inputCost * uplift),
    outputUsd: money(outputCost * uplift),
    extraUsd: money(extra * uplift),
    totalUsd: money((inputCost + outputCost + extra) * uplift),
    warnings: [...new Set(warnings)],
  };
}

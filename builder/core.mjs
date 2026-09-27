import { createHash } from 'node:crypto';
import { calcPrice } from '@pydantic/genai-prices';

export const IDS = ['openai', 'anthropic', 'google', 'x-ai'];
const direct = {
  input_cost_per_token: 'input_mtok',
  output_cost_per_token: 'output_mtok',
  output_cost_per_reasoning_token: 'output_reasoning_mtok',
  cache_read_input_token_cost: 'cache_read_mtok',
  cache_creation_input_token_cost: 'cache_write_mtok',
  input_cost_per_audio_token: 'input_audio_mtok',
  output_cost_per_audio_token: 'output_audio_mtok',
  input_cost_per_image_token: 'input_image_mtok',
  output_cost_per_image_token: 'output_image_mtok',
  cache_read_input_image_token_cost: 'cache_image_read_mtok',
  cache_read_input_audio_token_cost: 'cache_audio_read_mtok',
  cache_creation_input_audio_token_cost: 'cache_audio_write_mtok',
};
const mdKeys = {
  input: 'input_mtok',
  output: 'output_mtok',
  cache_read: 'cache_read_mtok',
  cache_write: 'cache_write_mtok',
  input_audio: 'input_audio_mtok',
  output_audio: 'output_audio_mtok',
  reasoning: 'output_reasoning_mtok',
  input_image: 'input_image_mtok',
  output_image: 'output_image_mtok',
};
const clean = (x) => JSON.parse(JSON.stringify(x));
export function normalizeId(id, provider) {
  if (provider === 'google') return id.replace(/^(gemini|vertex_ai[^/]*)\//, '');
  if (provider === 'x-ai') return id.replace(/^xai\//, '');
  if (provider === 'openai') return id.replace(/^openai\//, '');
  if (provider === 'anthropic') return id.replace(/^anthropic\//, '');
  return id;
}
export function providerOf(v, id) {
  const p = v.litellm_provider;
  if (p === 'openai' || p === 'anthropic') return p;
  if (
    p === 'gemini' ||
    (p?.startsWith('vertex_ai') && /^(gemini|imagen|veo|models\/)/.test(id.replace(/^.*?\//, '')))
  )
    return 'google';
  if (p === 'xai') return 'x-ai';
  return null;
}
function num(v) {
  return typeof v === 'number' && Number.isFinite(v) && v >= 0 ? v : undefined;
}
const mtok = (value) => Number((value * 1e6).toPrecision(12));
function put(obj, key, value) {
  if (value !== undefined) obj[key] = value;
}
function fromLite(v, provider) {
  const prices = {};
  const extras = {};
  for (const [k, d] of Object.entries(direct))
    put(prices, d, num(v[k]) === undefined ? undefined : mtok(v[k]));
  if (v.mode === 'image_generation' || v.output_cost_per_image !== undefined)
    put(extras, 'per_image', num(v.output_cost_per_image));
  // https://docs.x.ai/developers/pricing: xAI Imagine charges per generated image; LiteLLM stores this as input_cost_per_image.
  if (provider === 'x-ai' && v.mode === 'image_generation' && extras.per_image === undefined)
    put(extras, 'per_image', num(v.input_cost_per_image));
  else put(extras, 'input_per_image', num(v.input_cost_per_image));
  const searches = v.search_context_cost_per_query;
  put(
    extras,
    'web_search',
    num(searches) ??
      (searches && typeof searches === 'object'
        ? Math.max(...Object.values(searches).filter((x) => num(x) !== undefined))
        : undefined),
  );
  if (v.mode === 'video_generation') {
    const video = num(v.output_cost_per_video_per_second ?? v.output_cost_per_second);
    const resolutions = Object.fromEntries(
      Object.entries(v)
        .filter(
          ([k, val]) => /^output_cost_per_second_[a-z0-9]+$/.test(k) && num(val) !== undefined,
        )
        .map(([k, val]) => [k.slice('output_cost_per_second_'.length), val]),
    );
    if (Object.keys(resolutions).length)
      extras.per_video_second = {
        ...(video === undefined ? {} : { default: video }),
        ...resolutions,
      };
    else put(extras, 'per_video_second', video);
  }
  const tiers = {};
  for (const [k, d] of Object.entries(direct))
    for (const [suffix, start] of [
      ['above_128k_tokens', 128000],
      ['above_200k_tokens', 200000],
      ['above_272k_tokens', 272000],
    ]) {
      const val = num(v[k + '_' + suffix]);
      if (val !== undefined) {
        (tiers[d] ??= []).push({ start: start - 1, price: mtok(val) });
      }
    }
  for (const [k, t] of Object.entries(tiers))
    if (prices[k] !== undefined)
      prices[k] = { base: prices[k], tiers: t.sort((a, b) => a.start - b.start) };
  const modes = {};
  for (const [suffix, mode] of [
    ['priority', 'priority'],
    ['flex', 'flex'],
    ['batches', 'batch'],
  ]) {
    const modePrices = {};
    for (const [field, key] of Object.entries(direct)) {
      put(
        modePrices,
        key,
        num(v[`${field}_${suffix}`]) === undefined ? undefined : mtok(v[`${field}_${suffix}`]),
      );
      const tierValues = [];
      for (const [tierSuffix, start] of [
        ['above_128k_tokens', 128000],
        ['above_200k_tokens', 200000],
        ['above_272k_tokens', 272000],
      ]) {
        const value = num(v[`${field}_${tierSuffix}_${suffix}`]);
        if (value !== undefined) tierValues.push({ start: start - 1, price: mtok(value) });
      }
      if (tierValues.length && modePrices[key] !== undefined)
        modePrices[key] = { base: modePrices[key], tiers: tierValues };
    }
    if (Object.keys(modePrices).length) modes[mode] = { prices: modePrices };
  }
  const fastMultiplier = num(v.provider_specific_entry?.fast);
  if (fastMultiplier !== undefined)
    modes.fast = {
      prices: Object.fromEntries(
        Object.entries(prices).map(([key, value]) => [key, scalePrice(value, fastMultiplier)]),
      ),
    };
  const region = {};
  put(region, 'us', num(v.regional_processing_uplift_multiplier_us));
  put(region, 'eu', num(v.regional_processing_uplift_multiplier_eu));
  return { prices, extras, modes, region, capabilities: liteCapabilities(v) };
}
function scalePrice(value, factor) {
  return typeof value === 'number'
    ? value * factor
    : {
        base: value.base * factor,
        tiers: value.tiers.map((t) => ({ ...t, price: t.price * factor })),
      };
}
function fromModels(v, imageOutput = false) {
  const prices = {};
  const keys = { ...mdKeys, output: imageOutput ? 'output_image_mtok' : 'output_mtok' };
  for (const [k, d] of Object.entries(keys)) put(prices, d, num(v.cost?.[k]));
  for (const tier of v.cost?.tiers ?? [])
    if (tier.tier?.type === 'context')
      for (const [k, d] of Object.entries(keys))
        if (num(tier[k]) !== undefined && prices[d] !== undefined) {
          const entry = prices[d];
          const t = typeof entry === 'number' ? { base: entry, tiers: [] } : entry;
          t.tiers.push({ start: tier.tier.size - 1, price: tier[k] });
          prices[d] = t;
        }
  const modes = {};
  for (const [name, mode] of Object.entries(v.experimental?.modes ?? {})) {
    if (!['fast', 'priority', 'flex', 'batch'].includes(name) || !mode.cost) continue;
    modes[name] = {
      prices: fromModels({ cost: mode.cost }, imageOutput).prices,
      request: mode.provider ?? {},
    };
  }
  return { prices, extras: {}, modes, region: {}, capabilities: modelsCapabilities(v) };
}
const modality = (x) =>
  ({ file: 'pdf', images: 'image', vision: 'image' })[String(x).toLowerCase()] ??
  String(x).toLowerCase();
const modalities = (x) => (Array.isArray(x) ? [...new Set(x.map(modality))].sort() : []);
function liteCapabilities(v) {
  const flags = ['none', 'low', 'medium', 'high', 'xhigh', 'max'];
  let efforts = Array.isArray(v.reasoning_effort_levels) ? v.reasoning_effort_levels : null;
  if (!efforts) {
    const declared = flags.filter((level) => v[`supports_${level}_reasoning_effort`] === true);
    if (v.supports_minimal_reasoning_effort === true) declared.push('minimal');
    efforts = declared.length ? declared : null;
  }
  return {
    reasoning: v.supports_reasoning,
    reasoning_efforts: efforts,
    default_reasoning_effort: v.default_reasoning_effort,
    tool_call: v.supports_function_calling,
    parallel_tool_calls: v.supports_parallel_function_calling,
    structured_output: v.supports_response_schema,
    web_search: v.supports_web_search,
    input_modalities: modalities(v.supported_modalities),
    output_modalities: modalities(v.supported_output_modalities),
    temperature: v.supports_sampling_params,
    prompt_caching: v.supports_prompt_caching,
    computer_use: v.supports_computer_use,
    context_window: v.max_input_tokens,
    max_input_tokens: v.max_input_tokens,
    max_output_tokens: v.max_output_tokens,
    knowledge_cutoff: v.knowledge_cutoff,
    release_date: v.release_date,
    endpoints: v.supported_endpoints,
  };
}
function modelsCapabilities(v) {
  return {
    reasoning: v.reasoning,
    reasoning_efforts: v.reasoning_options?.find((x) => x.type === 'effort')?.values,
    default_reasoning_effort: v.default_reasoning_effort,
    tool_call: v.tool_call,
    parallel_tool_calls: v.parallel_tool_calls,
    structured_output: v.structured_output,
    web_search: v.web_search,
    input_modalities: modalities(v.modalities?.input),
    output_modalities: modalities(v.modalities?.output),
    temperature: v.temperature,
    prompt_caching: v.prompt_caching,
    computer_use: v.computer_use,
    context_window: v.limit?.context,
    max_input_tokens: v.limit?.input,
    max_output_tokens: v.limit?.output,
    knowledge_cutoff: v.knowledge,
    release_date: v.release_date,
    endpoints: v.endpoints,
  };
}
function mergeCapabilities(old, incoming, source, conflicts, provider, model) {
  const values = old?.values ?? {},
    sources = old?.sources ?? {};
  for (const [field, candidate] of Object.entries(incoming)) {
    if (
      candidate === undefined ||
      candidate === null ||
      (Array.isArray(candidate) && !candidate.length)
    )
      continue;
    const prior = values[field];
    if (prior === undefined || prior === null || (Array.isArray(prior) && !prior.length)) {
      values[field] = candidate;
      sources[field] = source;
      continue;
    }
    const different = JSON.stringify(prior) !== JSON.stringify(candidate);
    if (different)
      conflicts.push({
        provider,
        model,
        field,
        previous: prior,
        incoming: candidate,
        source_a: sources[field],
        source_b: source,
      });
    if (Array.isArray(prior) && field.includes('modalities'))
      values[field] = [...new Set([...prior, ...candidate])].sort();
    else if (field === 'reasoning_efforts')
      values[field] = source === 'models_dev' ? candidate : prior;
    else if (typeof prior === 'boolean') values[field] = prior || candidate;
    else if (typeof prior === 'number') values[field] = Math.min(prior, candidate);
    else if (source === 'models_dev') values[field] = candidate;
    sources[field] = different ? 'both' : sources[field] === source ? source : 'both';
  }
  return { values, sources };
}
function base(v) {
  return typeof v === 'number' ? v : v?.base;
}
function mergePrice(a, b, meta, conflicts) {
  if (a === undefined) return b;
  if (b === undefined) return a;
  const av = base(a),
    bv = base(b);
  const adopted = Math.max(av, bv);
  if (Math.abs(av - bv) / Math.max(av, bv, 1e-12) >= 0.005)
    conflicts.push({ ...meta, litellm: av, models_dev: bv, adopted });
  const tierMap = new Map();
  for (const t of typeof a === 'number' ? [] : a.tiers) tierMap.set(t.start, t.price);
  for (const t of typeof b === 'number' ? [] : b.tiers) {
    const prior = tierMap.get(t.start);
    if (prior !== undefined && Math.abs(prior - t.price) / Math.max(prior, t.price, 1e-12) >= 0.005)
      conflicts.push({
        ...meta,
        field: meta.field + '@' + (t.start + 1),
        litellm: prior,
        models_dev: t.price,
        adopted: Math.max(prior, t.price),
      });
    tierMap.set(t.start, Math.max(t.price, prior ?? 0));
  }
  const tiers = [...tierMap]
    .sort((x, y) => x[0] - y[0])
    .map(([start, price]) => ({ start, price }));
  return tiers.length ? { base: adopted, tiers } : adopted;
}
function escaped(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
function completeSdkPriceKeys(model, providerMetadata) {
  for (let attempt = 0; attempt < 12; attempt++) {
    try {
      calcPrice({ input_tokens: 1 }, model.id, {
        provider: { ...providerMetadata, models: [{ ...model, match: { equals: model.id } }] },
      });
      return;
    } catch (error) {
      const key = String(error).match(/Missing (?:join|ancestor) price key ([a-z0-9_]+)/)?.[1];
      if (!key) throw error;
      const prices = model.prices;
      const fallback =
        key === 'output_mtok'
          ? prices.output_image_mtok
          : key === 'output_image_reasoning_mtok'
            ? (prices.output_image_mtok ?? prices.output_reasoning_mtok ?? prices.output_mtok)
            : key === 'output_audio_reasoning_mtok'
              ? (prices.output_audio_mtok ?? prices.output_reasoning_mtok ?? prices.output_mtok)
              : key === 'cache_audio_read_mtok'
                ? (prices.cache_audio_read_mtok ?? prices.input_audio_mtok)
                : key === 'cache_audio_write_mtok'
                  ? (prices.cache_audio_write_mtok ?? prices.input_audio_mtok)
                  : key === 'cache_image_read_mtok'
                    ? (prices.cache_image_read_mtok ?? prices.input_image_mtok)
                    : key.startsWith('output_')
                      ? (prices.output_mtok ?? prices.output_image_mtok ?? prices.output_audio_mtok)
                      : key.includes('cache_')
                        ? (prices.cache_read_mtok ?? prices.cache_write_mtok ?? prices.input_mtok)
                        : prices.input_mtok;
      if (fallback === undefined || attempt === 11) throw error;
      model.prices[key] = fallback;
    }
  }
}
export function mergeSources(lite, models, gp) {
  const map = new Map(),
    conflicts = [],
    capability_conflicts = [],
    imageModels = new Set(),
    skipped = [];
  function add(p, id, v, source, sourceId = id) {
    id = normalizeId(id, p);
    if (!id || id.includes('/')) return;
    const key = p + '\0' + id;
    const old = map.get(key) ?? { id, prices: {}, x_source: source };
    if (old.x_source !== source) old.x_source = 'both';
    for (const [field, val] of Object.entries(v.prices)) {
      if (old.prices[field] === undefined) old.prices[field] = val;
      else if (source === 'models_dev')
        old.prices[field] = mergePrice(
          old.prices[field],
          val,
          { provider: p, model: id, field },
          conflicts,
        );
      else {
        const prior = base(old.prices[field]),
          candidate = base(val);
        if (Math.abs(prior - candidate) / Math.max(prior, candidate, 1e-12) >= 0.005)
          conflicts.push({
            provider: p,
            model: id,
            field,
            source_a: old.x_lite_sources?.[field],
            source_b: 'litellm:' + sourceId,
            prior,
            candidate,
            adopted: Math.max(prior, candidate),
          });
        const priorTiers = typeof old.prices[field] === 'number' ? [] : old.prices[field].tiers;
        const nextTiers = typeof val === 'number' ? [] : val.tiers;
        for (const next of nextTiers) {
          const existing = priorTiers.find((tier) => tier.start === next.start);
          if (
            existing &&
            Math.abs(existing.price - next.price) / Math.max(existing.price, next.price, 1e-12) >=
              0.005
          )
            conflicts.push({
              provider: p,
              model: id,
              field: `${field}@${next.start + 1}`,
              source_a: old.x_lite_sources?.[field],
              source_b: 'litellm:' + sourceId,
              prior: existing.price,
              candidate: next.price,
              adopted: Math.max(existing.price, next.price),
            });
        }
        old.prices[field] = mergePrice(
          old.prices[field],
          val,
          { provider: p, model: id, field },
          [],
        );
      }
      if (source === 'litellm') (old.x_lite_sources ??= {})[field] ??= 'litellm:' + sourceId;
    }
    function mergeExtra(target, incoming, prefix) {
      for (const [name, value] of Object.entries(incoming)) {
        const path = prefix ? `${prefix}.${name}` : name;
        const prior = target[name];
        if (prior === undefined) {
          target[name] = value;
          if (value && typeof value === 'object' && source === 'litellm') {
            for (const nested of Object.keys(value))
              (old.x_lite_extra_sources ??= {})[`${path}.${nested}`] = 'litellm:' + sourceId;
          }
        } else if (typeof prior === 'number' && typeof value === 'number') {
          if (Math.abs(prior - value) / Math.max(prior, value, 1e-12) >= 0.005)
            conflicts.push({
              provider: p,
              model: id,
              field: `x_extra_prices.${path}`,
              source_a: old.x_lite_extra_sources?.[path],
              source_b: 'litellm:' + sourceId,
              prior,
              candidate: value,
              adopted: Math.max(prior, value),
            });
          target[name] = Math.max(prior, value);
        } else if (prior && value && typeof prior === 'object' && typeof value === 'object')
          mergeExtra(prior, value, path);
        else target[name] = value;
        if (source === 'litellm') (old.x_lite_extra_sources ??= {})[path] ??= 'litellm:' + sourceId;
      }
    }
    if (Object.keys(v.extras).length) mergeExtra((old.x_extra_prices ??= {}), v.extras, '');
    for (const [mode, entry] of Object.entries(v.modes ?? {})) {
      const target = ((old.x_modes ??= {})[mode] ??= { prices: {} });
      for (const [field, value] of Object.entries(entry.prices)) {
        target.prices[field] = mergePrice(
          target.prices[field],
          value,
          { provider: p, model: id, field: `x_modes.${mode}.${field}` },
          conflicts,
        );
      }
      if (entry.request) target.request = entry.request;
    }
    for (const [region, factor] of Object.entries(v.region ?? {})) {
      const prior = (old.x_region_uplift ??= {})[region];
      if (prior !== undefined && prior !== factor)
        conflicts.push({
          provider: p,
          model: id,
          field: `x_region_uplift.${region}`,
          prior,
          candidate: factor,
          adopted: Math.max(prior, factor),
        });
      old.x_region_uplift[region] = Math.max(prior ?? 0, factor);
    }
    old._cap = mergeCapabilities(
      old._cap,
      v.capabilities ?? {},
      source,
      capability_conflicts,
      p,
      id,
    );
    map.set(key, old);
  }
  const sizedImages = [];
  for (const [id, v] of Object.entries(lite).sort(([a], [b]) => a.localeCompare(b, 'en')))
    if (v && typeof v === 'object') {
      const p = providerOf(v, id);
      if (!p) continue;
      const sized = id.match(/^(?:(low|medium|high|standard|hd)\/)?(\d+)-x-(\d+)\/(.+)$/);
      if (sized && v.mode === 'image_generation') {
        sizedImages.push({
          p,
          id: sized[4],
          quality: sized[1] ?? 'standard',
          width: +sized[2],
          height: +sized[3],
          v,
        });
        continue;
      }
      const n = normalizeId(id, p);
      if (/^(azure|bedrock|vertex_ai)\//.test(n)) continue;
      if (v.mode === 'image_generation' || v.output_cost_per_image_token !== undefined)
        imageModels.add(p + '\0' + n);
      add(p, id, fromLite(v, p), 'litellm', id);
    }
  for (const image of sizedImages) {
    const key = image.p + '\0' + normalizeId(image.id, image.p);
    const model = map.get(key) ?? {
      id: normalizeId(image.id, image.p),
      prices: {},
      x_source: 'litellm',
    };
    const pixel = num(image.v.input_cost_per_pixel) ?? num(image.v.output_cost_per_pixel);
    const fixed =
      image.p === 'x-ai' ? num(image.v.input_cost_per_image) : num(image.v.output_cost_per_image);
    if (pixel !== undefined || fixed !== undefined) {
      const size = `${image.width}x${image.height}/${image.quality}`;
      const existing = model.x_extra_prices?.per_image;
      const table =
        typeof existing === 'object'
          ? existing
          : typeof existing === 'number'
            ? { default: existing }
            : {};
      model.x_extra_prices = {
        ...model.x_extra_prices,
        per_image: { ...table, [size]: fixed ?? pixel * image.width * image.height },
      };
      map.set(key, model);
    }
  }
  for (const [src, p] of [
    ['openai', 'openai'],
    ['anthropic', 'anthropic'],
    ['google', 'google'],
    ['xai', 'x-ai'],
  ])
    for (const [id, v] of Object.entries(models[src]?.models ?? {})) {
      const normalized = normalizeId(id, p);
      const liteModel = map.get(p + '\0' + normalized);
      const imageOutput =
        v.modalities?.output?.includes('image') ||
        imageModels.has(p + '\0' + normalized) ||
        liteModel?.prices.output_image_mtok !== undefined ||
        liteModel?.x_extra_prices?.per_image !== undefined;
      add(p, id, fromModels(v, imageOutput), 'models_dev');
    }
  const providers = IDS.map((id) => {
    const meta = gp.find((p) => p.id === id);
    if (!meta) throw Error('missing metadata ' + id);
    const { models: ignored, extractors: upstream, ...rest } = meta;
    const ms = [...map.entries()]
      .filter(([key]) => key.startsWith(id + '\0'))
      .map(([, m]) => m)
      .filter((m) => Object.keys(m.prices).length || m.x_extra_prices);
    ms.sort((a, b) => a.id.localeCompare(b.id, 'en'));
    const valid = [];
    for (const m of ms) {
      const dev = models[id === 'x-ai' ? 'xai' : id]?.models?.[m.id];
      if (dev?.name) m.name = dev.name;
      if (dev?.limit?.context) m.context_window = dev.limit.context;
      const cap = m._cap ?? { values: {}, sources: {} };
      m.x_capabilities = {
        ...Object.fromEntries(
          [
            'reasoning',
            'reasoning_efforts',
            'default_reasoning_effort',
            'tool_call',
            'parallel_tool_calls',
            'structured_output',
            'web_search',
            'input_modalities',
            'output_modalities',
            'temperature',
            'prompt_caching',
            'computer_use',
            'context_window',
            'max_input_tokens',
            'max_output_tokens',
            'knowledge_cutoff',
            'release_date',
            'endpoints',
          ].map((field) => [
            field,
            cap.values[field] ??
              (field.endsWith('modalities')
                ? []
                : ['reasoning', 'tool_call', 'structured_output'].includes(field)
                  ? false
                  : null),
          ]),
        ),
        sources: cap.sources,
      };
      try {
        completeSdkPriceKeys(m, rest);
      } catch (error) {
        skipped.push({ provider: id, model: m.id, reason: String(error) });
        console.warn(`skipped ${id}/${m.id}: ${error}`);
        continue;
      }
      delete m.x_lite_sources;
      delete m.x_lite_extra_sources;
      delete m._cap;
      const exactChildren = ms
        .filter(
          (x) =>
            x !== m &&
            new RegExp(`^${escaped(m.id)}-(?:20\\d{6}|20\\d{2}-\\d{2}-\\d{2})$`).test(x.id),
        )
        .map((x) => x.id);
      m.match = {
        or: [
          { equals: m.id },
          {
            regex: `^${escaped(m.id)}-(?!${exactChildren.map((x) => escaped(x.slice(m.id.length + 1))).join('|') || '(?!)'}$)(?:20\\d{6}|20\\d{2}-\\d{2}-\\d{2})$`,
          },
        ],
      };
      valid.push(m);
    }
    return { ...rest, extractors: makeExtractors(id, upstream ?? []), models: valid };
  });
  conflicts.sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b), 'en'));
  capability_conflicts.sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b), 'en'));
  return { providers, conflicts, capability_conflicts, skipped };
}
function makeExtractors(id, existing) {
  const e = clean(existing);
  for (const extractor of e)
    extractor.mappings = extractor.mappings.filter(
      (mapping) => mapping.dest !== 'cache_write_1h_tokens',
    );
  const map = (path, dest) => ({ path, dest, required: false });
  if (id === 'openai') {
    if (!e.some((x) => x.api_flavor === 'images')) {
      const image = {
        api_flavor: 'images',
        root: 'usage',
        model_path: 'model',
        mappings: [
          map('input_tokens', 'input_tokens'),
          map('output_tokens', 'output_tokens'),
          map(['input_tokens_details', 'image_tokens'], 'input_image_tokens'),
          map(['output_tokens_details', 'image_tokens'], 'output_image_tokens'),
        ],
      };
      e.push(image);
    }
  }
  if (id === 'google')
    for (const x of e.filter((x) => x.api_flavor === 'default')) {
      if (!x.mappings.some((m) => m.dest === 'input_image_tokens'))
        x.mappings.push(
          map(
            [
              'promptTokensDetails',
              { field: 'modality', match: { equals: 'IMAGE' }, type: 'array-match' },
              'tokenCount',
            ],
            'input_image_tokens',
          ),
        );
      if (!x.mappings.some((m) => m.dest === 'output_image_tokens'))
        x.mappings.push(
          map(
            [
              'candidatesTokensDetails',
              { field: 'modality', match: { equals: 'IMAGE' }, type: 'array-match' },
              'tokenCount',
            ],
            'output_image_tokens',
          ),
        );
    }
  return e;
}
export function validate(doc, previous) {
  if (doc.schema !== 1 || !Array.isArray(doc.providers) || doc.providers.length !== 4)
    throw Error('invalid document');
  for (const p of doc.providers) {
    const old = previous?.providers?.find((x) => x.id === p.id);
    if (old && p.models.length < old.models.length * 0.8)
      throw Error('model count dropped: ' + p.id);
    for (const m of p.models) {
      if (!Object.keys(m.prices).length && !m.x_extra_prices)
        throw Error('model without price ' + m.id);
      const walk = (x) => {
        if (typeof x === 'number' && (!Number.isFinite(x) || x < 0))
          throw Error('invalid price ' + m.id);
        if (x && typeof x === 'object') Object.values(x).forEach(walk);
      };
      walk(m.prices);
      walk(m.x_extra_prices);
    }
  }
  for (const [p, id] of [
    ['openai', 'gpt-6-luna'],
    ['anthropic', 'claude-opus-5-5'],
    ['google', 'gemini-3.8-flash'],
    ['x-ai', 'grok-4.7'],
  ])
    if (!doc.providers.find((x) => x.id === p)?.models.some((x) => x.id === id))
      throw Error('missing flagship ' + id);
}
export function stableContent(doc) {
  return JSON.stringify({
    providers: doc.providers,
    conflicts: doc.conflicts,
    capability_conflicts: doc.capability_conflicts,
    skipped: doc.skipped,
  });
}
export function finalize(doc, previous, now = new Date().toISOString()) {
  const content = stableContent(doc);
  if (previous && content === stableContent(previous)) return previous;
  const hash = createHash('sha256').update(content).digest('hex').slice(0, 12);
  return { ...doc, generated_at: now, version: now + '-' + hash };
}

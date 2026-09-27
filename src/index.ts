import { calcPrice, type Provider } from '@pydantic/genai-prices';
export const DEFAULT_URL =
  'https://raw.githubusercontent.com/bloom-and-co/llm-prices/main/data/prices.json';
export const FALLBACK_URL =
  'https://cdn.jsdelivr.net/gh/bloom-and-co/llm-prices@main/data/prices.json';
export class PricesNotLoadedError extends Error {
  constructor() {
    super('Prices are not loaded; await load() first');
    this.name = 'PricesNotLoadedError';
  }
}
export type PriceData = {
  schema: number;
  version: string;
  generated_at: string;
  providers: Provider[];
  conflicts?: unknown[];
  skipped?: unknown[];
};
export type CacheDoc = {
  cache_schema: 1;
  source_url: string;
  fetched_at: string;
  etag: string | null;
  last_attempt_at: string;
  last_error: string | null;
  data: PriceData;
};
export interface PriceStore {
  read(): CacheDoc | null | Promise<CacheDoc | null>;
  write(doc: CacheDoc): void | Promise<void>;
}
export function memoryStore(initial: CacheDoc | null = null): PriceStore {
  let doc = initial;
  return {
    read: () => doc,
    write: (next) => {
      if (!doc || Date.parse(next.data.generated_at) >= Date.parse(doc.data.generated_at))
        doc = next;
    },
  };
}
export type Info = {
  version: string | null;
  generatedAt: string | null;
  fetchedAt: string | null;
  stale: boolean;
  lastError: string | null;
};
export type Cost = {
  totalUsd: number;
  inputUsd: number;
  outputUsd: number;
  extraUsd: number;
  provider: string;
  model: string;
  requestedModel: string;
  usage: Record<string, number>;
  dataVersion: string;
  source: string;
  warnings: string[];
};
type Options = {
  url?: string;
  fallbackUrls?: string[];
  store?: PriceStore;
  ttl?: number;
  autoRefresh?: boolean;
  fetch?: typeof fetch;
  accept?: (next: PriceData, prev: PriceData | null) => boolean | Promise<boolean>;
  onEvent?: (event: string, detail?: unknown) => void;
};
let created = false;
function valid(data: any): data is PriceData {
  return (
    data?.schema === 1 &&
    typeof data.version === 'string' &&
    Number.isFinite(Date.parse(data.generated_at)) &&
    Array.isArray(data.providers) &&
    data.providers.length === 4 &&
    data.providers.every(
      (p: any) =>
        typeof p.id === 'string' &&
        Array.isArray(p.models) &&
        p.models.every((m: any) => m.id && m.match && m.prices),
    )
  );
}
function stamp() {
  return new Date().toISOString();
}
function number(x: any): number | undefined {
  return typeof x === 'number' && Number.isFinite(x) ? x : undefined;
}
function matchModel(p: Provider, id: string) {
  const models = p.models as any[];
  const exact = models.find((m) => m.id.toLowerCase() === id.toLowerCase());
  if (exact) return exact;
  return models
    .filter((m) =>
      new RegExp(
        `^${m.id.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}-(?:20\\d{6}|20\\d{2}-\\d{2}-\\d{2})$`,
        'i',
      ).test(id),
    )
    .sort((a, b) => b.id.length - a.id.length)[0];
}
function pick(table: any, opt: any, warnings: string[], tag: string) {
  if (typeof table === 'number') return table;
  if (!table) {
    warnings.push('missing_price:' + tag);
    return 0;
  }
  if (tag === 'per_image' && !('default' in table)) {
    if (!opt.size) {
      warnings.push('missing_param:size');
      return 0;
    }
    if (!opt.quality) {
      warnings.push('missing_param:quality');
      return 0;
    }
  }
  const key = tag === 'per_image' ? `${opt.size}/${opt.quality}` : opt.resolution;
  if (!key && !('default' in table)) {
    warnings.push('missing_param:resolution');
    return 0;
  }
  const n = number(table[key] ?? table.default);
  if (n === undefined) {
    warnings.push('missing_price:' + tag);
    return 0;
  }
  return n;
}
function videoSeconds(r: any, request: any, model: string | null) {
  const raw =
    r.seconds ??
    r.duration ??
    request?.duration ??
    request?.durationSeconds ??
    request?.parameters?.durationSeconds;
  const seconds = typeof raw === 'string' && raw.trim() ? Number(raw) : raw;
  // https://ai.google.dev/gemini-api/docs/veo: Veo 3.1 generates 8-second videos by default.
  const duration = number(seconds) ?? (model?.startsWith('veo-') ? 8 : undefined);
  if (duration === undefined) return undefined;
  const count =
    r.generatedVideos?.length ??
    r.generated_videos?.length ??
    request?.parameters?.sampleCount ??
    request?.sampleCount ??
    1;
  return duration * count;
}
export function createLlmPrices(options: Options = {}) {
  if (created) throw Error('Only one createLlmPrices instance is allowed per process');
  created = true;
  const url = options.url ?? DEFAULT_URL,
    urls = [url, ...(options.fallbackUrls ?? [FALLBACK_URL])],
    ttl = options.ttl ?? 21600000;
  let store = options.store,
    doc: CacheDoc | null = null,
    pending: Promise<any> | null = null;
  const emit = (event: string, detail?: unknown) => options.onEvent?.(event, detail);
  const current = () => {
    if (!doc) throw new PricesNotLoadedError();
    return doc;
  };
  const stale = () => !doc || Date.now() - Date.parse(doc.fetched_at) > ttl;
  async function getStore() {
    if (!store)
      throw Error(
        'A PriceStore is required; pass memoryStore() or import fileStore from the /file entry',
      );
    return store;
  }
  async function persist(next: CacheDoc) {
    const s = await getStore();
    const saved = await s.read();
    if (saved && Date.parse(saved.data.generated_at) > Date.parse(next.data.generated_at)) {
      doc = saved;
      return;
    }
    await s.write(next);
    doc = next;
  }
  async function refresh({ force = false }: { force?: boolean } = {}) {
    if (pending) return pending;
    pending = (async () => {
      await getStore();
      if (doc && !force && !stale()) return { status: 'fresh', info: info() };
      const attempted = stamp();
      let error = '';
      for (const target of urls) {
        try {
          const headers: Record<string, string> = {};
          if (doc?.etag) headers['If-None-Match'] = doc.etag;
          const response = await (options.fetch ?? fetch)(target, { headers });
          if (response.status === 304 && doc) {
            await persist({
              ...doc,
              fetched_at: stamp(),
              last_attempt_at: attempted,
              last_error: null,
            });
            emit('not_modified');
            return { status: 'not_modified', info: info() };
          }
          if (!response.ok) throw Error(`HTTP ${response.status}`);
          const next = await response.json();
          if (!valid(next)) {
            emit('rejected', 'invalid_shape');
            return { status: 'rejected', reason: 'invalid_shape', info: info() };
          }
          if (doc && Date.parse(next.generated_at) < Date.parse(doc.data.generated_at)) {
            emit('rejected', 'older_data');
            return { status: 'rejected', reason: 'older_data', info: info() };
          }
          try {
            for (const p of next.providers) {
              if (!p.models.length) throw Error('empty provider');
              for (const m of p.models)
                if (!calcPrice({ input_tokens: 1, output_tokens: 1 }, m.id, { provider: p }))
                  throw Error('invalid SDK data');
            }
          } catch {
            emit('rejected', 'invalid_sdk_data');
            return { status: 'rejected', reason: 'invalid_sdk_data', info: info() };
          }
          if (options.accept && !(await options.accept(next, doc?.data ?? null))) {
            emit('rejected', 'accept_false');
            return { status: 'rejected', reason: 'accept_false', info: info() };
          }
          await persist({
            cache_schema: 1,
            source_url: target,
            fetched_at: stamp(),
            etag: response.headers.get('etag'),
            last_attempt_at: attempted,
            last_error: null,
            data: next,
          });
          emit('updated');
          return { status: 'updated', info: info() };
        } catch (e) {
          error = String(e);
        }
      }
      if (doc) {
        await persist({ ...doc, last_attempt_at: attempted, last_error: error });
        emit('error', error);
        return { status: 'error', info: info() };
      }
      throw Error('Unable to load prices: ' + error);
    })().finally(() => {
      pending = null;
    });
    return pending;
  }
  async function load() {
    const s = await getStore();
    if (!doc) {
      const saved = await s.read();
      if (saved && valid(saved.data)) doc = saved;
    }
    if (!doc) await refresh({ force: true });
    else if (stale() && options.autoRefresh !== false)
      void refresh().catch((e) => emit('error', e));
    return info();
  }
  function info(): Info {
    return {
      version: doc?.data.version ?? null,
      generatedAt: doc?.data.generated_at ?? null,
      fetchedAt: doc?.fetched_at ?? null,
      stale: stale(),
      lastError: doc?.last_error ?? null,
    };
  }
  function calc({
    provider,
    model,
    usage,
    at,
    options: opts = {},
  }: {
    provider: string;
    model: string;
    usage: Record<string, number>;
    at?: Date;
    options?: Record<string, any>;
  }): Cost | null {
    const d = current().data,
      p = d.providers.find((x) => x.id === provider),
      m = p && matchModel(p, model);
    if (!p || !m) return null;
    const clean = { ...usage };
    delete clean.output_images;
    delete clean.output_video_seconds;
    delete clean.web_searches;
    let result;
    for (let attempt = 0; attempt < 16; attempt++) {
      try {
        result = calcPrice(clean, m.id, {
          provider: { ...p, models: [{ ...m, match: { equals: m.id } }] },
          timestamp: at,
        });
        break;
      } catch (error) {
        const key = String(error).match(/Missing usage value for ([a-z_]+_tokens)/)?.[1];
        if (!key || key in clean) throw error;
        clean[key] = 0; // Unknown overlap: zero is the conservative billable split.
      }
    }
    if (!result) return null;
    const warnings: string[] = [];
    if (stale()) warnings.push('stale_data');
    let extra = 0;
    const x = (m as any).x_extra_prices ?? {};
    if (usage.output_images && !usage.output_image_tokens)
      extra += pick(x.per_image, opts, warnings, 'per_image') * usage.output_images;
    if (usage.output_video_seconds)
      extra +=
        pick(x.per_video_second, opts, warnings, 'per_video_second') * usage.output_video_seconds;
    if (usage.web_searches) {
      if (typeof x.web_search === 'number') extra += x.web_search * usage.web_searches;
      else warnings.push('missing_price:web_search');
    }
    if (x.per_video_second !== undefined && !usage.output_video_seconds)
      warnings.push('missing_param:duration');
    if (opts.service_tier && opts.service_tier !== 'default') warnings.push('service_tier_ignored');
    return {
      totalUsd: result.total_price + extra,
      inputUsd: result.input_price,
      outputUsd: result.output_price,
      extraUsd: extra,
      provider,
      model: m.id,
      requestedModel: model,
      usage,
      dataVersion: d.version,
      source: (m as any).x_source ?? 'unknown',
      warnings,
    };
  }
  function extractUsage({ provider, apiFlavor, response, request }: any) {
    const p = current().data.providers.find((x) => x.id === provider);
    if (!p) throw Error('Unknown provider ' + provider);
    const r = response ?? {},
      u = r.usage ?? r.usageMetadata ?? {},
      usage: Record<string, number> = {};
    let model = r.model ?? r.modelVersion ?? request?.model ?? null;
    const set = (k: string, v: any) => {
      if (number(v) !== undefined) usage[k] = v;
    };
    if (provider === 'anthropic') {
      set(
        'input_tokens',
        (u.input_tokens ?? 0) +
          (u.cache_creation_input_tokens ?? 0) +
          (u.cache_read_input_tokens ?? 0),
      );
      set('output_tokens', u.output_tokens);
      set('cache_read_tokens', u.cache_read_input_tokens);
      set('cache_write_tokens', u.cache_creation_input_tokens);
      set('web_searches', u.server_tool_use?.web_search_requests);
    } else if (provider === 'google') {
      set('input_tokens', (u.promptTokenCount ?? 0) + (u.toolUsePromptTokenCount ?? 0));
      set('output_tokens', (u.candidatesTokenCount ?? 0) + (u.thoughtsTokenCount ?? 0));
      set('cache_read_tokens', u.cachedContentTokenCount);
      if (u.thoughtsTokenCount && model && matchModel(p, model)?.prices?.output_reasoning_mtok)
        set('output_reasoning_tokens', u.thoughtsTokenCount);
      for (const [arr, key, modality] of [
        [u.promptTokensDetails, 'input_image_tokens', 'IMAGE'],
        [u.candidatesTokensDetails, 'output_image_tokens', 'IMAGE'],
        [u.promptTokensDetails, 'input_audio_tokens', 'AUDIO'],
        [u.toolUsePromptTokensDetails, 'input_audio_tokens', 'AUDIO'],
        [u.cacheTokensDetails, 'cache_audio_read_tokens', 'AUDIO'],
        [u.candidatesTokensDetails, 'output_audio_tokens', 'AUDIO'],
      ] as const)
        if (Array.isArray(arr))
          usage[key] =
            (usage[key] ?? 0) +
            arr
              .filter((x: any) => x.modality === modality)
              .reduce((a: number, x: any) => a + (x.tokenCount ?? 0), 0);
      set('output_images', r.generatedImages?.length ?? r.predictions?.length);
      set('output_video_seconds', videoSeconds(r, request, model));
    } else {
      const a = u.prompt_tokens ?? u.input_tokens,
        b = u.completion_tokens ?? u.output_tokens;
      set('input_tokens', a);
      set('output_tokens', b);
      set(
        'cache_read_tokens',
        u.prompt_tokens_details?.cached_tokens ?? u.input_tokens_details?.cached_tokens,
      );
      set(
        'input_audio_tokens',
        u.prompt_tokens_details?.audio_tokens ?? u.input_tokens_details?.audio_tokens,
      );
      set(
        'output_audio_tokens',
        u.completion_tokens_details?.audio_tokens ?? u.output_tokens_details?.audio_tokens,
      );
      set('input_image_tokens', u.input_tokens_details?.image_tokens);
      set('output_image_tokens', u.output_tokens_details?.image_tokens);
      if (model && matchModel(p, model)?.prices?.output_reasoning_mtok)
        set(
          'output_reasoning_tokens',
          u.completion_tokens_details?.reasoning_tokens ??
            u.output_tokens_details?.reasoning_tokens,
        );
      if (provider === 'x-ai') {
        // https://docs.x.ai/developers/tools/tool-usage-details: completion_tokens is final text; reasoning_tokens is separate.
        const reasoning =
          u.completion_tokens_details?.reasoning_tokens ??
          u.output_tokens_details?.reasoning_tokens;
        if (number(reasoning) !== undefined)
          usage.output_tokens = (usage.output_tokens ?? 0) + reasoning;
      }
      if (apiFlavor === 'images' || r.data?.length) {
        set('output_images', r.data?.length ?? request?.n ?? 1);
        model = model ?? request?.model;
      }
      set('output_video_seconds', videoSeconds(r, request, model));
    }
    return { model, usage };
  }
  function fromResponse(args: any) {
    const { model, usage } = extractUsage(args);
    if (!model) return null;
    return calc({
      provider: args.provider,
      model,
      usage,
      at: args.at,
      options: { ...args.request, ...args.response, service_tier: args.response?.service_tier },
    });
  }
  return { load, refresh, info, calc, extractUsage, fromResponse };
}

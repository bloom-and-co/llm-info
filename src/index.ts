import { calculate, findModel, type Model } from './engine.js';
export const DEFAULT_URL =
  'https://raw.githubusercontent.com/bloom-and-co/llm-info/main/data/llm-info.json';
export const FALLBACK_URL =
  'https://cdn.jsdelivr.net/gh/bloom-and-co/llm-info@main/data/llm-info.json';
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
  models: Model[];
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
function valid(data: any): data is PriceData {
  return (
    data?.schema === 2 &&
    typeof data.version === 'string' &&
    Number.isFinite(Date.parse(data.generated_at)) &&
    Array.isArray(data.models) &&
    data.models.every((m: any) => m.provider && m.id && m.prices)
  );
}
function stamp() {
  return new Date().toISOString();
}
function number(x: any): number | undefined {
  return typeof x === 'number' && Number.isFinite(x) ? x : undefined;
}
function usageNumber(x: any): number {
  if (x === undefined || x === null) return 0;
  const parsed = typeof x === 'string' && x.trim() ? Number(x) : x;
  return typeof parsed === 'number' && Number.isFinite(parsed) && parsed >= 0 ? parsed : NaN;
}
function videoSeconds(r: any, request: any, model: string | null) {
  const result = r.operation?.response ?? r.response ?? r;
  const raw =
    result.seconds ??
    result.duration ??
    request?.duration ??
    request?.durationSeconds ??
    request?.config?.durationSeconds ??
    request?.parameters?.durationSeconds;
  const seconds = raw === undefined || raw === null ? undefined : usageNumber(raw);
  // https://ai.google.dev/gemini-api/docs/veo: Veo 3.1 generates 8-second videos by default.
  // https://platform.openai.com/docs/api-reference/videos: Sora default is four seconds.
  const duration =
    number(seconds) ?? (model?.startsWith('veo-') ? 8 : model?.startsWith('sora-') ? 4 : undefined);
  if (duration === undefined) return undefined;
  const count =
    result.generatedVideos?.length ??
    result.generated_videos?.length ??
    result.videos?.length ??
    result.generateVideoResponse?.generatedSamples?.length ??
    request?.config?.numberOfVideos ??
    request?.parameters?.sampleCount ??
    request?.sampleCount ??
    1;
  return duration * usageNumber(count);
}
export function createLlmInfo(options: Options = {}) {
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
  function capabilities({ provider, model }: { provider: string; model: string }) {
    const m = findModel(current().data.models, provider, model);
    return m ? { ...m.capabilities, mode: m.mode } : null;
  }
  function models({ provider }: { provider?: string } = {}) {
    return current()
      .data.models.filter((m) => !provider || m.provider === provider)
      .map((m) => ({ provider: m.provider, id: m.id, mode: m.mode, capabilities: m.capabilities }));
  }
  function calc({
    provider,
    model,
    usage,
    at,
    options: opts = {},
    mode,
    region,
  }: {
    provider: string;
    model: string;
    usage: Record<string, number>;
    at?: Date;
    options?: Record<string, any>;
    mode?: 'standard' | 'fast' | 'priority' | 'flex' | 'batch';
    region?: 'us' | 'eu' | 'global';
  }): Cost | null {
    const d = current().data;
    const m = findModel(d.models, provider, model);
    if (!m) return null;
    const selectedMode = mode ?? opts.mode ?? 'standard';
    const providerModeMultiplier = d.models
      .filter((row) => row.provider === m.provider)
      .reduce((highest, row) => {
        for (const entry of Object.values(row.modes ?? {}) as any[]) {
          highest = Math.max(highest, entry.multiplier ?? 1);
          for (const [key, value] of Object.entries(entry.prices ?? {}))
            if (
              typeof value === 'number' &&
              typeof row.prices[key] === 'number' &&
              row.prices[key] > 0
            )
              highest = Math.max(highest, value / row.prices[key]);
        }
        return highest;
      }, 0);
    const result = calculate(
      m,
      usage,
      { ...opts, providerModeMultiplier },
      selectedMode,
      region ?? 'global',
    );
    if (stale()) result.warnings.push('stale_data');
    return {
      ...result,
      provider,
      model: m.id,
      requestedModel: model,
      usage,
      dataVersion: d.version,
    };
  }
  function extractUsage({ provider, apiFlavor, response, request }: any) {
    provider = provider.toLowerCase();
    const rows = current().data.models.filter((x) => x.provider === provider);
    if (!rows.length) throw Error('Unknown provider ' + provider);
    const r = response ?? {};
    const flavors: Record<string, string> = {
      chat: 'openai-chat',
      responses: 'openai-responses',
      embeddings: 'openai-embeddings',
      images: 'openai-images',
      'xai-chat': 'xai-chat',
      'xai-responses': 'xai-responses',
      'xai-images': 'xai-images',
      'openai-chat': 'openai-chat',
      'openai-responses': 'openai-responses',
      'openai-embeddings': 'openai-embeddings',
      'openai-images': 'openai-images',
      'anthropic-messages': 'anthropic-messages',
      'gemini-generate-content': 'gemini-generate-content',
      'gemini-embed-content': 'gemini-embed-content',
      'gemini-predict': 'gemini-predict',
    };
    if (apiFlavor != null && !flavors[apiFlavor]) throw Error('Unknown apiFlavor: ' + apiFlavor);
    const shape =
      apiFlavor == null
        ? provider === 'anthropic'
          ? 'anthropic-messages'
          : provider === 'google'
            ? 'gemini-generate-content'
            : r.data?.length
              ? provider === 'x-ai'
                ? 'xai-images'
                : 'openai-images'
              : r.object === 'response' || r.usage?.input_tokens != null
                ? provider === 'x-ai'
                  ? 'xai-responses'
                  : 'openai-responses'
                : provider === 'x-ai'
                  ? 'xai-chat'
                  : 'openai-chat'
        : flavors[apiFlavor];
    const openaiShape = shape.startsWith('openai-') || shape.startsWith('xai-');
    const responsesShape = shape === 'openai-responses' || shape === 'xai-responses';
    const imageShape = shape === 'openai-images' || shape === 'xai-images';
    const u = r.usage ?? r.usageMetadata ?? {},
      usage: Record<string, number> = {};
    let model = r.model ?? r.modelVersion ?? request?.model ?? null;
    const set = (k: string, v: any) => {
      if (v !== undefined && v !== null) usage[k] = v;
    };
    const n = usageNumber;
    if (shape === 'anthropic-messages') {
      // https://platform.claude.com/docs/en/build-with-claude/prompt-caching: cache_creation splits writes by TTL;
      // cache_creation_input_tokens is their total, including Vertex/Bedrock Anthropic responses.
      const oneHour = n(u.cache_creation?.ephemeral_1h_input_tokens);
      const fiveMinute =
        u.cache_creation?.ephemeral_5m_input_tokens === undefined
          ? Math.max(0, n(u.cache_creation_input_tokens) - oneHour)
          : n(u.cache_creation.ephemeral_5m_input_tokens);
      const cacheCreation = fiveMinute + oneHour;
      set('input_tokens', n(u.input_tokens) + cacheCreation + n(u.cache_read_input_tokens));
      set('output_tokens', u.output_tokens);
      set('cache_read_tokens', u.cache_read_input_tokens);
      set('cache_write_tokens', fiveMinute);
      set('cache_write_1h_tokens', oneHour);
      set('web_searches', u.server_tool_use?.web_search_requests);
    } else if (shape.startsWith('gemini-')) {
      set('input_tokens', n(u.promptTokenCount) + n(u.toolUsePromptTokenCount));
      set('output_tokens', n(u.candidatesTokenCount) + n(u.thoughtsTokenCount));
      set('cache_read_tokens', u.cachedContentTokenCount);
      if (u.thoughtsTokenCount && model && findModel(rows, provider, model)?.prices?.reasoning)
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
            n(usage[key]) +
            arr
              .filter((x: any) => x.modality === modality)
              .reduce((a: number, x: any) => a + n(x.tokenCount), 0);
      set(
        'output_images',
        r.generatedImages?.length ??
          r.predictions?.length ??
          request?.parameters?.sampleCount ??
          request?.config?.numberOfImages,
      );
      set('output_video_seconds', videoSeconds(r, request, model));
    } else if (openaiShape) {
      const a = responsesShape || imageShape ? u.input_tokens : u.prompt_tokens,
        b = responsesShape || imageShape ? u.output_tokens : u.completion_tokens;
      set('input_tokens', a);
      set('output_tokens', b);
      const inputDetails =
        responsesShape || imageShape ? u.input_tokens_details : u.prompt_tokens_details;
      const outputDetails =
        responsesShape || imageShape ? u.output_tokens_details : u.completion_tokens_details;
      set('cache_read_tokens', inputDetails?.cached_tokens);
      set('cache_write_tokens', inputDetails?.cache_write_tokens);
      set('input_audio_tokens', inputDetails?.audio_tokens);
      set('output_audio_tokens', outputDetails?.audio_tokens);
      set('input_image_tokens', u.input_tokens_details?.image_tokens);
      set('output_image_tokens', u.output_tokens_details?.image_tokens);
      if (model && findModel(rows, provider, model)?.prices?.reasoning)
        set('output_reasoning_tokens', outputDetails?.reasoning_tokens);
      if (shape === 'xai-chat') {
        // https://docs.x.ai/developers/tools/tool-usage-details: completion_tokens is final text; reasoning_tokens is separate.
        const reasoning = outputDetails?.reasoning_tokens;
        if (reasoning !== undefined && reasoning !== null)
          usage.output_tokens = n(usage.output_tokens) + n(reasoning);
      }
      if (imageShape) {
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
    // https://platform.openai.com/docs/api-reference/responses: service_tier reports the tier actually used.
    // https://platform.claude.com/docs/en/build-with-claude/fast-mode: usage.speed reports fast processing.
    const inferredMode =
      args.response?.service_tier === 'priority' || args.response?.service_tier === 'flex'
        ? args.response.service_tier
        : args.response?.usage?.speed === 'fast' || args.response?.speed === 'fast'
          ? 'fast'
          : undefined;
    const result = calc({
      provider: args.provider,
      model,
      usage,
      at: args.at,
      mode: args.mode ?? inferredMode,
      region: args.region,
      options: { ...args.request, ...args.response, service_tier: args.response?.service_tier },
    });
    const reportedUsage = args.response?.usage ?? args.response?.usageMetadata;
    if (
      result &&
      reportedUsage &&
      typeof reportedUsage === 'object' &&
      Object.keys(reportedUsage).length > 0 &&
      usageNumber(usage.input_tokens) === 0 &&
      usageNumber(usage.output_tokens) === 0
    )
      result.warnings.push('usage_not_extracted');
    if (
      result &&
      model.startsWith('sora-') &&
      args.response?.seconds == null &&
      args.response?.duration == null &&
      args.request?.duration == null &&
      args.request?.durationSeconds == null
    )
      result.warnings.push('missing_param:duration');
    return result;
  }
  return { load, refresh, info, capabilities, models, calc, extractUsage, fromResponse };
}

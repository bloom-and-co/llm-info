// Reviewed supplements to upstream data. Add IDs only after checking official docs.
// Exact IDs intentionally exclude unverified aliases and dated variants.
// ElevenLabs: reviewed 2026-10-15 against the official TTS credit descriptions
// and the production usage screen filtered to Hangar's API key (user-supplied evidence).
// API usage consumes subscription credits; USD/credit is account-specific and excluded.
// Observations: STT/alignment 63s -> 28, 8s -> 3.5 credits; isolation 5s -> 83;
// sound effects 1s -> 10 (one observation). Rates below are linear estimates;
// displayed credits may be rounded. The pricing FAQ's product approximations differ.
export const providerRules = [
  {
    id: 'elevenlabs-multilingual-tts',
    provider: 'elevenlabs',
    model_selector: {
      description: 'Reviewed TTS model IDs with subscription credit rates',
      ids: ['eleven_v3', 'eleven_multilingual_v2'],
    },
    effect: {
      supplement: {
        mode: 'audio_speech',
        price_unit: 'credit',
        prices: { per_character: 1 },
        capabilities: { input_modalities: ['text'], output_modalities: ['audio'] },
      },
    },
    source_url: 'https://elevenlabs.io/pricing',
    supporting_urls: ['https://elevenlabs.io/docs/overview/models'],
    checked_at: '2026-10-15',
  },
  {
    id: 'elevenlabs-flash-turbo-tts',
    provider: 'elevenlabs',
    model_selector: {
      description: 'Exact Flash IDs and documented deprecated Turbo equivalents',
      ids: ['eleven_flash_v2', 'eleven_flash_v2_5', 'eleven_turbo_v2', 'eleven_turbo_v2_5'],
    },
    effect: {
      supplement: {
        mode: 'audio_speech',
        price_unit: 'credit',
        prices: { per_character: 0.5 },
        capabilities: { input_modalities: ['text'], output_modalities: ['audio'] },
      },
    },
    source_url: 'https://elevenlabs.io/pricing',
    supporting_urls: ['https://elevenlabs.io/docs/overview/models'],
    checked_at: '2026-10-15',
  },
  {
    id: 'elevenlabs-scribe',
    provider: 'elevenlabs',
    model_selector: {
      description: 'Reviewed Scribe API model IDs',
      ids: ['scribe_v1', 'scribe_v1_experimental', 'scribe_v2'],
    },
    effect: {
      supplement: {
        mode: 'audio_transcription',
        price_unit: 'credit',
        prices: { per_input_audio_second: 4 / 9, per_output_audio_second: 0 },
        capabilities: { input_modalities: ['audio'], output_modalities: ['text'] },
      },
    },
    source_url: 'https://elevenlabs.io/pricing',
    supporting_urls: ['https://elevenlabs.io/docs/overview/models'],
    checked_at: '2026-10-15',
  },
  {
    id: 'elevenlabs-forced-alignment',
    provider: 'elevenlabs',
    model_selector: {
      // This API has no model_id parameter; use its exact endpoint ID as the catalog ID.
      description: 'Endpoint ID forced-alignment (no selectable model)',
      ids: ['forced-alignment'],
    },
    effect: {
      supplement: {
        mode: 'audio_alignment',
        price_unit: 'credit',
        prices: { per_input_audio_second: 4 / 9 },
        capabilities: {
          input_modalities: ['audio', 'text'],
          output_modalities: ['text'],
          endpoints: ['/v1/forced-alignment'],
        },
      },
    },
    source_url: 'https://elevenlabs.io/pricing',
    supporting_urls: [
      'https://elevenlabs.io/docs/overview/capabilities/forced-alignment',
      'https://elevenlabs.io/docs/api-reference/forced-alignment/create',
    ],
    checked_at: '2026-10-15',
  },
  {
    id: 'elevenlabs-sound-effects',
    provider: 'elevenlabs',
    model_selector: {
      description: 'Exact model ID accepted by the sound-generation endpoint',
      ids: ['eleven_text_to_sound_v2'],
    },
    effect: {
      supplement: {
        mode: 'audio_generation',
        price_unit: 'credit',
        prices: { per_output_audio_second: 10 },
        capabilities: {
          input_modalities: ['text'],
          output_modalities: ['audio'],
          endpoints: ['/v1/sound-generation'],
        },
      },
    },
    source_url: 'https://elevenlabs.io/pricing',
    supporting_urls: [
      'https://elevenlabs.io/docs/overview/capabilities/sound-effects',
      'https://elevenlabs.io/docs/api-reference/text-to-sound-effects/convert',
    ],
    checked_at: '2026-10-15',
  },
  {
    id: 'elevenlabs-audio-isolation',
    provider: 'elevenlabs',
    model_selector: {
      description: 'Endpoint ID audio-isolation (no selectable model)',
      ids: ['audio-isolation'],
    },
    effect: {
      supplement: {
        mode: 'audio_isolation',
        price_unit: 'credit',
        prices: { per_input_audio_second: 1000 / 60 },
        capabilities: {
          input_modalities: ['audio'],
          output_modalities: ['audio'],
          endpoints: ['/v1/audio-isolation'],
        },
      },
    },
    source_url: 'https://elevenlabs.io/pricing',
    supporting_urls: [
      'https://elevenlabs.io/docs/overview/capabilities/voice-isolator',
      'https://elevenlabs.io/docs/api-reference/audio-isolation/convert',
    ],
    checked_at: '2026-10-15',
  },
  {
    id: 'xai-priority-processing',
    provider: 'x-ai',
    model_selector: {
      description: 'Text API IDs listed on the official pricing page, reviewed 2026-09-28',
      ids: [
        'grok-4.7',
        'grok-4.6',
        'grok-4.5',
        'grok-4.3',
        'grok-build-0.1',
        'grok-4.20-multi-agent-0309',
        'grok-4.20-0309-reasoning',
        'grok-4.20-0309-non-reasoning',
      ],
    },
    response: { service_tier: 'priority' },
    effect: { mode_token_multiplier: { priority: 2 } },
    source_url: 'https://docs.x.ai/developers/pricing#priority-processing-pricing',
    supporting_urls: ['https://docs.x.ai/developers/advanced-api-usage/priority-processing'],
    checked_at: '2026-09-28',
  },
  {
    id: 'anthropic-us-inference',
    provider: 'anthropic',
    model_selector: {
      description: 'Official Claude API IDs for Claude 4.6 and later, reviewed 2026-09-28',
      ids: [
        'claude-fable-5',
        'claude-fable-5-1',
        'claude-mythos-5',
        'claude-mythos-5-1',
        'claude-opus-4-6',
        'claude-opus-4-7',
        'claude-opus-4-8',
        'claude-opus-5',
        'claude-opus-5-5',
        'claude-sonnet-4-6',
        'claude-sonnet-5',
      ],
    },
    request: { inference_geo: 'us' },
    effect: { region_uplift: { us: 1.1 } },
    source_url: 'https://platform.claude.com/docs/en/build-with-claude/data-residency',
    supporting_urls: [
      'https://platform.claude.com/docs/en/about-claude/pricing',
      'https://platform.claude.com/docs/en/about-claude/models/model-ids-and-versions',
      'https://platform.claude.com/docs/en/models/overview',
      'https://platform.claude.com/docs/en/models/fable-5/overview',
      'https://platform.claude.com/docs/en/models/mythos-5/overview',
      'https://platform.claude.com/docs/en/models/mythos-5-1/overview',
    ],
    checked_at: '2026-09-28',
  },
];

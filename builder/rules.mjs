// Reviewed supplements to upstream data. Add IDs only after checking official docs.
// Exact IDs intentionally exclude unverified aliases and dated variants.
export const providerRules = [
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

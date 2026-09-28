// Reviewed supplements to upstream data. Add IDs only after checking official docs.
// Exact IDs intentionally exclude unverified dated variants and Mythos Preview.
export const providerRules = [
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

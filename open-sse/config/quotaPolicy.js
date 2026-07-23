export const REQUEST_EXECUTION_POLICY = Object.freeze({
  maxAttempts: 16,
  minEndpointIntervalMs: 2000,
});

export const QUOTA_FALLBACK_POLICY = Object.freeze({
  baseCooldownMs: 2000,
  maxCooldownMs: 5 * 60 * 1000,
  maxBackoffLevel: 15,
});

const retryAfter = { header: "retry-after", format: "retry-after", authoritative: true };
const genericResetHints = [
  retryAfter,
  { header: "x-ratelimit-reset-after", format: "delay-seconds" },
  { header: "x-ratelimit-reset", format: "timestamp-or-delay" },
];

export const QUOTA_POLICY_PROFILES = Object.freeze({
  generic: Object.freeze({
    id: "generic",
    pacing: true,
    resetHints: genericResetHints,
    bodyHints: ["common-reset-fields"],
    sources: [],
  }),
  local: Object.freeze({
    id: "local",
    pacing: false,
    resetHints: [retryAfter],
    bodyHints: [],
    sources: [],
  }),
  openai: Object.freeze({
    id: "openai",
    pacing: true,
    resetHints: [
      retryAfter,
      { header: "x-ratelimit-reset-requests", remainingHeader: "x-ratelimit-remaining-requests", format: "delay-seconds" },
      { header: "x-ratelimit-reset-tokens", remainingHeader: "x-ratelimit-remaining-tokens", format: "delay-seconds" },
      { header: "x-ratelimit-reset-project-tokens", remainingHeader: "x-ratelimit-remaining-project-tokens", format: "delay-seconds" },
      { header: "x-ratelimit-reset", format: "timestamp-or-delay" },
    ],
    bodyHints: ["common-reset-fields"],
    sources: ["https://developers.openai.com/api/reference/overview"],
  }),
  "openai-compatible": Object.freeze({
    id: "openai-compatible",
    pacing: true,
    resetHints: [
      retryAfter,
      { header: "x-ratelimit-reset-requests", remainingHeader: "x-ratelimit-remaining-requests", format: "delay-seconds" },
      { header: "x-ratelimit-reset-tokens", remainingHeader: "x-ratelimit-remaining-tokens", format: "delay-seconds" },
      { header: "x-ratelimit-reset", format: "timestamp-or-delay" },
    ],
    bodyHints: ["common-reset-fields"],
    sources: [],
  }),
  "azure-openai": Object.freeze({
    id: "azure-openai",
    pacing: true,
    resetHints: [
      { header: "retry-after-ms", format: "delay-ms", authoritative: true },
      retryAfter,
      { header: "x-ratelimit-reset-requests", remainingHeader: "x-ratelimit-remaining-requests", format: "delay-seconds" },
      { header: "x-ratelimit-reset-tokens", remainingHeader: "x-ratelimit-remaining-tokens", format: "delay-seconds" },
    ],
    bodyHints: ["common-reset-fields"],
    sources: ["https://learn.microsoft.com/azure/ai-foundry/openai/how-to/quota"],
  }),
  anthropic: Object.freeze({
    id: "anthropic",
    pacing: true,
    resetHints: [
      retryAfter,
      { header: "anthropic-ratelimit-requests-reset", remainingHeader: "anthropic-ratelimit-requests-remaining", format: "timestamp" },
      { header: "anthropic-ratelimit-tokens-reset", remainingHeader: "anthropic-ratelimit-tokens-remaining", format: "timestamp" },
      { header: "anthropic-ratelimit-input-tokens-reset", remainingHeader: "anthropic-ratelimit-input-tokens-remaining", format: "timestamp" },
      { header: "anthropic-ratelimit-output-tokens-reset", remainingHeader: "anthropic-ratelimit-output-tokens-remaining", format: "timestamp" },
    ],
    bodyHints: ["common-reset-fields"],
    sources: ["https://platform.claude.com/docs/en/api/rate-limits"],
  }),
  "anthropic-compatible": Object.freeze({
    id: "anthropic-compatible",
    pacing: true,
    resetHints: genericResetHints,
    bodyHints: ["common-reset-fields"],
    sources: [],
  }),
  google: Object.freeze({
    id: "google",
    pacing: true,
    resetHints: [retryAfter],
    bodyHints: ["google-retry-info", "common-reset-fields"],
    sources: [
      "https://ai.google.dev/gemini-api/docs/rate-limits",
      "https://docs.cloud.google.com/java/docs/reference/proto-google-common-protos/latest/com.google.rpc.RetryInfo",
      "https://cloud.google.com/docs/quotas/overview",
    ],
  }),
  github: Object.freeze({
    id: "github",
    pacing: true,
    resetHints: [
      retryAfter,
      { header: "x-ratelimit-reset", remainingHeader: "x-ratelimit-remaining", format: "timestamp" },
    ],
    bodyHints: ["common-reset-fields"],
    sources: ["https://docs.github.com/rest/using-the-rest-api/rate-limits-for-the-rest-api"],
  }),
  openrouter: Object.freeze({
    id: "openrouter",
    pacing: true,
    resetHints: [retryAfter],
    bodyHints: ["common-reset-fields"],
    sources: ["https://openrouter.ai/docs/api_reference/errors-and-debugging"],
  }),
  perplexity: Object.freeze({
    id: "perplexity",
    pacing: true,
    resetHints: [
      retryAfter,
      { header: "x-ratelimit-reset", format: "timestamp-or-delay" },
    ],
    bodyHints: ["common-reset-fields"],
    sources: ["https://docs.perplexity.ai/docs/sdk/performance"],
  }),
  xai: Object.freeze({
    id: "xai",
    pacing: true,
    resetHints: [retryAfter],
    bodyHints: ["common-reset-fields"],
    sources: ["https://docs.x.ai/developers/rate-limits"],
  }),
  groq: Object.freeze({
    id: "groq",
    pacing: true,
    resetHints: [
      retryAfter,
      { header: "x-ratelimit-reset-requests", remainingHeader: "x-ratelimit-remaining-requests", format: "delay-seconds" },
      { header: "x-ratelimit-reset-tokens", remainingHeader: "x-ratelimit-remaining-tokens", format: "delay-seconds" },
    ],
    bodyHints: ["common-reset-fields"],
    sources: ["https://console.groq.com/docs/rate-limits"],
  }),
  cloudflare: Object.freeze({
    id: "cloudflare",
    pacing: true,
    resetHints: [
      retryAfter,
      { header: "ratelimit", format: "structured-delay" },
    ],
    bodyHints: ["common-reset-fields"],
    scheduledReset: Object.freeze({
      errorPattern: /\bdaily(?:[- ]free)?[- ]allocation\b/i,
      schedule: "next-utc-midnight",
    }),
    sources: ["https://developers.cloudflare.com/fundamentals/api/reference/limits/"],
  }),
  cerebras: Object.freeze({
    id: "cerebras",
    pacing: true,
    resetHints: [
      retryAfter,
      { header: "x-ratelimit-reset-requests-day", format: "delay-seconds" },
      { header: "x-ratelimit-reset-tokens-minute", format: "delay-seconds" },
    ],
    bodyHints: ["common-reset-fields"],
    sources: ["https://inference-docs.cerebras.ai/support/rate-limits"],
  }),
  cohere: Object.freeze({
    id: "cohere",
    pacing: true,
    resetHints: [retryAfter],
    bodyHints: ["common-reset-fields"],
    sources: ["https://docs.cohere.com/v2/docs/rate-limits"],
  }),
  deepseek: Object.freeze({
    id: "deepseek",
    pacing: true,
    resetHints: [retryAfter],
    bodyHints: ["common-reset-fields"],
    sources: ["https://api-docs.deepseek.com/quick_start/rate_limit"],
  }),
  elevenlabs: Object.freeze({
    id: "elevenlabs",
    pacing: true,
    resetHints: [retryAfter],
    bodyHints: ["common-reset-fields"],
    sources: ["https://elevenlabs.io/docs/eleven-api/resources/errors"],
  }),
  fireworks: Object.freeze({
    id: "fireworks",
    pacing: true,
    resetHints: [retryAfter],
    bodyHints: ["common-reset-fields"],
    sources: ["https://docs.fireworks.ai/serverless/rate-limits"],
  }),
  huggingface: Object.freeze({
    id: "huggingface",
    pacing: true,
    resetHints: [
      retryAfter,
      { header: "ratelimit", format: "structured-delay" },
    ],
    bodyHints: ["common-reset-fields"],
    sources: ["https://huggingface.co/docs/hub/en/rate-limits"],
  }),
  mistral: Object.freeze({
    id: "mistral",
    pacing: true,
    resetHints: [retryAfter],
    bodyHints: ["common-reset-fields"],
    sources: ["https://docs.mistral.ai/admin/billing-usage/usage-limits"],
  }),
  stability: Object.freeze({
    id: "stability",
    pacing: true,
    resetHints: [retryAfter],
    bodyHints: ["common-reset-fields"],
    fallbackCooldownMs: 60 * 1000,
    sources: ["https://kb.stability.ai/knowledge-base/api-key-rate-limit-information"],
  }),
  together: Object.freeze({
    id: "together",
    pacing: true,
    resetHints: [
      retryAfter,
      { header: "x-ratelimit-reset", format: "timestamp-or-delay" },
      { header: "x-ratelimit-reset-tokens", format: "timestamp-or-delay" },
    ],
    bodyHints: ["common-reset-fields"],
    sources: ["https://docs.together.ai/docs/serverless/rate-limits"],
  }),
});

const PROVIDER_PROFILE_IDS = Object.freeze({
  openai: "openai",
  codex: "openai",
  azure: "azure-openai",
  anthropic: "anthropic",
  claude: "anthropic",
  glm: "anthropic-compatible",
  kimi: "anthropic-compatible",
  "minimax-cn": "anthropic-compatible",
  minimax: "anthropic-compatible",
  antigravity: "google",
  gemini: "google",
  "gemini-cli": "google",
  vertex: "google",
  "vertex-partner": "google",
  "google-pse": "google",
  "google-tts": "google",
  github: "github",
  openrouter: "openrouter",
  perplexity: "perplexity",
  "perplexity-agent": "perplexity",
  "perplexity-web": "perplexity",
  xai: "xai",
  "grok-cli": "xai",
  "grok-web": "xai",
  groq: "groq",
  "cloudflare-ai": "cloudflare",
  cerebras: "cerebras",
  cohere: "cohere",
  deepseek: "deepseek",
  elevenlabs: "elevenlabs",
  fireworks: "fireworks",
  huggingface: "huggingface",
  mistral: "mistral",
  "stability-ai": "stability",
  together: "together",
  comfyui: "local",
  coqui: "local",
  "edge-tts": "local",
  "local-device": "local",
  "ollama-local": "local",
  sdwebui: "local",
  tortoise: "local",
});

export function resolveQuotaPolicyId(provider, transport = null) {
  const providerId = String(provider || "").toLowerCase();
  if (providerId.startsWith("openai-compatible-") || providerId.startsWith("custom-embedding-")) {
    return "openai-compatible";
  }
  if (providerId.startsWith("anthropic-compatible-")) return "anthropic-compatible";
  if (PROVIDER_PROFILE_IDS[providerId]) return PROVIDER_PROFILE_IDS[providerId];

  const format = String(transport?.format || "").toLowerCase();
  if (format === "claude" || format === "anthropic") return "anthropic-compatible";
  if (format.includes("gemini") || format.includes("google")) return "google";
  return "generic";
}

export function resolveQuotaPolicy(provider, transport = null) {
  return QUOTA_POLICY_PROFILES[resolveQuotaPolicyId(provider, transport)] || QUOTA_POLICY_PROFILES.generic;
}

export function buildProviderQuotaPolicies(registry) {
  const policies = {};
  for (const entry of registry || []) {
    if (!entry?.id) continue;
    policies[entry.id] = resolveQuotaPolicy(entry.id, entry.transport);
  }
  return policies;
}

# Quota and Request Execution Policy

9Router applies quota handling automatically. There is no feature flag to enable, and a normal `9router` launch always enables Codex thread affinity.

## Runtime contract

- Starts to the same upstream endpoint are separated by at least 2 seconds. Different endpoints remain independent.
- One logical chat or Codex Responses request can make at most 4 provider endpoint attempts across account retry, provider retry, and combo fallback.
- Media prefetches from a different origin do not consume the provider-attempt budget.
- A Codex thread keeps one persisted model/account binding. Requests for the same thread wait in FIFO order until the original response stream finishes or fails.
- Round-robin selects the initial route only for a new thread. It cannot move an established thread; only an eligible provider failure can rebind it.
- Fusion combos remain rejected for an affinity-bound request because fusion intentionally fans out to multiple models.
- A provider reset timestamp is authoritative when supplied. Otherwise the provider-specific fallback applies, then bounded exponential backoff from 2 seconds to 5 minutes.
- Account/model failure state is persisted in the existing SQLite connection record. Expired locks are reconciled at startup and again during account selection, so accounts become eligible automatically without a process restart or user action.
- Combo planning preserves configured fallback priority or the new-session round-robin cursor, then skips candidates whose provider/model state has evidence of an active lock. The selected account is checked again immediately before executor dispatch; a newly unavailable account is reselected without opening an endpoint or consuming the four-attempt budget.
- Persisted availability is evidence-scoped: explicit provider-wide evidence blocks every active account of that provider; account-wide evidence blocks that account; otherwise the lock is model-scoped. Ambiguous failures fail open and never become quota state. There is no generic combo freshness cache and no inferred provider reset calendar.

The implementation lives in `open-sse/config/quotaPolicy.js`. `PROVIDER_QUOTA_POLICIES` is generated from the live provider registry, so every registered provider receives a policy and new registry entries fall back safely to the generic policy.

## Provider reset evidence

The policy consumes only reset signals documented by a provider or already returned in that provider's error schema. Published plan limits are documentation, not hardcoded runtime timers, because account tier, project, model, and region can change the effective quota.

| Policy family | Registry providers | Reset signal used by 9Router | Official evidence |
| --- | --- | --- | --- |
| OpenAI | `openai`, `codex` | `Retry-After`, request/token reset duration headers, Codex `resets_at` / `resets_in_seconds` | [OpenAI API overview](https://developers.openai.com/api/reference/overview) |
| Azure OpenAI | `azure` | `retry-after-ms`, `Retry-After`, request/token reset headers | [Azure OpenAI quota](https://learn.microsoft.com/azure/ai-foundry/openai/how-to/quota) |
| Anthropic | `anthropic`, `claude` | `Retry-After` and RFC3339 request/token reset headers when present | [Anthropic rate limits](https://platform.claude.com/docs/en/api/rate-limits) |
| Anthropic-compatible schema | `glm`, `kimi`, `minimax-cn`, `minimax`, dynamic `anthropic-compatible-*` | Standard reset hints returned by the actual upstream; Anthropic-specific headers are not assumed from schema compatibility | Provider-owned endpoint contract; no cross-vendor reset schedule is inferred |
| Google | `antigravity`, `gemini-cli`, `gemini`, `google-pse`, `google-tts`, `vertex-partner`, `vertex` | `Retry-After`, `google.rpc.RetryInfo`; daily schedule is not inferred without an error hint | [Gemini limits](https://ai.google.dev/gemini-api/docs/rate-limits), [Google RetryInfo](https://docs.cloud.google.com/java/docs/reference/proto-google-common-protos/latest/com.google.rpc.RetryInfo), [Cloud quotas](https://cloud.google.com/docs/quotas/overview) |
| GitHub | `github` | `Retry-After`, REST epoch reset when exposed by the endpoint | [GitHub REST rate limits](https://docs.github.com/rest/using-the-rest-api/rate-limits-for-the-rest-api) |
| OpenRouter | `openrouter` | `Retry-After` and common response reset fields | [OpenRouter errors](https://openrouter.ai/docs/api_reference/errors-and-debugging) |
| Perplexity | `perplexity`, `perplexity-agent`, `perplexity-web` | `Retry-After`, `X-RateLimit-Reset` as epoch or delay | [Perplexity performance](https://docs.perplexity.ai/docs/sdk/performance) |
| xAI | `xai`, `grok-cli`, `grok-web` | `Retry-After`; otherwise bounded backoff because no universal reset header is documented | [xAI rate limits](https://docs.x.ai/developers/rate-limits) |
| Groq | `groq` | `Retry-After`, request/token reset duration headers | [Groq rate limits](https://console.groq.com/docs/rate-limits) |
| Cloudflare | `cloudflare-ai` | `Retry-After`, structured `RateLimit` delay when exposed | [Cloudflare API limits](https://developers.cloudflare.com/fundamentals/api/reference/limits/), [Workers AI limits](https://developers.cloudflare.com/workers-ai/platform/limits/) |
| Cerebras | `cerebras` | `Retry-After`, request/day and token/minute reset seconds | [Cerebras rate limits](https://inference-docs.cerebras.ai/support/rate-limits) |
| Together | `together` | `Retry-After`, request/token reset headers | [Together rate limits](https://docs.together.ai/docs/serverless/rate-limits) |
| Hugging Face | `huggingface` | `Retry-After`, structured `RateLimit` delay when exposed; routed-inference billing credits are not treated as a timed reset | [Hub rate limits](https://huggingface.co/docs/hub/en/rate-limits), [Inference pricing](https://huggingface.co/docs/inference-providers/en/pricing) |
| Stability AI | `stability-ai` | `Retry-After`; otherwise the documented 60-second 429 timeout | [Stability API limit](https://kb.stability.ai/knowledge-base/api-key-rate-limit-information) |
| Cohere | `cohere` | `Retry-After` if present, otherwise bounded backoff; no public universal reset header | [Cohere rate limits](https://docs.cohere.com/v2/docs/rate-limits) |
| DeepSeek | `deepseek` | `Retry-After` if present, otherwise bounded backoff; no fixed public reset cadence | [DeepSeek rate limit](https://api-docs.deepseek.com/quick_start/rate_limit) |
| Fireworks | `fireworks` | `Retry-After` if present, otherwise bounded backoff because limits are adaptive | [Fireworks rate limits](https://docs.fireworks.ai/serverless/rate-limits) |
| Mistral | `mistral` | `Retry-After` if present, otherwise bounded backoff; workspace spend limits can last until the next billing window | [Mistral usage limits](https://docs.mistral.ai/admin/billing-usage/usage-limits) |
| ElevenLabs | `elevenlabs` | `Retry-After` if present, otherwise bounded backoff; concurrency and credit limits have different scopes | [ElevenLabs errors](https://elevenlabs.io/docs/eleven-api/resources/errors) |
| Local | `comfyui`, `coqui`, `edge-tts`, `local-device`, `ollama-local`, `sdwebui`, `tortoise` | No gateway pacing; local runtime owns capacity | Local endpoint contract |

The remaining 57 registry providers currently use the generic policy: `alicode-intl`, `alicode`, `assemblyai`, `aws-polly`, `black-forest-labs`, `blackbox`, `brave-search`, `byteplus`, `cartesia`, `chutes`, `cline`, `clinepass`, `codebuddy-cn`, `commandcode`, `cursor`, `deepgram`, `exa`, `fal-ai`, `featherless`, `firecrawl`, `gitlab`, `glm-cn`, `hyperbolic`, `iflow`, `inworld`, `jina-ai`, `jina-reader`, `kilocode`, `kimchi`, `kiro`, `linkup`, `mimo-free`, `mmf`, `nanobanana`, `nebius`, `nvidia`, `ollama`, `opencode-go`, `opencode`, `playht`, `qoder`, `qwen`, `recraft`, `runwayml`, `searchapi`, `searxng`, `serper`, `siliconflow`, `tavily`, `topaz`, `venice`, `vercel-ai-gateway`, `volcengine-ark`, `voyage-ai`, `xiaomi-mimo`, `xiaomi-tokenplan`, and `youcom`.

For those providers, 9Router honors standard `Retry-After`, `X-RateLimit-Reset-After`, `X-RateLimit-Reset`, and common reset fields in the error body. If none are present, it records a bounded fallback cooldown instead of guessing a billing or quota reset schedule.

## NVIDIA and Gemini continuity failures

- NVIDIA is retried on the same selected account exactly once only for HTTP `504` responses that explicitly identify `FUNCTION_INVOCATION_TIMEOUT`, and only before output begins. A repeated match creates a short transient endpoint/model cooldown and follows ordinary account then combo fallback. It is never recorded as quota, and opaque provider correlation data is not retained in routing logs.
- Native Gemini tool continuity stores an opaque `thoughtSignature` locally for 30 days, keyed by a hash of the stable client session plus API family, compatible model, emitted tool-call ID, function name, and canonical arguments fingerprint. The token is replayed verbatim only for that exact continuation; it is not exported or logged. On expiry, the token is deleted and only a bounded hash-only tombstone remains long enough to reject unsafe fallback for that old continuation.
- A missing, mismatched, expired, or incompatible Gemini signature is a terminal `gemini_thought_signature_missing` routing error. It does not mutate account health or fall through to another provider. While one is pending, combo preflight permits only a compatible native Gemini candidate.

## Operational visibility

`GET /api/health` reports:

- `threadAffinity: true`;
- active logical requests;
- upstream requests waiting for endpoint pacing;
- rejected attempts after the logical request budget;
- the fixed 2-second endpoint interval and 4-attempt request budget.

No environment edit, dashboard toggle, or manual account re-enable is required.

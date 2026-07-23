---
slug: proactive-quota-combo-provider-fallback
status: planned
intent: clear
review_required: false
pending-action: await explicit start-work request or optional high-accuracy plan review
approach: typed upstream dispositions, request-local eligibility planning, bounded cross-layer retries, and lossless Gemini tool-signature continuity
---

# Draft: proactive-quota-combo-provider-fallback

## Components (topology ledger)

| id | outcome | status | evidence |
|---|---|---|---|
| `routing-disposition` | One classifier distinguishes confirmed quota, transient endpoint failure, protocol-continuity failure, credential failure, and non-retryable failure. | active | `open-sse/config/errorConfig.js`; `open-sse/utils/error.js`; `open-sse/services/accountFallback.js` |
| `provider-eligibility` | Provider/account/model selection bypasses a known unavailable target before any upstream fetch, then rechecks it atomically at credential selection. | active | `src/sse/services/auth.js:448-584`; `src/sse/handlers/chat.js` |
| `combo-candidate-planner` | Combo fallback sees an explicit typed all-accounts-unavailable outcome and advances only to an eligible candidate. | active | `open-sse/services/combo.js:158-186,230+`; `src/sse/handlers/chat.js` |
| `dispatch-budget` | Every real upstream HTTP attempt, including a controlled NVIDIA retry, consumes one global logical-request budget slot. | active | `open-sse/services/requestExecutionState.js`; `docs/QUOTA_POLICY.md` |
| `nvidia-timeout-policy` | NVIDIA `504 FUNCTION_INVOCATION_TIMEOUT` receives a bounded transient-endpoint retry/cooldown, never quota/reset state. | active | `open-sse/providers/registry/nvidia.js`; `open-sse/executors/default.js`; `open-sse/config/errorConfig.js` |
| `gemini-signature-continuity` | Exact Gemini `thought_signature` values survive native/OpenAI bridges and are restored only for the matching tool-call continuation. | active | `open-sse/translator/request/openai-to-gemini.js`; `open-sse/translator/response/gemini-to-openai.js`; `src/app/api/v1beta/models/[...path]/route.js` |
| `observability-and-docs` | Sanitized routing decisions, policy documentation, and focused regression tests make state changes explainable without logging credentials or signatures. | active | `docs/QUOTA_POLICY.md`; `docs/ARCHITECTURE.md`; `tests/unit/*` |

## Open assumptions (announced defaults)

| assumption | proposed default | rationale | reversible? |
|---|---|---|---|
| Known quota state | Persist only evidence-backed quota/reset data; unknown or stale state fails open. | Avoids an unnecessary endpoint call without turning an ambiguous transient failure into a prolonged false block. | yes |
| Combo freshness | Build a request-local filtered candidate list; do not add a 30-minute `combo-fresh-models` cache. | A cache duplicates account state, becomes stale after another request changes quota, and cannot replace the final credential check. | yes |
| Reset timing | Trust provider-supplied reset time when present; otherwise use a bounded policy cooldown, never hard-coded 5-hour/daily provider schedules. | Per-account and per-model windows are not safely inferable from provider name alone. | yes |
| Round robin and affinity | A live session retains its bound combo model; round robin chooses only a new session and rebinds after an eligible failure. | This matches `docs/QUOTA_POLICY.md` and prevents model hopping across tool continuations. The current source/test rotate even pinned sessions, so owner confirmation is required. | yes |
| Global attempt budget | Enforce four actual upstream dispatches per logical request, including retry/account/combo paths. | This is the documented contract; current implementation counts but does not enforce it. | yes |
| Gemini signature retention | Persist opaque signatures locally for the same 30-day session-affinity lifetime, encrypt/redact as existing local state permits, and never log them. | A restart must not silently lose a pending tool continuation. This adds a schema migration and stores opaque provider material. | yes |
| Gemini fallback during tools | Permit only targets explicitly compatible with the same native Gemini signed-part continuation; otherwise return a typed terminal protocol error. | Sending signed Gemini tool history to another format/model family may be invalid and cannot be repaired by account fallback. | yes |

## Findings (cited - path:lines)

- `getProviderModelAvailability` knows only `quota` versus generic `unavailable`, while `markAccountUnavailable` writes all retryable failures, including 5xx, into the same model-lock/account-health mechanism. That conflates durable quota with short endpoint faults. `src/sse/services/auth.js:448-471,680-682`; `open-sse/services/accountFallback.js`.
- The chat provider loop already returns `all_accounts_unavailable` after its account candidates are exhausted, and `handleComboChat` recognizes it as a reason to try the next combo candidate. The missing piece is a common preflight state/disposition contract and consistent classification of the failed account. `src/sse/handlers/chat.js`; `open-sse/services/combo.js:230+`; `open-sse/config/errorConfig.js`.
- Current combo rotation takes place before availability filtering. A request-local planner must first retain its router ordering (priority for fallback, cursor for round robin) and then skip ineligible candidates without consuming an endpoint attempt. `open-sse/services/combo.js:158-186`.
- `docs/QUOTA_POLICY.md` promises a maximum of four dispatches and failure-only rebinding, but `requestExecutionState` currently records rather than rejects excess attempts, and the round-robin test asserts rotation before a pinned model. The implementation and tests need one authoritative contract. `open-sse/services/requestExecutionState.js`; `tests/unit/request-execution-state.test.js`; `tests/unit/combo-routing.test.js`.
- NVIDIA is registered as a generic OpenAI-compatible provider, so its exact `504 FUNCTION_INVOCATION_TIMEOUT` currently follows generic 5xx handling. It must be recognized only when provider, status, and stable error phrase all match; the opaque correlation suffix is not a classifier input. `open-sse/providers/registry/nvidia.js`; `open-sse/executors/default.js`; `open-sse/config/errorConfig.js`.
- NVIDIA documents that 502/503/504 may be transient in deployment readiness paths. That supports a short bounded retry classification, but does not prove the precise upstream cause of the reported production error; sanitized response/header capture remains required for operational confirmation. https://docs.nvidia.com/nim/large-language-models/latest/deployment/csp-deployment/aws.html
- The Gemini request translator currently gives assistant tool calls a static default signature; the Gemini response translator reads an upstream signature but drops it and invents an unstable `tool_call.id`. The next turn cannot therefore reproduce the exact signed function-call part. `open-sse/translator/request/openai-to-gemini.js:140-147`; `open-sse/translator/response/gemini-to-openai.js`.
- Native `/v1beta` conversion reduces Gemini contents to text and loses `functionCall`, `functionResponse`, `thought`, and `thoughtSignature`; this is a direct data-loss path for clients that already supplied valid signed parts. `src/app/api/v1beta/models/[...path]/route.js:386-415`.
- Google requires that all received thought signatures be sent back unchanged; signed and unsigned parts must not be merged or reordered. A missing signature is a protocol-continuity error, not a quota condition. https://ai.google.dev/gemini-api/docs/generate-content/thinking
- Stable session identity is available for Codex and OpenCode only when the client sends a suitable thread/session header. Without one, server-side recovery across a restart is not safe; the client must return the exact signed Gemini part in its own follow-up. `open-sse/utils/threadIdentity.js`; `open-sse/services/threadRouteCoordinator.js`.

## Decisions (with rationale)

1. Introduce a central, pure upstream-failure policy (candidate: `open-sse/services/upstreamFailurePolicy.js`) that returns a typed disposition such as `quota`, `transient_endpoint`, `protocol_continuity`, `no_credentials`, or `non_retryable`, with scope, retry time, source evidence, and retry permission. All account, combo, and error-result paths consume it instead of independently matching strings.
2. Retain current durable account/model state for backward compatibility, but add an explicit disposition/scope rather than three divergent physical lists. Provider-wide unavailability is derived only when all eligible accounts are unavailable or an upstream result explicitly has provider scope. A confirmed quota target is skipped before fetch; a transient endpoint target gets only a short isolated cooldown; protocol errors never poison account health.
3. Replace any proposed durable `combo-fresh-models` cache with a request-local candidate plan. It keeps router ordering, filters state before dispatch, emits a sanitized `skipped_state` event, and performs a final availability check in `getProviderCredentials` to close concurrent-request races.
4. Make all-account exhaustion an explicit provider-layer terminal for that candidate, carrying earliest eligible retry time and disposition. The combo layer consumes it and tries the next eligible model; only after the candidate plan is exhausted does it return `no fallback`.
5. Enforce the documented dispatch budget before a real upstream fetch. Preflight checks do not count; each actual HTTP request does. This prevents account fallback, combo fallback, and NVIDIA retry from multiplying into unbounded traffic.
6. Add a narrow NVIDIA policy: for `provider=nvidia`, HTTP 504, and the literal stable phrase `FUNCTION_INVOCATION_TIMEOUT`, retry the same selected account/model at most once only before any output is exposed. On a second failure, record a short `transient_endpoint` cooldown and allow normal account/combo fallback. Never write quota reset state or match opaque request IDs.
7. Make Gemini signed tool continuity lossless. Preserve client-provided signed parts verbatim (normalizing only field spelling), capture exact upstream signatures on streaming and non-streaming responses, map them to a stable emitted tool-call ID, and retrieve them only for the matching next tool call. Never synthesize a signature for native Gemini continuation.
8. If a required Gemini signature is absent, mismatched, expired, or incompatible with the selected target, return a typed `gemini_thought_signature_missing` routing error (recommended HTTP 400), without account health mutation or account/combo fallback. Do not retry after response streaming starts.
9. Store only sanitized routing metadata in logs: provider, model, hashed connection/session identity, disposition, scope, retry time, and attempt index. Never log API keys, raw signatures, or NVIDIA correlation IDs.

## Scope IN

1. Normalize error classification and eligibility reads across `open-sse/config/errorConfig.js`, `open-sse/utils/error.js`, `open-sse/services/accountFallback.js`, `src/sse/services/auth.js`, and `open-sse/services/combo.js`.
2. Make combo planning state-aware before dispatch and retain a final provider/account eligibility recheck in `src/sse/handlers/chat.js`; preserve typed exhaustion propagation in the auxiliary request handlers already touched by the current branch where required.
3. Enforce shared dispatch budget in `open-sse/services/requestExecutionState.js` and expose a typed budget-exhausted result instead of performing a fifth fetch.
4. Implement the provider-specific NVIDIA timeout disposition and tests around retry, cooldown, account fallback, combo fallback, and the no-quota invariant.
5. Implement Gemini signature continuity across request/response translators, stream/non-stream paths, and native `/v1beta` conversion. Candidate files include `open-sse/translator/index.js`, `open-sse/utils/stream.js`, `open-sse/handlers/chatCore.js`, `open-sse/handlers/chatCore/nonStreamingHandler.js`, and `src/app/api/v1beta/models/[...path]/route.js`.
6. If durable signature retention is approved, add a narrowly scoped SQLite migration/repository under `src/lib/db/migrations/` and `src/lib/db/repos/`, wired into existing session-affinity cleanup semantics.
7. Add focused unit/translator tests plus policy/architecture documentation updates in `docs/QUOTA_POLICY.md` and `docs/ARCHITECTURE.md`.

## Scope OUT (Must NOT have)

- No hard-coded five-hour, daily, or seven-day quota schedule inferred solely from provider name.
- No stale 30-minute `combo-fresh-models` cache, background remote quota sweep at startup, or redundant independent state stores.
- No retry after output/streaming has begun, no retry of a possibly executed tool, and no reuse of a synthetic Gemini signature as if it were provider-issued.
- No account/provider quota marking for the NVIDIA timeout or Gemini protocol-continuity error.
- No dashboard redesign, credential logging, database export of signatures, unrelated refactor, commit, merge, push, or runtime restart in the plan phase.

## Open questions

1. Approve the documented hard cap of **four actual upstream dispatches** per logical request, including NVIDIA retry, account fallback, and combo fallback?
2. Approve **sticky session binding**: round robin selects the first route for a new session, and a bound session rebinds only after an eligible failure? This reverses the current source/test behavior that rotates a pinned session on each request.
3. Approve **local durable 30-day signature retention** for a stable session key, with no raw-signature logs? The alternative is in-memory-only retention and a typed failure after gateway restart.
4. Approve **Gemini-compatible-only fallback** while a tool continuation is pending? This favors protocol correctness over switching to a generic/non-Gemini candidate.
5. Operationally, the repository has `master` but no `main`, and the current task branch has uncommitted changes. If merge is still requested, confirm `master` as target and authorize how the existing implementation should be committed before merging.

## Approval gate
status: approved-and-planned

Owner approval received: four architecture defaults approved; `master` confirmed as the baseline merge target; whole-repository commit authorized. The executable plan is now `.omo/plans/proactive-quota-combo-provider-fallback.md`.

Metis gap-analysis was dispatched twice after plan skeleton creation but the delegated runtime returned only its generic intake prompt both times, without reading the supplied paths. Its review is therefore inconclusive, not a pass; the plan incorporates the primary source-grounded findings recorded above. No high-accuracy review was requested (`review_required: false`).

The next action under plan mode is an explicit start-work request or an optional high-accuracy plan review. Plan approval itself does not authorize implementation.

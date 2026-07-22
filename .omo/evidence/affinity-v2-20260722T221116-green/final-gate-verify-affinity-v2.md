# Final gate: affinity V2 independent review

## Recommendation

**REJECT** — two stated acceptance criteria fail in the current source. No production files or tests were modified by this review.

## Original intent

Implement durable provider-scoped session affinity for Codex and OpenCode: canonical collision-safe identity, provider/model binding separation, persistent strict account rotation, legacy migration, controlled rebinds, TTL expiry, and FIFO request serialization.

## Desired outcome

New sessions rotate A/B/A while repeat requests retain their bound account; same-provider aliases retain the account; other providers remain independent; persistence survives restart/import-export; stale bindings expire after the configured 30-day default; only account-relevant failures rebind.

## User outcome review

The implementation covers most of the requested shape: namespaced hashes, OpenCode header conflict handling, V2 tables/migration/export/import, persistent cursor selection, model/provider split, legacy fallback, and stream-aware per-session lanes. The two blockers below mean it cannot yet claim the full TTL and unrelated-4xx rebind outcomes.

## Blockers

1. **violatedCriterion:** Configurable TTL (30 days by default) must work at startup and lazily for inactive bindings.
   - **evidencePointer:** `open-sse/services/sessionRouteBindings.js:43` retains `cleanedSessions`; `open-sse/services/sessionRouteBindings.js:58` returns immediately after the first cleanup; `open-sse/services/sessionRouteBindings.js:61` records the session forever. A session first read at time `t`, then left idle beyond TTL in a long-lived process, is never cleaned on its later read and keeps its in-memory/database binding. Independent non-writing probe confirmed a single cleanup call at `t=1000` and none at `t=1200` with `ttlMs=100`.
   - **required resolution:** Track a cleanup deadline/last-cleaned timestamp per session (or always issue an idempotent cutoff delete) and test expiration after a binding was created in the same process.

2. **violatedCriterion:** Rebind disabled/deleted/locked/rate-limited/retryable account failures, but do not rebind on unrelated 4xx responses.
   - **evidencePointer:** `open-sse/services/accountFallback.js:27` classifies HTTP 404 as retryable; `open-sse/config/errorConfig.js:87` labels 404 as `model_not_found`; `src/sse/handlers/chat.js:392` through `src/sse/handlers/chat.js:396` unconditionally enables affinity rebind for every `shouldFallback`. Independent non-writing probe returned `checkFallbackError(404, "Model not found") => { shouldFallback: true, cooldownMs: 120000 }`, so a model/route-not-found 404 rotates the account and increments the affinity route epoch.
   - **required resolution:** Add affinity-specific eligibility classification so only account-scoped authentication/quota/availability/retryable transport failures enable rebind; preserve the bound route for a model-not-found/unrelated 4xx. Add an integration regression through `handleSingleModelChat` or its seam.

## Checked artifacts

- Identity and routing: `open-sse/utils/threadIdentity.js`, `open-sse/config/threadAffinityConfig.js`, `open-sse/services/sessionRouteBindings.js`, `open-sse/services/threadRouteCoordinator.js`.
- Chat/auth integration and failure routing: `src/sse/handlers/chat.js`, `src/sse/services/auth.js`, `open-sse/services/accountFallback.js`, `open-sse/services/combo.js`.
- Persistence: `src/lib/db/schema.js`, `src/lib/db/migrate.js`, `src/lib/db/migrations/index.js`, `src/lib/db/migrations/003-session-affinity-v2.js`, `src/lib/db/repos/threadRoutesRepo.js`, `src/lib/db/index.js`, `src/lib/db/sessionAffinityCleanup.js`, `src/lib/localDb.js`.
- Regression/evidence: the baseline `11` tests, red `17 failed | 16 passed`, final focused `63/63`, the recorded scenario, static-check receipts, and current scoped diff. Final focused output uses `node:sqlite` after the optional `better-sqlite3` binding fallback.
- Independent probes (no writes): checked fallback classification for 400/404 and repeated lazy-cleanup behavior; `git diff --check` reports no tracked-diff whitespace errors.

## Positive criteria confirmed by inspection

- Codex `thread-id` takes priority over generic session headers and conflicts with its metadata alias; OpenCode `x-session-affinity` and standalone/matching `x-session-id` normalize to the same namespaced hash while conflicts return HTTP 400. Parent session is not an affinity key.
- New identity keys are SHA-256 namespaced hashes with the exact previous `codex-thread:` hash retained for legacy lookup.
- Model bindings key `(sessionKey, routeAlias)` and connection bindings key `(sessionKey, providerId)`; account cursor updates occur in an adapter transaction and order eligible accounts by priority then ID.
- The chat flow passes the session key to auth only for affinity traffic, prefers a retained eligible connection, preserves sessionless sticky rotation, and holds a per-session lane until a streamed response completes or is cancelled.
- Database migration is additive/versioned, and `exportDb`/`importDb` include all V2 binding/cursor tables.

## Evidence gaps and non-blocking notes

- The deterministic scenario is described as “temporary real SQLite,” but it constructs `createSqlJsAdapter` in `session-affinity-scenario.mjs:4`; that wording is misleading. The broader focused suite separately records `node:sqlite`, so this is an evidence-label issue rather than a third blocker.
- `migrateLegacySessionRouteBinding` is exported from `src/lib/db/repos/threadRoutesRepo.js:179` but the live coordinator duplicates migration behavior instead of calling it. This is remove-ai-slops/dead-path debt, not a stated functional failure.
- Reviewer did not rerun tests because the requested gate forbade fixture-writing tests. The recorded commands support the listed passing claims, but do not cover either blocker scenario.

## Perspective coverage

- **Programming:** Reviewed interface boundaries from HTTP identity to chat/auth routing, DB schema/migration/import-export, adapter transaction semantics, restart behavior, and stream concurrency; no type-system gap was applicable to this JavaScript slice.
- **remove-ai-slops:** Checked new abstractions for duplication, dead exports, misleading evidence labels, and unnecessary surface growth. The unused migration helper is recorded above; no style-only concern changes the recommendation.

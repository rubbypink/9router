# proactive-quota-combo-provider-fallback - Work Plan

## TL;DR (For humans)

**What you'll get:** Requests will avoid endpoints already known to be quota-limited, exhaust provider accounts before moving a combo to its next eligible model, and stop after a bounded number of real upstream attempts. NVIDIA timeout behavior becomes controlled and short-lived; Gemini tool calls retain the exact signature they need across turns and restarts.

**Why this approach:** One shared classification prevents quota, temporary outage, and malformed tool history from being treated as the same failure. Live state is checked twice, once to skip known-bad routes and once immediately before sending, which avoids both waste and stale-cache mistakes.

**What it will NOT do:** It will not guess fixed quota schedules, continuously poll providers, retry after output has started, or log opaque provider metadata. It will not send an active Gemini signed-tool continuation to an incompatible model family.

**Effort:** XL
**Risk:** High - it changes cross-layer routing, persistent session data, retry safety, and provider-format continuity.
**Decisions to sanity-check:** You approved a four-attempt limit, sticky active-session routing, 30-day local Gemini signature retention, and Gemini-compatible-only fallback during tool continuation.

Your next move: explicitly start work, or ask for a high-accuracy plan review first. Full execution detail follows below.

---

> TL;DR (machine): XL/high-risk routing plan: typed quota/transient/protocol state, proactive combo/provider bypass, four-dispatch cap, NVIDIA timeout policy, and durable Gemini signed-tool continuity.

## Scope
### Must have
- Preserve the existing account-level `all_accounts_unavailable` contract, but make its retry disposition and earliest eligible time usable by combo routing.
- Classify confirmed quota, transient endpoint faults, Gemini protocol-continuity errors, missing credentials, and non-retryable errors in one policy consumed by provider and combo layers.
- Proactively skip a model/account/provider only when current persisted state is evidence-backed; perform a final eligibility recheck immediately before an upstream fetch.
- Preserve fallback ordering: priority order for fallback combos, cursor order for round-robin combos; then filter ineligible candidates without dispatching them.
- Enforce four actual upstream dispatches per logical request across NVIDIA retry, account fallback, and combo fallback. Preflight checks do not count.
- Treat NVIDIA `504 FUNCTION_INVOCATION_TIMEOUT` as a provider-specific transient endpoint event: one pre-output retry, short endpoint cooldown after a repeated failure, then normal account/combo fallback; never quota state.
- Preserve and restore Gemini `thoughtSignature` / `thought_signature` verbatim for the exact matching tool-call continuation across native Gemini, OpenAI/Codex translation, streaming, and non-streaming paths.
- Persist Gemini signatures locally for a stable session key for 30 days, remove them through existing cleanup, and never log a raw signature.
- Return a typed terminal Gemini protocol error for missing, mismatched, expired, or incompatible signatures, without account health mutation or account/combo fallback.
- Update focused tests and `docs/QUOTA_POLICY.md` / `docs/ARCHITECTURE.md` to make state, affinity, budget, retry, and failure semantics agree with source.

### Must NOT have (guardrails, anti-slop, scope boundaries)
- Do not infer fixed quota-reset schedules from provider names, add a 30-minute combo cache, or query providers at gateway startup merely to refresh quota.
- Do not retry after response output has started or after a tool could have executed; do not use a synthetic static signature for a native Gemini continuation.
- Do not mark NVIDIA timeout or Gemini signature continuity as account/provider quota.
- Do not send signed Gemini tool history to a non-compatible API family while a continuation is pending.
- Do not log credentials, raw thought signatures, full request bodies, or opaque NVIDIA correlation IDs.
- Do not change dashboard UX, bulk-refactor provider registry, alter unrelated dirty files, commit on `master`, or run a paid/live-provider probe as acceptance evidence.

## Verification strategy
> Zero human intervention - all verification is agent-executed.
- Test decision: TDD with the repository Vitest suite. Each behavior change starts with a passing characterization of preserved behavior, then a failing focused test for the new contract.
- Test runners: from `tests/`, run the exact focused Vitest files named in each Todo; after all focused suites pass, run `node __baseline__/verify-no-regression.mjs`, then root `npx eslint .`. Treat documented baseline failures as baseline only when the baseline verifier accepts them.
- Manual-QA channel: an ephemeral local fake-upstream driver must issue real gateway requests and assert the captured outbound attempts/order without credentials. The executor adds or extends `tests/manual/proactive-routing-smoke.mjs`, runs it as `node tests/manual/proactive-routing-smoke.mjs --scenario scenario-name --evidence .omo/evidence/scenario-name.json`, and removes all child processes/temp data in `finally`.
- Evidence: `.omo/evidence/task-number-proactive-quota-combo-provider-fallback.{log,json}`. Each evidence JSON contains scenario name, sanitized attempts, result code, and cleanup receipt only.
- Dirty-worktree guard: record `git status --short` before every executor wave; preserve all user-owned paths and fail the task if an unrelated path is modified.

## Execution strategy
### Parallel execution waves
> Target 5-8 todos per wave. Fewer than 3 (except the final) means you under-split.

| Wave | Todos | Why this grouping is safe |
|---|---|---|
| 0 | Precondition | Commit and merge the already-authorized baseline first; create a fresh task branch from updated `master` only if the project branch-cap rule permits it. |
| 1 | 1, 5 | Typed routing policy and SQLite signature storage are independent foundations. |
| 2 | 2, 3, 4, 6 | Provider/combo/NVIDIA work depends on policy; Gemini bridges depend on signature storage. They touch disjoint primary files except the shared policy contract, so serialize shared-file edits. |
| 3 | 7 | Cross-layer observability, docs, and integration regression work waits for all behavior changes. |
| final | F1-F4 | Independent verification runs only against the full task-branch diff. |

### Dependency matrix
| Todo | Depends on | Blocks | Can parallelize with |
| --- | --- | --- | --- |
| 1 | Wave 0 | 2, 3, 4, 7 | 5 |
| 2 | 1 | 3, 4, 7 | 5 |
| 3 | 1, 2 | 4, 7 | 5, 6 after shared-contract merge |
| 4 | 1, 2, 3 | 7 | 5, 6 after shared-contract merge |
| 5 | Wave 0 | 6, 7 | 1 |
| 6 | 5 | 7 | 2, 3, 4 after shared-contract merge |
| 7 | 1-6 | F1-F4 | none |

## Todos
> Implementation + Test = ONE todo. Never separate.
- [ ] 1. Normalize upstream failure disposition and durable availability state
  What to do / Must NOT do: Add a small pure policy module (candidate `open-sse/services/upstreamFailurePolicy.js`) that converts parsed upstream result plus provider/model/account context into `{ class, scope, retryAtMs, retryMode, evidence }`. Classes are exactly `quota`, `transient_endpoint`, `protocol_continuity`, `no_credentials`, and `non_retryable`. Update error parsing/config and account fallback writes to preserve the class/scope while retaining legacy `modelLock_*` reads. Store provider-wide unavailability only when the upstream explicitly says provider-wide or every active account is unavailable. Do not hard-code provider reset calendars, write quota state for an unknown failure, or introduce a second independently authoritative state list.
  Parallelization: Wave 1 | Blocked by: Wave 0 baseline | Blocks: 2, 3, 4, 7
  References (executor has NO interview context - be exhaustive): `open-sse/config/errorConfig.js`; `open-sse/utils/error.js`; `open-sse/services/accountFallback.js`; `src/sse/services/auth.js:448-471,537-584,680-682`; `tests/unit/fallback-policy.test.js`; `tests/unit/upstream-error-hints.test.js`; `tests/unit/account-health-state.test.js`.
  Acceptance criteria (agent-executable): First add passing characterizations for existing explicit 429/quota reset and generic 5xx behavior. Then assert: explicit quota with future reset is `quota` and skipped; ambiguous errors fail open; generic 5xx is `transient_endpoint`, not quota; and a protocol error cannot mutate account-health quota data. `cd tests && npx vitest run unit/fallback-policy.test.js unit/upstream-error-hints.test.js unit/account-health-state.test.js` passes.
  QA scenarios (name the exact tool + invocation): Happy: `node tests/manual/proactive-routing-smoke.mjs --scenario classified-known-quota-skip --evidence .omo/evidence/task-1-proactive-quota-combo-provider-fallback.json` records zero fake-upstream calls for the blocked candidate. Failure: run the same driver with `--scenario ambiguous-error-fail-open`; it records exactly one permitted attempt and class `transient_endpoint`, not `quota`. Capture stdout in `.omo/evidence/task-1-proactive-quota-combo-provider-fallback.log`.
  Commit: Y | `fix(routing): classify quota and transient availability state`

- [ ] 2. Make provider account selection proactively state-aware and return typed exhaustion
  What to do / Must NOT do: Change `getProviderModelAvailability`, `getProviderCredentials`, and the chat account loop to consume the normalized policy. Filter confirmed unavailable credentials before dispatch, atomically recheck after locks/exclusions are applied, and when none remain return the existing typed `all_accounts_unavailable` result enriched only with class/scope/earliest retry. Ensure successful terminal responses clear only the selected account/model state. Preserve connection pinning and do not convert a protocol-continuity or routing error into an account retry.
  Parallelization: Wave 2 | Blocked by: 1 | Blocks: 3, 4, 7
  References (executor has NO interview context - be exhaustive): `src/sse/services/auth.js:448-584,680+`; `src/sse/handlers/chat.js`; `open-sse/services/accountFallback.js`; `open-sse/utils/error.js`; `src/sse/handlers/fetch.js`; `src/sse/handlers/imageGeneration.js`; `src/sse/handlers/search.js`; `src/sse/handlers/tts.js`; `tests/unit/account-health-state.test.js`; `tests/unit/session-affinity-chat.test.js`.
  Acceptance criteria (agent-executable): Add a failing-first fixture with two known quota-blocked accounts and one eligible account; assert only the eligible fake endpoint receives a request. Add an all-blocked fixture; assert exactly one typed exhaustion result with earliest retry and zero upstream fetches. Existing pinned-connection behavior remains covered by `session-affinity-chat.test.js`.
  QA scenarios (name the exact tool + invocation): Happy: `node tests/manual/proactive-routing-smoke.mjs --scenario provider-preflight-selects-fresh-account --evidence .omo/evidence/task-2-proactive-quota-combo-provider-fallback.json` captures one call to the fresh account. Failure: `node tests/manual/proactive-routing-smoke.mjs --scenario provider-all-accounts-unavailable --evidence .omo/evidence/task-2-proactive-quota-combo-provider-fallback.json` captures no upstream call and typed exhaustion. Run `cd tests && npx vitest run unit/account-health-state.test.js unit/session-affinity-chat.test.js`.
  Commit: Y | `fix(provider): bypass unavailable accounts before dispatch`

- [ ] 3. Plan combo candidates from live eligibility, enforce affinity, and cap dispatches
  What to do / Must NOT do: In `handleComboChat`, construct a request-local candidate plan that first applies configured fallback priority or round-robin cursor, then filters provider/model availability before dispatch. A stable session keeps its bound model; round robin selects a model only for a new session, and an eligible provider/combo failure permits rebind. Propagate typed all-account exhaustion to the next candidate. Enforce the four-dispatch global budget inside `beforeUpstreamRequest` before a fetch; count every actual endpoint call but not preflight checks. Do not add a durable freshness cache, rotate a pinned tool session every turn, or permit a fifth endpoint call.
  Parallelization: Wave 2 | Blocked by: 1, 2 | Blocks: 4, 7
  References (executor has NO interview context - be exhaustive): `open-sse/services/combo.js:158-186,230+`; `open-sse/services/requestExecutionState.js`; `src/sse/handlers/chat.js`; `open-sse/services/threadRouteCoordinator.js`; `open-sse/utils/threadIdentity.js`; `docs/QUOTA_POLICY.md`; `tests/unit/combo-routing.test.js`; `tests/unit/request-execution-state.test.js`; `tests/unit/session-affinity-chat.test.js`.
  Acceptance criteria (agent-executable): Characterize priority and new-session round-robin ordering before changes. Add failing-first cases proving: blocked first combo candidate receives no request; provider typed exhaustion advances to the next eligible combo model; a pinned session retains its model until eligible failure; and a fifth fake fetch returns a typed `upstream_attempt_budget_exhausted` without opening an endpoint. `cd tests && npx vitest run unit/combo-routing.test.js unit/request-execution-state.test.js unit/session-affinity-chat.test.js` passes.
  QA scenarios (name the exact tool + invocation): Happy: `node tests/manual/proactive-routing-smoke.mjs --scenario combo-skips-exhausted-provider --evidence .omo/evidence/task-3-proactive-quota-combo-provider-fallback.json` records only the second candidate endpoint. Failure: `node tests/manual/proactive-routing-smoke.mjs --scenario dispatch-budget-four --evidence .omo/evidence/task-3-proactive-quota-combo-provider-fallback.json` records four calls and a local typed fifth-attempt rejection. Preserve `git status --short` in the evidence before/after run.
  Commit: Y | `fix(combo): route around unavailable provider candidates`

- [ ] 4. Add the narrow NVIDIA function-invocation-timeout policy
  What to do / Must NOT do: Match only `provider === "nvidia"`, HTTP 504, and literal `FUNCTION_INVOCATION_TIMEOUT` in normalized error text. Before headers/body output has begun, permit exactly one retry to the same selected account/model/endpoint and consume one budget slot for each fetch. On the repeated match, write a short `transient_endpoint` cooldown scoped to that endpoint/model, then use the normal account/combo route. Maintain generic 504 behavior for all other providers/messages. Never use the opaque suffix as a key, infer a reset time, or mark the account/provider quota-limited.
  Parallelization: Wave 2 | Blocked by: 1, 2, 3 | Blocks: 7
  References (executor has NO interview context - be exhaustive): `open-sse/providers/registry/nvidia.js`; `open-sse/executors/default.js`; `open-sse/handlers/chatCore.js`; `open-sse/config/errorConfig.js`; `open-sse/services/requestExecutionState.js`; `open-sse/services/accountFallback.js`; `tests/unit/fallback-policy.test.js`; `tests/unit/combo-routing.test.js`.
  Acceptance criteria (agent-executable): Add a local fake NVIDIA endpoint fixture returning the reported sanitized 504 text twice. Assert first call retries same target once only before output, second failure is `transient_endpoint`, no quota/reset record exists, and the next account/combo candidate is used when budget remains. Assert a generic provider 504 does not trigger the NVIDIA-specific retry. Focused Vitest test(s) pass.
  QA scenarios (name the exact tool + invocation): Happy: `node tests/manual/proactive-routing-smoke.mjs --scenario nvidia-timeout-retry-then-fallback --evidence .omo/evidence/task-4-proactive-quota-combo-provider-fallback.json` records exactly two same-endpoint calls followed by the fallback endpoint. Failure: `node tests/manual/proactive-routing-smoke.mjs --scenario nvidia-timeout-after-stream-start --evidence .omo/evidence/task-4-proactive-quota-combo-provider-fallback.json` records no retry after the driver marks output started. Run the new focused Vitest file from `tests/`.
  Commit: Y | `fix(nvidia): bound function timeout retry and fallback`

- [ ] 5. Add durable, bounded Gemini signature-continuity storage
  What to do / Must NOT do: Add a SQLite migration and repository dedicated to opaque Gemini thought signatures. Key records by a hash of the stable route/session key, native Gemini API family, stable emitted tool-call ID, model compatibility family, function name, and canonical-arguments fingerprint; store signature, observed time, expiry, and last-use time. Set expiry to the approved 30-day session-affinity lifetime and remove records in the existing affinity cleanup transaction/path. Provide exact put/get/delete primitives only; no public API, dashboard surface, cache, raw logging, or custom cryptography. If a request has no stable client session identity, the resolver must report that recovery is unavailable rather than guessing a durable key.
  Parallelization: Wave 1 | Blocked by: Wave 0 baseline | Blocks: 6, 7
  References (executor has NO interview context - be exhaustive): `src/lib/db/schema.js`; `src/lib/db/migrations/`; `src/lib/db/repos/`; `src/lib/db/sessionAffinityCleanup.js`; `src/lib/db/repos/sessionRouteBindings.js`; `open-sse/utils/threadIdentity.js`; `open-sse/services/threadRouteCoordinator.js`; `open-sse/utils/sessionManager.js`.
  Acceptance criteria (agent-executable): Add migration/repository tests proving exact match returns the stored opaque token, a different session/tool/fingerprint cannot read it, expired rows are removed, and cleanup removes signatures with the session retention policy. Test evidence must prove no raw signature appears in emitted log capture.
  QA scenarios (name the exact tool + invocation): Happy: `node tests/manual/proactive-routing-smoke.mjs --scenario gemini-signature-restart-recovery --evidence .omo/evidence/task-5-proactive-quota-combo-provider-fallback.json` stores a synthetic opaque test token, reopens the local DB, and restores only the matching record. Failure: `node tests/manual/proactive-routing-smoke.mjs --scenario gemini-signature-cross-session-denied --evidence .omo/evidence/task-5-proactive-quota-combo-provider-fallback.json` returns no token and reports a typed continuity miss. Run focused DB tests from `tests/`.
  Commit: Y | `feat(gemini): persist thought signature continuity`

- [ ] 6. Preserve Gemini signed parts losslessly and gate incompatible fallback
  What to do / Must NOT do: Replace text-only native Gemini conversion with a lossless bridge that retains `functionCall`, `functionResponse`, `thought`, and both signature spellings. In request translators, preserve a client-supplied native signed function-call part verbatim except field-name normalization; in OpenAI/Codex paths resolve the exact stored token only for the matching stable tool-call ID/fingerprint. In streaming and non-streaming Gemini responses, capture upstream signatures and map to a deterministic emitted tool-call ID: upstream function-call ID when supplied, otherwise a stable session/response-ordinal/function/arguments hash, never `Date.now()`. Carry verified route/session context through translator state. On a required signature miss/mismatch/expiry or target API-family incompatibility, use `createRoutingErrorResult(400, ..., "gemini_thought_signature_missing")`, bypass account health and combo fallback, and retain current Antigravity-only compatibility behavior outside the Gemini provider scope.
  Parallelization: Wave 2 | Blocked by: 5; coordinate shared policy imports with 1 | Blocks: 7
  References (executor has NO interview context - be exhaustive): `open-sse/translator/request/openai-to-gemini.js:49,140-147,234-237`; `open-sse/translator/request/gemini-to-openai.js`; `open-sse/translator/response/gemini-to-openai.js`; `open-sse/translator/index.js:84-87`; `open-sse/utils/stream.js`; `open-sse/handlers/chatCore.js`; `open-sse/handlers/chatCore/nonStreamingHandler.js`; `src/app/api/v1beta/models/[...path]/route.js:386-415`; `open-sse/executors/antigravity.js`; `open-sse/config/defaultThinkingSignature.js`; `open-sse/utils/error.js`; `tests/unit/gemini-native-endpoint.test.js`; `tests/translator/golden-request.test.js`; `tests/translator/golden-response-stream.test.js`; `tests/translator/bugs-gemini-cursor-commandcode.test.js`.
  Acceptance criteria (agent-executable): Add failing-first streaming and non-streaming fixtures containing two function calls with distinct opaque signatures. Assert the next matching tool continuation sends byte-for-byte the original token; native v1beta input retains its signed part; different tool ID/fingerprint or missing stable session returns the typed non-fallback error; no account lock/health mutation occurs; and a pending continuation rejects a non-compatible combo target. Run all listed focused tests.
  QA scenarios (name the exact tool + invocation): Happy: `node tests/manual/proactive-routing-smoke.mjs --scenario gemini-exact-signed-tool-continuation --evidence .omo/evidence/task-6-proactive-quota-combo-provider-fallback.json` captures the exact synthetic token only on the matching second request. Failure: `node tests/manual/proactive-routing-smoke.mjs --scenario gemini-signature-missing-terminal --evidence .omo/evidence/task-6-proactive-quota-combo-provider-fallback.json` captures no fallback endpoint attempt and a `gemini_thought_signature_missing` response. Run focused translator/native-endpoint Vitest files from `tests/`.
  Commit: Y | `fix(gemini): preserve signed tool-call continuity`

- [ ] 7. Lock observability, documentation, and cross-layer regression contracts
  What to do / Must NOT do: Add sanitized structured routing events containing only disposition, scope, provider, model, hashed connection/session identifier, retry time, attempt index, and skip reason. Update quota and architecture docs to state evidence-backed preflight bypass, final credential recheck, four-dispatch budget, session-sticky round robin, typed all-account exhaustion, NVIDIA transient behavior, and Gemini protocol terminal behavior. Consolidate focused regression tests and local fake-upstream smoke scenarios so they prove actual outbound-attempt order and no raw signature/request ID leakage. Do not add dashboard UI, remote provider probes, or tests that assert private implementation internals instead of observable routing outcomes.
  Parallelization: Wave 3 | Blocked by: 1-6 | Blocks: F1-F4
  References (executor has NO interview context - be exhaustive): `docs/QUOTA_POLICY.md`; `docs/ARCHITECTURE.md`; `open-sse/services/requestExecutionState.js`; `open-sse/services/combo.js`; `src/sse/services/auth.js`; `open-sse/translator/*gemini*`; `tests/__baseline__/verify-no-regression.mjs`; `tests/unit/combo-routing.test.js`; `tests/unit/request-execution-state.test.js`; `tests/unit/gemini-native-endpoint.test.js`.
  Acceptance criteria (agent-executable): The local smoke matrix covers known quota skip, all-account combo advance, four-dispatch cap, NVIDIA timeout path, Gemini exact signature replay, and missing-signature terminal behavior. Assertions show no raw test signature/NVIDIA suffix in captured logs. `cd tests && node __baseline__/verify-no-regression.mjs` and root `npx eslint .` pass or report only documented pre-existing baseline failures accepted by the baseline verifier.
  QA scenarios (name the exact tool + invocation): Happy: `node tests/manual/proactive-routing-smoke.mjs --scenario full-routing-matrix --evidence .omo/evidence/task-7-proactive-quota-combo-provider-fallback.json` yields one PASS record per scenario and removes local fake server/temp DB. Failure: `node tests/manual/proactive-routing-smoke.mjs --scenario sensitive-log-sentinel --evidence .omo/evidence/task-7-proactive-quota-combo-provider-fallback.json` fails if a sentinel raw signature or NVIDIA suffix appears. Capture `git diff --check` and `git status --short` in the evidence.
  Commit: Y | `test(routing): cover proactive fallback contracts`

## Final verification wave
> Runs in parallel after ALL todos. ALL must APPROVE. Surface results and wait for the user's explicit okay before declaring complete.
- [ ] F1. Plan compliance audit
  Verify every approved invariant above maps to code and an observable test, all checkbox acceptance criteria are satisfied, dependencies were respected, and no TODO relies on a human action. Command/evidence: `git diff --check`, `git status --short`, task evidence matrix in `.omo/evidence/`, and a checklist stored at `.omo/evidence/f1-plan-compliance.md`. Reject if the branch contains an unplanned behavioral change.
- [ ] F2. Code-quality and migration review
  Independently inspect the final diff for state races, lock cleanup, SQL migration safety, stable-ID collisions, retry-after-stream bugs, stale imports, and secret leakage. Run all focused Vitest files plus `npx eslint .`; save the exact commands/results to `.omo/evidence/f2-code-quality.log`. Reject if any test is weakened or any migration lacks forward-compatible cleanup.
- [ ] F3. Real local routing-manual QA
  Run `node tests/manual/proactive-routing-smoke.mjs --scenario full-routing-matrix --evidence .omo/evidence/f3-real-routing-qa.json` against only the ephemeral fake upstream. Verify the resulting JSON records outbound attempt order, no fifth call, no retry after output start, no Gemini cross-family fallback, and cleanup of all PIDs/temp paths. Reject live paid-provider calls as evidence.
- [ ] F4. Scope and security fidelity review
  Compare `git diff --name-only master...HEAD` against Scope IN/OUT; inspect logs/evidence for raw credentials, signature sentinel, request IDs, or unrelated dashboard/provider changes. Save `.omo/evidence/f4-scope-fidelity.md`. Reject on any raw secret-like value, direct `master` edit, or omitted requested provider behavior.

## Commit strategy

- Baseline integration is separately owner-authorized: stage the current branch's complete worktree, create one conventional commit, and merge it into `master` with a non-destructive merge commit or fast-forward only after targeted tests and `git diff --check` pass.
- Do not implement this plan on `master`. Before Todo 1, count `git branch --no-merged master`; if fewer than three task branches remain, create `codex/proactive-quota-combo-provider-fallback` from updated `master`. If the cap is already reached, stop and ask the owner to select an existing branch to merge/close.
- Keep the implementation commits shown in the todo rows unless a shared-file dependency requires folding adjacent rows into one focused conventional commit. Preserve unrelated changes and never stage a subset when the owner has authorized a whole-repo commit.
- Before asking to merge the implementation task branch, run all final-verification tasks and present their evidence. Merge only with explicit owner authorization.

## Success criteria

- A known quota-limited provider/account/model is not sent an upstream request until its evidence-backed retry time expires or a success clears the state.
- When all accounts of a combo candidate are unavailable, the next eligible combo candidate is attempted; `no fallback` appears only after the entire request-local candidate plan is exhausted.
- The logical request performs no more than four actual upstream dispatches across every retry/fallback layer.
- The exact NVIDIA function-invocation timeout is transient-only, retried once only before output, and never creates quota/reset state.
- Gemini signed function calls round-trip with the same opaque signature and stable ID across stream/non-stream/native bridge paths; invalid continuity is terminal and causes no fallback or health mutation.
- Session affinity is stable for a continuing session, round robin is used for new-session selection, and no raw signature/correlation identifier reaches logs or evidence.
- Focused tests, baseline verifier, lint, local fake-upstream manual QA, and final scope review pass with cleanup receipts.

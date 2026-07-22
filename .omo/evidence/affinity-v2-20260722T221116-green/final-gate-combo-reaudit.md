# Final gate: affinity V2 combo re-audit

## Recommendation

**APPROVE** — the final stated blocker is resolved, and the previous TTL blocker remains resolved. This is a read-only, scope-bounded re-audit of the affinity V2 acceptance criteria and the final combo correction; no production code or tests were changed and no tests were rerun by this reviewer.

## Original intent

Implement durable provider-scoped session affinity for Codex and OpenCode: canonical collision-safe identity, provider/model binding separation, persistent strict account rotation, legacy migration, controlled rebinds, TTL expiry, and FIFO request serialization.

## Desired outcome

New sessions rotate A/B/A while repeat requests retain their bound account; same-provider aliases retain the account; other providers remain independent; persistence survives restart/import-export; stale bindings expire after the configured 30-day default; only account-relevant failures rebind. A model/route-not-found response from a pinned combo model must return that response without advancing the combo, selecting another credential, or rebinding the affinity route.

## User outcome review

The final combo behavior now satisfies the unresolved controlled-rebind criterion. `handleComboChat` awaits the callback and immediately returns the original provider response only for an explicit `false` veto (`open-sse/services/combo.js:338`, `open-sse/services/combo.js:339`). Both chat combo entry points delegate to one affinity-aware guard (`src/sse/handlers/chat.js:153`, `src/sse/handlers/chat.js:243`), which vetoes HTTP 404 for affinity traffic but retains legacy behavior for sessionless traffic (`src/sse/handlers/chat.js:41`). The direct non-affinity-rebind guard remains before account unavailability marking (`src/sse/handlers/chat.js:385`).

The earlier TTL criterion is also satisfied: the cleanup scheduler records a next deadline rather than permanently suppressing later cleanup (`open-sse/services/sessionRouteBindings.js:58`), and its regression proves cached and persisted bindings are removed after the next window (`tests/unit/session-affinity-v2.test.js:279`). The default remains 30 days (`open-sse/config/threadAffinityConfig.js:8`).

## Blockers

- None found.
  - **violatedCriterion:** none.
  - **evidencePointer:** the pinned-combo handler regression returns the original 404 with one credential selection, one core call, and a single bind carrying `allowRebind: false` (`tests/unit/session-affinity-chat.test.js:159`).

## Checked artifacts

- Final source hunk and behavior path: `open-sse/services/combo.js:328`, `src/sse/handlers/chat.js:35`, `src/sse/handlers/chat.js:146`, `src/sse/handlers/chat.js:236`, and `src/sse/handlers/chat.js:383`.
- Unit-level veto and compatibility controls: `tests/unit/combo-routing.test.js:109` and `tests/unit/combo-routing.test.js:138`.
- Full-handler affinity regression: `tests/unit/session-affinity-chat.test.js:159` and its assertions at `tests/unit/session-affinity-chat.test.js:204`.
- TTL recurrence source and regression: `open-sse/services/sessionRouteBindings.js:58`, `tests/unit/session-affinity-v2.test.js:279`, and `open-sse/config/threadAffinityConfig.js:8`.
- Recorded targeted run: `gate-fix/combo-gate-fix/green-regressions.txt:4` reports both relevant files passing; `gate-fix/combo-gate-fix/green-regressions.txt:8` records 15/15 tests. Its source files have modification timestamps no later than the run.
- Recorded expanded run: `gate-fix/combo-gate-fix/focused-suite.txt:1` gives the seven-file command; `gate-fix/combo-gate-fix/focused-suite.txt:40` and `gate-fix/combo-gate-fix/focused-suite.txt:41` record 7/7 files and 79/79 tests. `gate-fix/combo-gate-fix/deterministic-scenario.txt:1` records the independent deterministic scenario pass.
- Scoped worktree/diff: the active branch is `codex/codex-thread-affinity-responses`; the worktree contains the expected affinity V2/release changes, plus unrelated release/health edits outside this final combo blocker.

## Perspective coverage

- **Programming:** Applied the language-boundary, TDD, minimal-surface, and post-write-review perspectives. The change preserves the existing callback contract by treating only `false` as a veto; the regression exercises real `handleChat`, not a callback in isolation. No TypeScript-specific type gate applies to this JavaScript slice.
- **remove-ai-slops:** Checked for needless branching, callback-contract breakage, duplicated status classification, dead-path reliance, and test-only behavior. The small guard reuses the direct-path eligibility predicate and keeps absent callbacks compatible. Existing large-module and broader release/health-diff concerns are style/scope notes, not failures of the stated affinity criteria.

## Evidence gaps and non-blocking notes

- The reviewer did not rerun tests, honoring the read-only/no-fixture-writing constraint. Recorded green evidence is recent and postdates the final combo source change, but it remains recorded evidence rather than a fresh execution by this reviewer.
- The optional `better-sqlite3` native binding is unavailable in the recorded expanded run; that suite explicitly falls back to `node:sqlite` and still passes, so it does not block this acceptance decision.
- This final gate does not certify the unrelated release/health changes present in the broader dirty worktree; they are outside the affinity V2 combo criterion re-audited here.

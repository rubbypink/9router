# Affinity V2 verification receipts

## Scope

- Repository: `/Users/alextran119/Code/9router`
- Branch and preserved worktree state: `final-git-status.txt`
- No browser QA, deployment, live provider request, health API probe, or manifest change was used.

## Red baseline retained

- **Scenario:** Exercise the original affinity implementation before the missing V2 migration and handler integration were completed.
- **Command:** `./node_modules/.bin/vitest run --config tests/vitest.config.js tests/unit/thread-routing.test.js tests/unit/session-affinity-v2.test.js tests/unit/session-affinity-db.test.js tests/unit/session-affinity-auth.test.js`
- **Observable:** `17 failed | 16 passed`; the recorded failures included the absent V2 migration and affinity contract gaps.
- **Artifact:** `../affinity-v2-20260722T215603-red/red-focused-tests.txt`

## Final targeted regression

- **Scenario:** Exercise legacy thread routing, V2 identity/coordinator, real temporary SQLite persistence, session-aware authentication selection, and database export/import together.
- **Command:** `./node_modules/.bin/vitest run --config tests/vitest.config.js tests/unit/thread-routing.test.js tests/unit/session-affinity-v2.test.js tests/unit/session-affinity-db.test.js tests/unit/session-affinity-auth.test.js tests/unit/db-sqlite-vs-lowdb.test.js`
- **Observable:** `5 passed` test files and `63 passed` tests. The DB integration used `node:sqlite`; the unavailable optional `better-sqlite3` binding was logged and did not affect the fallback or test result.
- **Artifact:** `focused-tests-final.txt`

## Deterministic SQLite scenario

- **Scenario:** Create a temporary real SQLite database, apply migrations 002 and 003, then verify strict A/B/A provider cursor rotation, repeated binding, same-provider model routes, provider split, durable restart, availability/retryable rebinding, rejected unqualified rebind with HTTP 409, lazy legacy migration, TTL cleanup of both V2 binding rows, and temporary-directory cleanup.
- **Command:** `./node_modules/.bin/vitest run --config tests/vitest.config.js .omo/evidence/affinity-v2-20260722T221116-green/session-affinity-scenario.test.js`
- **Observable:** `1 passed` test. The emitted `AFFINITY_SCENARIO` payload contains `strictCursor:["account-a","account-b","account-a"]`, epoch `1` on repeated binding, distinct `codex`/`anthropic` connection bindings, both permitted rebind reasons, HTTP `409` for an unqualified rebind, migrated legacy account, and dual-row TTL cleanup. The harness asserts its OS temporary directory no longer exists in `finally`.
- **Artifacts:** `session-affinity-scenario.mjs`, `session-affinity-scenario.test.js`, `session-affinity-scenario-test.txt`

## Database import/export coverage

- **Scenario:** Roundtrip legacy binding plus the V2 model binding, connection binding, and persistent provider cursor through the public database payload.
- **Command:** Included in the final targeted regression above: `tests/unit/db-sqlite-vs-lowdb.test.js` test `exportDb / importDb roundtrip`.
- **Observable:** The snapshot contains all three V2 tables; importing restores both bindings and makes the next provider cursor choice `connection-b`, proving the persisted cursor position survived the roundtrip.
- **Artifact:** `focused-tests-final.txt`

## Static checks

- **Scenario:** Validate changed production JavaScript syntax, whitespace correctness, and new logic file size.
- **Commands:** `node --check` over the 11 changed production affinity files; `git diff --check`; `wc -l open-sse/services/sessionRouteBindings.js open-sse/services/threadRouteCoordinator.js src/lib/db/sessionAffinityCleanup.js src/lib/db/migrations/003-session-affinity-v2.js`.
- **Observable:** All `node --check` invocations passed; `git diff --check` produced no output; all newly introduced logic modules are at or below 250 lines (`234`, `160`, `19`, `19`).
- **Artifacts:** `syntax-check.txt`, `git-diff-check.txt`, `new-logic-loc.txt`

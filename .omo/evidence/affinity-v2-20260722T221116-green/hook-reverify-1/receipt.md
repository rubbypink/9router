# Stop-hook re-verification receipt

- **Execution time:** July 22, 2026, local workspace run.
- **Scenario:** Re-run all targeted affinity V2 regressions after the completion claim.
- **Command:** `./node_modules/.bin/vitest run --config tests/vitest.config.js tests/unit/thread-routing.test.js tests/unit/session-affinity-v2.test.js tests/unit/session-affinity-db.test.js tests/unit/session-affinity-auth.test.js tests/unit/db-sqlite-vs-lowdb.test.js`
- **Observable:** Exit status 0; `5 passed` files and `63 passed` tests. Optional `better-sqlite3` was unavailable, while the successful test run used the logged `node:sqlite` fallback.
- **Artifact:** `focused-tests.txt`

- **Scenario:** Re-run the temporary real-SQLite/in-process affinity verification for cursor rotation, provider bindings, restart, controlled rebinding, 409 guard, legacy migration, TTL cleanup, and temporary-resource cleanup.
- **Command:** `./node_modules/.bin/vitest run --config tests/vitest.config.js .omo/evidence/affinity-v2-20260722T221116-green/session-affinity-scenario.test.js`
- **Observable:** Exit status 0; `1 passed` test; emitted `AFFINITY_SCENARIO` confirms A/B/A, route epoch 1 on repeat binding, provider split, both controlled rebind reasons, HTTP 409 guard, legacy account migration, and dual V2 binding cleanup.
- **Artifact:** `deterministic-scenario.txt`

- **Scenario:** Validate patch whitespace and source parsing.
- **Commands:** `git diff --check` and `node --check` for all modified production affinity files.
- **Observable:** Exit status 0; diff check produced no output; all source files parsed.
- **Artifacts:** `git-diff-check.txt`, `syntax-check.txt`

- **Scenario:** Preserve current branch/worktree context rather than resetting concurrent work.
- **Command:** `git status --short --branch`
- **Observable:** Captured without modifying branch or worktree state.
- **Artifact:** `context.txt`

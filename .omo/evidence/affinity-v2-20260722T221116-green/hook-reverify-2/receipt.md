# Stop-hook re-verification receipt 2

- **Date:** July 22, 2026.
- **Scenario:** Independently rerun targeted Affinity V2 regression coverage.
- **Command:** `./node_modules/.bin/vitest run --config tests/vitest.config.js tests/unit/thread-routing.test.js tests/unit/session-affinity-v2.test.js tests/unit/session-affinity-db.test.js tests/unit/session-affinity-auth.test.js tests/unit/db-sqlite-vs-lowdb.test.js`
- **Observable:** Process exited 0; `5 passed` files and `63 passed` tests. The missing optional `better-sqlite3` native binding fell back to the logged `node:sqlite` driver, and the migration chain applied versions 1 through 3.
- **Artifact:** `focused-tests.txt`

- **Scenario:** Independently rerun the real temporary SQLite affinity behavior receipt.
- **Command:** `./node_modules/.bin/vitest run --config tests/vitest.config.js .omo/evidence/affinity-v2-20260722T221116-green/session-affinity-scenario.test.js`
- **Observable:** Process exited 0; `1 passed` test. `AFFINITY_SCENARIO` recorded strict A/B/A selection, repeat epoch 1, provider split, two permitted rebind reasons, unqualified rebind status 409, legacy binding migration, and TTL cleanup.
- **Artifact:** `deterministic-scenario.txt`

- **Scenario:** Check patch whitespace and production affinity source syntax.
- **Commands:** `git diff --check`; `node --check` on all 11 modified production affinity files.
- **Observable:** Both exited 0; `git diff --check` emitted no output and syntax output confirms every file parsed.
- **Artifacts:** `git-diff-check.txt`, `syntax-check.txt`

- **Scenario:** Capture current branch/worktree state without mutation.
- **Command:** `git status --short --branch`
- **Artifact:** `context.txt`

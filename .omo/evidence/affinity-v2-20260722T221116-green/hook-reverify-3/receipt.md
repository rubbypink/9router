# Stop-hook re-verification receipt 3

- **Date:** Wednesday, July 22, 2026.
- **Scenario:** Fresh full targeted affinity regression.
- **Command:** `./node_modules/.bin/vitest run --config tests/vitest.config.js tests/unit/thread-routing.test.js tests/unit/session-affinity-v2.test.js tests/unit/session-affinity-db.test.js tests/unit/session-affinity-auth.test.js tests/unit/db-sqlite-vs-lowdb.test.js`
- **Judgment basis:** Exit status 0; recorded Vitest footer is `5 passed` files and `63 passed` tests. The optional `better-sqlite3` native binding was unavailable, but the successful execution explicitly selected `node:sqlite` and applied migrations 1, 2, and 3.
- **Artifact:** `test-runs.txt`

- **Scenario:** Fresh deterministic real SQLite affinity check.
- **Command:** `./node_modules/.bin/vitest run --config tests/vitest.config.js .omo/evidence/affinity-v2-20260722T221116-green/session-affinity-scenario.test.js`
- **Judgment basis:** Exit status 0; recorded footer is `1 passed` test. The emitted scenario demonstrates strict A/B/A selection, repeat route epoch 1, independent provider bindings, controlled availability/retryable rebinds, rejected unqualified rebind status 409, legacy migration, and TTL cleanup.
- **Artifact:** `test-runs.txt`

- **Scenario:** Fresh patch hygiene check.
- **Commands:** `git diff --check`; `node --check` over all modified production affinity files.
- **Judgment basis:** Both exited 0; the recorded diff output is explicitly `<no output>` and source parsing reports success.
- **Artifacts:** `git-diff-check.txt`, `syntax-check.txt`, `context-and-diff.txt`

- **Scenario:** Worktree context capture.
- **Command:** `git status --short --branch`
- **Artifact:** `context-and-diff.txt`

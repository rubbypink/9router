# Stop-hook re-verification 2

- **Focused command:** `./node_modules/.bin/vitest run --config tests/vitest.config.js tests/unit/thread-routing.test.js tests/unit/session-affinity-v2.test.js tests/unit/session-affinity-db.test.js tests/unit/session-affinity-auth.test.js tests/unit/db-sqlite-vs-lowdb.test.js tests/unit/session-affinity-chat.test.js`
- **Output and judgment:** Exit 0; all six files pass with `65/65` tests. Artifact: `focused-suite.txt`.
- **Scenario command:** `./node_modules/.bin/vitest run --config tests/vitest.config.js .omo/evidence/affinity-v2-20260722T221116-green/session-affinity-scenario.test.js`
- **Output and judgment:** Exit 0; the sole scenario test passes and emits the expected durable SQLite/coordinator affinity payload. Artifact: `deterministic-scenario.txt`.
- **Static command:** `node --check` for all changed production modules, `git diff --check`, and `/tmp` affinity-resource scan.
- **Output and judgment:** Exit 0; no parse/whitespace diagnostics and no matching leftover temp directories. Artifact: `static-and-cleanup.txt`.
- **Final judgment:** The corrected TTL cleanup and affinity-only 4xx fallback gate remain green on this second direct rerun.

# Stop-hook re-verification 1

- **Focused command:** `./node_modules/.bin/vitest run --config tests/vitest.config.js tests/unit/thread-routing.test.js tests/unit/session-affinity-v2.test.js tests/unit/session-affinity-db.test.js tests/unit/session-affinity-auth.test.js tests/unit/db-sqlite-vs-lowdb.test.js tests/unit/session-affinity-chat.test.js`
- **Observable:** Exit 0; `6/6` files and `65/65` tests pass. See `focused-suite.txt`.
- **Scenario command:** `./node_modules/.bin/vitest run --config tests/vitest.config.js .omo/evidence/affinity-v2-20260722T221116-green/session-affinity-scenario.test.js`
- **Observable:** Exit 0; `1/1` test passes and emits the SQLite/coordinator affinity scenario. See `deterministic-scenario.txt`.
- **Static command:** `node --check` on each changed production module plus `git diff --check` and temp-resource scan.
- **Observable:** Exit 0; no parse or whitespace diagnostics and no `9router-affinity-*` temp directory remains. See `static-and-cleanup.txt`.
- **Judgment:** The two gate corrections remain green after direct rerun.

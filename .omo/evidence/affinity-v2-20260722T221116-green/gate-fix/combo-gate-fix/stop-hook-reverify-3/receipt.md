# Stop-hook combo re-verification 3

- **Targeted command:** `./node_modules/.bin/vitest run --config tests/vitest.config.js --maxWorkers=1 --no-file-parallelism tests/unit/combo-routing.test.js tests/unit/session-affinity-chat.test.js`
- **Observable / judgment:** Exit 0; `2/2` files and `15/15` tests pass, covering explicit veto, undefined callback compatibility, and a bound combo 404 without rebind. Artifact: `targeted-combo.txt`.
- **Expanded command:** `./node_modules/.bin/vitest run --config tests/vitest.config.js tests/unit/thread-routing.test.js tests/unit/session-affinity-v2.test.js tests/unit/session-affinity-db.test.js tests/unit/session-affinity-auth.test.js tests/unit/db-sqlite-vs-lowdb.test.js tests/unit/session-affinity-chat.test.js tests/unit/combo-routing.test.js`
- **Observable / judgment:** Exit 0; `7/7` files and `79/79` tests pass. Artifact: `expanded-affinity-suite.txt`.
- **Scenario command:** `./node_modules/.bin/vitest run --config tests/vitest.config.js .omo/evidence/affinity-v2-20260722T221116-green/session-affinity-scenario.test.js`
- **Observable / judgment:** Exit 0; `1/1` deterministic SQLite/coordinator scenario passes. Artifact: `deterministic-scenario.txt`.
- **Static command:** `node --check` for all changed production modules, `git diff --check`, and affinity temporary-resource scan.
- **Observable / judgment:** Exit 0; no parse or whitespace diagnostics and no matching temporary directory. Artifact: `static-and-cleanup.txt`.
- **Final judgment:** The combo fallback veto and affinity 4xx guard remain green after independent direct verification.

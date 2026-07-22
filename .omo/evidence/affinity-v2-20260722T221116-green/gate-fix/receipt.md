# Affinity V2 final-gate correction receipt

## Scope

- Branch: `codex/codex-thread-affinity-responses`
- Production files changed for this correction: `open-sse/services/sessionRouteBindings.js`, `open-sse/services/threadRouteCoordinator.js`, and `src/sse/handlers/chat.js`.
- Regression coverage added: `tests/unit/session-affinity-v2.test.js` and `tests/unit/session-affinity-chat.test.js`.
- Unrelated release/health work remains untouched and unstaged.

## Criterion: expired bindings are removed after a later lazy-read window

- **Scenario:** A fake-clock coordinator cleans at `t=1000`, binds and reads a route, skips cleanup at `t=1050` inside `ttlMs=100`, then reads at `t=1101` after expiry. The store deletes persisted model and connection rows and reports the deletion counts.
- **Red command:** `./node_modules/.bin/vitest run --config tests/vitest.config.js --maxWorkers=1 --no-file-parallelism tests/unit/session-affinity-v2.test.js tests/unit/session-affinity-chat.test.js`
- **Red observable:** The pre-fix read returned the cached binding instead of `null`; `red-regressions.txt` records this failure.
- **Green command:** Same command after the implementation change.
- **Green observable:** `19/19` targeted tests pass; the fake-clock test confirms cleanup runs once inside the interval, later removes the binding, clears persisted rows, and leaves both cached model/connection lookups `null`.
- **Artifacts:** `red-regressions.txt`, `green-regressions.txt`.

## Criterion: unrelated affinity 404 does not rotate/rebind

- **Scenario:** `handleChat` receives a thread-affinity request bound to one OpenAI connection. Its provider result is `{ success: false, status: 404, errorCode: "model_not_found" }` while generic fallback would allow rotation.
- **Red command:** `./node_modules/.bin/vitest run --config tests/vitest.config.js --maxWorkers=1 --no-file-parallelism tests/unit/session-affinity-v2.test.js tests/unit/session-affinity-chat.test.js`
- **Red observable:** The pre-fix handler returns its generic fallback response rather than the provider 404; the same artifact records this failure.
- **Green command:** Same command after the implementation change.
- **Green observable:** The response remains the original 404, only the bound credential is selected, account-unavailable marking is not invoked, and the coordinator bind call retains `allowRebind: false` and the original route epoch.
- **Artifacts:** `red-regressions.txt`, `green-regressions.txt`.

## Broader verification

- **Scenario:** Full affinity V2 unit slice across routing, V2 bindings, DB persistence, auth selection, SQLite/LowDB parity, and the handler regression.
- **Command:** `./node_modules/.bin/vitest run --config tests/vitest.config.js tests/unit/thread-routing.test.js tests/unit/session-affinity-v2.test.js tests/unit/session-affinity-db.test.js tests/unit/session-affinity-auth.test.js tests/unit/db-sqlite-vs-lowdb.test.js tests/unit/session-affinity-chat.test.js`
- **Observable:** `6/6` files and `65/65` tests pass. The optional `better-sqlite3` native binding is unavailable; the test automatically uses `node:sqlite` and applies migrations `#1` through `#3` successfully.
- **Artifact:** `focused-suite.txt`.

- **Scenario:** Deterministic temporary SQLite plus in-process coordinator scenario.
- **Command:** `./node_modules/.bin/vitest run --config tests/vitest.config.js .omo/evidence/affinity-v2-20260722T221116-green/session-affinity-scenario.test.js`
- **Observable:** `1/1` test passes and emits `AFFINITY_SCENARIO`; it confirms strict A/B/A cursor order, unchanged repeat epoch, provider split, controlled rebind reasons, rejected unqualified rebind, legacy migration, and deletion of both TTL rows.
- **Artifact:** `deterministic-scenario.txt`.

- **Scenario:** Parse, tracked/untracked whitespace, and temporary-resource checks.
- **Command:** Recorded verbatim in `final-static-and-cleanup.txt`.
- **Observable:** `node --check` passes for all three changed production modules, tracked and untracked whitespace checks are clean, and no `9router-affinity-*` temporary directory remains in `/tmp` or `${TMPDIR}`.
- **Artifact:** `final-static-and-cleanup.txt`.

## Setup note

`deterministic-scenario-incorrect-node-run.txt` records a rejected standalone-Node invocation that cannot resolve the repository `@/` alias. The passing `vitest` command above is the established runner and supersedes it; this was a runner setup mismatch, not a product failure.

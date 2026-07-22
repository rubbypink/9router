# Affinity V2 combo-gate correction receipt

## Scope

- Production correction: `open-sse/services/combo.js` treats `onEligibleFallback(...) === false` as an immediate return of the original provider response.
- Affinity correction: both combo callbacks in `src/sse/handlers/chat.js` share the same status allowlist as direct account fallback, vetoing unrelated 4xx without changing `allowRebind` or `rebindReason`.
- Compatibility: an absent or non-false callback return retains legacy combo fallback behavior.

## Criterion: pinned affinity combo 404 does not advance or rebind

- **Scenario:** An affinity request binds `pinned-combo` to `openai/gpt-bound`. That bound model responds with `{ status: 404, errorCode: "model_not_found" }`; a second combo model would return success if reached.
- **Red command:** `./node_modules/.bin/vitest run --config tests/vitest.config.js --maxWorkers=1 --no-file-parallelism tests/unit/combo-routing.test.js tests/unit/session-affinity-chat.test.js`
- **Red observable:** Before the correction, both core and handler regressions returned `200` from the second model instead of the original `404`; no-veto legacy control still passed.
- **Green command:** Same command after the correction.
- **Green observable:** `15/15` tests pass. The handler returns the original pinned-model 404, selects one credential, calls `handleChatCore` once, and records one bind call with `allowRebind: false`.
- **Artifacts:** `red-regressions.txt`, `green-regressions.txt`.

## Criterion: legacy/non-affinity combo fallback remains compatible

- **Scenario:** A pinned combo model returns HTTP 404 with no `onEligibleFallback` callback.
- **Command:** The red/green targeted command above.
- **Observable:** `keeps legacy eligible 404 fallback when no veto callback is supplied` reaches the second model and returns its success response; only an explicit `false` veto changes behavior.
- **Artifacts:** `red-regressions.txt`, `green-regressions.txt`.

## Full verification

- **Scenario:** Expanded affinity slice with routing, bindings, persistence, auth, SQLite/LowDB parity, direct 404 guard, and combo routing.
- **Command:** `./node_modules/.bin/vitest run --config tests/vitest.config.js tests/unit/thread-routing.test.js tests/unit/session-affinity-v2.test.js tests/unit/session-affinity-db.test.js tests/unit/session-affinity-auth.test.js tests/unit/db-sqlite-vs-lowdb.test.js tests/unit/session-affinity-chat.test.js tests/unit/combo-routing.test.js`
- **Observable:** Exit 0; `7/7` files and `79/79` tests pass. Optional `better-sqlite3` binding is unavailable; the test uses `node:sqlite` and applies migrations `#1` through `#3`.
- **Artifact:** `focused-suite.txt`.

- **Scenario:** Deterministic temporary SQLite plus in-process coordinator V2 scenario.
- **Command:** `./node_modules/.bin/vitest run --config tests/vitest.config.js .omo/evidence/affinity-v2-20260722T221116-green/session-affinity-scenario.test.js`
- **Observable:** Exit 0; `1/1` test passes and emits strict cursor order, stable route epoch, controlled rebinds, rejected unqualified rebind, legacy migration, and TTL row cleanup.
- **Artifact:** `deterministic-scenario.txt`.

- **Scenario:** Parse, tracked/untracked whitespace, and temporary-resource checks.
- **Command:** Recorded in `static-and-cleanup.txt` and `untracked-whitespace-checks.txt`.
- **Observable:** All changed production modules pass `node --check`; tracked and untracked whitespace checks pass; no `9router-affinity-*` directory remains in `/tmp`.
- **Artifacts:** `static-and-cleanup.txt`, `untracked-whitespace-checks.txt`.

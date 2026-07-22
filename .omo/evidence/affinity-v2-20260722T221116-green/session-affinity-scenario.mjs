import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createSqlJsAdapter } from "../../../src/lib/db/adapters/sqljsAdapter.js";
import legacyMigration from "../../../src/lib/db/migrations/002-thread-route-bindings.js";
import sessionAffinityMigration from "../../../src/lib/db/migrations/003-session-affinity-v2.js";
import * as repo from "../../../src/lib/db/repos/threadRoutesRepo.js";
import { ThreadRouteCoordinator } from "../../../open-sse/services/threadRouteCoordinator.js";

function route(providerId, model, connectionId) {
  return { providerId, model, resolvedModel: model, connectionId };
}

function createStore() {
  return {
    getSessionModelBinding: repo.getSessionModelBinding,
    upsertSessionModelBinding: repo.upsertSessionModelBinding,
    getSessionConnectionBinding: repo.getSessionConnectionBinding,
    upsertSessionConnectionBinding: repo.upsertSessionConnectionBinding,
    getLegacyBinding: repo.getLegacySessionRouteBinding,
    cleanupExpired(sessionKey, cutoff) {
      return repo.cleanupExpiredSessionAffinityBindings({ sessionKey, cutoff });
    },
  };
}

export async function runSessionAffinityScenario() {
  const tempDirectory = fs.mkdtempSync(path.join(os.tmpdir(), "9router-affinity-v2-evidence-"));
  const databasePath = path.join(tempDirectory, "affinity.sqlite");
  let adapter;

  try {
  adapter = await createSqlJsAdapter(databasePath);
  legacyMigration.up(adapter);
  sessionAffinityMigration.up(adapter);
  Object.assign(global._dbAdapter, { instance: adapter, initPromise: null, logged: false });

  const cursorEligible = [
    { id: "account-b", priority: 1 },
    { id: "account-a", priority: 1 },
  ];
  const strictCursor = [
    repo.selectNextSessionAffinityConnection("codex", cursorEligible).id,
    repo.selectNextSessionAffinityConnection("codex", cursorEligible).id,
    repo.selectNextSessionAffinityConnection("codex", cursorEligible).id,
  ];
  assert.deepEqual(strictCursor, ["account-a", "account-b", "account-a"]);

  const store = createStore();
  const sessionKey = "a".repeat(64);
  const first = new ThreadRouteCoordinator({ store, now: () => 100 });
  first.bindRoute(sessionKey, "fast", route("codex", "codex/gpt-fast", "account-a"));
  const repeated = first.bindRoute(sessionKey, "fast", route("codex", "codex/gpt-fast", "account-a"));
  assert.equal(repeated.routeEpoch, 1);
  first.bindRoute(sessionKey, "deep", route("codex", "codex/gpt-deep", "account-b"));
  assert.equal(first.getConnectionBinding(sessionKey, "codex").connectionId, "account-a");
  first.bindRoute(sessionKey, "claude", route("anthropic", "anthropic/claude", "account-anthropic"));
  assert.equal(first.getConnectionBinding(sessionKey, "anthropic").connectionId, "account-anthropic");

  const restarted = new ThreadRouteCoordinator({ store, now: () => 200 });
  assert.equal(restarted.getBinding(sessionKey, "fast").connectionId, "account-a");
  const unavailableRebound = restarted.bindRoute(
    sessionKey,
    "fast",
    route("codex", "codex/gpt-fast", "account-b"),
    { allowRebind: true, rebindReason: "bound_connection_unavailable" },
  );
  assert.deepEqual(
    {
      connectionId: unavailableRebound.connectionId,
      routeEpoch: unavailableRebound.routeEpoch,
      rebindReason: unavailableRebound.rebindReason,
    },
    { connectionId: "account-b", routeEpoch: 2, rebindReason: "bound_connection_unavailable" },
  );
  const retryableRebound = restarted.bindRoute(
    sessionKey,
    "fast",
    route("codex", "codex/gpt-fast", "account-c"),
    { allowRebind: true, rebindReason: "retryable_provider_failure" },
  );
  assert.deepEqual(
    {
      connectionId: retryableRebound.connectionId,
      routeEpoch: retryableRebound.routeEpoch,
      rebindReason: retryableRebound.rebindReason,
    },
    { connectionId: "account-c", routeEpoch: 3, rebindReason: "retryable_provider_failure" },
  );
  assert.throws(
    () => restarted.bindRoute(sessionKey, "fast", route("codex", "codex/gpt-fast", "account-d")),
    (error) => error?.code === "thread_route_rebind_not_allowed" && error?.status === 409,
  );

  const legacySessionKey = "l".repeat(64);
  repo.upsertThreadRouteBinding(legacySessionKey, {
    requestedModel: "legacy",
    model: "codex/gpt-legacy",
    resolvedModel: "codex/gpt-legacy",
    connectionId: "account-legacy",
    routeEpoch: 4,
    assignedAt: 10,
    lastRoutedAt: 20,
    lastSuccessAt: 30,
  });
  const migratedSessionKey = "m".repeat(64);
  const migrated = new ThreadRouteCoordinator({ store, now: () => 300 })
    .getBinding(migratedSessionKey, "legacy", { legacySessionKey });
  assert.deepEqual(
    { connectionId: migrated.connectionId, routeEpoch: migrated.routeEpoch },
    { connectionId: "account-legacy", routeEpoch: 4 },
  );
  assert.equal(repo.getSessionModelBinding(migratedSessionKey, "legacy").model, "codex/gpt-legacy");

  const staleSessionKey = "s".repeat(64);
  const stale = new ThreadRouteCoordinator({ store, ttlMs: 100, now: () => 0 });
  stale.bindRoute(staleSessionKey, "fast", route("codex", "codex/gpt-stale", "account-stale"));
  const afterTtl = new ThreadRouteCoordinator({ store, ttlMs: 100, now: () => 1_000 });
  assert.equal(afterTtl.getBinding(staleSessionKey, "fast"), null);
  assert.equal(repo.getSessionModelBinding(staleSessionKey, "fast"), null);
  assert.equal(repo.getSessionConnectionBinding(staleSessionKey, "codex"), null);

    return {
      scenario: "temporary real SQLite + in-process coordinator",
      strictCursor,
      repeatedRouteEpoch: repeated.routeEpoch,
      sameProviderConnection: first.getConnectionBinding(sessionKey, "codex").connectionId,
      providerSplit: {
        codex: first.getConnectionBinding(sessionKey, "codex").connectionId,
        anthropic: first.getConnectionBinding(sessionKey, "anthropic").connectionId,
      },
      restartBinding: "account-a",
      rebinds: [unavailableRebound.rebindReason, retryableRebound.rebindReason],
      protectedRebindStatus: 409,
      legacyMigrationConnection: migrated.connectionId,
      ttlCleanup: "removed both session binding rows",
    };
  } finally {
    try { adapter?.close(); } catch {}
    delete globalThis._dbAdapter;
    fs.rmSync(tempDirectory, { recursive: true, force: true });
    if (fs.existsSync(tempDirectory)) {
      throw new Error(`Temporary evidence directory was not removed: ${tempDirectory}`);
    }
  }
}

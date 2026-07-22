import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createSqlJsAdapter } from "../../src/lib/db/adapters/sqljsAdapter.js";
import legacyMigration from "../../src/lib/db/migrations/002-thread-route-bindings.js";
import sessionAffinityMigration from "../../src/lib/db/migrations/003-session-affinity-v2.js";

let adapter;
let repo;
let tempDir;

beforeEach(async () => {
  tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "9router-session-affinity-"));
  adapter = await createSqlJsAdapter(path.join(tempDir, "affinity.sqlite"));
  legacyMigration.up(adapter);
  sessionAffinityMigration.up(adapter);
  global._dbAdapter = { instance: adapter, initPromise: null, logged: false };
  vi.resetModules();
  repo = await import("../../src/lib/db/repos/threadRoutesRepo.js");
});

afterEach(() => {
  try { adapter?.close(); } catch {}
  delete global._dbAdapter;
  fs.rmSync(tempDir, { recursive: true, force: true });
});

const modelBinding = (overrides = {}) => ({
  routeAlias: "fast",
  model: "codex/gpt-fast",
  resolvedModel: "codex/gpt-fast",
  providerId: "codex",
  routeEpoch: 1,
  assignedAt: 10,
  lastRoutedAt: 20,
  lastSuccessAt: null,
  rebindReason: null,
  ...overrides,
});

const connectionBinding = (overrides = {}) => ({
  providerId: "codex",
  connectionId: "account-a",
  routeEpoch: 1,
  assignedAt: 10,
  lastRoutedAt: 20,
  lastSuccessAt: null,
  rebindReason: null,
  ...overrides,
});

describe("session affinity v2 SQLite persistence", () => {
  it("creates model, connection, and cursor tables without removing legacy bindings", () => {
    const tables = adapter.all("SELECT name FROM sqlite_master WHERE type = 'table'").map((row) => row.name);

    expect(tables).toEqual(expect.arrayContaining([
      "threadRouteBindings",
      "sessionModelBindings",
      "sessionConnectionBindings",
      "providerRoundRobinCursors",
    ]));
  });

  it("persists model bindings by session key and route alias", () => {
    repo.upsertSessionModelBinding("session-a", modelBinding());
    repo.upsertSessionModelBinding("session-a", modelBinding({ routeAlias: "deep", model: "codex/gpt-deep" }));

    expect(repo.getSessionModelBinding("session-a", "fast")).toMatchObject({ model: "codex/gpt-fast" });
    expect(repo.getSessionModelBinding("session-a", "deep")).toMatchObject({ model: "codex/gpt-deep" });
  });

  it("persists connection bindings by session key and provider", () => {
    repo.upsertSessionConnectionBinding("session-a", connectionBinding());
    repo.upsertSessionConnectionBinding("session-a", connectionBinding({ providerId: "anthropic", connectionId: "account-b" }));

    expect(repo.getSessionConnectionBinding("session-a", "codex")).toMatchObject({ connectionId: "account-a" });
    expect(repo.getSessionConnectionBinding("session-a", "anthropic")).toMatchObject({ connectionId: "account-b" });
  });

  it("selects strict A/B/A cursor rotation independent of sticky limits", () => {
    const eligible = [
      { id: "account-b", priority: 1 },
      { id: "account-a", priority: 1 },
    ];

    expect(repo.selectNextSessionAffinityConnection("codex", eligible)).toMatchObject({ id: "account-a" });
    expect(repo.selectNextSessionAffinityConnection("codex", eligible)).toMatchObject({ id: "account-b" });
    expect(repo.selectNextSessionAffinityConnection("codex", eligible)).toMatchObject({ id: "account-a" });
  });

  it("keeps cursor state independent per provider", () => {
    const eligible = [{ id: "account-a", priority: 1 }, { id: "account-b", priority: 2 }];
    repo.selectNextSessionAffinityConnection("codex", eligible);

    expect(repo.selectNextSessionAffinityConnection("anthropic", eligible)).toMatchObject({ id: "account-a" });
    expect(repo.selectNextSessionAffinityConnection("codex", eligible)).toMatchObject({ id: "account-b" });
  });

  it("keeps the persistent cursor after a repository reload", async () => {
    const eligible = [{ id: "account-a", priority: 1 }, { id: "account-b", priority: 2 }];
    repo.selectNextSessionAffinityConnection("codex", eligible);
    vi.resetModules();
    repo = await import("../../src/lib/db/repos/threadRoutesRepo.js");

    expect(repo.selectNextSessionAffinityConnection("codex", eligible)).toMatchObject({ id: "account-b" });
  });

  it("cleans expired model and connection records together", () => {
    repo.upsertSessionModelBinding("stale", modelBinding({ lastRoutedAt: 10 }));
    repo.upsertSessionConnectionBinding("stale", connectionBinding({ lastRoutedAt: 10 }));
    repo.upsertSessionModelBinding("fresh", modelBinding({ lastRoutedAt: 900 }));
    repo.upsertSessionConnectionBinding("fresh", connectionBinding({ lastRoutedAt: 900 }));

    expect(repo.cleanupExpiredSessionAffinityBindings({ now: 1_000, ttlMs: 100 })).toMatchObject({ deleted: 2 });
    expect(repo.getSessionModelBinding("stale", "fast")).toBeNull();
    expect(repo.getSessionConnectionBinding("stale", "codex")).toBeNull();
  });

  it("keeps recent bindings during TTL cleanup", () => {
    repo.upsertSessionModelBinding("fresh", modelBinding({ lastRoutedAt: 900 }));
    repo.upsertSessionConnectionBinding("fresh", connectionBinding({ lastRoutedAt: 900 }));
    repo.cleanupExpiredSessionAffinityBindings({ now: 1_000, ttlMs: 100 });

    expect(repo.getSessionModelBinding("fresh", "fast")).not.toBeNull();
    expect(repo.getSessionConnectionBinding("fresh", "codex")).not.toBeNull();
  });

  it("leaves the legacy route table readable for lazy migration", () => {
    repo.upsertThreadRouteBinding("legacy-key", {
      requestedModel: "fast",
      model: "codex/gpt-fast",
      resolvedModel: "codex/gpt-fast",
      connectionId: "account-legacy",
      routeEpoch: 1,
      assignedAt: 10,
      lastRoutedAt: 20,
      lastSuccessAt: null,
    });

    expect(repo.getThreadRouteBinding("legacy-key")).toMatchObject({ connectionId: "account-legacy" });
  });
});

import { describe, expect, it } from "vitest";
import { resolveThreadIdentity } from "../../open-sse/utils/threadIdentity.js";
import {
  ThreadRouteCoordinator,
  isCodexThreadAffinityEnabled,
} from "../../open-sse/services/threadRouteCoordinator.js";

function makeStore() {
  const models = new Map();
  const connections = new Map();
  const legacy = new Map();
  const cleanupCalls = [];
  const key = (...parts) => parts.join(":");

  return {
    legacy,
    cleanupCalls,
    getSessionModelBinding(sessionKey, routeAlias) {
      return models.get(key(sessionKey, routeAlias)) || null;
    },
    upsertSessionModelBinding(sessionKey, binding) {
      models.set(key(sessionKey, binding.routeAlias), { ...binding });
    },
    getSessionConnectionBinding(sessionKey, providerId) {
      return connections.get(key(sessionKey, providerId)) || null;
    },
    upsertSessionConnectionBinding(sessionKey, binding) {
      connections.set(key(sessionKey, binding.providerId), { ...binding });
    },
    getLegacyBinding(sessionKey) {
      return legacy.get(sessionKey) || null;
    },
    cleanupExpired(sessionKey, cutoff) {
      cleanupCalls.push({ sessionKey, cutoff });
    },
  };
}

function makeExpiringStore() {
  const models = new Map();
  const connections = new Map();
  const cleanupCalls = [];
  const key = (...parts) => parts.join(":");

  return {
    models,
    connections,
    cleanupCalls,
    getSessionModelBinding(sessionKey, routeAlias) {
      return models.get(key(sessionKey, routeAlias)) || null;
    },
    upsertSessionModelBinding(sessionKey, binding) {
      models.set(key(sessionKey, binding.routeAlias), { ...binding });
    },
    getSessionConnectionBinding(sessionKey, providerId) {
      return connections.get(key(sessionKey, providerId)) || null;
    },
    upsertSessionConnectionBinding(sessionKey, binding) {
      connections.set(key(sessionKey, binding.providerId), { ...binding });
    },
    cleanupExpired(sessionKey, cutoff) {
      const prefix = `${sessionKey}:`;
      const modelBindings = [...models.entries()].filter(([entryKey, binding]) => (
        entryKey.startsWith(prefix) && binding.lastRoutedAt < cutoff
      ));
      const connectionBindings = [...connections.entries()].filter(([entryKey, binding]) => (
        entryKey.startsWith(prefix) && binding.lastRoutedAt < cutoff
      ));
      for (const [entryKey] of modelBindings) models.delete(entryKey);
      for (const [entryKey] of connectionBindings) connections.delete(entryKey);
      cleanupCalls.push({ sessionKey, cutoff });
      return {
        deleted: modelBindings.length + connectionBindings.length,
        modelBindings: modelBindings.length,
        connectionBindings: connectionBindings.length,
      };
    },
  };
}

function route({ providerId = "codex", model = "codex/gpt-5", connectionId = "account-a" } = {}) {
  return { providerId, model, resolvedModel: model, connectionId };
}

describe("session affinity v2 identity", () => {
  it("defaults enabled when no affinity environment value is supplied", () => {
    expect(isCodexThreadAffinityEnabled({})).toBe(true);
  });

  it("lets SESSION_AFFINITY_ENABLED override the legacy flag", () => {
    expect(isCodexThreadAffinityEnabled({
      SESSION_AFFINITY_ENABLED: "false",
      CODEX_THREAD_AFFINITY: "true",
    })).toBe(false);
  });

  it("retains CODEX_THREAD_AFFINITY when the v2 flag is absent", () => {
    expect(isCodexThreadAffinityEnabled({ CODEX_THREAD_AFFINITY: "false" })).toBe(false);
  });

  it("namespaces Codex v2 identities while retaining the legacy lookup key", () => {
    const identity = resolveThreadIdentity({ headers: { "thread-id": "thread-a" } });

    expect(identity).toMatchObject({ client: "codex", source: "thread-id" });
    expect(identity.sessionKey).toMatch(/^[a-f0-9]{64}$/);
    expect(identity.legacySessionKey).toMatch(/^[a-f0-9]{64}$/);
    expect(identity.sessionKey).not.toBe(identity.legacySessionKey);
    expect(identity).not.toHaveProperty("rawId");
  });

  it("uses a distinct namespace for OpenCode session affinity", () => {
    const codex = resolveThreadIdentity({ headers: { "thread-id": "same-value" } });
    const opencode = resolveThreadIdentity({ headers: { "x-session-affinity": "same-value" } });

    expect(opencode).toMatchObject({ client: "opencode", source: "x-session-affinity" });
    expect(opencode.sessionKey).not.toBe(codex.sessionKey);
  });

  it("rejects conflicting Codex aliases", () => {
    let error;
    try {
      resolveThreadIdentity({
        headers: { "thread-id": "thread-a" },
        body: { client_metadata: { thread_id: "thread-b" } },
      });
    } catch (caught) {
      error = caught;
    }
    expect(error).toMatchObject({ code: "thread_identity_mismatch", status: 400 });
  });

  it("requires matching OpenCode affinity and session headers", () => {
    let error;
    try {
      resolveThreadIdentity({
        headers: { "x-session-affinity": "session-a", "x-session-id": "session-b" },
      });
    } catch (caught) {
      error = caught;
    }
    expect(error).toMatchObject({ code: "thread_identity_mismatch", status: 400 });
  });

  it("accepts matching OpenCode affinity and session headers", () => {
    expect(resolveThreadIdentity({
      headers: { "x-session-affinity": "session-a", "x-session-id": "session-a" },
    })).toMatchObject({ client: "opencode", source: "x-session-affinity" });
  });

  it("canonicalizes standalone OpenCode session headers to one affinity key", () => {
    const affinity = resolveThreadIdentity({ headers: { "x-session-affinity": "session-a" } });
    const session = resolveThreadIdentity({ headers: { "x-session-id": "session-a" } });

    expect(session).toMatchObject({ client: "opencode", source: "x-session-id" });
    expect(session.sessionKey).toBe(affinity.sessionKey);
    expect(session.legacySessionKey).toBe(affinity.legacySessionKey);
  });

  it("rejects conflicting aliases in the generic legacy session group", () => {
    let error;
    try {
      resolveThreadIdentity({
        headers: { "session-id": "session-a", session_id: "session-b" },
      });
    } catch (caught) {
      error = caught;
    }
    expect(error).toMatchObject({ code: "thread_identity_mismatch", status: 400 });
  });

  it("keeps a parent session diagnostic-only", () => {
    expect(resolveThreadIdentity({ headers: { "x-parent-session-id": "parent" } })).toBeNull();

    const first = resolveThreadIdentity({
      headers: { "x-parent-session-id": "parent", "x-session-affinity": "child-a" },
    });
    const second = resolveThreadIdentity({
      headers: { "x-parent-session-id": "parent", "x-session-affinity": "child-b" },
    });
    expect(first.sessionKey).not.toBe(second.sessionKey);
  });
});

describe("session affinity v2 route coordinator", () => {
  it("keeps account pins isolated between threads", () => {
    const coordinator = new ThreadRouteCoordinator({ store: makeStore() });
    const firstSessionKey = "1".repeat(64);
    const secondSessionKey = "2".repeat(64);

    coordinator.bindRoute(firstSessionKey, "fast", route({ connectionId: "account-a" }));
    coordinator.bindRoute(secondSessionKey, "fast", route({ connectionId: "account-b" }));

    expect(coordinator.getConnectionBinding(firstSessionKey, "codex")).toMatchObject({ connectionId: "account-a" });
    expect(coordinator.getConnectionBinding(secondSessionKey, "codex")).toMatchObject({ connectionId: "account-b" });
  });

  it("stores model choices by route alias while retaining a same-provider connection", () => {
    const coordinator = new ThreadRouteCoordinator({ store: makeStore() });
    const sessionKey = "a".repeat(64);

    coordinator.bindRoute(sessionKey, "fast", route({ model: "codex/gpt-fast", connectionId: "account-a" }));
    coordinator.bindRoute(sessionKey, "deep", route({ model: "codex/gpt-deep", connectionId: "account-b" }));

    expect(coordinator.getRouteModelBinding(sessionKey, "fast")).toMatchObject({ model: "codex/gpt-fast" });
    expect(coordinator.getRouteModelBinding(sessionKey, "deep")).toMatchObject({ model: "codex/gpt-deep" });
    expect(coordinator.getConnectionBinding(sessionKey, "codex")).toMatchObject({ connectionId: "account-a" });
  });

  it("keeps provider connections independent inside one session", () => {
    const coordinator = new ThreadRouteCoordinator({ store: makeStore() });
    const sessionKey = "b".repeat(64);

    coordinator.bindRoute(sessionKey, "codex", route({ connectionId: "account-codex" }));
    coordinator.bindRoute(sessionKey, "claude", route({
      providerId: "anthropic",
      model: "anthropic/claude-sonnet",
      connectionId: "account-anthropic",
    }));

    expect(coordinator.getConnectionBinding(sessionKey, "codex")).toMatchObject({ connectionId: "account-codex" });
    expect(coordinator.getConnectionBinding(sessionKey, "anthropic")).toMatchObject({ connectionId: "account-anthropic" });
  });

  it("increments route epoch and records a controlled rebind reason", () => {
    const coordinator = new ThreadRouteCoordinator({ store: makeStore() });
    const sessionKey = "c".repeat(64);
    coordinator.bindRoute(sessionKey, "fast", route());

    coordinator.bindRoute(sessionKey, "fast", route({ connectionId: "account-b" }), {
      allowRebind: true,
      rebindReason: "retryable_provider_failure",
    });

    expect(coordinator.getBinding(sessionKey, "fast")).toMatchObject({
      connectionId: "account-b",
      routeEpoch: 2,
      rebindReason: "retryable_provider_failure",
    });
  });

  it("does not rebind a route without an eligible reason", () => {
    const coordinator = new ThreadRouteCoordinator({ store: makeStore() });
    const sessionKey = "d".repeat(64);
    coordinator.bindRoute(sessionKey, "fast", route());

    let error;
    try {
      coordinator.bindRoute(sessionKey, "fast", route({ connectionId: "account-b" }));
    } catch (caught) {
      error = caught;
    }
    expect(error).toMatchObject({ code: "thread_route_rebind_not_allowed", status: 409 });
  });

  it("lazily migrates a legacy route without changing its bound account", () => {
    const store = makeStore();
    const coordinator = new ThreadRouteCoordinator({ store });
    const sessionKey = "e".repeat(64);
    const legacySessionKey = "f".repeat(64);
    store.legacy.set(legacySessionKey, {
      requestedModel: "fast",
      model: "codex/gpt-fast",
      resolvedModel: "codex/gpt-fast",
      connectionId: "account-legacy",
      routeEpoch: 4,
      assignedAt: 10,
      lastRoutedAt: 20,
      lastSuccessAt: 30,
    });

    expect(coordinator.getBinding(sessionKey, "fast", { legacySessionKey })).toMatchObject({
      connectionId: "account-legacy",
      routeEpoch: 4,
    });
    expect(coordinator.getConnectionBinding(sessionKey, "codex")).toMatchObject({ connectionId: "account-legacy" });
  });

  it("performs lazy TTL cleanup before reading a session", () => {
    const store = makeStore();
    const coordinator = new ThreadRouteCoordinator({
      store,
      ttlMs: 100,
      now: () => 1_000,
    });

    coordinator.getBinding("g".repeat(64), "fast");

    expect(store.cleanupCalls).toContainEqual({ sessionKey: "g".repeat(64), cutoff: 900 });
  });

  it("expires cached bindings after the next scheduled cleanup window", () => {
    let now = 1_000;
    const store = makeExpiringStore();
    const coordinator = new ThreadRouteCoordinator({
      store,
      ttlMs: 100,
      now: () => now,
    });
    const sessionKey = "h".repeat(64);

    coordinator.getBinding(sessionKey, "fast");
    coordinator.bindRoute(sessionKey, "fast", route());
    expect(coordinator.getBinding(sessionKey, "fast")).toMatchObject({
      connectionId: "account-a",
      routeEpoch: 1,
    });

    now = 1_050;
    expect(coordinator.getBinding(sessionKey, "fast")).toMatchObject({ connectionId: "account-a" });
    expect(store.cleanupCalls).toHaveLength(1);

    now = 1_101;
    expect(coordinator.getBinding(sessionKey, "fast")).toBeNull();
    expect(coordinator.getRouteModelBinding(sessionKey, "fast")).toBeNull();
    expect(coordinator.getConnectionBinding(sessionKey, "codex")).toBeNull();
    expect(store.models.size).toBe(0);
    expect(store.connections.size).toBe(0);
    expect(store.cleanupCalls).toContainEqual({ sessionKey, cutoff: 1_001 });
  });
});

import { describe, expect, it, vi } from "vitest";

vi.mock("../../src/lib/db/repos/threadRoutesRepo.js", () => ({
  getThreadRouteBinding: vi.fn(() => null),
  upsertThreadRouteBinding: vi.fn(),
  getSessionModelBinding: vi.fn(() => null),
  upsertSessionModelBinding: vi.fn(),
  getSessionConnectionBinding: vi.fn(() => null),
  upsertSessionConnectionBinding: vi.fn(),
  getLegacySessionRouteBinding: vi.fn(() => null),
  cleanupExpiredSessionAffinityBindings: vi.fn(),
}));

import { resolveThreadIdentity } from "../../open-sse/utils/threadIdentity.js";
import {
  ThreadRouteCoordinator,
  isCodexThreadAffinityEnabled,
} from "../../open-sse/services/threadRouteCoordinator.js";
import { errorResponse } from "../../open-sse/utils/error.js";

function deferred() {
  let resolve;
  const promise = new Promise((done) => { resolve = done; });
  return { promise, resolve };
}

describe("Codex thread identity", () => {
  it("uses the legacy environment value when the v2 setting is absent", () => {
    expect(isCodexThreadAffinityEnabled({ CODEX_THREAD_AFFINITY: "false" })).toBe(false);
  });

  it("prioritizes thread-id and never merges sibling agents through session-id", () => {
    const shared = { "session-id": "parent-session" };
    const first = resolveThreadIdentity({
      headers: { ...shared, "thread-id": "child-a", "x-client-request-id": "child-a" },
      body: {},
    });
    const second = resolveThreadIdentity({
      headers: { ...shared, "thread-id": "child-b", "x-client-request-id": "child-b" },
      body: {},
    });

    expect(first.source).toBe("thread-id");
    expect(first.threadKey).toMatch(/^[a-f0-9]{64}$/);
    expect(first.threadKey).not.toBe(second.threadKey);
    expect(first).not.toHaveProperty("rawId");
  });

  it("rejects conflicting explicit Codex thread identifiers", () => {
    try {
      resolveThreadIdentity({
        headers: { "thread-id": "thread-a" },
        body: { client_metadata: { thread_id: "thread-b" } },
      });
    } catch (error) {
      expect(error.code).toBe("thread_identity_mismatch");
      expect(error.status).toBe(400);
    }
  });

  it("does not treat a per-request identifier as a thread identity", () => {
    const identity = resolveThreadIdentity({
      headers: { "x-client-request-id": "request-a" },
      body: { prompt_cache_key: "stable-thread" },
    });

    expect(identity.source).toBe("prompt_cache_key");
  });

  it("preserves the thread identity error code in an OpenAI error response", async () => {
    const response = errorResponse(
      400,
      "Conflicting Codex thread identifiers",
      "thread_identity_mismatch",
    );

    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({
      error: {
        type: "invalid_request_error",
        code: "thread_identity_mismatch",
      },
    });
  });

  it("falls back through Codex metadata before generic session headers", () => {
    const identity = resolveThreadIdentity({
      headers: { "session-id": "generic-session" },
      body: { client_metadata: { thread_id: "metadata-thread" } },
    });

    expect(identity.source).toBe("client_metadata.thread_id");
  });
});

describe("ThreadRouteCoordinator", () => {
  it("pins one route and changes it only after an explicitly eligible failure", () => {
    const coordinator = new ThreadRouteCoordinator();
    const threadKey = "a".repeat(64);

    coordinator.bindRoute(threadKey, "quick", {
      model: "provider-a/model-a",
      connectionId: "account-a",
    });
    expect(coordinator.getBinding(threadKey, "quick")).toMatchObject({
      model: "provider-a/model-a",
      connectionId: "account-a",
      routeEpoch: 1,
    });

    expect(() => coordinator.bindRoute(threadKey, "quick", {
      model: "provider-b/model-b",
      connectionId: "account-b",
    })).toThrow(/eligible provider failure/i);

    coordinator.bindRoute(threadKey, "quick", {
      model: "provider-b/model-b",
      connectionId: "account-b",
    }, { allowRebind: true });
    expect(coordinator.getBinding(threadKey, "quick")).toMatchObject({
      model: "provider-b/model-b",
      connectionId: "account-b",
      routeEpoch: 2,
    });

    coordinator.markSuccess(threadKey, "quick", {
      model: "provider-b/model-b",
      connectionId: "account-b",
    });
    expect(coordinator.getBinding(threadKey, "quick").lastSuccessAt).toEqual(expect.any(Number));
  });

  it("keeps independent model bindings for aliases inside one session", () => {
    const coordinator = new ThreadRouteCoordinator();
    const threadKey = "b".repeat(64);
    coordinator.bindRoute(threadKey, "quick", { model: "p/m", connectionId: "c" });
    coordinator.bindRoute(threadKey, "different-alias", { model: "p/n", connectionId: "c" });

    expect(coordinator.getBinding(threadKey, "quick")).toMatchObject({ model: "p/m", connectionId: "c" });
    expect(coordinator.getBinding(threadKey, "different-alias")).toMatchObject({ model: "p/n", connectionId: "c" });
  });

  it("restores a persisted route after the coordinator process state is recreated", () => {
    const rows = new Map();
    const store = {
      get: (threadKey) => rows.get(threadKey) || null,
      upsert: (threadKey, binding) => rows.set(threadKey, { ...binding }),
    };
    const threadKey = "f".repeat(64);
    const first = new ThreadRouteCoordinator({ store });
    first.bindRoute(threadKey, "quick", {
      model: "provider-a/model-a",
      connectionId: "account-a",
    });
    first.markSuccess(threadKey, "quick", {
      model: "provider-a/model-a",
      connectionId: "account-a",
    });

    const restarted = new ThreadRouteCoordinator({ store });
    expect(restarted.getBinding(threadKey, "quick")).toMatchObject({
      model: "provider-a/model-a",
      connectionId: "account-a",
      routeEpoch: 1,
      lastSuccessAt: expect.any(Number),
    });
  });

  it("holds the same-thread lane until the response stream is consumed", async () => {
    const coordinator = new ThreadRouteCoordinator();
    const gate = deferred();
    const entered = [];
    let streamController;

    const first = await coordinator.run("c".repeat(64), "quick", async () => {
      entered.push("first");
      return new Response(new ReadableStream({
        start(controller) {
          streamController = controller;
          controller.enqueue(new TextEncoder().encode("first"));
        },
      }));
    });
    const secondPromise = coordinator.run("c".repeat(64), "quick", async () => {
      entered.push("second");
      gate.resolve();
      return new Response("second");
    });

    await Promise.resolve();
    expect(entered).toEqual(["first"]);
    expect(coordinator.getSnapshot()).toMatchObject({
      activeThreads: 1,
      pendingOperations: 2,
      waitingOperations: 1,
    });

    const reader = first.body.getReader();
    expect(new TextDecoder().decode((await reader.read()).value)).toBe("first");
    await Promise.resolve();
    expect(entered).toEqual(["first"]);

    streamController.close();
    expect((await reader.read()).done).toBe(true);
    await gate.promise;
    expect(entered).toEqual(["first", "second"]);
    await (await secondPromise).text();
    expect(coordinator.getSnapshot()).toMatchObject({
      activeThreads: 0,
      pendingOperations: 0,
      waitingOperations: 0,
    });
  });

  it("allows different Codex threads to run concurrently", async () => {
    const coordinator = new ThreadRouteCoordinator();
    const firstGate = deferred();
    const entered = [];

    const first = await coordinator.run("d".repeat(64), "quick", async () => {
      entered.push("first");
      return new Response(new ReadableStream({
        start(controller) {
          controller.enqueue(new TextEncoder().encode("open"));
          firstGate.promise.then(() => controller.close());
        },
      }));
    });
    const second = await coordinator.run("e".repeat(64), "quick", async () => {
      entered.push("second");
      return new Response("done");
    });

    expect(entered).toEqual(["first", "second"]);
    firstGate.resolve();
    await first.text();
    await second.text();
  });
});

import { beforeEach, describe, expect, it, vi } from "vitest";

const state = vi.hoisted(() => ({
  affinityEnabled: true,
  requestExecution: { activeRequests: 2 },
  snapshot: {
    activeThreads: 1,
    maxPendingPerThread: 8,
    pendingOperations: 2,
    sessionKey: "must-not-be-exposed",
    waitingOperations: 1,
  },
}));

vi.mock("next/server", () => ({
  NextResponse: {
    json: (body, init) => new Response(JSON.stringify(body), init),
  },
}));

vi.mock("open-sse/services/threadRouteCoordinator.js", () => ({
  isCodexThreadAffinityEnabled: () => state.affinityEnabled,
  threadRouteCoordinator: {
    getSnapshot: () => state.snapshot,
  },
}));

vi.mock("open-sse/services/requestExecutionState.js", () => ({
  getUpstreamExecutionSnapshot: () => state.requestExecution,
}));

beforeEach(() => {
  vi.resetModules();
  state.affinityEnabled = true;
  state.snapshot = {
    activeThreads: 1,
    maxPendingPerThread: 8,
    pendingOperations: 2,
    sessionKey: "must-not-be-exposed",
    waitingOperations: 1,
  };
});

describe("9router immutable health contract", () => {
  it("reports the custom release fields and only a sanitized affinity snapshot", async () => {
    const { GET } = await import("../../src/app/api/health/route.js");

    const response = await GET();
    const body = await response.json();

    expect(body).toMatchObject({
      ok: true,
      service: "9router",
      threadAffinity: true,
      routingContractVersion: "session-affinity/v2",
      upstreamVersion: "0.5.40",
      customRevision: "0.5.40-9trip.4",
      affinitySchemaVersion: 3,
      affinityStore: {
        status: "enabled",
        snapshot: {
          activeThreads: 1,
          maxPendingPerThread: 8,
          pendingOperations: 2,
          waitingOperations: 1,
        },
      },
    });
    expect(body.version).toBe("0.5.40-9trip.4");
    expect(body.affinityStore.snapshot).not.toHaveProperty("sessionKey");
  });
});

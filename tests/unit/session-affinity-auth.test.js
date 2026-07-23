import { beforeEach, describe, expect, it, vi } from "vitest";

const state = vi.hoisted(() => ({
  connections: [],
  settings: {},
  updateConnection: vi.fn(),
}));

vi.mock("@/lib/localDb", () => ({
  getProviderConnections: vi.fn(async () => state.connections),
  getSettings: vi.fn(async () => state.settings),
  getProxyPools: vi.fn(async () => []),
  updateProviderConnection: (...args) => state.updateConnection(...args),
  validateApiKey: vi.fn(),
}));

vi.mock("@/lib/network/connectionProxy", () => ({
  pickProxyPoolId: vi.fn(),
  resolveConnectionProxyConfig: vi.fn(async () => ({
    connectionProxyEnabled: false,
    connectionProxyUrl: "",
    connectionNoProxy: "",
    proxyPoolId: null,
    vercelRelayUrl: "",
  })),
}));

vi.mock("open-sse/services/accountFallback.js", () => ({
  formatRetryAfter: vi.fn(() => "soon"),
  checkFallbackError: vi.fn(() => false),
  isModelLockActive: vi.fn(() => false),
  buildModelLockUpdate: vi.fn(() => ({})),
  getEarliestModelLockUntil: vi.fn(() => null),
  getModelLockKey: vi.fn(() => "modelLock_test"),
}));

vi.mock("open-sse/config/errorConfig.js", () => ({
  ACCOUNT_HEALTH_CONFIG: { errorMessageLimit: 100, historyLimit: 5 },
}));

vi.mock("open-sse/config/quotaPolicy.js", () => ({
  resolveQuotaPolicy: vi.fn(() => null),
}));

vi.mock("@/shared/constants/providers.js", () => ({
  FREE_PROVIDERS: {},
  resolveProviderId: (provider) => provider,
}));

import { getProviderCredentials } from "../../src/sse/services/auth.js";

function connection(id, priority, extra = {}) {
  return {
    id,
    provider: "codex",
    authType: "oauth",
    priority,
    isActive: true,
    providerSpecificData: {},
    ...extra,
  };
}

beforeEach(() => {
  state.connections = [connection("account-a", 1), connection("account-b", 2)];
  state.settings = { fallbackStrategy: "round-robin", stickyRoundRobinLimit: 3 };
  state.updateConnection.mockReset().mockImplementation(async (id, update) => {
    const item = state.connections.find((candidate) => candidate.id === id);
    if (!item) return null;
    Object.assign(item, update);
    return item;
  });
});

describe("session-aware authentication selection", () => {
  it("uses provider fill-first config independently for each new thread", async () => {
    state.settings = { fallbackStrategy: "fill-first" };
    await expect(getProviderCredentials("codex", null, "gpt", { sessionKey: "session-1" })).resolves.toMatchObject({ connectionId: "account-a" });
    await expect(getProviderCredentials("codex", null, "gpt", { sessionKey: "session-2" })).resolves.toMatchObject({ connectionId: "account-a" });
  });

  it("uses an already-bound eligible account before the provider strategy", async () => {
    await expect(getProviderCredentials("codex", null, "gpt", {
      sessionKey: "session-1",
      preferredConnectionId: "account-b",
    })).resolves.toMatchObject({ connectionId: "account-b" });
  });

  it("applies sticky round robin to a new thread", async () => {
    state.connections = [
      connection("account-a", 1, { lastUsedAt: "2026-07-22T00:00:00.000Z", consecutiveUseCount: 1 }),
      connection("account-b", 2),
    ];

    await expect(getProviderCredentials("codex", null, "gpt", { sessionKey: "session-1" })).resolves.toMatchObject({ connectionId: "account-a" });
    expect(state.updateConnection).toHaveBeenCalledWith("account-a", expect.objectContaining({ consecutiveUseCount: 2 }));
  });

  it("rotates a new thread when the configured sticky limit is exhausted", async () => {
    state.connections = [
      connection("account-a", 1, { lastUsedAt: "2026-07-22T00:00:00.000Z", consecutiveUseCount: 3 }),
      connection("account-b", 2),
    ];

    await expect(getProviderCredentials("codex", null, "gpt", { sessionKey: "session-2" })).resolves.toMatchObject({ connectionId: "account-b" });
  });

  it("skips a persisted connection error before applying provider strategy", async () => {
    state.settings = { fallbackStrategy: "fill-first" };
    state.connections = [
      connection("account-a", 1, { testStatus: "error", lastError: "credentials rejected" }),
      connection("account-b", 2),
    ];

    await expect(getProviderCredentials("codex", null, "gpt", { sessionKey: "session-error" })).resolves.toMatchObject({ connectionId: "account-b" });
  });

  it("skips a persisted unavailable connection even when no model lock remains", async () => {
    state.settings = { fallbackStrategy: "fill-first" };
    state.connections = [
      connection("account-a", 1, { testStatus: "unavailable" }),
      connection("account-b", 2),
    ];

    await expect(getProviderCredentials("codex", null, "gpt", { sessionKey: "session-unavailable" })).resolves.toMatchObject({ connectionId: "account-b" });
  });

  it("skips a connection with a persisted quota error before dispatch", async () => {
    state.settings = { fallbackStrategy: "fill-first" };
    state.connections = [
      connection("account-a", 1, { testStatus: "active", lastError: "Account is out of credits" }),
      connection("account-b", 2),
    ];

    await expect(getProviderCredentials("codex", null, "gpt", { sessionKey: "session-credits" })).resolves.toMatchObject({ connectionId: "account-b" });
  });

  it("skips persisted account health quota state even when a flat lock is missing", async () => {
    state.settings = { fallbackStrategy: "fill-first" };
    state.connections = [
      connection("account-a", 1, {
        accountHealth: {
          version: 2,
          models: {
            gpt: {
              state: "unavailable",
              reason: "quota",
              retryAt: new Date(Date.now() + 60_000).toISOString(),
            },
          },
        },
      }),
      connection("account-b", 2),
    ];

    await expect(getProviderCredentials("codex", null, "gpt", { sessionKey: "session-quota" })).resolves.toMatchObject({ connectionId: "account-b" });
  });

  it("keeps an unavailable account blocked when persisted health has no retry time", async () => {
    state.settings = { fallbackStrategy: "fill-first" };
    state.connections = [
      connection("account-a", 1, {
        accountHealth: {
          version: 2,
          models: {
            gpt: {
              state: "unavailable",
              reason: "quota",
              retryAt: null,
            },
          },
        },
      }),
      connection("account-b", 2),
    ];

    await expect(getProviderCredentials("codex", null, "gpt", { sessionKey: "session-quota-no-retry" })).resolves.toMatchObject({ connectionId: "account-b" });
  });
});

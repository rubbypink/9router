import { beforeEach, describe, expect, it, vi } from "vitest";

const state = vi.hoisted(() => ({
  connections: [],
  getProviderConnections: vi.fn(),
  updateProviderConnection: vi.fn(),
  getSettings: vi.fn(),
  getProxyPools: vi.fn(),
  validateApiKey: vi.fn(),
  resolveConnectionProxyConfig: vi.fn(),
  pickProxyPoolId: vi.fn(),
  resolveProviderId: vi.fn(),
}));

vi.mock("@/lib/localDb", () => ({
  getProviderConnections: state.getProviderConnections,
  updateProviderConnection: state.updateProviderConnection,
  getSettings: state.getSettings,
  getProxyPools: state.getProxyPools,
  validateApiKey: state.validateApiKey,
}));

vi.mock("@/lib/network/connectionProxy", () => ({
  resolveConnectionProxyConfig: state.resolveConnectionProxyConfig,
  pickProxyPoolId: state.pickProxyPoolId,
}));

vi.mock("@/shared/constants/providers.js", () => ({
  resolveProviderId: state.resolveProviderId,
  FREE_PROVIDERS: {},
}));

vi.mock("../../src/sse/utils/logger.js", () => ({
  debug: vi.fn(),
  info: vi.fn(),
  warn: vi.fn(),
}));

function connection(overrides = {}) {
  return {
    id: "conn-1",
    provider: "codex",
    authType: "oauth",
    name: "Codex account",
    isActive: true,
    accessToken: "test-token",
    providerSpecificData: {},
    priority: 1,
    ...overrides,
  };
}

beforeEach(() => {
  vi.resetModules();
  vi.clearAllMocks();
  state.connections = [];
  state.getProviderConnections.mockImplementation(async (filter = {}) => (
    state.connections.filter((item) => (
      (!filter.provider || item.provider === filter.provider)
      && (filter.isActive === undefined || item.isActive === filter.isActive)
    ))
  ));
  state.updateProviderConnection.mockImplementation(async (id, update) => {
    const item = state.connections.find((candidate) => candidate.id === id);
    if (!item) return null;
    Object.assign(item, update);
    return item;
  });
  state.getSettings.mockResolvedValue({});
  state.getProxyPools.mockResolvedValue([]);
  state.validateApiKey.mockResolvedValue(true);
  state.resolveConnectionProxyConfig.mockResolvedValue({});
  state.resolveProviderId.mockImplementation((provider) => provider);
});

describe("account health state", () => {
  it("keeps an exact provider quota reset instead of truncating it to a local cap", async () => {
    const account = connection({ backoffLevel: 4 });
    state.connections.push(account);
    const { markAccountUnavailable } = await import("../../src/sse/services/auth.js");
    const resetAtMs = Date.now() + 4 * 60 * 60 * 1000;

    const result = await markAccountUnavailable(
      account.id,
      429,
      "usage quota exhausted",
      "codex",
      "gpt-5.6",
      resetAtMs,
      { errorCode: "usage_limit_reached" },
    );

    expect(result).toMatchObject({ shouldFallback: true, cooldownMs: expect.any(Number) });
    expect(result.cooldownMs).toBeGreaterThan(3 * 60 * 60 * 1000);
    expect(account.isActive).toBe(true);
    expect(account["modelLock_gpt-5.6"]).toBe(new Date(resetAtMs).toISOString());
    expect(account.accountHealth.models["gpt-5.6"]).toMatchObject({
      state: "unavailable",
      reason: "quota",
      errorCode: "usage_limit_reached",
      retryAt: new Date(resetAtMs).toISOString(),
      source: "provider-reset",
      quotaPolicy: "openai",
    });
  });

  it("re-enables only the automatic health state after a persisted lock expires", async () => {
    const expiredAt = new Date(Date.now() - 1000).toISOString();
    const account = connection({
      "modelLock_gpt-5.6": expiredAt,
      testStatus: "unavailable",
      lastError: "quota exhausted",
      lastErrorAt: expiredAt,
      errorCode: "usage_limit_reached",
      backoffLevel: 3,
      accountHealth: {
        version: 1,
        updatedAt: expiredAt,
        models: {
          "gpt-5.6": {
            state: "unavailable",
            retryAt: expiredAt,
          },
        },
        recentErrors: [{ model: "gpt-5.6", status: 429 }],
      },
    });
    state.connections.push(account);
    const { reconcileAccountHealth } = await import("../../src/sse/services/auth.js");

    await expect(reconcileAccountHealth()).resolves.toEqual({ checked: 1, reconciled: 1 });
    expect(account.isActive).toBe(true);
    expect(account["modelLock_gpt-5.6"]).toBeNull();
    expect(account).toMatchObject({
      testStatus: "active",
      lastError: null,
      lastErrorAt: null,
      errorCode: null,
      backoffLevel: 0,
      accountHealth: {
        models: {},
        recentErrors: [{ model: "gpt-5.6", status: 429 }],
      },
    });
  });

  it("uses a provider-specific fallback cooldown when no reset hint is returned", async () => {
    const account = connection({ provider: "stability-ai" });
    state.connections.push(account);
    const { markAccountUnavailable } = await import("../../src/sse/services/auth.js");
    const before = Date.now();

    const result = await markAccountUnavailable(
      account.id,
      429,
      "rate limit exceeded",
      "stability-ai",
      "stable-image",
    );

    expect(result.cooldownMs).toBe(60_000);
    expect(new Date(account["modelLock_stable-image"]).getTime()).toBeGreaterThanOrEqual(before + 59_900);
    expect(account.accountHealth.models["stable-image"]).toMatchObject({
      quotaPolicy: "stability",
      source: "fallback-policy",
    });
  });
});

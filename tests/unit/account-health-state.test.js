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
    expect(account["modelLock___all"]).toBe(new Date(resetAtMs).toISOString());
    expect(account.accountHealth.models.__all).toMatchObject({
      state: "unavailable",
      reason: "quota",
      failureClass: "quota",
      scope: "account",
      errorCode: "usage_limit_reached",
      retryAt: new Date(resetAtMs).toISOString(),
      source: "provider-reset",
      quotaPolicy: "openai",
    });
  });

  it("does not poison account availability for a terminal Gemini continuity error", async () => {
    const account = connection({ provider: "gemini" });
    state.connections.push(account);
    const { markAccountUnavailable } = await import("../../src/sse/services/auth.js");

    const result = await markAccountUnavailable(
      account.id,
      400,
      "Function call is missing a thought_signature in functionCall parts.",
      "gemini",
      "gemini-2.5-pro",
    );

    expect(result).toEqual({ shouldFallback: false, cooldownMs: 0 });
    expect(state.updateProviderConnection).not.toHaveBeenCalled();
  });

  it("replicates an explicit provider-wide quota state before another account is selected", async () => {
    const retryAtMs = Date.now() + 60_000;
    const first = connection({ id: "conn-1", provider: "openai" });
    const second = connection({ id: "conn-2", provider: "openai" });
    state.connections.push(first, second);
    const { markAccountUnavailable, getProviderModelAvailability } = await import("../../src/sse/services/auth.js");

    await markAccountUnavailable(
      first.id,
      429,
      "provider-wide quota exhausted",
      "openai",
      "gpt-5.6",
      retryAtMs,
    );

    for (const account of [first, second]) {
      expect(account["modelLock___all"]).toBe(new Date(retryAtMs).toISOString());
      expect(account.accountHealth.models.__all).toMatchObject({
        failureClass: "quota",
        scope: "provider",
      });
    }
    await expect(getProviderModelAvailability("openai", "gpt-5.6")).resolves.toMatchObject({
      available: false,
      reason: "quota",
    });
  });

  it("rechecks the selected account against persisted availability before dispatch", async () => {
    const retryAt = new Date(Date.now() + 60_000).toISOString();
    const account = connection({
      provider: "openai",
      "modelLock_gpt-5.6": retryAt,
      accountHealth: {
        version: 2,
        models: {
          "gpt-5.6": {
            state: "unavailable",
            reason: "quota",
            failureClass: "quota",
            retryAt,
          },
        },
        recentErrors: [],
      },
    });
    state.connections.push(account);
    const { getProviderConnectionAvailability } = await import("../../src/sse/services/auth.js");

    await expect(getProviderConnectionAvailability("openai", account.id, "gpt-5.6")).resolves.toMatchObject({
      available: false,
      reason: "quota",
      failureClass: "quota",
      retryAfter: retryAt,
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

  it("clears stale Codex quota state when provider usage reports reset capacity", async () => {
    const retryAt = new Date(Date.now() + 60 * 60 * 1000).toISOString();
    const account = connection({
      "modelLock_gpt-5.6": retryAt,
      testStatus: "unavailable",
      lastError: "usage quota exhausted",
      lastErrorAt: new Date().toISOString(),
      errorCode: "usage_limit_reached",
      backoffLevel: 2,
      accountHealth: {
        version: 2,
        updatedAt: new Date().toISOString(),
        models: {
          "gpt-5.6": {
            state: "unavailable",
            reason: "quota",
            retryAt,
          },
        },
        recentErrors: [],
      },
    });
    state.connections.push(account);
    const { reconcileProviderQuotaState } = await import("../../src/sse/services/auth.js");

    await reconcileProviderQuotaState(account, {
      limitReached: false,
      quotas: {
        session: { used: 25, total: 100, remaining: 75, resetAt: retryAt },
        weekly: { used: 40, total: 100, remaining: 60, resetAt: retryAt },
      },
    });

    expect(account["modelLock_gpt-5.6"]).toBeNull();
    expect(account).toMatchObject({
      testStatus: "active",
      lastError: null,
      lastErrorAt: null,
      errorCode: null,
      backoffLevel: 0,
      accountHealth: { models: {} },
    });
  });

  it("reconciles exact Antigravity model buckets without clearing a still-exhausted sibling", async () => {
    const oldRetryAt = new Date(Date.now() + 60 * 60 * 1000).toISOString();
    const providerRetryAt = new Date(Date.now() + 2 * 60 * 60 * 1000).toISOString();
    const account = connection({
      provider: "antigravity",
      "modelLock_gemini-3.5-flash-low": oldRetryAt,
      "modelLock_claude-opus-4-6-thinking": oldRetryAt,
      testStatus: "unavailable",
      lastError: "quota exhausted",
      accountHealth: {
        version: 2,
        updatedAt: new Date().toISOString(),
        models: {
          "gemini-3.5-flash-low": { state: "unavailable", reason: "quota", retryAt: oldRetryAt },
          "claude-opus-4-6-thinking": { state: "unavailable", reason: "quota", retryAt: oldRetryAt },
        },
        recentErrors: [],
      },
    });
    state.connections.push(account);
    const { reconcileProviderQuotaState } = await import("../../src/sse/services/auth.js");

    await reconcileProviderQuotaState(account, {
      quotas: {
        "gemini-3.5-flash-low": { total: 1000, remainingPercentage: 35, resetAt: providerRetryAt },
        "claude-opus-4-6-thinking": { total: 1000, remainingPercentage: 0, resetAt: providerRetryAt },
      },
    });

    expect(account["modelLock_gemini-3.5-flash-low"]).toBeNull();
    expect(account["modelLock_claude-opus-4-6-thinking"]).toBe(providerRetryAt);
    expect(account.accountHealth.models).not.toHaveProperty("gemini-3.5-flash-low");
    expect(account.accountHealth.models["claude-opus-4-6-thinking"]).toMatchObject({
      state: "unavailable",
      reason: "quota",
      retryAt: providerRetryAt,
      source: "provider-usage",
    });
  });

  it("tracks and clears Claude family quota without hiding healthy model families", async () => {
    const retryAt = new Date(Date.now() + 2 * 60 * 60 * 1000).toISOString();
    const account = connection({ provider: "claude" });
    state.connections.push(account);
    const { getProviderModelAvailability, reconcileProviderQuotaState } = await import("../../src/sse/services/auth.js");

    await reconcileProviderQuotaState(account, {
      quotas: {
        "session (5h)": { remainingPercentage: 80, resetAt: retryAt },
        "weekly (7d)": { remainingPercentage: 60, resetAt: retryAt },
        "weekly sonnet (7d)": { remainingPercentage: 0, resetAt: retryAt },
        "weekly opus (7d)": { remainingPercentage: 40, resetAt: retryAt },
      },
    });

    expect(account["modelLock___family:sonnet"]).toBe(retryAt);
    await expect(getProviderModelAvailability("claude", "claude-sonnet-5")).resolves.toMatchObject({
      available: false,
      reason: "quota",
      retryAfter: retryAt,
    });
    await expect(getProviderModelAvailability("claude", "claude-opus-4-8")).resolves.toEqual({ available: true });

    await reconcileProviderQuotaState(account, {
      quotas: {
        "session (5h)": { remainingPercentage: 90, resetAt: retryAt },
        "weekly (7d)": { remainingPercentage: 75, resetAt: retryAt },
        "weekly sonnet (7d)": { remainingPercentage: 50, resetAt: retryAt },
        "weekly opus (7d)": { remainingPercentage: 40, resetAt: retryAt },
      },
    });

    expect(account["modelLock___family:sonnet"]).toBeNull();
    expect(account).toMatchObject({
      testStatus: "active",
      lastError: null,
      accountHealth: { models: {} },
    });
  });

  it("exposes provider-model availability without letting one model quota hide healthy siblings", async () => {
    const retryAt = new Date(Date.now() + 60 * 60 * 1000).toISOString();
    state.connections.push(
      connection({
        id: "conn-1",
        provider: "antigravity",
        "modelLock_model-a": retryAt,
        rateLimitedUntil: retryAt,
        testStatus: "unavailable",
        lastError: "quota exhausted for model-a",
        accountHealth: {
          version: 2,
          updatedAt: new Date().toISOString(),
          models: {
            "model-a": { state: "unavailable", reason: "quota", retryAt },
          },
          recentErrors: [],
        },
      }),
      connection({
        id: "conn-2",
        provider: "antigravity",
        "modelLock_model-a": retryAt,
        rateLimitedUntil: retryAt,
        testStatus: "unavailable",
        lastError: "quota exhausted for model-a",
        accountHealth: {
          version: 2,
          updatedAt: new Date().toISOString(),
          models: {
            "model-a": { state: "unavailable", reason: "quota", retryAt },
          },
          recentErrors: [],
        },
      }),
    );
    const { getProviderModelAvailability } = await import("../../src/sse/services/auth.js");

    await expect(getProviderModelAvailability("antigravity", "model-a")).resolves.toMatchObject({
      available: false,
      reason: "quota",
      retryAfter: retryAt,
    });
    await expect(getProviderModelAvailability("antigravity", "model-b")).resolves.toEqual({
      available: true,
    });
  });
});

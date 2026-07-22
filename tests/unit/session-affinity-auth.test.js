import { beforeEach, describe, expect, it, vi } from "vitest";

const state = vi.hoisted(() => ({
  connections: [],
  settings: {},
  claim: vi.fn(),
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

vi.mock("@/lib/db/repos/threadRoutesRepo.js", () => ({
  selectNextSessionAffinityConnection: (...args) => state.claim(...args),
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
  state.updateConnection.mockReset().mockResolvedValue(null);
  state.claim.mockReset();
});

describe("session-aware authentication selection", () => {
  it("uses strict persistent A/B/A selection for new affinity sessions", async () => {
    state.claim
      .mockImplementationOnce((_provider, eligible) => eligible[0])
      .mockImplementationOnce((_provider, eligible) => eligible[1])
      .mockImplementationOnce((_provider, eligible) => eligible[0]);

    await expect(getProviderCredentials("codex", null, "gpt", { sessionKey: "session-1" })).resolves.toMatchObject({ connectionId: "account-a" });
    await expect(getProviderCredentials("codex", null, "gpt", { sessionKey: "session-2" })).resolves.toMatchObject({ connectionId: "account-b" });
    await expect(getProviderCredentials("codex", null, "gpt", { sessionKey: "session-3" })).resolves.toMatchObject({ connectionId: "account-a" });
  });

  it("hands the cursor connections ordered by priority then ID", async () => {
    state.connections = [connection("account-b", 1), connection("account-a", 1)];
    state.claim.mockImplementation((_provider, eligible) => eligible[0]);

    await getProviderCredentials("codex", null, "gpt", { sessionKey: "session-1" });

    expect(state.claim).toHaveBeenCalledWith("codex", [expect.objectContaining({ id: "account-a" }), expect.objectContaining({ id: "account-b" })]);
  });

  it("bypasses the cursor for an already-bound eligible account", async () => {
    await expect(getProviderCredentials("codex", null, "gpt", {
      sessionKey: "session-1",
      preferredConnectionId: "account-b",
    })).resolves.toMatchObject({ connectionId: "account-b" });

    expect(state.claim).not.toHaveBeenCalled();
  });

  it("retains legacy sticky round robin for sessionless traffic", async () => {
    state.connections = [
      connection("account-a", 1, { lastUsedAt: "2026-07-22T00:00:00.000Z", consecutiveUseCount: 1 }),
      connection("account-b", 2),
    ];

    await expect(getProviderCredentials("codex", null, "gpt")).resolves.toMatchObject({ connectionId: "account-a" });
    expect(state.claim).not.toHaveBeenCalled();
    expect(state.updateConnection).toHaveBeenCalledWith("account-a", expect.objectContaining({ consecutiveUseCount: 2 }));
  });

  it("keeps sessionless sticky limits when the current account is exhausted", async () => {
    state.connections = [
      connection("account-a", 1, { lastUsedAt: "2026-07-22T00:00:00.000Z", consecutiveUseCount: 3 }),
      connection("account-b", 2),
    ];

    await expect(getProviderCredentials("codex", null, "gpt")).resolves.toMatchObject({ connectionId: "account-b" });
    expect(state.claim).not.toHaveBeenCalled();
  });

  it("does not use sticky limits for an unbound affinity session", async () => {
    state.connections = [
      connection("account-a", 1, { lastUsedAt: "2026-07-22T00:00:00.000Z", consecutiveUseCount: 3 }),
      connection("account-b", 2),
    ];
    state.claim.mockImplementation((_provider, eligible) => eligible[1]);

    await expect(getProviderCredentials("codex", null, "gpt", { sessionKey: "session-1" })).resolves.toMatchObject({ connectionId: "account-b" });
  });
});

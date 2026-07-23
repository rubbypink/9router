import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  getExecutor: vi.fn(),
  getProviderConnectionById: vi.fn(),
  getUsageForProvider: vi.fn(),
  reconcileProviderQuotaState: vi.fn(),
  resolveConnectionProxyConfig: vi.fn(),
  updateProviderConnection: vi.fn(),
}));

vi.mock("open-sse/index.js", () => ({}));
vi.mock("@/lib/localDb", () => ({
  getProviderConnectionById: mocks.getProviderConnectionById,
  updateProviderConnection: mocks.updateProviderConnection,
}));
vi.mock("open-sse/services/usage.js", () => ({
  getUsageForProvider: mocks.getUsageForProvider,
}));
vi.mock("open-sse/executors/index.js", () => ({
  getExecutor: mocks.getExecutor,
}));
vi.mock("@/lib/network/connectionProxy", () => ({
  resolveConnectionProxyConfig: mocks.resolveConnectionProxyConfig,
}));
vi.mock("@/shared/constants/providers", () => ({
  USAGE_APIKEY_PROVIDERS: [],
}));
vi.mock("@/sse/services/auth.js", () => ({
  reconcileProviderQuotaState: mocks.reconcileProviderQuotaState,
}));

describe("usage route quota reconciliation", () => {
  beforeEach(() => {
    vi.resetModules();
    vi.clearAllMocks();
    mocks.getExecutor.mockReturnValue({ needsRefresh: () => false });
    mocks.resolveConnectionProxyConfig.mockResolvedValue({});
  });

  it("persists provider quota truth before returning refreshed usage", async () => {
    const connection = {
      id: "conn-1",
      provider: "codex",
      authType: "oauth",
      accessToken: "token",
      providerSpecificData: {},
    };
    const usage = {
      limitReached: false,
      quotas: {
        session: { used: 10, total: 100, remaining: 90 },
        weekly: { used: 20, total: 100, remaining: 80 },
      },
    };
    mocks.getProviderConnectionById.mockResolvedValue(connection);
    mocks.getUsageForProvider.mockResolvedValue(usage);

    const { GET } = await import("../../src/app/api/usage/[connectionId]/route.js");
    const response = await GET(new Request("http://localhost/api/usage/conn-1"), {
      params: Promise.resolve({ connectionId: "conn-1" }),
    });

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual(usage);
    expect(mocks.reconcileProviderQuotaState).toHaveBeenCalledWith(connection, usage);
  });
});

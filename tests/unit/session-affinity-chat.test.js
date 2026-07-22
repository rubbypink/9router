import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  bindRoute: vi.fn(),
  cacheClaudeHeaders: vi.fn(),
  checkAndRefreshToken: vi.fn(),
  clearAccountError: vi.fn(),
  createUpstreamRequestState: vi.fn(() => ({})),
  extractApiKey: vi.fn(() => null),
  getComboModels: vi.fn(),
  getModelInfo: vi.fn(),
  getProviderCredentials: vi.fn(),
  getSettings: vi.fn(),
  getConnectionBinding: vi.fn(),
  handleBypassRequest: vi.fn(),
  handleChatCore: vi.fn(),
  isCodexThreadAffinityEnabled: vi.fn(),
  isValidApiKey: vi.fn(),
  markAccountUnavailable: vi.fn(),
  markSuccess: vi.fn(),
  resolveThreadIdentity: vi.fn(),
  run: vi.fn(),
  runWithUpstreamRequestState: vi.fn(),
}));

vi.mock("open-sse/index.js", () => ({}));
vi.mock("../../src/sse/services/auth.js", () => ({
  getProviderCredentials: mocks.getProviderCredentials,
  markAccountUnavailable: mocks.markAccountUnavailable,
  clearAccountError: mocks.clearAccountError,
  extractApiKey: mocks.extractApiKey,
  isValidApiKey: mocks.isValidApiKey,
}));
vi.mock("open-sse/utils/claudeHeaderCache.js", () => ({ cacheClaudeHeaders: mocks.cacheClaudeHeaders }));
vi.mock("@/lib/localDb", () => ({ getSettings: mocks.getSettings }));
vi.mock("../../src/sse/services/model.js", () => ({
  getModelInfo: mocks.getModelInfo,
  getComboModels: mocks.getComboModels,
  resolveProviderAlias: (provider) => provider,
}));
vi.mock("open-sse/handlers/chatCore.js", () => ({ handleChatCore: mocks.handleChatCore }));
vi.mock("@/lib/headroom/detect", () => ({ DEFAULT_HEADROOM_URL: "http://headroom.test" }));
vi.mock("@/lib/pxpipe/loader.js", () => ({ getTransform: vi.fn() }));
vi.mock("@/lib/pxpipe/events.js", () => ({ appendPxpipeEvent: vi.fn() }));
vi.mock("open-sse/utils/error.js", () => ({
  errorResponse: (status, message, code) => new Response(JSON.stringify({ message, code }), { status }),
  unavailableResponse: (status, message) => new Response(JSON.stringify({ message }), { status }),
}));
vi.mock("open-sse/services/combo.js", async (importOriginal) => ({
  ...await importOriginal(),
  handleFusionChat: vi.fn(),
}));
vi.mock("open-sse/utils/bypassHandler.js", () => ({ handleBypassRequest: mocks.handleBypassRequest }));
vi.mock("open-sse/config/runtimeConfig.js", async (importOriginal) => {
  const actual = await importOriginal();
  return {
    ...actual,
    HTTP_STATUS: { ...actual.HTTP_STATUS, BAD_REQUEST: 400, NOT_FOUND: 404, SERVICE_UNAVAILABLE: 503, UNAUTHORIZED: 401 },
  };
});
vi.mock("open-sse/translator/formats.js", () => ({ detectFormatByEndpoint: vi.fn() }));
vi.mock("../../src/sse/utils/logger.js", () => ({
  debug: vi.fn(),
  error: vi.fn(),
  info: vi.fn(),
  maskKey: vi.fn((value) => value),
  warn: vi.fn(),
}));
vi.mock("../../src/sse/services/tokenRefresh.js", () => ({
  checkAndRefreshToken: mocks.checkAndRefreshToken,
  updateProviderCredentials: vi.fn(),
}));
vi.mock("open-sse/services/projectId.js", () => ({ getProjectIdForConnection: vi.fn() }));
vi.mock("open-sse/utils/threadIdentity.js", () => ({ resolveThreadIdentity: mocks.resolveThreadIdentity }));
vi.mock("open-sse/services/threadRouteCoordinator.js", () => ({
  isCodexThreadAffinityEnabled: mocks.isCodexThreadAffinityEnabled,
  threadRouteCoordinator: {
    bindRoute: mocks.bindRoute,
    getConnectionBinding: mocks.getConnectionBinding,
    markSuccess: mocks.markSuccess,
    run: mocks.run,
  },
}));
vi.mock("open-sse/services/requestExecutionState.js", () => ({
  createUpstreamRequestState: mocks.createUpstreamRequestState,
  runWithUpstreamRequestState: mocks.runWithUpstreamRequestState,
}));

import { handleChat } from "../../src/sse/handlers/chat.js";

describe("session affinity chat fallback", () => {
  const boundConnection = "connection-bound";
  const binding = {
    providerId: "openai",
    model: "openai/gpt-test",
    resolvedModel: "openai/gpt-test",
    connectionId: boundConnection,
    routeEpoch: 7,
  };

  beforeEach(() => {
    vi.clearAllMocks();
    mocks.getSettings.mockResolvedValue({ requireApiKey: false });
    mocks.getComboModels.mockResolvedValue(null);
    mocks.getModelInfo.mockResolvedValue({ provider: "openai", model: "gpt-test" });
    mocks.handleBypassRequest.mockReturnValue(null);
    mocks.isCodexThreadAffinityEnabled.mockReturnValue(true);
    mocks.resolveThreadIdentity.mockReturnValue({ sessionKey: "session-affinity-chat", legacySessionKey: null });
    mocks.getConnectionBinding.mockReturnValue({ connectionId: boundConnection, routeEpoch: 7 });
    mocks.getProviderCredentials
      .mockResolvedValueOnce({
        connectionId: boundConnection,
        connectionName: "bound-account",
        accessToken: "test-token",
        providerSpecificData: {},
      })
      .mockResolvedValue(null);
    mocks.checkAndRefreshToken.mockImplementation(async (_provider, credentials) => credentials);
    mocks.handleChatCore.mockResolvedValue({
      success: false,
      status: 404,
      error: "Model not found",
      errorCode: "model_not_found",
      response: new Response("provider model not found", { status: 404 }),
    });
    mocks.markAccountUnavailable.mockResolvedValue({ shouldFallback: true });
    mocks.run.mockImplementation(async (_identity, _model, operation) => operation({ ...binding }));
    mocks.runWithUpstreamRequestState.mockImplementation(async (_state, operation) => operation());
  });

  it("returns a bound model-not-found response without reselecting an affinity route", async () => {
    const request = new Request("http://router.test/v1/chat/completions", {
      method: "POST",
      headers: { "content-type": "application/json", "thread-id": "thread-404" },
      body: JSON.stringify({ model: "openai/gpt-test", messages: [] }),
    });

    const response = await handleChat(request);

    expect(response.status).toBe(404);
    await expect(response.text()).resolves.toBe("provider model not found");
    expect(mocks.getProviderCredentials).toHaveBeenCalledTimes(1);
    expect(mocks.getProviderCredentials).toHaveBeenLastCalledWith(
      "openai",
      expect.any(Set),
      "gpt-test",
      { preferredConnectionId: boundConnection, sessionKey: "session-affinity-chat" },
    );
    expect(mocks.markAccountUnavailable).not.toHaveBeenCalled();
    expect(mocks.bindRoute).toHaveBeenCalledWith(
      "session-affinity-chat",
      "openai/gpt-test",
      expect.objectContaining({ connectionId: boundConnection }),
      { allowRebind: false, rebindReason: null },
    );
    expect(binding).toMatchObject({ connectionId: boundConnection, routeEpoch: 7 });
  });

  it("does not rebind a pinned combo after its bound model returns 404", async () => {
    const pinnedBinding = {
      ...binding,
      model: "openai/gpt-bound",
      resolvedModel: "openai/gpt-bound",
    };
    mocks.getComboModels.mockResolvedValue(["openai/gpt-bound", "anthropic/gpt-fallback"]);
    mocks.getModelInfo.mockImplementation(async (model) => {
      const [provider, modelName] = model.split("/");
      return { provider, model: modelName };
    });
    mocks.getProviderCredentials
      .mockReset()
      .mockResolvedValueOnce({
        connectionId: boundConnection,
        connectionName: "bound-account",
        accessToken: "test-token",
        providerSpecificData: {},
      })
      .mockResolvedValueOnce({
        connectionId: "connection-fallback",
        connectionName: "fallback-account",
        accessToken: "fallback-token",
        providerSpecificData: {},
      });
    mocks.handleChatCore
      .mockReset()
      .mockResolvedValueOnce({
        success: false,
        status: 404,
        error: "Model not found",
        errorCode: "model_not_found",
        response: new Response("pinned combo model not found", { status: 404 }),
      })
      .mockResolvedValueOnce({
        success: true,
        response: new Response("unexpected combo fallback"),
      });
    mocks.run.mockImplementation(async (_identity, _model, operation) => operation({ ...pinnedBinding }));
    const request = new Request("http://router.test/v1/chat/completions", {
      method: "POST",
      headers: { "content-type": "application/json", "thread-id": "thread-combo-404" },
      body: JSON.stringify({ model: "pinned-combo", messages: [] }),
    });

    const response = await handleChat(request);

    expect(response.status).toBe(404);
    await expect(response.text()).resolves.toBe("pinned combo model not found");
    expect(mocks.getProviderCredentials).toHaveBeenCalledTimes(1);
    expect(mocks.handleChatCore).toHaveBeenCalledTimes(1);
    expect(mocks.bindRoute).toHaveBeenCalledTimes(1);
    expect(mocks.bindRoute).toHaveBeenLastCalledWith(
      "session-affinity-chat",
      "pinned-combo",
      expect.objectContaining({ connectionId: boundConnection }),
      { allowRebind: false, rebindReason: null },
    );
    expect(pinnedBinding).toMatchObject({ connectionId: boundConnection, routeEpoch: 7 });
  });
});

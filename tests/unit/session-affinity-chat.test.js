import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  bindRoute: vi.fn(),
  cacheClaudeHeaders: vi.fn(),
  checkAndRefreshToken: vi.fn(),
  clearAccountError: vi.fn(),
  createUpstreamRequestState: vi.fn(() => ({})),
  extractApiKey: vi.fn(() => null),
  getComboModels: vi.fn(),
  getProviderConnectionAvailability: vi.fn(),
  getModelInfo: vi.fn(),
  getProviderModelAvailability: vi.fn(),
  getProviderCredentials: vi.fn(),
  getSettings: vi.fn(),
  getConnectionBinding: vi.fn(),
  handleBypassRequest: vi.fn(),
  handleChatCore: vi.fn(),
  handleFusionChat: vi.fn(),
  isCodexThreadAffinityEnabled: vi.fn(),
  isValidApiKey: vi.fn(),
  markAccountUnavailable: vi.fn(),
  markSuccess: vi.fn(),
  resolveThreadIdentity: vi.fn(),
  resolveComboName: vi.fn((model) => model),
  run: vi.fn(),
  runWithUpstreamRequestState: vi.fn(),
}));

vi.mock("open-sse/index.js", () => ({}));
vi.mock("../../src/sse/services/auth.js", () => ({
  getProviderCredentials: mocks.getProviderCredentials,
  getProviderConnectionAvailability: mocks.getProviderConnectionAvailability,
  getProviderModelAvailability: mocks.getProviderModelAvailability,
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
  resolveComboName: mocks.resolveComboName,
  resolveProviderAlias: (provider) => provider,
}));
vi.mock("open-sse/handlers/chatCore.js", () => ({ handleChatCore: mocks.handleChatCore }));
vi.mock("@/lib/headroom/detect", () => ({ DEFAULT_HEADROOM_URL: "http://headroom.test" }));
vi.mock("@/lib/pxpipe/loader.js", () => ({ getTransform: vi.fn() }));
vi.mock("@/lib/pxpipe/events.js", () => ({ appendPxpipeEvent: vi.fn() }));
vi.mock("open-sse/services/combo.js", async (importOriginal) => ({
  ...await importOriginal(),
  handleFusionChat: mocks.handleFusionChat,
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
  runWithUpstreamAttemptScope: (_scope, operation) => operation(),
  runWithUpstreamRequestState: mocks.runWithUpstreamRequestState,
  UPSTREAM_DISPATCH_INELIGIBLE_ERROR_CODE: "upstream_dispatch_ineligible",
  UPSTREAM_ATTEMPT_BUDGET_ERROR_CODE: "upstream_attempt_budget_exhausted",
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
    mocks.resolveComboName.mockImplementation((model) => model);
    mocks.getConnectionBinding.mockReturnValue({ connectionId: boundConnection, routeEpoch: 7 });
    mocks.getProviderCredentials
      .mockResolvedValueOnce({
        connectionId: boundConnection,
        connectionName: "bound-account",
        accessToken: "test-token",
        providerSpecificData: {},
      })
      .mockResolvedValue(null);
    mocks.getProviderModelAvailability.mockResolvedValue({ available: true });
    mocks.getProviderConnectionAvailability.mockResolvedValue({ available: true });
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

  it("switches accounts and rebinds after the pinned account returns model-not-found", async () => {
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
        response: new Response("provider model not found", { status: 404 }),
      })
      .mockResolvedValueOnce({
        success: true,
        response: new Response("fallback account ok"),
      });
    const request = new Request("http://router.test/v1/chat/completions", {
      method: "POST",
      headers: { "content-type": "application/json", "thread-id": "thread-404" },
      body: JSON.stringify({ model: "openai/gpt-test", messages: [] }),
    });

    const response = await handleChat(request);

    expect(response.status).toBe(200);
    await expect(response.text()).resolves.toBe("fallback account ok");
    expect(mocks.getProviderCredentials).toHaveBeenCalledTimes(2);
    expect(mocks.getProviderCredentials).toHaveBeenNthCalledWith(
      1,
      "openai",
      expect.any(Set),
      "gpt-test",
      { preferredConnectionId: boundConnection, sessionKey: "session-affinity-chat" },
    );
    expect(mocks.markAccountUnavailable).toHaveBeenCalledTimes(1);
    expect(mocks.bindRoute).toHaveBeenLastCalledWith(
      "session-affinity-chat",
      "openai/gpt-test",
      expect.objectContaining({ connectionId: "connection-fallback" }),
      { allowRebind: true, rebindReason: "retryable_provider_failure" },
    );
    expect(binding).toMatchObject({ connectionId: boundConnection, routeEpoch: 7 });
  });

  it("falls back and rebinds a pinned combo after its bound model returns 404", async () => {
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
      .mockResolvedValueOnce(null)
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
        response: new Response("combo fallback"),
      });
    mocks.run.mockImplementation(async (_identity, _model, operation) => operation({ ...pinnedBinding }));
    const request = new Request("http://router.test/v1/chat/completions", {
      method: "POST",
      headers: { "content-type": "application/json", "thread-id": "thread-combo-404" },
      body: JSON.stringify({ model: "pinned-combo", messages: [] }),
    });

    const response = await handleChat(request);

    expect(response.status).toBe(200);
    await expect(response.text()).resolves.toBe("combo fallback");
    expect(mocks.getProviderCredentials).toHaveBeenCalledTimes(3);
    expect(mocks.handleChatCore).toHaveBeenCalledTimes(2);
    expect(mocks.bindRoute).toHaveBeenCalledTimes(2);
    expect(mocks.bindRoute).toHaveBeenLastCalledWith(
      "session-affinity-chat",
      "pinned-combo",
      expect.objectContaining({ connectionId: "connection-fallback" }),
      { allowRebind: true, rebindReason: "combo_eligible_fallback" },
    );
    expect(pinnedBinding).toMatchObject({ connectionId: boundConnection, routeEpoch: 7 });
  });

  it("runs a fusion combo inside the affinity lane instead of rejecting it", async () => {
    mocks.getSettings.mockResolvedValue({
      requireApiKey: false,
      comboStrategies: { "fusion-combo": { fallbackStrategy: "fusion" } },
    });
    mocks.getComboModels.mockResolvedValue(["openai/gpt-test", "anthropic/claude-test"]);
    mocks.handleFusionChat.mockResolvedValue(new Response("fusion ok"));
    const request = new Request("http://router.test/v1/responses", {
      method: "POST",
      headers: { "content-type": "application/json", "thread-id": "thread-fusion" },
      body: JSON.stringify({ model: "fusion-combo", input: "hello" }),
    });

    const response = await handleChat(request);

    expect(response.status).toBe(200);
    await expect(response.text()).resolves.toBe("fusion ok");
    expect(mocks.handleFusionChat).toHaveBeenCalledTimes(1);
  });

  it("uses the canonical combo identity for alias strategy, affinity, and fusion settings", async () => {
    mocks.resolveComboName.mockImplementation((model) => (
      model === "kimi-k2.6-code" ? "kimi-k2.6-cb" : model
    ));
    mocks.getSettings.mockResolvedValue({
      requireApiKey: false,
      comboStrategies: {
        "kimi-k2.6-cb": {
          fallbackStrategy: "fusion",
          judgeModel: "openai/judge",
          fusionTuning: { minPanel: 1 },
        },
      },
    });
    mocks.getComboModels.mockResolvedValue(["openai/gpt-test", "anthropic/claude-test"]);
    mocks.handleFusionChat.mockResolvedValue(new Response("canonical fusion ok"));
    const request = new Request("http://router.test/v1/responses", {
      method: "POST",
      headers: { "content-type": "application/json", "thread-id": "thread-alias-fusion" },
      body: JSON.stringify({ model: "kimi-k2.6-code", input: "hello" }),
    });

    const response = await handleChat(request);

    expect(response.status).toBe(200);
    await expect(response.text()).resolves.toBe("canonical fusion ok");
    expect(mocks.run).toHaveBeenCalledWith(
      expect.any(Object),
      "kimi-k2.6-cb",
      expect.any(Function),
    );
    expect(mocks.handleFusionChat).toHaveBeenCalledWith(expect.objectContaining({
      comboName: "kimi-k2.6-cb",
      judgeModel: "openai/judge",
      tuning: { minPanel: 1 },
    }));
  });

  it("continues a fallback combo when every account for its first model is exhausted", async () => {
    // Given
    mocks.isCodexThreadAffinityEnabled.mockReturnValue(false);
    mocks.getComboModels.mockResolvedValue(["provider-a/model-a", "provider-b/model-b"]);
    mocks.getModelInfo.mockImplementation(async (model) => {
      const [provider, modelName] = model.split("/");
      return { provider, model: modelName };
    });
    mocks.getProviderCredentials
      .mockReset()
      .mockResolvedValueOnce({
        connectionId: "provider-a-account",
        connectionName: "provider-a account",
        accessToken: "test-token",
        providerSpecificData: {},
      })
      .mockResolvedValueOnce({
        allRateLimited: true,
        retryAfter: new Date(Date.now() + 60_000).toISOString(),
        retryAfterHuman: "reset after 1m",
        lastError: "All accounts unavailable",
        lastErrorCode: 400,
      })
      .mockResolvedValueOnce({
        connectionId: "provider-b-account",
        connectionName: "provider-b account",
        accessToken: "test-token",
        providerSpecificData: {},
      });
    mocks.handleChatCore
      .mockReset()
      .mockResolvedValueOnce({
        success: false,
        status: 400,
        error: "All accounts unavailable",
        response: new Response("provider-a accounts unavailable", { status: 400 }),
      })
      .mockResolvedValueOnce({
        success: true,
        response: new Response("provider-b fallback ok"),
      });
    mocks.markAccountUnavailable.mockResolvedValue({ shouldFallback: true });
    const request = new Request("http://router.test/v1/chat/completions", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ model: "quota-combo", messages: [] }),
    });

    // When
    const response = await handleChat(request);

    // Then
    expect(response.status).toBe(200);
    await expect(response.text()).resolves.toBe("provider-b fallback ok");
    expect(mocks.getProviderCredentials).toHaveBeenCalledTimes(3);
    expect(mocks.getProviderCredentials).toHaveBeenNthCalledWith(
      3,
      "provider-b",
      expect.any(Set),
      "model-b",
      { preferredConnectionId: null, sessionKey: null },
    );
    expect(mocks.handleChatCore).toHaveBeenCalledTimes(2);
  });

  it("retries only the same NVIDIA account once before moving to account fallback", async () => {
    mocks.isCodexThreadAffinityEnabled.mockReturnValue(false);
    mocks.handleChatCore
      .mockReset()
      .mockResolvedValueOnce({
        success: false,
        status: 504,
        error: "[504]: NVIDIA function invocation timed out",
        disposition: { retryMode: "same_target_once", cooldownMs: 5_000 },
        response: new Response("timeout", { status: 504 }),
      })
      .mockResolvedValueOnce({
        success: true,
        response: new Response("nvidia retry ok"),
      });
    const request = new Request("http://router.test/v1/chat/completions", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ model: "openai/gpt-test", messages: [] }),
    });

    const response = await handleChat(request);

    expect(response.status).toBe(200);
    await expect(response.text()).resolves.toBe("nvidia retry ok");
    expect(mocks.getProviderCredentials).toHaveBeenCalledTimes(1);
    expect(mocks.handleChatCore).toHaveBeenCalledTimes(2);
    expect(mocks.markAccountUnavailable).not.toHaveBeenCalled();
  });

  it("reselects an account that became unavailable before its endpoint dispatch", async () => {
    mocks.isCodexThreadAffinityEnabled.mockReturnValue(false);
    mocks.getProviderCredentials
      .mockReset()
      .mockResolvedValueOnce({
        connectionId: "connection-stale",
        connectionName: "stale-account",
        accessToken: "test-token",
        providerSpecificData: {},
      })
      .mockResolvedValueOnce({
        connectionId: "connection-fresh",
        connectionName: "fresh-account",
        accessToken: "fresh-token",
        providerSpecificData: {},
      });
    mocks.getProviderConnectionAvailability
      .mockResolvedValueOnce({ available: false, reason: "quota" })
      .mockResolvedValueOnce({ available: true });
    mocks.handleChatCore
      .mockReset()
      .mockImplementationOnce(async ({ onBeforeUpstreamDispatch }) => {
        try {
          await onBeforeUpstreamDispatch();
        } catch (error) {
          return {
            success: false,
            status: 503,
            error: error.message,
            errorCode: error.code,
            response: new Response(error.message, { status: 503 }),
          };
        }
        throw new Error("expected final account recheck to reject the stale account");
      })
      .mockImplementationOnce(async ({ onBeforeUpstreamDispatch }) => {
        await onBeforeUpstreamDispatch();
        return { success: true, response: new Response("fresh account ok") };
      });
    const request = new Request("http://router.test/v1/chat/completions", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ model: "openai/gpt-test", messages: [] }),
    });

    const response = await handleChat(request);

    expect(response.status).toBe(200);
    await expect(response.text()).resolves.toBe("fresh account ok");
    expect(mocks.getProviderCredentials).toHaveBeenCalledTimes(2);
    expect(mocks.getProviderConnectionAvailability).toHaveBeenCalledWith("openai", "connection-stale", "gpt-test");
    expect(mocks.getProviderConnectionAvailability).toHaveBeenCalledWith("openai", "connection-fresh", "gpt-test");
    expect(mocks.markAccountUnavailable).not.toHaveBeenCalled();
  });

  it("returns a Gemini continuity routing failure without poisoning account fallback", async () => {
    mocks.isCodexThreadAffinityEnabled.mockReturnValue(false);
    mocks.getModelInfo.mockResolvedValue({ provider: "gemini", model: "gemini-2.5-pro" });
    mocks.handleChatCore.mockResolvedValue({
      success: false,
      routingFailure: true,
      status: 400,
      errorCode: "gemini_thought_signature_missing",
      response: new Response("signature required", { status: 400 }),
    });
    const request = new Request("http://router.test/v1/chat/completions", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ model: "gemini/gemini-2.5-pro", messages: [] }),
    });

    const response = await handleChat(request);

    expect(response.status).toBe(400);
    expect(mocks.markAccountUnavailable).not.toHaveBeenCalled();
  });
});

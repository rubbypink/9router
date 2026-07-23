import "open-sse/index.js";

import {
  getProviderCredentials,
  getProviderModelAvailability,
  markAccountUnavailable,
  clearAccountError,
  extractApiKey,
  isValidApiKey,
} from "../services/auth.js";
import { cacheClaudeHeaders } from "open-sse/utils/claudeHeaderCache.js";
import { getSettings } from "@/lib/localDb";
import { getModelInfo, getComboModels } from "../services/model.js";
import { handleChatCore } from "open-sse/handlers/chatCore.js";
import { DEFAULT_HEADROOM_URL } from "@/lib/headroom/detect";
import { getTransform as getPxpipeTransform } from "@/lib/pxpipe/loader.js";
import { appendPxpipeEvent } from "@/lib/pxpipe/events.js";
import { errorResponse, unavailableResponse } from "open-sse/utils/error.js";
import { handleComboChat, handleFusionChat } from "open-sse/services/combo.js";
import { handleBypassRequest } from "open-sse/utils/bypassHandler.js";
import { HTTP_STATUS } from "open-sse/config/runtimeConfig.js";
import { ACCOUNT_EXHAUSTED_ERROR_CODE } from "open-sse/config/errorConfig.js";
import { detectFormatByEndpoint } from "open-sse/translator/formats.js";
import * as log from "../utils/logger.js";
import { updateProviderCredentials, checkAndRefreshToken } from "../services/tokenRefresh.js";
import { getProjectIdForConnection } from "open-sse/services/projectId.js";
import { resolveThreadIdentity } from "open-sse/utils/threadIdentity.js";
import {
  isCodexThreadAffinityEnabled,
  threadRouteCoordinator,
} from "open-sse/services/threadRouteCoordinator.js";
import {
  createUpstreamRequestState,
  runWithUpstreamRequestState,
} from "open-sse/services/requestExecutionState.js";

function markAffinityComboFallback(routeContext) {
  if (!routeContext) return;
  routeContext.allowRebind = true;
  routeContext.rebindReason = "combo_eligible_fallback";
}

function prepareAffinityComboRoute(routeContext, comboModels) {
  const pinnedModel = routeContext?.binding?.model;
  if (pinnedModel && !comboModels.includes(pinnedModel)) markAffinityComboFallback(routeContext);
}

async function getComboModelAvailability(modelStr) {
  const modelInfo = await getModelInfo(modelStr);
  if (!modelInfo?.provider) return { available: true };
  return getProviderModelAvailability(modelInfo.provider, modelInfo.model);
}

function markAffinityComboSelection(routeContext, comboStrategy, model) {
  if (!routeContext || comboStrategy !== "round-robin" || routeContext.binding?.model === model) return;
  routeContext.allowRebind = true;
  routeContext.rebindReason = "combo_round_robin";
}

/**
 * Handle chat completion request
 * Supports: OpenAI, Claude, Gemini, OpenAI Responses API formats
 * Format detection and translation handled by translator
 */
export async function handleChat(request, clientRawRequest = null) {
  let body;
  try {
    body = await request.json();
  } catch {
    log.warn("CHAT", "Invalid JSON body");
    return errorResponse(HTTP_STATUS.BAD_REQUEST, "Invalid JSON body");
  }

  // Build clientRawRequest for logging (if not provided)
  if (!clientRawRequest) {
    const url = new URL(request.url);
    clientRawRequest = {
      endpoint: url.pathname,
      body,
      headers: Object.fromEntries(request.headers.entries())
    };
  }
  cacheClaudeHeaders(clientRawRequest.headers);

  const modelStr = body.model;

  // Request summary is emitted as the unified "▶" line in chatCore (has fmt/thinking/account)

  // Log API key (masked)
  const authHeader = request.headers.get("Authorization");
  const apiKey = extractApiKey(request);
  if (authHeader && apiKey) {
    const masked = log.maskKey(apiKey);
    log.debug("AUTH", `API Key: ${masked}`);
  } else {
    log.debug("AUTH", "No API key provided (local mode)");
  }

  // Enforce API key if enabled in settings
  const settings = await getSettings();
  if (settings.requireApiKey) {
    if (!apiKey) {
      log.warn("AUTH", "Missing API key (requireApiKey=true)");
      return errorResponse(HTTP_STATUS.UNAUTHORIZED, "Missing API key");
    }
    const valid = await isValidApiKey(apiKey);
    if (!valid) {
      log.warn("AUTH", "Invalid API key (requireApiKey=true)");
      return errorResponse(HTTP_STATUS.UNAUTHORIZED, "Invalid API key");
    }
  }

  if (!modelStr) {
    log.warn("CHAT", "Missing model");
    return errorResponse(HTTP_STATUS.BAD_REQUEST, "Missing model");
  }

  // Bypass naming/warmup requests before combo rotation to avoid wasting rotation slots
  const userAgent = request?.headers?.get("user-agent") || "";
  const bypassResponse = handleBypassRequest(body, modelStr, userAgent, !!settings.ccFilterNaming);
  if (bypassResponse) return bypassResponse.response || bypassResponse;

  const dispatch = async (routeContext = null) => {
    const comboModels = await getComboModels(modelStr);
    if (comboModels) {
      const comboStrategies = settings.comboStrategies || {};
      const comboSpecificStrategy = comboStrategies[modelStr]?.fallbackStrategy;
      const comboStrategy = comboSpecificStrategy || settings.comboStrategy || "fallback";

      if (comboStrategy === "fusion") {
        log.info("CHAT", `Combo "${modelStr}" with ${comboModels.length} models (strategy: fusion)`);
        return handleFusionChat({
          body,
          models: comboModels,
          handleSingleModel: (b, m, isPanel) => {
            let cleanRawReq = clientRawRequest;
            if (isPanel && clientRawRequest) {
              const { tools, tool_choice, ...cleanBody } = clientRawRequest.body || {};
              cleanRawReq = { ...clientRawRequest, body: cleanBody };
            }
            return handleSingleModelChat(b, m, cleanRawReq, request, apiKey, null);
          },
          log,
          comboName: modelStr,
          judgeModel: comboStrategies[modelStr]?.judgeModel,
          tuning: comboStrategies[modelStr]?.fusionTuning,
        });
      }

      prepareAffinityComboRoute(routeContext, comboModels);
      const comboStickyLimit = settings.comboStickyRoundRobinLimit;
      log.info("CHAT", `Combo "${modelStr}" with ${comboModels.length} models (strategy: ${comboStrategy}, sticky: ${comboStickyLimit})`);
      return handleComboChat({
        body,
        models: comboModels,
        handleSingleModel: (b, m) => handleSingleModelChat(b, m, clientRawRequest, request, apiKey, routeContext),
        log,
        comboName: modelStr,
        comboStrategy,
        comboStickyLimit,
        preferredModel: routeContext?.binding?.model || null,
        getModelAvailability: getComboModelAvailability,
        onModelSelected: ({ model }) => markAffinityComboSelection(routeContext, comboStrategy, model),
        onEligibleFallback: () => markAffinityComboFallback(routeContext),
      });
    }

    return handleSingleModelChat(body, modelStr, clientRawRequest, request, apiKey, routeContext);
  };

  return runWithUpstreamRequestState(createUpstreamRequestState(), async () => {
    if (!isCodexThreadAffinityEnabled()) return dispatch();

    try {
      const identity = resolveThreadIdentity({ headers: request.headers, body });
      if (!identity) return dispatch();
      return await threadRouteCoordinator.run(identity, modelStr, (binding) => dispatch({
        coordinator: threadRouteCoordinator,
        sessionKey: identity.sessionKey,
        legacySessionKey: identity.legacySessionKey,
        requestedModel: modelStr,
        binding,
        allowRebind: false,
        rebindReason: null,
      }));
    } catch (error) {
      const status = Number.isInteger(error?.status) ? error.status : 500;
      log.warn("THREAD", error?.code || "thread_route_error");
      return errorResponse(
        status,
        error?.message || "Codex thread routing failed",
        error?.code || "thread_route_error",
      );
    }
  });
}

/**
 * Handle single model chat request
 */
async function handleSingleModelChat(body, modelStr, clientRawRequest = null, request = null, apiKey = null, routeContext = null) {
  const modelInfo = await getModelInfo(modelStr);

  // If provider is null, this might be a combo name - check and handle
  if (!modelInfo.provider) {
    const comboModels = await getComboModels(modelStr);
    if (comboModels) {
      const chatSettings = await getSettings();
      // Check for combo-specific strategy first, fallback to global
      const comboStrategies = chatSettings.comboStrategies || {};
      const comboSpecificStrategy = comboStrategies[modelStr]?.fallbackStrategy;
      const comboStrategy = comboSpecificStrategy || chatSettings.comboStrategy || "fallback";

      if (comboStrategy === "fusion") {
        log.info("CHAT", `Combo "${modelStr}" with ${comboModels.length} models (strategy: fusion)`);
        return handleFusionChat({
          body,
          models: comboModels,
          handleSingleModel: (b, m, isPanel) => {
            let cleanRawReq = clientRawRequest;
            if (isPanel && clientRawRequest) {
              const { tools, tool_choice, ...cleanBody } = clientRawRequest.body || {};
              cleanRawReq = { ...clientRawRequest, body: cleanBody };
            }
            return handleSingleModelChat(b, m, cleanRawReq, request, apiKey, null);
          },
          log,
          comboName: modelStr,
          judgeModel: comboStrategies[modelStr]?.judgeModel,
          tuning: comboStrategies[modelStr]?.fusionTuning,
        });
      }

      prepareAffinityComboRoute(routeContext, comboModels);
      const comboStickyLimit = chatSettings.comboStickyRoundRobinLimit;
      log.info("CHAT", `Combo "${modelStr}" with ${comboModels.length} models (strategy: ${comboStrategy}, sticky: ${comboStickyLimit})`);
      return handleComboChat({
        body,
        models: comboModels,
        handleSingleModel: (b, m) => handleSingleModelChat(b, m, clientRawRequest, request, apiKey, routeContext),
        log,
        comboName: modelStr,
        comboStrategy,
        comboStickyLimit,
        preferredModel: routeContext?.binding?.model || null,
        getModelAvailability: getComboModelAvailability,
        onModelSelected: ({ model }) => markAffinityComboSelection(routeContext, comboStrategy, model),
        onEligibleFallback: () => markAffinityComboFallback(routeContext),
      });
    }
    log.warn("CHAT", "Invalid model format", { model: modelStr });
    return errorResponse(HTTP_STATUS.BAD_REQUEST, "Invalid model format");
  }

  const { provider, model } = modelInfo;

  // Routing shown in the unified "▶" line (client model → provider/model)

  // Extract userAgent from request
  const userAgent = request?.headers?.get("user-agent") || "";

  // Try with available accounts (fallback on errors)
  const excludeConnectionIds = new Set();
  let lastError = null;
  let lastStatus = null;
  const resolvedRouteModel = `${provider}/${model}`;

  while (true) {
    const preferredConnectionId = routeContext?.coordinator
      .getConnectionBinding(routeContext.sessionKey, provider)?.connectionId || null;
    const credentials = await getProviderCredentials(provider, excludeConnectionIds, model, {
      preferredConnectionId,
      sessionKey: routeContext?.sessionKey || null,
    });

    // All accounts unavailable
    if (!credentials || credentials.allRateLimited) {
      if (credentials?.allRateLimited) {
        const errorMsg = lastError || credentials.lastError || "Unavailable";
        const status = lastStatus || Number(credentials.lastErrorCode) || HTTP_STATUS.SERVICE_UNAVAILABLE;
        log.warn("CHAT", `[${provider}/${model}] ${errorMsg} (${credentials.retryAfterHuman})`);
        return unavailableResponse(
          status,
          `[${provider}/${model}] ${errorMsg}`,
          credentials.retryAfter,
          credentials.retryAfterHuman,
          ACCOUNT_EXHAUSTED_ERROR_CODE,
        );
      }
      if (excludeConnectionIds.size === 0) {
        log.warn("AUTH", `No active credentials for provider: ${provider}`);
        return errorResponse(HTTP_STATUS.NOT_FOUND, `No active credentials for provider: ${provider}`);
      }
      log.warn("CHAT", "No more accounts available", { provider });
      return errorResponse(
        lastStatus || HTTP_STATUS.SERVICE_UNAVAILABLE,
        lastError || "All accounts unavailable",
        ACCOUNT_EXHAUSTED_ERROR_CODE,
      );
    }

    if (preferredConnectionId && credentials.connectionId !== preferredConnectionId && !routeContext?.allowRebind) {
      routeContext.allowRebind = true;
      routeContext.rebindReason = "bound_connection_unavailable";
    }

    const selectedRoute = {
      providerId: provider,
      model: modelStr,
      resolvedModel: resolvedRouteModel,
      connectionId: credentials.connectionId,
    };
    if (routeContext) {
      try {
        routeContext.coordinator.bindRoute(
          routeContext.sessionKey,
          routeContext.requestedModel,
          selectedRoute,
          {
            allowRebind: routeContext.allowRebind,
            rebindReason: routeContext.rebindReason,
          },
        );
      } catch (error) {
        return errorResponse(error.status || 409, error.message, error.code);
      }
    }

    // Account selection shown in the unified "▶" line (acc:...)
    const refreshedCredentials = await checkAndRefreshToken(provider, credentials);

    // Ensure real project ID is available for providers that need it (P0 fix: cold miss)
    if ((provider === "antigravity" || provider === "gemini-cli") && !refreshedCredentials.projectId) {
      const pid = await getProjectIdForConnection(credentials.connectionId, refreshedCredentials.accessToken);
      if (pid) {
        refreshedCredentials.projectId = pid;
        // Persist to DB in background so subsequent requests have it immediately
        updateProviderCredentials(credentials.connectionId, { projectId: pid }).catch(() => { });
      }
    }

    // Use shared chatCore
    const chatSettings = await getSettings();
    const providerThinking = (chatSettings.providerThinking || {})[provider] || null;
    const result = await handleChatCore({
      body: { ...body, model: `${provider}/${model}` },
      modelInfo: { provider, model },
      credentials: refreshedCredentials,
      log,
      clientRawRequest,
      connectionId: credentials.connectionId,
      userAgent,
      apiKey,
      ccFilterNaming: !!chatSettings.ccFilterNaming,
      rtkEnabled: !!chatSettings.rtkEnabled,
      headroomEnabled: !!chatSettings.headroomEnabled,
      headroomUrl: chatSettings.headroomUrl || DEFAULT_HEADROOM_URL,
      headroomCompressUserMessages: !!chatSettings.headroomCompressUserMessages,
      cavemanEnabled: !!chatSettings.cavemanEnabled,
      cavemanLevel: chatSettings.cavemanLevel || "full",
      ponytailEnabled: !!chatSettings.ponytailEnabled,
      ponytailLevel: chatSettings.ponytailLevel || "full",
      pxpipeEnabled: !!chatSettings.pxpipeEnabled,
      pxpipeMinChars: chatSettings.pxpipeMinChars,
      pxpipeTimeoutMs: chatSettings.pxpipeTimeoutMs,
      // Lazily warms the in-process module on first use; null when not installed (fail-open)
      pxpipeTransform: chatSettings.pxpipeEnabled ? await getPxpipeTransform() : null,
      onPxpipeEvent: appendPxpipeEvent,
      providerThinking,
      // Detect source format by endpoint + body
      sourceFormatOverride: request?.url ? detectFormatByEndpoint(new URL(request.url).pathname, body) : null,
      onCredentialsRefreshed: async (newCreds) => {
        await updateProviderCredentials(credentials.connectionId, {
          ...newCreds,
          existingProviderSpecificData: credentials.providerSpecificData,
          testStatus: "active"
        });
      },
      onRequestSuccess: async () => {
        if (routeContext) {
          routeContext.coordinator.markSuccess(
            routeContext.sessionKey,
            routeContext.requestedModel,
            selectedRoute,
          );
        }
        await clearAccountError(credentials.connectionId, credentials, model);
      }
    });

    if (result.success || result.routingFailure) return result.response;

    // Mark account unavailable (auto-calculates cooldown with exponential backoff, or precise resetsAtMs)
    const { shouldFallback } = await markAccountUnavailable(
      credentials.connectionId,
      result.status,
      result.error,
      provider,
      model,
      result.resetsAtMs,
      { errorCode: result.errorCode },
    );

    if (shouldFallback) {
      if (routeContext) {
        routeContext.allowRebind = true;
        routeContext.rebindReason = "retryable_provider_failure";
      }
      log.warn("FALLBACK", `⇄ ACC:${credentials.connectionName} UNAVAILABLE (${result.status}) → NEXT ACCOUNT`);
      excludeConnectionIds.add(credentials.connectionId);
      lastError = result.error;
      lastStatus = result.status;
      continue;
    }

    return result.response;
  }
}

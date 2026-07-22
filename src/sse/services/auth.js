import { getProviderConnections, validateApiKey, updateProviderConnection, getSettings, getProxyPools } from "@/lib/localDb";
import { resolveConnectionProxyConfig, pickProxyPoolId } from "@/lib/network/connectionProxy";
import { formatRetryAfter, checkFallbackError, isModelLockActive, buildModelLockUpdate, getEarliestModelLockUntil, getModelLockKey } from "open-sse/services/accountFallback.js";
import { ACCOUNT_HEALTH_CONFIG } from "open-sse/config/errorConfig.js";
import { resolveQuotaPolicy } from "open-sse/config/quotaPolicy.js";
import { resolveProviderId, FREE_PROVIDERS } from "@/shared/constants/providers.js";
import * as log from "../utils/logger.js";

// Mutex to prevent race conditions during account selection
let selectionMutex = Promise.resolve();

const ACCOUNT_HEALTH_VERSION = 2;
const ACCOUNT_HEALTH_ALL_MODELS = "__all";

function healthModelKey(model) {
  return model || ACCOUNT_HEALTH_ALL_MODELS;
}

function activeLockKeys(connection, now = Date.now()) {
  return Object.keys(connection || {}).filter(key => (
    key.startsWith("modelLock_") && new Date(connection[key]).getTime() > now
  ));
}

function expiredLockKeys(connection, now = Date.now()) {
  return Object.keys(connection || {}).filter(key => {
    if (!key.startsWith("modelLock_") || !connection[key]) return false;
    const expiry = new Date(connection[key]).getTime();
    return !Number.isFinite(expiry) || expiry <= now;
  });
}

function accountHealthReason(status, errorText) {
  const text = typeof errorText === "string" ? errorText.toLowerCase() : "";
  if (status === 429 || /quota|rate limit|too many requests|capacity/.test(text)) return "quota";
  if ([401, 402, 403].includes(status)) return "credentials";
  if (status >= 500 || /timeout|overload|temporarily unavailable/.test(text)) return "transient";
  return "provider";
}

function currentAccountHealth(connection) {
  const health = connection?.accountHealth;
  if (!health || typeof health !== "object" || Array.isArray(health)) return null;
  const models = health.models && typeof health.models === "object" && !Array.isArray(health.models)
    ? health.models
    : {};
  const recentErrors = Array.isArray(health.recentErrors) ? health.recentErrors : [];
  return { health, models, recentErrors };
}

function recordAccountHealth(connection, { model, status, errorCode, reason, retryAt, source, quotaPolicy, now }) {
  const current = currentAccountHealth(connection);
  const models = { ...(current?.models || {}) };
  const observedAt = new Date(now).toISOString();
  const entry = {
    state: "unavailable",
    reason: accountHealthReason(status, reason),
    status,
    errorCode: errorCode || null,
    observedAt,
    retryAt,
    source,
    quotaPolicy,
    message: reason.slice(0, ACCOUNT_HEALTH_CONFIG.errorMessageLimit),
  };
  models[healthModelKey(model)] = entry;
  const recentErrors = [
    ...(current?.recentErrors || []),
    { ...entry, model: model || null },
  ].slice(-ACCOUNT_HEALTH_CONFIG.historyLimit);
  return {
    version: ACCOUNT_HEALTH_VERSION,
    updatedAt: observedAt,
    models,
    recentErrors,
  };
}

function clearExpiredAccountHealth(connection, clearedLockKeys = [], now = Date.now()) {
  const current = currentAccountHealth(connection);
  if (!current) return { changed: false, value: null };

  const clearedModels = new Set(clearedLockKeys.map(key => key.slice("modelLock_".length)));
  const models = {};
  let changed = current.health.version !== ACCOUNT_HEALTH_VERSION;
  for (const [model, value] of Object.entries(current.models)) {
    const retryAt = new Date(value?.retryAt).getTime();
    if (clearedModels.has(model) || !Number.isFinite(retryAt) || retryAt <= now) {
      changed = true;
      continue;
    }
    models[model] = value;
  }

  const recentErrors = current.recentErrors.slice(-ACCOUNT_HEALTH_CONFIG.historyLimit);
  if (recentErrors.length !== current.recentErrors.length) changed = true;
  if (!changed) return { changed: false, value: current.health };
  return {
    changed: true,
    value: {
      version: ACCOUNT_HEALTH_VERSION,
      updatedAt: new Date(now).toISOString(),
      models,
      recentErrors,
    },
  };
}

function accountRecoveryUpdate(connection, extraClearedLockKeys = [], now = Date.now()) {
  const expired = expiredLockKeys(connection, now);
  const clearedLockKeys = [...new Set([...expired, ...extraClearedLockKeys])];
  const update = Object.fromEntries(clearedLockKeys.map(key => [key, null]));
  const health = clearExpiredAccountHealth(connection, clearedLockKeys, now);
  if (health.changed) update.accountHealth = health.value;

  if (activeLockKeys(connection, now).filter(key => !clearedLockKeys.includes(key)).length === 0) {
    if (connection.testStatus === "unavailable" || connection.lastError || connection.lastErrorAt || connection.errorCode || connection.backoffLevel) {
      Object.assign(update, {
        testStatus: "active",
        lastError: null,
        lastErrorAt: null,
        errorCode: null,
        backoffLevel: 0,
      });
    }
  }
  return update;
}

async function reconcileConnectionAvailability(connection) {
  const update = accountRecoveryUpdate(connection);
  if (Object.keys(update).length === 0) return connection;
  return (await updateProviderConnection(connection.id, update)) || { ...connection, ...update };
}

export async function reconcileAccountHealth() {
  const connections = await getProviderConnections({ isActive: true });
  let reconciled = 0;
  for (const connection of connections) {
    const update = accountRecoveryUpdate(connection);
    if (Object.keys(update).length === 0) continue;
    await updateProviderConnection(connection.id, update);
    reconciled++;
  }
  return { checked: connections.length, reconciled };
}

/**
 * Get provider credentials from localDb
 * Filters out unavailable accounts and returns the selected account based on strategy
 * @param {string} provider - Provider name
 * @param {Set<string>|string|null} excludeConnectionIds - Connection ID(s) to exclude (for retry with next account)
 * @param {string|null} model - Model name for per-model rate limit filtering
 */
export async function getProviderCredentials(provider, excludeConnectionIds = null, model = null, options = {}) {
  // Normalize to Set for consistent handling
  const excludeSet = excludeConnectionIds instanceof Set
    ? excludeConnectionIds
    : (excludeConnectionIds ? new Set([excludeConnectionIds]) : new Set());
  const preferredConnectionId = options?.preferredConnectionId || null;
  // Acquire mutex to prevent race conditions
  const currentMutex = selectionMutex;
  let resolveMutex;
  selectionMutex = new Promise(resolve => { resolveMutex = resolve; });

  try {
    await currentMutex;

    // Resolve alias to provider ID (e.g., "kc" -> "kilocode")
    const providerId = resolveProviderId(provider);

    // Inject a virtual connection for no-auth free providers (with optional proxy pool from settings)
    if (FREE_PROVIDERS[providerId]?.noAuth) {
      const settings = await getSettings();
      const override = (settings.providerStrategies || {})[providerId] || {};
      const strategy = override.rotateStrategy || "none";
      let pickedId = override.proxyPoolId || null;
      if (strategy !== "none") {
        const allPools = await getProxyPools({ isActive: true });
        const poolIds = allPools.filter(p => p.proxyUrl).map(p => p.id);
        pickedId = pickProxyPoolId(poolIds, strategy, providerId);
      }
      const resolvedProxy = await resolveConnectionProxyConfig({ proxyPoolId: pickedId || "" });
      return {
        id: "noauth",
        connectionName: "Public",
        isActive: true,
        accessToken: "public",
        providerSpecificData: {
          connectionProxyEnabled: resolvedProxy.connectionProxyEnabled,
          connectionProxyUrl: resolvedProxy.connectionProxyUrl,
          connectionNoProxy: resolvedProxy.connectionNoProxy,
          connectionProxyPoolId: resolvedProxy.proxyPoolId || null,
          vercelRelayUrl: resolvedProxy.vercelRelayUrl || "",
        },
      };
    }

    const storedConnections = await getProviderConnections({ provider: providerId, isActive: true });
    const connections = [];
    for (const storedConnection of storedConnections) {
      connections.push(await reconcileConnectionAvailability(storedConnection));
    }
    log.debug("AUTH", `${provider} | total connections: ${connections.length}, excludeIds: ${excludeSet.size > 0 ? [...excludeSet].join(",") : "none"}, model: ${model || "any"}`);

    if (connections.length === 0) {
      log.warn("AUTH", `No credentials for ${provider}`);
      return null;
    }

    // Filter out model-locked and excluded connections
    const availableConnections = connections.filter(c => {
      if (excludeSet.has(c.id)) return false;
      if (isModelLockActive(c, model)) return false;
      return true;
    });

    log.debug("AUTH", `${provider} | available: ${availableConnections.length}/${connections.length}`);
    connections.forEach(c => {
      const excluded = excludeSet.has(c.id);
      const locked = isModelLockActive(c, model);
      if (excluded || locked) {
        const lockUntil = getEarliestModelLockUntil(c);
        log.debug("AUTH", `  → ${c.id?.slice(0, 8)} | ${excluded ? "excluded" : ""} ${locked ? `modelLocked(${model}) until ${lockUntil}` : ""}`);
      }
    });

    if (availableConnections.length === 0) {
      // Find earliest lock expiry across all connections for retry timing
      const lockedConns = connections.filter(c => isModelLockActive(c, model));
      const expiries = lockedConns.map(c => getEarliestModelLockUntil(c)).filter(Boolean);
      const earliest = expiries.sort()[0] || null;
      if (earliest) {
        const earliestConn = lockedConns[0];
        log.warn("AUTH", `${provider} | all ${connections.length} accounts locked for ${model || "all"} (${formatRetryAfter(earliest)}) | lastError=${earliestConn?.lastError?.slice(0, 50)}`);
        return {
          allRateLimited: true,
          retryAfter: earliest,
          retryAfterHuman: formatRetryAfter(earliest),
          lastError: earliestConn?.lastError || null,
          lastErrorCode: earliestConn?.errorCode || null
        };
      }
      log.warn("AUTH", `${provider} | all ${connections.length} accounts unavailable`);
      return null;
    }

    const settings = await getSettings();
    // Per-provider strategy overrides global setting
    const providerOverride = (settings.providerStrategies || {})[providerId] || {};
    const strategy = providerOverride.fallbackStrategy || settings.fallbackStrategy || "fill-first";

    let connection;
    // Pin to preferred connection if specified and available
    if (preferredConnectionId) {
      connection = availableConnections.find((c) => c.id === preferredConnectionId);
      if (connection) {
        log.info("AUTH", `${provider} | pinned to ${connection.id?.slice(0, 8)} (${connection.name || connection.email || "unnamed"})`);
      }
    }
    if (connection) {
      // skip strategy
    } else if (strategy === "round-robin") {
      const stickyLimit = providerOverride.stickyRoundRobinLimit || settings.stickyRoundRobinLimit || 3;

      // Sort by lastUsed (most recent first) to find current candidate
      const byRecency = [...availableConnections].sort((a, b) => {
        if (!a.lastUsedAt && !b.lastUsedAt) return (a.priority || 999) - (b.priority || 999);
        if (!a.lastUsedAt) return 1;
        if (!b.lastUsedAt) return -1;
        return new Date(b.lastUsedAt) - new Date(a.lastUsedAt);
      });

      const current = byRecency[0];
      const currentCount = current?.consecutiveUseCount || 0;

      if (current && current.lastUsedAt && currentCount < stickyLimit) {
        // Stay with current account
        connection = current;
        // Update lastUsedAt and increment count (await to ensure persistence)
        await updateProviderConnection(connection.id, {
          lastUsedAt: new Date().toISOString(),
          consecutiveUseCount: (connection.consecutiveUseCount || 0) + 1
        });
      } else {
        // Pick the least recently used (excluding current if possible)
        const sortedByOldest = [...availableConnections].sort((a, b) => {
          if (!a.lastUsedAt && !b.lastUsedAt) return (a.priority || 999) - (b.priority || 999);
          if (!a.lastUsedAt) return -1;
          if (!b.lastUsedAt) return 1;
          return new Date(a.lastUsedAt) - new Date(b.lastUsedAt);
        });

        connection = sortedByOldest[0];

        // Update lastUsedAt and reset count to 1 (await to ensure persistence)
        await updateProviderConnection(connection.id, {
          lastUsedAt: new Date().toISOString(),
          consecutiveUseCount: 1
        });
      }
    } else {
      // Default: fill-first (already sorted by priority in getProviderConnections)
      connection = availableConnections[0];
    }

    const resolvedProxy = await resolveConnectionProxyConfig(connection.providerSpecificData || {});

    return {
      authType: connection.authType,
      apiKey: connection.apiKey,
      accessToken: connection.accessToken,
      refreshToken: connection.refreshToken,
      idToken: connection.idToken,
      expiresAt: connection.expiresAt,
      expiresIn: connection.expiresIn,
      lastRefreshAt: connection.lastRefreshAt,
      projectId: connection.projectId,
      connectionName: connection.displayName || connection.name || connection.email || connection.id,
      copilotToken: connection.providerSpecificData?.copilotToken,
      providerSpecificData: {
        ...(connection.providerSpecificData || {}),
        connectionProxyEnabled: resolvedProxy.connectionProxyEnabled,
        connectionProxyUrl: resolvedProxy.connectionProxyUrl,
        connectionNoProxy: resolvedProxy.connectionNoProxy,
        connectionProxyPoolId: resolvedProxy.proxyPoolId || null,
        vercelRelayUrl: resolvedProxy.vercelRelayUrl || "",
      },
      connectionId: connection.id,
      testStatus: connection.testStatus,
      lastError: connection.lastError,
      accountHealth: connection.accountHealth,
      _connection: connection
    };
  } finally {
    if (resolveMutex) resolveMutex();
  }
}

/**
 * Mark account+model as unavailable — locks modelLock_${model} in DB.
 * All errors (429, 401, 5xx, etc.) lock per model, not per account.
 * @param {string} connectionId
 * @param {number} status - HTTP status code from upstream
 * @param {string} errorText
 * @param {string|null} provider
 * @param {string|null} model - The specific model that triggered the error
 * @returns {{ shouldFallback: boolean, cooldownMs: number }}
 */
export async function markAccountUnavailable(connectionId, status, errorText, provider = null, model = null, resetsAtMs = null, failure = {}) {
  if (!connectionId || connectionId === "noauth") return { shouldFallback: false, cooldownMs: 0 };
  const connections = await getProviderConnections({ provider });
  const conn = connections.find(c => c.id === connectionId);
  const backoffLevel = conn?.backoffLevel || 0;
  const now = Date.now();
  const preciseReset = Number(resetsAtMs);
  const hasProviderReset = Number.isFinite(preciseReset) && preciseReset > now;
  const quotaPolicy = resolveQuotaPolicy(provider);

  let shouldFallback, cooldownMs, newBackoffLevel;
  if (hasProviderReset) {
    shouldFallback = true;
    cooldownMs = preciseReset - now;
    newBackoffLevel = 0;
  } else {
    ({ shouldFallback, cooldownMs, newBackoffLevel } = checkFallbackError(status, errorText, backoffLevel));
    if (shouldFallback && status === 429 && quotaPolicy.fallbackCooldownMs) {
      cooldownMs = quotaPolicy.fallbackCooldownMs;
      newBackoffLevel = 0;
    }
  }
  if (!shouldFallback) return { shouldFallback: false, cooldownMs: 0 };

  const reason = typeof errorText === "string" ? errorText.slice(0, 100) : "Provider error";
  const lockKey = getModelLockKey(model);
  const lockUpdate = hasProviderReset
    ? { [lockKey]: new Date(preciseReset).toISOString() }
    : buildModelLockUpdate(model, cooldownMs);
  const retryAt = lockUpdate[lockKey];
  const errorCode = failure?.errorCode ? String(failure.errorCode) : String(status);
  const accountHealth = recordAccountHealth(conn, {
    model,
    status,
    errorCode,
    reason,
    retryAt,
    source: hasProviderReset ? "provider-reset" : "fallback-policy",
    quotaPolicy: quotaPolicy.id,
    now,
  });

  await updateProviderConnection(connectionId, {
    ...lockUpdate,
    testStatus: "unavailable",
    lastError: reason,
    errorCode,
    lastErrorAt: new Date().toISOString(),
    backoffLevel: newBackoffLevel ?? backoffLevel,
    accountHealth,
  });

  const connName = conn?.displayName || conn?.name || conn?.email || connectionId.slice(0, 8);
  log.warn("AUTH", `${connName} locked ${lockKey} for ${Math.round(cooldownMs / 1000)}s [${status}]`);

  if (provider && status && reason) {
    console.error(`❌ ${provider} [${status}]: ${reason}`);
  }

  return { shouldFallback: true, cooldownMs };
}

/**
 * Clear account error status on successful request.
 * - Clears modelLock_${model} (the model that just succeeded)
 * - Lazy-cleans any other expired modelLock_* keys
 * - Resets error state only if no active locks remain
 * @param {string} connectionId
 * @param {object} currentConnection - credentials object (has _connection) or raw connection
 * @param {string|null} model - model that succeeded
 */
export async function clearAccountError(connectionId, currentConnection, model = null) {
  if (!connectionId || connectionId === "noauth") return;
  const conn = currentConnection._connection || currentConnection;
  if (!conn) return;
  const now = Date.now();
  const allLockKeys = Object.keys(conn).filter(k => k.startsWith("modelLock_"));

  const keysToClear = allLockKeys.filter(k => {
    if (model && k === getModelLockKey(model)) return true;
    if (model && k === getModelLockKey(null)) return true;
    return conn[k] && new Date(conn[k]).getTime() <= now;
  });
  const clearObj = accountRecoveryUpdate(conn, keysToClear, now);
  if (Object.keys(clearObj).length === 0) return;
  await updateProviderConnection(connectionId, clearObj);
}

/**
 * Extract API key from request headers
 */
export function extractApiKey(request) {
  // Check Authorization header first
  const authHeader = request.headers.get("Authorization");
  if (authHeader?.startsWith("Bearer ")) {
    return authHeader.slice(7);
  }

  // Check Anthropic x-api-key header
  const xApiKey = request.headers.get("x-api-key");
  if (xApiKey) {
    return xApiKey;
  }

  return null;
}

/**
 * Validate API key (optional - for local use can skip)
 */
export async function isValidApiKey(apiKey) {
  if (!apiKey) return false;
  return await validateApiKey(apiKey);
}

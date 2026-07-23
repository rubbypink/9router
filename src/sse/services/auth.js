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
const BLOCKING_CONNECTION_STATUSES = new Set(["error", "expired"]);
const BLOCKING_STORED_ERROR = /quota|rate limit|too many requests|capacity|out of credits|no credits|spending limit|usage limit/i;
const MODEL_SCOPED_USAGE_PROVIDERS = new Set(["antigravity", "gemini-cli"]);
const CLAUDE_QUOTA_FAMILIES = ["sonnet", "opus", "haiku"];

function healthModelKey(model) {
  return model || ACCOUNT_HEALTH_ALL_MODELS;
}

function claudeQuotaFamily(model) {
  const lowerModel = String(model || "").toLowerCase();
  return CLAUDE_QUOTA_FAMILIES.find((family) => lowerModel.includes(family)) || null;
}

function claudeQuotaHealthKey(family) {
  return `__family:${family}`;
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

function toFiniteNumber(value) {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string" && value.trim()) {
    const parsed = Number(value);
    if (Number.isFinite(parsed)) return parsed;
  }
  return null;
}

function quotaAvailability(quota) {
  if (!quota || typeof quota !== "object" || Array.isArray(quota)) return "unknown";
  if (quota.unlimited === true) return "available";
  const remaining = toFiniteNumber(quota.remaining);
  if (remaining !== null) return remaining > 0 ? "available" : "exhausted";
  const remainingPercentage = toFiniteNumber(quota.remainingPercentage);
  if (remainingPercentage !== null) return remainingPercentage > 0 ? "available" : "exhausted";
  const used = toFiniteNumber(quota.used);
  const total = toFiniteNumber(quota.total);
  if (used !== null && total !== null && total > 0) return used < total ? "available" : "exhausted";
  return "unknown";
}

function combineQuotaEntries(entries, mode, now = Date.now()) {
  const observed = entries.map(([, quota]) => ({ quota, state: quotaAvailability(quota) }));
  const known = observed.filter(({ state }) => state !== "unknown");
  if (known.length === 0) return { state: "unknown", retryAt: null };

  const available = known.filter(({ state }) => state === "available");
  const exhausted = known.filter(({ state }) => state === "exhausted");
  let state = "unknown";
  if (mode === "any") {
    if (available.length > 0) state = "available";
    else if (known.length === observed.length) state = "exhausted";
  } else if (exhausted.length > 0) {
    state = "exhausted";
  } else if (known.length === observed.length) {
    state = "available";
  }

  if (state !== "exhausted") return { state, retryAt: null };
  const resets = exhausted
    .map(({ quota }) => new Date(quota.resetAt).getTime())
    .filter((value) => Number.isFinite(value) && value > now);
  if (resets.length === 0) return { state, retryAt: null };
  const retryAtMs = mode === "any" ? Math.min(...resets) : Math.max(...resets);
  return { state, retryAt: new Date(retryAtMs).toISOString() };
}

function providerQuotaVerdict(provider, usage, model = null, now = Date.now()) {
  if (!usage || usage.error || usage.message) return { state: "unknown", retryAt: null };
  const quotas = usage.quotas;
  if (!quotas || typeof quotas !== "object" || Array.isArray(quotas)) return { state: "unknown", retryAt: null };
  const entries = Object.entries(quotas);
  if (entries.length === 0) return { state: "unknown", retryAt: null };

  if (MODEL_SCOPED_USAGE_PROVIDERS.has(provider)) {
    const quota = quotas[model];
    return quota ? combineQuotaEntries([[model, quota]], "all", now) : { state: "unknown", retryAt: null };
  }

  if (provider === "codex") {
    const normal = entries.filter(([name]) => name === "session" || name === "weekly");
    if (usage.limitReached === true) {
      const verdict = combineQuotaEntries(normal, "all", now);
      return { state: "exhausted", retryAt: verdict.retryAt };
    }
    return combineQuotaEntries(normal, "all", now);
  }

  if (provider === "claude") {
    const lowerModel = String(model || "").toLowerCase();
    const blocking = entries.filter(([name]) => {
      const lowerName = name.toLowerCase();
      if (lowerName === "session (5h)" || lowerName === "weekly (7d)") return true;
      return CLAUDE_QUOTA_FAMILIES.some((family) => lowerModel.includes(family) && lowerName.includes(family));
    });
    return combineQuotaEntries(blocking, "all", now);
  }

  if (provider === "qoder" && typeof usage.isQuotaExceeded === "boolean") {
    const verdict = combineQuotaEntries(entries, "any", now);
    return usage.isQuotaExceeded
      ? { state: "exhausted", retryAt: verdict.retryAt }
      : { state: "available", retryAt: null };
  }

  if (provider === "github") {
    const chat = entries.filter(([name]) => name === "chat");
    return combineQuotaEntries(chat, "all", now);
  }

  if (provider === "vercel-ai-gateway") {
    const remaining = entries.filter(([name]) => name === "Remaining (USD)");
    return combineQuotaEntries(remaining, "all", now);
  }

  if (provider === "glm" || provider === "glm-cn") {
    return combineQuotaEntries(entries.filter(([name]) => name === "session"), "all", now);
  }

  if (provider === "minimax" || provider === "minimax-cn") {
    const lowerModel = String(model || "").toLowerCase();
    const relevant = lowerModel.startsWith("minimax-m")
      ? entries.filter(([name]) => name.toLowerCase().includes("m-series") || name.toLowerCase().includes(lowerModel.replaceAll("-", " ")))
      : [];
    return combineQuotaEntries(relevant.length > 0 ? relevant : entries, "all", now);
  }

  const additiveProviders = new Set(["codebuddy-cn", "grok-cli", "kiro"]);
  return combineQuotaEntries(entries, additiveProviders.has(provider) ? "any" : "all", now);
}

function getStoredUnavailability(connection, model, now = Date.now()) {
  const current = currentAccountHealth(connection);
  const family = connection?.provider === "claude" ? claudeQuotaFamily(model) : null;
  const familyHealth = family ? current?.models?.[claudeQuotaHealthKey(family)] : null;
  const health = current?.models?.[healthModelKey(model)] || familyHealth || current?.models?.[ACCOUNT_HEALTH_ALL_MODELS];
  if (health?.state === "unavailable") {
    const retryAtMs = health.retryAt ? new Date(health.retryAt).getTime() : Number.NaN;
    if (!Number.isFinite(retryAtMs) || retryAtMs > now) {
      return {
        reason: health.reason || "accountHealth",
        retryAt: Number.isFinite(retryAtMs) ? new Date(retryAtMs).toISOString() : null,
      };
    }
  }

  const hasStructuredModels = Object.keys(current?.models || {}).length > 0;
  const legacyRetryAt = new Date(connection?.rateLimitedUntil).getTime();
  if (!hasStructuredModels && Number.isFinite(legacyRetryAt) && legacyRetryAt > now) {
    return { reason: "rateLimitedUntil", retryAt: new Date(legacyRetryAt).toISOString() };
  }

  const testStatus = String(connection?.testStatus || "").toLowerCase();
  if (BLOCKING_CONNECTION_STATUSES.has(testStatus)) return { reason: testStatus, retryAt: null };
  if (testStatus === "unavailable" && !hasStructuredModels && activeLockKeys(connection, now).length === 0) {
    return { reason: "unavailable", retryAt: null };
  }
  if (!hasStructuredModels && connection?.lastError && BLOCKING_STORED_ERROR.test(String(connection.lastError))) {
    return { reason: "storedQuotaError", retryAt: null };
  }
  return null;
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
    const retryAt = value?.retryAt ? new Date(value.retryAt).getTime() : Number.NaN;
    if (clearedModels.has(model) || (Number.isFinite(retryAt) && retryAt <= now)) {
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

  const hasActiveLocks = activeLockKeys(connection, now).some(key => !clearedLockKeys.includes(key));
  const hasActiveHealth = Object.keys(health.value?.models || {}).length > 0;
  const recoveredAutomaticState = clearedLockKeys.length > 0 || health.changed;
  if (recoveredAutomaticState && !hasActiveLocks && !hasActiveHealth) {
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

function providerUsageHealthEntry(provider, retryAt, now) {
  const observedAt = new Date(now).toISOString();
  return {
    state: "unavailable",
    reason: "quota",
    status: 429,
    errorCode: "quota_exhausted",
    observedAt,
    retryAt,
    source: "provider-usage",
    quotaPolicy: resolveQuotaPolicy(provider).id,
    message: "Provider usage reports quota exhausted",
  };
}

function quotaHealthModelKeys(connection) {
  return Object.entries(currentAccountHealth(connection)?.models || {})
    .filter(([, value]) => value?.reason === "quota")
    .map(([model]) => model);
}

function modelFromLockKey(key) {
  return key.slice("modelLock_".length);
}

export async function reconcileProviderQuotaState(connection, usage, now = Date.now()) {
  if (!connection?.id) return { updated: false, state: "unknown" };
  const provider = resolveProviderId(connection.provider);
  const current = currentAccountHealth(connection);
  const models = { ...(current?.models || {}) };
  const update = {};
  let modelsChanged = false;
  let observedState = "unknown";
  const legacyQuotaState = Boolean(connection.lastError && BLOCKING_STORED_ERROR.test(String(connection.lastError)));

  const clearModelQuota = (model) => {
    if (models[model]?.reason === "quota") {
      delete models[model];
      modelsChanged = true;
    }
    const lockKey = getModelLockKey(model === ACCOUNT_HEALTH_ALL_MODELS ? null : model);
    if (connection[lockKey]) update[lockKey] = null;
  };

  const setModelQuota = (model, retryAt) => {
    models[model] = providerUsageHealthEntry(provider, retryAt, now);
    modelsChanged = true;
    update[getModelLockKey(model === ACCOUNT_HEALTH_ALL_MODELS ? null : model)] = retryAt;
  };

  const applyVerdict = (model, verdict) => {
    if (verdict.state === "available") {
      observedState = observedState === "exhausted" ? observedState : "available";
      clearModelQuota(model);
    } else if (verdict.state === "exhausted") {
      observedState = "exhausted";
      setModelQuota(model, verdict.retryAt);
    }
  };

  if (MODEL_SCOPED_USAGE_PROVIDERS.has(provider)) {
    const quotas = usage?.quotas;
    if (quotas && typeof quotas === "object" && !Array.isArray(quotas) && !usage?.message && !usage?.error) {
      for (const model of Object.keys(quotas)) {
        applyVerdict(model, providerQuotaVerdict(provider, usage, model, now));
      }
    }
  } else if (provider === "claude") {
    const globalVerdict = providerQuotaVerdict(provider, usage, null, now);
    if (globalVerdict.state === "exhausted") {
      for (const model of quotaHealthModelKeys(connection)) clearModelQuota(model);
      applyVerdict(ACCOUNT_HEALTH_ALL_MODELS, globalVerdict);
    } else if (globalVerdict.state === "available") {
      applyVerdict(ACCOUNT_HEALTH_ALL_MODELS, globalVerdict);
      const quotaNames = Object.keys(usage?.quotas || {}).map((name) => name.toLowerCase());
      for (const family of CLAUDE_QUOTA_FAMILIES) {
        const familyKey = claudeQuotaHealthKey(family);
        const hasFamilyQuota = quotaNames.some((name) => name.includes(family));
        applyVerdict(
          familyKey,
          hasFamilyQuota ? providerQuotaVerdict(provider, usage, family, now) : { state: "available", retryAt: null },
        );
      }
    }
  } else {
    const knownModel = quotaHealthModelKeys(connection).find((model) => model !== ACCOUNT_HEALTH_ALL_MODELS) || null;
    const verdict = providerQuotaVerdict(provider, usage, knownModel, now);
    if (verdict.state === "available") {
      const quotaModels = quotaHealthModelKeys(connection);
      for (const model of quotaModels) clearModelQuota(model);
      if (legacyQuotaState && quotaModels.length === 0) {
        for (const key of activeLockKeys(connection, now)) update[key] = null;
      }
      applyVerdict(ACCOUNT_HEALTH_ALL_MODELS, verdict);
    } else if (verdict.state === "exhausted") {
      for (const model of quotaHealthModelKeys(connection)) clearModelQuota(model);
      applyVerdict(ACCOUNT_HEALTH_ALL_MODELS, verdict);
    }
  }

  if (modelsChanged) {
    update.accountHealth = {
      version: ACCOUNT_HEALTH_VERSION,
      updatedAt: new Date(now).toISOString(),
      models,
      recentErrors: (current?.recentErrors || []).slice(-ACCOUNT_HEALTH_CONFIG.historyLimit),
    };
  }

  if (observedState === "exhausted") {
    const retryAt = models[ACCOUNT_HEALTH_ALL_MODELS]?.retryAt || null;
    Object.assign(update, {
      testStatus: "unavailable",
      lastError: "Provider usage reports quota exhausted",
      lastErrorAt: new Date(now).toISOString(),
      errorCode: "quota_exhausted",
      rateLimitedUntil: retryAt,
      backoffLevel: 0,
    });
  } else if (observedState === "available" && (legacyQuotaState || modelsChanged)) {
    const merged = { ...connection, ...update };
    const hasUnavailableHealth = Object.values(models).some((value) => value?.state === "unavailable");
    const hasActiveLocks = activeLockKeys(merged, now).length > 0;
    if (!hasUnavailableHealth && !hasActiveLocks && !BLOCKING_CONNECTION_STATUSES.has(String(connection.testStatus || "").toLowerCase())) {
      Object.assign(update, {
        testStatus: "active",
        lastError: null,
        lastErrorAt: null,
        errorCode: null,
        rateLimitedUntil: null,
        backoffLevel: 0,
      });
    }
  }

  if (Object.keys(update).length === 0) return { updated: false, state: observedState };
  await updateProviderConnection(connection.id, update);
  return { updated: true, state: observedState };
}

export async function getProviderModelAvailability(provider, model = null) {
  const providerId = resolveProviderId(provider);
  if (FREE_PROVIDERS[providerId]?.noAuth) return { available: true };

  const storedConnections = await getProviderConnections({ provider: providerId, isActive: true });
  const connections = [];
  for (const storedConnection of storedConnections) {
    connections.push(await reconcileConnectionAvailability(storedConnection));
  }
  if (connections.length === 0) return { available: false, reason: "no_credentials", retryAfter: null };

  const blocked = connections.map((connection) => ({
    connection,
    unavailable: getStoredUnavailability(connection, model),
    locked: isModelLockActive(connection, model),
  }));
  if (blocked.some(({ unavailable, locked }) => !unavailable && !locked)) return { available: true };

  const retryAfter = blocked.flatMap(({ connection, unavailable }) => [
    unavailable?.retryAt,
    isModelLockActive(connection, model) ? getEarliestModelLockUntil(connection) : null,
  ]).filter(Boolean).sort()[0] || null;
  const quotaBlocked = blocked.some(({ unavailable }) => unavailable?.reason === "quota" || unavailable?.reason === "storedQuotaError");
  return { available: false, reason: quotaBlocked ? "quota" : "unavailable", retryAfter };
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

    const storedUnavailability = new Map(connections.map((connection) => [
      connection.id,
      getStoredUnavailability(connection, model),
    ]));

    const availableConnections = connections.filter(c => {
      if (excludeSet.has(c.id)) return false;
      if (isModelLockActive(c, model)) return false;
      if (storedUnavailability.get(c.id)) return false;
      return true;
    }).sort((left, right) => {
      const priorityDiff = (left.priority ?? 999) - (right.priority ?? 999);
      if (priorityDiff !== 0) return priorityDiff;
      return String(left.id).localeCompare(String(right.id));
    });

    log.debug("AUTH", `${provider} | available: ${availableConnections.length}/${connections.length}`);
    connections.forEach(c => {
      const excluded = excludeSet.has(c.id);
      const locked = isModelLockActive(c, model);
      const unavailable = storedUnavailability.get(c.id);
      if (excluded || locked || unavailable) {
        const lockUntil = getEarliestModelLockUntil(c);
        log.debug("AUTH", `  → ${c.id?.slice(0, 8)} | ${excluded ? "excluded" : ""} ${locked ? `modelLocked(${model}) until ${lockUntil}` : ""} ${unavailable ? `storedUnavailable(${unavailable.reason})` : ""}`);
      }
    });

    if (availableConnections.length === 0) {
      // Find earliest lock expiry across all connections for retry timing
      const lockedConns = connections.filter(c => isModelLockActive(c, model) || storedUnavailability.get(c.id));
      const expiries = lockedConns.flatMap(c => [
        getEarliestModelLockUntil(c),
        storedUnavailability.get(c.id)?.retryAt,
      ]).filter(Boolean);
      const earliest = expiries.sort()[0] || null;
      if (lockedConns.length > 0) {
        const earliestConn = lockedConns[0];
        log.warn("AUTH", `${provider} | all ${connections.length} accounts unavailable for ${model || "all"}${earliest ? ` (${formatRetryAfter(earliest)})` : ""} | lastError=${earliestConn?.lastError?.slice(0, 50)}`);
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

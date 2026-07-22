const REBIND_REASONS = new Set([
  "bound_connection_unavailable",
  "retryable_provider_failure",
  "combo_eligible_fallback",
  "transport_rebind",
]);

export class ThreadRouteError extends Error {
  constructor(message, { code = "thread_route_error", status = 409 } = {}) {
    super(message);
    this.name = "ThreadRouteError";
    this.code = code;
    this.status = status;
  }
}

function providerIdFor(route) {
  const candidate = route?.providerId || route?.resolvedModel || route?.model;
  return typeof candidate === "string" ? candidate.split("/", 1)[0] || null : null;
}

function routeMatches(binding, route, providerId) {
  return binding.model === route.model &&
    binding.resolvedModel === (route.resolvedModel || route.model) &&
    binding.providerId === providerId;
}

function keyFor(sessionKey, value) {
  return `${sessionKey}:${value}`;
}

function rebindReasonFor(reason) {
  return REBIND_REASONS.has(reason) ? reason : "retryable_provider_failure";
}

export class SessionRouteBindings {
  constructor({ store = null, ttlMs, now = () => Date.now() } = {}) {
    this.store = store;
    this.ttlMs = ttlMs;
    this.now = now;
    this.models = new Map();
    this.connections = new Map();
    this.hydratedModels = new Set();
    this.hydratedConnections = new Set();
    this.nextCleanupAt = new Map();
    this.legacyRouteAliases = new Map();
  }

  clear() {
    this.models.clear();
    this.connections.clear();
    this.hydratedModels.clear();
    this.hydratedConnections.clear();
    this.nextCleanupAt.clear();
    this.legacyRouteAliases.clear();
  }

  cleanupSession(sessionKey) {
    const now = this.now();
    const nextCleanupAt = this.nextCleanupAt.get(sessionKey);
    if (nextCleanupAt != null && now < nextCleanupAt) return;
    const cleanup = this.store?.cleanupExpired?.(sessionKey, now - this.ttlMs);
    this.nextCleanupAt.set(sessionKey, now + this.ttlMs);
    if (Number(cleanup?.deleted) > 0) this.evictSession(sessionKey);
  }

  evictSession(sessionKey) {
    const prefix = `${sessionKey}:`;
    for (const key of this.models.keys()) {
      if (key.startsWith(prefix)) this.models.delete(key);
    }
    for (const key of this.connections.keys()) {
      if (key.startsWith(prefix)) this.connections.delete(key);
    }
    for (const key of this.hydratedModels) {
      if (key.startsWith(prefix)) this.hydratedModels.delete(key);
    }
    for (const key of this.hydratedConnections) {
      if (key.startsWith(prefix)) this.hydratedConnections.delete(key);
    }
    this.legacyRouteAliases.delete(sessionKey);
  }

  getRouteModelBinding(sessionKey, routeAlias) {
    this.cleanupSession(sessionKey);
    const key = keyFor(sessionKey, routeAlias);
    if (!this.hydratedModels.has(key)) {
      const persisted = this.store?.getSessionModelBinding?.(sessionKey, routeAlias) || null;
      const legacy = !persisted ? this.store?.get?.(sessionKey) || null : null;
      if (persisted) this.models.set(key, persisted);
      if (legacy?.requestedModel === routeAlias) this.cacheLegacyRoute(sessionKey, routeAlias, legacy);
      else if (legacy?.requestedModel) this.legacyRouteAliases.set(sessionKey, legacy.requestedModel);
      this.hydratedModels.add(key);
    }
    const binding = this.models.get(key) || null;
    return binding ? { ...binding } : null;
  }

  cacheLegacyRoute(sessionKey, routeAlias, legacy) {
    const providerId = providerIdFor(legacy);
    if (!providerId) return;
    const modelBinding = {
      routeAlias,
      model: legacy.model,
      resolvedModel: legacy.resolvedModel || legacy.model,
      providerId,
      routeEpoch: legacy.routeEpoch || 1,
      assignedAt: legacy.assignedAt,
      lastRoutedAt: legacy.lastRoutedAt,
      lastSuccessAt: legacy.lastSuccessAt || null,
      rebindReason: null,
    };
    const connectionBinding = {
      providerId,
      connectionId: legacy.connectionId,
      routeEpoch: legacy.routeEpoch || 1,
      assignedAt: legacy.assignedAt,
      lastRoutedAt: legacy.lastRoutedAt,
      lastSuccessAt: legacy.lastSuccessAt || null,
      rebindReason: null,
    };
    this.models.set(keyFor(sessionKey, routeAlias), modelBinding);
    this.connections.set(keyFor(sessionKey, providerId), connectionBinding);
  }

  getConnectionBinding(sessionKey, providerId) {
    this.cleanupSession(sessionKey);
    const key = keyFor(sessionKey, providerId);
    if (!this.hydratedConnections.has(key)) {
      const persisted = this.store?.getSessionConnectionBinding?.(sessionKey, providerId) || null;
      if (persisted) this.connections.set(key, persisted);
      this.hydratedConnections.add(key);
    }
    const binding = this.connections.get(key) || null;
    return binding ? { ...binding } : null;
  }

  getBinding(sessionKey, routeAlias, { legacySessionKey = null } = {}) {
    let modelBinding = this.getRouteModelBinding(sessionKey, routeAlias);
    if (!modelBinding && legacySessionKey) {
      this.migrateLegacyBinding(sessionKey, routeAlias, legacySessionKey);
      modelBinding = this.getRouteModelBinding(sessionKey, routeAlias);
    }
    if (!modelBinding) {
      const legacyAlias = this.legacyRouteAliases.get(sessionKey);
      if (legacyAlias && legacyAlias !== routeAlias) {
        throw new ThreadRouteError("Requested model changed inside a bound Codex thread", {
          code: "thread_model_changed",
          status: 409,
        });
      }
      return null;
    }
    const connectionBinding = this.getConnectionBinding(sessionKey, modelBinding.providerId);
    return {
      ...modelBinding,
      connectionId: connectionBinding?.connectionId || null,
      routeEpoch: Math.max(modelBinding.routeEpoch, connectionBinding?.routeEpoch || 1),
      rebindReason: connectionBinding?.rebindReason || modelBinding.rebindReason || null,
    };
  }

  migrateLegacyBinding(sessionKey, routeAlias, legacySessionKey) {
    const legacy = this.store?.getLegacyBinding?.(legacySessionKey) || this.store?.get?.(legacySessionKey) || null;
    if (!legacy || legacy.requestedModel !== routeAlias || !legacy.connectionId) return null;
    this.cacheLegacyRoute(sessionKey, routeAlias, legacy);
    const modelBinding = this.getRouteModelBinding(sessionKey, routeAlias);
    const connectionBinding = this.getConnectionBinding(sessionKey, modelBinding.providerId);
    this.persistConnectionBinding(sessionKey, connectionBinding);
    this.persistModelBinding(sessionKey, modelBinding);
    return this.getBinding(sessionKey, routeAlias);
  }

  persistModelBinding(sessionKey, binding) {
    this.models.set(keyFor(sessionKey, binding.routeAlias), { ...binding });
    this.hydratedModels.add(keyFor(sessionKey, binding.routeAlias));
    this.store?.upsertSessionModelBinding?.(sessionKey, binding);
    this.store?.upsert?.(sessionKey, {
      requestedModel: binding.routeAlias,
      model: binding.model,
      resolvedModel: binding.resolvedModel,
      connectionId: this.getConnectionBinding(sessionKey, binding.providerId)?.connectionId || null,
      routeEpoch: binding.routeEpoch,
      assignedAt: binding.assignedAt,
      lastRoutedAt: binding.lastRoutedAt,
      lastSuccessAt: binding.lastSuccessAt,
    });
  }

  persistConnectionBinding(sessionKey, binding) {
    this.connections.set(keyFor(sessionKey, binding.providerId), { ...binding });
    this.hydratedConnections.add(keyFor(sessionKey, binding.providerId));
    this.store?.upsertSessionConnectionBinding?.(sessionKey, binding);
  }

  bindRoute(sessionKey, routeAlias, route, { allowRebind = false, rebindReason = null } = {}) {
    const providerId = providerIdFor(route);
    if (!sessionKey || !routeAlias || !route?.model || !providerId || !route.connectionId) {
      throw new ThreadRouteError("Incomplete thread route binding", { status: 500 });
    }
    const existingModel = this.getRouteModelBinding(sessionKey, routeAlias);
    const existingConnection = this.getConnectionBinding(sessionKey, providerId);
    const routeChanged = Boolean(existingModel && !routeMatches(existingModel, route, providerId));
    const connectionChanged = Boolean(existingConnection && existingConnection.connectionId !== route.connectionId);
    const needsRebind = Boolean(existingModel && (routeChanged || connectionChanged));
    if (needsRebind && !allowRebind) {
      throw new ThreadRouteError("Route can change only after an eligible provider failure", {
        code: "thread_route_rebind_not_allowed",
        status: 409,
      });
    }
    const now = this.now();
    const reason = needsRebind ? rebindReasonFor(rebindReason) : null;
    const effectiveConnectionId = existingConnection && !needsRebind ? existingConnection.connectionId : route.connectionId;
    const modelBinding = {
      routeAlias,
      model: route.model,
      resolvedModel: route.resolvedModel || route.model,
      providerId,
      routeEpoch: existingModel ? existingModel.routeEpoch + (needsRebind ? 1 : 0) : 1,
      assignedAt: needsRebind || !existingModel ? now : existingModel.assignedAt,
      lastRoutedAt: now,
      lastSuccessAt: needsRebind ? null : existingModel?.lastSuccessAt || null,
      rebindReason: reason,
    };
    const connectionBinding = {
      providerId,
      connectionId: effectiveConnectionId,
      routeEpoch: existingConnection ? existingConnection.routeEpoch + (connectionChanged && needsRebind ? 1 : 0) : 1,
      assignedAt: connectionChanged && needsRebind ? now : existingConnection?.assignedAt || now,
      lastRoutedAt: now,
      lastSuccessAt: connectionChanged && needsRebind ? null : existingConnection?.lastSuccessAt || null,
      rebindReason: connectionChanged && needsRebind ? reason : existingConnection?.rebindReason || null,
    };
    this.persistConnectionBinding(sessionKey, connectionBinding);
    this.persistModelBinding(sessionKey, modelBinding);
    return this.getBinding(sessionKey, routeAlias);
  }

  markSuccess(sessionKey, routeAlias, route) {
    const binding = this.getBinding(sessionKey, routeAlias);
    const providerId = providerIdFor(route);
    if (!binding || !routeMatches(binding, route, providerId) || binding.connectionId !== route.connectionId) {
      throw new ThreadRouteError("Successful response does not match the bound route", {
        code: "thread_route_success_mismatch",
        status: 500,
      });
    }
    const now = this.now();
    this.persistConnectionBinding(sessionKey, { ...this.getConnectionBinding(sessionKey, providerId), lastSuccessAt: now, lastRoutedAt: now });
    this.persistModelBinding(sessionKey, { ...this.getRouteModelBinding(sessionKey, routeAlias), lastSuccessAt: now, lastRoutedAt: now });
    return this.getBinding(sessionKey, routeAlias);
  }
}

import { getAdapterSync } from "../driver.js";
import { cleanupExpiredSessionAffinityBindings as cleanupRows } from "../sessionAffinityCleanup.js";

function rowToBinding(row) {
  if (!row) return null;
  return {
    requestedModel: row.requestedModel,
    model: row.model,
    resolvedModel: row.resolvedModel,
    connectionId: row.connectionId || null,
    routeEpoch: row.routeEpoch,
    assignedAt: row.assignedAt,
    lastRoutedAt: row.lastRoutedAt,
    lastSuccessAt: row.lastSuccessAt || null,
  };
}

export function getThreadRouteBinding(threadKey) {
  return rowToBinding(
    getAdapterSync().get(`SELECT * FROM threadRouteBindings WHERE threadKey = ?`, [threadKey]),
  );
}

export function upsertThreadRouteBinding(threadKey, binding) {
  getAdapterSync().run(
    `INSERT INTO threadRouteBindings(
      threadKey, requestedModel, model, resolvedModel, connectionId,
      routeEpoch, assignedAt, lastRoutedAt, lastSuccessAt
    ) VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(threadKey) DO UPDATE SET
      requestedModel = excluded.requestedModel,
      model = excluded.model,
      resolvedModel = excluded.resolvedModel,
      connectionId = excluded.connectionId,
      routeEpoch = excluded.routeEpoch,
      assignedAt = excluded.assignedAt,
      lastRoutedAt = excluded.lastRoutedAt,
      lastSuccessAt = excluded.lastSuccessAt`,
    [
      threadKey,
      binding.requestedModel,
      binding.model,
      binding.resolvedModel,
      binding.connectionId,
      binding.routeEpoch,
      binding.assignedAt,
      binding.lastRoutedAt,
      binding.lastSuccessAt,
    ],
  );
}

function rowToSessionModelBinding(row) {
  if (!row) return null;
  return {
    routeAlias: row.routeAlias,
    model: row.model,
    resolvedModel: row.resolvedModel,
    providerId: row.providerId,
    routeEpoch: row.routeEpoch,
    assignedAt: row.assignedAt,
    lastRoutedAt: row.lastRoutedAt,
    lastSuccessAt: row.lastSuccessAt || null,
    rebindReason: row.rebindReason || null,
  };
}

function rowToSessionConnectionBinding(row) {
  if (!row) return null;
  return {
    providerId: row.providerId,
    connectionId: row.connectionId,
    routeEpoch: row.routeEpoch,
    assignedAt: row.assignedAt,
    lastRoutedAt: row.lastRoutedAt,
    lastSuccessAt: row.lastSuccessAt || null,
    rebindReason: row.rebindReason || null,
  };
}

function providerIdFor(model) {
  return typeof model === "string" ? model.split("/", 1)[0] || null : null;
}

function connectionOrder(left, right) {
  const leftPriority = Number.isFinite(left.priority) ? left.priority : Number.MAX_SAFE_INTEGER;
  const rightPriority = Number.isFinite(right.priority) ? right.priority : Number.MAX_SAFE_INTEGER;
  if (leftPriority !== rightPriority) return leftPriority - rightPriority;
  return String(left.id).localeCompare(String(right.id));
}

export function getSessionModelBinding(sessionKey, routeAlias) {
  return rowToSessionModelBinding(getAdapterSync().get(
    `SELECT * FROM sessionModelBindings WHERE sessionKey = ? AND routeAlias = ?`,
    [sessionKey, routeAlias],
  ));
}

export function upsertSessionModelBinding(sessionKey, binding) {
  getAdapterSync().run(
    `INSERT INTO sessionModelBindings(
      sessionKey, routeAlias, model, resolvedModel, providerId, routeEpoch,
      assignedAt, lastRoutedAt, lastSuccessAt, rebindReason
    ) VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(sessionKey, routeAlias) DO UPDATE SET
      model = excluded.model,
      resolvedModel = excluded.resolvedModel,
      providerId = excluded.providerId,
      routeEpoch = excluded.routeEpoch,
      assignedAt = excluded.assignedAt,
      lastRoutedAt = excluded.lastRoutedAt,
      lastSuccessAt = excluded.lastSuccessAt,
      rebindReason = excluded.rebindReason`,
    [
      sessionKey, binding.routeAlias, binding.model, binding.resolvedModel,
      binding.providerId, binding.routeEpoch, binding.assignedAt,
      binding.lastRoutedAt, binding.lastSuccessAt, binding.rebindReason,
    ],
  );
}

export function getSessionConnectionBinding(sessionKey, providerId) {
  return rowToSessionConnectionBinding(getAdapterSync().get(
    `SELECT * FROM sessionConnectionBindings WHERE sessionKey = ? AND providerId = ?`,
    [sessionKey, providerId],
  ));
}

export function upsertSessionConnectionBinding(sessionKey, binding) {
  getAdapterSync().run(
    `INSERT INTO sessionConnectionBindings(
      sessionKey, providerId, connectionId, routeEpoch, assignedAt,
      lastRoutedAt, lastSuccessAt, rebindReason
    ) VALUES(?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(sessionKey, providerId) DO UPDATE SET
      connectionId = excluded.connectionId,
      routeEpoch = excluded.routeEpoch,
      assignedAt = excluded.assignedAt,
      lastRoutedAt = excluded.lastRoutedAt,
      lastSuccessAt = excluded.lastSuccessAt,
      rebindReason = excluded.rebindReason`,
    [
      sessionKey, binding.providerId, binding.connectionId, binding.routeEpoch,
      binding.assignedAt, binding.lastRoutedAt, binding.lastSuccessAt,
      binding.rebindReason,
    ],
  );
}

export function selectNextSessionAffinityConnection(providerId, eligibleConnections) {
  const eligible = [...eligibleConnections].sort(connectionOrder);
  if (eligible.length === 0) return null;

  const db = getAdapterSync();
  return db.transaction(() => {
    const current = db.get(
      `SELECT position FROM providerRoundRobinCursors WHERE providerId = ?`,
      [providerId],
    );
    const position = (Number(current?.position) || 0) + 1;
    db.run(
      `INSERT INTO providerRoundRobinCursors(providerId, position, updatedAt)
       VALUES(?, ?, ?)
       ON CONFLICT(providerId) DO UPDATE SET position = excluded.position, updatedAt = excluded.updatedAt`,
      [providerId, position, Date.now()],
    );
    return eligible[(position - 1) % eligible.length];
  });
}

export function cleanupExpiredSessionAffinityBindings(options = {}) {
  return cleanupRows(getAdapterSync(), options);
}

export function getLegacySessionRouteBinding(sessionKey) {
  return getThreadRouteBinding(sessionKey);
}

export function migrateLegacySessionRouteBinding(sessionKey, legacySessionKey, routeAlias, now = Date.now()) {
  const legacy = getThreadRouteBinding(legacySessionKey);
  if (!legacy || legacy.requestedModel !== routeAlias) return null;
  const providerId = providerIdFor(legacy.resolvedModel || legacy.model);
  if (!providerId || !legacy.connectionId) return null;

  const modelBinding = {
    routeAlias,
    model: legacy.model,
    resolvedModel: legacy.resolvedModel || legacy.model,
    providerId,
    routeEpoch: legacy.routeEpoch || 1,
    assignedAt: legacy.assignedAt || now,
    lastRoutedAt: legacy.lastRoutedAt || now,
    lastSuccessAt: legacy.lastSuccessAt || null,
    rebindReason: null,
  };
  const connectionBinding = {
    providerId,
    connectionId: legacy.connectionId,
    routeEpoch: legacy.routeEpoch || 1,
    assignedAt: legacy.assignedAt || now,
    lastRoutedAt: legacy.lastRoutedAt || now,
    lastSuccessAt: legacy.lastSuccessAt || null,
    rebindReason: null,
  };
  const db = getAdapterSync();
  db.transaction(() => {
    if (!getSessionModelBinding(sessionKey, routeAlias)) upsertSessionModelBinding(sessionKey, modelBinding);
    if (!getSessionConnectionBinding(sessionKey, providerId)) upsertSessionConnectionBinding(sessionKey, connectionBinding);
  });
  return { modelBinding, connectionBinding };
}

import { getAdapterSync } from "../driver.js";

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

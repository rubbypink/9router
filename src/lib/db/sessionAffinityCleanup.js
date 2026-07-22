export function cleanupExpiredSessionAffinityBindings(db, {
  sessionKey = null,
  cutoff = null,
  now = Date.now(),
  ttlMs,
} = {}) {
  const effectiveCutoff = Number.isFinite(cutoff) ? cutoff : now - ttlMs;
  if (!Number.isFinite(effectiveCutoff)) return { deleted: 0, modelBindings: 0, connectionBindings: 0 };

  const where = sessionKey ? "sessionKey = ? AND lastRoutedAt < ?" : "lastRoutedAt < ?";
  const params = sessionKey ? [sessionKey, effectiveCutoff] : [effectiveCutoff];
  let modelBindings = 0;
  let connectionBindings = 0;
  db.transaction(() => {
    modelBindings = db.run(`DELETE FROM sessionModelBindings WHERE ${where}`, params).changes;
    connectionBindings = db.run(`DELETE FROM sessionConnectionBindings WHERE ${where}`, params).changes;
  });
  return { deleted: modelBindings + connectionBindings, modelBindings, connectionBindings };
}

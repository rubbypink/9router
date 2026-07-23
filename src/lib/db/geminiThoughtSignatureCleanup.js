export const GEMINI_THOUGHT_SIGNATURE_TOMBSTONE_TTL_MS = 30 * 24 * 60 * 60 * 1000;

export function cleanupExpiredGeminiThoughtSignatures(db, { now = Date.now() } = {}) {
  if (!Number.isFinite(now)) return { deleted: 0 };
  const expired = db.all(
    `SELECT sessionKeyHash, apiFamily, modelFamily, toolCallId, functionName, argumentsFingerprint, expiresAt
     FROM geminiThoughtSignatures WHERE expiresAt <= ?`,
    [now],
  );
  let tombstones = 0;
  let deleted = 0;
  let expiredTombstones = 0;
  db.transaction(() => {
    expiredTombstones = db.run(
      `DELETE FROM geminiThoughtSignatureTombstones WHERE expiresAt <= ?`,
      [now],
    ).changes;
    for (const record of expired) {
      const expiresAt = Number(record.expiresAt) + GEMINI_THOUGHT_SIGNATURE_TOMBSTONE_TTL_MS;
      if (!Number.isFinite(expiresAt) || expiresAt <= now) continue;
      db.run(
        `INSERT INTO geminiThoughtSignatureTombstones(
          sessionKeyHash, apiFamily, modelFamily, toolCallId, functionName,
          argumentsFingerprint, observedAt, expiresAt
        ) VALUES(?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(sessionKeyHash, apiFamily, modelFamily, toolCallId, functionName, argumentsFingerprint) DO UPDATE SET
          observedAt = excluded.observedAt,
          expiresAt = excluded.expiresAt`,
        [
          record.sessionKeyHash,
          record.apiFamily,
          record.modelFamily,
          record.toolCallId,
          record.functionName,
          record.argumentsFingerprint,
          now,
          expiresAt,
        ],
      );
      tombstones++;
    }
    deleted = db.run(
      `DELETE FROM geminiThoughtSignatures WHERE expiresAt <= ?`,
      [now],
    ).changes;
  });
  return { deleted, tombstones, expiredTombstones };
}

import { getAdapterSync } from "../driver.js";
import { cleanupExpiredGeminiThoughtSignatures as cleanupRows } from "../geminiThoughtSignatureCleanup.js";

function rowToSignature(row) {
  if (!row) return null;
  return {
    sessionKeyHash: row.sessionKeyHash,
    apiFamily: row.apiFamily,
    modelFamily: row.modelFamily,
    toolCallId: row.toolCallId,
    functionName: row.functionName,
    argumentsFingerprint: row.argumentsFingerprint,
    thoughtSignature: row.thoughtSignature,
    observedAt: row.observedAt,
    lastUsedAt: row.lastUsedAt,
    expiresAt: row.expiresAt,
  };
}

export function upsertGeminiThoughtSignature(record) {
  getAdapterSync().run(
    `INSERT INTO geminiThoughtSignatures(
      sessionKeyHash, apiFamily, modelFamily, toolCallId, functionName,
      argumentsFingerprint, thoughtSignature, observedAt, lastUsedAt, expiresAt
    ) VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(sessionKeyHash, apiFamily, modelFamily, toolCallId, functionName, argumentsFingerprint) DO UPDATE SET
      thoughtSignature = excluded.thoughtSignature,
      observedAt = excluded.observedAt,
      lastUsedAt = excluded.lastUsedAt,
      expiresAt = excluded.expiresAt`,
    [
      record.sessionKeyHash,
      record.apiFamily,
      record.modelFamily,
      record.toolCallId,
      record.functionName,
      record.argumentsFingerprint,
      record.thoughtSignature,
      record.observedAt,
      record.lastUsedAt,
      record.expiresAt,
    ],
  );
}

export function getGeminiThoughtSignature(record, now = Date.now()) {
  const db = getAdapterSync();
  cleanupRows(db, { now });
  const row = db.get(
    `SELECT * FROM geminiThoughtSignatures
     WHERE sessionKeyHash = ? AND apiFamily = ? AND modelFamily = ?
       AND toolCallId = ? AND functionName = ? AND argumentsFingerprint = ?
       AND expiresAt > ?`,
    [
      record.sessionKeyHash,
      record.apiFamily,
      record.modelFamily,
      record.toolCallId,
      record.functionName,
      record.argumentsFingerprint,
      now,
    ],
  );
  if (row) {
    db.run(
      `UPDATE geminiThoughtSignatures SET lastUsedAt = ?
       WHERE sessionKeyHash = ? AND apiFamily = ? AND modelFamily = ?
         AND toolCallId = ? AND functionName = ? AND argumentsFingerprint = ?`,
      [
        now,
        record.sessionKeyHash,
        record.apiFamily,
        record.modelFamily,
        record.toolCallId,
        record.functionName,
        record.argumentsFingerprint,
      ],
    );
  }
  return rowToSignature(row);
}

export function listGeminiThoughtSignatureBindings(sessionKeyHash, now = Date.now(), { includeExpired = false } = {}) {
  const db = getAdapterSync();
  if (!includeExpired) cleanupRows(db, { now });
  const predicate = includeExpired ? "" : " AND expiresAt > ?";
  const params = includeExpired ? [sessionKeyHash] : [sessionKeyHash, now];
  return db.all(
    `SELECT apiFamily, modelFamily, toolCallId, functionName, argumentsFingerprint, expiresAt
     FROM geminiThoughtSignatures WHERE sessionKeyHash = ?${predicate}`,
    params,
  );
}

export function listGeminiThoughtSignatureTombstones(sessionKeyHash, now = Date.now()) {
  const db = getAdapterSync();
  cleanupRows(db, { now });
  return db.all(
    `SELECT apiFamily, modelFamily, toolCallId, functionName, argumentsFingerprint, expiresAt
     FROM geminiThoughtSignatureTombstones WHERE sessionKeyHash = ? AND expiresAt > ?`,
    [sessionKeyHash, now],
  );
}

export function cleanupExpiredGeminiThoughtSignatures(options = {}) {
  return cleanupRows(getAdapterSync(), options);
}

export const SESSION_AFFINITY_ENV = "SESSION_AFFINITY_ENABLED";
export const THREAD_AFFINITY_ENV = "CODEX_THREAD_AFFINITY";
export const SESSION_AFFINITY_ENABLED = true;
export const THREAD_AFFINITY_ENABLED = SESSION_AFFINITY_ENABLED;
export const THREAD_AFFINITY_MAX_PENDING_PER_THREAD = 8;
export const THREAD_ID_MAX_LENGTH = 256;
export const THREAD_ID_SESSION_HEADERS = ["session-id", "x-session-id", "session_id", "x-amp-thread-id"];
export const SESSION_AFFINITY_TTL_DAYS = 30;

function parseBoolean(value) {
  if (typeof value !== "string") return null;
  const normalized = value.trim().toLowerCase();
  if (["true", "1", "yes", "on"].includes(normalized)) return true;
  if (["false", "0", "no", "off"].includes(normalized)) return false;
  return null;
}

export function isSessionAffinityEnabled(env = process.env) {
  const sessionAffinity = parseBoolean(env?.[SESSION_AFFINITY_ENV]);
  if (sessionAffinity !== null) return sessionAffinity;

  const legacyAffinity = parseBoolean(env?.[THREAD_AFFINITY_ENV]);
  return legacyAffinity ?? SESSION_AFFINITY_ENABLED;
}

export function getSessionAffinityTtlMs(env = process.env) {
  const rawDays = Number(env?.SESSION_AFFINITY_TTL_DAYS);
  const days = Number.isFinite(rawDays) && rawDays > 0 ? rawDays : SESSION_AFFINITY_TTL_DAYS;
  return Math.floor(days * 24 * 60 * 60 * 1000);
}

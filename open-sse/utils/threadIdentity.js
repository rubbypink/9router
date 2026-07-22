import crypto from "crypto";
import {
  THREAD_ID_MAX_LENGTH,
  THREAD_ID_SESSION_HEADERS,
} from "../config/threadAffinityConfig.js";

export class ThreadIdentityError extends Error {
  constructor(message, { code = "thread_identity_error", status = 400 } = {}) {
    super(message);
    this.name = "ThreadIdentityError";
    this.code = code;
    this.status = status;
  }
}

function normalize(value) {
  if (typeof value !== "string") return null;
  const normalized = value.trim();
  if (!normalized || normalized.length > THREAD_ID_MAX_LENGTH) return null;
  return normalized;
}

function getHeader(headers, name) {
  if (!headers) return null;
  if (typeof headers.get === "function") return normalize(headers.get(name));
  const direct = headers[name] ?? headers[name.toLowerCase()];
  if (direct !== undefined) return normalize(direct);
  const entry = Object.entries(headers).find(([key]) => key.toLowerCase() === name.toLowerCase());
  return normalize(entry?.[1]);
}

function hashIdentity(namespace, value) {
  return crypto.createHash("sha256").update(`${namespace}:${value}`).digest("hex");
}

function resolveGroup(candidates, message) {
  const present = candidates.filter(([, value]) => value);
  if (present.length === 0) return null;
  const [, selected] = present[0];
  if (present.some(([, value]) => value !== selected)) {
    throw new ThreadIdentityError(message, {
      code: "thread_identity_mismatch",
      status: 400,
    });
  }
  return present[0];
}

export function resolveThreadIdentity({ headers, body = {} } = {}) {
  const explicitThread = getHeader(headers, "thread-id");
  const metadataThread = normalize(body?.client_metadata?.thread_id);
  const codex = resolveGroup([
    ["thread-id", explicitThread],
    ["client_metadata.thread_id", metadataThread],
  ], "Conflicting Codex thread identifiers");
  if (codex) return buildIdentity("codex", codex);

  const opencodeAffinity = getHeader(headers, "x-session-affinity");
  const opencodeSession = getHeader(headers, "x-session-id");
  if (opencodeAffinity && opencodeSession && opencodeAffinity !== opencodeSession) {
    throw new ThreadIdentityError("Conflicting OpenCode session identifiers", {
      code: "thread_identity_mismatch",
      status: 400,
    });
  }
  if (opencodeAffinity) return buildIdentity("opencode", ["x-session-affinity", opencodeAffinity]);
  if (opencodeSession) return buildIdentity("opencode", ["x-session-id", opencodeSession]);

  const legacyCandidates = [
    ["prompt_cache_key", normalize(body?.prompt_cache_key)],
    ...THREAD_ID_SESSION_HEADERS.map((header) => [header, getHeader(headers, header)]),
    ["body.session_id", normalize(body?.session_id)],
  ];
  const legacy = resolveGroup(legacyCandidates, "Conflicting legacy session identifiers");
  if (!legacy) return null;
  return buildIdentity("legacy", legacy);
}

function buildIdentity(client, [source, value]) {
  const sessionKey = hashIdentity(`session-affinity:v2:${client}`, value);
  const legacySessionKey = hashIdentity("codex-thread", value);
  return {
    client,
    source,
    sessionKey,
    legacySessionKey,
    threadKey: sessionKey,
  };
}

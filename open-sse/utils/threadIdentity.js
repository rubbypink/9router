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

function hashThreadId(value) {
  return crypto.createHash("sha256").update(`codex-thread:${value}`).digest("hex");
}

export function resolveThreadIdentity({ headers, body = {} } = {}) {
  const explicitThread = getHeader(headers, "thread-id");
  const metadataThread = normalize(body?.client_metadata?.thread_id);

  if (explicitThread) {
    const conflicting = [metadataThread].filter(Boolean).find((value) => value !== explicitThread);
    if (conflicting) {
      throw new ThreadIdentityError("Conflicting Codex thread identifiers", {
        code: "thread_identity_mismatch",
        status: 400,
      });
    }
  }

  const candidates = [
    ["thread-id", explicitThread],
    ["client_metadata.thread_id", metadataThread],
    ["prompt_cache_key", normalize(body?.prompt_cache_key)],
  ];
  for (const header of THREAD_ID_SESSION_HEADERS) candidates.push([header, getHeader(headers, header)]);
  candidates.push(["body.session_id", normalize(body?.session_id)]);

  const selected = candidates.find(([, value]) => value);
  if (!selected) return null;
  return { source: selected[0], threadKey: hashThreadId(selected[1]) };
}

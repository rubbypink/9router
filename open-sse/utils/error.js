import { ERROR_TYPES, DEFAULT_ERROR_MESSAGES } from "../config/errorConfig.js";
import { resolveQuotaPolicy } from "../config/quotaPolicy.js";
import { classifyUpstreamFailure } from "../services/upstreamFailurePolicy.js";
import { redactThoughtSignatureText } from "../translator/concerns/opaqueContinuity.js";

function positiveFinite(value) {
  return Number.isFinite(value) && value > 0 ? value : null;
}

/**
 * Parse a standard Retry-After value or provider duration into milliseconds.
 * Numeric values are delay-seconds; dates are absolute HTTP-date timestamps.
 */
export function parseRetryAfterMs(value, now = Date.now()) {
  if (typeof value === "number") return positiveFinite(value) ? value * 1000 : null;
  if (typeof value !== "string") return null;

  const input = value.trim();
  if (!input) return null;
  if (/^\d+(?:\.\d+)?$/.test(input)) return Number(input) > 0 ? Number(input) * 1000 : null;

  const durationPattern = /^(?:(\d+(?:\.\d+)?)d)?(?:(\d+(?:\.\d+)?)h)?(?:(\d+(?:\.\d+)?)m)?(?:(\d+(?:\.\d+)?)s)?(?:(\d+(?:\.\d+)?)ms)?$/i;
  const duration = input.match(durationPattern);
  if (duration && duration.slice(1).some(Boolean)) {
    const ms = (Number(duration[1] || 0) * 86400000)
      + (Number(duration[2] || 0) * 3600000)
      + (Number(duration[3] || 0) * 60000)
      + (Number(duration[4] || 0) * 1000)
      + Number(duration[5] || 0);
    return positiveFinite(ms) ? ms : null;
  }

  const dateMs = Date.parse(input);
  return Number.isFinite(dateMs) && dateMs > now ? dateMs - now : null;
}

/**
 * Parse an absolute provider reset value. Numeric epoch values can be seconds
 * or milliseconds; ISO/HTTP date strings are also accepted.
 */
export function parseResetAtMs(value, now = Date.now()) {
  let candidate = null;
  if (typeof value === "number" && Number.isFinite(value)) {
    candidate = value < 100000000000 ? value * 1000 : value;
  } else if (typeof value === "string" && /^\d+(?:\.\d+)?$/.test(value.trim())) {
    const numeric = Number(value);
    candidate = numeric < 100000000000 ? numeric * 1000 : numeric;
  } else if (typeof value === "string") {
    candidate = Date.parse(value);
  }
  return Number.isFinite(candidate) && candidate > now ? candidate : null;
}

function getErrorCode(value) {
  return typeof value === "string" || typeof value === "number" ? String(value) : null;
}

function readHeader(headers, name) {
  if (!headers || !name) return null;
  if (typeof headers.get === "function") {
    return headers.get(name) ?? headers.get(name.toLowerCase()) ?? null;
  }
  const key = Object.keys(headers).find((candidate) => candidate.toLowerCase() === name.toLowerCase());
  return key ? headers[key] : null;
}

function parseStructuredDelayMs(value) {
  if (typeof value !== "string") return null;
  const match = value.match(/(?:^|[;,])\s*t\s*=\s*(\d+(?:\.\d+)?)/i);
  return match ? positiveFinite(Number(match[1]) * 1000) : null;
}

function parsePolicyHintAtMs(value, format, now) {
  if (value === null || value === undefined || value === "") return null;
  if (format === "delay-ms") {
    const delayMs = positiveFinite(Number(value));
    return delayMs ? now + delayMs : null;
  }
  if (format === "structured-delay") {
    const delayMs = parseStructuredDelayMs(String(value));
    return delayMs ? now + delayMs : null;
  }
  if (format === "timestamp") return parseResetAtMs(value, now);
  if (format === "timestamp-or-delay") {
    const absolute = parseResetAtMs(value, now);
    if (absolute) return absolute;
    const delayMs = parseRetryAfterMs(value, now);
    return delayMs ? now + delayMs : null;
  }
  const delayMs = parseRetryAfterMs(value, now);
  return delayMs ? now + delayMs : null;
}

function resolvePolicyHeaderResetAtMs(response, provider, now) {
  const policy = resolveQuotaPolicy(provider);
  const candidates = [];
  for (const hint of policy.resetHints || []) {
    const raw = readHeader(response?.headers, hint.header);
    const resetAtMs = parsePolicyHintAtMs(raw, hint.format, now);
    if (!resetAtMs) continue;
    if (hint.authoritative) return resetAtMs;
    const remainingRaw = hint.remainingHeader ? readHeader(response?.headers, hint.remainingHeader) : null;
    candidates.push({
      resetAtMs,
      exhausted: remainingRaw !== null && Number.isFinite(Number(remainingRaw)) && Number(remainingRaw) <= 0,
    });
  }
  const exhausted = candidates.filter((candidate) => candidate.exhausted);
  const eligible = exhausted.length > 0 ? exhausted : candidates;
  return eligible.length > 0 ? Math.max(...eligible.map((candidate) => candidate.resetAtMs)) : null;
}

function resolveGoogleRetryInfoAtMs(parsedJson, now) {
  const details = parsedJson?.error?.details || parsedJson?.details;
  if (!Array.isArray(details)) return null;
  for (const detail of details) {
    if (!String(detail?.["@type"] || detail?.type || "").endsWith("google.rpc.RetryInfo")) continue;
    const retryDelay = detail.retryDelay ?? detail.retry_delay;
    if (retryDelay && typeof retryDelay === "object") {
      const seconds = Number(retryDelay.seconds || 0);
      const nanos = Number(retryDelay.nanos || 0);
      const delayMs = positiveFinite((seconds * 1000) + (nanos / 1000000));
      if (delayMs) return now + delayMs;
    }
    const delayMs = parseRetryAfterMs(retryDelay, now);
    if (delayMs) return now + delayMs;
  }
  return null;
}

function resolveCommonBodyResetAtMs(parsedJson, now) {
  const values = [parsedJson, parsedJson?.error, parsedJson?.error?.details].filter(Boolean);
  for (const value of values) {
    const absolute = value.resetsAtMs ?? value.resets_at ?? value.reset_at ?? value.resetTime ?? value.reset_time;
    const resetAtMs = parseResetAtMs(absolute, now);
    if (resetAtMs) return resetAtMs;
    const delay = value.retryAfter ?? value.retry_after ?? value.resets_in_seconds ?? value.retry_after_seconds ?? value.reset_after;
    const delayMs = parseRetryAfterMs(delay, now);
    if (delayMs) return now + delayMs;
  }
  return null;
}

function resolveResetAtMs(response, parsed, parsedJson, provider, now = Date.now()) {
  const explicitReset = parseResetAtMs(parsed?.resetsAtMs, now);
  if (explicitReset) return explicitReset;

  const parsedDelay = parseRetryAfterMs(parsed?.retryAfter, now);
  if (parsedDelay) return now + parsedDelay;

  const headerReset = resolvePolicyHeaderResetAtMs(response, provider, now);
  if (headerReset) return headerReset;

  const policy = resolveQuotaPolicy(provider);
  if (policy.bodyHints?.includes("google-retry-info")) {
    const googleReset = resolveGoogleRetryInfoAtMs(parsedJson, now);
    if (googleReset) return googleReset;
  }
  return policy.bodyHints?.includes("common-reset-fields")
    ? resolveCommonBodyResetAtMs(parsedJson, now)
    : null;
}

/**
 * Build OpenAI-compatible error response body
 * @param {number} statusCode - HTTP status code
 * @param {string} message - Error message
 * @returns {object} Error response object
 */
export function buildErrorBody(statusCode, message) {
  const errorInfo = ERROR_TYPES[statusCode] || 
    (statusCode >= 500 
      ? { type: "server_error", code: "internal_server_error" }
      : { type: "invalid_request_error", code: "" });

  return {
    error: {
      message: redactThoughtSignatureText(message || DEFAULT_ERROR_MESSAGES[statusCode] || "An error occurred"),
      type: errorInfo.type,
      code: errorInfo.code
    }
  };
}

/**
 * Create error Response object (for non-streaming)
 * @param {number} statusCode - HTTP status code
 * @param {string} message - Error message
 * @returns {Response} HTTP Response object
 */
export function errorResponse(statusCode, message, code = null, details = {}) {
  const body = buildErrorBody(statusCode, message);
  if (code) body.error.code = code;
  Object.assign(body.error, details);
  return new Response(JSON.stringify(body), {
    status: statusCode,
    headers: {
      "Content-Type": "application/json",
      "Access-Control-Allow-Origin": "*"
    }
  });
}

/**
 * Write error to SSE stream (for streaming)
 * @param {WritableStreamDefaultWriter} writer - Stream writer
 * @param {number} statusCode - HTTP status code
 * @param {string} message - Error message
 */
export async function writeStreamError(writer, statusCode, message) {
  const errorBody = buildErrorBody(statusCode, message);
  const encoder = new TextEncoder();
  await writer.write(encoder.encode(`data: ${JSON.stringify(errorBody)}\n\n`));
}

/**
 * Parse upstream provider error response
 * @param {Response} response - Fetch response from provider
 * @param {object} [executor] - Optional executor with parseError() override for provider-specific parsing
 * @returns {Promise<{statusCode: number, message: string, resetsAtMs?: number, errorCode?: string}>}
 */
export async function parseUpstreamError(response, executor = null) {
  let bodyText = "";
  try {
    bodyText = await response.text();
  } catch {
    bodyText = "";
  }

  let parsedJson = null;
  try {
    parsedJson = JSON.parse(bodyText);
  } catch {}
  const provider = executor?.provider || executor?.getProvider?.() || null;

  if (executor && typeof executor.parseError === "function") {
    try {
      const parsed = executor.parseError(response, bodyText);
      if (parsed && typeof parsed === "object") {
        const msg = redactThoughtSignatureText(parsed.message || DEFAULT_ERROR_MESSAGES[response.status] || `Upstream error: ${response.status}`);
        const statusCode = parsed.status || response.status;
        const errorCode = getErrorCode(parsed.errorCode) || getErrorCode(parsed.code);
        const resetsAtMs = resolveResetAtMs(response, parsed, parsedJson, provider);
        const disposition = classifyUpstreamFailure({
          provider,
          status: statusCode,
          error: msg,
          errorCode,
          resetsAtMs,
        });
        return {
          statusCode,
          message: disposition.safeMessage || msg,
          resetsAtMs,
          errorCode,
          disposition,
        };
      }
    } catch {}
  }

  let message = "";
  try {
    if (!parsedJson) parsedJson = JSON.parse(bodyText);
    message = parsedJson.error?.message
      || parsedJson.detail?.message
      || parsedJson.message
      || parsedJson.error
      || parsedJson.detail
      || bodyText;
  } catch {
    message = bodyText;
  }

  const messageStr = typeof message === "string" ? message : JSON.stringify(message);
  const finalMessage = redactThoughtSignatureText(messageStr || DEFAULT_ERROR_MESSAGES[response.status] || `Upstream error: ${response.status}`);
  const errorCode = getErrorCode(parsedJson?.error?.code) || getErrorCode(parsedJson?.error?.status) || getErrorCode(parsedJson?.code);
  const resetsAtMs = resolveResetAtMs(response, null, parsedJson, provider);
  const disposition = classifyUpstreamFailure({
    provider,
    status: response.status,
    error: finalMessage,
    errorCode,
    resetsAtMs,
  });

  return {
    statusCode: response.status,
    message: disposition.safeMessage || finalMessage,
    resetsAtMs,
    errorCode,
    disposition,
  };
}

/**
 * Create error result for chatCore handler
 * @param {number} statusCode - HTTP status code
 * @param {string} message - Error message
 * @param {number} [resetsAtMs] - Optional precise cooldown expiry (ms epoch) for provider-specific quota errors
 * @param {{errorCode?: string|null}} [failure] - Provider metadata retained for routing health.
 * @returns {{ success: false, status: number, error: string, response: Response, resetsAtMs?: number, errorCode?: string|null }}
 */
export function createErrorResult(statusCode, message, resetsAtMs, failure = {}) {
  const safeMessage = redactThoughtSignatureText(message);
  return {
    success: false,
    status: statusCode,
    error: safeMessage,
    resetsAtMs,
    errorCode: failure.errorCode || null,
    disposition: failure.disposition || null,
    response: errorResponse(statusCode, safeMessage)
  };
}

export function createTypedErrorResult(statusCode, message, code, details = {}) {
  const safeMessage = redactThoughtSignatureText(message);
  return {
    success: false,
    status: statusCode,
    error: safeMessage,
    response: errorResponse(statusCode, safeMessage, code, details)
  };
}

export function createRoutingErrorResult(statusCode, message, code, details = {}) {
  const safeMessage = redactThoughtSignatureText(message);
  return {
    success: false,
    status: statusCode,
    error: safeMessage,
    errorCode: code,
    routingFailure: true,
    response: errorResponse(statusCode, safeMessage, code, details),
  };
}

/**
 * Create unavailable response when all accounts are rate limited
 * @param {number} statusCode - Original error status code
 * @param {string} message - Error message (without retry info)
 * @param {string} retryAfter - ISO timestamp when earliest account becomes available
 * @param {string} retryAfterHuman - Human-readable retry info e.g. "reset after 30s"
 * @param {string|null} [errorCode] - Optional machine-readable unavailable reason
 * @returns {Response}
 */
export function unavailableResponse(statusCode, message, retryAfter, retryAfterHuman, errorCode = null) {
  const retryAfterSec = Math.max(Math.ceil((new Date(retryAfter).getTime() - Date.now()) / 1000), 1);
  const msg = redactThoughtSignatureText(`${message} (${retryAfterHuman})`);
  const error = { message: msg };
  if (errorCode) error.code = errorCode;
  return new Response(
    JSON.stringify({ error }),
    {
      status: statusCode,
      headers: {
        "Content-Type": "application/json",
        "Retry-After": String(retryAfterSec)
      }
    }
  );
}

/**
 * Format provider error with context
 * @param {Error} error - Original error
 * @param {string} provider - Provider name
 * @param {string} model - Model name
 * @param {number|string} statusCode - HTTP status code or error code
 * @returns {string} Formatted error message
 */
export function formatProviderError(error, provider, model, statusCode) {
  const code = statusCode || error.code || "FETCH_FAILED";
  const message = redactThoughtSignatureText(error.message || "Unknown error");
  // Expose low-level cause (e.g. UND_ERR_SOCKET, ECONNRESET, ETIMEDOUT) for diagnosing fetch failures
  const causeCode = error.cause?.code;
  const causeMsg = error.cause?.message;
  const causeStr = causeCode || causeMsg
    ? ` (cause: ${redactThoughtSignatureText([causeCode, causeMsg].filter(Boolean).join(": "))})`
    : "";
  return `[${code}]: ${message}${causeStr}`;
}

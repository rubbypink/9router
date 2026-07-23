export const FAILURE_CLASS = Object.freeze({
  QUOTA: "quota",
  TRANSIENT_ENDPOINT: "transient_endpoint",
  PROTOCOL_CONTINUITY: "protocol_continuity",
  NO_CREDENTIALS: "no_credentials",
  NON_RETRYABLE: "non_retryable",
});

export const NVIDIA_FUNCTION_INVOCATION_TIMEOUT_COOLDOWN_MS = 5_000;

const QUOTA_TEXT = /\b(quota|rate limit|too many requests|usage limit|out of credits|no credits|spending limit)\b/i;
const TRANSIENT_TEXT = /\b(timeout|timed out|overload(?:ed)?|temporarily unavailable|service unavailable|capacity|resource ?exhausted)\b/i;
const CREDENTIAL_TEXT = /\b(no credentials|invalid api key|invalid token|unauthori[sz]ed|forbidden|authentication)\b/i;
const GEMINI_THOUGHT_SIGNATURE_TEXT = /\bthought[_ ]signature\b/i;
const ACCOUNT_SCOPED_QUOTA_PROVIDERS = new Set(["codex", "cloudflare", "cloudflare-ai", "fm", "freemodel"]);
const MODEL_SCOPED_QUOTA_PROVIDERS = new Set(["antigravity", "opencode-go", "gemini-cli"]);

function validFutureRetryAt(value, now) {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > now ? parsed : null;
}

function quotaScope(provider, text) {
  if (/\b(provider|organization|project)[ -]?(?:wide )?(?:quota|limit)\b/i.test(text)) return "provider";
  if (/\b(account|subscription|plan)[ -]?(?:wide )?(?:quota|limit)\b/i.test(text)) return "account";
  if (ACCOUNT_SCOPED_QUOTA_PROVIDERS.has(provider)) return "account";
  if (MODEL_SCOPED_QUOTA_PROVIDERS.has(provider)) return "model";
  return "model";
}

function result(failureClass, scope, retryMode, { retryAtMs = null, evidence = null, cooldownMs = null, safeMessage = null } = {}) {
  return { failureClass, scope, retryMode, retryAtMs, evidence, cooldownMs, safeMessage };
}

export function classifyUpstreamFailure({ provider, status, error, errorCode, resetsAtMs, now = Date.now() } = {}) {
  const providerId = String(provider || "").toLowerCase();
  const message = `${error || ""} ${errorCode || ""}`.trim();
  const retryAtMs = validFutureRetryAt(resetsAtMs, now);

  if ((providerId === "gemini" || providerId === "gemini-cli") && GEMINI_THOUGHT_SIGNATURE_TEXT.test(message)) {
    return result(FAILURE_CLASS.PROTOCOL_CONTINUITY, "none", "terminal", {
      evidence: "gemini-thought-signature",
      safeMessage: "Gemini thought signature is required for this tool continuation",
    });
  }

  if (providerId === "nvidia" && status === 504 && /\bFUNCTION_INVOCATION_TIMEOUT\b/.test(message)) {
    return result(FAILURE_CLASS.TRANSIENT_ENDPOINT, "endpoint", "same_target_once", {
      evidence: "nvidia-function-invocation-timeout",
      cooldownMs: NVIDIA_FUNCTION_INVOCATION_TIMEOUT_COOLDOWN_MS,
      safeMessage: "NVIDIA function invocation timed out",
    });
  }

  if (status === 429 || QUOTA_TEXT.test(message)) {
    return result(FAILURE_CLASS.QUOTA, quotaScope(providerId, message), "fallback", {
      retryAtMs,
      evidence: retryAtMs ? "provider-reset" : "explicit-quota",
    });
  }

  if ([401, 402, 403].includes(status) || CREDENTIAL_TEXT.test(message)) {
    return result(FAILURE_CLASS.NO_CREDENTIALS, "account", "fallback", {
      evidence: "credential-error",
    });
  }

  if ((Number.isInteger(status) && status >= 500) || TRANSIENT_TEXT.test(message)) {
    return result(FAILURE_CLASS.TRANSIENT_ENDPOINT, "model", "fallback", {
      evidence: "transient-upstream",
    });
  }

  return result(FAILURE_CLASS.NON_RETRYABLE, "none", "terminal", {
    evidence: "deterministic-or-unknown",
  });
}

export function isAvailabilityFailure(disposition) {
  return disposition?.failureClass === FAILURE_CLASS.QUOTA
    || disposition?.failureClass === FAILURE_CLASS.TRANSIENT_ENDPOINT
    || disposition?.failureClass === FAILURE_CLASS.NO_CREDENTIALS;
}

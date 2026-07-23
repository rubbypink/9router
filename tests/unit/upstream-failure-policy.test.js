import { describe, expect, it } from "vitest";

import {
  FAILURE_CLASS,
  classifyUpstreamFailure,
} from "../../open-sse/services/upstreamFailurePolicy.js";

describe("upstream failure disposition", () => {
  it("classifies an explicit quota reset as proactive model availability state", () => {
    const retryAtMs = Date.now() + 60_000;

    expect(classifyUpstreamFailure({
      provider: "gemini",
      model: "gemini-2.5-pro",
      status: 429,
      error: "Quota exceeded",
      resetsAtMs: retryAtMs,
    })).toMatchObject({
      failureClass: FAILURE_CLASS.QUOTA,
      scope: "model",
      retryAtMs,
      retryMode: "fallback",
      evidence: "provider-reset",
    });
  });

  it("keeps a generic upstream 5xx transient instead of quota", () => {
    expect(classifyUpstreamFailure({
      provider: "openai",
      model: "gpt-5.6",
      status: 503,
      error: "upstream service unavailable",
    })).toMatchObject({
      failureClass: FAILURE_CLASS.TRANSIENT_ENDPOINT,
      scope: "model",
      retryMode: "fallback",
    });
  });

  it("fails open for ambiguous non-provider errors", () => {
    expect(classifyUpstreamFailure({
      provider: "openai",
      model: "gpt-5.6",
      status: 400,
      error: "validation failed for user input",
    })).toMatchObject({
      failureClass: FAILURE_CLASS.NON_RETRYABLE,
      scope: "none",
      retryMode: "terminal",
    });
  });

  it("classifies only NVIDIA function invocation timeout for same-target retry", () => {
    expect(classifyUpstreamFailure({
      provider: "nvidia",
      model: "meta/llama",
      status: 504,
      error: "An error occurred with your deployment FUNCTION_INVOCATION_TIMEOUT sin1::opaque-id",
    })).toMatchObject({
      failureClass: FAILURE_CLASS.TRANSIENT_ENDPOINT,
      scope: "endpoint",
      retryMode: "same_target_once",
      evidence: "nvidia-function-invocation-timeout",
    });

    expect(classifyUpstreamFailure({
      provider: "openai",
      model: "gpt-5.6",
      status: 504,
      error: "FUNCTION_INVOCATION_TIMEOUT",
    }).retryMode).toBe("fallback");
  });

  it("makes missing Gemini thought signatures terminal protocol errors", () => {
    expect(classifyUpstreamFailure({
      provider: "gemini",
      model: "gemini-2.5-pro",
      status: 400,
      error: "Function call is missing a thought_signature in functionCall parts.",
    })).toMatchObject({
      failureClass: FAILURE_CLASS.PROTOCOL_CONTINUITY,
      scope: "none",
      retryMode: "terminal",
    });
  });
});

import { describe, expect, it } from "vitest";

import { parseResetAtMs, parseRetryAfterMs, parseUpstreamError } from "../../open-sse/utils/error.js";

describe("upstream retry hints", () => {
  it("parses composite provider durations down to milliseconds", () => {
    expect(parseRetryAfterMs("1d2h3m4s500ms")).toBe(93_784_500);
  });
  it("normalizes provider duration and absolute reset values", () => {
    const now = Date.UTC(2026, 6, 19, 0, 0, 0);
    expect(parseRetryAfterMs("3.5s", now)).toBe(3500);
    expect(parseRetryAfterMs("2h7m", now)).toBe(7620000);
    expect(parseResetAtMs(now / 1000 + 60, now)).toBe(now + 60000);
    expect(parseResetAtMs(new Date(now + 60000).toISOString(), now)).toBe(now + 60000);
  });

  it("preserves retry and provider-code metadata from a Responses-compatible error", async () => {
    const before = Date.now();
    const response = new Response(JSON.stringify({
      error: { message: "quota exhausted", code: "usage_limit_reached" },
    }), {
      status: 429,
      headers: { "retry-after": "2" },
    });

    const result = await parseUpstreamError(response);

    expect(result).toMatchObject({
      statusCode: 429,
      message: "quota exhausted",
      errorCode: "usage_limit_reached",
    });
    expect(result.resetsAtMs).toBeGreaterThanOrEqual(before + 1900);
  });

  it("keeps a provider parser retry hint when the provider uses a custom schema", async () => {
    const before = Date.now();
    const response = new Response("{}", { status: 429 });
    const executor = {
      parseError: () => ({
        status: 429,
        message: "provider quota",
        retryAfter: "3.5s",
        errorCode: "RESOURCE_EXHAUSTED",
      }),
    };

    const result = await parseUpstreamError(response, executor);

    expect(result).toMatchObject({
      statusCode: 429,
      message: "provider quota",
      errorCode: "RESOURCE_EXHAUSTED",
    });
    expect(result.resetsAtMs).toBeGreaterThanOrEqual(before + 3400);
  });

  it("uses the exhausted OpenAI rate-limit dimension", async () => {
    const before = Date.now();
    const response = new Response(JSON.stringify({ error: { message: "rate limited" } }), {
      status: 429,
      headers: {
        "x-ratelimit-remaining-requests": "0",
        "x-ratelimit-reset-requests": "2s",
        "x-ratelimit-remaining-tokens": "10",
        "x-ratelimit-reset-tokens": "20s",
      },
    });

    const result = await parseUpstreamError(response, { provider: "openai" });

    expect(result.resetsAtMs).toBeGreaterThanOrEqual(before + 1_900);
    expect(result.resetsAtMs).toBeLessThan(before + 3_000);
  });

  it("honors Azure millisecond Retry-After before generic headers", async () => {
    const before = Date.now();
    const response = new Response("quota", {
      status: 429,
      headers: { "retry-after-ms": "1250", "retry-after": "20" },
    });

    const result = await parseUpstreamError(response, { provider: "azure" });

    expect(result.resetsAtMs).toBeGreaterThanOrEqual(before + 1_200);
    expect(result.resetsAtMs).toBeLessThan(before + 2_000);
  });

  it("parses Anthropic RFC3339 reset headers", async () => {
    const resetAt = Date.now() + 60_000;
    const response = new Response("quota", {
      status: 429,
      headers: {
        "anthropic-ratelimit-requests-remaining": "0",
        "anthropic-ratelimit-requests-reset": new Date(resetAt).toISOString(),
      },
    });

    const result = await parseUpstreamError(response, { provider: "anthropic" });

    expect(result.resetsAtMs).toBe(resetAt);
  });

  it("parses Google RetryInfo from structured error details", async () => {
    const before = Date.now();
    const response = new Response(JSON.stringify({
      error: {
        message: "resource exhausted",
        details: [{
          "@type": "type.googleapis.com/google.rpc.RetryInfo",
          retryDelay: "3.5s",
        }],
      },
    }), { status: 429 });

    const result = await parseUpstreamError(response, { provider: "gemini" });

    expect(result.resetsAtMs).toBeGreaterThanOrEqual(before + 3_400);
  });

  it("classifies the exact NVIDIA function timeout without retaining its opaque request suffix", async () => {
    const response = new Response(JSON.stringify({
      error: {
        message: "An error occurred with your deployment FUNCTION_INVOCATION_TIMEOUT sin1::7s8kv-178477620599",
      },
    }), { status: 504 });

    const result = await parseUpstreamError(response, { provider: "nvidia" });

    expect(result.disposition).toMatchObject({
      failureClass: "transient_endpoint",
      scope: "endpoint",
      retryMode: "same_target_once",
      cooldownMs: 5_000,
    });
    expect(result.message).toBe("NVIDIA function invocation timed out");
  });

  it("marks a Gemini thought-signature failure as a terminal continuity error", async () => {
    const response = new Response(JSON.stringify({
      error: {
        message: "Function call is missing a thought_signature in functionCall parts.",
      },
    }), { status: 400 });

    const result = await parseUpstreamError(response, { provider: "gemini" });

    expect(result.disposition).toMatchObject({
      failureClass: "protocol_continuity",
      retryMode: "terminal",
    });
  });
});

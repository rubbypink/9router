import { describe, expect, it } from "vitest";

import { checkFallbackError } from "../../open-sse/services/accountFallback.js";

describe("provider/account fallback policy", () => {
  it.each([400, 409, 413, 422])("does not switch route for deterministic client error %i", (status) => {
    expect(checkFallbackError(status, "invalid request schema")).toEqual({
      shouldFallback: false,
      cooldownMs: 0,
    });
  });

  it.each([401, 402, 403, 404, 429, 500, 502, 503, 504])("allows fallback for explicit provider failure %i", (status) => {
    expect(checkFallbackError(status, "upstream provider failure").shouldFallback).toBe(true);
  });

  it("fails closed for an unknown status or exception", () => {
    expect(checkFallbackError(418, "unexpected client response")).toEqual({
      shouldFallback: false,
      cooldownMs: 0,
    });
    expect(checkFallbackError(undefined, "unexpected exception")).toEqual({
      shouldFallback: false,
      cooldownMs: 0,
    });
  });

  it("does not classify malformed/request-not-allowed text as provider failure", () => {
    expect(checkFallbackError(400, "improperly formed request").shouldFallback).toBe(false);
    expect(checkFallbackError(400, "request not allowed by schema").shouldFallback).toBe(false);
    expect(checkFallbackError(400, "capacity field is invalid").shouldFallback).toBe(false);
  });

  it("reroutes NVIDIA worker-pool exhaustion even when the upstream maps it to 400", () => {
    expect(checkFallbackError(400, "ResourceExhausted: Worker local total request limit reached (516/48)").shouldFallback).toBe(true);
  });
});

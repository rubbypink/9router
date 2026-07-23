import { describe, expect, it } from "vitest";

import {
  REQUEST_EXECUTION_POLICY,
  buildProviderQuotaPolicies,
  resolveQuotaPolicy,
} from "../../open-sse/config/quotaPolicy.js";
import REGISTRY from "../../open-sse/providers/registry/index.js";

describe("provider quota policy", () => {
  it("resolves a policy for every registered provider", () => {
    const policies = buildProviderQuotaPolicies(REGISTRY);

    expect(Object.keys(policies)).toHaveLength(REGISTRY.length);
    expect(Object.values(policies).every((policy) => policy?.id)).toBe(true);
  });

  it("uses provider-specific reset contracts where official signals exist", () => {
    expect(resolveQuotaPolicy("openai").id).toBe("openai");
    expect(resolveQuotaPolicy("codex").id).toBe("openai");
    expect(resolveQuotaPolicy("anthropic").id).toBe("anthropic");
    expect(resolveQuotaPolicy("kimi").id).toBe("anthropic-compatible");
    expect(resolveQuotaPolicy("gemini").id).toBe("google");
    expect(resolveQuotaPolicy("together").id).toBe("together");
    expect(resolveQuotaPolicy("stability-ai")).toMatchObject({
      id: "stability",
      fallbackCooldownMs: 60_000,
    });
  });

  it("supports dynamic compatible providers without configuration toggles", () => {
    expect(resolveQuotaPolicy("openai-compatible-team").id).toBe("openai-compatible");
    expect(resolveQuotaPolicy("anthropic-compatible-team").id).toBe("anthropic-compatible");
    expect(resolveQuotaPolicy("custom-embedding-team").id).toBe("openai-compatible");
    expect(REQUEST_EXECUTION_POLICY).toEqual({
      maxAttempts: 16,
      minEndpointIntervalMs: 2_000,
    });
  });
});

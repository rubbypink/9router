import { describe, expect, it } from "vitest";

import { shouldSkipDynamicModelFetch } from "../../src/app/api/v1/models/route.js";

describe("Codex model catalog refresh", () => {
  it("skips dynamic provider discovery for Codex client-version requests", () => {
    expect(shouldSkipDynamicModelFetch(
      new Request("http://127.0.0.1:20128/v1/models?client_version=0.144.1"),
    )).toBe(true);
  });

  it("preserves dynamic provider discovery for regular model-list requests", () => {
    expect(shouldSkipDynamicModelFetch(
      new Request("http://127.0.0.1:20128/v1/models"),
    )).toBe(false);
  });
});

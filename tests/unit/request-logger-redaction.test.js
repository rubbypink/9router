import { describe, expect, it } from "vitest";

import {
  maskSensitiveHeaders,
  safeLogPayload,
} from "../../open-sse/utils/requestLogger.js";

describe("request logger redaction", () => {
  it("always redacts secret-bearing headers", () => {
    expect(maskSensitiveHeaders({
      authorization: "Bearer private",
      "x-api-key": "private",
      cookie: "session=private",
      accept: "application/json",
    })).toEqual({
      authorization: "[REDACTED]",
      "x-api-key": "[REDACTED]",
      cookie: "[REDACTED]",
      accept: "application/json",
    });
  });

  it("redacts secret-bearing provider response headers", () => {
    const masked = maskSensitiveHeaders(new Headers({
      authorization: "Bearer response-secret",
      "set-cookie": "session=response-secret",
      "content-type": "application/json",
    }));

    expect(masked.authorization).toBe("[REDACTED]");
    expect(masked["set-cookie"]).toBe("[REDACTED]");
    expect(masked["content-type"]).toBe("application/json");
  });

  it("records metadata instead of payload content by default", () => {
    expect(safeLogPayload({ input: "private", model: "test" })).toEqual({
      redacted: true,
      type: "object",
      keys: ["input", "model"],
    });
  });
});

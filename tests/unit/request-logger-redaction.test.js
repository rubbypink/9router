import { describe, expect, it } from "vitest";

import {
  maskSensitiveHeaders,
  safeLogPayload,
} from "../../open-sse/utils/requestLogger.js";
import { redactThoughtSignatureText, redactThoughtSignatures } from "../../open-sse/translator/concerns/opaqueContinuity.js";
import { buildRequestDetail } from "../../open-sse/handlers/chatCore/requestDetail.js";

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

  it("redacts Gemini signatures without mutating the outbound payload", () => {
    const signature = "opaque-signature-do-not-log";
    const payload = {
      contents: [{ parts: [{ thoughtSignature: signature, functionCall: { name: "task_create" } }] }],
    };

    const redacted = redactThoughtSignatures(payload);

    expect(redacted.contents[0].parts[0].thoughtSignature).toBe("[REDACTED]");
    expect(payload.contents[0].parts[0].thoughtSignature).toBe(signature);
    expect(redactThoughtSignatureText(JSON.stringify(payload))).not.toContain(signature);

    const nestedSerializedPayload = JSON.stringify({ nested: JSON.stringify(payload) });
    expect(redactThoughtSignatureText(nestedSerializedPayload)).not.toContain(signature);
  });

  it("does not persist a Gemini signature in request details", () => {
    const signature = "opaque-signature-detail-only";
    const detail = buildRequestDetail({
      provider: "gemini",
      model: "gemini-2.5-pro",
      request: { contents: [{ parts: [{ thought_signature: signature }] }] },
      providerRequest: { contents: [{ parts: [{ thoughtSignature: signature }] }] },
      providerResponse: { candidates: [{ content: { parts: [{ thoughtSignature: signature }] } }] },
      response: { content: "ok" },
    });

    expect(JSON.stringify(detail)).not.toContain(signature);
  });

  it("redacts request-detail overrides after they are merged", () => {
    const signature = "opaque-signature-override-only";
    const detail = buildRequestDetail(
      { provider: "gemini", model: "gemini-2.5-pro", request: { messages: [] } },
      { response: { error: JSON.stringify({ thoughtSignature: signature }) } },
    );

    expect(JSON.stringify(detail)).not.toContain(signature);
  });
});

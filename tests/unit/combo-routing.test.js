import { describe, it, expect, beforeEach } from "vitest";

import {
  getRotatedModels,
  handleComboChat,
  hasOpaqueResponsesContent,
  isCodexNativeModel,
  resetComboRotation,
} from "../../open-sse/services/combo.js";

describe("combo round-robin routing", () => {
  beforeEach(() => {
    resetComboRotation();
  });

  it("keeps existing one-request round-robin behavior by default", () => {
    const models = ["provider/model-a", "provider/model-b"];

    const firstChoices = Array.from({ length: 4 }, () => (
      getRotatedModels(models, "code-xhigh", "round-robin")[0]
    ));

    expect(firstChoices).toEqual([
      "provider/model-a",
      "provider/model-b",
      "provider/model-a",
      "provider/model-b",
    ]);
  });

  it("sticks to each combo model for the configured number of requests", () => {
    const models = ["provider/model-a", "provider/model-b"];

    const firstChoices = Array.from({ length: 6 }, () => (
      getRotatedModels(models, "code-xhigh", "round-robin", 2)[0]
    ));

    expect(firstChoices).toEqual([
      "provider/model-a",
      "provider/model-a",
      "provider/model-b",
      "provider/model-b",
      "provider/model-a",
      "provider/model-a",
    ]);
  });

  it("tracks sticky rotation independently per combo", () => {
    const models = ["provider/model-a", "provider/model-b"];

    expect(getRotatedModels(models, "code-high", "round-robin", 2)[0]).toBe("provider/model-a");
    expect(getRotatedModels(models, "code-xhigh", "round-robin", 2)[0]).toBe("provider/model-a");
    expect(getRotatedModels(models, "code-high", "round-robin", 2)[0]).toBe("provider/model-a");
    expect(getRotatedModels(models, "code-high", "round-robin", 2)[0]).toBe("provider/model-b");
    expect(getRotatedModels(models, "code-xhigh", "round-robin", 2)[0]).toBe("provider/model-a");
  });

  it("does not rotate fallback combos", () => {
    const models = ["provider/model-a", "provider/model-b"];

    expect(getRotatedModels(models, "code-xhigh", "fallback", 2)).toEqual(models);
    expect(getRotatedModels(models, "code-xhigh", "fallback", 2)).toEqual(models);
  });

  it("uses a thread-pinned model before round-robin state", async () => {
    const calls = [];
    const response = await handleComboChat({
      body: { messages: [{ role: "user", content: "hello" }] },
      models: ["provider/model-a", "provider/model-b"],
      handleSingleModel: async (_body, model) => {
        calls.push(model);
        return new Response("ok");
      },
      log: { info() {}, warn() {} },
      comboName: "quick",
      comboStrategy: "round-robin",
      preferredModel: "provider/model-b",
    });

    expect(response.ok).toBe(true);
    expect(calls).toEqual(["provider/model-b"]);
  });

  it("falls away from a pinned model only for an eligible provider failure", async () => {
    const calls = [];
    const response = await handleComboChat({
      body: { messages: [{ role: "user", content: "hello" }] },
      models: ["provider/model-a", "provider/model-b"],
      handleSingleModel: async (_body, model) => {
        calls.push(model);
        if (model === "provider/model-b") {
          return new Response(JSON.stringify({ error: { message: "upstream failed" } }), {
            status: 500,
            headers: { "content-type": "application/json" },
          });
        }
        return new Response("ok");
      },
      log: { info() {}, warn() {} },
      comboName: "quick",
      comboStrategy: "round-robin",
      preferredModel: "provider/model-b",
    });

    expect(response.ok).toBe(true);
    expect(calls).toEqual(["provider/model-b", "provider/model-a"]);
  });

  it("returns the pinned 404 when an eligible fallback callback vetoes rotation", async () => {
    const calls = [];
    const fallbackEvents = [];
    const response = await handleComboChat({
      body: { messages: [{ role: "user", content: "hello" }] },
      models: ["provider/model-a", "provider/model-b"],
      handleSingleModel: async (_body, model) => {
        calls.push(model);
        if (model === "provider/model-b") {
          return new Response("pinned model not found", { status: 404 });
        }
        return new Response("unexpected fallback");
      },
      log: { info() {}, warn() {} },
      comboName: "quick",
      comboStrategy: "fallback",
      preferredModel: "provider/model-b",
      onEligibleFallback: (event) => {
        fallbackEvents.push(event);
        return false;
      },
    });

    expect(response.status).toBe(404);
    await expect(response.text()).resolves.toBe("pinned model not found");
    expect(calls).toEqual(["provider/model-b"]);
    expect(fallbackEvents).toEqual([{ model: "provider/model-b", status: 404 }]);
  });

  it("keeps legacy eligible 404 fallback when no veto callback is supplied", async () => {
    const calls = [];
    const response = await handleComboChat({
      body: { messages: [{ role: "user", content: "hello" }] },
      models: ["provider/model-a", "provider/model-b"],
      handleSingleModel: async (_body, model) => {
        calls.push(model);
        if (model === "provider/model-b") {
          return new Response("legacy model not found", { status: 404 });
        }
        return new Response("legacy fallback");
      },
      log: { info() {}, warn() {} },
      comboName: "quick",
      comboStrategy: "fallback",
      preferredModel: "provider/model-b",
    });

    expect(response.ok).toBe(true);
    await expect(response.text()).resolves.toBe("legacy fallback");
    expect(calls).toEqual(["provider/model-b", "provider/model-a"]);
  });

  it("does not try another combo model for a deterministic 400", async () => {
    const calls = [];
    const response = await handleComboChat({
      body: { messages: [{ role: "user", content: "hello" }] },
      models: ["provider/model-a", "provider/model-b"],
      handleSingleModel: async (_body, model) => {
        calls.push(model);
        return new Response(JSON.stringify({ error: { message: "invalid schema" } }), {
          status: 400,
          headers: { "content-type": "application/json" },
        });
      },
      log: { info() {}, warn() {} },
      comboName: "quick",
      comboStrategy: "fallback",
      preferredModel: "provider/model-b",
    });

    expect(response.status).toBe(400);
    expect(calls).toEqual(["provider/model-b"]);
  });

  it("does not switch models after an unclassified handler exception", async () => {
    const calls = [];
    const response = await handleComboChat({
      body: { messages: [{ role: "user", content: "hello" }] },
      models: ["provider/model-a", "provider/model-b"],
      handleSingleModel: async (_body, model) => {
        calls.push(model);
        throw new Error("unexpected gateway bug");
      },
      log: { info() {}, warn() {} },
      comboName: "quick",
      comboStrategy: "fallback",
      preferredModel: "provider/model-b",
    });

    expect(response.status).toBe(500);
    expect(calls).toEqual(["provider/model-b"]);
  });

  it("stops combo fallback when the logical request attempt budget is exhausted", async () => {
    const calls = [];
    const response = await handleComboChat({
      body: { messages: [{ role: "user", content: "hello" }] },
      models: ["provider/model-a", "provider/model-b"],
      handleSingleModel: async (_body, model) => {
        calls.push(model);
        return new Response(JSON.stringify({
          error: {
            message: "Upstream attempt budget exhausted (4/4)",
            code: "upstream_attempt_budget_exhausted",
          },
        }), { status: 503, headers: { "content-type": "application/json" } });
      },
      log: { info() {}, warn() {} },
      comboName: "quick",
      comboStrategy: "fallback",
    });

    expect(response.status).toBe(503);
    expect(calls).toEqual(["provider/model-a"]);
  });

  it("routes opaque Codex inter-agent content only through a native Responses model", async () => {
    const calls = [];
    const rebinds = [];
    const body = {
      input: [{
        type: "message",
        role: "user",
        content: [
          { type: "input_text", text: "delegated task" },
          { type: "encrypted_content", encrypted_content: "enc_payload" },
        ],
      }],
    };

    const response = await handleComboChat({
      body,
      models: ["fm/gpt-5.6-terra", "cx/gpt-5.6-terra", "provider/model-b"],
      handleSingleModel: async (_body, model) => {
        calls.push(model);
        return new Response("ok");
      },
      log: { info() {}, warn() {} },
      comboName: "codex",
      comboStrategy: "fallback",
      preferredModel: "fm/gpt-5.6-terra",
      onRequiredTransportRebind: ({ model }) => rebinds.push(model),
    });

    expect(response.ok).toBe(true);
    expect(hasOpaqueResponsesContent(body)).toBe(true);
    expect(isCodexNativeModel("cx/gpt-5.6-terra")).toBe(true);
    expect(calls).toEqual(["cx/gpt-5.6-terra"]);
    expect(rebinds).toEqual(["fm/gpt-5.6-terra"]);
  });

  it("returns a typed conflict when opaque Codex content has no compatible route", async () => {
    const response = await handleComboChat({
      body: {
        input: [{ content: [{ type: "encrypted_content", encrypted_content: "enc_payload" }] }],
      },
      models: ["fm/gpt-5.6-terra"],
      handleSingleModel: async () => new Response("unexpected"),
      log: { info() {}, warn() {} },
      comboName: "codex",
      comboStrategy: "fallback",
    });

    expect(response.status).toBe(409);
    await expect(response.json()).resolves.toMatchObject({
      error: { code: "codex_responses_route_unavailable" },
    });
  });
});

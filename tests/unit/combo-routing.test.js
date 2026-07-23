import { describe, it, expect, beforeEach } from "vitest";

import {
  getRotatedModels,
  handleComboChat,
  resetComboRotation,
} from "../../open-sse/services/combo.js";
import { ACCOUNT_EXHAUSTED_ERROR_CODE } from "../../open-sse/config/errorConfig.js";

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

  it("keeps a thread-pinned model ahead of combo round-robin", async () => {
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

  it("falls away from a pinned fallback model only for an eligible provider failure", async () => {
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
      comboStrategy: "fallback",
      preferredModel: "provider/model-b",
    });

    expect(response.ok).toBe(true);
    expect(calls).toEqual(["provider/model-b", "provider/model-a"]);
  });

  it("skips a combo route with no quota-available account before provider account selection", async () => {
    const events = [];
    const retryAfter = new Date(Date.now() + 60_000).toISOString();
    const response = await handleComboChat({
      body: { messages: [{ role: "user", content: "hello" }] },
      models: ["provider-a/model-a", "provider-b/model-b"],
      getModelAvailability: async (model) => {
        events.push(`availability:${model}`);
        return model === "provider-a/model-a"
          ? { available: false, retryAfter, reason: "quota" }
          : { available: true };
      },
      onModelSelected: async ({ model }) => {
        events.push(`selected:${model}`);
      },
      handleSingleModel: async (_body, model) => {
        events.push(`account:${model}`);
        return new Response("ok");
      },
      log: { info() {}, warn() {} },
      comboName: "quick",
      comboStrategy: "round-robin",
    });

    expect(response.ok).toBe(true);
    expect(events).toEqual([
      "availability:provider-a/model-a",
      "availability:provider-b/model-b",
      "selected:provider-b/model-b",
      "account:provider-b/model-b",
    ]);
  });

  it("notifies affinity state without letting the callback veto a configured fallback", async () => {
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
        return new Response("configured fallback");
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

    expect(response.ok).toBe(true);
    await expect(response.text()).resolves.toBe("configured fallback");
    expect(calls).toEqual(["provider/model-b", "provider/model-a"]);
    expect(fallbackEvents).toEqual([{ model: "provider/model-b", status: 404 }]);
  });

  it("ignores a stale pin and starts with a model that remains in the combo", async () => {
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
      comboStrategy: "fallback",
      preferredModel: "provider/model-removed",
    });

    expect(response.ok).toBe(true);
    expect(calls).toEqual(["provider/model-a"]);
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

  it("tries the next combo model when a handler marks all provider accounts unavailable", async () => {
    const calls = [];
    const response = await handleComboChat({
      body: { messages: [{ role: "user", content: "hello" }] },
      models: ["provider-a/model-a", "provider-b/model-b"],
      handleSingleModel: async (_body, model) => {
        calls.push(model);
        if (model === "provider-a/model-a") {
          return new Response(JSON.stringify({
            error: {
              message: "All accounts unavailable",
              code: ACCOUNT_EXHAUSTED_ERROR_CODE,
            },
          }), {
            status: 400,
            headers: { "content-type": "application/json" },
          });
        }
        return new Response("provider-b fallback");
      },
      log: { info() {}, warn() {} },
      comboName: "quota-combo",
      comboStrategy: "fallback",
    });

    expect(response.ok).toBe(true);
    await expect(response.text()).resolves.toBe("provider-b fallback");
    expect(calls).toEqual(["provider-a/model-a", "provider-b/model-b"]);
  });

  it("tries the next configured model after an unclassified handler exception", async () => {
    const calls = [];
    const response = await handleComboChat({
      body: { messages: [{ role: "user", content: "hello" }] },
      models: ["provider/model-a", "provider/model-b"],
      handleSingleModel: async (_body, model) => {
        calls.push(model);
        if (model === "provider/model-b") throw new Error("unexpected gateway bug");
        return new Response("recovered");
      },
      log: { info() {}, warn() {} },
      comboName: "quick",
      comboStrategy: "fallback",
      preferredModel: "provider/model-b",
    });

    expect(response.ok).toBe(true);
    await expect(response.text()).resolves.toBe("recovered");
    expect(calls).toEqual(["provider/model-b", "provider/model-a"]);
  });

  it("continues to the next combo model when the prior model exhausts its dispatch budget", async () => {
    const calls = [];
    const response = await handleComboChat({
      body: { messages: [{ role: "user", content: "hello" }] },
      models: ["provider/model-a", "provider/model-b"],
      handleSingleModel: async (_body, model) => {
        calls.push(model);
        if (model === "provider/model-a") {
          return new Response(JSON.stringify({
            error: {
              message: "Upstream attempt budget exhausted (16/16)",
              code: "upstream_attempt_budget_exhausted",
            },
          }), { status: 503, headers: { "content-type": "application/json" } });
        }
        return new Response("configured fallback");
      },
      log: { info() {}, warn() {} },
      comboName: "quick",
      comboStrategy: "fallback",
    });

    expect(response.ok).toBe(true);
    await expect(response.text()).resolves.toBe("configured fallback");
    expect(calls).toEqual(["provider/model-a", "provider/model-b"]);
  });

  it("does not switch a signed Gemini tool continuation to another combo model", async () => {
    const calls = [];
    const response = await handleComboChat({
      body: { messages: [{ role: "user", content: "continue tool" }] },
      models: ["gemini/gemini-2.5-pro", "openai/gpt-5.6"],
      handleSingleModel: async (_body, model) => {
        calls.push(model);
        return new Response(JSON.stringify({
          error: {
            message: "Gemini thought signature is required for this tool continuation",
            code: "gemini_thought_signature_missing",
          },
        }), { status: 400, headers: { "content-type": "application/json" } });
      },
      log: { info() {}, warn() {} },
      comboName: "gemini-tools",
      comboStrategy: "fallback",
    });

    expect(response.status).toBe(400);
    expect(calls).toEqual(["gemini/gemini-2.5-pro"]);
  });

  it("preflights incompatible signed Gemini continuation candidates without dispatching them", async () => {
    const calls = [];
    const response = await handleComboChat({
      body: { messages: [{ role: "user", content: "continue tool" }] },
      models: ["openai/gpt-5.6", "anthropic/claude-sonnet"],
      handleSingleModel: async (_body, model) => {
        calls.push(model);
        return new Response("must not dispatch");
      },
      getModelAvailability: async () => ({
        available: false,
        reason: "gemini_signed_tool_incompatible",
        terminalRoutingCode: "gemini_thought_signature_missing",
      }),
      log: { info() {}, warn() {} },
      comboName: "gemini-tools",
      comboStrategy: "fallback",
    });

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toMatchObject({
      error: { code: "gemini_thought_signature_missing" },
    });
    expect(calls).toEqual([]);
  });

  it("skips incompatible signed continuation candidates and dispatches the compatible Gemini target", async () => {
    const calls = [];
    const response = await handleComboChat({
      body: { messages: [{ role: "user", content: "continue tool" }] },
      models: ["openai/gpt-5.6", "gemini/gemini-2.5-pro"],
      handleSingleModel: async (_body, model) => {
        calls.push(model);
        return new Response("Gemini continuation resumed");
      },
      getModelAvailability: async (model) => (
        model.startsWith("openai/")
          ? {
            available: false,
            reason: "gemini_signed_tool_incompatible",
            terminalRoutingCode: "gemini_thought_signature_missing",
          }
          : { available: true, continuationCompatible: true }
      ),
      log: { info() {}, warn() {} },
      comboName: "gemini-tools",
      comboStrategy: "fallback",
    });

    expect(response.ok).toBe(true);
    await expect(response.text()).resolves.toBe("Gemini continuation resumed");
    expect(calls).toEqual(["gemini/gemini-2.5-pro"]);
  });

  it("keeps a thread-pinned combo route for opaque inter-agent content", async () => {
    const calls = [];
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
    });

    expect(response.ok).toBe(true);
    expect(calls).toEqual(["fm/gpt-5.6-terra"]);
  });

  it("allows opaque inter-agent content on a non-native combo route", async () => {
    const calls = [];
    const response = await handleComboChat({
      body: {
        input: [{ content: [{ type: "encrypted_content", encrypted_content: "enc_payload" }] }],
      },
      models: ["fm/gpt-5.6-terra"],
      handleSingleModel: async (_body, model) => {
        calls.push(model);
        return new Response("ok");
      },
      log: { info() {}, warn() {} },
      comboName: "codex",
      comboStrategy: "fallback",
    });

    expect(response.ok).toBe(true);
    expect(calls).toEqual(["fm/gpt-5.6-terra"]);
  });
});

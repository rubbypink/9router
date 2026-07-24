import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createSqlJsAdapter } from "../../src/lib/db/adapters/sqljsAdapter.js";
import migration from "../../src/lib/db/migrations/004-gemini-thought-signatures.js";

let adapter;
let signatures;
let tempDir;

beforeEach(async () => {
  tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "9router-gemini-signatures-"));
  adapter = await createSqlJsAdapter(path.join(tempDir, "thought-signatures.sqlite"));
  migration.up(adapter);
  global._dbAdapter = { instance: adapter, initPromise: null, logged: false };
  vi.resetModules();
  signatures = await import("../../open-sse/services/geminiThoughtSignatures.js");
});

afterEach(() => {
  try { adapter?.close(); } catch {}
  delete global._dbAdapter;
  fs.rmSync(tempDir, { recursive: true, force: true });
});

function context(overrides = {}) {
  return signatures.createGeminiContinuationContext({
    sessionId: "thread-alpha",
    apiFamily: "gemini",
    model: "gemini-2.5-pro",
    ...overrides,
  });
}

const tool = {
  toolCallId: "call_signed_1",
  functionName: "task_create",
  arguments: { title: "route quota", priority: 1 },
};

describe("Gemini thought signature continuity", () => {
  it("persists and resolves only an exact signature match", () => {
    const current = context();
    const thoughtSignature = " opaque-signature-sentinel ";
    signatures.storeGeminiThoughtSignature(current, {
      ...tool,
      thoughtSignature,
      now: 1_000,
    });

    expect(signatures.resolveGeminiThoughtSignature(current, { ...tool, now: 1_001 }))
      .toBe(thoughtSignature);
    expect(signatures.resolveGeminiThoughtSignature(context({ sessionId: "thread-beta" }), { ...tool, now: 1_001 }))
      .toBeNull();
    expect(signatures.resolveGeminiThoughtSignature(context({ model: "Gemini-2.5-Pro" }), { ...tool, now: 1_001 }))
      .toBeNull();
    expect(signatures.resolveGeminiThoughtSignature(current, {
      ...tool,
      arguments: { priority: 2, title: "route quota" },
      now: 1_001,
    })).toBeNull();
  });

  it("restores an exact signature after a SQLite adapter restart", async () => {
    const current = context();
    const dbPath = path.join(tempDir, "thought-signatures.sqlite");
    signatures.storeGeminiThoughtSignature(current, {
      ...tool,
      thoughtSignature: "opaque-signature-restart-only",
      now: 1_000,
    });

    adapter.close();
    adapter = await createSqlJsAdapter(dbPath);
    migration.up(adapter);
    global._dbAdapter = { instance: adapter, initPromise: null, logged: false };
    vi.resetModules();
    signatures = await import("../../open-sse/services/geminiThoughtSignatures.js");

    expect(signatures.resolveGeminiThoughtSignature(current, { ...tool, now: 1_001 }))
      .toBe("opaque-signature-restart-only");
  });

  it("uses a deterministic tool-call id when durable recovery is unavailable", () => {
    const input = {
      responseId: "response-unbound",
      ordinal: 1,
      functionName: tool.functionName,
      arguments: tool.arguments,
    };

    expect(signatures.createGeminiToolCallId(null, input))
      .toBe(signatures.createGeminiToolCallId(null, input));
    expect(signatures.createGeminiToolCallId(null, input)).toMatch(/^call_gemini_/);
  });

  it("expires records after thirty days and removes them during cleanup", () => {
    const current = context();
    signatures.storeGeminiThoughtSignature(current, {
      ...tool,
      thoughtSignature: "opaque-signature-sentinel",
      now: 1_000,
    });

    const expiry = 1_000 + signatures.GEMINI_THOUGHT_SIGNATURE_TTL_MS;
    expect(signatures.resolveGeminiThoughtSignature(current, { ...tool, now: expiry - 1 })).toBe("opaque-signature-sentinel");
    expect(signatures.cleanupExpiredGeminiThoughtSignatures({ now: expiry })).toMatchObject({ deleted: 1 });
    expect(signatures.resolveGeminiThoughtSignature(current, { ...tool, now: expiry + 1 })).toBeNull();
  });

  it("keeps only hash metadata long enough to terminally reject an expired continuation", () => {
    const current = context();
    signatures.storeGeminiThoughtSignature(current, {
      ...tool,
      thoughtSignature: "opaque-signature-expiry-only",
      now: 1_000,
    });
    const expiry = 1_000 + signatures.GEMINI_THOUGHT_SIGNATURE_TTL_MS;
    const body = {
      messages: [
        { role: "assistant", tool_calls: [{ id: tool.toolCallId, type: "function", function: { name: tool.functionName, arguments: JSON.stringify(tool.arguments) } }] },
        { role: "tool", tool_call_id: tool.toolCallId, content: "created" },
      ],
    };

    expect(signatures.getGeminiContinuationState("thread-alpha", body, expiry)).toMatchObject({
      bindings: [],
      hasMismatch: true,
    });
    const tombstone = adapter.get(`SELECT * FROM geminiThoughtSignatureTombstones`);
    expect(tombstone).not.toHaveProperty("thoughtSignature");
  });

  it("replays the original token for an exact OpenAI tool continuation", async () => {
    const current = context();
    signatures.storeGeminiThoughtSignature(current, {
      ...tool,
      thoughtSignature: "opaque-signature-sentinel",
      now: Date.now(),
    });
    const { openaiToGeminiRequest } = await import("../../open-sse/translator/request/openai-to-gemini.js");
    const request = openaiToGeminiRequest("gemini-2.5-pro", {
      messages: [
        {
          role: "assistant",
          tool_calls: [{
            id: tool.toolCallId,
            type: "function",
            function: { name: tool.functionName, arguments: JSON.stringify(tool.arguments) },
          }],
        },
        { role: "tool", tool_call_id: tool.toolCallId, content: "created" },
      ],
    }, true, { _geminiContinuationContext: current });

    const functionPart = request.contents.find((content) => content.role === "model").parts.find((part) => part.functionCall);
    expect(functionPart).toMatchObject({
      thoughtSignature: "opaque-signature-sentinel",
      functionCall: { id: tool.toolCallId, name: tool.functionName, args: tool.arguments },
    });
  });

  it("keeps distinct signatures bound to their exact tool call and arguments", async () => {
    const current = context();
    const secondTool = {
      toolCallId: "call_signed_2",
      functionName: "task_update",
      arguments: { id: "task-1", status: "done" },
    };
    signatures.storeGeminiThoughtSignature(current, {
      ...tool,
      thoughtSignature: "opaque-signature-one",
      now: Date.now(),
    });
    signatures.storeGeminiThoughtSignature(current, {
      ...secondTool,
      thoughtSignature: "opaque-signature-two",
      now: Date.now(),
    });
    const { openaiToGeminiRequest } = await import("../../open-sse/translator/request/openai-to-gemini.js");
    const request = openaiToGeminiRequest("gemini-2.5-pro", {
      messages: [
        {
          role: "assistant",
          tool_calls: [
            { id: tool.toolCallId, type: "function", function: { name: tool.functionName, arguments: JSON.stringify(tool.arguments) } },
            { id: secondTool.toolCallId, type: "function", function: { name: secondTool.functionName, arguments: JSON.stringify(secondTool.arguments) } },
          ],
        },
        { role: "tool", tool_call_id: tool.toolCallId, content: "created" },
        { role: "tool", tool_call_id: secondTool.toolCallId, content: "updated" },
      ],
    }, true, { _geminiContinuationContext: current });

    const functionParts = request.contents
      .find((content) => content.role === "model")
      .parts
      .filter((part) => part.functionCall);
    expect(Object.fromEntries(functionParts.map((part) => [part.functionCall.id, part.thoughtSignature]))).toEqual({
      [tool.toolCallId]: "opaque-signature-one",
      [secondTool.toolCallId]: "opaque-signature-two",
    });
  });

  it("derives continuity from a stable client thread before request translation", async () => {
    const current = context();
    signatures.storeGeminiThoughtSignature(current, {
      ...tool,
      thoughtSignature: "opaque-signature-sentinel",
      now: Date.now(),
    });
    const { translateRequest } = await import("../../open-sse/translator/index.js");
    const credentials = { rawHeaders: { "thread-id": "thread-alpha" } };
    const request = translateRequest("openai", "gemini", "gemini-2.5-pro", {
      messages: [
        {
          role: "assistant",
          tool_calls: [{
            id: tool.toolCallId,
            type: "function",
            function: { name: tool.functionName, arguments: JSON.stringify(tool.arguments) },
          }],
        },
        { role: "tool", tool_call_id: tool.toolCallId, content: "created" },
      ],
    }, true, credentials, "gemini");

    expect(credentials._geminiContinuationContext).toMatchObject(current);
    expect(request.contents.find((content) => content.role === "model").parts.find((part) => part.functionCall).thoughtSignature)
      .toBe("opaque-signature-sentinel");
  });

  it("derives continuity from an OpenCode x-session-affinity thread before request translation", async () => {
    const current = context();
    signatures.storeGeminiThoughtSignature(current, {
      ...tool,
      thoughtSignature: "opaque-signature-sentinel",
      now: Date.now(),
    });
    const { translateRequest } = await import("../../open-sse/translator/index.js");
    const credentials = { rawHeaders: { "x-session-affinity": "thread-alpha" } };
    const request = translateRequest("openai", "gemini", "gemini-2.5-pro", {
      messages: [
        {
          role: "assistant",
          tool_calls: [{
            id: tool.toolCallId,
            type: "function",
            function: { name: tool.functionName, arguments: JSON.stringify(tool.arguments) },
          }],
        },
        { role: "tool", tool_call_id: tool.toolCallId, content: "created" },
      ],
    }, true, credentials, "gemini");

    expect(credentials._geminiContinuationContext).toMatchObject(current);
    expect(request.contents.find((content) => content.role === "model").parts.find((part) => part.functionCall).thoughtSignature)
      .toBe("opaque-signature-sentinel");
  });

  it("rejects a native Gemini continuation that has no exact signature", async () => {
    const { openaiToGeminiRequest } = await import("../../open-sse/translator/request/openai-to-gemini.js");
    try {
      openaiToGeminiRequest("gemini-2.5-pro", {
        messages: [
          {
            role: "assistant",
            tool_calls: [{
              id: tool.toolCallId,
              type: "function",
              function: { name: tool.functionName, arguments: JSON.stringify(tool.arguments) },
            }],
          },
          { role: "tool", tool_call_id: tool.toolCallId, content: "created" },
        ],
      }, true, { _geminiContinuationContext: context() });
      throw new Error("expected Gemini thought signature error");
    } catch (error) {
      expect(error).toMatchObject({ code: "gemini_thought_signature_missing" });
    }
  });

  it("rejects a changed Gemini tool-call fingerprint before translation or fallback", async () => {
    const current = context();
    signatures.storeGeminiThoughtSignature(current, {
      ...tool,
      thoughtSignature: "opaque-signature-sentinel",
      now: Date.now(),
    });
    const body = {
      messages: [
        {
          role: "assistant",
          tool_calls: [{
            id: tool.toolCallId,
            type: "function",
            function: { name: tool.functionName, arguments: JSON.stringify({ ...tool.arguments, priority: 2 }) },
          }],
        },
        { role: "tool", tool_call_id: tool.toolCallId, content: "created" },
      ],
    };
    expect(signatures.getGeminiContinuationState("thread-alpha", body)).toMatchObject({
      bindings: [],
      hasMismatch: true,
    });

    const { translateRequest } = await import("../../open-sse/translator/index.js");
    expect(() => translateRequest(
      "openai",
      "openai",
      "gpt-5.6",
      body,
      true,
      { rawHeaders: { "thread-id": "thread-alpha" } },
      "openai",
    )).toThrow(expect.objectContaining({ code: "gemini_thought_signature_missing" }));
  });

  it("captures an upstream signature under the emitted tool call id", async () => {
    const current = context();
    const { geminiToOpenAIResponse } = await import("../../open-sse/translator/response/gemini-to-openai.js");
    const chunks = geminiToOpenAIResponse({
      responseId: "response-1",
      modelVersion: "gemini-2.5-pro",
      candidates: [{
        content: {
          role: "model",
          parts: [{
            thoughtSignature: "opaque-signature-sentinel",
            functionCall: { id: tool.toolCallId, name: tool.functionName, args: tool.arguments },
          }],
        },
      }],
    }, { geminiContinuationContext: current, model: "gemini-2.5-pro" });

    const emitted = chunks.find((chunk) => chunk.choices?.[0]?.delta?.tool_calls)?.choices[0].delta.tool_calls[0];
    expect(emitted.id).toBe(tool.toolCallId);
    expect(signatures.resolveGeminiThoughtSignature(current, {
      toolCallId: emitted.id,
      functionName: tool.functionName,
      arguments: tool.arguments,
      now: Date.now(),
    })).toBe("opaque-signature-sentinel");
  });

  it("threads signature context through the streaming Gemini response transformer", async () => {
    const current = context();
    const { FORMATS } = await import("../../open-sse/translator/formats.js");
    const { createSSETransformStreamWithLogger } = await import("../../open-sse/utils/stream.js");
    const input = `data: ${JSON.stringify({
      responseId: "response-stream",
      modelVersion: "gemini-2.5-pro",
      candidates: [{
        content: {
          role: "model",
          parts: [{
            thoughtSignature: "opaque-signature-sentinel",
            functionCall: { id: tool.toolCallId, name: tool.functionName, args: tool.arguments },
          }],
        },
      }],
    })}\n\n`;
    const stream = new ReadableStream({
      start(controller) {
        controller.enqueue(new TextEncoder().encode(input));
        controller.close();
      },
    });

    const output = await new Response(stream.pipeThrough(
      createSSETransformStreamWithLogger(
        FORMATS.GEMINI,
        FORMATS.OPENAI,
        "gemini",
        null,
        null,
        "gemini-2.5-pro",
        null,
        null,
        null,
        null,
        current,
      ),
    )).text();

    expect(output).toContain(`"id":"${tool.toolCallId}"`);
    expect(output).not.toContain("opaque-signature-sentinel");
    expect(signatures.resolveGeminiThoughtSignature(current, {
      toolCallId: tool.toolCallId,
      functionName: tool.functionName,
      arguments: tool.arguments,
      now: Date.now(),
    })).toBe("opaque-signature-sentinel");
  });

  it("captures signatures in the non-streaming Gemini response path", async () => {
    const current = context();
    const { translateNonStreamingResponse } = await import("../../open-sse/handlers/chatCore/nonStreamingHandler.js");
    const response = translateNonStreamingResponse({
      responseId: "response-2",
      modelVersion: "gemini-2.5-pro",
      candidates: [{
        content: {
          role: "model",
          parts: [{
            thought_signature: "opaque-signature-sentinel",
            functionCall: { name: tool.functionName, args: tool.arguments },
          }],
        },
      }],
    }, "gemini", "openai", { geminiContinuationContext: current });

    const emitted = response.choices[0].message.tool_calls[0];
    expect(emitted.id).toMatch(/^call_gemini_/);
    expect(signatures.resolveGeminiThoughtSignature(current, {
      toolCallId: emitted.id,
      functionName: tool.functionName,
      arguments: tool.arguments,
      now: Date.now(),
    })).toBe("opaque-signature-sentinel");
  });
});

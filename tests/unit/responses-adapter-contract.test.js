import { describe, expect, it } from "vitest";

import { FORMATS } from "../../open-sse/translator/formats.js";
import { getUnsupportedResponsesAdapterFeatures } from "../../open-sse/translator/concerns/toolNamespace.js";
import { openAICompletionToResponsesResponse } from "../../open-sse/handlers/chatCore/nonStreamingHandler.js";
import { openaiResponsesToOpenAIRequest } from "../../open-sse/translator/request/openai-responses.js";
import { translateRequest } from "../../open-sse/translator/index.js";

describe("Responses chat-adapter contract", () => {
  it("rejects stateful and non-degradable hosted features instead of silently dropping them", () => {
    const unsupported = getUnsupportedResponsesAdapterFeatures({
      previous_response_id: "resp_1",
      conversation: "conv_1",
      background: true,
      store: true,
      tools: [
        { type: "custom", name: "patch", format: { type: "text" } },
      ],
    });

    expect(unsupported).toEqual([
      "background",
      "conversation",
      "previous_response_id",
      "store",
      "tools[0].type:custom",
    ]);
  });

  it("safely degrades Codex continuity output and optional hosted search on chat adapters", () => {
    const body = {
      include: ["reasoning.encrypted_content"],
      input: [{ type: "message", role: "user", content: [{ type: "input_text", text: "hello" }] }],
      tools: [
        { type: "web_search" },
        { type: "function", name: "local_tool", parameters: { type: "object" } },
      ],
    };

    expect(getUnsupportedResponsesAdapterFeatures(body)).toEqual([]);
    const translated = openaiResponsesToOpenAIRequest("model", body, true, {});
    expect(translated.include).toBeUndefined();
    expect(translated.tools).toEqual([{
      type: "function",
      function: {
        name: "local_tool",
        description: "",
        parameters: { type: "object", properties: {} },
      },
    }]);
  });

  it("keeps the reasoning summary but strips opaque continuity from non-Responses providers", () => {
    const translated = translateRequest(
      FORMATS.OPENAI_RESPONSES,
      FORMATS.OPENAI,
      "gpt-compatible",
      {
        input: [
          {
            type: "reasoning",
            summary: [{ type: "summary_text", text: "prior summary" }],
            encrypted_content: "opaque_blob",
          },
          {
            type: "function_call",
            call_id: "call_1",
            name: "inspect",
            arguments: "{}",
          },
          {
            type: "function_call_output",
            call_id: "call_1",
            output: "done",
          },
          {
            type: "message",
            role: "user",
            content: [{ type: "input_text", text: "continue" }],
          },
        ],
      },
      true,
      {},
      "openai-compatible-chat",
    );

    expect(JSON.stringify(translated)).not.toContain("opaque_blob");
    expect(JSON.stringify(translated)).not.toContain("encrypted_content");
    expect(translated.messages.find((message) => message.role === "assistant")?.reasoning_content).toBe("prior summary");
  });

  it("preserves opaque continuity on native Responses providers", () => {
    const body = {
      input: [{ type: "reasoning", summary: [], encrypted_content: "native_blob" }],
    };
    const translated = translateRequest(
      FORMATS.OPENAI_RESPONSES,
      FORMATS.OPENAI_RESPONSES,
      "gpt-native",
      structuredClone(body),
      true,
      {},
      "codex",
    );

    expect(translated.input[0].encrypted_content).toBe("native_blob");
  });

  it("strips opaque continuity from chat-shaped input sent to non-Responses providers", () => {
    const translated = translateRequest(
      FORMATS.OPENAI,
      FORMATS.OPENAI,
      "gpt-compatible",
      {
        messages: [{
          role: "assistant",
          content: "prior answer",
          reasoning_content: "safe summary",
          reasoning_encrypted_content: "opaque_alias",
        }],
      },
      true,
      {},
      "openai-compatible-chat",
    );

    expect(JSON.stringify(translated)).not.toContain("opaque_alias");
    expect(translated.messages[0].reasoning_content).toBe("safe summary");
  });

  it("degrades opaque encrypted message content without blocking a chat adapter", () => {
    expect(getUnsupportedResponsesAdapterFeatures({
      include: ["web_search_call.action.sources"],
      input: [{
        type: "message",
        role: "user",
        content: [{ type: "encrypted_content", encrypted_content: "enc_payload" }],
      }],
    })).toEqual(["include"]);

    const translated = translateRequest(
      FORMATS.OPENAI_RESPONSES,
      FORMATS.OPENAI,
      "gpt-compatible",
      {
        input: [{
          type: "message",
          role: "user",
          content: [
            { type: "input_text", text: "continue the task" },
            { type: "encrypted_content", encrypted_content: "enc_payload" },
          ],
        }],
      },
      true,
      {},
      "openai-compatible-chat",
    );

    expect(JSON.stringify(translated)).not.toContain("encrypted_content");
    expect(JSON.stringify(translated)).not.toContain("enc_payload");
    expect(translated.messages[0].content).toEqual([{ type: "text", text: "continue the task" }]);
  });

  it("accepts namespace-wrapped function tools on a chat adapter", () => {
    expect(getUnsupportedResponsesAdapterFeatures({
      store: false,
      tools: [{
        type: "namespace",
        name: "mcp__codegraph__",
        tools: [{ type: "function", name: "codegraph_explore", parameters: { type: "object" } }],
      }],
    })).toEqual([]);
  });

  it("rejects Responses-only limits, prompt templates, and file inputs that a chat adapter cannot preserve", () => {
    const unsupported = getUnsupportedResponsesAdapterFeatures({
      max_tool_calls: 2,
      prompt: { id: "pmpt_1" },
      text: { verbosity: "low" },
      truncation: "auto",
      input: [{
        type: "message",
        role: "user",
        content: [
          { type: "input_file", file_id: "file_1" },
          { type: "input_image", file_id: "file_2" },
        ],
      }],
    });

    expect(unsupported).toEqual([
      "input[0].content[0].type:input_file",
      "input[0].content[1].file_id",
      "max_tool_calls",
      "prompt",
      "text.verbosity",
      "truncation:auto",
    ]);
  });

  it("accepts adapter-safe text, remote images, and disabled truncation", () => {
    expect(getUnsupportedResponsesAdapterFeatures({
      truncation: "disabled",
      input: [{
        type: "message",
        role: "user",
        content: [
          { type: "input_text", text: "inspect" },
          { type: "input_image", image_url: "https://example.com/image.png" },
        ],
      }],
    })).toEqual([]);
  });

  it("returns canonical non-streaming Responses output and restores namespace identity", () => {
    const map = new Map();
    map.responsesNamespaceMap = new Map([
      ["mcp__codegraph__codegraph_explore", { namespace: "mcp__codegraph__", name: "codegraph_explore" }],
    ]);
    const response = openAICompletionToResponsesResponse({
      id: "chatcmpl_3",
      created: 123,
      model: "model",
      choices: [{
        message: {
          content: "done",
          reasoning_content: "reason",
          tool_calls: [{
            id: "call_3",
            type: "function",
            function: { name: "mcp__codegraph__codegraph_explore", arguments: "{\"path\":\"src\"}" },
          }],
        },
        finish_reason: "tool_calls",
      }],
      usage: { prompt_tokens: 5, completion_tokens: 3, total_tokens: 8 },
    }, map);

    expect(response).toMatchObject({
      object: "response",
      status: "completed",
      model: "model",
      usage: { input_tokens: 5, output_tokens: 3, total_tokens: 8 },
    });
    expect(response.output.map((item) => item.type)).toEqual(["reasoning", "message", "function_call"]);
    expect(response.output[2]).toMatchObject({
      namespace: "mcp__codegraph__",
      name: "codegraph_explore",
      call_id: "call_3",
      status: "completed",
    });
  });

  it("keeps total_tokens when usage is filtered for Responses", async () => {
    const { filterUsageForFormat } = await import("../../open-sse/utils/usageTracking.js");
    expect(filterUsageForFormat({ input_tokens: 2, output_tokens: 3, total_tokens: 5 }, FORMATS.OPENAI_RESPONSES)).toEqual({
      input_tokens: 2,
      output_tokens: 3,
      total_tokens: 5,
    });
  });
});

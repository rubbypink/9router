import { describe, expect, it } from "vitest";

import { FORMATS } from "../../open-sse/translator/formats.js";
import { initState, translateRequest } from "../../open-sse/translator/index.js";
import { openaiToOpenAIResponsesResponse } from "../../open-sse/translator/response/openai-responses.js";

const CODEGRAPH_NAMESPACE = "mcp__codegraph__";
const CODEGRAPH_TOOL = "codegraph_explore";
const CODEGRAPH_WIRE_NAME = "mcp__codegraph__codegraph_explore";

function responsesBody(overrides = {}) {
  return {
    model: "combo",
    input: [{ type: "message", role: "user", content: [{ type: "input_text", text: "inspect" }] }],
    tools: [{
      type: "namespace",
      name: CODEGRAPH_NAMESPACE,
      tools: [{
        type: "function",
        name: CODEGRAPH_TOOL,
        description: "Explore a code graph",
        parameters: { type: "object", properties: {} },
      }],
    }],
    ...overrides,
  };
}

describe("Responses namespace tool routing", () => {
  it("flattens namespace declarations and historical calls without duplicating the tool prefix", () => {
    const body = responsesBody({
      input: [
        { type: "function_call", namespace: CODEGRAPH_NAMESPACE, name: CODEGRAPH_TOOL, call_id: "call_1", arguments: {} },
        { type: "function_call_output", call_id: "call_1", output: "ok" },
      ],
    });

    const translated = translateRequest(
      FORMATS.OPENAI_RESPONSES,
      FORMATS.OPENAI,
      "model",
      body,
    );

    expect(translated.tools[0].function.name).toBe(CODEGRAPH_WIRE_NAME);
    expect(translated.messages[0].tool_calls[0].function.name).toBe(CODEGRAPH_WIRE_NAME);
    expect(translated._toolNameMap?.responsesNamespaceMap?.get(CODEGRAPH_WIRE_NAME)).toEqual({
      namespace: CODEGRAPH_NAMESPACE,
      name: CODEGRAPH_TOOL,
    });
  });

  it("restores namespace and inner name on streamed function calls", () => {
    const translated = translateRequest(
      FORMATS.OPENAI_RESPONSES,
      FORMATS.OPENAI,
      "model",
      responsesBody(),
    );
    const state = {
      ...initState(FORMATS.OPENAI_RESPONSES),
      model: "model",
      toolNameMap: translated._toolNameMap,
    };

    const events = openaiToOpenAIResponsesResponse({
      id: "chatcmpl_1",
      choices: [{
        index: 0,
        delta: {
          tool_calls: [{
            index: 0,
            id: "call_1",
            type: "function",
            function: { name: CODEGRAPH_WIRE_NAME, arguments: "{}" },
          }],
        },
      }],
    }, state);

    const added = events.find((event) => event.event === "response.output_item.added");
    expect(added.data.item).toMatchObject({
      type: "function_call",
      status: "in_progress",
      namespace: CODEGRAPH_NAMESPACE,
      name: CODEGRAPH_TOOL,
    });
  });

  it("keeps namespace tools reversible when a plain function already uses the readable wire name", () => {
    const translated = translateRequest(
      FORMATS.OPENAI_RESPONSES,
      FORMATS.OPENAI,
      "model",
      responsesBody({
        tools: [
          {
            type: "function",
            name: CODEGRAPH_WIRE_NAME,
            parameters: { type: "object", properties: {} },
          },
          {
            type: "namespace",
            name: CODEGRAPH_NAMESPACE,
            tools: [{
              type: "function",
              name: CODEGRAPH_TOOL,
              parameters: { type: "object", properties: {} },
            }],
          },
        ],
      }),
    );

    const names = translated.tools.map((tool) => tool.function.name);
    expect(new Set(names).size).toBe(2);
    expect(names[0]).toBe(CODEGRAPH_WIRE_NAME);
    expect(translated._toolNameMap.responsesNamespaceMap.get(names[1])).toEqual({
      namespace: CODEGRAPH_NAMESPACE,
      name: CODEGRAPH_TOOL,
    });
  });

  it("uses globally unique output indexes and completes with accumulated output and usage", () => {
    const state = { ...initState(FORMATS.OPENAI_RESPONSES), model: "model" };
    const emitted = [];

    emitted.push(...openaiToOpenAIResponsesResponse({
      id: "chatcmpl_2",
      choices: [{ index: 0, delta: { reasoning_content: "why" } }],
    }, state));
    emitted.push(...openaiToOpenAIResponsesResponse({
      id: "chatcmpl_2",
      choices: [{ index: 0, delta: { content: "answer" } }],
    }, state));
    emitted.push(...openaiToOpenAIResponsesResponse({
      id: "chatcmpl_2",
      choices: [{
        index: 0,
        delta: { tool_calls: [{ index: 0, id: "call_2", function: { name: "plain", arguments: "{}" } }] },
      }],
    }, state));
    emitted.push(...openaiToOpenAIResponsesResponse({
      id: "chatcmpl_2",
      choices: [{ index: 0, delta: {}, finish_reason: "tool_calls" }],
      usage: { prompt_tokens: 11, completion_tokens: 7, total_tokens: 18 },
    }, state));
    emitted.push(...openaiToOpenAIResponsesResponse(null, state));

    const addedIndexes = emitted
      .filter((event) => event.event === "response.output_item.added")
      .map((event) => event.data.output_index);
    expect(new Set(addedIndexes).size).toBe(addedIndexes.length);

    const completed = emitted.find((event) => event.event === "response.completed");
    expect(completed.data.response).toMatchObject({
      model: "model",
      status: "completed",
    });
    expect(completed.data.response.output.map((item) => item.type)).toEqual([
      "reasoning",
      "message",
      "function_call",
    ]);
    expect(completed.data.response.output[1].status).toBe("completed");
    expect(completed.data.response.output[2].status).toBe("completed");
    expect(completed.data.response.usage).toMatchObject({
      input_tokens: 11,
      output_tokens: 7,
      total_tokens: 18,
    });
  });
});

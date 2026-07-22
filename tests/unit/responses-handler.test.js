import { beforeEach, describe, expect, it, vi } from "vitest";

const handleChatCore = vi.fn();
vi.mock("../../open-sse/handlers/chatCore.js", () => ({ handleChatCore }));

const { handleResponsesCore } = await import("../../open-sse/handlers/responsesHandler.js");

describe("Responses handler", () => {
  beforeEach(() => handleChatCore.mockReset());

  it("passes the original Responses schema to the canonical translator", async () => {
    const body = {
      model: "combo",
      input: "inspect",
      tools: [{
        type: "namespace",
        name: "mcp__codegraph__",
        tools: [{ type: "function", name: "codegraph_explore", parameters: { type: "object" } }],
      }],
    };
    handleChatCore.mockResolvedValue({
      success: true,
      response: new Response(JSON.stringify({ object: "response", output: [] }), {
        headers: { "Content-Type": "application/json" },
      }),
    });

    await handleResponsesCore({ body, modelInfo: {}, credentials: {} });

    expect(handleChatCore).toHaveBeenCalledWith(expect.objectContaining({
      body: { ...body, stream: false },
      sourceFormatOverride: "openai-responses",
    }));
  });

  it("does not translate an already canonical Responses stream a second time", async () => {
    const canonical = "event: response.completed\ndata: {\"type\":\"response.completed\",\"response\":{\"output\":[]}}\n\ndata: [DONE]\n\n";
    handleChatCore.mockResolvedValue({
      success: true,
      response: new Response(canonical, { headers: { "Content-Type": "text/event-stream" } }),
    });

    const result = await handleResponsesCore({
      body: { model: "combo", input: "inspect", stream: true },
      modelInfo: {},
      credentials: {},
    });

    expect(await result.response.text()).toBe(canonical);
  });
});

import { describe, expect, it } from "vitest";

import { handleComboChat } from "../../open-sse/services/combo.js";

describe("opaque Responses combo routing", () => {
  it("keeps encrypted input on the configured non-native combo route", async () => {
    const calls = [];
    const response = await handleComboChat({
      body: {
        input: [
          {
            type: "reasoning",
            summary: [{ type: "summary_text", text: "prior delegated reasoning" }],
            encrypted_content: "enc_payload",
          },
          {
            type: "message",
            role: "user",
            content: [{ type: "input_text", text: "delegated task" }],
          },
        ],
      },
      models: ["fm/gpt-5.4-mini", "ag/gemini-3.5-flash-low"],
      handleSingleModel: async (_body, model) => {
        calls.push(model);
        return new Response("ok");
      },
      log: { info() {}, warn() {} },
      comboName: "quick",
      comboStrategy: "round-robin",
    });

    expect(response.status).toBe(200);
    expect(calls).toEqual(["fm/gpt-5.4-mini"]);
  });
});

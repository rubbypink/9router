import { describe, expect, it } from "vitest";

import {
  CODEX_MODEL_CATALOG_CONTRACT_VERSION,
  CODEX_MODEL_CATALOG_TEMPLATE_SLUG,
  buildCodexModelsCatalog,
  createCodexModelsEtag,
  selectCodexModelTemplate,
  withCodexModelsEtag,
} from "../../src/lib/codexModelCatalog.js";

const template = {
  slug: "gpt-5.6-terra",
  display_name: "GPT-5.6 Terra",
  description: "source metadata",
  supported_reasoning_levels: [{ effort: "medium" }],
  shell_type: "shell_command",
  visibility: "list",
  supported_in_api: true,
  priority: 4,
  base_instructions: "preserved codex instructions",
  support_verbosity: true,
  default_verbosity: "medium",
  apply_patch_tool_type: "freeform",
  truncation_policy: { type: "tokens", value: 1000 },
  supports_parallel_tool_calls: true,
  experimental_supported_tools: [],
  tool_mode: "code_mode_only",
  use_responses_lite: true,
};

const combos = [
  { id: "combo-b", name: "zeta", kind: null, models: ["cx/gpt-5.6-terra"] },
  { id: "combo-a", name: "alpha", kind: "llm", models: ["ag/gpt-5.4"] },
  { id: "combo-c", name: "search", kind: "webSearch", models: ["perplexity/search"] },
];

describe("Codex model catalog", () => {
  it("promotes LLM combos with chat-adapter-safe Codex tool metadata", () => {
    const catalog = buildCodexModelsCatalog({ combos, template });

    expect(catalog.models.map((model) => model.slug)).toEqual([
      CODEX_MODEL_CATALOG_TEMPLATE_SLUG,
      "alpha",
      "zeta",
    ]);
    expect(catalog.models[0].visibility).toBe("hide");
    expect(catalog.models[0].supported_in_api).toBe(false);
    expect(catalog.models[0].supports_reasoning_summaries).toBe(true);
    expect(catalog.models[1].base_instructions).toBe(template.base_instructions);
    expect(catalog.models[1].supported_reasoning_levels).toEqual(template.supported_reasoning_levels);
    expect(catalog.models[1].supports_reasoning_summaries).toBe(true);
    expect(catalog.models[1].shell_type).toBe("shell_command");
    expect(catalog.models[1].tool_mode).toBe("direct");
    expect(catalog.models[1].apply_patch_tool_type).toBeNull();
    expect(catalog.models[1].use_responses_lite).toBe(true);
    expect(catalog.models[1].visibility).toBe("list");
    expect(CODEX_MODEL_CATALOG_CONTRACT_VERSION).toBe("9router-codex-model-catalog/v3");
  });

  it("uses the retained catalog template before a regular upstream model", () => {
    const retained = { ...template, slug: CODEX_MODEL_CATALOG_TEMPLATE_SLUG };
    expect(selectCodexModelTemplate([template, retained])).toBe(retained);
  });

  it("changes the ETag for dashboard routing changes without hashing credentials", () => {
    const state = {
      combos,
      connections: [{
        id: "connection-a",
        provider: "codex",
        priority: 1,
        providerSpecificData: { prefix: "cx", enabledModels: ["gpt-5.6-terra"] },
        apiKey: "secret-a",
      }],
      customModels: [{ id: "custom", providerAlias: "cx", type: "llm" }],
      modelAliases: { primary: "cx/gpt-5.6-terra" },
      disabledModels: { cx: ["gpt-5.5"] },
    };
    const credentialOnlyChange = {
      ...state,
      connections: [{ ...state.connections[0], apiKey: "secret-b" }],
    };
    const changedCombo = {
      ...state,
      combos: [{ ...combos[0], models: ["cx/gpt-5.6-sol"] }, ...combos.slice(1)],
    };

    expect(createCodexModelsEtag(state)).toBe(createCodexModelsEtag(credentialOnlyChange));
    expect(createCodexModelsEtag(state)).not.toBe(createCodexModelsEtag(changedCombo));
    expect(buildCodexModelsCatalog({ combos, state, template }).etag).toBe(createCodexModelsEtag(state));
  });

  it("keeps the ModelsResponse valid when no local Codex metadata is available", () => {
    expect(buildCodexModelsCatalog({ combos, template: null }).models).toEqual([]);
  });

  it("adds the current ETag without consuming a streaming Responses result", async () => {
    const response = new Response("event: response.completed\n\n", {
      headers: { "Content-Type": "text/event-stream", "X-Existing": "preserved" },
    });
    const wrapped = withCodexModelsEtag(response, "\"catalog-etag\"");

    expect(wrapped.headers.get("X-Models-Etag")).toBe("\"catalog-etag\"");
    expect(wrapped.headers.get("X-9Router-Model-Catalog-Contract")).toBe(CODEX_MODEL_CATALOG_CONTRACT_VERSION);
    expect(wrapped.headers.get("X-Existing")).toBe("preserved");
    await expect(wrapped.text()).resolves.toBe("event: response.completed\n\n");
  });
});

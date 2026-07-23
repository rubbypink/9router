import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";

const originalDataDir = process.env.DATA_DIR;

async function setupDb() {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "9router-model-routing-"));
  process.env.DATA_DIR = tempDir;
  vi.resetModules();

  const { createCombo, createProviderNode } = await import("@/models/index.js");
  const { getComboModels, getModelInfo, resolveComboName } = await import("@/sse/services/model.js");

  return {
    createCombo,
    createProviderNode,
    getComboModels,
    getModelInfo,
    resolveComboName,
    cleanup() {
      fs.rmSync(tempDir, { recursive: true, force: true });
    },
  };
}

describe("model routing", () => {
  let cleanup = () => {};

  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.resetModules();
    vi.clearAllMocks();
    cleanup();
    cleanup = () => {};
    if (originalDataDir === undefined) delete process.env.DATA_DIR;
    else process.env.DATA_DIR = originalDataDir;
  });

  it("keeps built-in provider aliases ahead of compatible node prefixes", async () => {
    const ctx = await setupDb();
    cleanup = ctx.cleanup;

    await ctx.createProviderNode({
      id: "openai-compatible-chat-test",
      type: "openai-compatible",
      name: "Compatible CF Collision",
      prefix: "cf",
      apiType: "chat",
      baseUrl: "https://compatible.test/v1",
    });

    await expect(ctx.getModelInfo("cf/@cf/black-forest-labs/flux-2-klein-9b"))
      .resolves.toEqual({
        provider: "cloudflare-ai",
        model: "@cf/black-forest-labs/flux-2-klein-9b",
      });
  });

  it("still routes non-reserved compatible node prefixes", async () => {
    const ctx = await setupDb();
    cleanup = ctx.cleanup;

    await ctx.createProviderNode({
      id: "openai-compatible-chat-test",
      type: "openai-compatible",
      name: "Compatible OCT",
      prefix: "oct",
      apiType: "chat",
      baseUrl: "https://compatible.test/v1",
    });

    await expect(ctx.getModelInfo("oct/gpt-image-1"))
      .resolves.toEqual({
        provider: "openai-compatible-chat-test",
        model: "gpt-image-1",
      });
  });

  it("routes bare kimi-k2.6-code through the existing kimi-k2.6-cb combo", async () => {
    const ctx = await setupDb();
    cleanup = ctx.cleanup;
    const models = ["kimi/kimi-k2.6", "opencode-go/kimi-k2.6"];
    await ctx.createCombo({ name: "kimi-k2.6-cb", models });

    await expect(ctx.getComboModels("kimi-k2.6-code")).resolves.toEqual(models);
    expect(ctx.resolveComboName("kimi-k2.6-code")).toBe("kimi-k2.6-cb");
    await expect(ctx.getModelInfo("kimi-k2.6-code")).resolves.toEqual({
      provider: null,
      model: "kimi-k2.6-cb",
    });
    await expect(ctx.getComboModels("kimi-k2.6-code/not-a-model")).resolves.toBeNull();
  });
});

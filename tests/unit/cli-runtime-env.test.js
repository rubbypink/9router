import { createRequire } from "node:module";
import { describe, expect, it } from "vitest";

const require = createRequire(import.meta.url);
const { buildEnvWithRuntime } = require("../../cli/hooks/sqliteRuntime.js");

describe("9router CLI runtime environment", () => {
  it("forces Codex thread affinity on without user configuration", () => {
    const env = buildEnvWithRuntime({ CODEX_THREAD_AFFINITY: "false" });

    expect(env.CODEX_THREAD_AFFINITY).toBe("true");
  });
});

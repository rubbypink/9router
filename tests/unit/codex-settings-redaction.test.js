import { describe, expect, it } from "vitest";

import {
  redactConfigSecrets,
  resolveCodexDir,
} from "../../src/app/api/cli-tools/codex-settings/helpers.js";

describe("Codex settings secret redaction", () => {
  it("redacts basic and literal TOML bearer tokens", () => {
    const config = [
      "experimental_bearer_token = \"double-secret\"",
      "experimental_bearer_token = 'single-secret'",
      "base_url = \"http://127.0.0.1:20128/v1\"",
    ].join("\n");

    const redacted = redactConfigSecrets(config);
    expect(redacted).not.toContain("double-secret");
    expect(redacted).not.toContain("single-secret");
    expect(redacted.match(/\[REDACTED\]/g)).toHaveLength(2);
    expect(redacted).toContain("http://127.0.0.1:20128/v1");
  });

  it("uses an explicit Codex home under managed runtimes", () => {
    expect(resolveCodexDir({
      CODEX_HOME: "/managed/codex",
      HOME: "/Users/tester",
    })).toBe("/managed/codex");
    expect(resolveCodexDir({ HOME: "/Users/tester" })).toBe("/Users/tester/.codex");
  });
});

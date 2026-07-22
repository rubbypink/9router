import { expect, it } from "vitest";
import { runSessionAffinityScenario } from "./session-affinity-scenario.mjs";

it("records the durable session affinity V2 scenario", async () => {
  const result = await runSessionAffinityScenario();

  expect(result).toMatchObject({
    strictCursor: ["account-a", "account-b", "account-a"],
    repeatedRouteEpoch: 1,
    sameProviderConnection: "account-a",
    providerSplit: { codex: "account-a", anthropic: "account-anthropic" },
    restartBinding: "account-a",
    rebinds: ["bound_connection_unavailable", "retryable_provider_failure"],
    protectedRebindStatus: 409,
    legacyMigrationConnection: "account-legacy",
    ttlCleanup: "removed both session binding rows",
  });
  console.log(`AFFINITY_SCENARIO=${JSON.stringify(result)}`);
});

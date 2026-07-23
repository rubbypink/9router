import { beforeEach, describe, expect, it } from "vitest";

import {
  beforeUpstreamRequest,
  createUpstreamRequestState,
  resetUpstreamExecutionStateForTests,
  runAsUpstreamDispatch,
  runWithUpstreamAttemptScope,
  runWithUpstreamRequestState,
} from "../../open-sse/services/requestExecutionState.js";

const providerEndpoint = "https://api.example.test/v1/responses";

describe("upstream request execution state", () => {
  beforeEach(() => {
    resetUpstreamExecutionStateForTests();
  });

  it("spaces starts to the same endpoint by at least two seconds", async () => {
    let now = 10_000;
    const sleeps = [];
    const state = createUpstreamRequestState({
      now: () => now,
      sleep: async (ms) => {
        sleeps.push(ms);
        now += ms;
      },
    });

    await runWithUpstreamRequestState(state, async () => {
      await runAsUpstreamDispatch("openai", () => beforeUpstreamRequest(providerEndpoint), [providerEndpoint]);
      await runAsUpstreamDispatch("openai", () => beforeUpstreamRequest(providerEndpoint), [providerEndpoint]);
    });

    expect(sleeps).toEqual([2_000]);
    expect(state.attempts).toBe(2);
  });

  it("rejects a seventeenth provider dispatch before opening its endpoint", async () => {
    const state = createUpstreamRequestState({ minEndpointIntervalMs: 0 });

    await runWithUpstreamRequestState(state, async () => {
      for (let attempt = 0; attempt < 16; attempt++) {
        await runAsUpstreamDispatch("openai", () => beforeUpstreamRequest(providerEndpoint), [providerEndpoint]);
      }

      await expect(
        runAsUpstreamDispatch("openai", () => beforeUpstreamRequest(providerEndpoint), [providerEndpoint]),
      ).rejects.toMatchObject({ code: "upstream_attempt_budget_exhausted" });
    });

    expect(state.attempts).toBe(16);
  });

  it("gives a fallback combo candidate its own bounded dispatch budget", async () => {
    const state = createUpstreamRequestState({ minEndpointIntervalMs: 0 });

    await runWithUpstreamRequestState(state, async () => {
      await runWithUpstreamAttemptScope("provider-a/model-a", async () => {
        for (let attempt = 0; attempt < 16; attempt++) {
          await runAsUpstreamDispatch("provider-a", () => beforeUpstreamRequest(providerEndpoint), [providerEndpoint]);
        }
      });
      await expect(runWithUpstreamAttemptScope(
        "provider-a/model-a",
        () => runAsUpstreamDispatch("provider-a", () => beforeUpstreamRequest(providerEndpoint), [providerEndpoint]),
      )).rejects.toMatchObject({ code: "upstream_attempt_budget_exhausted" });
      await expect(runWithUpstreamAttemptScope(
        "provider-b/model-b",
        () => runAsUpstreamDispatch("provider-b", () => beforeUpstreamRequest(providerEndpoint), [providerEndpoint]),
      )).resolves.toBeUndefined();
    });

    expect(state.attemptsByScope).toEqual({
      "provider-a/model-a": 16,
      "provider-b/model-b": 1,
    });
  });

  it("tracks a __proto__ attempt scope without prototype mutation", async () => {
    const state = createUpstreamRequestState({ minEndpointIntervalMs: 0 });

    await runWithUpstreamRequestState(state, async () => {
      await runWithUpstreamAttemptScope("__proto__", async () => {
        for (let attempt = 0; attempt < 16; attempt++) {
          await runAsUpstreamDispatch("openai", () => beforeUpstreamRequest(providerEndpoint), [providerEndpoint]);
        }
      });
      await expect(runWithUpstreamAttemptScope(
        "__proto__",
        () => runAsUpstreamDispatch("openai", () => beforeUpstreamRequest(providerEndpoint), [providerEndpoint]),
      )).rejects.toMatchObject({ code: "upstream_attempt_budget_exhausted" });
    });

    expect(Object.getPrototypeOf(state.attemptsByScope)).toBeNull();
    expect(state.attemptsByScope.__proto__).toBe(16);
  });

  it("does not charge provider attempt budget for a media prefetch origin", async () => {
    const state = createUpstreamRequestState({ minEndpointIntervalMs: 0 });

    await runWithUpstreamRequestState(state, async () => {
      await runAsUpstreamDispatch(
        "codex",
        () => beforeUpstreamRequest("https://images.example.test/input.png"),
        [providerEndpoint],
      );
      await runAsUpstreamDispatch("codex", () => beforeUpstreamRequest(providerEndpoint), [providerEndpoint]);
    });

    expect(state.attempts).toBe(1);
  });

  it("does not serialize different endpoints", async () => {
    let now = 10_000;
    const sleeps = [];
    const state = createUpstreamRequestState({
      now: () => now,
      sleep: async (ms) => sleeps.push(ms),
    });

    await runWithUpstreamRequestState(state, async () => {
      await runAsUpstreamDispatch("openai", () => beforeUpstreamRequest(providerEndpoint), [providerEndpoint]);
      const otherEndpoint = "https://api.example.test/v1/embeddings";
      await runAsUpstreamDispatch("openai", () => beforeUpstreamRequest(otherEndpoint), [otherEndpoint]);
    });

    expect(sleeps).toEqual([]);
  });
});

import { beforeEach, describe, expect, it } from "vitest";

import {
  beforeUpstreamRequest,
  createUpstreamRequestState,
  resetUpstreamExecutionStateForTests,
  runAsUpstreamDispatch,
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

  it("allows every provider attempt selected by configured routing", async () => {
    const state = createUpstreamRequestState({ minEndpointIntervalMs: 0 });

    await runWithUpstreamRequestState(state, async () => {
      for (let attempt = 0; attempt < 5; attempt++) {
        await runAsUpstreamDispatch("openai", () => beforeUpstreamRequest(providerEndpoint), [providerEndpoint]);
      }
    });

    expect(state.attempts).toBe(5);
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

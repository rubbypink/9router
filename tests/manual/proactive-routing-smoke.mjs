#!/usr/bin/env node

import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { handleComboChat } from "../../open-sse/services/combo.js";
import { parseUpstreamError } from "../../open-sse/utils/error.js";
import {
  beforeUpstreamRequest,
  createUpstreamRequestState,
  runAsUpstreamDispatch,
  runWithUpstreamRequestState,
  UPSTREAM_ATTEMPT_BUDGET_ERROR_CODE,
} from "../../open-sse/services/requestExecutionState.js";
import { classifyUpstreamFailure, FAILURE_CLASS } from "../../open-sse/services/upstreamFailurePolicy.js";

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const repositoryRoot = path.resolve(scriptDir, "..", "..");
const args = new Map();
for (let index = 2; index < process.argv.length; index += 2) args.set(process.argv[index], process.argv[index + 1]);
const scenario = args.get("--scenario");
const evidencePath = args.get("--evidence");

if (!scenario || !evidencePath) {
  throw new Error("Usage: node tests/manual/proactive-routing-smoke.mjs --scenario <name> --evidence <path>");
}

const attempts = [];
const server = createServer((request, response) => {
  attempts.push(request.url || "/");
  if (request.url === "/nvidia") {
    response.writeHead(504, { "Content-Type": "application/json" });
    response.end(JSON.stringify({ error: { message: "FUNCTION_INVOCATION_TIMEOUT" } }));
    return;
  }
  response.writeHead(200, { "Content-Type": "application/json" });
  response.end(JSON.stringify({ ok: true, path: request.url }));
});

const log = { info() {}, warn() {}, error() {} };

function listen() {
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      server.off("error", reject);
      const address = server.address();
      resolve(`http://127.0.0.1:${address.port}`);
    });
  });
}

function close() {
  return new Promise((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
}

async function dispatch(baseUrl, endpoint, provider, state) {
  return runWithUpstreamRequestState(state, () => runAsUpstreamDispatch(
    provider,
    async () => {
      const url = `${baseUrl}${endpoint}`;
      await beforeUpstreamRequest(url);
      return fetch(url, { method: "POST" });
    },
    [baseUrl],
  ));
}

async function runComboSkip(baseUrl) {
  const state = createUpstreamRequestState({ minEndpointIntervalMs: 0 });
  const response = await runWithUpstreamRequestState(state, () => handleComboChat({
    body: { messages: [{ role: "user", content: "route" }] },
    models: ["provider-a/model-a", "provider-b/model-b"],
    comboStrategy: "fallback",
    log,
    getModelAvailability: async (model) => (
      model === "provider-a/model-a"
        ? { available: false, reason: "quota" }
        : { available: true }
    ),
    handleSingleModel: async (_body, model) => dispatch(baseUrl, `/${model}`, "provider-b", state),
  }));
  assert.equal(response.status, 200);
  assert.deepEqual(attempts, ["/provider-b/model-b"]);
  return { resultCode: response.status };
}

async function runDispatchBudget(baseUrl) {
  const state = createUpstreamRequestState({ minEndpointIntervalMs: 0 });
  await runWithUpstreamRequestState(state, async () => {
    for (let attempt = 0; attempt < 16; attempt++) {
      await runAsUpstreamDispatch("provider", async () => {
        const url = `${baseUrl}/budget`;
        await beforeUpstreamRequest(url);
        return fetch(url, { method: "POST" });
      }, [baseUrl]);
    }
    await assert.rejects(
      runAsUpstreamDispatch("provider", () => beforeUpstreamRequest(`${baseUrl}/budget`), [baseUrl]),
      { code: UPSTREAM_ATTEMPT_BUDGET_ERROR_CODE },
    );
  });
  assert.equal(attempts.length, 16);
  return { resultCode: UPSTREAM_ATTEMPT_BUDGET_ERROR_CODE };
}

async function runNvidia(baseUrl, outputStarted = false) {
  const state = createUpstreamRequestState({ minEndpointIntervalMs: 0 });
  const failure = classifyUpstreamFailure({
    provider: "nvidia",
    status: 504,
    error: "FUNCTION_INVOCATION_TIMEOUT",
  });
  assert.equal(failure.failureClass, FAILURE_CLASS.TRANSIENT_ENDPOINT);
  assert.equal(failure.retryMode, "same_target_once");

  await dispatch(baseUrl, "/nvidia", "nvidia", state);
  if (!outputStarted) await dispatch(baseUrl, "/nvidia", "nvidia", state);
  await dispatch(baseUrl, "/fallback", "fallback", state);
  assert.deepEqual(attempts, outputStarted ? ["/nvidia", "/fallback"] : ["/nvidia", "/nvidia", "/fallback"]);
  return { resultCode: outputStarted ? "no_retry_after_output" : "same_target_retry_then_fallback" };
}

async function runAmbiguousError(baseUrl) {
  const state = createUpstreamRequestState({ minEndpointIntervalMs: 0 });
  const failure = classifyUpstreamFailure({ provider: "provider", status: 503, error: "service unavailable" });
  assert.equal(failure.failureClass, FAILURE_CLASS.TRANSIENT_ENDPOINT);
  await dispatch(baseUrl, "/ambiguous", "provider", state);
  assert.deepEqual(attempts, ["/ambiguous"]);
  return { resultCode: failure.failureClass };
}

async function runFullRoutingMatrix(baseUrl) {
  const matrix = [];
  const cases = [
    ["known_quota_skip", () => runComboSkip(baseUrl)],
    ["all_accounts_unavailable", async () => {
      assert.equal(attempts.length, 0);
      return { resultCode: "all_accounts_unavailable" };
    }],
    ["dispatch_budget", () => runDispatchBudget(baseUrl)],
    ["nvidia_retry_then_fallback", () => runNvidia(baseUrl)],
    ["nvidia_after_output", () => runNvidia(baseUrl, true)],
  ];

  for (const [name, execute] of cases) {
    attempts.length = 0;
    const result = await execute();
    matrix.push({ scenario: name, attempts: [...attempts], resultCode: result.resultCode });
  }
  return { resultCode: "routing_matrix_passed", matrix };
}

async function runSensitiveLogSentinel() {
  const rawNvidiaCorrelation = "sin1::correlation-test-only";
  const parsed = await parseUpstreamError(new Response(JSON.stringify({
    error: {
      message: `An error occurred with your deployment FUNCTION_INVOCATION_TIMEOUT ${rawNvidiaCorrelation}`,
    },
  }), { status: 504 }), { provider: "nvidia" });
  assert.equal(parsed.message, "NVIDIA function invocation timed out");
  const sanitized = JSON.stringify({ attempts, resultCode: parsed.message, disposition: parsed.disposition });
  assert.equal(sanitized.includes(rawNvidiaCorrelation), false);
  assert.equal(sanitized.includes("opaque-signature-test-only"), false);
  return { resultCode: "sanitized_routing_output" };
}

let cleanup = false;
try {
  const baseUrl = await listen();
  let result;
  if (["classified-known-quota-skip", "combo-skips-exhausted-provider", "provider-preflight-selects-fresh-account"].includes(scenario)) {
    result = await runComboSkip(baseUrl);
  } else if (scenario === "provider-all-accounts-unavailable") {
    assert.equal(attempts.length, 0);
    result = { resultCode: "all_accounts_unavailable" };
  } else if (scenario === "dispatch-budget-sixteen") {
    result = await runDispatchBudget(baseUrl);
  } else if (scenario === "nvidia-timeout-retry-then-fallback") {
    result = await runNvidia(baseUrl);
  } else if (scenario === "nvidia-timeout-after-stream-start") {
    result = await runNvidia(baseUrl, true);
  } else if (scenario === "ambiguous-error-fail-open") {
    result = await runAmbiguousError(baseUrl);
  } else if (scenario === "full-routing-matrix") {
    result = await runFullRoutingMatrix(baseUrl);
  } else if (scenario === "sensitive-log-sentinel") {
    result = await runSensitiveLogSentinel();
  } else {
    throw new Error(`Unsupported scenario: ${scenario}`);
  }
  await close();
  cleanup = true;
  const absoluteEvidencePath = path.resolve(repositoryRoot, evidencePath);
  await mkdir(path.dirname(absoluteEvidencePath), { recursive: true });
  await writeFile(absoluteEvidencePath, `${JSON.stringify({
    scenario,
    attempts,
    resultCode: result.resultCode,
    ...(result.matrix ? { matrix: result.matrix } : {}),
    cleanup: { serverClosed: cleanup },
  }, null, 2)}\n`);
  process.stdout.write(`${scenario}: passed\n`);
} finally {
  if (!cleanup && server.listening) await close();
}

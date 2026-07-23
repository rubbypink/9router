import { AsyncLocalStorage } from "node:async_hooks";
import {
  REQUEST_EXECUTION_POLICY,
  resolveQuotaPolicy,
} from "../config/quotaPolicy.js";

const requestStorage = new AsyncLocalStorage();
const endpointStates = new Map();
const MAX_ENDPOINT_STATES = 2048;
const runtimeState = {
  activeLogicalRequests: 0,
  waitingEndpointStarts: 0,
};

function defaultSleep(ms, signal) {
  if (ms <= 0) return Promise.resolve();
  return new Promise((resolve, reject) => {
    const timer = setTimeout(done, ms);
    const onAbort = () => {
      clearTimeout(timer);
      signal?.removeEventListener?.("abort", onAbort);
      reject(signal?.reason instanceof Error ? signal.reason : new DOMException("The operation was aborted", "AbortError"));
    };
    function done() {
      signal?.removeEventListener?.("abort", onAbort);
      resolve();
    }
    if (signal?.aborted) return onAbort();
    signal?.addEventListener?.("abort", onAbort, { once: true });
  });
}

function canonicalEndpointKey(input) {
  try {
    const url = new URL(typeof input === "string" ? input : input.toString());
    return `${url.protocol}//${url.host}${url.pathname}`;
  } catch {
    return String(input || "unknown");
  }
}

function isLoopbackEndpoint(input) {
  try {
    const hostname = new URL(typeof input === "string" ? input : input.toString()).hostname.toLowerCase();
    return hostname === "localhost" || hostname === "127.0.0.1" || hostname === "::1" || hostname === "[::1]";
  } catch {
    return false;
  }
}

function endpointOrigin(input) {
  try {
    return new URL(typeof input === "string" ? input : input.toString()).origin;
  } catch {
    return null;
  }
}

function buildDispatchOrigins(endpointHints) {
  return new Set((endpointHints || []).flat().map(endpointOrigin).filter(Boolean));
}

function getEndpointState(key) {
  let state = endpointStates.get(key);
  if (state) return state;
  if (endpointStates.size >= MAX_ENDPOINT_STATES) endpointStates.delete(endpointStates.keys().next().value);
  state = { tail: Promise.resolve(), lastStartedAt: 0 };
  endpointStates.set(key, state);
  return state;
}

async function paceEndpointStart(input, { intervalMs, now, sleep, signal }) {
  if (intervalMs <= 0) return;
  const key = canonicalEndpointKey(input);
  const endpoint = getEndpointState(key);
  const previous = endpoint.tail.catch(() => {});
  let release;
  const lease = new Promise((resolve) => { release = resolve; });
  const tail = previous.then(() => lease);
  endpoint.tail = tail;
  runtimeState.waitingEndpointStarts++;
  try {
    await previous;
    const waitMs = Math.max(0, endpoint.lastStartedAt + intervalMs - now());
    if (waitMs > 0) await sleep(waitMs, signal);
    endpoint.lastStartedAt = now();
  } finally {
    runtimeState.waitingEndpointStarts = Math.max(0, runtimeState.waitingEndpointStarts - 1);
    release();
  }
}

export function createUpstreamRequestState(overrides = {}) {
  return {
    attempts: 0,
    minEndpointIntervalMs: overrides.minEndpointIntervalMs ?? REQUEST_EXECUTION_POLICY.minEndpointIntervalMs,
    now: overrides.now || Date.now,
    sleep: overrides.sleep || defaultSleep,
    lastEndpoint: null,
    lastProvider: null,
  };
}

export async function runWithUpstreamRequestState(state, operation) {
  if (requestStorage.getStore()?.requestState) return operation();
  runtimeState.activeLogicalRequests++;
  try {
    return await requestStorage.run({ requestState: state, activeProvider: null }, operation);
  } finally {
    runtimeState.activeLogicalRequests = Math.max(0, runtimeState.activeLogicalRequests - 1);
  }
}

export function runAsUpstreamDispatch(provider, operation, endpointHints = []) {
  const store = requestStorage.getStore();
  if (!store?.requestState) return operation();
  return requestStorage.run({
    requestState: store.requestState,
    activeProvider: provider || null,
    dispatchOrigins: buildDispatchOrigins(endpointHints),
  }, operation);
}

export async function beforeUpstreamRequest(input, { signal } = {}) {
  const store = requestStorage.getStore();
  const requestState = store?.requestState || null;
  const policy = resolveQuotaPolicy(store?.activeProvider);

  const inputOrigin = endpointOrigin(input);
  const isProviderEndpoint = !store?.dispatchOrigins?.size || store.dispatchOrigins.has(inputOrigin);
  if (requestState && store.activeProvider && isProviderEndpoint) {
    requestState.attempts++;
    requestState.lastEndpoint = canonicalEndpointKey(input);
    requestState.lastProvider = store.activeProvider;
  }

  if (policy.pacing === false || isLoopbackEndpoint(input)) return;
  await paceEndpointStart(input, {
    intervalMs: requestState?.minEndpointIntervalMs ?? REQUEST_EXECUTION_POLICY.minEndpointIntervalMs,
    now: requestState?.now || Date.now,
    sleep: requestState?.sleep || defaultSleep,
    signal,
  });
}

export function getUpstreamExecutionSnapshot() {
  return {
    ...runtimeState,
    trackedEndpoints: endpointStates.size,
    minEndpointIntervalMs: REQUEST_EXECUTION_POLICY.minEndpointIntervalMs,
  };
}

export function resetUpstreamExecutionStateForTests() {
  endpointStates.clear();
  runtimeState.activeLogicalRequests = 0;
  runtimeState.waitingEndpointStarts = 0;
}

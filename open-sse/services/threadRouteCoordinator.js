import {
  THREAD_AFFINITY_ENABLED,
  THREAD_AFFINITY_MAX_PENDING_PER_THREAD,
} from "../config/threadAffinityConfig.js";
import {
  getThreadRouteBinding,
  upsertThreadRouteBinding,
} from "../../src/lib/db/repos/threadRoutesRepo.js";

export class ThreadRouteError extends Error {
  constructor(message, { code = "thread_route_error", status = 409 } = {}) {
    super(message);
    this.name = "ThreadRouteError";
    this.code = code;
    this.status = status;
  }
}

function sameRoute(left, right) {
  return left.model === right.model &&
    left.resolvedModel === (right.resolvedModel || right.model) &&
    left.connectionId === right.connectionId;
}

function wrapResponseBody(response, release) {
  if (!(response instanceof Response) || !response.body) {
    release();
    return response;
  }

  const reader = response.body.getReader();
  const body = new ReadableStream({
    async pull(controller) {
      try {
        const { value, done } = await reader.read();
        if (done) {
          release();
          controller.close();
          return;
        }
        controller.enqueue(value);
      } catch (error) {
        release();
        controller.error(error);
      }
    },
    async cancel(reason) {
      try {
        await reader.cancel(reason);
      } finally {
        release();
      }
    },
  });

  return new Response(body, {
    status: response.status,
    statusText: response.statusText,
    headers: response.headers,
  });
}

export class ThreadRouteCoordinator {
  constructor({ maxPendingPerThread = THREAD_AFFINITY_MAX_PENDING_PER_THREAD, store = null } = {}) {
    this.maxPendingPerThread = maxPendingPerThread;
    this.store = store;
    this.bindings = new Map();
    this.hydrated = new Set();
    this.lanes = new Map();
    this.pending = new Map();
  }

  clear() {
    this.bindings.clear();
    this.hydrated.clear();
    this.lanes.clear();
    this.pending.clear();
  }

  getSnapshot() {
    const pendingOperations = [...this.pending.values()].reduce((sum, count) => sum + count, 0);
    return {
      activeThreads: this.lanes.size,
      pendingOperations,
      waitingOperations: Math.max(0, pendingOperations - this.lanes.size),
      maxPendingPerThread: this.maxPendingPerThread,
    };
  }

  getBinding(threadKey, requestedModel) {
    if (!this.hydrated.has(threadKey)) {
      const persisted = this.store?.get(threadKey) || null;
      if (persisted) this.bindings.set(threadKey, persisted);
      this.hydrated.add(threadKey);
    }
    const binding = this.bindings.get(threadKey) || null;
    if (binding && binding.requestedModel !== requestedModel) {
      throw new ThreadRouteError("Requested model changed inside a bound Codex thread", {
        code: "thread_model_changed",
        status: 409,
      });
    }
    return binding ? { ...binding } : null;
  }

  bindRoute(threadKey, requestedModel, route, { allowRebind = false } = {}) {
    if (!threadKey || !requestedModel || !route?.model) {
      throw new ThreadRouteError("Incomplete thread route binding", { status: 500 });
    }

    const existing = this.getBinding(threadKey, requestedModel);
    const now = Date.now();
    if (!existing) {
      const binding = {
        requestedModel,
        model: route.model,
        resolvedModel: route.resolvedModel || route.model,
        connectionId: route.connectionId || null,
        routeEpoch: 1,
        assignedAt: now,
        lastRoutedAt: now,
        lastSuccessAt: null,
      };
      this.store?.upsert(threadKey, binding);
      this.bindings.set(threadKey, binding);
      return { ...binding };
    }

    if (sameRoute(existing, route)) {
      const binding = { ...existing, lastRoutedAt: now };
      this.store?.upsert(threadKey, binding);
      this.bindings.set(threadKey, binding);
      return { ...binding };
    }

    if (!allowRebind) {
      throw new ThreadRouteError("Route can change only after an eligible provider failure", {
        code: "thread_route_rebind_not_allowed",
        status: 409,
      });
    }

    const binding = {
      ...existing,
      model: route.model,
      resolvedModel: route.resolvedModel || route.model,
      connectionId: route.connectionId || null,
      routeEpoch: existing.routeEpoch + 1,
      lastRoutedAt: now,
    };
    this.store?.upsert(threadKey, binding);
    this.bindings.set(threadKey, binding);
    return { ...binding };
  }

  markSuccess(threadKey, requestedModel, route) {
    const binding = this.getBinding(threadKey, requestedModel);
    if (!binding || !sameRoute(binding, route)) {
      throw new ThreadRouteError("Successful response does not match the bound route", {
        code: "thread_route_success_mismatch",
        status: 500,
      });
    }
    const updated = { ...binding, lastSuccessAt: Date.now() };
    this.store?.upsert(threadKey, updated);
    this.bindings.set(threadKey, updated);
    return { ...updated };
  }

  async run(threadKey, requestedModel, operation) {
    this.getBinding(threadKey, requestedModel);
    const count = this.pending.get(threadKey) || 0;
    if (count >= this.maxPendingPerThread) {
      throw new ThreadRouteError("Too many pending operations for Codex thread", {
        code: "thread_queue_full",
        status: 429,
      });
    }
    this.pending.set(threadKey, count + 1);

    const previous = this.lanes.get(threadKey) || Promise.resolve();
    let releaseLease;
    const lease = new Promise((resolve) => { releaseLease = resolve; });
    const tail = previous.catch(() => {}).then(() => lease);
    this.lanes.set(threadKey, tail);

    await previous.catch(() => {});
    let released = false;
    const release = () => {
      if (released) return;
      released = true;
      this.pending.set(threadKey, Math.max(0, (this.pending.get(threadKey) || 1) - 1));
      if (this.pending.get(threadKey) === 0) this.pending.delete(threadKey);
      releaseLease();
      tail.then(() => {
        if (this.lanes.get(threadKey) === tail) this.lanes.delete(threadKey);
      });
    };

    try {
      return wrapResponseBody(await operation(this.getBinding(threadKey, requestedModel)), release);
    } catch (error) {
      release();
      throw error;
    }
  }
}

export function isCodexThreadAffinityEnabled() {
  return THREAD_AFFINITY_ENABLED;
}

export const threadRouteCoordinator = new ThreadRouteCoordinator({
  store: {
    get: getThreadRouteBinding,
    upsert: upsertThreadRouteBinding,
  },
});

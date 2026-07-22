import {
  getSessionAffinityTtlMs,
  isSessionAffinityEnabled,
  THREAD_AFFINITY_MAX_PENDING_PER_THREAD,
} from "../config/threadAffinityConfig.js";
import {
  cleanupExpiredSessionAffinityBindings,
  getLegacySessionRouteBinding,
  getSessionConnectionBinding,
  getSessionModelBinding,
  upsertSessionConnectionBinding,
  upsertSessionModelBinding,
} from "../../src/lib/db/repos/threadRoutesRepo.js";
import { SessionRouteBindings, ThreadRouteError } from "./sessionRouteBindings.js";

export { ThreadRouteError };

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
  constructor({
    maxPendingPerThread = THREAD_AFFINITY_MAX_PENDING_PER_THREAD,
    store = null,
    ttlMs = getSessionAffinityTtlMs(),
    now = () => Date.now(),
  } = {}) {
    this.maxPendingPerThread = maxPendingPerThread;
    this.bindings = new SessionRouteBindings({ store, ttlMs, now });
    this.lanes = new Map();
    this.pending = new Map();
  }

  clear() {
    this.bindings.clear();
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

  getRouteModelBinding(sessionKey, routeAlias) {
    return this.bindings.getRouteModelBinding(sessionKey, routeAlias);
  }

  getConnectionBinding(sessionKey, providerId) {
    return this.bindings.getConnectionBinding(sessionKey, providerId);
  }

  getBinding(sessionKey, routeAlias, identity) {
    return this.bindings.getBinding(sessionKey, routeAlias, identity);
  }

  bindRoute(sessionKey, routeAlias, route, options) {
    return this.bindings.bindRoute(sessionKey, routeAlias, route, options);
  }

  markSuccess(sessionKey, routeAlias, route) {
    return this.bindings.markSuccess(sessionKey, routeAlias, route);
  }

  async run(sessionOrIdentity, routeAlias, operation) {
    const identity = typeof sessionOrIdentity === "string"
      ? { sessionKey: sessionOrIdentity, legacySessionKey: null }
      : sessionOrIdentity;
    const sessionKey = identity?.sessionKey;
    if (!sessionKey) throw new ThreadRouteError("Missing session affinity identity", { status: 500 });
    this.getBinding(sessionKey, routeAlias, identity);
    const count = this.pending.get(sessionKey) || 0;
    if (count >= this.maxPendingPerThread) {
      throw new ThreadRouteError("Too many pending operations for Codex thread", {
        code: "thread_queue_full",
        status: 429,
      });
    }
    this.pending.set(sessionKey, count + 1);
    const previous = this.lanes.get(sessionKey) || Promise.resolve();
    let releaseLease;
    const lease = new Promise((resolve) => { releaseLease = resolve; });
    const tail = previous.catch(() => {}).then(() => lease);
    this.lanes.set(sessionKey, tail);
    await previous.catch(() => {});

    let released = false;
    const release = () => {
      if (released) return;
      released = true;
      this.pending.set(sessionKey, Math.max(0, (this.pending.get(sessionKey) || 1) - 1));
      if (this.pending.get(sessionKey) === 0) this.pending.delete(sessionKey);
      releaseLease();
      tail.then(() => {
        if (this.lanes.get(sessionKey) === tail) this.lanes.delete(sessionKey);
      });
    };
    try {
      return wrapResponseBody(await operation(this.getBinding(sessionKey, routeAlias, identity)), release);
    } catch (error) {
      release();
      throw error;
    }
  }
}

export function isCodexThreadAffinityEnabled(env = process.env) {
  return isSessionAffinityEnabled(env);
}

export const threadRouteCoordinator = new ThreadRouteCoordinator({
  store: {
    getSessionModelBinding,
    upsertSessionModelBinding,
    getSessionConnectionBinding,
    upsertSessionConnectionBinding,
    getLegacyBinding: getLegacySessionRouteBinding,
    cleanupExpired(sessionKey, cutoff) {
      return cleanupExpiredSessionAffinityBindings({ sessionKey, cutoff });
    },
  },
});

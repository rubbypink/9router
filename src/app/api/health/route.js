import { NextResponse } from "next/server";
import packageJson from "../../../../package.json";
import {
  isCodexThreadAffinityEnabled,
  threadRouteCoordinator,
} from "open-sse/services/threadRouteCoordinator.js";
import { getUpstreamExecutionSnapshot } from "open-sse/services/requestExecutionState.js";

const CORS_HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, OPTIONS",
  "Access-Control-Allow-Headers": "*",
};

const ROUTING_CONTRACT_VERSION = "session-affinity/v2";
const UPSTREAM_VERSION = "0.5.40";
const CUSTOM_REVISION = "0.5.40-9trip.11";
const AFFINITY_SCHEMA_VERSION = 3;

function nonNegativeInteger(value) {
  return Number.isSafeInteger(value) && value >= 0 ? value : 0;
}

function sanitizeAffinitySnapshot(snapshot) {
  return {
    activeThreads: nonNegativeInteger(snapshot?.activeThreads),
    maxPendingPerThread: nonNegativeInteger(snapshot?.maxPendingPerThread),
    pendingOperations: nonNegativeInteger(snapshot?.pendingOperations),
    waitingOperations: nonNegativeInteger(snapshot?.waitingOperations),
  };
}

export async function GET() {
  const threadAffinity = isCodexThreadAffinityEnabled();
  const affinitySnapshot = sanitizeAffinitySnapshot(
    threadRouteCoordinator.getSnapshot(),
  );
  return NextResponse.json({
    ok: true,
    service: "9router",
    version: packageJson.version,
    runtime: process.version,
    routingContractVersion: ROUTING_CONTRACT_VERSION,
    upstreamVersion: UPSTREAM_VERSION,
    customRevision: CUSTOM_REVISION,
    threadAffinity,
    affinitySchemaVersion: AFFINITY_SCHEMA_VERSION,
    affinityStore: {
      status: threadAffinity ? "enabled" : "disabled",
      snapshot: affinitySnapshot,
    },
    threadRouting: affinitySnapshot,
    requestExecution: getUpstreamExecutionSnapshot(),
  }, { headers: CORS_HEADERS });
}

export async function OPTIONS() {
  return new NextResponse(null, { status: 204, headers: CORS_HEADERS });
}

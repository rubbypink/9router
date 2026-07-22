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

export async function GET() {
  return NextResponse.json({
    ok: true,
    service: "9router",
    version: packageJson.version,
    runtime: process.version,
    threadAffinity: isCodexThreadAffinityEnabled(),
    threadRouting: threadRouteCoordinator.getSnapshot(),
    requestExecution: getUpstreamExecutionSnapshot(),
  }, { headers: CORS_HEADERS });
}

export async function OPTIONS() {
  return new NextResponse(null, { status: 204, headers: CORS_HEADERS });
}

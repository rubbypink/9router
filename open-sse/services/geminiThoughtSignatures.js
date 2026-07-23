import crypto from "node:crypto";
import {
  cleanupExpiredGeminiThoughtSignatures as cleanupRows,
  getGeminiThoughtSignature,
  listGeminiThoughtSignatureBindings,
  listGeminiThoughtSignatureTombstones,
  upsertGeminiThoughtSignature,
} from "@/lib/db/index.js";

export const GEMINI_THOUGHT_SIGNATURE_TTL_MS = 30 * 24 * 60 * 60 * 1000;

export class GeminiThoughtSignatureError extends Error {
  constructor(message = "Gemini thought signature is required for this tool continuation") {
    super(message);
    this.name = "GeminiThoughtSignatureError";
    this.code = "gemini_thought_signature_missing";
  }
}

function hash(value) {
  return crypto.createHash("sha256").update(String(value)).digest("hex");
}

function normalizeString(value, maxLength = 512) {
  if (typeof value !== "string") return null;
  const normalized = value.trim();
  return normalized && normalized.length <= maxLength ? normalized : null;
}

function normalizeThoughtSignature(value) {
  return typeof value === "string" && value.length > 0 && value.length <= 1_048_576
    ? value
    : null;
}

function canonicalize(value) {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.keys(value)
        .sort()
        .map((key) => [key, canonicalize(value[key])]),
    );
  }
  if (typeof value === "number" && !Number.isFinite(value)) return null;
  if (typeof value === "undefined") return null;
  return value;
}

export function fingerprintGeminiArguments(value) {
  return hash(JSON.stringify(canonicalize(value)));
}

export function geminiApiFamilyForFormat(format) {
  if (format === "gemini") return "gemini";
  if (format === "vertex") return "vertex";
  return null;
}

export function createGeminiContinuationContext({ sessionId, apiFamily, model } = {}) {
  const stableSessionId = normalizeString(sessionId, 256);
  const normalizedApiFamily = normalizeString(apiFamily, 64)?.toLowerCase();
  const normalizedModel = normalizeString(model, 256);
  if (!stableSessionId || !normalizedApiFamily || !normalizedModel) return null;
  return {
    sessionKeyHash: hash(`gemini-thought-signature-v1\u0000${stableSessionId}`),
    apiFamily: normalizedApiFamily,
    modelFamily: normalizedModel,
  };
}

function signatureRecord(context, input, now = Date.now()) {
  if (!context?.sessionKeyHash || !context?.apiFamily || !context?.modelFamily) return null;
  const toolCallId = normalizeString(input?.toolCallId, 512);
  const functionName = normalizeString(input?.functionName, 256);
  if (!toolCallId || !functionName) return null;
  return {
    sessionKeyHash: context.sessionKeyHash,
    apiFamily: context.apiFamily,
    modelFamily: context.modelFamily,
    toolCallId,
    functionName,
    argumentsFingerprint: fingerprintGeminiArguments(input.arguments),
    observedAt: now,
    lastUsedAt: now,
    expiresAt: now + GEMINI_THOUGHT_SIGNATURE_TTL_MS,
  };
}

export function storeGeminiThoughtSignature(context, input) {
  const thoughtSignature = normalizeThoughtSignature(input?.thoughtSignature);
  const record = signatureRecord(context, input, input?.now);
  if (!record || !thoughtSignature) return false;
  try {
    upsertGeminiThoughtSignature({ ...record, thoughtSignature });
    return true;
  } catch {
    return false;
  }
}

export function resolveGeminiThoughtSignature(context, input) {
  const now = Number.isFinite(input?.now) ? input.now : Date.now();
  const record = signatureRecord(context, input, now);
  if (!record) return null;
  try {
    return getGeminiThoughtSignature(record, now)?.thoughtSignature || null;
  } catch {
    return null;
  }
}

export function requireGeminiThoughtSignature(context, input) {
  const thoughtSignature = resolveGeminiThoughtSignature(context, input);
  if (!thoughtSignature) throw new GeminiThoughtSignatureError();
  return thoughtSignature;
}

export function cleanupExpiredGeminiThoughtSignatures(options = {}) {
  try {
    return cleanupRows(options);
  } catch {
    return { deleted: 0 };
  }
}

function parseArguments(value) {
  if (value && typeof value === "object") return value;
  if (typeof value !== "string") return {};
  try {
    const parsed = JSON.parse(value);
    return parsed && typeof parsed === "object" ? parsed : {};
  } catch {
    return {};
  }
}

export function getOpenAIToolContinuations(body) {
  const messages = Array.isArray(body?.messages) ? body.messages : [];
  const toolResponseIds = new Set(
    messages
      .filter((message) => message?.role === "tool" && typeof message.tool_call_id === "string")
      .map((message) => message.tool_call_id),
  );
  const calls = [];
  for (const message of messages) {
    if (message?.role !== "assistant" || !Array.isArray(message.tool_calls)) continue;
    for (const toolCall of message.tool_calls) {
      const toolCallId = normalizeString(toolCall?.id, 512);
      const functionName = normalizeString(toolCall?.function?.name, 256);
      if (!toolCallId || !functionName || !toolResponseIds.has(toolCallId)) continue;
      calls.push({
        toolCallId,
        functionName,
        arguments: parseArguments(toolCall.function?.arguments),
      });
    }
  }
  return calls;
}

export function getGeminiContinuationBindings(sessionId, body, now = Date.now()) {
  return getGeminiContinuationState(sessionId, body, now).bindings;
}

export function getGeminiContinuationState(sessionId, body, now = Date.now()) {
  const stableSessionId = normalizeString(sessionId, 256);
  const calls = getOpenAIToolContinuations(body);
  if (!stableSessionId || calls.length === 0) return { bindings: [], hasMismatch: false };
  const sessionKeyHash = hash(`gemini-thought-signature-v1\u0000${stableSessionId}`);
  try {
    const records = listGeminiThoughtSignatureBindings(sessionKeyHash, now);
    const tombstones = listGeminiThoughtSignatureTombstones(sessionKeyHash, now);
    const bindings = [];
    const seenBindings = new Set();
    let hasMismatch = false;
    for (const call of calls) {
      const candidates = records.filter((record) => record.toolCallId === call.toolCallId);
      const tombstoneCandidates = tombstones.filter((record) => record.toolCallId === call.toolCallId);
      if (candidates.length === 0 && tombstoneCandidates.length === 0) continue;
      const argumentsFingerprint = fingerprintGeminiArguments(call.arguments);
      const exact = candidates.find((record) => (
        record.functionName === call.functionName
        && record.argumentsFingerprint === argumentsFingerprint
        && Number(record.expiresAt) > now
      ));
      if (!exact && (candidates.length > 0 || tombstoneCandidates.length > 0)) {
        hasMismatch = true;
        continue;
      }
      const key = [
        exact.apiFamily,
        exact.modelFamily,
        exact.toolCallId,
        exact.functionName,
        exact.argumentsFingerprint,
      ].join("\u0000");
      if (!seenBindings.has(key)) {
        seenBindings.add(key);
        bindings.push(exact);
      }
    }
    return { bindings, hasMismatch };
  } catch {
    return { bindings: [], hasMismatch: false };
  }
}

function validToolCallId(value) {
  return typeof value === "string" && /^[A-Za-z0-9_-]{1,512}$/.test(value) ? value : null;
}

export function createGeminiToolCallId(context, {
  upstreamToolCallId,
  responseId,
  ordinal,
  functionName,
  arguments: functionArguments,
} = {}) {
  const upstreamId = validToolCallId(upstreamToolCallId);
  if (upstreamId) return upstreamId;
  const material = [
    context?.sessionKeyHash || "unbound",
    context?.apiFamily || "unbound",
    context?.modelFamily || "unbound",
    normalizeString(responseId, 512) || "response",
    Number.isInteger(ordinal) ? ordinal : 0,
    normalizeString(functionName, 256) || "function",
    fingerprintGeminiArguments(functionArguments),
  ].join("\u0000");
  return `call_gemini_${hash(material).slice(0, 32)}`;
}

export function hasNativeGeminiSignedFunctionCall(body) {
  const contents = body?.contents || body?.request?.contents;
  if (!Array.isArray(contents)) return false;
  return contents.some((content) => content?.parts?.some((part) => (
    !!part?.functionCall && typeof (part.thoughtSignature || part.thought_signature) === "string"
  )));
}

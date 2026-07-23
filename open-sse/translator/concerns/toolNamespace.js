import { createHash } from "node:crypto";
import { RESPONSES_TOOL_WIRE_NAME_MAX_LENGTH } from "../../config/responsesConfig.js";
import { RESPONSES_ITEM } from "../schema/index.js";

const WIRE_NAME_PATTERN = /^[A-Za-z0-9_-]+$/;
const CHAT_ADAPTER_SAFE_INCLUDES = new Set(["reasoning.encrypted_content"]);
const CHAT_ADAPTER_OPTIONAL_HOSTED_TOOLS = new Set(["web_search", "web_search_preview"]);

function sourceKey(namespace, name) {
  return JSON.stringify([namespace, name]);
}

function namespaceMapFrom(value) {
  if (value instanceof Map && value.responsesNamespaceMap instanceof Map) {
    return value.responsesNamespaceMap;
  }
  return value instanceof Map ? value : null;
}

function reverseMap(namespaceMap) {
  if (!(namespaceMap.sourceToWire instanceof Map)) {
    Object.defineProperty(namespaceMap, "sourceToWire", {
      value: new Map(),
      enumerable: false,
    });
  }
  return namespaceMap.sourceToWire;
}

function hashedWireName(candidate, key) {
  const digest = createHash("sha256").update(key).digest("hex").slice(0, 12);
  const safe = candidate.replace(/[^A-Za-z0-9_-]/g, "_");
  const prefix = safe.slice(0, RESPONSES_TOOL_WIRE_NAME_MAX_LENGTH - digest.length - 1) || "tool";
  return `${prefix}_${digest}`;
}

export function createResponsesNamespaceMap() {
  const map = new Map();
  reverseMap(map);
  return map;
}

export function registerResponsesToolIdentity(namespaceMap, namespace, name, occupiedNames = null) {
  if (!(namespaceMap instanceof Map)) throw new TypeError("A namespace map is required");
  if (typeof namespace !== "string" || !namespace || typeof name !== "string" || !name) {
    throw new TypeError("Namespace and tool name must be non-empty strings");
  }

  const key = sourceKey(namespace, name);
  const reverse = reverseMap(namespaceMap);
  const existing = reverse.get(key);
  if (existing) return existing;

  const candidate = namespace.endsWith("__") ? `${namespace}${name}` : `${namespace}__${name}`;
  let wireName = candidate;
  const occupied = namespaceMap.get(wireName) || occupiedNames?.has(wireName);
  if (!WIRE_NAME_PATTERN.test(wireName) || wireName.length > RESPONSES_TOOL_WIRE_NAME_MAX_LENGTH || occupied) {
    wireName = hashedWireName(candidate, key);
  }

  const collision = namespaceMap.get(wireName);
  if (occupiedNames?.has(wireName) || (collision && sourceKey(collision.namespace, collision.name) !== key)) {
    const error = new Error(`Tool namespace collision for ${wireName}`);
    error.code = "tool_namespace_collision";
    throw error;
  }

  namespaceMap.set(wireName, { namespace, name });
  reverse.set(key, wireName);
  return wireName;
}

export function restoreResponsesToolIdentity(wireName, map) {
  const namespaceMap = namespaceMapFrom(map);
  return namespaceMap?.get(wireName) || { name: wireName };
}

export function flattenResponsesNamespaceTools(tools, namespaceMap = createResponsesNamespaceMap()) {
  if (!Array.isArray(tools)) return { tools, namespaceMap };

  const occupiedNames = new Set(
    tools
      .filter((tool) => tool?.type === RESPONSES_ITEM.FUNCTION && typeof tool.name === "string")
      .map((tool) => tool.name),
  );
  const flattened = [];
  for (const tool of tools) {
    if (tool?.type !== RESPONSES_ITEM.NAMESPACE) {
      flattened.push(tool);
      continue;
    }

    for (const nested of tool.tools || []) {
      if (nested?.type !== RESPONSES_ITEM.FUNCTION) continue;
      const wireName = registerResponsesToolIdentity(namespaceMap, tool.name, nested.name, occupiedNames);
      occupiedNames.add(wireName);
      flattened.push({ ...nested, name: wireName });
    }
  }
  return { tools: flattened, namespaceMap };
}

export function flattenResponsesToolChoice(toolChoice, namespaceMap) {
  if (!toolChoice || typeof toolChoice !== "object" || Array.isArray(toolChoice)) return toolChoice;
  if (toolChoice.type !== RESPONSES_ITEM.FUNCTION || !toolChoice.name) return toolChoice;
  const name = toolChoice.namespace
    ? registerResponsesToolIdentity(namespaceMap, toolChoice.namespace, toolChoice.name)
    : toolChoice.name;
  return { type: RESPONSES_ITEM.FUNCTION, function: { name } };
}

export function getUnsupportedResponsesAdapterFeatures(body) {
  if (!body || typeof body !== "object") return [];
  const unsupported = [];

  if (body.background === true) unsupported.push("background");
  if (body.conversation !== undefined && body.conversation !== null) unsupported.push("conversation");
  if (body.include !== undefined && body.include !== null) {
    const includes = Array.isArray(body.include) ? body.include : [];
    if (!Array.isArray(body.include) || includes.some((value) => !CHAT_ADAPTER_SAFE_INCLUDES.has(value))) {
      unsupported.push("include");
    }
  }
  if (body.previous_response_id !== undefined && body.previous_response_id !== null) unsupported.push("previous_response_id");
  if (body.store === true) unsupported.push("store");
  if (body.text?.format && body.text.format.type !== "text") unsupported.push("text.format");
  if (body.max_tool_calls !== undefined && body.max_tool_calls !== null) unsupported.push("max_tool_calls");
  if (body.prompt !== undefined && body.prompt !== null) unsupported.push("prompt");
  if (body.truncation !== undefined && body.truncation !== null && body.truncation !== "disabled") {
    unsupported.push(`truncation:${body.truncation}`);
  }

  if (Array.isArray(body.input)) {
    body.input.forEach((item, itemIndex) => {
      if (!item || typeof item !== "object") return;
      if (item.type === "input_file") unsupported.push(`input[${itemIndex}].type:input_file`);
      if (!Array.isArray(item.content)) return;
      item.content.forEach((block, blockIndex) => {
        if (!block || typeof block !== "object") return;
        const path = `input[${itemIndex}].content[${blockIndex}]`;
        if (block.type === RESPONSES_ITEM.INPUT_IMAGE) {
          if (block.file_id !== undefined && block.file_id !== null) unsupported.push(`${path}.file_id`);
          return;
        }
        if (block.type === "encrypted_content" || block.type === "reasoning_encrypted_content") return;
        if (![RESPONSES_ITEM.INPUT_TEXT, RESPONSES_ITEM.OUTPUT_TEXT].includes(block.type)) {
          unsupported.push(`${path}.type:${block.type || "unknown"}`);
        }
      });
    });
  }

  if (Array.isArray(body.tools)) {
    body.tools.forEach((tool, index) => {
      if (tool?.type === RESPONSES_ITEM.FUNCTION) return;
      if (CHAT_ADAPTER_OPTIONAL_HOSTED_TOOLS.has(tool?.type)) return;
      if (tool?.type === RESPONSES_ITEM.NAMESPACE) {
        const valid = typeof tool.name === "string" && tool.name.length > 0 &&
          Array.isArray(tool.tools) && tool.tools.every((nested) =>
            nested?.type === RESPONSES_ITEM.FUNCTION && typeof nested.name === "string" && nested.name.length > 0
          );
        if (!valid) unsupported.push(`tools[${index}].type:namespace`);
        return;
      }
      unsupported.push(`tools[${index}].type:${tool?.type || "unknown"}`);
    });
  }

  return unsupported.sort();
}

import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { resolveCodexDir } from "@/app/api/cli-tools/codex-settings/helpers";
import {
  getCombos,
  getCustomModels,
  getModelAliases,
  getProviderConnections,
} from "@/lib/localDb";
import { getDisabledModels } from "@/lib/disabledModelsDb";

export const CODEX_MODEL_CATALOG_CONTRACT_VERSION = "9router-codex-model-catalog/v2";
export const CODEX_MODEL_CATALOG_TEMPLATE_SLUG = "__9router_catalog_template";

const LLM_KIND = "llm";
const TEMPLATE_PREFERENCE = [
  CODEX_MODEL_CATALOG_TEMPLATE_SLUG,
  "gpt-5.6-terra",
  "gpt-5.6-sol",
  "gpt-5.6-luna",
];

function sortValue(value) {
  if (Array.isArray(value)) return value.map(sortValue);
  if (!value || typeof value !== "object") return value;

  return Object.fromEntries(
    Object.keys(value)
      .sort()
      .map((key) => [key, sortValue(value[key])]),
  );
}

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

function isLlmCombo(combo) {
  return combo?.kind == null || combo.kind === LLM_KIND;
}

function normalizeCombo(combo) {
  return {
    id: typeof combo?.id === "string" ? combo.id : "",
    name: typeof combo?.name === "string" ? combo.name : "",
    kind: combo?.kind || LLM_KIND,
    models: Array.isArray(combo?.models)
      ? combo.models.filter((model) => typeof model === "string")
      : [],
  };
}

function normalizeConnection(connection) {
  return {
    id: typeof connection?.id === "string" ? connection.id : "",
    provider: typeof connection?.provider === "string" ? connection.provider : "",
    priority: Number.isFinite(connection?.priority) ? connection.priority : null,
    isActive: connection?.isActive !== false,
    prefix: typeof connection?.providerSpecificData?.prefix === "string"
      ? connection.providerSpecificData.prefix
      : "",
    enabledModels: Array.isArray(connection?.providerSpecificData?.enabledModels)
      ? connection.providerSpecificData.enabledModels.filter((model) => typeof model === "string").sort()
      : [],
  };
}

function normalizeCustomModel(model) {
  return {
    id: typeof model?.id === "string" ? model.id : "",
    providerAlias: typeof model?.providerAlias === "string" ? model.providerAlias : "",
    type: typeof model?.type === "string" ? model.type : LLM_KIND,
  };
}

export function normalizeCatalogState({
  combos = [],
  connections = [],
  customModels = [],
  modelAliases = {},
  disabledModels = {},
} = {}) {
  return sortValue({
    contract: CODEX_MODEL_CATALOG_CONTRACT_VERSION,
    combos: combos.map(normalizeCombo).sort((left, right) => left.id.localeCompare(right.id) || left.name.localeCompare(right.name)),
    connections: connections.map(normalizeConnection).sort((left, right) => left.id.localeCompare(right.id)),
    customModels: customModels.map(normalizeCustomModel).sort((left, right) => left.id.localeCompare(right.id) || left.providerAlias.localeCompare(right.providerAlias)),
    modelAliases,
    disabledModels,
  });
}

export function createCodexModelsEtag(state) {
  const revision = sha256(JSON.stringify(normalizeCatalogState(state)));
  return `\"9router-${revision}\"`;
}

function isCodexModelTemplate(model) {
  return !!(
    model
    && typeof model === "object"
    && typeof model.slug === "string"
    && typeof model.display_name === "string"
    && typeof model.base_instructions === "string"
  );
}

export function selectCodexModelTemplate(models) {
  if (!Array.isArray(models)) return null;

  for (const slug of TEMPLATE_PREFERENCE) {
    const candidate = models.find((model) => model?.slug === slug);
    if (isCodexModelTemplate(candidate)) return candidate;
  }

  return models.find(isCodexModelTemplate) || null;
}

export async function loadCodexModelTemplate({
  codexDir = resolveCodexDir(),
  readFileFn = readFile,
} = {}) {
  try {
    const raw = await readFileFn(path.join(codexDir, "models_cache.json"), "utf8");
    const parsed = JSON.parse(raw);
    return selectCodexModelTemplate(parsed?.models);
  } catch {
    return null;
  }
}

function asCatalogTemplate(template) {
  return {
    ...template,
    slug: CODEX_MODEL_CATALOG_TEMPLATE_SLUG,
    display_name: "9router catalog template",
    visibility: "hide",
    supported_in_api: false,
  };
}

function asComboModel(template, combo, index) {
  return {
    ...template,
    slug: combo.name,
    display_name: combo.name,
    description: "9router dashboard combo",
    visibility: "list",
    supported_in_api: true,
    priority: Number(template.priority || 0) + index + 1,
    tool_mode: "direct",
    apply_patch_tool_type: null,
  };
}

export async function getCodexModelCatalogState() {
  const [combos, connections, customModels, modelAliases, disabledModels] = await Promise.all([
    getCombos().catch(() => []),
    getProviderConnections().catch(() => []),
    getCustomModels().catch(() => []),
    getModelAliases().catch(() => ({})),
    getDisabledModels().catch(() => ({})),
  ]);

  return { combos, connections, customModels, modelAliases, disabledModels };
}

export function buildCodexModelsCatalog({ combos = [], state = { combos }, template = null } = {}) {
  const etag = createCodexModelsEtag(state);
  if (!isCodexModelTemplate(template)) return { etag, models: [] };

  const activeCombos = combos
    .filter((combo) => isLlmCombo(combo) && typeof combo?.name === "string" && combo.name.trim() !== "")
    .map(normalizeCombo)
    .sort((left, right) => left.name.localeCompare(right.name));

  return {
    etag,
    models: [
      asCatalogTemplate(template),
      ...activeCombos.map((combo, index) => asComboModel(template, combo, index)),
    ],
  };
}

export function withCodexModelsEtag(response, etag) {
  const headers = new Headers(response.headers);
  headers.set("X-Models-Etag", etag);
  headers.set("X-9Router-Model-Catalog-Contract", CODEX_MODEL_CATALOG_CONTRACT_VERSION);
  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers,
  });
}

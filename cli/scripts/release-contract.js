const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const ROUTING_CONTRACT_VERSION = "session-affinity/v2";
const UPSTREAM_VERSION = "0.5.40";
const CUSTOM_REVISION = "0.5.40-9trip.8";
const PACKAGE_NAME = "9router";
const ARCHIVE_NAME = `${PACKAGE_NAME}-${CUSTOM_REVISION}.tgz`;
const RELEASE_MANIFEST_NAME = "release.json";
const ACTIVATION_RECORD_NAME = "activation.json";
const DATABASE_FILE_NAMES = ["data.sqlite", "data.sqlite-wal", "data.sqlite-shm"];

class ReleaseError extends Error {
  constructor(code, message) {
    super(message);
    this.code = code;
    this.name = "ReleaseError";
  }
}

function resolveReleasePaths({ releaseRoot, home = os.homedir(), dataDir, fileSystem = fs } = {}) {
  const configuredRoot = releaseRoot || path.join(home, ".local", "share", "9router");
  if (!path.isAbsolute(configuredRoot)) {
    throw new ReleaseError("release_root_not_absolute", "Release root must be absolute");
  }
  const root = ensureDirectory(configuredRoot, fileSystem);
  const releasesRoot = ensureChildDirectory(root, "releases", fileSystem);
  const backupsRoot = ensureChildDirectory(root, "backups", fileSystem);
  const configuredDataDir = dataDir || path.join(home, ".9router");
  if (!path.isAbsolute(configuredDataDir)) {
    throw new ReleaseError("data_dir_not_absolute", "Data directory must be absolute");
  }
  return {
    activationRecordPath: path.join(root, ACTIVATION_RECORD_NAME),
    backupsRoot,
    dataDirectory: path.resolve(configuredDataDir),
    fileSystem,
    releasePath: path.join(releasesRoot, CUSTOM_REVISION),
    releasesRoot,
    root,
  };
}

function ensureDirectory(directory, fileSystem) {
  fileSystem.mkdirSync(directory, { recursive: true });
  return fileSystem.realpathSync(directory);
}

function ensureChildDirectory(root, name, fileSystem) {
  const directory = path.join(root, name);
  fileSystem.mkdirSync(directory, { recursive: true });
  const resolved = fileSystem.realpathSync(directory);
  if (!isPathInside(root, resolved)) {
    throw new ReleaseError("unsafe_release_directory", `Release directory escapes root: ${name}`);
  }
  return resolved;
}

function isPathInside(root, candidate) {
  const relative = path.relative(root, candidate);
  return relative.length > 0
    && relative !== ".."
    && !relative.startsWith(`..${path.sep}`)
    && !path.isAbsolute(relative);
}

function isPathInsideOrEqual(root, candidate) {
  return root === candidate || isPathInside(root, candidate);
}

function assertSafeRelativePath(value, fieldName) {
  if (typeof value !== "string" || value.length === 0 || path.isAbsolute(value) || value.includes("\\")) {
    throw new ReleaseError("unsafe_relative_path", `${fieldName} must be a safe relative path`);
  }
  if (value.split("/").some((segment) => segment.length === 0 || segment === "." || segment === "..")) {
    throw new ReleaseError("unsafe_relative_path", `${fieldName} must be a safe relative path`);
  }
  return value;
}

function releaseManifest() {
  return {
    binaryRelativePath: "bin/9router",
    customRevision: CUSTOM_REVISION,
    packageName: PACKAGE_NAME,
    packageVersion: CUSTOM_REVISION,
    routingContractVersion: ROUTING_CONTRACT_VERSION,
    upstreamVersion: UPSTREAM_VERSION,
  };
}

function parseReleaseManifest(value, { expectedCustomRevision } = {}) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new ReleaseError("invalid_release_manifest", "Release manifest must be an object");
  }
  const manifest = value;
  if (
    manifest.routingContractVersion !== ROUTING_CONTRACT_VERSION
    || manifest.packageName !== PACKAGE_NAME
    || typeof manifest.upstreamVersion !== "string"
    || typeof manifest.customRevision !== "string"
    || manifest.packageVersion !== manifest.customRevision
    || !isCompatibleCustomRevision(manifest.upstreamVersion, manifest.customRevision)
    || (expectedCustomRevision && manifest.customRevision !== expectedCustomRevision)
  ) {
    throw new ReleaseError("release_contract_mismatch", "Release manifest does not match the compatible custom contract");
  }
  assertSafeRelativePath(manifest.binaryRelativePath, "binaryRelativePath");
  return manifest;
}

function isCompatibleCustomRevision(upstreamVersion, customRevision) {
  const escapedUpstreamVersion = upstreamVersion.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(`^${escapedUpstreamVersion}-9trip\\.\\d+$`).test(customRevision);
}

function readReleaseManifest(releasePath, options = {}, fileSystem = fs) {
  const manifestPath = path.join(releasePath, RELEASE_MANIFEST_NAME);
  let manifest;
  try {
    manifest = JSON.parse(fileSystem.readFileSync(manifestPath, "utf8"));
  } catch {
    throw new ReleaseError("invalid_release_manifest", "Release manifest is unavailable or invalid JSON");
  }
  return parseReleaseManifest(manifest, options);
}

function relativeToRoot(root, target) {
  if (!isPathInside(root, target)) {
    throw new ReleaseError("unsafe_release_target", "Release target escapes root");
  }
  return path.relative(root, target).split(path.sep).join("/");
}

function resolveRecordedPath(root, relativePath, { allowedRoot = root, fileSystem = fs, label = "recorded release path" } = {}) {
  assertSafeRelativePath(relativePath, "recorded release path");
  const candidate = path.resolve(root, relativePath);
  if (!isPathInside(allowedRoot, candidate)) {
    throw new ReleaseError("unsafe_release_target", "Recorded release target escapes root");
  }
  let stat;
  let resolved;
  try {
    stat = fileSystem.lstatSync(candidate);
    if (stat.isSymbolicLink()) {
      throw new ReleaseError("unsafe_release_target", `${label} must not be a symbolic link`);
    }
    resolved = fileSystem.realpathSync(candidate);
  } catch (error) {
    if (error instanceof ReleaseError) throw error;
    throw new ReleaseError("recorded_release_missing", `${label} is unavailable`);
  }
  if (!isPathInside(allowedRoot, resolved)) {
    throw new ReleaseError("unsafe_release_target", `${label} resolves outside its allowed directory`);
  }
  return resolved;
}

module.exports = {
  ACTIVATION_RECORD_NAME,
  ARCHIVE_NAME,
  CUSTOM_REVISION,
  DATABASE_FILE_NAMES,
  PACKAGE_NAME,
  RELEASE_MANIFEST_NAME,
  ROUTING_CONTRACT_VERSION,
  ReleaseError,
  UPSTREAM_VERSION,
  assertSafeRelativePath,
  isCompatibleCustomRevision,
  isPathInside,
  isPathInsideOrEqual,
  parseReleaseManifest,
  readReleaseManifest,
  relativeToRoot,
  releaseManifest,
  resolveRecordedPath,
  resolveReleasePaths,
};

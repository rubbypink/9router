const { randomUUID } = require("node:crypto");
const { spawnSync } = require("node:child_process");
const fs = require("node:fs");
const path = require("node:path");
const { gunzipSync } = require("node:zlib");

const {
  ARCHIVE_NAME,
  CUSTOM_REVISION,
  PACKAGE_NAME,
  RELEASE_MANIFEST_NAME,
  ReleaseError,
  isPathInside,
  isPathInsideOrEqual,
  readReleaseManifest,
  releaseManifest,
  resolveReleasePaths,
} = require("./release-contract.js");

const TAR_BLOCK_SIZE = 512;

function installRelease(options = {}) {
  const paths = resolveReleasePaths(options);
  const fileSystem = paths.fileSystem;
  const archivePath = resolveArchive(options.archivePath, fileSystem);
  if (fileSystem.existsSync(paths.releasePath)) {
    throw new ReleaseError("release_exists", `Immutable release already exists: ${CUSTOM_REVISION}`);
  }

  const stagingPath = fileSystem.mkdtempSync(path.join(paths.releasesRoot, ".staging-"));
  try {
    extractArchive(archivePath, stagingPath, fileSystem);
    validatePackagedCli(stagingPath, { packageName: PACKAGE_NAME, packageVersion: CUSTOM_REVISION }, fileSystem);
    writeReleaseFiles(stagingPath, fileSystem);
    validateReleaseDirectory(stagingPath, { expectedCustomRevision: CUSTOM_REVISION, fileSystem });
    fileSystem.renameSync(stagingPath, paths.releasePath);
    return {
      manifest: readReleaseManifest(paths.releasePath, { expectedCustomRevision: CUSTOM_REVISION }, fileSystem),
      releasePath: paths.releasePath,
    };
  } catch (error) {
    fileSystem.rmSync(stagingPath, { force: true, recursive: true });
    throw error;
  }
}

function resolveArchive(archivePath, fileSystem) {
  if (!archivePath || path.basename(archivePath) !== ARCHIVE_NAME) {
    throw new ReleaseError("archive_name_mismatch", `Archive must be ${ARCHIVE_NAME}`);
  }
  try {
    return fileSystem.realpathSync(archivePath);
  } catch {
    throw new ReleaseError("archive_unavailable", "Release archive is unavailable");
  }
}

function extractArchive(archivePath, stagingPath, fileSystem) {
  listArchiveEntries(archivePath, fileSystem);
  const result = spawnSync("tar", ["-xzf", archivePath, "-C", stagingPath, "--strip-components=1"], {
    encoding: "utf8",
  });
  if (result.status !== 0) {
    throw new ReleaseError("archive_extract_failed", "Could not extract the release archive");
  }
  validateStagedTree(stagingPath, fileSystem);
}

function listArchiveEntries(archivePath, fileSystem = fs) {
  let archive;
  try {
    archive = gunzipSync(fileSystem.readFileSync(archivePath));
  } catch {
    throw new ReleaseError("archive_invalid", "Release archive is not a valid gzip tarball");
  }
  const entries = [];
  let offset = 0;
  while (offset + TAR_BLOCK_SIZE <= archive.length) {
    const header = archive.subarray(offset, offset + TAR_BLOCK_SIZE);
    if (header.every((byte) => byte === 0)) break;
    const name = tarPath(header);
    const type = tarType(header);
    const size = tarSize(header);
    assertSafeArchiveEntry(name, type);
    entries.push({ name, type });
    const contentBlocks = Math.ceil(size / TAR_BLOCK_SIZE);
    offset += TAR_BLOCK_SIZE + (contentBlocks * TAR_BLOCK_SIZE);
    if (offset > archive.length) {
      throw new ReleaseError("archive_invalid", "Release archive entry exceeds archive contents");
    }
  }
  if (entries.length === 0 || offset > archive.length) {
    throw new ReleaseError("archive_invalid", "Release archive has no valid entries");
  }
  return entries;
}

function tarPath(header) {
  const name = tarString(header, 0, 100);
  const prefix = tarString(header, 345, 155);
  if (!name) {
    throw new ReleaseError("archive_entry_invalid", "Release archive contains an unnamed entry");
  }
  return prefix ? `${prefix}/${name}` : name;
}

function tarType(header) {
  const typeByte = header[156];
  return typeByte === 0 ? "0" : String.fromCharCode(typeByte);
}

function tarSize(header) {
  const field = header.subarray(124, 136);
  if ((field[0] & 0x80) !== 0) {
    throw new ReleaseError("archive_entry_invalid", "Release archive uses an unsupported size encoding");
  }
  const text = field.toString("ascii").replace(/\0.*$/u, "").trim();
  if (!text) return 0;
  if (!/^[0-7]+$/u.test(text)) {
    throw new ReleaseError("archive_entry_invalid", "Release archive contains an invalid entry size");
  }
  return Number.parseInt(text, 8);
}

function tarString(header, offset, length) {
  return header
    .subarray(offset, offset + length)
    .toString("utf8")
    .replace(/\0.*$/u, "");
}

function assertSafeArchiveEntry(name, type) {
  const normalized = name.endsWith("/") ? name.slice(0, -1) : name;
  if (
    !normalized
    || path.posix.isAbsolute(normalized)
    || normalized.includes("\\")
    || normalized.split("/").some((segment) => segment.length === 0 || segment === "." || segment === "..")
  ) {
    throw new ReleaseError("archive_entry_unsafe", "Release archive contains an unsafe entry path");
  }
  if (type !== "0" && type !== "5") {
    throw new ReleaseError("archive_entry_unsafe", "Release archive contains a non-regular entry");
  }
}

function validateStagedTree(releasePath, fileSystem = fs) {
  let canonicalRoot;
  let rootStat;
  try {
    canonicalRoot = fileSystem.realpathSync(releasePath);
    rootStat = fileSystem.lstatSync(canonicalRoot);
  } catch {
    throw new ReleaseError("release_tree_invalid", "Release directory is unavailable");
  }
  if (!rootStat.isDirectory()) {
    throw new ReleaseError("release_tree_invalid", "Release path is not a directory");
  }
  const queue = [canonicalRoot];
  while (queue.length > 0) {
    const directory = queue.shift();
    for (const entry of fileSystem.readdirSync(directory, { withFileTypes: true })) {
      const entryPath = path.join(directory, entry.name);
      const stat = fileSystem.lstatSync(entryPath);
      if (stat.isSymbolicLink()) {
        throw new ReleaseError("release_tree_unsafe", "Release tree contains a symbolic link");
      }
      if (!stat.isDirectory() && !stat.isFile()) {
        throw new ReleaseError("release_tree_unsafe", "Release tree contains a non-regular entry");
      }
      if (stat.isFile() && stat.nlink > 1) {
        throw new ReleaseError("release_tree_unsafe", "Release tree contains a hardlink");
      }
      let resolved;
      try {
        resolved = fileSystem.realpathSync(entryPath);
      } catch {
        throw new ReleaseError("release_tree_invalid", "Release tree entry is unavailable");
      }
      if (!isPathInside(canonicalRoot, resolved)) {
        throw new ReleaseError("release_tree_unsafe", "Release tree entry escapes its staging directory");
      }
      if (stat.isDirectory()) queue.push(resolved);
    }
  }
  return canonicalRoot;
}

function validatePackagedCli(releasePath, expectedPackage, fileSystem = fs) {
  const canonicalReleasePath = validateStagedTree(releasePath, fileSystem);
  const packagePath = path.join(canonicalReleasePath, "package.json");
  let packageJson;
  try {
    packageJson = JSON.parse(fileSystem.readFileSync(packagePath, "utf8"));
  } catch {
    throw new ReleaseError("package_manifest_invalid", "Packaged CLI manifest is invalid");
  }
  if (
    packageJson.name !== expectedPackage.packageName
    || packageJson.version !== expectedPackage.packageVersion
  ) {
    throw new ReleaseError("package_version_mismatch", "Packaged CLI does not match its release manifest");
  }
  resolveRegularFile(canonicalReleasePath, "cli.js", "cli_missing", "Packaged CLI entrypoint is missing", fileSystem);
  const cliPath = path.join(canonicalReleasePath, "cli.js");
  const syntaxCheck = spawnSync(process.execPath, ["--check", cliPath], { encoding: "utf8" });
  if (syntaxCheck.status !== 0) {
    throw new ReleaseError("cli_invalid", "Packaged CLI entrypoint does not pass syntax validation");
  }
}

function writeReleaseFiles(releasePath, fileSystem) {
  const binaryDirectory = path.join(releasePath, "bin");
  fileSystem.mkdirSync(binaryDirectory, { recursive: true });
  fileSystem.writeFileSync(
    path.join(binaryDirectory, "9router"),
    '#!/usr/bin/env node\nrequire(require("node:path").join(__dirname, "..", "cli.js"));\n',
    { mode: 0o755 },
  );
  fileSystem.writeFileSync(
    path.join(releasePath, RELEASE_MANIFEST_NAME),
    `${JSON.stringify(releaseManifest(), null, 2)}\n`,
  );
}

function validateReleaseDirectory(releasePath, { expectedCustomRevision, fileSystem = fs } = {}) {
  const canonicalReleasePath = validateStagedTree(releasePath, fileSystem);
  const manifest = readReleaseManifest(
    canonicalReleasePath,
    expectedCustomRevision ? { expectedCustomRevision } : {},
    fileSystem,
  );
  resolveRegularFile(
    canonicalReleasePath,
    manifest.binaryRelativePath,
    "release_binary_missing",
    "Release binary is unavailable",
    fileSystem,
  );
  validatePackagedCli(canonicalReleasePath, manifest, fileSystem);
  return manifest;
}

function resolveRegularFile(releasePath, relativePath, code, message, fileSystem) {
  const candidate = path.resolve(releasePath, relativePath);
  if (!isPathInsideOrEqual(releasePath, candidate) || candidate === releasePath) {
    throw new ReleaseError("release_binary_unsafe", "Release binary escapes the staged release");
  }
  let stat;
  let resolved;
  try {
    stat = fileSystem.lstatSync(candidate);
    if (stat.isSymbolicLink() || !stat.isFile() || stat.nlink > 1) {
      throw new ReleaseError("release_binary_unsafe", `${message}: expected a real regular file`);
    }
    resolved = fileSystem.realpathSync(candidate);
  } catch (error) {
    if (error instanceof ReleaseError) throw error;
    throw new ReleaseError(code, message);
  }
  if (!isPathInside(releasePath, resolved)) {
    throw new ReleaseError("release_binary_unsafe", "Release binary escapes the staged release");
  }
  return resolved;
}

module.exports = {
  installRelease,
  listArchiveEntries,
  validateReleaseDirectory,
  validateStagedTree,
};

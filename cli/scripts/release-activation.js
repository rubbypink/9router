const { randomUUID } = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");

const {
  CUSTOM_REVISION,
  DATABASE_FILE_NAMES,
  ReleaseError,
  isPathInside,
  relativeToRoot,
  resolveRecordedPath,
  resolveReleasePaths,
} = require("./release-contract.js");
const { validateReleaseDirectory } = require("./release-install.js");

const ACTIVATION_SCHEMA_VERSION = "9router-release-activation/v2";

function activateRelease(options = {}) {
  const paths = resolveReleasePaths(options);
  const fileSystem = paths.fileSystem;
  validateReleaseDirectory(paths.releasePath, {
    expectedCustomRevision: CUSTOM_REVISION,
    fileSystem,
  });
  const previousReleasePath = currentReleasePath(paths);
  if (previousReleasePath === paths.releasePath) {
    throw new ReleaseError("release_already_current", "Requested release is already current");
  }
  if (previousReleasePath) {
    validateReleaseDirectory(previousReleasePath, { fileSystem });
  }

  const backup = createDatabaseBackup(paths, "activation");
  const previousRecord = readOptionalRecord(paths.activationRecordPath, fileSystem);
  const preparedRecord = activationRecord(paths, backup, previousReleasePath, "prepared");
  writeJson(paths.activationRecordPath, preparedRecord, fileSystem);
  try {
    replaceCurrentLink(paths.root, paths.releasePath, fileSystem);
  } catch (error) {
    restoreActivationRecord(paths.activationRecordPath, previousRecord, fileSystem);
    throw error;
  }

  writeJson(
    paths.activationRecordPath,
    { ...preparedRecord, state: "active" },
    fileSystem,
  );
  return { backupPath: backup.path, previousReleasePath, releasePath: paths.releasePath };
}

function rollbackRelease(options = {}) {
  const paths = resolveReleasePaths(options);
  const fileSystem = paths.fileSystem;
  const record = readActivationRecord(paths);
  if (!record.previousReleasePath) {
    throw new ReleaseError("rollback_unavailable", "No previous release is recorded for rollback");
  }
  if (currentReleasePath(paths) !== record.activatedReleasePath) {
    throw new ReleaseError("rollback_state_mismatch", "Current release does not match the activation record");
  }
  validateReleaseDirectory(record.activatedReleasePath, { fileSystem });
  validateReleaseDirectory(record.previousReleasePath, { fileSystem });

  const preRollbackBackup = createDatabaseBackup(paths, "rollback");
  replaceCurrentLink(paths.root, record.previousReleasePath, fileSystem);
  try {
    restoreDatabaseBackup(paths, record.databaseBackupPath, record.databaseFiles);
  } catch (restoreError) {
    recoverRollbackFailure(paths, record.activatedReleasePath, preRollbackBackup, restoreError);
  }
  return {
    currentReleasePath: record.previousReleasePath,
    restoredBackupPath: record.databaseBackupPath,
  };
}

function activationRecord(paths, backup, previousReleasePath, state) {
  return {
    activatedReleaseRelativePath: relativeToRoot(paths.root, paths.releasePath),
    databaseBackupRelativePath: relativeToRoot(paths.root, backup.path),
    databaseFiles: backup.files,
    previousReleaseRelativePath: previousReleasePath
      ? relativeToRoot(paths.root, previousReleasePath)
      : null,
    schemaVersion: ACTIVATION_SCHEMA_VERSION,
    state,
  };
}

function recoverRollbackFailure(paths, activeReleasePath, preRollbackBackup, restoreError) {
  try {
    replaceCurrentLink(paths.root, activeReleasePath, paths.fileSystem);
    restoreDatabaseBackup(paths, preRollbackBackup.path, preRollbackBackup.files);
  } catch (recoveryError) {
    throw new ReleaseError(
      "rollback_recovery_failed",
      `Rollback database restore failed and compensation did not complete: ${errorMessage(restoreError)}; ${errorMessage(recoveryError)}`,
    );
  }
  throw new ReleaseError(
    "rollback_restore_failed",
    `Rollback database restore failed; active release and pre-rollback database snapshot were restored: ${errorMessage(restoreError)}`,
  );
}

function currentReleasePath(paths) {
  const currentPath = path.join(paths.root, "current");
  if (!paths.fileSystem.existsSync(currentPath)) return null;
  let resolved;
  try {
    resolved = paths.fileSystem.realpathSync(currentPath);
  } catch {
    throw new ReleaseError("current_release_invalid", "Current release link is invalid");
  }
  if (!isPathInside(paths.releasesRoot, resolved)) {
    throw new ReleaseError("current_release_unsafe", "Current release link escapes the releases directory");
  }
  return resolved;
}

function createDatabaseBackup(paths, label) {
  const fileSystem = paths.fileSystem;
  const backupPath = path.join(paths.backupsRoot, `${label}-${Date.now()}-${randomUUID()}`);
  fileSystem.mkdirSync(backupPath, { recursive: true });
  const databaseDirectory = path.join(paths.dataDirectory, "db");
  const files = [];
  for (const name of DATABASE_FILE_NAMES) {
    const sourcePath = path.join(databaseDirectory, name);
    if (!fileSystem.existsSync(sourcePath)) continue;
    fileSystem.copyFileSync(sourcePath, path.join(backupPath, name));
    files.push(name);
  }
  return { files, path: fileSystem.realpathSync(backupPath) };
}

function restoreDatabaseBackup(paths, backupPath, files) {
  const fileSystem = paths.fileSystem;
  assertDatabaseFiles(files);
  const databaseDirectory = path.join(paths.dataDirectory, "db");
  fileSystem.mkdirSync(databaseDirectory, { recursive: true });
  for (const name of DATABASE_FILE_NAMES) {
    const destinationPath = path.join(databaseDirectory, name);
    if (files.includes(name)) {
      fileSystem.copyFileSync(resolveBackupFile(backupPath, name, fileSystem), destinationPath);
    } else {
      fileSystem.rmSync(destinationPath, { force: true });
    }
  }
}

function resolveBackupFile(backupPath, name, fileSystem) {
  const candidate = path.join(backupPath, name);
  let stat;
  let resolved;
  try {
    stat = fileSystem.lstatSync(candidate);
    if (stat.isSymbolicLink() || !stat.isFile()) {
      throw new ReleaseError("database_backup_invalid", "Database backup contains an unsafe file");
    }
    resolved = fileSystem.realpathSync(candidate);
  } catch (error) {
    if (error instanceof ReleaseError) throw error;
    throw new ReleaseError("database_backup_invalid", "Database backup file is unavailable");
  }
  if (!isPathInside(backupPath, resolved)) {
    throw new ReleaseError("database_backup_invalid", "Database backup file escapes its backup directory");
  }
  return resolved;
}

function replaceCurrentLink(root, target, fileSystem) {
  const temporaryLink = path.join(root, `.current-${randomUUID()}`);
  const relativeTarget = path.relative(root, target);
  try {
    fileSystem.symlinkSync(relativeTarget, temporaryLink, "dir");
    fileSystem.renameSync(temporaryLink, path.join(root, "current"));
  } catch (error) {
    fileSystem.rmSync(temporaryLink, { force: true });
    throw error;
  }
}

function readActivationRecord(paths) {
  let record;
  try {
    record = JSON.parse(paths.fileSystem.readFileSync(paths.activationRecordPath, "utf8"));
  } catch {
    throw new ReleaseError("activation_record_invalid", "Activation record is unavailable or invalid");
  }
  if (!record || typeof record !== "object" || Array.isArray(record)) {
    throw new ReleaseError("activation_record_invalid", "Activation record is invalid");
  }
  const state = record.schemaVersion === "9router-release-activation/v1" ? "active" : record.state;
  if (
    (record.schemaVersion !== ACTIVATION_SCHEMA_VERSION && record.schemaVersion !== "9router-release-activation/v1")
    || (state !== "prepared" && state !== "active")
    || typeof record.activatedReleaseRelativePath !== "string"
    || typeof record.databaseBackupRelativePath !== "string"
    || (record.previousReleaseRelativePath !== null && typeof record.previousReleaseRelativePath !== "string")
  ) {
    throw new ReleaseError("activation_record_invalid", "Activation record is invalid");
  }
  assertDatabaseFiles(record.databaseFiles);
  const activatedReleasePath = resolveRecordedPath(paths.root, record.activatedReleaseRelativePath, {
    allowedRoot: paths.releasesRoot,
    fileSystem: paths.fileSystem,
    label: "activated release",
  });
  const databaseBackupPath = resolveRecordedPath(paths.root, record.databaseBackupRelativePath, {
    allowedRoot: paths.backupsRoot,
    fileSystem: paths.fileSystem,
    label: "database backup",
  });
  const previousReleasePath = record.previousReleaseRelativePath
    ? resolveRecordedPath(paths.root, record.previousReleaseRelativePath, {
      allowedRoot: paths.releasesRoot,
      fileSystem: paths.fileSystem,
      label: "previous release",
    })
    : null;
  assertDirectory(activatedReleasePath, "activated release", paths.fileSystem);
  assertDirectory(databaseBackupPath, "database backup", paths.fileSystem);
  if (previousReleasePath) assertDirectory(previousReleasePath, "previous release", paths.fileSystem);
  return {
    activatedReleasePath,
    databaseBackupPath,
    databaseFiles: record.databaseFiles,
    previousReleasePath,
    state,
  };
}

function assertDatabaseFiles(files) {
  if (
    !Array.isArray(files)
    || new Set(files).size !== files.length
    || files.some((name) => !DATABASE_FILE_NAMES.includes(name))
  ) {
    throw new ReleaseError("activation_record_invalid", "Activation record has invalid database file names");
  }
}

function assertDirectory(directory, label, fileSystem) {
  if (!fileSystem.lstatSync(directory).isDirectory()) {
    throw new ReleaseError("activation_record_invalid", `${label} is not a directory`);
  }
}

function readOptionalRecord(recordPath, fileSystem) {
  if (!fileSystem.existsSync(recordPath)) return null;
  const stat = fileSystem.lstatSync(recordPath);
  if (stat.isSymbolicLink() || !stat.isFile()) {
    throw new ReleaseError("activation_record_invalid", "Existing activation record is unsafe");
  }
  return fileSystem.readFileSync(recordPath);
}

function restoreActivationRecord(recordPath, previousRecord, fileSystem) {
  if (previousRecord === null) {
    fileSystem.rmSync(recordPath, { force: true });
    return;
  }
  writeAtomically(recordPath, previousRecord, fileSystem);
}

function writeJson(filePath, value, fileSystem = fs) {
  writeAtomically(filePath, `${JSON.stringify(value, null, 2)}\n`, fileSystem);
}

function writeAtomically(filePath, contents, fileSystem) {
  const temporaryPath = `${filePath}.${randomUUID()}.tmp`;
  try {
    fileSystem.writeFileSync(temporaryPath, contents);
    fileSystem.renameSync(temporaryPath, filePath);
  } catch (error) {
    fileSystem.rmSync(temporaryPath, { force: true });
    throw error;
  }
}

function errorMessage(error) {
  return error instanceof Error ? error.message : String(error);
}

module.exports = {
  activateRelease,
  rollbackRelease,
};

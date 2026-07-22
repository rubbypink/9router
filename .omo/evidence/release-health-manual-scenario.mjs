#!/usr/bin/env node

import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const scriptDirectory = path.dirname(fileURLToPath(import.meta.url));
const repositoryRoot = path.resolve(scriptDirectory, '..', '..');
const archivePath = process.argv[2] ?? path.join(repositoryRoot, '9router-0.5.40-9trip.1.tgz');
const releaseCliPath = path.join(repositoryRoot, 'cli', 'scripts', 'release-cli.js');
const temporaryRoot = mkdtempSync(path.join(tmpdir(), '9router-release-manual-'));
const releaseRoot = path.join(temporaryRoot, 'release-root');
const dataDir = path.join(temporaryRoot, 'data');
const previousReleasePath = path.join(releaseRoot, 'releases', '0.5.39-9trip.1');

function runRelease(command, ...args) {
  return JSON.parse(
    execFileSync(process.execPath, [releaseCliPath, command, ...args], {
      encoding: 'utf8',
    }),
  );
}

function createCompatiblePreviousRelease() {
  const binaryPath = path.join(previousReleasePath, 'bin', '9router');
  mkdirSync(path.dirname(binaryPath), { recursive: true });
  writeFileSync(
    path.join(previousReleasePath, 'package.json'),
    JSON.stringify({ name: '9router', version: '0.5.39-9trip.1' }),
  );
  writeFileSync(path.join(previousReleasePath, 'cli.js'), '#!/usr/bin/env node\n');
  chmodSync(path.join(previousReleasePath, 'cli.js'), 0o755);
  writeFileSync(binaryPath, '#!/usr/bin/env node\n');
  chmodSync(binaryPath, 0o755);
  writeFileSync(
    path.join(previousReleasePath, 'release.json'),
    JSON.stringify({
      binaryRelativePath: 'bin/9router',
      customRevision: '0.5.39-9trip.1',
      packageName: '9router',
      packageVersion: '0.5.39-9trip.1',
      routingContractVersion: 'session-affinity/v2',
      upstreamVersion: '0.5.39',
    }),
  );
}

function writeDatabase(values) {
  const databaseDirectory = path.join(dataDir, 'db');
  mkdirSync(databaseDirectory, { recursive: true });
  for (const [name, value] of Object.entries(values)) {
    writeFileSync(path.join(databaseDirectory, name), value);
  }
}

try {
  assert.ok(path.isAbsolute(archivePath), 'archive path must be absolute');
  createCompatiblePreviousRelease();
  symlinkSync(previousReleasePath, path.join(releaseRoot, 'current'), 'dir');
  writeDatabase({
    'data.sqlite': 'before',
    'data.sqlite-shm': 'before-shm',
    'data.sqlite-wal': 'before-wal',
  });

  const common = ['--release-root', releaseRoot, '--data-dir', dataDir];
  const installed = runRelease('install', '--archive', archivePath, ...common);
  assert.throws(() => runRelease('install', '--archive', archivePath, ...common));
  const activated = runRelease('activate', ...common);
  assert.equal(
    realpathSync(path.join(releaseRoot, 'current')),
    installed.releasePath,
  );
  assert.equal(activated.previousReleasePath, realpathSync(previousReleasePath));

  writeDatabase({
    'data.sqlite': 'after',
    'data.sqlite-shm': 'after-shm',
    'data.sqlite-wal': 'after-wal',
  });
  const rolledBack = runRelease('rollback', ...common);
  assert.equal(rolledBack.currentReleasePath, realpathSync(previousReleasePath));
  assert.equal(readFileSync(path.join(dataDir, 'db', 'data.sqlite'), 'utf8'), 'before');
  assert.equal(readFileSync(path.join(dataDir, 'db', 'data.sqlite-wal'), 'utf8'), 'before-wal');
  assert.equal(readFileSync(path.join(dataDir, 'db', 'data.sqlite-shm'), 'utf8'), 'before-shm');
  console.log('manual lifecycle passed: install, overwrite rejection, activate, rollback, SQLite/WAL/SHM restore');
} finally {
  rmSync(temporaryRoot, { force: true, recursive: true });
}

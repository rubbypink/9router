import { createRequire } from "node:module";
import { execFileSync } from "node:child_process";
import {
  chmodSync,
  existsSync,
  linkSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import os from "node:os";
import path from "node:path";
import { gzipSync } from "node:zlib";
import { afterEach, describe, expect, it } from "vitest";

const require = createRequire(import.meta.url);
const fs = require("node:fs");
const {
  activateRelease,
  installRelease,
  rollbackRelease,
  validateReleaseDirectory,
} = require("../../cli/scripts/release-manager.js");
const {
  ARCHIVE_NAME,
  CUSTOM_REVISION: CUSTOM_VERSION,
} = require("../../cli/scripts/release-contract.js");
const fixtureRoots = [];

afterEach(() => {
  for (const fixtureRoot of fixtureRoots.splice(0)) {
    rmSync(fixtureRoot, { force: true, recursive: true });
  }
});

function createFixture({ packageVersion = CUSTOM_VERSION } = {}) {
  const fixtureRoot = mkdtempSync(path.join(os.tmpdir(), "9router-release-test-"));
  fixtureRoots.push(fixtureRoot);
  const sourceRoot = path.join(fixtureRoot, "source");
  const packageRoot = path.join(sourceRoot, "package");
  const archivePath = path.join(fixtureRoot, ARCHIVE_NAME);
  mkdirSync(packageRoot, { recursive: true });
  writeFileSync(
    path.join(packageRoot, "package.json"),
    JSON.stringify({ name: "9router", version: packageVersion }),
  );
  const cliPath = path.join(packageRoot, "cli.js");
  writeFileSync(
    cliPath,
    `#!/usr/bin/env node\nif (process.argv.includes("--version")) console.log("${packageVersion}");\n`,
  );
  chmodSync(cliPath, 0o755);
  execFileSync("tar", ["-czf", archivePath, "-C", sourceRoot, "package"]);

  return {
    archivePath,
    dataDir: path.join(fixtureRoot, "data"),
    fixtureRoot,
    releaseRoot: path.join(fixtureRoot, "release-root"),
  };
}

function writeDatabase(dataDir, values) {
  const databaseDirectory = path.join(dataDir, "db");
  mkdirSync(databaseDirectory, { recursive: true });
  for (const [name, value] of Object.entries(values)) {
    writeFileSync(path.join(databaseDirectory, name), value);
  }
}

function writeTarString(buffer, value, offset, length) {
  Buffer.from(value).copy(buffer, offset, 0, Math.min(Buffer.byteLength(value), length));
}

function writeTarNumber(buffer, value, offset, length) {
  writeTarString(buffer, `${value.toString(8).padStart(length - 1, "0")}\0`, offset, length);
}

function writeArchive(archivePath, entries) {
  const blocks = [];
  for (const entry of entries) {
    const content = Buffer.from(entry.content || "");
    const header = Buffer.alloc(512);
    writeTarString(header, entry.name, 0, 100);
    writeTarNumber(header, entry.mode ?? 0o644, 100, 8);
    writeTarNumber(header, 0, 108, 8);
    writeTarNumber(header, 0, 116, 8);
    writeTarNumber(header, content.length, 124, 12);
    writeTarNumber(header, 0, 136, 12);
    header.fill(0x20, 148, 156);
    header[156] = (entry.type ?? "0").charCodeAt(0);
    writeTarString(header, entry.linkName || "", 157, 100);
    writeTarString(header, "ustar", 257, 6);
    writeTarString(header, "00", 263, 2);
    writeTarNumber(header, header.reduce((total, byte) => total + byte, 0), 148, 8);
    const padding = Buffer.alloc((512 - (content.length % 512)) % 512);
    blocks.push(header, content, padding);
  }
  writeFileSync(archivePath, gzipSync(Buffer.concat([...blocks, Buffer.alloc(1024)])));
}

function createCompatibleRelease(releasePath, { customRevision = CUSTOM_VERSION, upstreamVersion = "0.5.40" } = {}) {
  const binaryPath = path.join(releasePath, "bin", "9router");
  mkdirSync(path.dirname(binaryPath), { recursive: true });
  writeFileSync(
    path.join(releasePath, "package.json"),
    JSON.stringify({ name: "9router", version: customRevision }),
  );
  writeFileSync(
    path.join(releasePath, "cli.js"),
    `#!/usr/bin/env node\nif (process.argv.includes("--version")) console.log("${customRevision}");\n`,
  );
  chmodSync(path.join(releasePath, "cli.js"), 0o755);
  writeFileSync(binaryPath, '#!/usr/bin/env node\nrequire(require("node:path").join(__dirname, "..", "cli.js"));\n');
  chmodSync(binaryPath, 0o755);
  writeFileSync(
    path.join(releasePath, "release.json"),
    JSON.stringify({
      binaryRelativePath: "bin/9router",
      customRevision,
      packageName: "9router",
      packageVersion: customRevision,
      routingContractVersion: "session-affinity/v2",
      upstreamVersion,
    }),
  );
}

function withFileSystemOverrides(overrides) {
  return new Proxy(fs, {
    get(target, property, receiver) {
      if (Object.hasOwn(overrides, property)) return overrides[property];
      return Reflect.get(target, property, receiver);
    },
  });
}

describe("immutable custom 9router release manager", () => {
  it("installs the exact custom archive into a safe temp release root", () => {
    const fixture = createFixture();

    const result = installRelease(fixture);
    const manifest = JSON.parse(
      readFileSync(path.join(result.releasePath, "release.json"), "utf8"),
    );

    expect(result.releasePath).toBe(
      path.join(realpathSync(fixture.releaseRoot), "releases", CUSTOM_VERSION),
    );
    expect(manifest).toMatchObject({
      routingContractVersion: "session-affinity/v2",
      upstreamVersion: "0.5.40",
      customRevision: CUSTOM_VERSION,
      packageVersion: CUSTOM_VERSION,
      binaryRelativePath: "bin/9router",
    });
    expect(realpathSync(path.join(result.releasePath, manifest.binaryRelativePath)))
      .toContain(result.releasePath);
  });

  it("rejects a vanilla package and never overwrites an installed release", () => {
    const vanillaFixture = createFixture({ packageVersion: "0.5.40" });
    expect(() => installRelease(vanillaFixture)).toThrow(/package|version|contract/i);

    const fixture = createFixture();
    installRelease(fixture);
    expect(() => installRelease(fixture)).toThrow(/already exists/i);
  });

  it("preflights archive headers before extraction and rejects traversal, symlink, and hardlink entries", () => {
    const cases = [
      { name: "package/../../escape", type: "0" },
      { name: "/absolute-entry", type: "0" },
      { linkName: "../../escape", name: "package/linked-cli", type: "2" },
      { linkName: "package/cli.js", name: "package/hardlinked-cli", type: "1" },
    ];

    for (const entry of cases) {
      const fixture = createFixture();
      writeArchive(fixture.archivePath, [
        { content: JSON.stringify({ name: "9router", version: CUSTOM_VERSION }), name: "package/package.json" },
        { content: "#!/usr/bin/env node\n", mode: 0o755, name: "package/cli.js" },
        entry,
      ]);

      expect(() => installRelease(fixture)).toThrow(/archive/i);
      expect(existsSync(path.join(fixture.releaseRoot, "releases", CUSTOM_VERSION))).toBe(false);
    }
  });

  it("rejects links and hardlinks that exist in an extracted release tree", () => {
    const fixture = createFixture();
    const releasePath = path.join(fixture.fixtureRoot, "staged-release");
    createCompatibleRelease(releasePath);
    const outsidePath = path.join(fixture.fixtureRoot, "outside");
    writeFileSync(outsidePath, "outside");
    symlinkSync(outsidePath, path.join(releasePath, "escaped-link"));

    expect(() => validateReleaseDirectory(releasePath)).toThrow(/link|unsafe/i);

    fs.rmSync(path.join(releasePath, "escaped-link"));
    linkSync(path.join(releasePath, "package.json"), path.join(releasePath, "hardlinked-package.json"));
    expect(() => validateReleaseDirectory(releasePath)).toThrow(/hardlink|unsafe/i);
  });

  it("atomically activates then rolls back the previous release with its SQLite snapshot", () => {
    const fixture = createFixture();
    const previousRelease = path.join(fixture.releaseRoot, "releases", "0.5.39-previous");
    createCompatibleRelease(previousRelease, {
      customRevision: "0.5.39-9trip.1",
      upstreamVersion: "0.5.39",
    });
    mkdirSync(fixture.releaseRoot, { recursive: true });
    symlinkSync(previousRelease, path.join(fixture.releaseRoot, "current"));
    writeDatabase(fixture.dataDir, {
      "data.sqlite": "before",
      "data.sqlite-shm": "before-shm",
      "data.sqlite-wal": "before-wal",
    });

    const installed = installRelease(fixture);
    const activated = activateRelease({
      dataDir: fixture.dataDir,
      releaseRoot: fixture.releaseRoot,
    });
    expect(realpathSync(path.join(fixture.releaseRoot, "current"))).toBe(installed.releasePath);
    writeDatabase(fixture.dataDir, {
      "data.sqlite": "after",
      "data.sqlite-shm": "after-shm",
      "data.sqlite-wal": "after-wal",
    });
    const rolledBack = rollbackRelease({
      dataDir: fixture.dataDir,
      releaseRoot: fixture.releaseRoot,
    });

    expect(activated.previousReleasePath).toBe(realpathSync(previousRelease));
    expect(rolledBack.currentReleasePath).toBe(realpathSync(previousRelease));
    expect(readFileSync(path.join(fixture.dataDir, "db", "data.sqlite"), "utf8")).toBe("before");
    expect(readFileSync(path.join(fixture.dataDir, "db", "data.sqlite-wal"), "utf8")).toBe("before-wal");
    expect(readFileSync(path.join(fixture.dataDir, "db", "data.sqlite-shm"), "utf8")).toBe("before-shm");
    expect(existsSync(path.join(fixture.releaseRoot, "activation.json"))).toBe(true);
  });

  it("rejects a bare previous release rather than recording it for rollback", () => {
    const fixture = createFixture();
    const previousRelease = path.join(fixture.releaseRoot, "releases", "bare-release");
    mkdirSync(previousRelease, { recursive: true });
    mkdirSync(fixture.releaseRoot, { recursive: true });
    symlinkSync(previousRelease, path.join(fixture.releaseRoot, "current"));
    installRelease(fixture);

    expect(() => activateRelease({ dataDir: fixture.dataDir, releaseRoot: fixture.releaseRoot })).toThrow(/release|manifest/i);
  });

  it("keeps a prepared activation record recoverable when the post-switch record write fails", () => {
    const fixture = createFixture();
    const previousRelease = path.join(fixture.releaseRoot, "releases", "0.5.39-previous");
    createCompatibleRelease(previousRelease, {
      customRevision: "0.5.39-9trip.1",
      upstreamVersion: "0.5.39",
    });
    mkdirSync(fixture.releaseRoot, { recursive: true });
    symlinkSync(previousRelease, path.join(fixture.releaseRoot, "current"));
    writeDatabase(fixture.dataDir, { "data.sqlite": "before" });
    const installed = installRelease(fixture);
    const recordPath = path.join(realpathSync(fixture.releaseRoot), "activation.json");
    let recordWriteCount = 0;
    const fileSystem = withFileSystemOverrides({
      renameSync(source, destination) {
        if (destination === recordPath && recordWriteCount++ === 1) {
          throw new Error("injected post-switch activation record failure");
        }
        return fs.renameSync(source, destination);
      },
    });

    expect(() => activateRelease({ dataDir: fixture.dataDir, fileSystem, releaseRoot: fixture.releaseRoot })).toThrow(/injected/i);
    expect(realpathSync(path.join(fixture.releaseRoot, "current"))).toBe(installed.releasePath);
    expect(JSON.parse(readFileSync(recordPath, "utf8")).state).toBe("prepared");

    writeDatabase(fixture.dataDir, { "data.sqlite": "after" });
    rollbackRelease({ dataDir: fixture.dataDir, releaseRoot: fixture.releaseRoot });
    expect(realpathSync(path.join(fixture.releaseRoot, "current"))).toBe(realpathSync(previousRelease));
    expect(readFileSync(path.join(fixture.dataDir, "db", "data.sqlite"), "utf8")).toBe("before");
  });

  it("preserves the previous current release when the atomic link switch fails", () => {
    const fixture = createFixture();
    const previousRelease = path.join(fixture.releaseRoot, "releases", "0.5.39-previous");
    createCompatibleRelease(previousRelease, {
      customRevision: "0.5.39-9trip.1",
      upstreamVersion: "0.5.39",
    });
    mkdirSync(fixture.releaseRoot, { recursive: true });
    symlinkSync(previousRelease, path.join(fixture.releaseRoot, "current"));
    installRelease(fixture);
    const fileSystem = withFileSystemOverrides({
      symlinkSync(target, linkPath, type) {
        if (String(linkPath).includes(`${path.sep}.current-`)) {
          throw new Error("injected current symlink failure");
        }
        return fs.symlinkSync(target, linkPath, type);
      },
    });

    expect(() => activateRelease({ dataDir: fixture.dataDir, fileSystem, releaseRoot: fixture.releaseRoot })).toThrow(/injected/i);
    expect(realpathSync(path.join(fixture.releaseRoot, "current"))).toBe(realpathSync(previousRelease));
    expect(existsSync(path.join(fixture.releaseRoot, "activation.json"))).toBe(false);
  });

  it("compensates rollback failures by restoring the active pointer and database snapshot", () => {
    const fixture = createFixture();
    const previousRelease = path.join(fixture.releaseRoot, "releases", "0.5.39-previous");
    createCompatibleRelease(previousRelease, {
      customRevision: "0.5.39-9trip.1",
      upstreamVersion: "0.5.39",
    });
    mkdirSync(fixture.releaseRoot, { recursive: true });
    symlinkSync(previousRelease, path.join(fixture.releaseRoot, "current"));
    writeDatabase(fixture.dataDir, { "data.sqlite": "before" });
    const installed = installRelease(fixture);
    activateRelease({ dataDir: fixture.dataDir, releaseRoot: fixture.releaseRoot });
    writeDatabase(fixture.dataDir, { "data.sqlite": "after" });
    const record = JSON.parse(readFileSync(path.join(fixture.releaseRoot, "activation.json"), "utf8"));
    const activationBackupPath = realpathSync(
      path.join(fixture.releaseRoot, record.databaseBackupRelativePath),
    );
    const fileSystem = withFileSystemOverrides({
      copyFileSync(source, destination, mode) {
        if (String(source).startsWith(`${activationBackupPath}${path.sep}`)) {
          throw new Error("injected rollback restore failure");
        }
        return fs.copyFileSync(source, destination, mode);
      },
    });

    expect(() => rollbackRelease({ dataDir: fixture.dataDir, fileSystem, releaseRoot: fixture.releaseRoot })).toThrow(/restore|injected/i);
    expect(realpathSync(path.join(fixture.releaseRoot, "current"))).toBe(installed.releasePath);
    expect(readFileSync(path.join(fixture.dataDir, "db", "data.sqlite"), "utf8")).toBe("after");
  });

  it("rejects activation records with unapproved database names and canonical path escapes", () => {
    const fixture = createFixture();
    const previousRelease = path.join(fixture.releaseRoot, "releases", "0.5.39-previous");
    createCompatibleRelease(previousRelease, {
      customRevision: "0.5.39-9trip.1",
      upstreamVersion: "0.5.39",
    });
    mkdirSync(fixture.releaseRoot, { recursive: true });
    symlinkSync(previousRelease, path.join(fixture.releaseRoot, "current"));
    writeDatabase(fixture.dataDir, { "data.sqlite": "before" });
    installRelease(fixture);
    activateRelease({ dataDir: fixture.dataDir, releaseRoot: fixture.releaseRoot });
    const recordPath = path.join(fixture.releaseRoot, "activation.json");
    const record = JSON.parse(readFileSync(recordPath, "utf8"));

    writeFileSync(recordPath, JSON.stringify({ ...record, databaseFiles: ["outside.sqlite"] }));
    expect(() => rollbackRelease({ dataDir: fixture.dataDir, releaseRoot: fixture.releaseRoot })).toThrow(/database file/i);

    const outsideRelease = path.join(fixture.fixtureRoot, "outside-release");
    mkdirSync(outsideRelease, { recursive: true });
    symlinkSync(outsideRelease, path.join(fixture.releaseRoot, "releases", "redirect"));
    writeFileSync(
      recordPath,
      JSON.stringify({ ...record, previousReleaseRelativePath: "releases/redirect" }),
    );
    expect(() => rollbackRelease({ dataDir: fixture.dataDir, releaseRoot: fixture.releaseRoot })).toThrow(/symbolic link|outside/i);
  });
});
